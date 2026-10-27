import { createHash } from "node:crypto";
import type {
  AddTaskEvidenceInput,
  ApproveToolPackInput,
  ApplyChairSuggestedRoleInput,
  AdvanceMeetingAgendaInput,
  Agent,
  AgentReadiness,
  AgentRevision,
  AgentTeam,
  AgentTurnJobData,
  Category,
  ChairAutomationJobAdmission,
  ChairAutomationJobReconciliationReason,
  ChairSuggestion,
  ChairSuggestionRecord,
  ChairAutomationLevel,
  CreateAgentInput,
  CreateAgentTeamInput,
  CreateCategoryInput,
  CreateCredentialInput,
  CreateDecisionInput,
  CreateGroupInput,
  CreateMcpConnectorInput,
  CreateMeetingInput,
  CreateMeetingPresetInput,
  CreateModelConnectorInput,
  CreatePromptInput,
  CreateRoleInput,
  CreateRuntimeProfileInput,
  CreateSkillInput,
  CreateTagInput,
  CreateToolPackInput,
  UpdateCategoryInput,
  UpdateGroupInput,
  UpdateThreadInput,
  UpdateTagInput,
  CreateTaskAdapterConnectorInput,
  CreateTaskInput,
  CreateThreadInput,
  CreateUtteranceInput,
  Credential,
  Decision,
  DiscussionGroup,
  DiscussionThread,
  ExecutionContract,
  GoalEvent,
  GoalEventType,
  GoalPlanTask,
  GoalPlanRevision,
  GoalPlannerProvenance,
  GoalReviewJobData,
  GoalRun,
  GoalRunState,
  GoalTaskBinding,
  GoalTaskState,
  RoleExecutionSnapshot,
  ReviewerVerdict,
  ActionAdapter,
  ActionRun,
  ActionRunState,
  McpConnector,
  Meeting,
  MeetingRecord,
  MeetingSummaryState,
  MeetingState,
  McpToolCallJobData,
  McpToolRun,
  MeetingViewSnapshot,
  McpConnectorUpdateResult,
  ModelConnector,
  ModelConnectorUpdateResult,
  MeetingPreset,
  MoveTaskInput,
  ParticipantAssignment,
  ParticipantRoleBinding,
  PlatformSnapshot,
  PlatformViewName,
  PromptTemplate,
  PromptVersion,
  Role,
  RoleDeletionResult,
  RoleLifecycleView,
  RoleVersion,
  RuntimeProfile,
  RuntimeProfileRevision,
  RuntimeRun,
  RuntimeRunEvent,
  RuntimeRunState,
  Skill,
  SetAgentModelInput,
  SetMeetingAgendaInput,
  SetMeetingAutomationInput,
  SetMeetingModeInput,
  SetTaskApprovalInput,
  SpeakerQueueItem,
  SetSkillStatusInput,
  SkillRevocationResult,
  Task,
  TaskAdapterUpsertPayload,
  TaskAgentRunJobData,
  TaskSyncRequestInput,
  TaskAdapterConnector,
  Tag,
  ToolRegistrationSnapshot,
  ToolPack,
  ToolPackRevision,
  UpdateAgentInput,
  UpdateAgentTeamInput,
  UpdateCredentialInput,
  UpdateMcpConnectorInput,
  UpdateMeetingPresetInput,
  UpdateModelConnectorInput,
  UpdatePromptInput,
  UpdateRoleInput,
  UpdateTaskInput,
  UpdateToolPackInput,
  SwitchParticipantRoleInput,
  ValidateSkillInput,
  ValidateToolPackInput,
  RevokeSkillInput,
  RevokeToolPackInput,
  Utterance
} from "@council/contracts";
import { goalPlannerProvenanceSchema, goalReviewJobDataSchema } from "@council/contracts";
import type { ExternalExecution, ExternalExecutionRequest, RuntimeRunMutation, SecretVault } from "@council/domain";
import type {
  ArchivePromptInput,
  PublishAgentInput,
  PublishPromptInput,
  RollbackAgentInput,
  RollbackPromptInput,
  RotateCredentialInput,
  SetAgentStatusInput,
  UpdateCredentialStatusInput,
  UpdateRuntimeProfileInput
} from "@council/contracts";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

export function requestFingerprint(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value)) ?? "undefined";
  return createHash("sha256").update(serialized).digest("hex");
}

export function goalReviewRequestFingerprint(data: GoalReviewJobData): string {
  return `v2:${requestFingerprint(data)}`;
}

export function assertGoalReviewJobAdmission(
  admission: GoalJobAdmission,
  data: GoalReviewJobData
): GoalReviewJobData {
  const parsed = goalReviewJobDataSchema.parse(data);
  const expectedEntityId = `${parsed.scope}:${parsed.scopeId}:${parsed.reviewerAgentId}`;
  if (admission.goalRunId !== parsed.goalRunId
    || admission.jobName !== "goal-review"
    || admission.entityId !== expectedEntityId
    || admission.requestFingerprint !== goalReviewRequestFingerprint(parsed)) {
    throw new StoreConflictError("Goal Review job admission does not match its immutable binding.");
  }
  return parsed;
}

export function goalRunCreateIdempotencyInput(
  run: GoalRun,
  event: AppendGoalEventInput
): Record<string, unknown> {
  return {
    title: run.title,
    goal: run.goal,
    threadId: run.threadId,
    meetingId: run.meetingId,
    state: run.state,
    limits: run.limits,
    createdBy: run.createdBy,
    event: {
      type: event.type,
      actorType: event.actorType,
      actorId: event.actorId,
      entityType: event.entityType,
      summary: event.summary,
      detail: event.detail ?? {}
    }
  };
}

export function goalPlanTaskCreateInput(task: GoalPlanTask): CreateTaskInput {
  return {
    decisionId: task.decisionId,
    title: task.title,
    description: task.description,
    assignee: null,
    assigneeAgentId: task.assigneeAgentId,
    dueAt: null,
    acceptanceCriteria: task.acceptanceCriteria,
    executionProfile: task.executionMode === "action" ? "manual" : task.executionMode,
    allowedTools: task.allowedTools,
    dataScope: task.dataScope
  };
}

export function canonicalTaskMatchesPlan(task: Task, planTask: GoalPlanTask): boolean {
  const expected = goalPlanTaskCreateInput(planTask);
  return task.decisionId === expected.decisionId
    && task.title === expected.title
    && task.description === expected.description
    && task.assigneeAgentId === expected.assigneeAgentId
    && task.dueAt === expected.dueAt
    && task.acceptanceCriteria === expected.acceptanceCriteria
    && task.executionProfile === expected.executionProfile
    && JSON.stringify(task.allowedTools) === JSON.stringify(expected.allowedTools)
    && task.dataScope === expected.dataScope;
}

