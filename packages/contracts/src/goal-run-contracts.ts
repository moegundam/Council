import { z } from "zod";
import { runtimeCapabilities, runtimeHarnessKinds, runtimePolicies } from "#runtime-contracts";

const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const nonEmpty = (max: number) => z.string().trim().min(1).max(max);
const revision = z.number().int().positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const safeInputKey = z.string().trim().min(1).max(100).refine(
  (value) => !/(?:^|[_-])(secret|token|password|cookie|authorization|api[_-]?key|credential)(?:$|[_-])/i.test(value),
  "Action inputs cannot contain secret-bearing keys."
);
const scalarInput = z.union([z.string().max(4_000), z.number().finite(), z.boolean(), z.null()]);
export const actionInputsSchema = z.record(
  safeInputKey,
  z.union([scalarInput, z.array(scalarInput).max(50)])
).superRefine((value, context) => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 32 * 1_024) {
    context.addIssue({ code: "custom", message: "Action inputs exceed the 32 KiB limit." });
  }
});

export const goalRunStates = [
  "draft",
  "planning",
  "awaiting_approval",
  "executing",
  "reviewing",
  "replanning",
  "paused",
  "completed",
  "failed",
  "cancelled"
] as const;
export const goalRunStateSchema = z.enum(goalRunStates);

export const goalTaskStates = [
  "waiting",
  "ready",
  "running",
  "reviewing",
  "completed",
  "failed",
  "blocked",
  "cancelled"
] as const;
export const goalTaskStateSchema = z.enum(goalTaskStates);

export const goalExecutionLimitsSchema = z.object({
  discussionRounds: z.number().int().min(1).max(8).default(3),
  maxTasks: z.number().int().min(1).max(12).default(12),
  maxConcurrentTasks: z.number().int().min(1).max(2).default(2),
  maxAttemptsPerTask: z.number().int().min(1).max(5).default(3),
  maxReplans: z.number().int().min(0).max(5).default(2),
  maxDurationMinutes: z.number().int().min(5).max(1_440).default(120),
  maxModelCalls: z.number().int().min(1).max(500).default(60),
  maxActionCalls: z.number().int().min(0).max(100).default(30)
}).strict();

export const goalExecutionUsageSchema = z.object({
  discussionRounds: z.number().int().nonnegative(),
  taskAttempts: z.number().int().nonnegative(),
  replans: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  actionCalls: z.number().int().nonnegative()
}).strict();

export const goalPlanActionSchema = z.object({
  adapterId: uuid,
  actionKey: nonEmpty(120),
  targetId: nonEmpty(240),
  inputs: actionInputsSchema,
  riskClass: z.enum(["ordinary", "critical"])
}).strict();

export const goalPlanTaskSchema = z.object({
  id: uuid,
  decisionId: uuid,
  title: nonEmpty(160),
  description: z.string().trim().max(4_000),
  acceptanceCriteria: nonEmpty(4_000),
  dependencyIds: z.array(uuid).max(12),
  assigneeAgentId: uuid.nullable(),
  executionMode: z.enum(["manual", "advisor", "worker", "action"]),
  allowedTools: z.array(nonEmpty(200)).max(20),
  dataScope: nonEmpty(2_000),
  action: goalPlanActionSchema.nullable()
}).strict().superRefine((task, context) => {
  if (new Set(task.dependencyIds).size !== task.dependencyIds.length) {
    context.addIssue({ code: "custom", path: ["dependencyIds"], message: "Task dependencies must be unique." });
  }
  if (task.dependencyIds.includes(task.id)) {
    context.addIssue({ code: "custom", path: ["dependencyIds"], message: "A task cannot depend on itself." });
  }
  if (task.executionMode === "action" && task.action === null) {
    context.addIssue({ code: "custom", path: ["action"], message: "Action tasks require an Action binding." });
  }
  if (task.executionMode !== "action" && task.action !== null) {
    context.addIssue({ code: "custom", path: ["action"], message: "Only Action tasks may carry an Action binding." });
  }
});

