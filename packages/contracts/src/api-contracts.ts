import { z } from "zod";
import {
  agentLifecycleStatuses,
  agentReadinessSchema,
  agentRevisionSchema,
  agentTeamSchema,
  chairAutomationLevels,
  credentialSchema,
  credentialStatuses,
  decisionStatuses,
  mcpToolRunStatuses,
  meetingAgendaSchema,
  meetingModes,
  meetingRecordSchema as contractMeetingRecordSchema,
  meetingPresetSchema,
  meetingStates,
  meetingSummaryStates,
  promptKinds,
  promptStatuses,
  promptTemplateSchema,
  promptVersionSchema,
  roleDataPolicies,
  roleTemplateKeys,
  roleToolPolicies,
  roleVersionSchema,
  speakerQueueKinds,
  speakerQueueStatuses,
  taskApprovalStates,
  taskExecutionProfiles,
  taskExecutionStatuses,
  taskStatuses,
  taskSyncStatuses,
  threadStatuses,
  toolRegistrationKinds,
  toolRegistrationSchema
} from "#index";
import type {
  Agent,
  AgentReadiness,
  AgentTeam,
  Category,
  ChairSuggestionRecord,
  ChairSuggestionTransition,
  Credential,
  Decision,
  DiscoveredMcpTool,
  DiscussionGroup,
  DiscussionThread,
  McpConnector,
  McpDiscoveryResponse,
  Meeting,
  MeetingAgenda,
  MeetingRecord,
  MeetingPreset,
  ModelConnector,
  ParticipantAssignment,
  ParticipantRoleHistoryEntry,
  PublicMcpToolExecutionBinding,
  PublicMcpToolRun,
  PublicMeetingViewSnapshot,
  PublicPlatformSnapshot,
  PublicSpeakerQueueItem,
  PublicTask,
  PublicTaskExecutionState,
  PublicTaskSyncState,
  PublicTaskTransition,
  PromptBinding,
  PromptTemplate,
  PromptVersion,
  Role,
  RoleExecutionSnapshot,
  RoleVersion,
  Skill,
  SkillValidation,
  Tag,
  TaskAdapterConnector,
  TaskEvidence,
  ToolRegistration,
  ToolRegistrationSnapshot,
  Utterance
} from "#index";
import {
  runtimeProfileBindingSchema,
  runtimeProfileRevisionSchema,
  runtimeProfileSchema,
  runtimeProfileSnapshotSchema
} from "#runtime-contracts";
import {
  toolPackGrantSchema,
  toolPackRevisionSchema,
  toolPackSchema
} from "#tool-pack-contracts";

type OptionalKeys<T extends object> = {
  [Key in keyof T]-?: {} extends Pick<T, Key> ? Key : never;
}[keyof T];

type RequiredKeys<T extends object> = Exclude<keyof T, OptionalKeys<T>>;

type ZodResponseOutput<T> = T extends readonly (infer Item)[]
  ? ZodResponseOutput<Item>[]
  : T extends object
    ? { [Key in RequiredKeys<T>]: ZodResponseOutput<T[Key]> }
      & { [Key in OptionalKeys<T>]?: ZodResponseOutput<T[Key]> | undefined }
    : T;

type ResponseShape<T extends object> = {
  [Key in keyof T]-?: z.ZodType<ZodResponseOutput<T[Key]>>;
};

const uuid = z.string().uuid();
const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
// Migrations 004 and 014 emitted stable namespaced IDs before nested Task records switched to UUIDs.
const taskEvidenceId = z.union([
  uuid,
  z.string().trim().max(80).regex(new RegExp(`^(?:meeting|decision):${uuidPattern}$`, "i"))
]);
const taskTransitionId = z.union([
  uuid,
  z.string().trim().max(100).regex(new RegExp(`^(?:created|migration014:approval):${uuidPattern}$`, "i"))
]);
const timestamp = z.string().datetime({ offset: true });
const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();
const nonEmpty = (maximum: number) => z.string().trim().min(1).max(maximum);
const boundedString = (maximum: number) => z.string().max(maximum);
const jobId = nonEmpty(500);

function omitInternalResponseFields(value: unknown, fields: readonly string[]): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const projected = { ...(value as Record<string, unknown>) };
  for (const field of fields) delete projected[field];
  return projected;
}
const httpUrl = z.string().url().max(2_000).refine((value) => {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}, "An HTTP(S) URL without embedded credentials is required.");

// Index schemas are lazy so this subpath remains safe if index.ts re-exports it.
const credentialResponseSchema: z.ZodType<Credential> = z.lazy(() => credentialSchema);
export const credentialListResponseSchema = z.object({
  credentials: z.array(credentialResponseSchema)
}).strict();
export const promptTemplateResponseSchema: z.ZodType<PromptTemplate> = z.lazy(() => promptTemplateSchema);
const promptVersionResponseSchema: z.ZodType<PromptVersion> = z.lazy(() => promptVersionSchema);
const roleVersionResponseSchema: z.ZodType<RoleVersion> = z.lazy(() => roleVersionSchema);
const agentTeamResponseSchema: z.ZodType<AgentTeam> = z.lazy(() => agentTeamSchema);
export const agentReadinessResponseSchema: z.ZodType<AgentReadiness> = z.lazy(() => agentReadinessSchema);
const agentRevisionResponseSchema = z.lazy(() => agentRevisionSchema);
const meetingPresetResponseSchema: z.ZodType<MeetingPreset> = z.lazy(() => meetingPresetSchema);
const meetingAgendaResponseSchema: z.ZodType<MeetingAgenda> = z.lazy(() => meetingAgendaSchema);
const registeredToolResponseSchema: z.ZodType<ToolRegistration> = z.lazy(() => toolRegistrationSchema);

