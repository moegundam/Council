import { z } from "zod";
import {
  runtimeProfileBindingSchema,
  runtimeProfileSnapshotSchema,
  runtimeControlJobDataSchema,
  runtimeReconcileJobDataSchema,
  runtimeRunSchema,
  type RuntimeControlJobData,
  type RuntimeReconcileJobData
} from "#runtime-contracts";
import { mcpToolArgumentsSchema } from "#mcp-arguments";
import { executionRuntimeBindingSchema } from "#goal-run-contracts";
import type {
  AgentTurnJobData,
  ChairAutomationJobData,
  CouncilJobName,
  GoalActionRunJobData,
  GoalOrchestrateJobData,
  GoalPlanJobData,
  GoalReviewJobData,
  LegacyGoalReviewJobData,
  McpToolCallJobData,
  MeetingSummaryJobData,
  TaskAgentRunJobData,
  TaskSyncJobData,
  ToolRegistrationKind
} from "#index";

const nonEmptyString = z.string().min(1).max(2_000).refine(
  (value) => value.trim().length > 0,
  "A non-empty string is required."
);
const identifier = nonEmptyString.max(500);
const positiveRevision = z.number().int().positive();
const nonNegativeRevision = z.number().int().nonnegative();

export const councilJobNames = [
  "agent-turn",
  "chair-automation",
  "mcp-tool-call",
  "meeting-summary",
  "task-sync",
  "task-agent-run",
  "goal-orchestrate",
  "goal-plan",
  "goal-review",
  "goal-action-run",
  "runtime-control",
  "runtime-reconcile"
] as const satisfies readonly CouncilJobName[];

export const councilJobNameSchema = z.enum(councilJobNames);
export const jobContractVersionSchema = z.literal(1);

const participantRoleBindingSchema = z.object({
  participantId: identifier,
  roleRevision: positiveRevision,
  roleId: identifier,
  roleVersion: positiveRevision
}).strict();

const modelConnectorBindingSchema = z.object({
  id: identifier,
  location: z.enum(["cloud", "local"]),
  baseUrl: nonEmptyString.max(2_000),
  model: nonEmptyString.max(500),
  secretRevision: nonNegativeRevision
}).strict();

const credentialBindingSchema = z.object({
  credentialId: identifier,
  secretRevision: nonNegativeRevision,
  provider: nonEmptyString.max(500),
  location: z.enum(["cloud", "local"])
}).strict();

const goalReviewModelConnectorBindingSchema = modelConnectorBindingSchema.extend({
  revision: positiveRevision,
  credentialId: identifier.nullable()
}).strict();

const promptBindingSchema = z.object({
  promptId: identifier,
  version: positiveRevision
}).strict();

const skillDigestsSchema = z.record(identifier, nonEmptyString.max(500));
const toolRegistrationKinds = [
  "mcp_tool",
  "function_wrapper",
  "library_wrapper",
  "program_adapter",
  "api_wrapper"
] as const satisfies readonly ToolRegistrationKind[];

const executionBindingFields = {
  modelConnectorBinding: modelConnectorBindingSchema,
  agentRevision: positiveRevision,
  promptBinding: promptBindingSchema.nullable(),
  credentialBinding: credentialBindingSchema.optional(),
  skillDigests: skillDigestsSchema,
  runtimeProfileBinding: runtimeProfileBindingSchema,
  runtimeProfileSnapshot: runtimeProfileSnapshotSchema
};

const optionalExecutionBindingFields = {
  modelConnectorBinding: modelConnectorBindingSchema.optional(),
  agentRevision: positiveRevision.optional(),
  promptBinding: promptBindingSchema.nullable().optional(),
  credentialBinding: credentialBindingSchema.optional(),
  skillDigests: skillDigestsSchema.optional(),
  runtimeProfileBinding: runtimeProfileBindingSchema.optional(),
  runtimeProfileSnapshot: runtimeProfileSnapshotSchema.optional()
};

