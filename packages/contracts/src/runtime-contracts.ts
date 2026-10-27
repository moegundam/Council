import { z } from "zod";

export const runtimeHarnessKinds = ["openai_compatible", "codex", "pi"] as const;
export const runtimeCapabilities = [
  "text",
  "images",
  "fast_mode",
  "abort",
  "resume",
  "file_read",
  "file_write",
  "process",
  "read_only_tool",
  "external_write"
] as const;
export const runtimePolicies = ["text_only", "read_only_tools", "isolated_exec"] as const;
export const runtimeRunKinds = ["meeting_turn", "task_agent", "tool_execution"] as const;
export const runtimeRunStates = [
  "queued",
  "provisioning",
  "ready",
  "running",
  "awaiting_approval",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "expired"
] as const;
export const runtimeRunEventTypes = [
  "state.changed",
  "progress.updated",
  "tool.started",
  "tool.completed",
  "checkpoint.created",
  "usage.updated",
  "error.recorded",
  "owner.action"
] as const;
export const runtimeRunPhases = [
  "queued",
  "provisioning",
  "ready",
  "executing",
  "compacting",
  "reconciling",
  "paused",
  "completed"
] as const;
export const runtimeControlActions = ["steer", "pause", "resume", "cancel"] as const;
export const executionScopeKinds = ["agent", "meeting_participant", "task_attempt"] as const;
export const sandboxBackends = ["rootless_docker", "external"] as const;
export const sandboxLeaseStates = ["provisioning", "active", "idle", "snapshotting", "destroyed", "error"] as const;
export const sandboxNetworkPolicies = ["deny_all", "allowlist"] as const;
export const runtimeProfileRevisionSources = ["created", "updated", "legacy_backfilled"] as const;

export type RuntimeHarnessKind = (typeof runtimeHarnessKinds)[number];
export type RuntimeCapability = (typeof runtimeCapabilities)[number];
export type RuntimePolicy = (typeof runtimePolicies)[number];
export type RuntimeRunKind = (typeof runtimeRunKinds)[number];
export type RuntimeRunState = (typeof runtimeRunStates)[number];
export type RuntimeRunEventType = (typeof runtimeRunEventTypes)[number];
export type RuntimeRunPhase = (typeof runtimeRunPhases)[number];
export type RuntimeControlAction = (typeof runtimeControlActions)[number];
export type ExecutionScopeKind = (typeof executionScopeKinds)[number];
export type SandboxBackendKind = (typeof sandboxBackends)[number];
export type SandboxLeaseState = (typeof sandboxLeaseStates)[number];
export type SandboxNetworkPolicy = (typeof sandboxNetworkPolicies)[number];
export type RuntimeProfileRevisionSource = (typeof runtimeProfileRevisionSources)[number];

const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const capabilitySchema = z.enum(runtimeCapabilities);

const policyCapabilities: Record<RuntimePolicy, ReadonlySet<RuntimeCapability>> = {
  text_only: new Set(["text", "images", "fast_mode", "abort", "resume"]),
  read_only_tools: new Set(["text", "images", "fast_mode", "abort", "resume", "file_read", "read_only_tool"]),
  isolated_exec: new Set(runtimeCapabilities.filter((capability) => capability !== "external_write"))
};

const profileFields = {
  harnessKind: z.enum(runtimeHarnessKinds),
  modelConnectorId: uuid.nullable(),
  sandboxProfileId: uuid.nullable(),
  policy: z.enum(runtimePolicies),
  capabilities: z.array(capabilitySchema).min(1).max(runtimeCapabilities.length),
  timeoutMs: z.number().int().min(1_000).max(12 * 60 * 60_000),
  maxConcurrency: z.number().int().min(1).max(10)
};

