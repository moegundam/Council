import { describe, expect, it, vi } from "vitest";
import { SecretVault } from "@council/domain";
import { InMemoryPlatformStore } from "@council/database";
import { createApp } from "./app.js";

class CredentialRotationEvidenceStore extends InMemoryPlatformStore {
  credentialRotatedAuditCount = 0;
  readonly rotationAuditDetails: Record<string, unknown>[] = [];

  override async recordAudit(
    event: string,
    entityType: string,
    entityId: string,
    detail: Record<string, unknown> = {}
  ): Promise<void> {
    if (event === "credential.rotated") {
      this.credentialRotatedAuditCount += 1;
      this.rotationAuditDetails.push(structuredClone(detail));
    }
    return super.recordAudit(event, entityType, entityId, detail);
  }
}

async function credentialFixture(store: InMemoryPlatformStore, vault: SecretVault, name: string) {
  return store.createCredential({
    name,
    provider: "test-provider",
    kind: "api_key",
    location: "cloud",
    expiresAt: null
  }, { ciphertext: vault.encrypt("initial-local-secret") });
}

describe("Credential rotation idempotency API", () => {
  it("requires a caller-owned key before encrypting or rotating", async () => {
    const store = new CredentialRotationEvidenceStore();
    const vault = new SecretVault(Buffer.alloc(32, 61));
    const credential = await credentialFixture(store, vault, "Missing rotation key");
    const encryptSpy = vi.spyOn(vault, "encrypt");
    const rotateSpy = vi.spyOn(store, "rotateCredential");
    const app = await createApp({ store, authDisabled: true, secretVault: vault });

    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/credentials/${credential.id}/rotate`,
        payload: {
          credentialId: credential.id,
          secret: "replacement-local-secret",
          expectedSecretRevision: credential.secretRevision
        }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
      expect(encryptSpy).not.toHaveBeenCalled();
      expect(rotateSpy).not.toHaveBeenCalled();
      expect((await store.getCredentials()).find((item) => item.id === credential.id)).toEqual(credential);
    } finally {
      await app.close();
    }
  });

  it("replays one exact rotation and rejects reuse with a changed secret or revision", async () => {
    const store = new CredentialRotationEvidenceStore();
    const vault = new SecretVault(Buffer.alloc(32, 62));
    const credential = await credentialFixture(store, vault, "Retry-safe rotation");
    const rotateSpy = vi.spyOn(store, "rotateCredential");
    const app = await createApp({ store, authDisabled: true, secretVault: vault });
    const key = "credential-rotation-retry";
    const payload = {
      credentialId: credential.id,
      secret: "replacement-local-secret",
      expectedSecretRevision: credential.secretRevision
    };

    try {
      const first = await app.inject({
        method: "POST",
        url: `/api/credentials/${credential.id}/rotate`,
        headers: { "idempotency-key": key },
        payload
      });
      const replay = await app.inject({
        method: "POST",
        url: `/api/credentials/${credential.id}/rotate`,
        headers: { "idempotency-key": key },
        payload: structuredClone(payload)
      });
      const changedSecret = await app.inject({
        method: "POST",
        url: `/api/credentials/${credential.id}/rotate`,
        headers: { "idempotency-key": key },
        payload: { ...payload, secret: "different-local-secret" }
      });
      const changedRevision = await app.inject({
        method: "POST",
        url: `/api/credentials/${credential.id}/rotate`,
        headers: { "idempotency-key": key },
        payload: { ...payload, expectedSecretRevision: credential.secretRevision + 1 }
      });

      expect(first.statusCode).toBe(200);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect(changedSecret.statusCode).toBe(409);
      expect(changedSecret.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });
      expect(changedRevision.statusCode).toBe(409);
      expect(changedRevision.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });
      expect(store.credentialRotatedAuditCount).toBe(1);
      expect((await store.getCredentials()).find((item) => item.id === credential.id)).toEqual(first.json());

      const ciphertext = await store.getCredentialSecret(credential.id);
      expect(vault.decrypt(ciphertext!)).toBe(payload.secret);
      const calls = rotateSpy.mock.calls as unknown[][];
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1]).toMatchObject({
        ciphertext: expect.any(String),
        idempotencyProof: expect.stringMatching(/^hmac-sha256:v1:[a-f0-9]{64}$/)
      });
      expect(calls[0]?.[3]).toBe(key);

      const publicEvidence = JSON.stringify({
        first: first.json(),
        replay: replay.json(),
        audit: store.rotationAuditDetails,
        snapshot: await store.getSnapshot()
      });
      expect(publicEvidence).not.toContain(payload.secret);
      expect(publicEvidence).not.toContain("ciphertext");
      expect(publicEvidence).not.toContain("idempotencyProof");
      expect(publicEvidence).not.toContain("hmac-sha256");
    } finally {
      await app.close();
    }
  });
});
