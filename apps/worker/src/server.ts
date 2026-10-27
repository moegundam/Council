import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { z } from "zod";
import type {
  AgentTurnJobData,
  ChairAutomationJobData,
  CouncilJobData,
  CouncilJobEnvelope,
  CouncilJobName,
  GoalActionRunJobData,
  GoalReviewJobData,
  McpToolCallJobData,
  MeetingSummaryJobData,
  RuntimeReconcileJobData,
  SpeakerQueueItem,
  Task,
  TaskAgentRunJobData,
  TaskSyncJobData,
  Utterance
} from "@council/contracts";
import { createCouncilJobEnvelope } from "@council/contracts";
import { coordinateChairIntervention, createPostgresPoolFromEnv, PostgresPlatformStore, requestFingerprint } from "@council/database";
import { parseActionAdapterEndpointAllowlist, parseConnectorHostAllowlist, SecretVault } from "@council/domain";
import {
  createGovernanceControlFromEnv,
  GovernanceDeniedError,
  GovernanceUnavailableError,
  HarnessActionAdapter,
  HarnessMcpExecutorBackend,
  type ActionAdapter as RuntimeActionAdapter
} from "@council/runtime";
import {
  agentTurnFailureDisposition,
  meetingActionFailureAttemptDisposition,
  mcpToolFailureDisposition,
  meetingSummaryFailureDisposition,
  queueOwnsJob,
  taskAgentRunFailureDisposition,
  taskSyncFailureDisposition
} from "./job-lifecycle.js";
import {
  AgentTurnOutcomeUnknownError,
  processAgentTurn,
  recordAgentTurnFailure,
  StaleAgentTurnError
} from "./process-agent-turn.js";
import {
  McpToolOutcomeUnknownError,
  processMcpToolCall,
  recordReservedMcpToolFailure,
  StaleMcpToolRunError
} from "./process-mcp-tool-call.js";
import {
  prepareMcpToolCallExecution,
  legacyMcpArgumentReaderEnabledFromEnv,
  resolveMcpToolCallArguments,
  type PrepareMcpToolCallExecutionInput
} from "./mcp-job-lifecycle.js";
import { processMeetingSummary } from "./process-meeting-summary.js";
import {
  processTaskSync,
  recordTaskSyncFailure,
  TaskSyncAttemptError,
  TaskSyncPayloadChangedError
} from "./process-task-sync.js";
import { processTaskAgentRun, recordTaskAgentRunFailure } from "./process-task-agent-run.js";
import {
  processChairAutomation,
  recordAutomaticChairTurnFailure,
  shouldCoordinateChairAfterAgentTurn
} from "./process-chair-automation.js";
import { createCodexRuntimeHarness } from "./codex-runtime.js";
import { reconcileSpeakerQueueLeases } from "./speaker-queue-reconciler.js";
import { parseQueuedCouncilJob } from "./job-contract.js";
import { createWorkerObservability } from "./observability.js";
import { recoverOrphanedAsyncState } from "./async-state-recovery.js";
import { backfillMeetingRecords } from "./meeting-record-backfill.js";
import { processGoalActionRun } from "./process-goal-action-run.js";
import { processGoalOrchestrate } from "./process-goal-orchestrate.js";
import { continueGoalForTask } from "./goal-task-continuation.js";
import { processGoalPlan } from "./process-goal-plan.js";
import { processGoalReview, processLegacyGoalReview } from "./process-goal-review.js";
import { processRuntimeControl, type OmpRuntimeController } from "./process-runtime-control.js";
import { createOmpBrokerClientFromEnv } from "./omp-broker-client.js";
import {
  pauseOmpRuntimeOutcomeUnknown,
  processOmpTaskRuntime,
  StaleOmpTaskRuntimeError
} from "./process-omp-task-runtime.js";
import { runGoalMeetingRound } from "./goal-meeting-runner.js";
import { recoverFailedGoalTaskBindings, recoverGoalJobs } from "./goal-job-recovery.js";
import { deferDisabledGoalJob, goalRunAutonomyEnabledFromEnv } from "./goal-feature-flag.js";
import {
  assertHarnessActionAdapterReadiness,
  harnessActionAdapterHealthStatus,
  harnessActionAdapterRuntimeEnabledFromEnv
} from "./harness-action-adapter-runtime.js";
import {
  createContractMeetingEventPublisher,
  publishTaskChangedEvent,
  type WorkerTaskChangeAction
} from "./meeting-event-publisher.js";
import {
  armWorkerStartup,
  createWorkerHealthIntake,
  createWorkerLifecycle,
  DEFERRED_BULLMQ_WORKER_OPTIONS,
  withWorkerHealthCheckTimeout
} from "./worker-lifecycle.js";

function connectionOptions(redisUrl: string) {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.protocol === "rediss:" ? { tls: {} } : {})
  };
}

interface AgentTurnExecutionStore {
  getSnapshot(): Promise<{ utterances: readonly Utterance[] }>;
  getSpeakerQueue(): Promise<SpeakerQueueItem[]>;
  markSpeakerTurnRunning(jobId: string, reservationId?: string): Promise<SpeakerQueueItem | null>;
}

export interface PrepareAgentTurnExecutionInput {
  store: AgentTurnExecutionStore;
  jobId: string;
  meetingId: string;
  agentId: string;
  reservationId?: string;
  deliveryAttempt?: number;
}

export interface PreparedAgentTurnExecution {
  utterance: Utterance | null;
  queueItem: SpeakerQueueItem | null;
  inProgress: boolean;
  replayed: boolean;
}

async function findPersistedAgentTurn(input: PrepareAgentTurnExecutionInput): Promise<Utterance | null> {
  const existing = (await input.store.getSnapshot()).utterances.find((item) => item.turnId === input.jobId);
  if (!existing) return null;
  if (existing.speakerType !== "agent" || existing.meetingId !== input.meetingId || existing.agentId !== input.agentId) {
    throw new Error("Agent turn ID belongs to a different meeting action.");
  }
  return existing;
}

export async function prepareAgentTurnExecution(
  input: PrepareAgentTurnExecutionInput
): Promise<PreparedAgentTurnExecution> {
  const persisted = await findPersistedAgentTurn(input);
  if (persisted) return { utterance: persisted, queueItem: null, inProgress: false, replayed: true };

  const queueItem = await (input.reservationId
    ? input.store.markSpeakerTurnRunning(input.jobId, input.reservationId)
    : input.store.markSpeakerTurnRunning(input.jobId));
  if (queueItem) return { utterance: null, queueItem, inProgress: false, replayed: false };

  const committedDuringAdmission = await findPersistedAgentTurn(input);
  if (committedDuringAdmission) {
    return { utterance: committedDuringAdmission, queueItem: null, inProgress: false, replayed: true };
  }
  const runningReservation = (await input.store.getSpeakerQueue()).find((item) => (
    item.status === "running"
    && item.kind === "agent_turn"
    && item.jobId === input.jobId
    && item.meetingId === input.meetingId
    && item.agentId === input.agentId
    && (input.reservationId === undefined
      ? item.reservationId === null || item.reservationId === undefined
      : item.reservationId === input.reservationId)
  ));
  if (runningReservation) {
    if ((input.deliveryAttempt ?? 1) > 1) throw new AgentTurnOutcomeUnknownError();
    return { utterance: null, queueItem: null, inProgress: true, replayed: false };
  }

  const committedAfterClaimCheck = await findPersistedAgentTurn(input);
  if (committedAfterClaimCheck) {
    return { utterance: committedAfterClaimCheck, queueItem: null, inProgress: false, replayed: true };
  }
  throw new StaleAgentTurnError();
}

