import type { TaskSyncState } from "@council/contracts";
import { taskAgentAdmissionLeaseActive, type PlatformStore } from "@council/database";
import { recordReservedAgentTurnFailure } from "./process-agent-turn.js";
import { recordReservedMcpToolFailure } from "./process-mcp-tool-call.js";

const queueOwnedStates = new Set([
  "active",
  "delayed",
  "paused",
  "prioritized",
  "waiting",
  "waiting-children"
]);
const taskSyncAdmissionLeaseMs = 5 * 60_000;

function taskSyncAdmissionLeaseActive(
  sync: Pick<TaskSyncState, "status" | "lastAttemptAt">,
  now: number
): boolean {
  if (sync.status !== "queued" || !sync.lastAttemptAt) return false;
  const requestedAt = Date.parse(sync.lastAttemptAt);
  return Number.isFinite(requestedAt) && requestedAt + taskSyncAdmissionLeaseMs > now;
}

export interface AsyncStateJobReference {
  getState(): Promise<string>;
}

export type AsyncStateRecoveryStore = Pick<PlatformStore,
  | "commitAgentTurnFailure"
  | "commitMcpToolRun"
  | "failTaskAgentRun"
  | "failTaskSync"
  | "getChairAutomationJobAdmissions"
  | "getSnapshot"
  | "recordAudit"
  | "requireChairAutomationJobReconciliation"
  | "releaseChairSuggestion"
  | "releaseSpeakerTurn"
  | "setMeetingSummaryState"
>;

export interface AsyncStateRecoveryInput {
  store: AsyncStateRecoveryStore;
  findJob(jobId: string): Promise<AsyncStateJobReference | null>;
  enqueueMeetingSummary?(meetingId: string, jobId: string): Promise<void>;
  now?: string;
  scope?: "all" | "task-agent" | "background-jobs";
}

export interface AsyncStateRecoveryResult {
  checkedJobs: number;
  preservedJobs: number;
  deferredTaskRuns: number;
  deferredTaskSyncs: number;
  deferredSpeakerTurns: number;
  failedTaskRuns: number;
  failedTaskSyncs: number;
  failedMeetingSummaries: number;
  requeuedMeetingSummaries: number;
  deferredMeetingSummaries: number;
  releasedSpeakerTurns: number;
  releasedChairSuggestions: number;
  requiredChairAutomationReconciliations: number;
}

type QueueOwnership = "owned" | "missing" | "terminal";