export function assertGoalPlanDecisionBindings(
  run: Pick<GoalRun, "meetingId">,
  plan: Pick<GoalPlanRevision, "tasks">,
  snapshot: Pick<PlatformSnapshot, "decisions" | "tasks" | "agents">
): void {
  for (const planTask of plan.tasks) {
    const decision = snapshot.decisions.find((candidate) => candidate.id === planTask.decisionId);
    if (!decision || decision.meetingId !== run.meetingId) {
      throw new StoreConflictError(
        "Every Goal Plan task must reference a Decision from the Goal's formal Meeting.",
        "business_rule",
        "GOAL_DECISION_BINDING_INVALID"
      );
    }
    if (decision.status === "rejected") {
      throw new StoreConflictError(
        "A rejected Meeting Decision cannot enter a Goal Plan.",
        "business_rule",
        "GOAL_DECISION_REJECTED"
      );
    }
    if (planTask.assigneeAgentId && !snapshot.agents.some((agent) => agent.id === planTask.assigneeAgentId)) {
      throw new StoreConflictError(
        "Goal Plan task assignee is not a registered Agent.",
        "business_rule",
        "GOAL_ASSIGNEE_INVALID"
      );
    }
    const existingTasks = snapshot.tasks.filter((task) => task.decisionId === decision.id);
    if (existingTasks.length > 1) {
      throw new StoreConflictError("A formal Meeting Decision has more than one canonical Task.");
    }
    if (existingTasks[0] && !canonicalTaskMatchesPlan(existingTasks[0], planTask)) {
      throw new StoreConflictError(
        "The Goal Plan no longer matches the canonical Task created from its Decision.",
        "revision",
        "GOAL_CANONICAL_TASK_CONFLICT"
      );
    }
  }
}

export function assertExecutionActionBindings(contract: ExecutionContract): void {
  const actionTasks = contract.planSnapshot.filter((task) => task.executionMode === "action");
  if (contract.actionBindings.length !== actionTasks.length
    || new Set(contract.actionBindings.map((binding) => binding.planTaskId)).size !== actionTasks.length) {
    throw new StoreConflictError(
      "Every Action task must pin exactly one Adapter identity in the Execution Contract.",
      "business_rule",
      "ACTION_CONTRACT_BINDING_INVALID"
    );
  }
  for (const task of actionTasks) {
    const binding = contract.actionBindings.find((candidate) => candidate.planTaskId === task.id);
    if (!binding || binding.adapterId !== task.action?.adapterId) {
      throw new StoreConflictError(
        "Execution Contract Action binding does not match the approved Plan.",
        "business_rule",
        "ACTION_CONTRACT_BINDING_INVALID"
      );
    }
  }
}

export const externalExecutionStartOperation = "external_execution.start";

export type ExternalExecutionStartRequest = Pick<ExternalExecutionRequest, "resourceId" | "inputs">;

export type ExternalExecutionStartAdmission =
  | { status: "reserved"; reservationId: string }
  | { status: "pending"; reservationId: string }
  | { status: "settled"; reservationId: string; execution: ExternalExecution };

export type ExternalExecutionStartEnvelope =
  | { state: "reserved"; reservationId: string }
  | { state: "settled"; reservationId: string; execution: ExternalExecution };

export function externalExecutionStartFingerprint(input: ExternalExecutionStartRequest): string {
  return requestFingerprint({ resourceId: input.resourceId, inputs: input.inputs });
}

export function parseExternalExecutionStartEnvelope(value: unknown): ExternalExecutionStartEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (typeof envelope.reservationId !== "string" || envelope.reservationId.length === 0) return null;
  if (envelope.state === "reserved") {
    return { state: "reserved", reservationId: envelope.reservationId };
  }
  if (envelope.state !== "settled" || !envelope.execution || typeof envelope.execution !== "object" || Array.isArray(envelope.execution)) {
    return null;
  }
  const execution = envelope.execution as Record<string, unknown>;
  const statuses: ReadonlySet<ExternalExecution["status"]> = new Set([
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "unknown"
  ]);
  if (typeof execution.executionId !== "string"
    || execution.executionId.length === 0
    || typeof execution.status !== "string"
    || !statuses.has(execution.status as ExternalExecution["status"])
    || (execution.evidence !== undefined
      && (!execution.evidence || typeof execution.evidence !== "object" || Array.isArray(execution.evidence)))) {
    return null;
  }
  return {
    state: "settled",
    reservationId: envelope.reservationId,
    execution: structuredClone(execution as unknown as ExternalExecution)
  };
}

export function isMeetingSummaryUtterance(meetingId: string, input: CreateUtteranceInput): boolean {
  return input.speakerType === "system"
    && input.kind === "system"
    && input.agentId === undefined
    && input.turnId === `meeting-summary:${meetingId}`;
}

export function utteranceReplayMatches(
  meetingId: string,
  existing: Utterance,
  input: CreateUtteranceInput
): boolean {
  const canonicalSummaryReplay = isMeetingSummaryUtterance(meetingId, existing)
    && isMeetingSummaryUtterance(meetingId, input);
  return existing.meetingId === meetingId
    && existing.turnId === input.turnId
    && existing.agentId === input.agentId
    && existing.speakerType === input.speakerType
    && existing.speakerName === input.speakerName
    && existing.roleName === input.roleName
    && (canonicalSummaryReplay || existing.content === input.content)
    && existing.kind === input.kind
    && existing.evidenceCount === input.evidenceCount;
}

export type UtteranceCreateResult =
  | { status: "created"; utterance: Utterance }
  | { status: "existing"; utterance: Utterance };

export function taskExecutionFingerprint(task: Task): string {
  return requestFingerprint({
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    assignee: task.assignee,
    assigneeAgentId: task.assigneeAgentId,
    acceptanceCriteria: task.acceptanceCriteria,
    executionProfile: task.executionProfile,
    allowedTools: task.allowedTools,
    dataScope: task.dataScope,
    approvalState: task.approvalState
  });
}

const taskMutableFields = [
  "title",
  "description",
  "assignee",
  "assigneeAgentId",
  "dueAt",
  "acceptanceCriteria",
  "executionProfile",
  "allowedTools",
  "dataScope"
] as const;

export type TaskMutableField = (typeof taskMutableFields)[number];

export function taskChangedFields(before: Task, after: Task): TaskMutableField[] {
  return taskMutableFields
    .filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
    .sort();
}

export function taskAdapterUpsertPayload(task: Task): TaskAdapterUpsertPayload {
  return {
    taskId: task.id,
    meetingId: task.meetingId,
    decisionId: task.decisionId,
    title: task.title,
    description: task.description,
    status: task.status,
    assignee: task.assignee,
    dueAt: task.dueAt,
    acceptanceCriteria: task.acceptanceCriteria,
    executionProfile: task.executionProfile,
    allowedTools: task.allowedTools,
    dataScope: task.dataScope,
    approvalState: task.approvalState
  };
}

export function taskSyncRequestFingerprint(task: Task): string {
  return requestFingerprint(taskAdapterUpsertPayload(task));
}

export function taskSyncAdmissionInput(task: Task, adapterId: string): TaskSyncRequestInput {
  return {
    adapterId,
    expectedRevision: task.revision,
    expectedStatus: task.status,
    expectedApprovalState: task.approvalState,
    expectedSyncAttemptCount: task.sync.attemptCount
  };
}

export const taskAgentAdmissionLeaseMs = 5 * 60_000;

export function taskAgentAdmissionLeaseActive(
  execution: Pick<Task["execution"], "status" | "requestedAt">,
  now = Date.now()
): boolean {
  if (execution.status !== "queued" || !execution.requestedAt) return false;
  const requestedAt = Date.parse(execution.requestedAt);
  return Number.isFinite(requestedAt) && requestedAt + taskAgentAdmissionLeaseMs > now;
}

export function mcpConnectorExecutionFingerprint(connector: McpConnector, ciphertext: string | null): string {
  return requestFingerprint({
    id: connector.id,
    name: connector.name,
    location: connector.location,
    baseUrl: connector.baseUrl,
    approvedTools: connector.approvedTools,
    toolRegistrations: connector.toolRegistrations,
    enabled: connector.enabled,
    hasSecret: connector.hasSecret,
    secretRevision: connector.secretRevision ?? (connector.hasSecret ? 1 : 0),
    secretCiphertext: ciphertext
  });
}