async function startWorker(): Promise<void> {
if (!process.env.REDIS_URL) throw new Error("Worker requires REDIS_URL.");
if (!process.env.APP_MASTER_KEY_FILE) throw new Error("Worker requires APP_MASTER_KEY_FILE.");
const key = Buffer.from((await readFile(process.env.APP_MASTER_KEY_FILE, "utf8")).trim(), "base64");
const secretVault = new SecretVault(key);
const allowLegacyMcpArguments = legacyMcpArgumentReaderEnabledFromEnv();
const goalRunAutonomyEnabled = goalRunAutonomyEnabledFromEnv();
const ompBroker = await createOmpBrokerClientFromEnv(process.env);
const harnessActionAdapterEnabled = harnessActionAdapterRuntimeEnabledFromEnv(process.env);
const harnessActionAdapterEndpointAllowlist = new Set(
  parseActionAdapterEndpointAllowlist(process.env.HARNESS_ACTION_ADAPTER_ENDPOINT_ALLOWLIST)
);
const mcpLocalHostAllowlist = parseConnectorHostAllowlist(process.env.MCP_LOCAL_HOST_ALLOWLIST);
const codexRuntimeHarness = await createCodexRuntimeHarness(process.env);
const observability = createWorkerObservability();
const governance = await createGovernanceControlFromEnv(process.env);
if (governance.initializationError) {
  observability.logOperationalError(
    "governance.provider.initialization.failed",
    governance.initializationError,
    {
      resourceId: governance.provider.metadata.providerId,
      resourceType: "governance_provider"
    }
  );
}
const store = new PostgresPlatformStore(await createPostgresPoolFromEnv());
const redisPublisher = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
const publisher = createContractMeetingEventPublisher(redisPublisher);
type CouncilJobPayload = CouncilJobEnvelope | CouncilJobData;

const backgroundQueue = new Queue<CouncilJobPayload, void, CouncilJobName>("council-background-jobs", {
  connection: connectionOptions(process.env.REDIS_URL)
});

async function createHarnessGoalActionAdapter(adapter: Awaited<ReturnType<typeof store.listActionAdapters>>[number]): Promise<RuntimeActionAdapter | null> {
  if (!harnessActionAdapterEnabled
    || !adapter.enabled
    || !adapter.credentialId
    || !harnessActionAdapterEndpointAllowlist.has(new URL(adapter.baseUrl).toString())) return null;
  const ciphertext = await store.getCredentialSecret(adapter.credentialId).catch(() => null);
  if (!ciphertext) return null;
  let bearerToken: string;
  try {
    bearerToken = secretVault.decrypt(ciphertext);
  } catch {
    return null;
  }
  const scalar = z.union([z.string().max(4_000), z.number().finite(), z.boolean(), z.null()]);
  const actions = adapter.actions.flatMap((action) => action.targetIds.map((targetId) => ({
    actionId: `${action.key}:${targetId}`,
    targetId,
    // The persisted target ID is the only resource identity the Plan can select.
    resourceId: targetId,
    inputSchema: z.object(Object.fromEntries(
      action.inputKeys.map((key) => [key, z.union([scalar, z.array(scalar).max(50)]).optional()])
    )).strict()
  })));
  if (actions.length === 0) return null;
  return new HarnessActionAdapter({
    catalogId: adapter.id,
    catalogVersion: adapter.catalogRevision,
    actions
  }, new HarnessMcpExecutorBackend({ endpoint: adapter.baseUrl, bearerToken }));
}

async function enqueueChairAutomation(job: ChairAutomationJobData, requestedJobId: string): Promise<{ jobId: string }> {
  const queued = await backgroundQueue.add("chair-automation", createCouncilJobEnvelope("chair-automation", job), {
    attempts: 3,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: 500,
    removeOnFail: 500,
    deduplication: { id: `chair-automation-${job.chairSuggestionId}` },
    jobId: requestedJobId
  });
  if (queued.id !== requestedJobId) throw new Error("Chair automation queue returned a mismatched job ID.");
  if (!(await queueOwnsJob(backgroundQueue, requestedJobId))) {
    throw new Error("Chair automation queue returned a terminal or unsupported job state.");
  }
  return { jobId: requestedJobId };
}

async function getBackgroundJobState(jobId: string): Promise<string | null> {
  const job = await backgroundQueue.getJob(jobId);
  return job ? await job.getState() : null;
}

async function enqueueAutomaticAgentTurn(job: AgentTurnJobData, requestedJobId: string): Promise<{ jobId: string }> {
  const queued = await backgroundQueue.add("agent-turn", createCouncilJobEnvelope("agent-turn", job), {
    attempts: 1,
    removeOnComplete: 500,
    removeOnFail: 500,
    deduplication: { id: `meeting-action-${job.meetingId}` },
    jobId: requestedJobId
  });
  if (queued.id !== requestedJobId) throw new Error("Automatic Chair turn was not enqueued with its persisted job ID.");
  return { jobId: requestedJobId };
}

async function enqueueGoalTaskAgent(job: TaskAgentRunJobData, requestedJobId: string): Promise<{ jobId: string }> {
  const queued = await backgroundQueue.add("task-agent-run", createCouncilJobEnvelope("task-agent-run", job), {
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    delay: 1_000,
    removeOnComplete: 500,
    removeOnFail: 500,
    deduplication: { id: `task-agent-run-${job.taskId}` },
    jobId: requestedJobId
  });
  if (queued.id !== requestedJobId) throw new Error("Goal Task Agent queue returned a mismatched job ID.");
  return { jobId: requestedJobId };
}

async function enqueueOmpRuntimeReconcile(
  data: RuntimeReconcileJobData,
  suffix: string,
  delay = 15_000
): Promise<void> {
  const jobId = `runtime-reconcile-${data.runtimeRunId}-${suffix}`;
  const queued = await backgroundQueue.add("runtime-reconcile", createCouncilJobEnvelope("runtime-reconcile", data), {
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    delay,
    removeOnComplete: 2_000,
    removeOnFail: 2_000,
    jobId
  });
  if (queued.id !== jobId) throw new Error("OMP Runtime reconcile queue returned a mismatched job ID.");
}

async function enqueueRecoveredOmpRuntime(data: RuntimeReconcileJobData): Promise<void> {
  const jobId = `runtime-reconcile-recovery-${data.runtimeRunId}`;
  const existing = await backgroundQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (["waiting", "delayed", "active", "prioritized", "waiting-children"].includes(state)) return;
    await existing.remove().catch(() => undefined);
  }
  const queued = await backgroundQueue.add("runtime-reconcile", createCouncilJobEnvelope("runtime-reconcile", data), {
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: true,
    removeOnFail: 2_000,
    jobId
  });
  if (queued.id !== jobId) throw new Error("Recovered OMP Runtime reconcile queue returned a mismatched job ID.");
}

async function recoverOmpRuntimeRuns(startup = false): Promise<number> {
  if (!ompBroker) return 0;
  const runs = await store.listRecoverableOmpRuntimeRuns();
  let recovered = 0;
  for (const run of runs) {
    if (!startup && run.state === "paused") continue;
    await enqueueRecoveredOmpRuntime({
      runtimeRunId: run.id,
      taskAgentJobId: run.idempotencyKey,
      pollAttempt: 0,
      requestedBy: "system"
    });
    recovered += 1;
  }
  return recovered;
}

async function enqueueGoalAction(job: GoalActionRunJobData, requestedJobId: string): Promise<{ jobId: string }> {
  const queued = await backgroundQueue.add("goal-action-run", createCouncilJobEnvelope("goal-action-run", job), {
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: 500,
    removeOnFail: 500,
    deduplication: { id: `goal-action-${job.actionRunId}` },
    jobId: requestedJobId
  });
  if (queued.id !== requestedJobId) throw new Error("Goal Action queue returned a mismatched job ID.");
  return { jobId: requestedJobId };
}

