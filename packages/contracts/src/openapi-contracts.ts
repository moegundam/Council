import { z } from "zod";
import {
  agentReadinessBatchRequestSchema,
  agentReadinessBatchResponseSchema,
  agentReadinessResponseSchema,
  agentRevisionListResponseSchema,
  effectiveAgentConfigurationSchema,
  credentialListResponseSchema,
  humanUtteranceResponseSchema,
  mcpConnectorUpdateResponseSchema,
  mcpDiscoveryResponseSchema,
  meetingRecordSchema,
  meetingUtterancePageResponseSchema,
  meetingViewSnapshotSchema,
  modelConnectorUpdateResponseSchema,
  platformSnapshotSchema,
  promptListResponseSchema,
  promptPreviewResponseSchema,
  promptTemplateResponseSchema,
  promptVersionListResponseSchema,
  queuedJobAcceptanceSchema,
  meetingPresetPreflightSchema,
  roleDeletionResponseSchema,
  roleLifecycleResponseSchema,
  roleResponseSchema,
  runtimeProfileListResponseSchema,
  runtimeProfileRevisionListResponseSchema,
  skillResponseSchema,
  skillRevocationResponseSchema,
  suggestedRoleResponseSchema,
  taskRunResponseSchema,
  taskSyncResponseSchema,
  toolPackListResponseSchema,
  toolPackRevisionListResponseSchema,
  toolRunAcceptanceSchema
} from "#api-contracts";
import {
  addTaskEvidenceSchema,
  actionAdapterListResponseSchema,
  actionAdapterSchema,
  advanceMeetingAgendaSchema,
  agentTeamSchema,
  applyChairSuggestedRoleSchema,
  archivePromptSchema,
  authorizeToolSchema,
  approveGoalRunSchema,
  approveToolPackSchema,
  createAgentSchema,
  createActionAdapterSchema,
  createAgentTeamSchema,
  createCategorySchema,
  createCredentialSchema,
  createDecisionSchema,
  createGoalRunSchema,
  createGroupSchema,
  createHumanUtteranceSchema,
  createMcpConnectorSchema,
  createMeetingSchema,
  createMeetingPresetSchema,
  createModelConnectorSchema,
  createPromptSchema,
  createRoleSchema,
  createRuntimeProfileSchema,
  createSkillSchema,
  createTagSchema,
  createTaskAdapterConnectorSchema,
  createTaskSchema,
  createThreadSchema,
  createToolPackSchema,
  credentialSchema,
  deleteRoleSchema,
  externalExecutionRequestSchema,
  externalExecutionSchema,
  executionContractSchema,
  goalCanvasLensSchema,
  goalCanvasSnapshotSchema,
  goalEventSchema,
  goalPlanRevisionSchema,
  goalRunControlSchema,
  goalRunMessageSchema,
  goalRunPlanUpdateSchema,
  goalRunSchema,
  goalTaskBindingSchema,
  meetingPresetSchema,
  moveTaskSchema,
  platformViewNames,
  promptPreviewRequestSchema,
  reviewerVerdictSchema,
  publishAgentSchema,
  publishPromptSchema,
  rollbackAgentSchema,
  rollbackPromptSchema,
  rollbackRoleSchema,
  rotateCredentialSchema,
  runAgentSchema,
  runMcpToolSchema,
  runTaskAgentSchema,
  revokeSkillSchema,
  setAgentModelRequestSchema,
  setAgentStatusSchema,
  setMeetingAgendaSchema,
  setMeetingAutomationSchema,
  setMeetingModeSchema,
  setSkillStatusSchema,
  setTaskApprovalSchema,
  taskSyncRequestSchema,
  actionRunSchema,
  switchParticipantRoleSchema,
  revokeToolPackSchema,
  runtimeProfileSchema,
  runtimeRunControlSchema,
  runtimeRunEventSchema,
  runtimeRunSchema,
  runtimeRunSteerSchema,
  toolPackSchema,
  updateAgentRequestSchema,
  updateAgentTeamSchema,
  updateCategorySchema,
  updateCredentialSchema,
  updateCredentialStatusSchema,
  updateGroupSchema,
  updateMeetingPresetSchema,
  updateMcpConnectorSchema,
  updateModelConnectorSchema,
  updatePromptSchema,
  updateRoleRequestSchema,
  updateRuntimeProfileSchema,
  updateTagSchema,
  updateTaskSchema,
  updateThreadSchema,
  updateToolPackSchema,
  validateSkillSchema,
  validateToolPackSchema
} from "#index";

export type ApiContractMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ApiContractSecurity = "public" | "session";

export interface ApiContractSchema {
  componentName: string;
  schema: z.ZodType;
}

export interface ApiContractRequestBody extends ApiContractSchema {
  required: boolean;
}

export interface ApiContractResponseWithContent extends ApiContractSchema {
  status: `${number}`;
  description: string;
  contentType?: "application/json" | "text/event-stream";
}

export interface ApiContractResponseWithoutContent {
  status: `${number}`;
  description: string;
}

export type ApiContractResponse = ApiContractResponseWithContent | ApiContractResponseWithoutContent;

export interface ApiContractParameter {
  name: string;
  in: "header" | "path" | "query";
  required: boolean;
  description: string;
  schema: z.ZodType;
}

export interface ApiContractCapability {
  method: ApiContractMethod;
  path: `/api/${string}`;
  operationId: string;
  tags: string[];
  summary: string;
  security: ApiContractSecurity;
  requestBody?: ApiContractRequestBody;
  parameters?: ApiContractParameter[];
  responses: ApiContractResponse[];
}

const idempotencyKeyParameter = (required: boolean): ApiContractParameter => ({
  name: "Idempotency-Key",
  in: "header",
  required,
  description: required
    ? "Stable caller key required to safely retry this operation."
    : "Optional stable caller key used to deduplicate retries.",
  schema: z.string().trim().min(1).max(200)
});

function body(componentName: string, schema: z.ZodType, required = true): ApiContractRequestBody {
  return { componentName, schema, required };
}

function response(
  status: number,
  componentName: string,
  schema: z.ZodType,
  description = "Successful response"
): ApiContractResponse {
  return { status: `${status}`, componentName, schema, description };
}