export type McpToolRequestFingerprintInput = Pick<
  McpToolCallJobData,
  "meetingId" | "agentId" | "connectorId" | "toolName"
> & {
  arguments: Record<string, unknown>;
  participantId: ParticipantRoleBinding["participantId"] | undefined;
  roleRevision: ParticipantRoleBinding["roleRevision"] | undefined;
  roleId: ParticipantRoleBinding["roleId"] | undefined;
  roleVersion: ParticipantRoleBinding["roleVersion"] | undefined;
};

export function mcpToolRequestFingerprint(input: McpToolRequestFingerprintInput, vault?: SecretVault): string {
  const digest = requestFingerprint({
    meetingId: input.meetingId,
    agentId: input.agentId,
    participantId: input.participantId,
    roleRevision: input.roleRevision,
    roleId: input.roleId,
    roleVersion: input.roleVersion,
    connectorId: input.connectorId,
    toolName: input.toolName,
    arguments: input.arguments
  });
  return vault ? vault.fingerprint("mcp-tool-request-v1", digest) : digest;
}

export interface McpToolCallReservationInput extends ParticipantRoleBinding {
  meetingId: string;
  agentId: string;
  connectorId: string;
  toolName: string;
  toolSnapshot: ToolRegistrationSnapshot;
  connectorFingerprint: string;
  requestFingerprint: string;
}

export interface McpToolCallAdmissionInput extends McpToolCallReservationInput {
  acceptedRequestFingerprints: readonly string[];
}

export type McpToolCallAdmissionResult =
  | { status: "existing_run"; run: McpToolRun; reservation: SpeakerQueueItem | null; clearedReservation: boolean }
  | { status: "existing_reservation" | "reserved"; run: null; reservation: SpeakerQueueItem; clearedReservation: false };

export interface OwnerUser {
  id: string;
  email: string;
  passwordHash: string;
}

export interface SessionRecord {
  userId: string;
  tokenHash: string;
  expiresAt: string;
}

export interface SecretInput {
  ciphertext?: string;
  idempotencyProof?: string;
}

export type CreateCredentialMetadataInput = Omit<CreateCredentialInput, "secret">;
export type UpdateCredentialMetadataInput = Omit<UpdateCredentialInput, "secret">;
export type RotateCredentialMetadataInput = Omit<RotateCredentialInput, "secret">;

export type CreateModelConnectorStateInput = Omit<CreateModelConnectorInput, "apiKey">;
export type CreateMcpConnectorStateInput = Omit<CreateMcpConnectorInput, "bearerToken">;
export type CreateTaskAdapterConnectorStateInput = Omit<CreateTaskAdapterConnectorInput, "bearerToken">;
export type UpdateMcpConnectorStateInput = Omit<UpdateMcpConnectorInput, "bearerToken">;
export type UpdateModelConnectorStateInput = Omit<UpdateModelConnectorInput, "apiKey">;

export interface AgentTurnExecutionBinding {
  agentRevision: Exclude<AgentTurnJobData["agentRevision"], undefined>;
  promptBinding: Exclude<AgentTurnJobData["promptBinding"], undefined>;
  credentialBinding?: Exclude<AgentTurnJobData["credentialBinding"], undefined>;
  runtimeProfileBinding: Exclude<AgentTurnJobData["runtimeProfileBinding"], undefined>;
  runtimeProfileSnapshot: Exclude<AgentTurnJobData["runtimeProfileSnapshot"], undefined>;
}

export interface AgentTurnCommitInput extends ParticipantRoleBinding {
  meetingId: string;
  agentId: string;
  turnId: string;
  reservationId?: string;
  agendaRevision: number;
  chairSuggestionId?: string;
  automationRevision?: number;
  requestedBy?: "owner" | "system";
  speakerName: string;
  roleName: string;
  content: string;
  modelConnectorId?: string;
  modelConnectorSnapshot?: Pick<ModelConnector, "id" | "location" | "baseUrl" | "model" | "enabled" | "secretRevision">;
  skillDigests?: Record<string, string>;
  executionBinding?: AgentTurnExecutionBinding;
  auditDetail: Record<string, unknown>;
  reservationRequired?: boolean;
}

export type AgentTurnCommitResult =
  | { status: "created" | "existing"; utterance: Utterance; chairSuggestion: ChairSuggestionRecord | null }
  | { status: "stale"; utterance: null; chairSuggestion: null };

export interface AgentTurnFailureCommitInput {
  meetingId: string;
  jobId: string;
  reservationId?: string;
  content: string;
  classification: string;
}

export type AgentTurnFailureCommitResult =
  | { status: "created" | "existing"; meeting: Meeting; utterance: Utterance; meetingPaused: boolean }
  | { status: "stale"; meeting: Meeting; utterance: null; meetingPaused: false };

export interface MeetingSummaryCommitInput {
  meetingId: string;
  jobId: string;
  utterance: CreateUtteranceInput;
  record?: MeetingRecord;
  auditDetail: Record<string, unknown>;
}

export type MeetingSummaryCommitResult =
  | { status: "created" | "existing"; meeting: Meeting; utterance: Utterance; record: MeetingRecord | null }
  | { status: "stale"; meeting: Meeting; utterance: null; record: null };

export interface MeetingUtterancePageInput {
  cursor: string | null;
  limit: number;
}

export interface MeetingUtterancePage {
  items: Utterance[];
  nextCursor: string | null;
}

export interface McpToolRunCommitInput extends ParticipantRoleBinding {
  jobId: string;
  requestFingerprint: string;
  meetingId: string;
  agentId: string;
  connectorId: string;
  toolName: string;
  toolSnapshot: ToolRegistrationSnapshot;
  status: "succeeded" | "failed";
  content: string;
  connectorFingerprint?: string;
  reservationRequired?: boolean;
}

export type McpToolRunCommitResult =
  | { status: "created" | "existing"; run: McpToolRun; utterance: Utterance; meetingPaused: boolean }
  | { status: "stale"; run: null; utterance: null; meetingPaused: false };

export interface ChairSuggestionCreateResult {
  status: "created" | "existing";
  suggestion: ChairSuggestionRecord;
  supersededSuggestionIds: string[];
}

export interface ChairAutomationJobAdmissionMutationResult {
  status: "updated" | "unchanged";
  admission: ChairAutomationJobAdmission | null;
}

export interface ChairSuggestionPolicyBinding {
  automation: ChairAutomationLevel;
  automationRevision: number;
}

export interface ApplyChairAutomationInput {
  meetingId: string;
  chairSuggestionId: string;
  sourceUtteranceId: string;
  automationRevision: number;
  agentTurnJobId?: string;
  modelConnectorBinding?: AgentTurnJobData["modelConnectorBinding"];
  agentRevision?: AgentTurnJobData["agentRevision"];
  promptBinding?: AgentTurnJobData["promptBinding"];
  credentialBinding?: AgentTurnJobData["credentialBinding"];
  skillDigests?: AgentTurnJobData["skillDigests"];
  runtimeProfileBinding?: AgentTurnJobData["runtimeProfileBinding"];
  runtimeProfileSnapshot?: AgentTurnJobData["runtimeProfileSnapshot"];
  runtimeRun?: AgentTurnJobData["runtimeRun"];
}

