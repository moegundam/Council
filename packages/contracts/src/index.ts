import { z } from "zod";
import {
  runtimeProfileBindingSchema,
  type RuntimeProfile,
  type RuntimeProfileBinding,
  type RuntimeProfileRevision,
  type RuntimeProfileSnapshot,
  type RuntimeRun,
  type RuntimeControlJobData,
  type RuntimeReconcileJobData
} from "@council/contracts/runtime-contracts";
import {
  toolPackGrantSchema,
  type ToolPack,
  type ToolPackGrant,
  type ToolPackRevision
} from "@council/contracts/tool-pack-contracts";
import { mcpToolArgumentsSchema } from "#mcp-arguments";
import { externalExecutionInputsSchema } from "#external-execution-inputs";
import type { ExecutionRuntimeBinding } from "#goal-run-contracts";

export * from "@council/contracts/runtime-contracts";
export * from "@council/contracts/tool-pack-contracts";
export * from "#mcp-arguments";
export * from "#external-execution-inputs";
export * from "#job-contracts";
export * from "#api-contracts";
export * from "#goal-run-contracts";
export * from "#omp-broker-contracts";

export const meetingStates = ["draft", "active", "paused", "closed"] as const;
export const meetingModes = ["chaired", "open", "fixed"] as const;
export const chairAutomationLevels = ["manual", "suggest", "auto"] as const;
export const meetingSummaryStates = ["not_requested", "pending", "queued", "completed", "failed"] as const;
export const taskStatuses = ["todo", "in_progress", "review", "done"] as const;
export const threadStatuses = ["open", "resolved", "archived"] as const;
export const decisionStatuses = ["proposed", "approved", "rejected"] as const;
export const taskExecutionProfiles = ["manual", "advisor", "worker"] as const;
export const taskApprovalStates = ["not_required", "pending", "approved", "rejected"] as const;
export const taskExecutionStatuses = ["idle", "queued", "running", "completed", "failed"] as const;
export const taskSyncStatuses = ["not_synced", "queued", "synced", "failed"] as const;
export const toolRegistrationKinds = ["mcp_tool", "function_wrapper", "library_wrapper", "program_adapter", "api_wrapper"] as const;
export const mcpToolRunStatuses = ["succeeded", "failed"] as const;
export const agendaItemStatuses = ["pending", "current", "completed", "skipped"] as const;
export const speakerQueueStatuses = ["queued", "running"] as const;
export const speakerQueueKinds = ["agent_turn", "mcp_tool_call"] as const;
export const credentialKinds = ["api_key", "bearer_token"] as const;
export const credentialStatuses = ["active", "disabled", "revoked"] as const;
export const promptKinds = ["agent", "role", "meeting", "task", "output"] as const;
export const promptStatuses = ["draft", "published", "archived"] as const;
export const promptVersionSources = ["created", "updated", "published", "rollback"] as const;
export const agentLifecycleStatuses = ["draft", "published", "disabled"] as const;
export const agentRevisionSources = ["created", "updated", "published", "rollback", "legacy_backfilled"] as const;
export const agentReadinessStatuses = ["ready", "warning", "blocked"] as const;
export const agentReadinessCheckCodes = ["model", "credential", "prompt", "skill", "tool", "runtime", "lifecycle"] as const;
export const agentReadinessCheckStatuses = ["passed", "warning", "blocked"] as const;
export const agentTeamStatuses = ["active", "archived"] as const;
export const meetingPresetStatuses = ["active", "archived"] as const;

export type MeetingState = (typeof meetingStates)[number];
export type MeetingMode = (typeof meetingModes)[number];
export type ChairAutomationLevel = (typeof chairAutomationLevels)[number];
export type MeetingSummaryState = (typeof meetingSummaryStates)[number];
export type ThreadStatus = (typeof threadStatuses)[number];
export type TaskStatus = (typeof taskStatuses)[number];
export type DecisionStatus = (typeof decisionStatuses)[number];
export type TaskExecutionProfile = (typeof taskExecutionProfiles)[number];
export type TaskApprovalState = (typeof taskApprovalStates)[number];
export type TaskExecutionStatus = (typeof taskExecutionStatuses)[number];
export type TaskSyncStatus = (typeof taskSyncStatuses)[number];
export type ToolRegistrationKind = (typeof toolRegistrationKinds)[number];
export type McpToolRunStatus = (typeof mcpToolRunStatuses)[number];
export type AgendaItemStatus = (typeof agendaItemStatuses)[number];
export type SpeakerQueueStatus = (typeof speakerQueueStatuses)[number];
export type SpeakerQueueKind = (typeof speakerQueueKinds)[number];
export type CredentialKind = (typeof credentialKinds)[number];
export type CredentialStatus = (typeof credentialStatuses)[number];
export type PromptKind = (typeof promptKinds)[number];
export type PromptStatus = (typeof promptStatuses)[number];
export type PromptVersionSource = (typeof promptVersionSources)[number];
export type AgentLifecycleStatus = (typeof agentLifecycleStatuses)[number];
export type AgentRevisionSource = (typeof agentRevisionSources)[number];
export type AgentReadinessStatus = (typeof agentReadinessStatuses)[number];
export type AgentReadinessCheckCode = (typeof agentReadinessCheckCodes)[number];
export type AgentReadinessCheckStatus = (typeof agentReadinessCheckStatuses)[number];
export type AgentTeamStatus = (typeof agentTeamStatuses)[number];
export type MeetingPresetStatus = (typeof meetingPresetStatuses)[number];

export interface PromptBinding {
  promptId: string;
  version: number;
}

export interface Credential {
  id: string;
  name: string;
  provider: string;
  kind: CredentialKind;
  location: "cloud" | "local";
  status: CredentialStatus;
  hasSecret: boolean;
  secretRevision: number;
  maskedHint: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  rotatedAt: string | null;
}