export const toolPackListResponseSchema = z.object({
  toolPacks: z.array(toolPackSchema)
}).strict();
export const toolPackRevisionListResponseSchema = z.array(toolPackRevisionSchema);
export const runtimeProfileListResponseSchema = z.object({
  runtimeProfiles: z.array(runtimeProfileSchema)
}).strict();
export const runtimeProfileRevisionListResponseSchema = z.array(runtimeProfileRevisionSchema);
export const agentRevisionListResponseSchema = z.array(agentRevisionResponseSchema);

const threadStatusSchema: z.ZodType<DiscussionThread["status"]> = z.lazy(() => z.enum(threadStatuses));
const agentLifecycleStatusSchema: z.ZodType<NonNullable<Agent["lifecycleStatus"]>> = z.lazy(
  () => z.enum(agentLifecycleStatuses)
);
const promptKindSchema: z.ZodType<PromptTemplate["kind"]> = z.lazy(() => z.enum(promptKinds));
const promptStatusSchema: z.ZodType<PromptTemplate["status"]> = z.lazy(() => z.enum(promptStatuses));
const credentialStatusSchema: z.ZodType<Credential["status"]> = z.lazy(() => z.enum(credentialStatuses));
const roleTemplateKeySchema: z.ZodType<NonNullable<Role["templateKey"]>> = z.lazy(() => z.enum(roleTemplateKeys));
const roleToolPolicySchema: z.ZodType<Role["toolPolicy"]> = z.lazy(() => z.enum(roleToolPolicies));
const roleDataPolicySchema: z.ZodType<Role["dataPolicy"]> = z.lazy(() => z.enum(roleDataPolicies));
const toolRegistrationKindSchema: z.ZodType<ToolRegistration["kind"]> = z.lazy(() => z.enum(toolRegistrationKinds));
const speakerQueueKindSchema: z.ZodType<PublicSpeakerQueueItem["kind"]> = z.lazy(() => z.enum(speakerQueueKinds));
const speakerQueueStatusSchema: z.ZodType<PublicSpeakerQueueItem["status"]> = z.lazy(() => z.enum(speakerQueueStatuses));
const meetingStateSchema: z.ZodType<Meeting["state"]> = z.lazy(() => z.enum(meetingStates));
const meetingModeSchema: z.ZodType<Meeting["mode"]> = z.lazy(() => z.enum(meetingModes));
const chairAutomationLevelSchema: z.ZodType<Meeting["automation"]> = z.lazy(() => z.enum(chairAutomationLevels));
const meetingSummaryStateSchema: z.ZodType<Meeting["summaryState"]> = z.lazy(() => z.enum(meetingSummaryStates));
const mcpToolRunStatusSchema: z.ZodType<PublicMcpToolRun["status"]> = z.lazy(() => z.enum(mcpToolRunStatuses));
const decisionStatusSchema: z.ZodType<Decision["status"]> = z.lazy(() => z.enum(decisionStatuses));
const taskStatusSchema: z.ZodType<PublicTask["status"]> = z.lazy(() => z.enum(taskStatuses));
const taskExecutionProfileSchema: z.ZodType<PublicTask["executionProfile"]> = z.lazy(() => z.enum(taskExecutionProfiles));
const taskApprovalStateSchema: z.ZodType<PublicTask["approvalState"]> = z.lazy(() => z.enum(taskApprovalStates));
const taskExecutionStatusSchema: z.ZodType<PublicTaskExecutionState["status"]> = z.lazy(() => z.enum(taskExecutionStatuses));
const taskSyncStatusSchema: z.ZodType<PublicTaskSyncState["status"]> = z.lazy(() => z.enum(taskSyncStatuses));

const promptBindingResponseSchema = z.object({
  promptId: uuid,
  version: positiveInteger
} satisfies ResponseShape<PromptBinding>).strict();

export const discussionGroupResponseSchema = z.object({
  id: uuid,
  revision: positiveInteger,
  name: nonEmpty(100)
} satisfies ResponseShape<DiscussionGroup>).strict();

export const categoryResponseSchema = z.object({
  id: uuid,
  revision: positiveInteger,
  groupId: uuid,
  name: nonEmpty(100)
} satisfies ResponseShape<Category>).strict();

export const tagResponseSchema = z.object({
  id: uuid,
  revision: positiveInteger,
  name: nonEmpty(100),
  color: z.enum(["green", "blue", "amber", "red", "gray"])
} satisfies ResponseShape<Tag>).strict();

export const discussionThreadResponseSchema = z.object({
  id: uuid,
  revision: positiveInteger,
  categoryId: uuid,
  title: nonEmpty(160),
  summary: boundedString(1_000),
  status: threadStatusSchema,
  tagIds: z.array(uuid).max(12),
  createdAt: timestamp
} satisfies ResponseShape<DiscussionThread>).strict().superRefine((value, context) => {
  if (new Set(value.tagIds).size !== value.tagIds.length) {
    context.addIssue({ code: "custom", path: ["tagIds"], message: "Thread tag IDs must be unique." });
  }
});

const agentToolGrantResponseSchema = z.object({
  connectorId: uuid,
  toolName: nonEmpty(200)
}).strict();

