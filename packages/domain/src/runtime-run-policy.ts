import { createHash } from "node:crypto";
import {
  runtimeRunSchema,
  type ExecutionScope,
  type RuntimeProfileSnapshot,
  type RuntimeRun,
  type RuntimeRunKind,
  type RuntimeRunState
} from "@council/contracts";

const MAX_QUEUE_TTL_MS = 12 * 60 * 60 * 1_000;
const MAX_SHORT_RUNTIME_TTL_MS = 30 * 60 * 1_000;
const MIN_QUEUE_TTL_MS = 5 * 60 * 1_000;

export class RuntimeRunAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeRunAdmissionError";
  }
}

export interface RuntimeRunBinding {
  kind: RuntimeRunKind;
  scope: ExecutionScope;
  runtimeProfile: RuntimeProfileSnapshot;
  agentId: string;
  agentRevision: number;
  roleId: string | null;
  roleRevision: number | null;
  idempotencyKey: string;
  goalRunId?: string | null;
  taskId?: string | null;
  runtimeVersion?: string | null;
}

export interface RuntimeRunMutation {
  expectedRevision: number;
  state: RuntimeRunState;
  providerSessionId?: string;
  leaseId?: string;
  heartbeatAt?: string | null;
  eventCursor?: number;
  evidenceIds?: string[];
  errorCode?: string | null;
  startedAt?: string | null;
  expiresAt?: string | null;
  at?: string;
}

