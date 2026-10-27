import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { type IncomingMessage } from "node:http";
import { z } from "zod";
import { ToolPackRegistry, type RegisteredToolDefinition, type RegisteredToolPackManifest } from "./tool-pack-registry.js";
import {
  ensureWorkspacePath,
  normalizeWorkspaceSubpath,
  removeWorkspacePath,
  validateExistingWorkspacePath
} from "./workspace-paths.js";

const timestampSchema = z.string().datetime({ offset: true });
const sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const createLeaseRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(500),
  scopeId: z.string().trim().min(1).max(500),
  workspaceSubpath: z.string().trim().min(1).max(500),
  imageDigest: sha256DigestSchema,
  cpuLimit: z.number().positive().max(16),
  memoryMb: z.number().int().min(128).max(65_536),
  diskMb: z.number().int().min(128).max(262_144),
  processLimit: z.number().int().min(1).max(4_096),
  ttlMs: z.number().int().min(1_000).max(900_000),
  networkPolicy: z.enum(["deny_all", "allowlist"]).default("deny_all"),
  allowlistedHosts: z.array(z.string().trim().min(1).max(253)).max(100).default([])
}).strict();

const executeToolRequestSchema = z.object({
  leaseId: z.string().uuid(),
  idempotencyKey: z.string().trim().min(1).max(500),
  toolPackId: z.string().trim().min(1).max(120),
  toolName: z.string().trim().min(1).max(120),
  argv: z.array(z.string().max(500)).max(32).default([]),
  env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(8_192)).default({}),
  stdin: z.string().max(32_768).optional(),
  timeoutMs: z.number().int().min(50).max(300_000).optional()
}).strict();

export interface SandboxLease {
  id: string;
  scopeId: string;
  backend: "external";
  instanceId: string;
  state: "provisioning" | "active" | "idle" | "snapshotting" | "destroyed" | "error";
  imageDigest: string;
  cpuLimit: number;
  memoryMb: number;
  diskMb: number;
  processLimit: number;
  networkPolicy: "deny_all" | "allowlist";
  allowlistedHosts: string[];
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  destroyedAt: string | null;
  checkpointRef: string | null;
}

export interface LeaseView {
  created: boolean;
  lease: SandboxLease;
  scopeId: string;
  workspacePath: string;
}

export interface ChildRunEvidence {
  replayed: boolean;
  leaseId: string;
  scopeId: string;
  toolPack: {
    id: string;
    version: string;
    digest: string;
    reference: string;
    executableDigest: string;
  };
  tool: {
    name: string;
    argv: string[];
  };
  exit: {
    code: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
  };
  timing: {
    startedAt: string;
    completedAt: string;
    durationMs: number;
  };
  output: {
    stdoutText: string;
    stderrText: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    outputDigest: string;
  };
}

export interface SandboxBrokerConfig {
  workspaceRoot: string;
  toolPackRegistry: ToolPackRegistry;
  authToken: string;
  now?: () => Date;
  authorizeSourceAddress?: (address: string | undefined, request: { method: string; path: string }) => boolean;
  maxConcurrentProcesses?: number;
  stdinMaxBytes?: number;
  stdoutMaxBytes?: number;
  stderrMaxBytes?: number;
  terminationGraceMs?: number;
  maxExecutionTimeoutMs?: number;
  executionIsolationAttested?: boolean;
  maxLeaseRecords?: number;
  maxRunsPerLease?: number;
}

interface LeaseRecord {
  lease: SandboxLease;
  scopeId: string;
  workspacePath: string;
  idempotencyKey: string;
  createFingerprint: string;
  runsByKey: Map<string, { fingerprint: string; evidence: ChildRunEvidence }>;
  pendingRunsByKey: Map<string, { fingerprint: string; result: Promise<ChildRunEvidence> }>;
}

interface ActiveRun {
  completion: Promise<void>;
  cancel: () => Promise<void>;
}