export const goalPlannerProvenanceSchema = z.object({
  plannerParticipantId: uuid,
  plannerAgentId: uuid,
  plannerAgentRevision: revision,
  plannerModelConnectorId: uuid,
  plannerRoleId: uuid,
  plannerRoleRevision: revision,
  plannerRoleSnapshotDigest: digest
}).strict();

function validateGoalTaskDag(
  tasks: Array<z.output<typeof goalPlanTaskSchema>>,
  context: z.RefinementCtx
): void {
  const taskIds = new Set(tasks.map((task) => task.id));
  if (taskIds.size !== tasks.length) {
    context.addIssue({ code: "custom", path: ["tasks"], message: "Plan task IDs must be unique." });
    return;
  }
  if (new Set(tasks.map((task) => task.decisionId)).size !== tasks.length) {
    context.addIssue({
      code: "custom",
      path: ["tasks"],
      message: "Each Plan task must reference a distinct formal Meeting Decision."
    });
  }
  for (const [index, task] of tasks.entries()) {
    for (const dependencyId of task.dependencyIds) {
      if (!taskIds.has(dependencyId)) {
        context.addIssue({
          code: "custom",
          path: ["tasks", index, "dependencyIds"],
          message: "Task dependencies must reference tasks in the same Plan revision."
        });
      }
    }
  }
  const state = new Map<string, "visiting" | "visited">();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visit = (taskId: string): boolean => {
    if (state.get(taskId) === "visiting") return false;
    if (state.get(taskId) === "visited") return true;
    state.set(taskId, "visiting");
    for (const dependencyId of byId.get(taskId)?.dependencyIds ?? []) {
      if (!visit(dependencyId)) return false;
    }
    state.set(taskId, "visited");
    return true;
  };
  if (tasks.some((task) => !visit(task.id))) {
    context.addIssue({ code: "custom", path: ["tasks"], message: "The Plan task graph must be acyclic." });
  }
}

export const goalPlanRevisionSchema = z.object({
  id: uuid,
  goalRunId: uuid,
  revision,
  status: z.enum(["draft", "approved", "superseded"]),
  digest,
  tasks: z.array(goalPlanTaskSchema).min(1).max(12),
  // Optional only for plans created before Planner provenance was introduced.
  plannerProvenance: goalPlannerProvenanceSchema.optional(),
  createdAt: timestamp
}).strict().superRefine(({ tasks }, context) => validateGoalTaskDag(tasks, context));

export const executionActionBindingSchema = z.object({
  planTaskId: uuid,
  adapterId: uuid,
  adapterCatalogRevision: revision,
  endpointDigest: digest,
  credentialId: uuid.nullable(),
  credentialSecretRevision: z.number().int().nonnegative().nullable()
}).strict().superRefine((binding, context) => {
  if ((binding.credentialId === null) !== (binding.credentialSecretRevision === null)) {
    context.addIssue({
      code: "custom",
      path: ["credentialSecretRevision"],
      message: "Action credential identity and secret revision must be pinned together."
    });
  }
});

