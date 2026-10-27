import { describe, expect, it } from "vitest";
import { InMemoryPlatformStore } from "@council/database";
import { createApp } from "./app.js";

const skillPayload = {
  name: "Retry-safe Skill",
  version: "1.0.0",
  instructions: "Return the original Skill when creation is retried.",
  source: "internal",
  owner: "Platform Owner"
};

class CountingSkillAuditStore extends InMemoryPlatformStore {
  skillCreatedAuditCount = 0;

  override async recordAudit(
    event: string,
    entityType: string,
    entityId: string,
    detail: Record<string, unknown> = {}
  ): Promise<void> {
    if (event === "skill.created") this.skillCreatedAuditCount += 1;
    return super.recordAudit(event, entityType, entityId, detail);
  }
}

describe("Skill creation idempotency API", () => {
  it("requires a bounded key, replays one Skill, and rejects a changed payload", async () => {
    const store = new CountingSkillAuditStore();
    const app = await createApp({ store, authDisabled: true });

    try {
      const missing = await app.inject({ method: "POST", url: "/api/skills", payload: skillPayload });
      expect(missing.statusCode).toBe(400);
      expect(missing.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });

      const key = "skill-create-retry";
      const first = await app.inject({
        method: "POST",
        url: "/api/skills",
        headers: { "idempotency-key": key },
        payload: skillPayload
      });
      const replay = await app.inject({
        method: "POST",
        url: "/api/skills",
        headers: { "idempotency-key": key },
        payload: skillPayload
      });
      const conflict = await app.inject({
        method: "POST",
        url: "/api/skills",
        headers: { "idempotency-key": key },
        payload: { ...skillPayload, instructions: "Changed retry payload." }
      });

      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });
      expect((await store.getSnapshot()).skills.filter((skill) => skill.name === skillPayload.name)).toHaveLength(1);
      expect(store.skillCreatedAuditCount).toBe(1);
    } finally {
      await app.close();
    }
  });
});