type OptionalExecutionBinding = {
  [Key in keyof typeof optionalExecutionBindingFields]?: z.output<typeof optionalExecutionBindingFields[Key]>;
};

const executionBindingKeys = [
  "modelConnectorBinding",
  "agentRevision",
  "promptBinding",
  "skillDigests",
  "runtimeProfileBinding",
  "runtimeProfileSnapshot"
] as const;

function validateOptionalExecutionBinding(value: OptionalExecutionBinding, context: z.RefinementCtx): void {
  const hasExecutionBinding = executionBindingKeys.some((key) => value[key] !== undefined)
    || value.credentialBinding !== undefined;
  if (!hasExecutionBinding) return;

  for (const key of executionBindingKeys) {
    if (value[key] === undefined) {
      context.addIssue({ code: "custom", path: [key], message: `Chair automation execution binding requires ${key}.` });
    }
  }
  if (value.modelConnectorBinding?.location === "cloud" && value.credentialBinding === undefined) {
    context.addIssue({
      code: "custom",
      path: ["credentialBinding"],
      message: "Cloud model connectors require a credential binding."
    });
  }
}

export const agentTurnJobDataSchema = z.object({
  ...participantRoleBindingSchema.shape,
  meetingId: identifier,
  agentId: identifier,
  reservationId: identifier.optional(),
  agendaRevision: nonNegativeRevision,
  agendaCurrentItemId: identifier.nullable(),
  requestedBy: z.enum(["owner", "system"]),
  chairSuggestionId: identifier.optional(),
  automationRevision: nonNegativeRevision.optional(),
  ...executionBindingFields,
  runtimeRun: runtimeRunSchema
}).strict();

export const chairAutomationJobDataSchema = z.object({
  meetingId: identifier,
  chairSuggestionId: identifier,
  sourceUtteranceId: identifier,
  automationRevision: nonNegativeRevision,
  requestedBy: z.literal("system"),
  ...optionalExecutionBindingFields
}).strict().superRefine(validateOptionalExecutionBinding);

const toolRegistrationSnapshotSchema = z.object({
  connectorName: nonEmptyString.max(500),
  toolName: nonEmptyString.max(500),
  displayName: nonEmptyString.max(500),
  kind: z.enum(toolRegistrationKinds),
  version: nonEmptyString.max(500),
  owner: nonEmptyString.max(500),
  goal: nonEmptyString.max(2_000)
}).strict();

const mcpToolCallJobBaseShape = {
  ...participantRoleBindingSchema.shape,
  meetingId: identifier,
  agentId: identifier,
  requestFingerprint: nonEmptyString.max(500).optional(),
  connectorId: identifier,
  toolName: nonEmptyString.max(500),
  toolSnapshot: toolRegistrationSnapshotSchema,
  connectorFingerprint: nonEmptyString.max(500),
  requestedBy: z.literal("owner")
} as const;

export const mcpToolCallJobDataSchema: z.ZodType<McpToolCallJobData> = z.union([
  z.object({
    ...mcpToolCallJobBaseShape,
    arguments: mcpToolArgumentsSchema
  }).strict(),
  z.object({
    ...mcpToolCallJobBaseShape,
    argumentEncoding: z.literal("vault_v1"),
    argumentsCiphertext: z.string().min(1).max(128 * 1_024)
  }).strict()
]);

export const meetingSummaryJobDataSchema = z.object({
  meetingId: identifier,
  requestedBy: z.literal("system")
}).strict();

export const taskSyncJobDataSchema = z.object({
  taskId: identifier,
  adapterId: identifier,
  requestedBy: z.enum(["owner", "system"])
}).strict();

