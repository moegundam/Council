import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  ExternalExecution,
  ExternalExecutionRequest,
  ExternalExecutorBackend
} from "@council/domain";
import { openConnectorHttpSession } from "./model-connector.js";
import { createBoundedMcpFetch, resolveMcpResponseCap } from "./mcp-client.js";

export interface HarnessExecutorConfig {
  endpoint: string;
  bearerToken: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

function resultRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.structuredContent === "object" && record.structuredContent !== null) {
      return record.structuredContent as Record<string, unknown>;
    }
    const content = Array.isArray(record.content) ? record.content : [];
    for (const entry of content) {
      if (typeof entry === "object" && entry !== null && "text" in entry && typeof entry.text === "string") {
        try {
          const parsed = JSON.parse(entry.text) as unknown;
          if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
        } catch {
          // Harness may return explanatory text with no structured payload.
        }
      }
    }
    return record;
  }
  return {};
}

function executionFrom(value: unknown, expectedId?: string): ExternalExecution {
  const record = resultRecord(value);
  const rawExecutionId = record.execution_id ?? record.executionId ?? record.id;
  if (rawExecutionId !== undefined && (typeof rawExecutionId !== "string" || rawExecutionId.trim() === "")) {
    throw new Error("Harness MCP response contains an invalid execution identity.");
  }
  const explicitId = typeof rawExecutionId === "string" ? rawExecutionId.trim() : undefined;
  if (expectedId && explicitId && explicitId !== expectedId) {
    throw new Error("Harness MCP execution identity does not match the requested execution.");
  }
  const executionId = explicitId ?? expectedId;
  if (!executionId) throw new Error("Harness MCP response is missing an execution identity.");
  const rawStatusValue = record.execution_status ?? record.status;
  const rawStatus = typeof rawStatusValue === "string" ? rawStatusValue.toLocaleLowerCase() : "unknown";
  const status: ExternalExecution["status"] =
    rawStatus.includes("success") ? "succeeded" :
    rawStatus.includes("fail") || rawStatus.includes("error") ? "failed" :
    rawStatus.includes("cancel") || rawStatus.includes("abort") ? "cancelled" :
    rawStatus.includes("run") ? "running" :
    rawStatus.includes("queue") ? "queued" : "unknown";
  return { executionId, status };
}

export class HarnessMcpExecutorBackend implements ExternalExecutorBackend {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly config: HarnessExecutorConfig) {
    this.timeoutMs = config.timeoutMs ?? 15_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000) {
      throw new Error("Harness request timeout must be between 100 and 30000 milliseconds.");
    }
    this.maxResponseBytes = resolveMcpResponseCap(config.maxResponseBytes);
  }

  async validate(request: ExternalExecutionRequest): Promise<void> {
    await this.call("harness_get", {
      resource_type: "pipeline",
      resource_id: request.resourceId
    });
  }

  async start(request: ExternalExecutionRequest): Promise<ExternalExecution> {
    const result = await this.call("harness_execute", {
      resource_type: "pipeline",
      action: "run",
      resource_id: request.resourceId,
      inputs: request.inputs,
      wait: false
    });
    return executionFrom(result);
  }

  async status(executionId: string): Promise<ExternalExecution> {
    const result = await this.call("harness_get", {
      resource_type: "execution",
      resource_id: executionId
    });
    return executionFrom(result, executionId);
  }

  async cancel(executionId: string): Promise<ExternalExecution> {
    const result = await this.call("harness_execute", {
      resource_type: "execution",
      action: "interrupt",
      resource_id: executionId
    });
    return executionFrom(result, executionId);
  }

  private async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const session = await openConnectorHttpSession(this.config.endpoint, true);
    let client: Client | undefined;
    try {
      client = new Client({ name: "council-harness-adapter", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(this.config.endpoint), {
        requestInit: {
          headers: { authorization: `Bearer ${this.config.bearerToken}` },
          signal: AbortSignal.timeout(this.timeoutMs)
        },
        fetch: createBoundedMcpFetch(session.fetch, this.maxResponseBytes)
      });
      await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
      const result = await client.callTool({ name, arguments: args });
      if (typeof result === "object" && result !== null && result.isError === true) {
        throw new Error("Harness MCP tool reported failure.");
      }
      return result;
    } finally {
      try {
        await client?.close();
      } finally {
        await session.close();
      }
    }
  }
}
