import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  MAX_RESPONSE_BYTES,
  createTaskAdapterServer,
  readTaskAdapterToken,
  readServerConfig
} from "./server.js";

const validPayload = {
  taskId: "10000000-0000-4000-8000-000000000001",
  meetingId: "20000000-0000-4000-8000-000000000001",
  decisionId: "30000000-0000-4000-8000-000000000001",
  title: "Ship the reference adapter",
  description: "Exercise the fixed Task Adapter protocol.",
  status: "todo",
  assignee: null,
  dueAt: null,
  acceptanceCriteria: "Return a stable external ID.",
  executionProfile: "manual",
  allowedTools: [],
  dataScope: "Decision only",
  approvalState: "not_required"
};

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function startServer(options: Parameters<typeof createTaskAdapterServer>[0] = {}) {
  const server = createTaskAdapterServer(options);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function upsert(baseUrl: string, payload: typeof validPayload = validPayload, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/v1/tasks/upsert`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `${payload.taskId}:${"a".repeat(64)}`,
      ...headers
    },
    body: JSON.stringify(payload)
  });
}

describe("Task Adapter reference server", () => {
  it("serves a bounded health response and defaults to loopback", async () => {
    expect(readServerConfig({})).toEqual({
      host: DEFAULT_HOST,
      port: DEFAULT_PORT
    });
    expect(readServerConfig({ HOST: "0.0.0.0", PORT: "4312" })).toEqual({
      host: "0.0.0.0",
      port: 4312
    });

    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
    expect(Number(response.headers.get("content-length"))).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });

  it("loads the bearer token from one protected secret source", async () => {
    const directory = await mkdtemp(join(tmpdir(), "council-task-adapter-"));
    const tokenFile = join(directory, "token");
    try {
      await writeFile(tokenFile, "file-token\n", { mode: 0o600 });
      expect(readTaskAdapterToken({ TASK_ADAPTER_TOKEN_FILE: tokenFile })).toBe("file-token");
      expect(() => readTaskAdapterToken({
        TASK_ADAPTER_TOKEN: "inline-token",
        TASK_ADAPTER_TOKEN_FILE: tokenFile
      })).toThrow("Set only one");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns the same bounded external ID across repeated stateless upserts", async () => {
    const firstBaseUrl = await startServer();
    const secondBaseUrl = await startServer();
    const first = await upsert(firstBaseUrl);
    const second = await upsert(secondBaseUrl, { ...validPayload, title: "Updated title" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = await first.json() as { externalId: string };
    const secondBody = await second.json() as { externalId: string };
    expect(secondBody).toEqual(firstBody);
    expect(firstBody.externalId).toMatch(/^task_[a-f0-9]{32}$/);
    expect(firstBody.externalId.length).toBeLessThanOrEqual(200);
    expect(Number(first.headers.get("content-length"))).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });

  it("enforces the configured bearer token without reflecting it", async () => {
    const token = "top-secret-adapter-token";
    const baseUrl = await startServer({ token });

    const missing = await upsert(baseUrl);
    const wrong = await upsert(baseUrl, validPayload, { authorization: "Bearer wrong" });
    const accepted = await upsert(baseUrl, validPayload, { authorization: `Bearer ${token}` });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(JSON.stringify(await wrong.json())).not.toContain(token);
    expect(accepted.status).toBe(200);
  });

  it("rejects malformed JSON, unknown fields, and missing or mismatched idempotency keys", async () => {
    const baseUrl = await startServer();
    const malformed = await fetch(`${baseUrl}/v1/tasks/upsert`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `${validPayload.taskId}:${"a".repeat(64)}`
      },
      body: "{"
    });
    const unknown = await upsert(baseUrl, { ...validPayload, transcript: "must stay internal" } as typeof validPayload);
    const missing = await fetch(`${baseUrl}/v1/tasks/upsert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validPayload)
    });
    const mismatched = await upsert(baseUrl, validPayload, { "idempotency-key": crypto.randomUUID() });

    expect(malformed.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(missing.status).toBe(400);
    expect(mismatched.status).toBe(400);
  });

  it("rejects unsupported content types and oversized request bodies", async () => {
    const baseUrl = await startServer({ maxBodyBytes: 64 });
    const unsupported = await fetch(`${baseUrl}/v1/tasks/upsert`, {
      method: "POST",
      body: JSON.stringify(validPayload)
    });
    const oversized = await upsert(baseUrl);

    expect(unsupported.status).toBe(415);
    expect(oversized.status).toBe(413);
    expect(Number(oversized.headers.get("content-length"))).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });
});