export type ApplyChairAutomationResult =
  | {
      status: "stale";
      meeting: null;
      suggestion: null;
      queueItem: null;
      agentTurnJob: null;
    }
  | {
      status: "applied";
      meeting: Meeting;
      suggestion: ChairSuggestionRecord;
      queueItem: SpeakerQueueItem | null;
      agentTurnJob: AgentTurnJobData | null;
    };

export interface ChairSuggestionMutationResult {
  status: "updated" | "unchanged";
  suggestion: ChairSuggestionRecord;
}

export interface ChairSuggestionRoleApplyResult {
  participant: ParticipantAssignment;
  suggestion: ChairSuggestionRecord;
}

export interface TaskSyncMutationResult {
  status: "updated" | "unchanged" | "stale";
  task: Task;
}

export interface TaskExecutionMutationResult {
  status: "updated" | "unchanged" | "stale";
  task: Task;
}

export type TaskAgentRunFailureBinding = Pick<
  TaskAgentRunJobData,
  "taskId" | "agentId" | "executionProfile" | "executionRevision" | "requestFingerprint"
> & {
  jobId: string;
};

export interface TaskSyncFailureBinding {
  taskId: string;
  adapterId: string;
  jobId: string;
  requestFingerprint: string;
}

export interface TaskAgentCompletionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface MeetingModeChangeResult {
  meeting: Meeting;
  chairSuggestion: ChairSuggestionRecord | null;
  resolvedSuggestionIds: string[];
}

export interface GoalRunDetail {
  goalRun: GoalRun;
  plans: GoalPlanRevision[];
  executionContract: ExecutionContract | null;
  taskBindings: GoalTaskBinding[];
  events: GoalEvent[];
  reviewerVerdicts: ReviewerVerdict[];
  actionRuns: ActionRun[];
  runtimeRuns?: RuntimeRun[];
}

export const goalCancellationTaskStates = [
  "waiting",
  "ready",
  "running",
  "reviewing",
  "blocked"
] as const satisfies readonly GoalTaskState[];

export const goalCancellationActionStates = [
  "draft",
  "awaiting_review",
  "approved",
  "reserved"
] as const satisfies readonly ActionRunState[];

export const goalCancellationBlockingActionStates = [
  "running",
  "outcome_unknown"
] as const satisfies readonly ActionRunState[];

export function roleExecutionSnapshotDigest(snapshot: RoleExecutionSnapshot): string {
  return requestFingerprint({
    roleId: snapshot.roleId,
    name: snapshot.name,
    usageContext: snapshot.usageContext,
    responsibility: snapshot.responsibility,
    speakingGuidance: snapshot.speakingGuidance,
    decisionScope: snapshot.decisionScope,
    constraints: snapshot.constraints,
    version: snapshot.version,
    templateKey: snapshot.templateKey,
    toolPolicy: snapshot.toolPolicy,
    dataPolicy: snapshot.dataPolicy,
    orchestrationFunctions: snapshot.orchestrationFunctions,
    source: snapshot.source
  });
}

export function assertGoalPlannerProvenance(
  run: Pick<GoalRun, "meetingId">,
  provenance: GoalPlannerProvenance,
  snapshot: Pick<PlatformSnapshot, "participants">
): void {
  const participant = snapshot.participants.find((candidate) => candidate.id === provenance.plannerParticipantId);
  if (!participant
    || participant.meetingId !== run.meetingId
    || participant.agentId !== provenance.plannerAgentId
    || participant.agentRevision !== provenance.plannerAgentRevision) {
    throw new StoreConflictError("Planner provenance does not match a canonical Meeting participant.");
  }
  const roleHistory = participant.roleHistory.find((entry) => entry.revision === provenance.plannerRoleRevision);
  if (!roleHistory
    || roleHistory.roleId !== provenance.plannerRoleId
    || !roleHistory.roleSnapshot.orchestrationFunctions.includes("planner")) {
    throw new StoreConflictError("Planner provenance does not retain a historical Planner capability.");
  }
  if (roleExecutionSnapshotDigest(roleHistory.roleSnapshot) !== provenance.plannerRoleSnapshotDigest) {
    throw new StoreConflictError("Planner provenance role snapshot digest does not match immutable history.");
  }
}

export function goalPlannerProvenanceFromDetail(detail: GoalRunDetail): GoalPlannerProvenance | null {
  const activePlan = detail.plans.find((plan) => plan.revision === detail.goalRun.activePlanRevision);
  if (activePlan?.plannerProvenance) return activePlan.plannerProvenance;
  const priorPlanProvenance = [...detail.plans]
    .filter((plan) => plan.revision < detail.goalRun.activePlanRevision)
    .sort((left, right) => right.revision - left.revision)
    .find((plan) => plan.plannerProvenance)?.plannerProvenance;
  if (priorPlanProvenance) return priorPlanProvenance;
  for (const event of [...detail.events].reverse()) {
    if (event.type !== "plan.created" && event.type !== "plan.revised") continue;
    if (typeof event.detail.revision !== "number" || event.detail.revision > detail.goalRun.activePlanRevision) continue;
    const parsed = goalPlannerProvenanceSchema.safeParse({
      plannerParticipantId: event.detail.plannerParticipantId,
      plannerAgentId: event.detail.plannerAgentId,
      plannerAgentRevision: event.detail.plannerAgentRevision,
      plannerModelConnectorId: event.detail.plannerModelConnectorId,
      plannerRoleId: event.detail.plannerRoleId,
      plannerRoleRevision: event.detail.plannerRoleRevision,
      plannerRoleSnapshotDigest: event.detail.plannerRoleSnapshotDigest
    });
    if (parsed.success) return parsed.data;
  }
  return null;
}

export interface AppendGoalEventInput {
  type: GoalEventType;
  actorType: GoalEvent["actorType"];
  actorId: string | null;
  entityType: GoalEvent["entityType"];
  entityId: string;
  summary: string;
  detail?: GoalEvent["detail"];
  occurredAt?: string;
}

export interface GoalRunStateMutationInput {
  expectedRevision: number;
  state: GoalRunState;
  pausedFromState?: GoalRunState | null;
  terminalReason?: string | null;
  usage?: GoalRun["usage"];
  orchestrationAdmission?: GoalJobAdmission;
  event: AppendGoalEventInput;
}

export interface GoalPlanMutationInput {
  expectedRevision: number;
  expectedPlanRevision: number;
  plan: GoalPlanRevision;
  event: AppendGoalEventInput;
}

export interface GoalApprovalMutationInput {
  expectedRevision: number;
  contract: ExecutionContract;
  bindings: GoalTaskBinding[];
  orchestrationAdmission?: GoalJobAdmission;
  event: AppendGoalEventInput;
}

export interface GoalTaskBindingMutationInput {
  expectedState: GoalTaskState;
  state: GoalTaskState;
  activeJobId?: string | null;
  attemptCount?: number;
  taskId?: string | null;
  lastError?: string | null;
  event: AppendGoalEventInput;
}

export interface ActionRunMutationInput {
  expectedState: ActionRunState;
  state: ActionRunState;
  externalExecutionId?: string | null;
  verificationSummary?: string | null;
  lastError?: string | null;
  event: AppendGoalEventInput;
}

export type GoalActionExecutionPhase = "preview" | "execute";

export interface GoalActionExecutionAdmissionInput {
  goalRunId: string;
  planTaskId: string;
  contractDigest: string;
  jobId: string;
  phase: GoalActionExecutionPhase;
  now?: string;
  event: AppendGoalEventInput;
  bindingEvent: AppendGoalEventInput;
}