function enforceProfilePolicy(
  value: {
    harnessKind: RuntimeHarnessKind;
    modelConnectorId: string | null;
    policy: RuntimePolicy;
    capabilities: RuntimeCapability[];
    sandboxProfileId: string | null;
    timeoutMs: number;
    maxConcurrency: number;
  },
  context: z.RefinementCtx
): void {
  if (new Set(value.capabilities).size !== value.capabilities.length) {
    context.addIssue({ code: "custom", path: ["capabilities"], message: "Runtime capabilities must be unique." });
  }
  const allowed = policyCapabilities[value.policy];
  const denied = value.capabilities.find((capability) => !allowed.has(capability));
  if (denied) {
    context.addIssue({
      code: "custom",
      path: ["capabilities"],
      message: `Capability ${denied} exceeds the ${value.policy} policy.`
    });
  }
  if (value.policy === "isolated_exec" && value.sandboxProfileId === null) {
    context.addIssue({
      code: "custom",
      path: ["sandboxProfileId"],
      message: "The isolated_exec policy requires a sandbox profile."
    });
  }
  if (value.harnessKind === "pi") {
    if (value.policy !== "isolated_exec" || value.sandboxProfileId === null) {
      context.addIssue({
        code: "custom",
        path: ["policy"],
        message: "The pi harness is OMP (Pi-compatible) and requires isolated_exec with a sandbox profile."
      });
    }
    if (value.modelConnectorId === null) {
      context.addIssue({
        code: "custom",
        path: ["modelConnectorId"],
        message: "The OMP runtime requires an explicitly bound Model Connector."
      });
    }
    if (value.timeoutMs < 30 * 60_000 || value.timeoutMs > 12 * 60 * 60_000) {
      context.addIssue({
        code: "custom",
        path: ["timeoutMs"],
        message: "OMP timeouts must be between 30 minutes and 12 hours."
      });
    }
    if (value.maxConcurrency > 2) {
      context.addIssue({
        code: "custom",
        path: ["maxConcurrency"],
        message: "OMP concurrency cannot exceed 2."
      });
    }
  } else if (value.timeoutMs > 15 * 60_000) {
    context.addIssue({
      code: "custom",
      path: ["timeoutMs"],
      message: "Non-OMP runtime timeouts cannot exceed 15 minutes."
    });
  }
}

export const runtimeProfileSchema = z.object({
  id: uuid,
  name: z.string().trim().min(1).max(120),
  ...profileFields,
  enabled: z.boolean(),
  revision: z.number().int().positive(),
  createdAt: timestamp,
  updatedAt: timestamp
}).strict().superRefine(enforceProfilePolicy);

export const createRuntimeProfileSchema = z.object({
  name: z.string().trim().min(1).max(120),
  ...profileFields,
  enabled: z.boolean().default(true)
}).strict().superRefine(enforceProfilePolicy);

export const updateRuntimeProfileSchema = z.object({
  expectedRevision: z.number().int().positive(),
  name: z.string().trim().min(1).max(120).optional(),
  harnessKind: profileFields.harnessKind.optional(),
  modelConnectorId: profileFields.modelConnectorId.optional(),
  sandboxProfileId: profileFields.sandboxProfileId.optional(),
  policy: profileFields.policy.optional(),
  capabilities: profileFields.capabilities.optional(),
  timeoutMs: profileFields.timeoutMs.optional(),
  maxConcurrency: profileFields.maxConcurrency.optional(),
  enabled: z.boolean().optional()
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== "expectedRevision"),
  "At least one Runtime Profile field is required."
);

export const runtimeProfileSnapshotSchema = z.object({
  profileId: uuid,
  revision: z.number().int().positive(),
  ...profileFields
}).strict().superRefine(enforceProfilePolicy);

export const runtimeProfileBindingSchema = z.object({
  profileId: uuid,
  revision: z.number().int().positive()
}).strict();

export const runtimeProfileRevisionSchema = z.object({
  profileId: uuid,
  revision: z.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  ...profileFields,
  enabled: z.boolean(),
  source: z.enum(runtimeProfileRevisionSources),
  recordedAt: timestamp
}).strict().superRefine(enforceProfilePolicy);

export const executionScopeSchema = z.object({
  id: z.string().trim().min(1).max(500),
  kind: z.enum(executionScopeKinds),
  subjectId: uuid,
  parentScopeId: z.string().trim().min(1).max(500).nullable()
}).strict();

const terminalRunStates: ReadonlySet<RuntimeRunState> = new Set(["completed", "failed", "cancelled", "expired"]);
const ompRuntimeVersion = "omp-rpc-v2@18.1.2";

