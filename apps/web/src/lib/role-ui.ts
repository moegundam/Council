import {
  builtInRoleTemplates,
  roleAllowsExternalTools,
  type MeetingState,
  type ParticipantAssignment,
  type PublicPlatformSnapshot as PlatformSnapshot,
  type Role,
  type RoleTemplateKey,
  type RoleVersion
} from "@council/contracts";

interface MeetingRoleOption {
  id: string;
  templateKey: RoleTemplateKey | null;
}

export function participantRoleSelectionIsNoop(
  participant: Pick<ParticipantAssignment, "roleId" | "roleSnapshot">,
  selectedRole: Pick<Role, "id" | "version"> | undefined
): boolean {
  return Boolean(selectedRole
    && selectedRole.id === participant.roleId
    && selectedRole.version === participant.roleSnapshot.version);
}

export function initialMeetingRoleSelection(
  agentIds: string[],
  roles: readonly MeetingRoleOption[],
  chairAgentId: string | null | undefined
): Record<string, string> {
  const fallbackRole = roles.find((role) => role.templateKey === "platform_architect") ?? roles[0];
  const chairRole = roles.find((role) => role.templateKey === "meeting_chair") ?? fallbackRole;
  if (!fallbackRole) return {};
  return Object.fromEntries(agentIds.map((agentId) => [
    agentId,
    agentId === chairAgentId ? chairRole?.id ?? fallbackRole.id : fallbackRole.id
  ]));
}

export function meetingRoleSelectionIsValid(
  selectedAgentIds: string[],
  chairAgentId: string | null,
  roleIdByAgent: Record<string, string>
): boolean {
  return selectedAgentIds.length > 0
    && chairAgentId !== null
    && selectedAgentIds.includes(chairAgentId)
    && selectedAgentIds.every((agentId) => Boolean(roleIdByAgent[agentId]));
}

export interface MeetingAgentPrefill {
  participantIds: string[];
  chairAgentId: string;
  roleIdByAgent: Record<string, string>;
}

export function meetingPrefillForAgent(
  availableAgentIds: string[],
  defaultChairId: string | null | undefined,
  requestedAgentId: string,
  roles: readonly MeetingRoleOption[]
): MeetingAgentPrefill | null {
  if (!availableAgentIds.includes(requestedAgentId) || roles.length === 0) return null;
  const chairAgentId = defaultChairId && availableAgentIds.includes(defaultChairId) ? defaultChairId : requestedAgentId;
  const participantIds = requestedAgentId === chairAgentId ? [requestedAgentId] : [requestedAgentId, chairAgentId];
  return {
    participantIds,
    chairAgentId,
    roleIdByAgent: initialMeetingRoleSelection(participantIds, roles, chairAgentId)
  };
}

export function preferredMeetingChairAgentId(
  snapshot: PlatformSnapshot,
  availableAgentIds: readonly string[]
): string | null {
  const available = new Set(availableAgentIds);
  return snapshot.participants.flatMap((participant) => {
    if (!participant.isChair || !available.has(participant.agentId)) return [];
    const meeting = snapshot.meetings.find((candidate) => candidate.id === participant.meetingId);
    return meeting ? [{ agentId: participant.agentId, meetingCreatedAt: meeting.createdAt, meetingId: meeting.id }] : [];
  }).sort((left, right) => right.meetingCreatedAt.localeCompare(left.meetingCreatedAt)
    || right.meetingId.localeCompare(left.meetingId)
    || left.agentId.localeCompare(right.agentId))[0]?.agentId ?? null;
}

export function reconcileMeetingRoleSelection(
  selectedAgentIds: readonly string[],
  chairAgentId: string | null,
  currentRoleIdByAgent: Readonly<Record<string, string>>,
  roles: readonly MeetingRoleOption[]
): Record<string, string> {
  const agentIds = [...new Set(selectedAgentIds)];
  const validRoleIds = new Set(roles.map((role) => role.id));
  const defaults = initialMeetingRoleSelection(agentIds, roles, chairAgentId);
  return Object.fromEntries(agentIds.flatMap((agentId) => {
    const currentRoleId = currentRoleIdByAgent[agentId];
    const roleId = currentRoleId && validRoleIds.has(currentRoleId) ? currentRoleId : defaults[agentId];
    return roleId ? [[agentId, roleId]] : [];
  }));
}

export interface AgentRoleUsageEntry {
  meetingId: string;
  meetingTitle: string;
  meetingState: MeetingState;
  meetingCreatedAt: string;
  roleId: string;
  roleName: string;
  roleVersion: number;
  usageContext: string;
  isChair: boolean;
}

export function agentRoleUsage(snapshot: PlatformSnapshot, agentId: string): AgentRoleUsageEntry[] {
  return snapshot.participants.flatMap((participant) => {
    if (participant.agentId !== agentId) return [];
    const meeting = snapshot.meetings.find((candidate) => candidate.id === participant.meetingId);
    if (!meeting) return [];
    return [{
      meetingId: meeting.id,
      meetingTitle: meeting.title,
      meetingState: meeting.state,
      meetingCreatedAt: meeting.createdAt,
      roleId: participant.roleSnapshot.roleId,
      roleName: participant.roleSnapshot.name,
      roleVersion: participant.roleSnapshot.version,
      usageContext: participant.roleSnapshot.usageContext,
      isChair: participant.isChair
    }];
  }).sort((left, right) => right.meetingCreatedAt.localeCompare(left.meetingCreatedAt) || left.meetingId.localeCompare(right.meetingId));
}