export type GoalActionExecutionAdmissionResult =
  | { status: "admitted"; actionRun: ActionRun; taskBinding: GoalTaskBinding }
  | { status: "rejected"; reason: string };

export type GoalJobAdmissionState = "reserved" | "dispatching" | "admitted" | "running" | "settled" | "outcome_unknown";
export interface GoalJobAdmission {
  jobId: string;
  goalRunId: string;
  jobName: "goal-orchestrate" | "goal-plan" | "goal-review" | "goal-action-run";
  entityId: string;
  requestFingerprint: string;
  state: GoalJobAdmissionState;
  dispatchToken?: string | null;
  dispatchLeaseExpiresAt?: string | null;
  reservedAt: string;
  admittedAt: string | null;
  startedAt: string | null;
  settledAt: string | null;
  updatedAt: string;
}

export interface GoalJobDispatchClaimInput {
  dispatchToken: string;
  leaseDurationMs?: number;
  now?: string;
}

export type GoalJobDispatchClaimResult = {
  status: "claimed" | "contended" | "already_dispatched";
  admission: GoalJobAdmission;
};

export const GOAL_JOB_DISPATCH_TOKEN_MAX_LENGTH = 200;
export const GOAL_JOB_DISPATCH_LEASE_DEFAULT_MS = 30_000;
export const GOAL_JOB_DISPATCH_LEASE_MIN_MS = 1_000;
export const GOAL_JOB_DISPATCH_LEASE_MAX_MS = 60_000;

export function normalizeGoalJobAdmission(admission: GoalJobAdmission): GoalJobAdmission {
  return {
    ...admission,
    dispatchToken: admission.dispatchToken ?? null,
    dispatchLeaseExpiresAt: admission.dispatchLeaseExpiresAt ?? null
  };
}

export function validateGoalJobDispatchToken(dispatchToken: string): string {
  if (typeof dispatchToken !== "string"
    || dispatchToken.length < 1
    || dispatchToken.length > GOAL_JOB_DISPATCH_TOKEN_MAX_LENGTH
    || dispatchToken !== dispatchToken.trim()) {
    throw new RangeError(`Goal job dispatch token must contain 1-${GOAL_JOB_DISPATCH_TOKEN_MAX_LENGTH} non-padded characters.`);
  }
  return dispatchToken;
}

export function normalizeGoalJobDispatchClaimInput(input: GoalJobDispatchClaimInput): {
  dispatchToken: string;
  now: string;
  leaseExpiresAt: string;
} {
  const dispatchToken = validateGoalJobDispatchToken(input.dispatchToken);
  const leaseDurationMs = input.leaseDurationMs ?? GOAL_JOB_DISPATCH_LEASE_DEFAULT_MS;
  if (!Number.isSafeInteger(leaseDurationMs)
    || leaseDurationMs < GOAL_JOB_DISPATCH_LEASE_MIN_MS
    || leaseDurationMs > GOAL_JOB_DISPATCH_LEASE_MAX_MS) {
    throw new RangeError("Goal job dispatch lease must be an integer between 1000 and 60000 milliseconds.");
  }
  const nowDate = input.now === undefined ? new Date() : new Date(input.now);
  if (!Number.isFinite(nowDate.getTime())
    || (input.now !== undefined && nowDate.toISOString() !== input.now)) {
    throw new RangeError("Goal job dispatch time must be a canonical ISO timestamp.");
  }
  const leaseExpiresAt = new Date(nowDate.getTime() + leaseDurationMs);
  if (!Number.isFinite(leaseExpiresAt.getTime())) {
    throw new RangeError("Goal job dispatch lease expiry is outside the supported timestamp range.");
  }
  return {
    dispatchToken,
    now: nowDate.toISOString(),
    leaseExpiresAt: leaseExpiresAt.toISOString()
  };
}

export interface GoalTaskDispatchUsageIncrements {
  taskAttempts: number;
  modelCalls: number;
  actionCalls: number;
}

export interface GoalTaskDispatchActionClaim {
  actionRun: ActionRun;
  actionEvent: AppendGoalEventInput;
  jobAdmission: GoalJobAdmission;
}

export interface GoalTaskDispatchClaimInput {
  goalRunId: string;
  bindingId: string;
  planRevision: number;
  planTaskId: string;
  taskId: string | null;
  expectedAttemptCount: number;
  jobId: string;
  contractDigest: string;
  usageIncrements: GoalTaskDispatchUsageIncrements;
  budgetEvent: AppendGoalEventInput;
  bindingEvent: AppendGoalEventInput;
  action: GoalTaskDispatchActionClaim | null;
  taskAgentJob?: TaskAgentRunJobData;
  now?: string;
}

export type GoalTaskDispatchClaimResult =
  | {
    status: "claimed";
    goalRun: GoalRun;
    taskBinding: GoalTaskBinding;
    actionRun: ActionRun | null;
    jobAdmission: GoalJobAdmission | null;
  }
  | { status: "contended"; reason: string }
  | { status: "rejected"; reason: string };

export function canonicalTaskMatchesGoalDispatch(
  task: Task | undefined,
  input: GoalTaskDispatchClaimInput
): boolean {
  const job = input.taskAgentJob;
  return Boolean(task && job
    && task.id === input.taskId
    && job.taskId === input.taskId
    && task.execution.status === "queued"
    && task.execution.jobId === input.jobId
    && task.execution.revision === job.executionRevision
    && task.execution.requestFingerprint === job.requestFingerprint
    && task.execution.agentId === job.agentId
    && task.execution.profile === job.executionProfile);
}

export class StoreNotFoundError extends Error {
  readonly statusCode = 404;

  constructor(message: string, readonly apiCode?: string) {
    super(message);
    this.name = "StoreNotFoundError";
  }
}

export function assertReservedGoalOrchestrationAdmission(
  admission: GoalJobAdmission,
  goalRunId: string,
  entityId: string
): void {
  if (admission.goalRunId !== goalRunId
    || admission.jobName !== "goal-orchestrate"
    || admission.entityId !== entityId
    || admission.state !== "reserved"
    || admission.requestFingerprint.trim().length === 0
    || admission.jobId.trim().length === 0
    || (admission.dispatchToken ?? null) !== null
    || (admission.dispatchLeaseExpiresAt ?? null) !== null
    || admission.admittedAt !== null
    || admission.startedAt !== null
    || admission.settledAt !== null
    || !Number.isFinite(Date.parse(admission.reservedAt))
    || !Number.isFinite(Date.parse(admission.updatedAt))) {
    throw new StoreConflictError("Goal orchestration admission does not match the atomic Goal mutation.");
  }
}

export class StoreConflictError extends Error {
  readonly statusCode = 409;

  constructor(
    message: string,
    readonly kind: "business_rule" | "revision" = "business_rule",
    readonly apiCode?: string
  ) {
    super(message);
    this.name = "StoreConflictError";
  }
}

export type AppendRuntimeRunEventInput = Omit<RuntimeRunEvent, "id" | "runtimeRunId" | "sequence" | "occurredAt"> & {
  occurredAt?: string;
};

export type RuntimeRunMutationInput = RuntimeRunMutation & {
  event: AppendRuntimeRunEventInput;
};

export interface RuntimeRunHeartbeatInput {
  expectedRevision: number;
  state: RuntimeRunState;
  heartbeatAt: string;
  eventCursor: number;
}

const secretIdempotencyProofPattern = /^hmac-sha256:v1:[a-f0-9]{64}$/;