export interface PromptTemplate {
  id: string;
  name: string;
  kind: PromptKind;
  description: string;
  owner: string;
  status: PromptStatus;
  currentVersion: number;
  publishedVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface PromptVersion {
  promptId: string;
  version: number;
  content: string;
  variables: string[];
  contentDigest: string;
  source: PromptVersionSource;
  restoredFromVersion: number | null;
  createdAt: string;
  publishedAt: string | null;
}
export type ChairSuggestionStatus = "open" | "pending" | "resolved";
export type ChairSuggestionResolution = "completed" | "dismissed" | "superseded" | "manual_override" | "meeting_closed";
export type ChairAutomationJobAdmissionStatus = "reserved" | "admitted" | "reconciliation_required";
export type ChairAutomationJobReconciliationReason =
  | "queue_state_missing"
  | "queue_state_terminal"
  | "queue_ownership_unknown";

export interface ChairAutomationJobAdmission {
  chairSuggestionId: string;
  meetingId: string;
  jobId: string;
  automationRevision: number;
  status: ChairAutomationJobAdmissionStatus;
  reservedAt: string;
  admittedAt: string | null;
  reconciliationRequiredAt: string | null;
  reconciliationReason: ChairAutomationJobReconciliationReason | null;
  updatedAt: string;
}

export type ChairSuggestionTransitionType =
  | "created"
  | "mode_accepted"
  | "role_accepted"
  | "agent_requested"
  | "request_released"
  | "completed"
  | "dismissed"
  | "superseded"
  | "manual_override"
  | "meeting_closed"
  | "close_reverted";

export interface ChairSuggestion {
  reason: "repetition" | "off_topic" | "time_remaining";
  suggestedMode: MeetingMode;
  explanation: string;
  score: number;
  suggestedAgentId?: string;
  suggestedAgentName?: string;
  suggestedParticipantId?: string;
  suggestedParticipantAgentId?: string;
  suggestedParticipantAgentName?: string;
  suggestedParticipantRoleRevision?: number;
  suggestedRoleId?: string;
  suggestedRoleName?: string;
  suggestedRoleVersion?: number;
}

export interface ChairSuggestionRecord extends ChairSuggestion {
  id: string;
  meetingId: string;
  sourceUtteranceId: string;
  status: ChairSuggestionStatus;
  modeAcceptedAt: string | null;
  requestedAgentId: string | null;
  requestedAgentJobId: string | null;
  resolution: ChairSuggestionResolution | null;
  resolutionNote: string | null;
  resolvedBy: "owner" | "system" | null;
  transitions: ChairSuggestionTransition[];
  createdAt: string;
  resolvedAt: string | null;
}

export interface ChairSuggestionTransition {
  id: string;
  type: ChairSuggestionTransitionType;
  actor: "owner" | "system";
  at: string;
  agentId?: string;
  jobId?: string;
  note?: string;
}

export interface DiscussionGroup {
  id: string;
  revision: number;
  name: string;
}

export interface Category {
  id: string;
  revision: number;
  groupId: string;
  name: string;
}

export interface Tag {
  id: string;
  revision: number;
  name: string;
  color: "green" | "blue" | "amber" | "red" | "gray";
}

export interface DiscussionThread {
  id: string;
  revision: number;
  categoryId: string;
  title: string;
  summary: string;
  status: ThreadStatus;
  tagIds: string[];
  createdAt: string;
}

export interface Agent {
  id: string;
  revision?: number;
  name: string;
  description: string;
  modelConnectorId: string | null;
  goalSummary: string;
  toolsSummary: string;
  dataSummary: string;
  skillIds: string[];
  toolGrants: Array<{ connectorId: string; toolName: string }>;
  toolPackGrants: ToolPackGrant[];
  runtimeProfileBinding: RuntimeProfileBinding | null;
  status: "online" | "offline" | "attention";
  lifecycleStatus?: AgentLifecycleStatus;
  promptBinding?: PromptBinding | null;
  draftRevision?: number;
  publishedRevision?: number | null;
}

export interface AgentRevision {
  agentId: string;
  revision: number;
  name: string;
  description: string;
  modelConnectorId: string | null;
  goalSummary: string;
  toolsSummary: string;
  dataSummary: string;
  skillIds: string[];
  toolGrants: Array<{ connectorId: string; toolName: string }>;
  toolPackGrants: ToolPackGrant[];
  runtimeProfileBinding: RuntimeProfileBinding | null;
  promptBinding: PromptBinding | null;
  contentDigest: string;
  contentDigestVersion: 1 | 2 | 3;
  source: AgentRevisionSource;
  restoredFromRevision: number | null;
  createdAt: string;
  publishedAt: string | null;
}

export interface AgentReadinessCheck {
  code: AgentReadinessCheckCode;
  status: AgentReadinessCheckStatus;
  message: string;
}

export interface AgentReadiness {
  status: AgentReadinessStatus;
  checks: AgentReadinessCheck[];
}

export interface AgentTeamMember {
  agentId: string;
  roleId: string;
  isChair: boolean;
}

export interface AgentTeam {
  id: string;
  revision: number;
  name: string;
  description: string;
  status: AgentTeamStatus;
  members: AgentTeamMember[];
  createdAt: string;
  updatedAt: string;
}

export interface MeetingPresetAgendaItem {
  title: string;
  description: string;
}

export interface MeetingPreset {
  id: string;
  revision: number;
  name: string;
  description: string;
  status: MeetingPresetStatus;
  teamId: string | null;
  mode: MeetingMode;
  automation: ChairAutomationLevel;
  durationMinutes: number;
  agendaItems: MeetingPresetAgendaItem[];
  createdAt: string;
  updatedAt: string;
}

export const roleToolPolicies = ["none", "agent_read_only_grants"] as const;
export type RoleToolPolicy = typeof roleToolPolicies[number];

export const roleDataPolicies = ["meeting_only", "agent_declared_scope"] as const;
export type RoleDataPolicy = typeof roleDataPolicies[number];

export const roleTemplateKeys = ["platform_architect", "meeting_chair", "security_reviewer", "evidence_analyst"] as const;
export type RoleTemplateKey = typeof roleTemplateKeys[number];
export const roleOrchestrationFunctions = ["chair", "planner", "worker", "reviewer"] as const;
export type RoleOrchestrationFunction = typeof roleOrchestrationFunctions[number];

export interface Role {
  id: string;
  name: string;
  usageContext: string;
  responsibility: string;
  speakingGuidance: string;
  decisionScope: string;
  constraints: string;
  version: number;
  templateKey: RoleTemplateKey | null;
  toolPolicy: RoleToolPolicy;
  dataPolicy: RoleDataPolicy;
  orchestrationFunctions?: RoleOrchestrationFunction[];
  deletedAt: string | null;
}

export type RoleVersionSource = "created" | "updated" | "rollback" | "legacy_backfilled";

export interface RoleVersion {
  roleId: string;
  version: number;
  name: string;
  usageContext: string;
  responsibility: string;
  speakingGuidance: string;
  decisionScope: string;
  constraints: string;
  templateKey: RoleTemplateKey | null;
  toolPolicy: RoleToolPolicy;
  dataPolicy: RoleDataPolicy;
  orchestrationFunctions?: RoleOrchestrationFunction[];
  source: RoleVersionSource;
  restoredFromVersion: number | null;
  recordedAt: string;
}

export interface RoleLifecycleView {
  role: Role;
  versions: RoleVersion[];
  missingVersions: number[];
  canDelete: boolean;
  blockerReason: string | null;
  unfinishedMeetingCount: number;
  activeTeamCount: number;
  historicalMeetingCount: number;
}

export interface RoleDeletionResult {
  id: string;
  historicalMeetingCount: number;
}

export function createRoleVersion(
  role: Role,
  source: RoleVersionSource,
  restoredFromVersion: number | null = null,
  recordedAt: string = new Date().toISOString()
): RoleVersion {
  return {
    roleId: role.id,
    version: role.version,
    name: role.name,
    usageContext: role.usageContext,
    responsibility: role.responsibility,
    speakingGuidance: role.speakingGuidance,
    decisionScope: role.decisionScope,
    constraints: role.constraints,
    templateKey: role.templateKey,
    toolPolicy: role.toolPolicy,
    dataPolicy: role.dataPolicy,
    orchestrationFunctions: [...(role.orchestrationFunctions ?? [])],
    source,
    restoredFromVersion,
    recordedAt
  };
}

export function roleAllowsExternalTools(policy: Pick<Role, "toolPolicy" | "dataPolicy">): boolean {
  return policy.toolPolicy === "agent_read_only_grants" && policy.dataPolicy === "agent_declared_scope";
}

export function rolePolicyCombinationIsValid(policy: Pick<Role, "toolPolicy" | "dataPolicy">): boolean {
  return policy.toolPolicy === "none" || policy.dataPolicy === "agent_declared_scope";
}

export const defaultRoleBehavior = {
  speakingGuidance: "先回應目前議題，再提出一項具體建議與風險。",
  decisionScope: "可提出候選決議，不代替擁有者核准。",
  constraints: "不得偏離會議目標；不確定時必須明確標示假設。"
} as const;

export interface BuiltInRoleTemplate {
  key: RoleTemplateKey;
  name: string;
  usageContext: string;
  responsibility: string;
  speakingGuidance: string;
  decisionScope: string;
  constraints: string;
  toolPolicy: RoleToolPolicy;
  dataPolicy: RoleDataPolicy;
  orchestrationFunctions: RoleOrchestrationFunction[];
}

export const builtInRoleTemplates = [
  {
    key: "platform_architect",
    name: "平台架構師",
    usageContext: "用於架構邊界、整合取捨與技術方案評審。",
    responsibility: "提出可維護的系統邊界與取捨。",
    speakingGuidance: "先界定邊界與取捨，再提出可落地的下一步。",
    decisionScope: "可提出候選決議，不代替擁有者核准。",
    constraints: "不得以未驗證推論取代技術證據。",
    toolPolicy: "agent_read_only_grants",
    dataPolicy: "agent_declared_scope",
    orchestrationFunctions: ["planner", "worker"] as RoleOrchestrationFunction[]
  },
  {
    key: "meeting_chair",
    name: "會議主席",
    usageContext: "用於需要控制議程、發言秩序與時間的會議。",
    responsibility: "維持議程、時間並形成候選決議。",
    speakingGuidance: "遇離題、重複或時間不足時，提出模式或角色切換建議。",
    decisionScope: "可整理候選決議與主持流程，不代替擁有者核准。",
    constraints: "不得自行核准決議、建立任務或擴張工具權限。",
    toolPolicy: "none",
    dataPolicy: "meeting_only",
    orchestrationFunctions: ["chair", "planner"] as RoleOrchestrationFunction[]
  },
  {
    key: "security_reviewer",
    name: "安全審查",
    usageContext: "用於權限、資料、供應鏈與外部整合風險審查。",
    responsibility: "挑戰權限、資料與外部整合風險。",
    speakingGuidance: "優先檢查權限、資料流、供應鏈與外部整合風險。",
    decisionScope: "提供風險意見與阻擋理由，不代替擁有者核准。",
    constraints: "沒有證據時標示 unknown；不得自行執行寫入型工具。",
    toolPolicy: "agent_read_only_grants",
    dataPolicy: "agent_declared_scope",
    orchestrationFunctions: ["reviewer"] as RoleOrchestrationFunction[]
  },
  {
    key: "evidence_analyst",
    name: "證據分析師",
    usageContext: "用於彙整來源、驗證主張與指出證據缺口。",
    responsibility: "整理來源、區分證據與推論並指出缺口。",
    speakingGuidance: "先列出可驗證來源，再說明推論與待確認事項。",
    decisionScope: "可整理證據與候選結論，不代替擁有者核准。",
    constraints: "不得把缺少來源的內容標示為已驗證事實。",
    toolPolicy: "agent_read_only_grants",
    dataPolicy: "agent_declared_scope",
    orchestrationFunctions: ["reviewer"] as RoleOrchestrationFunction[]
  }
] as const satisfies readonly BuiltInRoleTemplate[];

export function resolveRoleUsageContext(value: {
  usageContext?: unknown;
  templateKey?: RoleTemplateKey | null | undefined;
  responsibility?: unknown;
}): string {
  if (typeof value.usageContext === "string" && value.usageContext.trim()) return value.usageContext;
  const template = builtInRoleTemplates.find((candidate) => candidate.key === value.templateKey);
  if (template) return template.usageContext;
  if (typeof value.responsibility === "string" && value.responsibility.trim()) return value.responsibility.trim();
  throw new Error("Role usage context cannot be resolved without a template or responsibility.");
}

export interface RoleExecutionSnapshot {
  roleId: string;
  name: string;
  usageContext: string;
  responsibility: string;
  speakingGuidance: string;
  decisionScope: string;
  constraints: string;
  version: number;
  templateKey: RoleTemplateKey | null;
  toolPolicy: RoleToolPolicy;
  dataPolicy: RoleDataPolicy;
  orchestrationFunctions: RoleOrchestrationFunction[];
  source: "meeting_created" | "legacy_backfilled" | "meeting_role_switched";
}

export function createRoleExecutionSnapshot(
  role: Role,
  source: RoleExecutionSnapshot["source"] = "meeting_created"
): RoleExecutionSnapshot {
  return {
    roleId: role.id,
    name: role.name,
    usageContext: role.usageContext,
    responsibility: role.responsibility,
    speakingGuidance: role.speakingGuidance,
    decisionScope: role.decisionScope,
    constraints: role.constraints,
    version: role.version,
    templateKey: role.templateKey,
    toolPolicy: role.toolPolicy,
    dataPolicy: role.dataPolicy,
    orchestrationFunctions: [...(role.orchestrationFunctions ?? [])],
    source
  };
}

export interface Skill {
  id: string;
  name: string;
  version: string;
  instructions: string;
  source: string;
  owner: string;
  contentDigest: string;
  validation: SkillValidation;
  status: "draft" | "approved" | "revoked";
  approvedAt: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
}

export interface SkillValidation {
  result: "pending" | "passed" | "failed";
  summary: string;
  checkedAt: string | null;
  contentDigest: string | null;
}

export interface SkillRevocationResult {
  skill: Skill;
  revokedAssignmentCount: number;
}

export interface ModelConnector {
  id: string;
  revision: number;
  name: string;
  location: "cloud" | "local";
  baseUrl: string;
  model: string;
  enabled: boolean;
  hasSecret: boolean;
  secretRevision: number;
  credentialId?: string | null;
}

export interface ModelConnectorUpdateResult {
  connector: ModelConnector;
  assignedAgentCount: number;
}

export interface McpConnector {
  id: string;
  revision: number;
  name: string;
  location: "cloud" | "local";
  baseUrl: string;
  approvedTools: string[];
  toolRegistrations: ToolRegistration[];
  enabled: boolean;
  hasSecret: boolean;
  secretRevision?: number;
}

export interface ToolRegistration {
  toolName: string;
  displayName: string;
  kind: ToolRegistrationKind;
  version: string;
  owner: string;
  goal: string;
}

export interface ToolRegistrationSnapshot extends ToolRegistration {
  connectorName: string;
}

export interface McpToolExecutionBinding {
  connectorId: string;
  toolSnapshot: ToolRegistrationSnapshot;
  connectorFingerprint: string;
}

export type PublicMcpToolExecutionBinding = Omit<McpToolExecutionBinding, "connectorFingerprint">;

export interface McpConnectorUpdateResult {
  connector: McpConnector;
  revokedGrantCount: number;
}

export interface DiscoveredMcpTool {
  name: string;
  description?: string;
  readOnly: boolean;
}

export interface McpDiscoveryResponse {
  connector: McpConnector;
  tools: DiscoveredMcpTool[];
  approvedTools: string[];
}

export interface TaskAdapterConnector {
  id: string;
  name: string;
  location: "cloud" | "local";
  baseUrl: string;
  enabled: boolean;
  hasSecret: boolean;
}

export interface ParticipantAssignment {
  id: string;
  meetingId: string;
  agentId: string;
  roleId: string;
  isChair: boolean;
  agentRevision?: number | undefined;
  roleSnapshot: RoleExecutionSnapshot;
  roleRevision: number;
  roleHistory: ParticipantRoleHistoryEntry[];
}

export interface ParticipantRoleHistoryEntry {
  revision: number;
  roleId: string;
  roleSnapshot: RoleExecutionSnapshot;
  changedAt: string;
  changedBy: "owner" | "system";
  reason: string;
}

export interface ParticipantRoleBinding {
  participantId: string;
  roleRevision: number;
  roleId: string;
  roleVersion: number;
}

export interface SpeakerQueueItem extends ParticipantRoleBinding {
  id: string;
  jobId: string;
  reservationId?: string | null;
  requestFingerprint: string | null;
  meetingId: string;
  agentId: string;
  kind: SpeakerQueueKind;
  label: string;
  toolName: string | null;
  roleName: string;
  agendaRevision: number | null;
  agendaCurrentItemId: string | null;
  status: SpeakerQueueStatus;
  requestedAt: string;
  startedAt: string | null;
  leaseExpiresAt: string;
  runtimeProfileBinding?: RuntimeProfileBinding | null;
  mcpExecutionBinding?: McpToolExecutionBinding | null;
  requestedBy?: "owner" | "system";
  chairSuggestionId?: string | null;
  automationRevision?: number | null;
}

export type PublicSpeakerQueueItem = Omit<
  SpeakerQueueItem,
  "reservationId" | "requestFingerprint" | "mcpExecutionBinding"
> & {
  mcpExecutionBinding?: PublicMcpToolExecutionBinding | null;
};

export interface AgendaItem {
  id: string;
  title: string;
  description: string;
  position: number;
  status: AgendaItemStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  resolvedAt: string | null;
}

export interface MeetingAgenda {
  revision: number;
  items: AgendaItem[];
}

export interface Meeting {
  id: string;
  threadId: string;
  title: string;
  goal: string;
  state: MeetingState;
  mode: MeetingMode;
  automation: ChairAutomationLevel;
  automationRevision?: number;
  durationMinutes: number;
  startedAt: string | null;
  closedAt: string | null;
  agenda: MeetingAgenda;
  summaryState: MeetingSummaryState;
  summaryJobId: string | null;
  createdAt: string;
  sourceTeamId?: string | null;
  sourcePresetId?: string | null;
}

export interface Utterance {
  id: string;
  meetingId: string;
  agentId?: string | undefined;
  agentRevision?: number | null | undefined;
  turnId?: string | undefined;
  speakerType: "human" | "agent" | "system" | "tool";
  speakerName: string;
  roleName: string | null;
  roleId?: string | null | undefined;
  roleRevision?: number | null | undefined;
  content: string;
  kind: "human" | "inference" | "verified" | "failure" | "system";
  evidenceCount: number;
  createdAt: string;
}

export const meetingRecordGenerationModes = ["deterministic", "model_assisted"] as const;
export const meetingRecordCreatedBy = ["system", "owner"] as const;
export const meetingRecordOutcomeStatuses = ["completed", "partial", "inconclusive"] as const;
export const meetingRecordSourceKinds = ["utterance", "agenda", "decision", "task", "tool_run", "chair_suggestion", "goal"] as const;

export type MeetingRecordGenerationMode = (typeof meetingRecordGenerationModes)[number];
export type MeetingRecordCreatedBy = (typeof meetingRecordCreatedBy)[number];
export type MeetingRecordOutcomeStatus = (typeof meetingRecordOutcomeStatuses)[number];
export type MeetingRecordSourceKind = (typeof meetingRecordSourceKinds)[number];

export interface MeetingRecordSourceReference {
  kind: MeetingRecordSourceKind;
  id: string;
}

export interface MeetingRecordNarrativePoint {
  text: string;
  sourceReferences: MeetingRecordSourceReference[];
}

export interface MeetingRecordContent {
  meeting: {
    meetingId: string;
    threadId: string;
    title: string;
    goal: string;
    state: "closed";
    mode: MeetingMode;
    startedAt: string | null;
    closedAt: string;
  };
  outcome: {
    status: MeetingRecordOutcomeStatus;
    summary: string;
    narrativePoints: MeetingRecordNarrativePoint[];
  };
  participants: Array<{
    participantId: string;
    agentId: string;
    agentRevision: number | null;
    roleId: string;
    roleRevision: number;
    isChair: boolean;
  }>;
  agenda: Array<{
    agendaItemId: string;
    title: string;
    status: AgendaItemStatus;
    outcome: string | null;
    sourceReferences: MeetingRecordSourceReference[];
  }>;
  consensus: MeetingRecordNarrativePoint[];
  dissent: MeetingRecordNarrativePoint[];
  openItems: MeetingRecordNarrativePoint[];
  decisions: Array<{
    decisionId: string;
    title: string;
    description: string;
    status: DecisionStatus;
    sourceReferences: MeetingRecordSourceReference[];
  }>;
  tasks: Array<{
    taskId: string;
    decisionId: string;
    title: string;
    status: TaskStatus;
    assigneeAgentId: string | null;
    dueAt: string | null;
    sourceReferences: MeetingRecordSourceReference[];
  }>;
  evidenceReferences: Array<{
    evidenceId: string;
    type: "meeting" | "decision" | "url" | "note";
    label: string;
    reference: string;
    sourceReferences: MeetingRecordSourceReference[];
  }>;
  linkedGoalIds: string[];
}

export interface MeetingRecord {
  meetingId: string;
  revision: number;
  closedAt: string;
  generatedAt: string;
  generationMode: MeetingRecordGenerationMode;
  content: MeetingRecordContent;
  sourceDigest: string;
  createdBy: MeetingRecordCreatedBy;
}

export interface McpToolRun {
  id: string;
  jobId: string;
  requestFingerprint: string;
  meetingId: string;
  agentId: string;
  connectorId: string;
  toolName: string;
  toolSnapshot: ToolRegistrationSnapshot;
  status: McpToolRunStatus;
  utteranceId: string;
  createdAt: string;
}

export type PublicMcpToolRun = Omit<McpToolRun, "requestFingerprint">;

export interface Decision {
  id: string;
  meetingId: string;
  title: string;
  description: string;
  status: DecisionStatus;
  createdAt: string;
}

export interface TaskEvidence {
  id: string;
  type: "meeting" | "decision" | "url" | "note";
  label: string;
  reference: string;
  addedBy: "owner" | "system";
  agentId?: string;
  jobId?: string;
  executionProfile?: Exclude<TaskExecutionProfile, "manual">;
  createdAt: string;
}

export interface TaskTransition {
  id: string;
  type:
    | "created"
    | "updated"
    | "moved"
    | "evidence_added"
    | "approval_changed"
    | "agent_run_requested"
    | "agent_run_started"
    | "agent_run_completed"
    | "agent_run_failed"
    | "sync_requested"
    | "sync_succeeded"
    | "sync_failed";
  actor: "owner" | "system";
  at: string;
  fromStatus?: TaskStatus;
  toStatus?: TaskStatus;
  fromPosition?: number;
  toPosition?: number;
  evidenceId?: string;
  agentId?: string;
  executionRevision?: number;
  fromApprovalState?: TaskApprovalState;
  toApprovalState?: TaskApprovalState;
  requestFingerprint?: string;
  adapterId?: string;
  jobId?: string;
  note?: string;
}

export interface TaskExecutionState {
  revision: number;
  status: TaskExecutionStatus;
  jobId: string | null;
  requestFingerprint: string | null;
  agentId: string | null;
  profile: Exclude<TaskExecutionProfile, "manual"> | null;
  attemptCount: number;
  requestedAt: string | null;
  startedAt: string | null;
  providerStartedAt?: string | null;
  completedAt: string | null;
  lastError: string | null;
  resultEvidenceId: string | null;
  runtimeProfileBinding?: RuntimeProfileBinding | null;
}

export interface TaskSyncState {
  status: TaskSyncStatus;
  adapterId: string | null;
  jobId: string | null;
  requestFingerprint: string | null;
  externalId: string | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  syncedAt: string | null;
}

export type PublicTaskTransition = Omit<TaskTransition, "requestFingerprint">;
export type PublicTaskExecutionState = Omit<TaskExecutionState, "requestFingerprint">;
export type PublicTaskSyncState = Omit<TaskSyncState, "requestFingerprint">;

export interface Task {
  id: string;
  meetingId: string;
  decisionId: string;
  revision: number;
  boardRevision: number;
  title: string;
  description: string;
  status: TaskStatus;
  position: number;
  assignee: string | null;
  assigneeAgentId: string | null;
  dueAt: string | null;
  acceptanceCriteria: string;
  evidence: TaskEvidence[];
  executionProfile: TaskExecutionProfile;
  allowedTools: string[];
  dataScope: string;
  approvalState: TaskApprovalState;
  execution: TaskExecutionState;
  transitions: TaskTransition[];
  sync: TaskSyncState;
  createdAt: string;
  updatedAt: string;
}

export type PublicTask = Omit<Task, "execution" | "transitions" | "sync"> & {
  execution: PublicTaskExecutionState;
  transitions: PublicTaskTransition[];
  sync: PublicTaskSyncState;
};

export interface PlatformSnapshot {
  groups: DiscussionGroup[];
  categories: Category[];
  tags: Tag[];
  threads: DiscussionThread[];
  agents: Agent[];
  roles: Role[];
  skills: Skill[];
  modelConnectors: ModelConnector[];
  mcpConnectors: McpConnector[];
  taskAdapterConnectors: TaskAdapterConnector[];
  meetings: Meeting[];
  participants: ParticipantAssignment[];
  speakerQueue: SpeakerQueueItem[];
  utterances: Utterance[];
  toolRuns: McpToolRun[];
  chairSuggestions: ChairSuggestionRecord[];
  decisions: Decision[];
  tasks: Task[];
  credentials?: Credential[];
  prompts?: PromptTemplate[];
  agentTeams?: AgentTeam[];
  meetingPresets?: MeetingPreset[];
  runtimeProfiles?: RuntimeProfile[];
  runtimeProfileRevisions?: RuntimeProfileRevision[];
  toolPacks?: ToolPack[];
  toolPackRevisions?: ToolPackRevision[];
}

export type PublicPlatformSnapshot = Omit<PlatformSnapshot, "speakerQueue" | "toolRuns" | "tasks"> & {
  speakerQueue: PublicSpeakerQueueItem[];
  toolRuns: PublicMcpToolRun[];
  tasks: PublicTask[];
};

export const platformViewNames = ["discussions", "tasks", "agents", "settings"] as const;
export type PlatformViewName = (typeof platformViewNames)[number];

export interface MeetingViewSnapshot {
  meeting: Meeting;
  participants: ParticipantAssignment[];
  speakerQueue: SpeakerQueueItem[];
  utterances: Utterance[];
  toolRuns: McpToolRun[];
  chairSuggestions: ChairSuggestionRecord[];
  decisions: Decision[];
  tasks: Task[];
}

export type PublicMeetingViewSnapshot = Omit<MeetingViewSnapshot, "speakerQueue" | "toolRuns" | "tasks"> & {
  speakerQueue: PublicSpeakerQueueItem[];
  toolRuns: PublicMcpToolRun[];
  tasks: PublicTask[];
};

export interface CredentialBinding {
  credentialId: string;
  secretRevision: number;
  provider: string;
  location: "cloud" | "local";
}

export interface AgentTurnJobData extends ParticipantRoleBinding {
  meetingId: string;
  agentId: string;
  reservationId?: string;
  agendaRevision: number;
  agendaCurrentItemId: string | null;
  requestedBy: "owner" | "system";
  chairSuggestionId?: string;
  automationRevision?: number;
  modelConnectorBinding?: Pick<ModelConnector, "id" | "location" | "baseUrl" | "model" | "secretRevision">;
  agentRevision?: number;
  promptBinding?: PromptBinding | null;
  credentialBinding?: CredentialBinding;
  skillDigests?: Record<string, string>;
  runtimeProfileBinding?: RuntimeProfileBinding;
  runtimeProfileSnapshot?: RuntimeProfileSnapshot;
  runtimeRun?: RuntimeRun;
}

export interface ChairAutomationJobData {
  meetingId: string;
  chairSuggestionId: string;
  sourceUtteranceId: string;
  automationRevision: number;
  requestedBy: "system";
  modelConnectorBinding?: Pick<ModelConnector, "id" | "location" | "baseUrl" | "model" | "secretRevision">;
  agentRevision?: number;
  promptBinding?: PromptBinding | null;
  credentialBinding?: CredentialBinding;
  skillDigests?: Record<string, string>;
  runtimeProfileBinding?: RuntimeProfileBinding;
  runtimeProfileSnapshot?: RuntimeProfileSnapshot;
}

interface McpToolCallJobBase extends ParticipantRoleBinding {
  meetingId: string;
  agentId: string;
  requestFingerprint?: string | undefined;
  connectorId: string;
  toolName: string;
  toolSnapshot: ToolRegistrationSnapshot;
  connectorFingerprint: string;
  requestedBy: "owner";
}

export type McpToolArgumentPayload =
  | {
      argumentEncoding?: never;
      arguments: Record<string, unknown>;
      argumentsCiphertext?: never;
    }
  | {
      argumentEncoding: "vault_v1";
      arguments?: never;
      argumentsCiphertext: string;
    };

export type McpToolCallJobData = McpToolCallJobBase & McpToolArgumentPayload;

export interface MeetingSummaryJobData {
  meetingId: string;
  requestedBy: "system";
}

export interface TaskSyncJobData {
  taskId: string;
  adapterId: string;
  requestedBy: "owner" | "system";
}

export interface TaskAgentRunJobData {
  taskId: string;
  goalRunId?: string;
  planTaskId?: string;
  agentId: string;
  executionProfile: Exclude<TaskExecutionProfile, "manual">;
  executionRevision: number;
  taskFingerprint: string;
  requestFingerprint: string;
  modelConnectorBinding: Pick<ModelConnector, "id" | "location" | "baseUrl" | "model" | "secretRevision">;
  agentRevision?: number;
  promptBinding?: PromptBinding | null;
  credentialBinding?: CredentialBinding;
  skillDigests: Record<string, string>;
  runtimeProfileBinding?: RuntimeProfileBinding;
  runtimeProfileSnapshot?: RuntimeProfileSnapshot;
  runtimeRun?: RuntimeRun;
  executionRuntimeBinding?: ExecutionRuntimeBinding;
  requestedBy: "owner";
}

export type CouncilJobData = AgentTurnJobData | ChairAutomationJobData | McpToolCallJobData | MeetingSummaryJobData | TaskSyncJobData | TaskAgentRunJobData | RuntimeControlJobData | RuntimeReconcileJobData;
export type CouncilJobName =
  | "agent-turn"
  | "chair-automation"
  | "mcp-tool-call"
  | "meeting-summary"
  | "task-sync"
  | "task-agent-run"
  | "goal-orchestrate"
  | "goal-plan"
  | "goal-review"
  | "goal-action-run"
  | "runtime-control"
  | "runtime-reconcile";

const nonEmpty = z.string().trim().min(1).max(500);
const httpUrl = z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "HTTP(S) URL required");