interface CaptureResult {
  text: string;
  truncated: boolean;
}

export class BrokerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerValidationError";
  }
}

export class BrokerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerConflictError";
  }
}

export class BrokerNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerNotFoundError";
  }
}

export class BrokerPayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerPayloadTooLargeError";
  }
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256DigestOf(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function bearerTokenMatches(authorization: string, token: string): boolean {
  const presented = createHash("sha256").update(authorization).digest();
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  return timingSafeEqual(presented, expected);
}

function normalizeSourceAddress(address: string | undefined): string {
  return address?.startsWith("::ffff:") ? address.slice("::ffff:".length) : address ?? "";
}

export function exactSourceAddressAuthorizer(allowedAddresses: readonly string[]) {
  const allowed = new Set(allowedAddresses.map(normalizeSourceAddress));
  return (address: string | undefined): boolean => allowed.has(normalizeSourceAddress(address));
}

function asTimestamp(value: Date): string {
  return value.toISOString();
}

function sanitizeText(value: string, secrets: string[]): string {
  let sanitized = value;
  for (const secret of secrets) {
    if (!secret) continue;
    sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  return sanitized;
}

function buffersToDigest(stdoutText: string, stderrText: string): `sha256:${string}` {
  return sha256DigestOf(`${stdoutText}\n---stderr---\n${stderrText}`);
}

async function terminateChild(
  child: ReturnType<typeof spawn>,
  graceMs: number
): Promise<NodeJS.Signals> {
  const waitForExit = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  };

  if (child.exitCode !== null || child.signalCode !== null) {
    return (child.signalCode ?? "SIGTERM") as NodeJS.Signals;
  }

  const signalTree = (signal: NodeJS.Signals): void => {
    if (process.platform !== "win32" && child.pid !== undefined) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    child.kill(signal);
  };

  signalTree("SIGTERM");
  const exitedAfterTerm = await Promise.race([
    waitForExit().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs))
  ]);
  if (exitedAfterTerm) return "SIGTERM";

  signalTree("SIGKILL");
  await waitForExit();
  return "SIGKILL";
}

async function captureStream(
  stream: NodeJS.ReadableStream | null,
  maxBytes: number,
  onOverflow: () => void
): Promise<CaptureResult> {
  if (stream === null) return { text: "", truncated: false };

  return await new Promise<CaptureResult>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    stream.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = maxBytes - size;
      if (remaining > 0) {
        chunks.push(buffer.subarray(0, remaining));
        size += Math.min(buffer.length, remaining);
      }
      if (buffer.length > remaining) {
        truncated = true;
        onOverflow();
      }
    });
    stream.on("error", reject);
    stream.on("end", () => resolve({
      text: Buffer.concat(chunks).toString("utf8"),
      truncated
    }));
  });
}

function exactArgvMatch(argv: string[], allowedArgvSets: string[][]): boolean {
  return allowedArgvSets.some((allowed) => allowed.length === argv.length && allowed.every((entry, index) => entry === argv[index]));
}

