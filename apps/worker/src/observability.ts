import { performance } from "node:perf_hooks";
import type { AsyncStateRecoveryResult } from "./async-state-recovery.js";
import type { MeetingRecordBackfillResult } from "./meeting-record-backfill.js";

export type WorkerResourceType =
  | "governance_provider"
  | "mcp_connector"
  | "model_connector"
  | "task_adapter"
  | "runtime_profile";
export type WorkerErrorClassification =
  | "dependency_unavailable"
  | "invalid_job_contract"
  | "permission_denied"
  | "provider_or_runtime_failure"
  | "stale_execution"
  | "timeout";

interface WorkerCorrelation {
  jobId?: string;
  meetingId?: string;
  taskId?: string;
  runId?: string;
  resourceId?: string;
  resourceType?: WorkerResourceType;
}

interface WorkerJobLogBase extends WorkerCorrelation {
  timestamp: string;
  level: "info" | "error";
  service: "worker";
  event: "worker.job.started" | "worker.job.completed" | "worker.job.failed";
  jobId: string;
  jobName: string;
  attempt: number;
}

export type WorkerJobLog = WorkerJobLogBase & {
  durationMs?: number;
  errorClassification?: WorkerErrorClassification;
  errorType?: string;
};

export interface WorkerOperationalErrorLog extends WorkerCorrelation {
  timestamp: string;
  level: "error";
  service: "worker";
  event:
    | "async_state.reconcile.failed"
    | "governance.provider.initialization.failed"
    | "speaker_queue.publish.failed"
    | "speaker_queue.reconcile.failed"
    | "task_event.publish.failed"
    | "worker.runtime.failed";
  errorClassification: WorkerErrorClassification;
  errorType: string;
}

export interface WorkerAsyncStateRecoveryLog extends AsyncStateRecoveryResult {
  timestamp: string;
  level: "info";
  service: "worker";
  event: "worker.async_state.recovered";
}

export interface WorkerMeetingRecordBackfillLog extends MeetingRecordBackfillResult {
  timestamp: string;
  level: "info";
  service: "worker";
  event: "worker.meeting_records.backfilled";
}

export type WorkerLogEntry =
  | WorkerJobLog
  | WorkerOperationalErrorLog
  | WorkerAsyncStateRecoveryLog
  | WorkerMeetingRecordBackfillLog;

export interface ObservedJob {
  jobId: string;
  jobName: string;
  attempt: number;
  payload: unknown;
}

export interface WorkerObservabilityOptions {
  emit?: (entry: WorkerLogEntry) => void;
  now?: () => number;
  timestamp?: () => string;
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,499}$/;
const timeoutCodes = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"]);
const dependencyCodes = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND"]);
const permissionCodes = new Set(["EACCES", "EPERM"]);
const knownErrorTypes = new Set([
  "AbortError",
  "AgentTurnOutcomeUnknownError",
  "Error",
  "GovernanceDeniedError",
  "GovernanceUnavailableError",
  "RangeError",
  "McpToolOutcomeUnknownError",
  "StaleAgentTurnError",
  "StaleMcpToolRunError",
  "StaleTaskAgentRunError",
  "StaleTaskSyncError",
  "TaskSyncAttemptError",
  "TaskSyncNotReadyError",
  "TaskSyncPayloadChangedError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
  "ZodError"
]);

function defaultEmit(entry: WorkerLogEntry): void {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && identifierPattern.test(value) ? value : undefined;
}

function jobData(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload) ?? {};
  return record.contractVersion !== undefined && typeof record.name === "string"
    ? asRecord(record.data) ?? {}
    : record;
}

function nestedIdentifier(record: Record<string, unknown>, field: string, nestedField = "id"): string | undefined {
  return identifier(asRecord(record[field])?.[nestedField]);
}

