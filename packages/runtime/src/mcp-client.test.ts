import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  createConnectorConnectionPolicy: vi.fn(async (value: string) => ({ url: new URL(value), lookup: mocks.lookup })),
  connect: vi.fn<(transport: unknown) => Promise<void>>(async () => undefined),
  close: vi.fn(async () => undefined),
  listTools: vi.fn(async () => ({ tools: [{ name: "search", description: "Read only search", annotations: { readOnlyHint: true, destructiveHint: false } }] })),
  callTool: vi.fn<(input: unknown) => Promise<{ content: unknown[]; isError?: boolean }>>(async () => ({ content: [] })),
  transport: vi.fn<(url: URL, options: unknown) => void>()
}));

vi.mock("@council/domain", async () => {
  const actual = await vi.importActual<typeof import("@council/domain")>("@council/domain");
  return { ...actual, createConnectorConnectionPolicy: mocks.createConnectorConnectionPolicy };
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect(transport: unknown) { return mocks.connect(transport); }
    close() { return mocks.close(); }
    listTools() { return mocks.listTools(); }
    callTool(input: unknown) { return mocks.callTool(input); }
  }
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL, options: unknown) { mocks.transport(url, options); }
  }
}));

import { McpReadOnlyClient } from "./mcp-client.js";

describe("MCP read-only client", () => {
  afterEach(() => vi.clearAllMocks());

  it("defaults to public endpoints, applies a timeout, and closes the client", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    const closeDispatcher = vi.fn(async () => undefined);
    const dispatcher = { close: closeDispatcher };
    const createDispatcher = vi.fn(() => dispatcher);
    const client = new McpReadOnlyClient({
      connectorId: "docs",
      baseUrl: "https://mcp.example.com/mcp",
      bearerToken: "secret",
      approvedTools: ["search"],
      trustedReadOnlyTools: ["search"],
      timeoutMs: 2_500
    }, { fetcher, createDispatcher });

    await expect(client.discover()).resolves.toEqual([{ name: "search", description: "Read only search", readOnly: true }]);
    expect(mocks.createConnectorConnectionPolicy).toHaveBeenCalledWith("https://mcp.example.com/mcp", false, undefined);
    const options = mocks.transport.mock.calls[0]![1] as {
      requestInit: { headers: Headers; signal: AbortSignal };
      fetch: typeof fetch;
    };
    expect(options.requestInit.headers.get("authorization")).toBe("Bearer secret");
    expect(options.requestInit.signal).toBeInstanceOf(AbortSignal);
    await expect(options.fetch("https://mcp.example.com/mcp", { method: "POST" })).resolves.toHaveProperty("status", 204);
    const requestInit = fetcher.mock.calls[0]![1] as RequestInit & { dispatcher?: unknown };
    expect(requestInit.redirect).toBe("error");
    expect(requestInit.dispatcher).toBe(dispatcher);
    expect(createDispatcher).toHaveBeenCalledWith(mocks.lookup);
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(closeDispatcher).toHaveBeenCalledOnce();
  });

  it("passes the bounded local host allowlist into the connection policy", async () => {
    const client = new McpReadOnlyClient({
      connectorId: "local-docs",
      baseUrl: "http://mcp-readonly:4100/mcp",
      approvedTools: ["search"],
      trustedReadOnlyTools: ["search"],
      allowPrivate: true,
      allowedHosts: ["mcp-readonly"]
    });

    await client.discover();

    expect(mocks.createConnectorConnectionPolicy).toHaveBeenCalledWith(
      "http://mcp-readonly:4100/mcp",
      true,
      undefined,
      ["mcp-readonly"]
    );
  });

  it("rejects tools outside the connector allowlist before connecting", async () => {
    const client = new McpReadOnlyClient({
      connectorId: "docs",
      baseUrl: "https://mcp.example.com/mcp",
      approvedTools: ["search"],
      trustedReadOnlyTools: ["search"]
    });

    await expect(client.call("update_document", {})).rejects.toThrow(/allowlist|not approved|denied/i);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("rejects a remotely self-declared read-only tool without a trusted local registration", async () => {
    const client = new McpReadOnlyClient({
      connectorId: "docs",
      baseUrl: "https://mcp.example.com/mcp",
      approvedTools: ["search"],
      trustedReadOnlyTools: []
    });

    await expect(client.call("search", {})).rejects.toThrow(/local policy/i);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("fails closed when an allowlisted tool is not explicitly read-only", async () => {
    mocks.listTools.mockResolvedValueOnce({
      tools: [{ name: "search", description: "Writes data", annotations: { readOnlyHint: false, destructiveHint: true } }]
    });
    const client = new McpReadOnlyClient({
      connectorId: "docs",
      baseUrl: "https://mcp.example.com/mcp",
      approvedTools: ["search"],
      trustedReadOnlyTools: ["search"]
    });

    await expect(client.call("search", {})).rejects.toThrow(/read-only/i);
    expect(mocks.callTool).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("rejects an MCP semantic error instead of returning it as successful evidence", async () => {
    mocks.callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "remote detail must not become verified evidence" }]
    });
    const client = new McpReadOnlyClient({
      connectorId: "docs",
      baseUrl: "https://mcp.example.com/mcp",
      approvedTools: ["search"],
      trustedReadOnlyTools: ["search"]
    });

    await expect(client.call("search", {})).rejects.toThrow(/reported failure/i);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("bounds MCP response streams before the SDK can buffer them", async () => {
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(9));
        controller.close();
      }
    })));
    const client = new McpReadOnlyClient({
      connectorId: "docs",
      baseUrl: "https://mcp.example.com/mcp",
      approvedTools: ["search"],
      trustedReadOnlyTools: ["search"],
      maxResponseBytes: 8
    }, {
      fetcher,
      createDispatcher: () => ({ close: async () => undefined })
    });

    await client.discover();
    const options = mocks.transport.mock.calls[0]![1] as { fetch: typeof fetch };
    const response = await options.fetch("https://mcp.example.com/mcp", { method: "POST" });

    await expect(response.arrayBuffer()).rejects.toThrow(/size limit/i);
  });
});
