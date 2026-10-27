import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join, posix, resolve, sep } from "node:path";
import {
  ompBrokerControlRequestSchema,
  ompBrokerEventSchema,
  ompBrokerSessionSchema,
  ompBrokerStartRequestSchema,
  type OmpBrokerArtifactManifest,
  type OmpBrokerControlRequest,
  type OmpBrokerEvent,
  type OmpBrokerHealth,
  type OmpBrokerSession,
  type OmpBrokerStartRequest
} from "@council/contracts";
import {
  OMP_RPC_RUNTIME_VERSION,
  OmpProviderOutcomeUnknownError,
  OmpPromptAbortedError,
  OmpRpcHarness,
  OmpRpcProtocolError,
  type OmpRpcEvent
} from "@council/runtime";

export const OMP_PROVIDER_SESSION_ROOT = "/opt/council-omp-config/sessions";

export interface OmpContainerExit {
  exitCode: number | null;
  signal: string | null;
}

export interface OmpContainerHandle {
  containerId: string;
  stdoutLines: AsyncIterable<string | Uint8Array>;
  completion: Promise<OmpContainerExit>;
  writeLine(line: string): Promise<void>;
  terminate(): Promise<void>;
}

export interface OmpContainerStartInput {
  runtimeRunId: string;
  imageDigest: string;
  workspacePath: string;
  sourceArchivePath: string;
  modelBaseUrl: string;
  modelId: string;
  allowedTools: string[];
  timeoutMs: number;
  cpuLimit: number;
  memoryMb: number;
  processLimit: number;
  diskMb: number;
  resumeSessionFile: string | null;
}

export interface OmpContainerRuntimeHealth {
  rootless: boolean;
  rootfulSocketAbsent: boolean;
  resourceLimitsEnforced: boolean;
  networkPolicyEnforced: boolean;
  imagePinned: boolean;
  modelGatewayReady: boolean;
}

export interface OmpContainerRuntime {
  health(): Promise<OmpContainerRuntimeHealth>;
  reconcile?(): Promise<void>;
  start(input: OmpContainerStartInput): Promise<OmpContainerHandle>;
  collectArtifacts(input: {
    runtimeRunId: string;
    workspacePath: string;
    artifactRoot: string;
  }): Promise<OmpBrokerArtifactManifest>;
}

export interface OmpRuntimeBrokerConfig {
  dataRoot: string;
  sourceRoot: string;
  runtime: OmpContainerRuntime;
  isolationAttested: boolean;
  maxConcurrency?: 1 | 2;
  cpuLimit?: number;
  memoryMb?: number;
  processLimit?: number;
  diskMb?: number;
  now?: () => Date;
}

interface ActiveSession {
  handle: OmpContainerHandle;
  harness: OmpRpcHarness;
  request: OmpBrokerStartRequest;
}

interface ControlReceipt {
  requestDigest: string;
  action: OmpBrokerControlRequest["action"];
  recordedAt: string;
}

export class OmpBrokerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OmpBrokerValidationError";
  }
}

export class OmpBrokerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OmpBrokerConflictError";
  }
}

export class OmpBrokerNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OmpBrokerNotFoundError";
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex")}`;
}

async function fileDigest(path: string): Promise<`sha256:${string}`> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

function isTerminal(state: OmpBrokerSession["state"]): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function safeChild(root: string, ...parts: string[]): string {
  const base = resolve(root);
  const candidate = resolve(base, ...parts);
  if (candidate !== base && !candidate.startsWith(`${base}${sep}`)) {
    throw new OmpBrokerValidationError("OMP Broker path escaped its configured root.");
  }
  return candidate;
}

function mapRpcEvent(event: OmpRpcEvent, sequence: number, now: string): OmpBrokerEvent {
  const progressPercent = event.type === "agent.started" ? 10
    : event.type === "agent.completed" ? 90
      : event.type === "tool.started" ? 35
        : event.type === "tool.completed" ? 65
          : null;
  return ompBrokerEventSchema.parse({
    sequence,
    kind: event.type,
    summary: event.summary,
    toolName: event.toolName,
    progressPercent,
    inputTokens: null,
    outputTokens: null,
    toolCalls: null,
    errorCode: event.type === "runtime.error" ? "omp_runtime_error" : null,
    occurredAt: now
  });
}