const runtimeRunObjectSchema = z.object({
  id: uuid,
  kind: z.enum(runtimeRunKinds),
  scope: executionScopeSchema,
  runtimeProfile: runtimeProfileSnapshotSchema,
  goalRunId: uuid.nullable(),
  taskId: uuid.nullable(),
  agentId: uuid,
  agentRevision: z.number().int().positive(),
  roleId: uuid.nullable(),
  roleRevision: z.number().int().positive().nullable(),
  state: z.enum(runtimeRunStates),
  attempt: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(500),
  evidenceIds: z.array(uuid).max(100),
  queuedAt: timestamp,
  startedAt: timestamp.nullable(),
  completedAt: timestamp.nullable(),
  expiresAt: timestamp.nullable(),
  errorCode: z.string().trim().min(1).max(120).nullable(),
  runtimeVersion: z.string().trim().min(1).max(120).nullable(),
  providerSessionId: z.string().trim().min(1).max(500).nullable(),
  leaseId: uuid.nullable(),
  revision: z.number().int().positive(),
  heartbeatAt: timestamp.nullable(),
  eventCursor: z.number().int().nonnegative(),
  pausedAt: timestamp.nullable(),
  updatedAt: timestamp
}).strict().superRefine((value, context) => {
  const terminal = terminalRunStates.has(value.state);
  if (terminal !== (value.completedAt !== null)) {
    context.addIssue({
      code: "custom",
      path: ["completedAt"],
      message: "Runtime terminal states require completedAt and non-terminal states forbid it."
    });
  }
  if (value.state === "failed" && value.errorCode === null) {
    context.addIssue({ code: "custom", path: ["errorCode"], message: "Failed runtime runs require an error code." });
  }
  if (!terminal && value.expiresAt === null) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "Active runtime runs require an expiry." });
  }
  if (value.expiresAt !== null && Date.parse(value.expiresAt) <= Date.parse(value.queuedAt)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "Runtime run expiry must be after queuedAt." });
  }
  if (value.state === "paused" && value.pausedAt === null) {
    context.addIssue({ code: "custom", path: ["pausedAt"], message: "Paused runtime runs require pausedAt." });
  }
  if (value.state !== "paused" && value.pausedAt !== null) {
    context.addIssue({ code: "custom", path: ["pausedAt"], message: "Only paused runtime runs may retain pausedAt." });
  }
  if (value.errorCode === "provider_outcome_unknown" && value.state !== "paused") {
    context.addIssue({ code: "custom", path: ["errorCode"], message: "Unknown provider outcomes must fail closed as paused runs." });
  }
  if (value.runtimeProfile.harnessKind === "pi") {
    if (value.kind !== "task_agent" || value.scope.kind !== "task_attempt") {
      context.addIssue({ code: "custom", path: ["kind"], message: "OMP pi runs are restricted to task_agent isolated execution." });
    }
    if (value.goalRunId === null || value.taskId === null || value.taskId !== value.scope.subjectId) {
      context.addIssue({ code: "custom", path: ["taskId"], message: "OMP runs require immutable Goal and Task bindings." });
    }
    if (value.runtimeVersion !== ompRuntimeVersion) {
      context.addIssue({ code: "custom", path: ["runtimeVersion"], message: `OMP runs require ${ompRuntimeVersion}.` });
    }
  }
});

export const runtimeRunSchema = z.preprocess((input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const value = input as Record<string, unknown>;
  const queuedAt = typeof value.queuedAt === "string" ? value.queuedAt : new Date(0).toISOString();
  const harnessKind = value.runtimeProfile && typeof value.runtimeProfile === "object"
    ? (value.runtimeProfile as Record<string, unknown>).harnessKind
    : null;
  return {
    ...value,
    goalRunId: value.goalRunId ?? null,
    taskId: value.taskId ?? (value.scope && typeof value.scope === "object"
      && (value.scope as Record<string, unknown>).kind === "task_attempt"
      ? (value.scope as Record<string, unknown>).subjectId ?? null
      : null),
    runtimeVersion: value.runtimeVersion ?? (harnessKind === "pi" ? ompRuntimeVersion : null),
    providerSessionId: value.providerSessionId ?? null,
    leaseId: value.leaseId ?? null,
    revision: value.revision ?? 1,
    heartbeatAt: value.heartbeatAt ?? null,
    eventCursor: value.eventCursor ?? 0,
    pausedAt: value.pausedAt ?? null,
    updatedAt: value.updatedAt ?? queuedAt
  };
}, runtimeRunObjectSchema);

export const runtimeRunUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative()
}).strict();

export const runtimeRunEventSchema = z.object({
  id: uuid,
  runtimeRunId: uuid,
  sequence: z.number().int().positive(),
  type: z.enum(runtimeRunEventTypes),
  phase: z.enum(runtimeRunPhases),
  summary: z.string().trim().min(1).max(1_000),
  toolName: z.string().trim().min(1).max(200).nullable(),
  progressPercent: z.number().int().min(0).max(100).nullable(),
  usage: runtimeRunUsageSchema.nullable(),
  errorCode: z.string().trim().min(1).max(120).nullable(),
  actorType: z.enum(["owner", "system", "runtime"]),
  occurredAt: timestamp
}).strict();

export const runtimeRunControlSchema = z.object({
  expectedRevision: z.number().int().positive()
}).strict();

export const runtimeRunSteerSchema = runtimeRunControlSchema.extend({
  message: z.string().trim().min(1).max(4_000)
}).strict();

export const runtimeControlJobDataSchema = z.object({
  runtimeRunId: uuid,
  action: z.enum(runtimeControlActions),
  commandRevision: z.number().int().positive(),
  message: z.string().trim().min(1).max(4_000).optional(),
  requestedBy: z.literal("owner")
}).strict().superRefine((value, context) => {
  if ((value.action === "steer") !== (value.message !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["message"],
      message: "Only steer commands require an Owner message."
    });
  }
});