export const executionRoutes = ["native_text", "omp_coding", "read_only_research", "approved_action"] as const;
export const executionWorkspaceSourceSchema = z.object({
  sourceId: z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9._-]*$/),
  archiveDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/)
}).strict();
export const executionRuntimeBindingSchema = z.object({
  planTaskId: uuid,
  route: z.enum(executionRoutes),
  runtimeProfileId: uuid,
  runtimeProfileRevision: revision,
  harnessKind: z.enum(runtimeHarnessKinds),
  runtimeVersion: nonEmpty(120),
  policy: z.enum(runtimePolicies),
  capabilities: z.array(z.enum(runtimeCapabilities)).min(1).max(runtimeCapabilities.length),
  agentId: uuid,
  agentRevision: revision,
  modelConnectorId: uuid,
  modelConnectorRevision: revision,
  modelConnectorSecretRevision: z.number().int().nonnegative(),
  sandboxProfileId: uuid.nullable(),
  sandboxImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
  workspaceSource: executionWorkspaceSourceSchema.nullable(),
  allowedTools: z.array(nonEmpty(200)).max(20),
  dataScopeDigest: digest,
  timeoutMs: z.number().int().min(1_000).max(12 * 60 * 60_000)
}).strict().superRefine((binding, context) => {
  if (new Set(binding.capabilities).size !== binding.capabilities.length) {
    context.addIssue({ code: "custom", path: ["capabilities"], message: "Runtime binding capabilities must be unique." });
  }
  if (new Set(binding.allowedTools).size !== binding.allowedTools.length) {
    context.addIssue({ code: "custom", path: ["allowedTools"], message: "Runtime binding tools must be unique." });
  }
  if (binding.route === "omp_coding") {
    if (binding.harnessKind !== "pi" || binding.policy !== "isolated_exec") {
      context.addIssue({ code: "custom", path: ["harnessKind"], message: "OMP coding requires the pi isolated_exec runtime." });
    }
    if (binding.runtimeVersion !== "omp-rpc-v2@18.1.2" || binding.sandboxProfileId === null
      || binding.sandboxImageDigest === null || binding.workspaceSource === null) {
      context.addIssue({ code: "custom", path: ["runtimeVersion"], message: "OMP coding requires pinned RPC and sandbox revisions." });
    }
    if (binding.capabilities.includes("external_write")) {
      context.addIssue({ code: "custom", path: ["capabilities"], message: "OMP runtime bindings cannot include external_write." });
    }
    if (!binding.capabilities.includes("file_read")
      || !binding.capabilities.includes("file_write")
      || !binding.capabilities.includes("process")) {
      context.addIssue({ code: "custom", path: ["capabilities"], message: "OMP coding requires file and process capabilities." });
    }
  } else {
    if (binding.harnessKind === "pi") {
      context.addIssue({ code: "custom", path: ["route"], message: "The pi runtime is reserved for omp_coding bindings." });
    }
    if (binding.workspaceSource !== null) {
      context.addIssue({ code: "custom", path: ["workspaceSource"], message: "Only OMP coding binds an isolated workspace source." });
    }
  }
});

export const executionContractSchema = z.object({
  id: uuid,
  goalRunId: uuid,
  planRevision: revision,
  planDigest: digest,
  contractDigest: digest,
  approvedBy: uuid,
  approvedAt: timestamp,
  limits: goalExecutionLimitsSchema,
  planSnapshot: z.array(goalPlanTaskSchema).min(1).max(12),
  actionBindings: z.array(executionActionBindingSchema).max(12).default([]),
  runtimeBindings: z.array(executionRuntimeBindingSchema).max(12).default([])
}).strict().superRefine(({ planSnapshot, actionBindings, runtimeBindings }, context) => {
  validateGoalTaskDag(planSnapshot, context);
  const actionTaskIds = planSnapshot.filter((task) => task.executionMode === "action").map((task) => task.id);
  if (actionBindings.length > 0 && (actionBindings.length !== actionTaskIds.length
    || new Set(actionBindings.map((binding) => binding.planTaskId)).size !== actionBindings.length
    || actionBindings.some((binding) => !actionTaskIds.includes(binding.planTaskId)))) {
    context.addIssue({
      code: "custom",
      path: ["actionBindings"],
      message: "Every Action task requires exactly one immutable Adapter binding."
    });
  }
  for (const binding of actionBindings) {
    const task = planSnapshot.find((candidate) => candidate.id === binding.planTaskId);
    if (task?.action?.adapterId !== binding.adapterId) {
      context.addIssue({
        code: "custom",
        path: ["actionBindings"],
        message: "Action Adapter bindings must match the approved Plan snapshot."
      });
    }
  }
  if (runtimeBindings.length > 0) {
    const runtimeTaskIds = planSnapshot
      .filter((task) => task.executionMode === "worker" || task.executionMode === "advisor")
      .map((task) => task.id);
    if (runtimeBindings.length !== runtimeTaskIds.length
      || new Set(runtimeBindings.map((binding) => binding.planTaskId)).size !== runtimeBindings.length
      || runtimeBindings.some((binding) => !runtimeTaskIds.includes(binding.planTaskId))) {
      context.addIssue({
        code: "custom",
        path: ["runtimeBindings"],
        message: "Every automatic non-Action task requires exactly one immutable Runtime binding."
      });
    }
  }
});