function secretBearingCreateIdempotencyInput(
  metadata: unknown,
  secret: SecretInput | undefined,
  idempotencyKey: string | undefined,
  entityLabel: string,
  errorCodePrefix: string
): Record<string, unknown> {
  const secretPresent = Boolean(secret?.ciphertext);
  if (idempotencyKey && secretPresent && !secretIdempotencyProofPattern.test(secret?.idempotencyProof ?? "")) {
    throw new StoreConflictError(
      `${entityLabel} creation with a secret requires a valid idempotency proof.`,
      "business_rule",
      `${errorCodePrefix}_IDEMPOTENCY_PROOF_REQUIRED`
    );
  }
  if (idempotencyKey && !secretPresent && secret?.idempotencyProof !== undefined) {
    throw new StoreConflictError(
      `${entityLabel} idempotency proof cannot be supplied without encrypted secret material.`,
      "business_rule",
      `${errorCodePrefix}_IDEMPOTENCY_PROOF_INVALID`
    );
  }
  return {
    metadata,
    idempotencyKey: idempotencyKey ?? null,
    secret: secretPresent
      ? { present: true, proof: idempotencyKey ? secret!.idempotencyProof! : null }
      : { present: false, proof: null }
  };
}

export function credentialCreateIdempotencyInput(
  input: CreateCredentialMetadataInput,
  secret: SecretInput | undefined,
  idempotencyKey: string | undefined
): Record<string, unknown> {
  return secretBearingCreateIdempotencyInput(input, secret, idempotencyKey, "Credential", "CREDENTIAL");
}

export function credentialRotationIdempotencyInput(
  input: RotateCredentialMetadataInput,
  secret: SecretInput,
  maskedHint: string | null | undefined,
  idempotencyKey: string | undefined
): Record<string, unknown> {
  const secretPresent = Boolean(secret.ciphertext);
  if (idempotencyKey && (!secretPresent || !secretIdempotencyProofPattern.test(secret.idempotencyProof ?? ""))) {
    throw new StoreConflictError(
      "Credential rotation with a caller key requires encrypted secret material and a valid idempotency proof.",
      "business_rule",
      "CREDENTIAL_ROTATION_IDEMPOTENCY_PROOF_REQUIRED"
    );
  }
  return {
    metadata: {
      input,
      maskedHint: maskedHint ?? null
    },
    idempotencyKey: idempotencyKey ?? null,
    secret: secretPresent
      ? { present: true, proof: idempotencyKey ? secret.idempotencyProof! : null }
      : { present: false, proof: null }
  };
}

export function mcpConnectorCreateIdempotencyInput(
  input: CreateMcpConnectorStateInput,
  secret: SecretInput | undefined,
  idempotencyKey: string | undefined
): Record<string, unknown> {
  return secretBearingCreateIdempotencyInput(input, secret, idempotencyKey, "MCP Connector", "MCP_CONNECTOR");
}

export function modelConnectorCreateIdempotencyInput(
  input: CreateModelConnectorStateInput,
  secret: SecretInput | undefined,
  idempotencyKey: string | undefined
): Record<string, unknown> {
  if (Object.prototype.hasOwnProperty.call(input, "apiKey")) {
    throw new StoreConflictError(
      "Plaintext Model Connector API keys are not accepted by the store; pass encrypted ciphertext via SecretInput.",
      "business_rule",
      "MODEL_CONNECTOR_PLAINTEXT_SECRET_REJECTED"
    );
  }
  return secretBearingCreateIdempotencyInput(input, secret, idempotencyKey, "Model Connector", "MODEL_CONNECTOR");
}

export function taskAdapterConnectorCreateIdempotencyInput(
  input: CreateTaskAdapterConnectorStateInput,
  secret: SecretInput | undefined,
  idempotencyKey: string | undefined
): Record<string, unknown> {
  return secretBearingCreateIdempotencyInput(input, secret, idempotencyKey, "Task Adapter Connector", "TASK_ADAPTER_CONNECTOR");
}

export function meetingStateAuditEvent(
  previousState: MeetingState,
  state: MeetingState
): "meeting.start" | "meeting.pause" | "meeting.resume" | "meeting.close" | null {
  if (previousState === state) return null;
  if (state === "closed") return "meeting.close";
  if (state === "paused") return "meeting.pause";
  if (state === "active") return previousState === "paused" ? "meeting.resume" : "meeting.start";
  return null;
}

