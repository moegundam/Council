import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn<(transport: unknown) => Promise<void>>(async () => undefined),
  close: vi.fn(async () => undefined),
  callTool: vi.fn<(input: unknown) => Promise<unknown>>(async () => ({})),
  transport: vi.fn<(url: URL, options: unknown) => void>(),
  sessionFetch: vi.fn(),
  closeSession: vi.fn(async () => undefined),
  openConnectorHttpSession: vi.fn(async () => ({
    fetch: mocks.sessionFetch,
    close: mocks.closeSession
  }))
}));

vi.mock("./model-connector.js", () => ({
  openConnectorHttpSession: mocks.openConnectorHttpSession
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect(transport: unknown) { return mocks.connect(transport); }
    close() { return mocks.close(); }
    callTool(input: unknown) { return mocks.callTool(input); }
  }
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL, options: unknown) { mocks.transport(url, options); }
  }
}));

import { HarnessMcpExecutorBackend } from "./harness-executor.js";

describe("Harness MCP executor backend", () => {
  afterEach(() => vi.clearAllMocks());

  it("maps validate, start, status, and cancel to bounded Harness MCP calls and results", async () => {
    mocks.callTool
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Pipeline exists." }] })
      .mockResolvedValueOnce({
        structuredContent: {
          execution_id: "execution-42",
          execution_status: "QUEUED",
          pipeline_id: "deploy_preview"
        }
      })
      .mockResolvedValueOnce({
        content: [{
          type: "text",
          text: JSON.stringify({ id: "execution-42", status: "RUNNING", stage: "deploy" })
        }]
      })
      .mockResolvedValueOnce({
        executionId: "execution-42",
        status: "ABORTED",
        reason: "owner_requested"
      });
    const backend = new HarnessMcpExecutorBackend({
      endpoint: "https://harness.example.com/mcp",
      bearerToken: "harness-secret"
    });
    const request = {
      resourceId: "deploy_preview",
      inputs: { release: "20260720T072200Z" },
      idempotencyKey: "preview-42"
    };

    await expect(backend.validate(request)).resolves.toBeUndefined();
    await expect(backend.start(request)).resolves.toEqual({
      executionId: "execution-42",
      status: "queued"
    });
    await expect(backend.status("execution-42")).resolves.toEqual({
      executionId: "execution-42",
      status: "running"
    });
    await expect(backend.cancel("execution-42")).resolves.toEqual({
      executionId: "execution-42",
      status: "cancelled"
    });

    expect(mocks.callTool.mock.calls.map(([input]) => input)).toEqual([
      {
        name: "harness_get",
        arguments: { resource_type: "pipeline", resource_id: "deploy_preview" }
      },
      {
        name: "harness_execute",
        arguments: {
          resource_type: "pipeline",
          action: "run",
          resource_id: "deploy_preview",
          inputs: { release: "20260720T072200Z" },
          wait: false
        }
      },
      {
        name: "harness_get",
        arguments: { resource_type: "execution", resource_id: "execution-42" }
      },
      {
        name: "harness_execute",
        arguments: { resource_type: "execution", action: "interrupt", resource_id: "execution-42" }
      }
    ]);
    expect(mocks.openConnectorHttpSession).toHaveBeenCalledTimes(4);
    expect(mocks.openConnectorHttpSession).toHaveBeenCalledWith("https://harness.example.com/mcp", true);
    expect(mocks.connect).toHaveBeenCalledTimes(4);
    expect(mocks.close).toHaveBeenCalledTimes(4);
    expect(mocks.closeSession).toHaveBeenCalledTimes(4);
    expect(mocks.transport).toHaveBeenCalledTimes(4);
    const transportOptions = mocks.transport.mock.calls[0]![1] as {
      requestInit: { headers: Record<string, string>; signal: AbortSignal };
      fetch: typeof fetch;
    };
    expect(transportOptions.requestInit.headers.authorization).toBe("Bearer harness-secret");
    expect(transportOptions.requestInit.signal).toBeInstanceOf(AbortSignal);
    expect(transportOptions.fetch).not.toBe(mocks.sessionFetch);
    mocks.sessionFetch.mockImplementation(async () => new Response("ok"));
    const transportFetches = mocks.transport.mock.calls.map(([, options]) =>
      (options as { fetch: typeof fetch }).fetch
    );
    await expect(Promise.all(transportFetches.map(async (fetcher) => {
      const response = await fetcher("https://harness.example.com/mcp", { method: "POST" });
      return response.text();
    }))).resolves.toEqual(["ok", "ok", "ok", "ok"]);
  });

  it("rejects a Harness response advertised over the configured cap before consuming it", async () => {
    let cancelled = false;
    mocks.sessionFetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; }
    }), { headers: { "content-length": "9" } }));
    const backend = new HarnessMcpExecutorBackend({
      endpoint: "https://harness.example.com/mcp",
      bearerToken: "harness-secret",
      maxResponseBytes: 8
    });

    await backend.validate({ resourceId: "deploy_preview", inputs: {} });
    const options = mocks.transport.mock.calls[0]![1] as { fetch: typeof fetch };
    await expect(options.fetch("https://harness.example.com/mcp", { method: "POST" }))
      .rejects.toThrow(/size limit/i);
    expect(cancelled).toBe(true);
  });

  it("cancels a chunked Harness response as soon as it exceeds the configured cap", async () => {
    let cancelled = false;
    mocks.sessionFetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5));
        controller.enqueue(new Uint8Array(4));
      },
      cancel() { cancelled = true; }
    })));
    const backend = new HarnessMcpExecutorBackend({
      endpoint: "https://harness.example.com/mcp",
      bearerToken: "harness-secret",
      maxResponseBytes: 8
    });

    await backend.validate({ resourceId: "deploy_preview", inputs: {} });
    const options = mocks.transport.mock.calls[0]![1] as { fetch: typeof fetch };
    const response = await options.fetch("https://harness.example.com/mcp", { method: "POST" });
    await expect(response.arrayBuffer()).rejects.toThrow(/size limit/i);
    expect(cancelled).toBe(true);
  });

  it("rejects an unbounded Harness request timeout", () => {
    expect(() => new HarnessMcpExecutorBackend({
      endpoint: "https://harness.example.com/mcp",
      bearerToken: "harness-secret",
      timeoutMs: 30_001
    })).toThrow(/timeout/i);
  });

  it.each([0, 16 * 1024 * 1024 + 1])("rejects an invalid Harness response cap of %s bytes", (maxResponseBytes) => {
    expect(() => new HarnessMcpExecutorBackend({
      endpoint: "https://harness.example.com/mcp",
      bearerToken: "harness-secret",
      maxResponseBytes
    })).toThrow(/response size limit/i);
  });

  it("rejects MCP tool-level errors instead of mapping them to a successful execution", async () => {
    mocks.callTool.mockResolvedValue({
      isError: true,
      content: [{ type: "text", text: "remote detail must not escape" }]
    });
    const backend = new HarnessMcpExecutorBackend({
      endpoint: "https://harness.example.com/mcp",
      bearerToken: "harness-secret"
    });
    const request = {
      resourceId: "deploy_preview",
      inputs: { release: "20260720T072200Z" },
      idempotencyKey: "preview-42"
    };

    await expect(backend.validate(request)).rejects.toThrow("Harness MCP tool reported failure.");
    await expect(backend.start(request)).rejects.toThrow("Harness MCP tool reported failure.");
    expect(mocks.callTool).toHaveBeenCalledTimes(2);
    expect(mocks.close).toHaveBeenCalledTimes(2);
    expect(mocks.closeSession).toHaveBeenCalledTimes(2);
  });

  it("rejects a malformed successful start response without an execution identity", async () => {
    mocks.callTool.mockResolvedValueOnce({
      isError: false,
      structuredContent: { execution_status: "QUEUED" }
    });
    const backend = new HarnessMcpExecutorBackend({
      endpoint: "https://harness.example.com/mcp",
      bearerToken: "harness-secret"
    });

    await expect(backend.start({
      resourceId: "deploy_preview",
      inputs: {}
    })).rejects.toThrow(/execution identity/i);
  });

  it("rejects a status response that switches to a different execution identity", async () => {
    mocks.callTool.mockResolvedValueOnce({
      structuredContent: { execution_id: "execution-other", execution_status: "RUNNING" }
    });
    const backend = new HarnessMcpExecutorBackend({
      endpoint: "https://harness.example.com/mcp",
      bearerToken: "harness-secret"
    });

    await expect(backend.status("execution-42")).rejects.toThrow(/does not match/i);
  });

  it("closes the pinned HTTP session when the MCP client cannot close cleanly", async () => {
    mocks.callTool.mockResolvedValueOnce({ structuredContent: { id: "execution-42", status: "RUNNING" } });
    mocks.close.mockRejectedValueOnce(new Error("client close failed"));
    const backend = new HarnessMcpExecutorBackend({
      endpoint: "https://harness.example.com/mcp",
      bearerToken: "harness-secret"
    });

    await expect(backend.status("execution-42")).rejects.toThrow(/client close failed/i);

    expect(mocks.closeSession).toHaveBeenCalledOnce();
  });
});
