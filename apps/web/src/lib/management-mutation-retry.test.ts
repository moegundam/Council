import { describe, expect, it, vi } from "vitest";
import { ManagementMutationRetryOwnership, ManagementMutationRetrySignature } from "./management-mutation-retry";
import { IdempotencyRetryRegistry } from "./view-model";

describe("ManagementMutationRetryOwnership", () => {
  it("retains one caller key per exact lifecycle intent, including A to B to A", () => {
    const ownership = new ManagementMutationRetryOwnership();
    const createKey = vi.fn()
      .mockReturnValueOnce("key-a")
      .mockReturnValueOnce("key-b");

    const firstA = ownership.acquire("credential.status", "credential-1", "active->disabled", createKey);
    const b = ownership.acquire("credential.status", "credential-1", "disabled->active", createKey);
    const secondA = ownership.acquire("credential.status", "credential-1", "active->disabled", createKey);

    expect(firstA.idempotencyKey).toBe("key-a");
    expect(b.idempotencyKey).toBe("key-b");
    expect(secondA).toEqual(firstA);
    expect(createKey).toHaveBeenCalledTimes(2);
  });

  it("clears only the exact deterministically settled intent", () => {
    const ownership = new ManagementMutationRetryOwnership();
    const first = ownership.acquire("skill.revoke", "skill-1", "reason-a", () => "key-a");
    const second = ownership.acquire("skill.revoke", "skill-1", "reason-b", () => "key-b");

    ownership.clear(first);

    expect(ownership.acquire("skill.revoke", "skill-1", "reason-a", () => "key-a2").idempotencyKey)
      .toBe("key-a2");
    expect(ownership.acquire("skill.revoke", "skill-1", "reason-b", () => "key-b2"))
      .toEqual(second);
  });
});

describe("ManagementMutationRetrySignature", () => {
  it("creates stable, secret-free, operation-scoped payload signatures", async () => {
    const signatures = new ManagementMutationRetrySignature();
    const payload = { name: "Primary", secret: "low-entropy-secret" };

    const first = await signatures.forPayload("credential.create", payload);
    const same = await signatures.forPayload("credential.create", { ...payload });
    const changed = await signatures.forPayload("credential.create", { ...payload, name: "Backup" });
    const otherOperation = await signatures.forPayload("mcp-connector.create", payload);

    expect(same).toBe(first);
    expect(changed).not.toBe(first);
    expect(otherOperation).not.toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain(payload.secret);
  });

  it("retains independent secret-bearing A, B, A retry ownership", async () => {
    const signatures = new ManagementMutationRetrySignature();
    const registry = new IdempotencyRetryRegistry();
    const createKey = vi.fn()
      .mockReturnValueOnce("rotation-key-a")
      .mockReturnValueOnce("rotation-key-b");
    const intentA = { credentialId: "credential-a", expectedSecretRevision: 1, secret: "secret-a" };
    const intentB = { credentialId: "credential-b", expectedSecretRevision: 3, secret: "secret-b" };

    const signatureA = await signatures.forPayload("credential.rotate", intentA);
    const signatureB = await signatures.forPayload("credential.rotate", intentB);
    const firstA = registry.acquire(signatureA, createKey);
    const firstB = registry.acquire(signatureB, createKey);

    expect(registry.acquire(await signatures.forPayload("credential.rotate", { ...intentA }), createKey)).toBe(firstA);
    expect(firstA.idempotencyKey).toBe("rotation-key-a");
    expect(firstB.idempotencyKey).toBe("rotation-key-b");
    expect(createKey).toHaveBeenCalledTimes(2);
    expect(signatureA).not.toContain(intentA.secret);
    expect(signatureB).not.toContain(intentB.secret);
  });
});