const runtimeRunTransitions: Readonly<Record<RuntimeRunState, ReadonlySet<RuntimeRunState>>> = {
  queued: new Set(["provisioning", "running", "paused", "failed", "cancelled", "expired"]),
  provisioning: new Set(["provisioning", "ready", "paused", "failed", "cancelled", "expired"]),
  ready: new Set(["ready", "running", "paused", "cancelled", "expired"]),
  running: new Set(["running", "awaiting_approval", "paused", "completed", "failed", "cancelled", "expired"]),
  awaiting_approval: new Set(["awaiting_approval", "running", "paused", "cancelled", "expired"]),
  paused: new Set(["paused", "provisioning", "ready", "running", "cancelled", "failed", "expired"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  expired: new Set()
};

export function runtimeRunQueueTtlMs(
  profile: Pick<RuntimeProfileSnapshot, "timeoutMs"> & Partial<Pick<RuntimeProfileSnapshot, "harnessKind">>
): number {
  const harnessKind = profile.harnessKind ?? null;
  return harnessKind === "pi"
    ? Math.min(MAX_QUEUE_TTL_MS, Math.max(30 * 60 * 1_000, profile.timeoutMs))
    : Math.min(MAX_SHORT_RUNTIME_TTL_MS, Math.max(MIN_QUEUE_TTL_MS, profile.timeoutMs * 2));
}

export function stableRuntimeRunId(idempotencyKey: string): string {
  const bytes = Buffer.from(createHash("sha256").update(`runtime-run:${idempotencyKey}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createQueuedRuntimeRun(input: RuntimeRunBinding & {
  id: string;
  attempt: number;
  queuedAt: string;
  ttlMs: number;
}): RuntimeRun {
  const maxTtlMs = input.runtimeProfile.harnessKind === "pi"
    ? MAX_QUEUE_TTL_MS
    : MAX_SHORT_RUNTIME_TTL_MS;
  if (!Number.isInteger(input.ttlMs) || input.ttlMs < 1_000 || input.ttlMs > maxTtlMs) {
    throw new RuntimeRunAdmissionError(`Runtime Run TTL must be between 1000 and ${maxTtlMs}ms.`);
  }
  const queuedAt = Date.parse(input.queuedAt);
  if (!Number.isFinite(queuedAt)) throw new RuntimeRunAdmissionError("Runtime Run queuedAt is invalid.");
  return runtimeRunSchema.parse({
    id: input.id,
    kind: input.kind,
    scope: input.scope,
    runtimeProfile: input.runtimeProfile,
    goalRunId: input.goalRunId ?? null,
    taskId: input.taskId ?? (input.scope.kind === "task_attempt" ? input.scope.subjectId : null),
    agentId: input.agentId,
    agentRevision: input.agentRevision,
    roleId: input.roleId,
    roleRevision: input.roleRevision,
    state: "queued",
    attempt: input.attempt,
    idempotencyKey: input.idempotencyKey,
    evidenceIds: [],
    queuedAt: input.queuedAt,
    startedAt: null,
    completedAt: null,
    expiresAt: new Date(queuedAt + input.ttlMs).toISOString(),
    errorCode: null,
    runtimeVersion: input.runtimeVersion ?? null
  });
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

export function validateQueuedRuntimeRun(
  run: RuntimeRun,
  expected: RuntimeRunBinding,
  at = new Date().toISOString()
): RuntimeRun {
  const parsed = runtimeRunSchema.safeParse(run);
  if (!parsed.success || parsed.data.state !== "queued" || parsed.data.expiresAt === null) {
    throw new RuntimeRunAdmissionError("Runtime Run is not an admissible queued run.");
  }
  if (Date.parse(at) >= Date.parse(parsed.data.expiresAt)) {
    throw new RuntimeRunAdmissionError("Runtime Run has expired.");
  }
  const actual: RuntimeRunBinding = {
    kind: parsed.data.kind,
    scope: parsed.data.scope,
    runtimeProfile: parsed.data.runtimeProfile,
    agentId: parsed.data.agentId,
    agentRevision: parsed.data.agentRevision,
    roleId: parsed.data.roleId,
    roleRevision: parsed.data.roleRevision,
    idempotencyKey: parsed.data.idempotencyKey,
    goalRunId: parsed.data.goalRunId,
    taskId: parsed.data.taskId,
    runtimeVersion: parsed.data.runtimeVersion
  };
  const normalizedExpected: RuntimeRunBinding = {
    ...expected,
    goalRunId: expected.goalRunId ?? null,
    taskId: expected.taskId ?? (expected.scope.kind === "task_attempt" ? expected.scope.subjectId : null),
    runtimeVersion: expected.runtimeVersion ?? null
  };
  if (canonical(actual) !== canonical(normalizedExpected)) {
    throw new RuntimeRunAdmissionError("Runtime Run binding does not match the queued action.");
  }
  return parsed.data;
}

function immutableProviderBinding(
  label: "Session" | "Lease",
  current: string | null,
  requested: string | undefined
): string | null {
  if (requested === undefined) return current;
  if (current !== null && requested !== current) {
    throw new RuntimeRunAdmissionError(`Runtime Run ${label} binding is immutable.`);
  }
  return requested;
}

export function applyRuntimeRunMutation(run: RuntimeRun, input: RuntimeRunMutation): RuntimeRun {
  const current = runtimeRunSchema.parse(run);
  if (current.revision !== input.expectedRevision) {
    throw new RuntimeRunAdmissionError("Runtime Run revision changed.");
  }
  if (!runtimeRunTransitions[current.state].has(input.state)) {
    throw new RuntimeRunAdmissionError(`Runtime Run transition ${current.state} -> ${input.state} is not allowed.`);
  }
  if (current.runtimeProfile.harnessKind === "pi" && current.state === "queued" && input.state === "running") {
    throw new RuntimeRunAdmissionError("OMP Runtime Runs must pass through provisioning and ready before running.");
  }
  const at = input.at ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) {
    throw new RuntimeRunAdmissionError("Runtime Run mutation time must be a canonical ISO timestamp.");
  }
  if (input.eventCursor !== undefined
    && (!Number.isSafeInteger(input.eventCursor) || input.eventCursor < current.eventCursor)) {
    throw new RuntimeRunAdmissionError("Runtime Run event cursor cannot move backwards.");
  }

  const terminal = ["completed", "failed", "cancelled", "expired"].includes(input.state);
  const errorCode = input.errorCode !== undefined
    ? input.errorCode
    : current.errorCode === "provider_outcome_unknown" && input.state !== "paused"
      ? null
      : current.errorCode;
  const next = {
    ...current,
    state: input.state,
    providerSessionId: immutableProviderBinding("Session", current.providerSessionId, input.providerSessionId),
    leaseId: immutableProviderBinding("Lease", current.leaseId, input.leaseId),
    heartbeatAt: input.heartbeatAt === undefined ? current.heartbeatAt : input.heartbeatAt,
    eventCursor: input.eventCursor ?? current.eventCursor,
    evidenceIds: input.evidenceIds === undefined ? current.evidenceIds : [...input.evidenceIds],
    errorCode,
    startedAt: input.startedAt === undefined
      ? (input.state === "running" && current.startedAt === null ? at : current.startedAt)
      : input.startedAt,
    completedAt: terminal ? at : null,
    expiresAt: terminal ? null : (input.expiresAt === undefined ? current.expiresAt : input.expiresAt),
    pausedAt: input.state === "paused" ? (current.pausedAt ?? at) : null,
    revision: current.revision + 1,
    updatedAt: at
  };
  return runtimeRunSchema.parse(next);
}
