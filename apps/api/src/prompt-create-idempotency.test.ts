import { describe, expect, it } from "vitest";
import { InMemoryPlatformStore } from "@council/database";
import { createApp } from "./app.js";

const promptPayload = {
  name: "Retry-safe Prompt",
  kind: "agent" as const,
  description: "One durable Prompt for one create intent.",
  owner: "Platform Owner",
  content: "Review {{MEETING_GOAL}} without duplicating the Prompt.",
  variables: ["MEETING_GOAL"]
};

class CountingPromptAuditStore extends InMemoryPlatformStore {
  promptCreatedAuditCount = 0;

  override async recordAudit(
    event: string,
    entityType: string,
    entityId: string,
    detail: Record<string, unknown> = {}
  ): Promise<void> {
    if (event === "prompt.created") this.promptCreatedAuditCount += 1;
    return super.recordAudit(event, entityType, entityId, detail);
  }
}

describe("Prompt creation idempotency API", () => {
  it("requires a key and replays one Prompt for the same complete payload", async () => {
    const store = new CountingPromptAuditStore();
    const app = await createApp({ store, authDisabled: true });

    try {
      const missing = await app.inject({
        method: "POST",
        url: "/api/prompts",
        payload: { ...promptPayload, name: "Missing Prompt key" }
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });

      const request = {
        method: "POST" as const,
        url: "/api/prompts",
        headers: { "idempotency-key": "prompt-create-retry" },
        payload: promptPayload
      };
      const [first, concurrentReplay] = await Promise.all([
        app.inject(request),
        app.inject({ ...request, payload: structuredClone(promptPayload) })
      ]);
      const laterReplay = await app.inject(request);
      const changed = await app.inject({
        ...request,
        payload: { ...promptPayload, description: "Changed retry payload." }
      });

      expect(first.statusCode).toBe(201);
      expect(concurrentReplay.statusCode).toBe(201);
      expect(concurrentReplay.json()).toEqual(first.json());
      expect(laterReplay.json()).toEqual(first.json());
      expect(changed.statusCode).toBe(409);
      expect(changed.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });
      expect((await store.getPrompts()).filter((prompt) => prompt.name === promptPayload.name)).toHaveLength(1);
      expect(store.promptCreatedAuditCount).toBe(1);
    } finally {
      await app.close();
    }
  });
});
