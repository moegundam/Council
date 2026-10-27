import { describe, expect, it } from "vitest";
import { InMemoryPlatformStore } from "./memory-store.js";

const input = {
  name: "Retry-safe Task Adapter",
  location: "cloud" as const,
  baseUrl: "https://1.1.1.1"
};

describe("Task Adapter Connector creation store boundary", () => {
  it("replays one exact key-bound request and rejects a changed secret", async () => {
    const store = new InMemoryPlatformStore();
    const key = "task-adapter-memory-retry";
    const proof = `hmac-sha256:v1:${"c".repeat(64)}`;

    const first = await store.createTaskAdapterConnector(
      input,
      { ciphertext: "v1.first-randomized-ciphertext", idempotencyProof: proof },
      key
    );
    await expect(store.createTaskAdapterConnector(
      input,
      { ciphertext: "v1.second-randomized-ciphertext", idempotencyProof: proof },
      key
    )).resolves.toEqual(first);
    await expect(store.createTaskAdapterConnector(
      input,
      {
        ciphertext: "v1.changed-randomized-ciphertext",
        idempotencyProof: `hmac-sha256:v1:${"d".repeat(64)}`
      },
      key
    )).rejects.toMatchObject({ apiCode: "IDEMPOTENCY_KEY_CONFLICT" });

    expect((await store.getSnapshot()).taskAdapterConnectors).toEqual([first]);
    expect(await store.getConnectorSecret(first.id)).toBe("v1.first-randomized-ciphertext");
  });

  it("does not treat a plaintext bearerToken supplied across the Store boundary as persisted secret material", async () => {
    const store = new InMemoryPlatformStore();
    const connector = await store.createTaskAdapterConnector({
      ...input,
      name: "Unsafe plaintext Task Adapter",
      bearerToken: "must-not-be-treated-as-ciphertext"
    } as never);

    expect(connector.hasSecret).toBe(false);
    expect(await store.getConnectorSecret(connector.id)).toBeNull();
    expect(JSON.stringify(await store.getSnapshot())).not.toContain("must-not-be-treated-as-ciphertext");
  });
});
