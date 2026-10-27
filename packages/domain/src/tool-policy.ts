import { roleAllowsExternalTools, type RoleDataPolicy, type RoleToolPolicy } from "@council/contracts";

export type ToolEffect = "read" | "write";

export interface ToolGrant {
  connectorId: string;
  toolName: string;
  effect: ToolEffect;
}

export interface ToolAuthorization {
  allowed: boolean;
  reason?: string;
}

export function authorizeRoleMcpAccess(policy: {
  toolPolicy: RoleToolPolicy;
  dataPolicy: RoleDataPolicy;
}): ToolAuthorization {
  if (policy.toolPolicy !== "agent_read_only_grants") {
    return { allowed: false, reason: "Role policy does not allow external tools." };
  }
  if (!roleAllowsExternalTools(policy)) {
    return { allowed: false, reason: "Role data policy is limited to the Meeting." };
  }
  return { allowed: true };
}

export class ToolPolicy {
  private readonly grants: Map<string, ToolGrant>;

  constructor(grants: ToolGrant[]) {
    this.grants = new Map(grants.map((grant) => [`${grant.connectorId}:${grant.toolName}`, grant]));
  }

  authorize(connectorId: string, toolName: string): ToolAuthorization {
    const grant = this.grants.get(`${connectorId}:${toolName}`);
    if (!grant) return { allowed: false, reason: "Tool is not in the allowlist." };
    if (grant.effect !== "read") return { allowed: false, reason: "Phase 1 only permits read-only tools." };
    return { allowed: true };
  }
}
