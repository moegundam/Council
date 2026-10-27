import { describe, expect, it, vi } from "vitest";
import { SecretVault } from "@council/domain";
import { InMemoryPlatformStore } from "@council/database";
import { createApp } from "./app.js";

const modelPayload = {
  name: "Retry-safe Model",
  location: "cloud" as const,
  baseUrl: "https://1.1.1.1/v1",
  model: "meeting-model",
  apiKey: "local-model-test-key"
};

class ModelCreateEvidenceStore extends InMemoryPlatformStore {
  readonly auditDetails: Record<string, unknown>[] = [];
  modelCreatedAuditCount = 0;

  override async recordAudit(
    event: string,
    entityType: string,
    entityId: string,
    detail: Record<string, unknown> = {}
  ): Promise<void> {
    if (event === "model_connector.created") {
      this.modelCreatedAuditCount += 1;
      this.auditDetails.push(structuredClone(detail));
    }
    return super.recordAudit(event, entityType, entityId, detail);
  }
}

describe("Model Connector creation idempotency API", () => {
  it("requires a key and binds replay equality to complete metadata plus the API key", async () => {
    const store = new ModelCreateEvidenceStore();
    const secretVault = new SecretVault(Buffer.alloc(32, 51));
    const encryptSpy = vi.spyOn(secretVault, "encrypt");
    const app = await createApp({ store, authDisabled: true, secretVault });

    try {
      const missing = await app.inject({
        method: "POST",
        url: "/api/model-connectors",
        payload: { ...modelPayload, name: "Missing key Model" }
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
      expect(encryptSpy).not.toHaveBeenCalled();

      const key = "model-create-retry";
      const [first, concurrentReplay] = await Promise.all([
        app.inject({
          method: "POST",
          url: "/api/model-connectors",
          headers: { "idempotency-key": key },
          payload: modelPayload
        }),
        app.inject({
          method: "POST",
          url: "/api/model-connectors",
          headers: { "idempotency-key": key },
          payload: structuredClone(modelPayload)
        })
      ]);
      const changedSecret = await app.inject({
        method: "POST",
        url: "/api/model-connectors",
        headers: { "idempotency-key": key },
        payload: { ...modelPayload, apiKey: "changed-local-model-test-key" }
      });
      const changedMetadata = await app.inject({
        method: "POST",
        url: "/api/model-connectors",
        headers: { "idempotency-key": key },
        payload: { ...modelPayload, model: "changed-meeting-model" }
      });

      expect(first.statusCode).toBe(201);
      expect(concurrentReplay.statusCode).toBe(201);
      expect(concurrentReplay.json()).toEqual(first.json());
      expect(changedSecret.statusCode).toBe(409);
      expect(changedSecret.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });
      expect(changedMetadata.statusCode).toBe(409);
      expect(changedMetadata.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });

      const snapshot = await store.getSnapshot();
      expect(snapshot.modelConnectors.filter((connector) => connector.name === modelPayload.name)).toHaveLength(1);
      expect(snapshot.credentials?.filter((credential) => credential.name === `${modelPayload.name} Credential`)).toHaveLength(1);
      expect(store.modelCreatedAuditCount).toBe(1);
      const persistedCiphertext = await store.getConnectorSecret(first.json().id);
      expect(secretVault.decrypt(persistedCiphertext!)).toBe(modelPayload.apiKey);

      const publicEvidence = JSON.stringify({
        first: first.json(),
        concurrentReplay: concurrentReplay.json(),
        snapshot,
        auditDetails: store.auditDetails
      });
      expect(publicEvidence).not.toContain(modelPayload.apiKey);
      expect(publicEvidence).not.toContain("ciphertext");
      expect(publicEvidence).not.toContain("idempotencyProof");
      expect(publicEvidence).not.toContain("hmac-sha256");
    } finally {
      await app.close();
    }
  });

  it("replays a committed create before re-evaluating mutable URL policy", async () => {
    const store = new ModelCreateEvidenceStore();
    const key = "model-policy-stable-replay";
    const payload = {
      name: "Policy-stable replay Model",
      location: "cloud" as const,
      baseUrl: "https://model-replay.invalid/v1",
      model: "replay-model"
    };
    await (store.createModelConnector as (...args: unknown[]) => Promise<unknown>)(payload, undefined, key);
    const app = await createApp({ store, authDisabled: true });

    try {
      const replay = await app.inject({
        method: "POST",
        url: "/api/model-connectors",
        headers: { "idempotency-key": key },
        payload
      });

      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toMatchObject({ name: payload.name, baseUrl: payload.baseUrl });
      expect(store.modelCreatedAuditCount).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("fails closed when the Store returns an added API key field", async () => {
    const store = new InMemoryPlatformStore();
    const createModelConnector = store.createModelConnector.bind(store);
    store.createModelConnector = async (...args) => ({
      ...await createModelConnector(...args),
      apiKey: "must-not-cross-the-response-boundary"
    }) as never;
    const app = await createApp({ store, authDisabled: true });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/model-connectors",
        headers: { "idempotency-key": "model-secret-bearing-response" },
        payload: {
          name: "Response boundary Model",
          location: "cloud",
          baseUrl: "https://1.1.1.1/v1",
          model: "response-boundary"
        }
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ error: { code: "RESPONSE_CONTRACT_VIOLATION" } });
      expect(response.body).not.toContain("must-not-cross-the-response-boundary");
    } finally {
      await app.close();
    }
  });
});