function runToolCommand(input: {
  lease: LeaseRecord;
  authToken: string;
  manifest: RegisteredToolPackManifest;
  tool: RegisteredToolDefinition;
  argv: string[];
  env: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  stdinMaxBytes: number;
  stdoutMaxBytes: number;
  stderrMaxBytes: number;
  terminationGraceMs: number;
}): { completion: Promise<ChildRunEvidence>; cancel: () => Promise<void> } {
  if (!exactArgvMatch(input.argv, input.tool.allowedArgvSets)) {
    throw new BrokerValidationError(`Arguments are not allowed for tool ${input.tool.name}.`);
  }
  if (input.stdin !== undefined && !input.tool.allowStdin) {
    throw new BrokerValidationError(`stdin is not allowed for tool ${input.tool.name}.`);
  }
  if (Buffer.byteLength(input.stdin ?? "", "utf8") > input.stdinMaxBytes) {
    throw new BrokerValidationError("stdin exceeds the configured byte limit.");
  }

  const env = Object.fromEntries(Object.entries(input.env).filter(([key]) => input.tool.envAllowlist.includes(key)));
  const unexpectedEnv = Object.keys(input.env).filter((key) => !input.tool.envAllowlist.includes(key));
  if (unexpectedEnv.length > 0) {
    throw new BrokerValidationError(`Environment keys are not allowed: ${unexpectedEnv.join(", ")}`);
  }

  const secrets = [input.authToken, ...Object.values(env)];
  const startedAtDate = new Date();
  let timedOut = false;
  let overflowed = false;

  const child = spawn(input.manifest.executableRealPath, [...input.tool.baseArgs, ...input.argv], {
    cwd: input.lease.workspacePath,
    env,
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });

  const cancel = async () => {
    await terminateChild(child, input.terminationGraceMs);
  };

  const stdoutPromise = captureStream(child.stdout, input.stdoutMaxBytes, () => {
    overflowed = true;
    void cancel();
  });
  const stderrPromise = captureStream(child.stderr, input.stderrMaxBytes, () => {
    overflowed = true;
    void cancel();
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    void cancel();
  }, input.timeoutMs);

  if (input.stdin !== undefined) {
    child.stdin.write(input.stdin);
  }
  child.stdin.end();

  return {
    completion: (async () => {
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });

      clearTimeout(timeout);
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      const completedAtDate = new Date();
      const stdoutText = sanitizeText(stdout.text, secrets);
      const stderrText = sanitizeText(stderr.text, secrets);

      return {
        replayed: false,
        leaseId: input.lease.lease.id,
        scopeId: input.lease.scopeId,
        toolPack: {
          id: input.manifest.id,
          version: input.manifest.version,
          digest: input.manifest.digest,
          reference: input.manifest.reference,
          executableDigest: input.manifest.executableDigest
        },
        tool: {
          name: input.tool.name,
          argv: [...input.argv]
        },
        exit: {
          code: exit.code,
          signal: exit.signal,
          timedOut: timedOut || overflowed
        },
        timing: {
          startedAt: asTimestamp(startedAtDate),
          completedAt: asTimestamp(completedAtDate),
          durationMs: completedAtDate.getTime() - startedAtDate.getTime()
        },
        output: {
          stdoutText,
          stderrText,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          outputDigest: buffersToDigest(stdoutText, stderrText)
        }
      };
    })(),
    cancel
  };
}

export interface SandboxBroker {
  readonly authToken: string;
  readonly executionIsolationAttested: boolean;
  readonly authorizeSourceAddress: (address: string | undefined, request: { method: string; path: string }) => boolean;
  createLease(input: z.input<typeof createLeaseRequestSchema>): Promise<LeaseView>;
  getLease(leaseId: string): Promise<LeaseView | null>;
  destroyLease(leaseId: string): Promise<LeaseView>;
  reconcileLeases(): Promise<{ destroyedLeaseIds: string[] }>;
  executeTool(input: z.input<typeof executeToolRequestSchema>): Promise<ChildRunEvidence>;
}