export const taskAgentRunJobDataSchema = z.object({
  taskId: identifier,
  goalRunId: identifier.optional(),
  planTaskId: identifier.optional(),
  agentId: identifier,
  executionProfile: z.enum(["advisor", "worker"]),
  executionRevision: positiveRevision,
  taskFingerprint: nonEmptyString.max(500),
  requestFingerprint: nonEmptyString.max(500),
  ...executionBindingFields,
  runtimeRun: runtimeRunSchema,
  executionRuntimeBinding: executionRuntimeBindingSchema.optional(),
  requestedBy: z.literal("owner")
}).strict().superRefine((value, context) => {
  const hasGoalBinding = value.goalRunId !== undefined
    || value.planTaskId !== undefined
    || value.executionRuntimeBinding !== undefined;
  if (!hasGoalBinding) return;
  if (!value.goalRunId || !value.planTaskId || !value.executionRuntimeBinding) {
    context.addIssue({
      code: "custom",
      path: ["executionRuntimeBinding"],
      message: "Goal Task jobs require Goal, Plan Task, and Execution Runtime bindings together."
    });
    return;
  }
  if (value.executionRuntimeBinding.planTaskId !== value.planTaskId
    || value.executionRuntimeBinding.agentId !== value.agentId
    || value.runtimeRun.goalRunId !== value.goalRunId
    || value.runtimeRun.taskId !== value.taskId) {
    context.addIssue({
      code: "custom",
      path: ["executionRuntimeBinding"],
      message: "Goal Task execution identities must match their immutable Runtime binding."
    });
  }
});

export const goalOrchestrateJobDataSchema: z.ZodType<GoalOrchestrateJobData> = z.object({
  goalRunId: identifier,
  expectedRevision: positiveRevision,
  requestFingerprint: nonEmptyString.max(500),
  requestedBy: z.enum(["owner", "system"])
}).strict();

export const goalPlanJobDataSchema: z.ZodType<GoalPlanJobData> = z.object({
  goalRunId: identifier,
  expectedRevision: positiveRevision,
  expectedPlanRevision: nonNegativeRevision,
  requestedBy: z.literal("system")
}).strict();

export const goalReviewJobDataSchema: z.ZodType<GoalReviewJobData> = z.object({
  goalRunId: identifier,
  scope: z.enum(["task", "goal", "action"]),
  scopeId: identifier,
  reviewerAgentId: identifier,
  reviewerAgentRevision: positiveRevision,
  reviewerParticipantId: identifier,
  reviewerRoleId: identifier,
  reviewerRoleRevision: positiveRevision,
  reviewerRoleSnapshotDigest: z.string().regex(/^[a-f0-9]{64}$/),
  modelConnectorId: identifier,
  modelConnectorBinding: goalReviewModelConnectorBindingSchema,
  credentialBinding: credentialBindingSchema.optional(),
  contractDigest: z.string().regex(/^[a-f0-9]{64}$/),
  requestedBy: z.literal("system")
}).strict().superRefine((value, context) => {
  if (value.modelConnectorId !== value.modelConnectorBinding.id) {
    context.addIssue({
      code: "custom",
      path: ["modelConnectorBinding", "id"],
      message: "Reviewer Model Connector ID must match its immutable binding."
    });
  }
  if ((value.modelConnectorBinding.location === "cloud" || value.modelConnectorBinding.credentialId !== null)
    && !value.credentialBinding) {
    context.addIssue({
      code: "custom",
      path: ["credentialBinding"],
      message: "Credential-backed Reviewer Model Connectors require an immutable Credential binding."
    });
  }
  if (value.credentialBinding && (
    value.modelConnectorBinding.credentialId !== value.credentialBinding.credentialId
    || value.modelConnectorBinding.secretRevision !== value.credentialBinding.secretRevision
    || value.modelConnectorBinding.location !== value.credentialBinding.location
  )) {
    context.addIssue({
      code: "custom",
      path: ["credentialBinding"],
      message: "Reviewer Credential binding must match the immutable Model Connector binding."
    });
  }
});