export interface RoleMeetingUsageEntry {
  id: string;
  title: string;
  state: MeetingState;
  createdAt: string;
  agentNames: string[];
}

export interface RoleUsageSummary {
  agentNames: string[];
  meetings: RoleMeetingUsageEntry[];
  meetingCount: number;
  unfinishedMeetingCount: number;
  runnableAgentCount: number;
  skillCount: number;
  toolCount: number;
}

function skillIsCurrentlyApproved(snapshot: PlatformSnapshot, skillId: string): boolean {
  const skill = snapshot.skills.find((candidate) => candidate.id === skillId);
  return Boolean(skill
    && skill.status === "approved"
    && skill.validation.result === "passed"
    && skill.validation.contentDigest === skill.contentDigest);
}

export function effectiveAgentTools(snapshot: PlatformSnapshot, agentId: string) {
  const agent = snapshot.agents.find((candidate) => candidate.id === agentId);
  return agent?.toolGrants.flatMap((grant) => {
    const connector = snapshot.mcpConnectors.find((candidate) => candidate.id === grant.connectorId
      && candidate.enabled
      && candidate.approvedTools.includes(grant.toolName));
    const registration = connector?.toolRegistrations.find((candidate) => candidate.toolName === grant.toolName);
    return connector && registration ? [{ connector, registration }] : [];
  }) ?? [];
}

export function roleUsageSummary(snapshot: PlatformSnapshot, roleId: string): RoleUsageSummary {
  const assignments = snapshot.participants.filter((participant) => participant.roleId === roleId);
  const agents = snapshot.agents.filter((agent) => assignments.some((assignment) => assignment.agentId === agent.id));
  const meetings = snapshot.meetings.flatMap((meeting) => {
    const meetingAssignments = assignments.filter((assignment) => assignment.meetingId === meeting.id);
    if (meetingAssignments.length === 0) return [];
    return [{
      id: meeting.id,
      title: meeting.title,
      state: meeting.state,
      createdAt: meeting.createdAt,
      agentNames: meetingAssignments.flatMap((assignment) => {
        const agent = snapshot.agents.find((candidate) => candidate.id === assignment.agentId);
        return agent ? [agent.name] : [];
      }).sort((left, right) => left.localeCompare(right, "zh-TW"))
    }];
  }).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  const runnableAgentCount = agents.filter((agent) => agent.modelConnectorId
    && snapshot.modelConnectors.some((connector) => connector.id === agent.modelConnectorId && connector.enabled)).length;
  const skillIds = new Set(agents.flatMap((agent) => agent.skillIds).filter((skillId) => skillIsCurrentlyApproved(snapshot, skillId)));
  const role = snapshot.roles.find((candidate) => candidate.id === roleId);
  const toolKeys = new Set(role && roleAllowsExternalTools(role) ? agents.flatMap((agent) => effectiveAgentTools(snapshot, agent.id)
    .map(({ connector, registration }) => `${connector.id}:${registration.toolName}`)) : []);
  return {
    agentNames: agents.map((agent) => agent.name).sort((left, right) => left.localeCompare(right, "zh-TW")),
    meetings,
    meetingCount: meetings.length,
    unfinishedMeetingCount: meetings.filter((meeting) => meeting.state !== "closed").length,
    runnableAgentCount,
    skillCount: skillIds.size,
    toolCount: toolKeys.size
  };
}

export interface RoleVersionDifference {
  field: "name" | "usageContext" | "responsibility" | "speakingGuidance" | "decisionScope" | "constraints" | "templateKey" | "toolPolicy" | "dataPolicy";
  label: string;
  selected: string;
  current: string;
}

const toolPolicyLabels = {
  none: "不使用外部工具",
  agent_read_only_grants: "Agent 已授權唯讀工具"
} as const;

const dataPolicyLabels = {
  meeting_only: "只限本場會議",
  agent_declared_scope: "Agent 宣告資料範圍"
} as const;

function templateLabel(key: RoleTemplateKey | null): string {
  return builtInRoleTemplates.find((template) => template.key === key)?.name ?? "自訂";
}

export function roleVersionDifferences(selected: RoleVersion, current: RoleVersion): RoleVersionDifference[] {
  const fields: Array<{
    field: RoleVersionDifference["field"];
    label: string;
    format(value: RoleVersion): string;
  }> = [
    { field: "name", label: "名稱", format: (value) => value.name },
    { field: "usageContext", label: "適用情境", format: (value) => value.usageContext },
    { field: "responsibility", label: "職責", format: (value) => value.responsibility },
    { field: "speakingGuidance", label: "發言準則", format: (value) => value.speakingGuidance },
    { field: "decisionScope", label: "決策範圍", format: (value) => value.decisionScope },
    { field: "constraints", label: "限制", format: (value) => value.constraints },
    { field: "templateKey", label: "模板", format: (value) => templateLabel(value.templateKey) },
    { field: "toolPolicy", label: "工具政策", format: (value) => toolPolicyLabels[value.toolPolicy] },
    { field: "dataPolicy", label: "資料政策", format: (value) => dataPolicyLabels[value.dataPolicy] }
  ];
  return fields.flatMap(({ field, label, format }) => {
    const selectedValue = format(selected);
    const currentValue = format(current);
    return selectedValue === currentValue ? [] : [{ field, label, selected: selectedValue, current: currentValue }];
  });
}

export function roleVersionSourceLabel(source: RoleVersion["source"]): string {
  if (source === "created") return "建立";
  if (source === "updated") return "更新";
  if (source === "rollback") return "回復";
  return "舊資料回填";
}
