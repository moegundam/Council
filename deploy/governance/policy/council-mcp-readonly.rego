package council.agent_governance

import rego.v1

default pre_tool_call_verdict := {
  "decision": "deny",
  "reason": "council.native-authorization-invariant-failed",
  "message": "The host authorization snapshot is incomplete or no longer read-only."
}

pre_tool_call_verdict := {
  "decision": "allow",
  "reason": "council.native-read-only-authorization-confirmed",
  "result_labels": ["council-native-authorized", "read-only"]
} if {
  input.intervention_point == "pre_tool_call"
  input.snapshot.council.action_type == "mcp_tool_call"
  input.snapshot.council.native_authorized == true
  input.snapshot.council.access == "read_only"
  input.snapshot.council.meeting_state == "active"
  input.snapshot.council.role_tool_policy == "agent_read_only_grants"
  input.snapshot.council.role_data_policy == "agent_declared_scope"
  input.snapshot.council.connector_enabled == true
  input.snapshot.council.catalog_registered == true
  input.snapshot.council.agent_granted == true
  input.tool.name == "council_mcp_readonly"
  input.snapshot.council.tool_name != ""
}
