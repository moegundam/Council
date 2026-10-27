import { describe, expect, it } from "vitest";
import { InMemoryPlatformStore } from "./memory-store.js";

class ModelCredentialEvidenceStore extends InMemoryPlatformStore {
  readonly audits: Array<{ event: string; entityType: string; entityId: string; detail: Record<string, unknown> }> = [];

  override async recordAudit(
    event: string,
    entityType: string,
    entityId: string,
    detail: Record<string, unknown> = {}
  ): Promise<void> {
    this.audits.push({ event, entityType, entityId, detail: structuredClone(detail) });
  }
}

const input = {
  name: "Retry-safe Model Store",
  location: "cloud" as const,
  baseUrl: "https://1.1.1.1/v1",
  model: "meeting-model"
};

describe("Model Connector creation store boundary", () => {
  it("replays one exact key-bound request and rejects changed secret or metadata", async () => {
    const store = new InMemoryPlatformStore();
    const key = "model-memory-retry";
    const proof = `hmac-sha256:v1:${"1".repeat(64)}`;
    const create = store.createModelConnector.bind(store) as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof store.createModelConnector>>>;

    const first = await create(
      input,
      { ciphertext: "v1.first-randomized-ciphertext", idempotencyProof: proof },
      key
    );
    await expect(create(
      input,
      { ciphertext: "v1.second-randomized-ciphertext", idempotencyProof: proof },
      key
    )).resolves.toEqual(first);
    await expect(create(
      input,
      {
        ciphertext: "v1.changed-randomized-ciphertext",
        idempotencyProof: `hmac-sha256:v1:${"2".repeat(64)}`
      },
      key
    )).rejects.toMatchObject({ apiCode: "IDEMPOTENCY_KEY_CONFLICT" });
    await expect(create(
      { ...input, model: "changed-model" },
      { ciphertext: "v1.third-randomized-ciphertext", idempotencyProof: proof },
      key
    )).rejects.toMatchObject({ apiCode: "IDEMPOTENCY_KEY_CONFLICT" });

    expect((await store.getSnapshot()).modelConnectors).toEqual([first]);
    expect(await store.getConnectorSecret(first.id)).toBe("v1.first-randomized-ciphertext");
  });

  it("rejects a plaintext apiKey supplied across the Store boundary", async () => {
    const store = new InMemoryPlatformStore();
    const plaintext = "must-not-be-treated-as-ciphertext";

    await expect(store.createModelConnector({
      ...input,
      name: "Unsafe plaintext Model",
      apiKey: plaintext
    } as never)).rejects.toThrow(/plaintext|api key/i);

    expect(JSON.stringify(await store.getSnapshot())).not.toContain(plaintext);
  });

  it("applies ordinary Credential-name uniqueness to generated Model Credentials", async () => {
    const store = new InMemoryPlatformStore();
    await store.createCredential({
      name: "  COLLISION MODEL CREDENTIAL  ",
      provider: "existing-provider",
      kind: "api_key",
      location: "cloud",
      expiresAt: null
    });

    await expect(store.createModelConnector({
      ...input,
      name: "Collision Model"
    }, { ciphertext: "encrypted-model-secret" })).rejects.toThrow(/Credential name already exists/i);

    expect((await store.getSnapshot()).modelConnectors).toEqual([]);
  });

  it("validates and audits a generated Credential as a first-class registry entry", async () => {
    const store = new ModelCredentialEvidenceStore();
    const connector = await store.createModelConnector(
      { ...input, name: "Audited Model" },
      { ciphertext: "encrypted-audited-model-secret" }
    );

    const credential = (await store.getSnapshot()).credentials?.find((item) => item.id === connector.credentialId);
    expect(credential).toMatchObject({
      name: "Audited Model Credential",
      provider: "Audited Model",
      kind: "api_key",
      hasSecret: true,
      secretRevision: 1
    });
    expect(store.audits.map((audit) => audit.event)).toEqual([
      "credential.created",
      "model_connector.created"
    ]);
    expect(JSON.stringify(store.audits)).not.toContain("encrypted-audited-model-secret");

    const before = structuredClone(await store.getSnapshot());
    await expect(store.createModelConnector(
      { ...input, name: "x".repeat(90) },
      { ciphertext: "encrypted-overlong-generated-name" }
    )).rejects.toThrow(/Generated Credential metadata is invalid/i);
    expect(await store.getSnapshot()).toEqual(before);
    expect(store.audits).toHaveLength(2);
  });
});
