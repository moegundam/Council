import { createGovernanceControlFromEnv, evaluateGovernanceGate } from "@council/runtime";

const control = await createGovernanceControlFromEnv(process.env);
if (control.initializationError) {
  throw new Error("Governance provider initialization did not pass the deployment smoke check.");
}

if (control.mode === "off") {
  if (control.provider.metadata.providerId !== "native") {
    throw new Error("Off-mode governance must use the native provider.");
  }
} else {
  if (control.provider.metadata.providerId !== "microsoft_acs") {
    throw new Error("Enabled governance must use the Microsoft ACS provider.");
  }
  const smokeRequest = (nativeAuthorized: boolean) => ({
    point: "pre_tool_call" as const,
    actionIdentity: `sha256:${nativeAuthorized ? "8".repeat(64) : "9".repeat(64)}`,
    snapshot: {
      tool_call: { name: "council_mcp_readonly", args: {} },
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
        tool_name: "deployment_smoke"
      }
    }
  });
  const approvedResult = await evaluateGovernanceGate(control, smokeRequest(true));
  if (!approvedResult || approvedResult.decision !== "allow" || approvedResult.effect !== "allow") {
    throw new Error("Governance provider did not allow the approved deployment smoke action.");
  }
  const deniedResult = await evaluateGovernanceGate(control, smokeRequest(false));
  const expectedDenyEffect = control.mode === "enforce" ? "block" : "allow";
  if (!deniedResult || deniedResult.decision !== "deny" || !deniedResult.wouldBlock
    || deniedResult.effect !== expectedDenyEffect) {
    throw new Error("Governance provider did not deny the unauthorized deployment smoke action.");
  }
}

process.stdout.write(`${JSON.stringify({
  mode: control.mode,
  providerId: control.provider.metadata.providerId,
  providerVersion: control.provider.metadata.providerVersion,
  policyDigest: control.provider.metadata.policyDigest,
  status: "ready"
})}\n`);
