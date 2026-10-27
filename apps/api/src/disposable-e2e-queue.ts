import { randomUUID } from "node:crypto";
import type {
  AgentTurnJobData,
  ChairAutomationJobData,
  GoalActionRunJobData,
  GoalOrchestrateJobData,
  GoalPlanJobData,
  GoalReviewJobData,
  McpToolCallJobData,
  MeetingSummaryJobData,
  TaskAgentRunJobData,
  TaskSyncJobData
} from "@council/contracts";
import type { AgentTurnQueue } from "./agent-queue.js";

const disposableMarker = "council-agent-meeting-platform-disposable-e2e-v1";

function assertDisposableEnvironment(environment: NodeJS.ProcessEnv): void {
  if (environment.E2E_DISPOSABLE_MARKER !== disposableMarker) {
    throw new Error("Disposable E2E marker is missing or invalid.");
  }
  if (environment.NODE_ENV === "production") {
    throw new Error("Disposable E2E runtime cannot run with NODE_ENV=production.");
  }
}

function acceptedJob(requestedJobId?: string): Promise<{ jobId: string }> {
  return Promise.resolve({ jobId: requestedJobId ?? randomUUID() });
}

class DisposableE2eAgentQueue implements AgentTurnQueue {
  enqueue(_job: AgentTurnJobData, requestedJobId?: string) {
    return acceptedJob(requestedJobId);
  }

  enqueueToolCall(_job: McpToolCallJobData, requestedJobId?: string) {
    return acceptedJob(requestedJobId);
  }

  enqueueMeetingSummary(_job: MeetingSummaryJobData, requestedJobId?: string) {
    return acceptedJob(requestedJobId);
  }

  enqueueChairAutomation(_job: ChairAutomationJobData, requestedJobId?: string) {
    return acceptedJob(requestedJobId);
  }

  enqueueTaskSync(_job: TaskSyncJobData, requestedJobId?: string) {
    return acceptedJob(requestedJobId);
  }

  enqueueTaskAgentRun(_job: TaskAgentRunJobData, requestedJobId: string) {
    return acceptedJob(requestedJobId);
  }

  enqueueGoalOrchestrate(_job: GoalOrchestrateJobData, requestedJobId: string) {
    return acceptedJob(requestedJobId);
  }

  enqueueGoalPlan(_job: GoalPlanJobData, requestedJobId: string) {
    return acceptedJob(requestedJobId);
  }

  enqueueGoalReview(_job: GoalReviewJobData, requestedJobId: string) {
    return acceptedJob(requestedJobId);
  }

  enqueueGoalActionRun(_job: GoalActionRunJobData, requestedJobId: string) {
    return acceptedJob(requestedJobId);
  }

  ready() {
    return Promise.resolve();
  }

  close() {
    return Promise.resolve();
  }
}

export function disposableE2eAgentQueueFromEnv(
  environment: NodeJS.ProcessEnv = process.env
): AgentTurnQueue | undefined {
  if (environment.E2E_DEPLOYMENT_CLASS !== "disposable") return undefined;
  assertDisposableEnvironment(environment);
  if (environment.REDIS_URL) {
    throw new Error("Disposable E2E Agent queue cannot shadow a configured Redis queue.");
  }
  return new DisposableE2eAgentQueue();
}

export function disposableE2eOwnerSeedFromEnv(
  environment: NodeJS.ProcessEnv = process.env
): { email: string; password: string } | undefined {
  if (environment.E2E_DEPLOYMENT_CLASS !== "disposable") return undefined;
  assertDisposableEnvironment(environment);
  const email = environment.E2E_OWNER_EMAIL?.trim();
  const password = environment.E2E_OWNER_PASSWORD;
  if (!email || !password || password.length < 16) {
    throw new Error("Disposable E2E Owner credentials are missing or too short.");
  }
  return { email, password };
}

export function disposableE2eTestLoginEnabledFromEnv(
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  if (environment.TEST_LOGIN_ENABLED !== "true") return false;
  if (environment.E2E_DEPLOYMENT_CLASS !== "disposable") {
    throw new Error("Direct test login requires the disposable E2E deployment class.");
  }
  assertDisposableEnvironment(environment);
  return true;
}