export async function createSandboxBroker(config: SandboxBrokerConfig): Promise<SandboxBroker> {
  const now = config.now ?? (() => new Date());
  const authorizeSourceAddress = config.authorizeSourceAddress ?? exactSourceAddressAuthorizer(["127.0.0.1", "::1"]);
  const maxConcurrentProcesses = config.maxConcurrentProcesses ?? 8;
  const stdinMaxBytes = config.stdinMaxBytes ?? 32_768;
  const stdoutMaxBytes = config.stdoutMaxBytes ?? 65_536;
  const stderrMaxBytes = config.stderrMaxBytes ?? 65_536;
  const terminationGraceMs = config.terminationGraceMs ?? 250;
  const maxExecutionTimeoutMs = config.maxExecutionTimeoutMs ?? 300_000;
  const executionIsolationAttested = config.executionIsolationAttested === true;
  const maxLeaseRecords = config.maxLeaseRecords ?? 1_024;
  const maxRunsPerLease = config.maxRunsPerLease ?? 256;
  if (!Number.isInteger(maxLeaseRecords) || maxLeaseRecords < 1 || maxLeaseRecords > 100_000) {
    throw new BrokerValidationError("Lease record limit must be between 1 and 100000.");
  }
  if (!Number.isInteger(maxRunsPerLease) || maxRunsPerLease < 1 || maxRunsPerLease > 10_000) {
    throw new BrokerValidationError("Run replay limit must be between 1 and 10000.");
  }

  const leaseRecords = new Map<string, LeaseRecord>();
  const createKeyIndex = new Map<string, string>();
  const workspaceKeyIndex = new Map<string, string>();
  const pendingLeaseCreates = new Map<string, { fingerprint: string; workspaceKey: string; result: Promise<LeaseView> }>();
  const pendingWorkspaceKeys = new Set<string>();
  const activeRuns = new Map<string, Set<ActiveRun>>();
  const activeRunCounts = new Map<string, number>();
  let globalActiveRunCount = 0;

  async function removeLeaseWorkspace(record: LeaseRecord): Promise<void> {
    await removeWorkspacePath(config.workspaceRoot, record.workspacePath);
  }

  async function cancelActiveLeaseRuns(leaseId: string): Promise<void> {
    const runs = [...(activeRuns.get(leaseId) ?? new Set())];
    await Promise.all(runs.map(async (run) => {
      await run.cancel();
      await run.completion.catch(() => undefined);
    }));
  }

  async function destroyRecord(record: LeaseRecord, destroyedAt: Date): Promise<LeaseRecord> {
    if (record.lease.state === "destroyed") return record;
    await cancelActiveLeaseRuns(record.lease.id);
    await removeLeaseWorkspace(record);
    record.lease.state = "destroyed";
    record.lease.destroyedAt = asTimestamp(destroyedAt);
    record.lease.lastUsedAt = record.lease.destroyedAt;
    return record;
  }

  async function expireLeaseIfNeeded(record: LeaseRecord | undefined): Promise<LeaseRecord | undefined> {
    if (!record) return undefined;
    if (record.lease.state === "destroyed") return record;
    if (new Date(record.lease.expiresAt).getTime() > now().getTime()) return record;
    return destroyRecord(record, now());
  }

  function toLeaseView(record: LeaseRecord, created: boolean): LeaseView {
    return {
      created,
      lease: { ...record.lease, allowlistedHosts: [...record.lease.allowlistedHosts] },
      scopeId: record.scopeId,
      workspacePath: record.workspacePath
    };
  }

  return {
    authToken: config.authToken,
    executionIsolationAttested,
    authorizeSourceAddress,
    async createLease(input) {
      const parsed = createLeaseRequestSchema.parse(input);
      if (parsed.networkPolicy !== "deny_all" || parsed.allowlistedHosts.length > 0) {
        throw new BrokerValidationError("Allowlist egress is unavailable until a real egress enforcer is configured.");
      }

      const createFingerprint = canonicalize({ ...parsed, idempotencyKey: undefined });
      const workspaceKey = normalizeWorkspaceSubpath(parsed.workspaceSubpath);
      const existingLeaseId = createKeyIndex.get(parsed.idempotencyKey);
      if (existingLeaseId) {
        const existingRecord = await expireLeaseIfNeeded(leaseRecords.get(existingLeaseId));
        if (!existingRecord) throw new BrokerNotFoundError(`Lease not found for idempotency key ${parsed.idempotencyKey}`);
        if (existingRecord.createFingerprint !== createFingerprint) {
          throw new BrokerConflictError("Idempotency key already belongs to a different lease request.");
        }
        return toLeaseView(existingRecord, false);
      }
      const pending = pendingLeaseCreates.get(parsed.idempotencyKey);
      if (pending) {
        if (pending.fingerprint !== createFingerprint) {
          throw new BrokerConflictError("Idempotency key already belongs to a different pending lease request.");
        }
        return { ...(await pending.result), created: false };
      }
      if (workspaceKeyIndex.has(workspaceKey) || pendingWorkspaceKeys.has(workspaceKey)) {
        throw new BrokerConflictError("Workspace path already belongs to another lease.");
      }
      if (leaseRecords.size + pendingLeaseCreates.size >= maxLeaseRecords) {
        throw new BrokerConflictError("Sandbox broker lease record limit reached.");
      }

      const result = (async (): Promise<LeaseView> => {
        const createdAt = now();
        const workspace = await ensureWorkspacePath(config.workspaceRoot, workspaceKey);
        const leaseId = randomUUID();
        const lease: SandboxLease = {
          id: leaseId,
          scopeId: parsed.scopeId,
          backend: "external",
          instanceId: `sandbox-${leaseId}`,
          state: "active",
          imageDigest: parsed.imageDigest,
          cpuLimit: parsed.cpuLimit,
          memoryMb: parsed.memoryMb,
          diskMb: parsed.diskMb,
          processLimit: parsed.processLimit,
          networkPolicy: "deny_all",
          allowlistedHosts: [],
          createdAt: asTimestamp(createdAt),
          lastUsedAt: asTimestamp(createdAt),
          expiresAt: asTimestamp(new Date(createdAt.getTime() + parsed.ttlMs)),
          destroyedAt: null,
          checkpointRef: null
        };
        const record: LeaseRecord = {
          lease,
          scopeId: parsed.scopeId,
          workspacePath: workspace.path,
          idempotencyKey: parsed.idempotencyKey,
          createFingerprint,
          runsByKey: new Map(),
          pendingRunsByKey: new Map()
        };
        leaseRecords.set(leaseId, record);
        createKeyIndex.set(parsed.idempotencyKey, leaseId);
        workspaceKeyIndex.set(workspaceKey, leaseId);
        return toLeaseView(record, true);
      })();
      pendingLeaseCreates.set(parsed.idempotencyKey, { fingerprint: createFingerprint, workspaceKey, result });
      pendingWorkspaceKeys.add(workspaceKey);
      try {
        return await result;
      } finally {
        pendingLeaseCreates.delete(parsed.idempotencyKey);
        pendingWorkspaceKeys.delete(workspaceKey);
      }
    },

    async getLease(leaseId) {
      const record = await expireLeaseIfNeeded(leaseRecords.get(leaseId));
      if (!record) return null;
      return toLeaseView(record, false);
    },

    async destroyLease(leaseId) {
      const record = await expireLeaseIfNeeded(leaseRecords.get(leaseId));
      if (!record) throw new BrokerNotFoundError(`Lease not found: ${leaseId}`);
      await destroyRecord(record, now());
      return toLeaseView(record, false);
    },

    async reconcileLeases() {
      const destroyedLeaseIds: string[] = [];
      for (const record of leaseRecords.values()) {
        if (record.lease.state !== "destroyed" && new Date(record.lease.expiresAt).getTime() <= now().getTime()) {
          await destroyRecord(record, now());
          destroyedLeaseIds.push(record.lease.id);
        }
      }
      return { destroyedLeaseIds };
    },

    async executeTool(input) {
      const parsed = executeToolRequestSchema.parse(input);
      if (!executionIsolationAttested) {
        throw new BrokerValidationError("OS-level execution isolation has not been attested for this broker deployment.");
      }
      const record = await expireLeaseIfNeeded(leaseRecords.get(parsed.leaseId));
      if (!record) throw new BrokerNotFoundError(`Lease not found: ${parsed.leaseId}`);
      if (record.lease.state === "destroyed") {
        throw new BrokerConflictError(`Lease is not active: ${parsed.leaseId}`);
      }

      const runFingerprint = canonicalize({ ...parsed, idempotencyKey: undefined });
      const replay = record.runsByKey.get(parsed.idempotencyKey);
      if (replay) {
        if (replay.fingerprint !== runFingerprint) {
          throw new BrokerConflictError("Idempotency key already belongs to a different run request.");
        }
        return { ...replay.evidence, replayed: true };
      }

      const pending = record.pendingRunsByKey.get(parsed.idempotencyKey);
      if (pending) {
        if (pending.fingerprint !== runFingerprint) {
          throw new BrokerConflictError("Idempotency key already belongs to a different pending run request.");
        }
        return { ...(await pending.result), replayed: true };
      }
      if (record.runsByKey.size + record.pendingRunsByKey.size >= maxRunsPerLease) {
        throw new BrokerConflictError(`Run replay record limit reached for ${record.lease.id}.`);
      }

      const result = (async (): Promise<ChildRunEvidence> => {
        await validateExistingWorkspacePath(config.workspaceRoot, record.workspacePath);
        const leaseRunCount = activeRunCounts.get(record.lease.id) ?? 0;
        if (leaseRunCount >= record.lease.processLimit) {
          throw new BrokerConflictError(`Lease concurrency limit reached for ${record.lease.id}.`);
        }
        if (globalActiveRunCount >= maxConcurrentProcesses) {
          throw new BrokerConflictError("Sandbox broker concurrency limit reached.");
        }

        activeRunCounts.set(record.lease.id, leaseRunCount + 1);
        globalActiveRunCount += 1;

        const runsForLease = activeRuns.get(record.lease.id) ?? new Set<ActiveRun>();
        let resolveTrackedCompletion!: () => void;
        let cancelRequested = false;
        let runningHandle: ReturnType<typeof runToolCommand> | undefined;
        const activeRun: ActiveRun = {
          completion: new Promise<void>((resolve) => { resolveTrackedCompletion = resolve; }),
          cancel: async () => {
            cancelRequested = true;
            if (runningHandle) await runningHandle.cancel();
          }
        };
        runsForLease.add(activeRun);
        activeRuns.set(record.lease.id, runsForLease);

        try {
          const resolved = await config.toolPackRegistry.resolveTool(parsed.toolPackId, parsed.toolName);
          await validateExistingWorkspacePath(config.workspaceRoot, record.workspacePath);
          if (record.lease.destroyedAt !== null || cancelRequested) {
            throw new BrokerConflictError(`Lease is not active: ${parsed.leaseId}`);
          }
          const timeoutMs = Math.min(parsed.timeoutMs ?? maxExecutionTimeoutMs, maxExecutionTimeoutMs);
          runningHandle = runToolCommand({
            lease: record,
            authToken: config.authToken,
            manifest: resolved.manifest,
            tool: resolved.tool,
            argv: parsed.argv,
            env: parsed.env,
            timeoutMs,
            stdinMaxBytes,
            stdoutMaxBytes,
            stderrMaxBytes,
            terminationGraceMs,
            ...(parsed.stdin !== undefined ? { stdin: parsed.stdin } : {})
          });
          if (cancelRequested) await runningHandle.cancel();

          const evidence = await runningHandle.completion;
          record.lease.lastUsedAt = evidence.timing.completedAt;
          record.lease.state = "idle";
          record.runsByKey.set(parsed.idempotencyKey, { fingerprint: runFingerprint, evidence });
          return evidence;
        } finally {
          runsForLease.delete(activeRun);
          if (runsForLease.size === 0) activeRuns.delete(record.lease.id);
          const remainingLeaseRuns = (activeRunCounts.get(record.lease.id) ?? 1) - 1;
          if (remainingLeaseRuns <= 0) activeRunCounts.delete(record.lease.id);
          else activeRunCounts.set(record.lease.id, remainingLeaseRuns);
          globalActiveRunCount = Math.max(0, globalActiveRunCount - 1);
          resolveTrackedCompletion();
        }
      })();
      record.pendingRunsByKey.set(parsed.idempotencyKey, { fingerprint: runFingerprint, result });
      try {
        return await result;
      } finally {
        record.pendingRunsByKey.delete(parsed.idempotencyKey);
      }
    }
  };
}

