import { describe, expect, it } from "vitest";
import { InMemoryPlatformStore } from "./memory-store.js";

type RotationMethod = (
  input: { credentialId: string; expectedSecretRevision: number },
  secret: { ciphertext?: string; idempotencyProof?: string },
  maskedHint?: string | null,
  idempotencyKey?: string
) => ReturnType<InMemoryPlatformStore["rotateCredential"]>;

async function credentialFixture(store: InMemoryPlatformStore) {
  return store.createCredential({
    name: "Store rotation Credential",
    provider: "test-provider",
    kind: "api_key",
    location: "cloud",
    expiresAt: null
  }, { ciphertext: "v1.initial-ciphertext" });
}

describe("Credential rotation Store boundary", () => {
  it("replays the same key, revision, and secret without rotating twice", async () => {
    const store = new InMemoryPlatformStore();
    const credential = await credentialFixture(store);
    const rotate = store.rotateCredential.bind(store) as RotationMethod;
    const key = "credential-memory-rotation";
    const proof = `hmac-sha256:v1:${"7".repeat(64)}`;
    const input = { credentialId: credential.id, expectedSecretRevision: credential.secretRevision };

    const first = await rotate(
      input,
      { ciphertext: "v1.first-randomized-ciphertext", idempotencyProof: proof },
      "****safe",
      key
    );
    await expect(rotate(
      input,
      { ciphertext: "v1.second-randomized-ciphertext", idempotencyProof: proof },
      "****safe",
      key
    )).resolves.toEqual(first);

    expect((await store.getCredentials()).find((item) => item.id === credential.id)).toEqual(first);
    expect(await store.getCredentialSecret(credential.id)).toBe("v1.first-randomized-ciphertext");
  });

  it("rejects key reuse with a changed secret, revision, or masked hint", async () => {
    const store = new InMemoryPlatformStore();
    const credential = await credentialFixture(store);
    const rotate = store.rotateCredential.bind(store) as RotationMethod;
    const key = "credential-memory-rotation-conflict";
    const proof = `hmac-sha256:v1:${"8".repeat(64)}`;
    const input = { credentialId: credential.id, expectedSecretRevision: credential.secretRevision };

    await rotate(input, { ciphertext: "v1.persisted-ciphertext", idempotencyProof: proof }, "****safe", key);

    await expect(rotate(
      input,
      {
        ciphertext: "v1.changed-ciphertext",
        idempotencyProof: `hmac-sha256:v1:${"9".repeat(64)}`
      },
      "****safe",
      key
    )).rejects.toMatchObject({ apiCode: "IDEMPOTENCY_KEY_CONFLICT" });
    await expect(rotate(
      { ...input, expectedSecretRevision: input.expectedSecretRevision + 1 },
      { ciphertext: "v1.changed-revision-ciphertext", idempotencyProof: proof },
      "****safe",
      key
    )).rejects.toMatchObject({ apiCode: "IDEMPOTENCY_KEY_CONFLICT" });
    await expect(rotate(
      input,
      { ciphertext: "v1.changed-hint-ciphertext", idempotencyProof: proof },
      "****different",
      key
    )).rejects.toMatchObject({ apiCode: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("requires a valid proof whenever a caller key owns the rotation", async () => {
    const store = new InMemoryPlatformStore();
    const credential = await credentialFixture(store);
    const rotate = store.rotateCredential.bind(store) as RotationMethod;

    await expect(rotate(
      { credentialId: credential.id, expectedSecretRevision: credential.secretRevision },
      { ciphertext: "v1.no-proof-ciphertext" },
      "****safe",
      "credential-memory-proof-required"
    )).rejects.toMatchObject({ apiCode: "CREDENTIAL_ROTATION_IDEMPOTENCY_PROOF_REQUIRED" });

    expect((await store.getCredentials()).find((item) => item.id === credential.id)).toEqual(credential);
    expect(await store.getCredentialSecret(credential.id)).toBe("v1.initial-ciphertext");
  });
});