const agendaTitleSchema = nonEmpty.max(160);
const agendaDescriptionSchema = z.string().trim().max(1000).default("");
const agendaDraftItemSchema = z.object({
  title: agendaTitleSchema,
  description: agendaDescriptionSchema
}).strict();
const editableAgendaItemSchema = agendaDraftItemSchema.extend({
  id: z.string().uuid().optional()
}).strict();

function normalizedAgendaTitle(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

const positiveInteger = z.number().int().positive();
const timestamp = z.string().datetime({ offset: true });
const digest = nonEmpty.max(200);
const promptVariable = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const promptVariables = z.array(promptVariable).max(100).superRefine((variables, context) => {
  if (new Set(variables).size !== variables.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Each Prompt variable may appear only once." });
  }
});
const promptBindingSchema = z.object({
  promptId: z.string().uuid(),
  version: positiveInteger
}).strict();

export const credentialSchema = z.object({
  id: z.string().uuid(),
  name: nonEmpty.max(100),
  provider: nonEmpty.max(100),
  kind: z.enum(credentialKinds),
  location: z.enum(["cloud", "local"]),
  status: z.enum(credentialStatuses),
  hasSecret: z.boolean(),
  secretRevision: z.number().int().nonnegative(),
  maskedHint: z.string().trim().max(100).nullable(),
  expiresAt: timestamp.nullable(),
  lastUsedAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  rotatedAt: timestamp.nullable()
}).strict();

const credentialSecret = z.string().trim().min(1).max(4_000);

export const createCredentialSchema = z.object({
  name: nonEmpty.max(100),
  provider: nonEmpty.max(100),
  kind: z.enum(credentialKinds),
  location: z.enum(["cloud", "local"]),
  secret: credentialSecret.optional(),
  expiresAt: timestamp.nullable().optional()
}).strict();

export const updateCredentialSchema = z.object({
  expectedUpdatedAt: timestamp,
  name: nonEmpty.max(100).optional(),
  provider: nonEmpty.max(100).optional(),
  kind: z.enum(credentialKinds).optional(),
  location: z.enum(["cloud", "local"]).optional(),
  expiresAt: timestamp.nullable().optional()
}).strict().refine(
  (value) => Object.keys(value).some((field) => field !== "expectedUpdatedAt"),
  "At least one Credential field is required"
);

export const rotateCredentialSchema = z.object({
  credentialId: z.string().uuid(),
  secret: credentialSecret,
  expectedSecretRevision: z.number().int().nonnegative()
}).strict();

export const updateCredentialStatusSchema = z.object({
  status: z.enum(credentialStatuses),
  expectedUpdatedAt: timestamp
}).strict();
export const setCredentialStatusSchema = updateCredentialStatusSchema;

export const promptTemplateSchema = z.object({
  id: z.string().uuid(),
  name: nonEmpty.max(100),
  kind: z.enum(promptKinds),
  description: z.string().trim().max(1_000),
  owner: nonEmpty.max(200),
  status: z.enum(promptStatuses),
  currentVersion: positiveInteger,
  publishedVersion: positiveInteger.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp
}).strict();

export const promptVersionSchema = z.object({
  promptId: z.string().uuid(),
  version: positiveInteger,
  content: nonEmpty.max(20_000),
  variables: promptVariables,
  contentDigest: digest,
  source: z.enum(promptVersionSources),
  restoredFromVersion: positiveInteger.nullable(),
  createdAt: timestamp,
  publishedAt: timestamp.nullable()
}).strict();

export const createPromptSchema = z.object({
  name: nonEmpty.max(100),
  kind: z.enum(promptKinds),
  description: z.string().trim().max(1_000),
  owner: nonEmpty.max(200),
  content: nonEmpty.max(20_000),
  variables: promptVariables.default([])
}).strict();

export const updatePromptSchema = z.object({
  expectedCurrentVersion: positiveInteger,
  name: nonEmpty.max(100).optional(),
  kind: z.enum(promptKinds).optional(),
  description: z.string().trim().max(1_000).optional(),
  owner: nonEmpty.max(200).optional(),
  content: nonEmpty.max(20_000).optional(),
  variables: promptVariables.optional()
}).strict().refine(
  (value) => Object.keys(value).some((field) => field !== "expectedCurrentVersion"),
  "At least one Prompt field is required"
);

export const publishPromptSchema = z.object({
  expectedCurrentVersion: positiveInteger,
  version: positiveInteger
}).strict();

export const rollbackPromptSchema = z.object({
  expectedCurrentVersion: positiveInteger,
  version: positiveInteger
}).strict();

export const archivePromptSchema = z.object({
  expectedCurrentVersion: positiveInteger
}).strict();

export const promptPreviewRequestSchema = z.object({
  version: positiveInteger,
  variables: z.record(z.string(), z.string().max(20_000)).default({})
}).strict();

export const agentRevisionSchema = z.object({
  agentId: z.string().uuid(),
  revision: positiveInteger,
  name: nonEmpty.max(100),
  description: z.string().trim().max(500),
  modelConnectorId: z.string().uuid().nullable(),
  goalSummary: nonEmpty.max(1_000),
  toolsSummary: nonEmpty.max(1_000),
  dataSummary: nonEmpty.max(1_000),
  skillIds: z.array(z.string().uuid()).max(50),
  toolGrants: z.array(z.object({ connectorId: z.string().uuid(), toolName: nonEmpty.max(200) }).strict()).max(100),
  toolPackGrants: z.array(toolPackGrantSchema).max(100).default([]),
  runtimeProfileBinding: runtimeProfileBindingSchema.nullable(),
  promptBinding: promptBindingSchema.nullable(),
  contentDigest: digest,
  contentDigestVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
  source: z.enum(agentRevisionSources),
  restoredFromRevision: positiveInteger.nullable(),
  createdAt: timestamp,
  publishedAt: timestamp.nullable()
}).strict().superRefine((value, context) => {
  if (new Set(value.skillIds).size !== value.skillIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Each Skill may be assigned only once.", path: ["skillIds"] });
  }
  const grants = value.toolGrants.map((grant) => `${grant.connectorId}:${grant.toolName}`);
  if (new Set(grants).size !== grants.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Each Agent tool grant may appear only once.", path: ["toolGrants"] });
  }
  const packGrants = value.toolPackGrants.map((grant) => `${grant.packId}:${grant.revision}:${grant.manifestDigest}:${grant.toolName}`);
  if (new Set(packGrants).size !== packGrants.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Each Agent Tool Pack grant may appear only once.", path: ["toolPackGrants"] });
  }
});

export const agentReadinessSchema = z.object({
  status: z.enum(agentReadinessStatuses),
  checks: z.array(z.object({
    code: z.enum(agentReadinessCheckCodes),
    status: z.enum(agentReadinessCheckStatuses),
    message: nonEmpty.max(1_000)
  }).strict()).max(20)
}).strict();

export const publishAgentSchema = z.object({
  expectedDraftRevision: positiveInteger
}).strict();

export const rollbackAgentSchema = z.object({
  expectedPublishedRevision: positiveInteger,
  expectedDraftRevision: positiveInteger,
  revision: positiveInteger
}).strict();

export const setAgentStatusSchema = z.object({
  status: z.enum(agentLifecycleStatuses),
  expectedRevision: positiveInteger
}).strict();

const agentTeamMemberSchema = z.object({
  agentId: z.string().uuid(),
  roleId: z.string().uuid(),
  isChair: z.boolean()
}).strict();

function validateAgentTeamMembers(
  members: Array<{ agentId: string; isChair: boolean }>,
  context: z.RefinementCtx
): void {
  if (new Set(members.map((member) => member.agentId)).size !== members.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Each Agent may be assigned to a Team only once.", path: ["members"] });
  }
  if (members.filter((member) => member.isChair).length !== 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "An Agent Team must have exactly one chair.", path: ["members"] });
  }
}

