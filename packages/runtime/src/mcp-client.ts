import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { DiscoveredMcpTool } from "@council/contracts";
import { ToolPolicy } from "@council/domain";
import {
  openConnectorHttpSession,
  type ConnectorFetch,
  type ConnectorHttpDependencies
} from "./model-connector.js";

export interface McpClientConfig {
  connectorId: string;
  baseUrl: string;
  bearerToken?: string;
  approvedTools: string[];
  trustedReadOnlyTools: string[];
  allowPrivate?: boolean;
  allowedHosts?: readonly string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const defaultMcpResponseCapBytes = 1024 * 1024;
const maxMcpResponseCapBytes = 16 * 1024 * 1024;

export function resolveMcpResponseCap(maxResponseBytes?: number): number {
  const maxBytes = maxResponseBytes ?? defaultMcpResponseCapBytes;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > maxMcpResponseCapBytes) {
    throw new Error("MCP response size limit must be between 1 byte and 16 MiB.");
  }
  return maxBytes;
}

export async function boundedMcpResponse(response: Response, maxBytes: number): Promise<Response> {
  const advertisedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("MCP response exceeds the size limit.");
  }
  if (!response.body) return response;

  const reader = response.body.getReader();
  let total = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          controller.error(new Error("MCP response exceeds the size limit."));
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    }
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

export function createBoundedMcpFetch(fetcher: ConnectorFetch, maxResponseBytes?: number): ConnectorFetch {
  const maxBytes = resolveMcpResponseCap(maxResponseBytes);
  return async (input, init) => boundedMcpResponse(await fetcher(input, init), maxBytes);
}

export class McpReadOnlyClient {
  constructor(
    private readonly config: McpClientConfig,
    private readonly httpDependencies: ConnectorHttpDependencies = {}
  ) {}

  async discover(): Promise<DiscoveredMcpTool[]> {
    return this.withClient(async (client) => {
      const result = await client.listTools();
      return result.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        readOnly: tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true
      }));
    });
  }

  async call(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const policy = new ToolPolicy(this.config.approvedTools.map((name) => ({
      connectorId: this.config.connectorId,
      toolName: name,
      effect: "read"
    })));
    const authorization = policy.authorize(this.config.connectorId, toolName);
    if (!authorization.allowed) throw new Error(authorization.reason ?? "Tool call denied.");
    if (!this.config.trustedReadOnlyTools.includes(toolName)) {
      throw new Error("MCP tool is not registered as read-only by local policy.");
    }
    return this.withClient(async (client) => {
      const discovered = await client.listTools();
      const tool = discovered.tools.find((item) => item.name === toolName);
      if (!tool) throw new Error("MCP tool is no longer available.");
      if (tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint === true) {
        throw new Error("MCP tool is not explicitly declared read-only.");
      }
      const result = await client.callTool({ name: toolName, arguments: args });
      if (result.isError === true) throw new Error("MCP tool reported failure.");
      return result;
    });
  }

  private async withClient<T>(action: (client: Client) => Promise<T>): Promise<T> {
    const maxResponseBytes = resolveMcpResponseCap(this.config.maxResponseBytes);
    const session = await openConnectorHttpSession(
      this.config.baseUrl,
      this.config.allowPrivate ?? false,
      {
        ...this.httpDependencies,
        ...(this.config.allowedHosts === undefined
          ? {}
          : { allowedHosts: this.config.allowedHosts })
      }
    );
    let client: Client | undefined;
    try {
      client = new Client({ name: "council-mcp-client", version: "0.1.0" });
      const headers = new Headers();
      if (this.config.bearerToken) headers.set("authorization", `Bearer ${this.config.bearerToken}`);
      const transport = new StreamableHTTPClientTransport(new URL(this.config.baseUrl), {
        requestInit: { headers, signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000) },
        fetch: createBoundedMcpFetch(session.fetch, maxResponseBytes)
      });
      await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
      return await action(client);
    } finally {
      try {
        await client?.close();
      } finally {
        await session.close();
      }
    }
  }
}
