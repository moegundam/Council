import {
  StaleTaskAgentRunError,
  TaskAgentRunNotReadyError,
  TaskAgentRunOutcomeUnknownError
} from "./process-task-agent-run.js";
import {
  StaleTaskSyncError,
  TaskSyncAttemptError,
  TaskSyncNotReadyError,
  TaskSyncPayloadChangedError
} from "./process-task-sync.js";

const queueOwnedStates = new Set(["active", "delayed", "prioritized", "waiting", "waiting-children"]);

export interface QueueJobLookup {
  getJob(jobId: string): Promise<{ getState(): Promise<string> } | null | undefined>;
}

export async function queueOwnsJob(queue: QueueJobLookup, jobId: string): Promise<boolean> {
  const job = await queue.getJob(jobId);
  return job ? queueOwnedStates.has(await job.getState()) : false;
}

export function agentTurnFailureDisposition(
  utterancePersisted: boolean
): "provider_or_runtime_failure" | "event_delivery_failure" {
  return utterancePersisted ? "event_delivery_failure" : "provider_or_runtime_failure";
}

export function meetingSummaryFailureDisposition(
  summaryPersisted: boolean
): "summary_failure" | "event_delivery_failure" {
  return summaryPersisted ? "event_delivery_failure" : "summary_failure";
}

export function mcpToolFailureDisposition(
  toolRunPersisted: boolean
): "mcp_tool_failure" | "event_delivery_failure" {
  return toolRunPersisted ? "event_delivery_failure" : "mcp_tool_failure";
}

export function meetingActionFailureAttemptDisposition(
  jobName: "agent-turn" | "mcp-tool-call" | "meeting-summary",
  durableResultPersisted: boolean,
  attemptsMade = 0,
  configuredAttempts?: number
): "retry_delivery" | "terminal_failure" {
  const attempts = typeof configuredAttempts === "number"
    && Number.isSafeInteger(configuredAttempts)
    && configuredAttempts > 0
    ? configuredAttempts
    : 1;
  const hasAttemptRemaining = Number.isSafeInteger(attemptsMade)
    && attemptsMade >= 0
    && attemptsMade + 1 < attempts;
  if (!hasAttemptRemaining) return "terminal_failure";
  if ((jobName === "agent-turn" || jobName === "mcp-tool-call") && !durableResultPersisted) {
    return "terminal_failure";
  }
  return "retry_delivery";
}

export function taskAgentRunFailureDisposition(
  error: unknown,
  attemptsMade = 0,
  configuredAttempts?: number
): "stale" | "retryable" | "provider_outcome_unknown" | "provider_or_runtime_failure" {
  if (error instanceof StaleTaskAgentRunError) return "stale";
  if (error instanceof TaskAgentRunNotReadyError) return "retryable";
  if (error instanceof TaskAgentRunOutcomeUnknownError) return "provider_outcome_unknown";
  const attempts = typeof configuredAttempts === "number"
    && Number.isSafeInteger(configuredAttempts)
    && configuredAttempts > 0
    ? configuredAttempts
    : 1;
  if (Number.isSafeInteger(attemptsMade) && attemptsMade >= 0 && attemptsMade + 1 < attempts) {
    return "retryable";
  }
  return "provider_or_runtime_failure";
}

export function taskSyncFailureDisposition(
  error: unknown
): "stale" | "retryable" | "payload_churn" | "provider_or_runtime_failure" {
  if (error instanceof StaleTaskSyncError) return "stale";
  if (error instanceof TaskSyncPayloadChangedError) return "payload_churn";
  if (error instanceof TaskSyncNotReadyError) return "retryable";
  if (error instanceof TaskSyncAttemptError) return taskSyncFailureDisposition(error.cause);
  return "provider_or_runtime_failure";
}