export const agentResponseSchema = z.object({
  id: uuid,
  revision: positiveInteger.optional(),
  name: nonEmpty(100),
  description: boundedString(500),
  modelConnectorId: uuid.nullable(),
  goalSummary: nonEmpty(1_000),
  toolsSummary: nonEmpty(1_000),
  dataSummary: nonEmpty(1_000),
  skillIds: z.array(uuid).max(50),
  toolGrants: z.array(agentToolGrantResponseSchema).max(100),
  toolPackGrants: z.array(toolPackGrantSchema).max(100),
  runtimeProfileBinding: runtimeProfileBindingSchema.nullable(),
  status: z.enum(["online", "offline", "attention"]),
  lifecycleStatus: agentLifecycleStatusSchema.optional(),
  promptBinding: promptBindingResponseSchema.nullable().optional(),
  draftRevision: positiveInteger.optional(),
  publishedRevision: positiveInteger.nullable().optional()
} satisfies ResponseShape<Agent>).strict().superRefine((value, context) => {
  if (new Set(value.skillIds).size !== value.skillIds.length) {
    context.addIssue({ code: "custom", path: ["skillIds"], message: "Agent skill IDs must be unique." });
  }
  const grants = value.toolGrants.map((grant) => `${grant.connectorId}:${grant.toolName}`);
  if (new Set(grants).size !== grants.length) {
    context.addIssue({ code: "custom", path: ["toolGrants"], message: "Agent tool grants must be unique." });
  }
});

export const roleResponseSchema = z.object({
  id: uuid,
  name: nonEmpty(100),
  usageContext: nonEmpty(1_000),
  responsibility: nonEmpty(1_000),
  speakingGuidance: nonEmpty(2_000),
  decisionScope: nonEmpty(2_000),
  constraints: nonEmpty(2_000),
  version: positiveInteger,
  templateKey: roleTemplateKeySchema.nullable(),
  toolPolicy: roleToolPolicySchema,
  dataPolicy: roleDataPolicySchema,
  orchestrationFunctions: z.array(z.enum(["chair", "planner", "worker", "reviewer"])).max(4).optional(),
  deletedAt: timestamp.nullable()
} satisfies ResponseShape<Role>).strict().superRefine((value, context) => {
  if (value.toolPolicy === "agent_read_only_grants" && value.dataPolicy === "meeting_only") {
    context.addIssue({
      code: "custom",
      path: ["dataPolicy"],
      message: "External tools require the Agent declared data scope."
    });
  }
});

const skillValidationResponseSchema = z.object({
  result: z.enum(["pending", "passed", "failed"]),
  summary: boundedString(2_000),
  checkedAt: timestamp.nullable(),
  contentDigest: nonEmpty(500).nullable()
} satisfies ResponseShape<SkillValidation>).strict();

export const skillResponseSchema = z.object({
  id: uuid,
  name: nonEmpty(100),
  version: nonEmpty(100),
  instructions: nonEmpty(20_000),
  source: nonEmpty(500),
  owner: nonEmpty(200),
  contentDigest: nonEmpty(500),
  validation: skillValidationResponseSchema,
  status: z.enum(["draft", "approved", "revoked"]),
  approvedAt: timestamp.nullable(),
  revokedAt: timestamp.nullable(),
  revocationReason: nonEmpty(1_000).nullable()
} satisfies ResponseShape<Skill>).strict();

export const roleLifecycleResponseSchema = z.object({
  role: roleResponseSchema,
  versions: z.array(roleVersionResponseSchema),
  missingVersions: z.array(z.number().int().positive()),
  canDelete: z.boolean(),
  blockerReason: z.string().nullable(),
  unfinishedMeetingCount: z.number().int().nonnegative(),
  activeTeamCount: z.number().int().nonnegative(),
  historicalMeetingCount: z.number().int().nonnegative()
}).strict();

export const roleDeletionResponseSchema = z.object({
  id: uuid,
  historicalMeetingCount: z.number().int().nonnegative()
}).strict();

export const skillRevocationResponseSchema = z.object({
  skill: skillResponseSchema,
  revokedAssignmentCount: z.number().int().nonnegative()
}).strict();

export const promptListResponseSchema = z.object({
  prompts: z.array(promptTemplateResponseSchema)
}).strict();

export const promptVersionListResponseSchema = z.array(promptVersionResponseSchema);

export const promptPreviewResponseSchema = z.object({
  content: z.string().max(20_000),
  version: z.number().int().positive()
}).strict();

export const modelConnectorResponseSchema = z.object({
  id: uuid,
  revision: positiveInteger,
  name: nonEmpty(100),
  location: z.enum(["cloud", "local"]),
  baseUrl: httpUrl,
  model: nonEmpty(200),
  enabled: z.boolean(),
  hasSecret: z.boolean(),
  secretRevision: nonNegativeInteger,
  credentialId: uuid.nullable().optional()
} satisfies ResponseShape<ModelConnector>).strict();

