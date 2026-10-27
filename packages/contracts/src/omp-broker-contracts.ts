import { z } from "zod";
import { executionRuntimeBindingSchema } from "#goal-run-contracts";

const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const bounded = (max: number) => z.string().trim().min(1).max(max);

export const ompBrokerSessionStates = [
  "provisioning",
  "ready",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled"
] as const;

export const ompBrokerEventKinds = [
  "state.changed",
  "agent.started",
  "agent.completed",
  "tool.started",
  "tool.progress",
  "tool.completed",
  "compaction.started",
  "compaction.completed",
  "checkpoint.created",
  "runtime.error"
] as const;

export const ompBrokerModelBindingSchema = z.object({
  id: uuid,
  revision: z.number().int().positive(),
  secretRevision: z.literal(0),
  location: z.literal("local"),
  baseUrl: z.string().url().max(2_000),
  model: bounded(240)
}).strict();

export const ompBrokerStartRequestSchema = z.object({
  runtimeRunId: uuid,
  goalRunId: uuid,
  taskId: uuid,
  idempotencyKey: bounded(500),
  executionBinding: executionRuntimeBindingSchema,
  model: ompBrokerModelBindingSchema,
  prompt: bounded(32_000)
}).strict().superRefine((value, context) => {
  if (value.executionBinding.route !== "omp_coding"
    || value.executionBinding.harnessKind !== "pi"
    || value.executionBinding.workspaceSource === null) {
    context.addIssue({ code: "custom", path: ["executionBinding"], message: "OMP Broker requires an immutable omp_coding binding." });
  }
  // The canonical Task and its approved Plan Task are distinct persisted identities.
  if (value.executionBinding.modelConnectorId !== value.model.id
    || value.executionBinding.modelConnectorRevision !== value.model.revision
    || value.executionBinding.modelConnectorSecretRevision !== value.model.secretRevision) {
    context.addIssue({ code: "custom", path: ["executionBinding"], message: "OMP Broker request does not match the approved model binding." });
  }
});

export const ompBrokerEventSchema = z.object({
  sequence: z.number().int().positive(),
  kind: z.enum(ompBrokerEventKinds),
  summary: bounded(1_000),
  toolName: z.string().trim().min(1).max(200).nullable(),
  progressPercent: z.number().int().min(0).max(100).nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  toolCalls: z.number().int().nonnegative().nullable(),
  errorCode: z.string().trim().min(1).max(120).nullable(),
  occurredAt: timestamp
}).strict();

export const ompBrokerArtifactManifestSchema = z.object({
  artifactRef: bounded(500),
  patchDigest: digest,
  manifestDigest: digest,
  changedFiles: z.array(z.object({
    path: bounded(500),
    status: z.enum(["added", "modified", "deleted", "renamed"]),
    digest: digest.nullable()
  }).strict()).max(2_000),
  tests: z.array(z.object({
    commandDigest: digest,
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative(),
    outputDigest: digest
  }).strict()).max(100),
  createdAt: timestamp
}).strict();

export const ompBrokerSessionSchema = z.object({
  runtimeRunId: uuid,
  goalRunId: uuid,
  taskId: uuid,
  idempotencyKey: bounded(500),
  requestDigest: digest,
  state: z.enum(ompBrokerSessionStates),
  runtimeVersion: z.literal("omp-rpc-v2@18.1.2"),
  leaseId: uuid,
  containerId: z.string().trim().min(1).max(200).nullable(),
  providerSessionId: z.string().trim().min(1).max(500).nullable(),
  providerSessionFile: z.string().trim().min(1).max(1_000).nullable(),
  eventCursor: z.number().int().nonnegative(),
  errorCode: z.string().trim().min(1).max(120).nullable(),
  artifactManifest: ompBrokerArtifactManifestSchema.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  expiresAt: timestamp
}).strict().superRefine((session, context) => {
  if (session.state === "paused" && session.errorCode === null) {
    context.addIssue({ code: "custom", path: ["errorCode"], message: "Paused OMP sessions require a reason." });
  }
  if (session.state === "completed" && session.artifactManifest === null) {
    context.addIssue({ code: "custom", path: ["artifactManifest"], message: "Completed OMP sessions require an artifact manifest." });
  }
});

export const ompBrokerControlRequestSchema = z.object({
  action: z.enum(["steer", "pause", "resume", "cancel"]),
  idempotencyKey: bounded(500),
  expectedEventCursor: z.number().int().nonnegative(),
  message: z.string().trim().min(1).max(8_000).optional()
}).strict().superRefine((value, context) => {
  if ((value.action === "steer") !== (value.message !== undefined)) {
    context.addIssue({ code: "custom", path: ["message"], message: "Only steer requires an Owner guidance message." });
  }
});

export const ompBrokerHealthSchema = z.object({
  ok: z.boolean(),
  ready: z.boolean(),
  runtimeVersion: z.literal("omp-rpc-v2@18.1.2"),
  rootless: z.boolean(),
  rootfulSocketAbsent: z.boolean(),
  isolationAttested: z.boolean(),
  maxConcurrency: z.number().int().min(1).max(2)
}).strict();

export type OmpBrokerStartRequest = z.infer<typeof ompBrokerStartRequestSchema>;
export type OmpBrokerControlRequest = z.infer<typeof ompBrokerControlRequestSchema>;
export type OmpBrokerEvent = z.infer<typeof ompBrokerEventSchema>;
export type OmpBrokerArtifactManifest = z.infer<typeof ompBrokerArtifactManifestSchema>;
export type OmpBrokerSession = z.infer<typeof ompBrokerSessionSchema>;
export type OmpBrokerHealth = z.infer<typeof ompBrokerHealthSchema>;
