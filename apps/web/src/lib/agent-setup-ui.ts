import { skillInstructionBudget } from "@council/domain/skill-context";
import type { AgentReadiness, AgentReadinessCheck, Skill } from "@council/contracts";

export type AgentSetupAction = "edit" | "manage_models" | "manage_credentials" | "manage_prompts" | "manage_skills" | "manage_mcp" | "test_connection";
export type AgentSetupRowId = "lifecycle" | "runtime" | "model" | "credential" | "prompt" | "skill" | "tool";

export interface AgentSetupRow {
  id: AgentSetupRowId;
  label: string;
  status: "ready" | "attention" | "blocked" | "unavailable";
  detail: string;
  action: AgentSetupAction;
}

const rowDefinitions: ReadonlyArray<{ id: AgentSetupRowId; label: string; action: AgentSetupAction }> = [
  { id: "lifecycle", label: "Lifecycle", action: "edit" },
  { id: "runtime", label: "Runtime", action: "edit" },
  { id: "model", label: "Model", action: "manage_models" },
  { id: "credential", label: "Credential", action: "manage_credentials" },
  { id: "prompt", label: "Prompt", action: "manage_prompts" },
  { id: "skill", label: "Skill", action: "manage_skills" },
  { id: "tool", label: "Tool", action: "manage_mcp" }
];

function setupStatus(status: AgentReadinessCheck["status"]): AgentSetupRow["status"] {
  return status === "passed" ? "ready" : status === "warning" ? "attention" : "blocked";
}

export function agentSetupRows(readiness: AgentReadiness | "loading" | null): AgentSetupRow[] {
  return rowDefinitions.map((definition) => {
    if (readiness === "loading") return { ...definition, status: "unavailable", detail: "正在載入 Readiness" };
    const check = readiness?.checks.find((candidate) => candidate.code === definition.id);
    if (!check) return { ...definition, status: "unavailable", detail: "Readiness 無法取得" };
    return {
      ...definition,
      status: setupStatus(check.status),
      detail: check.message,
      action: definition.id === "model" && check.status !== "blocked" ? "test_connection" : definition.action
    };
  });
}

export function selectedSkillInstructionBudget(
  skillIds: readonly string[],
  skills: readonly Pick<Skill, "id" | "instructions">[]
) {
  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
  return skillInstructionBudget(skillIds.flatMap((id) => {
    const skill = skillsById.get(id);
    return skill ? [skill] : [];
  }));
}

export function effectiveModelConnectionIdentity(input: {
  agentId: string;
  source: { kind: "published" | "draft" | "published_missing"; revision: number };
  connectorId: string | null;
  connectorRevision?: number | undefined;
  credentialRevision?: number | undefined;
  credentialState?: string | undefined;
}): string | null {
  return input.connectorId ? JSON.stringify([
    input.agentId, input.source.kind, input.source.revision, input.connectorId,
    input.connectorRevision ?? null, input.credentialRevision ?? null, input.credentialState ?? null
  ]) : null;
}