async function enqueueGoalReview(job: GoalReviewJobData, requestedJobId: string): Promise<{ jobId: string }> {
  const queued = await backgroundQueue.add("goal-review", createCouncilJobEnvelope("goal-review", job), {
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: 500,
    removeOnFail: 500,
    deduplication: { id: `goal-review-${job.goalRunId}-${job.scope}-${job.scopeId}-${job.reviewerAgentId}` },
    jobId: requestedJobId
  });
  if (queued.id !== requestedJobId) throw new Error("Goal Review queue returned a mismatched job ID.");
  return { jobId: requestedJobId };
}

async function executeGoalMeetingRound(input: { goalRunId: string; meetingId: string; round: number }): Promise<{ modelCalls: number }> {
  return runGoalMeetingRound({
    store,
    ...input,
    secretVault,
    harnessFor: (runtime) => runtime.harnessKind === "codex" ? codexRuntimeHarness ?? undefined : undefined,
    onUtterance: async (utterance, jobId) => {
      await publisher.publish(`council:meeting:${input.meetingId}`, JSON.stringify({
        type: "utterance.created",
        meetingId: input.meetingId,
        data: { utterance, jobId, jobName: "goal-meeting-turn" },
        occurredAt: new Date().toISOString()
      }));
    }
  });
}

async function executeGoalOrchestrateJob(data: Parameters<typeof processGoalOrchestrate>[0]["data"], jobId: string) {
  return processGoalOrchestrate({
    store,
    data,
    jobId,
    enqueueTaskAgent: enqueueGoalTaskAgent,
    enqueueAction: enqueueGoalAction,
    enqueueReview: enqueueGoalReview,
    runMeetingRound: executeGoalMeetingRound,
    ompRuntimeReady: async () => {
      if (!ompBroker) return false;
      return (await ompBroker.health()).ready;
    }
  });
}

const ompRuntimeController: OmpRuntimeController = {
  control: async (input) => {
    if (!ompBroker) throw new Error("OMP Sandbox Broker control is not configured.");
    const session = await ompBroker.control(input.runtimeRun.id, {
      action: input.action,
      idempotencyKey: input.idempotencyKey,
      expectedEventCursor: input.runtimeRun.eventCursor,
      ...(input.message === undefined ? {} : { message: input.message })
    });
    return {
      ...(session.providerSessionId ? { providerSessionId: session.providerSessionId } : {}),
      leaseId: session.leaseId,
      eventCursor: session.eventCursor
    };
  }
};

async function continueGoalRun(goalRunId: string, trigger: string): Promise<void> {
  const run = await store.getGoalRun(goalRunId);
  if (!run || ["paused", "completed", "failed", "cancelled"].includes(run.state)) return;
  const fingerprint = requestFingerprint({ goalRunId, revision: run.revision, trigger });
  const jobId = `goal-orchestrate-${goalRunId}-${fingerprint.slice(0, 32)}`;
  const reservedAt = new Date().toISOString();
  await store.reserveGoalJob({
    jobId,
    goalRunId,
    jobName: "goal-orchestrate",
    entityId: goalRunId,
    requestFingerprint: fingerprint,
    state: "reserved",
    reservedAt,
    admittedAt: null,
    startedAt: null,
    settledAt: null,
    updatedAt: reservedAt
  });
  await executeGoalOrchestrateJob({
    goalRunId,
    expectedRevision: run.revision,
    requestFingerprint: fingerprint,
    requestedBy: "system"
  }, jobId);
}

async function recoverDurableGoalJobs(startup = false) {
  if (!goalRunAutonomyEnabled) return null;
  return recoverGoalJobs({
    store,
    startup,
    findJob: async (jobId) => (await backgroundQueue.getJob(jobId)) ?? null,
    runOrchestrate: (data, jobId) => executeGoalOrchestrateJob(data, jobId),
    runPlan: (data, jobId) => processGoalPlan({ store, data, jobId }),
    runReview: (data, jobId) => "modelConnectorBinding" in data
      ? processGoalReview({
        store,
        data,
        jobId,
        onReviewCompleted: (goalRunId) => continueGoalRun(goalRunId, `recovered-review:${jobId}`)
      })
      : processLegacyGoalReview({
        store,
        data,
        jobId,
        onReviewCompleted: (goalRunId) => continueGoalRun(goalRunId, `recovered-review:${jobId}`)
      }),
    enqueueReview: enqueueGoalReview,
    enqueueAction: enqueueGoalAction,
    continueGoal: continueGoalRun
  });
}

async function continueGoalForCanonicalTask(taskId: string, trigger: string, goalRunId?: string | null): Promise<void> {
  if (!goalRunAutonomyEnabled) return;
  await continueGoalForTask({ store, taskId, goalRunId: goalRunId ?? null, trigger, continueGoal: continueGoalRun });
}

async function taskBelongsToGoalRun(taskId: string): Promise<boolean> {
  for (const run of await store.listGoalRuns()) {
    const detail = await store.getGoalRunDetail(run.id);
    if (detail?.taskBindings.some((binding) => binding.taskId === taskId)) return true;
  }
  return false;
}

async function enqueueRecoveredMeetingSummary(meetingId: string, requestedJobId: string): Promise<void> {
  const job: MeetingSummaryJobData = { meetingId, requestedBy: "system" };
  const queued = await backgroundQueue.add("meeting-summary", createCouncilJobEnvelope("meeting-summary", job), {
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: 500,
    removeOnFail: 500,
    deduplication: { id: `meeting-summary-${meetingId}` },
    jobId: requestedJobId
  });
  if (queued.id !== requestedJobId) {
    throw new Error("Meeting summary recovery returned a mismatched job ID.");
  }
}

async function publishSpeakerQueueChanged(
  item: SpeakerQueueItem,
  status: SpeakerQueueItem["status"] | "released",
  reason?: string
): Promise<void> {
  try {
    await publisher.publish(`council:meeting:${item.meetingId}`, JSON.stringify({
      type: "speaker.queue.changed",
      meetingId: item.meetingId,
      data: {
        jobId: item.jobId,
        participantId: item.participantId,
        agentId: item.agentId,
        kind: item.kind,
        label: item.label,
        toolName: item.toolName,
        roleRevision: item.roleRevision,
        roleId: item.roleId,
        roleVersion: item.roleVersion,
        roleName: item.roleName,
        status,
        leaseExpiresAt: item.leaseExpiresAt,
        ...(reason ? { reason } : {})
      },
      occurredAt: new Date().toISOString()
    }));
  } catch (error) {
    observability.logOperationalError("speaker_queue.publish.failed", error, {
      jobId: item.jobId,
      meetingId: item.meetingId
    });
  }
}

async function publishTaskChanged(
  task: Pick<Task, "id" | "meetingId" | "status">,
  action: WorkerTaskChangeAction,
  jobId: string
): Promise<void> {
  await publishTaskChangedEvent(publisher, task, action, {
    onError: (error) => {
      observability.logOperationalError("task_event.publish.failed", error, {
        jobId,
        meetingId: task.meetingId,
        taskId: task.id
      });
    }
  });
}

function taskAgentFailureWasCommitted(task: Task, data: TaskAgentRunJobData, jobId: string): boolean {
  return task.execution.status === "failed"
    && task.execution.jobId === jobId
    && task.execution.requestFingerprint === data.requestFingerprint
    && task.execution.agentId === data.agentId;
}

