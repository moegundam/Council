import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
  AgendaItem,
  Category,
  ChairAutomationJobAdmission,
  ChairAutomationJobReconciliationReason,
  ChairSuggestion,
  ChairSuggestionRecord,
  CreateAgentInput,
  CreateAgentTeamInput,
  CreateCategoryInput,
  CreateCredentialInput,
  CreateDecisionInput,
  CreateGroupInput,
  CreateMeetingInput,
  CreateMeetingPresetInput,
  CreatePromptInput,
  CreateRoleInput,
  CreateRuntimeProfileInput,
  CreateSkillInput,
  CreateTagInput,
  CreateToolPackInput,
  UpdateCategoryInput,
  UpdateGroupInput,
  CreateTaskInput,
  CreateThreadInput,
  CreateUtteranceInput,
  Credential,
  Decision,
  DiscussionGroup,
  DiscussionThread,
  ExecutionContract,
  GoalEvent,
  GoalPlanRevision,
  GoalReviewJobData,
  GoalRun,
  GoalTaskBinding,
  ReviewerVerdict,
  ActionAdapter,
  ActionRun,
  McpConnector,
  McpConnectorUpdateResult,
  McpToolExecutionBinding,
  McpToolRun,
  MeetingViewSnapshot,
  Meeting,
  MeetingRecord,
  MeetingAgenda,
  MeetingPreset,
  MeetingSummaryState,
  MeetingState,
  ModelConnector,
  ModelConnectorUpdateResult,
  MoveTaskInput,
  ParticipantAssignment,
  ParticipantRoleBinding,
  ParticipantRoleHistoryEntry,
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
  RuntimeProfileSnapshot,
  RuntimeRun,
  RuntimeRunEvent,
  SetAgentModelInput,
  SetMeetingAgendaInput,
  SetMeetingAutomationInput,
  SetMeetingModeInput,
  SetTaskApprovalInput,
  SpeakerQueueItem,
  SetSkillStatusInput,
  Skill,
  SkillRevocationResult,
  Task,
  TaskAgentRunJobData,
  TaskSyncRequestInput,
  TaskAdapterConnector,
  TaskTransition,
  Tag,
  ToolRegistration,
  ToolRegistrationSnapshot,
  ToolPack,
  ToolPackGrant,
  ToolPackRevision,
  UpdateAgentInput,
  UpdateAgentTeamInput,
  UpdateCredentialInput,
  UpdateMeetingPresetInput,
  UpdatePromptInput,
  UpdateRoleInput,
  UpdateRuntimeProfileInput,
  UpdateTagInput,
  UpdateThreadInput,
  UpdateTaskInput,
  UpdateToolPackInput,
  SwitchParticipantRoleInput,
  ValidateSkillInput,
  ValidateToolPackInput,
  RevokeSkillInput,
  RevokeToolPackInput,
  Utterance
} from "@council/contracts";
import { projectMeetingView, projectPlatformView } from "@council/domain/platform-views";
import {
  advanceMeetingAgendaSchema,
  createRoleSchema,
  approveToolPackSchema,
  actionAdapterSchema,
  actionRunSchema,
  builtInRoleTemplates,
  createCredentialSchema,
  createToolPackSchema,
  createRuntimeProfileRevision,
  createToolPackRevision,
  createRoleExecutionSnapshot,
  createRoleVersion,
  createTaskSchema,
  defaultRoleBehavior,
  executionContractSchema,
  goalEventSchema,
  goalPlanRevisionSchema,
  goalRunSchema,
  goalTaskBindingSchema,
  meetingAgendaSchema,
  meetingRecordSchema,
  runtimeRunEventSchema,
  runtimeRunSchema,
  runtimeProfileSchema,
  runtimeProfileBindingSchema,
  resolveRoleUsageContext,
  rolePolicyCombinationIsValid,
  setMeetingAgendaSchema,
  toolRegistrationSchema,
  toolPackGrantIsCurrentAndApproved,
  toolPackGrantSchema,
  toolPackRevisionSchema,
  toolPackSchema,
  updateToolPackSchema,
  validateToolPackSchema,
  revokeToolPackSchema,
  reviewerVerdictSchema,
  type RoleTemplateKey
} from "@council/contracts";
import {
  assertConnectorUrlShapeAllowed,
  actionAdapterEndpointDigest,
  credentialIsExpired,
  goalBudgetFailureReason,
  goalBudgetReservationFailureReason,
  applyRuntimeRunMutation,
  validateQueuedRuntimeRun
} from "@council/domain";
import { permittedAgentIdsForMeeting } from "@council/domain/meeting-scheduling";
import { createSeedSnapshot } from "./seed.js";
import {
  createDefaultRuntimeProfile,
  createDefaultRuntimeProfileRevision,
  defaultRuntimeProfileBinding,
  resolveRuntimeProfileSnapshotForBinding,
  sameRuntimeProfileBinding,
  sameRuntimeProfileSnapshot
} from "./runtime-profiles.js";
import { skillContentDigest, skillHasCurrentApprovedValidation } from "./skill-governance.js";
import { agentRevisionContentDigestIsValid, createAgentRevisionContentDigest } from "./agent-revision-governance.js";
import { createToolPackManifestDigest, toolPackManifestDigestIsValid } from "./tool-pack-governance.js";
import {
  decodeMeetingUtteranceCursor,
  encodeMeetingUtteranceCursor,
  MeetingUtteranceCursorError
} from "./meeting-utterance-pagination.js";
import {
  isMeetingSummaryUtterance,
  externalExecutionStartFingerprint,
  externalExecutionStartOperation,
  meetingStateAuditEvent,
  mcpConnectorExecutionFingerprint,
  requestFingerprint,
  goalRunCreateIdempotencyInput,
  goalCancellationActionStates,
  goalCancellationBlockingActionStates,
  goalCancellationTaskStates,
  normalizeGoalJobAdmission,
  normalizeGoalJobDispatchClaimInput,
  assertExecutionActionBindings,
  assertGoalPlannerProvenance,
  assertGoalReviewJobAdmission,
  assertGoalPlanDecisionBindings,
  assertReservedGoalOrchestrationAdmission,
  canonicalTaskMatchesPlan,
  canonicalTaskMatchesGoalDispatch,
  goalPlanTaskCreateInput,
  taskChangedFields,
  taskExecutionFingerprint,
  taskSyncRequestFingerprint,
  utteranceReplayMatches,
  parseExternalExecutionStartEnvelope,
  StoreConflictError,
  StoreNotFoundError,
  validateGoalJobDispatchToken,
  type AgentTurnCommitInput,
  type AgentTurnCommitResult,
  type AgentTurnFailureCommitInput,
  type AgentTurnFailureCommitResult,
  type ApplyChairAutomationInput,
  type ApplyChairAutomationResult,
  type ActionRunMutationInput,
  type AppendGoalEventInput,
  type AppendRuntimeRunEventInput,
  type ChairAutomationJobAdmissionMutationResult,
  type ChairSuggestionCreateResult,
  type ChairSuggestionPolicyBinding,
  type ChairSuggestionMutationResult,
  type ChairSuggestionRoleApplyResult,
  type GoalApprovalMutationInput,
  type GoalActionExecutionAdmissionInput,
  type GoalActionExecutionAdmissionResult,
  type GoalJobAdmission,
  type GoalJobAdmissionState,
  type GoalJobDispatchClaimInput,
  type GoalJobDispatchClaimResult,
  type GoalPlanMutationInput,
  type GoalRunDetail,
  type GoalRunStateMutationInput,
  type GoalTaskDispatchClaimInput,
  type GoalTaskDispatchClaimResult,
  type GoalTaskBindingMutationInput,
  type MeetingSummaryCommitInput,
  type MeetingSummaryCommitResult,
  type MeetingUtterancePage,
  type MeetingUtterancePageInput,
  type MeetingModeChangeResult,
  type McpToolCallAdmissionInput,
  type McpToolCallAdmissionResult,
  type McpToolCallReservationInput,
  type McpToolRunCommitInput,
  type McpToolRunCommitResult,
  type OwnerUser,
  type PlatformStore,
  type RuntimeRunHeartbeatInput,
  type RuntimeRunMutationInput,
  type CreateCredentialMetadataInput,
  type CreateModelConnectorStateInput,
  type CreateMcpConnectorStateInput,
  type CreateTaskAdapterConnectorStateInput,
  credentialCreateIdempotencyInput,
  credentialRotationIdempotencyInput,
  type ExternalExecutionStartAdmission,
  type ExternalExecutionStartEnvelope,
  type ExternalExecutionStartRequest,
  type RotateCredentialMetadataInput,
  type SecretInput,
  type SessionRecord,
  type TaskAgentCompletionUsage,
  type TaskAgentRunFailureBinding,
  type TaskExecutionMutationResult,
  type TaskSyncFailureBinding,
  type TaskSyncMutationResult,
  type UpdateCredentialMetadataInput,
  mcpConnectorCreateIdempotencyInput,
  modelConnectorCreateIdempotencyInput,
  taskAdapterConnectorCreateIdempotencyInput,
  type UpdateMcpConnectorStateInput,
  type UpdateModelConnectorStateInput,
  type UtteranceCreateResult
} from "./store.js";
import type { ExternalExecution } from "@council/domain";
import type {
  ArchivePromptInput,
  PublishAgentInput,
  PublishPromptInput,
  RollbackAgentInput,
  RollbackPromptInput,
  RotateCredentialInput,
  SetAgentStatusInput,
  UpdateCredentialStatusInput
} from "@council/contracts";

interface IdempotencyRecord {
  requestFingerprint: string;
  response: unknown;
}

interface PendingIdempotencyRecord {
  requestFingerprint: string;
  promise: Promise<unknown>;
}

const legacyRoleTemplateKeyById: Readonly<Record<string, RoleTemplateKey>> = {
  "60000000-0000-4000-8000-000000000001": "platform_architect",
  "60000000-0000-4000-8000-000000000002": "meeting_chair",
  "60000000-0000-4000-8000-000000000003": "security_reviewer"
};

function validMcpExecutionBinding(value: unknown): value is McpToolExecutionBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  const snapshot = binding.toolSnapshot;
  const snapshotRecord = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown>
    : null;
  const { connectorName: _connectorName, ...registration } = snapshotRecord ?? {};
  return Object.keys(binding).length === 3
    && typeof binding.connectorId === "string"
    && binding.connectorId.trim().length > 0
    && typeof binding.connectorFingerprint === "string"
    && binding.connectorFingerprint.trim().length > 0
    && typeof snapshotRecord?.connectorName === "string"
    && snapshotRecord.connectorName.trim().length > 0
    && toolRegistrationSchema.safeParse(registration).success;
}

function idleTaskExecution(revision = 0, attemptCount = 0): Task["execution"] {
  return {
    revision,
    status: "idle",
    jobId: null,
    requestFingerprint: null,
    agentId: null,
    profile: null,
    attemptCount,
    requestedAt: null,
    startedAt: null,
    providerStartedAt: null,
    completedAt: null,
    lastError: null,
    resultEvidenceId: null,
    runtimeProfileBinding: null
  };
}

function normalizeTaskExecution(value: Task["execution"] | undefined): Task["execution"] {
  if (!value) return idleTaskExecution();
  const runtimeProfileBinding = value.runtimeProfileBinding ?? null;
  const providerStartedAt = value.providerStartedAt ?? null;
  const validStatus = ["idle", "queued", "running", "completed", "failed"].includes(value.status);
  const validProfile = value.profile === null || value.profile === "advisor" || value.profile === "worker";
  const validStrings = [value.jobId, value.requestFingerprint, value.agentId, value.requestedAt, value.startedAt, providerStartedAt, value.completedAt, value.lastError, value.resultEvidenceId]
    .every((entry) => entry === null || typeof entry === "string");
  if (!Number.isInteger(value.revision) || value.revision < 0
    || !Number.isInteger(value.attemptCount) || value.attemptCount < 0
    || (runtimeProfileBinding !== null && !runtimeProfileBindingSchema.safeParse(runtimeProfileBinding).success)
    || !validStatus || !validProfile || !validStrings) {
    throw new StoreConflictError("Task execution state is invalid.");
  }
    if (value.status === "idle") {
      if (value.jobId !== null || value.requestFingerprint !== null || value.agentId !== null || value.profile !== null
        || value.requestedAt !== null || value.startedAt !== null || value.completedAt !== null
        || providerStartedAt !== null || value.lastError !== null || value.resultEvidenceId !== null || runtimeProfileBinding !== null) {
      throw new StoreConflictError("Idle Task execution cannot retain an active run binding.");
    }
    return { ...structuredClone(value), providerStartedAt, runtimeProfileBinding };
  }
  if (!value.jobId || !value.requestFingerprint || !value.agentId || !value.profile || !value.requestedAt) {
    throw new StoreConflictError("Active or terminal Task execution requires a complete run binding.");
  }
  if (value.status === "queued" && (value.startedAt !== null || providerStartedAt !== null || value.completedAt !== null || value.lastError !== null || value.resultEvidenceId !== null)) {
    throw new StoreConflictError("Queued Task execution has invalid lifecycle fields.");
  }
  if (value.status === "running" && (!value.startedAt || value.completedAt !== null || value.lastError !== null || value.resultEvidenceId !== null)) {
    throw new StoreConflictError("Running Task execution has invalid lifecycle fields.");
  }
  if (value.status === "completed" && (!value.startedAt || !value.completedAt || !value.resultEvidenceId || value.lastError !== null)) {
    throw new StoreConflictError("Completed Task execution requires result evidence.");
  }
  if (value.status === "failed" && (!value.startedAt || !value.completedAt || !value.lastError || value.resultEvidenceId !== null)) {
    throw new StoreConflictError("Failed Task execution requires a terminal error.");
  }
  return { ...structuredClone(value), providerStartedAt, runtimeProfileBinding };
}

const queuedSpeakerLeaseMs = 5 * 60 * 1_000;
const runningSpeakerLeaseMs = 30 * 60 * 1_000;

function leaseExpiry(from: string, durationMs: number): string {
  return new Date(new Date(from).getTime() + durationMs).toISOString();
}

function nextTimestamp(previous: string): string {
  const previousTime = Date.parse(previous);
  const now = Date.now();
  return new Date(Number.isFinite(previousTime) ? Math.max(now, previousTime + 1) : now).toISOString();
}

function snapshotToolRegistration(toolName: string, provided?: ToolRegistrationSnapshot): ToolRegistrationSnapshot {
  if (provided?.toolName === toolName) return structuredClone(provided);
  return {
    connectorName: "Unknown legacy connector",
    toolName,
    displayName: toolName,
    kind: "mcp_tool",
    version: "legacy-unknown",
    owner: "Unknown legacy owner",
    goal: "Legacy Tool Run did not capture request-time metadata."
  };
}

export class InMemoryPlatformStore implements PlatformStore {
  private readonly state: PlatformSnapshot;
  private readonly roleVersions: RoleVersion[];
  private readonly agentRevisions = new Map<string, AgentRevision[]>();
  private readonly promptVersions = new Map<string, PromptVersion[]>();
  private readonly owners = new Map<string, OwnerUser>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly pendingIdempotency = new Map<string, PendingIdempotencyRecord>();
  private readonly connectorSecrets = new Map<string, string>();
  private readonly credentialSecrets = new Map<string, string>();
  private readonly chairAutomationJobAdmissions = new Map<string, ChairAutomationJobAdmission>();
  private readonly goalRuns = new Map<string, GoalRun>();
  private readonly goalPlans = new Map<string, GoalPlanRevision[]>();
  private readonly goalContracts = new Map<string, ExecutionContract>();
  private readonly goalTaskBindings = new Map<string, GoalTaskBinding>();
  private readonly goalEvents = new Map<string, GoalEvent[]>();
  private readonly reviewerVerdicts = new Map<string, ReviewerVerdict>();
  private readonly actionAdapters = new Map<string, ActionAdapter>();
  private readonly actionRuns = new Map<string, ActionRun>();
  private readonly goalJobAdmissions = new Map<string, GoalJobAdmission>();
  private readonly goalReviewJobBindings = new Map<string, GoalReviewJobData>();
  private readonly meetingRecords = new Map<string, MeetingRecord>();
  private readonly meetingRecordBySourceDigest = new Map<string, MeetingRecord>();
  private readonly runtimeRuns = new Map<string, RuntimeRun>();
  private readonly runtimeRunByIdempotency = new Map<string, string>();
  private readonly runtimeRunEvents = new Map<string, RuntimeRunEvent[]>();
  private goalEventSequence = 0;
  private agentDefinitionMutation: Promise<void> = Promise.resolve();
  private roleMutation: Promise<void> = Promise.resolve();
  private roleReferenceMutation: Promise<void> = Promise.resolve();
  private skillMutation: Promise<void> = Promise.resolve();
  private toolPackMutation: Promise<void> = Promise.resolve();
  private runtimeProfileMutation: Promise<void> = Promise.resolve();
  private promptMutation: Promise<void> = Promise.resolve();
  private taxonomyMutation: Promise<void> = Promise.resolve();
  private readonly connectorMutations = new Map<"model" | "mcp" | "task_adapter", Promise<void>>();
  private readonly meetingSummaryMutations = new Map<string, Promise<void>>();
  private readonly meetingMutations = new Map<string, Promise<void>>();
  private readonly topicMeetingMutations = new Map<string, Promise<void>>();
  private readonly decisionWorkflowMutations = new Map<string, Promise<void>>();
  private runtimeAdmissionMutation: Promise<void> = Promise.resolve();
  private runtimeRunMutation: Promise<void> = Promise.resolve();
  private externalExecutionAdmissionMutation: Promise<void> = Promise.resolve();
  private goalMutation: Promise<void> = Promise.resolve();
  private taskMutation: Promise<void> = Promise.resolve();

  constructor(
    seed: PlatformSnapshot = createSeedSnapshot(),
    history: {
      agentRevisions?: AgentRevision[];
      promptVersions?: PromptVersion[];
      credentialSecrets?: Array<{ credentialId: string; ciphertext: string }>;
      connectorSecrets?: Array<{ connectorId: string; ciphertext: string }>;
      chairAutomationJobAdmissions?: ChairAutomationJobAdmission[];
      runtimeProfileRevisions?: RuntimeProfileRevision[];
      toolPackRevisions?: ToolPackRevision[];
      goalRuntimeAdmissionDetails?: Array<Pick<
        GoalRunDetail,
        "goalRun" | "executionContract" | "taskBindings"
      >>;
    } = {}
  ) {
    const state = structuredClone(seed) as PlatformSnapshot & {
      chairSuggestions?: ChairSuggestionRecord[];
      toolRuns?: McpToolRun[];
      taskAdapterConnectors?: TaskAdapterConnector[];
      speakerQueue?: SpeakerQueueItem[];
      skills: Array<Partial<Skill> & Pick<Skill, "id" | "name" | "version" | "instructions" | "status">>;
      roles: Array<Partial<Role> & Pick<Role, "id" | "name" | "responsibility">>;
      participants: Array<Partial<ParticipantAssignment> & Pick<ParticipantAssignment, "id" | "meetingId" | "agentId" | "roleId" | "isChair">>;
      modelConnectors: Array<Partial<ModelConnector> & Pick<ModelConnector, "id" | "name" | "location" | "baseUrl" | "model" | "enabled" | "hasSecret">>;
      meetings: Array<Partial<Meeting> & Pick<Meeting, "id" | "threadId" | "title" | "goal" | "state" | "mode" | "automation" | "durationMinutes" | "startedAt" | "createdAt">>;
      tasks: Array<Partial<Task> & Pick<Task, "id" | "meetingId" | "decisionId" | "title" | "description" | "status" | "position" | "assignee" | "createdAt">>;
    };
    const roles = state.roles.map((role) => {
      const templateKey = role.templateKey ?? legacyRoleTemplateKeyById[role.id] ?? null;
      const template = builtInRoleTemplates.find((item) => item.key === templateKey);
      const dataPolicy = role.dataPolicy ?? template?.dataPolicy ?? "meeting_only";
      const requestedToolPolicy = role.toolPolicy ?? template?.toolPolicy ?? "none";
      const toolPolicy = rolePolicyCombinationIsValid({ toolPolicy: requestedToolPolicy, dataPolicy })
        ? requestedToolPolicy
        : "none";
      return {
        ...role,
        usageContext: resolveRoleUsageContext({ ...role, templateKey }),
        speakingGuidance: role.speakingGuidance ?? defaultRoleBehavior.speakingGuidance,
        decisionScope: role.decisionScope ?? defaultRoleBehavior.decisionScope,
        constraints: role.constraints ?? defaultRoleBehavior.constraints,
        version: role.version ?? 1,
        templateKey,
        toolPolicy,
        dataPolicy,
        orchestrationFunctions: Array.isArray(role.orchestrationFunctions)
          ? [...role.orchestrationFunctions]
          : [...(template?.orchestrationFunctions ?? [])],
        deletedAt: role.deletedAt ?? null
      };
    }) as Role[];
    const participants = state.participants.map((participant) => {
      let roleSnapshot: ParticipantAssignment["roleSnapshot"];
      if (participant.roleSnapshot) {
        const snapshot = participant.roleSnapshot as Partial<ParticipantAssignment["roleSnapshot"]> & Pick<ParticipantAssignment["roleSnapshot"], "roleId" | "responsibility" | "templateKey">;
        const templateKey = snapshot.templateKey ?? legacyRoleTemplateKeyById[snapshot.roleId] ?? null;
        roleSnapshot = {
          ...snapshot,
          templateKey,
          usageContext: resolveRoleUsageContext({ ...snapshot, templateKey }),
          orchestrationFunctions: Array.isArray(snapshot.orchestrationFunctions)
            ? [...snapshot.orchestrationFunctions]
            : [...(builtInRoleTemplates.find((item) => item.key === templateKey)?.orchestrationFunctions ?? [])]
        } as ParticipantAssignment["roleSnapshot"];
      } else {
        const role = roles.find((item) => item.id === participant.roleId);
        if (!role) throw new StoreConflictError("Cannot backfill a Participant with a missing Role.");
        roleSnapshot = createRoleExecutionSnapshot(role, "legacy_backfilled");
      }
      const meetingCreatedAt = state.meetings.find((meeting) => meeting.id === participant.meetingId)?.createdAt
        ?? new Date().toISOString();
      const roleHistory = this.normalizeParticipantRoleHistory(participant, roleSnapshot, meetingCreatedAt);
      const roleRevision = participant.roleRevision ?? roleHistory.at(-1)!.revision;
      const current = roleHistory.at(-1)!;
      if (current.revision !== roleRevision
        || current.roleId !== participant.roleId
        || JSON.stringify(current.roleSnapshot) !== JSON.stringify(roleSnapshot)) {
        throw new StoreConflictError("Participant Role history does not match its current Role revision.");
      }
      return { ...participant, roleSnapshot, roleRevision, roleHistory } as ParticipantAssignment;
    });
    const connectorRevisions = [...state.modelConnectors, ...state.mcpConnectors]
      .map((connector) => connector.revision)
      .filter((revision): revision is number => revision !== undefined);
    if (connectorRevisions.some((revision) => !Number.isInteger(revision) || revision < 1)) {
      throw new StoreConflictError("Connector revisions must be positive integers.");
    }
    const mcpConnectors = state.mcpConnectors.map((connector) => {
      const approvedTools = this.normalizeApprovedTools(connector.approvedTools);
      return {
        ...connector,
        revision: connector.revision ?? 1,
        location: connector.location ?? "local",
        secretRevision: connector.secretRevision ?? (connector.hasSecret ? 1 : 0),
        approvedTools,
        toolRegistrations: this.normalizeToolRegistrations(
          approvedTools,
          Array.isArray(connector.toolRegistrations) ? connector.toolRegistrations : [],
          connector.enabled,
          false
        )
      };
    });
    const runtimeRecordedAt = this.defaultRecordedAt(state);
    const runtimeProfileState = this.normalizeRuntimeProfiles(
      Array.isArray(state.runtimeProfiles) ? state.runtimeProfiles : [],
      Array.isArray(state.runtimeProfileRevisions) ? state.runtimeProfileRevisions : [],
      history.runtimeProfileRevisions ?? [],
      runtimeRecordedAt
    );
    const toolPackState = this.normalizeToolPacks(
      Array.isArray(state.toolPacks) ? state.toolPacks : [],
      Array.isArray(state.toolPackRevisions) ? state.toolPackRevisions : [],
      history.toolPackRevisions ?? []
    );
    const agents = state.agents.map((agent) => {
      const revision = agent.revision ?? agent.draftRevision ?? agent.publishedRevision ?? 1;
      if (!Number.isInteger(revision) || revision < 1) {
        throw new StoreConflictError("Agent resource revisions must be positive integers.");
      }
      return {
        ...agent,
        revision,
        lifecycleStatus: agent.lifecycleStatus ?? "published",
        draftRevision: agent.draftRevision ?? 1,
        publishedRevision: agent.publishedRevision === undefined ? 1 : agent.publishedRevision,
        runtimeProfileBinding: agent.runtimeProfileBinding ?? { ...defaultRuntimeProfileBinding },
        promptBinding: agent.promptBinding ?? null,
        toolPackGrants: this.normalizeToolPackGrants(agent.toolPackGrants),
        toolGrants: agent.toolGrants.filter((grant) => mcpConnectors.some((connector) =>
          connector.id === grant.connectorId
          && connector.enabled
          && connector.approvedTools.includes(grant.toolName)
          && connector.toolRegistrations.some((registration) => registration.toolName === grant.toolName)
        ))
      };
    });
    const recordedTaskBoardRevisions = state.tasks
      .map((task) => task.boardRevision)
      .filter((revision): revision is number => revision !== undefined);
    if (state.tasks.some((task) => task.revision !== undefined && (!Number.isInteger(task.revision) || task.revision < 1))
      || recordedTaskBoardRevisions.some((revision) => !Number.isInteger(revision) || revision < 1)) {
      throw new StoreConflictError("Task revisions must be positive integers.");
    }
    const distinctTaskBoardRevisions = new Set(recordedTaskBoardRevisions);
    if (distinctTaskBoardRevisions.size > 1) {
      throw new StoreConflictError("Task board revisions are inconsistent.");
    }
    const taskBoardRevision = recordedTaskBoardRevisions[0] ?? 1;
    const taxonomyRevisions = [...state.groups, ...state.categories, ...state.tags]
      .map((item) => item.revision)
      .filter((revision): revision is number => revision !== undefined);
    if (taxonomyRevisions.some((revision) => !Number.isInteger(revision) || revision < 1)) {
      throw new StoreConflictError("Taxonomy revisions must be positive integers.");
    }
    this.state = {
      ...state,
      groups: state.groups.map((group) => ({ ...group, revision: group.revision ?? 1 })),
      categories: state.categories.map((category) => ({ ...category, revision: category.revision ?? 1 })),
      tags: state.tags.map((tag) => ({ ...tag, revision: tag.revision ?? 1 })),
      agents,
      runtimeProfiles: runtimeProfileState.profiles,
      runtimeProfileRevisions: runtimeProfileState.revisions,
      toolPacks: toolPackState.packs,
      toolPackRevisions: toolPackState.revisions,
      roles,
      speakerQueue: this.normalizeSpeakerQueue(state.speakerQueue),
      chairSuggestions: Array.isArray(state.chairSuggestions)
        ? state.chairSuggestions.map((suggestion) => ({
            ...suggestion,
            transitions: Array.isArray(suggestion.transitions) ? suggestion.transitions : []
          }))
        : [],
      taskAdapterConnectors: Array.isArray(state.taskAdapterConnectors) ? state.taskAdapterConnectors : [],
      mcpConnectors,
      toolRuns: Array.isArray(state.toolRuns)
        ? state.toolRuns.map((run) => ({
            ...run,
            requestFingerprint: run.requestFingerprint ?? "legacy-unverifiable",
            toolSnapshot: snapshotToolRegistration(run.toolName, run.toolSnapshot)
          }))
        : [],
      skills: state.skills.map((skill) => this.normalizeSkill(skill)),
      modelConnectors: state.modelConnectors.map((connector) => ({
        ...connector,
        revision: connector.revision ?? 1,
        secretRevision: connector.secretRevision ?? (connector.hasSecret ? 1 : 0),
        credentialId: connector.credentialId ?? null
      })),
      credentials: Array.isArray(state.credentials) ? state.credentials : [],
      prompts: Array.isArray(state.prompts) ? state.prompts : [],
      threads: state.threads.map((thread) => ({ ...thread, revision: thread.revision ?? 1 })),
      agentTeams: Array.isArray(state.agentTeams)
        ? state.agentTeams.map((team) => ({ ...team, revision: team.revision ?? 1 }))
        : [],
      meetingPresets: Array.isArray(state.meetingPresets)
        ? state.meetingPresets.map((preset) => ({ ...preset, revision: preset.revision ?? 1 }))
        : [],
      participants,
      meetings: state.meetings.map((meeting) => ({
        ...meeting,
        automationRevision: meeting.automationRevision ?? 0,
        closedAt: meeting.closedAt ?? null,
        agenda: this.normalizeMeetingAgenda(meeting.agenda),
        summaryState: meeting.summaryState ?? "not_requested",
        summaryJobId: meeting.summaryJobId ?? null,
        sourceTeamId: meeting.sourceTeamId ?? null,
        sourcePresetId: meeting.sourcePresetId ?? null
      })),
      tasks: state.tasks.map((task) => ({
        ...task,
        revision: task.revision ?? 1,
        boardRevision: taskBoardRevision,
        assigneeAgentId: task.assigneeAgentId ?? null,
        dueAt: task.dueAt ?? null,
        acceptanceCriteria: task.acceptanceCriteria ?? "",
        evidence: Array.isArray(task.evidence) ? task.evidence : [
          { id: `meeting:${task.id}`, type: "meeting" as const, label: "來源會議", reference: task.meetingId, addedBy: "system" as const, createdAt: task.createdAt },
          { id: `decision:${task.id}`, type: "decision" as const, label: "來源決議", reference: task.decisionId, addedBy: "system" as const, createdAt: task.createdAt }
        ],
        executionProfile: task.executionProfile ?? "manual",
        allowedTools: Array.isArray(task.allowedTools) ? task.allowedTools : [],
        dataScope: task.dataScope ?? "",
        approvalState: task.approvalState ?? "not_required",
        execution: normalizeTaskExecution((task as Partial<Task>).execution),
        transitions: Array.isArray(task.transitions) ? task.transitions : [{
          id: `created:${task.id}`,
          type: "created" as const,
          actor: "system" as const,
          at: task.createdAt,
          toStatus: task.status,
          toPosition: task.position,
          note: "Backfilled from a legacy Task."
        }],
        sync: {
          status: task.sync?.status ?? "not_synced",
          adapterId: task.sync?.adapterId ?? null,
          jobId: task.sync?.jobId ?? null,
          requestFingerprint: task.sync?.requestFingerprint ?? null,
          externalId: task.sync?.externalId ?? null,
          attemptCount: task.sync?.attemptCount ?? 0,
          lastAttemptAt: task.sync?.lastAttemptAt ?? null,
          lastError: task.sync?.lastError ?? null,
          syncedAt: task.sync?.syncedAt ?? null
        },
        updatedAt: task.updatedAt ?? task.createdAt
      })) as Task[]
    };
    for (const agent of agents) {
      const recorded = history.agentRevisions?.filter((item) => item.agentId === agent.id) ?? [];
      const revision = this.agentRevisionFromAgent(agent, agent.draftRevision ?? agent.publishedRevision ?? 1, "legacy_backfilled", null, agent.publishedRevision ? runtimeRecordedAt : null);
      const normalized = (recorded.length > 0 ? recorded : [revision]).map((item) => this.normalizeAgentRevision(item, agent.runtimeProfileBinding ?? defaultRuntimeProfileBinding));
      this.agentRevisions.set(agent.id, structuredClone(normalized));
    }
    for (const prompt of this.state.prompts ?? []) {
      this.promptVersions.set(
        prompt.id,
        structuredClone(history.promptVersions?.filter((item) => item.promptId === prompt.id) ?? [])
      );
    }
    for (const secret of history.credentialSecrets ?? []) {
      this.credentialSecrets.set(secret.credentialId, secret.ciphertext);
    }
    for (const secret of history.connectorSecrets ?? []) {
      this.connectorSecrets.set(secret.connectorId, secret.ciphertext);
    }
    for (const admission of history.chairAutomationJobAdmissions ?? []) {
      this.chairAutomationJobAdmissions.set(admission.chairSuggestionId, structuredClone(admission));
    }
    for (const detail of history.goalRuntimeAdmissionDetails ?? []) {
      const goalRun = goalRunSchema.parse(detail.goalRun);
      this.goalRuns.set(goalRun.id, structuredClone(goalRun));
      if (detail.executionContract) {
        const contract = executionContractSchema.parse(detail.executionContract);
        if (contract.goalRunId !== goalRun.id || goalRun.executionContractId !== contract.id) {
          throw new StoreConflictError("Goal Runtime admission Contract does not match its Goal Run.");
        }
        this.goalContracts.set(contract.id, structuredClone(contract));
      }
      for (const candidate of detail.taskBindings) {
        const binding = goalTaskBindingSchema.parse(candidate);
        if (binding.goalRunId !== goalRun.id) {
          throw new StoreConflictError("Goal Runtime admission Task binding does not match its Goal Run.");
        }
        this.goalTaskBindings.set(binding.id, structuredClone(binding));
      }
    }
    this.roleVersions = this.initializeRoleVersions(roles, participants);
  }

  async checkHealth(): Promise<void> {}

  async getSnapshot(): Promise<PlatformSnapshot> {
    return structuredClone(this.state);
  }

  async getViewSnapshot(view: PlatformViewName): Promise<PlatformSnapshot> {
    return projectPlatformView(await this.getSnapshot(), view);
  }

  async getMeetingView(meetingId: string): Promise<MeetingViewSnapshot | null> {
    return projectMeetingView(await this.getSnapshot(), meetingId);
  }

  async appendMeetingRecord(record: MeetingRecord): Promise<MeetingRecord> {
    const parsed = meetingRecordSchema.parse(record);
    return this.withMeetingSummaryMutation(parsed.meetingId, async () => {
      const existing = this.meetingRecordBySourceDigest.get(`${parsed.meetingId}:${parsed.sourceDigest}`)
        ?? this.meetingRecords.get(`${parsed.meetingId}:${parsed.revision}`);
      if (existing) {
        if (!isDeepStrictEqual(existing, parsed)) {
          throw new StoreConflictError("Meeting Record retry conflicts with an immutable persisted record.");
        }
        return structuredClone(existing);
      }
      this.meetingRecords.set(`${parsed.meetingId}:${parsed.revision}`, structuredClone(parsed));
      this.meetingRecordBySourceDigest.set(`${parsed.meetingId}:${parsed.sourceDigest}`, structuredClone(parsed));
      return structuredClone(parsed);
    });
  }

  async getLatestMeetingRecord(meetingId: string): Promise<MeetingRecord | null> {
    const latest = [...this.meetingRecords.values()]
      .filter((record) => record.meetingId === meetingId)
      .sort((left, right) => right.revision - left.revision || right.generatedAt.localeCompare(left.generatedAt))[0];
    return latest ? structuredClone(latest) : null;
  }

  async listMeetingUtterances(
    meetingId: string,
    input: MeetingUtterancePageInput
  ): Promise<MeetingUtterancePage | null> {
    if (!this.state.meetings.some((meeting) => meeting.id === meetingId)) return null;
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new MeetingUtteranceCursorError();
    }
    const rows = this.state.utterances
      .map((utterance, index) => ({ utterance, sequenceNo: BigInt(index + 1) }))
      .filter(({ utterance }) => utterance.meetingId === meetingId)
      .sort((left, right) => left.utterance.createdAt.localeCompare(right.utterance.createdAt)
        || (left.sequenceNo < right.sequenceNo ? -1 : left.sequenceNo > right.sequenceNo ? 1 : 0));
    const cursor = input.cursor ? decodeMeetingUtteranceCursor(input.cursor, meetingId) : null;
    if (cursor && !rows.some(({ utterance, sequenceNo }) => (
      utterance.createdAt === cursor.createdAt && sequenceNo === cursor.sequenceNo
    ))) {
      throw new MeetingUtteranceCursorError();
    }
    const eligible = cursor
      ? rows.filter(({ utterance, sequenceNo }) => utterance.createdAt > cursor.createdAt
        || (utterance.createdAt === cursor.createdAt && sequenceNo > cursor.sequenceNo))
      : rows;
    const pageRows = eligible.slice(0, input.limit);
    const hasMore = eligible.length > input.limit;
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(({ utterance }) => structuredClone(utterance)),
      nextCursor: hasMore && last
        ? encodeMeetingUtteranceCursor(meetingId, last.utterance.createdAt, last.sequenceNo)
        : null
    };
  }

  async getSpeakerQueue(): Promise<SpeakerQueueItem[]> {
    return structuredClone(this.state.speakerQueue);
  }

  async createRuntimeRun(run: RuntimeRun, initialEvent: AppendRuntimeRunEventInput): Promise<RuntimeRun> {
    return this.serializeRuntimeRunMutation(async () => {
      const parsed = runtimeRunSchema.parse(run);
      const existingId = this.runtimeRunByIdempotency.get(parsed.idempotencyKey);
      const existing = this.runtimeRuns.get(parsed.id) ?? (existingId ? this.runtimeRuns.get(existingId) : undefined);
      if (existing) {
        if (!isDeepStrictEqual(existing, parsed)) {
          throw new StoreConflictError("Runtime Run idempotency binding conflicts with an existing run.");
        }
        return structuredClone(existing);
      }
      const event = this.runtimeRunEvent(parsed.id, 1, initialEvent);
      this.runtimeRuns.set(parsed.id, structuredClone(parsed));
      this.runtimeRunByIdempotency.set(parsed.idempotencyKey, parsed.id);
      this.runtimeRunEvents.set(parsed.id, [event]);
      return structuredClone(parsed);
    });
  }

  async getRuntimeRun(id: string): Promise<RuntimeRun | null> {
    const run = this.runtimeRuns.get(id);
    return run ? structuredClone(run) : null;
  }

  async getRuntimeRunForTask(taskId: string): Promise<RuntimeRun | null> {
    const run = [...this.runtimeRuns.values()]
      .filter((candidate) => candidate.taskId === taskId)
      .sort((left, right) => right.attempt - left.attempt || right.queuedAt.localeCompare(left.queuedAt))[0];
    return run ? structuredClone(run) : null;
  }

  async listRuntimeRunsForGoal(goalRunId: string): Promise<RuntimeRun[]> {
    return [...this.runtimeRuns.values()]
      .filter((run) => run.goalRunId === goalRunId)
      .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt) || left.id.localeCompare(right.id))
      .map((run) => structuredClone(run));
  }

  async listRecoverableOmpRuntimeRuns(limit = 1_000): Promise<RuntimeRun[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new RangeError("Runtime recovery limit is invalid.");
    return [...this.runtimeRuns.values()]
      .filter((run) => run.runtimeProfile.harnessKind === "pi"
        && !["completed", "failed", "cancelled", "expired"].includes(run.state))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map((run) => structuredClone(run));
  }

  async updateRuntimeRun(id: string, input: RuntimeRunMutationInput): Promise<RuntimeRun> {
    return this.serializeRuntimeRunMutation(async () => {
      const current = this.requiredRuntimeRun(id);
      const updated = applyRuntimeRunMutation(current, input);
      const events = this.runtimeRunEvents.get(id) ?? [];
      const event = this.runtimeRunEvent(id, events.length + 1, input.event);
      this.runtimeRuns.set(id, structuredClone(updated));
      events.push(event);
      this.runtimeRunEvents.set(id, events);
      return structuredClone(updated);
    });
  }

  async heartbeatRuntimeRun(id: string, input: RuntimeRunHeartbeatInput): Promise<RuntimeRun> {
    return this.serializeRuntimeRunMutation(async () => {
      const current = this.requiredRuntimeRun(id);
      const updated = applyRuntimeRunMutation(current, {
        expectedRevision: input.expectedRevision,
        state: input.state,
        heartbeatAt: input.heartbeatAt,
        eventCursor: input.eventCursor,
        at: input.heartbeatAt
      });
      this.runtimeRuns.set(id, structuredClone(updated));
      return structuredClone(updated);
    });
  }

  async appendRuntimeRunEvent(id: string, input: AppendRuntimeRunEventInput): Promise<RuntimeRunEvent> {
    return this.serializeRuntimeRunMutation(async () => {
      this.requiredRuntimeRun(id);
      const events = this.runtimeRunEvents.get(id) ?? [];
      const event = this.runtimeRunEvent(id, events.length + 1, input);
      events.push(event);
      this.runtimeRunEvents.set(id, events);
      return structuredClone(event);
    });
  }

  async getRuntimeRunEvents(id: string, afterSequence = 0, limit = 100): Promise<RuntimeRunEvent[]> {
    this.requiredRuntimeRun(id);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RangeError("Runtime Run event sequence must be a non-negative integer.");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError("Runtime Run event limit must be between 1 and 500.");
    }
    return structuredClone((this.runtimeRunEvents.get(id) ?? [])
      .filter((event) => event.sequence > afterSequence)
      .slice(0, limit));
  }

  async listGoalRuns(): Promise<GoalRun[]> {
    return [...this.goalRuns.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
      .map((run) => structuredClone(run));
  }

  async getGoalRun(id: string): Promise<GoalRun | null> {
    const run = this.goalRuns.get(id);
    return run ? structuredClone(run) : null;
  }

  async getGoalRunDetail(id: string): Promise<GoalRunDetail | null> {
    const goalRun = this.goalRuns.get(id);
    if (!goalRun) return null;
    return {
      goalRun: structuredClone(goalRun),
      plans: structuredClone(this.goalPlans.get(id) ?? []),
      executionContract: goalRun.executionContractId
        ? structuredClone(this.goalContracts.get(goalRun.executionContractId) ?? null)
        : null,
      taskBindings: [...this.goalTaskBindings.values()]
        .filter((binding) => binding.goalRunId === id)
        .map((binding) => structuredClone(binding)),
      events: structuredClone(this.goalEvents.get(id) ?? []),
      reviewerVerdicts: [...this.reviewerVerdicts.values()]
        .filter((verdict) => verdict.goalRunId === id)
        .map((verdict) => structuredClone(verdict)),
      actionRuns: [...this.actionRuns.values()]
        .filter((run) => run.goalRunId === id)
        .map((run) => structuredClone(run)),
      runtimeRuns: [...this.runtimeRuns.values()]
        .filter((run) => run.goalRunId === id)
        .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt) || left.id.localeCompare(right.id))
        .map((run) => structuredClone(run))
    };
  }

  async createGoalRun(
    run: GoalRun,
    event: AppendGoalEventInput,
    idempotencyKey: string,
    orchestrationAdmission?: GoalJobAdmission
  ): Promise<GoalRun> {
    return this.runIdempotent("goal_run.create", idempotencyKey, goalRunCreateIdempotencyInput(run, event), () => (
      this.serializeGoalMutation(async () => {
        const parsed = goalRunSchema.parse(run);
        if (orchestrationAdmission) {
          assertReservedGoalOrchestrationAdmission(orchestrationAdmission, parsed.id, parsed.id);
          this.assertGoalJobAdmissionAvailable(orchestrationAdmission);
        }
        if (this.goalRuns.has(parsed.id) || [...this.goalRuns.values()].some((item) => item.meetingId === parsed.meetingId)) {
          throw new StoreConflictError("Goal Run already exists for this meeting.");
        }
        const meeting = this.state.meetings.find((item) => item.id === parsed.meetingId);
        if (!meeting || meeting.threadId !== parsed.threadId) {
          throw new StoreConflictError("Goal Run meeting and Topic binding is invalid.");
        }
        this.goalRuns.set(parsed.id, structuredClone(parsed));
        this.goalPlans.set(parsed.id, []);
        if (orchestrationAdmission) {
          this.goalJobAdmissions.set(
            orchestrationAdmission.jobId,
            structuredClone(normalizeGoalJobAdmission(orchestrationAdmission))
          );
        }
        await this.appendGoalEventRecord(parsed.id, event);
        await this.recordAudit("goal_run.created", "goal_run", parsed.id, {
          threadId: parsed.threadId,
          meetingId: parsed.meetingId,
          state: parsed.state
        });
        return structuredClone(parsed);
      })
    ));
  }

  async saveGoalPlan(id: string, input: GoalPlanMutationInput): Promise<GoalRunDetail> {
    return this.serializeGoalMutation(async () => {
      const run = this.requiredGoalRun(id);
      this.assertGoalRevision(run, input.expectedRevision);
      if (run.executionContractId !== null && run.state !== "paused") {
        throw new StoreConflictError("An approved Goal Plan must be paused before a new revision is created.");
      }
      if (!["planning", "awaiting_approval", "replanning", "paused"].includes(run.state)) {
        throw new StoreConflictError("Goal Run is not in a state that permits Plan revision.");
      }
      if (run.activePlanRevision !== input.expectedPlanRevision) {
        throw new StoreConflictError("Goal Plan revision changed.", "revision", "GOAL_PLAN_REVISION_CONFLICT");
      }
      const plan = goalPlanRevisionSchema.parse(input.plan);
      if (plan.goalRunId !== id || plan.revision !== input.expectedPlanRevision + 1 || plan.status !== "draft") {
        throw new StoreConflictError("Goal Plan identity or revision is invalid.");
      }
      assertGoalPlanDecisionBindings(run, plan, this.state);
      const plans = this.goalPlans.get(id) ?? [];
      const previousPlan = plans.find((candidate) => candidate.revision === input.expectedPlanRevision) ?? null;
      if (input.event.actorType === "owner" && previousPlan
        && JSON.stringify(plan.plannerProvenance ?? null) !== JSON.stringify(previousPlan.plannerProvenance ?? null)) {
        throw new StoreConflictError("Owner Plan revisions must retain immutable Planner provenance.");
      }
      if (input.event.actorType === "agent"
        && (!plan.plannerProvenance || input.event.actorId !== plan.plannerProvenance.plannerAgentId)) {
        throw new StoreConflictError("Agent-authored Goal Plans require matching immutable Planner provenance.");
      }
      if (plan.plannerProvenance) assertGoalPlannerProvenance(run, plan.plannerProvenance, this.state);
      for (const existing of plans) {
        if (existing.status === "draft") existing.status = "superseded";
      }
      plans.push(structuredClone(plan));
      this.goalPlans.set(id, plans);
      Object.assign(run, {
        state: "awaiting_approval" as const,
        activePlanRevision: plan.revision,
        executionContractId: null,
        pausedFromState: null,
        terminalReason: null,
        revision: run.revision + 1,
        updatedAt: new Date().toISOString()
      });
      await this.appendGoalEventRecord(id, input.event);
      await this.recordAudit("goal_plan.created", "goal_run", id, {
        planRevision: plan.revision,
        planDigest: plan.digest,
        taskCount: plan.tasks.length
      });
      return (await this.getGoalRunDetail(id))!;
    });
  }

  async approveGoalRun(id: string, input: GoalApprovalMutationInput): Promise<GoalRunDetail> {
    return this.serializeGoalMutation(async () => {
      const run = this.requiredGoalRun(id);
      this.assertGoalRevision(run, input.expectedRevision);
      if (run.state !== "awaiting_approval" || run.executionContractId !== null) {
        throw new StoreConflictError("Goal Run is not awaiting its one-time approval.");
      }
      const contract = executionContractSchema.parse(input.contract);
      assertExecutionActionBindings(contract);
      const orchestrationAdmission = input.orchestrationAdmission;
      if (orchestrationAdmission) {
        assertReservedGoalOrchestrationAdmission(orchestrationAdmission, id, id);
        this.assertGoalJobAdmissionAvailable(orchestrationAdmission);
      }
      const plans = this.goalPlans.get(id) ?? [];
      const plan = plans.find((item) => item.revision === contract.planRevision);
      if (!plan || plan.digest !== contract.planDigest || contract.goalRunId !== id) {
        throw new StoreConflictError("Execution Contract does not match the current Goal Plan.");
      }
      if (contract.planRevision !== run.activePlanRevision) {
        throw new StoreConflictError("Execution Contract targets a stale Goal Plan.", "revision", "GOAL_PLAN_REVISION_CONFLICT");
      }
      if (input.bindings.length !== plan.tasks.length) {
        throw new StoreConflictError("Every Goal Plan task requires exactly one durable binding.");
      }
      const parsedBindings = input.bindings.map((binding) => goalTaskBindingSchema.parse(binding));
      const planTaskIds = new Set(plan.tasks.map((task) => task.id));
      if (new Set(parsedBindings.map((binding) => binding.planTaskId)).size !== plan.tasks.length
        || parsedBindings.some((binding) => (
          binding.goalRunId !== id
          || binding.planRevision !== plan.revision
          || !planTaskIds.has(binding.planTaskId)
        ))) {
        throw new StoreConflictError("Goal task bindings do not match the approved Plan.");
      }
      assertGoalPlanDecisionBindings(run, plan, this.state);
      const bindingByPlanTaskId = new Map(parsedBindings.map((binding) => [binding.planTaskId, binding]));
      for (const planTask of plan.tasks) {
        const binding = bindingByPlanTaskId.get(planTask.id)!;
        const canonicalTask = this.state.tasks.find((candidate) => candidate.decisionId === planTask.decisionId) ?? null;
        if (binding.taskId !== null && binding.taskId !== canonicalTask?.id) {
          throw new StoreConflictError("Goal task binding references a different canonical Task.");
        }
      }
      for (const planTask of plan.tasks) {
        const decision = this.required(this.state.decisions, planTask.decisionId, "Decision");
        if (decision.status === "proposed") await this.setDecisionStatus(decision.id, "approved");
        let task = this.state.tasks.find((candidate) => candidate.decisionId === decision.id) ?? null;
        if (!task) task = await this.createTask(goalPlanTaskCreateInput(planTask));
        if (task.executionProfile === "worker" && task.approvalState === "pending") {
          task = await this.setTaskApproval(task.id, {
            expectedExecutionRevision: task.execution.revision,
            action: "approve"
          });
        }
        const binding = bindingByPlanTaskId.get(planTask.id)!;
        if (binding.taskId !== null && binding.taskId !== task.id) {
          throw new StoreConflictError("Goal task binding references a different canonical Task.");
        }
        binding.taskId = task.id;
      }
      plan.status = "approved";
      this.goalContracts.set(contract.id, structuredClone(contract));
      for (const binding of parsedBindings) {
        this.goalTaskBindings.set(binding.id, structuredClone(binding));
        const planTask = plan.tasks.find((task) => task.id === binding.planTaskId)!;
        await this.appendGoalEventRecord(id, {
          type: "task.bound",
          actorType: "system",
          actorId: null,
          entityType: "task",
          entityId: binding.taskId!,
          summary: "Goal Plan task bound to its canonical Meeting Task.",
          detail: {
            planTaskId: binding.planTaskId,
            decisionId: planTask.decisionId,
            taskId: binding.taskId
          }
        });
      }
      Object.assign(run, {
        state: "executing" as const,
        executionContractId: contract.id,
        revision: run.revision + 1,
        updatedAt: new Date().toISOString()
      });
      await this.appendGoalEventRecord(id, input.event);
      await this.recordAudit("goal_contract.approved", "goal_run", id, {
        planRevision: contract.planRevision,
        planDigest: contract.planDigest,
        contractDigest: contract.contractDigest,
        approvedBy: contract.approvedBy
      });
      if (orchestrationAdmission) {
        this.goalJobAdmissions.set(
          orchestrationAdmission.jobId,
          structuredClone(normalizeGoalJobAdmission(orchestrationAdmission))
        );
      }
      return (await this.getGoalRunDetail(id))!;
    });
  }

  async setGoalRunState(id: string, input: GoalRunStateMutationInput): Promise<GoalRun> {
    return this.serializeGoalMutation(async () => {
      const run = this.requiredGoalRun(id);
      this.assertGoalRevision(run, input.expectedRevision);
      const goalActionRuns = [...this.actionRuns.values()].filter((candidate) => candidate.goalRunId === id);
      if (input.state === "cancelled" && goalActionRuns.some((candidate) => (
        goalCancellationBlockingActionStates.includes(candidate.state as (typeof goalCancellationBlockingActionStates)[number])
      ))) {
        throw new StoreConflictError(
          "The Goal cannot be cancelled while an Action has an active or unknown external outcome.",
          "business_rule",
          "GOAL_ACTION_RECONCILIATION_REQUIRED"
        );
      }
      if (input.orchestrationAdmission) {
        assertReservedGoalOrchestrationAdmission(input.orchestrationAdmission, id, id);
        this.assertGoalJobAdmissionAvailable(input.orchestrationAdmission);
      }
      let cancelledTaskCount = 0;
      let cancelledActionCount = 0;
      if (input.state === "cancelled") {
        const updatedAt = new Date().toISOString();
        const bindings = [...this.goalTaskBindings.values()]
          .filter((candidate) => candidate.goalRunId === id && goalCancellationTaskStates.includes(
            candidate.state as (typeof goalCancellationTaskStates)[number]
          ))
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
        for (const binding of bindings) {
          const updated = goalTaskBindingSchema.parse({
            ...binding,
            state: "cancelled",
            activeJobId: null,
            updatedAt
          });
          this.goalTaskBindings.set(binding.id, updated);
          await this.appendGoalEventRecord(id, {
            type: "task.state.changed",
            actorType: input.event.actorType,
            actorId: input.event.actorId,
            entityType: "task",
            entityId: binding.taskId ?? binding.planTaskId,
            summary: "Goal task cancelled because its Goal Run was cancelled.",
            detail: {
              bindingId: binding.id,
              planTaskId: binding.planTaskId,
              taskId: binding.taskId,
              fromState: binding.state,
              toState: "cancelled",
              reason: "goal_cancelled"
            },
            ...(input.event.occurredAt ? { occurredAt: input.event.occurredAt } : {})
          });
        }
        cancelledTaskCount = bindings.length;

        const actions = goalActionRuns
          .filter((candidate) => goalCancellationActionStates.includes(
            candidate.state as (typeof goalCancellationActionStates)[number]
          ))
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
        for (const actionRun of actions) {
          const updated = actionRunSchema.parse({ ...actionRun, state: "cancelled", updatedAt });
          this.actionRuns.set(actionRun.id, updated);
          await this.appendGoalEventRecord(id, {
            type: "action.state.changed",
            actorType: input.event.actorType,
            actorId: input.event.actorId,
            entityType: "action",
            entityId: actionRun.id,
            summary: "Action Run cancelled before external write admission because its Goal Run was cancelled.",
            detail: {
              actionRunId: actionRun.id,
              planTaskId: actionRun.planTaskId,
              fromState: actionRun.state,
              toState: "cancelled",
              reason: "goal_cancelled"
            },
            ...(input.event.occurredAt ? { occurredAt: input.event.occurredAt } : {})
          });
        }
        cancelledActionCount = actions.length;
      }
      Object.assign(run, {
        state: input.state,
        pausedFromState: input.pausedFromState === undefined ? run.pausedFromState : input.pausedFromState,
        terminalReason: input.terminalReason === undefined ? run.terminalReason : input.terminalReason,
        usage: input.usage === undefined ? run.usage : structuredClone(input.usage),
        revision: run.revision + 1,
        updatedAt: new Date().toISOString()
      });
      await this.appendGoalEventRecord(id, input.event);
      await this.recordAudit("goal_run.state.changed", "goal_run", id, {
        state: run.state,
        revision: run.revision,
        terminalReason: run.terminalReason,
        cancelledTaskCount,
        cancelledActionCount
      });
      if (input.orchestrationAdmission) {
        this.goalJobAdmissions.set(
          input.orchestrationAdmission.jobId,
          structuredClone(normalizeGoalJobAdmission(input.orchestrationAdmission))
        );
      }
      return structuredClone(run);
    });
  }

  async appendGoalEvent(id: string, input: AppendGoalEventInput): Promise<GoalEvent> {
    return this.serializeGoalMutation(() => this.appendGoalEventRecord(id, input));
  }

  async getGoalEvents(id: string, afterSequence = 0, limit = 500): Promise<GoalEvent[]> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new RangeError("Goal event sequence must be non-negative.");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError("Goal event limit must be between 1 and 500.");
    if (!this.goalRuns.has(id)) throw new StoreNotFoundError("Goal Run was not found.");
    return structuredClone((this.goalEvents.get(id) ?? []).filter((event) => event.sequence > afterSequence).slice(0, limit));
  }

  async updateGoalTaskBinding(id: string, input: GoalTaskBindingMutationInput): Promise<GoalTaskBinding> {
    return this.serializeGoalMutation(async () => {
      const binding = this.goalTaskBindings.get(id);
      if (!binding) throw new StoreNotFoundError("Goal task binding was not found.");
      if (binding.state !== input.expectedState) throw new StoreConflictError("Goal task binding state changed.", "revision", "GOAL_TASK_STATE_CONFLICT");
      const updated = goalTaskBindingSchema.parse({
        ...binding,
        state: input.state,
        activeJobId: input.activeJobId === undefined ? binding.activeJobId : input.activeJobId,
        attemptCount: input.attemptCount === undefined ? binding.attemptCount : input.attemptCount,
        taskId: input.taskId === undefined ? binding.taskId : input.taskId,
        lastError: input.lastError === undefined ? binding.lastError : input.lastError,
        updatedAt: new Date().toISOString()
      });
      this.goalTaskBindings.set(id, updated);
      await this.appendGoalEventRecord(binding.goalRunId, input.event);
      return structuredClone(updated);
    });
  }

  async claimGoalTaskDispatch(input: GoalTaskDispatchClaimInput): Promise<GoalTaskDispatchClaimResult> {
    const occurredAt = input.now ?? new Date().toISOString();
    const now = Date.parse(occurredAt);
    if (!Number.isFinite(now)) throw new RangeError("Goal task dispatch claim time is invalid.");
    if (!Number.isSafeInteger(input.expectedAttemptCount) || input.expectedAttemptCount < 0) {
      throw new RangeError("Goal task dispatch attempt count is invalid.");
    }
    const increments = input.usageIncrements;
    if (Object.values(increments).some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new RangeError("Goal task dispatch usage increments must be non-negative integers.");
    }
    const parsedActionRun = input.action ? actionRunSchema.parse(input.action.actionRun) : null;

    return this.serializeGoalMutation(async () => {
      const goalRun = this.requiredGoalRun(input.goalRunId);
      if (goalRun.state !== "executing") {
        return { status: "contended", reason: "Goal Run is no longer executing." };
      }
      if (goalRun.activePlanRevision !== input.planRevision) {
        return { status: "contended", reason: "Goal Plan revision changed before task dispatch." };
      }
      const contract = goalRun.executionContractId ? this.goalContracts.get(goalRun.executionContractId) : null;
      if (!contract || contract.contractDigest !== input.contractDigest || contract.planRevision !== input.planRevision) {
        return { status: "rejected", reason: "Execution Contract identity changed before task dispatch." };
      }
      const contractTask = contract.planSnapshot.find((candidate) => candidate.id === input.planTaskId);
      if (!contractTask) {
        return { status: "rejected", reason: "Execution Contract task identity changed before dispatch." };
      }
      const binding = this.goalTaskBindings.get(input.bindingId);
      if (!binding) throw new StoreNotFoundError("Goal task binding was not found.");
      if (binding.goalRunId !== goalRun.id
        || binding.planRevision !== input.planRevision
        || binding.planTaskId !== input.planTaskId
        || binding.taskId !== input.taskId) {
        return { status: "rejected", reason: "Goal task binding identity changed before dispatch." };
      }
      if (binding.state !== "ready" || binding.attemptCount !== input.expectedAttemptCount) {
        return { status: "contended", reason: "Goal task dispatch was already claimed or superseded." };
      }
      if (binding.attemptCount >= goalRun.limits.maxAttemptsPerTask) {
        return { status: "rejected", reason: "Goal task exhausted its bounded execution attempts." };
      }
      const runningCount = [...this.goalTaskBindings.values()].filter((candidate) => (
        candidate.goalRunId === goalRun.id
        && candidate.planRevision === input.planRevision
        && candidate.state === "running"
      )).length;
      if (runningCount >= goalRun.limits.maxConcurrentTasks) {
        return { status: "contended", reason: "Goal task concurrency capacity is already occupied." };
      }
      const budgetReason = goalBudgetReservationFailureReason({
        limits: goalRun.limits,
        usage: goalRun.usage,
        increments,
        deadlineAt: goalRun.deadlineAt,
        now
      });
      if (budgetReason) return { status: "rejected", reason: budgetReason };

      let actionRun: ActionRun | null = null;
      let jobAdmission: GoalJobAdmission | null = null;
      if (input.action && parsedActionRun) {
        if (input.taskAgentJob || increments.actionCalls !== 1 || increments.taskAttempts !== 0 || increments.modelCalls !== 0) {
          return { status: "rejected", reason: "Action dispatch usage reservation is invalid." };
        }
        if (parsedActionRun.goalRunId !== goalRun.id
          || parsedActionRun.planTaskId !== binding.planTaskId
          || parsedActionRun.contractDigest !== contract.contractDigest
          || parsedActionRun.state !== "approved") {
          return { status: "rejected", reason: "Action Run identity is invalid for task dispatch." };
        }
        const approvedAction = contractTask.executionMode === "action" ? contractTask.action : null;
        const approvedBinding = contract.actionBindings.find((candidate) => candidate.planTaskId === contractTask.id);
        const expectedFingerprint = requestFingerprint({
          goalRunId: goalRun.id,
          planTaskId: contractTask.id,
          contractDigest: contract.contractDigest,
          adapterCatalogRevision: approvedBinding?.adapterCatalogRevision,
          action: approvedAction
        });
        if (!approvedAction || !approvedBinding
          || parsedActionRun.adapterId !== approvedAction.adapterId
          || parsedActionRun.adapterId !== approvedBinding.adapterId
          || parsedActionRun.adapterCatalogRevision !== approvedBinding.adapterCatalogRevision
          || parsedActionRun.actionKey !== approvedAction.actionKey
          || parsedActionRun.targetId !== approvedAction.targetId
          || requestFingerprint(parsedActionRun.inputs) !== requestFingerprint(approvedAction.inputs)
          || parsedActionRun.requestFingerprint !== expectedFingerprint) {
          return { status: "rejected", reason: "Action Run does not match the immutable Execution Contract snapshot." };
        }
        const adapter = this.actionAdapters.get(parsedActionRun.adapterId);
        const catalogEntry = adapter?.actions.find((candidate) => (
          candidate.key === approvedAction.actionKey
          && candidate.targetIds.includes(approvedAction.targetId)
          && candidate.riskClass === approvedAction.riskClass
          && Object.keys(approvedAction.inputs).every((key) => candidate.inputKeys.includes(key))
        ));
        if (!adapter
          || !adapter.enabled
          || adapter.catalogRevision !== parsedActionRun.adapterCatalogRevision
          || adapter.credentialId !== approvedBinding.credentialId
          || actionAdapterEndpointDigest(adapter.baseUrl) !== approvedBinding.endpointDigest
          || !catalogEntry) {
          return { status: "rejected", reason: "Action Adapter is disabled or its catalog changed." };
        }
        const targetOccupied = [...this.goalTaskBindings.values()].some((candidate) => (
          candidate.id !== binding.id
          && candidate.goalRunId === goalRun.id
          && candidate.planRevision === input.planRevision
          && candidate.state === "running"
          && [...this.actionRuns.values()].some((run) => (
            run.goalRunId === goalRun.id
            && run.planTaskId === candidate.planTaskId
            && run.contractDigest === contract.contractDigest
            && run.adapterId === parsedActionRun.adapterId
            && run.targetId === parsedActionRun.targetId
          ))
        ));
        if (targetOccupied) {
          return { status: "contended", reason: "Another Action is already running against the same approved Adapter target." };
        }
        const requestedAdmission = input.action.jobAdmission;
        const expectedAdmissionFingerprint = [
          goalRun.id,
          binding.planTaskId,
          parsedActionRun.id,
          contract.contractDigest
        ].join(":");
        if (requestedAdmission.jobId !== input.jobId
          || requestedAdmission.goalRunId !== goalRun.id
          || requestedAdmission.jobName !== "goal-action-run"
          || requestedAdmission.entityId !== parsedActionRun.id
          || requestedAdmission.requestFingerprint !== expectedAdmissionFingerprint
          || requestedAdmission.state !== "reserved"
          || (requestedAdmission.dispatchToken ?? null) !== null
          || (requestedAdmission.dispatchLeaseExpiresAt ?? null) !== null) {
          return { status: "rejected", reason: "Goal Action job admission identity is invalid." };
        }
        const existingAdmission = this.goalJobAdmissions.get(requestedAdmission.jobId);
        if (existingAdmission && (
          existingAdmission.goalRunId !== requestedAdmission.goalRunId
          || existingAdmission.jobName !== requestedAdmission.jobName
          || existingAdmission.entityId !== requestedAdmission.entityId
          || existingAdmission.requestFingerprint !== requestedAdmission.requestFingerprint
          || existingAdmission.state !== "reserved"
        )) {
          return { status: "rejected", reason: "Goal Action job admission is already bound to another execution." };
        }
        const existingAction = [...this.actionRuns.values()].find((candidate) => (
          candidate.goalRunId === goalRun.id
          && candidate.planTaskId === binding.planTaskId
          && candidate.contractDigest === contract.contractDigest
        ));
        if (existingAction) {
          if (existingAction.id !== parsedActionRun.id
            || existingAction.requestFingerprint !== parsedActionRun.requestFingerprint
            || existingAction.contractDigest !== parsedActionRun.contractDigest
            || existingAction.state !== "approved") {
            return { status: "rejected", reason: "Existing Action Run does not match the approved dispatch request." };
          }
          actionRun = existingAction;
        } else {
          this.actionRuns.set(parsedActionRun.id, structuredClone(parsedActionRun));
          actionRun = parsedActionRun;
          await this.appendGoalEventRecord(goalRun.id, input.action.actionEvent);
        }
        if (existingAdmission) {
          jobAdmission = normalizeGoalJobAdmission(existingAdmission);
        } else {
          const normalizedAdmission = normalizeGoalJobAdmission(requestedAdmission);
          this.goalJobAdmissions.set(requestedAdmission.jobId, structuredClone(normalizedAdmission));
          jobAdmission = normalizedAdmission;
        }
      } else if (increments.taskAttempts !== 1
        || increments.modelCalls !== 1
        || increments.actionCalls !== 0
        || !input.taskId
        || !["worker", "advisor"].includes(contractTask.executionMode)
        || !contractTask.assigneeAgentId
        || !canonicalTaskMatchesGoalDispatch(
          this.state.tasks.find((candidate) => candidate.id === input.taskId),
          input
        )) {
        return { status: "rejected", reason: "Task Agent dispatch usage or canonical Task identity is invalid." };
      }

      const updatedRun = goalRunSchema.parse({
        ...goalRun,
        usage: {
          ...goalRun.usage,
          taskAttempts: goalRun.usage.taskAttempts + increments.taskAttempts,
          modelCalls: goalRun.usage.modelCalls + increments.modelCalls,
          actionCalls: goalRun.usage.actionCalls + increments.actionCalls
        },
        revision: goalRun.revision + 1,
        updatedAt: occurredAt
      });
      const updatedBinding = goalTaskBindingSchema.parse({
        ...binding,
        state: "running",
        activeJobId: input.jobId,
        attemptCount: binding.attemptCount + 1,
        lastError: null,
        updatedAt: occurredAt
      });
      this.goalRuns.set(goalRun.id, updatedRun);
      this.goalTaskBindings.set(binding.id, updatedBinding);
      await this.appendGoalEventRecord(goalRun.id, input.budgetEvent);
      await this.appendGoalEventRecord(goalRun.id, input.bindingEvent);
      await this.recordAudit("goal_task.dispatch.claimed", "goal_run", goalRun.id, {
        planRevision: input.planRevision,
        planTaskId: input.planTaskId,
        bindingId: binding.id,
        jobId: input.jobId,
        attemptCount: updatedBinding.attemptCount,
        usageIncrements: increments,
        actionRunId: actionRun?.id ?? null
      });
      return {
        status: "claimed",
        goalRun: structuredClone(updatedRun),
        taskBinding: structuredClone(updatedBinding),
        actionRun: actionRun ? structuredClone(actionRun) : null,
        jobAdmission: jobAdmission ? structuredClone(jobAdmission) : null
      };
    });
  }

  async addReviewerVerdict(verdict: ReviewerVerdict, event: AppendGoalEventInput): Promise<ReviewerVerdict> {
    return this.serializeGoalMutation(async () => {
      const parsed = reviewerVerdictSchema.parse(verdict);
      this.requiredGoalRun(parsed.goalRunId);
      if (parsed.reviewJobId !== null) {
        const admission = this.goalJobAdmissions.get(parsed.reviewJobId);
        if (!admission
          || admission.goalRunId !== parsed.goalRunId
          || admission.jobName !== "goal-review"
          || admission.entityId !== `${parsed.scope}:${parsed.scopeId}:${parsed.reviewerAgentId}`
          || admission.requestFingerprint !== parsed.reviewRequestFingerprint) {
          throw new StoreConflictError("Reviewer verdict does not match its durable Goal Review admission.");
        }
      }
      const key = `${parsed.goalRunId}:${parsed.scope}:${parsed.scopeId}:${parsed.reviewerAgentId}:${parsed.contractDigest}`;
      const existing = this.reviewerVerdicts.get(key);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(parsed)) throw new StoreConflictError("Reviewer already submitted a different verdict.");
        return structuredClone(existing);
      }
      this.reviewerVerdicts.set(key, structuredClone(parsed));
      await this.appendGoalEventRecord(parsed.goalRunId, event);
      await this.recordAudit("goal_review.recorded", "goal_run", parsed.goalRunId, {
        scope: parsed.scope,
        scopeId: parsed.scopeId,
        reviewerAgentId: parsed.reviewerAgentId,
        modelConnectorId: parsed.modelConnectorId,
        verdict: parsed.verdict,
        contractDigest: parsed.contractDigest,
        reviewJobId: parsed.reviewJobId
      });
      return structuredClone(parsed);
    });
  }

  async createActionAdapter(adapter: ActionAdapter): Promise<ActionAdapter> {
    return this.serializeGoalMutation(async () => {
      const parsed = actionAdapterSchema.parse(adapter);
      if (this.actionAdapters.has(parsed.id) || [...this.actionAdapters.values()].some((item) => item.name === parsed.name)) {
        throw new StoreConflictError("Action Adapter already exists.");
      }
      this.actionAdapters.set(parsed.id, structuredClone(parsed));
      await this.recordAudit("action_adapter.created", "action_adapter", parsed.id, {
        kind: parsed.kind,
        enabled: parsed.enabled,
        catalogRevision: parsed.catalogRevision,
        actionCount: parsed.actions.length
      });
      return structuredClone(parsed);
    });
  }

  async listActionAdapters(): Promise<ActionAdapter[]> {
    return [...this.actionAdapters.values()].map((adapter) => structuredClone(adapter));
  }

  async createActionRun(run: ActionRun, event: AppendGoalEventInput): Promise<ActionRun> {
    return this.serializeGoalMutation(async () => {
      const parsed = actionRunSchema.parse(run);
      this.requiredGoalRun(parsed.goalRunId);
      const adapter = this.actionAdapters.get(parsed.adapterId);
      if (!adapter || !adapter.enabled || adapter.catalogRevision !== parsed.adapterCatalogRevision) {
        throw new StoreConflictError("Action Adapter is disabled or its catalog changed.");
      }
      if (this.actionRuns.has(parsed.id) || [...this.actionRuns.values()].some((item) => item.requestFingerprint === parsed.requestFingerprint)) {
        throw new StoreConflictError("Action Run request already exists.");
      }
      this.actionRuns.set(parsed.id, structuredClone(parsed));
      await this.appendGoalEventRecord(parsed.goalRunId, event);
      return structuredClone(parsed);
    });
  }

  async updateActionRun(id: string, input: ActionRunMutationInput): Promise<ActionRun> {
    return this.serializeGoalMutation(async () => {
      const run = this.actionRuns.get(id);
      if (!run) throw new StoreNotFoundError("Action Run was not found.");
      if (run.state !== input.expectedState) throw new StoreConflictError("Action Run state changed.", "revision", "ACTION_RUN_STATE_CONFLICT");
      const updated = actionRunSchema.parse({
        ...run,
        state: input.state,
        externalExecutionId: input.externalExecutionId === undefined ? run.externalExecutionId : input.externalExecutionId,
        verificationSummary: input.verificationSummary === undefined ? run.verificationSummary : input.verificationSummary,
        lastError: input.lastError === undefined ? run.lastError : input.lastError,
        updatedAt: new Date().toISOString()
      });
      this.actionRuns.set(id, updated);
      await this.appendGoalEventRecord(run.goalRunId, input.event);
      return structuredClone(updated);
    });
  }

  async admitGoalActionExecution(
    id: string,
    input: GoalActionExecutionAdmissionInput
  ): Promise<GoalActionExecutionAdmissionResult> {
    return this.serializeGoalMutation(async () => {
      const actionRun = this.actionRuns.get(id);
      if (!actionRun) throw new StoreNotFoundError("Action Run was not found.");
      const goalRun = this.requiredGoalRun(input.goalRunId);
      const now = Date.parse(input.now ?? new Date().toISOString());
      if (!Number.isFinite(now)) throw new RangeError("Goal Action admission time is invalid.");
      if (actionRun.goalRunId !== goalRun.id || actionRun.planTaskId !== input.planTaskId) {
        return { status: "rejected", reason: "Action Run identity no longer matches the queued Goal task." };
      }
      if (goalRun.state !== "executing") {
        return { status: "rejected", reason: "Goal Run is not executing." };
      }
      const budgetReason = goalBudgetFailureReason({
        limits: goalRun.limits,
        usage: goalRun.usage,
        deadlineAt: goalRun.deadlineAt,
        now
      });
      if (budgetReason) return { status: "rejected", reason: budgetReason };
      const contract = goalRun.executionContractId ? this.goalContracts.get(goalRun.executionContractId) : null;
      if (!contract || contract.contractDigest !== input.contractDigest || actionRun.contractDigest !== input.contractDigest) {
        return { status: "rejected", reason: "Execution Contract identity changed before Action admission." };
      }
      const contractTask = contract.planSnapshot.find((candidate) => candidate.id === input.planTaskId);
      const approvedAction = contractTask?.executionMode === "action" ? contractTask.action : null;
      const approvedBinding = contract.actionBindings.find((candidate) => candidate.planTaskId === input.planTaskId);
      const expectedFingerprint = requestFingerprint({
        goalRunId: goalRun.id,
        planTaskId: input.planTaskId,
        contractDigest: contract.contractDigest,
        adapterCatalogRevision: approvedBinding?.adapterCatalogRevision,
        action: approvedAction
      });
      const adapter = approvedAction ? this.actionAdapters.get(approvedAction.adapterId) : null;
      const catalogEntry = adapter && approvedAction ? adapter.actions.find((candidate) => (
        candidate.key === approvedAction.actionKey
        && candidate.targetIds.includes(approvedAction.targetId)
        && candidate.riskClass === approvedAction.riskClass
        && Object.keys(approvedAction.inputs).every((key) => candidate.inputKeys.includes(key))
      )) : null;
      const approvedCredential = approvedBinding?.credentialId
        ? (this.state.credentials ?? []).find((candidate) => candidate.id === approvedBinding.credentialId)
        : null;
      const credentialMatches = approvedBinding?.credentialId === null
        ? adapter?.credentialId === null && approvedBinding.credentialSecretRevision === null
        : Boolean(approvedCredential
          && approvedCredential.status === "active"
          && approvedCredential.hasSecret
          && approvedCredential.secretRevision === approvedBinding?.credentialSecretRevision
          && (approvedCredential.expiresAt === null || Date.parse(approvedCredential.expiresAt) > now));
      if (!approvedAction || !approvedBinding || !adapter || !adapter.enabled || !catalogEntry
        || actionRun.adapterId !== approvedAction.adapterId
        || actionRun.adapterId !== approvedBinding.adapterId
        || actionRun.adapterCatalogRevision !== approvedBinding.adapterCatalogRevision
        || actionRun.actionKey !== approvedAction.actionKey
        || actionRun.targetId !== approvedAction.targetId
        || requestFingerprint(actionRun.inputs) !== requestFingerprint(approvedAction.inputs)
        || actionRun.requestFingerprint !== expectedFingerprint
        || adapter.catalogRevision !== approvedBinding.adapterCatalogRevision
        || adapter.credentialId !== approvedBinding.credentialId
        || actionAdapterEndpointDigest(adapter.baseUrl) !== approvedBinding.endpointDigest
        || !credentialMatches) {
        return { status: "rejected", reason: "Action Run no longer matches the immutable Execution Contract and Adapter binding." };
      }
      const binding = [...this.goalTaskBindings.values()].find((candidate) => (
        candidate.goalRunId === goalRun.id
        && candidate.planRevision === goalRun.activePlanRevision
        && candidate.planTaskId === input.planTaskId
      ));
      if (!binding) return { status: "rejected", reason: "Goal task binding is unavailable for Action admission." };

      const actionStateEligible = input.phase === "preview"
        ? actionRun.state === "approved" || actionRun.state === "reserved"
        : actionRun.state === "reserved";
      if (!actionStateEligible) {
        return { status: "rejected", reason: `Action Run is not eligible for ${input.phase} admission.` };
      }
      if (input.phase === "preview") {
        if (binding.state === "ready") {
          const updatedBinding = goalTaskBindingSchema.parse({
            ...binding,
            state: "running",
            activeJobId: input.jobId,
            updatedAt: new Date(now).toISOString()
          });
          this.goalTaskBindings.set(binding.id, updatedBinding);
          await this.appendGoalEventRecord(goalRun.id, input.bindingEvent);
        } else if (binding.state !== "running" || binding.activeJobId !== input.jobId) {
          return { status: "rejected", reason: "Action task is not owned by the queued Goal job." };
        }
      } else if (binding.state !== "running" || binding.activeJobId !== input.jobId) {
        return { status: "rejected", reason: "Action task execution ownership changed before the external effect boundary." };
      }

      const currentBinding = this.goalTaskBindings.get(binding.id)!;
      const actionNeedsTransition = input.phase === "execute" || actionRun.state === "approved";
      const updatedActionRun = actionNeedsTransition
        ? actionRunSchema.parse({
          ...actionRun,
          state: input.phase === "preview" ? "reserved" : "running",
          updatedAt: new Date(now).toISOString()
        })
        : actionRun;
      if (actionNeedsTransition) {
        this.actionRuns.set(id, updatedActionRun);
        await this.appendGoalEventRecord(goalRun.id, input.event);
        await this.recordAudit("goal_action.execution.admitted", "action_run", id, {
          goalRunId: goalRun.id,
          planTaskId: input.planTaskId,
          jobId: input.jobId,
          phase: input.phase,
          contractDigest: input.contractDigest
        });
      }
      return {
        status: "admitted",
        actionRun: structuredClone(updatedActionRun),
        taskBinding: structuredClone(currentBinding)
      };
    });
  }

  async reserveGoalJob(admission: GoalJobAdmission): Promise<GoalJobAdmission> {
    return this.serializeGoalMutation(async () => {
      this.requiredGoalRun(admission.goalRunId);
      if (admission.state === "dispatching") {
        throw new StoreConflictError("Goal job dispatching state must be entered through a dispatch lease claim.");
      }
      if ((admission.dispatchToken ?? null) !== null || (admission.dispatchLeaseExpiresAt ?? null) !== null) {
        throw new StoreConflictError("Goal job dispatch lease fields require dispatching state.");
      }
      const existing = this.assertGoalJobAdmissionAvailable(admission);
      if (existing) return structuredClone(normalizeGoalJobAdmission(existing));
      const normalized = normalizeGoalJobAdmission(admission);
      this.goalJobAdmissions.set(admission.jobId, structuredClone(normalized));
      return structuredClone(normalized);
    });
  }

  async reserveGoalReviewJob(admission: GoalJobAdmission, data: GoalReviewJobData): Promise<GoalJobAdmission> {
    return this.serializeGoalMutation(async () => {
      this.requiredGoalRun(admission.goalRunId);
      const parsed = assertGoalReviewJobAdmission(admission, data);
      if (admission.state === "dispatching") {
        throw new StoreConflictError("Goal job dispatching state must be entered through a dispatch lease claim.");
      }
      if ((admission.dispatchToken ?? null) !== null || (admission.dispatchLeaseExpiresAt ?? null) !== null) {
        throw new StoreConflictError("Goal job dispatch lease fields require dispatching state.");
      }
      const normalized = normalizeGoalJobAdmission(admission);
      const existing = this.goalJobAdmissions.get(admission.jobId);
      const existingBinding = this.goalReviewJobBindings.get(admission.jobId);
      if (existing || existingBinding) {
        if (!existing || !existingBinding
          || existing.goalRunId !== normalized.goalRunId
          || existing.jobName !== normalized.jobName
          || existing.entityId !== normalized.entityId
          || existing.requestFingerprint !== normalized.requestFingerprint
          || !isDeepStrictEqual(existingBinding, parsed)) {
          throw new StoreConflictError("Goal Review job ID is already bound to another request.");
        }
        return structuredClone(normalizeGoalJobAdmission(existing));
      }
      this.goalJobAdmissions.set(admission.jobId, structuredClone(normalized));
      this.goalReviewJobBindings.set(admission.jobId, structuredClone(parsed));
      return structuredClone(normalized);
    });
  }

  async getGoalJobAdmission(jobId: string): Promise<GoalJobAdmission | null> {
    const admission = this.goalJobAdmissions.get(jobId);
    return admission ? structuredClone(normalizeGoalJobAdmission(admission)) : null;
  }

  async getGoalReviewJobData(jobId: string): Promise<GoalReviewJobData | null> {
    const admission = this.goalJobAdmissions.get(jobId);
    const stored = this.goalReviewJobBindings.get(jobId);
    if (!stored && !admission) return null;
    if (!stored || !admission) {
      throw new StoreConflictError("Goal Review job binding is incomplete.");
    }
    const parsed = assertGoalReviewJobAdmission(normalizeGoalJobAdmission(admission), stored);
    return structuredClone(parsed);
  }

  async claimGoalJobDispatch(
    jobId: string,
    input: GoalJobDispatchClaimInput
  ): Promise<GoalJobDispatchClaimResult> {
    const claim = normalizeGoalJobDispatchClaimInput(input);
    return this.serializeGoalMutation(async () => {
      const stored = this.goalJobAdmissions.get(jobId);
      if (!stored) throw new StoreNotFoundError("Goal job admission was not found.");
      const admission = normalizeGoalJobAdmission(stored);
      this.goalJobAdmissions.set(jobId, admission);

      if (admission.state === "outcome_unknown") {
        throw new StoreConflictError("Goal job outcome is unknown; dispatch fails closed.");
      }
      if (admission.state === "admitted" || admission.state === "running" || admission.state === "settled") {
        return { status: "already_dispatched", admission: structuredClone(admission) };
      }
      if (admission.state === "dispatching") {
        if (!admission.dispatchToken || !admission.dispatchLeaseExpiresAt
          || !Number.isFinite(Date.parse(admission.dispatchLeaseExpiresAt))) {
          throw new StoreConflictError("Goal job dispatch lease state is invalid.");
        }
        if (admission.dispatchToken === claim.dispatchToken) {
          return { status: "claimed", admission: structuredClone(admission) };
        }
        if (Date.parse(admission.dispatchLeaseExpiresAt) > Date.parse(claim.now)) {
          return { status: "contended", admission: structuredClone(admission) };
        }
      }

      Object.assign(admission, {
        state: "dispatching" as const,
        dispatchToken: claim.dispatchToken,
        dispatchLeaseExpiresAt: claim.leaseExpiresAt,
        updatedAt: claim.now
      });
      this.goalJobAdmissions.set(jobId, admission);
      return { status: "claimed", admission: structuredClone(admission) };
    });
  }

  async completeGoalJobDispatch(jobId: string, dispatchToken: string): Promise<GoalJobAdmission> {
    const validatedToken = validateGoalJobDispatchToken(dispatchToken);
    return this.serializeGoalMutation(async () => {
      const stored = this.goalJobAdmissions.get(jobId);
      if (!stored) throw new StoreNotFoundError("Goal job admission was not found.");
      const admission = normalizeGoalJobAdmission(stored);
      this.goalJobAdmissions.set(jobId, admission);

      if (admission.state === "admitted" || admission.state === "running" || admission.state === "settled") {
        return structuredClone(admission);
      }
      if (admission.state === "reserved") {
        throw new StoreConflictError("Reserved Goal job dispatch has not been claimed.");
      }
      if (admission.state === "outcome_unknown") {
        throw new StoreConflictError("Goal job outcome is unknown; dispatch completion fails closed.");
      }
      if (admission.dispatchToken !== validatedToken) {
        throw new StoreConflictError("Goal job dispatch token does not own the active lease.");
      }
      const now = new Date().toISOString();
      Object.assign(admission, {
        state: "admitted" as const,
        dispatchToken: null,
        dispatchLeaseExpiresAt: null,
        admittedAt: now,
        updatedAt: now
      });
      this.goalJobAdmissions.set(jobId, admission);
      return structuredClone(admission);
    });
  }

  async setGoalJobState(
    jobId: string,
    expectedState: GoalJobAdmissionState,
    state: GoalJobAdmissionState
  ): Promise<GoalJobAdmission> {
    if (expectedState === "dispatching" || state === "dispatching") {
      throw new StoreConflictError("Goal job dispatch lease transitions require the dispatch lease methods.");
    }
    return this.serializeGoalMutation(async () => {
      const admission = this.goalJobAdmissions.get(jobId);
      if (!admission) throw new StoreNotFoundError("Goal job admission was not found.");
      if (admission.state !== expectedState) throw new StoreConflictError("Goal job admission state changed.", "revision");
      const now = new Date().toISOString();
      Object.assign(admission, {
        state,
        admittedAt: state === "admitted" ? now : admission.admittedAt,
        startedAt: state === "running" ? now : admission.startedAt,
        settledAt: state === "settled" || state === "outcome_unknown" ? now : admission.settledAt,
        updatedAt: now
      });
      return structuredClone(normalizeGoalJobAdmission(admission));
    });
  }

  async getRecoverableGoalJobs(): Promise<GoalJobAdmission[]> {
    return [...this.goalJobAdmissions.values()]
      .filter((admission) => admission.state === "reserved"
        || admission.state === "dispatching"
        || admission.state === "admitted"
        || admission.state === "running"
        || (admission.state === "outcome_unknown" && admission.jobName === "goal-review"))
      .map((admission) => structuredClone(normalizeGoalJobAdmission(admission)));
  }

  async getToolPacks(): Promise<ToolPack[]> {
    return structuredClone(this.state.toolPacks ?? []);
  }

  async createToolPack(input: CreateToolPackInput, idempotencyKey?: string): Promise<ToolPack> {
    return this.runIdempotent("tool_pack.create", idempotencyKey, input, () => (
      this.serializeToolPackMutation(() => this.createToolPackRecord(input))
    ));
  }

  private async createToolPackRecord(input: CreateToolPackInput): Promise<ToolPack> {
    const normalized = createToolPackSchema.parse(input);
    if ((this.state.toolPacks ?? []).some((pack) => this.sameName(pack.name, normalized.name))) {
      throw new StoreConflictError("Tool Pack name already exists.");
    }
    const now = new Date().toISOString();
    const pack = toolPackSchema.parse({
      id: randomUUID(),
      ...normalized,
      manifestDigest: createToolPackManifestDigest(normalized),
      revision: 1,
      status: "draft",
      validation: {
        result: "pending",
        summary: "Not validated.",
        checkedAt: null,
        manifestDigest: null
      },
      approvedAt: null,
      revokedAt: null,
      revocationReason: null,
      createdAt: now,
      updatedAt: now
    });
    const revision = createToolPackRevision(pack, "created", now);
    await this.recordAudit("tool_pack.created", "tool_pack", pack.id, {
      revision: pack.revision,
      manifestDigest: pack.manifestDigest
    });
    this.state.toolPacks = [...(this.state.toolPacks ?? []), pack];
    this.state.toolPackRevisions = [...(this.state.toolPackRevisions ?? []), revision];
    return structuredClone(pack);
  }

  async updateToolPack(id: string, input: UpdateToolPackInput): Promise<ToolPack> {
    return this.serializeToolPackMutation(() => this.updateToolPackDraft(id, input));
  }

  private async updateToolPackDraft(id: string, input: UpdateToolPackInput): Promise<ToolPack> {
    const normalized = updateToolPackSchema.parse(input);
    const pack = this.required(this.state.toolPacks ?? [], id, "Tool Pack");
    this.assertToolPackRevision(pack, normalized.expectedRevision);
    if (pack.status === "revoked") throw new StoreConflictError("A revoked Tool Pack is terminal.");
    if (pack.status === "approved") throw new StoreConflictError("An approved Tool Pack cannot be edited; create a new Tool Pack.");

    const updates = Object.fromEntries(Object.entries(normalized).filter(([key]) => key !== "expectedRevision"));
    if (normalized.name !== undefined && (this.state.toolPacks ?? []).some((candidate) =>
      candidate.id !== id && this.sameName(candidate.name, normalized.name!)
    )) {
      throw new StoreConflictError("Tool Pack name already exists.");
    }
    const manifest = createToolPackSchema.parse({
      name: pack.name,
      version: pack.version,
      description: pack.description,
      owner: pack.owner,
      sourceReference: pack.sourceReference,
      imageDigest: pack.imageDigest,
      tools: pack.tools,
      ...updates
    });
    const manifestDigest = createToolPackManifestDigest(manifest);
    if (manifestDigest === pack.manifestDigest) return structuredClone(pack);

    const updatedAt = new Date().toISOString();
    const persisted = toolPackSchema.parse({
      ...pack,
      ...manifest,
      manifestDigest,
      revision: pack.revision + 1,
      status: "draft",
      validation: {
        result: "pending",
        summary: "Manifest changed; validation is required.",
        checkedAt: null,
        manifestDigest: null
      },
      approvedAt: null,
      revokedAt: null,
      revocationReason: null,
      updatedAt
    });
    const revision = this.prepareToolPackRevision(persisted, "updated", updatedAt);
    await this.recordAudit("tool_pack.updated", "tool_pack", pack.id, {
      fields: Object.keys(updates), revision: persisted.revision, manifestDigest: persisted.manifestDigest
    });
    Object.assign(pack, persisted);
    this.state.toolPackRevisions = [...(this.state.toolPackRevisions ?? []), revision];
    return structuredClone(persisted);
  }

  async validateToolPack(id: string, input: ValidateToolPackInput): Promise<ToolPack> {
    return this.serializeToolPackMutation(() => this.validateToolPackDraft(id, input));
  }

  private async validateToolPackDraft(id: string, input: ValidateToolPackInput): Promise<ToolPack> {
    const normalized = validateToolPackSchema.parse(input);
    const pack = this.required(this.state.toolPacks ?? [], id, "Tool Pack");
    this.assertToolPackRevision(pack, normalized.expectedRevision);
    if (pack.status === "revoked") throw new StoreConflictError("A revoked Tool Pack is terminal.");
    if (pack.status === "approved") throw new StoreConflictError("An approved Tool Pack cannot be revalidated.");
    if (pack.manifestDigest !== normalized.manifestDigest) {
      throw new StoreConflictError("Tool Pack validation digest does not match the current immutable manifest digest.");
    }
    const checkedAt = new Date().toISOString();
    const persisted = toolPackSchema.parse({
      ...pack,
      revision: pack.revision + 1,
      status: "validated",
      validation: {
        result: normalized.result,
        summary: normalized.summary,
        checkedAt,
        manifestDigest: normalized.manifestDigest
      },
      updatedAt: checkedAt
    });
    const revision = this.prepareToolPackRevision(persisted, "validated", checkedAt);
    await this.recordAudit(`tool_pack.validation.${normalized.result}`, "tool_pack", pack.id, {
      revision: persisted.revision,
      manifestDigest: persisted.manifestDigest
    });
    Object.assign(pack, persisted);
    this.state.toolPackRevisions = [...(this.state.toolPackRevisions ?? []), revision];
    return structuredClone(persisted);
  }

  async approveToolPack(id: string, input: ApproveToolPackInput): Promise<ToolPack> {
    return this.serializeToolPackMutation(() => this.approveToolPackDraft(id, input));
  }

  private async approveToolPackDraft(id: string, input: ApproveToolPackInput): Promise<ToolPack> {
    const normalized = approveToolPackSchema.parse(input);
    const pack = this.required(this.state.toolPacks ?? [], id, "Tool Pack");
    this.assertToolPackRevision(pack, normalized.expectedRevision);
    if (pack.status === "revoked") throw new StoreConflictError("A revoked Tool Pack is terminal.");
    if (pack.status !== "validated") throw new StoreConflictError("Tool Pack must be validated before approval.");
    if (pack.manifestDigest !== normalized.manifestDigest
      || pack.validation.result !== "passed"
      || pack.validation.manifestDigest !== pack.manifestDigest) {
      throw new StoreConflictError("Tool Pack approval requires current passed validation matching the immutable manifest digest.");
    }
    const approvedAt = new Date().toISOString();
    const persisted = toolPackSchema.parse({
      ...pack,
      revision: pack.revision + 1,
      status: "approved",
      approvedAt,
      updatedAt: approvedAt
    });
    const revision = this.prepareToolPackRevision(persisted, "approved", approvedAt);
    await this.recordAudit("tool_pack.approved", "tool_pack", pack.id, {
      revision: persisted.revision,
      manifestDigest: persisted.manifestDigest
    });
    Object.assign(pack, persisted);
    this.state.toolPackRevisions = [...(this.state.toolPackRevisions ?? []), revision];
    return structuredClone(persisted);
  }

  async revokeToolPack(id: string, input: RevokeToolPackInput): Promise<ToolPack> {
    return this.serializeToolPackMutation(() => this.revokeToolPackDraft(id, input));
  }

  private async revokeToolPackDraft(id: string, input: RevokeToolPackInput): Promise<ToolPack> {
    const normalized = revokeToolPackSchema.parse(input);
    const pack = this.required(this.state.toolPacks ?? [], id, "Tool Pack");
    this.assertToolPackRevision(pack, normalized.expectedRevision);
    if (pack.status === "revoked") throw new StoreConflictError("A revoked Tool Pack is terminal.");
    if (pack.status !== "approved") throw new StoreConflictError("Only an approved Tool Pack can be revoked.");
    const revokedAt = new Date().toISOString();
    const persisted = toolPackSchema.parse({
      ...pack,
      revision: pack.revision + 1,
      status: "revoked",
      revokedAt,
      revocationReason: normalized.reason,
      updatedAt: revokedAt
    });
    const revision = this.prepareToolPackRevision(persisted, "revoked", revokedAt);
    await this.recordAudit("tool_pack.revoked", "tool_pack", pack.id, {
      revision: persisted.revision,
      manifestDigest: persisted.manifestDigest,
      reason: normalized.reason
    });
    Object.assign(pack, persisted);
    this.state.toolPackRevisions = [...(this.state.toolPackRevisions ?? []), revision];
    return structuredClone(persisted);
  }

  async getToolPackRevisions(id: string): Promise<ToolPackRevision[]> {
    this.required(this.state.toolPacks ?? [], id, "Tool Pack");
    return structuredClone((this.state.toolPackRevisions ?? [])
      .filter((revision) => revision.packId === id)
      .sort((left, right) => right.revision - left.revision));
  }

  async getRuntimeProfiles(): Promise<RuntimeProfile[]> {
    return structuredClone(this.state.runtimeProfiles ?? []);
  }

  async createRuntimeProfile(input: CreateRuntimeProfileInput, idempotencyKey?: string): Promise<RuntimeProfile> {
    return this.runIdempotent("runtime_profile.create", idempotencyKey, input, () => (
      this.serializeRuntimeProfileMutation(() => this.createRuntimeProfileRecord(input))
    ));
  }

  private async createRuntimeProfileRecord(input: CreateRuntimeProfileInput): Promise<RuntimeProfile> {
    const createdAt = new Date().toISOString();
    const profile = runtimeProfileSchema.parse({
      id: randomUUID(),
      ...input,
      revision: 1,
      createdAt,
      updatedAt: createdAt
    });
    const revision = createRuntimeProfileRevision(profile, "created", createdAt);
    await this.recordAudit("runtime_profile.created", "runtime_profile", profile.id, { revision: profile.revision });
    this.state.runtimeProfiles = [...(this.state.runtimeProfiles ?? []), profile];
    this.state.runtimeProfileRevisions = [...(this.state.runtimeProfileRevisions ?? []), revision];
    return structuredClone(profile);
  }

  async updateRuntimeProfile(id: string, input: UpdateRuntimeProfileInput): Promise<RuntimeProfile> {
    return this.serializeRuntimeProfileMutation(() => this.updateRuntimeProfileRecord(id, input));
  }

  private async updateRuntimeProfileRecord(id: string, input: UpdateRuntimeProfileInput): Promise<RuntimeProfile> {
    const profiles = this.state.runtimeProfiles ?? [];
    const profile = this.required(profiles, id, "Runtime Profile");
    if (profile.revision !== input.expectedRevision) {
      throw new StoreConflictError("Runtime Profile revision is stale.", "revision");
    }
    const next: RuntimeProfile = {
      ...profile,
      ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== "expectedRevision")),
      updatedAt: profile.updatedAt
    };
    const changed = JSON.stringify(next) !== JSON.stringify(profile);
    if (!changed) return structuredClone(profile);
    const updatedAt = new Date().toISOString();
    const persisted = runtimeProfileSchema.parse({
      ...next,
      revision: profile.revision + 1,
      updatedAt
    });
    const revision = createRuntimeProfileRevision(persisted, "updated", updatedAt);
    await this.recordAudit("runtime_profile.updated", "runtime_profile", id, {
      fields: Object.keys(input).filter((field) => field !== "expectedRevision"),
      previousRevision: profile.revision,
      revision: persisted.revision
    });
    Object.assign(profile, persisted);
    this.state.runtimeProfileRevisions = [...(this.state.runtimeProfileRevisions ?? []), revision];
    return structuredClone(persisted);
  }

  async getRuntimeProfileRevisions(id: string): Promise<RuntimeProfileRevision[]> {
    const profiles = this.state.runtimeProfiles ?? [];
    this.required(profiles, id, "Runtime Profile");
    return structuredClone(
      (this.state.runtimeProfileRevisions ?? [])
        .filter((item) => item.profileId === id)
        .sort((left, right) => right.revision - left.revision)
    );
  }

  async createGroup(input: CreateGroupInput, idempotencyKey?: string): Promise<DiscussionGroup> {
    const operation = "group.create";
    return this.runIdempotent(operation, idempotencyKey, input, () => this.serializeTaxonomyMutation(async () => {
      if (this.state.groups.some((group) => this.sameName(group.name, input.name))) {
        throw new StoreConflictError("Group name already exists.");
      }
      const group: DiscussionGroup = { id: randomUUID(), revision: 1, ...input };
      await this.recordAudit("group.created", "group", group.id);
      this.state.groups.push(group);
      return group;
    }));
  }

  async createCategory(input: CreateCategoryInput, idempotencyKey?: string): Promise<Category> {
    const operation = "category.create";
    return this.runIdempotent(operation, idempotencyKey, input, () => this.serializeTaxonomyMutation(async () => {
      this.required(this.state.groups, input.groupId, "Group");
      if (this.state.categories.some((category) => category.groupId === input.groupId && this.sameName(category.name, input.name))) {
        throw new StoreConflictError("Category name already exists in this Group.");
      }
      const category: Category = { id: randomUUID(), revision: 1, ...input };
      await this.recordAudit("category.created", "category", category.id);
      this.state.categories.push(category);
      return category;
    }));
  }

  async createTag(input: CreateTagInput, idempotencyKey?: string): Promise<Tag> {
    const operation = "tag.create";
    return this.runIdempotent(operation, idempotencyKey, input, () => this.serializeTaxonomyMutation(async () => {
      if (this.state.tags.some((tag) => this.sameName(tag.name, input.name))) {
        throw new StoreConflictError("Tag name already exists.");
      }
      const tag: Tag = { id: randomUUID(), revision: 1, ...input };
      await this.recordAudit("tag.created", "tag", tag.id);
      this.state.tags.push(tag);
      return tag;
    }));
  }

  async updateGroup(id: string, input: UpdateGroupInput): Promise<DiscussionGroup> {
    return this.serializeTaxonomyMutation(async () => {
      const group = this.required(this.state.groups, id, "Group");
      const { expectedRevision, ...changes } = input;
      if (group.revision !== expectedRevision) {
        throw new StoreConflictError("Group revision is stale.", "revision");
      }
      const name = changes.name ?? group.name;
      if (name === group.name) return structuredClone(group);
      if (this.state.groups.some((candidate) => candidate.id !== id && this.sameName(candidate.name, name))) {
        throw new StoreConflictError("Group name already exists.");
      }
      const previous = { name: group.name };
      const current = { name, revision: group.revision + 1 };
      await this.recordAudit("group.updated", "group", id, {
        fields: Object.keys(changes),
        previousRevision: expectedRevision,
        revision: current.revision,
        previous,
        current: { name: current.name }
      });
      Object.assign(group, current);
      return structuredClone(group);
    });
  }

  async updateCategory(id: string, input: UpdateCategoryInput): Promise<Category> {
    return this.serializeTaxonomyMutation(async () => {
      const category = this.required(this.state.categories, id, "Category");
      const { expectedRevision, ...changes } = input;
      if (category.revision !== expectedRevision) {
        throw new StoreConflictError("Category revision is stale.", "revision");
      }
      const groupId = changes.groupId ?? category.groupId;
      const name = changes.name ?? category.name;
      if (groupId === category.groupId && name === category.name) return structuredClone(category);
      this.required(this.state.groups, groupId, "Group");
      if (this.state.categories.some((candidate) => candidate.id !== id && candidate.groupId === groupId && this.sameName(candidate.name, name))) {
        throw new StoreConflictError("Category name already exists in this Group.");
      }
      const previous = { groupId: category.groupId, name: category.name };
      const current = { groupId, name, revision: category.revision + 1 };
      await this.recordAudit("category.updated", "category", id, {
        fields: Object.keys(changes),
        previousRevision: expectedRevision,
        revision: current.revision,
        previous,
        current: { groupId: current.groupId, name: current.name }
      });
      Object.assign(category, current);
      return structuredClone(category);
    });
  }

  async updateTag(id: string, input: UpdateTagInput): Promise<Tag> {
    return this.serializeTaxonomyMutation(async () => {
      const tag = this.required(this.state.tags, id, "Tag");
      const { expectedRevision, ...changes } = input;
      if (tag.revision !== expectedRevision) {
        throw new StoreConflictError("Tag revision is stale.", "revision");
      }
      const name = changes.name ?? tag.name;
      const color = changes.color ?? tag.color;
      if (name === tag.name && color === tag.color) return structuredClone(tag);
      if (this.state.tags.some((candidate) => candidate.id !== id && this.sameName(candidate.name, name))) {
        throw new StoreConflictError("Tag name already exists.");
      }
      const previous = { name: tag.name, color: tag.color };
      const current = { name, color, revision: tag.revision + 1 };
      await this.recordAudit("tag.updated", "tag", id, {
        fields: Object.keys(changes),
        previousRevision: expectedRevision,
        revision: current.revision,
        previous,
        current: { name: current.name, color: current.color }
      });
      Object.assign(tag, current);
      return structuredClone(tag);
    });
  }

  async createThread(input: CreateThreadInput, idempotencyKey?: string): Promise<DiscussionThread> {
    const operation = "thread.create";
    return this.runIdempotent(operation, idempotencyKey, input, () => this.serializeTaxonomyMutation(async () => {
      this.required(this.state.categories, input.categoryId, "Category");
      if (new Set(input.tagIds).size !== input.tagIds.length) throw new StoreConflictError("Each tag may be assigned only once.");
      for (const tagId of input.tagIds) this.required(this.state.tags, tagId, "Tag");
      const thread: DiscussionThread = {
        id: randomUUID(),
        revision: 1,
        ...input,
        status: "open",
        createdAt: new Date().toISOString()
      };
      await this.recordAudit("thread.created", "thread", thread.id);
      this.state.threads.push(thread);
      return thread;
    }));
  }

  async updateThread(id: string, input: UpdateThreadInput): Promise<DiscussionThread> {
    return this.withTopicMeetingMutation(id, () => this.serializeTaxonomyMutation(async () => {
      const thread = this.required(this.state.threads, id, "Thread");
      const { expectedRevision, ...changes } = input;
      if (thread.revision !== expectedRevision) throw new StoreConflictError("Topic revision is stale.", "revision");
      const previousStatus = thread.status;
      if (changes.categoryId !== undefined) this.required(this.state.categories, changes.categoryId, "Category");
      if (changes.tagIds !== undefined) {
        for (const tagId of changes.tagIds) this.required(this.state.tags, tagId, "Tag");
        if (new Set(changes.tagIds).size !== changes.tagIds.length) {
          throw new StoreConflictError("Each tag may be assigned only once.");
        }
      }
      if (changes.status && changes.status !== "open") {
        const activeThreadMeeting = this.state.meetings.some((meeting) => meeting.threadId === id && meeting.state !== "closed");
        if (activeThreadMeeting) {
          throw new StoreConflictError("A Topic with an unfinished Meeting cannot be resolved or archived.");
        }
      }
      const changed = Object.entries(changes).some(([field, value]) => {
        const current = thread[field as keyof DiscussionThread];
        return Array.isArray(value) ? JSON.stringify(current) !== JSON.stringify(value) : current !== value;
      });
      if (!changed) return structuredClone(thread);
      const next = { ...changes, revision: thread.revision + 1 };
      await this.recordAudit("thread.updated", "thread", thread.id, {
        fields: Object.keys(changes),
        previousRevision: expectedRevision,
        revision: next.revision,
        previousStatus,
        status: changes.status ?? thread.status
      });
      Object.assign(thread, next);
      return structuredClone(thread);
    }));
  }

  async createMeeting(
    input: CreateMeetingInput,
    idempotencyKey?: string,
    participantAdmission: "structural" | "runnable" = "structural"
  ): Promise<Meeting> {
    return this.serializeRoleReferenceMutation(() => (
      this.withTopicMeetingMutation(input.threadId, () => (
        this.createMeetingRecord(input, idempotencyKey, participantAdmission)
      ))
    ));
  }

  private async createMeetingRecord(
    input: CreateMeetingInput,
    idempotencyKey?: string,
    participantAdmission: "structural" | "runnable" = "structural"
  ): Promise<Meeting> {
    const operation = "meeting.create";
    const idempotencyInput = participantAdmission === "runnable"
      ? { input, participantAdmission }
      : input;
    return this.runIdempotent(operation, idempotencyKey, idempotencyInput, async () => {
      const thread = this.state.threads.find((item) => item.id === input.threadId);
      if (!thread) throw new StoreNotFoundError("Topic not found.", "NOT_FOUND");
      if (thread.status !== "open") {
        throw new StoreConflictError("Only open Topics can create Meetings.", "business_rule", "TOPIC_NOT_OPEN");
      }
      const agentIds = input.participants.map((participant) => participant.agentId);
      if (new Set(agentIds).size !== agentIds.length) {
        throw new StoreConflictError("Each Agent may be assigned only once.", "business_rule", "DUPLICATE_PARTICIPANT");
      }
      if (input.participants.filter((participant) => participant.isChair).length !== 1) {
        throw new StoreConflictError("A meeting requires exactly one chair Agent.", "business_rule", "INVALID_CHAIR");
      }
      const preset = input.sourcePresetId
        ? this.required(this.state.meetingPresets ?? [], input.sourcePresetId, "Meeting Preset")
        : null;
      if (preset && preset.status !== "active") throw new StoreConflictError("Only active Meeting Presets can be referenced.");
      const sourceTeamId = input.sourceTeamId ?? preset?.teamId ?? null;
      const sourceTeam = sourceTeamId ? this.requiredActiveTeam(sourceTeamId) : null;
      if (preset?.teamId && input.sourceTeamId && preset.teamId !== input.sourceTeamId) {
        throw new StoreConflictError("Meeting Preset and source Agent Team do not match.");
      }
      if (sourceTeam) {
        const expected = sourceTeam.members
          .map((member) => `${member.agentId}:${member.roleId}:${member.isChair ? "chair" : "member"}`)
          .sort();
        const actual = input.participants
          .map((member) => `${member.agentId}:${member.roleId}:${member.isChair ? "chair" : "member"}`)
          .sort();
        if (JSON.stringify(expected) !== JSON.stringify(actual)) {
          throw new StoreConflictError("Meeting participants must match the selected Agent Team.");
        }
      }
      const unfinishedMeetingExists = this.state.meetings.some(
        (meeting) => meeting.threadId === input.threadId && meeting.state !== "closed"
      );
      if (participantAdmission === "structural" && unfinishedMeetingExists) {
        throw new StoreConflictError(
          "A Topic with an unfinished Meeting cannot create another Meeting.",
          "business_rule",
          "MEETING_ALREADY_OPEN"
        );
      }
      const admittedParticipants = input.participants.map((participant) => {
        if (participantAdmission === "structural") {
          const agent = this.required(this.state.agents, participant.agentId, "Agent");
          if (participant.agentRevision !== undefined
            && !this.resolveRunnableAgentRevision(agent.id, participant.agentRevision, true)) {
            throw new StoreConflictError("Meeting participant published Agent revision is stale or not ready.");
          }
          this.requiredActiveRole(participant.roleId);
          return { ...participant };
        }
        const agent = this.state.agents.find((item) => item.id === participant.agentId);
        const role = this.state.roles.find((item) => item.id === participant.roleId);
        if (!agent || !role || role.deletedAt) {
          throw new StoreConflictError(
            "Meeting participant or role is unavailable.",
            "business_rule",
            "INVALID_PARTICIPANT"
          );
        }
        const publishedRevision = agent.publishedRevision ?? (agent.lifecycleStatus === undefined ? 1 : null);
        const revision = publishedRevision === null
          ? null
          : this.agentRevisions.get(agent.id)?.find((item) => item.revision === publishedRevision) ?? null;
        const connector = revision?.modelConnectorId
          ? this.state.modelConnectors.find((item) => item.id === revision.modelConnectorId && item.enabled)
          : null;
        if (!connector) {
          throw new StoreConflictError(
            `${agent.name} has no enabled model connector.`,
            "business_rule",
            "PARTICIPANT_MODEL_UNAVAILABLE"
          );
        }
        if (!publishedRevision || !this.resolveRunnableAgentRevision(agent.id, publishedRevision, true)) {
          throw new StoreConflictError(
            `${agent.name} is not ready to join a Meeting.`,
            "business_rule",
            "PARTICIPANT_NOT_READY"
          );
        }
        if (participant.agentRevision !== undefined && participant.agentRevision !== publishedRevision) {
          throw new StoreConflictError(
            `${agent.name} is no longer on the requested published revision.`,
            "business_rule",
            "PARTICIPANT_REVISION_STALE"
          );
        }
        return { ...participant, agentRevision: publishedRevision };
      });
      if (participantAdmission === "runnable" && unfinishedMeetingExists) {
        throw new StoreConflictError(
          "A Topic with an unfinished Meeting cannot create another Meeting.",
          "business_rule",
          "MEETING_ALREADY_OPEN"
        );
      }
      const now = new Date().toISOString();
      const meeting: Meeting = {
        id: randomUUID(),
        threadId: input.threadId,
        title: input.title,
        goal: input.goal,
        mode: input.mode,
        durationMinutes: input.durationMinutes,
        state: "draft",
        automation: input.automation ?? "suggest",
        automationRevision: 0,
        startedAt: null,
        closedAt: null,
        agenda: {
          revision: 0,
          items: input.agendaItems.map((item, position) => ({
            id: randomUUID(),
            title: item.title,
            description: item.description,
            position,
            status: "pending",
            createdAt: now,
            updatedAt: now,
            startedAt: null,
            resolvedAt: null
          }))
        },
        summaryState: "not_requested",
        summaryJobId: null,
        createdAt: now,
        sourceTeamId,
        sourcePresetId: input.sourcePresetId ?? null
      };
      if (meeting.agenda.items.length < 1 || meeting.agenda.items.length > 12) {
        throw new StoreConflictError("A Meeting requires between 1 and 12 Agenda items.");
      }
      meeting.agenda = meetingAgendaSchema.parse(meeting.agenda);
      const assignments = admittedParticipants.map((participant): ParticipantAssignment => {
        const role = this.requiredActiveRole(participant.roleId);
        const agent = this.required(this.state.agents, participant.agentId, "Agent");
        const assignmentId = randomUUID();
        const roleSnapshot = createRoleExecutionSnapshot(role);
        return {
          id: assignmentId,
          meetingId: meeting.id,
          ...participant,
          agentRevision: participant.agentRevision ?? agent.publishedRevision ?? 1,
          roleSnapshot,
          roleRevision: 1,
          roleHistory: [{
            revision: 1,
            roleId: role.id,
            roleSnapshot: structuredClone(roleSnapshot),
            changedAt: now,
            changedBy: "owner",
            reason: "Role assigned when the Meeting was created."
          }]
        };
      });
      await this.recordAudit("meeting.created", "meeting", meeting.id);
      this.state.meetings.push(meeting);
      this.state.participants.push(...assignments);
      return meeting;
    });
  }

  async setMeetingState(id: string, state: MeetingState, expectedState?: MeetingState): Promise<Meeting> {
    const threadId = this.required(this.state.meetings, id, "Meeting").threadId;
    return this.withTopicMeetingMutation(threadId, () => (
      this.withMeetingMutation(id, () => this.setMeetingStateUnlocked(id, state, expectedState))
    ));
  }

  private async setMeetingStateUnlocked(id: string, state: MeetingState, expectedState?: MeetingState): Promise<Meeting> {
    const meeting = this.required(this.state.meetings, id, "Meeting");
    if (expectedState && meeting.state !== expectedState) {
      throw new StoreConflictError(
        `Meeting state changed from ${expectedState} to ${meeting.state} before the action completed.`,
        "revision"
      );
    }
    if (state !== "closed" && this.state.meetings.some((item) => item.id !== id && item.threadId === meeting.threadId && item.state !== "closed")) {
      throw new StoreConflictError("A closed Meeting cannot be reopened while its Topic has another unfinished Meeting.");
    }
    const nextMeeting = structuredClone(meeting);
    let nextSpeakerQueue = structuredClone(this.state.speakerQueue.filter((item) => item.meetingId === id));
    const nextChairSuggestions = structuredClone(this.state.chairSuggestions.filter((item) => item.meetingId === id));
    const previousState = meeting.state;
    const previousAgendaRevision = meeting.agenda.revision;
    nextMeeting.state = state;
    if (state === "active" && !nextMeeting.startedAt) nextMeeting.startedAt = new Date().toISOString();
    if (state === "closed") nextMeeting.closedAt ??= new Date().toISOString();
    if (state !== "closed") nextMeeting.closedAt = null;
    if (state === "active" && this.activateFirstPendingAgendaItem(nextMeeting)) {
      nextMeeting.agenda.revision += 1;
      await this.recordAudit("meeting.agenda.advanced", "meeting", id, {
        action: "activate",
        previousRevision: previousAgendaRevision,
        revision: nextMeeting.agenda.revision,
        currentItemId: nextMeeting.agenda.items.find((item) => item.status === "current")?.id ?? null,
        source: "meeting_state"
      });
    }
    if (state === "closed" && previousState !== "closed") {
      nextMeeting.summaryState = "pending";
      nextMeeting.summaryJobId = null;
      const invalidatedActions = nextSpeakerQueue;
      nextSpeakerQueue = [];
      for (const item of invalidatedActions) {
        await this.recordAudit("speaker.queue.released", "meeting", id, {
          jobId: item.jobId,
          participantId: item.participantId,
          agentId: item.agentId,
          roleRevision: item.roleRevision,
          reason: "meeting_closed"
        });
      }
      for (const suggestion of nextChairSuggestions.filter((item) => item.status !== "resolved")) {
        this.resolveSuggestion(suggestion, "meeting_closed", "The Meeting was closed.", "system");
        await this.recordAudit("chair.suggestion.resolved", "chair_suggestion", suggestion.id, {
          meetingId: id,
          resolution: suggestion.resolution
        });
      }
    }
    if (previousState === "closed" && state !== "closed") {
      nextMeeting.summaryState = "not_requested";
      nextMeeting.summaryJobId = null;
      for (const suggestion of nextChairSuggestions.filter((item) => item.resolution === "meeting_closed")) {
        suggestion.status = suggestion.requestedAgentJobId ? "pending" : "open";
        suggestion.resolution = null;
        suggestion.resolutionNote = null;
        suggestion.resolvedBy = null;
        suggestion.resolvedAt = null;
        this.appendSuggestionTransition(suggestion, "close_reverted", "system", {
          note: "The Meeting close operation was reverted."
        });
        await this.recordAudit("chair.suggestion.reopened", "chair_suggestion", suggestion.id, { meetingId: id });
      }
    }
    const auditEvent = meetingStateAuditEvent(previousState, state);
    if (auditEvent) {
      await this.recordAudit(auditEvent, "meeting", id, { previousState, state });
    }
    Object.assign(meeting, nextMeeting);
    if (state === "closed" && previousState !== "closed") {
      this.state.speakerQueue = this.state.speakerQueue.filter((item) => item.meetingId !== id);
    }
    const nextSuggestionById = new Map(nextChairSuggestions.map((suggestion) => [suggestion.id, suggestion]));
    this.state.chairSuggestions = this.state.chairSuggestions.map((suggestion) => (
      suggestion.meetingId === id ? nextSuggestionById.get(suggestion.id) ?? suggestion : suggestion
    ));
    return structuredClone(meeting);
  }

  async setMeetingAgenda(id: string, input: SetMeetingAgendaInput): Promise<Meeting> {
    return this.withMeetingMutation(id, () => this.setMeetingAgendaUnlocked(id, input));
  }

  private async setMeetingAgendaUnlocked(id: string, input: SetMeetingAgendaInput): Promise<Meeting> {
    const meeting = this.required(this.state.meetings, id, "Meeting");
    if (meeting.state === "closed") throw new StoreConflictError("A closed Meeting Agenda cannot be changed.");
    const parsed = setMeetingAgendaSchema.parse(input);
    this.assertAgendaRevision(meeting, parsed.expectedRevision);
    const previousAgenda = structuredClone(meeting.agenda);
    try {
      const lockedItems = meeting.agenda.items.filter((item) => item.status !== "pending");
      if (parsed.items.length < lockedItems.length) {
        throw new StoreConflictError("Started or resolved Agenda items are locked.");
      }
      for (const [index, locked] of lockedItems.entries()) {
        const candidate = parsed.items[index];
        if (!candidate
          || candidate.id !== locked.id
          || candidate.title !== locked.title
          || candidate.description !== locked.description) {
          throw new StoreConflictError("Started or resolved Agenda items are locked.");
        }
      }

      const pendingById = new Map(
        meeting.agenda.items
          .filter((item) => item.status === "pending")
          .map((item) => [item.id, item] as const)
      );
      const now = new Date().toISOString();
      const nextItems: AgendaItem[] = lockedItems.map((item, position) => ({ ...item, position }));
      for (const [offset, candidate] of parsed.items.slice(lockedItems.length).entries()) {
        const position = lockedItems.length + offset;
        const existing = candidate.id ? pendingById.get(candidate.id) : undefined;
        if (candidate.id && !existing) {
          throw new StoreConflictError("Agenda item ID is not an editable pending item.");
        }
        const changed = !existing
          || existing.title !== candidate.title
          || existing.description !== candidate.description
          || existing.position !== position;
        nextItems.push(existing ? {
          ...existing,
          title: candidate.title,
          description: candidate.description,
          position,
          updatedAt: changed ? now : existing.updatedAt
        } : {
          id: randomUUID(),
          title: candidate.title,
          description: candidate.description,
          position,
          status: "pending",
          createdAt: now,
          updatedAt: now,
          startedAt: null,
          resolvedAt: null
        });
      }

      const nextAgenda: MeetingAgenda = { revision: meeting.agenda.revision + 1, items: nextItems };
      if (meeting.state === "active") this.activateFirstPendingAgendaItem({ ...meeting, agenda: nextAgenda });
      if (JSON.stringify(nextAgenda.items) === JSON.stringify(meeting.agenda.items)) {
        return structuredClone(meeting);
      }
      meeting.agenda = meetingAgendaSchema.parse(nextAgenda);
      const previousItems = new Map(previousAgenda.items.map((item) => [item.id, item]));
      const currentItems = new Map(meeting.agenda.items.map((item) => [item.id, item]));
      const changedItemIds = [...new Set([...previousItems.keys(), ...currentItems.keys()])].filter((itemId) => {
        const previous = previousItems.get(itemId);
        const current = currentItems.get(itemId);
        return !previous || !current || JSON.stringify(previous) !== JSON.stringify(current);
      });
      await this.recordAudit("meeting.agenda.updated", "meeting", id, {
        previousRevision: previousAgenda.revision,
        revision: meeting.agenda.revision,
        previousItemCount: previousAgenda.items.length,
        itemCount: meeting.agenda.items.length,
        changedItemIds
      });
      return structuredClone(meeting);
    } catch (error) {
      meeting.agenda = previousAgenda;
      throw error;
    }
  }

  async advanceMeetingAgenda(id: string, input: AdvanceMeetingAgendaInput): Promise<Meeting> {
    return this.withMeetingMutation(id, () => this.advanceMeetingAgendaUnlocked(id, input));
  }

  private async advanceMeetingAgendaUnlocked(id: string, input: AdvanceMeetingAgendaInput): Promise<Meeting> {
    const meeting = this.required(this.state.meetings, id, "Meeting");
    if (meeting.state !== "active") throw new StoreConflictError("Agenda progress requires an active Meeting.");
    const parsed = advanceMeetingAgendaSchema.parse(input);
    this.assertAgendaRevision(meeting, parsed.expectedRevision);
    const previousAgenda = structuredClone(meeting.agenda);
    try {
      const previousRevision = meeting.agenda.revision;
      const current = meeting.agenda.items.find((item) => item.status === "current");

      if (parsed.action === "activate") {
        if (current) throw new StoreConflictError("The Meeting Agenda already has a current item.");
        if (!this.activateFirstPendingAgendaItem(meeting)) {
          throw new StoreConflictError("The Meeting Agenda has no pending item to activate.");
        }
      } else {
        if (!current || current.id !== parsed.itemId) {
          throw new StoreConflictError("Only the current Agenda item can be completed or skipped.");
        }
        const now = new Date().toISOString();
        current.status = parsed.action === "complete" ? "completed" : "skipped";
        current.resolvedAt = now;
        current.updatedAt = now;
        this.activateFirstPendingAgendaItem(meeting, now);
      }
      meeting.agenda.revision += 1;
      meeting.agenda = meetingAgendaSchema.parse(meeting.agenda);
      await this.recordAudit("meeting.agenda.advanced", "meeting", id, {
        action: parsed.action,
        itemId: "itemId" in parsed ? parsed.itemId : null,
        previousRevision,
        revision: meeting.agenda.revision,
        currentItemId: meeting.agenda.items.find((item) => item.status === "current")?.id ?? null
      });
      return structuredClone(meeting);
    } catch (error) {
      meeting.agenda = previousAgenda;
      throw error;
    }
  }

  private async withMeetingMutation<T>(meetingId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.meetingMutations.get(meetingId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(action);
    const settled = run.then(() => undefined, () => undefined);
    this.meetingMutations.set(meetingId, settled);
    void settled.then(() => {
      if (this.meetingMutations.get(meetingId) === settled) this.meetingMutations.delete(meetingId);
    });
    return run;
  }

  private withMeetingMutations<T>(meetingIds: Iterable<string>, action: () => Promise<T>): Promise<T> {
    const orderedMeetingIds = [...new Set(meetingIds)].sort();
    const acquire = (index: number): Promise<T> => {
      const meetingId = orderedMeetingIds[index];
      return meetingId
        ? this.withMeetingMutation(meetingId, () => acquire(index + 1))
        : action();
    };
    return acquire(0);
  }

  private async withTopicMeetingMutation<T>(threadId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.topicMeetingMutations.get(threadId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(action);
    const settled = run.then(() => undefined, () => undefined);
    this.topicMeetingMutations.set(threadId, settled);
    void settled.then(() => {
      if (this.topicMeetingMutations.get(threadId) === settled) this.topicMeetingMutations.delete(threadId);
    });
    return run;
  }

  private async withDecisionWorkflowMutation<T>(decisionId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.decisionWorkflowMutations.get(decisionId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(action);
    const settled = run.then(() => undefined, () => undefined);
    this.decisionWorkflowMutations.set(decisionId, settled);
    void settled.then(() => {
      if (this.decisionWorkflowMutations.get(decisionId) === settled) {
        this.decisionWorkflowMutations.delete(decisionId);
      }
    });
    return run;
  }

  private serializeTaskMutation<T>(action: (tasks: Task[]) => Promise<T>): Promise<T> {
    const run = this.taskMutation.catch(() => undefined).then(async () => {
      const stagedTasks = structuredClone(this.state.tasks);
      const result = await action(stagedTasks);
      this.state.tasks = stagedTasks;
      return result;
    });
    this.taskMutation = run.then(() => undefined, () => undefined);
    return run;
  }

  private serializeRuntimeAdmissionMutation<T>(action: () => Promise<T>): Promise<T> {
    const run = this.runtimeAdmissionMutation.catch(() => undefined).then(action);
    this.runtimeAdmissionMutation = run.then(() => undefined, () => undefined);
    return run;
  }

  async setMeetingSummaryState(id: string, state: MeetingSummaryState, jobId: string | null = null): Promise<Meeting> {
    return this.withMeetingSummaryMutation(id, async () => this.setMeetingSummaryStateUnlocked(id, state, jobId));
  }

  async commitMeetingSummary(input: MeetingSummaryCommitInput): Promise<MeetingSummaryCommitResult> {
    return this.withMeetingSummaryMutation(input.meetingId, async () => {
      const meeting = this.required(this.state.meetings, input.meetingId, "Meeting");
      if (meeting.state !== "closed") {
        throw new StoreConflictError("Only closed Meetings can commit a summary.");
      }
      if (!isMeetingSummaryUtterance(input.meetingId, input.utterance)) {
        throw new StoreConflictError("Meeting summary commits require the canonical system turn ID.");
      }
      const record = input.record ? meetingRecordSchema.parse(input.record) : null;
      if (record && (record.meetingId !== meeting.id || record.closedAt !== meeting.closedAt)) {
        throw new StoreConflictError("Meeting Record must match the closed Meeting summary reservation.");
      }
      const existingRecord = record
        ? this.meetingRecordBySourceDigest.get(`${record.meetingId}:${record.sourceDigest}`)
          ?? this.meetingRecords.get(`${record.meetingId}:${record.revision}`)
        : null;
      if (existingRecord && record && !isDeepStrictEqual(existingRecord, record)) {
        throw new StoreConflictError("Meeting Record retry conflicts with an immutable persisted record.");
      }
      if (meeting.summaryJobId !== input.jobId) {
        await this.recordAudit("meeting.summary.cancelled", "meeting", meeting.id, {
          classification: "stale_summary_job",
          jobId: input.jobId,
          currentJobId: meeting.summaryJobId
        });
        return { status: "stale", meeting: structuredClone(meeting), utterance: null, record: null };
      }

      const existing = this.state.utterances.find((item) => item.turnId === input.utterance.turnId);
      if (existing) {
        if (existing.meetingId !== meeting.id) {
          throw new StoreConflictError("Meeting summary turn ID belongs to another Meeting.");
        }
        const completed = this.setMeetingSummaryStateUnlocked(meeting.id, "completed", input.jobId);
        if (record && !existingRecord) {
          this.meetingRecords.set(`${record.meetingId}:${record.revision}`, structuredClone(record));
          this.meetingRecordBySourceDigest.set(`${record.meetingId}:${record.sourceDigest}`, structuredClone(record));
        }
        return {
          status: "existing",
          meeting: completed,
          utterance: structuredClone(existing),
          record: record ? structuredClone(existingRecord ?? record) : null
        };
      }

      const utterance: Utterance = {
        id: randomUUID(),
        meetingId: meeting.id,
        ...input.utterance,
        createdAt: new Date().toISOString()
      };
      await this.recordAudit("meeting.summary.created", "meeting", meeting.id, input.auditDetail);
      this.state.utterances.push(utterance);
      if (record && !existingRecord) {
        this.meetingRecords.set(`${record.meetingId}:${record.revision}`, structuredClone(record));
        this.meetingRecordBySourceDigest.set(`${record.meetingId}:${record.sourceDigest}`, structuredClone(record));
      }
      const completed = this.setMeetingSummaryStateUnlocked(meeting.id, "completed", input.jobId);
      return {
        status: "created",
        meeting: completed,
        utterance: structuredClone(utterance),
        record: record ? structuredClone(existingRecord ?? record) : null
      };
    });
  }

  private setMeetingSummaryStateUnlocked(id: string, state: MeetingSummaryState, jobId: string | null): Meeting {
    const meeting = this.required(this.state.meetings, id, "Meeting");
    if (meeting.state !== "closed") throw new StoreConflictError("Only closed Meetings can update summary delivery state.");
    if (state !== "pending" && jobId && meeting.summaryJobId && meeting.summaryJobId !== jobId) {
      return structuredClone(meeting);
    }
    if (meeting.summaryState === state) {
      if (state === "pending" && jobId && !meeting.summaryJobId) meeting.summaryJobId = jobId;
      return structuredClone(meeting);
    }
    if (meeting.summaryState === "completed" && state !== "completed") return structuredClone(meeting);
    const allowed: Record<MeetingSummaryState, MeetingSummaryState[]> = {
      not_requested: ["pending", "completed"],
      pending: ["queued", "completed", "failed"],
      queued: ["completed", "failed"],
      completed: ["completed"],
      failed: ["pending", "completed", "failed"]
    };
    if (!allowed[meeting.summaryState].includes(state)) {
      throw new StoreConflictError(`Meeting summary state cannot change from ${meeting.summaryState} to ${state}.`);
    }
    if (state === "queued" && !jobId) throw new StoreConflictError("A queued Meeting summary requires a job ID.");
    meeting.summaryState = state;
    if (state === "pending" || state === "failed") meeting.summaryJobId = jobId;
    else if (jobId) meeting.summaryJobId = jobId;
    return structuredClone(meeting);
  }

  async setMeetingMode(
    id: string,
    input: SetMeetingModeInput,
    actor: "owner" | "system" = "owner"
  ): Promise<MeetingModeChangeResult> {
    return this.withMeetingMutation(id, () => this.setMeetingModeUnlocked(id, input, actor));
  }

  private async setMeetingModeUnlocked(
    id: string,
    input: SetMeetingModeInput,
    actor: "owner" | "system"
  ): Promise<MeetingModeChangeResult> {
    const currentMeeting = this.required(this.state.meetings, id, "Meeting");
    if (currentMeeting.state === "closed") throw new StoreConflictError("Closed meetings cannot change mode.");
    const nextMeeting = structuredClone(currentMeeting);
    const nextSuggestions = this.state.chairSuggestions
      .filter((item) => item.meetingId === id)
      .map((item) => structuredClone(item));
    let chairSuggestion: ChairSuggestionRecord | null = null;
    const resolvedSuggestionIds: string[] = [];
    if (input.chairSuggestionId) {
      const suggestion = this.required(nextSuggestions, input.chairSuggestionId, "Chair suggestion");
      if (suggestion.meetingId !== id || suggestion.status === "resolved") {
        throw new StoreConflictError("Chair suggestion is no longer available for this Meeting.");
      }
      if (suggestion.suggestedMode !== input.mode) {
        throw new StoreConflictError("Chair suggestion does not recommend this Meeting mode.");
      }
      chairSuggestion = suggestion;
    }
    nextMeeting.mode = input.mode;
    if (chairSuggestion) {
      const suggestion = chairSuggestion;
      suggestion.modeAcceptedAt = new Date().toISOString();
      this.appendSuggestionTransition(suggestion, "mode_accepted", actor, { note: input.reason });
      if (!suggestion.suggestedAgentId) {
        this.resolveSuggestion(suggestion, "completed", input.reason, actor);
        resolvedSuggestionIds.push(suggestion.id);
        await this.recordAudit("chair.suggestion.resolved", "chair_suggestion", suggestion.id, {
          meetingId: id,
          resolution: suggestion.resolution
        });
      }
      await this.recordAudit("chair.suggestion.mode.accepted", "chair_suggestion", suggestion.id, {
        meetingId: id,
        mode: input.mode,
        resolved: !suggestion.suggestedAgentId
      });
    } else {
      for (const suggestion of nextSuggestions.filter((item) => item.status !== "resolved")) {
        this.resolveSuggestion(suggestion, "manual_override", input.reason, actor);
        resolvedSuggestionIds.push(suggestion.id);
        await this.recordAudit("chair.suggestion.resolved", "chair_suggestion", suggestion.id, {
          meetingId: id,
          resolution: suggestion.resolution
        });
      }
    }
    await this.recordAudit("meeting.mode.changed", "meeting", id, {
      mode: input.mode,
      reason: input.reason,
      chairSuggestionId: input.chairSuggestionId ?? null
      ,actor
    });
    Object.assign(currentMeeting, nextMeeting);
    for (const nextSuggestion of nextSuggestions) {
      const currentSuggestion = this.state.chairSuggestions.find((item) => item.id === nextSuggestion.id);
      if (currentSuggestion) Object.assign(currentSuggestion, nextSuggestion);
    }
    return {
      meeting: structuredClone(nextMeeting),
      chairSuggestion: chairSuggestion ? structuredClone(chairSuggestion) : null,
      resolvedSuggestionIds
    };
  }

  async setMeetingAutomation(
    id: string,
    input: SetMeetingAutomationInput,
    actor: "owner" | "system" = "owner"
  ): Promise<Meeting> {
    return this.withMeetingMutation(id, () => this.setMeetingAutomationUnlocked(id, input, actor));
  }

  private async setMeetingAutomationUnlocked(
    id: string,
    input: SetMeetingAutomationInput,
    actor: "owner" | "system"
  ): Promise<Meeting> {
    const currentMeeting = this.required(this.state.meetings, id, "Meeting");
    if (currentMeeting.state === "closed") throw new StoreConflictError("A closed Meeting cannot change Chair automation.");
    if (currentMeeting.automation !== input.expectedAutomation
      || (currentMeeting.automationRevision ?? 0) !== input.expectedAutomationRevision) {
      throw new StoreConflictError(
        `Chair automation changed from ${input.expectedAutomation} revision ${input.expectedAutomationRevision} to ${currentMeeting.automation} revision ${currentMeeting.automationRevision ?? 0} before the action completed.`,
        "revision"
      );
    }
    if (currentMeeting.automation === input.automation) return structuredClone(currentMeeting);
    if (input.automation === "auto" && this.state.speakerQueue.some((item) => item.meetingId === id)) {
      throw new StoreConflictError("Chair automation cannot change while the Meeting has a queued or running speaker action.");
    }

    const nextMeeting = structuredClone(currentMeeting);
    const nextSuggestions = this.state.chairSuggestions
      .filter((item) => item.meetingId === id)
      .map((item) => structuredClone(item));
    const previous = currentMeeting.automation;
    const resolvedSuggestionIds: string[] = [];
    const releasedQueueItems = previous === "auto" && input.automation !== "auto"
      ? this.state.speakerQueue.filter((item) => item.meetingId === id && item.requestedBy === "system")
      : [];
    if (releasedQueueItems.length > 0) {
      for (const item of releasedQueueItems) {
        await this.recordAudit("speaker.queue.released", "meeting", id, {
          jobId: item.jobId,
          participantId: item.participantId,
          agentId: item.agentId,
          roleRevision: item.roleRevision,
          reason: "chair_automation_downshift"
        });
      }
    }
    for (const suggestion of nextSuggestions.filter((item) => item.status !== "resolved")) {
      this.resolveSuggestion(
        suggestion,
        "manual_override",
        `Chair automation changed from ${previous} to ${input.automation}.`,
        actor
      );
      resolvedSuggestionIds.push(suggestion.id);
      await this.recordAudit("chair.suggestion.resolved", "chair_suggestion", suggestion.id, {
        meetingId: id,
        resolution: suggestion.resolution,
        actor
      });
    }
    nextMeeting.automation = input.automation;
    nextMeeting.automationRevision = (nextMeeting.automationRevision ?? 0) + 1;
    await this.recordAudit("meeting.automation.changed", "meeting", id, {
      from: previous,
      to: nextMeeting.automation,
      actor,
      automationRevision: nextMeeting.automationRevision,
      resolvedSuggestionIds,
      releasedJobIds: releasedQueueItems.map((item) => item.jobId)
    });
    Object.assign(currentMeeting, nextMeeting);
    for (const nextSuggestion of nextSuggestions) {
      const currentSuggestion = this.state.chairSuggestions.find((item) => item.id === nextSuggestion.id);
      if (currentSuggestion) Object.assign(currentSuggestion, nextSuggestion);
    }
    if (releasedQueueItems.length > 0) {
      const releasedJobIds = new Set(releasedQueueItems.map((item) => item.jobId));
      this.state.speakerQueue = this.state.speakerQueue.filter((item) => !releasedJobIds.has(item.jobId));
    }
    return structuredClone(nextMeeting);
  }

  async applyChairAutomation(input: ApplyChairAutomationInput): Promise<ApplyChairAutomationResult> {
    return this.serializeRuntimeAdmissionMutation(() => (
      this.withMeetingMutation(input.meetingId, () => this.applyChairAutomationUnlocked(input))
    ));
  }

  private async applyChairAutomationUnlocked(input: ApplyChairAutomationInput): Promise<ApplyChairAutomationResult> {
    const stale: ApplyChairAutomationResult = {
      status: "stale",
      meeting: null,
      suggestion: null,
      queueItem: null,
      agentTurnJob: null
    };
    const meeting = this.state.meetings.find((item) => item.id === input.meetingId);
    const suggestion = this.state.chairSuggestions.find((item) => item.id === input.chairSuggestionId);
    if (!meeting
      || !suggestion
      || meeting.state !== "active"
      || meeting.automation !== "auto"
      || (meeting.automationRevision ?? 0) !== input.automationRevision
      || suggestion.meetingId !== meeting.id
      || suggestion.sourceUtteranceId !== input.sourceUtteranceId
      || suggestion.status !== "open") {
      return stale;
    }

    const modeRank = { open: 0, chaired: 1, fixed: 2 } as const;
    if (modeRank[suggestion.suggestedMode] < modeRank[meeting.mode]) return stale;
    const participant = suggestion.suggestedAgentId
      ? this.state.participants.find((item) => item.meetingId === meeting.id
          && item.agentId === suggestion.suggestedAgentId
          && item.isChair)
      : undefined;
    const agent = suggestion.suggestedAgentId
      ? this.state.agents.find((item) => item.id === suggestion.suggestedAgentId)
      : undefined;
    let agentTurnJob: AgentTurnJobData | null = null;
    let queueItem: SpeakerQueueItem | null = null;
    const requestedAt = new Date().toISOString();
    if (suggestion.suggestedAgentId) {
      if (!participant || !agent || !input.agentTurnJobId) return stale;
      const revision = input.agentRevision === undefined
        ? undefined
        : this.agentRevisions.get(agent.id)?.find((item) => item.revision === input.agentRevision);
      if (agent.lifecycleStatus === "disabled"
        || input.agentRevision === undefined
        || !revision
        || participant.agentRevision !== input.agentRevision) return stale;
      const effectiveAgent = revision ? { ...agent, ...this.agentFieldsFromRevision(revision) } : agent;
      const model = effectiveAgent.modelConnectorId
        ? this.state.modelConnectors.find((item) => item.id === effectiveAgent.modelConnectorId && item.enabled)
        : undefined;
      const binding = input.modelConnectorBinding;
      const promptBindingMatches = input.agentRevision === undefined
        || JSON.stringify(input.promptBinding ?? null) === JSON.stringify(revision?.promptBinding ?? null);
      const prompt = revision?.promptBinding
        ? (this.state.prompts ?? []).find((item) => item.id === revision.promptBinding?.promptId)
        : undefined;
      const promptVersion = revision?.promptBinding
        ? this.promptVersions.get(revision.promptBinding.promptId)?.find((item) => item.version === revision.promptBinding?.version)
        : undefined;
      const promptRunnable = !revision?.promptBinding || Boolean(
        prompt
        && prompt.kind === "agent"
        && prompt.status !== "archived"
        && prompt.publishedVersion !== null
        && prompt.publishedVersion >= revision.promptBinding.version
        && promptVersion?.publishedAt
      );
      const credential = model?.credentialId
        ? (this.state.credentials ?? []).find((item) => item.id === model.credentialId)
        : undefined;
      const credentialRunnable = input.agentRevision === undefined || (model?.credentialId
        ? Boolean(
            credential
            && this.credentialRunnable(credential)
            && credential.secretRevision === model.secretRevision
            && input.credentialBinding?.credentialId === credential.id
            && input.credentialBinding.secretRevision === credential.secretRevision
            && input.credentialBinding.provider === credential.provider
            && input.credentialBinding.location === credential.location
          )
        : model?.location === "local" && !model.hasSecret && input.credentialBinding === undefined);
      const runtimeProfileSnapshot = this.resolveRuntimeProfileSnapshot(
        effectiveAgent.runtimeProfileBinding,
        effectiveAgent.modelConnectorId
      );
      if (!model
        || !binding
        || binding.id !== model.id
        || binding.location !== model.location
        || binding.baseUrl !== model.baseUrl
        || binding.model !== model.model
        || binding.secretRevision !== model.secretRevision
        || !promptBindingMatches
        || !promptRunnable
        || !credentialRunnable
        || !effectiveAgent.runtimeProfileBinding
        || !runtimeProfileSnapshot
        || !input.runtimeProfileBinding
        || !input.runtimeProfileSnapshot
        || !sameRuntimeProfileBinding(effectiveAgent.runtimeProfileBinding, input.runtimeProfileBinding)
        || !sameRuntimeProfileSnapshot(runtimeProfileSnapshot, input.runtimeProfileSnapshot)
        || !input.runtimeRun
        || !input.skillDigests
        || !this.hasMatchingSkillSnapshot(effectiveAgent, input.skillDigests)
        || this.state.speakerQueue.some((item) => item.meetingId === meeting.id)) return stale;
      try {
        validateQueuedRuntimeRun(input.runtimeRun, {
          kind: "meeting_turn",
          scope: {
            id: `meeting:${meeting.id}:participant:${participant.id}`,
            kind: "meeting_participant",
            subjectId: participant.id,
            parentScopeId: `meeting:${meeting.id}`
          },
          runtimeProfile: runtimeProfileSnapshot,
          agentId: agent.id,
          agentRevision: revision.revision,
          roleId: participant.roleId,
          roleRevision: participant.roleRevision,
          idempotencyKey: input.agentTurnJobId
        });
      } catch {
        return stale;
      }
      const approvedSkills = effectiveAgent.skillIds.map((skillId) => this.state.skills.find((skill) => skill.id === skillId));
      if (approvedSkills.some((skill) => !skill || !skillHasCurrentApprovedValidation(skill))) return stale;
      const originalMode = meeting.mode;
      meeting.mode = suggestion.suggestedMode;
      const permitted = permittedAgentIdsForMeeting(this.state, meeting.id).includes(agent.id);
      meeting.mode = originalMode;
      if (!permitted) return stale;
      this.assertRuntimeProfileCapacity(runtimeProfileSnapshot);
      agentTurnJob = {
        meetingId: meeting.id,
        agentId: agent.id,
        reservationId: input.runtimeRun.id,
        participantId: participant.id,
        roleRevision: participant.roleRevision,
        roleId: participant.roleId,
        roleVersion: participant.roleSnapshot.version,
        agendaRevision: meeting.agenda.revision,
        agendaCurrentItemId: meeting.agenda.items.find((item) => item.status === "current")?.id ?? null,
        requestedBy: "system",
        chairSuggestionId: suggestion.id,
        automationRevision: input.automationRevision,
        modelConnectorBinding: structuredClone(binding),
        ...(revision ? { agentRevision: revision.revision, promptBinding: revision.promptBinding } : {}),
        ...(input.credentialBinding ? { credentialBinding: structuredClone(input.credentialBinding) } : {}),
        ...(effectiveAgent.runtimeProfileBinding && runtimeProfileSnapshot ? {
          runtimeProfileBinding: { ...effectiveAgent.runtimeProfileBinding },
          runtimeProfileSnapshot: structuredClone(runtimeProfileSnapshot),
          runtimeRun: structuredClone(input.runtimeRun)
        } : {}),
        skillDigests: structuredClone(input.skillDigests)
      };
      queueItem = {
        id: input.agentTurnJobId,
        jobId: input.agentTurnJobId,
        reservationId: input.runtimeRun.id,
        requestFingerprint: requestFingerprint(agentTurnJob),
        meetingId: meeting.id,
        agentId: agent.id,
        kind: "agent_turn",
        label: `${agent.name} 發言`,
        toolName: null,
        participantId: participant.id,
        roleRevision: participant.roleRevision,
        roleId: participant.roleId,
        roleVersion: participant.roleSnapshot.version,
        roleName: participant.roleSnapshot.name,
        agendaRevision: meeting.agenda.revision,
        agendaCurrentItemId: meeting.agenda.items.find((item) => item.status === "current")?.id ?? null,
        status: "queued",
        requestedAt,
        startedAt: null,
        leaseExpiresAt: leaseExpiry(requestedAt, queuedSpeakerLeaseMs),
        runtimeProfileBinding: {
          profileId: runtimeProfileSnapshot.profileId,
          revision: runtimeProfileSnapshot.revision
        },
        requestedBy: "system",
        chairSuggestionId: suggestion.id,
        automationRevision: input.automationRevision
      };
    }

    const nextMeeting = structuredClone(meeting);
    const nextSuggestion = structuredClone(suggestion);
    nextMeeting.mode = nextSuggestion.suggestedMode;
    nextSuggestion.modeAcceptedAt = requestedAt;
    this.appendSuggestionTransition(nextSuggestion, "mode_accepted", "system", {
      note: nextSuggestion.explanation.slice(0, 1_000)
    });
    if (agentTurnJob && queueItem) {
      nextSuggestion.status = "pending";
      nextSuggestion.requestedAgentId = agentTurnJob.agentId;
      nextSuggestion.requestedAgentJobId = queueItem.jobId;
      this.appendSuggestionTransition(nextSuggestion, "agent_requested", "system", {
        agentId: agentTurnJob.agentId,
        jobId: queueItem.jobId
      });
    } else {
      this.resolveSuggestion(nextSuggestion, "completed", "Automatic Chair policy applied the Meeting mode.", "system");
    }
    await this.recordAudit("meeting.mode.changed", "meeting", nextMeeting.id, {
      mode: nextMeeting.mode,
      reason: nextSuggestion.reason,
      chairSuggestionId: nextSuggestion.id,
      actor: "system"
    });
    await this.recordAudit("chair.suggestion.mode.accepted", "chair_suggestion", nextSuggestion.id, {
      meetingId: nextMeeting.id,
      mode: nextMeeting.mode,
      actor: "system"
    });
    if (queueItem && agentTurnJob) {
      await this.recordAudit("speaker.queue.reserved", "meeting", nextMeeting.id, {
        jobId: queueItem.jobId,
        participantId: queueItem.participantId,
        agentId: queueItem.agentId,
        roleRevision: queueItem.roleRevision,
        runtimeProfileId: queueItem.runtimeProfileBinding?.profileId,
        runtimeProfileRevision: queueItem.runtimeProfileBinding?.revision,
        automationRevision: input.automationRevision,
        requestedBy: "system"
      });
      await this.recordAudit("chair.suggestion.agent.requested", "chair_suggestion", nextSuggestion.id, {
        meetingId: nextMeeting.id,
        agentId: queueItem.agentId,
        jobId: queueItem.jobId,
        actor: "system"
      });
    } else {
      await this.recordAudit("chair.suggestion.resolved", "chair_suggestion", nextSuggestion.id, {
        meetingId: nextMeeting.id,
        resolution: nextSuggestion.resolution,
        actor: "system"
      });
    }
    await this.recordAudit("chair.automation.applied", "chair_suggestion", nextSuggestion.id, {
      meetingId: nextMeeting.id,
      reason: nextSuggestion.reason,
      score: nextSuggestion.score,
      sourceUtteranceId: nextSuggestion.sourceUtteranceId,
      automationRevision: input.automationRevision,
      jobId: queueItem?.jobId ?? null,
      policyVersion: "deterministic-v1"
    });
    Object.assign(meeting, nextMeeting);
    Object.assign(suggestion, nextSuggestion);
    if (queueItem) this.state.speakerQueue.push(queueItem);
    return {
      status: "applied",
      meeting: structuredClone(meeting),
      suggestion: structuredClone(suggestion),
      queueItem: queueItem ? structuredClone(queueItem) : null,
      agentTurnJob: agentTurnJob ? structuredClone(agentTurnJob) : null
    };
  }

  async switchParticipantRole(
    meetingId: string,
    participantId: string,
    input: SwitchParticipantRoleInput
  ): Promise<ParticipantAssignment> {
    return this.serializeRuntimeAdmissionMutation(() => (
      this.serializeRoleReferenceMutation(() => (
        this.withMeetingMutation(meetingId, () => this.switchParticipantRoleRecord(meetingId, participantId, input))
      ))
    ));
  }

  private async switchParticipantRoleRecord(
    meetingId: string,
    participantId: string,
    input: SwitchParticipantRoleInput
  ): Promise<ParticipantAssignment> {
    const meeting = this.required(this.state.meetings, meetingId, "Meeting");
    if (meeting.state === "closed") throw new StoreConflictError("A closed Meeting cannot switch participant Roles.");
    const participant = this.required(this.state.participants, participantId, "Participant");
    if (participant.meetingId !== meeting.id) throw new StoreConflictError("Participant belongs to another Meeting.");
    if (participant.roleRevision !== input.expectedRoleRevision) {
      throw new StoreConflictError(
        `Participant Role revision changed from ${input.expectedRoleRevision} to ${participant.roleRevision} before the action completed.`,
        "revision"
      );
    }
    if (this.state.speakerQueue.some((item) => item.participantId === participant.id)) {
      throw new StoreConflictError("The participant already has a queued or running Agent turn.");
    }
    const role = this.requiredActiveRole(input.roleId);
    const nextSnapshot = createRoleExecutionSnapshot(role, "meeting_role_switched");
    if (this.roleSnapshotMatchesRole(participant.roleSnapshot, role)) {
      throw new StoreConflictError("Participant already uses the current version of this Role.");
    }

    const previous = structuredClone(participant);
    const nextParticipant = structuredClone(participant);
    const nextRevision = participant.roleRevision + 1;
    const transition: ParticipantRoleHistoryEntry = {
      revision: nextRevision,
      roleId: role.id,
      roleSnapshot: structuredClone(nextSnapshot),
      changedAt: new Date().toISOString(),
      changedBy: "owner",
      reason: input.reason
    };
    nextParticipant.roleId = role.id;
    nextParticipant.roleSnapshot = nextSnapshot;
    nextParticipant.roleRevision = nextRevision;
    nextParticipant.roleHistory.push(transition);
    await this.recordAudit("meeting.participant.role.changed", "participant", participant.id, {
      meetingId,
      agentId: participant.agentId,
      previousRoleId: previous.roleId,
      previousRoleVersion: previous.roleSnapshot.version,
      roleId: role.id,
      roleVersion: role.version,
      previousRoleRevision: previous.roleRevision,
      roleRevision: nextRevision,
      reason: input.reason
    });
    Object.assign(participant, nextParticipant);
    return structuredClone(participant);
  }

  async reserveSpeakerTurn(jobId: string, input: AgentTurnJobData): Promise<SpeakerQueueItem> {
    return this.serializeRuntimeAdmissionMutation(() => (
      this.withMeetingMutation(input.meetingId, () => this.reserveSpeakerTurnUnlocked(jobId, input))
    ));
  }

  private async reserveSpeakerTurnUnlocked(jobId: string, input: AgentTurnJobData): Promise<SpeakerQueueItem> {
    if (!jobId.trim()) throw new StoreConflictError("Speaker queue job ID is required.");
    if (input.reservationId !== undefined && !input.reservationId.trim()) {
      throw new StoreConflictError("Speaker reservation ID is required when supplied.");
    }
    if (input.reservationId && input.runtimeRun && input.reservationId !== input.runtimeRun.id) {
      throw new StoreConflictError("Speaker reservation ID does not match its Runtime Run.");
    }
    const reservationId = input.reservationId ?? input.runtimeRun?.id ?? null;
    const admittedJob: AgentTurnJobData = {
      ...input,
      ...(reservationId ? { reservationId } : {})
    };
    const admittedRequestFingerprint = requestFingerprint(admittedJob);
    const duplicate = this.state.speakerQueue.find((item) => item.jobId === jobId);
    if (duplicate) {
      if (duplicate.kind === "agent_turn"
        && duplicate.meetingId === input.meetingId
        && duplicate.agentId === input.agentId
        && duplicate.participantId === input.participantId
        && duplicate.roleRevision === input.roleRevision
        && duplicate.requestFingerprint === admittedRequestFingerprint) {
        return structuredClone(duplicate);
      }
      throw new StoreConflictError("Speaker queue job ID belongs to another Meeting action.");
    }
    if (this.state.speakerQueue.some((item) => item.meetingId === input.meetingId)) {
      throw new StoreConflictError("Meeting already has a queued or active speaker action.");
    }
    const meeting = this.required(this.state.meetings, input.meetingId, "Meeting");
    if (meeting.state !== "active") throw new StoreConflictError("Meeting must be active before reserving a speaker turn.");
    if (input.requestedBy === "system") {
      if (meeting.automation !== "auto" || !input.chairSuggestionId) {
        throw new StoreConflictError("System Chair turns require automatic Chair policy and a bound suggestion.");
      }
      if (input.automationRevision !== (meeting.automationRevision ?? 0)) {
        throw new StoreConflictError("System Chair turn automation revision is stale.");
      }
      const suggestion = this.required(this.state.chairSuggestions, input.chairSuggestionId, "Chair suggestion");
      if (suggestion.meetingId !== meeting.id
        || suggestion.status !== "open"
        || suggestion.suggestedAgentId !== input.agentId) {
        throw new StoreConflictError("System Chair turn does not match an open automatic suggestion.");
      }
    }
    const currentAgendaItemId = meeting.agenda.items.find((item) => item.status === "current")?.id ?? null;
    if (meeting.agenda.revision !== input.agendaRevision || currentAgendaItemId !== input.agendaCurrentItemId) {
      throw new StoreConflictError("Speaker turn Agenda binding is stale.");
    }
    const participant = this.state.participants.find((item) => item.id === input.participantId);
    if (!participant
      || participant.meetingId !== meeting.id
      || participant.agentId !== input.agentId
      || !this.participantMatchesRoleBinding(participant, input)) {
      throw new StoreConflictError("Speaker turn Role binding is stale.");
    }
    const agent = this.required(this.state.agents, input.agentId, "Agent");
    let effectiveAgent = agent;
    let runtimeProfileSnapshot: RuntimeProfileSnapshot | null = null;
    if (input.agentRevision !== undefined) {
      const runtime = this.resolveRunnableAgentRevision(agent.id, input.agentRevision, false);
      const modelBinding = input.modelConnectorBinding;
      if (!runtime
        || participant.agentRevision !== input.agentRevision
        || !modelBinding
        || modelBinding.id !== runtime.connector.id
        || modelBinding.location !== runtime.connector.location
        || modelBinding.baseUrl !== runtime.connector.baseUrl
        || modelBinding.model !== runtime.connector.model
        || modelBinding.secretRevision !== runtime.connector.secretRevision
        || JSON.stringify(input.promptBinding ?? null) !== JSON.stringify(runtime.revision.promptBinding ?? null)
        || !sameRuntimeProfileBinding(runtime.effectiveAgent.runtimeProfileBinding, input.runtimeProfileBinding)
        || !sameRuntimeProfileSnapshot(runtime.runtimeProfileSnapshot, input.runtimeProfileSnapshot)
        || !input.skillDigests
        || !this.hasMatchingSkillSnapshot(runtime.effectiveAgent, input.skillDigests)) {
        throw new StoreConflictError("Speaker turn Agent execution binding is stale.");
      }
      if (runtime.connector.credentialId) {
        const credential = (this.state.credentials ?? []).find((item) => item.id === runtime.connector.credentialId);
        if (!credential
          || input.credentialBinding?.credentialId !== credential.id
          || input.credentialBinding.secretRevision !== credential.secretRevision
          || input.credentialBinding.provider !== credential.provider
          || input.credentialBinding.location !== credential.location) {
          throw new StoreConflictError("Speaker turn Credential binding is stale.");
        }
      } else if (input.credentialBinding !== undefined) {
        throw new StoreConflictError("Speaker turn Credential binding is stale.");
      }
      try {
        if (!input.runtimeRun) throw new Error("Runtime Run is missing.");
        validateQueuedRuntimeRun(input.runtimeRun, {
          kind: "meeting_turn",
          scope: {
            id: `meeting:${meeting.id}:participant:${participant.id}`,
            kind: "meeting_participant",
            subjectId: participant.id,
            parentScopeId: `meeting:${meeting.id}`
          },
          runtimeProfile: runtime.runtimeProfileSnapshot,
          agentId: agent.id,
          agentRevision: runtime.revision.revision,
          roleId: participant.roleId,
          roleRevision: participant.roleRevision,
          idempotencyKey: jobId
        });
      } catch {
        throw new StoreConflictError("Speaker turn Runtime Run binding is stale.");
      }
      effectiveAgent = runtime.effectiveAgent;
      runtimeProfileSnapshot = runtime.runtimeProfileSnapshot;
    } else {
      const model = agent.modelConnectorId
        ? this.state.modelConnectors.find((item) => item.id === agent.modelConnectorId && item.enabled)
        : undefined;
      if (!model) throw new StoreConflictError("Agent has no enabled model connector.");
      runtimeProfileSnapshot = this.resolveRuntimeProfileSnapshot(
        agent.runtimeProfileBinding,
        agent.modelConnectorId
      );
      if (!runtimeProfileSnapshot) {
        throw new StoreConflictError("Speaker turn Runtime Profile is unavailable or no longer permitted.");
      }
    }
    if (!permittedAgentIdsForMeeting(this.state, meeting.id).includes(agent.id)) {
      throw new StoreConflictError("Agent is not currently permitted to speak.");
    }
    this.assertRuntimeProfileCapacity(runtimeProfileSnapshot);
    const requestedAt = new Date().toISOString();
    const item: SpeakerQueueItem = {
      id: jobId,
      jobId,
      reservationId,
      requestFingerprint: admittedRequestFingerprint,
      meetingId: meeting.id,
      agentId: agent.id,
      kind: "agent_turn",
      label: `${effectiveAgent.name} 發言`,
      toolName: null,
      participantId: participant.id,
      roleRevision: participant.roleRevision,
      roleId: participant.roleId,
      roleVersion: participant.roleSnapshot.version,
      roleName: participant.roleSnapshot.name,
      agendaRevision: input.agendaRevision,
      agendaCurrentItemId: input.agendaCurrentItemId,
      status: "queued",
      requestedAt,
      startedAt: null,
      leaseExpiresAt: leaseExpiry(requestedAt, queuedSpeakerLeaseMs),
        runtimeProfileBinding: {
          profileId: runtimeProfileSnapshot.profileId,
          revision: runtimeProfileSnapshot.revision
        },
        requestedBy: input.requestedBy,
        chairSuggestionId: input.chairSuggestionId ?? null,
        automationRevision: input.automationRevision ?? null
    };
    await this.recordAudit("speaker.queue.reserved", "meeting", meeting.id, {
      jobId,
      reservationId,
      participantId: participant.id,
      agentId: agent.id,
      roleRevision: participant.roleRevision,
      roleId: participant.roleId,
      roleVersion: participant.roleSnapshot.version,
      agendaRevision: input.agendaRevision,
      agendaCurrentItemId: input.agendaCurrentItemId,
      runtimeProfileId: runtimeProfileSnapshot.profileId,
      runtimeProfileRevision: runtimeProfileSnapshot.revision
    });
    this.state.speakerQueue.push(item);
    return structuredClone(item);
  }

  async reserveMcpToolCall(jobId: string, input: McpToolCallReservationInput): Promise<SpeakerQueueItem> {
    return this.serializeRuntimeAdmissionMutation(() => (
      this.withMeetingMutation(input.meetingId, () => this.reserveMcpToolCallUnlocked(jobId, input))
    ));
  }

  private async reserveMcpToolCallUnlocked(jobId: string, input: McpToolCallReservationInput): Promise<SpeakerQueueItem> {
    if (!jobId.trim()) throw new StoreConflictError("MCP queue job ID is required.");
    if (!input.requestFingerprint.trim()) throw new StoreConflictError("MCP request fingerprint is required.");
    if (this.state.toolRuns.some((item) => item.jobId === jobId)) {
      throw new StoreConflictError("MCP queue job ID already has a terminal Tool Run.");
    }
    const duplicate = this.state.speakerQueue.find((item) => item.jobId === jobId);
    if (duplicate) {
      if (duplicate.kind === "mcp_tool_call"
        && duplicate.requestFingerprint === input.requestFingerprint
        && duplicate.meetingId === input.meetingId
        && duplicate.agentId === input.agentId
        && duplicate.participantId === input.participantId
        && duplicate.roleRevision === input.roleRevision
        && duplicate.roleId === input.roleId
        && duplicate.roleVersion === input.roleVersion
        && duplicate.toolName === input.toolName
        && duplicate.mcpExecutionBinding?.connectorId === input.connectorId
        && duplicate.mcpExecutionBinding.connectorFingerprint === input.connectorFingerprint
        && JSON.stringify(duplicate.mcpExecutionBinding.toolSnapshot) === JSON.stringify(input.toolSnapshot)) {
        return structuredClone(duplicate);
      }
      throw new StoreConflictError("MCP queue job ID belongs to another Meeting action.");
    }
    if (this.state.speakerQueue.some((item) => item.meetingId === input.meetingId)) {
      throw new StoreConflictError("Meeting already has a queued or active Agent action.");
    }
    const { meeting, participant, agent, connector } = this.assertMcpToolCallAuthorization(input);
    const requestedAt = new Date().toISOString();
    const item: SpeakerQueueItem = {
      id: jobId,
      jobId,
      requestFingerprint: input.requestFingerprint,
      meetingId: meeting.id,
      agentId: agent.id,
      kind: "mcp_tool_call",
      label: `${input.toolSnapshot.displayName} 工具`,
      toolName: input.toolName,
      participantId: participant.id,
      roleRevision: participant.roleRevision,
      roleId: participant.roleId,
      roleVersion: participant.roleSnapshot.version,
      roleName: participant.roleSnapshot.name,
      agendaRevision: null,
      agendaCurrentItemId: null,
      status: "queued",
      requestedAt,
      startedAt: null,
      leaseExpiresAt: leaseExpiry(requestedAt, queuedSpeakerLeaseMs),
      mcpExecutionBinding: {
        connectorId: connector.id,
        toolSnapshot: structuredClone(input.toolSnapshot),
        connectorFingerprint: input.connectorFingerprint
      }
    };
    await this.recordAudit("speaker.queue.reserved", "meeting", meeting.id, {
      kind: item.kind,
      jobId,
      participantId: participant.id,
      agentId: agent.id,
      roleRevision: participant.roleRevision,
      connectorId: connector.id,
      toolName: input.toolName
    });
    this.state.speakerQueue.push(item);
    return structuredClone(item);
  }

  async admitMcpToolCall(jobId: string, input: McpToolCallAdmissionInput): Promise<McpToolCallAdmissionResult> {
    return this.serializeRuntimeAdmissionMutation(() => (
      this.withMeetingMutation(input.meetingId, () => this.admitMcpToolCallUnlocked(jobId, input))
    ));
  }

  private async admitMcpToolCallUnlocked(jobId: string, input: McpToolCallAdmissionInput): Promise<McpToolCallAdmissionResult> {
    const acceptedFingerprints = new Set(input.acceptedRequestFingerprints);
    if (acceptedFingerprints.size === 0 || [...acceptedFingerprints].some((value) => !value.trim())) {
      throw new StoreConflictError("At least one valid MCP request fingerprint reader is required.");
    }
    if (!acceptedFingerprints.has(input.requestFingerprint)) {
      throw new StoreConflictError("The MCP writer fingerprint must be accepted by this admission request.");
    }

    const existingRun = this.state.toolRuns.find((item) => item.jobId === jobId);
    if (existingRun) {
      if (!acceptedFingerprints.has(existingRun.requestFingerprint)
        || existingRun.meetingId !== input.meetingId
        || existingRun.agentId !== input.agentId
        || existingRun.connectorId !== input.connectorId
        || existingRun.toolName !== input.toolName) {
        throw new StoreConflictError("MCP queue job ID belongs to another Tool Run.");
      }
      const queueIndex = this.state.speakerQueue.findIndex((item) => item.jobId === jobId);
      const reservation = queueIndex >= 0 ? this.state.speakerQueue[queueIndex]! : null;
      if (reservation && (reservation.kind !== "mcp_tool_call"
        || !reservation.requestFingerprint
        || !acceptedFingerprints.has(reservation.requestFingerprint)
        || reservation.meetingId !== input.meetingId
        || reservation.agentId !== input.agentId
        || reservation.participantId !== input.participantId
        || reservation.roleRevision !== input.roleRevision
        || reservation.roleId !== input.roleId
        || reservation.roleVersion !== input.roleVersion
        || reservation.toolName !== input.toolName
        || reservation.mcpExecutionBinding?.connectorId !== input.connectorId
        || reservation.mcpExecutionBinding.connectorFingerprint !== input.connectorFingerprint
        || JSON.stringify(reservation.mcpExecutionBinding.toolSnapshot) !== JSON.stringify(input.toolSnapshot))) {
        throw new StoreConflictError("MCP terminal Tool Run conflicts with its remaining reservation.");
      }
      if (queueIndex >= 0) this.state.speakerQueue.splice(queueIndex, 1);
      return {
        status: "existing_run",
        run: structuredClone(existingRun),
        reservation: reservation ? structuredClone(reservation) : null,
        clearedReservation: reservation !== null
      };
    }

    this.assertMcpToolCallAuthorization(input);

    const existingReservation = this.state.speakerQueue.find((item) => item.jobId === jobId);
    if (existingReservation) {
      if (existingReservation.kind !== "mcp_tool_call"
        || !existingReservation.requestFingerprint
        || !acceptedFingerprints.has(existingReservation.requestFingerprint)
        || existingReservation.meetingId !== input.meetingId
        || existingReservation.agentId !== input.agentId
        || existingReservation.participantId !== input.participantId
        || existingReservation.roleRevision !== input.roleRevision
        || existingReservation.roleId !== input.roleId
        || existingReservation.roleVersion !== input.roleVersion
        || existingReservation.toolName !== input.toolName
        || existingReservation.mcpExecutionBinding?.connectorId !== input.connectorId
        || existingReservation.mcpExecutionBinding.connectorFingerprint !== input.connectorFingerprint
        || JSON.stringify(existingReservation.mcpExecutionBinding.toolSnapshot) !== JSON.stringify(input.toolSnapshot)) {
        throw new StoreConflictError("MCP queue job ID belongs to another Meeting action.");
      }
      return {
        status: "existing_reservation",
        run: null,
        reservation: structuredClone(existingReservation),
        clearedReservation: false
      };
    }

    return {
      status: "reserved",
      run: null,
      reservation: await this.reserveMcpToolCallUnlocked(jobId, input),
      clearedReservation: false
    };
  }

  async markSpeakerTurnRunning(jobId: string, reservationId?: string): Promise<SpeakerQueueItem | null> {
    const observed = this.state.speakerQueue.find((candidate) => candidate.jobId === jobId);
    if (!observed || !this.speakerReservationMatches(observed, reservationId)) return null;
    return this.serializeRuntimeAdmissionMutation(() => (
      this.withMeetingMutation(observed.meetingId, () => this.markSpeakerTurnRunningUnlocked(jobId, observed.meetingId, reservationId))
    ));
  }

  private async markSpeakerTurnRunningUnlocked(
    jobId: string,
    meetingId: string,
    reservationId?: string
  ): Promise<SpeakerQueueItem | null> {
    const item = this.state.speakerQueue.find((candidate) => candidate.jobId === jobId);
    if (!item || item.meetingId !== meetingId || !this.speakerReservationMatches(item, reservationId)) return null;
    if (item.status !== "queued") return null;
    const nextItem = structuredClone(item);
    nextItem.status = "running";
    nextItem.startedAt = new Date().toISOString();
    nextItem.leaseExpiresAt = leaseExpiry(nextItem.startedAt, runningSpeakerLeaseMs);
    await this.recordAudit("speaker.queue.started", "meeting", nextItem.meetingId, {
      jobId,
      reservationId: nextItem.reservationId,
      participantId: nextItem.participantId,
      agentId: nextItem.agentId,
      roleRevision: nextItem.roleRevision,
      runtimeProfileId: nextItem.runtimeProfileBinding?.profileId,
      runtimeProfileRevision: nextItem.runtimeProfileBinding?.revision
    });
    Object.assign(item, nextItem);
    return structuredClone(item);
  }

  async renewSpeakerTurnLease(
    jobId: string,
    now = new Date().toISOString(),
    reservationId?: string
  ): Promise<SpeakerQueueItem | null> {
    const observed = this.state.speakerQueue.find((candidate) => candidate.jobId === jobId);
    if (!observed || !this.speakerReservationMatches(observed, reservationId)) return null;
    return this.serializeRuntimeAdmissionMutation(() => (
      this.withMeetingMutation(observed.meetingId, () => this.renewSpeakerTurnLeaseUnlocked(jobId, observed.meetingId, now, reservationId))
    ));
  }

  private async renewSpeakerTurnLeaseUnlocked(
    jobId: string,
    meetingId: string,
    now: string,
    reservationId?: string
  ): Promise<SpeakerQueueItem | null> {
    const item = this.state.speakerQueue.find((candidate) => candidate.jobId === jobId);
    if (!item
      || item.meetingId !== meetingId
      || (item.status !== "queued" && item.status !== "running")
      || !this.speakerReservationMatches(item, reservationId)) return null;
    const timestamp = new Date(now).getTime();
    if (!Number.isFinite(timestamp)) throw new StoreConflictError("A valid Speaker Queue renewal time is required.");
    const duration = item.status === "running" ? runningSpeakerLeaseMs : queuedSpeakerLeaseMs;
    item.leaseExpiresAt = leaseExpiry(new Date(timestamp).toISOString(), duration);
    return structuredClone(item);
  }

  async releaseSpeakerTurn(jobId: string, reason: string, reservationId?: string): Promise<SpeakerQueueItem | null> {
    const observed = this.state.speakerQueue.find((candidate) => candidate.jobId === jobId);
    if (!observed || !this.speakerReservationMatches(observed, reservationId)) return null;
    return this.serializeRuntimeAdmissionMutation(() => (
      this.withMeetingMutation(observed.meetingId, () => this.releaseSpeakerTurnUnlocked(jobId, observed.meetingId, reason, reservationId))
    ));
  }

  private async releaseSpeakerTurnUnlocked(
    jobId: string,
    meetingId: string,
    reason: string,
    reservationId?: string
  ): Promise<SpeakerQueueItem | null> {
    const index = this.state.speakerQueue.findIndex((item) => item.jobId === jobId);
    if (index < 0) return null;
    const item = this.state.speakerQueue[index]!;
    if (item.meetingId !== meetingId || !this.speakerReservationMatches(item, reservationId)) return null;
    await this.recordAudit("speaker.queue.released", "meeting", item.meetingId, {
      jobId,
      reservationId: item.reservationId,
      participantId: item.participantId,
      agentId: item.agentId,
      roleRevision: item.roleRevision,
      reason: reason.slice(0, 200)
    });
    this.state.speakerQueue.splice(index, 1);
    return structuredClone(item);
  }

  async releaseExpiredSpeakerTurns(now = new Date().toISOString()): Promise<SpeakerQueueItem[]> {
    const cutoff = new Date(now).getTime();
    if (!Number.isFinite(cutoff)) throw new StoreConflictError("A valid queue reconciliation time is required.");
    return this.serializeRuntimeAdmissionMutation(() => {
      const meetingIds = this.state.speakerQueue
        .filter((item) => item.status === "queued" && new Date(item.leaseExpiresAt).getTime() <= cutoff)
        .map((item) => item.meetingId);
      return this.withMeetingMutations(meetingIds, () => this.releaseExpiredSpeakerTurnsUnlocked(cutoff));
    });
  }

  private async releaseExpiredSpeakerTurnsUnlocked(cutoff: number): Promise<SpeakerQueueItem[]> {
    const expired = this.state.speakerQueue.filter(
      (item) => item.status === "queued" && new Date(item.leaseExpiresAt).getTime() <= cutoff
    );
    if (expired.length === 0) return [];
    const suggestionUpdates: Array<{ current: ChairSuggestionRecord; next: ChairSuggestionRecord }> = [];
    for (const item of expired) {
      if (item.chairSuggestionId) {
        const current = this.state.chairSuggestions.find((suggestion) => suggestion.id === item.chairSuggestionId);
        if (current?.status === "pending" && current.requestedAgentJobId === item.jobId) {
          const next = structuredClone(current);
          next.status = "open";
          next.requestedAgentId = null;
          next.requestedAgentJobId = null;
          this.appendSuggestionTransition(next, "request_released", "system", {
            jobId: item.jobId,
            note: "Speaker reservation lease expired."
          });
          await this.recordAudit("chair.suggestion.agent.released", "chair_suggestion", next.id, {
            meetingId: next.meetingId,
            jobId: item.jobId,
            note: "Speaker reservation lease expired."
          });
          suggestionUpdates.push({ current, next });
        }
      }
      await this.recordAudit("speaker.queue.released", "meeting", item.meetingId, {
        jobId: item.jobId,
        participantId: item.participantId,
        agentId: item.agentId,
        roleRevision: item.roleRevision,
        reason: "lease_expired"
      });
    }
    const expiredIds = new Set(expired.map((item) => item.jobId));
    this.state.speakerQueue = this.state.speakerQueue.filter((item) => !expiredIds.has(item.jobId));
    for (const { current, next } of suggestionUpdates) Object.assign(current, next);
    return structuredClone(expired);
  }

  async addUtterance(meetingId: string, input: CreateUtteranceInput): Promise<Utterance> {
    return (await this.addUtteranceWithDisposition(meetingId, input)).utterance;
  }

  async addUtteranceWithDisposition(
    meetingId: string,
    input: CreateUtteranceInput
  ): Promise<UtteranceCreateResult> {
    const meeting = this.required(this.state.meetings, meetingId, "Meeting");
    if (input.turnId) {
      const existing = this.state.utterances.find((item) => item.turnId === input.turnId);
      if (existing) {
        if (!utteranceReplayMatches(meetingId, existing, input)) {
          throw new StoreConflictError(
            "Utterance turn ID was already used for different content or attribution.",
            "business_rule",
            "IDEMPOTENCY_KEY_CONFLICT"
          );
        }
        return { status: "existing", utterance: structuredClone(existing) };
      }
    }
    const isClosedSummary = meeting.state === "closed" && isMeetingSummaryUtterance(meetingId, input);
    if (meeting.state !== "active" && !isClosedSummary) {
      throw new StoreConflictError("Meeting must be active before adding an Utterance.");
    }
    const utterance: Utterance = { id: randomUUID(), meetingId, ...input, createdAt: new Date().toISOString() };
    this.state.utterances.push(utterance);
    return { status: "created", utterance: structuredClone(utterance) };
  }

  async createChairSuggestion(
    meetingId: string,
    sourceUtteranceId: string,
    proposal: ChairSuggestion,
    policyBinding?: ChairSuggestionPolicyBinding
  ): Promise<ChairSuggestionCreateResult> {
    return this.withMeetingMutation(meetingId, () => (
      this.createChairSuggestionUnlocked(meetingId, sourceUtteranceId, proposal, policyBinding)
    ));
  }

  private async createChairSuggestionUnlocked(
    meetingId: string,
    sourceUtteranceId: string,
    proposal: ChairSuggestion,
    policyBinding?: ChairSuggestionPolicyBinding
  ): Promise<ChairSuggestionCreateResult> {
    const meeting = this.required(this.state.meetings, meetingId, "Meeting");
    if (policyBinding && (
      meeting.automation !== policyBinding.automation
      || (meeting.automationRevision ?? 0) !== policyBinding.automationRevision
    )) {
      throw new StoreConflictError("Chair automation policy changed before the suggestion was persisted.");
    }
    const source = this.required(this.state.utterances, sourceUtteranceId, "Source utterance");
    if (source.meetingId !== meetingId) throw new StoreConflictError("Chair suggestion source belongs to another Meeting.");
    const existing = this.state.chairSuggestions.find((item) => item.sourceUtteranceId === sourceUtteranceId);
    if (existing) {
      if (existing.meetingId !== meetingId) throw new StoreConflictError("Chair suggestion source was already used by another Meeting.");
      return { status: "existing", suggestion: structuredClone(existing), supersededSuggestionIds: [] };
    }
    if (this.state.chairSuggestions.some((item) => item.meetingId === meetingId && item.status === "pending")) {
      throw new StoreConflictError("A pending Chair intervention must finish or be cancelled before another suggestion is created.");
    }

    const supersededSuggestions = this.state.chairSuggestions
      .filter((item) => item.meetingId === meetingId && item.status !== "resolved")
      .map((current) => ({ current, next: structuredClone(current) }));
    const supersededSuggestionIds: string[] = [];
    for (const { next } of supersededSuggestions) {
      this.resolveSuggestion(next, "superseded", "A newer Chair suggestion replaced this suggestion.", "system");
      supersededSuggestionIds.push(next.id);
      await this.recordAudit("chair.suggestion.resolved", "chair_suggestion", next.id, {
        meetingId,
        resolution: next.resolution
      });
    }

    const createdAt = new Date().toISOString();
    const suggestion: ChairSuggestionRecord = {
      id: randomUUID(),
      meetingId,
      sourceUtteranceId,
      ...proposal,
      status: "open",
      modeAcceptedAt: null,
      requestedAgentId: null,
      requestedAgentJobId: null,
      resolution: null,
      resolutionNote: null,
      resolvedBy: null,
      transitions: [{ id: randomUUID(), type: "created", actor: "system", at: createdAt }],
      createdAt,
      resolvedAt: null
    };
    await this.recordAudit("chair.suggestion.created", "chair_suggestion", suggestion.id, {
      meetingId,
      sourceUtteranceId,
      reason: suggestion.reason,
      suggestedMode: suggestion.suggestedMode,
      suggestedAgentId: suggestion.suggestedAgentId ?? null,
      suggestedParticipantId: suggestion.suggestedParticipantId ?? null,
      suggestedParticipantRoleRevision: suggestion.suggestedParticipantRoleRevision ?? null,
      suggestedRoleId: suggestion.suggestedRoleId ?? null,
      suggestedRoleVersion: suggestion.suggestedRoleVersion ?? null,
      supersededSuggestionIds
    });
    for (const { current, next } of supersededSuggestions) Object.assign(current, next);
    this.state.chairSuggestions.push(suggestion);
    return { status: "created", suggestion: structuredClone(suggestion), supersededSuggestionIds };
  }

  async getChairAutomationJobAdmissions(): Promise<ChairAutomationJobAdmission[]> {
    return [...this.chairAutomationJobAdmissions.values()]
      .map((admission) => structuredClone(admission))
      .sort((left, right) => left.reservedAt.localeCompare(right.reservedAt) || left.jobId.localeCompare(right.jobId));
  }

  async reserveChairAutomationJobAdmission(
    id: string,
    jobId: string,
    automationRevision: number
  ): Promise<ChairAutomationJobAdmissionMutationResult> {
    const meetingId = this.required(this.state.chairSuggestions, id, "Chair suggestion").meetingId;
    return this.serializeRuntimeAdmissionMutation(() => (
      this.withMeetingMutation(meetingId, async () => {
        if (!jobId.trim()) throw new StoreConflictError("Chair automation job ID is required.");
        if (!Number.isInteger(automationRevision) || automationRevision < 0) {
          throw new StoreConflictError("Chair automation revision is invalid.");
        }
        const suggestion = this.required(this.state.chairSuggestions, id, "Chair suggestion");
        const meeting = this.required(this.state.meetings, suggestion.meetingId, "Meeting");
        const existing = this.chairAutomationJobAdmissions.get(id);
        if (existing) {
          if (existing.jobId !== jobId || existing.automationRevision !== automationRevision) {
            throw new StoreConflictError("Chair suggestion already has another parent job admission.");
          }
          return { status: "unchanged", admission: structuredClone(existing) };
        }
        if (suggestion.status !== "open"
          || meeting.state !== "active"
          || meeting.automation !== "auto"
          || (meeting.automationRevision ?? 0) !== automationRevision) {
          throw new StoreConflictError("Chair automation policy changed before parent job reservation.");
        }
        const reservedAt = new Date().toISOString();
        const admission: ChairAutomationJobAdmission = {
          chairSuggestionId: id,
          meetingId: suggestion.meetingId,
          jobId,
          automationRevision,
          status: "reserved",
          reservedAt,
          admittedAt: null,
          reconciliationRequiredAt: null,
          reconciliationReason: null,
          updatedAt: reservedAt
        };
        await this.recordAudit("chair.automation.admission.reserved", "chair_suggestion", id, {
          meetingId: suggestion.meetingId,
          jobId,
          automationRevision
        });
        this.chairAutomationJobAdmissions.set(id, admission);
        return { status: "updated", admission: structuredClone(admission) };
      })
    ));
  }

  async confirmChairAutomationJobAdmission(
    id: string,
    jobId: string
  ): Promise<ChairAutomationJobAdmissionMutationResult> {
    const meetingId = this.required(this.state.chairSuggestions, id, "Chair suggestion").meetingId;
    return this.serializeRuntimeAdmissionMutation(() => (
      this.withMeetingMutation(meetingId, async () => {
        const suggestion = this.required(this.state.chairSuggestions, id, "Chair suggestion");
        const current = this.chairAutomationJobAdmissions.get(id);
        if (!current || current.jobId !== jobId) {
          throw new StoreConflictError("Chair automation parent job reservation is missing.");
        }
        if (current.status === "reconciliation_required") {
          throw new StoreConflictError("Chair automation parent job requires reconciliation before it can be admitted.");
        }
        if (current.status === "admitted") {
          return { status: "unchanged", admission: structuredClone(current) };
        }
        const admittedAt = current.admittedAt ?? nextTimestamp(current.updatedAt);
        const admission: ChairAutomationJobAdmission = {
          ...current,
          status: "admitted",
          admittedAt,
          reconciliationRequiredAt: null,
          reconciliationReason: null,
          updatedAt: admittedAt
        };
        await this.recordAudit("chair.automation.queued", "chair_suggestion", id, {
          meetingId: suggestion.meetingId,
          jobId,
          automationRevision: current.automationRevision,
          reason: suggestion.reason,
          score: suggestion.score
        });
        this.chairAutomationJobAdmissions.set(id, admission);
        return { status: "updated", admission: structuredClone(admission) };
      })
    ));
  }

  async releaseChairAutomationJobAdmission(
    id: string,
    jobId: string,
    classification: string
  ): Promise<ChairAutomationJobAdmissionMutationResult> {
    const meetingId = this.required(this.state.chairSuggestions, id, "Chair suggestion").meetingId;
    return this.serializeRuntimeAdmissionMutation(() => (
      this.withMeetingMutation(meetingId, async () => {
        const current = this.chairAutomationJobAdmissions.get(id);
        if (!current || current.jobId !== jobId || current.status === "admitted") {
          return { status: "unchanged", admission: current ? structuredClone(current) : null };
        }
        await this.recordAudit("chair.automation.enqueue_failed", "chair_suggestion", id, {
          meetingId,
          jobId,
          classification,
          automationRevision: current.automationRevision
        });
        this.chairAutomationJobAdmissions.delete(id);
        return { status: "updated", admission: null };
      })
    ));
  }

  async requireChairAutomationJobReconciliation(
    id: string,
    jobId: string,
    reason: ChairAutomationJobReconciliationReason,
    at = new Date().toISOString()
  ): Promise<ChairAutomationJobAdmissionMutationResult> {
    const meetingId = this.required(this.state.chairSuggestions, id, "Chair suggestion").meetingId;
    return this.serializeRuntimeAdmissionMutation(() => (
      this.withMeetingMutation(meetingId, async () => {
        const suggestion = this.required(this.state.chairSuggestions, id, "Chair suggestion");
        const current = this.chairAutomationJobAdmissions.get(id);
        if (!current || current.jobId !== jobId || suggestion.status !== "open") {
          return { status: "unchanged", admission: current ? structuredClone(current) : null };
        }
        if (current.status === "reconciliation_required") {
          return { status: "unchanged", admission: structuredClone(current) };
        }
        if (!Number.isFinite(Date.parse(at))) throw new StoreConflictError("Chair automation reconciliation time is invalid.");
        const admission: ChairAutomationJobAdmission = {
          ...current,
          status: "reconciliation_required",
          reconciliationRequiredAt: at,
          reconciliationReason: reason,
          updatedAt: at
        };
        await this.recordAudit("chair.automation.reconciliation_required", "chair_suggestion", id, {
          meetingId,
          jobId,
          classification: reason,
          automationRevision: current.automationRevision
        });
        this.chairAutomationJobAdmissions.set(id, admission);
        return { status: "updated", admission: structuredClone(admission) };
      })
    ));
  }

  async setChairSuggestionPending(
    id: string,
    agentId: string,
    jobId: string,
    actor: "owner" | "system" = "owner"
  ): Promise<ChairSuggestionMutationResult> {
    const meetingId = this.required(this.state.chairSuggestions, id, "Chair suggestion").meetingId;
    return this.serializeRuntimeAdmissionMutation(() => (
      this.withMeetingMutation(meetingId, () => this.setChairSuggestionPendingUnlocked(id, agentId, jobId, actor))
    ));
  }

  private async setChairSuggestionPendingUnlocked(
    id: string,
    agentId: string,
    jobId: string,
    actor: "owner" | "system"
  ): Promise<ChairSuggestionMutationResult> {
    const suggestion = this.required(this.state.chairSuggestions, id, "Chair suggestion");
    if (suggestion.status === "resolved") {
      const completedBySameJob = suggestion.resolution === "completed"
        && suggestion.suggestedAgentId === agentId
        && suggestion.transitions.some((transition) => transition.type === "completed" && transition.jobId === jobId);
      if (completedBySameJob) return { status: "unchanged", suggestion: structuredClone(suggestion) };
      throw new StoreConflictError("Chair suggestion is already resolved.");
    }
    if (suggestion.suggestedAgentId !== agentId) throw new StoreConflictError("Chair suggestion does not target this Agent.");
    if (suggestion.status === "pending") {
      if (suggestion.requestedAgentJobId !== jobId) throw new StoreConflictError("Chair suggestion already has a pending Agent action.");
      return { status: "unchanged", suggestion: structuredClone(suggestion) };
    }
    const meeting = this.required(this.state.meetings, suggestion.meetingId, "Meeting");
    if (actor === "system" && meeting.automation !== "auto") {
      throw new StoreConflictError("System Chair actions require automatic Chair policy.");
    }
    if (meeting.state !== "active" || meeting.mode !== suggestion.suggestedMode) {
      throw new StoreConflictError("Apply the suggested Meeting mode before requesting the Chair Agent.");
    }
    if (!permittedAgentIdsForMeeting(this.state, meeting.id).includes(agentId)) {
      throw new StoreConflictError("The suggested Chair Agent is not currently permitted to speak.");
    }
    const nextSuggestion = structuredClone(suggestion);
    nextSuggestion.status = "pending";
    nextSuggestion.requestedAgentId = agentId;
    nextSuggestion.requestedAgentJobId = jobId;
    this.appendSuggestionTransition(nextSuggestion, "agent_requested", actor, { agentId, jobId });
    await this.recordAudit("chair.suggestion.agent.requested", "chair_suggestion", nextSuggestion.id, {
      meetingId: nextSuggestion.meetingId,
      agentId,
      jobId,
      actor
    });
    Object.assign(suggestion, nextSuggestion);
    return { status: "updated", suggestion: structuredClone(nextSuggestion) };
  }

  async releaseChairSuggestion(id: string, jobId: string, note: string): Promise<ChairSuggestionMutationResult> {
    const meetingId = this.required(this.state.chairSuggestions, id, "Chair suggestion").meetingId;
    return this.serializeRuntimeAdmissionMutation(() => (
      this.withMeetingMutation(meetingId, () => this.releaseChairSuggestionUnlocked(id, jobId, note))
    ));
  }

  private async releaseChairSuggestionUnlocked(
    id: string,
    jobId: string,
    note: string
  ): Promise<ChairSuggestionMutationResult> {
    const suggestion = this.required(this.state.chairSuggestions, id, "Chair suggestion");
    if (suggestion.status !== "pending" || suggestion.requestedAgentJobId !== jobId) {
      return { status: "unchanged", suggestion: structuredClone(suggestion) };
    }
    const nextSuggestion = structuredClone(suggestion);
    nextSuggestion.status = "open";
    nextSuggestion.requestedAgentId = null;
    nextSuggestion.requestedAgentJobId = null;
    this.appendSuggestionTransition(nextSuggestion, "request_released", "system", { jobId, note });
    await this.recordAudit("chair.suggestion.agent.released", "chair_suggestion", nextSuggestion.id, {
      meetingId: nextSuggestion.meetingId,
      jobId,
      note
    });
    Object.assign(suggestion, nextSuggestion);
    return { status: "updated", suggestion: structuredClone(nextSuggestion) };
  }

  async dismissChairSuggestion(id: string, note: string): Promise<ChairSuggestionMutationResult> {
    const meetingId = this.required(this.state.chairSuggestions, id, "Chair suggestion").meetingId;
    return this.serializeRuntimeAdmissionMutation(() => (
      this.withMeetingMutation(meetingId, () => this.dismissChairSuggestionUnlocked(id, note))
    ));
  }

  private async dismissChairSuggestionUnlocked(id: string, note: string): Promise<ChairSuggestionMutationResult> {
    const suggestion = this.required(this.state.chairSuggestions, id, "Chair suggestion");
    if (suggestion.status === "resolved") return { status: "unchanged", suggestion: structuredClone(suggestion) };
    if (suggestion.status === "pending") throw new StoreConflictError("A pending Chair intervention cannot be dismissed.");
    const nextSuggestion = structuredClone(suggestion);
    this.resolveSuggestion(nextSuggestion, "dismissed", note, "owner");
    await this.recordAudit("chair.suggestion.resolved", "chair_suggestion", nextSuggestion.id, {
      meetingId: nextSuggestion.meetingId,
      resolution: nextSuggestion.resolution,
      note
    });
    Object.assign(suggestion, nextSuggestion);
    return { status: "updated", suggestion: structuredClone(nextSuggestion) };
  }

  async applyChairSuggestedRole(
    id: string,
    input: ApplyChairSuggestedRoleInput
  ): Promise<ChairSuggestionRoleApplyResult> {
    const suggestion = this.required(this.state.chairSuggestions, id, "Chair suggestion");
    if (suggestion.status !== "open") throw new StoreConflictError("Chair Role suggestion is no longer open.");
    if (!suggestion.suggestedParticipantId
      || !suggestion.suggestedParticipantAgentId
      || !suggestion.suggestedRoleId
      || suggestion.suggestedParticipantRoleRevision === undefined
      || suggestion.suggestedRoleVersion === undefined) {
      throw new StoreConflictError("Chair suggestion does not contain an applicable Role change.");
    }
    if (input.expectedRoleRevision !== suggestion.suggestedParticipantRoleRevision) {
      throw new StoreConflictError("Chair Role suggestion was created for another participant Role revision.");
    }
    const participant = this.required(this.state.participants, suggestion.suggestedParticipantId, "Participant");
    if (participant.meetingId !== suggestion.meetingId
      || participant.agentId !== suggestion.suggestedParticipantAgentId) {
      throw new StoreConflictError("Chair Role suggestion participant binding changed.");
    }
    const role = this.requiredActiveRole(suggestion.suggestedRoleId);
    if (role.version !== suggestion.suggestedRoleVersion) {
      throw new StoreConflictError("Suggested Role changed after the Chair recommendation was created.");
    }

    const previousParticipant = structuredClone(participant);
    const previousSuggestion = structuredClone(suggestion);
    try {
      const changed = await this.switchParticipantRole(suggestion.meetingId, participant.id, {
        roleId: role.id,
        expectedRoleRevision: input.expectedRoleRevision,
        reason: `擁有者核准主席建議：切換為 ${role.name} v${role.version}`
      });
      this.resolveSuggestion(
        suggestion,
        "completed",
        `${suggestion.suggestedParticipantAgentName ?? "Agent"} 已依主席建議切換為 ${role.name} v${role.version}。`,
        "owner",
        {},
        "role_accepted"
      );
      await this.recordAudit("chair.suggestion.role.accepted", "chair_suggestion", suggestion.id, {
        meetingId: suggestion.meetingId,
        participantId: participant.id,
        agentId: participant.agentId,
        roleId: role.id,
        roleVersion: role.version,
        roleRevision: changed.roleRevision
      });
      return { participant: changed, suggestion: structuredClone(suggestion) };
    } catch (error) {
      Object.assign(participant, previousParticipant);
      Object.assign(suggestion, previousSuggestion);
      throw error;
    }
  }

  async commitAgentTurn(input: AgentTurnCommitInput): Promise<AgentTurnCommitResult> {
    return this.serializeRuntimeAdmissionMutation(() => (
      this.serializeAgentDefinitionMutation(input.agentId, () => (
        this.withMeetingMutation(input.meetingId, () => this.commitAgentTurnUnlocked(input))
      ))
    ));
  }

  private async commitAgentTurnUnlocked(input: AgentTurnCommitInput): Promise<AgentTurnCommitResult> {
    const existing = this.state.utterances.find((item) => item.turnId === input.turnId);
    if (existing) {
      if (existing.meetingId !== input.meetingId || existing.agentId !== input.agentId) {
        throw new StoreConflictError("Agent turn ID was already used by a different meeting action.");
      }
      const chairSuggestion = input.chairSuggestionId
        ? this.state.chairSuggestions.find((item) => item.id === input.chairSuggestionId && item.resolution === "completed") ?? null
        : null;
      const queueIndex = this.state.speakerQueue.findIndex((item) => (
        item.jobId === input.turnId && this.speakerReservationMatches(item, input.reservationId)
      ));
      if (queueIndex >= 0) this.state.speakerQueue.splice(queueIndex, 1);
      return {
        status: "existing",
        utterance: structuredClone(existing),
        chairSuggestion: chairSuggestion ? structuredClone(chairSuggestion) : null
      };
    }

    const reservedAction = this.state.speakerQueue.find((item) => item.jobId === input.turnId);
    if (input.reservationRequired && (!reservedAction
      || reservedAction.kind !== "agent_turn"
      || reservedAction.meetingId !== input.meetingId
      || reservedAction.agentId !== input.agentId
      || reservedAction.participantId !== input.participantId
      || reservedAction.roleRevision !== input.roleRevision
      || !this.speakerReservationMatches(reservedAction, input.reservationId))) {
      return { status: "stale", utterance: null, chairSuggestion: null };
    }

    const meeting = this.required(this.state.meetings, input.meetingId, "Meeting");
    if (input.requestedBy === "system" && meeting.automation !== "auto") {
      return { status: "stale", utterance: null, chairSuggestion: null };
    }
    if (input.requestedBy === "system" && input.automationRevision !== (meeting.automationRevision ?? 0)) {
      return { status: "stale", utterance: null, chairSuggestion: null };
    }
    if (meeting.agenda.revision !== input.agendaRevision) {
      return { status: "stale", utterance: null, chairSuggestion: null };
    }
    if (meeting.state !== "active" || !permittedAgentIdsForMeeting(this.state, meeting.id).includes(input.agentId)) {
      return { status: "stale", utterance: null, chairSuggestion: null };
    }
    const agent = this.required(this.state.agents, input.agentId, "Agent");
    const participant = this.state.participants.find((item) => item.id === input.participantId);
    if (!participant
      || participant.meetingId !== meeting.id
      || participant.agentId !== agent.id
      || !this.participantMatchesRoleBinding(participant, input)) {
      return { status: "stale", utterance: null, chairSuggestion: null };
    }
    let runtimeAgent: Pick<Agent, "modelConnectorId" | "skillIds"> | AgentRevision = agent;
    if (input.executionBinding) {
      const binding = input.executionBinding;
      const revision = this.agentRevisions.get(agent.id)?.find((item) => item.revision === binding.agentRevision);
      const promptBindingMatches = (revision?.promptBinding?.promptId ?? null) === (binding.promptBinding?.promptId ?? null)
        && (revision?.promptBinding?.version ?? null) === (binding.promptBinding?.version ?? null);
      const prompt = binding.promptBinding
        ? this.state.prompts?.find((item) => item.id === binding.promptBinding?.promptId)
        : null;
      const promptVersion = binding.promptBinding
        ? this.promptVersions.get(binding.promptBinding.promptId)?.find((item) => item.version === binding.promptBinding?.version)
        : null;
      const runtimeProfileSnapshot = revision
        ? resolveRuntimeProfileSnapshotForBinding({
            binding: binding.runtimeProfileBinding,
            runtimeProfiles: this.state.runtimeProfiles,
            runtimeProfileRevisions: this.state.runtimeProfileRevisions,
            agentModelConnectorId: revision.modelConnectorId
          })
        : null;
      if (!revision
        || participant.agentRevision !== binding.agentRevision
        || !revision.publishedAt
        || !agentRevisionContentDigestIsValid(revision)
        || !promptBindingMatches
        || (binding.promptBinding !== null && (
          !prompt
          || prompt.kind !== "agent"
          || prompt.status === "archived"
          || prompt.publishedVersion === null
          || prompt.publishedVersion < binding.promptBinding.version
          || !promptVersion?.publishedAt
        ))
        || !sameRuntimeProfileBinding(revision.runtimeProfileBinding, binding.runtimeProfileBinding)
        || !sameRuntimeProfileSnapshot(runtimeProfileSnapshot, binding.runtimeProfileSnapshot)
        || !this.agentTurnCredentialBindingIsCurrent(revision, binding.credentialBinding)) {
        return { status: "stale", utterance: null, chairSuggestion: null };
      }
      runtimeAgent = revision;
    }
    if (input.modelConnectorId && runtimeAgent.modelConnectorId !== input.modelConnectorId) {
      return { status: "stale", utterance: null, chairSuggestion: null };
    }
    if (input.modelConnectorSnapshot) {
      const expected = input.modelConnectorSnapshot;
      const current = this.state.modelConnectors.find((connector) => connector.id === expected.id && connector.enabled);
      if (!current
        || current.location !== expected.location
        || current.baseUrl !== expected.baseUrl
        || current.model !== expected.model
        || current.enabled !== expected.enabled
        || current.secretRevision !== expected.secretRevision) {
        return { status: "stale", utterance: null, chairSuggestion: null };
      }
    }
    if (input.skillDigests && !this.hasMatchingSkillSnapshot(runtimeAgent, input.skillDigests)) {
      return { status: "stale", utterance: null, chairSuggestion: null };
    }

    const requestedSuggestion = input.chairSuggestionId
      ? this.required(this.state.chairSuggestions, input.chairSuggestionId, "Chair suggestion")
      : null;
    if (requestedSuggestion && (
      requestedSuggestion.meetingId !== meeting.id
      || requestedSuggestion.suggestedAgentId !== input.agentId
      || (requestedSuggestion.status === "pending" && requestedSuggestion.requestedAgentJobId !== input.turnId)
    )) {
      throw new StoreConflictError("Agent turn does not match the Chair suggestion.");
    }
    if (input.requestedBy === "system" && (!requestedSuggestion
      || requestedSuggestion.status !== "pending"
      || requestedSuggestion.requestedAgentJobId !== input.turnId)) {
      return { status: "stale", utterance: null, chairSuggestion: null };
    }

    const utterance: Utterance = {
      id: randomUUID(),
      meetingId: meeting.id,
      agentId: input.agentId,
      agentRevision: participant.agentRevision ?? null,
      turnId: input.turnId,
      speakerType: "agent",
      speakerName: input.speakerName,
      roleName: input.roleName,
      roleId: input.roleId,
      roleRevision: input.roleRevision,
      content: input.content,
      kind: "inference",
      evidenceCount: 0,
      createdAt: new Date().toISOString()
    };
    let chairSuggestion: ChairSuggestionRecord | null = null;
    let resolvedSuggestion: ChairSuggestionRecord | null = null;
    if (requestedSuggestion) {
      const suggestion = structuredClone(requestedSuggestion);
      if (suggestion.status !== "resolved") {
        this.resolveSuggestion(suggestion, "completed", "The requested Chair Agent completed its turn.", "system", {
          agentId: input.agentId,
          jobId: input.turnId
        });
        chairSuggestion = suggestion;
        resolvedSuggestion = suggestion;
        await this.recordAudit("chair.suggestion.resolved", "chair_suggestion", suggestion.id, {
          meetingId: meeting.id,
          resolution: suggestion.resolution,
          turnId: input.turnId
        });
      } else if (suggestion.resolution === "completed") {
        chairSuggestion = suggestion;
      }
    }
    await this.recordAudit("model.run.completed", "meeting", meeting.id, input.auditDetail);
    this.state.utterances.push(utterance);
    const queueIndex = this.state.speakerQueue.findIndex((item) => (
      item.jobId === input.turnId && this.speakerReservationMatches(item, input.reservationId)
    ));
    if (queueIndex >= 0) this.state.speakerQueue.splice(queueIndex, 1);
    if (resolvedSuggestion && requestedSuggestion) Object.assign(requestedSuggestion, resolvedSuggestion);
    return {
      status: "created",
      utterance: structuredClone(utterance),
      chairSuggestion: chairSuggestion ? structuredClone(chairSuggestion) : null
    };
  }

  async commitAgentTurnFailure(input: AgentTurnFailureCommitInput): Promise<AgentTurnFailureCommitResult> {
    return this.withMeetingMutation(input.meetingId, () => this.commitAgentTurnFailureUnlocked(input));
  }

  private async commitAgentTurnFailureUnlocked(
    input: AgentTurnFailureCommitInput
  ): Promise<AgentTurnFailureCommitResult> {
    const meeting = this.required(this.state.meetings, input.meetingId, "Meeting");
    const utteranceInput: CreateUtteranceInput = {
      turnId: input.jobId,
      speakerType: "system",
      speakerName: "Council",
      roleName: null,
      content: input.content,
      kind: "failure",
      evidenceCount: 0
    };
    const existing = this.state.utterances.find((item) => item.turnId === input.jobId);
    if (existing) {
      if (!utteranceReplayMatches(input.meetingId, existing, utteranceInput)) {
        throw new StoreConflictError("Agent turn job ID was already used by a different meeting action.");
      }
      return {
        status: "existing",
        meeting: structuredClone(meeting),
        utterance: structuredClone(existing),
        meetingPaused: false
      };
    }
    const hasCurrentReservation = this.state.speakerQueue.some((item) => (
      item.kind === "agent_turn"
      && item.jobId === input.jobId
      && item.meetingId === input.meetingId
      && this.speakerReservationMatches(item, input.reservationId)
    ));
    if (meeting.state === "draft" || !hasCurrentReservation) {
      return { status: "stale", meeting: structuredClone(meeting), utterance: null, meetingPaused: false };
    }

    const utterance: Utterance = {
      id: randomUUID(),
      meetingId: meeting.id,
      ...utteranceInput,
      createdAt: new Date().toISOString()
    };
    await this.recordAudit("model.run.failed", "meeting", meeting.id, {
      classification: input.classification,
      jobId: input.jobId,
      reservationId: input.reservationId ?? null
    });
    const meetingPaused = meeting.state === "active";
    if (meetingPaused) {
      await this.recordAudit("meeting.pause", "meeting", meeting.id, {
        previousState: "active",
        state: "paused",
        reason: "agent_turn_failure",
        jobId: input.jobId,
        reservationId: input.reservationId ?? null
      });
      meeting.state = "paused";
    }
    this.state.utterances.push(utterance);
    return {
      status: "created",
      meeting: structuredClone(meeting),
      utterance: structuredClone(utterance),
      meetingPaused
    };
  }

  async commitMcpToolRun(input: McpToolRunCommitInput): Promise<McpToolRunCommitResult> {
    return this.serializeRuntimeAdmissionMutation(() => (
      this.serializeAgentDefinitionMutation(input.agentId, () => (
        this.withMeetingMutation(input.meetingId, () => this.commitMcpToolRunUnlocked(input))
      ))
    ));
  }

  private async commitMcpToolRunUnlocked(input: McpToolRunCommitInput): Promise<McpToolRunCommitResult> {
    const existing = this.state.toolRuns.find((item) => item.jobId === input.jobId);
    if (existing) {
      if (existing.meetingId !== input.meetingId
        || existing.requestFingerprint !== input.requestFingerprint
        || existing.agentId !== input.agentId
        || existing.connectorId !== input.connectorId
        || existing.toolName !== input.toolName
        || existing.status !== input.status) {
        throw new StoreConflictError("MCP Tool Run job ID was already used by a different meeting action.");
      }
      const utterance = this.required(this.state.utterances, existing.utteranceId, "Tool evidence utterance");
      const queueIndex = this.state.speakerQueue.findIndex((item) => item.jobId === input.jobId);
      if (queueIndex >= 0) this.state.speakerQueue.splice(queueIndex, 1);
      return { status: "existing", run: structuredClone(existing), utterance: structuredClone(utterance), meetingPaused: false };
    }

    const reservedAction = this.state.speakerQueue.find((item) => item.jobId === input.jobId);
    const reservedBinding = reservedAction?.kind === "mcp_tool_call"
      ? reservedAction.mcpExecutionBinding
      : null;
    const reservationMatches = Boolean(reservedAction
      && reservedAction.kind === "mcp_tool_call"
      && reservedAction.requestFingerprint === input.requestFingerprint
      && reservedAction.meetingId === input.meetingId
      && reservedAction.agentId === input.agentId
      && reservedAction.participantId === input.participantId
      && reservedAction.roleRevision === input.roleRevision
      && reservedAction.roleId === input.roleId
      && reservedAction.roleVersion === input.roleVersion
      && reservedAction.toolName === input.toolName
      && reservedBinding
      && reservedBinding.connectorId === input.connectorId
      && reservedBinding.connectorFingerprint === input.connectorFingerprint
      && JSON.stringify(reservedBinding.toolSnapshot) === JSON.stringify(input.toolSnapshot));
    if (input.reservationRequired && !reservationMatches) {
      return { status: "stale", run: null, utterance: null, meetingPaused: false };
    }
    const durableFailureReceipt = input.status === "failed"
      && input.reservationRequired === true
      && reservationMatches;
    const meeting = this.required(this.state.meetings, input.meetingId, "Meeting");
    const agent = this.required(this.state.agents, input.agentId, "Agent");
    const connector = this.state.mcpConnectors.find((item) => item.id === input.connectorId);
    const participant = this.state.participants.find((item) => item.id === input.participantId);
    const agentRevision = participant?.agentRevision === undefined
      ? undefined
      : this.agentRevisions.get(agent.id)?.find((item) => item.revision === participant.agentRevision);
    const registration = connector?.toolRegistrations.find((item) => item.toolName === input.toolName);
    if (input.toolSnapshot.toolName !== input.toolName) {
      throw new StoreConflictError("MCP Tool Run snapshot does not match the requested tool.");
    }
    if (!durableFailureReceipt && (!participant
      || participant.meetingId !== meeting.id
      || participant.agentId !== agent.id
      || !this.participantMatchesRoleBinding(participant, input)
      || agent.lifecycleStatus === "disabled"
      || !agentRevision?.publishedAt
      || !connector
      || JSON.stringify({ connectorName: connector.name, ...registration }) !== JSON.stringify(input.toolSnapshot)
      || (input.connectorFingerprint
        && mcpConnectorExecutionFingerprint(connector, this.connectorSecrets.get(connector.id) ?? null) !== input.connectorFingerprint))) {
      return { status: "stale", run: null, utterance: null, meetingPaused: false };
    }
    if (input.status === "succeeded" && (
      !participant
      || participant.meetingId !== meeting.id
      || participant.agentId !== agent.id
      || !this.participantMatchesRoleBinding(participant, input)
      || agent.lifecycleStatus === "disabled"
      || !agentRevision?.publishedAt
      || !connector
      || meeting.state !== "active"
      || participant.roleSnapshot.toolPolicy !== "agent_read_only_grants"
      || participant.roleSnapshot.dataPolicy !== "agent_declared_scope"
      || !connector.enabled
      || !connector.approvedTools.includes(input.toolName)
      || !registration
      || !agentRevision.toolGrants.some((grant) => grant.connectorId === connector.id && grant.toolName === input.toolName)
    )) {
      return { status: "stale", run: null, utterance: null, meetingPaused: false };
    }

    const createdAt = new Date().toISOString();
    const toolSnapshot = snapshotToolRegistration(input.toolName, input.toolSnapshot);
    const meetingPaused = input.status === "failed" && meeting.state === "active";
    const utterance: Utterance = {
      id: randomUUID(),
      meetingId: meeting.id,
      agentId: agent.id,
      agentRevision: participant?.agentRevision ?? null,
      turnId: input.jobId,
      speakerType: "tool",
      speakerName: `${toolSnapshot.connectorName} · ${toolSnapshot.displayName}`,
      roleName: "MCP Tool",
      roleId: input.roleId,
      roleRevision: input.roleRevision,
      content: input.content.slice(0, 20_000),
      kind: input.status === "succeeded" ? "verified" : "failure",
      evidenceCount: 1,
      createdAt
    };
    const run: McpToolRun = {
      id: randomUUID(),
      jobId: input.jobId,
      requestFingerprint: input.requestFingerprint,
      meetingId: meeting.id,
      agentId: agent.id,
      connectorId: input.connectorId,
      toolName: input.toolName,
      toolSnapshot,
      status: input.status,
      utteranceId: utterance.id,
      createdAt
    };
    await this.recordAudit(
      input.status === "succeeded" ? "mcp.tool.succeeded" : "mcp.tool.failed",
      "meeting",
      meeting.id,
      { jobId: input.jobId, agentId: agent.id, connectorId: input.connectorId, toolName: input.toolName, toolRunId: run.id }
    );
    if (meetingPaused) meeting.state = "paused";
    this.state.utterances.push(utterance);
    this.state.toolRuns.push(run);
    const queueIndex = this.state.speakerQueue.findIndex((item) => item.jobId === input.jobId);
    if (queueIndex >= 0) this.state.speakerQueue.splice(queueIndex, 1);
    return { status: "created", run: structuredClone(run), utterance: structuredClone(utterance), meetingPaused };
  }

  async createDecision(input: CreateDecisionInput, idempotencyKey?: string): Promise<Decision> {
    const operation = "decision.create";
    return this.runIdempotent(operation, idempotencyKey, input, async () => {
      this.required(this.state.meetings, input.meetingId, "Meeting");
      const decision: Decision = { id: randomUUID(), ...input, status: "proposed", createdAt: new Date().toISOString() };
      await this.recordAudit("decision.proposed", "decision", decision.id, { meetingId: decision.meetingId });
      this.state.decisions.push(decision);
      return decision;
    });
  }

  async setDecisionStatus(id: string, status: "approved" | "rejected"): Promise<Decision> {
    return this.withDecisionWorkflowMutation(id, async () => {
      const decision = this.required(this.state.decisions, id, "Decision");
      if (decision.status === status) return structuredClone(decision);
      if (decision.status !== "proposed") {
        throw new StoreConflictError("A finalized Decision cannot change without an explicit revocation policy.");
      }
      await this.recordAudit(status === "approved" ? "decision.approve" : "decision.reject", "decision", decision.id);
      decision.status = status;
      return structuredClone(decision);
    });
  }

  async createTask(input: CreateTaskInput, idempotencyKey?: string): Promise<Task> {
    const operation = "task.create";
    return this.runIdempotent(operation, idempotencyKey, input, () => (
      this.withDecisionWorkflowMutation(input.decisionId, () => (
        this.serializeTaskMutation(async (tasks) => {
          const normalized = createTaskSchema.parse(input);
          const decision = this.required(this.state.decisions, normalized.decisionId, "Decision");
          if (decision.status !== "approved") throw new StoreConflictError("Only approved decisions can create tasks.");
          if (tasks.some((item) => item.decisionId === decision.id)) {
            throw new StoreConflictError("This decision already has a task.");
          }
          if (new Set(normalized.allowedTools).size !== normalized.allowedTools.length) {
            throw new StoreConflictError("Each allowed tool may appear only once.");
          }
          const assigneeAgent = normalized.assigneeAgentId
            ? this.required(this.state.agents, normalized.assigneeAgentId, "Assignee Agent")
            : null;
          const taskId = randomUUID();
          await this.recordAudit("task.created", "task", taskId, {
            decisionId: decision.id,
            meetingId: decision.meetingId
          });
          const now = new Date().toISOString();
          const boardRevision = this.advanceTaskBoardRevision(tasks);
          const task: Task = {
            id: taskId,
            meetingId: decision.meetingId,
            decisionId: decision.id,
            revision: 1,
            boardRevision,
            title: normalized.title,
            description: normalized.description,
            assignee: assigneeAgent?.name ?? normalized.assignee,
            assigneeAgentId: normalized.assigneeAgentId,
            dueAt: normalized.dueAt,
            acceptanceCriteria: normalized.acceptanceCriteria,
            evidence: [
              { id: randomUUID(), type: "meeting", label: "來源會議", reference: decision.meetingId, addedBy: "system", createdAt: now },
              { id: randomUUID(), type: "decision", label: "來源決議", reference: decision.id, addedBy: "system", createdAt: now }
            ],
            executionProfile: normalized.executionProfile,
            allowedTools: normalized.allowedTools,
            dataScope: normalized.dataScope,
            approvalState: normalized.approvalState,
            execution: idleTaskExecution(),
            status: "todo",
            position: tasks.filter((item) => item.status === "todo").length,
            transitions: [],
            sync: {
              status: "not_synced",
              adapterId: null,
              jobId: null,
              requestFingerprint: null,
              externalId: null,
              attemptCount: 0,
              lastAttemptAt: null,
              lastError: null,
              syncedAt: null
            },
            createdAt: now,
            updatedAt: now
          };
          this.appendTaskTransition(task, "created", "owner", {
            toStatus: task.status,
            toPosition: task.position
          });
          tasks.push(task);
          return task;
        })
      ))
    ));
  }

  async updateTask(id: string, input: UpdateTaskInput): Promise<Task> {
    return this.serializeTaskMutation(async (tasks) => {
    const task = this.required(tasks, id, "Task");
    const previousSyncFingerprint = taskSyncRequestFingerprint(task);
    this.assertTaskRevision(task, input.expectedRevision);
    this.assertTaskExecutionRevision(task, input.expectedExecutionRevision);
    this.assertTaskNotExecuting(task);
    if (input.allowedTools && new Set(input.allowedTools).size !== input.allowedTools.length) {
      throw new StoreConflictError("Each allowed tool may appear only once.");
    }
    const {
      expectedRevision: _expectedRevision,
      expectedExecutionRevision: _expectedExecutionRevision,
      ...changes
    } = input;
    const hasAgentAssignment = Object.prototype.hasOwnProperty.call(changes, "assigneeAgentId");
    let assigneeAgentId = hasAgentAssignment ? changes.assigneeAgentId ?? null : task.assigneeAgentId;
    let assignee = changes.assignee === undefined ? task.assignee : changes.assignee;
    if (hasAgentAssignment && assigneeAgentId) {
      assignee = this.required(this.state.agents, assigneeAgentId, "Assignee Agent").name;
    } else if (hasAgentAssignment && !assigneeAgentId && changes.assignee === undefined) {
      assignee = null;
    } else if (!hasAgentAssignment && changes.assignee !== undefined && task.assigneeAgentId) {
      assigneeAgentId = null;
    }
    if (assigneeAgentId) assignee = this.required(this.state.agents, assigneeAgentId, "Assignee Agent").name;

    const candidate = structuredClone(task);
    Object.assign(candidate, changes, { assignee, assigneeAgentId });
    const fields = taskChangedFields(task, candidate);
    if (fields.length === 0) return structuredClone(task);
    const executionFields = new Set<(typeof fields)[number]>([
      "title", "description", "assignee", "assigneeAgentId", "acceptanceCriteria",
      "executionProfile", "allowedTools", "dataScope"
    ]);
    const executionChanged = fields.some((field) => executionFields.has(field));
    Object.assign(task, changes, { assignee, assigneeAgentId });
    if (task.executionProfile === "worker") {
      if (executionChanged) task.approvalState = "pending";
    } else {
      task.approvalState = "not_required";
    }
    if (executionChanged) task.execution = idleTaskExecution(task.execution.revision + 1, task.execution.attemptCount);
    const previousRevision = task.revision;
    task.revision += 1;
    this.invalidateTaskSyncIfPayloadChanged(task, previousSyncFingerprint);
    task.updatedAt = new Date().toISOString();
    this.appendTaskTransition(task, "updated", "owner", {
      note: fields.sort().join(","),
      ...(executionChanged ? { executionRevision: task.execution.revision } : {})
    });
    await this.recordAudit("task.updated", "task", task.id, {
      fields,
      previousRevision,
      revision: task.revision
    });
    return structuredClone(task);
    });
  }

  async setTaskApproval(id: string, input: SetTaskApprovalInput): Promise<Task> {
    return this.serializeTaskMutation(async (tasks) => {
    const task = this.required(tasks, id, "Task");
    const previousSyncFingerprint = taskSyncRequestFingerprint(task);
    this.assertTaskExecutionRevision(task, input.expectedExecutionRevision);
    this.assertTaskNotExecuting(task);
    if (task.executionProfile !== "worker") throw new StoreConflictError("Only Worker Tasks use execution approval.");
    if (input.action === "approve" && !task.acceptanceCriteria.trim()) {
      throw new StoreConflictError("Worker Task execution requires acceptance criteria before Owner approval.");
    }
    const next = input.action === "approve" ? "approved" : input.action === "reject" ? "rejected" : "pending";
    if (task.approvalState === next) return structuredClone(task);
    const previous = task.approvalState;
    task.approvalState = next;
    task.execution = idleTaskExecution(task.execution.revision + 1, task.execution.attemptCount);
    this.invalidateTaskSyncIfPayloadChanged(task, previousSyncFingerprint);
    task.updatedAt = new Date().toISOString();
    this.appendTaskTransition(task, "approval_changed", "owner", {
      fromApprovalState: previous,
      toApprovalState: next,
      executionRevision: task.execution.revision,
      note: input.action
    });
    await this.recordAudit("task.approval.changed", "task", task.id, {
      action: input.action,
      from: previous,
      to: next,
      executionRevision: task.execution.revision
    });
    return structuredClone(task);
    });
  }

  async addTaskEvidence(id: string, input: AddTaskEvidenceInput, idempotencyKey?: string): Promise<Task> {
    return this.runIdempotent("task.evidence.add", idempotencyKey, { taskId: id, input }, () => (
      this.serializeTaskMutation(async (tasks) => {
        const task = this.required(tasks, id, "Task");
        const evidence = { id: randomUUID(), ...input, addedBy: "owner" as const, createdAt: new Date().toISOString() };
        task.evidence.push(evidence);
        task.updatedAt = evidence.createdAt;
        this.appendTaskTransition(task, "evidence_added", "owner", { evidenceId: evidence.id, note: evidence.label });
        await this.recordAudit("task.evidence.added", "task", task.id, { evidenceId: evidence.id, type: evidence.type });
        return structuredClone(task);
      })
    ));
  }

  async moveTask(id: string, input: MoveTaskInput): Promise<Task> {
    return this.serializeTaskMutation(async (tasks) => {
    const task = this.required(tasks, id, "Task");
    const previousSyncFingerprint = taskSyncRequestFingerprint(task);
    this.assertTaskBoardRevision(task, input.expectedBoardRevision);
    this.assertTaskExecutionRevision(task, input.expectedExecutionRevision);
    this.assertTaskNotExecuting(task);
    const fromStatus = task.status;
    const fromPosition = task.position;
    const source = tasks
      .filter((item) => item.id !== task.id && item.status === fromStatus)
      .sort((left, right) => left.position - right.position || left.createdAt.localeCompare(right.createdAt));
    const destination = input.status === fromStatus
      ? source
      : tasks
          .filter((item) => item.status === input.status)
          .sort((left, right) => left.position - right.position || left.createdAt.localeCompare(right.createdAt));
    const toPosition = Math.min(input.position, destination.length);
    if (fromStatus === input.status && fromPosition === toPosition) return structuredClone(task);
    if (input.status !== fromStatus) source.forEach((item, index) => { item.position = index; });
    task.status = input.status;
    destination.splice(toPosition, 0, task);
    destination.forEach((item, index) => { item.position = index; });
    const previousBoardRevision = task.boardRevision;
    const boardRevision = this.advanceTaskBoardRevision(tasks);
    this.invalidateTaskSyncIfPayloadChanged(task, previousSyncFingerprint);
    task.updatedAt = new Date().toISOString();
    this.appendTaskTransition(task, "moved", "owner", {
      fromStatus,
      toStatus: task.status,
      fromPosition,
      toPosition: task.position
    });
    await this.recordAudit("task.moved", "task", task.id, {
      fromStatus,
      toStatus: task.status,
      fromPosition,
      toPosition: task.position,
      previousBoardRevision,
      boardRevision
    });
    return structuredClone(task);
    });
  }

  async markTaskAgentRunQueued(jobId: string, input: TaskAgentRunJobData): Promise<TaskExecutionMutationResult> {
    return this.serializeRuntimeAdmissionMutation(() => this.serializeTaskMutation(async (tasks) => {
    const task = this.required(tasks, input.taskId, "Task");
    if (task.execution.jobId === jobId) {
      if (task.execution.requestFingerprint === input.requestFingerprint
        && task.execution.revision === input.executionRevision
        && task.execution.agentId === input.agentId
        && task.execution.profile === input.executionProfile) {
        return { status: "unchanged", task: structuredClone(task) };
      }
      throw new StoreConflictError("Task Agent run job ID belongs to a different request.");
    }
    this.assertTaskNotExecuting(task);
    if (input.executionRevision !== task.execution.revision + 1) {
      throw new StoreConflictError(`Task execution revision changed from ${input.executionRevision - 1} to ${task.execution.revision} before the run was queued.`);
    }
    this.assertTaskRunBinding(task, input);
    this.assertTaskRuntimeRun(jobId, task, input);
    this.assertRuntimeProfileCapacity(input.runtimeProfileSnapshot!, tasks);
    const now = new Date().toISOString();
    task.execution = {
      revision: input.executionRevision,
      status: "queued",
      jobId,
      requestFingerprint: input.requestFingerprint,
      agentId: input.agentId,
      profile: input.executionProfile,
      attemptCount: task.execution.attemptCount + 1,
      requestedAt: now,
      startedAt: null,
      providerStartedAt: null,
      completedAt: null,
      lastError: null,
      resultEvidenceId: null,
      runtimeProfileBinding: {
        profileId: input.runtimeProfileSnapshot!.profileId,
        revision: input.runtimeProfileSnapshot!.revision
      }
    };
    task.updatedAt = now;
    this.appendTaskTransition(task, "agent_run_requested", "owner", {
      agentId: input.agentId,
      jobId,
      executionRevision: input.executionRevision,
      requestFingerprint: input.requestFingerprint,
      note: input.executionProfile
    });
    await this.recordAudit("task.agent_run.requested", "task", task.id, {
      jobId,
      agentId: input.agentId,
      executionProfile: input.executionProfile,
      executionRevision: input.executionRevision,
      requestFingerprint: input.requestFingerprint,
      runtimeProfileId: input.runtimeProfileSnapshot!.profileId,
      runtimeProfileRevision: input.runtimeProfileSnapshot!.revision
    });
    return { status: "updated", task: structuredClone(task) };
    }));
  }

  async markTaskAgentRunRunning(jobId: string, input: TaskAgentRunJobData): Promise<TaskExecutionMutationResult> {
    return this.serializeTaskMutation(async (tasks) => {
    const task = this.required(tasks, input.taskId, "Task");
    if (task.execution.jobId === jobId
      && task.execution.revision === input.executionRevision
      && (task.execution.status === "completed" || task.execution.status === "failed")) {
      return { status: "unchanged", task: structuredClone(task) };
    }
    if (task.execution.status === "running"
      && task.execution.jobId === jobId
      && task.execution.revision === input.executionRevision) {
      return task.execution.requestFingerprint === input.requestFingerprint && this.taskRunBindingMatches(task, input)
        ? { status: "unchanged", task: structuredClone(task) }
        : { status: "stale", task: structuredClone(task) };
    }
    if (task.execution.status !== "queued"
      || task.execution.jobId !== jobId
      || task.execution.revision !== input.executionRevision
      || task.execution.requestFingerprint !== input.requestFingerprint
      || !this.taskRunBindingMatches(task, input)) {
      return { status: "stale", task: structuredClone(task) };
    }
    const now = new Date().toISOString();
    task.execution.status = "running";
    task.execution.startedAt = now;
    task.updatedAt = now;
    this.appendTaskTransition(task, "agent_run_started", "system", {
      agentId: input.agentId,
      jobId,
      executionRevision: input.executionRevision,
      note: input.executionProfile
    });
    await this.recordAudit("task.agent_run.started", "task", task.id, {
      jobId,
      agentId: input.agentId,
      executionProfile: input.executionProfile,
      executionRevision: input.executionRevision,
      requestFingerprint: input.requestFingerprint
    });
    return { status: "updated", task: structuredClone(task) };
    });
  }

  async claimTaskAgentProviderAttempt(jobId: string, input: TaskAgentRunJobData): Promise<TaskExecutionMutationResult> {
    return this.serializeTaskMutation(async (tasks) => {
      const task = this.required(tasks, input.taskId, "Task");
      if (task.execution.jobId === jobId
        && task.execution.revision === input.executionRevision
        && (task.execution.status === "completed" || task.execution.status === "failed")) {
        return { status: "unchanged", task: structuredClone(task) };
      }
      if (task.execution.status !== "running"
        || task.execution.jobId !== jobId
        || task.execution.revision !== input.executionRevision
        || task.execution.requestFingerprint !== input.requestFingerprint
        || !this.taskRunBindingMatches(task, input)) {
        return { status: "stale", task: structuredClone(task) };
      }
      if (task.execution.providerStartedAt) {
        return { status: "unchanged", task: structuredClone(task) };
      }
      const now = new Date().toISOString();
      task.execution.providerStartedAt = now;
      task.updatedAt = now;
      await this.recordAudit("task.agent_run.provider_started", "task", task.id, {
        jobId,
        agentId: input.agentId,
        executionProfile: input.executionProfile,
        executionRevision: input.executionRevision,
        requestFingerprint: input.requestFingerprint
      });
      return { status: "updated", task: structuredClone(task) };
    });
  }

  async completeTaskAgentRun(
    jobId: string,
    input: TaskAgentRunJobData,
    content: string,
    usage?: TaskAgentCompletionUsage
  ): Promise<TaskExecutionMutationResult> {
    return this.serializeTaskMutation(async (tasks) => {
    const task = this.required(tasks, input.taskId, "Task");
    const previousSyncFingerprint = taskSyncRequestFingerprint(task);
    if (task.execution.status === "completed"
      && task.execution.jobId === jobId
      && task.execution.revision === input.executionRevision) {
      return { status: "unchanged", task: structuredClone(task) };
    }
    const recoversProviderOutcomeUnknown = task.execution.status === "failed"
      && task.execution.lastError === "provider_outcome_unknown";
    if ((task.execution.status !== "running" && !recoversProviderOutcomeUnknown)
      || task.execution.jobId !== jobId
      || task.execution.revision !== input.executionRevision
      || task.execution.requestFingerprint !== input.requestFingerprint
      || !task.execution.providerStartedAt
      || !this.taskRunBindingMatches(task, input)) {
      return { status: "stale", task: structuredClone(task) };
    }
    const boundedContent = content.trim().slice(0, 4_000);
    if (!boundedContent) throw new StoreConflictError("Task Agent output is empty.");
    const agent = this.required(this.state.agents, input.agentId, "Assignee Agent");
    const now = new Date().toISOString();
    const evidence = {
      id: randomUUID(),
      type: "note" as const,
      label: `${input.executionProfile === "worker" ? "Agent 執行結果" : "Agent 提案"} · ${agent.name}`,
      reference: boundedContent,
      addedBy: "system" as const,
      agentId: agent.id,
      jobId,
      executionProfile: input.executionProfile,
      createdAt: now
    };
    task.evidence.push(evidence);
    task.execution = {
      ...task.execution,
      status: "completed",
      completedAt: now,
      lastError: null,
      resultEvidenceId: evidence.id
    };
    task.updatedAt = now;
    this.appendTaskTransition(task, "agent_run_completed", "system", {
      agentId: input.agentId,
      jobId,
      executionRevision: input.executionRevision,
      evidenceId: evidence.id,
      note: input.executionProfile
    });

    let moveAuditDetail: Record<string, unknown> | null = null;
    if (input.executionProfile === "worker" && task.status !== "review") {
      const fromStatus = task.status;
      const fromPosition = task.position;
      const previousBoardRevision = task.boardRevision;
      const source = tasks
        .filter((item) => item.id !== task.id && item.status === fromStatus)
        .sort((left, right) => left.position - right.position || left.createdAt.localeCompare(right.createdAt));
      source.forEach((item, index) => { item.position = index; });
      const destination = tasks
        .filter((item) => item.id !== task.id && item.status === "review")
        .sort((left, right) => left.position - right.position || left.createdAt.localeCompare(right.createdAt));
      task.status = "review";
      task.position = destination.length;
      destination.push(task);
      destination.forEach((item, index) => { item.position = index; });
      const boardRevision = this.advanceTaskBoardRevision(tasks);
      this.appendTaskTransition(task, "moved", "system", {
        fromStatus,
        toStatus: "review",
        fromPosition,
        toPosition: task.position,
        executionRevision: input.executionRevision,
        note: "Worker output requires Owner review."
      });
      moveAuditDetail = {
        fromStatus,
        toStatus: task.status,
        fromPosition,
        toPosition: task.position,
        previousBoardRevision,
        boardRevision,
        source: "task_agent_run"
      };
    }
    this.invalidateTaskSyncIfPayloadChanged(task, previousSyncFingerprint);
    await this.recordAudit("task.agent_run.completed", "task", task.id, {
      jobId,
      agentId: input.agentId,
      executionProfile: input.executionProfile,
      executionRevision: input.executionRevision,
      requestFingerprint: input.requestFingerprint,
      evidenceId: evidence.id,
      outputLength: boundedContent.length,
      usage: usage ?? null,
      taskStatus: task.status
    });
    if (moveAuditDetail) {
      await this.recordAudit("task.moved", "task", task.id, moveAuditDetail);
    }
    return { status: "updated", task: structuredClone(task) };
    });
  }

  async failTaskAgentRun(binding: TaskAgentRunFailureBinding, error: string): Promise<TaskExecutionMutationResult> {
    return this.serializeTaskMutation(async (tasks) => {
      const task = this.required(tasks, binding.taskId, "Task");
      const bindingMatches = task.execution.jobId === binding.jobId
        && task.execution.revision === binding.executionRevision
        && task.execution.requestFingerprint === binding.requestFingerprint
        && task.execution.agentId === binding.agentId
        && task.execution.profile === binding.executionProfile;
      if (task.execution.status === "failed" && bindingMatches) {
        return { status: "unchanged", task: structuredClone(task) };
      }
      if ((task.execution.status !== "queued" && task.execution.status !== "running")
        || !bindingMatches) {
        return { status: "stale", task: structuredClone(task) };
      }
    const now = new Date().toISOString();
    const safeError = error.trim().slice(0, 500) || "task_agent_run_failed";
    task.execution = {
      ...task.execution,
      status: "failed",
      startedAt: task.execution.startedAt ?? now,
      completedAt: now,
      lastError: safeError,
      resultEvidenceId: null
    };
    task.updatedAt = now;
      this.appendTaskTransition(task, "agent_run_failed", "system", {
        ...(task.execution.agentId ? { agentId: task.execution.agentId } : {}),
        jobId: binding.jobId,
        executionRevision: binding.executionRevision,
        requestFingerprint: binding.requestFingerprint,
        note: safeError
      });
      await this.recordAudit("task.agent_run.failed", "task", task.id, {
        jobId: binding.jobId,
        agentId: task.execution.agentId,
        executionProfile: task.execution.profile,
        executionRevision: binding.executionRevision,
        requestFingerprint: binding.requestFingerprint,
        classification: safeError
      });
    return { status: "updated", task: structuredClone(task) };
    });
  }

  async markTaskSyncPending(id: string, jobId: string, input: TaskSyncRequestInput): Promise<TaskSyncMutationResult> {
    return this.serializeTaskMutation(async (tasks) => {
    const task = this.required(tasks, id, "Task");
    this.assertTaskRevision(task, input.expectedRevision);
    if (task.status !== input.expectedStatus) {
      throw new StoreConflictError(`Task status changed from ${input.expectedStatus} to ${task.status} before synchronization.`, "revision");
    }
    if (task.approvalState !== input.expectedApprovalState) {
      throw new StoreConflictError(`Task approval state changed from ${input.expectedApprovalState} to ${task.approvalState} before synchronization.`, "revision");
    }
    const requestFingerprint = taskSyncRequestFingerprint(task);
    const replaysPriorAttempt = task.sync.attemptCount === input.expectedSyncAttemptCount + 1
      && task.sync.adapterId === input.adapterId
      && task.sync.jobId !== null
      && task.sync.requestFingerprint === requestFingerprint;
    if (replaysPriorAttempt) {
      return { status: "unchanged", task: structuredClone(task) };
    }
    if (task.sync.attemptCount !== input.expectedSyncAttemptCount) {
      throw new StoreConflictError("Task synchronization attempt is stale.", "revision");
    }
    const adapter = this.required(this.state.taskAdapterConnectors, input.adapterId, "Task Adapter Connector");
    if (!adapter.enabled) {
      throw new StoreConflictError("Task Adapter Connector is disabled.", "business_rule", "TASK_ADAPTER_DISABLED");
    }
    if (task.sync.status === "queued") {
      if (task.sync.jobId === jobId) return { status: "unchanged", task: structuredClone(task) };
      throw new StoreConflictError("Task synchronization is already queued.");
    }
    const now = new Date().toISOString();
    task.sync = {
      ...task.sync,
      status: "queued",
      adapterId: input.adapterId,
      jobId,
      requestFingerprint,
      attemptCount: task.sync.attemptCount + 1,
      lastAttemptAt: now,
      lastError: null
    };
    task.updatedAt = now;
    this.appendTaskTransition(task, "sync_requested", "owner", { adapterId: input.adapterId, jobId, requestFingerprint });
    await this.recordAudit("task.sync.requested", "task", task.id, { adapterId: input.adapterId, jobId, requestFingerprint });
    return { status: "updated", task: structuredClone(task) };
    });
  }

  async completeTaskSync(id: string, jobId: string, externalId: string, requestFingerprint: string): Promise<TaskSyncMutationResult> {
    return this.serializeTaskMutation(async (tasks) => {
    const task = this.required(tasks, id, "Task");
    if (task.sync.status !== "queued"
      || task.sync.jobId !== jobId
      || !task.sync.requestFingerprint
      || task.sync.requestFingerprint !== requestFingerprint
      || requestFingerprint !== taskSyncRequestFingerprint(task)) {
      return { status: "stale", task: structuredClone(task) };
    }
    const now = new Date().toISOString();
    task.sync = { ...task.sync, status: "synced", externalId, lastError: null, syncedAt: now };
    task.updatedAt = now;
    this.appendTaskTransition(task, "sync_succeeded", "system", {
      ...(task.sync.adapterId ? { adapterId: task.sync.adapterId } : {}),
      jobId,
      requestFingerprint,
      note: externalId
    });
    await this.recordAudit("task.sync.succeeded", "task", task.id, {
      adapterId: task.sync.adapterId,
      jobId,
      requestFingerprint,
      externalId
    });
    return { status: "updated", task: structuredClone(task) };
    });
  }

  async failTaskSync(binding: TaskSyncFailureBinding, error: string): Promise<TaskSyncMutationResult> {
    return this.serializeTaskMutation(async (tasks) => {
      const task = this.required(tasks, binding.taskId, "Task");
      const bindingMatches = task.sync.jobId === binding.jobId
        && task.sync.adapterId === binding.adapterId
        && task.sync.requestFingerprint === binding.requestFingerprint;
      if (task.sync.status === "failed" && bindingMatches) {
        return { status: "unchanged", task: structuredClone(task) };
      }
      if (task.sync.status !== "queued"
        || !bindingMatches
        || binding.requestFingerprint !== taskSyncRequestFingerprint(task)) {
        return { status: "stale", task: structuredClone(task) };
      }
      const now = new Date().toISOString();
      const safeError = error.slice(0, 500);
      task.sync = { ...task.sync, status: "failed", lastError: safeError, syncedAt: null };
      task.updatedAt = now;
      this.appendTaskTransition(task, "sync_failed", "system", {
        ...(task.sync.adapterId ? { adapterId: task.sync.adapterId } : {}),
        jobId: binding.jobId,
        requestFingerprint: binding.requestFingerprint,
        note: safeError
      });
      await this.recordAudit("task.sync.failed", "task", task.id, {
        adapterId: task.sync.adapterId,
        jobId: binding.jobId,
        requestFingerprint: binding.requestFingerprint,
        error: safeError
      });
      return { status: "updated", task: structuredClone(task) };
    });
  }

  async createAgent(input: CreateAgentInput, idempotencyKey?: string): Promise<Agent> {
    return this.runIdempotent("agent.create", idempotencyKey, input, () => (
      this.serializeAgentDefinitionMutation("create", () => this.createAgentRecord(input))
    ));
  }

  private async createAgentRecord(input: CreateAgentInput): Promise<Agent> {
    const normalizedInput: Omit<CreateAgentInput, "toolPackGrants"> & { toolPackGrants: ToolPackGrant[] } = {
      ...input,
      skillIds: input.skillIds ?? [],
      toolGrants: input.toolGrants ?? [],
      toolPackGrants: input.toolPackGrants ?? [],
      runtimeProfileBinding: input.runtimeProfileBinding ?? null,
      promptBinding: input.promptBinding ?? null,
      description: input.description ?? "",
      modelConnectorId: input.modelConnectorId ?? null
    };
    this.validateAgentPermissions(normalizedInput);
    const agent: Agent = {
      id: randomUUID(),
      revision: 1,
      ...normalizedInput,
      toolPackGrants: structuredClone(normalizedInput.toolPackGrants),
      runtimeProfileBinding: normalizedInput.runtimeProfileBinding ?? { ...defaultRuntimeProfileBinding },
      status: normalizedInput.modelConnectorId ? "online" : "attention",
      lifecycleStatus: "draft",
      promptBinding: normalizedInput.promptBinding,
      draftRevision: 1,
      publishedRevision: null
    };
    const revision = this.agentRevisionFromAgent(agent, 1, "created", null, null);
    await this.recordAudit("agent.created", "agent", agent.id, { revision: 1 });
    this.state.agents.push(agent);
    this.agentRevisions.set(agent.id, [revision]);
    return structuredClone(agent);
  }

  async updateAgent(id: string, input: UpdateAgentInput, expectedDraftRevision?: number): Promise<Agent> {
    return this.serializeAgentDefinitionMutation(id, () => (
      this.mutateAgentDraft(id, input, expectedDraftRevision, "agent.updated")
    ));
  }

  async setAgentModel(id: string, input: SetAgentModelInput, expectedDraftRevision?: number): Promise<Agent> {
    return this.serializeAgentDefinitionMutation(id, () => (
      this.mutateAgentDraft(
        id,
        { modelConnectorId: input.modelConnectorId },
        expectedDraftRevision,
        "agent.model.changed"
      )
    ));
  }

  private serializeAgentDefinitionMutation<T>(id: string, action: () => Promise<T>): Promise<T> {
    void id;
    const previous = this.agentDefinitionMutation;
    const run = previous.catch(() => undefined).then(action);
    const settled = run.then(() => undefined, () => undefined);
    this.agentDefinitionMutation = settled;
    return run;
  }

  private serializeTaxonomyMutation<T>(action: () => Promise<T>): Promise<T> {
    const run = this.taxonomyMutation.catch(() => undefined).then(action);
    this.taxonomyMutation = run.then(() => undefined, () => undefined);
    return run;
  }

  private serializeRoleMutation<T>(action: () => Promise<T>): Promise<T> {
    const run = this.roleMutation.catch(() => undefined).then(action);
    this.roleMutation = run.then(() => undefined, () => undefined);
    return run;
  }

  private serializeRoleReferenceMutation<T>(action: () => Promise<T>): Promise<T> {
    const run = this.roleReferenceMutation.catch(() => undefined).then(action);
    this.roleReferenceMutation = run.then(() => undefined, () => undefined);
    return run;
  }

  private serializeConnectorMutation<T>(kind: "model" | "mcp" | "task_adapter", action: () => Promise<T>): Promise<T> {
    const previous = this.connectorMutations.get(kind) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(action);
    const settled = run.then(() => undefined, () => undefined);
    this.connectorMutations.set(kind, settled);
    void settled.then(() => {
      if (this.connectorMutations.get(kind) === settled) this.connectorMutations.delete(kind);
    });
    return run;
  }

  private serializeSkillMutation<T>(action: () => Promise<T>): Promise<T> {
    const run = this.skillMutation.catch(() => undefined).then(action);
    this.skillMutation = run.then(() => undefined, () => undefined);
    return run;
  }

  private serializeToolPackMutation<T>(action: () => Promise<T>): Promise<T> {
    const run = this.toolPackMutation.catch(() => undefined).then(action);
    this.toolPackMutation = run.then(() => undefined, () => undefined);
    return run;
  }

  private serializeRuntimeProfileMutation<T>(action: () => Promise<T>): Promise<T> {
    const run = this.runtimeProfileMutation.catch(() => undefined).then(action);
    this.runtimeProfileMutation = run.then(() => undefined, () => undefined);
    return run;
  }

  private serializePromptMutation<T>(action: () => Promise<T>): Promise<T> {
    const run = this.promptMutation.catch(() => undefined).then(action);
    this.promptMutation = run.then(() => undefined, () => undefined);
    return run;
  }

  private async mutateAgentDraft(
    id: string,
    input: UpdateAgentInput,
    expectedDraftRevision: number | undefined,
    auditEvent: "agent.updated" | "agent.model.changed"
  ): Promise<Agent> {
    const agent = this.required(this.state.agents, id, "Agent");
    if (expectedDraftRevision !== undefined && (agent.draftRevision ?? 1) !== expectedDraftRevision) {
      throw new StoreConflictError("Agent draft revision is stale.", "revision");
    }
    this.validateAgentPermissions({
      modelConnectorId: input.modelConnectorId === undefined ? agent.modelConnectorId : input.modelConnectorId,
      promptBinding: input.promptBinding === undefined ? agent.promptBinding ?? null : input.promptBinding,
      skillIds: input.skillIds ?? agent.skillIds,
      toolGrants: input.toolGrants ?? agent.toolGrants,
      toolPackGrants: input.toolPackGrants ?? agent.toolPackGrants
    }, agent.modelConnectorId);
    const changed = Object.entries(input).some(([key, value]) => (
      !isDeepStrictEqual(agent[key as keyof Agent], value)
    ));
    if (!changed) return structuredClone(agent);
    const next = structuredClone(agent);
    const history = this.agentRevisions.get(id) ?? [];
    Object.assign(next, input);
    next.status = next.modelConnectorId ? "online" : "attention";
    const revisionNumber = Math.max(next.draftRevision ?? 0, ...history.map((item) => item.revision)) + 1;
    const revision = this.agentRevisionFromAgent(next, revisionNumber, "updated", null, null);
    next.draftRevision = revisionNumber;
    next.revision = this.nextAgentResourceRevision(agent);
    if (next.lifecycleStatus !== "disabled") next.lifecycleStatus = "draft";
    await this.recordAudit(auditEvent, "agent", id, auditEvent === "agent.model.changed"
      ? {
          modelConnectorId: next.modelConnectorId,
          previousRevision: agent.draftRevision ?? null,
          revision: next.draftRevision ?? 1,
          previousResourceRevision: this.agentResourceRevision(agent),
          resourceRevision: next.revision
        }
      : {
          fields: Object.keys(input),
          previousRevision: agent.draftRevision ?? null,
          revision: next.draftRevision ?? 1,
          previousResourceRevision: this.agentResourceRevision(agent),
          resourceRevision: next.revision
        });
    Object.assign(agent, next);
    this.agentRevisions.set(id, [...history, revision]);
    return structuredClone(next);
  }

  private evaluateAgentReadiness(
    id: string,
    options: { executionIsolationAttested?: boolean } = {}
  ): AgentReadiness {
    const agent = this.required(this.state.agents, id, "Agent");
    const checks: AgentReadiness["checks"] = [];
    const lifecycle = agent.lifecycleStatus ?? "published";
    const draftWithPublishedRevision = lifecycle === "draft" && agent.publishedRevision !== null && agent.publishedRevision !== undefined;
    checks.push({
      code: "lifecycle",
      status: lifecycle === "disabled" ? "blocked" : draftWithPublishedRevision ? "warning" : lifecycle === "draft" ? "blocked" : "passed",
      message: lifecycle === "disabled"
        ? "Agent 已停用。"
        : draftWithPublishedRevision
          ? "有尚未發布的草稿；正式執行仍使用上一個已發布版本。"
          : lifecycle === "draft" ? "草稿 Agent 尚未發布。" : "Agent 已發布。"
    });
    const runtimeProfileSnapshot = this.resolveRuntimeProfileSnapshot(
      agent.runtimeProfileBinding,
      agent.modelConnectorId,
      options.executionIsolationAttested
    );
    checks.push({
      code: "runtime",
      status: runtimeProfileSnapshot ? "passed" : "blocked",
      message: runtimeProfileSnapshot
        ? `Runtime Profile Rev ${runtimeProfileSnapshot.revision} 可用。`
        : !agent.runtimeProfileBinding
          ? "Agent 尚未綁定 Runtime Profile。"
          : "Runtime Profile 不存在、已停用，或與 Agent 模型綁定不一致。"
    });
    const connector = agent.modelConnectorId
      ? this.state.modelConnectors.find((candidate) => candidate.id === agent.modelConnectorId)
      : undefined;
    checks.push({
      code: "model",
      status: connector?.enabled ? "passed" : "blocked",
      message: connector?.enabled ? "模型 Connector 已啟用。" : "模型 Connector 不存在或已停用。"
    });
    const credential = connector?.credentialId ? this.state.credentials?.find((item) => item.id === connector.credentialId) : undefined;
    const localWithoutCredential = connector?.location === "local" && !connector.credentialId && !connector.hasSecret;
    const credentialExpired = credential ? credentialIsExpired(credential.expiresAt) : false;
    const credentialReady = localWithoutCredential
      || Boolean(credential && this.credentialRunnable(credential) && credential.secretRevision === connector?.secretRevision);
    checks.push({
      code: "credential",
      status: credentialReady ? "passed" : "blocked",
      message: credentialReady
        ? "模型 Connector 憑證有效。"
        : credentialExpired ? "模型 Connector 憑證已過期。" : "模型 Connector 未綁定有效憑證。"
    });
    const binding = agent.promptBinding ?? null;
    const prompt = binding ? this.state.prompts?.find((item) => item.id === binding.promptId) : undefined;
    const promptVersion = binding ? this.promptVersions.get(binding.promptId)?.find((item) => item.version === binding.version) : undefined;
    const promptReady = !binding
      ? lifecycle === "published"
      : Boolean(prompt && prompt.kind === "agent" && prompt.status !== "archived" && prompt.publishedVersion !== null
        && prompt.publishedVersion >= binding.version && promptVersion?.publishedAt);
    checks.push({
      code: "prompt",
      status: promptReady ? (binding ? "passed" : "warning") : "blocked",
      message: promptReady ? (binding ? "Prompt 版本已發布。" : "沿用舊版 Agent Prompt，尚未建立版本綁定。") : "綁定的 Prompt 版本尚未發布。"
    });
    const skillsReady = agent.skillIds.every((skillId) => {
      const skill = this.state.skills.find((item) => item.id === skillId);
      return Boolean(skill && skill.status === "approved" && skillHasCurrentApprovedValidation(skill));
    });
    checks.push({
      code: "skill",
      status: skillsReady ? "passed" : "blocked",
      message: skillsReady ? "所有 Skill 均已核准且驗證有效。" : "所有 Skill 必須已核准並通過驗證。"
    });
    const mcpToolsReady = agent.toolGrants.every((grant) => {
      const mcp = this.state.mcpConnectors.find((item) => item.id === grant.connectorId);
      return Boolean(mcp?.enabled && mcp.approvedTools.includes(grant.toolName)
        && mcp.toolRegistrations.some((item) => item.toolName === grant.toolName));
    });
    const toolPacksReady = agent.toolPackGrants.every((grant) =>
      toolPackGrantIsCurrentAndApproved(grant, this.state.toolPacks ?? [])
    );
    const toolsReady = mcpToolsReady && toolPacksReady;
    checks.push({
      code: "tool",
      status: toolsReady ? "passed" : "blocked",
      message: toolsReady ? "所有工具授權均已核准並完成註冊。" : "有工具授權未通過白名單或註冊檢查。"
    });
    const status = checks.some((check) => check.status === "blocked")
      ? "blocked"
      : checks.some((check) => check.status === "warning") ? "warning" : "ready";
    return { status, checks };
  }

  async getAgentReadiness(
    id: string,
    options: { executionIsolationAttested?: boolean } = {}
  ): Promise<AgentReadiness> {
    return this.evaluateAgentReadiness(id, options);
  }

  async getAgentRevisions(id: string): Promise<AgentRevision[]> {
    this.required(this.state.agents, id, "Agent");
    return structuredClone((this.agentRevisions.get(id) ?? []).sort((left, right) => right.revision - left.revision));
  }

  async getAgentRevision(id: string, revision: number): Promise<AgentRevision> {
    this.required(this.state.agents, id, "Agent");
    const item = this.agentRevisions.get(id)?.find((candidate) => candidate.revision === revision);
    if (!item) throw new StoreNotFoundError("Agent revision not found.");
    return structuredClone(item);
  }

  async publishAgent(id: string, input: PublishAgentInput): Promise<Agent> {
    const agent = this.required(this.state.agents, id, "Agent");
    if (agent.lifecycleStatus === "disabled") throw new StoreConflictError("Disabled Agents cannot be published.");
    if (agent.draftRevision !== input.expectedDraftRevision) {
      throw new StoreConflictError("Agent draft revision is stale.", "revision");
    }
    if (agent.publishedRevision === agent.draftRevision) {
      throw new StoreConflictError("Agent has no unpublished draft revision.");
    }
    await this.getAgentReadiness(id, { executionIsolationAttested: true });
    return this.serializeAgentDefinitionMutation(id, () => this.commitPublishedAgent(id, input));
  }

  private async commitPublishedAgent(id: string, input: PublishAgentInput): Promise<Agent> {
    const currentAgent = this.required(this.state.agents, id, "Agent");
    if (currentAgent.lifecycleStatus === "disabled") throw new StoreConflictError("Disabled Agents cannot be published.");
    if (currentAgent.draftRevision !== input.expectedDraftRevision) {
      throw new StoreConflictError("Agent draft revision is stale.", "revision");
    }
    if (currentAgent.publishedRevision === currentAgent.draftRevision) {
      throw new StoreConflictError("Agent has no unpublished draft revision.");
    }
    const readiness = this.evaluateAgentReadiness(id, { executionIsolationAttested: true });
    if (readiness.checks.some((check) => check.status === "blocked" && check.code !== "lifecycle")) {
      throw new StoreConflictError("Agent readiness has blocking checks.");
    }
    const revision = this.agentRevisions.get(id)?.find((candidate) => candidate.revision === input.expectedDraftRevision);
    if (!revision) throw new StoreNotFoundError("Agent draft revision not found.");
    const publishedAt = new Date().toISOString();
    const persisted: Agent = {
      ...currentAgent,
      ...this.agentFieldsFromRevision(revision),
      revision: this.nextAgentResourceRevision(currentAgent),
      lifecycleStatus: "published",
      publishedRevision: revision.revision,
      draftRevision: revision.revision,
      status: revision.modelConnectorId ? "online" : "attention"
    };
    await this.recordAudit("agent.published", "agent", id, {
      revision: revision.revision,
      previousResourceRevision: this.agentResourceRevision(currentAgent),
      resourceRevision: persisted.revision
    });
    revision.publishedAt = publishedAt;
    Object.assign(currentAgent, persisted);
    return structuredClone(currentAgent);
  }

  async rollbackAgent(id: string, input: RollbackAgentInput): Promise<Agent> {
    return this.serializeAgentDefinitionMutation(id, () => this.rollbackAgentDraft(id, input));
  }

  private async rollbackAgentDraft(id: string, input: RollbackAgentInput): Promise<Agent> {
    const agent = this.required(this.state.agents, id, "Agent");
    if (agent.publishedRevision !== input.expectedPublishedRevision) throw new StoreConflictError("Agent published revision is stale.", "revision");
    if (agent.draftRevision !== input.expectedDraftRevision) throw new StoreConflictError("Agent draft revision is stale.", "revision");
    if (agent.draftRevision !== agent.publishedRevision) {
      throw new StoreConflictError("Agent has an unpublished draft; publish it before restoring an earlier revision.");
    }
    const target = this.agentRevisions.get(id)?.find((candidate) => candidate.revision === input.revision);
    if (!target) throw new StoreNotFoundError("Agent revision not found.");
    if (agent.lifecycleStatus === "disabled") throw new StoreConflictError("Disabled Agents cannot be rolled back.");
    this.validateAgentPermissions(this.agentFieldsFromRevision(target), agent.modelConnectorId);
    const history = this.agentRevisions.get(agent.id) ?? [];
    const revisionNumber = Math.max(agent.draftRevision ?? 0, ...history.map((item) => item.revision)) + 1;
    const restoredAgent: Agent = { ...agent, ...this.agentFieldsFromRevision(target) };
    const draft = this.agentRevisionFromAgent(restoredAgent, revisionNumber, "rollback", target.revision, null);
    const persisted: Agent = {
      ...restoredAgent,
      revision: this.nextAgentResourceRevision(agent),
      draftRevision: revisionNumber,
      lifecycleStatus: "draft"
    };
    await this.recordAudit("agent.rolled_back", "agent", id, {
      previousPublishedRevision: input.expectedPublishedRevision,
      revision: revisionNumber,
      restoredFromRevision: target.revision,
      previousResourceRevision: this.agentResourceRevision(agent),
      resourceRevision: persisted.revision
    });
    history.push(draft);
    this.agentRevisions.set(agent.id, history);
    Object.assign(agent, persisted);
    return structuredClone(agent);
  }

  async setAgentStatus(id: string, input: SetAgentStatusInput): Promise<Agent> {
    return this.serializeAgentDefinitionMutation(id, () => this.setAgentStatusDraft(id, input));
  }

  private async setAgentStatusDraft(id: string, input: SetAgentStatusInput): Promise<Agent> {
    const agent = this.required(this.state.agents, id, "Agent");
    const currentRevision = this.agentResourceRevision(agent);
    if (input.expectedRevision !== currentRevision) {
      throw new StoreConflictError("Agent revision is stale.", "revision");
    }
    const currentStatus = agent.lifecycleStatus ?? (agent.publishedRevision == null ? "draft" : "published");
    if (input.status === currentStatus) return structuredClone(agent);
    const disablingPublishedAgent = input.status === "disabled"
      && currentStatus !== "disabled"
      && agent.publishedRevision != null;
    const reactivatingPublishedAgent = input.status === "published"
      && currentStatus === "disabled"
      && agent.publishedRevision != null;
    const recoveringLegacyDraft = input.status === "draft"
      && currentStatus === "disabled"
      && agent.publishedRevision == null;
    if (!disablingPublishedAgent && !reactivatingPublishedAgent && !recoveringLegacyDraft) {
      throw new StoreConflictError("Invalid Agent lifecycle transition; publish draft revisions through the publish action.");
    }
    const persisted: Agent = {
      ...agent,
      revision: currentRevision + 1,
      lifecycleStatus: input.status,
      status: input.status === "disabled" ? "offline" : agent.modelConnectorId ? "online" : "attention"
    };
    await this.recordAudit("agent.status.changed", "agent", id, {
      previousStatus: currentStatus,
      status: persisted.lifecycleStatus,
      previousRevision: currentRevision,
      revision: persisted.revision
    });
    Object.assign(agent, persisted);
    return structuredClone(agent);
  }

  async getCredentials(): Promise<Credential[]> {
    return structuredClone(this.state.credentials ?? []);
  }

  async createCredential(
    input: CreateCredentialMetadataInput,
    secret?: SecretInput,
    idempotencyKey?: string
  ): Promise<Credential> {
    const replayInput = credentialCreateIdempotencyInput(input, secret, idempotencyKey);
    return this.runIdempotent("credential.create", idempotencyKey, replayInput, () => (
      this.serializeAgentDefinitionMutation("credential:create", () => this.createCredentialDraft(input, secret))
    ));
  }

  private async createCredentialDraft(input: CreateCredentialMetadataInput, secret?: SecretInput): Promise<Credential> {
    this.assertNoPlaintextSecret(input);
    this.assertCredentialNameAvailable(input.name);
    const credential = this.buildCredentialRecord(randomUUID(), input, secret);
    await this.recordCredentialCreatedAudit(credential);
    this.state.credentials ??= [];
    this.state.credentials.push(credential);
    if (secret?.ciphertext) this.credentialSecrets.set(credential.id, secret.ciphertext);
    return structuredClone(credential);
  }

  async updateCredential(id: string, input: UpdateCredentialMetadataInput): Promise<Credential> {
    return this.serializeAgentDefinitionMutation(id, () => this.updateCredentialDraft(id, input));
  }

  private async updateCredentialDraft(id: string, input: UpdateCredentialMetadataInput): Promise<Credential> {
    this.assertNoPlaintextSecret(input);
    const credential = this.required(this.state.credentials ?? [], id, "Credential");
    const { expectedUpdatedAt, ...changes } = input;
    if (credential.updatedAt !== expectedUpdatedAt) {
      throw new StoreConflictError("Credential metadata is stale.", "revision");
    }
    if (credential.status === "revoked") throw new StoreConflictError("A revoked Credential is terminal.");
    const nextName = changes.name ?? credential.name;
    if ((this.state.credentials ?? []).some((item) => item.id !== id && this.sameName(item.name, nextName))) {
      throw new StoreConflictError("Credential name already exists.");
    }
    const now = nextTimestamp(credential.updatedAt);
    const persisted: Credential = {
      ...credential,
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.provider !== undefined ? { provider: changes.provider } : {}),
      ...(changes.kind !== undefined ? { kind: changes.kind } : {}),
      ...(changes.location !== undefined ? { location: changes.location } : {}),
      ...(changes.expiresAt !== undefined ? { expiresAt: changes.expiresAt } : {}),
      updatedAt: now
    };
    await this.recordAudit("credential.updated", "credential", id, {
      fields: Object.keys(changes),
      secretRotated: false,
      status: persisted.status,
      secretRevision: persisted.secretRevision
    });
    Object.assign(credential, persisted);
    this.syncCredentialBindings(credential);
    return structuredClone(persisted);
  }

  async rotateCredential(
    input: RotateCredentialMetadataInput,
    secret: SecretInput,
    maskedHint?: string | null,
    idempotencyKey?: string
  ): Promise<Credential> {
    const replayInput = credentialRotationIdempotencyInput(input, secret, maskedHint, idempotencyKey);
    return this.runIdempotent("credential.rotate", idempotencyKey, replayInput, () => (
      this.serializeAgentDefinitionMutation(input.credentialId, () => (
        this.rotateCredentialDraft(input, secret, maskedHint)
      ))
    ));
  }

  async replayCredentialRotation(
    input: RotateCredentialMetadataInput,
    secret: SecretInput,
    maskedHint: string | null | undefined,
    idempotencyKey: string
  ): Promise<Credential | null> {
    return this.replayIdempotent(
      "credential.rotate",
      idempotencyKey,
      credentialRotationIdempotencyInput(input, secret, maskedHint, idempotencyKey)
    );
  }

  private async rotateCredentialDraft(input: RotateCredentialMetadataInput, secret: SecretInput, maskedHint?: string | null): Promise<Credential> {
    this.assertNoPlaintextSecret(input);
    const credential = this.required(this.state.credentials ?? [], input.credentialId, "Credential");
    if (credential.status === "revoked") throw new StoreConflictError("A revoked Credential is terminal.");
    if (!secret.ciphertext) throw new StoreConflictError("Credential rotation requires encrypted ciphertext.");
    if (input.expectedSecretRevision !== credential.secretRevision) {
      throw new StoreConflictError("Credential secret revision is stale.", "revision");
    }
    const rotatedAt = nextTimestamp(credential.updatedAt);
    const persisted: Credential = {
      ...credential,
      secretRevision: credential.secretRevision + 1,
      hasSecret: true,
      maskedHint: maskedHint === undefined ? credential.maskedHint : maskedHint,
      rotatedAt,
      updatedAt: rotatedAt
    };
    await this.recordAudit("credential.rotated", "credential", credential.id, {
      secretRevision: persisted.secretRevision,
      hasMaskedHint: Boolean(persisted.maskedHint)
    });
    Object.assign(credential, persisted);
    this.credentialSecrets.set(credential.id, secret.ciphertext);
    this.syncCredentialBindings(credential);
    return structuredClone(persisted);
  }

  async setCredentialStatus(
    id: string,
    input: UpdateCredentialStatusInput,
    idempotencyKey?: string
  ): Promise<Credential> {
    return this.runIdempotent("credential.status", idempotencyKey, { credentialId: id, ...input }, () => (
      this.serializeAgentDefinitionMutation(id, () => this.setCredentialStatusDraft(id, input))
    ));
  }

  private async setCredentialStatusDraft(id: string, input: UpdateCredentialStatusInput): Promise<Credential> {
    const credential = this.required(this.state.credentials ?? [], id, "Credential");
    if (credential.updatedAt !== input.expectedUpdatedAt) {
      throw new StoreConflictError("Credential state is stale.", "revision");
    }
    if (credential.status === "revoked" && input.status !== "revoked") {
      throw new StoreConflictError("A revoked Credential is terminal.");
    }
    if (credential.status === input.status) return structuredClone(credential);
    const persisted: Credential = {
      ...credential,
      status: input.status,
      updatedAt: nextTimestamp(credential.updatedAt)
    };
    await this.recordAudit("credential.status.changed", "credential", id, {
      previousStatus: credential.status,
      status: persisted.status
    });
    Object.assign(credential, persisted);
    this.syncCredentialBindings(credential);
    return structuredClone(persisted);
  }

  async getCredentialSecret(id: string): Promise<string | null> {
    this.required(this.state.credentials ?? [], id, "Credential");
    return this.credentialSecrets.get(id) ?? null;
  }

  async getPrompts(): Promise<PromptTemplate[]> {
    return structuredClone(this.state.prompts ?? []);
  }

  async createPrompt(input: CreatePromptInput, idempotencyKey?: string): Promise<PromptTemplate> {
    return this.runIdempotent("prompt.create", idempotencyKey, input, () => (
      this.serializePromptMutation(() => this.createPromptRecord(input))
    ));
  }

  private async createPromptRecord(input: CreatePromptInput): Promise<PromptTemplate> {
    if (this.state.prompts?.some((item) => this.sameName(item.name, input.name))) {
      throw new StoreConflictError("Prompt name already exists.");
    }
    this.validatePromptTokens(input.content, input.variables);
    const now = new Date().toISOString();
    const prompt: PromptTemplate = {
      id: randomUUID(),
      name: input.name,
      kind: input.kind,
      description: input.description,
      owner: input.owner,
      status: "draft",
      currentVersion: 1,
      publishedVersion: null,
      createdAt: now,
      updatedAt: now
    };
    const version = this.makePromptVersion(prompt.id, 1, input.content, input.variables, "created", null, now);
    await this.recordAudit("prompt.created", "prompt", prompt.id, { version: prompt.currentVersion, kind: prompt.kind });
    this.state.prompts ??= [];
    this.state.prompts.push(prompt);
    this.promptVersions.set(prompt.id, [version]);
    return structuredClone(prompt);
  }

  async updatePrompt(id: string, input: UpdatePromptInput): Promise<PromptTemplate> {
    return this.serializePromptMutation(() => this.updatePromptRecord(id, input));
  }

  private async updatePromptRecord(id: string, input: UpdatePromptInput): Promise<PromptTemplate> {
    const prompt = this.required(this.state.prompts ?? [], id, "Prompt");
    if (prompt.status === "archived") throw new StoreConflictError("An archived Prompt is terminal.");
    if (prompt.currentVersion !== input.expectedCurrentVersion) throw new StoreConflictError("Prompt version is stale.", "revision");
    const nextName = input.name ?? prompt.name;
    if ((this.state.prompts ?? []).some((item) => item.id !== id && this.sameName(item.name, nextName))) {
      throw new StoreConflictError("Prompt name already exists.");
    }
    const current = this.requiredPromptVersion(id, prompt.currentVersion);
    const content = input.content ?? current.content;
    const variables = input.variables ?? current.variables;
    this.validatePromptTokens(content, variables);
    const now = new Date().toISOString();
    const nextVersion = prompt.currentVersion + 1;
    const version = this.makePromptVersion(id, nextVersion, content, variables, "updated", null, now);
    const persisted: PromptTemplate = {
      ...prompt,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      currentVersion: nextVersion,
      updatedAt: now,
      status: "draft"
    };
    await this.recordAudit("prompt.updated", "prompt", id, {
      fields: Object.keys(input).filter((field) => field !== "expectedCurrentVersion"),
      previousVersion: input.expectedCurrentVersion,
      version: persisted.currentVersion
    });
    Object.assign(prompt, persisted);
    this.promptVersions.get(id)!.push(version);
    return structuredClone(persisted);
  }

  async publishPrompt(id: string, input: PublishPromptInput): Promise<PromptTemplate> {
    return this.serializePromptMutation(() => this.publishPromptRecord(id, input));
  }

  private async publishPromptRecord(id: string, input: PublishPromptInput): Promise<PromptTemplate> {
    const prompt = this.required(this.state.prompts ?? [], id, "Prompt");
    if (prompt.status === "archived") throw new StoreConflictError("An archived Prompt is terminal.");
    if (prompt.currentVersion !== input.expectedCurrentVersion) throw new StoreConflictError("Prompt version is stale.", "revision");
    const version = this.requiredPromptVersion(id, input.version);
    if (version.publishedAt) {
      throw new StoreConflictError("Prompt version is already published.");
    }
    if (version.version !== prompt.currentVersion) {
      throw new StoreConflictError("Only the current Prompt version can be published; use rollback for historical content.");
    }
    const now = new Date().toISOString();
    const persistedVersion: PromptVersion = { ...version, publishedAt: now };
    const persisted: PromptTemplate = {
      ...prompt,
      publishedVersion: version.version,
      status: "published",
      updatedAt: now
    };
    await this.recordAudit("prompt.published", "prompt", id, { version: input.version });
    Object.assign(version, persistedVersion);
    Object.assign(prompt, persisted);
    return structuredClone(persisted);
  }

  async rollbackPrompt(id: string, input: RollbackPromptInput): Promise<PromptTemplate> {
    return this.serializePromptMutation(() => this.rollbackPromptRecord(id, input));
  }

  private async rollbackPromptRecord(id: string, input: RollbackPromptInput): Promise<PromptTemplate> {
    const prompt = this.required(this.state.prompts ?? [], id, "Prompt");
    if (prompt.status === "archived") throw new StoreConflictError("An archived Prompt is terminal.");
    if (prompt.currentVersion !== input.expectedCurrentVersion) throw new StoreConflictError("Prompt version is stale.", "revision");
    if (input.version >= prompt.currentVersion) {
      throw new StoreConflictError("Prompt rollback target must be older than the current version.");
    }
    const target = this.requiredPromptVersion(id, input.version);
    const now = new Date().toISOString();
    const nextVersion = prompt.currentVersion + 1;
    const version = this.makePromptVersion(id, nextVersion, target.content, target.variables, "rollback", target.version, now);
    version.publishedAt = now;
    const persisted: PromptTemplate = {
      ...prompt,
      currentVersion: nextVersion,
      publishedVersion: nextVersion,
      status: "published",
      updatedAt: now
    };
    await this.recordAudit("prompt.rolled_back", "prompt", id, {
      previousVersion: input.expectedCurrentVersion,
      version: version.version,
      restoredFromVersion: input.version
    });
    this.promptVersions.get(id)!.push(version);
    Object.assign(prompt, persisted);
    return structuredClone(persisted);
  }

  async archivePrompt(id: string, input: ArchivePromptInput): Promise<PromptTemplate> {
    return this.serializePromptMutation(() => this.archivePromptRecord(id, input));
  }

  private async archivePromptRecord(id: string, input: ArchivePromptInput): Promise<PromptTemplate> {
    const prompt = this.required(this.state.prompts ?? [], id, "Prompt");
    if (prompt.currentVersion !== input.expectedCurrentVersion) throw new StoreConflictError("Prompt version is stale.", "revision");
    if (prompt.status === "archived") return structuredClone(prompt);
    const persisted: PromptTemplate = {
      ...prompt,
      status: "archived",
      updatedAt: new Date().toISOString()
    };
    await this.recordAudit("prompt.archived", "prompt", id, { version: prompt.currentVersion });
    Object.assign(prompt, persisted);
    return structuredClone(persisted);
  }

  async getPromptVersions(id: string): Promise<PromptVersion[]> {
    this.required(this.state.prompts ?? [], id, "Prompt");
    return structuredClone((this.promptVersions.get(id) ?? []).sort((left, right) => right.version - left.version));
  }

  async getPromptVersion(id: string, version: number): Promise<PromptVersion> {
    this.required(this.state.prompts ?? [], id, "Prompt");
    return structuredClone(this.requiredPromptVersion(id, version));
  }

  async createAgentTeam(input: CreateAgentTeamInput, idempotencyKey?: string): Promise<AgentTeam> {
    return this.runIdempotent("agent_team.create", idempotencyKey, input, () => (
      this.serializeRoleReferenceMutation(() => this.createAgentTeamRecord(input))
    ));
  }

  private async createAgentTeamRecord(input: CreateAgentTeamInput): Promise<AgentTeam> {
    if (this.state.agentTeams?.some((item) => this.sameName(item.name, input.name))) throw new StoreConflictError("Agent Team name already exists.");
    this.validateTeamMembers(input.members);
    const now = new Date().toISOString();
    const team: AgentTeam = { id: randomUUID(), revision: 1, ...structuredClone(input), status: "active", createdAt: now, updatedAt: now };
    await this.recordAudit("agent_team.created", "agent_team", team.id, { memberCount: team.members.length });
    this.state.agentTeams ??= [];
    this.state.agentTeams.push(team);
    return structuredClone(team);
  }

  async updateAgentTeam(id: string, input: UpdateAgentTeamInput): Promise<AgentTeam> {
    return this.serializeRoleReferenceMutation(() => this.updateAgentTeamRecord(id, input));
  }

  private async updateAgentTeamRecord(id: string, input: UpdateAgentTeamInput): Promise<AgentTeam> {
    const team = this.required(this.state.agentTeams ?? [], id, "Agent Team");
    const { expectedRevision, ...changes } = input;
    if (team.revision !== expectedRevision) throw new StoreConflictError("Agent Team revision is stale.", "revision");
    if (team.status === "archived") throw new StoreConflictError("An archived Agent Team is terminal.");
    const name = changes.name ?? team.name;
    if ((this.state.agentTeams ?? []).some((item) => item.id !== id && this.sameName(item.name, name))) throw new StoreConflictError("Agent Team name already exists.");
    const members = changes.members ?? team.members;
    if (changes.status !== "archived") this.validateTeamMembers(members);
    const changed = name !== team.name
      || (changes.description ?? team.description) !== team.description
      || (changes.status ?? team.status) !== team.status
      || JSON.stringify(members) !== JSON.stringify(team.members);
    if (!changed) return structuredClone(team);
    const persisted: AgentTeam = {
      ...team,
      name,
      description: changes.description ?? team.description,
      members: structuredClone(members),
      status: changes.status ?? team.status,
      revision: team.revision + 1,
      updatedAt: new Date().toISOString()
    };
    await this.recordAudit("agent_team.updated", "agent_team", id, {
      fields: Object.keys(input).filter((field) => field !== "expectedRevision"),
      previousRevision: input.expectedRevision,
      revision: persisted.revision,
      memberCount: persisted.members.length,
      status: persisted.status
    });
    Object.assign(team, persisted);
    return structuredClone(persisted);
  }

  async createMeetingPreset(input: CreateMeetingPresetInput, idempotencyKey?: string): Promise<MeetingPreset> {
    return this.runIdempotent("meeting_preset.create", idempotencyKey, input, () => (
      this.serializeRoleReferenceMutation(() => this.createMeetingPresetRecord(input))
    ));
  }

  private async createMeetingPresetRecord(input: CreateMeetingPresetInput): Promise<MeetingPreset> {
    if (this.state.meetingPresets?.some((item) => this.sameName(item.name, input.name))) throw new StoreConflictError("Meeting Preset name already exists.");
    if (input.teamId) this.requiredActiveTeam(input.teamId);
    const now = new Date().toISOString();
    const preset: MeetingPreset = { id: randomUUID(), revision: 1, ...structuredClone(input), status: "active", createdAt: now, updatedAt: now };
    await this.recordAudit("meeting_preset.created", "meeting_preset", preset.id, {
      teamId: preset.teamId,
      agendaItemCount: preset.agendaItems.length
    });
    this.state.meetingPresets ??= [];
    this.state.meetingPresets.push(preset);
    return structuredClone(preset);
  }

  async updateMeetingPreset(id: string, input: UpdateMeetingPresetInput): Promise<MeetingPreset> {
    return this.serializeRoleReferenceMutation(() => this.updateMeetingPresetRecord(id, input));
  }

  private async updateMeetingPresetRecord(id: string, input: UpdateMeetingPresetInput): Promise<MeetingPreset> {
    const preset = this.required(this.state.meetingPresets ?? [], id, "Meeting Preset");
    const { expectedRevision, ...changes } = input;
    if (preset.revision !== expectedRevision) throw new StoreConflictError("Meeting Preset revision is stale.", "revision");
    if (preset.status === "archived") throw new StoreConflictError("An archived Meeting Preset is terminal.");
    const name = changes.name ?? preset.name;
    if ((this.state.meetingPresets ?? []).some((item) => item.id !== id && this.sameName(item.name, name))) throw new StoreConflictError("Meeting Preset name already exists.");
    const teamId = changes.teamId === undefined ? preset.teamId : changes.teamId;
    if (teamId && changes.status !== "archived") this.requiredActiveTeam(teamId);
    const changed = name !== preset.name
      || (changes.description ?? preset.description) !== preset.description
      || teamId !== preset.teamId
      || (changes.mode ?? preset.mode) !== preset.mode
      || (changes.automation ?? preset.automation) !== preset.automation
      || (changes.durationMinutes ?? preset.durationMinutes) !== preset.durationMinutes
      || (changes.status ?? preset.status) !== preset.status
      || JSON.stringify(changes.agendaItems ?? preset.agendaItems) !== JSON.stringify(preset.agendaItems);
    if (!changed) return structuredClone(preset);
    const persisted: MeetingPreset = {
      ...preset,
      name,
      description: changes.description ?? preset.description,
      teamId,
      mode: changes.mode ?? preset.mode,
      automation: changes.automation ?? preset.automation,
      durationMinutes: changes.durationMinutes ?? preset.durationMinutes,
      agendaItems: structuredClone(changes.agendaItems ?? preset.agendaItems),
      status: changes.status ?? preset.status,
      revision: preset.revision + 1,
      updatedAt: new Date().toISOString()
    };
    await this.recordAudit("meeting_preset.updated", "meeting_preset", id, {
      fields: Object.keys(input).filter((field) => field !== "expectedRevision"),
      previousRevision: input.expectedRevision,
      revision: persisted.revision,
      status: persisted.status
    });
    Object.assign(preset, persisted);
    return structuredClone(persisted);
  }

  async createRole(input: CreateRoleInput, idempotencyKey?: string): Promise<Role> {
    return this.runIdempotent("role.create", idempotencyKey, input, () => (
      this.serializeRoleMutation(() => this.createRoleRecord(input))
    ));
  }

  private async createRoleRecord(input: CreateRoleInput): Promise<Role> {
    const parsed = createRoleSchema.parse(input);
    if (!rolePolicyCombinationIsValid(parsed)) {
      throw new StoreConflictError("External tools require the Agent declared data scope.");
    }
    const role: Role = { id: randomUUID(), ...parsed, version: 1, deletedAt: null };
    const version = createRoleVersion(role, "created");
    await this.recordAudit("role.created", "role", role.id, {
      version: role.version,
      templateKey: role.templateKey,
      toolPolicy: role.toolPolicy,
      dataPolicy: role.dataPolicy
    });
    this.state.roles.push(role);
    this.roleVersions.push(version);
    return structuredClone(role);
  }

  async updateRole(id: string, input: UpdateRoleInput, expectedCurrentVersion: number): Promise<Role> {
    return this.serializeRoleMutation(() => this.updateRoleRecord(id, input, expectedCurrentVersion));
  }

  private async updateRoleRecord(id: string, input: UpdateRoleInput, expectedCurrentVersion: number): Promise<Role> {
    const role = this.requiredActiveRole(id);
    this.assertRoleVersion(role, expectedCurrentVersion);
    const changed = Object.entries(input).some(([field, value]) => role[field as keyof Role] !== value);
    if (!changed) return structuredClone(role);
    const nextPolicy = {
      toolPolicy: input.toolPolicy ?? role.toolPolicy,
      dataPolicy: input.dataPolicy ?? role.dataPolicy
    };
    if (!rolePolicyCombinationIsValid(nextPolicy)) {
      throw new StoreConflictError("External tools require the Agent declared data scope.");
    }
    const nextRole = structuredClone(role);
    Object.assign(nextRole, input, { version: role.version + 1 });
    const version = createRoleVersion(nextRole, "updated");
    const fields = Object.entries(input)
      .filter(([field, value]) => role[field as keyof Role] !== value)
      .map(([field]) => field);
    await this.recordAudit("role.updated", "role", role.id, {
      fields,
      previousVersion: role.version,
      version: nextRole.version,
      templateKey: nextRole.templateKey,
      toolPolicy: nextRole.toolPolicy,
      dataPolicy: nextRole.dataPolicy
    });
    Object.assign(role, nextRole);
    this.roleVersions.push(version);
    return structuredClone(nextRole);
  }

  async getRoleVersions(id: string): Promise<RoleVersion[]> {
    const versions = this.roleVersions.filter((version) => version.roleId === id);
    if (versions.length === 0 && !this.state.roles.some((role) => role.id === id)) {
      throw new StoreNotFoundError("Role version history not found.");
    }
    return structuredClone(versions.sort((left, right) => right.version - left.version));
  }

  async getRoleLifecycle(id: string): Promise<RoleLifecycleView> {
    const role = this.requiredActiveRole(id);
    const meetingIds = new Set(this.state.participants.filter((participant) => participant.roleId === id).map((participant) => participant.meetingId));
    const meetings = this.state.meetings.filter((meeting) => meetingIds.has(meeting.id));
    const unfinishedMeetingCount = meetings.filter((meeting) => meeting.state !== "closed").length;
    const historicalMeetingCount = meetings.filter((meeting) => meeting.state === "closed").length;
    const activeTeamCount = (this.state.agentTeams ?? []).filter((team) =>
      team.status === "active" && team.members.some((member) => member.roleId === id)
    ).length;
    const versions = await this.getRoleVersions(id);
    const recorded = new Set(versions.map((version) => version.version));
    const missingVersions = Array.from({ length: role.version }, (_value, index) => index + 1).filter((version) => !recorded.has(version));
    const blockers = [
      unfinishedMeetingCount > 0 ? `${unfinishedMeetingCount} unfinished Meeting(s) still use this Role.` : null,
      activeTeamCount > 0 ? `${activeTeamCount} active Agent Team(s) still use this Role.` : null
    ].filter((item): item is string => item !== null);
    return {
      role: structuredClone(role),
      versions,
      missingVersions,
      canDelete: blockers.length === 0,
      blockerReason: blockers.length > 0 ? blockers.join(" ") : null,
      unfinishedMeetingCount,
      activeTeamCount,
      historicalMeetingCount
    };
  }

  async rollbackRole(id: string, version: number, expectedCurrentVersion: number): Promise<Role> {
    return this.serializeRoleMutation(async () => {
      const target = this.roleVersions.find((candidate) => candidate.roleId === id && candidate.version === version);
      if (!target) throw new StoreNotFoundError("Role version not found.");
      return this.restoreRoleVersionRecord(id, target, expectedCurrentVersion);
    });
  }

  async restoreRoleVersion(id: string, target: RoleVersion, expectedCurrentVersion: number): Promise<Role> {
    return this.serializeRoleMutation(() => this.restoreRoleVersionRecord(id, target, expectedCurrentVersion));
  }

  private async restoreRoleVersionRecord(id: string, target: RoleVersion, expectedCurrentVersion: number): Promise<Role> {
    const role = this.requiredActiveRole(id);
    this.assertRoleVersion(role, expectedCurrentVersion);
    if (target.roleId !== id) throw new StoreConflictError("Role version belongs to another Role.");
    if (target.version === role.version) throw new StoreConflictError("The selected Role version is already the current version.");
    if (!rolePolicyCombinationIsValid(target)) {
      throw new StoreConflictError("External tools require the Agent declared data scope.");
    }
    const nextRole: Role = { ...role,
      name: target.name,
      usageContext: target.usageContext,
      responsibility: target.responsibility,
      speakingGuidance: target.speakingGuidance,
      decisionScope: target.decisionScope,
      constraints: target.constraints,
      templateKey: target.templateKey,
      toolPolicy: target.toolPolicy,
      dataPolicy: target.dataPolicy,
      version: role.version + 1
    };
    const restored = createRoleVersion(nextRole, "rollback", target.version);
    await this.recordAudit("role.rolled_back", "role", role.id, {
      previousVersion: role.version,
      version: nextRole.version,
      restoredFromVersion: target.version,
      templateKey: nextRole.templateKey,
      toolPolicy: nextRole.toolPolicy,
      dataPolicy: nextRole.dataPolicy
    });
    Object.assign(role, nextRole);
    this.roleVersions.push(restored);
    return structuredClone(nextRole);
  }

  async deleteRole(
    id: string,
    expectedCurrentVersion: number,
    idempotencyKey?: string
  ): Promise<RoleDeletionResult> {
    return this.runIdempotent("role.delete", idempotencyKey, { roleId: id, expectedCurrentVersion }, () => (
      this.serializeRoleMutation(() => (
        this.serializeRoleReferenceMutation(() => this.deleteRoleRecord(id, expectedCurrentVersion))
      ))
    ));
  }

  private async deleteRoleRecord(id: string, expectedCurrentVersion: number): Promise<RoleDeletionResult> {
    const role = this.requiredActiveRole(id);
    this.assertRoleVersion(role, expectedCurrentVersion);
    const meetingIds = new Set(this.state.participants.filter((participant) => participant.roleId === id).map((participant) => participant.meetingId));
    const meetings = this.state.meetings.filter((meeting) => meetingIds.has(meeting.id));
    const unfinishedMeetingCount = meetings.filter((meeting) => meeting.state !== "closed").length;
    if (unfinishedMeetingCount > 0) throw new StoreConflictError("An unfinished Meeting still uses this Role.");
    const activeTeamCount = (this.state.agentTeams ?? []).filter((team) =>
      team.status === "active" && team.members.some((member) => member.roleId === id)
    ).length;
    if (activeTeamCount > 0) throw new StoreConflictError("An active Agent Team still uses this Role.");
    const historicalMeetingCount = meetings.filter((meeting) => meeting.state === "closed").length;
    const deletedAt = new Date().toISOString();
    await this.recordAudit("role.deleted", "role", role.id, {
      version: role.version,
      historicalMeetingCount,
      deletionMode: "tombstone"
    });
    role.deletedAt = deletedAt;
    return { id: role.id, historicalMeetingCount };
  }

  async createSkill(input: CreateSkillInput, idempotencyKey?: string): Promise<Skill> {
    return this.runIdempotent("skill.create", idempotencyKey, input, () => (
      this.serializeSkillMutation(() => this.createSkillRecord(input))
    ));
  }

  private async createSkillRecord(input: CreateSkillInput): Promise<Skill> {
    if (this.state.skills.some((skill) => this.sameName(skill.name, input.name) && skill.version === input.version)) {
      throw new StoreConflictError("Skill name and version already exist.");
    }
    const contentDigest = skillContentDigest(input);
    const skill: Skill = {
      id: randomUUID(),
      ...input,
      contentDigest,
      validation: { result: "pending", summary: "尚未記錄人工驗證證據。", checkedAt: null, contentDigest: null },
      status: "draft",
      approvedAt: null,
      revokedAt: null,
      revocationReason: null
    };
    await this.recordAudit("skill.created", "skill", skill.id, this.skillAuditDetail(skill));
    this.state.skills.push(skill);
    return structuredClone(skill);
  }

  async setSkillStatus(id: string, input: SetSkillStatusInput): Promise<Skill> {
    return this.serializeSkillMutation(() => this.setSkillStatusDraft(id, input));
  }

  private async setSkillStatusDraft(id: string, input: SetSkillStatusInput): Promise<Skill> {
    const skill = this.required(this.state.skills, id, "Skill");
    const { status, expectedCheckedAt } = input;
    if (skill.validation.checkedAt !== expectedCheckedAt) {
      throw new StoreConflictError("Skill validation evidence is stale.", "revision");
    }
    const previousStatus = skill.status;
    if (skill.status === "revoked") throw new StoreConflictError("A revoked Skill is terminal.");
    if (status === "draft") {
      if (skill.status !== "draft") throw new StoreConflictError("Approved Skills cannot return to draft.");
      return structuredClone(skill);
    }
    if (skill.status === "approved") {
      if (!skillHasCurrentApprovedValidation(skill)) throw new StoreConflictError("Skill validation digest does not match current content.");
      return structuredClone(skill);
    }
    if (skill.status !== "draft") throw new StoreConflictError("Skill is not eligible for approval.");
    if (skill.validation.result !== "passed") throw new StoreConflictError("Skill approval requires passed validation.");
    const currentDigest = skillContentDigest(skill);
    if (skill.contentDigest !== currentDigest || skill.validation.contentDigest !== currentDigest) {
      throw new StoreConflictError("Skill validation digest does not match current content.");
    }
    const next = structuredClone(skill);
    next.status = "approved";
    next.approvedAt = new Date().toISOString();
    await this.recordAudit("skill.status.changed", "skill", skill.id, {
      ...this.skillAuditDetail(next),
      previousStatus,
      currentStatus: next.status
    });
    Object.assign(skill, next);
    return structuredClone(next);
  }

  async validateSkill(id: string, input: ValidateSkillInput): Promise<Skill> {
    return this.serializeSkillMutation(() => this.validateSkillDraft(id, input));
  }

  private async validateSkillDraft(id: string, input: ValidateSkillInput): Promise<Skill> {
    const skill = this.required(this.state.skills, id, "Skill");
    if (skill.validation.checkedAt !== input.expectedCheckedAt) {
      throw new StoreConflictError("Skill validation evidence is stale.", "revision");
    }
    if (skill.status !== "draft") throw new StoreConflictError("Only draft Skills can be validated.");
    const contentDigest = skillContentDigest(skill);
    if (skill.contentDigest !== contentDigest) {
      throw new StoreConflictError("Skill content digest does not match the immutable version.");
    }
    const previousValidation = structuredClone(skill.validation);
    const next = structuredClone(skill);
    next.validation = {
      result: input.result,
      summary: input.summary,
      checkedAt: skill.validation.checkedAt
        ? nextTimestamp(skill.validation.checkedAt)
        : new Date().toISOString(),
      contentDigest
    };
    await this.recordAudit("skill.validated", "skill", skill.id, {
      ...this.skillAuditDetail(next),
      previousValidation,
      currentValidation: next.validation
    });
    Object.assign(skill, next);
    return structuredClone(next);
  }

  async revokeSkill(
    id: string,
    input: RevokeSkillInput,
    idempotencyKey?: string
  ): Promise<SkillRevocationResult> {
    return this.runIdempotent("skill.revoke", idempotencyKey, { skillId: id, ...input }, () => (
      this.serializeAgentDefinitionMutation(id, () => (
        this.serializeSkillMutation(() => this.revokeSkillDraft(id, input))
      ))
    ));
  }

  private async revokeSkillDraft(id: string, input: RevokeSkillInput): Promise<SkillRevocationResult> {
    const skill = this.required(this.state.skills, id, "Skill");
    if (skill.status === "revoked") {
      if (skill.revocationReason === input.reason) return { skill: structuredClone(skill), revokedAssignmentCount: 0 };
      throw new StoreConflictError("A revoked Skill is terminal.");
    }
    if (skill.status !== "approved") throw new StoreConflictError("Only approved Skills can be revoked.");
    const affectedAgents = this.state.agents
      .filter((agent) => agent.skillIds.includes(id))
      .map((agent) => ({
        agent,
        next: structuredClone(agent),
        revisions: structuredClone(this.agentRevisions.get(agent.id) ?? []),
        revision: null as AgentRevision | null
      }));
    const previousStatus = skill.status;
    const nextSkill = structuredClone(skill);
    nextSkill.status = "revoked";
    nextSkill.revokedAt = new Date().toISOString();
    nextSkill.revocationReason = input.reason;
    for (const affected of affectedAgents) {
      affected.next.skillIds = affected.next.skillIds.filter((skillId) => skillId !== id);
      const revisionNumber = Math.max(
        affected.next.draftRevision ?? 0,
        ...affected.revisions.map((item) => item.revision)
      ) + 1;
      affected.revision = this.agentRevisionFromAgent(affected.next, revisionNumber, "updated", null, null);
      affected.next.draftRevision = revisionNumber;
      affected.next.revision = this.nextAgentResourceRevision(affected.agent);
      if (affected.next.lifecycleStatus !== "disabled") affected.next.lifecycleStatus = "draft";
    }
    const revokedAssignmentCount = affectedAgents.length;
    await this.recordAudit("skill.revoked", "skill", skill.id, {
      ...this.skillAuditDetail(nextSkill),
      previousStatus,
      currentStatus: nextSkill.status,
      revocationReason: input.reason,
      revokedAssignmentCount,
      affectedAgentRevisions: affectedAgents.map(({ next }) => ({
        agentId: next.id,
        revision: next.draftRevision
      }))
    });
    Object.assign(skill, nextSkill);
    for (const affected of affectedAgents) {
      Object.assign(affected.agent, affected.next);
      this.agentRevisions.set(affected.agent.id, [...affected.revisions, affected.revision!]);
    }
    return { skill: structuredClone(nextSkill), revokedAssignmentCount };
  }

  async createModelConnector(
    input: CreateModelConnectorStateInput,
    secret?: SecretInput,
    idempotencyKey?: string
  ): Promise<ModelConnector> {
    const replayInput = modelConnectorCreateIdempotencyInput(input, secret, idempotencyKey);
    return this.runIdempotent("model_connector.create", idempotencyKey, replayInput, () => (
      this.serializeAgentDefinitionMutation("model:create", () => (
        this.serializeConnectorMutation("model", () => this.createModelConnectorDraft(input, secret))
      ))
    ));
  }

  async replayModelConnectorCreate(
    input: CreateModelConnectorStateInput,
    secret: SecretInput | undefined,
    idempotencyKey: string
  ): Promise<ModelConnector | null> {
    return this.replayIdempotent(
      "model_connector.create",
      idempotencyKey,
      modelConnectorCreateIdempotencyInput(input, secret, idempotencyKey)
    );
  }

  private async createModelConnectorDraft(input: CreateModelConnectorStateInput, secret?: SecretInput): Promise<ModelConnector> {
    assertConnectorUrlShapeAllowed(input.baseUrl, input.location === "local");
    if (this.state.modelConnectors.some((connector) => this.sameName(connector.name, input.name))) {
      throw new StoreConflictError("Model Connector name already exists.");
    }
    const legacyCiphertext = secret?.ciphertext;
    const explicitCredential = input.credentialId
      ? this.requiredActiveCredential(input.credentialId)
      : null;
    if (explicitCredential && legacyCiphertext) {
      throw new StoreConflictError("Rotate an existing Credential through the Credential lifecycle before binding it.");
    }
    let createdCredential: Credential | null = null;
    const connector: ModelConnector = {
      id: randomUUID(),
      revision: 1,
      name: input.name,
      location: input.location,
      baseUrl: input.baseUrl,
      model: input.model,
      enabled: true,
      hasSecret: explicitCredential ? this.credentialRunnable(explicitCredential) : Boolean(legacyCiphertext),
      secretRevision: explicitCredential?.secretRevision ?? (legacyCiphertext ? 1 : 0),
      credentialId: explicitCredential?.id ?? null
    };
    if (legacyCiphertext && !explicitCredential) {
      const credential = this.buildCredentialRecord(
        connector.id,
        this.generatedModelCredentialMetadata(connector.name, connector.location),
        { ciphertext: legacyCiphertext }
      );
      createdCredential = credential;
      connector.credentialId = credential.id;
      connector.hasSecret = true;
      connector.secretRevision = credential.secretRevision;
    }
    if (createdCredential) await this.recordCredentialCreatedAudit(createdCredential);
    await this.recordAudit("model_connector.created", "model_connector", connector.id, {
      location: connector.location
    });
    this.state.modelConnectors.push(connector);
    if (createdCredential) {
      this.state.credentials ??= [];
      this.state.credentials.push(createdCredential);
      if (legacyCiphertext) this.credentialSecrets.set(createdCredential.id, legacyCiphertext);
    }
    return structuredClone(connector);
  }

  async updateModelConnector(id: string, input: UpdateModelConnectorStateInput, secret?: SecretInput): Promise<ModelConnectorUpdateResult> {
    return this.serializeAgentDefinitionMutation(id, () => (
      this.serializeConnectorMutation("model", () => this.updateModelConnectorDraft(id, input, secret))
    ));
  }

  private async updateModelConnectorDraft(id: string, input: UpdateModelConnectorStateInput, secret?: SecretInput): Promise<ModelConnectorUpdateResult> {
    const connector = this.required(this.state.modelConnectors, id, "Model connector");
    const { expectedRevision, ...changes } = input;
    if (connector.revision !== expectedRevision) {
      throw new StoreConflictError("Model Connector revision is stale.", "revision");
    }
    const nextName = changes.name ?? connector.name;
    const nextLocation = changes.location ?? connector.location;
    const nextBaseUrl = changes.baseUrl ?? connector.baseUrl;
    assertConnectorUrlShapeAllowed(nextBaseUrl, nextLocation === "local");
    if (this.state.modelConnectors.some((candidate) => candidate.id !== id && this.sameName(candidate.name, nextName))) {
      throw new StoreConflictError("Model Connector name already exists.");
    }

    const nextCredentialId = changes.credentialId === undefined ? (connector.credentialId ?? null) : changes.credentialId;
    const nextCredential = nextCredentialId ? this.requiredActiveCredential(nextCredentialId) : null;
    if (nextCredential && secret?.ciphertext) {
      throw new StoreConflictError("Rotate an existing Credential through the Credential lifecycle before binding it.");
    }
    const previous = {
      name: connector.name,
      location: connector.location,
      baseUrl: connector.baseUrl,
      model: connector.model,
      enabled: connector.enabled,
      hasSecret: connector.hasSecret,
      secretRevision: connector.secretRevision,
      credentialId: connector.credentialId ?? null
    };
    const next = structuredClone(connector);
    next.name = nextName;
    next.location = nextLocation;
    next.baseUrl = nextBaseUrl;
    next.model = changes.model ?? connector.model;
    next.enabled = changes.enabled ?? connector.enabled;
    next.credentialId = nextCredentialId;
    let createdCredential: Credential | null = null;
    let createdCredentialCiphertext: string | null = null;
    let legacyCiphertext: string | null = null;
    if (secret?.ciphertext) {
      if (connector.hasSecret && connector.credentialId === null) {
        // Legacy connectors predate the Credential registry; rotate their ciphertext and revision in place.
        legacyCiphertext = secret.ciphertext;
        next.credentialId = null;
        next.hasSecret = true;
        next.secretRevision = connector.secretRevision + 1;
      } else {
        const credential = this.buildCredentialRecord(
          connector.id,
          this.generatedModelCredentialMetadata(next.name, nextLocation),
          secret
        );
        createdCredential = credential;
        createdCredentialCiphertext = secret.ciphertext;
        next.credentialId = credential.id;
        next.hasSecret = true;
        next.secretRevision = credential.secretRevision;
      }
    } else if (nextCredential) {
      next.hasSecret = this.credentialRunnable(nextCredential);
      next.secretRevision = nextCredential.secretRevision;
    } else if (changes.credentialId === undefined && connector.hasSecret && connector.credentialId === null) {
      // Empty or omitted ciphertext is a no-op for legacy connectors. Preserve their old binding.
      next.credentialId = null;
      next.hasSecret = previous.hasSecret;
      next.secretRevision = previous.secretRevision;
    } else {
      next.hasSecret = false;
      next.secretRevision = 0;
    }
    const assignedAgentCount = this.state.agents.filter((agent) => agent.modelConnectorId === connector.id).length;
    if (isDeepStrictEqual(next, connector)) {
      return { connector: structuredClone(connector), assignedAgentCount };
    }
    next.revision = connector.revision + 1;
    if (createdCredential) await this.recordCredentialCreatedAudit(createdCredential);
    await this.recordAudit("model_connector.updated", "model_connector", connector.id, {
      fields: Object.keys(changes),
      secretRotated: Boolean(secret?.ciphertext),
      assignedAgentCount,
      previousRevision: connector.revision,
      currentRevision: next.revision,
      previous,
      current: {
        name: next.name,
        location: next.location,
        baseUrl: next.baseUrl,
        model: next.model,
        enabled: next.enabled,
        hasSecret: next.hasSecret,
        secretRevision: next.secretRevision,
        credentialId: next.credentialId
      }
    });
    Object.assign(connector, next);
    if (createdCredential && createdCredentialCiphertext) {
      this.state.credentials ??= [];
      this.state.credentials.push(createdCredential);
      this.credentialSecrets.set(createdCredential.id, createdCredentialCiphertext);
    }
    if (legacyCiphertext) this.connectorSecrets.set(connector.id, legacyCiphertext);
    if (next.enabled !== previous.enabled) {
      for (const agent of this.state.agents.filter((item) => item.modelConnectorId === connector.id)) {
        const status = agent.lifecycleStatus === "disabled"
          ? "offline"
          : next.enabled ? "online" : "attention";
        if (status !== agent.status) {
          agent.status = status;
          agent.revision = this.nextAgentResourceRevision(agent);
        }
      }
    }
    return { connector: structuredClone(next), assignedAgentCount };
  }

  async createMcpConnector(
    input: CreateMcpConnectorStateInput,
    secret?: SecretInput,
    idempotencyKey?: string
  ): Promise<McpConnector> {
    const replayInput = mcpConnectorCreateIdempotencyInput(input, secret, idempotencyKey);
    return this.runIdempotent("mcp_connector.create", idempotencyKey, replayInput, () => (
      this.serializeConnectorMutation("mcp", () => this.createMcpConnectorDraft(input, secret))
    ));
  }

  async replayMcpConnectorCreate(
    input: CreateMcpConnectorStateInput,
    secret: SecretInput | undefined,
    idempotencyKey: string
  ): Promise<McpConnector | null> {
    return this.replayIdempotent(
      "mcp_connector.create",
      idempotencyKey,
      mcpConnectorCreateIdempotencyInput(input, secret, idempotencyKey)
    );
  }

  private async createMcpConnectorDraft(input: CreateMcpConnectorStateInput, secret?: SecretInput): Promise<McpConnector> {
    const location = input.location ?? "cloud";
    assertConnectorUrlShapeAllowed(input.baseUrl, location === "local");
    if (this.state.mcpConnectors.some((connector) => this.sameName(connector.name, input.name))) {
      throw new StoreConflictError("MCP Connector name already exists.");
    }
    const approvedTools = this.normalizeApprovedTools(input.approvedTools);
    const connector: McpConnector = {
      id: randomUUID(),
      revision: 1,
      name: input.name,
      location,
      baseUrl: input.baseUrl,
      approvedTools,
      toolRegistrations: this.normalizeToolRegistrations(approvedTools, input.toolRegistrations ?? [], true, true),
      enabled: true,
      hasSecret: Boolean(secret?.ciphertext),
      secretRevision: secret?.ciphertext ? 1 : 0
    };
    await this.recordAudit("mcp_connector.created", "mcp_connector", connector.id, {
      location: connector.location,
      approvedTools: connector.approvedTools
    });
    this.state.mcpConnectors.push(connector);
    if (secret?.ciphertext) this.connectorSecrets.set(connector.id, secret.ciphertext);
    return structuredClone(connector);
  }

  async updateMcpConnector(id: string, input: UpdateMcpConnectorStateInput, secret?: SecretInput): Promise<McpConnectorUpdateResult> {
    return this.serializeAgentDefinitionMutation(id, () => (
      this.serializeConnectorMutation("mcp", () => this.updateMcpConnectorDraft(id, input, secret))
    ));
  }

  private async updateMcpConnectorDraft(id: string, input: UpdateMcpConnectorStateInput, secret?: SecretInput): Promise<McpConnectorUpdateResult> {
    const connector = this.required(this.state.mcpConnectors, id, "MCP connector");
    const { expectedRevision, ...changes } = input;
    if (connector.revision !== expectedRevision) {
      throw new StoreConflictError("MCP Connector revision is stale.", "revision");
    }
    const nextLocation = changes.location ?? connector.location;
    if (changes.baseUrl || changes.location) {
      assertConnectorUrlShapeAllowed(changes.baseUrl ?? connector.baseUrl, nextLocation === "local");
    }
    const nextName = changes.name ?? connector.name;
    if (this.state.mcpConnectors.some((candidate) => candidate.id !== id && this.sameName(candidate.name, nextName))) {
      throw new StoreConflictError("MCP Connector name already exists.");
    }
    const nextApprovedTools = changes.approvedTools === undefined
      ? connector.approvedTools
      : this.normalizeApprovedTools(changes.approvedTools);
    const nextEnabled = changes.enabled ?? connector.enabled;
    const nextToolRegistrations = this.normalizeToolRegistrations(
      nextApprovedTools,
      changes.toolRegistrations ?? connector.toolRegistrations,
      nextEnabled,
      changes.toolRegistrations !== undefined
    );
    const nextConnector = structuredClone(connector);
    nextConnector.name = nextName;
    nextConnector.location = nextLocation;
    nextConnector.baseUrl = changes.baseUrl ?? connector.baseUrl;
    nextConnector.approvedTools = nextApprovedTools;
    nextConnector.enabled = nextEnabled;
    nextConnector.toolRegistrations = nextToolRegistrations;
    if (secret?.ciphertext) {
      nextConnector.hasSecret = true;
      nextConnector.secretRevision = (connector.secretRevision ?? (connector.hasSecret ? 1 : 0)) + 1;
    }
    if (isDeepStrictEqual(nextConnector, connector)) {
      return { connector: structuredClone(connector), revokedGrantCount: 0 };
    }
    nextConnector.revision = connector.revision + 1;

    const approvedTools = new Set(nextConnector.approvedTools);
    const affectedAgents: Array<{
      agent: Agent;
      next: Agent;
      revisions: AgentRevision[];
      revision: AgentRevision;
    }> = [];
    let revokedGrantCount = 0;
    for (const agent of this.state.agents) {
      const nextToolGrants = agent.toolGrants.filter((grant) =>
        grant.connectorId !== connector.id || (
          nextConnector.enabled
          && approvedTools.has(grant.toolName)
          && nextConnector.toolRegistrations.some((registration) => registration.toolName === grant.toolName)
        )
      );
      if (nextToolGrants.length === agent.toolGrants.length) continue;

      const nextAgent = structuredClone(agent);
      const revisions = structuredClone(this.agentRevisions.get(agent.id) ?? []);
      nextAgent.toolGrants = nextToolGrants;
      const revisionNumber = Math.max(
        nextAgent.draftRevision ?? 0,
        ...revisions.map((item) => item.revision)
      ) + 1;
      const revision = this.agentRevisionFromAgent(nextAgent, revisionNumber, "updated", null, null);
      nextAgent.draftRevision = revisionNumber;
      nextAgent.revision = this.nextAgentResourceRevision(agent);
      if (nextAgent.lifecycleStatus !== "disabled") nextAgent.lifecycleStatus = "draft";
      affectedAgents.push({ agent, next: nextAgent, revisions, revision });
      revokedGrantCount += agent.toolGrants.length - nextToolGrants.length;
    }

    await this.recordAudit("mcp_connector.updated", "mcp_connector", connector.id, {
      fields: Object.keys(changes),
      secretRotated: Boolean(secret?.ciphertext),
      previousRevision: connector.revision,
      currentRevision: nextConnector.revision,
      secretRevision: nextConnector.secretRevision ?? 0,
      location: nextConnector.location,
      enabled: nextConnector.enabled,
      approvedTools: nextConnector.approvedTools,
      revokedGrantCount,
      affectedAgentRevisions: affectedAgents.map(({ next }) => ({
        agentId: next.id,
        revision: next.draftRevision
      }))
    });

    Object.assign(connector, nextConnector);
    if (secret?.ciphertext) this.connectorSecrets.set(connector.id, secret.ciphertext);
    for (const affected of affectedAgents) {
      Object.assign(affected.agent, affected.next);
      this.agentRevisions.set(affected.agent.id, [...affected.revisions, affected.revision]);
    }
    return { connector: structuredClone(nextConnector), revokedGrantCount };
  }

  async replayTaskAdapterConnectorCreate(
    input: CreateTaskAdapterConnectorStateInput,
    secret: SecretInput | undefined,
    idempotencyKey: string
  ): Promise<TaskAdapterConnector | null> {
    return this.replayIdempotent(
      "task_adapter.create",
      idempotencyKey,
      taskAdapterConnectorCreateIdempotencyInput(input, secret, idempotencyKey)
    );
  }

  async createTaskAdapterConnector(
    input: CreateTaskAdapterConnectorStateInput,
    secret?: SecretInput,
    idempotencyKey?: string
  ): Promise<TaskAdapterConnector> {
    const replayInput = taskAdapterConnectorCreateIdempotencyInput(input, secret, idempotencyKey);
    return this.runIdempotent("task_adapter.create", idempotencyKey, replayInput, () => (
      this.serializeConnectorMutation("task_adapter", () => this.createTaskAdapterConnectorDraft(input, secret))
    ));
  }

  private async createTaskAdapterConnectorDraft(input: CreateTaskAdapterConnectorStateInput, secret?: SecretInput): Promise<TaskAdapterConnector> {
    if (this.state.taskAdapterConnectors.some((connector) => connector.enabled)) {
      throw new StoreConflictError("Phase 1 permits one enabled Task Adapter Connector.");
    }
    if (this.state.taskAdapterConnectors.some((connector) => this.sameName(connector.name, input.name))) {
      throw new StoreConflictError("Task Adapter Connector name already exists.");
    }
    const connector: TaskAdapterConnector = {
      id: randomUUID(),
      name: input.name,
      location: input.location,
      baseUrl: input.baseUrl,
      enabled: true,
      hasSecret: Boolean(secret?.ciphertext)
    };
    await this.recordAudit("task_adapter.created", "task_adapter", connector.id, { location: connector.location });
    this.state.taskAdapterConnectors.push(connector);
    if (secret?.ciphertext) this.connectorSecrets.set(connector.id, secret.ciphertext);
    return structuredClone(connector);
  }

  async getConnectorSecret(connectorId: string): Promise<string | null> {
    const model = this.state.modelConnectors.find((connector) => connector.id === connectorId);
    if (model?.credentialId) return this.getCredentialSecret(model.credentialId);
    return this.connectorSecrets.get(connectorId) ?? null;
  }

  async createOwner(email: string, passwordHash: string): Promise<OwnerUser> {
    const normalized = email.toLocaleLowerCase();
    if (this.owners.has(normalized)) throw new StoreConflictError("Owner already exists.");
    const owner = { id: randomUUID(), email: normalized, passwordHash };
    this.owners.set(normalized, owner);
    return owner;
  }

  async findOwnerByEmail(email: string): Promise<OwnerUser | null> {
    return this.owners.get(email.toLocaleLowerCase()) ?? null;
  }

  async createSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.tokenHash, session);
  }

  async findSession(tokenHash: string): Promise<SessionRecord | null> {
    const session = this.sessions.get(tokenHash);
    if (!session || new Date(session.expiresAt).getTime() <= Date.now()) return null;
    return session;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
  }

  async admitExternalExecutionStart(
    input: ExternalExecutionStartRequest,
    idempotencyKey: string
  ): Promise<ExternalExecutionStartAdmission> {
    return this.serializeExternalExecutionAdmission(async () => {
      const scopedKey = `${externalExecutionStartOperation}:${idempotencyKey}`;
      const fingerprint = externalExecutionStartFingerprint(input);
      const record = this.idempotency.get(scopedKey);
      if (record) {
        if (record.requestFingerprint !== fingerprint) {
          throw new StoreConflictError(
            "Idempotency key was already used with a different request.",
            "business_rule",
            "IDEMPOTENCY_KEY_CONFLICT"
          );
        }
        const envelope = parseExternalExecutionStartEnvelope(record.response);
        if (!envelope) {
          throw new StoreConflictError(
            "External execution admission requires manual reconciliation.",
            "business_rule",
            "EXTERNAL_EXECUTION_RECONCILIATION_REQUIRED"
          );
        }
        return envelope.state === "settled"
          ? {
              status: "settled",
              reservationId: envelope.reservationId,
              execution: structuredClone(envelope.execution)
            }
          : { status: "pending", reservationId: envelope.reservationId };
      }

      const reservationId = randomUUID();
      const envelope: ExternalExecutionStartEnvelope = { state: "reserved", reservationId };
      await this.recordAudit("external_execution.requested", "external_execution", reservationId, {});
      this.idempotency.set(scopedKey, { requestFingerprint: fingerprint, response: envelope });
      return { status: "reserved", reservationId };
    });
  }

  async settleExternalExecutionStart(
    input: ExternalExecutionStartRequest,
    idempotencyKey: string,
    execution: ExternalExecution
  ): Promise<ExternalExecution> {
    return this.serializeExternalExecutionAdmission(async () => {
      const scopedKey = `${externalExecutionStartOperation}:${idempotencyKey}`;
      const fingerprint = externalExecutionStartFingerprint(input);
      const record = this.idempotency.get(scopedKey);
      if (!record) {
        throw new StoreConflictError(
          "External execution reservation was not found.",
          "business_rule",
          "EXTERNAL_EXECUTION_RECONCILIATION_REQUIRED"
        );
      }
      if (record.requestFingerprint !== fingerprint) {
        throw new StoreConflictError(
          "Idempotency key was already used with a different request.",
          "business_rule",
          "IDEMPOTENCY_KEY_CONFLICT"
        );
      }
      const envelope = parseExternalExecutionStartEnvelope(record.response);
      if (!envelope) {
        throw new StoreConflictError(
          "External execution admission requires manual reconciliation.",
          "business_rule",
          "EXTERNAL_EXECUTION_RECONCILIATION_REQUIRED"
        );
      }
      if (envelope.state === "settled") return structuredClone(envelope.execution);

      const settled: ExternalExecutionStartEnvelope = {
        state: "settled",
        reservationId: envelope.reservationId,
        execution: structuredClone(execution)
      };
      await this.recordAudit("external_execution.accepted", "external_execution", envelope.reservationId, {
        reservationId: envelope.reservationId,
        status: execution.status
      });
      this.idempotency.set(scopedKey, { requestFingerprint: fingerprint, response: settled });
      return structuredClone(execution);
    });
  }

  async recordAudit(_event: string, _entityType: string, _entityId: string, _detail: Record<string, unknown> = {}): Promise<void> {}
  async close(): Promise<void> {}

  private initializeRoleVersions(roles: Role[], participants: ParticipantAssignment[]): RoleVersion[] {
    const recordedAt = new Date().toISOString();
    const versions = new Map<string, RoleVersion>();
    const add = (candidate: RoleVersion) => {
      const key = `${candidate.roleId}:${candidate.version}`;
      const existing = versions.get(key);
      if (!existing) versions.set(key, candidate);
    };
    for (const role of roles) add(createRoleVersion(role, "legacy_backfilled", null, recordedAt));
    for (const participant of participants) {
      for (const history of participant.roleHistory) {
        const snapshot = history.roleSnapshot;
        add({
          roleId: snapshot.roleId,
          version: snapshot.version,
          name: snapshot.name,
          usageContext: snapshot.usageContext,
          responsibility: snapshot.responsibility,
          speakingGuidance: snapshot.speakingGuidance,
          decisionScope: snapshot.decisionScope,
          constraints: snapshot.constraints,
          templateKey: snapshot.templateKey,
          toolPolicy: snapshot.toolPolicy,
          dataPolicy: snapshot.dataPolicy,
          orchestrationFunctions: [...snapshot.orchestrationFunctions],
          source: "legacy_backfilled",
          restoredFromVersion: null,
          recordedAt: history.changedAt
        });
      }
    }
    return [...versions.values()];
  }

  private requiredActiveRole(id: string): Role {
    const role = this.required(this.state.roles, id, "Role");
    if (role.deletedAt) throw new StoreConflictError("A deleted Role cannot be used or changed.");
    return role;
  }

  private normalizeParticipantRoleHistory(
    participant: Partial<ParticipantAssignment> & Pick<ParticipantAssignment, "id" | "meetingId" | "agentId" | "roleId" | "isChair">,
    currentSnapshot: ParticipantAssignment["roleSnapshot"],
    meetingCreatedAt: string
  ): ParticipantRoleHistoryEntry[] {
    if (!Array.isArray(participant.roleHistory) || participant.roleHistory.length === 0) {
      return [{
        revision: 1,
        roleId: participant.roleId,
        roleSnapshot: structuredClone(currentSnapshot),
        changedAt: meetingCreatedAt,
        changedBy: "system",
        reason: "Existing Meeting Role imported into revision history."
      }];
    }
    const history = participant.roleHistory.map((entry, index) => {
      if (!entry
        || !Number.isInteger(entry.revision)
        || entry.revision !== index + 1
        || typeof entry.roleId !== "string"
        || typeof entry.changedAt !== "string"
        || (entry.changedBy !== "owner" && entry.changedBy !== "system")
        || typeof entry.reason !== "string"
        || !entry.reason.trim()
        || !entry.roleSnapshot) {
        throw new StoreConflictError("Invalid Participant Role history data.");
      }
      const snapshot = entry.roleSnapshot;
      const templateKey = snapshot.templateKey ?? legacyRoleTemplateKeyById[snapshot.roleId] ?? null;
      const template = builtInRoleTemplates.find((item) => item.key === templateKey);
      return {
        ...entry,
        roleId: entry.roleId,
        roleSnapshot: {
          ...snapshot,
          templateKey,
          usageContext: resolveRoleUsageContext({ ...snapshot, templateKey }),
          orchestrationFunctions: Array.isArray(snapshot.orchestrationFunctions)
            ? [...snapshot.orchestrationFunctions]
            : [...(template?.orchestrationFunctions ?? [])]
        },
        reason: entry.reason.trim()
      } as ParticipantRoleHistoryEntry;
    });
    return history;
  }

  private normalizeSpeakerQueue(value: SpeakerQueueItem[] | undefined): SpeakerQueueItem[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new StoreConflictError("Invalid Speaker Queue data.");
    const normalized = value.map((item) => {
      const kind = item.kind ?? "agent_turn";
      const requestedAt = item.requestedAt;
      const duration = item.status === "running" ? runningSpeakerLeaseMs : queuedSpeakerLeaseMs;
      return {
        ...item,
        kind,
        reservationId: item.reservationId ?? null,
        requestFingerprint: item.requestFingerprint ?? null,
        label: item.label ?? (kind === "agent_turn" ? `${item.roleName} 發言` : item.toolName ?? "MCP 工具"),
        toolName: item.toolName ?? null,
        agendaRevision: item.agendaRevision ?? (kind === "agent_turn" ? 0 : null),
        leaseExpiresAt: item.leaseExpiresAt ?? leaseExpiry(requestedAt, duration),
        runtimeProfileBinding: item.runtimeProfileBinding ?? null,
        mcpExecutionBinding: item.mcpExecutionBinding ?? null,
        requestedBy: item.requestedBy ?? "owner",
        chairSuggestionId: item.chairSuggestionId ?? null,
        automationRevision: item.automationRevision ?? null
      } as SpeakerQueueItem;
    });
    const meetingIds = new Set<string>();
    const jobIds = new Set<string>();
    for (const item of normalized) {
      if (!item
        || typeof item.id !== "string"
        || typeof item.jobId !== "string"
        || item.id !== item.jobId
        || (item.reservationId !== null
          && (typeof item.reservationId !== "string" || !item.reservationId.trim()))
        || (item.requestFingerprint !== null
          && (typeof item.requestFingerprint !== "string" || !item.requestFingerprint.trim()))
        || typeof item.meetingId !== "string"
        || typeof item.agentId !== "string"
        || typeof item.participantId !== "string"
        || (item.kind !== "agent_turn" && item.kind !== "mcp_tool_call")
        || typeof item.label !== "string"
        || !item.label.trim()
        || (item.toolName !== null && typeof item.toolName !== "string")
        || !Number.isInteger(item.roleRevision)
        || item.roleRevision < 1
        || typeof item.roleId !== "string"
        || !Number.isInteger(item.roleVersion)
        || item.roleVersion < 1
        || typeof item.roleName !== "string"
        || (item.agendaRevision !== null && (!Number.isInteger(item.agendaRevision) || item.agendaRevision < 0))
        || (item.kind === "agent_turn" && item.agendaRevision === null)
        || (item.kind === "agent_turn" && item.toolName !== null)
        || (item.runtimeProfileBinding !== null && !runtimeProfileBindingSchema.safeParse(item.runtimeProfileBinding).success)
        || (item.mcpExecutionBinding !== null && !validMcpExecutionBinding(item.mcpExecutionBinding))
        || (item.kind === "agent_turn" && item.mcpExecutionBinding !== null)
        || (item.kind === "mcp_tool_call" && item.runtimeProfileBinding !== null)
        || (item.kind === "mcp_tool_call" && (!item.toolName || item.agendaRevision !== null))
        || (item.kind === "mcp_tool_call"
          && item.mcpExecutionBinding !== null
          && item.mcpExecutionBinding.toolSnapshot.toolName !== item.toolName)
        || (item.agendaCurrentItemId !== null && typeof item.agendaCurrentItemId !== "string")
        || (item.status !== "queued" && item.status !== "running")
        || typeof item.requestedAt !== "string"
        || Number.isNaN(new Date(item.requestedAt).getTime())
        || (item.startedAt !== null && typeof item.startedAt !== "string")
        || typeof item.leaseExpiresAt !== "string"
        || Number.isNaN(new Date(item.leaseExpiresAt).getTime())
        || (item.requestedBy !== "owner" && item.requestedBy !== "system")
        || (item.chairSuggestionId !== null && typeof item.chairSuggestionId !== "string")
        || (item.automationRevision !== null && item.automationRevision !== undefined
          && (!Number.isInteger(item.automationRevision) || item.automationRevision < 0))
        || (item.requestedBy === "system" && (!item.chairSuggestionId || item.automationRevision == null))
        || new Date(item.leaseExpiresAt).getTime() <= new Date(item.requestedAt).getTime()
        || (item.status === "queued" && item.startedAt !== null)
        || (item.status === "running" && item.startedAt === null)
        || meetingIds.has(item.meetingId)
        || jobIds.has(item.jobId)) {
        throw new StoreConflictError("Invalid Speaker Queue data.");
      }
      meetingIds.add(item.meetingId);
      jobIds.add(item.jobId);
    }
    return structuredClone(normalized);
  }

  private participantMatchesRoleBinding(participant: ParticipantAssignment, binding: ParticipantRoleBinding): boolean {
    return participant.id === binding.participantId
      && participant.roleRevision === binding.roleRevision
      && participant.roleId === binding.roleId
      && participant.roleSnapshot.version === binding.roleVersion;
  }

  private speakerReservationMatches(item: SpeakerQueueItem, reservationId: string | undefined): boolean {
    if (item.kind !== "agent_turn") return reservationId === undefined;
    return item.reservationId === null
      ? reservationId === undefined
      : item.reservationId === reservationId;
  }

  private roleSnapshotMatchesRole(snapshot: ParticipantAssignment["roleSnapshot"], role: Role): boolean {
    return snapshot.roleId === role.id
      && snapshot.name === role.name
      && snapshot.usageContext === role.usageContext
      && snapshot.responsibility === role.responsibility
      && snapshot.speakingGuidance === role.speakingGuidance
      && snapshot.decisionScope === role.decisionScope
      && snapshot.constraints === role.constraints
      && snapshot.version === role.version
      && snapshot.templateKey === role.templateKey
      && snapshot.toolPolicy === role.toolPolicy
      && snapshot.dataPolicy === role.dataPolicy
      && snapshot.orchestrationFunctions.length === (role.orchestrationFunctions?.length ?? 0)
      && snapshot.orchestrationFunctions.every((capability, index) => capability === role.orchestrationFunctions?.[index]);
  }

  private normalizeMeetingAgenda(value: unknown): MeetingAgenda {
    if (value === undefined) return { revision: 0, items: [] };
    const parsed = meetingAgendaSchema.safeParse(value);
    if (!parsed.success) throw new StoreConflictError("Invalid existing Meeting Agenda data.");
    return parsed.data;
  }

  private assertAgendaRevision(meeting: Meeting, expectedRevision: number): void {
    if (meeting.agenda.revision !== expectedRevision) {
      throw new StoreConflictError(
        `Meeting Agenda revision changed from ${expectedRevision} to ${meeting.agenda.revision} before the action completed.`,
        "revision"
      );
    }
  }

  private activateFirstPendingAgendaItem(meeting: Meeting, at = new Date().toISOString()): boolean {
    if (meeting.agenda.items.some((item) => item.status === "current")) return false;
    const next = meeting.agenda.items.find((item) => item.status === "pending");
    if (!next) return false;
    next.status = "current";
    next.startedAt = at;
    next.updatedAt = at;
    return true;
  }

  private assertRoleVersion(role: Role, expectedCurrentVersion: number): void {
    if (role.version !== expectedCurrentVersion) {
      throw new StoreConflictError(
        `Role version changed from ${expectedCurrentVersion} to ${role.version} before the action completed.`,
        "revision"
      );
    }
  }

  private required<T extends { id: string }>(items: T[], id: string, label: string): T {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) throw new StoreNotFoundError(`${label} not found.`);
    return item;
  }

  private sameName(left: string, right: string): boolean {
    return left.normalize("NFKC").trim().toLocaleLowerCase() === right.normalize("NFKC").trim().toLocaleLowerCase();
  }

  private resolveSuggestion(
    suggestion: ChairSuggestionRecord,
    resolution: NonNullable<ChairSuggestionRecord["resolution"]>,
    note: string,
    resolvedBy: NonNullable<ChairSuggestionRecord["resolvedBy"]>,
    detail: { agentId?: string; jobId?: string } = {},
    transitionType: ChairSuggestionRecord["transitions"][number]["type"] = resolution
  ): void {
    suggestion.status = "resolved";
    suggestion.resolution = resolution;
    suggestion.resolutionNote = note;
    suggestion.resolvedBy = resolvedBy;
    suggestion.resolvedAt = new Date().toISOString();
    this.appendSuggestionTransition(suggestion, transitionType, resolvedBy, { ...detail, note });
  }

  private appendSuggestionTransition(
    suggestion: ChairSuggestionRecord,
    type: ChairSuggestionRecord["transitions"][number]["type"],
    actor: ChairSuggestionRecord["transitions"][number]["actor"],
    detail: { agentId?: string; jobId?: string; note?: string } = {}
  ): void {
    suggestion.transitions.push({ id: randomUUID(), type, actor, at: new Date().toISOString(), ...detail });
  }

  private appendTaskTransition(
    task: Task,
    type: TaskTransition["type"],
    actor: TaskTransition["actor"],
    detail: Omit<TaskTransition, "id" | "type" | "actor" | "at"> = {}
  ): void {
    task.transitions.push({ id: randomUUID(), type, actor, at: new Date().toISOString(), ...detail });
  }

  private invalidateTaskSyncIfPayloadChanged(task: Task, previousFingerprint: string): boolean {
    const nextFingerprint = taskSyncRequestFingerprint(task);
    if (nextFingerprint === previousFingerprint) return false;
    if (task.sync.status === "queued" && task.sync.jobId) {
      task.sync = {
        ...task.sync,
        requestFingerprint: nextFingerprint,
        lastError: null,
        syncedAt: null
      };
      return true;
    }
    task.sync = {
      ...task.sync,
      status: "not_synced",
      jobId: null,
      requestFingerprint: null,
      lastError: null,
      syncedAt: null
    };
    return true;
  }

  private assertTaskExecutionRevision(task: Task, expectedRevision: number): void {
    if (task.execution.revision !== expectedRevision) {
      throw new StoreConflictError(`Task execution revision changed from ${expectedRevision} to ${task.execution.revision} before the action completed.`, "revision");
    }
  }

  private assertTaskRevision(task: Task, expectedRevision: number): void {
    if (task.revision !== expectedRevision) {
      throw new StoreConflictError(`Task revision is stale; expected ${expectedRevision}, current ${task.revision}.`, "revision");
    }
  }

  private assertTaskBoardRevision(task: Task, expectedRevision: number): void {
    if (task.boardRevision !== expectedRevision) {
      throw new StoreConflictError(`Task board revision is stale; expected ${expectedRevision}, current ${task.boardRevision}.`, "revision");
    }
  }

  private advanceTaskBoardRevision(tasks: Task[]): number {
    const nextRevision = (tasks[0]?.boardRevision ?? 0) + 1;
    for (const task of tasks) task.boardRevision = nextRevision;
    return nextRevision;
  }

  private assertTaskNotExecuting(task: Task): void {
    if (task.execution.status === "queued" || task.execution.status === "running") {
      throw new StoreConflictError("Task is executing; wait for the current Agent run to settle before changing it.");
    }
  }

  private resolveRunnableAgentRevision(
    agentId: string,
    revisionNumber: number | undefined,
    requireCurrentPublishedRevision: boolean,
    executionIsolationAttested?: boolean
  ): {
    agent: Agent;
    revision: AgentRevision;
    effectiveAgent: Agent;
    connector: ModelConnector;
    runtimeProfileSnapshot: RuntimeProfileSnapshot;
  } | null {
    const agent = this.state.agents.find((item) => item.id === agentId);
    const revision = revisionNumber === undefined
      ? undefined
      : this.agentRevisions.get(agentId)?.find((item) => item.revision === revisionNumber);
    if (!agent
      || agent.lifecycleStatus === "disabled"
      || !revision?.publishedAt
      || (requireCurrentPublishedRevision && agent.publishedRevision !== revision.revision)
      || !revision.modelConnectorId) {
      return null;
    }
    const effectiveAgent = { ...agent, ...this.agentFieldsFromRevision(revision) };
    const connector = this.state.modelConnectors.find((item) => item.id === revision.modelConnectorId && item.enabled);
    if (!connector) return null;
    if (revision.promptBinding) {
      const prompt = (this.state.prompts ?? []).find((item) => item.id === revision.promptBinding?.promptId);
      const promptVersion = this.promptVersions.get(revision.promptBinding.promptId)
        ?.find((item) => item.version === revision.promptBinding?.version);
      if (!prompt
        || prompt.kind !== "agent"
        || prompt.status === "archived"
        || prompt.publishedVersion === null
        || prompt.publishedVersion < revision.promptBinding.version
        || !promptVersion?.publishedAt) {
        return null;
      }
    }
    if (connector.credentialId) {
      const credential = (this.state.credentials ?? []).find((item) => item.id === connector.credentialId);
      if (!credential
        || !this.credentialRunnable(credential)
        || credential.secretRevision !== connector.secretRevision) {
        return null;
      }
    } else if (connector.location !== "local" || connector.hasSecret) {
      return null;
    }
    const runtimeProfileSnapshot = this.resolveRuntimeProfileSnapshot(
      effectiveAgent.runtimeProfileBinding,
      effectiveAgent.modelConnectorId,
      executionIsolationAttested
    );
    if (!runtimeProfileSnapshot || !this.hasMatchingSkillSnapshot(
      effectiveAgent,
      Object.fromEntries(effectiveAgent.skillIds.map((skillId) => {
        const skill = this.state.skills.find((item) => item.id === skillId);
        return [skillId, skill?.contentDigest ?? ""];
      }))
    )) {
      return null;
    }
    const mcpToolsReady = effectiveAgent.toolGrants.every((grant) => {
      const mcp = this.state.mcpConnectors.find((item) => item.id === grant.connectorId);
      return Boolean(mcp?.enabled
        && mcp.approvedTools.includes(grant.toolName)
        && mcp.toolRegistrations.some((item) => item.toolName === grant.toolName));
    });
    if (!mcpToolsReady || !effectiveAgent.toolPackGrants.every((grant) =>
      toolPackGrantIsCurrentAndApproved(grant, this.state.toolPacks ?? [])
    )) {
      return null;
    }
    return { agent, revision, effectiveAgent, connector, runtimeProfileSnapshot };
  }

  private taskHasImmutableOmpRuntimeBinding(task: Task, input: TaskAgentRunJobData): boolean {
    const runtimeBinding = input.executionRuntimeBinding;
    if (!input.goalRunId
      || !input.planTaskId
      || !runtimeBinding
      || runtimeBinding.route !== "omp_coding"
      || runtimeBinding.harnessKind !== "pi"
      || runtimeBinding.policy !== "isolated_exec"
      || runtimeBinding.sandboxProfileId === null
      || runtimeBinding.sandboxImageDigest === null
      || runtimeBinding.workspaceSource === null) {
      return false;
    }
    const goalRun = this.goalRuns.get(input.goalRunId);
    const contract = goalRun?.executionContractId
      ? this.goalContracts.get(goalRun.executionContractId)
      : null;
    const planTask = contract?.planSnapshot.find((candidate) => candidate.id === input.planTaskId);
    const contractRuntimeBinding = contract?.runtimeBindings.find((candidate) => (
      candidate.planTaskId === input.planTaskId
    ));
    const taskBinding = [...this.goalTaskBindings.values()].find((candidate) => (
      candidate.goalRunId === input.goalRunId
      && candidate.planRevision === goalRun?.activePlanRevision
      && candidate.planTaskId === input.planTaskId
      && candidate.taskId === task.id
    ));
    const recoversProviderOutcomeUnknown = taskBinding?.state === "failed"
      && taskBinding.lastError === "provider_outcome_unknown"
      && taskBinding.activeJobId === null
      && task.execution.status === "failed"
      && task.execution.lastError === "provider_outcome_unknown"
      && task.execution.jobId !== null
      && task.execution.jobId === input.runtimeRun?.idempotencyKey
      && task.execution.revision === input.executionRevision
      && task.execution.requestFingerprint === input.requestFingerprint
      && input.runtimeRun?.goalRunId === input.goalRunId
      && input.runtimeRun.taskId === task.id
      && input.runtimeRun.attempt === taskBinding.attemptCount;
    return Boolean(goalRun
      && contract
      && contract.planRevision === goalRun.activePlanRevision
      && planTask
      && canonicalTaskMatchesPlan(task, planTask)
      && contractRuntimeBinding
      && isDeepStrictEqual(contractRuntimeBinding, runtimeBinding)
      && taskBinding
      && (["ready", "running"].includes(taskBinding.state) || recoversProviderOutcomeUnknown));
  }

  private taskRunBindingMatches(
    task: Task,
    input: TaskAgentRunJobData,
    requireCurrentPublishedRevision = false
  ): boolean {
    if (task.id !== input.taskId
      || task.status === "done"
      || task.assigneeAgentId !== input.agentId
      || task.executionProfile !== input.executionProfile
      || taskExecutionFingerprint(task) !== input.taskFingerprint
      || (input.executionProfile === "worker" && !task.acceptanceCriteria.trim())
      || (input.executionProfile === "worker" && task.approvalState !== "approved")
      || (input.executionProfile === "advisor" && task.approvalState !== "not_required")) {
      return false;
    }
    const executionIsolationAttested = this.taskHasImmutableOmpRuntimeBinding(task, input);
    const runtime = this.resolveRunnableAgentRevision(
      input.agentId,
      input.agentRevision,
      requireCurrentPublishedRevision,
      executionIsolationAttested || undefined
    );
    if (!runtime) return false;
    const { revision, effectiveAgent, connector, runtimeProfileSnapshot } = runtime;
    const decision = this.state.decisions.find((item) => item.id === task.decisionId && item.meetingId === task.meetingId);
    if (!decision || decision.status !== "approved") return false;
    if (connector.id !== input.modelConnectorBinding.id
      || connector.location !== input.modelConnectorBinding.location
      || connector.baseUrl !== input.modelConnectorBinding.baseUrl
      || connector.model !== input.modelConnectorBinding.model
      || connector.secretRevision !== input.modelConnectorBinding.secretRevision) {
      return false;
    }
    if (JSON.stringify(input.promptBinding ?? null) !== JSON.stringify(revision.promptBinding ?? null)) return false;
    if (connector.credentialId) {
      const credential = (this.state.credentials ?? []).find((item) => item.id === connector.credentialId);
      if (!credential
        || input.credentialBinding?.credentialId !== credential.id
        || input.credentialBinding.secretRevision !== credential.secretRevision
        || input.credentialBinding.provider !== credential.provider
        || input.credentialBinding.location !== credential.location) {
        return false;
      }
    } else if (connector.location !== "local" || connector.hasSecret || input.credentialBinding !== undefined) {
      return false;
    }
    if (!sameRuntimeProfileBinding(effectiveAgent.runtimeProfileBinding, input.runtimeProfileBinding)
      || !sameRuntimeProfileSnapshot(runtimeProfileSnapshot, input.runtimeProfileSnapshot)) {
      return false;
    }
    return this.hasMatchingSkillSnapshot(effectiveAgent, input.skillDigests);
  }

  private assertTaskRunBinding(task: Task, input: TaskAgentRunJobData): void {
    if (task.executionProfile === "manual") throw new StoreConflictError("Manual Tasks cannot start an Agent run.");
    if (!task.assigneeAgentId) throw new StoreConflictError("Task must be assigned to an Agent before it can run.");
    if (task.status === "done") throw new StoreConflictError("Completed Tasks cannot start an Agent run.");
    if (task.executionProfile === "worker" && !task.acceptanceCriteria.trim()) {
      throw new StoreConflictError("Worker Task execution requires acceptance criteria.");
    }
    if (task.executionProfile === "worker" && task.approvalState !== "approved") {
      throw new StoreConflictError("Worker Task execution requires explicit Owner approval.");
    }
    if (task.executionProfile === "advisor" && task.approvalState !== "not_required") {
      throw new StoreConflictError("Advisor Tasks do not use execution approval.");
    }
    if (!this.taskRunBindingMatches(task, input, true)) {
      throw new StoreConflictError("Task Agent, model, Skill, approval, or execution binding is stale.");
    }
  }

  private assertTaskRuntimeRun(jobId: string, task: Task, input: TaskAgentRunJobData): void {
    if (!input.runtimeProfileSnapshot || !input.runtimeRun || input.agentRevision === undefined) {
      throw new StoreConflictError("Task Runtime Run binding is stale.");
    }
    const attempt = task.execution.attemptCount + 1;
    try {
      validateQueuedRuntimeRun(input.runtimeRun, {
        kind: "task_agent",
        scope: {
          id: `task:${task.id}:attempt:${attempt}`,
          kind: "task_attempt",
          subjectId: task.id,
          parentScopeId: null
        },
        runtimeProfile: input.runtimeProfileSnapshot,
        agentId: input.agentId,
        agentRevision: input.agentRevision,
        roleId: null,
        roleRevision: null,
        idempotencyKey: jobId,
        goalRunId: input.goalRunId ?? null,
        taskId: task.id,
        runtimeVersion: input.executionRuntimeBinding?.runtimeVersion ?? null
      });
      if (input.runtimeRun.attempt !== attempt) throw new Error("Runtime Run attempt is stale.");
    } catch {
      throw new StoreConflictError("Task Runtime Run binding is stale.");
    }
  }

  private assertRuntimeProfileCapacity(runtimeProfile: RuntimeProfileSnapshot, tasks = this.state.tasks): void {
    const activeSpeakerTurns = this.state.speakerQueue.filter((item) => item.kind === "agent_turn");
    const activeTaskExecutions = tasks
      .map((task) => task.execution)
      .filter((execution) => execution.status === "queued" || execution.status === "running");
    if (activeSpeakerTurns.some((item) => !item.runtimeProfileBinding)
      || activeTaskExecutions.some((execution) => !execution.runtimeProfileBinding)) {
      throw new StoreConflictError(
        "Runtime Profile capacity cannot be verified while an unattributed legacy execution is active."
      );
    }
    const activeCount = activeSpeakerTurns.filter((item) => (
      item.runtimeProfileBinding!.profileId === runtimeProfile.profileId
    )).length + activeTaskExecutions.filter((execution) => (
      execution.runtimeProfileBinding!.profileId === runtimeProfile.profileId
    )).length;
    if (activeCount >= runtimeProfile.maxConcurrency) {
      throw new StoreConflictError(
        `Runtime Profile concurrency limit reached (${activeCount}/${runtimeProfile.maxConcurrency}).`
      );
    }
  }

  private agentRevisionFromAgent(
    agent: Agent,
    revision: number,
    source: AgentRevision["source"],
    restoredFromRevision: number | null,
    publishedAt: string | null
  ): AgentRevision {
    const snapshot = {
      agentId: agent.id,
      revision,
      name: agent.name,
      description: agent.description,
      modelConnectorId: agent.modelConnectorId,
      goalSummary: agent.goalSummary,
      toolsSummary: agent.toolsSummary,
      dataSummary: agent.dataSummary,
      skillIds: [...agent.skillIds],
      toolGrants: structuredClone(agent.toolGrants),
      toolPackGrants: structuredClone(agent.toolPackGrants),
      runtimeProfileBinding: agent.runtimeProfileBinding ?? null,
      promptBinding: agent.promptBinding ?? null
    };
    return {
      ...snapshot,
      contentDigest: createAgentRevisionContentDigest(snapshot),
      contentDigestVersion: 3,
      source,
      restoredFromRevision,
      createdAt: new Date().toISOString(),
      publishedAt
    };
  }

  private agentFieldsFromRevision(revision: AgentRevision): Pick<Agent, "name" | "description" | "modelConnectorId" | "goalSummary" | "toolsSummary" | "dataSummary" | "skillIds" | "toolGrants" | "toolPackGrants" | "runtimeProfileBinding" | "promptBinding"> {
    return {
      name: revision.name,
      description: revision.description,
      modelConnectorId: revision.modelConnectorId,
      goalSummary: revision.goalSummary,
      toolsSummary: revision.toolsSummary,
      dataSummary: revision.dataSummary,
      skillIds: [...revision.skillIds],
      toolGrants: structuredClone(revision.toolGrants),
      toolPackGrants: structuredClone(revision.toolPackGrants),
      runtimeProfileBinding: revision.runtimeProfileBinding ? { ...revision.runtimeProfileBinding } : null,
      promptBinding: revision.promptBinding
    };
  }

  private createAgentDraft(agent: Agent, source: AgentRevision["source"], restoredFromRevision: number | null): AgentRevision {
    const history = this.agentRevisions.get(agent.id) ?? [];
    const revision = Math.max(agent.draftRevision ?? 0, ...history.map((item) => item.revision)) + 1;
    const draft = this.agentRevisionFromAgent(agent, revision, source, restoredFromRevision, null);
    history.push(draft);
    this.agentRevisions.set(agent.id, history);
    agent.draftRevision = revision;
    agent.revision = this.nextAgentResourceRevision(agent);
    if (agent.lifecycleStatus !== "disabled") agent.lifecycleStatus = "draft";
    return draft;
  }

  private agentResourceRevision(agent: Agent): number {
    return agent.revision ?? agent.draftRevision ?? agent.publishedRevision ?? 1;
  }

  private nextAgentResourceRevision(agent: Agent): number {
    return this.agentResourceRevision(agent) + 1;
  }

  private normalizeAgentRevision(
    revision: AgentRevision,
    fallbackRuntimeProfileBinding: NonNullable<Agent["runtimeProfileBinding"]>
  ): AgentRevision {
    const normalized: AgentRevision = {
      ...revision,
      skillIds: [...revision.skillIds],
      toolGrants: structuredClone(revision.toolGrants),
      toolPackGrants: structuredClone(revision.toolPackGrants ?? []),
      runtimeProfileBinding: revision.runtimeProfileBinding === undefined
        ? { ...fallbackRuntimeProfileBinding }
        : revision.runtimeProfileBinding ? { ...revision.runtimeProfileBinding } : null,
      promptBinding: revision.promptBinding ?? null,
      contentDigestVersion: revision.contentDigestVersion ?? 1
    };
    if (!agentRevisionContentDigestIsValid(normalized)) {
      throw new StoreConflictError("Agent revision content digest does not match its immutable execution binding.");
    }
    return normalized;
  }

  private defaultRecordedAt(state: PlatformSnapshot): string {
    return state.meetings[0]?.createdAt
      ?? state.threads[0]?.createdAt
      ?? new Date().toISOString();
  }

  private normalizeToolPackGrants(value: unknown): ToolPackGrant[] {
    if (value === undefined) return [];
    const parsed = toolPackGrantSchema.array().max(100).safeParse(value);
    if (!parsed.success) throw new StoreConflictError("Invalid existing Agent Tool Pack grants.");
    const keys = parsed.data.map((grant) => `${grant.packId}:${grant.revision}:${grant.manifestDigest}:${grant.toolName}`);
    if (new Set(keys).size !== keys.length) {
      throw new StoreConflictError("Each Agent Tool Pack grant may appear only once.");
    }
    return parsed.data.map((grant) => ({ ...grant }));
  }

  private normalizeToolPacks(
    currentPacks: ToolPack[],
    currentRevisions: ToolPackRevision[],
    recordedRevisions: ToolPackRevision[]
  ): { packs: ToolPack[]; revisions: ToolPackRevision[] } {
    const packs = currentPacks.map((pack) => {
      const parsed = toolPackSchema.parse(pack);
      this.assertToolPackManifestDigest(parsed);
      return parsed;
    });
    const ids = packs.map((pack) => pack.id);
    if (new Set(ids).size !== ids.length) throw new StoreConflictError("Duplicate Tool Pack identifiers detected.");
    const names = packs.map((pack) => pack.name.normalize("NFKC").trim().toLocaleLowerCase());
    if (new Set(names).size !== names.length) throw new StoreConflictError("Duplicate Tool Pack names detected.");

    const revisionsByKey = new Map<string, ToolPackRevision>();
    for (const raw of [...currentRevisions, ...recordedRevisions]) {
      const revision = toolPackRevisionSchema.parse(raw);
      this.assertToolPackManifestDigest(revision);
      const key = `${revision.packId}:${revision.revision}`;
      const existing = revisionsByKey.get(key);
      if (existing && JSON.stringify(existing) !== JSON.stringify(revision)) {
        throw new StoreConflictError("Conflicting immutable Tool Pack revisions detected.");
      }
      revisionsByKey.set(key, revision);
    }
    for (const pack of packs) {
      const revision = revisionsByKey.get(`${pack.id}:${pack.revision}`);
      const createdRevision = revisionsByKey.get(`${pack.id}:1`);
      if (!revision
        || !createdRevision
        || pack.createdAt !== createdRevision.recordedAt
        || pack.updatedAt !== revision.recordedAt
        || JSON.stringify(createToolPackRevision(pack, revision.source, revision.recordedAt)) !== JSON.stringify(revision)) {
        throw new StoreConflictError("Tool Pack current state does not match its immutable revision.");
      }
    }
    return {
      packs: packs.map((pack) => structuredClone(pack)),
      revisions: [...revisionsByKey.values()].sort((left, right) =>
        left.packId.localeCompare(right.packId) || left.revision - right.revision
      )
    };
  }

  private assertToolPackManifestDigest(pack: ToolPack | ToolPackRevision): void {
    if (!toolPackManifestDigestIsValid(pack)) {
      throw new StoreConflictError("Tool Pack manifest digest does not match its immutable content.");
    }
  }

  private assertToolPackRevision(pack: ToolPack, expectedRevision: number): void {
    if (pack.revision !== expectedRevision) throw new StoreConflictError("Tool Pack revision is stale.", "revision");
  }

  private prepareToolPackRevision(
    pack: ToolPack,
    source: ToolPackRevision["source"],
    recordedAt: string
  ): ToolPackRevision {
    const keyExists = (this.state.toolPackRevisions ?? []).some((revision) =>
      revision.packId === pack.id && revision.revision === pack.revision
    );
    if (keyExists) throw new StoreConflictError("Tool Pack revision already exists.");
    return createToolPackRevision(pack, source, recordedAt);
  }

  private normalizeRuntimeProfiles(
    currentProfiles: RuntimeProfile[],
    currentRevisions: RuntimeProfileRevision[],
    recordedRevisions: RuntimeProfileRevision[],
    recordedAt: string
  ): { profiles: RuntimeProfile[]; revisions: RuntimeProfileRevision[] } {
    const profilesById = new Map<string, RuntimeProfile>();
    for (const profile of currentProfiles) {
      profilesById.set(profile.id, {
        ...profile,
        capabilities: [...profile.capabilities]
      });
    }

    const revisionsByKey = new Map<string, RuntimeProfileRevision>();
    for (const revision of [...currentRevisions, ...recordedRevisions]) {
      revisionsByKey.set(`${revision.profileId}:${revision.revision}`, {
        ...revision,
        capabilities: [...revision.capabilities]
      });
    }

    for (const profile of profilesById.values()) {
      const key = `${profile.id}:${profile.revision}`;
      if (!revisionsByKey.has(key)) {
        revisionsByKey.set(
          key,
          createRuntimeProfileRevision(profile, "legacy_backfilled", profile.updatedAt ?? profile.createdAt ?? recordedAt)
        );
      }
    }

    if (profilesById.size === 0 && revisionsByKey.size > 0) {
      for (const revision of revisionsByKey.values()) {
        const existing = profilesById.get(revision.profileId);
        if (existing && existing.revision >= revision.revision) continue;
        profilesById.set(revision.profileId, {
          id: revision.profileId,
          name: revision.name,
          harnessKind: revision.harnessKind,
          modelConnectorId: revision.modelConnectorId,
          sandboxProfileId: revision.sandboxProfileId,
          policy: revision.policy,
          capabilities: [...revision.capabilities],
          timeoutMs: revision.timeoutMs,
          maxConcurrency: revision.maxConcurrency,
          enabled: revision.enabled,
          revision: revision.revision,
          createdAt: revision.recordedAt,
          updatedAt: revision.recordedAt
        });
      }
    }

    if (!profilesById.has(defaultRuntimeProfileBinding.profileId)) {
      const profile = createDefaultRuntimeProfile(recordedAt);
      profilesById.set(profile.id, profile);
    }
    if (!revisionsByKey.has(`${defaultRuntimeProfileBinding.profileId}:1`)) {
      revisionsByKey.set(
        `${defaultRuntimeProfileBinding.profileId}:1`,
        createDefaultRuntimeProfileRevision(recordedAt)
      );
    }

    const profiles = [...profilesById.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const revisions = [...revisionsByKey.values()].sort((left, right) =>
      left.profileId.localeCompare(right.profileId) || left.revision - right.revision
    );
    return { profiles, revisions };
  }

  private resolveRuntimeProfileSnapshot(
    binding: Agent["runtimeProfileBinding"],
    agentModelConnectorId: string | null,
    executionIsolationAttested?: boolean
  ): RuntimeProfileSnapshot | null {
    return resolveRuntimeProfileSnapshotForBinding({
      binding,
      runtimeProfiles: this.state.runtimeProfiles,
      runtimeProfileRevisions: this.state.runtimeProfileRevisions,
      agentModelConnectorId,
      ...(executionIsolationAttested === undefined ? {} : { executionIsolationAttested })
    });
  }

  private makePromptVersion(
    promptId: string,
    version: number,
    content: string,
    variables: string[],
    source: PromptVersion["source"],
    restoredFromVersion: number | null,
    createdAt: string
  ): PromptVersion {
    return {
      promptId,
      version,
      content,
      variables: [...variables],
      contentDigest: createHash("sha256").update(content).digest("hex"),
      source,
      restoredFromVersion,
      createdAt,
      publishedAt: null
    };
  }

  private requiredPromptVersion(promptId: string, version: number): PromptVersion {
    const item = this.promptVersions.get(promptId)?.find((candidate) => candidate.version === version);
    if (!item) throw new StoreNotFoundError("Prompt version not found.");
    return item;
  }

  private validatePromptTokens(content: string, variables: string[]): void {
    const declared = new Set(variables);
    const tokens = [...content.matchAll(/\{\{([^{}]+)\}\}/g)].map((match) => match[1]!.trim());
    for (const token of tokens) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(token) || !declared.has(token)) {
        throw new StoreConflictError("Prompt contains an undeclared or invalid variable token.");
      }
    }
    for (const variable of declared) {
      if (!tokens.includes(variable)) throw new StoreConflictError(`Prompt variable ${variable} is declared but unused.`);
    }
  }

  private validateTeamMembers(members: AgentTeam["members"]): void {
    if (members.filter((member) => member.isChair).length !== 1) throw new StoreConflictError("An Agent Team must have exactly one chair.");
    if (new Set(members.map((member) => member.agentId)).size !== members.length) throw new StoreConflictError("Each Agent may be assigned to a Team only once.");
    for (const member of members) {
      const agent = this.required(this.state.agents, member.agentId, "Agent");
      if (!agent.publishedRevision || !this.resolveRunnableAgentRevision(agent.id, agent.publishedRevision, true)) {
        throw new StoreConflictError(`Agent ${agent.name} must have a runnable current published revision before joining an active Team.`);
      }
      this.requiredActiveRole(member.roleId);
    }
  }

  private requiredActiveTeam(id: string): AgentTeam {
    const team = this.required(this.state.agentTeams ?? [], id, "Agent Team");
    if (team.status !== "active") throw new StoreConflictError("Only active Agent Teams can be referenced.");
    this.validateTeamMembers(team.members);
    return team;
  }

  private requiredActiveCredential(id: string): Credential {
    const credential = this.required(this.state.credentials ?? [], id, "Credential");
    if (credential.status !== "active" || credentialIsExpired(credential.expiresAt)) {
      throw new StoreConflictError("Only active, unexpired Credentials can be bound.");
    }
    return credential;
  }

  private credentialRunnable(credential: Credential): boolean {
    return credential.status === "active"
      && !credentialIsExpired(credential.expiresAt)
      && credential.hasSecret
      && this.credentialSecrets.has(credential.id);
  }

  private buildCredentialRecord(id: string, input: CreateCredentialMetadataInput, secret?: SecretInput): Credential {
    if (this.state.credentials?.some((item) => item.id === id)) throw new StoreConflictError("Credential ID already exists.");
    const now = new Date().toISOString();
    const hasSecret = Boolean(secret?.ciphertext);
    const credential: Credential = {
      id,
      name: input.name,
      provider: input.provider,
      kind: input.kind,
      location: input.location,
      status: "active",
      hasSecret,
      secretRevision: hasSecret ? 1 : 0,
      maskedHint: null,
      expiresAt: input.expiresAt ?? null,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
      rotatedAt: hasSecret ? now : null
    };
    return credential;
  }

  private generatedModelCredentialMetadata(
    connectorName: string,
    location: ModelConnector["location"]
  ): CreateCredentialMetadataInput {
    const parsed = createCredentialSchema.safeParse({
      name: `${connectorName} Credential`,
      provider: connectorName,
      kind: "api_key",
      location,
      expiresAt: null
    });
    if (!parsed.success) {
      throw new StoreConflictError("Generated Credential metadata is invalid; shorten the Model Connector name.");
    }
    const { secret: _secret, ...metadata } = parsed.data;
    this.assertCredentialNameAvailable(metadata.name);
    return metadata;
  }

  private assertCredentialNameAvailable(name: string): void {
    if (this.state.credentials?.some((item) => this.sameName(item.name, name))) {
      throw new StoreConflictError("Credential name already exists.");
    }
  }

  private async recordCredentialCreatedAudit(credential: Credential): Promise<void> {
    await this.recordAudit("credential.created", "credential", credential.id, {
      provider: credential.provider,
      kind: credential.kind,
      location: credential.location,
      hasSecret: credential.hasSecret,
      secretRevision: credential.secretRevision
    });
  }

  private syncCredentialBindings(credential: Credential): void {
    for (const connector of this.state.modelConnectors) {
      if (connector.credentialId !== credential.id) continue;
      const hasSecret = this.credentialRunnable(credential);
      if (connector.hasSecret === hasSecret && connector.secretRevision === credential.secretRevision) continue;
      connector.hasSecret = hasSecret;
      connector.secretRevision = credential.secretRevision;
      connector.revision += 1;
    }
  }

  private assertNoPlaintextSecret(value: object): void {
    if (Object.prototype.hasOwnProperty.call(value, "secret")) {
      throw new StoreConflictError("Plaintext Credential secrets are not accepted by the store; pass encrypted ciphertext via SecretInput.");
    }
  }

  private validateAgentPermissions(
    input: Pick<Agent, "modelConnectorId" | "promptBinding" | "skillIds" | "toolGrants" | "toolPackGrants">,
    existingModelConnectorId: string | null = null
  ): void {
    if (input.promptBinding) {
      const prompt = this.required(this.state.prompts ?? [], input.promptBinding.promptId, "Prompt");
      if (prompt.kind !== "agent") throw new StoreConflictError("Agent Prompt bindings require an Agent Prompt kind.");
    }
    if (input.modelConnectorId) {
      const connector = this.required(this.state.modelConnectors, input.modelConnectorId, "Model connector");
      if (!connector.enabled && connector.id !== existingModelConnectorId) {
        throw new StoreConflictError("Disabled Model Connectors cannot be assigned.");
      }
    }
    if (new Set(input.skillIds).size !== input.skillIds.length) {
      throw new StoreConflictError("Each Skill may be assigned only once.");
    }
    for (const skillId of input.skillIds) {
      const skill = this.required(this.state.skills, skillId, "Skill");
      if (!skillHasCurrentApprovedValidation(skill)) {
        throw new StoreConflictError("Only approved Skills with current passed validation and matching digest can be assigned.");
      }
    }
    for (const grant of input.toolGrants) {
      const connector = this.required(this.state.mcpConnectors, grant.connectorId, "MCP connector");
      if (!connector.enabled
        || !connector.approvedTools.includes(grant.toolName)
        || !connector.toolRegistrations.some((registration) => registration.toolName === grant.toolName)) {
        throw new StoreConflictError("Agent tools must be approved by an enabled MCP connector.");
      }
    }
    const grantKeys = input.toolPackGrants.map((grant) =>
      `${grant.packId}:${grant.revision}:${grant.manifestDigest}:${grant.toolName}`
    );
    if (new Set(grantKeys).size !== grantKeys.length) {
      throw new StoreConflictError("Each Agent Tool Pack grant may appear only once.");
    }
    for (const grant of input.toolPackGrants) {
      const pack = (this.state.toolPacks ?? []).find((candidate) => candidate.id === grant.packId);
      if (!pack
        || pack.status !== "approved"
        || pack.revision !== grant.revision
        || pack.manifestDigest !== grant.manifestDigest) {
        throw new StoreConflictError("Agent Tool Pack grants must bind the current approved non-revoked revision and manifest digest.");
      }
      const tool = pack.tools.find((candidate) => candidate.name === grant.toolName);
      if (!tool || tool.access !== "read_only") {
        throw new StoreConflictError("Agent Tool Pack grants must name a declared read-only tool.");
      }
    }
  }

  private normalizeSkill(skill: Partial<Skill> & Pick<Skill, "id" | "name" | "version" | "instructions" | "status">): Skill {
    const source = typeof skill.source === "string" && skill.source.trim() ? skill.source : "Council legacy registry";
    const owner = typeof skill.owner === "string" && skill.owner.trim() ? skill.owner : "Platform Owner";
    const calculatedDigest = skillContentDigest({ ...skill, source, owner });
    const contentDigest = typeof skill.contentDigest === "string" ? skill.contentDigest : calculatedDigest;
    const rawValidation = skill.validation as Partial<Skill["validation"]> | null | undefined;
    const hasCompleteValidation = rawValidation
      && ["pending", "passed", "failed"].includes(rawValidation.result ?? "")
      && typeof rawValidation.summary === "string"
      && (typeof rawValidation.checkedAt === "string" || rawValidation.checkedAt === null)
      && (rawValidation.result === "pending" || typeof rawValidation.contentDigest === "string");
    const validation = hasCompleteValidation
      ? {
          result: rawValidation.result!,
          summary: rawValidation.summary!,
          checkedAt: rawValidation.checkedAt!,
          contentDigest: rawValidation.result === "pending" ? null : rawValidation.contentDigest!
        }
      : rawValidation == null
        ? skill.status === "approved"
          ? {
              result: "passed" as const,
              summary: "此 Skill 在治理功能上線前已核准；沒有自動驗證證據。",
              checkedAt: null,
              contentDigest: calculatedDigest
            }
          : { result: "pending" as const, summary: "尚未記錄人工驗證證據。", checkedAt: null, contentDigest: null }
        : {
            result: "failed" as const,
            summary: "治理紀錄不完整，必須重新人工驗證。",
            checkedAt: null,
            contentDigest: calculatedDigest
          };
    return {
      id: skill.id,
      name: skill.name,
      version: skill.version,
      instructions: skill.instructions,
      source,
      owner,
      contentDigest,
      validation,
      status: skill.status,
      approvedAt: typeof skill.approvedAt === "string" ? skill.approvedAt : null,
      revokedAt: typeof skill.revokedAt === "string" ? skill.revokedAt : null,
      revocationReason: typeof skill.revocationReason === "string" ? skill.revocationReason : null
    };
  }

  private normalizeApprovedTools(tools: readonly string[]): string[] {
    return [...new Set(tools.map((toolName) => toolName.trim()).filter(Boolean))];
  }

  private normalizeToolRegistrations(
    approvedTools: readonly string[],
    registrations: readonly ToolRegistration[],
    enabled: boolean,
    rejectInvalid: boolean
  ): ToolRegistration[] {
    const approved = new Set(approvedTools);
    const provided = new Map<string, ToolRegistration>();
    for (const candidate of registrations) {
      const registration = toolRegistrationSchema.parse(candidate);
      if (!approved.has(registration.toolName)) {
        if (rejectInvalid) throw new StoreConflictError("Tool Catalog entries must belong to the approved MCP allowlist.");
        continue;
      }
      if (provided.has(registration.toolName)) {
        if (rejectInvalid) throw new StoreConflictError("Each MCP tool may be registered only once.");
        continue;
      }
      provided.set(registration.toolName, registration);
    }
    if (!enabled) return [];
    return approvedTools.map((toolName) => provided.get(toolName) ?? {
      toolName,
      displayName: toolName,
      kind: "mcp_tool",
      version: "unversioned",
      owner: "Platform Owner",
      goal: `以唯讀方式執行 ${toolName}。`
    });
  }

  private agentTurnCredentialBindingIsCurrent(
    revision: AgentRevision,
    binding: NonNullable<AgentTurnCommitInput["executionBinding"]>["credentialBinding"]
  ): boolean {
    const connector = revision.modelConnectorId
      ? this.state.modelConnectors.find((item) => item.id === revision.modelConnectorId)
      : undefined;
    if (!connector) return false;
    if (!connector.credentialId) {
      return connector.location === "local"
        && !connector.hasSecret
        && connector.secretRevision === 0
        && binding === undefined;
    }
    const credential = this.state.credentials?.find((item) => item.id === connector.credentialId);
    return Boolean(binding
      && credential
      && binding.credentialId === connector.credentialId
      && binding.credentialId === credential.id
      && binding.provider === credential.provider
      && binding.location === credential.location
      && binding.secretRevision === credential.secretRevision
      && binding.secretRevision === connector.secretRevision
      && this.credentialRunnable(credential));
  }

  private hasMatchingSkillSnapshot(agent: Pick<Agent, "skillIds">, skillDigests: Record<string, string>): boolean {
    const skillIds = Object.keys(skillDigests);
    if (skillIds.length !== agent.skillIds.length || skillIds.some((id) => !agent.skillIds.includes(id))) return false;
    return agent.skillIds.every((id) => {
      const skill = this.state.skills.find((item) => item.id === id);
      return Boolean(skill && skillHasCurrentApprovedValidation(skill) && skillDigests[id] === skill.contentDigest);
    });
  }

  private assertMcpToolCallAuthorization(input: McpToolCallReservationInput): {
    meeting: Meeting;
    participant: ParticipantAssignment;
    agent: Agent;
    revision: AgentRevision;
    connector: McpConnector;
    registration: ToolRegistration;
  } {
    const meeting = this.required(this.state.meetings, input.meetingId, "Meeting");
    if (meeting.state !== "active") {
      throw new StoreConflictError("Meeting must be active before reserving an MCP call.", "business_rule", "MEETING_NOT_ACTIVE");
    }
    const participant = this.state.participants.find((item) => item.id === input.participantId);
    const agent = this.required(this.state.agents, input.agentId, "Agent");
    if (!participant
      || participant.meetingId !== meeting.id
      || participant.agentId !== agent.id
      || !this.participantMatchesRoleBinding(participant, input)) {
      throw new StoreConflictError("MCP Role binding is stale.", "business_rule", "MCP_BINDING_STALE");
    }
    if (agent.lifecycleStatus === "disabled") {
      throw new StoreConflictError("Agent is disabled.", "business_rule", "AGENT_DISABLED");
    }
    const revision = participant.agentRevision === undefined
      ? undefined
      : this.agentRevisions.get(agent.id)?.find((item) => item.revision === participant.agentRevision);
    if (!revision?.publishedAt || !agentRevisionContentDigestIsValid(revision)) {
      throw new StoreConflictError(
        "The Meeting Agent revision is unavailable or invalid.",
        "business_rule",
        "AGENT_REVISION_UNAVAILABLE"
      );
    }
    if (participant.roleSnapshot.toolPolicy !== "agent_read_only_grants"
      || participant.roleSnapshot.dataPolicy !== "agent_declared_scope") {
      throw new StoreConflictError("The Meeting Role does not permit this tool call.", "business_rule", "ROLE_TOOL_DENIED");
    }
    const connector = this.required(this.state.mcpConnectors, input.connectorId, "MCP connector");
    const registration = connector.toolRegistrations.find((item) => item.toolName === input.toolName);
    if (!connector.enabled
      || !connector.approvedTools.includes(input.toolName)
      || !registration
      || JSON.stringify({ connectorName: connector.name, ...registration }) !== JSON.stringify(input.toolSnapshot)
      || mcpConnectorExecutionFingerprint(connector, this.connectorSecrets.get(connector.id) ?? null) !== input.connectorFingerprint
      || !revision.toolGrants.some((grant) => grant.connectorId === connector.id && grant.toolName === input.toolName)) {
      throw new StoreConflictError("Tool is not approved for this Meeting Agent revision.", "business_rule", "TOOL_DENIED");
    }
    return { meeting, participant, agent, revision, connector, registration };
  }

  private skillAuditDetail(skill: Skill): Record<string, unknown> {
    return {
      name: skill.name,
      version: skill.version,
      source: skill.source,
      owner: skill.owner,
      ownerAttribution: "declared_metadata",
      contentDigest: skill.contentDigest,
      status: skill.status,
      validation: skill.validation,
      approvedAt: skill.approvedAt,
      revokedAt: skill.revokedAt,
      revocationReason: skill.revocationReason
    };
  }

  private async withMeetingSummaryMutation<T>(meetingId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.meetingSummaryMutations.get(meetingId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.catch(() => undefined).then(() => gate);
    this.meetingSummaryMutations.set(meetingId, current);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.meetingSummaryMutations.get(meetingId) === current) {
        this.meetingSummaryMutations.delete(meetingId);
      }
    }
  }

  private async serializeExternalExecutionAdmission<T>(action: () => Promise<T>): Promise<T> {
    const run = this.externalExecutionAdmissionMutation.catch(() => undefined).then(action);
    this.externalExecutionAdmissionMutation = run.then(() => undefined, () => undefined);
    return run;
  }

  private serializeGoalMutation<T>(action: () => Promise<T>): Promise<T> {
    const run = this.goalMutation.catch(() => undefined).then(action);
    this.goalMutation = run.then(() => undefined, () => undefined);
    return run;
  }

  private serializeRuntimeRunMutation<T>(action: () => Promise<T>): Promise<T> {
    const run = this.runtimeRunMutation.catch(() => undefined).then(action);
    this.runtimeRunMutation = run.then(() => undefined, () => undefined);
    return run;
  }

  private requiredRuntimeRun(id: string): RuntimeRun {
    const run = this.runtimeRuns.get(id);
    if (!run) throw new StoreNotFoundError("Runtime Run was not found.");
    return run;
  }

  private runtimeRunEvent(
    runtimeRunId: string,
    sequence: number,
    input: AppendRuntimeRunEventInput
  ): RuntimeRunEvent {
    return runtimeRunEventSchema.parse({
      id: randomUUID(),
      runtimeRunId,
      sequence,
      ...input,
      occurredAt: input.occurredAt ?? new Date().toISOString()
    });
  }

  private requiredGoalRun(id: string): GoalRun {
    const run = this.goalRuns.get(id);
    if (!run) throw new StoreNotFoundError("Goal Run was not found.");
    return run;
  }

  private assertGoalRevision(run: GoalRun, expectedRevision: number): void {
    if (run.revision !== expectedRevision) {
      throw new StoreConflictError("Goal Run revision changed.", "revision", "GOAL_RUN_REVISION_CONFLICT");
    }
  }

  private assertGoalJobAdmissionAvailable(admission: GoalJobAdmission): GoalJobAdmission | null {
    const existing = this.goalJobAdmissions.get(admission.jobId) ?? null;
    if (existing && (existing.requestFingerprint !== admission.requestFingerprint
      || existing.goalRunId !== admission.goalRunId
      || existing.jobName !== admission.jobName
      || existing.entityId !== admission.entityId)) {
      throw new StoreConflictError("Goal job ID is already bound to another request.");
    }
    return existing;
  }

  private async appendGoalEventRecord(id: string, input: AppendGoalEventInput): Promise<GoalEvent> {
    this.requiredGoalRun(id);
    const event = goalEventSchema.parse({
      id: randomUUID(),
      goalRunId: id,
      sequence: ++this.goalEventSequence,
      ...input,
      detail: input.detail ?? {},
      occurredAt: input.occurredAt ?? new Date().toISOString()
    });
    const events = this.goalEvents.get(id) ?? [];
    events.push(event);
    this.goalEvents.set(id, events);
    return structuredClone(event);
  }

  private cached<T>(operation: string, key: string | undefined, input: unknown): T | null {
    if (!key) return null;
    const record = this.idempotency.get(`${operation}:${key}`);
    if (!record) return null;
    if (record.requestFingerprint !== requestFingerprint(input)) {
      throw new StoreConflictError(
        "Idempotency key was already used with a different request.",
        "business_rule",
        "IDEMPOTENCY_KEY_CONFLICT"
      );
    }
    return structuredClone(record.response as T);
  }

  private async replayIdempotent<T>(operation: string, key: string, input: unknown): Promise<T | null> {
    const cached = this.cached<T>(operation, key, input);
    if (cached) return cached;
    const pending = this.pendingIdempotency.get(`${operation}:${key}`);
    if (!pending) return null;
    if (pending.requestFingerprint !== requestFingerprint(input)) {
      throw new StoreConflictError(
        "Idempotency key was already used with a different request.",
        "business_rule",
        "IDEMPOTENCY_KEY_CONFLICT"
      );
    }
    return structuredClone(await pending.promise as T);
  }

  private async runIdempotent<T>(operation: string, key: string | undefined, input: unknown, action: () => Promise<T>): Promise<T> {
    const cached = this.cached<T>(operation, key, input);
    if (cached) return cached;
    if (!key) return structuredClone(await action());

    const scopedKey = `${operation}:${key}`;
    const fingerprint = requestFingerprint(input);
    const pending = this.pendingIdempotency.get(scopedKey);
    if (pending) {
      if (pending.requestFingerprint !== fingerprint) {
        throw new StoreConflictError(
          "Idempotency key was already used with a different request.",
          "business_rule",
          "IDEMPOTENCY_KEY_CONFLICT"
        );
      }
      return structuredClone(await pending.promise as T);
    }

    const promise = Promise.resolve()
      .then(action)
      .then((value) => this.remember(operation, key, input, value));
    this.pendingIdempotency.set(scopedKey, { requestFingerprint: fingerprint, promise });
    try {
      return structuredClone(await promise);
    } finally {
      if (this.pendingIdempotency.get(scopedKey)?.promise === promise) this.pendingIdempotency.delete(scopedKey);
    }
  }

  private remember<T>(operation: string, key: string | undefined, input: unknown, value: T): T {
    if (key) {
      this.idempotency.set(`${operation}:${key}`, {
        requestFingerprint: requestFingerprint(input),
        response: structuredClone(value)
      });
    }
    return structuredClone(value);
  }
}