const agentTeamFields = {
  name: nonEmpty.max(100),
  description: z.string().trim().max(1_000),
  members: z.array(agentTeamMemberSchema).min(1).max(12)
};

export const createAgentTeamSchema = z.object(agentTeamFields).strict().superRefine(({ members }, context) => validateAgentTeamMembers(members, context));

export const updateAgentTeamSchema = z.object({
  expectedRevision: positiveInteger,
  name: agentTeamFields.name.optional(),
  description: agentTeamFields.description.optional(),
  members: agentTeamFields.members.optional(),
  status: z.enum(agentTeamStatuses).optional()
}).strict().refine(
  (value) => Object.keys(value).some((field) => field !== "expectedRevision"),
  "At least one Agent Team field is required"
)
  .superRefine(({ members }, context) => {
    if (members) validateAgentTeamMembers(members, context);
  });

export const agentTeamSchema = z.object({
  id: z.string().uuid(),
  revision: positiveInteger.default(1),
  ...agentTeamFields,
  status: z.enum(agentTeamStatuses),
  createdAt: timestamp,
  updatedAt: timestamp
}).strict().superRefine(({ members }, context) => validateAgentTeamMembers(members, context));

const meetingPresetAgendaItemSchema = z.object({
  title: nonEmpty.max(160),
  description: z.string().trim().max(1_000)
}).strict();

