import { describe, expect, it } from "vitest";
import { InMemoryPlatformStore } from "@council/database";
import { createApp } from "./app.js";

const agentPayload = {
  name: "Retry-safe Agent",
  description: "Created once after a lost acknowledgement.",
  modelConnectorId: null,
  goalSummary: "Protect Agent draft creation from duplicate retries.",
  toolsSummary: "No tools.",
  dataSummary: "No data.",
  skillIds: [],
  toolGrants: [],
  toolPackGrants: [],
  runtimeProfileBinding: null,
  promptBinding: null
};

describe("Agent creation idempotency", () => {
  it("requires a stable key, replays one Agent, and rejects a changed payload", async () => {
    const store = new InMemoryPlatformStore();
    const app = await createApp({ store, authDisabled: true });

    const missing = await app.inject({ method: "POST", url: "/api/agents", payload: agentPayload });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });

    const first = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "idempotency-key": "agent-create-retry" },
      payload: agentPayload
    });
    const replay = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "idempotency-key": "agent-create-retry" },
      payload: agentPayload
    });
    const conflict = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "idempotency-key": "agent-create-retry" },
      payload: { ...agentPayload, name: "Changed retry" }
    });

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });
    expect((await store.getSnapshot()).agents.filter((agent) => agent.id === first.json().id)).toHaveLength(1);
    await app.close();
  });
});