export const mcpConnectorResponseSchema = z.object({
  id: uuid,
  revision: positiveInteger,
  name: nonEmpty(100),
  location: z.enum(["cloud", "local"]),
  baseUrl: httpUrl,
  approvedTools: z.array(nonEmpty(200)).max(100),
  toolRegistrations: z.array(registeredToolResponseSchema).max(100),
  enabled: z.boolean(),
  hasSecret: z.boolean(),
  secretRevision: nonNegativeInteger
} satisfies ResponseShape<McpConnector>).strict().superRefine((value, context) => {
  if (new Set(value.approvedTools).size !== value.approvedTools.length) {
    context.addIssue({ code: "custom", path: ["approvedTools"], message: "Approved MCP tools must be unique." });
  }
  const registeredNames = value.toolRegistrations.map((registration) => registration.toolName);
  if (new Set(registeredNames).size !== registeredNames.length) {
    context.addIssue({ code: "custom", path: ["toolRegistrations"], message: "Registered MCP tools must be unique." });
  }
  for (const [index, registration] of value.toolRegistrations.entries()) {
    if (!value.approvedTools.includes(registration.toolName)) {
      context.addIssue({
        code: "custom",
        path: ["toolRegistrations", index, "toolName"],
        message: "Registered MCP tools must belong to the approved allowlist."
      });
    }
  }
});

export const modelConnectorUpdateResponseSchema = modelConnectorResponseSchema.extend({
  assignedAgentCount: nonNegativeInteger
}).strict();

export const mcpConnectorUpdateResponseSchema = z.object({
  connector: mcpConnectorResponseSchema,
  revokedGrantCount: nonNegativeInteger
}).strict();

export const discoveredMcpToolResponseSchema = z.object({
  name: nonEmpty(200),
  description: boundedString(4_000).optional(),
  readOnly: z.boolean()
} satisfies ResponseShape<DiscoveredMcpTool>).strict();

export const mcpDiscoveryResponseSchema = z.object({
  connector: mcpConnectorResponseSchema,
  tools: z.array(discoveredMcpToolResponseSchema).max(1_000),
  approvedTools: z.array(nonEmpty(200)).max(100)
} satisfies ResponseShape<McpDiscoveryResponse>).strict();

export const taskAdapterConnectorResponseSchema = z.object({
  id: uuid,
  name: nonEmpty(100),
  location: z.enum(["cloud", "local"]),
  baseUrl: httpUrl,
  enabled: z.boolean(),
  hasSecret: z.boolean()
} satisfies ResponseShape<TaskAdapterConnector>).strict();

const roleExecutionSnapshotResponseSchema = z.object({
  roleId: uuid,
  name: nonEmpty(100),
  usageContext: nonEmpty(1_000),
  responsibility: nonEmpty(1_000),
  speakingGuidance: nonEmpty(2_000),
  decisionScope: nonEmpty(2_000),
  constraints: nonEmpty(2_000),
  version: positiveInteger,
  templateKey: roleTemplateKeySchema.nullable(),
  toolPolicy: roleToolPolicySchema,
  dataPolicy: roleDataPolicySchema,
  orchestrationFunctions: z.array(z.enum(["chair", "planner", "worker", "reviewer"])).max(4),
  source: z.enum(["meeting_created", "legacy_backfilled", "meeting_role_switched"])
} satisfies ResponseShape<RoleExecutionSnapshot>).strict();

const participantRoleHistoryResponseSchema = z.object({
  revision: positiveInteger,
  roleId: uuid,
  roleSnapshot: roleExecutionSnapshotResponseSchema,
  changedAt: timestamp,
  changedBy: z.enum(["owner", "system"]),
  reason: nonEmpty(500)
} satisfies ResponseShape<ParticipantRoleHistoryEntry>).strict();

export const participantAssignmentResponseSchema = z.object({
  id: uuid,
  meetingId: uuid,
  agentId: uuid,
  roleId: uuid,
  isChair: z.boolean(),
  agentRevision: positiveInteger.optional(),
  roleSnapshot: roleExecutionSnapshotResponseSchema,
  roleRevision: positiveInteger,
  roleHistory: z.array(participantRoleHistoryResponseSchema)
} satisfies ResponseShape<ParticipantAssignment>).strict();

const toolRegistrationSnapshotResponseSchema = z.object({
  toolName: nonEmpty(200),
  displayName: nonEmpty(200),
  kind: toolRegistrationKindSchema,
  version: nonEmpty(100),
  owner: nonEmpty(200),
  goal: nonEmpty(2_000),
  connectorName: nonEmpty(100)
} satisfies ResponseShape<ToolRegistrationSnapshot>).strict();

const mcpToolExecutionBindingResponseSchema = z.preprocess(
  (value) => omitInternalResponseFields(value, ["connectorFingerprint"]),
  z.object({
    connectorId: uuid,
    toolSnapshot: toolRegistrationSnapshotResponseSchema
  } satisfies ResponseShape<PublicMcpToolExecutionBinding>).strict()
);

const speakerQueueItemResponseSchema = z.preprocess(
  (value) => omitInternalResponseFields(value, ["reservationId", "requestFingerprint"]),
  z.object({
    participantId: uuid,
    roleRevision: positiveInteger,
    roleId: uuid,
    roleVersion: positiveInteger,
    id: jobId,
    jobId,
    meetingId: uuid,
    agentId: uuid,
    kind: speakerQueueKindSchema,
    label: nonEmpty(500),
    toolName: nonEmpty(200).nullable(),
    roleName: nonEmpty(100),
    agendaRevision: nonNegativeInteger.nullable(),
    agendaCurrentItemId: uuid.nullable(),
    status: speakerQueueStatusSchema,
    requestedAt: timestamp,
    startedAt: timestamp.nullable(),
    leaseExpiresAt: timestamp,
    runtimeProfileBinding: runtimeProfileBindingSchema.nullable().optional(),
    mcpExecutionBinding: mcpToolExecutionBindingResponseSchema.nullable().optional(),
    requestedBy: z.enum(["owner", "system"]).optional(),
    chairSuggestionId: uuid.nullable().optional(),
    automationRevision: nonNegativeInteger.nullable().optional()
  } satisfies ResponseShape<PublicSpeakerQueueItem>).strict()
);