export const goalRunSchema = z.object({
  id: uuid,
  title: nonEmpty(160),
  goal: nonEmpty(8_000),
  threadId: uuid,
  meetingId: uuid,
  state: goalRunStateSchema,
  revision,
  activePlanRevision: z.number().int().nonnegative(),
  executionContractId: uuid.nullable(),
  limits: goalExecutionLimitsSchema,
  usage: goalExecutionUsageSchema,
  deadlineAt: timestamp,
  pausedFromState: goalRunStateSchema.nullable(),
  terminalReason: z.string().trim().max(2_000).nullable(),
  createdBy: uuid,
  createdAt: timestamp,
  updatedAt: timestamp
}).strict();

export const goalTaskBindingSchema = z.object({
  id: uuid,
  goalRunId: uuid,
  planRevision: revision,
  planTaskId: uuid,
  taskId: uuid.nullable(),
  state: goalTaskStateSchema,
  attemptCount: z.number().int().nonnegative(),
  activeJobId: z.string().trim().min(1).max(500).nullable(),
  lastError: z.string().max(2_000).nullable(),
  createdAt: timestamp,
  updatedAt: timestamp
}).strict();

export const goalEventTypes = [
  "goal.created",
  "goal.state.changed",
  "meeting.linked",
  "meeting.round.started",
  "meeting.round.completed",
  "chair.intervened",
  "plan.created",
  "plan.revised",
  "contract.approved",
  "task.bound",
  "task.state.changed",
  "action.state.changed",
  "review.recorded",
  "owner.message",
  "owner.takeover"
] as const;
export const goalEventTypeSchema = z.enum(goalEventTypes);

export const goalEventSchema = z.object({
  id: uuid,
  goalRunId: uuid,
  sequence: z.number().int().positive(),
  type: goalEventTypeSchema,
  actorType: z.enum(["owner", "agent", "system"]),
  actorId: uuid.nullable(),
  entityType: z.enum(["goal", "meeting", "plan", "task", "action", "review"]),
  entityId: z.string().trim().min(1).max(500),
  summary: nonEmpty(1_000),
  detail: z.record(z.string().max(100), scalarInput).default({}),
  occurredAt: timestamp
}).strict();

export const reviewerVerdictSchema = z.object({
  id: uuid,
  goalRunId: uuid,
  scope: z.enum(["task", "goal", "action"]),
  scopeId: uuid,
  reviewerAgentId: uuid,
  reviewerAgentRevision: revision,
  modelConnectorId: uuid,
  verdict: z.enum(["pass", "fail", "needs_human"]),
  summary: nonEmpty(4_000),
  evidenceIds: z.array(uuid).max(100),
  contractDigest: digest,
  reviewJobId: z.string().trim().min(1).max(1_000).nullable(),
  reviewRequestFingerprint: z.string().regex(/^v2:[a-f0-9]{64}$/).nullable(),
  createdAt: timestamp
}).strict().superRefine((value, context) => {
  if ((value.reviewJobId === null) !== (value.reviewRequestFingerprint === null)) {
    context.addIssue({
      code: "custom",
      path: ["reviewJobId"],
      message: "Reviewer verdict job ID and request fingerprint must both be set or both be null."
    });
  }
});

export const actionCatalogEntrySchema = z.object({
  key: nonEmpty(120),
  displayName: nonEmpty(200),
  targetIds: z.array(nonEmpty(240)).min(1).max(100),
  inputKeys: z.array(safeInputKey).max(100),
  riskClass: z.enum(["ordinary", "critical"]),
  timeoutMs: z.number().int().min(1_000).max(30 * 60_000),
  supportsCancellation: z.boolean(),
  supportsCompensation: z.boolean()
}).strict();

export const actionAdapterSchema = z.object({
  id: uuid,
  name: nonEmpty(120),
  kind: z.literal("harness_pipeline"),
  enabled: z.boolean(),
  baseUrl: z.string().url().max(2_000),
  credentialId: uuid.nullable(),
  catalogRevision: revision,
  actions: z.array(actionCatalogEntrySchema).max(100),
  createdAt: timestamp,
  updatedAt: timestamp
}).strict();