export const runtimeReconcileJobDataSchema = z.object({
  runtimeRunId: uuid,
  taskAgentJobId: z.string().trim().min(1).max(500),
  pollAttempt: z.number().int().nonnegative().max(10_000),
  requestedBy: z.literal("system")
}).strict();

const imageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const allowlistedHostSchema = z.string().trim().toLowerCase()
  .regex(/^(?=.{1,253}$)(?!localhost$)(?!\d{1,3}(?:\.\d{1,3}){3}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, "A DNS host name is required.");

export const sandboxLeaseSchema = z.object({
  id: uuid,
  scopeId: z.string().trim().min(1).max(500),
  backend: z.enum(sandboxBackends),
  instanceId: z.string().trim().min(1).max(200),
  state: z.enum(sandboxLeaseStates),
  imageDigest: imageDigestSchema,
  cpuLimit: z.number().positive().max(16),
  memoryMb: z.number().int().min(128).max(65_536),
  diskMb: z.number().int().min(128).max(262_144),
  processLimit: z.number().int().min(1).max(4_096),
  networkPolicy: z.enum(sandboxNetworkPolicies),
  allowlistedHosts: z.array(allowlistedHostSchema).max(100),
  createdAt: timestamp,
  lastUsedAt: timestamp,
  expiresAt: timestamp,
  destroyedAt: timestamp.nullable(),
  checkpointRef: z.string().trim().min(1).max(500).nullable()
}).strict().superRefine((value, context) => {
  if (new Set(value.allowlistedHosts).size !== value.allowlistedHosts.length) {
    context.addIssue({ code: "custom", path: ["allowlistedHosts"], message: "Allowlisted hosts must be unique." });
  }
  if (value.networkPolicy === "deny_all" && value.allowlistedHosts.length > 0) {
    context.addIssue({ code: "custom", path: ["allowlistedHosts"], message: "deny_all cannot include an allowed host." });
  }
  if (value.networkPolicy === "allowlist" && value.allowlistedHosts.length === 0) {
    context.addIssue({ code: "custom", path: ["allowlistedHosts"], message: "allowlist requires at least one host." });
  }
  if (value.state === "destroyed" && value.destroyedAt === null) {
    context.addIssue({ code: "custom", path: ["destroyedAt"], message: "Destroyed leases require destroyedAt." });
  }
});

export type RuntimeProfile = z.infer<typeof runtimeProfileSchema>;
export type CreateRuntimeProfileInput = z.infer<typeof createRuntimeProfileSchema>;
export type UpdateRuntimeProfileInput = z.infer<typeof updateRuntimeProfileSchema>;
export type RuntimeProfileSnapshot = z.infer<typeof runtimeProfileSnapshotSchema>;
export type RuntimeProfileBinding = z.infer<typeof runtimeProfileBindingSchema>;
export type RuntimeProfileRevision = z.infer<typeof runtimeProfileRevisionSchema>;
export type ExecutionScope = z.infer<typeof executionScopeSchema>;
export type RuntimeRun = z.infer<typeof runtimeRunSchema>;
export type RuntimeRunEvent = z.infer<typeof runtimeRunEventSchema>;
export type RuntimeRunUsage = z.infer<typeof runtimeRunUsageSchema>;
export type RuntimeRunControlInput = z.infer<typeof runtimeRunControlSchema>;
export type RuntimeRunSteerInput = z.infer<typeof runtimeRunSteerSchema>;
export type RuntimeControlJobData = z.infer<typeof runtimeControlJobDataSchema>;
export type RuntimeReconcileJobData = z.infer<typeof runtimeReconcileJobDataSchema>;
export type SandboxLease = z.infer<typeof sandboxLeaseSchema>;

export function createRuntimeProfileRevision(
  profile: RuntimeProfile,
  source: RuntimeProfileRevisionSource,
  recordedAt = new Date().toISOString()
): RuntimeProfileRevision {
  return {
    profileId: profile.id,
    revision: profile.revision,
    name: profile.name,
    harnessKind: profile.harnessKind,
    modelConnectorId: profile.modelConnectorId,
    sandboxProfileId: profile.sandboxProfileId,
    policy: profile.policy,
    capabilities: [...profile.capabilities],
    timeoutMs: profile.timeoutMs,
    maxConcurrency: profile.maxConcurrency,
    enabled: profile.enabled,
    source,
    recordedAt
  };
}

export function createRuntimeProfileSnapshot(profile: RuntimeProfileRevision): RuntimeProfileSnapshot {
  return {
    profileId: profile.profileId,
    revision: profile.revision,
    harnessKind: profile.harnessKind,
    modelConnectorId: profile.modelConnectorId,
    sandboxProfileId: profile.sandboxProfileId,
    policy: profile.policy,
    capabilities: [...profile.capabilities],
    timeoutMs: profile.timeoutMs,
    maxConcurrency: profile.maxConcurrency
  };
}