export const meetingResponseSchema = z.object({
  id: uuid,
  threadId: uuid,
  title: nonEmpty(160),
  goal: nonEmpty(1_000),
  state: meetingStateSchema,
  mode: meetingModeSchema,
  automation: chairAutomationLevelSchema,
  automationRevision: nonNegativeInteger.optional(),
  durationMinutes: z.number().int().min(5).max(240),
  startedAt: timestamp.nullable(),
  closedAt: timestamp.nullable().default(null),
  agenda: meetingAgendaResponseSchema,
  summaryState: meetingSummaryStateSchema,
  summaryJobId: jobId.nullable(),
  createdAt: timestamp,
  sourceTeamId: uuid.nullable().optional(),
  sourcePresetId: uuid.nullable().optional()
} satisfies ResponseShape<Meeting>).strict();

export const utteranceResponseSchema = z.object({
  id: uuid,
  meetingId: uuid,
  agentId: uuid.optional(),
  agentRevision: positiveInteger.nullable().optional(),
  turnId: nonEmpty(200).optional(),
  speakerType: z.enum(["human", "agent", "system", "tool"]),
  speakerName: nonEmpty(100),
  roleName: boundedString(100).nullable(),
  roleId: uuid.nullable().optional(),
  roleRevision: positiveInteger.nullable().optional(),
  content: nonEmpty(20_000),
  kind: z.enum(["human", "inference", "verified", "failure", "system"]),
  evidenceCount: z.number().int().min(0).max(100),
  createdAt: timestamp
} satisfies ResponseShape<Utterance>).strict();

export const meetingRecordSchema: z.ZodType<MeetingRecord> = z.lazy(() => contractMeetingRecordSchema);

export const meetingUtterancePageResponseSchema = z.object({
  items: z.array(utteranceResponseSchema).max(100),
  nextCursor: z.string().trim().min(8).max(2_048).nullable()
}).strict();

const mcpToolRunResponseSchema = z.preprocess(
  (value) => omitInternalResponseFields(value, ["requestFingerprint"]),
  z.object({
    id: uuid,
    jobId,
    meetingId: uuid,
    agentId: uuid,
    connectorId: uuid,
    toolName: nonEmpty(200),
    toolSnapshot: toolRegistrationSnapshotResponseSchema,
    status: mcpToolRunStatusSchema,
    utteranceId: uuid,
    createdAt: timestamp
  } satisfies ResponseShape<PublicMcpToolRun>).strict()
);

const chairSuggestionTransitionResponseSchema = z.object({
  id: uuid,
  type: z.enum([
    "created",
    "mode_accepted",
    "role_accepted",
    "agent_requested",
    "request_released",
    "completed",
    "dismissed",
    "superseded",
    "manual_override",
    "meeting_closed",
    "close_reverted"
  ]),
  actor: z.enum(["owner", "system"]),
  at: timestamp,
  agentId: uuid.optional(),
  jobId: jobId.optional(),
  note: boundedString(1_000).optional()
} satisfies ResponseShape<ChairSuggestionTransition>).strict();

export const chairSuggestionResponseSchema = z.object({
  reason: z.enum(["repetition", "off_topic", "time_remaining"]),
  suggestedMode: meetingModeSchema,
  explanation: nonEmpty(2_000),
  score: z.number().min(0).max(1),
  suggestedAgentId: uuid.optional(),
  suggestedAgentName: nonEmpty(100).optional(),
  suggestedParticipantId: uuid.optional(),
  suggestedParticipantAgentId: uuid.optional(),
  suggestedParticipantAgentName: nonEmpty(100).optional(),
  suggestedParticipantRoleRevision: positiveInteger.optional(),
  suggestedRoleId: uuid.optional(),
  suggestedRoleName: nonEmpty(100).optional(),
  suggestedRoleVersion: positiveInteger.optional(),
  id: uuid,
  meetingId: uuid,
  sourceUtteranceId: uuid,
  status: z.enum(["open", "pending", "resolved"]),
  modeAcceptedAt: timestamp.nullable(),
  requestedAgentId: uuid.nullable(),
  requestedAgentJobId: jobId.nullable(),
  resolution: z.enum(["completed", "dismissed", "superseded", "manual_override", "meeting_closed"]).nullable(),
  resolutionNote: boundedString(1_000).nullable(),
  resolvedBy: z.enum(["owner", "system"]).nullable(),
  transitions: z.array(chairSuggestionTransitionResponseSchema),
  createdAt: timestamp,
  resolvedAt: timestamp.nullable()
} satisfies ResponseShape<ChairSuggestionRecord>).strict();

export const humanUtteranceResponseSchema = z.object({
  utterance: utteranceResponseSchema,
  chairSuggestion: chairSuggestionResponseSchema.nullable().optional()
}).strict();

export const suggestedRoleResponseSchema = z.object({
  participant: participantAssignmentResponseSchema,
  suggestion: chairSuggestionResponseSchema
}).strict();

export const decisionResponseSchema = z.object({
  id: uuid,
  meetingId: uuid,
  title: nonEmpty(160),
  description: nonEmpty(4_000),
  status: decisionStatusSchema,
  createdAt: timestamp
} satisfies ResponseShape<Decision>).strict();