export const legacyGoalReviewJobDataSchema: z.ZodType<LegacyGoalReviewJobData> = z.object({
  goalRunId: identifier,
  scope: z.enum(["task", "goal", "action"]),
  scopeId: identifier,
  reviewerAgentId: identifier,
  reviewerAgentRevision: positiveRevision,
  modelConnectorId: identifier,
  contractDigest: z.string().regex(/^[a-f0-9]{64}$/),
  requestedBy: z.literal("system")
}).strict();

export const goalActionRunJobDataSchema: z.ZodType<GoalActionRunJobData> = z.object({
  goalRunId: identifier,
  planTaskId: identifier,
  actionRunId: identifier,
  contractDigest: z.string().regex(/^[a-f0-9]{64}$/),
  requestedBy: z.literal("system")
}).strict();

const agentTurnJobEnvelopeSchema = z.object({
  contractVersion: jobContractVersionSchema,
  name: z.literal("agent-turn"),
  data: agentTurnJobDataSchema
}).strict();

const chairAutomationJobEnvelopeSchema = z.object({
  contractVersion: jobContractVersionSchema,
  name: z.literal("chair-automation"),
  data: chairAutomationJobDataSchema
}).strict();

const mcpToolCallJobEnvelopeSchema = z.object({
  contractVersion: jobContractVersionSchema,
  name: z.literal("mcp-tool-call"),
  data: mcpToolCallJobDataSchema
}).strict();

const meetingSummaryJobEnvelopeSchema = z.object({
  contractVersion: jobContractVersionSchema,
  name: z.literal("meeting-summary"),
  data: meetingSummaryJobDataSchema
}).strict();

const taskSyncJobEnvelopeSchema = z.object({
  contractVersion: jobContractVersionSchema,
  name: z.literal("task-sync"),
  data: taskSyncJobDataSchema
}).strict();

const taskAgentRunJobEnvelopeSchema = z.object({
  contractVersion: jobContractVersionSchema,
  name: z.literal("task-agent-run"),
  data: taskAgentRunJobDataSchema
}).strict();

const goalOrchestrateJobEnvelopeSchema = z.object({
  contractVersion: jobContractVersionSchema,
  name: z.literal("goal-orchestrate"),
  data: goalOrchestrateJobDataSchema
}).strict();

const goalPlanJobEnvelopeSchema = z.object({
  contractVersion: jobContractVersionSchema,
  name: z.literal("goal-plan"),
  data: goalPlanJobDataSchema
}).strict();

const legacyGoalReviewJobEnvelopeSchema = z.object({
  contractVersion: z.literal(1),
  name: z.literal("goal-review"),
  data: legacyGoalReviewJobDataSchema
}).strict();

const goalReviewJobEnvelopeSchema = z.object({
  contractVersion: z.literal(2),
  name: z.literal("goal-review"),
  data: goalReviewJobDataSchema
}).strict();

const goalActionRunJobEnvelopeSchema = z.object({
  contractVersion: jobContractVersionSchema,
  name: z.literal("goal-action-run"),
  data: goalActionRunJobDataSchema
}).strict();

const runtimeControlJobEnvelopeSchema = z.object({
  contractVersion: jobContractVersionSchema,
  name: z.literal("runtime-control"),
  data: runtimeControlJobDataSchema
}).strict();

const runtimeReconcileJobEnvelopeSchema = z.object({
  contractVersion: jobContractVersionSchema,
  name: z.literal("runtime-reconcile"),
  data: runtimeReconcileJobDataSchema
}).strict();

export const councilJobEnvelopeSchema = z.union([
  agentTurnJobEnvelopeSchema,
  chairAutomationJobEnvelopeSchema,
  mcpToolCallJobEnvelopeSchema,
  meetingSummaryJobEnvelopeSchema,
  taskSyncJobEnvelopeSchema,
  taskAgentRunJobEnvelopeSchema,
  goalOrchestrateJobEnvelopeSchema,
  goalPlanJobEnvelopeSchema,
  legacyGoalReviewJobEnvelopeSchema,
  goalReviewJobEnvelopeSchema,
  goalActionRunJobEnvelopeSchema,
  runtimeControlJobEnvelopeSchema,
  runtimeReconcileJobEnvelopeSchema
]);