function emptyResponse(status: number, description: string): ApiContractResponseWithoutContent {
  return { status: `${status}`, description };
}

/** Returns the typed API capability registry from the core Zod contracts. */
export function createApiContractCapabilities(): ApiContractCapability[] {
  const snapshotShape = platformSnapshotSchema.in.shape;
  const groupResponseSchema = snapshotShape.groups.element;
  const categoryResponseSchema = snapshotShape.categories.element;
  const tagResponseSchema = snapshotShape.tags.element;
  const threadResponseSchema = snapshotShape.threads.element;
  const agentResponseSchema = snapshotShape.agents.element;
  const modelConnectorResponseSchema = snapshotShape.modelConnectors.element;
  const mcpConnectorResponseSchema = snapshotShape.mcpConnectors.element;
  const taskAdapterConnectorResponseSchema = snapshotShape.taskAdapterConnectors.element;
  const meetingResponseSchema = snapshotShape.meetings.element;
  const participantResponseSchema = snapshotShape.participants.element;
  const chairSuggestionResponseSchema = snapshotShape.chairSuggestions.element;
  const decisionResponseSchema = snapshotShape.decisions.element;
  const taskResponseSchema = snapshotShape.tasks.element;

  const healthLiveResponseSchema = z.object({ status: z.literal("ok") }).strict();
  const healthReadyResponseSchema = z.object({ status: z.literal("ready") }).strict();
  const connectorHealthResponseSchema = z.object({ healthy: z.boolean() }).strict();
  const toolAuthorizationResponseSchema = z.object({ allowed: z.literal(true) }).strict();
  const goalRunListResponseSchema = z.object({ goalRuns: z.array(goalRunSchema) }).strict();
  const goalRunDetailResponseSchema = z.object({
    goalRun: goalRunSchema,
    plans: z.array(goalPlanRevisionSchema),
    executionContract: executionContractSchema.nullable(),
    taskBindings: z.array(goalTaskBindingSchema),
    events: z.array(goalEventSchema),
    reviewerVerdicts: z.array(reviewerVerdictSchema),
    actionRuns: z.array(actionRunSchema),
    runtimeRuns: z.array(runtimeRunSchema)
  }).strict();
  const goalRunCreateResponseSchema = z.object({
    goalRun: goalRunSchema,
    meeting: meetingResponseSchema,
    jobId: z.string().trim().min(1).max(500)
  }).strict();
  const goalRunApprovalResponseSchema = goalRunDetailResponseSchema.extend({
    jobId: z.string().trim().min(1).max(500)
  }).strict();
  const runtimeRunEventsResponseSchema = z.object({ events: z.array(runtimeRunEventSchema) }).strict();
  const capabilities: ApiContractCapability[] = [
    {
      method: "GET", path: "/api/health/live", operationId: "getHealthLive", tags: ["health"],
      summary: "Report process liveness", security: "public",
      responses: [response(200, "HealthLiveResponse", healthLiveResponseSchema)]
    },
    {
      method: "GET", path: "/api/health/ready", operationId: "getHealthReady", tags: ["health"],
      summary: "Report dependency readiness", security: "public",
      responses: [response(200, "HealthReadyResponse", healthReadyResponseSchema)]
    },
    {
      method: "GET", path: "/api/bootstrap", operationId: "getBootstrap", tags: ["platform"],
      summary: "Load the normalized platform snapshot", security: "session",
      responses: [response(200, "PlatformSnapshotResponse", platformSnapshotSchema.in)]
    },
    {
      method: "GET", path: "/api/views/:view", operationId: "getPlatformView", tags: ["platform"],
      summary: "Load one normalized platform view", security: "session",
      parameters: [{
        name: "view",
        in: "path",
        required: true,
        description: "Bounded platform projection used by the main workspace views.",
        schema: z.enum(platformViewNames)
      }],
      responses: [
        response(200, "PlatformSnapshotResponse", platformSnapshotSchema.in),
        emptyResponse(304, "The requested projection has not changed.")
      ]
    },

    {
      method: "GET", path: "/api/goal-runs", operationId: "listGoalRuns", tags: ["goal-runs"],
      summary: "List Goal Runs", security: "session",
      responses: [response(200, "GoalRunListResponse", goalRunListResponseSchema)]
    },
    {
      method: "GET", path: "/api/action-adapters", operationId: "listActionAdapters", tags: ["action-adapters"],
      summary: "List Owner-approved Harness Action Adapters", security: "session",
      responses: [response(200, "ActionAdapterListResponse", actionAdapterListResponseSchema)]
    },
    {
      method: "POST", path: "/api/action-adapters", operationId: "createActionAdapter", tags: ["action-adapters"],
      summary: "Create an Owner-approved fixed Harness Action Adapter catalog", security: "session",
      requestBody: body("CreateActionAdapterRequest", createActionAdapterSchema),
      responses: [response(201, "ActionAdapterResponse", actionAdapterSchema)]
    },
    {
      method: "POST", path: "/api/goal-runs", operationId: "createGoalRun", tags: ["goal-runs"],
      summary: "Create a Goal Run and canonical Meeting", security: "session",
      requestBody: body("CreateGoalRunRequest", createGoalRunSchema),
      parameters: [idempotencyKeyParameter(true)],
      responses: [response(201, "GoalRunCreateResponse", goalRunCreateResponseSchema)]
    },
    {
      method: "GET", path: "/api/goal-runs/:id", operationId: "getGoalRun", tags: ["goal-runs"],
      summary: "Load a Goal Run with its immutable history", security: "session",
      responses: [response(200, "GoalRunDetailResponse", goalRunDetailResponseSchema)]
    },
    {
      method: "PUT", path: "/api/goal-runs/:id/plan", operationId: "reviseGoalRunPlan", tags: ["goal-runs"],
      summary: "Create a reviewable Goal Plan revision", security: "session",
      requestBody: body("GoalRunPlanUpdateRequest", goalRunPlanUpdateSchema),
      responses: [response(200, "GoalRunDetailResponse", goalRunDetailResponseSchema)]
    },
    {
      method: "POST", path: "/api/goal-runs/:id/approve", operationId: "approveGoalRun", tags: ["goal-runs"],
      summary: "Approve an immutable Execution Contract", security: "session",
      requestBody: body("ApproveGoalRunRequest", approveGoalRunSchema),
      responses: [response(200, "GoalRunApprovalResponse", goalRunApprovalResponseSchema)]
    },
    ...(["pause", "resume", "cancel"] as const).map((action): ApiContractCapability => ({
      method: "POST",
      path: `/api/goal-runs/:id/${action}`,
      operationId: `${action}GoalRun`,
      tags: ["goal-runs"],
      summary: `${action[0]!.toUpperCase()}${action.slice(1)} a Goal Run`,
      security: "session",
      requestBody: body("GoalRunControlRequest", goalRunControlSchema),
      responses: [response(200, "GoalRunResponse", goalRunSchema)]
    })),
    {
      method: "POST", path: "/api/goal-runs/:id/messages", operationId: "addGoalRunMessage", tags: ["goal-runs"],
      summary: "Add an attributable Owner instruction", security: "session",
      requestBody: body("GoalRunMessageRequest", goalRunMessageSchema),
      responses: [response(201, "GoalEventResponse", goalEventSchema)]
    },
    {
      method: "GET", path: "/api/goal-runs/:id/canvas", operationId: "getGoalRunCanvas", tags: ["goal-runs"],
      summary: "Project the Goal Run state canvas", security: "session",
      parameters: [{
        name: "lens", in: "query", required: false,
        description: "Read-only Goal Canvas projection lens.", schema: goalCanvasLensSchema
      }],
      responses: [response(200, "GoalCanvasSnapshotResponse", goalCanvasSnapshotSchema)]
    },
    {
      method: "GET", path: "/api/goal-runs/:id/events", operationId: "streamGoalRunEvents", tags: ["goal-runs"],
      summary: "Replay and stream durable Goal events", security: "session",
      parameters: [{
        name: "Last-Event-ID", in: "header", required: false,
        description: "Last durable Goal event sequence received by the client.",
        schema: z.string().regex(/^\d+$/)
      }],
      responses: [{
        ...response(200, "GoalEventStreamResponse", z.string().describe("Server-sent Goal event stream."), "Goal event stream"),
        contentType: "text/event-stream"
      }]
    },
    {
      method: "GET", path: "/api/runtime-runs/by-task/:taskId", operationId: "getTaskRuntimeRun", tags: ["runtime-runs"],
      summary: "Load the latest durable Runtime Run for one Task", security: "session",
      responses: [response(200, "RuntimeRunResponse", runtimeRunSchema)]
    },
    {
      method: "GET", path: "/api/runtime-runs/:id", operationId: "getRuntimeRun", tags: ["runtime-runs"],
      summary: "Load one durable Runtime Run", security: "session",
      responses: [response(200, "RuntimeRunResponse", runtimeRunSchema)]
    },
    {
      method: "GET", path: "/api/runtime-runs/:id/events", operationId: "listRuntimeRunEvents", tags: ["runtime-runs"],
      summary: "Page standardized Runtime Run events", security: "session",
      parameters: [
        {
          name: "afterSequence", in: "query", required: false,
          description: "Return events after this per-run sequence.", schema: z.number().int().nonnegative()
        },
        {
          name: "limit", in: "query", required: false,
          description: "Maximum number of Runtime events to return.", schema: z.number().int().min(1).max(500)
        }
      ],
      responses: [response(200, "RuntimeRunEventsResponse", runtimeRunEventsResponseSchema)]
    },
    {
      method: "POST", path: "/api/runtime-runs/:id/steer", operationId: "steerRuntimeRun", tags: ["runtime-runs"],
      summary: "Guide an active OMP Session", security: "session",
      requestBody: body("RuntimeRunSteerRequest", runtimeRunSteerSchema),
      responses: [response(200, "RuntimeRunResponse", runtimeRunSchema)]
    },
    ...(["pause", "resume", "cancel"] as const).map((action): ApiContractCapability => ({
      method: "POST",
      path: `/api/runtime-runs/:id/${action}`,
      operationId: `${action}RuntimeRun`,
      tags: ["runtime-runs"],
      summary: `${action[0]!.toUpperCase()}${action.slice(1)} an OMP Runtime Run`,
      security: "session",
      requestBody: body("RuntimeRunControlRequest", runtimeRunControlSchema),
      responses: [response(200, "RuntimeRunResponse", runtimeRunSchema)]
    })),

    {
      method: "POST", path: "/api/groups", operationId: "createGroup", tags: ["taxonomy"],
      summary: "Create a discussion group", security: "session", requestBody: body("CreateGroupRequest", createGroupSchema),
      parameters: [idempotencyKeyParameter(true)], responses: [response(201, "GroupResponse", groupResponseSchema)]
    },
    {
      method: "PATCH", path: "/api/groups/:id", operationId: "updateGroup", tags: ["taxonomy"],
      summary: "Update a discussion group", security: "session", requestBody: body("UpdateGroupRequest", updateGroupSchema),
      responses: [response(200, "GroupResponse", groupResponseSchema)]
    },
    {
      method: "POST", path: "/api/categories", operationId: "createCategory", tags: ["taxonomy"],
      summary: "Create a discussion category", security: "session", requestBody: body("CreateCategoryRequest", createCategorySchema),
      parameters: [idempotencyKeyParameter(true)], responses: [response(201, "CategoryResponse", categoryResponseSchema)]
    },
    {
      method: "PATCH", path: "/api/categories/:id", operationId: "updateCategory", tags: ["taxonomy"],
      summary: "Update a discussion category", security: "session", requestBody: body("UpdateCategoryRequest", updateCategorySchema),
      responses: [response(200, "CategoryResponse", categoryResponseSchema)]
    },
    {
      method: "POST", path: "/api/tags", operationId: "createTag", tags: ["taxonomy"],
      summary: "Create a discussion tag", security: "session", requestBody: body("CreateTagRequest", createTagSchema),
      parameters: [idempotencyKeyParameter(true)], responses: [response(201, "TagResponse", tagResponseSchema)]
    },
    {
      method: "PATCH", path: "/api/tags/:id", operationId: "updateTag", tags: ["taxonomy"],
      summary: "Update a discussion tag", security: "session", requestBody: body("UpdateTagRequest", updateTagSchema),
      responses: [response(200, "TagResponse", tagResponseSchema)]
    },
    {
      method: "POST", path: "/api/threads", operationId: "createThread", tags: ["discussions"],
      summary: "Create a discussion topic", security: "session", requestBody: body("CreateThreadRequest", createThreadSchema),
      parameters: [idempotencyKeyParameter(true)], responses: [response(201, "ThreadResponse", threadResponseSchema)]
    },
    {
      method: "PATCH", path: "/api/threads/:id", operationId: "updateThread", tags: ["discussions"],
      summary: "Update a discussion topic", security: "session", requestBody: body("UpdateThreadRequest", updateThreadSchema),
      responses: [response(200, "ThreadResponse", threadResponseSchema)]
    },

    {
      method: "POST", path: "/api/agents", operationId: "createAgent", tags: ["agents"],
      summary: "Create an Agent draft", security: "session", requestBody: body("CreateAgentRequest", createAgentSchema),
      parameters: [idempotencyKeyParameter(true)], responses: [response(201, "AgentResponse", agentResponseSchema)]
    },
    {
      method: "PATCH", path: "/api/agents/:id", operationId: "updateAgent", tags: ["agents"],
      summary: "Update an Agent draft", security: "session", requestBody: body("UpdateAgentRequest", updateAgentRequestSchema),
      responses: [response(200, "AgentResponse", agentResponseSchema)]
    },
    {
      method: "PATCH", path: "/api/agents/:id/model", operationId: "setAgentModel", tags: ["agents"],
      summary: "Assign an Agent model connector", security: "session", requestBody: body("SetAgentModelRequest", setAgentModelRequestSchema),
      responses: [response(200, "AgentResponse", agentResponseSchema)]
    },
    {
      method: "GET", path: "/api/agents/:id/readiness", operationId: "getAgentReadiness", tags: ["agents"],
      summary: "Evaluate Agent publication readiness", security: "session",
      responses: [response(200, "AgentReadinessResponse", agentReadinessResponseSchema)]
    },
    {
      method: "POST", path: "/api/agents/readiness:batch", operationId: "getPublishedAgentReadinessBatch", tags: ["agents"],
      summary: "Evaluate published Agent readiness in a bounded batch", security: "session",
      requestBody: body("AgentReadinessBatchRequest", agentReadinessBatchRequestSchema),
      responses: [response(200, "AgentReadinessBatchResponse", agentReadinessBatchResponseSchema)]
    },
    {
      method: "GET", path: "/api/agents/:id/effective-configuration", operationId: "getAgentEffectiveConfiguration", tags: ["agents"],
      summary: "Load an Agent's effective configuration", security: "session",
      responses: [response(200, "EffectiveAgentConfigurationResponse", effectiveAgentConfigurationSchema)]
    },
    {
      method: "GET", path: "/api/agents/:id/revisions", operationId: "listAgentRevisions", tags: ["agents"],
      summary: "List Agent revisions", security: "session",
      responses: [response(200, "AgentRevisionListResponse", agentRevisionListResponseSchema)]
    },
    {
      method: "POST", path: "/api/agents/:id/publish", operationId: "publishAgent", tags: ["agents"],
      summary: "Publish an Agent revision", security: "session", requestBody: body("PublishAgentRequest", publishAgentSchema),
      responses: [response(200, "AgentResponse", agentResponseSchema)]
    },
    {
      method: "POST", path: "/api/agents/:id/rollback", operationId: "rollbackAgent", tags: ["agents"],
      summary: "Restore a prior Agent revision", security: "session", requestBody: body("RollbackAgentRequest", rollbackAgentSchema),
      responses: [response(200, "AgentResponse", agentResponseSchema)]
    },
    {
      method: "PATCH", path: "/api/agents/:id/status", operationId: "setAgentStatus", tags: ["agents"],
      summary: "Change Agent lifecycle status", security: "session", requestBody: body("SetAgentStatusRequest", setAgentStatusSchema),
      responses: [response(200, "AgentResponse", agentResponseSchema)]
    },

    {
      method: "POST", path: "/api/skills", operationId: "createSkill", tags: ["skills"],
      summary: "Create a Skill", security: "session", requestBody: body("CreateSkillRequest", createSkillSchema),
      parameters: [idempotencyKeyParameter(true)], responses: [response(201, "SkillResponse", skillResponseSchema)]
    },
    {
      method: "PATCH", path: "/api/skills/:id/status", operationId: "setSkillStatus", tags: ["skills"],
      summary: "Change Skill lifecycle status", security: "session", requestBody: body("SetSkillStatusRequest", setSkillStatusSchema),
      responses: [response(200, "SkillResponse", skillResponseSchema)]
    },
    {
      method: "POST", path: "/api/skills/:id/validation", operationId: "validateSkill", tags: ["skills"],
      summary: "Record Skill validation", security: "session", requestBody: body("ValidateSkillRequest", validateSkillSchema),
      responses: [response(200, "SkillResponse", skillResponseSchema)]
    },
    {
      method: "POST", path: "/api/skills/:id/revoke", operationId: "revokeSkill", tags: ["skills"],
      summary: "Revoke a Skill", security: "session", requestBody: body("RevokeSkillRequest", revokeSkillSchema),
      parameters: [idempotencyKeyParameter(true)],
      responses: [response(200, "SkillRevocationResponse", skillRevocationResponseSchema)]
    },

    {
      method: "POST", path: "/api/roles", operationId: "createRole", tags: ["roles"],
      summary: "Create an Agent role", security: "session", requestBody: body("CreateRoleRequest", createRoleSchema),
      parameters: [idempotencyKeyParameter(true)], responses: [response(201, "RoleResponse", roleResponseSchema)]
    },
    {
      method: "GET", path: "/api/roles/:id/lifecycle", operationId: "getRoleLifecycle", tags: ["roles"],
      summary: "Inspect Role lifecycle and version history", security: "session",
      responses: [response(200, "RoleLifecycleResponse", roleLifecycleResponseSchema)]
    },
    {
      method: "PATCH", path: "/api/roles/:id", operationId: "updateRole", tags: ["roles"],
      summary: "Update an Agent role", security: "session", requestBody: body("UpdateRoleRequest", updateRoleRequestSchema),
      responses: [response(200, "RoleResponse", roleResponseSchema)]
    },
    {
      method: "POST", path: "/api/roles/:id/rollback", operationId: "rollbackRole", tags: ["roles"],
      summary: "Restore a prior Role version", security: "session", requestBody: body("RollbackRoleRequest", rollbackRoleSchema),
      responses: [response(200, "RoleResponse", roleResponseSchema)]
    },
    {
      method: "DELETE", path: "/api/roles/:id", operationId: "deleteRole", tags: ["roles"],
      summary: "Tombstone an unused Role", security: "session", requestBody: body("DeleteRoleRequest", deleteRoleSchema),
      parameters: [idempotencyKeyParameter(true)],
      responses: [response(200, "RoleDeletionResponse", roleDeletionResponseSchema)]
    },

    {
      method: "GET", path: "/api/meetings/:id/view", operationId: "getMeetingView", tags: ["meetings"],
      summary: "Load one Meeting's bounded live state", security: "session",
      responses: [
        response(200, "MeetingViewResponse", meetingViewSnapshotSchema.in),
        emptyResponse(304, "The requested Meeting view has not changed.")
      ]
    },
    {
      method: "GET", path: "/api/meetings/:id/record", operationId: "getMeetingRecord", tags: ["meetings"],
      summary: "Load the latest immutable Meeting Record", security: "session",
      responses: [response(200, "MeetingRecordResponse", meetingRecordSchema)]
    },
    {
      method: "GET", path: "/api/meetings/:id/utterances", operationId: "listMeetingUtterances", tags: ["meetings"],
      summary: "Load one bounded Meeting transcript page", security: "session",
      parameters: [
        {
          name: "cursor", in: "query", required: false,
          description: "Opaque cursor returned by the previous transcript page.",
          schema: z.string().trim().min(8).max(2_048)
        },
        {
          name: "limit", in: "query", required: false,
          description: "Maximum utterances returned in one page.",
          schema: z.coerce.number().int().min(1).max(100).default(100)
        }
      ],
      responses: [response(200, "MeetingUtterancePageResponse", meetingUtterancePageResponseSchema)]
    },
    {
      method: "GET", path: "/api/meetings/:id/events", operationId: "streamMeetingEvents", tags: ["meetings"],
      summary: "Stream Meeting events", security: "session",
      responses: [{
        ...response(
          200,
          "MeetingEventStreamResponse",
          z.string().describe("Server-sent event stream carrying Meeting event envelopes."),
          "Meeting event stream"
        ),
        contentType: "text/event-stream"
      }]
    },
    {
      method: "POST", path: "/api/meetings", operationId: "createMeeting", tags: ["meetings"],
      summary: "Create a Meeting from an open Topic", security: "session", requestBody: body("CreateMeetingRequest", createMeetingSchema),
      parameters: [idempotencyKeyParameter(true)], responses: [response(201, "MeetingResponse", meetingResponseSchema)]
    },
    {
      method: "PATCH", path: "/api/meetings/:id/agenda", operationId: "setMeetingAgenda", tags: ["meetings"],
      summary: "Replace a draft Meeting agenda", security: "session", requestBody: body("SetMeetingAgendaRequest", setMeetingAgendaSchema),
      responses: [response(200, "MeetingResponse", meetingResponseSchema)]
    },
    {
      method: "POST", path: "/api/meetings/:id/agenda/advance", operationId: "advanceMeetingAgenda", tags: ["meetings"],
      summary: "Advance the active agenda item", security: "session", requestBody: body("AdvanceMeetingAgendaRequest", advanceMeetingAgendaSchema),
      responses: [response(200, "MeetingResponse", meetingResponseSchema)]
    },
    ...(["start", "pause", "resume", "close"] as const).map((action): ApiContractCapability => ({
      method: "POST",
      path: `/api/meetings/:id/${action}`,
      operationId: `${action}Meeting`,
      tags: ["meetings"],
      summary: `${action[0]!.toUpperCase()}${action.slice(1)} a Meeting`,
      security: "session",
      responses: [response(200, "MeetingResponse", meetingResponseSchema)]
    })),
    {
      method: "POST", path: "/api/meetings/:id/summary/retry", operationId: "retryMeetingSummary", tags: ["meetings"],
      summary: "Retry Meeting summary generation", security: "session",
      responses: [
        response(200, "MeetingResponse", meetingResponseSchema),
        response(202, "MeetingResponse", meetingResponseSchema)
      ]
    },
    {
      method: "POST", path: "/api/meetings/:id/utterances", operationId: "createMeetingUtterance", tags: ["meetings"],
      summary: "Add an owner utterance to an active Meeting", security: "session",
      requestBody: body("CreateHumanUtteranceRequest", createHumanUtteranceSchema),
      parameters: [idempotencyKeyParameter(true)],
      responses: [response(201, "HumanUtteranceResponse", humanUtteranceResponseSchema)]
    },
    {
      method: "PATCH", path: "/api/meetings/:id/automation", operationId: "setMeetingAutomation", tags: ["meetings"],
      summary: "Change Chair automation level", security: "session",
      requestBody: body("SetMeetingAutomationRequest", setMeetingAutomationSchema),
      responses: [response(200, "MeetingResponse", meetingResponseSchema)]
    },
    {
      method: "POST", path: "/api/meetings/:id/mode", operationId: "setMeetingMode", tags: ["meetings"],
      summary: "Change Meeting facilitation mode", security: "session", requestBody: body("SetMeetingModeRequest", setMeetingModeSchema),
      responses: [response(200, "MeetingResponse", meetingResponseSchema)]
    },
    {
      method: "PATCH", path: "/api/meetings/:meetingId/participants/:participantId/role", operationId: "switchMeetingParticipantRole", tags: ["meetings"],
      summary: "Switch a participant's active Role", security: "session",
      requestBody: body("SwitchParticipantRoleRequest", switchParticipantRoleSchema),
      responses: [response(200, "ParticipantResponse", participantResponseSchema)]
    },
    {
      method: "POST", path: "/api/meetings/:meetingId/chair-suggestions/:suggestionId/role", operationId: "applyChairSuggestedRole", tags: ["meetings"],
      summary: "Apply a Chair Role switch suggestion", security: "session",
      requestBody: body("ApplyChairSuggestedRoleRequest", applyChairSuggestedRoleSchema),
      responses: [response(200, "SuggestedRoleResponse", suggestedRoleResponseSchema)]
    },
    {
      method: "POST", path: "/api/meetings/:id/run", operationId: "runMeetingAgent", tags: ["meetings"],
      summary: "Queue an assigned Agent turn", security: "session", requestBody: body("RunMeetingAgentRequest", runAgentSchema),
      parameters: [idempotencyKeyParameter(true)],
      responses: [response(202, "QueuedJobAcceptanceResponse", queuedJobAcceptanceSchema)]
    },
    {
      method: "POST", path: "/api/meetings/:id/chair-suggestions/:suggestionId/dismiss", operationId: "dismissChairSuggestion", tags: ["meetings"],
      summary: "Dismiss an open Chair suggestion", security: "session",
      responses: [response(200, "ChairSuggestionResponse", chairSuggestionResponseSchema)]
    },
    {
      method: "POST", path: "/api/meetings/:id/tools/run", operationId: "runMeetingTool", tags: ["meetings"],
      summary: "Queue an approved read-only MCP tool call", security: "session",
      requestBody: body("RunMeetingToolRequest", runMcpToolSchema), parameters: [idempotencyKeyParameter(true)],
      responses: [
        response(200, "ToolRunAcceptanceResponse", toolRunAcceptanceSchema),
        response(202, "ToolRunAcceptanceResponse", toolRunAcceptanceSchema)
      ]
    },

    {
      method: "POST", path: "/api/decisions", operationId: "createDecision", tags: ["decisions"],
      summary: "Propose a Meeting decision", security: "session", requestBody: body("CreateDecisionRequest", createDecisionSchema),
      parameters: [idempotencyKeyParameter(true)], responses: [response(201, "DecisionResponse", decisionResponseSchema)]
    },
    ...(["approve", "reject"] as const).map((action): ApiContractCapability => ({
      method: "POST",
      path: `/api/decisions/:id/${action}`,
      operationId: `${action}Decision`,
      tags: ["decisions"],
      summary: `${action[0]!.toUpperCase()}${action.slice(1)} a proposed Decision`,
      security: "session",
      responses: [response(200, "DecisionResponse", decisionResponseSchema)]
    })),

    {
      method: "POST", path: "/api/tasks", operationId: "createTask", tags: ["tasks"],
      summary: "Create a Task from an approved Decision", security: "session", requestBody: body("CreateTaskRequest", createTaskSchema),
      parameters: [idempotencyKeyParameter(true)], responses: [response(201, "TaskResponse", taskResponseSchema)]
    },
    {
      method: "GET", path: "/api/tasks/:id", operationId: "getTask", tags: ["tasks"],
      summary: "Get one Task", security: "session", responses: [response(200, "TaskResponse", taskResponseSchema)]
    },
    {
      method: "PATCH", path: "/api/tasks/:id", operationId: "updateTask", tags: ["tasks"],
      summary: "Update Task execution settings", security: "session", requestBody: body("UpdateTaskRequest", updateTaskSchema),
      responses: [response(200, "TaskResponse", taskResponseSchema)]
    },
    {
      method: "POST", path: "/api/tasks/:id/approval", operationId: "setTaskApproval", tags: ["tasks"],
      summary: "Change Task approval state", security: "session", requestBody: body("SetTaskApprovalRequest", setTaskApprovalSchema),
      responses: [response(200, "TaskResponse", taskResponseSchema)]
    },
    {
      method: "POST", path: "/api/tasks/:id/run", operationId: "runTaskAgent", tags: ["tasks"],
      summary: "Queue the assigned Task Agent", security: "session", requestBody: body("RunTaskAgentRequest", runTaskAgentSchema),
      parameters: [idempotencyKeyParameter(true)],
      responses: [
        response(200, "TaskRunResponse", taskRunResponseSchema),
        response(202, "TaskRunResponse", taskRunResponseSchema)
      ]
    },
    {
      method: "POST", path: "/api/tasks/:id/evidence", operationId: "addTaskEvidence", tags: ["tasks"],
      summary: "Add Task evidence", security: "session", requestBody: body("AddTaskEvidenceRequest", addTaskEvidenceSchema),
      parameters: [idempotencyKeyParameter(true)], responses: [response(201, "TaskResponse", taskResponseSchema)]
    },
    {
      method: "PATCH", path: "/api/tasks/:id/status", operationId: "moveTask", tags: ["tasks"],
      summary: "Move a Task on the fixed workflow board", security: "session", requestBody: body("MoveTaskRequest", moveTaskSchema),
      responses: [response(200, "TaskResponse", taskResponseSchema)]
    },
    {
      method: "POST", path: "/api/tasks/:id/sync", operationId: "syncTask", tags: ["tasks"],
      summary: "Queue Task synchronization", security: "session", requestBody: body("SyncTaskRequest", taskSyncRequestSchema),
      responses: [response(202, "TaskSyncResponse", taskSyncResponseSchema)]
    },

    {
      method: "POST", path: "/api/model-connectors", operationId: "createModelConnector", tags: ["model-connectors"],
      summary: "Create a cloud or local model connector", security: "session",
      requestBody: body("CreateModelConnectorRequest", createModelConnectorSchema),
      parameters: [idempotencyKeyParameter(true)],
      responses: [response(201, "ModelConnectorResponse", modelConnectorResponseSchema)]
    },
    {
      method: "PATCH", path: "/api/model-connectors/:id", operationId: "updateModelConnector", tags: ["model-connectors"],
      summary: "Update a model connector", security: "session",
      requestBody: body("UpdateModelConnectorRequest", updateModelConnectorSchema),
      responses: [response(200, "ModelConnectorUpdateResponse", modelConnectorUpdateResponseSchema)]
    },
    {
      method: "POST", path: "/api/model-connectors/:id/health", operationId: "checkModelConnectorHealth", tags: ["model-connectors"],
      summary: "Check model connector health", security: "session",
      responses: [response(200, "ConnectorHealthResponse", connectorHealthResponseSchema)]
    },
    {
      method: "POST", path: "/api/mcp-connectors", operationId: "createMcpConnector", tags: ["mcp-connectors"],
      summary: "Create an approved read-only MCP connector", security: "session",
      requestBody: body("CreateMcpConnectorRequest", createMcpConnectorSchema),
      parameters: [idempotencyKeyParameter(true)],
      responses: [response(201, "McpConnectorResponse", mcpConnectorResponseSchema)]
    },
    {
      method: "PATCH", path: "/api/mcp-connectors/:id", operationId: "updateMcpConnector", tags: ["mcp-connectors"],
      summary: "Update an MCP connector and its allowlist", security: "session",
      requestBody: body("UpdateMcpConnectorRequest", updateMcpConnectorSchema),
      responses: [response(200, "McpConnectorUpdateResponse", mcpConnectorUpdateResponseSchema)]
    },
    {
      method: "POST", path: "/api/mcp-connectors/:id/discover", operationId: "discoverMcpTools", tags: ["mcp-connectors"],
      summary: "Discover tools exposed by an MCP connector", security: "session",
      responses: [response(200, "McpDiscoveryResponse", mcpDiscoveryResponseSchema)]
    },
    {
      method: "POST", path: "/api/task-adapter-connectors", operationId: "createTaskAdapterConnector", tags: ["task-adapter-connectors"],
      summary: "Create a Task Adapter connector", security: "session",
      requestBody: body("CreateTaskAdapterConnectorRequest", createTaskAdapterConnectorSchema),
      parameters: [idempotencyKeyParameter(true)],
      responses: [response(201, "TaskAdapterConnectorResponse", taskAdapterConnectorResponseSchema)]
    },
    {
      method: "POST", path: "/api/task-adapter-connectors/:id/health", operationId: "checkTaskAdapterConnectorHealth", tags: ["task-adapter-connectors"],
      summary: "Check Task Adapter connector health", security: "session",
      responses: [response(200, "ConnectorHealthResponse", connectorHealthResponseSchema)]
    },
    {
      method: "POST", path: "/api/tools/authorize", operationId: "authorizeTool", tags: ["tools"],
      summary: "Authorize a Tool", security: "session",
      requestBody: body("AuthorizeToolRequest", authorizeToolSchema),
      responses: [response(200, "ToolAuthorizationResponse", toolAuthorizationResponseSchema)]
    },
    {
      method: "POST", path: "/api/executions/harness", operationId: "startHarnessExecution", tags: ["executions"],
      summary: "Start an allowlisted external execution", security: "session",
      parameters: [idempotencyKeyParameter(true)],
      requestBody: body("StartHarnessExecutionRequest", externalExecutionRequestSchema),
      responses: [response(202, "ExternalExecutionResponse", externalExecutionSchema, "Execution accepted or replayed")]
    },

    {
      method: "GET", path: "/api/tool-packs", operationId: "listToolPacks", tags: ["tool-packs"],
      summary: "List Tool Packs", security: "session",
      responses: [response(200, "ToolPackListResponse", toolPackListResponseSchema)]
    },
    {
      method: "POST", path: "/api/tool-packs", operationId: "createToolPack", tags: ["tool-packs"],
      summary: "Create a Tool Pack", security: "session", parameters: [idempotencyKeyParameter(true)],
      requestBody: body("CreateToolPackRequest", createToolPackSchema),
      responses: [response(201, "ToolPackResponse", toolPackSchema)]
    },
    {
      method: "PATCH", path: "/api/tool-packs/:id", operationId: "updateToolPack", tags: ["tool-packs"],
      summary: "Update a Tool Pack", security: "session",
      requestBody: body("UpdateToolPackRequest", updateToolPackSchema),
      responses: [response(200, "ToolPackResponse", toolPackSchema)]
    },
    {
      method: "GET", path: "/api/tool-packs/:id/revisions", operationId: "listToolPackRevisions", tags: ["tool-packs"],
      summary: "List Tool Pack revisions", security: "session",
      responses: [response(200, "ToolPackRevisionListResponse", toolPackRevisionListResponseSchema)]
    },
    {
      method: "POST", path: "/api/tool-packs/:id/validate", operationId: "validateToolPack", tags: ["tool-packs"],
      summary: "Validate a Tool Pack revision", security: "session",
      requestBody: body("ValidateToolPackRequest", validateToolPackSchema),
      responses: [response(200, "ToolPackResponse", toolPackSchema)]
    },
    {
      method: "POST", path: "/api/tool-packs/:id/approve", operationId: "approveToolPack", tags: ["tool-packs"],
      summary: "Approve a Tool Pack revision", security: "session",
      requestBody: body("ApproveToolPackRequest", approveToolPackSchema),
      responses: [response(200, "ToolPackResponse", toolPackSchema)]
    },
    {
      method: "POST", path: "/api/tool-packs/:id/revoke", operationId: "revokeToolPack", tags: ["tool-packs"],
      summary: "Revoke a Tool Pack", security: "session",
      requestBody: body("RevokeToolPackRequest", revokeToolPackSchema),
      responses: [response(200, "ToolPackResponse", toolPackSchema)]
    },

    {
      method: "GET", path: "/api/runtime-profiles", operationId: "listRuntimeProfiles", tags: ["runtime-profiles"],
      summary: "List Runtime Profiles", security: "session",
      responses: [response(200, "RuntimeProfileListResponse", runtimeProfileListResponseSchema)]
    },
    {
      method: "POST", path: "/api/runtime-profiles", operationId: "createRuntimeProfile", tags: ["runtime-profiles"],
      summary: "Create a Runtime Profile", security: "session", parameters: [idempotencyKeyParameter(true)],
      requestBody: body("CreateRuntimeProfileRequest", createRuntimeProfileSchema),
      responses: [response(201, "RuntimeProfileResponse", runtimeProfileSchema)]
    },
    {
      method: "PATCH", path: "/api/runtime-profiles/:id", operationId: "updateRuntimeProfile", tags: ["runtime-profiles"],
      summary: "Update a Runtime Profile", security: "session",
      requestBody: body("UpdateRuntimeProfileRequest", updateRuntimeProfileSchema),
      responses: [response(200, "RuntimeProfileResponse", runtimeProfileSchema)]
    },
    {
      method: "GET", path: "/api/runtime-profiles/:id/revisions", operationId: "listRuntimeProfileRevisions", tags: ["runtime-profiles"],
      summary: "List Runtime Profile revisions", security: "session",
      responses: [response(200, "RuntimeProfileRevisionListResponse", runtimeProfileRevisionListResponseSchema)]
    },

    {
      method: "POST", path: "/api/agent-teams", operationId: "createAgentTeam", tags: ["agent-teams"],
      summary: "Create an Agent Team", security: "session",
      parameters: [idempotencyKeyParameter(true)],
      requestBody: body("CreateAgentTeamRequest", createAgentTeamSchema),
      responses: [response(201, "AgentTeamResponse", agentTeamSchema)]
    },
    {
      method: "PATCH", path: "/api/agent-teams/:id", operationId: "updateAgentTeam", tags: ["agent-teams"],
      summary: "Update an Agent Team", security: "session",
      requestBody: body("UpdateAgentTeamRequest", updateAgentTeamSchema),
      responses: [response(200, "AgentTeamResponse", agentTeamSchema)]
    },

    {
      method: "POST", path: "/api/meeting-presets", operationId: "createMeetingPreset", tags: ["meeting-presets"],
      summary: "Create a Meeting Preset", security: "session",
      parameters: [idempotencyKeyParameter(true)],
      requestBody: body("CreateMeetingPresetRequest", createMeetingPresetSchema),
      responses: [response(201, "MeetingPresetResponse", meetingPresetSchema)]
    },
    {
      method: "PATCH", path: "/api/meeting-presets/:id", operationId: "updateMeetingPreset", tags: ["meeting-presets"],
      summary: "Update a Meeting Preset", security: "session",
      requestBody: body("UpdateMeetingPresetRequest", updateMeetingPresetSchema),
      responses: [response(200, "MeetingPresetResponse", meetingPresetSchema)]
    },
    {
      method: "GET", path: "/api/meeting-presets/:id/preflight", operationId: "getMeetingPresetPreflight", tags: ["meeting-presets"],
      summary: "Run Meeting Preset preflight checks", security: "session",
      responses: [response(200, "MeetingPresetPreflightResponse", meetingPresetPreflightSchema)]
    },

    {
      method: "GET", path: "/api/credentials", operationId: "listCredentials", tags: ["credentials"],
      summary: "List credential metadata", security: "session",
      responses: [response(200, "CredentialListResponse", credentialListResponseSchema)]
    },
    {
      method: "POST", path: "/api/credentials", operationId: "createCredential", tags: ["credentials"],
      summary: "Create credential metadata and optional secret", security: "session",
      requestBody: body("CreateCredentialRequest", createCredentialSchema),
      parameters: [idempotencyKeyParameter(true)],
      responses: [response(201, "CredentialResponse", credentialSchema)]
    },
    {
      method: "PATCH", path: "/api/credentials/:id", operationId: "updateCredential", tags: ["credentials"],
      summary: "Update credential metadata", security: "session",
      requestBody: body("UpdateCredentialRequest", updateCredentialSchema),
      responses: [response(200, "CredentialResponse", credentialSchema)]
    },
    {
      method: "POST", path: "/api/credentials/:id/rotate", operationId: "rotateCredential", tags: ["credentials"],
      summary: "Rotate a credential secret", security: "session",
      requestBody: body("RotateCredentialRequest", rotateCredentialSchema),
      parameters: [idempotencyKeyParameter(true)],
      responses: [response(200, "CredentialResponse", credentialSchema)]
    },
    {
      method: "PATCH", path: "/api/credentials/:id/status", operationId: "setCredentialStatus", tags: ["credentials"],
      summary: "Change credential lifecycle status", security: "session",
      requestBody: body("SetCredentialStatusRequest", updateCredentialStatusSchema),
      parameters: [idempotencyKeyParameter(true)],
      responses: [response(200, "CredentialResponse", credentialSchema)]
    },

    {
      method: "GET", path: "/api/prompts", operationId: "listPrompts", tags: ["prompts"],
      summary: "List Prompt templates", security: "session",
      responses: [response(200, "PromptListResponse", promptListResponseSchema)]
    },
    {
      method: "POST", path: "/api/prompts", operationId: "createPrompt", tags: ["prompts"],
      summary: "Create a versioned Prompt", security: "session", requestBody: body("CreatePromptRequest", createPromptSchema),
      parameters: [idempotencyKeyParameter(true)],
      responses: [response(201, "PromptResponse", promptTemplateResponseSchema)]
    },
    {
      method: "PATCH", path: "/api/prompts/:id", operationId: "updatePrompt", tags: ["prompts"],
      summary: "Create the next Prompt revision", security: "session", requestBody: body("UpdatePromptRequest", updatePromptSchema),
      responses: [response(200, "PromptResponse", promptTemplateResponseSchema)]
    },
    {
      method: "GET", path: "/api/prompts/:id/versions", operationId: "listPromptVersions", tags: ["prompts"],
      summary: "List Prompt versions", security: "session",
      responses: [response(200, "PromptVersionListResponse", promptVersionListResponseSchema)]
    },
    {
      method: "POST", path: "/api/prompts/:id/publish", operationId: "publishPrompt", tags: ["prompts"],
      summary: "Publish a Prompt version", security: "session", requestBody: body("PublishPromptRequest", publishPromptSchema),
      responses: [response(200, "PromptResponse", promptTemplateResponseSchema)]
    },
    {
      method: "POST", path: "/api/prompts/:id/rollback", operationId: "rollbackPrompt", tags: ["prompts"],
      summary: "Restore a prior Prompt version", security: "session", requestBody: body("RollbackPromptRequest", rollbackPromptSchema),
      responses: [response(200, "PromptResponse", promptTemplateResponseSchema)]
    },
    {
      method: "POST", path: "/api/prompts/:id/archive", operationId: "archivePrompt", tags: ["prompts"],
      summary: "Archive a Prompt", security: "session", requestBody: body("ArchivePromptRequest", archivePromptSchema),
      responses: [response(200, "PromptResponse", promptTemplateResponseSchema)]
    },
    {
      method: "POST", path: "/api/prompts/:id/preview", operationId: "previewPrompt", tags: ["prompts"],
      summary: "Render a Prompt version with supplied variables", security: "session",
      requestBody: body("PromptPreviewRequest", promptPreviewRequestSchema),
      responses: [response(200, "PromptPreviewResponse", promptPreviewResponseSchema)]
    }
  ];

  return capabilities;
}