const taskEvidenceResponseSchema = z.object({
  id: taskEvidenceId,
  type: z.enum(["meeting", "decision", "url", "note"]),
  label: nonEmpty(160),
  reference: nonEmpty(4_000),
  addedBy: z.enum(["owner", "system"]),
  agentId: uuid.optional(),
  jobId: jobId.optional(),
  executionProfile: z.enum(["advisor", "worker"]).optional(),
  createdAt: timestamp
} satisfies ResponseShape<TaskEvidence>).strict();

const taskTransitionResponseSchema = z.preprocess(
  (value) => omitInternalResponseFields(value, ["requestFingerprint"]),
  z.object({
    id: taskTransitionId,
    type: z.enum([
      "created",
      "updated",
      "moved",
      "evidence_added",
      "approval_changed",
      "agent_run_requested",
      "agent_run_started",
      "agent_run_completed",
      "agent_run_failed",
      "sync_requested",
      "sync_succeeded",
      "sync_failed"
    ]),
    actor: z.enum(["owner", "system"]),
    at: timestamp,
    fromStatus: taskStatusSchema.optional(),
    toStatus: taskStatusSchema.optional(),
    fromPosition: nonNegativeInteger.optional(),
    toPosition: nonNegativeInteger.optional(),
    evidenceId: taskEvidenceId.optional(),
    agentId: uuid.optional(),
    executionRevision: nonNegativeInteger.optional(),
    fromApprovalState: taskApprovalStateSchema.optional(),
    toApprovalState: taskApprovalStateSchema.optional(),
    adapterId: uuid.optional(),
    jobId: jobId.optional(),
    note: boundedString(4_000).optional()
  } satisfies ResponseShape<PublicTaskTransition>).strict()
);

const taskExecutionStateResponseSchema = z.preprocess(
  (value) => omitInternalResponseFields(value, ["requestFingerprint"]),
  z.object({
    revision: nonNegativeInteger,
    status: taskExecutionStatusSchema,
    jobId: jobId.nullable(),
    agentId: uuid.nullable(),
    profile: z.enum(["advisor", "worker"]).nullable(),
    attemptCount: nonNegativeInteger,
    requestedAt: timestamp.nullable(),
    startedAt: timestamp.nullable(),
    providerStartedAt: timestamp.nullable().optional(),
    completedAt: timestamp.nullable(),
    lastError: boundedString(4_000).nullable(),
    resultEvidenceId: taskEvidenceId.nullable(),
    runtimeProfileBinding: runtimeProfileBindingSchema.nullable().optional()
  } satisfies ResponseShape<PublicTaskExecutionState>).strict()
);

const taskSyncStateResponseSchema = z.preprocess(
  (value) => omitInternalResponseFields(value, ["requestFingerprint"]),
  z.object({
    status: taskSyncStatusSchema,
    adapterId: uuid.nullable(),
    jobId: jobId.nullable(),
    externalId: nonEmpty(500).nullable(),
    attemptCount: nonNegativeInteger,
    lastAttemptAt: timestamp.nullable(),
    lastError: boundedString(4_000).nullable(),
    syncedAt: timestamp.nullable()
  } satisfies ResponseShape<PublicTaskSyncState>).strict()
);

export const taskResponseSchema = z.object({
  id: uuid,
  meetingId: uuid,
  decisionId: uuid,
  revision: positiveInteger,
  boardRevision: positiveInteger,
  title: nonEmpty(160),
  description: boundedString(4_000),
  status: taskStatusSchema,
  position: nonNegativeInteger,
  assignee: boundedString(100).nullable(),
  assigneeAgentId: uuid.nullable(),
  dueAt: timestamp.nullable(),
  acceptanceCriteria: boundedString(4_000),
  evidence: z.array(taskEvidenceResponseSchema),
  executionProfile: taskExecutionProfileSchema,
  allowedTools: z.array(nonEmpty(200)).max(50),
  dataScope: boundedString(2_000),
  approvalState: taskApprovalStateSchema,
  execution: taskExecutionStateResponseSchema,
  transitions: z.array(taskTransitionResponseSchema),
  sync: taskSyncStateResponseSchema,
  createdAt: timestamp,
  updatedAt: timestamp
} satisfies ResponseShape<PublicTask>).strict();

export const taskRunResponseSchema = z.object({
  task: taskResponseSchema,
  jobId,
  replayed: z.boolean().optional()
}).strict();

export const taskSyncResponseSchema = z.object({
  task: taskResponseSchema,
  jobId
}).strict();

const platformSnapshotShape = {
  groups: z.array(discussionGroupResponseSchema),
  categories: z.array(categoryResponseSchema),
  tags: z.array(tagResponseSchema),
  threads: z.array(discussionThreadResponseSchema),
  agents: z.array(agentResponseSchema),
  roles: z.array(roleResponseSchema),
  skills: z.array(skillResponseSchema),
  modelConnectors: z.array(modelConnectorResponseSchema),
  mcpConnectors: z.array(mcpConnectorResponseSchema),
  taskAdapterConnectors: z.array(taskAdapterConnectorResponseSchema),
  meetings: z.array(meetingResponseSchema),
  participants: z.array(participantAssignmentResponseSchema),
  speakerQueue: z.array(speakerQueueItemResponseSchema),
  utterances: z.array(utteranceResponseSchema),
  toolRuns: z.array(mcpToolRunResponseSchema),
  chairSuggestions: z.array(chairSuggestionResponseSchema),
  decisions: z.array(decisionResponseSchema),
  tasks: z.array(taskResponseSchema),
  credentials: z.array(credentialResponseSchema).default([]),
  prompts: z.array(promptTemplateResponseSchema).default([]),
  agentTeams: z.array(agentTeamResponseSchema).default([]),
  meetingPresets: z.array(meetingPresetResponseSchema).default([]),
  runtimeProfiles: z.array(runtimeProfileSchema).default([]),
  runtimeProfileRevisions: z.array(runtimeProfileRevisionSchema).default([]),
  toolPacks: z.array(toolPackSchema).default([]),
  toolPackRevisions: z.array(toolPackRevisionSchema).default([])
} satisfies ResponseShape<Required<PublicPlatformSnapshot>>;