function validateUniquePresetAgendaTitles(
  items: Array<{ title: string }>,
  context: z.RefinementCtx
): void {
  const titles = items.map((item) => normalizedAgendaTitle(item.title));
  if (new Set(titles).size !== titles.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Each Meeting Preset agenda title may appear only once.", path: ["agendaItems"] });
  }
}

const meetingPresetFields = {
  name: nonEmpty.max(100),
  description: z.string().trim().max(1_000),
  teamId: z.string().uuid().nullable(),
  mode: z.enum(meetingModes),
  automation: z.enum(chairAutomationLevels),
  durationMinutes: z.number().int().min(5).max(240),
  agendaItems: z.array(meetingPresetAgendaItemSchema).min(1).max(12)
};

export const createMeetingPresetSchema = z.object(meetingPresetFields).strict().superRefine(({ agendaItems }, context) => validateUniquePresetAgendaTitles(agendaItems, context));

export const updateMeetingPresetSchema = z.object({
  expectedRevision: positiveInteger,
  name: meetingPresetFields.name.optional(),
  description: meetingPresetFields.description.optional(),
  teamId: meetingPresetFields.teamId.optional(),
  mode: meetingPresetFields.mode.optional(),
  automation: meetingPresetFields.automation.optional(),
  durationMinutes: meetingPresetFields.durationMinutes.optional(),
  agendaItems: meetingPresetFields.agendaItems.optional(),
  status: z.enum(meetingPresetStatuses).optional()
}).strict().refine(
  (value) => Object.keys(value).some((field) => field !== "expectedRevision"),
  "At least one Meeting Preset field is required"
)
  .superRefine(({ agendaItems }, context) => {
    if (agendaItems) validateUniquePresetAgendaTitles(agendaItems, context);
  });

export const meetingPresetSchema = z.object({
  id: z.string().uuid(),
  revision: positiveInteger.default(1),
  ...meetingPresetFields,
  status: z.enum(meetingPresetStatuses),
  createdAt: timestamp,
  updatedAt: timestamp
}).strict().superRefine(({ agendaItems }, context) => validateUniquePresetAgendaTitles(agendaItems, context));

function validateAgendaDraftItems(
  items: Array<{ id?: string | undefined; title: string }>,
  context: z.RefinementCtx
): void {
  const normalizedTitles = items.map((item) => normalizedAgendaTitle(item.title));
  if (new Set(normalizedTitles).size !== normalizedTitles.length) {
    context.addIssue({ code: "custom", message: "Each Agenda title may appear only once.", path: ["items"] });
  }
  const ids = items.flatMap((item) => item.id ? [item.id] : []);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "Each Agenda item ID may appear only once.", path: ["items"] });
  }
}

export const agendaItemSchema = z.object({
  id: z.string().uuid(),
  title: agendaTitleSchema,
  description: z.string().trim().max(1000),
  position: z.number().int().min(0).max(11),
  status: z.enum(agendaItemStatuses),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  resolvedAt: z.string().datetime({ offset: true }).nullable()
}).strict().superRefine((item, context) => {
  if (item.status === "pending" && (item.startedAt !== null || item.resolvedAt !== null)) {
    context.addIssue({ code: "custom", message: "A pending Agenda item cannot have lifecycle timestamps.", path: ["status"] });
  }
  if (item.status === "current" && (item.startedAt === null || item.resolvedAt !== null)) {
    context.addIssue({ code: "custom", message: "A current Agenda item requires startedAt and no resolvedAt.", path: ["status"] });
  }
  if ((item.status === "completed" || item.status === "skipped") && item.resolvedAt === null) {
    context.addIssue({ code: "custom", message: "A resolved Agenda item requires resolvedAt.", path: ["status"] });
  }
});

export const meetingAgendaSchema = z.object({
  revision: z.number().int().min(0),
  items: z.array(agendaItemSchema).max(12)
}).strict().superRefine(({ items }, context) => {
  validateAgendaDraftItems(items, context);
  if (items.filter((item) => item.status === "current").length > 1) {
    context.addIssue({ code: "custom", message: "A Meeting Agenda may have only one current item.", path: ["items"] });
  }
  if (items.some((item, index) => item.position !== index)) {
    context.addIssue({ code: "custom", message: "Agenda positions must be contiguous and match list order.", path: ["items"] });
  }
  const lifecycleRank = { completed: 0, skipped: 0, current: 1, pending: 2 } as const;
  if (items.some((item, index) => items.slice(0, index).some((previous) => lifecycleRank[previous.status] > lifecycleRank[item.status]))) {
    context.addIssue({ code: "custom", message: "Agenda items must remain in terminal, current, then pending lifecycle order.", path: ["items"] });
  }
});

export const createGroupSchema = z.object({
  name: nonEmpty.max(100)
});

export const createCategorySchema = z.object({
  groupId: z.string().uuid(),
  name: nonEmpty.max(100)
});

