import { describe, expect, it } from "vitest";
import { InMemoryPlatformStore } from "@council/database";
import { createApp } from "./app.js";

const rolePayload = {
  name: "Retry-safe API Role",
  usageContext: "Use for retried Role creation requests.",
  responsibility: "Create exactly one Role through the API.",
  speakingGuidance: "Return the original persisted Role on replay.",
  decisionScope: "Recommend without approving unrelated changes.",
  constraints: "Bind the idempotency key to this complete payload.",
  templateKey: null,
  toolPolicy: "none",
  dataPolicy: "meeting_only"
};

class CountingRoleAuditStore extends InMemoryPlatformStore {
  roleCreatedAuditCount = 0;

  override async recordAudit(
    event: string,
    entityType: string,
    entityId: string,
    detail: Record<string, unknown> = {}
  ): Promise<void> {
    if (event === "role.created") this.roleCreatedAuditCount += 1;
    return super.recordAudit(event, entityType, entityId, detail);
  }
}

describe("Role creation idempotency API", () => {
  it("requires a bounded key, replays one Role, and rejects a changed payload", async () => {
    const store = new CountingRoleAuditStore();
    const app = await createApp({ store, authDisabled: true });

    try {
      const missing = await app.inject({ method: "POST", url: "/api/roles", payload: rolePayload });
      const blank = await app.inject({
        method: "POST",
        url: "/api/roles",
        headers: { "idempotency-key": "   " },
        payload: rolePayload
      });
      const oversized = await app.inject({
        method: "POST",
        url: "/api/roles",
        headers: { "idempotency-key": "r".repeat(201) },
        payload: rolePayload
      });

      expect(missing.statusCode).toBe(400);
      expect(missing.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
      expect(blank.statusCode).toBe(400);
      expect(oversized.statusCode).toBe(400);

      const key = "r".repeat(200);
      const first = await app.inject({
        method: "POST",
        url: "/api/roles",
        headers: { "idempotency-key": key },
        payload: rolePayload
      });
      const replay = await app.inject({
        method: "POST",
        url: "/api/roles",
        headers: { "idempotency-key": key },
        payload: rolePayload
      });
      const conflict = await app.inject({
        method: "POST",
        url: "/api/roles",
        headers: { "idempotency-key": key },
        payload: { ...rolePayload, responsibility: "Changed retry payload." }
      });

      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });

      const snapshot = await store.getSnapshot();
      expect(snapshot.roles.filter((role) => role.name === rolePayload.name)).toHaveLength(1);
      expect(await store.getRoleVersions(first.json().id)).toHaveLength(1);
      expect(store.roleCreatedAuditCount).toBe(1);
    } finally {
      await app.close();
    }
  });
});
