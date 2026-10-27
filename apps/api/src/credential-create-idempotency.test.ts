import { describe, expect, it, vi } from "vitest";
import { SecretVault } from "@council/domain";
import {
  InMemoryPlatformStore,
  type CreateCredentialMetadataInput,
  type SecretInput
} from "@council/database";
import { createApp } from "./app.js";

const credentialPayload = {
  name: "Retry-safe Credential",
  provider: "test-provider",
  kind: "api_key" as const,
  location: "cloud" as const,
  secret: "local-test-secret",
  expiresAt: null
};

class CredentialCreateEvidenceStore extends InMemoryPlatformStore {
  readonly createSecrets: Array<SecretInput | undefined> = [];
  readonly auditDetails: Record<string, unknown>[] = [];
  credentialCreatedAuditCount = 0;

  override async createCredential(
    input: CreateCredentialMetadataInput,
    secret?: SecretInput,
    idempotencyKey?: string
  ) {
    this.createSecrets.push(secret ? structuredClone(secret) : undefined);
    return super.createCredential(input, secret, idempotencyKey);
  }

  override async recordAudit(
    event: string,
    entityType: string,
    entityId: string,
    detail: Record<string, unknown> = {}
  ): Promise<void> {
    if (event === "credential.created") {
      this.credentialCreatedAuditCount += 1;
      this.auditDetails.push(structuredClone(detail));
    }
    return super.recordAudit(event, entityType, entityId, detail);
  }
}

describe("Credential creation idempotency API", () => {
  it("requires a key and binds replay equality to metadata plus the secret without exposing secret evidence", async () => {
    const store = new CredentialCreateEvidenceStore();
    const secretVault = new SecretVault(Buffer.alloc(32, 31));
    const encryptSpy = vi.spyOn(secretVault, "encrypt");
    const app = await createApp({ store, authDisabled: true, secretVault });

    try {
      const missing = await app.inject({
        method: "POST",
        url: "/api/credentials",
        payload: { ...credentialPayload, name: "Missing key Credential" }
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
      expect(encryptSpy).not.toHaveBeenCalled();

      const key = "credential-create-retry";
      const [first, replay] = await Promise.all([
        app.inject({
          method: "POST",
          url: "/api/credentials",
          headers: { "idempotency-key": key },
          payload: credentialPayload
        }),
        app.inject({
          method: "POST",
          url: "/api/credentials",
          headers: { "idempotency-key": key },
          payload: credentialPayload
        })
      ]);
      const changedSecret = await app.inject({
        method: "POST",
        url: "/api/credentials",
        headers: { "idempotency-key": key },
        payload: { ...credentialPayload, secret: "changed-local-test-secret" }
      });
      const changedMetadata = await app.inject({
        method: "POST",
        url: "/api/credentials",
        headers: { "idempotency-key": key },
        payload: { ...credentialPayload, provider: "changed-provider" }
      });

      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(changedSecret.statusCode).toBe(409);
      expect(changedSecret.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });
      expect(changedMetadata.statusCode).toBe(409);
      expect(changedMetadata.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });
      expect(store.createSecrets).toHaveLength(4);
      expect(store.createSecrets[0]?.ciphertext).not.toBe(store.createSecrets[1]?.ciphertext);
      expect(store.createSecrets[0]?.idempotencyProof).toBe(store.createSecrets[1]?.idempotencyProof);
      expect(store.createSecrets[2]?.idempotencyProof).not.toBe(store.createSecrets[0]?.idempotencyProof);
      expect(store.createSecrets[3]?.idempotencyProof).toBe(store.createSecrets[0]?.idempotencyProof);
      expect(store.createSecrets[0]?.idempotencyProof).toMatch(/^hmac-sha256:v1:[a-f0-9]{64}$/);

      const snapshot = await store.getSnapshot();
      expect(snapshot.credentials?.filter((credential) => credential.name === credentialPayload.name)).toHaveLength(1);
      expect(store.credentialCreatedAuditCount).toBe(1);
      const persistedCiphertext = await store.getCredentialSecret(first.json().id);
      expect(secretVault.decrypt(persistedCiphertext!)).toBe(credentialPayload.secret);

      const publicEvidence = JSON.stringify({
        first: first.json(),
        replay: replay.json(),
        snapshot,
        auditDetails: store.auditDetails
      });
      expect(publicEvidence).not.toContain(credentialPayload.secret);
      expect(publicEvidence).not.toContain("ciphertext");
      expect(publicEvidence).not.toContain("idempotencyProof");
      expect(publicEvidence).not.toContain("hmac-sha256");
    } finally {
      await app.close();
    }
  });

  it("replays metadata-only creation without a configured vault", async () => {
    const store = new CredentialCreateEvidenceStore();
    const app = await createApp({ store, authDisabled: true });
    const payload = {
      name: "Cloud key deferred",
      provider: "cloud-provider",
      kind: "api_key" as const,
      location: "cloud" as const,
      expiresAt: null
    };

    try {
      const [first, replay] = await Promise.all([
        app.inject({
          method: "POST",
          url: "/api/credentials",
          headers: { "idempotency-key": "metadata-only-credential" },
          payload
        }),
        app.inject({
          method: "POST",
          url: "/api/credentials",
          headers: { "idempotency-key": "metadata-only-credential" },
          payload
        })
      ]);

      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(first.json()).toMatchObject({ hasSecret: false, secretRevision: 0 });
      expect(store.createSecrets).toEqual([undefined, undefined]);
      expect(store.credentialCreatedAuditCount).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("binds secret proof to the caller key without returning the proof", async () => {
    const store = new CredentialCreateEvidenceStore();
    const secretVault = new SecretVault(Buffer.alloc(32, 32));
    const app = await createApp({ store, authDisabled: true, secretVault });

    try {
      const first = await app.inject({
        method: "POST",
        url: "/api/credentials",
        headers: { "idempotency-key": "credential-key-a" },
        payload: { ...credentialPayload, name: "Credential key A" }
      });
      const second = await app.inject({
        method: "POST",
        url: "/api/credentials",
        headers: { "idempotency-key": "credential-key-b" },
        payload: { ...credentialPayload, name: "Credential key B" }
      });

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(store.createSecrets[0]?.idempotencyProof).not.toBe(store.createSecrets[1]?.idempotencyProof);
      expect(JSON.stringify([first.json(), second.json()])).not.toContain("hmac-sha256");
    } finally {
      await app.close();
    }
  });
});