export const createTagSchema = z.object({
  name: nonEmpty.max(100),
  color: z.enum(["green", "blue", "amber", "red", "gray"])
});

export const updateGroupSchema = z.object({
  expectedRevision: z.number().int().positive(),
  name: nonEmpty.max(100).optional()
}).strict().superRefine((value, context) => {
  if (!Object.keys(value).some((field) => field !== "expectedRevision")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "At least one Group field is required", path: ["name"] });
  }
});

export const updateCategorySchema = z.object({
  expectedRevision: z.number().int().positive(),
  groupId: z.string().uuid().optional(),
  name: nonEmpty.max(100).optional()
}).strict().superRefine((value, context) => {
  if (!Object.keys(value).some((field) => field !== "expectedRevision")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "At least one Category field is required", path: ["name"] });
  }
});

export const updateTagSchema = z.object({
  expectedRevision: z.number().int().positive(),
  name: nonEmpty.max(100).optional(),
  color: z.enum(["green", "blue", "amber", "red", "gray"]).optional()
}).strict().superRefine((value, context) => {
  if (!Object.keys(value).some((field) => field !== "expectedRevision")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "At least one Tag field is required", path: ["name"] });
  }
});

export const createThreadSchema = z.object({
  categoryId: z.string().uuid(),
  title: nonEmpty.max(160),
  summary: z.string().trim().max(1000).default(""),
  tagIds: z.array(z.string().uuid()).max(12).default([])
}).superRefine(({ tagIds }, context) => {
  if (new Set(tagIds).size !== tagIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Each tag may be assigned only once.", path: ["tagIds"] });
  }
});

export const updateThreadSchema = z.object({
  expectedRevision: z.number().int().positive(),
  categoryId: z.string().uuid().optional(),
  title: nonEmpty.max(160).optional(),
  summary: z.string().trim().max(1000).optional(),
  tagIds: z.array(z.string().uuid()).max(12).optional(),
  status: z.enum(threadStatuses).optional()
}).strict().superRefine((value, context) => {
  if (!Object.keys(value).some((field) => field !== "expectedRevision")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "At least one Topic field is required", path: ["status"] });
  }
  if (value.tagIds && new Set(value.tagIds).size !== value.tagIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Each tag may be assigned only once.", path: ["tagIds"] });
  }
});

export const createMeetingSchema = z.object({
  threadId: z.string().uuid(),
  title: nonEmpty.max(160),
  goal: nonEmpty.max(1000),
  mode: z.enum(meetingModes),
  automation: z.enum(chairAutomationLevels).default("suggest"),
  durationMinutes: z.number().int().min(5).max(240),
  sourceTeamId: z.string().uuid().nullable().optional(),
  sourcePresetId: z.string().uuid().nullable().optional(),
  participants: z.array(z.object({
    agentId: z.string().uuid(),
    roleId: z.string().uuid(),
    isChair: z.boolean().default(false),
    agentRevision: z.number().int().positive().optional()
  }).strict()).min(1).max(12),
  agendaItems: z.array(agendaDraftItemSchema).min(1).max(12)
}).strict().superRefine(({ agendaItems }, context) => validateAgendaDraftItems(agendaItems, context));

export const setMeetingAgendaSchema = z.object({
  expectedRevision: z.number().int().min(0),
  items: z.array(editableAgendaItemSchema).min(1).max(12)
}).strict().superRefine(({ items }, context) => validateAgendaDraftItems(items, context));

export const advanceMeetingAgendaSchema = z.discriminatedUnion("action", [
  z.object({
    expectedRevision: z.number().int().min(0),
    action: z.literal("activate")
  }).strict(),
  z.object({
    expectedRevision: z.number().int().min(0),
    action: z.literal("complete"),
    itemId: z.string().uuid()
  }).strict(),
  z.object({
    expectedRevision: z.number().int().min(0),
    action: z.literal("skip"),
    itemId: z.string().uuid()
  }).strict()
]);

export const createUtteranceSchema = z.object({
  agentId: z.string().uuid().optional(),
  agentRevision: z.number().int().positive().nullable().optional(),
  turnId: z.string().trim().min(1).max(200).optional(),
  speakerType: z.enum(["human", "agent", "system", "tool"]),
  speakerName: nonEmpty.max(100),
  roleName: z.string().trim().max(100).nullable().default(null),
  roleId: z.string().uuid().nullable().optional(),
  roleRevision: z.number().int().positive().nullable().optional(),
  content: nonEmpty.max(20_000),
  kind: z.enum(["human", "inference", "verified", "failure", "system"]),
  evidenceCount: z.number().int().min(0).max(100).default(0)
});

const meetingRecordSourceReferencesSchema = z.array(z.object({
  kind: z.enum(meetingRecordSourceKinds),
  id: z.string().uuid()
}).strict()).min(1).max(100).superRefine((references, context) => {
  if (new Set(references.map((reference) => `${reference.kind}:${reference.id}`)).size !== references.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Meeting Record source references must be unique." });
  }
});
const meetingRecordNarrativePointSchema = z.object({
  text: nonEmpty.max(4_000),
  sourceReferences: meetingRecordSourceReferencesSchema
}).strict();
const meetingRecordEvidenceReferenceSchema = z.string().trim().min(1).max(4_000);

export const meetingRecordContentSchema: z.ZodType<MeetingRecordContent> = z.object({
  meeting: z.object({
    meetingId: z.string().uuid(),
    threadId: z.string().uuid(),
    title: nonEmpty.max(160),
    goal: nonEmpty.max(1_000),
    state: z.literal("closed"),
    mode: z.enum(meetingModes),
    startedAt: timestamp.nullable(),
    closedAt: timestamp
  }).strict(),
  outcome: z.object({
    status: z.enum(meetingRecordOutcomeStatuses),
    summary: nonEmpty.max(4_000),
    narrativePoints: z.array(meetingRecordNarrativePointSchema).max(100)
  }).strict(),
  participants: z.array(z.object({
    participantId: z.string().uuid(),
    agentId: z.string().uuid(),
    agentRevision: positiveInteger.nullable(),
    roleId: z.string().uuid(),
    roleRevision: positiveInteger,
    isChair: z.boolean()
  }).strict()).max(100),
  agenda: z.array(z.object({
    agendaItemId: z.string().uuid(),
    title: nonEmpty.max(160),
    status: z.enum(agendaItemStatuses),
    outcome: z.string().trim().max(4_000).nullable(),
    sourceReferences: meetingRecordSourceReferencesSchema
  }).strict()).max(100),
  consensus: z.array(meetingRecordNarrativePointSchema).max(100),
  dissent: z.array(meetingRecordNarrativePointSchema).max(100),
  openItems: z.array(meetingRecordNarrativePointSchema).max(100),
  decisions: z.array(z.object({
    decisionId: z.string().uuid(),
    title: nonEmpty.max(160),
    description: nonEmpty.max(4_000),
    status: z.enum(decisionStatuses),
    sourceReferences: meetingRecordSourceReferencesSchema
  }).strict()).max(100),
  tasks: z.array(z.object({
    taskId: z.string().uuid(),
    decisionId: z.string().uuid(),
    title: nonEmpty.max(160),
    status: z.enum(taskStatuses),
    assigneeAgentId: z.string().uuid().nullable(),
    dueAt: timestamp.nullable(),
    sourceReferences: meetingRecordSourceReferencesSchema
  }).strict()).max(100),
  evidenceReferences: z.array(z.object({
    evidenceId: nonEmpty.max(200),
    type: z.enum(["meeting", "decision", "url", "note"]),
    label: nonEmpty.max(500),
    reference: meetingRecordEvidenceReferenceSchema,
    sourceReferences: meetingRecordSourceReferencesSchema
  }).strict()).max(200),
  linkedGoalIds: z.array(z.string().uuid()).max(100)
}).strict();

export const meetingRecordSchema: z.ZodType<MeetingRecord> = z.object({
  meetingId: z.string().uuid(),
  revision: positiveInteger,
  closedAt: timestamp,
  generatedAt: timestamp,
  generationMode: z.enum(meetingRecordGenerationModes),
  content: meetingRecordContentSchema,
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/, "Meeting Record source digest must be a SHA-256 hex digest."),
  createdBy: z.enum(meetingRecordCreatedBy)
}).strict().superRefine((record, context) => {
  if (record.content.meeting.meetingId !== record.meetingId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["content", "meeting", "meetingId"], message: "Meeting Record content must match its Meeting ID." });
  }
  if (record.content.meeting.closedAt !== record.closedAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["content", "meeting", "closedAt"], message: "Meeting Record content must match its closed timestamp." });
  }
});

export const createHumanUtteranceSchema = z.object({
  content: nonEmpty.max(20_000)
}).strict();

export const createDecisionSchema = z.object({
  meetingId: z.string().uuid(),
  title: nonEmpty.max(160),
  description: nonEmpty.max(4000)
});

export const createTaskSchema = z.object({
  decisionId: z.string().uuid(),
  title: nonEmpty.max(160),
  description: z.string().trim().max(4000).default(""),
  assignee: z.string().trim().max(100).nullable().default(null),
  assigneeAgentId: z.string().uuid().nullable().default(null),
  dueAt: z.string().datetime({ offset: true }).nullable().default(null),
  acceptanceCriteria: z.string().trim().max(4000).default(""),
  executionProfile: z.enum(taskExecutionProfiles).default("manual"),
  allowedTools: z.array(nonEmpty.max(200)).max(50).default([]),
  dataScope: z.string().trim().max(2000).default(""),
  approvalState: z.enum(taskApprovalStates).optional()
}).strict().superRefine((value, context) => {
  if (value.executionProfile === "worker") {
    if (value.approvalState && value.approvalState !== "pending") {
      context.addIssue({ code: "custom", message: "A Worker Task cannot be created as approved or rejected.", path: ["approvalState"] });
    }
    return;
  }
  if (value.approvalState && value.approvalState !== "not_required") {
    context.addIssue({ code: "custom", message: "A Manual or Advisor Task does not use approval.", path: ["approvalState"] });
  }
}).transform((value) => ({
  ...value,
  approvalState: value.executionProfile === "worker" ? "pending" as const : "not_required" as const
}));

