import { createHash, randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import {
  createCouncilJobEnvelope,
  type AgentTurnJobData,
  type ChairAutomationJobData,
  type CouncilJobEnvelope,
  type CouncilJobName,
  type GoalActionRunJobData,
  type GoalOrchestrateJobData,
  type GoalPlanJobData,
  type GoalReviewJobData,
  type McpToolCallJobData,
  type MeetingSummaryJobData,
  type RuntimeControlJobData,
  type TaskAgentRunJobData,
  type TaskSyncJobData
} from "@council/contracts";

function meetingActionResult(meetingId: string, requestedJobId: string, queuedJobId: string | undefined): { jobId: string } {
  if (queuedJobId !== requestedJobId) {
    throw Object.assign(
      new Error(`Meeting "${meetingId}" already has a queued or active action; requested job "${requestedJobId}" was not enqueued.`),
      { statusCode: 409 }
    );
  }
  return { jobId: requestedJobId };
}

function taskSyncResult(taskId: string, requestedJobId: string, queuedJobId: string | undefined): { jobId: string } {
  if (queuedJobId !== requestedJobId) {
    throw Object.assign(
      new Error(`Task "${taskId}" already has a queued or active synchronization.`),
      { statusCode: 409 }
    );
  }
  return { jobId: requestedJobId };
}

function taskAgentRunResult(taskId: string, requestedJobId: string, queuedJobId: string | undefined): { jobId: string } {
  if (queuedJobId !== requestedJobId) {
    throw Object.assign(
      new Error(`Task "${taskId}" already has a queued or active Agent run.`),
      { statusCode: 409 }
    );
  }
  return { jobId: requestedJobId };
}

export interface AgentTurnQueue {
  enqueue(job: AgentTurnJobData, requestedJobId?: string): Promise<{ jobId: string }>;
  enqueueToolCall(job: McpToolCallJobData, requestedJobId?: string): Promise<{ jobId: string }>;
  enqueueMeetingSummary(job: MeetingSummaryJobData, requestedJobId?: string): Promise<{ jobId: string }>;
  enqueueChairAutomation?(job: ChairAutomationJobData, requestedJobId?: string): Promise<{ jobId: string }>;
  enqueueTaskSync?(job: TaskSyncJobData, requestedJobId?: string): Promise<{ jobId: string }>;
  enqueueTaskAgentRun?(job: TaskAgentRunJobData, requestedJobId: string): Promise<{ jobId: string }>;
  enqueueGoalOrchestrate?(job: GoalOrchestrateJobData, requestedJobId: string): Promise<{ jobId: string }>;
  enqueueGoalPlan?(job: GoalPlanJobData, requestedJobId: string): Promise<{ jobId: string }>;
  enqueueGoalReview?(job: GoalReviewJobData, requestedJobId: string): Promise<{ jobId: string }>;
  enqueueGoalActionRun?(job: GoalActionRunJobData, requestedJobId: string): Promise<{ jobId: string }>;
  enqueueRuntimeControl?(job: RuntimeControlJobData, requestedJobId: string): Promise<{ jobId: string }>;
  hasJob?(jobId: string): Promise<boolean>;
  getJobState?(jobId: string): Promise<string | null>;
  /** MCP admission requires this capability and rejects the queue before persistence when it is absent. */
  inspectJob?(jobId: string): Promise<{ state: string; data: unknown } | null>;
  ready?(): Promise<void>;
  close(): Promise<void>;
}

const retainedMcpFailures = {
  age: 7 * 24 * 60 * 60,
  count: 500
} as const;

const queueOwnedBullJobStates: ReadonlySet<string> = new Set([
  "active",
  "delayed",
  "prioritized",
  "waiting",
  "waiting-children"
]);

export class BullAgentTurnQueue implements AgentTurnQueue {
  private readonly queue: Queue<CouncilJobEnvelope, void, CouncilJobName>;

  constructor(redisUrl: string) {
    const url = new URL(redisUrl);
    this.queue = new Queue<CouncilJobEnvelope, void, CouncilJobName>("council-background-jobs", {
      connection: {
        host: url.hostname,
        port: Number(url.port || 6379),
        ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
        ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
        ...(url.protocol === "rediss:" ? { tls: {} } : {})
      }
    });
  }

  async enqueue(
    job: AgentTurnJobData,
    requestedJobId = agentTurnJobId(job.meetingId, job.agentId, job.chairSuggestionId)
  ): Promise<{ jobId: string }> {
    const queued = await this.queue.add("agent-turn", createCouncilJobEnvelope("agent-turn", job), {
      attempts: 2,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: 500,
      removeOnFail: 500,
      deduplication: { id: `meeting-action-${job.meetingId}` },
      jobId: requestedJobId
    });
    return meetingActionResult(job.meetingId, requestedJobId, queued.id);
  }

  async enqueueToolCall(
    job: McpToolCallJobData,
    requestedJobId = mcpToolJobId(job.meetingId, randomUUID())
  ): Promise<{ jobId: string }> {
    const queued = await this.queue.add("mcp-tool-call", createCouncilJobEnvelope("mcp-tool-call", job), {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: retainedMcpFailures,
      deduplication: { id: `meeting-action-${job.meetingId}` },
      jobId: requestedJobId
    });
    return meetingActionResult(job.meetingId, requestedJobId, queued.id);
  }

  async enqueueMeetingSummary(
    job: MeetingSummaryJobData,
    requestedJobId = meetingSummaryJobId(job.meetingId)
  ): Promise<{ jobId: string }> {
    const queued = await this.queue.add("meeting-summary", createCouncilJobEnvelope("meeting-summary", job), {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 500,
      removeOnFail: 500,
      deduplication: { id: `meeting-summary-${job.meetingId}` },
      jobId: requestedJobId
    });
    if (queued.id !== requestedJobId) {
      throw Object.assign(new Error(`Meeting "${job.meetingId}" already has a queued or active summary.`), { statusCode: 409 });
    }
    return { jobId: requestedJobId };
  }

  async enqueueChairAutomation(
    job: ChairAutomationJobData,
    requestedJobId = chairAutomationJobId(job.meetingId, job.chairSuggestionId)
  ): Promise<{ jobId: string }> {
    const queued = await this.queue.add("chair-automation", createCouncilJobEnvelope("chair-automation", job), {
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: 500,
      removeOnFail: 500,
      deduplication: { id: `chair-automation-${job.chairSuggestionId}` },
      jobId: requestedJobId
    });
    if (queued.id !== requestedJobId) {
      throw Object.assign(new Error("Chair automation was not enqueued with its stable suggestion job ID."), { statusCode: 409 });
    }
    const queueState = await queued.getState();
    if (!queueOwnedBullJobStates.has(queueState)) {
      throw Object.assign(
        new Error(`Chair automation job is in a terminal or unsupported state (${queueState}).`),
        { statusCode: 409 }
      );
    }
    return { jobId: requestedJobId };
  }

  async hasJob(jobId: string): Promise<boolean> {
    const job = await this.queue.getJob(jobId);
    if (!job) return false;

    // Preserve lookup failures as unknown ownership for callers to handle safely.
    const state = await job.getState();
    return queueOwnedBullJobStates.has(state);
  }

  async getJobState(jobId: string): Promise<string | null> {
    const job = await this.queue.getJob(jobId);
    return job ? await job.getState() : null;
  }

  async inspectJob(jobId: string): Promise<{ state: string; data: unknown } | null> {
    const job = await this.queue.getJob(jobId);
    if (!job) return null;
    return { state: await job.getState(), data: job.data };
  }

  async enqueueTaskSync(job: TaskSyncJobData, requestedJobId = taskSyncJobId(job.taskId)): Promise<{ jobId: string }> {
    const queued = await this.queue.add("task-sync", createCouncilJobEnvelope("task-sync", job), {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      delay: 1_000,
      removeOnComplete: 500,
      removeOnFail: 500,
      deduplication: { id: `task-sync-${job.taskId}` },
      jobId: requestedJobId
    });
    return taskSyncResult(job.taskId, requestedJobId, queued.id);
  }

  async enqueueTaskAgentRun(job: TaskAgentRunJobData, requestedJobId: string): Promise<{ jobId: string }> {
    const queued = await this.queue.add("task-agent-run", createCouncilJobEnvelope("task-agent-run", job), {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      delay: 1_000,
      removeOnComplete: 500,
      removeOnFail: 500,
      deduplication: { id: `task-agent-run-${job.taskId}` },
      jobId: requestedJobId
    });
    return taskAgentRunResult(job.taskId, requestedJobId, queued.id);
  }

  async enqueueGoalOrchestrate(job: GoalOrchestrateJobData, requestedJobId: string): Promise<{ jobId: string }> {
    return this.enqueueGoalJob("goal-orchestrate", job, requestedJobId, `goal-orchestrate-${job.goalRunId}`);
  }

  async enqueueGoalPlan(job: GoalPlanJobData, requestedJobId: string): Promise<{ jobId: string }> {
    return this.enqueueGoalJob("goal-plan", job, requestedJobId, `goal-plan-${job.goalRunId}`);
  }

  async enqueueGoalReview(job: GoalReviewJobData, requestedJobId: string): Promise<{ jobId: string }> {
    return this.enqueueGoalJob("goal-review", job, requestedJobId, `goal-review-${job.goalRunId}-${job.scope}-${job.scopeId}`);
  }

  async enqueueGoalActionRun(job: GoalActionRunJobData, requestedJobId: string): Promise<{ jobId: string }> {
    return this.enqueueGoalJob("goal-action-run", job, requestedJobId, `goal-action-${job.actionRunId}`);
  }

  async enqueueRuntimeControl(job: RuntimeControlJobData, requestedJobId: string): Promise<{ jobId: string }> {
    const queued = await this.queue.add("runtime-control", createCouncilJobEnvelope("runtime-control", job), {
      attempts: 3,
      backoff: { type: "exponential", delay: 500 },
      delay: 500,
      removeOnComplete: 500,
      removeOnFail: retainedMcpFailures,
      deduplication: { id: `runtime-control-${job.runtimeRunId}-${job.commandRevision}` },
      jobId: requestedJobId
    });
    if (queued.id !== requestedJobId) {
      throw Object.assign(new Error(`Runtime control ${requestedJobId} was not admitted by the queue.`), { statusCode: 409 });
    }
    return { jobId: requestedJobId };
  }

  async ready(): Promise<void> {
    await this.queue.waitUntilReady();
  }

  async close(): Promise<void> {
    await this.queue.close();
  }

  private async enqueueGoalJob<
    Name extends "goal-orchestrate" | "goal-plan" | "goal-review" | "goal-action-run",
    Data extends GoalOrchestrateJobData | GoalPlanJobData | GoalReviewJobData | GoalActionRunJobData
  >(name: Name, data: Data, requestedJobId: string, deduplicationId: string): Promise<{ jobId: string }> {
    const envelope = createCouncilJobEnvelope(name as never, data as never) as unknown as CouncilJobEnvelope;
    const queued = await this.queue.add(name, envelope, {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 500,
      removeOnFail: 500,
      deduplication: { id: deduplicationId },
      jobId: requestedJobId
    });
    if (queued.id !== requestedJobId) {
      throw Object.assign(new Error(`Goal job ${requestedJobId} was not admitted by the queue.`), { statusCode: 409 });
    }
    return { jobId: requestedJobId };
  }
}

export function goalOrchestrateJobId(goalRunId: string, requestFingerprint: string): string {
  return `${goalRunId}-goal-orchestrate-${requestFingerprint.slice(0, 40)}`;
}

export function meetingSummaryJobId(meetingId: string): string {
  return `${meetingId}-summary-${randomUUID()}`;
}

export function agentTurnJobId(meetingId: string, agentId: string, chairSuggestionId?: string): string {
  return chairSuggestionId
    ? `${meetingId}-${agentId}-chair-${chairSuggestionId}-${randomUUID()}`
    : `${meetingId}-${agentId}-${randomUUID()}`;
}

export function chairAutomationJobId(meetingId: string, suggestionId: string): string {
  return `${meetingId}-chair-auto-${suggestionId}`;
}

export function taskSyncJobId(taskId: string): string {
  return `${taskId}-sync-${randomUUID()}`;
}

export function mcpToolJobId(meetingId: string, idempotencyKey: string): string {
  const digest = createHash("sha256").update(`${meetingId}\0${idempotencyKey}`).digest("hex").slice(0, 40);
  return `${meetingId}-tool-${digest}`;
}

export function taskAgentRunJobId(taskId: string, idempotencyKey: string): string {
  const digest = createHash("sha256").update(`${taskId}\0${idempotencyKey}`).digest("hex").slice(0, 40);
  return `${taskId}-task-agent-${digest}`;
}

export function runtimeControlJobId(runtimeRunId: string, action: RuntimeControlJobData["action"], commandRevision: number): string {
  return `${runtimeRunId}-runtime-${action}-${commandRevision}`;
}