let worker!: Worker<CouncilJobPayload, void, CouncilJobName>;
let healthServer!: ReturnType<typeof createServer>;
let speakerQueueTimer: ReturnType<typeof setInterval> | undefined;
let durableJobRecoveryTimer: ReturnType<typeof setInterval> | undefined;
const healthIntake = createWorkerHealthIntake({
  open: () => new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      healthServer.off("error", onError);
      reject(error);
    };
    healthServer.once("error", onError);
    healthServer.listen(Number(process.env.HEALTH_PORT ?? 4102), "0.0.0.0", () => {
      healthServer.off("error", onError);
      resolve();
    });
  }),
  close: () => new Promise<void>((resolve, reject) => {
    healthServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  })
});
const lifecycle = createWorkerLifecycle({
  cancelScheduledWork: () => {
    if (speakerQueueTimer) clearInterval(speakerQueueTimer);
    if (durableJobRecoveryTimer) clearInterval(durableJobRecoveryTimer);
  },
  closeHealthIntake: () => healthIntake.close(),
  stopWorkerIntake: () => worker.isRunning() ? worker.pause(true) : undefined,
  closeWorker: (force) => worker.close(force),
  dependencies: [
    { name: "background-queue", close: () => backgroundQueue.close() },
    { name: "event-publisher", close: async () => { await redisPublisher.quit(); } },
    { name: "store", close: () => store.close() }
  ],
  onDeadline: () => {
    observability.logOperationalError(
      "worker.runtime.failed",
      new Error("Worker shutdown exceeded the application deadline.")
    );
    process.exit(1);
  },
  onResourceCloseError: (resource, error) => {
    observability.logOperationalError(
      "worker.runtime.failed",
      new Error(`Worker failed to close ${resource}.`, { cause: error })
    );
  }
});