export const updateTaskSchema = z.object({
  expectedRevision: z.number().int().positive(),
  expectedExecutionRevision: z.number().int().min(0),
  title: nonEmpty.max(160).optional(),
  description: z.string().trim().max(4000).optional(),
  assignee: z.string().trim().max(100).nullable().optional(),
  assigneeAgentId: z.string().uuid().nullable().optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  acceptanceCriteria: z.string().trim().max(4000).optional(),
  executionProfile: z.enum(taskExecutionProfiles).optional(),
  allowedTools: z.array(nonEmpty.max(200)).max(50).optional(),
  dataScope: z.string().trim().max(2000).optional()
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== "expectedRevision" && key !== "expectedExecutionRevision"),
  "At least one Task field is required"
);

export const setTaskApprovalSchema = z.object({
  expectedExecutionRevision: z.number().int().min(0),
  action: z.enum(["request", "approve", "reject"])
}).strict();

export const runTaskAgentSchema = z.object({
  expectedExecutionRevision: z.number().int().min(0)
}).strict();

export const taskSyncRequestSchema = z.object({
  adapterId: z.string().uuid(),
  expectedRevision: z.number().int().min(1),
  expectedStatus: z.enum(taskStatuses),
  expectedApprovalState: z.enum(taskApprovalStates),
  expectedSyncAttemptCount: z.number().int().min(0)
}).strict();

export const addTaskEvidenceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("url"),
    label: nonEmpty.max(160),
    reference: httpUrl.max(2000)
  }).strict(),
  z.object({
    type: z.literal("note"),
    label: nonEmpty.max(160),
    reference: nonEmpty.max(4000)
  }).strict()
]);

export const moveTaskSchema = z.object({
  status: z.enum(taskStatuses),
  position: z.number().int().min(0).max(100_000),
  expectedBoardRevision: z.number().int().positive(),
  expectedExecutionRevision: z.number().int().min(0)
}).strict();

const agentFieldSchemas = {
  name: nonEmpty.max(100),
  description: z.string().trim().max(500),
  modelConnectorId: z.string().uuid().nullable(),
  goalSummary: nonEmpty.max(1000),
  toolsSummary: nonEmpty.max(1000),
  dataSummary: nonEmpty.max(1000),
  skillIds: z.array(z.string().uuid()).max(50),
  toolGrants: z.array(z.object({ connectorId: z.string().uuid(), toolName: nonEmpty.max(200) })).max(100),
  toolPackGrants: z.array(toolPackGrantSchema).max(100),
  runtimeProfileBinding: runtimeProfileBindingSchema.nullable(),
  promptBinding: promptBindingSchema.nullable()
};

const uniqueSkillAssignments = (value: { skillIds?: string[] | undefined; toolPackGrants?: ToolPackGrant[] | undefined }, context: z.RefinementCtx) => {
  if (value.skillIds && new Set(value.skillIds).size !== value.skillIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Each Skill may be assigned only once.", path: ["skillIds"] });
  }
  if (value.toolPackGrants) {
    const grants = value.toolPackGrants.map((grant) => `${grant.packId}:${grant.revision}:${grant.manifestDigest}:${grant.toolName}`);
    if (new Set(grants).size !== grants.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Each Agent Tool Pack grant may appear only once.", path: ["toolPackGrants"] });
    }
  }
};

export const createAgentSchema = z.object({
  ...agentFieldSchemas,
  description: agentFieldSchemas.description.default(""),
  modelConnectorId: agentFieldSchemas.modelConnectorId.default(null),
  skillIds: agentFieldSchemas.skillIds.default([]),
  toolGrants: agentFieldSchemas.toolGrants.default([]),
  toolPackGrants: agentFieldSchemas.toolPackGrants.default([]),
  runtimeProfileBinding: agentFieldSchemas.runtimeProfileBinding.default(null),
  promptBinding: agentFieldSchemas.promptBinding.default(null)
}).superRefine(uniqueSkillAssignments);

export const updateAgentSchema = z.object(agentFieldSchemas).partial()
  .refine((value) => Object.keys(value).length > 0, "At least one Agent field is required")
  .superRefine(uniqueSkillAssignments);

export const updateAgentRequestSchema = z.object({
  expectedDraftRevision: z.number().int().positive()
}).and(updateAgentSchema);

export const setAgentModelSchema = z.object({
  modelConnectorId: z.string().uuid().nullable()
});

export const setAgentModelRequestSchema = setAgentModelSchema.extend({
  expectedDraftRevision: z.number().int().positive()
});

export const agentLifecycleStatusSchema = z.enum(agentLifecycleStatuses);

export const setMeetingModeSchema = z.object({
  mode: z.enum(meetingModes),
  reason: nonEmpty.max(1000),
  chairSuggestionId: z.string().uuid().optional()
});

export const setMeetingAutomationSchema = z.object({
  automation: z.enum(chairAutomationLevels),
  expectedAutomation: z.enum(chairAutomationLevels),
  expectedAutomationRevision: z.number().int().nonnegative()
}).strict();

export const switchParticipantRoleSchema = z.object({
  roleId: z.string().uuid(),
  expectedRoleRevision: z.number().int().min(1),
  reason: nonEmpty.max(500)
}).strict();

export const applyChairSuggestedRoleSchema = z.object({
  expectedRoleRevision: z.number().int().min(1)
}).strict();

export const runAgentSchema = z.object({
  agentId: z.string().uuid(),
  chairSuggestionId: z.string().uuid().optional()
}).strict();

export const runMcpToolSchema = z.object({
  agentId: z.string().uuid(),
  connectorId: z.string().uuid(),
  toolName: nonEmpty.max(200),
  arguments: mcpToolArgumentsSchema.default({})
}).strict();

export const authorizeToolSchema = z.object({
  connectorId: nonEmpty.max(100),
  toolName: nonEmpty.max(200),
  effect: z.enum(["read", "write"]),
  agentId: z.string().uuid().optional()
}).strict();

export const externalExecutionRequestSchema = z.object({
  resourceId: z.string().trim().min(1).max(200),
  inputs: externalExecutionInputsSchema
}).strict();

export const externalExecutionSchema = z.object({
  executionId: z.string().trim().min(1).max(500),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "unknown"])
}).strict();

export type ExternalExecutionRequest = z.infer<typeof externalExecutionRequestSchema>;
export type ExternalExecution = z.infer<typeof externalExecutionSchema>;

const roleFieldSchemas = {
  name: nonEmpty.max(100),
  usageContext: z.string().trim().min(1).max(1000),
  responsibility: nonEmpty.max(1000),
  speakingGuidance: nonEmpty.max(2000),
  decisionScope: nonEmpty.max(2000),
  constraints: nonEmpty.max(2000),
  toolPolicy: z.enum(roleToolPolicies),
  dataPolicy: z.enum(roleDataPolicies),
  orchestrationFunctions: z.array(z.enum(roleOrchestrationFunctions)).max(4)
};

function validateRolePolicyCombination(
  value: { toolPolicy?: RoleToolPolicy | undefined; dataPolicy?: RoleDataPolicy | undefined },
  context: z.RefinementCtx
): void {
  if (value.toolPolicy === "agent_read_only_grants" && value.dataPolicy === "meeting_only") {
    context.addIssue({
      code: "custom",
      path: ["dataPolicy"],
      message: "External tools require the Agent declared data scope."
    });
  }
}

export const createRoleSchema = z.object({
  ...roleFieldSchemas,
  usageContext: roleFieldSchemas.usageContext.optional(),
  speakingGuidance: roleFieldSchemas.speakingGuidance.default(defaultRoleBehavior.speakingGuidance),
  decisionScope: roleFieldSchemas.decisionScope.default(defaultRoleBehavior.decisionScope),
  constraints: roleFieldSchemas.constraints.default(defaultRoleBehavior.constraints),
  templateKey: z.enum(roleTemplateKeys).nullable().default(null),
  toolPolicy: roleFieldSchemas.toolPolicy.default("none"),
  dataPolicy: roleFieldSchemas.dataPolicy.default("meeting_only"),
  orchestrationFunctions: roleFieldSchemas.orchestrationFunctions.default([])
}).strict().superRefine(validateRolePolicyCombination).transform((value) => ({
  ...value,
  usageContext: resolveRoleUsageContext(value)
}));

export const updateRoleSchema = z.object(roleFieldSchemas).partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  "At least one Role field is required"
).superRefine(validateRolePolicyCombination);

export const updateRoleRequestSchema = z.object({
  name: roleFieldSchemas.name.optional(),
  usageContext: roleFieldSchemas.usageContext.optional(),
  responsibility: roleFieldSchemas.responsibility.optional(),
  speakingGuidance: roleFieldSchemas.speakingGuidance.optional(),
  decisionScope: roleFieldSchemas.decisionScope.optional(),
  constraints: roleFieldSchemas.constraints.optional(),
  toolPolicy: roleFieldSchemas.toolPolicy.optional(),
  dataPolicy: roleFieldSchemas.dataPolicy.optional(),
  orchestrationFunctions: roleFieldSchemas.orchestrationFunctions.optional(),
  expectedCurrentVersion: z.number().int().positive()
}).strict().refine(
  (value) => Object.keys(value).some((field) => field !== "expectedCurrentVersion"),
  "At least one Role field is required"
).superRefine(validateRolePolicyCombination);

export const rollbackRoleSchema = z.object({
  version: z.number().int().positive(),
  expectedCurrentVersion: z.number().int().positive()
}).strict();

export const deleteRoleSchema = z.object({
  expectedCurrentVersion: z.number().int().positive()
}).strict();

export const roleVersionSchema = z.object({
  roleId: z.string().uuid(),
  version: z.number().int().positive(),
  ...roleFieldSchemas,
  orchestrationFunctions: roleFieldSchemas.orchestrationFunctions.default([]),
  templateKey: z.enum(roleTemplateKeys).nullable(),
  source: z.enum(["created", "updated", "rollback", "legacy_backfilled"]),
  restoredFromVersion: z.number().int().positive().nullable(),
  recordedAt: z.string().datetime({ offset: true })
}).strict().superRefine(validateRolePolicyCombination);

export const createSkillSchema = z.object({
  name: nonEmpty.max(100),
  version: z.string().trim().regex(/^\d+\.\d+\.\d+$/),
  instructions: nonEmpty.max(20_000),
  source: nonEmpty.max(500),
  owner: nonEmpty.max(200)
}).strict();