export interface OmpRuntimeBroker {
  health(): Promise<OmpBrokerHealth>;
  start(request: unknown): Promise<OmpBrokerSession>;
  get(runtimeRunId: string): Promise<OmpBrokerSession | null>;
  events(runtimeRunId: string, afterSequence?: number, limit?: number): Promise<OmpBrokerEvent[]>;
  control(runtimeRunId: string, request: unknown): Promise<OmpBrokerSession>;
  reconcileInterruptedSessions(): Promise<number>;
}

export async function createOmpRuntimeBroker(config: OmpRuntimeBrokerConfig): Promise<OmpRuntimeBroker> {
  const now = config.now ?? (() => new Date());
  const maxConcurrency = config.maxConcurrency ?? 1;
  const active = new Map<string, ActiveSession>();
  const reservations = new Set<string>();
  const mutations = new Map<string, Promise<void>>();
  const sessionsRoot = safeChild(config.dataRoot, "sessions");
  const runsRoot = safeChild(config.dataRoot, "runs");
  await mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
  await mkdir(runsRoot, { recursive: true, mode: 0o700 });

  const sessionDir = (id: string) => safeChild(sessionsRoot, id);
  const sessionPath = (id: string) => safeChild(sessionDir(id), "session.json");
  const requestPath = (id: string) => safeChild(sessionDir(id), "request.json");
  const eventsPath = (id: string) => safeChild(sessionDir(id), "events.ndjson");
  const controlsDir = (id: string) => safeChild(sessionDir(id), "controls");

  const serialize = async <T>(id: string, operation: () => Promise<T>): Promise<T> => {
    const previous = mutations.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const tail = previous.then(() => current);
    mutations.set(id, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (mutations.get(id) === tail) mutations.delete(id);
    }
  };

  const writeAtomic = async (path: string, value: unknown): Promise<void> => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  };

  const readSession = async (id: string): Promise<OmpBrokerSession | null> => {
    try {
      return ompBrokerSessionSchema.parse(JSON.parse(await readFile(sessionPath(id), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };

  const persistSession = async (session: OmpBrokerSession): Promise<OmpBrokerSession> => {
    const parsed = ompBrokerSessionSchema.parse(session);
    await mkdir(sessionDir(parsed.runtimeRunId), { recursive: true, mode: 0o700 });
    await writeAtomic(sessionPath(parsed.runtimeRunId), parsed);
    return parsed;
  };

  const appendEvent = async (
    id: string,
    event: Omit<OmpBrokerEvent, "sequence" | "occurredAt"> & { occurredAt?: string }
  ): Promise<OmpBrokerSession> => serialize(id, async () => {
    const session = await readSession(id);
    if (!session) throw new OmpBrokerNotFoundError("OMP Session was not found.");
    const occurredAt = event.occurredAt ?? now().toISOString();
    const parsed = ompBrokerEventSchema.parse({ ...event, sequence: session.eventCursor + 1, occurredAt });
    await appendFile(eventsPath(id), `${JSON.stringify(parsed)}\n`, { encoding: "utf8", mode: 0o600 });
    return persistSession({ ...session, eventCursor: parsed.sequence, updatedAt: occurredAt });
  });

  const setState = async (id: string, input: {
    state: OmpBrokerSession["state"];
    errorCode?: string | null;
    containerId?: string | null;
    providerSessionId?: string | null;
    providerSessionFile?: string | null;
    artifactManifest?: OmpBrokerArtifactManifest | null;
    summary: string;
    progressPercent: number | null;
  }): Promise<OmpBrokerSession> => serialize(id, async () => {
    const session = await readSession(id);
    if (!session) throw new OmpBrokerNotFoundError("OMP Session was not found.");
    const occurredAt = now().toISOString();
    const event = ompBrokerEventSchema.parse({
      sequence: session.eventCursor + 1,
      kind: "state.changed",
      summary: input.summary,
      toolName: null,
      progressPercent: input.progressPercent,
      inputTokens: null,
      outputTokens: null,
      toolCalls: null,
      errorCode: input.errorCode ?? null,
      occurredAt
    });
    await appendFile(eventsPath(id), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    return persistSession({
      ...session,
      state: input.state,
      errorCode: input.errorCode === undefined ? session.errorCode : input.errorCode,
      containerId: input.containerId === undefined ? session.containerId : input.containerId,
      providerSessionId: input.providerSessionId === undefined ? session.providerSessionId : input.providerSessionId,
      providerSessionFile: input.providerSessionFile === undefined ? session.providerSessionFile : input.providerSessionFile,
      artifactManifest: input.artifactManifest === undefined ? session.artifactManifest : input.artifactManifest,
      eventCursor: event.sequence,
      updatedAt: occurredAt
    });
  });

  const sourceArchive = async (request: OmpBrokerStartRequest): Promise<string> => {
    const source = request.executionBinding.workspaceSource!;
    const path = safeChild(config.sourceRoot, source.sourceId, `${source.archiveDigest.slice("sha256:".length)}.tar`);
    const metadata = await stat(path).catch(() => null);
    if (!metadata?.isFile()) throw new OmpBrokerValidationError("Approved OMP workspace archive is unavailable.");
    if (await fileDigest(path) !== source.archiveDigest) {
      throw new OmpBrokerValidationError("Approved OMP workspace archive digest changed.");
    }
    return path;
  };

  const sessionState = async (harness: OmpRpcHarness, request: OmpBrokerStartRequest) => {
    const state = await harness.getState();
    const sessionId = typeof state.sessionId === "string" && state.sessionId ? state.sessionId : null;
    const sessionFile = typeof state.sessionFile === "string" && state.sessionFile ? state.sessionFile : null;
    const tools = Array.isArray(state.dumpTools)
      ? state.dumpTools.flatMap((item) => item && typeof item === "object" && typeof (item as Record<string, unknown>).name === "string"
        ? [(item as Record<string, unknown>).name as string]
        : [])
      : [];
    const reportedTools = [...new Set(tools)].sort();
    const approvedTools = [...request.executionBinding.allowedTools].sort();
    const safeSessionFile = sessionFile !== null
      && posix.isAbsolute(sessionFile)
      && posix.normalize(sessionFile) === sessionFile
      && sessionFile.startsWith(`${OMP_PROVIDER_SESSION_ROOT}/`);
    if (!sessionId || !safeSessionFile || JSON.stringify(reportedTools) !== JSON.stringify(approvedTools)) {
      throw new OmpRpcProtocolError("OMP Session state violated the approved identity or tool allowlist.");
    }
    return { sessionId, sessionFile };
  };

  const failSession = async (id: string, error: unknown, promptStarted: boolean): Promise<void> => {
    const current = await readSession(id);
    if (!current || isTerminal(current.state)) return;
    const activeSession = active.get(id);
    active.delete(id);
    if (activeSession) await activeSession.handle.terminate().catch(() => undefined);
    const outcomeUnknown = promptStarted
      || error instanceof OmpProviderOutcomeUnknownError;
    await setState(id, {
      state: outcomeUnknown ? "paused" : "failed",
      errorCode: outcomeUnknown ? "provider_outcome_unknown" : "runtime_setup_failed",
      summary: outcomeUnknown
        ? "OMP transport outcome is unknown; automatic replay is fenced."
        : "OMP Session setup failed before the provider boundary.",
      progressPercent: null
    });
  };

  const runPromptToArtifacts = (
    request: OmpBrokerStartRequest,
    handle: OmpContainerHandle,
    harness: OmpRpcHarness,
    workspacePath: string,
    artifactRoot: string,
    prompt: string
  ): void => {
    void harness.prompt(prompt).then(async () => {
      const beforeCollection = await readSession(request.runtimeRunId);
      if (!beforeCollection || beforeCollection.state !== "running") return;
      const manifest = await config.runtime.collectArtifacts({
        runtimeRunId: request.runtimeRunId,
        workspacePath,
        artifactRoot
      });
      const beforeCompletion = await readSession(request.runtimeRunId);
      if (!beforeCompletion || beforeCompletion.state !== "running") return;
      await setState(request.runtimeRunId, {
        state: "completed",
        errorCode: null,
        artifactManifest: manifest,
        summary: "OMP Session completed and produced a verified artifact manifest.",
        progressPercent: 100
      });
      await handle.terminate();
      active.delete(request.runtimeRunId);
    }).catch(async (error) => {
      const current = await readSession(request.runtimeRunId);
      if (error instanceof OmpPromptAbortedError
        && current && (current.state === "paused" || current.state === "cancelled")) return;
      await failSession(request.runtimeRunId, error, true);
    });
  };

  const launch = async (request: OmpBrokerStartRequest, resumeSessionFile: string | null): Promise<OmpBrokerSession> => {
    const archive = await sourceArchive(request);
    const workspacePath = safeChild(runsRoot, request.runtimeRunId, "workspace");
    const artifactRoot = safeChild(runsRoot, request.runtimeRunId, "artifacts");
    await mkdir(workspacePath, { recursive: true, mode: 0o700 });
    await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
    let promptStarted = false;
    let handle: OmpContainerHandle | null = null;
    try {
      handle = await config.runtime.start({
        runtimeRunId: request.runtimeRunId,
        imageDigest: request.executionBinding.sandboxImageDigest!,
        workspacePath,
        sourceArchivePath: archive,
        modelBaseUrl: request.model.baseUrl,
        modelId: request.model.model,
        allowedTools: [...request.executionBinding.allowedTools],
        timeoutMs: request.executionBinding.timeoutMs,
        cpuLimit: config.cpuLimit ?? 2,
        memoryMb: config.memoryMb ?? 8_192,
        processLimit: config.processLimit ?? 256,
        diskMb: config.diskMb ?? 8_192,
        resumeSessionFile
      });
      const harness = new OmpRpcHarness({ writeLine: (line) => handle!.writeLine(line) });
      active.set(request.runtimeRunId, { handle, harness, request });
      harness.subscribe(async (event) => {
        if (event.type.startsWith("tool.") && !event.toolName) {
          throw new OmpRpcProtocolError("OMP emitted a tool event without an approved tool identity.");
        }
        if (event.toolName && !request.executionBinding.allowedTools.includes(event.toolName)) {
          throw new OmpRpcProtocolError("OMP invoked a tool outside the approved allowlist.");
        }
        const current = await readSession(request.runtimeRunId);
        if (!current || isTerminal(current.state)) return;
        const mapped = mapRpcEvent(event, current.eventCursor + 1, now().toISOString());
        await appendEvent(request.runtimeRunId, mapped);
      });
      void (async () => {
        try {
          for await (const line of handle!.stdoutLines) await harness.ingestLine(line);
          const exit = await handle!.completion;
          harness.transportClosed(new Error(`OMP container exited with code ${exit.exitCode ?? "unknown"}.`));
        } catch (error) {
          harness.transportClosed(error instanceof Error ? error : new Error("OMP container transport failed."));
          await failSession(request.runtimeRunId, error, promptStarted);
        }
      })();

      await harness.ready();
      const provider = await sessionState(harness, request);
      await setState(request.runtimeRunId, {
        state: "ready",
        containerId: handle.containerId,
        providerSessionId: provider.sessionId,
        providerSessionFile: provider.sessionFile,
        errorCode: null,
        summary: resumeSessionFile ? "OMP Session was reattached and is ready." : "OMP RPC v2 Session is ready.",
        progressPercent: 5
      });
      await setState(request.runtimeRunId, {
        state: "running",
        errorCode: null,
        summary: resumeSessionFile ? "OMP Session resumed approved execution." : "OMP Session started approved execution.",
        progressPercent: 10
      });
      promptStarted = true;
      runPromptToArtifacts(request, handle, harness, workspacePath, artifactRoot, resumeSessionFile
        ? "Resume the approved task from the existing Session and finish the stated acceptance criteria."
        : request.prompt);
      return (await readSession(request.runtimeRunId))!;
    } catch (error) {
      if (handle) await handle.terminate().catch(() => undefined);
      await failSession(request.runtimeRunId, error, promptStarted);
      throw error;
    }
  };

  const broker: OmpRuntimeBroker = {
    async health() {
      const engine = await config.runtime.health();
      const ready = config.isolationAttested
        && engine.rootless
        && engine.rootfulSocketAbsent
        && engine.resourceLimitsEnforced
        && engine.networkPolicyEnforced
        && engine.imagePinned
        && engine.modelGatewayReady;
      return {
        ok: true,
        ready,
        runtimeVersion: OMP_RPC_RUNTIME_VERSION,
        rootless: engine.rootless,
        rootfulSocketAbsent: engine.rootfulSocketAbsent,
        isolationAttested: config.isolationAttested,
        maxConcurrency
      };
    },

    async start(raw) {
      const request = ompBrokerStartRequestSchema.parse(raw);
      const requestDigest = digest(request);
      let launchRequired = false;
      const admitted = await serialize("__omp_admission__", async () => {
        const existing = await readSession(request.runtimeRunId);
        if (existing) {
          if (existing.idempotencyKey !== request.idempotencyKey || existing.requestDigest !== requestDigest) {
            throw new OmpBrokerConflictError("OMP Session idempotency binding conflicts with an existing Session.");
          }
          return existing;
        }
        const health = await broker.health();
        if (!health.ready) throw new OmpBrokerConflictError("OMP rootless isolation is not attested and ready.");
        if (active.size + reservations.size >= maxConcurrency) {
          throw new OmpBrokerConflictError("OMP Runtime concurrency is exhausted.");
        }
        const createdAt = now().toISOString();
        const session = ompBrokerSessionSchema.parse({
          runtimeRunId: request.runtimeRunId,
          goalRunId: request.goalRunId,
          taskId: request.taskId,
          idempotencyKey: request.idempotencyKey,
          requestDigest,
          state: "provisioning",
          runtimeVersion: OMP_RPC_RUNTIME_VERSION,
          leaseId: randomUUID(),
          containerId: null,
          providerSessionId: null,
          providerSessionFile: null,
          eventCursor: 1,
          errorCode: null,
          artifactManifest: null,
          createdAt,
          updatedAt: createdAt,
          expiresAt: new Date(Date.parse(createdAt) + request.executionBinding.timeoutMs).toISOString()
        });
        const event = ompBrokerEventSchema.parse({
          sequence: 1,
          kind: "state.changed",
          summary: "OMP Session provisioning was durably admitted.",
          toolName: null,
          progressPercent: 0,
          inputTokens: null,
          outputTokens: null,
          toolCalls: null,
          errorCode: null,
          occurredAt: createdAt
        });
        await mkdir(sessionDir(request.runtimeRunId), { recursive: true, mode: 0o700 });
        await writeAtomic(requestPath(request.runtimeRunId), request);
        await appendFile(eventsPath(request.runtimeRunId), `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
        await persistSession(session);
        reservations.add(request.runtimeRunId);
        launchRequired = true;
        return session;
      });
      if (!launchRequired) return admitted;
      try {
        return await launch(request, null);
      } finally {
        reservations.delete(request.runtimeRunId);
      }
    },

    get(id) {
      return readSession(id);
    },

    async events(id, afterSequence = 0, limit = 100) {
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new OmpBrokerValidationError("Event cursor must be non-negative.");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new OmpBrokerValidationError("Event limit must be between 1 and 500.");
      if (!await readSession(id)) throw new OmpBrokerNotFoundError("OMP Session was not found.");
      const raw = await readFile(eventsPath(id), "utf8").catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      });
      return raw.split("\n").filter(Boolean).map((line) => ompBrokerEventSchema.parse(JSON.parse(line)))
        .filter((event) => event.sequence > afterSequence).slice(0, limit);
    },

    async control(id, raw) {
      return serialize(`control:${id}`, async () => {
      const request = ompBrokerControlRequestSchema.parse(raw);
      const session = await readSession(id);
      if (!session) throw new OmpBrokerNotFoundError("OMP Session was not found.");
      const acknowledgesCompleted = request.action === "resume"
        && session.state === "completed"
        && request.expectedEventCursor <= session.eventCursor;
      if (!acknowledgesCompleted && session.eventCursor !== request.expectedEventCursor) {
        throw new OmpBrokerConflictError("OMP Session event cursor changed.");
      }
      const receiptPath = safeChild(controlsDir(id), `${digest(request.idempotencyKey).slice("sha256:".length)}.json`);
      const requestDigest = digest(request);
      try {
        const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as ControlReceipt;
        if (receipt.requestDigest !== requestDigest || receipt.action !== request.action) {
          throw new OmpBrokerConflictError("OMP control idempotency key belongs to another command.");
        }
        return (await readSession(id))!;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      const current = active.get(id);
      if (request.action === "steer") {
        if (session.state !== "running" || !current) throw new OmpBrokerConflictError("Only an active OMP Session can be steered.");
        await current.harness.steer(request.message!);
        await appendEvent(id, {
          kind: "state.changed",
          summary: "Owner guidance was delivered to the active OMP Session.",
          toolName: null,
          progressPercent: null,
          inputTokens: null,
          outputTokens: null,
          toolCalls: null,
          errorCode: null
        });
      } else if (request.action === "pause") {
        if (session.state !== "running" || !current) throw new OmpBrokerConflictError("Only an active OMP Session can be paused.");
        await setState(id, {
          state: "paused",
          errorCode: "owner_paused",
          summary: "Owner paused the OMP Session at a recorded checkpoint.",
          progressPercent: null
        });
        await current.harness.abortPrompt();
      } else if (request.action === "cancel") {
        if (isTerminal(session.state)) throw new OmpBrokerConflictError("Terminal OMP Sessions cannot be cancelled again.");
        if (current) {
          await setState(id, {
            state: "cancelled",
            errorCode: "owner_cancelled",
            summary: "Owner cancelled the OMP Session.",
            progressPercent: null
          });
          await current.harness.abortPrompt().catch(() => undefined);
          await current.handle.terminate();
          active.delete(id);
        } else await setState(id, {
          state: "cancelled",
          errorCode: "owner_cancelled",
          summary: "Owner cancelled the OMP Session.",
          progressPercent: null
        });
      } else {
        if (session.state === "completed") {
          // A completed Session is immutable; resume only acknowledges its durable result.
        } else if (session.state !== "paused") {
          throw new OmpBrokerConflictError("Only a paused or completed OMP Session can be resumed.");
        } else if (current) {
          await setState(id, {
            state: "running",
            errorCode: null,
            summary: "Owner resumed the active OMP Session.",
            progressPercent: null
          });
          const workspacePath = safeChild(runsRoot, id, "workspace");
          const artifactRoot = safeChild(runsRoot, id, "artifacts");
          runPromptToArtifacts(
            current.request,
            current.handle,
            current.harness,
            workspacePath,
            artifactRoot,
            "Resume the approved task and finish the stated acceptance criteria."
          );
        } else {
          const savedRequest = ompBrokerStartRequestSchema.parse(JSON.parse(await readFile(requestPath(id), "utf8")));
          await launch(savedRequest, session.providerSessionFile);
        }
      }
      await mkdir(controlsDir(id), { recursive: true, mode: 0o700 });
      await writeAtomic(receiptPath, { requestDigest, action: request.action, recordedAt: now().toISOString() } satisfies ControlReceipt);
      return (await readSession(id))!;
      });
    },

    async reconcileInterruptedSessions() {
      let reconciled = 0;
      for (const entry of await readdir(sessionsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const session = await readSession(entry.name).catch(() => null);
        if (!session || isTerminal(session.state) || session.state === "paused") continue;
        await setState(session.runtimeRunId, {
          state: "paused",
          errorCode: "provider_outcome_unknown",
          summary: "Broker restart interrupted the OMP transport; the Session requires explicit resume.",
          progressPercent: null
        });
        reconciled += 1;
      }
      return reconciled;
    }
  };

  await config.runtime.reconcile?.();
  await broker.reconcileInterruptedSessions();
  return broker;
}