worker = new Worker<CouncilJobPayload, void, CouncilJobName>(
  "council-background-jobs",
  async (job: Job<CouncilJobPayload, void, CouncilJobName>) => lifecycle.runInFlight(() => observability.observeJob({
    jobId: String(job.id ?? "unknown"),
    jobName: job.name,
    attempt: job.attemptsMade + 1,
    payload: job.data
  }, async () => {
    let envelope: ReturnType<typeof parseQueuedCouncilJob>;
    try {
      envelope = parseQueuedCouncilJob(job.name, job.data);
    } catch (error) {
      const attempts = typeof job.opts.attempts === "number" ? job.opts.attempts : 1;
      if (job.name === "mcp-tool-call" && job.id && job.attemptsMade + 1 >= attempts) {
        const failure = await recordReservedMcpToolFailure({
          store,
          jobId: String(job.id),
          message: "MCP 工作格式無法驗證，會議已暫停。請重新建立工具工作。"
        });
        if (failure.recorded && failure.queueItem) {
          await publishSpeakerQueueChanged(failure.queueItem, "released", "invalid_job_contract");
          await store.recordAudit("mcp.tool.failed", "meeting", failure.queueItem.meetingId, {
            classification: "invalid_job_contract",
            jobId: String(job.id)
          });
          await publisher.publish(`council:meeting:${failure.queueItem.meetingId}`, JSON.stringify({
            type: "mcp.failed",
            meetingId: failure.queueItem.meetingId,
            data: { classification: "invalid_job_contract", jobId: String(job.id), jobName: job.name },
            occurredAt: new Date().toISOString()
          }));
        } else if (failure.queueItem) {
          const released = await store.releaseSpeakerTurn(String(job.id), "invalid_job_contract");
          if (released) await publishSpeakerQueueChanged(released, "released", "invalid_job_contract");
        }
      }
      throw error;
    }
    if (envelope.name === "runtime-control") {
      await processRuntimeControl({ store, data: envelope.data, controller: ompRuntimeController });
      if (envelope.data.action === "resume" || envelope.data.action === "steer") {
        const run = await store.getRuntimeRun(envelope.data.runtimeRunId);
        if (run) await enqueueOmpRuntimeReconcile({
          runtimeRunId: run.id,
          taskAgentJobId: run.idempotencyKey,
          pollAttempt: 0,
          requestedBy: "system"
        }, `control-${envelope.data.commandRevision}`, 0);
      }
      return;
    }
    if (envelope.name === "runtime-reconcile") {
      if (!ompBroker) throw new Error("OMP Sandbox Broker is disabled.");
      const run = await store.getRuntimeRun(envelope.data.runtimeRunId);
      if (!run || run.idempotencyKey !== envelope.data.taskAgentJobId) return;
      try {
        const result = await processOmpTaskRuntime({
          store,
          broker: ompBroker,
          runtimeRunId: run.id
        });
        if (result.pollRequired) {
          await enqueueOmpRuntimeReconcile({
            ...envelope.data,
            pollAttempt: envelope.data.pollAttempt + 1
          }, `poll-${envelope.data.pollAttempt + 1}`);
        } else if (result.state === "completed") {
          await publishTaskChanged(result.task, "agent_run_completed", run.idempotencyKey);
          await continueGoalForCanonicalTask(result.task.id, `runtime:${run.id}`, run.goalRunId);
        }
      } catch (error) {
        const attempts = typeof job.opts.attempts === "number" ? job.opts.attempts : 1;
        if (error instanceof StaleOmpTaskRuntimeError) {
          await pauseOmpRuntimeOutcomeUnknown(store, run.id);
          return;
        }
        if (job.attemptsMade + 1 < attempts) throw error;
        await pauseOmpRuntimeOutcomeUnknown(store, run.id);
      }
      return;
    }
    if (envelope.name === "goal-orchestrate") {
      if (!goalRunAutonomyEnabled) await deferDisabledGoalJob(job);
      if (!job.id) throw new Error("Goal orchestration job requires a stable job ID.");
      await executeGoalOrchestrateJob(envelope.data, String(job.id));
      return;
    }

    if (envelope.name === "goal-plan") {
      if (!goalRunAutonomyEnabled) await deferDisabledGoalJob(job);
      if (!job.id) throw new Error("Goal plan job requires a stable job ID.");
      await processGoalPlan({ store, data: envelope.data, jobId: String(job.id) });
      return;
    }

    if (envelope.name === "goal-review") {
      if (!goalRunAutonomyEnabled) await deferDisabledGoalJob(job);
      if (!job.id) throw new Error("Goal review job requires a stable job ID.");
      if (envelope.contractVersion === 1) {
        await processLegacyGoalReview({
          store,
          data: envelope.data,
          jobId: String(job.id),
          onReviewCompleted: (goalRunId) => continueGoalRun(goalRunId, `review:${job.id}`)
        });
      } else {
        await processGoalReview({
          store,
          data: envelope.data,
          jobId: String(job.id),
          secretVault,
          onReviewCompleted: (goalRunId) => continueGoalRun(goalRunId, `review:${job.id}`)
        });
      }
      return;
    }

    if (envelope.name === "goal-action-run") {
      if (!goalRunAutonomyEnabled) await deferDisabledGoalJob(job);
      if (!job.id) throw new Error("Goal Action job requires a stable job ID.");
      const result = await processGoalActionRun({
        store,
        data: envelope.data,
        jobId: String(job.id),
        createAdapter: createHarnessGoalActionAdapter
      });
      if (result === "pending") {
        throw new Error("Harness Action is still asynchronous; retrying status reconciliation without repeating execution.");
      }
      if (result === "succeeded") await continueGoalRun(envelope.data.goalRunId, `action:${job.id}`);
      return;
    }

    if (envelope.name === "task-agent-run") {
      const data = envelope.data;
      if (!goalRunAutonomyEnabled && await taskBelongsToGoalRun(data.taskId)) await deferDisabledGoalJob(job);
      if (!job.id) throw new Error("Task Agent run requires a stable job ID.");
      const jobId = String(job.id);
      if (data.executionRuntimeBinding?.route === "omp_coding" || data.runtimeProfileSnapshot?.harnessKind === "pi") {
        if (!ompBroker || !data.runtimeRun) throw new Error("OMP Sandbox Broker is unavailable.");
        try {
          const result = await processOmpTaskRuntime({
            store,
            broker: ompBroker,
            runtimeRunId: data.runtimeRun.id,
            data
          });
          if (result.pollRequired) {
            await enqueueOmpRuntimeReconcile({
              runtimeRunId: data.runtimeRun.id,
              taskAgentJobId: data.runtimeRun.idempotencyKey,
              pollAttempt: 0,
              requestedBy: "system"
            }, "poll-0");
          } else if (result.state === "completed") {
            await publishTaskChanged(result.task, "agent_run_completed", data.runtimeRun.idempotencyKey);
            await continueGoalForCanonicalTask(result.task.id, `runtime:${data.runtimeRun.id}`, data.runtimeRun.goalRunId);
          }
        } catch (error) {
          const attempts = typeof job.opts.attempts === "number" ? job.opts.attempts : 1;
          if (error instanceof StaleOmpTaskRuntimeError) {
            const failed = await recordTaskAgentRunFailure(store, data, data.runtimeRun.idempotencyKey, "stale_execution_binding");
            await publishTaskChanged(failed, "agent_run_cancelled", data.runtimeRun.idempotencyKey);
            return;
          }
          if (job.attemptsMade + 1 < attempts) throw error;
          await pauseOmpRuntimeOutcomeUnknown(store, data.runtimeRun.id);
        }
        return;
      }
      try {
        const completed = await processTaskAgentRun({
          store,
          data,
          jobId,
          queueAttempt: job.attemptsMade + 1,
          secretVault,
          ...(data.runtimeProfileSnapshot?.harnessKind === "codex" && codexRuntimeHarness
            ? { harness: codexRuntimeHarness }
            : {})
        });
        if (completed.execution.status === "completed") {
          await publishTaskChanged(completed, "agent_run_completed", jobId);
          await continueGoalForCanonicalTask(completed.id, `task:${jobId}`, data.goalRunId);
        } else if (taskAgentFailureWasCommitted(completed, data, jobId)) {
          await publishTaskChanged(completed, "agent_run_failed", jobId);
        }
      } catch (error) {
        const disposition = taskAgentRunFailureDisposition(error, job.attemptsMade, job.opts.attempts);
        if (disposition === "stale") {
          const failed = await recordTaskAgentRunFailure(store, data, jobId, "stale_execution_binding");
          if (taskAgentFailureWasCommitted(failed, data, jobId)) {
            await publishTaskChanged(failed, "agent_run_cancelled", jobId);
          }
          await store.recordAudit("task.agent_run.cancelled", "task", data.taskId, {
            jobId,
            agentId: data.agentId,
            executionRevision: data.executionRevision,
            classification: "stale_execution_binding"
          });
          return;
        }
        if (disposition === "retryable") throw error;
        if (disposition === "provider_outcome_unknown") {
          const failed = await recordTaskAgentRunFailure(store, data, jobId, "provider_outcome_unknown");
          if (taskAgentFailureWasCommitted(failed, data, jobId)) {
            await publishTaskChanged(failed, "agent_run_failed", jobId);
          }
          return;
        }
        const failed = await recordTaskAgentRunFailure(store, data, jobId, "provider_or_runtime_failure");
        if (taskAgentFailureWasCommitted(failed, data, jobId)) {
          await publishTaskChanged(failed, "agent_run_failed", jobId);
        }
        throw error;
      }
      return;
    }

    if (envelope.name === "task-sync") {
      const data = envelope.data;
      if (!job.id) throw new Error("Task sync job requires a stable job ID.");
      const jobId = String(job.id);
      try {
        const completed = await processTaskSync({
          store,
          taskId: data.taskId,
          adapterId: data.adapterId,
          jobId,
          secretVault
        });
        await publishTaskChanged(completed, "sync_completed", jobId);
      } catch (error) {
        const disposition = taskSyncFailureDisposition(error);
        if (disposition === "stale") return;
        if (disposition === "payload_churn" && error instanceof TaskSyncPayloadChangedError) {
          const failed = await recordTaskSyncFailure(store, {
            taskId: data.taskId,
            adapterId: data.adapterId,
            jobId,
            requestFingerprint: error.requestFingerprint
          }, "payload_churn");
          if (failed.status === "updated") {
            await publishTaskChanged(failed.task, "sync_failed", jobId);
          }
          if (failed.status === "stale") {
            await store.recordAudit("task.sync.reconciliation.required", "task", data.taskId, {
              adapterId: data.adapterId,
              jobId,
              reason: "payload_churn_binding_changed"
            });
          }
          return;
        }
        if (disposition === "retryable") throw error;
        const attempts = typeof job.opts.attempts === "number" ? job.opts.attempts : 1;
        if (job.attemptsMade + 1 >= attempts) {
          if (error instanceof TaskSyncAttemptError) {
            const failed = await recordTaskSyncFailure(store, {
              taskId: data.taskId,
              adapterId: data.adapterId,
              jobId,
              requestFingerprint: error.requestFingerprint
            });
            if (failed.status === "updated") {
              await publishTaskChanged(failed.task, "sync_failed", jobId);
            }
          } else {
            await store.recordAudit("task.sync.reconciliation.required", "task", data.taskId, {
              adapterId: data.adapterId,
              jobId,
              reason: "failure_binding_unavailable"
            });
          }
        }
        throw error;
      }
      return;
    }

    if (envelope.name === "chair-automation") {
      const data = envelope.data;
      if (!job.id) throw new Error("Chair automation job requires a stable job ID.");
      try {
        const result = await processChairAutomation({
          store,
          data,
          automationJobId: String(job.id),
          enqueueAgentTurn: enqueueAutomaticAgentTurn,
          hasJob: (jobId) => queueOwnsJob(backgroundQueue, jobId)
        });
        const snapshot = await store.getSnapshot();
        const meeting = snapshot.meetings.find((item) => item.id === data.meetingId);
        const suggestion = snapshot.chairSuggestions.find((item) => item.id === data.chairSuggestionId);
        const queueItem = result.agentTurnJobId
          ? snapshot.speakerQueue.find((item) => item.jobId === result.agentTurnJobId)
          : undefined;
        if (result.status === "applied" || result.status === "queued") {
          if (meeting) {
            await publisher.publish(`council:meeting:${data.meetingId}`, JSON.stringify({
              type: "meeting.mode.changed",
              meetingId: data.meetingId,
              data: { mode: meeting.mode, chairSuggestionId: data.chairSuggestionId, actor: "system" },
              occurredAt: new Date().toISOString()
            }));
          }
          if (queueItem) await publishSpeakerQueueChanged(queueItem, "queued");
          await publisher.publish(`council:meeting:${data.meetingId}`, JSON.stringify({
            type: "chair.automation.applied",
            meetingId: data.meetingId,
            data: {
              chairSuggestionId: data.chairSuggestionId,
              status: result.status,
              agentTurnJobId: result.agentTurnJobId
            },
            occurredAt: new Date().toISOString()
          }));
        } else if (result.status === "queue_unavailable" || result.status === "queue_unknown") {
          await publisher.publish(`council:meeting:${data.meetingId}`, JSON.stringify({
            type: "chair.automation.failed",
            meetingId: data.meetingId,
            data: {
              chairSuggestionId: data.chairSuggestionId,
              classification: result.status === "queue_unavailable" ? "queue_unavailable" : "queue_acceptance_unknown"
            },
            occurredAt: new Date().toISOString()
          }));
        }
        if (suggestion) {
          await publisher.publish(`council:meeting:${data.meetingId}`, JSON.stringify({
            type: "chair.suggestion.updated",
            meetingId: data.meetingId,
            data: { suggestion },
            occurredAt: new Date().toISOString()
          }));
        }
      } catch (error) {
        const attempts = typeof job.opts.attempts === "number" ? job.opts.attempts : 1;
        if (job.attemptsMade + 1 >= attempts) {
          await store.recordAudit("chair.automation.failed", "chair_suggestion", data.chairSuggestionId, {
            meetingId: data.meetingId,
            classification: "runtime_failure",
            automationJobId: String(job.id),
            automationRevision: data.automationRevision
          });
          await publisher.publish(`council:meeting:${data.meetingId}`, JSON.stringify({
            type: "chair.automation.failed",
            meetingId: data.meetingId,
            data: { chairSuggestionId: data.chairSuggestionId, classification: "runtime_failure" },
            occurredAt: new Date().toISOString()
          }));
        }
        throw error;
      }
      return;
    }

    const meetingJobData = envelope.data as AgentTurnJobData | McpToolCallJobData | MeetingSummaryJobData;
    let agentTurnPersisted = false;
    let mcpToolRunPersisted = false;
    let meetingSummaryPersisted = false;
    let actionQueueItem: SpeakerQueueItem | null = null;
    let actionInProgress = false;
    let resolvedMcpArguments: Record<string, unknown> | undefined;
    try {
      let utterance;
      let replayedAgentUtterance: Utterance | null = null;
      let replayedMcpUtterance: Utterance | null = null;
      const mcpExecutionInput: PrepareMcpToolCallExecutionInput | null = envelope.name === "mcp-tool-call"
        ? (() => {
            if (!job.id) throw new Error("MCP tool job requires a stable job ID.");
            resolvedMcpArguments = resolveMcpToolCallArguments(
              envelope.data,
              String(job.id),
              secretVault,
              allowLegacyMcpArguments
            );
            return {
              store,
              jobId: String(job.id),
              meetingId: envelope.data.meetingId,
              agentId: envelope.data.agentId,
              ...(envelope.data.requestFingerprint
                ? { requestFingerprint: envelope.data.requestFingerprint }
                : {}),
              participantId: envelope.data.participantId,
              roleRevision: envelope.data.roleRevision,
              roleId: envelope.data.roleId,
              roleVersion: envelope.data.roleVersion,
              connectorId: envelope.data.connectorId,
              toolName: envelope.data.toolName,
              toolSnapshot: envelope.data.toolSnapshot,
              connectorFingerprint: envelope.data.connectorFingerprint,
              arguments: resolvedMcpArguments,
              deliveryAttempt: job.attemptsStarted,
              reservationRequired: true,
              mcpLocalHostAllowlist,
              secretVault,
              governance,
              onGovernanceObservationError: (error: unknown) => {
                observability.logOperationalError("worker.runtime.failed", error, {
                  jobId: String(job.id),
                  meetingId: envelope.data.meetingId,
                  resourceId: envelope.data.connectorId,
                  resourceType: "mcp_connector"
                });
              }
            };
          })()
        : null;
      if (envelope.name === "agent-turn") {
        if (!job.id) throw new Error("Meeting action job requires a stable job ID.");
        const prepared = await prepareAgentTurnExecution({
          store,
          jobId: String(job.id),
          meetingId: envelope.data.meetingId,
          agentId: envelope.data.agentId,
          deliveryAttempt: job.attemptsStarted,
          ...(envelope.data.reservationId ? { reservationId: envelope.data.reservationId } : {})
        });
        actionQueueItem = prepared.queueItem;
        actionInProgress = prepared.inProgress;
        replayedAgentUtterance = prepared.utterance;
        if (actionQueueItem) await publishSpeakerQueueChanged(actionQueueItem, "running");
      } else if (mcpExecutionInput) {
        const prepared = await prepareMcpToolCallExecution(mcpExecutionInput);
        actionQueueItem = prepared.queueItem;
        actionInProgress = prepared.inProgress;
        replayedMcpUtterance = prepared.utterance;
        if (actionQueueItem) await publishSpeakerQueueChanged(actionQueueItem, "running");
      }
      if (actionInProgress) return;
      if (envelope.name === "agent-turn") {
        const data = envelope.data;
        if (!job.id) throw new Error("Agent turn job requires a stable job ID.");
        const legacyAgendaBinding = data.agendaRevision === undefined && data.agendaCurrentItemId === undefined;
        utterance = replayedAgentUtterance ?? await processAgentTurn({
          store,
          meetingId: data.meetingId,
          agentId: data.agentId,
          participantId: data.participantId,
          roleRevision: data.roleRevision,
          roleId: data.roleId,
          roleVersion: data.roleVersion,
          turnId: String(job.id),
          ...(data.reservationId ? { reservationId: data.reservationId } : {}),
          agendaRevision: data.agendaRevision,
          agendaCurrentItemId: data.agendaCurrentItemId,
          allowLegacyAgendaBinding: legacyAgendaBinding,
          reservationRequired: true,
          requestedBy: data.requestedBy,
          ...(data.automationRevision === undefined ? {} : { automationRevision: data.automationRevision }),
          ...(data.chairSuggestionId ? { chairSuggestionId: data.chairSuggestionId } : {}),
          ...(data.modelConnectorBinding ? { modelConnectorBinding: data.modelConnectorBinding } : {}),
          ...(data.agentRevision === undefined ? {} : { agentRevision: data.agentRevision }),
          ...(data.promptBinding === undefined ? {} : { promptBinding: data.promptBinding }),
          ...(data.credentialBinding ? { credentialBinding: data.credentialBinding } : {}),
          ...(data.skillDigests ? { skillDigests: data.skillDigests } : {}),
          ...(data.runtimeProfileBinding ? { runtimeProfileBinding: data.runtimeProfileBinding } : {}),
          ...(data.runtimeProfileSnapshot ? { runtimeProfileSnapshot: data.runtimeProfileSnapshot } : {}),
          ...(data.runtimeRun ? { runtimeRun: data.runtimeRun } : {}),
          ...(data.runtimeProfileSnapshot?.harnessKind === "codex" && codexRuntimeHarness
            ? { harness: codexRuntimeHarness }
            : {}),
          secretVault
        });
        agentTurnPersisted = true;
        if (actionQueueItem) await publishSpeakerQueueChanged(actionQueueItem, "released", "completed");
      } else if (envelope.name === "mcp-tool-call") {
        if (!mcpExecutionInput) throw new Error("MCP tool job requires a stable execution input.");
        utterance = replayedMcpUtterance ?? await processMcpToolCall(mcpExecutionInput);
        mcpToolRunPersisted = true;
        if (actionQueueItem) await publishSpeakerQueueChanged(actionQueueItem, "released", "completed");
      } else if (envelope.name === "meeting-summary") {
        if (!job.id) throw new Error("Meeting summary job requires a stable job ID.");
        const summary = await processMeetingSummary(store, envelope.data.meetingId, String(job.id));
        if (!summary) return;
        utterance = summary;
        meetingSummaryPersisted = true;
      } else {
        throw new Error("Unsupported Council job contract.");
      }
      await publisher.publish(`council:meeting:${meetingJobData.meetingId}`, JSON.stringify({
        type: "utterance.created",
        meetingId: meetingJobData.meetingId,
        data: { utterance, jobId: String(job.id), jobName: envelope.name },
        occurredAt: new Date().toISOString()
      }));
      if (envelope.name === "agent-turn" && shouldCoordinateChairAfterAgentTurn(envelope.data)) {
        const coordinated = await coordinateChairIntervention({
          store,
          meetingId: meetingJobData.meetingId,
          sourceUtteranceId: utterance.id,
          enqueue: enqueueChairAutomation,
          getJobState: getBackgroundJobState,
          hasJob: (jobId) => queueOwnsJob(backgroundQueue, jobId)
        });
        if (coordinated.suggestion) {
          await publisher.publish(`council:meeting:${meetingJobData.meetingId}`, JSON.stringify({
            type: "chair.suggestion",
            meetingId: meetingJobData.meetingId,
            data: { suggestion: coordinated.suggestion },
            occurredAt: new Date().toISOString()
          }));
        }
        if (coordinated.disposition === "queue_unavailable") {
          await publisher.publish(`council:meeting:${meetingJobData.meetingId}`, JSON.stringify({
            type: "chair.automation.failed",
            meetingId: meetingJobData.meetingId,
            data: { chairSuggestionId: coordinated.suggestion?.id ?? null, classification: "queue_unavailable" },
            occurredAt: new Date().toISOString()
          }));
        }
      }
    } catch (error) {
      if (error instanceof StaleAgentTurnError) {
        const suggestionId = envelope.name === "agent-turn" ? envelope.data.chairSuggestionId : undefined;
        const reservationId = envelope.name === "agent-turn" ? envelope.data.reservationId : undefined;
        if (suggestionId) await store.releaseChairSuggestion(suggestionId, String(job.id), "stale_turn");
        const released = await (reservationId
          ? store.releaseSpeakerTurn(String(job.id), "stale_turn", reservationId)
          : store.releaseSpeakerTurn(String(job.id), "stale_turn"));
        if (released) await publishSpeakerQueueChanged(released, "released", "stale_turn");
        await store.recordAudit("agent.turn.cancelled", "meeting", meetingJobData.meetingId, {
          classification: "stale_turn",
          jobId: String(job.id)
        });
        await publisher.publish(`council:meeting:${meetingJobData.meetingId}`, JSON.stringify({
          type: "agent.cancelled",
          meetingId: meetingJobData.meetingId,
          data: { classification: "stale_turn", jobId: String(job.id), jobName: envelope.name },
          occurredAt: new Date().toISOString()
        }));
        return;
      }
      if (error instanceof StaleMcpToolRunError) {
        const released = await store.releaseSpeakerTurn(String(job.id), "stale_authorization");
        if (released) await publishSpeakerQueueChanged(released, "released", "stale_authorization");
        await store.recordAudit("mcp.tool.cancelled", "meeting", meetingJobData.meetingId, {
          classification: "stale_authorization",
          jobId: String(job.id)
        });
        await publisher.publish(`council:meeting:${meetingJobData.meetingId}`, JSON.stringify({
          type: "mcp.cancelled",
          meetingId: meetingJobData.meetingId,
          data: { classification: "stale_authorization", jobId: String(job.id), jobName: envelope.name },
          occurredAt: new Date().toISOString()
        }));
        return;
      }
      const attempts = typeof job.opts.attempts === "number" ? job.opts.attempts : 1;
      const durableResultPersisted = envelope.name === "agent-turn"
        ? agentTurnPersisted
        : envelope.name === "mcp-tool-call"
          ? mcpToolRunPersisted
          : meetingSummaryPersisted;
      const attemptDisposition = meetingActionFailureAttemptDisposition(
        envelope.name,
        durableResultPersisted,
        job.attemptsMade,
        attempts
      );
      if (attemptDisposition === "terminal_failure") {
        if ((envelope.name === "agent-turn" || envelope.name === "mcp-tool-call")
          && !durableResultPersisted
          && job.attemptsMade + 1 < attempts) {
          job.discard();
        }
        let failureMeetingId = meetingJobData.meetingId;
        let classification = envelope.name === "mcp-tool-call"
          ? "mcp_tool_failure"
          : envelope.name === "meeting-summary"
            ? "summary_failure"
            : error instanceof AgentTurnOutcomeUnknownError
              ? "agent_outcome_unknown"
              : "provider_or_runtime_failure";
        if (envelope.name === "mcp-tool-call") {
          const disposition = mcpToolFailureDisposition(mcpToolRunPersisted);
          classification = error instanceof McpToolOutcomeUnknownError
            ? "mcp_outcome_unknown"
            : error instanceof GovernanceDeniedError
              ? "governance_denied"
              : error instanceof GovernanceUnavailableError
                ? "governance_unavailable"
                : disposition;
          if (disposition === "event_delivery_failure") {
            await store.recordAudit("mcp.tool.delivery.failed", "meeting", meetingJobData.meetingId, {
              classification: disposition,
              jobId: String(job.id)
            });
            throw error;
          }
          const failure = await recordReservedMcpToolFailure({
            store,
            jobId: String(job.id),
            message: error instanceof McpToolOutcomeUnknownError
              ? "MCP 工具的外部執行結果無法確認。系統不會自動重送；會議已暫停，請先人工對帳。"
              : error instanceof GovernanceDeniedError
                ? "治理政策拒絕這次 MCP 工具呼叫，會議已暫停。請檢查政策判斷與工具權限後再繼續。"
                : error instanceof GovernanceUnavailableError
                  ? "治理服務或治理稽核目前無法確認，MCP 工具未執行且會議已暫停。"
                  : "MCP 工具無法完成呼叫，會議已暫停。請檢查 Connector 與權限後再繼續。"
          });
          if (failure.queueItem) failureMeetingId = failure.queueItem.meetingId;
          if (failure.existingRunStatus === "succeeded") {
            await store.recordAudit("mcp.tool.delivery.failed", "meeting", failureMeetingId, {
              classification: "commit_acknowledgement_unknown",
              jobId: String(job.id)
            });
            throw error;
          }
          if (!failure.recorded) {
            if (error instanceof McpToolOutcomeUnknownError) throw error;
            const released = await store.releaseSpeakerTurn(String(job.id), "stale_authorization");
            if (released) await publishSpeakerQueueChanged(released, "released", "stale_authorization");
            await store.recordAudit("mcp.tool.cancelled", "meeting", failureMeetingId, {
              classification: "stale_authorization",
              jobId: String(job.id)
            });
            await publisher.publish(`council:meeting:${failureMeetingId}`, JSON.stringify({
              type: "mcp.cancelled",
              meetingId: failureMeetingId,
              data: { classification: "stale_authorization", jobId: String(job.id), jobName: envelope.name },
              occurredAt: new Date().toISOString()
            }));
            return;
          }
          if (failure.queueItem) await publishSpeakerQueueChanged(failure.queueItem, "released", classification);
        } else if (envelope.name === "agent-turn") {
          const disposition = error instanceof AgentTurnOutcomeUnknownError
            ? "agent_outcome_unknown"
            : agentTurnFailureDisposition(agentTurnPersisted);
          if (disposition === "provider_or_runtime_failure" || disposition === "agent_outcome_unknown") {
            const agentData = envelope.data;
            const suggestionId = agentData.chairSuggestionId;
            if (agentData.requestedBy === "system" && disposition !== "agent_outcome_unknown") {
              const queueItem = (await store.getSnapshot()).speakerQueue.find((item) => item.jobId === String(job.id));
              await recordAutomaticChairTurnFailure(store, agentData, String(job.id), disposition);
              if (queueItem) await publishSpeakerQueueChanged(queueItem, "released", disposition);
            } else {
              await recordAgentTurnFailure(
                store,
                meetingJobData.meetingId,
                String(job.id),
                disposition === "agent_outcome_unknown"
                  ? "Agent 發言的模型執行結果無法確認。系統不會自動重送；會議已暫停，請先人工確認。"
                  : "模型或執行器無法完成發言，會議已暫停。請檢查 Connector 後再繼續。",
                agentData.reservationId,
                disposition
              );
              if (suggestionId) await store.releaseChairSuggestion(suggestionId, String(job.id), disposition);
              const released = await (agentData.reservationId
                ? store.releaseSpeakerTurn(String(job.id), disposition, agentData.reservationId)
                : store.releaseSpeakerTurn(String(job.id), disposition));
              if (released) await publishSpeakerQueueChanged(released, "released", disposition);
            }
          } else {
            await store.recordAudit("agent.turn.delivery.failed", "meeting", meetingJobData.meetingId, {
              classification: disposition,
              jobId: String(job.id)
            });
            throw error;
          }
        } else {
          const disposition = meetingSummaryFailureDisposition(meetingSummaryPersisted);
          if (disposition === "event_delivery_failure") {
            await store.recordAudit("meeting.summary.delivery.failed", "meeting", meetingJobData.meetingId, {
              classification: disposition,
              jobId: String(job.id)
            });
            throw error;
          }
          await store.setMeetingSummaryState(meetingJobData.meetingId, "failed", String(job.id));
          await store.recordAudit("meeting.summary.failed", "meeting", meetingJobData.meetingId, { classification: disposition });
        }
        await publisher.publish(`council:meeting:${failureMeetingId}`, JSON.stringify({
          type: envelope.name === "meeting-summary"
            ? "summary.failed"
            : envelope.name === "mcp-tool-call"
              ? "mcp.failed"
              : envelope.data.requestedBy === "system"
                ? "chair.automation.failed"
                : "agent.failed",
          meetingId: failureMeetingId,
          data: {
            classification,
            jobId: String(job.id),
            jobName: envelope.name,
            ...(envelope.name === "agent-turn"
              && envelope.data.requestedBy === "system"
              && envelope.data.chairSuggestionId
              ? { chairSuggestionId: envelope.data.chairSuggestionId }
              : {})
          },
          occurredAt: new Date().toISOString()
        }));
      }
      throw error;
    }
  })),
  {
    ...DEFERRED_BULLMQ_WORKER_OPTIONS,
    connection: connectionOptions(process.env.REDIS_URL),
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2)
  }
);

