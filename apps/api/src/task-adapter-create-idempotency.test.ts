import { describe, expect, it, vi } from "vitest";
import { SecretVault } from "@council/domain";
import { InMemoryPlatformStore, type SecretInput } from "@council/database";
import { createApp } from "./app.js";

const taskAdapterPayload = {
  name: "Retry-safe Task Adapter",
  location: "cloud" as const,
  baseUrl: "https://1.1.1.1",
  bearerToken: "local-task-adapter-test-token"
};

class TaskAdapterCreateEvidenceStore extends InMemoryPlatformStore {
  readonly auditDetails: Record<string, unknown>[] = [];
  taskAdapterCreatedAuditCount = 0;

  override async recordAudit(
    event: string,
    entityType: string,
    entityId: string,
    detail: Record<string, unknown> = {}
  ): Promise<void> {
    if (event === "task_adapter.created") {
      this.taskAdapterCreatedAuditCount += 1;
      this.auditDetails.push(structuredClone(detail));
    }
    return super.recordAudit(event, entityType, entityId, detail);
  }
}

describe("Task Adapter Connector creation idempotency API", () => {
  it("requires a key and binds replay equality to complete metadata plus secret without exposing secret evidence", async () => {
    const store = new TaskAdapterCreateEvidenceStore();
    const createSpy = vi.spyOn(store, "createTaskAdapterConnector");
    const replaySpy = vi.spyOn(store, "replayTaskAdapterConnectorCreate");
    const secretVault = new SecretVault(Buffer.alloc(32, 42));
    const encryptSpy = vi.spyOn(secretVault, "encrypt");
    const app = await createApp({ store, authDisabled: true, secretVault });

    try {
      const missing = await app.inject({
        method: "POST",
        url: "/api/task-adapter-connectors",
        payload: { ...taskAdapterPayload, name: "Missing key Task Adapter" }
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
      expect(createSpy).not.toHaveBeenCalled();
      expect(encryptSpy).not.toHaveBeenCalled();

      const key = "task-adapter-create-retry";
      const [first, concurrentReplay] = await Promise.all([
        app.inject({
          method: "POST",
          url: "/api/task-adapter-connectors",
          headers: { "idempotency-key": key },
          payload: taskAdapterPayload
        }),
        app.inject({
          method: "POST",
          url: "/api/task-adapter-connectors",
          headers: { "idempotency-key": key },
          payload: structuredClone(taskAdapterPayload)
        })
      ]);
      const changedSecret = await app.inject({
        method: "POST",
        url: "/api/task-adapter-connectors",
        headers: { "idempotency-key": key },
        payload: { ...taskAdapterPayload, bearerToken: "changed-task-adapter-test-token" }
      });
      const changedMetadata = await app.inject({
        method: "POST",
        url: "/api/task-adapter-connectors",
        headers: { "idempotency-key": key },
        payload: { ...taskAdapterPayload, baseUrl: "https://1.0.0.1" }
      });

      expect(first.statusCode).toBe(201);
      expect(concurrentReplay.statusCode).toBe(201);
      expect(concurrentReplay.json()).toEqual(first.json());
      expect(changedSecret.statusCode).toBe(409);
      expect(changedSecret.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });
      expect(changedMetadata.statusCode).toBe(409);
      expect(changedMetadata.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });

      const replayCalls = replaySpy.mock.calls as unknown as Array<[
        unknown,
        SecretInput | undefined,
        string | undefined
      ]>;
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(replayCalls).toHaveLength(4);
      expect(replayCalls[0]?.[1]?.ciphertext).not.toBe(replayCalls[1]?.[1]?.ciphertext);
      expect(replayCalls[0]?.[1]?.idempotencyProof).toBe(replayCalls[1]?.[1]?.idempotencyProof);
      expect(replayCalls[2]?.[1]?.idempotencyProof).not.toBe(replayCalls[0]?.[1]?.idempotencyProof);
      expect(replayCalls[3]?.[1]?.idempotencyProof).toBe(replayCalls[0]?.[1]?.idempotencyProof);
      expect(replayCalls[0]?.[1]?.idempotencyProof).toMatch(/^hmac-sha256:v1:[a-f0-9]{64}$/);
      expect(replayCalls.map((call) => call[2])).toEqual([key, key, key, key]);

      const snapshot = await store.getSnapshot();
      expect(snapshot.taskAdapterConnectors).toHaveLength(1);
      expect(store.taskAdapterCreatedAuditCount).toBe(1);
      const persistedCiphertext = await store.getConnectorSecret(first.json().id);
      expect(secretVault.decrypt(persistedCiphertext!)).toBe(taskAdapterPayload.bearerToken);

      const publicEvidence = JSON.stringify({
        first: first.json(),
        concurrentReplay: concurrentReplay.json(),
        snapshot,
        auditDetails: store.auditDetails
      });
      expect(publicEvidence).not.toContain(taskAdapterPayload.bearerToken);
      expect(publicEvidence).not.toContain("ciphertext");
      expect(publicEvidence).not.toContain("idempotencyProof");
      expect(publicEvidence).not.toContain("hmac-sha256");
    } finally {
      await app.close();
    }
  });

  it("replays secret-free Task Adapter creation without a configured vault", async () => {
    const store = new TaskAdapterCreateEvidenceStore();
    const app = await createApp({ store, authDisabled: true });
    const { bearerToken: _bearerToken, ...payload } = taskAdapterPayload;

    try {
      const [first, replay] = await Promise.all([
        app.inject({
          method: "POST",
          url: "/api/task-adapter-connectors",
          headers: { "idempotency-key": "secret-free-task-adapter" },
          payload: { ...payload, name: "Secret-free retry Task Adapter" }
        }),
        app.inject({
          method: "POST",
          url: "/api/task-adapter-connectors",
          headers: { "idempotency-key": "secret-free-task-adapter" },
          payload: { ...payload, name: "Secret-free retry Task Adapter" }
        })
      ]);

      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(first.json()).toMatchObject({ hasSecret: false });
      expect(store.taskAdapterCreatedAuditCount).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("fails closed when the store returns an unexpected secret-bearing create response", async () => {
    const store = new InMemoryPlatformStore();
    const createTaskAdapterConnector = store.createTaskAdapterConnector.bind(store);
    store.createTaskAdapterConnector = async (...args) => ({
      ...await createTaskAdapterConnector(...args),
      bearerToken: "must-not-cross-the-task-adapter-response-boundary"
    }) as never;
    const app = await createApp({ store, authDisabled: true });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/task-adapter-connectors",
        headers: { "idempotency-key": "task-adapter-secret-bearing-response" },
        payload: {
          name: "Response boundary Task Adapter",
          location: "cloud",
          baseUrl: "https://1.1.1.1"
        }
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ error: { code: "RESPONSE_CONTRACT_VIOLATION" } });
      expect(response.body).not.toContain("must-not-cross-the-task-adapter-response-boundary");
    } finally {
      await app.close();
    }
  });
});