export function requestPathname(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://sandbox-broker.local").pathname;
}

export function createHealthResponse(broker: Pick<SandboxBroker, "executionIsolationAttested">) {
  return { ok: true, ready: broker.executionIsolationAttested };
}

function publicLeaseView(view: LeaseView): Omit<LeaseView, "workspacePath"> {
  return {
    created: view.created,
    lease: view.lease,
    scopeId: view.scopeId
  };
}

export function createHttpServerForBroker(options: {
  broker: SandboxBroker;
  authToken: string;
  readBody: (request: IncomingMessage) => Promise<unknown>;
  writeJson: (statusCode: number, payload: unknown) => void;
  request: IncomingMessage;
}) {
  const { broker, authToken, readBody, writeJson, request } = options;
  const pathname = requestPathname(request);

  const requireAuth = (): boolean => {
    const authorization = request.headers.authorization ?? "";
    if (!bearerTokenMatches(authorization, authToken)) {
      writeJson(401, { error: "unauthorized" });
      return false;
    }
    if (!broker.authorizeSourceAddress(request.socket.remoteAddress, { method: request.method ?? "GET", path: pathname })) {
      writeJson(403, { error: "forbidden_source" });
      return false;
    }
    return true;
  };

  return async () => {
    try {
      if (request.method === "GET" && pathname === "/health") {
        const health = createHealthResponse(broker);
        writeJson(health.ready ? 200 : 503, health);
        return;
      }
      if (!requireAuth()) return;

      if (request.method === "POST" && pathname === "/leases") {
        const result = await broker.createLease(await readBody(request) as z.input<typeof createLeaseRequestSchema>);
        writeJson(result.created ? 201 : 200, publicLeaseView(result));
        return;
      }

      if (request.method === "POST" && pathname === "/leases/reconcile") {
        writeJson(200, await broker.reconcileLeases());
        return;
      }

      const leaseMatch = pathname.match(/^\/leases\/([0-9a-f-]{36})$/i);
      if (request.method === "GET" && leaseMatch) {
        const result = await broker.getLease(leaseMatch[1]!);
        if (!result) {
          writeJson(404, { error: "not_found" });
          return;
        }
        writeJson(200, publicLeaseView(result));
        return;
      }
      if (request.method === "DELETE" && leaseMatch) {
        writeJson(200, publicLeaseView(await broker.destroyLease(leaseMatch[1]!)));
        return;
      }

      const runMatch = pathname.match(/^\/leases\/([0-9a-f-]{36})\/runs$/i);
      if (request.method === "POST" && runMatch) {
        const body = await readBody(request);
        if (typeof body !== "object" || body === null) throw new BrokerValidationError("Request body must be an object.");
        writeJson(200, await broker.executeTool({
          ...(body as z.input<typeof executeToolRequestSchema>),
          leaseId: runMatch[1]!
        }));
        return;
      }

      writeJson(404, { error: "not_found" });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof BrokerValidationError) {
        writeJson(400, { error: "invalid_request", message: error.message });
        return;
      }
      if (error instanceof BrokerPayloadTooLargeError) {
        writeJson(413, { error: "payload_too_large", message: error.message });
        return;
      }
      if (error instanceof BrokerConflictError) {
        writeJson(409, { error: "conflict", message: error.message });
        return;
      }
      if (error instanceof BrokerNotFoundError) {
        writeJson(404, { error: "not_found", message: error.message });
        return;
      }
      writeJson(500, { error: "internal_error" });
    }
  };
}
