import { describe, expect, it, vi } from "vitest";
import {
  evaluateGovernanceGate,
  governanceAuditDetail,
  NativeGovernanceProvider,
  type GovernanceProvider
} from "./governance.js";

const request = {
  point: "pre_tool_call" as const,
  actionIdentity: "request-fingerprint-1",
  snapshot: {
    tool_call: {
      name: "search",
      args: { query: "must-not-enter-audit" }
    }
  }
};

function provider(decision: "allow" | "deny" | "warn" | "escalate" | "transform"): GovernanceProvider {
  return {
    metadata: {
      providerId: "test-policy",
      providerVersion: "1.2.3",
      policyDigest: `sha256:${"1".repeat(64)}`
    },
    evaluate: vi.fn(async () => ({
      decision,
      reason: decision === "allow" || decision === "warn"
        ? "council.native-read-only-authorization-confirmed"
        : "council.native-authorization-invariant-failed",
      inputIdentity: `sha256:${"2".repeat(64)}`,
      enforcedIdentity: `sha256:${"3".repeat(64)}`,
      evidenceArtefact: `sha256:${"4".repeat(64)}`,
      evidencePointerKeys: ["audit", "audit", "trace"],
      resultLabels: ["internal", "internal", "reviewed"]
    }))
  };
}

describe("governance gate", () => {
  it("keeps the native provider inert while governance is off", async () => {
    const native = new NativeGovernanceProvider();
    const evaluate = vi.spyOn(native, "evaluate");

    await expect(evaluateGovernanceGate({ mode: "off", provider: native }, request)).resolves.toBeNull();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("observes deny decisions without changing the action in shadow mode", async () => {
    const result = await evaluateGovernanceGate({ mode: "shadow", provider: provider("deny") }, request);

    expect(result).toMatchObject({
      mode: "shadow",
      decision: "deny",
      effect: "allow",
      wouldBlock: true,
      reason: "council.native-authorization-invariant-failed"
    });
  });

  it.each(["deny", "escalate", "transform"] as const)(
    "blocks %s until an action-bound approval or transform contract exists",
    async (decision) => {
      await expect(evaluateGovernanceGate({ mode: "enforce", provider: provider(decision) }, request))
        .resolves.toMatchObject({ decision, effect: "block", wouldBlock: true });
    }
  );

  it.each(["allow", "warn"] as const)("permits %s in enforce mode", async (decision) => {
    await expect(evaluateGovernanceGate({ mode: "enforce", provider: provider(decision) }, request))
      .resolves.toMatchObject({ decision, effect: "allow", wouldBlock: false });
  });

  it("fails closed on provider errors only in enforce mode", async () => {
    const failingProvider: GovernanceProvider = {
      metadata: {
        providerId: "unavailable-policy",
        providerVersion: "1.0.0",
        policyDigest: `sha256:${"5".repeat(64)}`
      },
      evaluate: vi.fn(async () => { throw new Error("secret provider detail"); })
    };

    const shadow = await evaluateGovernanceGate({ mode: "shadow", provider: failingProvider }, request);
    const enforce = await evaluateGovernanceGate({ mode: "enforce", provider: failingProvider }, request);

    expect(shadow).toMatchObject({ decision: "provider_error", effect: "allow", wouldBlock: true });
    expect(enforce).toMatchObject({ decision: "provider_error", effect: "block", wouldBlock: true });
    expect(JSON.stringify(shadow)).not.toContain("secret provider detail");
  });

  it("bounds provider evaluation time and maps a timeout through the same fail-closed rule", async () => {
    const stalledProvider: GovernanceProvider = {
      metadata: {
        providerId: "stalled-policy",
        providerVersion: "1.0.0",
        policyDigest: `sha256:${"6".repeat(64)}`
      },
      evaluate: vi.fn(() => new Promise<never>(() => undefined))
    };

    vi.useFakeTimers();
    try {
      const evaluation = evaluateGovernanceGate({
        mode: "enforce",
        provider: stalledProvider,
        timeoutMs: 50
      }, request);
      await vi.advanceTimersByTimeAsync(50);
      await expect(evaluation).resolves.toMatchObject({
        decision: "provider_error",
        effect: "block",
        reason: "governance.provider-error"
      });
      expect(stalledProvider.evaluate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("builds bounded audit metadata without copying the governed snapshot", async () => {
    const result = await evaluateGovernanceGate({ mode: "shadow", provider: provider("deny") }, request);
    const detail = governanceAuditDetail(result!);

    expect(detail).toEqual(expect.objectContaining({
      actionIdentity: "request-fingerprint-1",
      decision: "deny",
      reasonCode: "council.native-authorization-invariant-failed",
      evidencePointerCount: 2,
      resultLabelCount: 2
    }));
    expect(JSON.stringify(detail)).not.toContain("must-not-enter-audit");
  });

  it("never persists arbitrary provider-controlled text in audit metadata", async () => {
    const secret = "council.sk-review-secret-12345678";
    const maliciousProvider: GovernanceProvider = {
      metadata: {
        providerId: "test-policy",
        providerVersion: "1.2.3",
        policyDigest: `sha256:${"7".repeat(64)}`
      },
      evaluate: vi.fn(async () => ({
        decision: "deny" as const,
        reason: secret,
        inputIdentity: secret,
        enforcedIdentity: secret,
        evidenceArtefact: secret,
        evidencePointerKeys: [secret],
        resultLabels: [secret]
      }))
    };

    const result = await evaluateGovernanceGate({ mode: "shadow", provider: maliciousProvider }, request);
    const detail = governanceAuditDetail(result!);

    expect(detail).toEqual(expect.objectContaining({
      decision: "deny",
      evidencePointerCount: 1,
      resultLabelCount: 1
    }));
    expect(JSON.stringify(detail)).not.toContain(secret);
  });
});
