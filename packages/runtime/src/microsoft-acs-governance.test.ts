import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createGovernanceControlFromEnv,
  MicrosoftAcsGovernanceProvider,
  policyArtifactDigest,
  policyArtifactDigestFromPaths
} from "./microsoft-acs-governance.js";

describe("Microsoft Agent Control Specification governance provider", () => {
  it("maps a provider-neutral request to ACS evaluate-only semantics", async () => {
    const evaluateInterventionPoint = vi.fn(async () => ({
      verdict: {
        decision: "deny",
        reason: "policy.read-only-only",
        evidence: {
          artefact: "sha256:evidence",
          verificationPointers: { audit: "https://audit.invalid", trace: "https://trace.invalid" }
        },
        result_labels: ["restricted"]
      },
      inputIdentity: "sha256:input",
      enforcedIdentity: "sha256:enforced"
    }));
    const provider = new MicrosoftAcsGovernanceProvider({ evaluateInterventionPoint }, {
      policyDigest: `sha256:${"a".repeat(64)}`
    });
    const snapshot = { tool_call: { name: "search", args: { query: "policy" } } };

    await expect(provider.evaluate({
      point: "pre_tool_call",
      actionIdentity: "action-1",
      snapshot
    })).resolves.toEqual({
      decision: "deny",
      reason: "policy.read-only-only",
      inputIdentity: "sha256:input",
      enforcedIdentity: "sha256:enforced",
      evidenceArtefact: "sha256:evidence",
      evidencePointerKeys: ["audit", "trace"],
      resultLabels: ["restricted"]
    });
    expect(evaluateInterventionPoint).toHaveBeenCalledWith("pre_tool_call", snapshot, "evaluate_only");
  });

  it("rejects malformed ACS verdicts instead of treating them as allow", async () => {
    const provider = new MicrosoftAcsGovernanceProvider({
      evaluateInterventionPoint: vi.fn(async () => ({ verdict: { decision: "unexpected" } }))
    }, { policyDigest: `sha256:${"b".repeat(64)}` });

    await expect(provider.evaluate({
      point: "pre_tool_call",
      actionIdentity: "action-1",
      snapshot: { tool_call: { name: "search", args: {} } }
    })).rejects.toThrow(/verdict/i);
  });

  it("defaults to the native off control and validates Microsoft ACS environment combinations", async () => {
    await expect(createGovernanceControlFromEnv({})).resolves.toMatchObject({
      mode: "off",
      provider: { metadata: { providerId: "native" } }
    });
    await expect(createGovernanceControlFromEnv({
      GOVERNANCE_PROVIDER: "microsoft_acs",
      GOVERNANCE_MODE: "enforce"
    })).rejects.toThrow(/manifest/i);
    const unavailableShadow = await createGovernanceControlFromEnv({
      GOVERNANCE_PROVIDER: "microsoft_acs",
      GOVERNANCE_MODE: "shadow"
    });
    expect(unavailableShadow).toMatchObject({
      mode: "shadow",
      provider: { metadata: { providerId: "microsoft_acs" } },
      initializationError: expect.any(Error)
    });
    await expect(unavailableShadow.provider.evaluate({
      point: "pre_tool_call",
      actionIdentity: "action-1",
      snapshot: { tool_call: { name: "search", args: {} } }
    })).rejects.toThrow(/unavailable/i);
    await expect(createGovernanceControlFromEnv({
      GOVERNANCE_PROVIDER: "unknown"
    })).rejects.toThrow(/GOVERNANCE_PROVIDER/i);
    await expect(createGovernanceControlFromEnv({
      GOVERNANCE_PROVIDER: "native",
      GOVERNANCE_TIMEOUT_MS: "6000"
    })).rejects.toThrow(/GOVERNANCE_TIMEOUT_MS/i);
  });

  it("hashes every ordered policy artifact and rejects duplicate inputs", async () => {
    const first = new TextEncoder().encode("manifest");
    const second = new TextEncoder().encode("policy");

    await expect(policyArtifactDigest([
      { identity: "manifest.yaml", content: first },
      { identity: "policy.rego", content: second }
    ])).resolves.toMatch(/^sha256:[a-f0-9]{64}$/);
    await expect(policyArtifactDigest([
      { identity: "same", content: first },
      { identity: "same", content: second }
    ])).rejects.toThrow(/duplicate/i);
  });

  it("hashes every regular file in a policy bundle and rejects nested symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "council-acs-policy-"));
    const policyRoot = join(root, "policy");
    await mkdir(policyRoot);
    await writeFile(join(policyRoot, "base.rego"), "package council.base\n");
    try {
      const first = await policyArtifactDigestFromPaths([policyRoot]);
      await writeFile(join(policyRoot, "additional.rego"), "package council.additional\n");
      const second = await policyArtifactDigestFromPaths([policyRoot]);
      expect(second).not.toBe(first);

      await symlink(join(policyRoot, "base.rego"), join(policyRoot, "linked.rego"));
      await expect(policyArtifactDigestFromPaths([policyRoot])).rejects.toThrow(/symbolic link/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