export interface PlatformStore {
  checkHealth(): Promise<void>;
  getSnapshot(): Promise<PlatformSnapshot>;
  getViewSnapshot(view: PlatformViewName): Promise<PlatformSnapshot>;
  getMeetingView(meetingId: string): Promise<MeetingViewSnapshot | null>;
  appendMeetingRecord(record: MeetingRecord): Promise<MeetingRecord>;
  getLatestMeetingRecord(meetingId: string): Promise<MeetingRecord | null>;
  listMeetingUtterances(meetingId: string, input: MeetingUtterancePageInput): Promise<MeetingUtterancePage | null>;
  getSpeakerQueue(): Promise<SpeakerQueueItem[]>;
  createRuntimeRun(run: RuntimeRun, initialEvent: AppendRuntimeRunEventInput): Promise<RuntimeRun>;
  getRuntimeRun(id: string): Promise<RuntimeRun | null>;
  getRuntimeRunForTask(taskId: string): Promise<RuntimeRun | null>;
  listRuntimeRunsForGoal(goalRunId: string): Promise<RuntimeRun[]>;
  listRecoverableOmpRuntimeRuns(limit?: number): Promise<RuntimeRun[]>;
  updateRuntimeRun(id: string, input: RuntimeRunMutationInput): Promise<RuntimeRun>;
  heartbeatRuntimeRun(id: string, input: RuntimeRunHeartbeatInput): Promise<RuntimeRun>;
  appendRuntimeRunEvent(id: string, input: AppendRuntimeRunEventInput): Promise<RuntimeRunEvent>;
  getRuntimeRunEvents(id: string, afterSequence?: number, limit?: number): Promise<RuntimeRunEvent[]>;
  listGoalRuns(): Promise<GoalRun[]>;
  getGoalRun(id: string): Promise<GoalRun | null>;
  getGoalRunDetail(id: string): Promise<GoalRunDetail | null>;
  createGoalRun(
    run: GoalRun,
    event: AppendGoalEventInput,
    idempotencyKey: string,
    orchestrationAdmission?: GoalJobAdmission
  ): Promise<GoalRun>;
  saveGoalPlan(id: string, input: GoalPlanMutationInput): Promise<GoalRunDetail>;
  approveGoalRun(id: string, input: GoalApprovalMutationInput): Promise<GoalRunDetail>;
  setGoalRunState(id: string, input: GoalRunStateMutationInput): Promise<GoalRun>;
  appendGoalEvent(id: string, input: AppendGoalEventInput): Promise<GoalEvent>;
  getGoalEvents(id: string, afterSequence?: number, limit?: number): Promise<GoalEvent[]>;
  updateGoalTaskBinding(id: string, input: GoalTaskBindingMutationInput): Promise<GoalTaskBinding>;
  claimGoalTaskDispatch(input: GoalTaskDispatchClaimInput): Promise<GoalTaskDispatchClaimResult>;
  addReviewerVerdict(verdict: ReviewerVerdict, event: AppendGoalEventInput): Promise<ReviewerVerdict>;
  createActionAdapter(adapter: ActionAdapter): Promise<ActionAdapter>;
  listActionAdapters(): Promise<ActionAdapter[]>;
  createActionRun(run: ActionRun, event: AppendGoalEventInput): Promise<ActionRun>;
  updateActionRun(id: string, input: ActionRunMutationInput): Promise<ActionRun>;
  admitGoalActionExecution(id: string, input: GoalActionExecutionAdmissionInput): Promise<GoalActionExecutionAdmissionResult>;
  reserveGoalJob(admission: GoalJobAdmission): Promise<GoalJobAdmission>;
  reserveGoalReviewJob(admission: GoalJobAdmission, data: GoalReviewJobData): Promise<GoalJobAdmission>;
  getGoalJobAdmission(jobId: string): Promise<GoalJobAdmission | null>;
  getGoalReviewJobData(jobId: string): Promise<GoalReviewJobData | null>;
  claimGoalJobDispatch(jobId: string, input: GoalJobDispatchClaimInput): Promise<GoalJobDispatchClaimResult>;
  completeGoalJobDispatch(jobId: string, dispatchToken: string): Promise<GoalJobAdmission>;
  setGoalJobState(jobId: string, expectedState: GoalJobAdmissionState, state: GoalJobAdmissionState): Promise<GoalJobAdmission>;
  getRecoverableGoalJobs(): Promise<GoalJobAdmission[]>;
  getToolPacks(): Promise<ToolPack[]>;
  createToolPack(input: CreateToolPackInput, idempotencyKey?: string): Promise<ToolPack>;
  updateToolPack(id: string, input: UpdateToolPackInput): Promise<ToolPack>;
  validateToolPack(id: string, input: ValidateToolPackInput): Promise<ToolPack>;
  approveToolPack(id: string, input: ApproveToolPackInput): Promise<ToolPack>;
  revokeToolPack(id: string, input: RevokeToolPackInput): Promise<ToolPack>;
  getToolPackRevisions(id: string): Promise<ToolPackRevision[]>;
  getRuntimeProfiles(): Promise<RuntimeProfile[]>;
  createRuntimeProfile(input: CreateRuntimeProfileInput, idempotencyKey?: string): Promise<RuntimeProfile>;
  updateRuntimeProfile(id: string, input: UpdateRuntimeProfileInput): Promise<RuntimeProfile>;
  getRuntimeProfileRevisions(id: string): Promise<RuntimeProfileRevision[]>;
  createGroup(input: CreateGroupInput, idempotencyKey: string): Promise<DiscussionGroup>;
  createCategory(input: CreateCategoryInput, idempotencyKey: string): Promise<Category>;
  createTag(input: CreateTagInput, idempotencyKey: string): Promise<Tag>;
  updateGroup(id: string, input: UpdateGroupInput): Promise<DiscussionGroup>;
  updateCategory(id: string, input: UpdateCategoryInput): Promise<Category>;
  updateTag(id: string, input: UpdateTagInput): Promise<Tag>;
  createThread(input: CreateThreadInput, idempotencyKey: string): Promise<DiscussionThread>;
  updateThread(id: string, input: UpdateThreadInput): Promise<DiscussionThread>;
  createMeeting(
    input: CreateMeetingInput,
    idempotencyKey?: string,
    participantAdmission?: "structural" | "runnable"
  ): Promise<Meeting>;
  setMeetingState(id: string, state: MeetingState, expectedState?: MeetingState): Promise<Meeting>;
  setMeetingAgenda(id: string, input: SetMeetingAgendaInput): Promise<Meeting>;
  advanceMeetingAgenda(id: string, input: AdvanceMeetingAgendaInput): Promise<Meeting>;
  setMeetingSummaryState(id: string, state: MeetingSummaryState, jobId?: string | null): Promise<Meeting>;
  commitMeetingSummary(input: MeetingSummaryCommitInput): Promise<MeetingSummaryCommitResult>;
  setMeetingMode(id: string, input: SetMeetingModeInput, actor?: "owner" | "system"): Promise<MeetingModeChangeResult>;
  setMeetingAutomation(id: string, input: SetMeetingAutomationInput, actor?: "owner" | "system"): Promise<Meeting>;
  applyChairAutomation(input: ApplyChairAutomationInput): Promise<ApplyChairAutomationResult>;
  switchParticipantRole(meetingId: string, participantId: string, input: SwitchParticipantRoleInput): Promise<ParticipantAssignment>;
  reserveSpeakerTurn(jobId: string, input: AgentTurnJobData): Promise<SpeakerQueueItem>;
  admitMcpToolCall(jobId: string, input: McpToolCallAdmissionInput): Promise<McpToolCallAdmissionResult>;
  reserveMcpToolCall(jobId: string, input: McpToolCallReservationInput): Promise<SpeakerQueueItem>;
  /** Atomically claims a queued action; returns null when another delivery already claimed it. */
  markSpeakerTurnRunning(jobId: string, reservationId?: string): Promise<SpeakerQueueItem | null>;
  renewSpeakerTurnLease(jobId: string, now?: string, reservationId?: string): Promise<SpeakerQueueItem | null>;
  releaseSpeakerTurn(jobId: string, reason: string, reservationId?: string): Promise<SpeakerQueueItem | null>;
  releaseExpiredSpeakerTurns(now?: string): Promise<SpeakerQueueItem[]>;
  addUtterance(meetingId: string, input: CreateUtteranceInput): Promise<Utterance>;
  addUtteranceWithDisposition(meetingId: string, input: CreateUtteranceInput): Promise<UtteranceCreateResult>;
  createChairSuggestion(
    meetingId: string,
    sourceUtteranceId: string,
    suggestion: ChairSuggestion,
    policyBinding?: ChairSuggestionPolicyBinding
  ): Promise<ChairSuggestionCreateResult>;
  getChairAutomationJobAdmissions(): Promise<ChairAutomationJobAdmission[]>;
  reserveChairAutomationJobAdmission(
    id: string,
    jobId: string,
    automationRevision: number
  ): Promise<ChairAutomationJobAdmissionMutationResult>;
  confirmChairAutomationJobAdmission(
    id: string,
    jobId: string
  ): Promise<ChairAutomationJobAdmissionMutationResult>;
  releaseChairAutomationJobAdmission(
    id: string,
    jobId: string,
    classification: string
  ): Promise<ChairAutomationJobAdmissionMutationResult>;
  requireChairAutomationJobReconciliation(
    id: string,
    jobId: string,
    reason: ChairAutomationJobReconciliationReason,
    at?: string
  ): Promise<ChairAutomationJobAdmissionMutationResult>;
  setChairSuggestionPending(id: string, agentId: string, jobId: string, actor?: "owner" | "system"): Promise<ChairSuggestionMutationResult>;
  releaseChairSuggestion(id: string, jobId: string, note: string): Promise<ChairSuggestionMutationResult>;
  dismissChairSuggestion(id: string, note: string): Promise<ChairSuggestionMutationResult>;
  applyChairSuggestedRole(id: string, input: ApplyChairSuggestedRoleInput): Promise<ChairSuggestionRoleApplyResult>;
  commitAgentTurn(input: AgentTurnCommitInput): Promise<AgentTurnCommitResult>;
  commitAgentTurnFailure(input: AgentTurnFailureCommitInput): Promise<AgentTurnFailureCommitResult>;
  commitMcpToolRun(input: McpToolRunCommitInput): Promise<McpToolRunCommitResult>;
  createDecision(input: CreateDecisionInput, idempotencyKey: string): Promise<Decision>;
  setDecisionStatus(id: string, status: "approved" | "rejected"): Promise<Decision>;
  createTask(input: CreateTaskInput, idempotencyKey: string): Promise<Task>;
  updateTask(id: string, input: UpdateTaskInput): Promise<Task>;
  setTaskApproval(id: string, input: SetTaskApprovalInput): Promise<Task>;
  addTaskEvidence(id: string, input: AddTaskEvidenceInput, idempotencyKey?: string): Promise<Task>;
  moveTask(id: string, input: MoveTaskInput): Promise<Task>;
  markTaskAgentRunQueued(jobId: string, input: TaskAgentRunJobData): Promise<TaskExecutionMutationResult>;
  markTaskAgentRunRunning(jobId: string, input: TaskAgentRunJobData): Promise<TaskExecutionMutationResult>;
  claimTaskAgentProviderAttempt(jobId: string, input: TaskAgentRunJobData): Promise<TaskExecutionMutationResult>;
  completeTaskAgentRun(jobId: string, input: TaskAgentRunJobData, content: string, usage?: TaskAgentCompletionUsage): Promise<TaskExecutionMutationResult>;
  failTaskAgentRun(binding: TaskAgentRunFailureBinding, error: string): Promise<TaskExecutionMutationResult>;
  markTaskSyncPending(id: string, jobId: string, input: TaskSyncRequestInput): Promise<TaskSyncMutationResult>;
  completeTaskSync(id: string, jobId: string, externalId: string, requestFingerprint: string): Promise<TaskSyncMutationResult>;
  failTaskSync(binding: TaskSyncFailureBinding, error: string): Promise<TaskSyncMutationResult>;
  createAgent(input: CreateAgentInput, idempotencyKey?: string): Promise<Agent>;
  updateAgent(id: string, input: UpdateAgentInput, expectedDraftRevision?: number): Promise<Agent>;
  setAgentModel(id: string, input: SetAgentModelInput, expectedDraftRevision?: number): Promise<Agent>;
  getAgentReadiness(id: string, options?: { executionIsolationAttested?: boolean }): Promise<AgentReadiness>;
  getAgentRevisions(id: string): Promise<AgentRevision[]>;
  getAgentRevision(id: string, revision: number): Promise<AgentRevision>;
  publishAgent(id: string, input: PublishAgentInput): Promise<Agent>;
  rollbackAgent(id: string, input: RollbackAgentInput): Promise<Agent>;
  setAgentStatus(id: string, input: SetAgentStatusInput): Promise<Agent>;
  getCredentials(): Promise<Credential[]>;
  createCredential(input: CreateCredentialMetadataInput, secret?: SecretInput, idempotencyKey?: string): Promise<Credential>;
  updateCredential(id: string, input: UpdateCredentialMetadataInput): Promise<Credential>;
  replayCredentialRotation(input: RotateCredentialMetadataInput, secret: SecretInput, maskedHint: string | null | undefined, idempotencyKey: string): Promise<Credential | null>;
  rotateCredential(input: RotateCredentialMetadataInput, secret: SecretInput, maskedHint?: string | null, idempotencyKey?: string): Promise<Credential>;
  setCredentialStatus(id: string, input: UpdateCredentialStatusInput, idempotencyKey?: string): Promise<Credential>;
  getCredentialSecret(id: string): Promise<string | null>;
  getPrompts(): Promise<PromptTemplate[]>;
  createPrompt(input: CreatePromptInput, idempotencyKey?: string): Promise<PromptTemplate>;
  updatePrompt(id: string, input: UpdatePromptInput): Promise<PromptTemplate>;
  publishPrompt(id: string, input: PublishPromptInput): Promise<PromptTemplate>;
  rollbackPrompt(id: string, input: RollbackPromptInput): Promise<PromptTemplate>;
  archivePrompt(id: string, input: ArchivePromptInput): Promise<PromptTemplate>;
  getPromptVersions(id: string): Promise<PromptVersion[]>;
  getPromptVersion(id: string, version: number): Promise<PromptVersion>;
  createAgentTeam(input: CreateAgentTeamInput, idempotencyKey?: string): Promise<AgentTeam>;
  updateAgentTeam(id: string, input: UpdateAgentTeamInput): Promise<AgentTeam>;
  createMeetingPreset(input: CreateMeetingPresetInput, idempotencyKey?: string): Promise<MeetingPreset>;
  updateMeetingPreset(id: string, input: UpdateMeetingPresetInput): Promise<MeetingPreset>;
  createRole(input: CreateRoleInput, idempotencyKey?: string): Promise<Role>;
  updateRole(id: string, input: UpdateRoleInput, expectedCurrentVersion: number): Promise<Role>;
  getRoleVersions(id: string): Promise<RoleVersion[]>;
  getRoleLifecycle(id: string): Promise<RoleLifecycleView>;
  rollbackRole(id: string, version: number, expectedCurrentVersion: number): Promise<Role>;
  deleteRole(id: string, expectedCurrentVersion: number, idempotencyKey?: string): Promise<RoleDeletionResult>;
  createSkill(input: CreateSkillInput, idempotencyKey?: string): Promise<Skill>;
  setSkillStatus(id: string, input: SetSkillStatusInput): Promise<Skill>;
  validateSkill(id: string, input: ValidateSkillInput): Promise<Skill>;
  revokeSkill(id: string, input: RevokeSkillInput, idempotencyKey?: string): Promise<SkillRevocationResult>;
  replayModelConnectorCreate(input: CreateModelConnectorStateInput, secret: SecretInput | undefined, idempotencyKey: string): Promise<ModelConnector | null>;
  createModelConnector(input: CreateModelConnectorStateInput, secret?: SecretInput, idempotencyKey?: string): Promise<ModelConnector>;
  updateModelConnector(id: string, input: UpdateModelConnectorStateInput, secret?: SecretInput): Promise<ModelConnectorUpdateResult>;
  replayMcpConnectorCreate(input: CreateMcpConnectorStateInput, secret: SecretInput | undefined, idempotencyKey: string): Promise<McpConnector | null>;
  createMcpConnector(input: CreateMcpConnectorStateInput, secret?: SecretInput, idempotencyKey?: string): Promise<McpConnector>;
  updateMcpConnector(id: string, input: UpdateMcpConnectorStateInput, secret?: SecretInput): Promise<McpConnectorUpdateResult>;
  replayTaskAdapterConnectorCreate(input: CreateTaskAdapterConnectorStateInput, secret: SecretInput | undefined, idempotencyKey: string): Promise<TaskAdapterConnector | null>;
  createTaskAdapterConnector(input: CreateTaskAdapterConnectorStateInput, secret?: SecretInput, idempotencyKey?: string): Promise<TaskAdapterConnector>;
  getConnectorSecret(connectorId: string): Promise<string | null>;
  admitExternalExecutionStart(
    input: ExternalExecutionStartRequest,
    idempotencyKey: string
  ): Promise<ExternalExecutionStartAdmission>;
  settleExternalExecutionStart(
    input: ExternalExecutionStartRequest,
    idempotencyKey: string,
    execution: ExternalExecution
  ): Promise<ExternalExecution>;
  createOwner(email: string, passwordHash: string): Promise<OwnerUser>;
  findOwnerByEmail(email: string): Promise<OwnerUser | null>;
  createSession(session: SessionRecord): Promise<void>;
  findSession(tokenHash: string): Promise<SessionRecord | null>;
  deleteSession(tokenHash: string): Promise<void>;
  recordAudit(event: string, entityType: string, entityId: string, detail?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}