export const createActionAdapterSchema = z.object({
  name: nonEmpty(120),
  baseUrl: z.string().url().max(2_000),
  credentialId: uuid,
  actions: z.array(actionCatalogEntrySchema).min(1).max(100)
}).strict();

export const actionAdapterListResponseSchema = z.object({
  actionAdapters: z.array(actionAdapterSchema)
}).strict();

export const actionRunStates = [
  "draft",
  "awaiting_review",
  "approved",
  "reserved",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "denied",
  "expired",
  "outcome_unknown"
] as const;
export const actionRunStateSchema = z.enum(actionRunStates);

export const actionRunSchema = z.object({
  id: uuid,
  goalRunId: uuid,
  planTaskId: uuid,
  adapterId: uuid,
  adapterCatalogRevision: revision,
  actionKey: nonEmpty(120),
  targetId: nonEmpty(240),
  inputs: actionInputsSchema,
  state: actionRunStateSchema,
  requestFingerprint: digest,
  contractDigest: digest,
  externalExecutionId: z.string().trim().min(1).max(500).nullable(),
  verificationSummary: z.string().max(4_000).nullable(),
  lastError: z.string().max(2_000).nullable(),
  createdAt: timestamp,
  updatedAt: timestamp
}).strict();

export const goalCanvasLenses = ["progress", "collaboration", "resources"] as const;
export const goalCanvasLensSchema = z.enum(goalCanvasLenses);
export const goalCanvasNodeSchema = z.object({
  id: nonEmpty(500),
  type: z.enum(["phase", "task", "runtime", "agent", "role", "model", "tool", "data", "action", "review"]),
  label: nonEmpty(500),
  status: z.enum(["waiting", "running", "completed", "paused", "failed", "blocked"]),
  entityId: z.string().max(500).nullable(),
  detail: z.record(z.string().max(100), scalarInput).default({})
}).strict();
export const goalCanvasEdgeSchema = z.object({
  id: nonEmpty(500),
  source: nonEmpty(500),
  target: nonEmpty(500),
  type: z.enum(["sequence", "dependency", "assignment", "usage", "review"]),
  label: z.string().max(200).nullable()
}).strict();
export const goalCanvasSnapshotSchema = z.object({
  goalRunId: uuid,
  revision,
  lens: goalCanvasLensSchema,
  nodes: z.array(goalCanvasNodeSchema).max(500),
  edges: z.array(goalCanvasEdgeSchema).max(1_000),
  generatedAt: timestamp
}).strict();

export const createGoalRunSchema = z.object({
  goal: nonEmpty(8_000),
  title: z.string().trim().min(1).max(160).optional(),
  threadId: uuid.optional(),
  categoryId: uuid.optional(),
  tagIds: z.array(uuid).max(12).default([]),
  limits: goalExecutionLimitsSchema.partial().optional()
}).strict().superRefine((value, context) => {
  if ((value.threadId ? 1 : 0) + (value.categoryId ? 1 : 0) !== 1) {
    context.addIssue({
      code: "custom",
      path: ["threadId"],
      message: "A Goal Run requires exactly one existing Topic or destination Category."
    });
  }
  if (new Set(value.tagIds).size !== value.tagIds.length) {
    context.addIssue({ code: "custom", path: ["tagIds"], message: "Goal Run tags must be unique." });
  }
});

export const goalRunPlanUpdateSchema = z.object({
  expectedPlanRevision: z.number().int().nonnegative(),
  tasks: z.array(goalPlanTaskSchema).min(1).max(12)
}).strict().superRefine(({ tasks }, context) => validateGoalTaskDag(tasks, context));

export const approveGoalRunSchema = z.object({
  expectedRevision: revision,
  expectedPlanRevision: revision,
  expectedPlanDigest: digest
}).strict();

export const goalRunControlSchema = z.object({ expectedRevision: revision }).strict();
export const goalRunMessageSchema = z.object({
  expectedRevision: revision,
  content: nonEmpty(8_000)
}).strict();