export async function recoverOrphanedAsyncState(
  input: AsyncStateRecoveryInput
): Promise<AsyncStateRecoveryResult> {
  const now = input.now ?? new Date().toISOString();
  const nowTimestamp = Date.parse(now);
  if (!Number.isFinite(nowTimestamp)) throw new Error("Async state recovery time is invalid.");
  const scope = input.scope ?? "all";
  const taskAgentOnly = scope === "task-agent";
  const includeSpeakerReservations = scope === "all";
  const snapshot = await input.store.getSnapshot();
  const chairAutomationAdmissions = taskAgentOnly
    ? []
    : await input.store.getChairAutomationJobAdmissions();
  const openChairSuggestionIds = new Set(
    snapshot.chairSuggestions
      .filter((suggestion) => suggestion.status === "open")
      .map((suggestion) => suggestion.id)
  );
  const activeChairAutomationAdmissions = chairAutomationAdmissions.filter((admission) =>
    (admission.status === "reserved" || admission.status === "admitted")
    && openChairSuggestionIds.has(admission.chairSuggestionId)
  );
  const jobIds = new Set<string>();

  for (const task of snapshot.tasks) {
    if (["queued", "running"].includes(task.execution.status) && task.execution.jobId) {
      jobIds.add(task.execution.jobId);
    }
    if (!taskAgentOnly && task.sync.status === "queued" && task.sync.jobId) jobIds.add(task.sync.jobId);
  }
  if (!taskAgentOnly) {
    for (const admission of activeChairAutomationAdmissions) jobIds.add(admission.jobId);
    for (const meeting of snapshot.meetings) {
      if (["pending", "queued"].includes(meeting.summaryState) && meeting.summaryJobId) {
        jobIds.add(meeting.summaryJobId);
      }
    }
    if (includeSpeakerReservations) {
      for (const item of snapshot.speakerQueue) jobIds.add(item.jobId);
      for (const suggestion of snapshot.chairSuggestions) {
        if (suggestion.status === "pending" && suggestion.requestedAgentJobId) {
          jobIds.add(suggestion.requestedAgentJobId);
        }
      }
    }
  }

  // Resolve every queue reference before the first database mutation. If Redis is
  // unavailable, startup fails without turning valid queued work into failures.
  const ownership = new Map<string, QueueOwnership>();
  for (const jobId of jobIds) {
    const job = await input.findJob(jobId);
    if (!job) {
      ownership.set(jobId, "missing");
      continue;
    }
    ownership.set(jobId, queueOwnedStates.has(await job.getState()) ? "owned" : "terminal");
  }

  const result: AsyncStateRecoveryResult = {
    checkedJobs: jobIds.size,
    preservedJobs: [...ownership.values()].filter((state) => state === "owned").length,
    deferredTaskRuns: 0,
    deferredTaskSyncs: 0,
    deferredSpeakerTurns: 0,
    failedTaskRuns: 0,
    failedTaskSyncs: 0,
    failedMeetingSummaries: 0,
    requeuedMeetingSummaries: 0,
    deferredMeetingSummaries: 0,
    releasedSpeakerTurns: 0,
    releasedChairSuggestions: 0,
    requiredChairAutomationReconciliations: 0
  };
  const deferredSpeakerJobIds = new Set<string>();
  const classification = (jobId: string) => ownership.get(jobId) === "missing"
    ? "queue_state_missing"
    : "queue_state_terminal";

  for (const task of snapshot.tasks) {
    const executionJobId = task.execution.jobId;
    if (["queued", "running"].includes(task.execution.status)
      && executionJobId
      && ownership.get(executionJobId) !== "owned") {
      if (ownership.get(executionJobId) === "missing"
        && taskAgentAdmissionLeaseActive(task.execution, nowTimestamp)) {
        result.deferredTaskRuns += 1;
      } else if (!task.execution.requestFingerprint || !task.execution.agentId || !task.execution.profile) {
        result.deferredTaskRuns += 1;
        await input.store.recordAudit("task.agent_run.reconciliation.required", "task", task.id, {
          jobId: executionJobId,
          reason: "incomplete_execution_binding"
        });
      } else {
        const failureClassification = task.execution.providerStartedAt
          ? "provider_outcome_unknown"
          : classification(executionJobId);
        const failed = await input.store.failTaskAgentRun({
          taskId: task.id,
          jobId: executionJobId,
          executionRevision: task.execution.revision,
          requestFingerprint: task.execution.requestFingerprint,
          agentId: task.execution.agentId,
          executionProfile: task.execution.profile
        }, failureClassification);
        if (failed.status === "updated") result.failedTaskRuns += 1;
      }
    }

    if (!taskAgentOnly) {
      const syncJobId = task.sync.jobId;
      if (task.sync.status === "queued" && syncJobId && ownership.get(syncJobId) !== "owned") {
        if (ownership.get(syncJobId) === "missing" && taskSyncAdmissionLeaseActive(task.sync, nowTimestamp)) {
          result.deferredTaskSyncs += 1;
        } else if (!task.sync.adapterId || !task.sync.requestFingerprint) {
          result.deferredTaskSyncs += 1;
          await input.store.recordAudit("task.sync.reconciliation.required", "task", task.id, {
            jobId: syncJobId,
            reason: "incomplete_sync_binding"
          });
        } else {
          const failed = await input.store.failTaskSync({
            taskId: task.id,
            adapterId: task.sync.adapterId,
            jobId: syncJobId,
            requestFingerprint: task.sync.requestFingerprint
          }, classification(syncJobId));
          if (failed.status === "updated") result.failedTaskSyncs += 1;
        }
      }
    }
  }

  if (!taskAgentOnly) {
    for (const admission of activeChairAutomationAdmissions) {
      const queueOwnership = ownership.get(admission.jobId);
      if (queueOwnership === "owned" || queueOwnership === undefined) continue;
      const reconciled = await input.store.requireChairAutomationJobReconciliation(
        admission.chairSuggestionId,
        admission.jobId,
        queueOwnership === "missing" ? "queue_state_missing" : "queue_state_terminal",
        now
      );
      if (reconciled.status === "updated") {
        result.requiredChairAutomationReconciliations += 1;
      }
    }

    for (const meeting of snapshot.meetings) {
      const jobId = meeting.summaryJobId;
      if (["pending", "queued"].includes(meeting.summaryState)
        && jobId
        && ownership.get(jobId) !== "owned") {
        if (meeting.summaryState === "pending" && ownership.get(jobId) === "missing") {
          if (!input.enqueueMeetingSummary) {
            result.deferredMeetingSummaries += 1;
            continue;
          }
          try {
            await input.enqueueMeetingSummary(meeting.id, jobId);
          } catch {
            // A queue write may have succeeded even when its acknowledgement was lost.
          }
          const currentJob = await input.findJob(jobId);
          if (!currentJob) {
            result.deferredMeetingSummaries += 1;
            continue;
          }
          const currentState = await currentJob.getState();
          if (queueOwnedStates.has(currentState)) {
            const queued = await input.store.setMeetingSummaryState(meeting.id, "queued", jobId);
            if (queued.summaryState === "queued" || queued.summaryState === "completed") {
              result.requeuedMeetingSummaries += 1;
              result.preservedJobs += 1;
            }
            continue;
          }
        }
        const failed = await input.store.setMeetingSummaryState(meeting.id, "failed", jobId);
        if (failed.summaryState === "failed") result.failedMeetingSummaries += 1;
      }
    }

    if (includeSpeakerReservations) {
      for (const item of snapshot.speakerQueue) {
        if (ownership.get(item.jobId) === "owned") continue;
        if (item.status === "queued"
          && ownership.get(item.jobId) === "missing"
          && Date.parse(item.leaseExpiresAt) > nowTimestamp) {
          deferredSpeakerJobIds.add(item.jobId);
          result.deferredSpeakerTurns += 1;
          continue;
        }
        if (item.kind === "mcp_tool_call") {
          const failure = await recordReservedMcpToolFailure({
            store: input.store,
            jobId: item.jobId,
            message: `MCP 工具工作失去可驗證的佇列所有權（${classification(item.jobId)}）。外部執行結果未知，系統不會自動重送；請先人工對帳。`
          });
          if (failure.recorded) {
            result.releasedSpeakerTurns += 1;
            continue;
          }
          const stillReserved = (await input.store.getSnapshot()).speakerQueue.some((candidate) => candidate.jobId === item.jobId);
          if (stillReserved) throw new Error(`MCP reservation ${item.jobId} could not be resolved durably.`);
          continue;
        }
        if (item.kind === "agent_turn" && item.status === "running") {
          const failure = await recordReservedAgentTurnFailure({
            store: input.store,
            item,
            message: `Agent 發言失去可驗證的佇列所有權（${classification(item.jobId)}）。模型執行結果未知，系統不會自動重送；會議已暫停，請先人工確認。`
          });
          if (!failure.recorded) {
            const stillReserved = (await input.store.getSnapshot()).speakerQueue.some(
              (candidate) => candidate.jobId === item.jobId
            );
            if (stillReserved) throw new Error(`Agent reservation ${item.jobId} could not be resolved durably.`);
            continue;
          }
          const queueItem = failure.queueItem ?? item;
          if (queueItem.chairSuggestionId) {
            const suggestion = await input.store.releaseChairSuggestion(
              queueItem.chairSuggestionId,
              queueItem.jobId,
              "Agent outcome is unknown after queue ownership was lost."
            );
            if (suggestion.status === "updated") result.releasedChairSuggestions += 1;
          }
          const released = await (queueItem.reservationId
            ? input.store.releaseSpeakerTurn(queueItem.jobId, "agent_outcome_unknown", queueItem.reservationId)
            : input.store.releaseSpeakerTurn(queueItem.jobId, "agent_outcome_unknown"));
          if (released) result.releasedSpeakerTurns += 1;
          continue;
        }
        const released = await (item.reservationId
          ? input.store.releaseSpeakerTurn(item.jobId, classification(item.jobId), item.reservationId)
          : input.store.releaseSpeakerTurn(item.jobId, classification(item.jobId)));
        if (released) result.releasedSpeakerTurns += 1;
      }

      for (const suggestion of snapshot.chairSuggestions) {
        const jobId = suggestion.requestedAgentJobId;
        if (suggestion.status !== "pending"
          || !jobId
          || ownership.get(jobId) === "owned"
          || deferredSpeakerJobIds.has(jobId)) continue;
        const released = await input.store.releaseChairSuggestion(suggestion.id, jobId, classification(jobId));
        if (released.status === "updated") result.releasedChairSuggestions += 1;
      }
    }
  }

  const recoveryCount = result.failedTaskRuns
    + result.failedTaskSyncs
    + result.failedMeetingSummaries
    + result.requeuedMeetingSummaries
    + result.releasedSpeakerTurns
    + result.releasedChairSuggestions
    + result.requiredChairAutomationReconciliations;
  if (recoveryCount > 0) {
    await input.store.recordAudit(
      "async_state.recovered",
      "queue",
      scope === "task-agent"
        ? "worker-task-agent-reconciliation"
        : scope === "background-jobs"
          ? "worker-background-job-reconciliation"
          : "worker-startup",
      { ...result }
    );
  }
  return result;
}