function correlationFor(jobName: string, payload: unknown): WorkerCorrelation {
  const data = jobData(payload);
  const meetingId = identifier(data.meetingId);
  const taskId = identifier(data.taskId);
  const runId = nestedIdentifier(data, "runtimeRun");
  const correlation: WorkerCorrelation = {
    ...(meetingId ? { meetingId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(runId ? { runId } : {})
  };

  if (jobName === "mcp-tool-call") {
    const resourceId = identifier(data.connectorId);
    return resourceId ? { ...correlation, resourceId, resourceType: "mcp_connector" } : correlation;
  }
  if (jobName === "task-sync") {
    const resourceId = identifier(data.adapterId);
    return resourceId ? { ...correlation, resourceId, resourceType: "task_adapter" } : correlation;
  }

  const modelConnectorId = nestedIdentifier(data, "modelConnectorBinding");
  if (modelConnectorId) return { ...correlation, resourceId: modelConnectorId, resourceType: "model_connector" };
  const runtimeProfileId = nestedIdentifier(data, "runtimeProfileBinding", "profileId");
  return runtimeProfileId
    ? { ...correlation, resourceId: runtimeProfileId, resourceType: "runtime_profile" }
    : correlation;
}

function errorCode(error: unknown): string | undefined {
  return identifier(asRecord(error)?.code);
}

function errorName(error: unknown): string {
  const name = error instanceof Error ? error.name : undefined;
  return name && knownErrorTypes.has(name) ? name : "Error";
}

export function classifyWorkerError(error: unknown): WorkerErrorClassification {
  const name = errorName(error);
  const code = errorCode(error);
  if (name.startsWith("Stale")) return "stale_execution";
  if (name === "ZodError" || name === "SyntaxError") return "invalid_job_contract";
  if (name === "AbortError" || name === "TimeoutError" || (code && timeoutCodes.has(code))) return "timeout";
  if (code && dependencyCodes.has(code)) return "dependency_unavailable";
  if (code && permissionCodes.has(code)) return "permission_denied";
  return "provider_or_runtime_failure";
}

function roundedDuration(value: number): number {
  return Math.max(0, Number(value.toFixed(3)));
}

export function createWorkerObservability(options: WorkerObservabilityOptions = {}) {
  const emit = options.emit ?? defaultEmit;
  const now = options.now ?? (() => performance.now());
  const timestamp = options.timestamp ?? (() => new Date().toISOString());

  const safeEmit = (entry: WorkerLogEntry): void => {
    try {
      emit(entry);
    } catch {
      // Observability must not change job outcomes.
    }
  };

  return {
    async observeJob<T>(job: ObservedJob, operation: () => Promise<T>): Promise<T> {
      const startedAt = now();
      const context = {
        jobId: identifier(job.jobId) ?? "unknown",
        jobName: identifier(job.jobName) ?? "unknown",
        attempt: Number.isSafeInteger(job.attempt) && job.attempt > 0 ? job.attempt : 1,
        ...correlationFor(job.jobName, job.payload)
      };
      safeEmit({
        timestamp: timestamp(),
        level: "info",
        service: "worker",
        event: "worker.job.started",
        ...context
      });
      try {
        const result = await operation();
        safeEmit({
          timestamp: timestamp(),
          level: "info",
          service: "worker",
          event: "worker.job.completed",
          ...context,
          durationMs: roundedDuration(now() - startedAt)
        });
        return result;
      } catch (error) {
        safeEmit({
          timestamp: timestamp(),
          level: "error",
          service: "worker",
          event: "worker.job.failed",
          ...context,
          durationMs: roundedDuration(now() - startedAt),
          errorClassification: classifyWorkerError(error),
          errorType: errorName(error)
        });
        throw error;
      }
    },

    logOperationalError(
      event: WorkerOperationalErrorLog["event"],
      error: unknown,
      correlation: WorkerCorrelation = {}
    ): void {
      safeEmit({
        timestamp: timestamp(),
        level: "error",
        service: "worker",
        event,
        ...correlation,
        errorClassification: classifyWorkerError(error),
        errorType: errorName(error)
      });
    },

    logAsyncStateRecovery(result: AsyncStateRecoveryResult): void {
      safeEmit({
        timestamp: timestamp(),
        level: "info",
        service: "worker",
        event: "worker.async_state.recovered",
        ...result
      });
    },

    logMeetingRecordBackfill(result: MeetingRecordBackfillResult): void {
      safeEmit({
        timestamp: timestamp(),
        level: "info",
        service: "worker",
        event: "worker.meeting_records.backfilled",
        ...result
      });
    }
  };
}