export const setSkillStatusSchema = z.object({
  status: z.enum(["draft", "approved"]),
  expectedCheckedAt: timestamp.nullable()
}).strict();

export const validateSkillSchema = z.object({
  result: z.enum(["passed", "failed"]),
  summary: nonEmpty.max(2_000),
  expectedCheckedAt: timestamp.nullable()
}).strict();

export const revokeSkillSchema = z.object({
  reason: nonEmpty.max(1_000)
}).strict();

export const createModelConnectorSchema = z.object({
  name: nonEmpty.max(100),
  location: z.enum(["cloud", "local"]),
  baseUrl: httpUrl,
  model: nonEmpty.max(200),
  credentialId: z.string().uuid().nullable().optional(),
  apiKey: z.string().trim().max(2000).optional()
}).refine(
  (value) => !(value.credentialId && value.apiKey),
  { message: "Rotate an existing Credential through the Credential lifecycle before binding it.", path: ["apiKey"] }
);

export const updateModelConnectorSchema = z.object({
  expectedRevision: z.number().int().positive(),
  name: nonEmpty.max(100).optional(),
  location: z.enum(["cloud", "local"]).optional(),
  baseUrl: httpUrl.optional(),
  model: nonEmpty.max(200).optional(),
  credentialId: z.string().uuid().nullable().optional(),
  enabled: z.boolean().optional()
}).strict().refine(
  (value) => Object.keys(value).some((field) => field !== "expectedRevision"),
  "At least one Model Connector field is required"
);

const approvedMcpToolsSchema = z.array(nonEmpty.max(200)).max(100).transform((items) => [...new Set(items)]);

export const toolRegistrationSchema = z.object({
  toolName: nonEmpty.max(200),
  displayName: nonEmpty.max(200),
  kind: z.enum(toolRegistrationKinds),
  version: nonEmpty.max(100),
  owner: nonEmpty.max(200),
  goal: nonEmpty.max(2_000)
}).strict();

const toolRegistrationsSchema = z.array(toolRegistrationSchema).max(100);

function validateToolRegistrations(
  value: { approvedTools?: string[] | undefined; toolRegistrations?: ToolRegistration[] | undefined },
  context: z.RefinementCtx
): void {
  if (!value.toolRegistrations) return;
  const seen = new Set<string>();
  for (const [index, registration] of value.toolRegistrations.entries()) {
    if (seen.has(registration.toolName)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Each MCP tool may be registered only once.",
        path: ["toolRegistrations", index, "toolName"]
      });
    }
    seen.add(registration.toolName);
    if (value.approvedTools && !value.approvedTools.includes(registration.toolName)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Tool Catalog entries must belong to the approved MCP allowlist.",
        path: ["toolRegistrations", index, "toolName"]
      });
    }
  }
}

export const createMcpConnectorSchema = z.object({
  name: nonEmpty.max(100),
  location: z.enum(["cloud", "local"]).default("cloud"),
  baseUrl: httpUrl,
  approvedTools: approvedMcpToolsSchema,
  toolRegistrations: toolRegistrationsSchema.default([]),
  bearerToken: nonEmpty.max(4000).optional()
}).strict().superRefine(validateToolRegistrations);

export const updateMcpConnectorSchema = z.object({
  expectedRevision: z.number().int().positive(),
  name: nonEmpty.max(100).optional(),
  location: z.enum(["cloud", "local"]).optional(),
  baseUrl: httpUrl.optional(),
  approvedTools: approvedMcpToolsSchema.optional(),
  toolRegistrations: toolRegistrationsSchema.optional(),
  enabled: z.boolean().optional(),
  bearerToken: nonEmpty.max(4000).optional()
}).strict().superRefine(validateToolRegistrations).refine(
  (value) => Object.keys(value).some((field) => field !== "expectedRevision"),
  "At least one MCP Connector field is required"
);

export const createTaskAdapterConnectorSchema = z.object({
  name: nonEmpty.max(100),
  location: z.enum(["cloud", "local"]),
  baseUrl: httpUrl,
  bearerToken: z.string().trim().max(4000).optional()
}).strict().refine((value) => {
  const url = new URL(value.baseUrl);
  return url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
}, { message: "Task Adapter Base URL must be an HTTP(S) origin without credentials, path, query, or fragment", path: ["baseUrl"] });

export const taskAdapterUpsertPayloadSchema = z.object({
  taskId: z.string().uuid(),
  meetingId: z.string().uuid(),
  decisionId: z.string().uuid(),
  title: nonEmpty.max(160),
  description: z.string().max(4000),
  status: z.enum(taskStatuses),
  assignee: z.string().max(100).nullable(),
  dueAt: z.string().datetime({ offset: true }).nullable(),
  acceptanceCriteria: z.string().max(4000),
  executionProfile: z.enum(taskExecutionProfiles),
  allowedTools: z.array(nonEmpty.max(200)).max(50),
  dataScope: z.string().max(2000),
  approvalState: z.enum(taskApprovalStates)
}).strict();

export const taskAdapterUpsertResponseSchema = z.object({
  externalId: nonEmpty.max(200)
}).strict();

export const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(12).max(256)
});

export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type CreateTagInput = z.infer<typeof createTagSchema>;
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type UpdateTagInput = z.infer<typeof updateTagSchema>;
export type CreateThreadInput = z.infer<typeof createThreadSchema>;
export type UpdateThreadInput = z.infer<typeof updateThreadSchema>;
export type CreateMeetingInput = Omit<z.infer<typeof createMeetingSchema>, "automation"> & {
  automation?: ChairAutomationLevel;
};
export type SetMeetingAgendaInput = z.infer<typeof setMeetingAgendaSchema>;
export type AdvanceMeetingAgendaInput = z.infer<typeof advanceMeetingAgendaSchema>;
export type CreateUtteranceInput = z.infer<typeof createUtteranceSchema>;
export type CreateHumanUtteranceInput = z.infer<typeof createHumanUtteranceSchema>;
export type CreateDecisionInput = z.infer<typeof createDecisionSchema>;
export type CreateTaskInput = z.input<typeof createTaskSchema>;
export type MoveTaskInput = z.infer<typeof moveTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type SetTaskApprovalInput = z.infer<typeof setTaskApprovalSchema>;
export type RunTaskAgentInput = z.infer<typeof runTaskAgentSchema>;
export type TaskSyncRequestInput = z.infer<typeof taskSyncRequestSchema>;
export type AddTaskEvidenceInput = z.infer<typeof addTaskEvidenceSchema>;
export type CreateAgentInput = Omit<z.infer<typeof createAgentSchema>, "toolPackGrants"> & {
  toolPackGrants?: ToolPackGrant[];
};
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;
export type UpdateAgentRequestInput = z.infer<typeof updateAgentRequestSchema>;
export type CreateRoleInput = z.input<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
export type UpdateRoleRequestInput = z.infer<typeof updateRoleRequestSchema>;
export type RollbackRoleInput = z.infer<typeof rollbackRoleSchema>;
export type DeleteRoleInput = z.infer<typeof deleteRoleSchema>;
export type CreateSkillInput = z.infer<typeof createSkillSchema>;
export type SetSkillStatusInput = z.infer<typeof setSkillStatusSchema>;
export type ValidateSkillInput = z.infer<typeof validateSkillSchema>;
export type RevokeSkillInput = z.infer<typeof revokeSkillSchema>;
export type CreateModelConnectorInput = z.infer<typeof createModelConnectorSchema>;
export type UpdateModelConnectorInput = z.infer<typeof updateModelConnectorSchema>;
export type CreateMcpConnectorInput = z.input<typeof createMcpConnectorSchema>;
export type UpdateMcpConnectorInput = z.input<typeof updateMcpConnectorSchema>;
export type CreateTaskAdapterConnectorInput = z.infer<typeof createTaskAdapterConnectorSchema>;
export type TaskAdapterUpsertPayload = z.infer<typeof taskAdapterUpsertPayloadSchema>;
export type TaskAdapterUpsertResponse = z.infer<typeof taskAdapterUpsertResponseSchema>;
export type SetAgentModelInput = z.infer<typeof setAgentModelSchema>;
export type SetAgentModelRequestInput = z.infer<typeof setAgentModelRequestSchema>;
export type SetMeetingModeInput = z.infer<typeof setMeetingModeSchema>;
export type SetMeetingAutomationInput = z.infer<typeof setMeetingAutomationSchema>;
export type SwitchParticipantRoleInput = z.infer<typeof switchParticipantRoleSchema>;
export type ApplyChairSuggestedRoleInput = z.infer<typeof applyChairSuggestedRoleSchema>;
export type RunAgentInput = z.infer<typeof runAgentSchema>;
export type RunMcpToolInput = z.infer<typeof runMcpToolSchema>;
export type AuthorizeToolInput = z.infer<typeof authorizeToolSchema>;
export type CreateCredentialInput = z.infer<typeof createCredentialSchema>;
export type UpdateCredentialInput = z.infer<typeof updateCredentialSchema>;
export type RotateCredentialInput = z.infer<typeof rotateCredentialSchema>;
export type UpdateCredentialStatusInput = z.infer<typeof updateCredentialStatusSchema>;
export type CreatePromptInput = z.infer<typeof createPromptSchema>;
export type UpdatePromptInput = z.infer<typeof updatePromptSchema>;
export type PublishPromptInput = z.infer<typeof publishPromptSchema>;
export type RollbackPromptInput = z.infer<typeof rollbackPromptSchema>;
export type ArchivePromptInput = z.infer<typeof archivePromptSchema>;
export type PromptPreviewRequestInput = z.infer<typeof promptPreviewRequestSchema>;
export type PublishAgentInput = z.infer<typeof publishAgentSchema>;
export type RollbackAgentInput = z.infer<typeof rollbackAgentSchema>;
export type SetAgentStatusInput = z.infer<typeof setAgentStatusSchema>;
export type CreateAgentTeamInput = z.infer<typeof createAgentTeamSchema>;
export type UpdateAgentTeamInput = z.infer<typeof updateAgentTeamSchema>;
export type CreateMeetingPresetInput = z.infer<typeof createMeetingPresetSchema>;
export type UpdateMeetingPresetInput = z.infer<typeof updateMeetingPresetSchema>;