worker.on("error", (error) => {
  observability.logOperationalError("worker.runtime.failed", error);
});

let reconcilingSpeakerQueue = false;
const reconcileSpeakerQueue = async () => {
  if (reconcilingSpeakerQueue) return;
  reconcilingSpeakerQueue = true;
  try {
    const result = await reconcileSpeakerQueueLeases({
      store,
      findJob: async (jobId) => (await backgroundQueue.getJob(jobId)) ?? null
    });
    for (const released of result.released) {
      await publishSpeakerQueueChanged(released.item, "released", released.reason);
    }
  } catch (error) {
    observability.logOperationalError("speaker_queue.reconcile.failed", error);
  } finally {
    reconcilingSpeakerQueue = false;
  }
};
let reconcilingDurableJobs = false;
const reconcileDurableJobs = async () => {
  if (reconcilingDurableJobs) return;
  reconcilingDurableJobs = true;
  try {
    await recoverOrphanedAsyncState({
      store,
      findJob: async (jobId) => (await backgroundQueue.getJob(jobId)) ?? null,
      enqueueMeetingSummary: enqueueRecoveredMeetingSummary,
      scope: "background-jobs"
    });
    await recoverFailedGoalTaskBindings({
      store,
      findJob: async (jobId) => (await backgroundQueue.getJob(jobId)) ?? null,
      continueGoal: continueGoalRun
    });
    await recoverDurableGoalJobs();
    await recoverOmpRuntimeRuns();
  } catch (error) {
    observability.logOperationalError("async_state.reconcile.failed", error);
  } finally {
    reconcilingDurableJobs = false;
  }
};
healthServer = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://worker");
    const path = url.pathname;
    const actionAdapterHealth = path === "/health/harness-action-adapter";
    const ompRuntimeHealth = path === "/health/omp-runtime";
    if (path !== "/health" && !actionAdapterHealth && !ompRuntimeHealth) {
      response.writeHead(404).end();
      return;
    }
    try {
      const runtimeStatus = harnessActionAdapterHealthStatus({
        enabled: harnessActionAdapterEnabled,
        workerReady: lifecycle.isHealthAvailable() && worker.isRunning()
      });
      if (actionAdapterHealth && runtimeStatus.status !== "ready") {
        response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify(runtimeStatus));
        return;
      }
      if (ompRuntimeHealth) {
        if (!ompBroker || !(await ompBroker.health()).ready) {
          response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ status: "not_ready" }));
          return;
        }
      }
      if (!lifecycle.isHealthAvailable() || !worker.isRunning()) {
        throw new Error("Worker is not accepting work.");
      }
      const checks: Array<Promise<unknown>> = [
        worker.waitUntilReady(),
        backgroundQueue.waitUntilReady(),
        redisPublisher.ping(),
        store.checkHealth()
      ];
      if (codexRuntimeHarness) {
        checks.push(codexRuntimeHarness.health({ baseUrl: "http://127.0.0.1" }).then((health) => {
          if (!health.healthy) throw new Error(health.detail ?? "Codex CLI harness is unhealthy.");
        }));
      }
      if (actionAdapterHealth) {
        const adapterIds = url.searchParams.getAll("adapterId");
        checks.push(store.listActionAdapters().then((adapters) => {
          assertHarnessActionAdapterReadiness(adapterIds, adapters);
        }));
      }
      await withWorkerHealthCheckTimeout(Promise.all(checks));
      if (!lifecycle.isHealthAvailable() || !worker.isRunning()) {
        throw new Error("Worker stopped accepting work during the health check.");
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ready" }));
    } catch {
      response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ status: "not_ready" }));
    }
  })();
});

