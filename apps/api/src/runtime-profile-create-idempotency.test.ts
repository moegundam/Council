import { describe, expect, it } from "vitest";
import { InMemoryPlatformStore } from "@council/database";
import { createApp } from "./app.js";

const runtimeProfilePayload = {
  name: "Retry-safe Runtime Profile",
  harnessKind: "openai_compatible" as const,
  modelConnectorId: null,
  sandboxProfileId: null,
  policy: "text_only" as const,
  capabilities: ["text", "abort"] as const,
  timeoutMs: 60_000,
  maxConcurrency: 1,
  enabled: true
};

class CountingRuntimeProfileAuditStore extends InMemoryPlatformStore {
  runtimeProfileCreatedAuditCount = 0;

  override async recordAudit(
    event: string,
    entityType: string,
    entityId: string,
    detail: Record<string, unknown> = {}
  ): Promise<void> {
    if (event === "runtime_profile.created") this.runtimeProfileCreatedAuditCount += 1;
    return super.recordAudit(event, entityType, entityId, detail);
  }
}

describe("Runtime Profile creation idempotency API", () => {
  it("requires a bounded key, replays one profile, and rejects a changed payload", async () => {
    const store = new CountingRuntimeProfileAuditStore();
    const app = await createApp({ store, authDisabled: true });

    try {
      const missing = await app.inject({
        method: "POST",
        url: "/api/runtime-profiles",
        payload: runtimeProfilePayload
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });

      const key = "runtime-profile-create-retry";
      const [first, replay] = await Promise.all([
        app.inject({
          method: "POST",
          url: "/api/runtime-profiles",
          headers: { "idempotency-key": key },
          payload: runtimeProfilePayload
        }),
        app.inject({
          method: "POST",
          url: "/api/runtime-profiles",
          headers: { "idempotency-key": key },
          payload: runtimeProfilePayload
        })
      ]);
      const conflict = await app.inject({
        method: "POST",
        url: "/api/runtime-profiles",
        headers: { "idempotency-key": key },
        payload: { ...runtimeProfilePayload, maxConcurrency: 2 }
      });

      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });

      const snapshot = await store.getSnapshot();
      expect(snapshot.runtimeProfiles?.filter((profile) => profile.name === runtimeProfilePayload.name)).toHaveLength(1);
      expect(snapshot.runtimeProfileRevisions?.filter((revision) => revision.profileId === first.json().id)).toHaveLength(1);
      expect(store.runtimeProfileCreatedAuditCount).toBe(1);
    } finally {
      await app.close();
    }
  });
});
