import type {
  Agent,
  AgentReadiness,
  MeetingPreset,
  PublicPlatformSnapshot as PlatformSnapshot,
  PromptTemplate
} from "@council/contracts";

export type SettingsResourceId =
  | "roles"
  | "skills"
  | "prompts"
  | "models"
  | "credentials"
  | "mcp"
  | "task_adapters"
  | "harness";

export interface SettingsNavigationItem {
  id: SettingsResourceId;
  label: string;
  groupId: "governance" | "connections" | "operations";
  groupLabel: string;
}

const settingsNavigation: readonly SettingsNavigationItem[] = [
  { id: "roles", label: "角色", groupId: "governance", groupLabel: "治理資源" },
  { id: "skills", label: "Skills", groupId: "governance", groupLabel: "治理資源" },
  { id: "prompts", label: "Prompts", groupId: "governance", groupLabel: "治理資源" },
  { id: "models", label: "模型", groupId: "connections", groupLabel: "連線與工具" },
  { id: "credentials", label: "API 金鑰", groupId: "connections", groupLabel: "連線與工具" },
  { id: "mcp", label: "MCP 工具", groupId: "connections", groupLabel: "連線與工具" },
  { id: "task_adapters", label: "任務介接", groupId: "operations", groupLabel: "執行與整合" },
  { id: "harness", label: "Harness", groupId: "operations", groupLabel: "執行與整合" }
];

export function getSettingsNavigation(): SettingsNavigationItem[] {
  return settingsNavigation.map((item) => ({ ...item }));
}

export interface PromptLifecycleActions {
  canEdit: boolean;
  canPublish: boolean;
  canRollback: boolean;
  canArchive: boolean;
}

export function promptLifecycleActions(prompt: PromptTemplate): PromptLifecycleActions {
  const active = prompt.status !== "archived";
  return {
    canEdit: active,
    canPublish: active && prompt.publishedVersion !== prompt.currentVersion,
    canRollback: active,
    canArchive: active
  };
}

export type AgentRosterReadinessFilter = "all" | AgentReadiness["status"];

export interface AgentRosterItem {
  agent: Agent;
  readiness: AgentReadiness | null;
}

export interface ReadinessStatusUi {
  label: "Ready" | "Warning" | "Blocked";
  className: "approved" | "disabled" | "";
  runnable: boolean;
}

export function readinessStatusUi(status: AgentReadiness["status"]): ReadinessStatusUi {
  if (status === "ready") return { label: "Ready", className: "approved", runnable: true };
  if (status === "warning") return { label: "Warning", className: "", runnable: true };
  return { label: "Blocked", className: "disabled", runnable: false };
}

export function selectionAfterArchive(currentId: string | null, archivedId: string): string | null {
  return currentId === archivedId ? null : currentId;
}

export function firstUnavailableTeamMemberId(
  memberAgentIds: readonly string[],
  readinessByAgentId: Readonly<Record<string, AgentReadiness>>
): string | null {
  return memberAgentIds.find((agentId) => {
    const readiness = readinessByAgentId[agentId];
    return !readiness || !readinessStatusUi(readiness.status).runnable;
  }) ?? null;
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function rosterSearchText(agent: Agent): string {
  return [agent.name, agent.description, agent.goalSummary, agent.toolsSummary, agent.dataSummary]
    .filter(Boolean)
    .join(" ");
}

export function filterAgentRoster(
  snapshot: PlatformSnapshot,
  readinessByAgentId: Readonly<Record<string, AgentReadiness>>,
  query = "",
  readinessFilter: AgentRosterReadinessFilter = "all"
): AgentRosterItem[] {
  const search = normalized(query);
  return snapshot.agents
    .map((agent) => ({ agent, readiness: readinessByAgentId[agent.id] ?? null }))
    .filter(({ agent, readiness }) => {
      const matchesQuery = !search || normalized(rosterSearchText(agent)).includes(search);
      return matchesQuery && (readinessFilter === "all" || readiness?.status === readinessFilter);
    });
}

export interface AgentTeamApplication {
  participantIds: string[];
  roleIdByAgent: Record<string, string>;
  chairAgentId: string;
}

export function applyAgentTeam(source: PlatformSnapshot, teamId: string): AgentTeamApplication {
  const team = (source.agentTeams ?? []).find((candidate) => candidate.id === teamId);
  if (!team) throw new Error("找不到 Agent Team");
  if (team.status !== "active") throw new Error("Agent Team 已封存");
  if (team.members.length === 0) throw new Error("Agent Team 沒有成員");

  const agentIds = new Set(source.agents.map((agent) => agent.id));
  const roleIds = new Set(source.roles.map((role) => role.id));
  for (const member of team.members) {
    if (!agentIds.has(member.agentId)) throw new Error("Agent Team 包含不存在的 Agent");
    if (!roleIds.has(member.roleId)) throw new Error("Agent Team 包含不存在的角色");
  }
  const chairs = team.members.filter((member) => member.isChair);
  if (chairs.length !== 1) throw new Error("Agent Team 必須有一位主席");
  return {
    participantIds: team.members.map((member) => member.agentId),
    roleIdByAgent: Object.fromEntries(team.members.map((member) => [member.agentId, member.roleId])),
    chairAgentId: chairs[0]!.agentId
  };
}

export interface MeetingPresetApplication {
  teamId: string | null;
  mode: MeetingPreset["mode"];
  automation: MeetingPreset["automation"];
  durationMinutes: number;
  agendaItems: MeetingPreset["agendaItems"];
}

export function applyMeetingPreset(source: PlatformSnapshot, presetId: string): MeetingPresetApplication {
  const preset = (source.meetingPresets ?? []).find((candidate) => candidate.id === presetId);
  if (!preset) throw new Error("找不到會議範本");
  if (preset.status !== "active") throw new Error("會議範本已封存");
  if (preset.teamId !== null) {
    const team = (source.agentTeams ?? []).find((candidate) => candidate.id === preset.teamId);
    if (!team) throw new Error("會議範本指定的 Agent Team 不存在");
    if (team.status !== "active") throw new Error("會議範本指定的 Agent Team 已封存");
  }
  return {
    teamId: preset.teamId,
    mode: preset.mode,
    automation: preset.automation,
    durationMinutes: preset.durationMinutes,
    agendaItems: preset.agendaItems.map((item) => ({ ...item }))
  };
}
