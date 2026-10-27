import {
  taskAdapterUpsertPayloadSchema,
  taskAdapterUpsertResponseSchema,
  type TaskAdapterUpsertPayload,
  type TaskAdapterUpsertResponse
} from "@council/contracts";
import { openConnectorHttpSession, type ConnectorHttpDependencies } from "./model-connector.js";

export interface TaskAdapterClientConfig {
  baseUrl: string;
  bearerToken?: string;
  allowPrivate?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > maxBytes) throw new Error("Task Adapter response exceeds the size limit.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("Task Adapter response exceeds the size limit.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export class TaskAdapterClient {
  constructor(
    private readonly config: TaskAdapterClientConfig,
    private readonly httpDependencies: ConnectorHttpDependencies = {}
  ) {}

  async health(): Promise<boolean> {
    const session = await this.openSession();
    let response: Response | undefined;
    try {
      response = await session.fetch(new URL("/health", this.config.baseUrl), {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 5_000)
      });
      return response.ok;
    } finally {
      await response?.body?.cancel().catch(() => undefined);
      await session.close();
    }
  }

  async upsert(input: TaskAdapterUpsertPayload, idempotencyKey: string): Promise<TaskAdapterUpsertResponse> {
    const payload = taskAdapterUpsertPayloadSchema.parse(input);
    const keyPrefix = `${payload.taskId}:`;
    const fingerprint = idempotencyKey.startsWith(keyPrefix) ? idempotencyKey.slice(keyPrefix.length) : "";
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw new Error("Task Adapter idempotency key must bind the Task ID to a payload fingerprint.");
    }
    const session = await this.openSession();
    let response: Response | undefined;
    try {
      response = await session.fetch(new URL("/v1/tasks/upsert", this.config.baseUrl), {
        method: "POST",
        headers: this.headers({
          "content-type": "application/json",
          "idempotency-key": idempotencyKey
        }),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000)
      });
      if (!response.ok) throw new Error(`Task Adapter request failed with status ${response.status}.`);
      const text = await readBoundedText(response, this.config.maxResponseBytes ?? 65_536);
      return taskAdapterUpsertResponseSchema.parse(JSON.parse(text));
    } finally {
      await response?.body?.cancel().catch(() => undefined);
      await session.close();
    }
  }

  private openSession() {
    return openConnectorHttpSession(
      this.config.baseUrl,
      this.config.allowPrivate ?? false,
      this.httpDependencies
    );
  }

  private headers(extra: Record<string, string> = {}): Headers {
    const headers = new Headers(extra);
    if (this.config.bearerToken) headers.set("authorization", `Bearer ${this.config.bearerToken}`);
    return headers;
  }
}
