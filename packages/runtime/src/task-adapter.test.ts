import { describe, expect, it, vi } from "vitest";
import type { TaskAdapterUpsertPayload } from "@council/contracts";
import { TaskAdapterClient } from "./task-adapter.js";

const payload: TaskAdapterUpsertPayload = {
  taskId: "10000000-0000-4000-8000-000000000001",
  meetingId: "20000000-0000-4000-8000-000000000001",
  decisionId: "30000000-0000-4000-8000-000000000001",
  title: "Ship",
  description: "Fixed payload",
  status: "todo",
  assignee: null,
  dueAt: null,
  acceptanceCriteria: "External ID returned",
  executionProfile: "manual",
  allowedTools: [],
  dataScope: "Decision only",
  approvalState: "not_required"
};
const idempotencyKey = `${payload.taskId}:${"a".repeat(64)}`;

describe("Task Adapter client", () => {
  it("uses the fixed upsert path, bounded payload, bearer token, and Task idempotency key", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ externalId: "REF-42" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const client = new TaskAdapterClient({
      baseUrl: "https://tasks.example.com",
      bearerToken: "secret-token"
    }, { fetcher, resolver: async () => ["93.184.216.34"] });

    await expect(client.upsert(payload, idempotencyKey)).resolves.toEqual({ externalId: "REF-42" });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://tasks.example.com/v1/tasks/upsert");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe(idempotencyKey);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-token");
    expect(JSON.parse(String(init?.body))).toEqual(payload);
  });

  it("checks only the fixed health path", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    const client = new TaskAdapterClient({ baseUrl: "http://task-adapter:4200", allowPrivate: true }, {
      fetcher,
      resolver: async () => ["172.18.0.10"]
    });
    await expect(client.health()).resolves.toBe(true);
    expect(String(fetcher.mock.calls[0]![0])).toBe("http://task-adapter:4200/health");
  });

  it("does not expose provider response bodies in errors", async () => {
    const client = new TaskAdapterClient({ baseUrl: "https://tasks.example.com" }, {
      fetcher: async () => new Response("provider-secret", { status: 503 }),
      resolver: async () => ["93.184.216.34"]
    });
    await expect(client.upsert(payload, idempotencyKey)).rejects.toThrow(/503/);
    await expect(client.upsert(payload, idempotencyKey)).rejects.not.toThrow(/provider-secret/);
  });

  it("rejects oversized and malformed success responses", async () => {
    for (const response of [
      new Response("x".repeat(65_537), { status: 200 }),
      new Response(JSON.stringify({ externalId: "x".repeat(201) }), { status: 200 })
    ]) {
      const client = new TaskAdapterClient({ baseUrl: "https://tasks.example.com" }, {
        fetcher: async () => response,
        resolver: async () => ["93.184.216.34"]
      });
      await expect(client.upsert(payload, idempotencyKey)).rejects.toThrow();
    }
  });

  it("rejects an idempotency key that is not bound to the Task and payload intent", async () => {
    const fetcher = vi.fn();
    const client = new TaskAdapterClient({ baseUrl: "https://tasks.example.com" }, {
      fetcher,
      resolver: async () => ["93.184.216.34"]
    });

    await expect(client.upsert(payload, payload.taskId)).rejects.toThrow(/idempotency key/i);
    await expect(client.upsert(payload, `${payload.taskId}:${"z".repeat(64)}`)).rejects.toThrow(/idempotency key/i);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