type DefaultedPlatformCollection =
  | "credentials"
  | "prompts"
  | "agentTeams"
  | "meetingPresets"
  | "runtimeProfiles"
  | "runtimeProfileRevisions"
  | "toolPacks"
  | "toolPackRevisions";

export type NormalizedPlatformSnapshot = PublicPlatformSnapshot & {
  [Key in DefaultedPlatformCollection]-?: NonNullable<PublicPlatformSnapshot[Key]>;
};

export const platformSnapshotSchema = z.object(platformSnapshotShape).strict().transform(
  (value): NormalizedPlatformSnapshot => value as unknown as NormalizedPlatformSnapshot
);

const meetingViewSnapshotShape = {
  meeting: meetingResponseSchema,
  participants: z.array(participantAssignmentResponseSchema),
  speakerQueue: z.array(speakerQueueItemResponseSchema),
  utterances: z.array(utteranceResponseSchema),
  toolRuns: z.array(mcpToolRunResponseSchema),
  chairSuggestions: z.array(chairSuggestionResponseSchema),
  decisions: z.array(decisionResponseSchema),
  tasks: z.array(taskResponseSchema)
} satisfies ResponseShape<PublicMeetingViewSnapshot>;

export const meetingViewSnapshotSchema = z.object(meetingViewSnapshotShape).strict().transform(
  (value): PublicMeetingViewSnapshot => value as unknown as PublicMeetingViewSnapshot
);

const effectiveAgentSummarySchema = z.object({
  id: uuid,
  name: nonEmpty(100),
  description: boundedString(500),
  lifecycleStatus: agentLifecycleStatusSchema,
  draftRevision: positiveInteger,
  publishedRevision: positiveInteger.nullable(),
  goalSummary: nonEmpty(1_000),
  toolsSummary: nonEmpty(1_000),
  dataSummary: nonEmpty(1_000)
}).strict();

const effectiveConfigurationSourceSchema = z.object({
  kind: z.enum(["published", "draft", "published_missing"]),
  revision: positiveInteger
}).strict();

const bindingCountSchema = z.object({
  configured: nonNegativeInteger,
  ready: nonNegativeInteger
}).strict().superRefine((count, context) => {
  if (count.ready > count.configured) {
    context.addIssue({
      code: "custom",
      path: ["ready"],
      message: "Ready binding count cannot exceed configured binding count."
    });
  }
});

const effectiveBindingCountsSchema = z.object({
  skills: bindingCountSchema,
  tools: bindingCountSchema,
  toolPacks: bindingCountSchema
}).strict();

const effectiveModelResponseSchema = z.object({
  id: uuid,
  name: nonEmpty(100),
  location: z.enum(["cloud", "local"]),
  model: nonEmpty(500),
  enabled: z.boolean()
}).strict();

const effectiveCredentialResponseSchema = z.object({
  id: uuid,
  name: nonEmpty(100),
  location: z.enum(["cloud", "local"]),
  status: credentialStatusSchema,
  hasSecret: z.boolean(),
  maskedHint: z.string().trim().max(100).nullable(),
  expiresAt: timestamp.nullable()
}).strict();

const effectivePromptResponseSchema = z.object({
  id: uuid,
  name: nonEmpty(100),
  kind: promptKindSchema,
  description: z.string().trim().max(1_000),
  owner: nonEmpty(200),
  status: promptStatusSchema,
  currentVersion: positiveInteger,
  publishedVersion: positiveInteger.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  version: positiveInteger
}).strict();

const effectiveToolResponseSchema = z.object({
  connectorId: uuid,
  connectorName: nonEmpty(100),
  toolName: nonEmpty(200),
  displayName: nonEmpty(200),
  kind: toolRegistrationKindSchema,
  version: nonEmpty(100),
  owner: nonEmpty(200),
  goal: nonEmpty(2_000)
}).strict();

const effectiveSkillResponseSchema = z.object({
  id: uuid,
  name: nonEmpty(100),
  version: nonEmpty(100),
  source: nonEmpty(1_000),
  owner: nonEmpty(200)
}).strict();

const effectiveToolPackResponseSchema = z.object({
  packId: uuid,
  packName: nonEmpty(120),
  revision: positiveInteger,
  version: nonEmpty(100),
  toolName: nonEmpty(120),
  toolGoal: nonEmpty(2_000)
}).strict();

const agentTeamMembershipSummarySchema = z.object({
  id: uuid,
  name: nonEmpty(100),
  isChair: z.boolean(),
  role: z.object({
    id: uuid,
    name: nonEmpty(100),
    version: positiveInteger,
    toolPolicy: roleToolPolicySchema,
    dataPolicy: roleDataPolicySchema
  }).strict()
}).strict();