export const councilJobSchema = councilJobEnvelopeSchema;

export type CouncilJobNameContract = (typeof councilJobNames)[number];
export type AgentTurnJobContract = z.infer<typeof agentTurnJobDataSchema>;
export type ChairAutomationJobContract = z.infer<typeof chairAutomationJobDataSchema>;
export type McpToolCallJobContract = z.infer<typeof mcpToolCallJobDataSchema>;
export type MeetingSummaryJobContract = z.infer<typeof meetingSummaryJobDataSchema>;
export type TaskSyncJobContract = z.infer<typeof taskSyncJobDataSchema>;
export type TaskAgentRunJobContract = z.infer<typeof taskAgentRunJobDataSchema>;
export type GoalOrchestrateJobContract = z.infer<typeof goalOrchestrateJobDataSchema>;
export type GoalPlanJobContract = z.infer<typeof goalPlanJobDataSchema>;
export type GoalReviewJobContract = z.infer<typeof goalReviewJobDataSchema>;
export type LegacyGoalReviewJobContract = z.infer<typeof legacyGoalReviewJobDataSchema>;
export type GoalActionRunJobContract = z.infer<typeof goalActionRunJobDataSchema>;
export type RuntimeControlJobContract = z.infer<typeof runtimeControlJobDataSchema>;
export type RuntimeReconcileJobContract = z.infer<typeof runtimeReconcileJobDataSchema>;

export type CouncilJobDataByName = {
  "agent-turn": AgentTurnJobData;
  "chair-automation": ChairAutomationJobData;
  "mcp-tool-call": McpToolCallJobData;
  "meeting-summary": MeetingSummaryJobData;
  "task-sync": TaskSyncJobData;
  "task-agent-run": TaskAgentRunJobData;
  "goal-orchestrate": GoalOrchestrateJobData;
  "goal-plan": GoalPlanJobData;
  "goal-review": GoalReviewJobData;
  "goal-action-run": GoalActionRunJobData;
  "runtime-control": RuntimeControlJobData;
  "runtime-reconcile": RuntimeReconcileJobData;
};

export type CouncilJobEnvelopeByName<Name extends CouncilJobNameContract> = Name extends "goal-review"
  ? { contractVersion: 2; name: Name; data: CouncilJobDataByName[Name] }
  : { contractVersion: 1; name: Name; data: CouncilJobDataByName[Name] };
export type LegacyGoalReviewJobEnvelope = {
  contractVersion: 1;
  name: "goal-review";
  data: LegacyGoalReviewJobData;
};
export type CouncilJobEnvelope = {
  [Name in CouncilJobNameContract]: CouncilJobEnvelopeByName<Name>
}[CouncilJobNameContract] | LegacyGoalReviewJobEnvelope;
export type CouncilJobEnvelopeInput = z.input<typeof councilJobEnvelopeSchema>;

export function parseCouncilJobEnvelope(input: unknown): CouncilJobEnvelope {
  return councilJobEnvelopeSchema.parse(input) as CouncilJobEnvelope;
}

export function createCouncilJobEnvelope<Name extends CouncilJobNameContract>(
  name: Name,
  data: CouncilJobDataByName[Name]
): CouncilJobEnvelopeByName<Name> {
  return councilJobEnvelopeSchema.parse({
    contractVersion: name === "goal-review" ? 2 : 1,
    name,
    data
  }) as CouncilJobEnvelopeByName<Name>;
}

export function safeParseCouncilJobEnvelope(input: unknown) {
  return councilJobEnvelopeSchema.safeParse(input);
}

export const parseCouncilJob = parseCouncilJobEnvelope;
export const safeParseCouncilJob = safeParseCouncilJobEnvelope;