type ShutdownCompletion =
  | { ok: true }
  | { ok: false; error: unknown };
interface ShutdownRequest {
  signal: NodeJS.Signals;
  completion: Promise<ShutdownCompletion>;
}

const { shutdownRequested, workerRun } = await armWorkerStartup({
  openHealthIntake: async () => {
    await backgroundQueue.waitUntilReady();
    const asyncStateRecovery = await recoverOrphanedAsyncState({
      store,
      findJob: async (jobId) => (await backgroundQueue.getJob(jobId)) ?? null,
      enqueueMeetingSummary: enqueueRecoveredMeetingSummary
    });
    observability.logAsyncStateRecovery(asyncStateRecovery);
    observability.logMeetingRecordBackfill(await backfillMeetingRecords(store));
    await recoverFailedGoalTaskBindings({
      store,
      findJob: async (jobId) => (await backgroundQueue.getJob(jobId)) ?? null,
      continueGoal: continueGoalRun
    });
    await recoverDurableGoalJobs(true);
    await recoverOmpRuntimeRuns(true);

    speakerQueueTimer = setInterval(() => {
      void lifecycle.runInFlight(reconcileSpeakerQueue).catch(() => undefined);
    }, 30_000);
    speakerQueueTimer.unref();
    void lifecycle.runInFlight(reconcileSpeakerQueue).catch(() => undefined);
    durableJobRecoveryTimer = setInterval(() => {
      void lifecycle.runInFlight(reconcileDurableJobs).catch(() => undefined);
    }, 30_000);
    durableJobRecoveryTimer.unref();

    await healthIntake.open();
  },
  armShutdown: () => new Promise<ShutdownRequest>((resolve) => {
    let requested = false;
    const requestShutdown = (signal: NodeJS.Signals) => {
      if (requested) return;
      requested = true;
      const completion = lifecycle.shutdown().then<ShutdownCompletion, ShutdownCompletion>(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error })
      );
      resolve({ signal, completion });
    };
    process.once("SIGTERM", () => requestShutdown("SIGTERM"));
    process.once("SIGINT", () => requestShutdown("SIGINT"));
  }),
  markReady: () => lifecycle.markReady(),
  startWorker: () => worker.run(),
  closeAllocatedResources: async () => {
    await lifecycle.shutdown();
  }
});

const terminal = await Promise.race([
  shutdownRequested.then((request) => ({ kind: "shutdown" as const, request })),
  workerRun.then(
    () => ({ kind: "worker-stopped" as const }),
    (error: unknown) => ({ kind: "worker-failed" as const, error })
  )
]);

if (terminal.kind === "shutdown") {
  const completion = await terminal.request.completion;
  if (!completion.ok) throw completion.error;
  return;
}

await lifecycle.shutdown();
if (terminal.kind === "worker-failed") throw terminal.error;
throw new Error("BullMQ Worker stopped unexpectedly.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startWorker().catch((error: unknown) => {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    process.stderr.write(`worker terminated with ${errorType}\n`);
    process.exitCode = 1;
  });
}