const effectiveRuntimeProfileResponseSchema = z.object({
  binding: runtimeProfileBindingSchema,
  current: runtimeProfileSchema.nullable(),
  revision: runtimeProfileRevisionSchema.nullable(),
  snapshot: runtimeProfileSnapshotSchema.nullable()
}).strict();

const boundedUniqueAgentIdsSchema = z.array(uuid).min(1).max(50).superRefine((agentIds, context) => {
  if (new Set(agentIds).size !== agentIds.length) {
    context.addIssue({ code: "custom", message: "Agent IDs must be unique." });
  }
});

export const agentReadinessBatchRequestSchema = z.object({
  agentIds: boundedUniqueAgentIdsSchema
}).strict();

const agentReadinessBatchResultSchema = z.object({
  agentId: uuid,
  readiness: agentReadinessResponseSchema
}).strict();

export const agentReadinessBatchResponseSchema = z.object({
  results: z.array(agentReadinessBatchResultSchema).min(1).max(50)
}).strict();

export const effectiveAgentConfigurationSchema = z.object({
  source: effectiveConfigurationSourceSchema,
  agent: effectiveAgentSummarySchema,
  bindingCounts: effectiveBindingCountsSchema,
  model: effectiveModelResponseSchema.nullable(),
  credential: effectiveCredentialResponseSchema.nullable(),
  prompt: effectivePromptResponseSchema.nullable(),
  skills: z.array(effectiveSkillResponseSchema).max(50),
  tools: z.array(effectiveToolResponseSchema).max(100),
  toolPacks: z.array(effectiveToolPackResponseSchema).max(100),
  teams: z.array(agentTeamMembershipSummarySchema),
  runtimeProfile: effectiveRuntimeProfileResponseSchema.nullable(),
  readiness: agentReadinessResponseSchema
}).strict();

const meetingPresetPreflightAgentSchema = z.object({
  agentId: uuid,
  roleId: uuid,
  isChair: z.boolean(),
  agentRevision: positiveInteger.nullable(),
  readiness: agentReadinessResponseSchema
}).strict();

export const meetingPresetPreflightSchema = z.object({
  presetId: uuid,
  status: z.enum(["blocked", "warning", "ready"]),
  team: agentTeamResponseSchema.nullable(),
  invalidRoleIds: z.array(uuid).max(12),
  agents: z.array(meetingPresetPreflightAgentSchema).max(12)
}).strict();

export const apiErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().trim().min(1).max(120).regex(/^[A-Z][A-Z0-9_]*$/),
    message: nonEmpty(2_000)
  }).strict()
}).strict();

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema)
]));

const forbiddenEventDataKeys = new Set([
  "apikey",
  "bearertoken",
  "accesstoken",
  "refreshtoken",
  "password",
  "passwordhash",
  "privatekey",
  "secret",
  "encryptedsecret",
  "ciphertext",
  "tokenhash"
]);

function rejectSecretEventData(
  value: JsonValue,
  context: z.RefinementCtx,
  path: Array<string | number> = []
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecretEventData(item, context, [...path, index]));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
    if (forbiddenEventDataKeys.has(normalizedKey)) {
      context.addIssue({
        code: "custom",
        path: [...path, key],
        message: "Meeting event data cannot contain secret-bearing fields."
      });
      continue;
    }
    rejectSecretEventData(nested, context, [...path, key]);
  }
}

export const meetingSseEventDataSchema = z.record(z.string(), jsonValueSchema).superRefine((value, context) => {
  rejectSecretEventData(value, context);
});

export const meetingSseEventEnvelopeSchema = z.object({
  type: nonEmpty(120),
  meetingId: uuid,
  data: meetingSseEventDataSchema,
  occurredAt: timestamp
}).strict();

export const queuedJobAcceptanceSchema = z.object({
  jobId,
  replayed: z.boolean().optional()
}).strict();

export const toolRunAcceptanceSchema = queuedJobAcceptanceSchema.extend({
  status: z.enum(["succeeded", "failed"]).optional()
}).strict();

export type ApiErrorEnvelope = z.infer<typeof apiErrorEnvelopeSchema>;
export type PlatformSnapshotResponse = z.infer<typeof platformSnapshotSchema>;
export type PlatformSnapshotResponseInput = z.input<typeof platformSnapshotSchema>;
export type MeetingViewSnapshotResponse = z.infer<typeof meetingViewSnapshotSchema>;
export type AgentReadinessBatchRequest = z.infer<typeof agentReadinessBatchRequestSchema>;
export type AgentReadinessBatchResponse = z.infer<typeof agentReadinessBatchResponseSchema>;
export type EffectiveAgentConfigurationResponse = z.infer<typeof effectiveAgentConfigurationSchema>;
export type MeetingPresetPreflightResponse = z.infer<typeof meetingPresetPreflightSchema>;
export type MeetingSseEventEnvelope = z.infer<typeof meetingSseEventEnvelopeSchema>;
export type QueuedJobAcceptance = z.infer<typeof queuedJobAcceptanceSchema>;
export type HumanUtteranceResponse = z.infer<typeof humanUtteranceResponseSchema>;
export type SuggestedRoleResponse = z.infer<typeof suggestedRoleResponseSchema>;
export type TaskRunResponse = z.infer<typeof taskRunResponseSchema>;
export type TaskSyncResponse = z.infer<typeof taskSyncResponseSchema>;
export type ToolRunAcceptance = z.infer<typeof toolRunAcceptanceSchema>;