export interface GoalOrchestrateJobData {
  goalRunId: string;
  expectedRevision: number;
  requestFingerprint: string;
  requestedBy: "owner" | "system";
}

export interface GoalPlanJobData {
  goalRunId: string;
  expectedRevision: number;
  expectedPlanRevision: number;
  requestedBy: "system";
}

export interface GoalReviewModelConnectorBinding {
  id: string;
  revision: number;
  location: "cloud" | "local";
  baseUrl: string;
  model: string;
  credentialId: string | null;
  secretRevision: number;
}

export interface GoalReviewCredentialBinding {
  credentialId: string;
  secretRevision: number;
  provider: string;
  location: "cloud" | "local";
}

export interface LegacyGoalReviewJobData {
  goalRunId: string;
  scope: "task" | "goal" | "action";
  scopeId: string;
  reviewerAgentId: string;
  reviewerAgentRevision: number;
  modelConnectorId: string;
  contractDigest: string;
  requestedBy: "system";
}

export interface GoalReviewJobData {
  goalRunId: string;
  scope: "task" | "goal" | "action";
  scopeId: string;
  reviewerAgentId: string;
  reviewerAgentRevision: number;
  reviewerParticipantId: string;
  reviewerRoleId: string;
  reviewerRoleRevision: number;
  reviewerRoleSnapshotDigest: string;
  modelConnectorId: string;
  modelConnectorBinding: GoalReviewModelConnectorBinding;
  credentialBinding?: GoalReviewCredentialBinding | undefined;
  contractDigest: string;
  requestedBy: "system";
}

export interface GoalActionRunJobData {
  goalRunId: string;
  planTaskId: string;
  actionRunId: string;
  contractDigest: string;
  requestedBy: "system";
}

export type GoalRunState = z.infer<typeof goalRunStateSchema>;
export type GoalTaskState = z.infer<typeof goalTaskStateSchema>;
export type GoalExecutionLimits = z.infer<typeof goalExecutionLimitsSchema>;
export type GoalExecutionUsage = z.infer<typeof goalExecutionUsageSchema>;
export type GoalPlanAction = z.infer<typeof goalPlanActionSchema>;
export type GoalPlanTask = z.infer<typeof goalPlanTaskSchema>;
export type GoalPlannerProvenance = z.infer<typeof goalPlannerProvenanceSchema>;
export type GoalPlanRevision = z.infer<typeof goalPlanRevisionSchema>;
export type ExecutionActionBinding = z.infer<typeof executionActionBindingSchema>;
export type ExecutionRoute = (typeof executionRoutes)[number];
export type ExecutionRuntimeBinding = z.infer<typeof executionRuntimeBindingSchema>;
export type ExecutionContract = z.infer<typeof executionContractSchema>;
export type GoalRun = z.infer<typeof goalRunSchema>;
export type GoalTaskBinding = z.infer<typeof goalTaskBindingSchema>;
export type GoalEvent = z.infer<typeof goalEventSchema>;
export type GoalEventType = z.infer<typeof goalEventTypeSchema>;
export type ReviewerVerdict = z.infer<typeof reviewerVerdictSchema>;
export type ActionAdapter = z.infer<typeof actionAdapterSchema>;
export type CreateActionAdapterInput = z.infer<typeof createActionAdapterSchema>;
export type ActionRun = z.infer<typeof actionRunSchema>;
export type ActionRunState = z.infer<typeof actionRunStateSchema>;
export type GoalCanvasLens = z.infer<typeof goalCanvasLensSchema>;
export type GoalCanvasSnapshot = z.infer<typeof goalCanvasSnapshotSchema>;
export type CreateGoalRunInput = z.input<typeof createGoalRunSchema>;
export type GoalRunPlanUpdateInput = z.input<typeof goalRunPlanUpdateSchema>;
export type ApproveGoalRunInput = z.infer<typeof approveGoalRunSchema>;
export type GoalRunControlInput = z.infer<typeof goalRunControlSchema>;
export type GoalRunMessageInput = z.infer<typeof goalRunMessageSchema>;
