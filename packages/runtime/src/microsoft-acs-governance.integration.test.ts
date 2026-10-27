import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateGovernanceGate } from "./governance.js";
import { createGovernanceControlFromEnv } from "./microsoft-acs-governance.js";

const manifestPath = fileURLToPath(new URL("../../../deploy/governance/acs-mcp-readonly.manifest.yaml", import.meta.url));
const policyPath = fileURLToPath(new URL("../../../deploy/governance/policy", import.meta.url));
const envExamplePath = fileURLToPath(new URL("../../../deploy/.env.example", import.meta.url));

function snapshot(nativeAuthorized: boolean) {
  return {
    tool_call: { name: "council_mcp_readonly", args: { query: "governance" } },
    council: {
      action_type: "mcp_tool_call",
      native_authorized: nativeAuthorized,
      access: "read_only",
      meeting_state: "active",
      role_tool_policy: "agent_read_only_grants",
      role_data_policy: "agent_declared_scope",
      connector_enabled: true,
      catalog_registered: true,
      agent_granted: true,
      tool_name: "search"
    }
  } as const;
}

describe("Microsoft ACS packaged policy integration", () => {
  it("loads the pinned native runtime and evaluates the shipped Rego policy", async () => {
    const shadow = await createGovernanceControlFromEnv({
      GOVERNANCE_PROVIDER: "microsoft_acs",
      GOVERNANCE_MODE: "shadow",
      GOVERNANCE_ACS_MANIFEST_PATH: manifestPath,
      GOVERNANCE_ACS_POLICY_ARTIFACT_PATHS: policyPath
    });
    const expectedDigest = (await readFile(envExamplePath, "utf8"))
      .match(/^GOVERNANCE_ACS_EXPECTED_POLICY_DIGEST=(sha256:[a-f0-9]{64})$/m)?.[1];
    expect(shadow.provider.metadata.policyDigest).toBe(expectedDigest);

    await expect(evaluateGovernanceGate(shadow, {
      point: "pre_tool_call",
      actionIdentity: "approved-action",
      snapshot: snapshot(true)
    })).resolves.toMatchObject({ decision: "allow", effect: "allow" });
    await expect(evaluateGovernanceGate(shadow, {
      point: "pre_tool_call",
      actionIdentity: "invalid-action",
      snapshot: snapshot(false)
    })).resolves.toMatchObject({ decision: "deny", effect: "allow", wouldBlock: true });

    const enforce = await createGovernanceControlFromEnv({
      GOVERNANCE_PROVIDER: "microsoft_acs",
      GOVERNANCE_MODE: "enforce",
      GOVERNANCE_ACS_MANIFEST_PATH: manifestPath,
      GOVERNANCE_ACS_POLICY_ARTIFACT_PATHS: policyPath,
      GOVERNANCE_ACS_EXPECTED_POLICY_DIGEST: shadow.provider.metadata.policyDigest
    });
    await expect(evaluateGovernanceGate(enforce, {
      point: "pre_tool_call",
      actionIdentity: "invalid-action",
      snapshot: snapshot(false)
    })).resolves.toMatchObject({ decision: "deny", effect: "block", wouldBlock: true });
    await expect(createGovernanceControlFromEnv({
      GOVERNANCE_PROVIDER: "microsoft_acs",
      GOVERNANCE_MODE: "enforce",
      GOVERNANCE_ACS_MANIFEST_PATH: manifestPath,
      GOVERNANCE_ACS_POLICY_ARTIFACT_PATHS: policyPath,
      GOVERNANCE_ACS_EXPECTED_POLICY_DIGEST: `sha256:${"0".repeat(64)}`
    })).rejects.toThrow(/digest/i);
  }, 20_000);
});
