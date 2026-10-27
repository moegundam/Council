import type {
  GoalActionRunJobData,
  GoalOrchestrateJobData,
  GoalPlanJobData,
  GoalReviewJobData,
  LegacyGoalReviewJobData
} from "@council/contracts";
import type { GoalJobAdmission, PlatformStore } from "@council/database";
import {
  assertCurrentGoalReviewBinding,
  recoverLegacyGoalReviewJobData
} from "./goal-review-binding.js";
import { isGoalRunTerminal, pauseGoalRun } from "./goal-run-control.js";

const queueOwnedStates = new Set(["active", "delayed", "paused", "prioritized", "waiting", "waiting-children"]);
const defaultStaleMs = 5 * 60_000;

export interface GoalRecoveryQueueJob {
  getState(): Promise<string>;
  retry?(state?: "failed"): Promise<void>;
}

export type GoalJobRecoveryStore = Pick<PlatformStore,
  | "completeGoalJobDispatch"
  | "getGoalRun"
  | "getGoalRunDetail"
  | "getGoalReviewJobData"
  | "getSnapshot"
  | "getRecoverableGoalJobs"
  | "reserveGoalJob"
  | "setGoalJobState"
  | "setGoalRunState"
  | "updateActionRun"
  | "updateGoalTaskBinding"
>;

export interface RecoverGoalJobsInput {
  store: GoalJobRecoveryStore;
  findJob(jobId: string): Promise<GoalRecoveryQueueJob | null>;
  runOrchestrate(data: GoalOrchestrateJobData, jobId: string): Promise<unknown>;
  runPlan(data: GoalPlanJobData, jobId: string): Promise<unknown>;
  runReview(data: GoalReviewJobData | LegacyGoalReviewJobData, jobId: string): Promise<unknown>;
  enqueueReview(data: GoalReviewJobData, jobId: string): Promise<{ jobId: string }>;
  enqueueAction(data: GoalActionRunJobData, jobId: string): Promise<{ jobId: string }>;
  continueGoal(goalRunId: string, trigger: string): Promise<void>;
  startup?: boolean;
  now?: string;
  staleMs?: number;
}

export interface GoalJobRecoveryResult {
  checked: number;
  preserved: number;
  rerun: number;
  requeued: number;
  settled: number;
  fenced: number;
  deferred: number;
}

export interface RecoverFailedGoalTaskBindingsInput {
  store: Pick<PlatformStore, "getGoalRunDetail" | "getSnapshot" | "listGoalRuns">;
  findJob(jobId: string): Promise<GoalRecoveryQueueJob | null>;
  continueGoal(goalRunId: string, trigger: string): Promise<void>;
}

export interface FailedGoalTaskBindingRecoveryResult {
  checked: number;
  preserved: number;
  continued: number;
}

export async function recoverFailedGoalTaskBindings(
  input: RecoverFailedGoalTaskBindingsInput
): Promise<FailedGoalTaskBindingRecoveryResult> {
  const snapshot = await input.store.getSnapshot();
  const failedTasks = new Map(snapshot.tasks
    .filter((task) => task.execution.status === "failed" && task.execution.jobId !== null)
    .map((task) => [task.id, task]));
  const result: FailedGoalTaskBindingRecoveryResult = { checked: 0, preserved: 0, continued: 0 };
  if (failedTasks.size === 0) return result;

  for (const run of await input.store.listGoalRuns()) {
    if (run.state !== "executing" && run.state !== "reviewing") continue;
    const detail = await input.store.getGoalRunDetail(run.id);
    const recovery = detail?.taskBindings.map((candidate) => {
      const task = candidate.taskId ? failedTasks.get(candidate.taskId) : null;
      const jobId = task?.execution.jobId ?? null;
      if (!jobId || candidate.planRevision !== run.activePlanRevision) return null;
      const claimedFailure = candidate.state === "running" && candidate.activeJobId === jobId;
      const unclaimedFailure = candidate.state === "ready"
        && candidate.activeJobId === null
        && jobId.startsWith(`goal-task-${run.id}-${candidate.planTaskId}-`);
      return claimedFailure || unclaimedFailure ? { jobId } : null;
    }).find((candidate) => candidate !== null);
    if (!recovery) continue;
    result.checked += 1;
    const queueJob = await input.findJob(recovery.jobId);
    const queueState = queueJob ? await queueJob.getState() : null;
    if (queueState && queueOwnedStates.has(queueState)) {
      result.preserved += 1;
      continue;
    }
    await input.continueGoal(run.id, `recovered-task-agent:${recovery.jobId}`);
    result.continued += 1;
  }
  return result;
}

function parseInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Recovered ${label} is invalid.`);
  return parsed;
}

function recoveredPlanData(admission: GoalJobAdmission): GoalPlanJobData {
  const parts = admission.requestFingerprint.split(":");
  if (parts.length !== 3 || parts[0] !== admission.goalRunId) throw new Error("Goal Plan recovery fingerprint is invalid.");
  return {
    goalRunId: admission.goalRunId,
    expectedRevision: parseInteger(parts[1]!, "Goal revision"),
    expectedPlanRevision: parseInteger(parts[2]!, "Plan revision"),
    requestedBy: "system"
  };
}

function recoveredActionData(admission: GoalJobAdmission): GoalActionRunJobData {
  const parts = admission.requestFingerprint.split(":");
  if (parts.length !== 4 || parts[0] !== admission.goalRunId || parts[2] !== admission.entityId) {
    throw new Error("Goal Action recovery fingerprint is invalid.");
  }
  return {
    goalRunId: admission.goalRunId,
    planTaskId: parts[1]!,
    actionRunId: parts[2]!,
    contractDigest: parts[3]!,
    requestedBy: "system"
  };
}

async function refreshAdmission(store: GoalJobRecoveryStore, admission: GoalJobAdmission): Promise<GoalJobAdmission> {
  return store.reserveGoalJob(admission);
}

async function moveAdmission(
  store: GoalJobRecoveryStore,
  admission: GoalJobAdmission,
  target: "admitted" | "settled" | "outcome_unknown"
): Promise<GoalJobAdmission> {
  const current = await refreshAdmission(store, admission);
  if (current.state === target || current.state === "settled") return current;
  if (current.state === "outcome_unknown" && target !== "settled") return current;
  return store.setGoalJobState(current.jobId, current.state, target);
}

async function pauseRecoveredGoal(
  store: GoalJobRecoveryStore,
  goalRunId: string,
  reason: string,
  admission: GoalJobAdmission
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const run = await store.getGoalRun(goalRunId);
    if (!run || run.state === "paused" || isGoalRunTerminal(run.state)) return;
    try {
      await pauseGoalRun(store, run, reason, { jobId: admission.jobId, jobName: admission.jobName });
      return;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
}

async function recoverReview(
  input: RecoverGoalJobsInput,
  admission: GoalJobAdmission,
  queueJob: GoalRecoveryQueueJob | null,
  queueState: string | null
): Promise<"requeued" | "settled" | "fenced"> {
  const currentVersion = admission.requestFingerprint.startsWith("v2:");
  let data: GoalReviewJobData | LegacyGoalReviewJobData;
  try {
    if (currentVersion) {
      const stored = await input.store.getGoalReviewJobData(admission.jobId);
      if (!stored) throw new Error("Goal Review version 2 binding snapshot is missing.");
      data = stored;
    } else {
      data = recoverLegacyGoalReviewJobData(admission.requestFingerprint, admission.goalRunId);
    }
  } catch (error) {
    await moveAdmission(input.store, admission, "settled");
    await pauseRecoveredGoal(
      input.store,
      admission.goalRunId,
      `Goal Run is paused because a recovered Reviewer admission is invalid: ${error instanceof Error ? error.message : "unknown admission error"}`,
      admission
    );
    return "fenced";
  }
  const detail = await input.store.getGoalRunDetail(admission.goalRunId);
  const persisted = detail?.reviewerVerdicts.some((verdict) => (
    verdict.scope === data.scope
    && verdict.scopeId === data.scopeId
    && verdict.reviewerAgentId === data.reviewerAgentId
    && verdict.reviewerAgentRevision === data.reviewerAgentRevision
    && verdict.modelConnectorId === data.modelConnectorId
    && verdict.contractDigest === data.contractDigest
    && (currentVersion
      ? verdict.reviewJobId === admission.jobId
        && verdict.reviewRequestFingerprint === admission.requestFingerprint
      : verdict.reviewJobId === null && verdict.reviewRequestFingerprint === null)
  ));
  if (persisted) {
    await input.runReview(data, admission.jobId);
    const reconciled = await moveAdmission(input.store, admission, "settled");
    const run = await input.store.getGoalRun(admission.goalRunId);
    if (reconciled.state !== "settled") {
      await pauseRecoveredGoal(
        input.store,
        admission.goalRunId,
        "Goal Run is paused because a durable Reviewer verdict could not be deterministically reconciled.",
        admission
      );
      return "fenced";
    }
    if (run && run.state !== "paused" && !isGoalRunTerminal(run.state)) {
      await input.continueGoal(admission.goalRunId, `recovered-review:${admission.jobId}`);
    }
    return "settled";
  }
  if (admission.state === "running" || admission.state === "outcome_unknown") {
    await moveAdmission(input.store, admission, "outcome_unknown");
    await pauseRecoveredGoal(
      input.store,
      admission.goalRunId,
      "Goal Run is paused because a Reviewer model outcome was not durably recorded before Worker restart; automatic replay is disabled.",
      admission
    );
    return "fenced";
  }
  if (!currentVersion) {
    await moveAdmission(input.store, admission, "settled");
    await pauseRecoveredGoal(
      input.store,
      admission.goalRunId,
      "Goal Run is paused because a legacy Reviewer job has no immutable runtime binding; Owner must resume to create a version 2 job.",
      admission
    );
    return "fenced";
  }
  try {
    assertCurrentGoalReviewBinding(
      data as GoalReviewJobData,
      await input.store.getSnapshot(),
      detail?.goalRun.meetingId
    );
  } catch (error) {
    await moveAdmission(input.store, admission, "settled");
    await pauseRecoveredGoal(
      input.store,
      admission.goalRunId,
      `Goal Run is paused because a recovered Reviewer binding is no longer current: ${error instanceof Error ? error.message : "unknown binding error"}`,
      admission
    );
    return "fenced";
  }
  if (queueState === "failed" && queueJob?.retry) {
    await queueJob.retry("failed");
    await moveAdmission(input.store, admission, "admitted");
    return "requeued";
  }
  const queued = await input.enqueueReview(data as GoalReviewJobData, admission.jobId);
  if (queued.jobId !== admission.jobId) throw new Error("Recovered Goal Review queue returned a mismatched job ID.");
  await moveAdmission(input.store, admission, "admitted");
  return "requeued";
}

async function recoverAction(input: RecoverGoalJobsInput, admission: GoalJobAdmission): Promise<"requeued" | "settled" | "fenced"> {
  const data = recoveredActionData(admission);
  const detail = await input.store.getGoalRunDetail(admission.goalRunId);
  const actionRun = detail?.actionRuns.find((run) => run.id === data.actionRunId);
  if (!detail || !actionRun || detail.executionContract?.contractDigest !== data.contractDigest) {
    await moveAdmission(input.store, admission, "settled");
    return "settled";
  }
  if (actionRun.state === "succeeded") {
    const binding = detail?.taskBindings.find((candidate) => (
      candidate.planTaskId === data.planTaskId
      && candidate.planRevision === detail.goalRun.activePlanRevision
    ));
    if (binding?.state === "running" && binding.activeJobId === admission.jobId) {
      await input.store.updateGoalTaskBinding(binding.id, {
        expectedState: "running",
        state: "reviewing",
        activeJobId: null,
        event: {
          type: "task.state.changed",
          actorType: "system",
          actorId: null,
          entityType: "task",
          entityId: binding.planTaskId,
          summary: "Recovered a verified Action task into independent review."
        }
      });
    }
    await moveAdmission(input.store, admission, "settled");
    await input.continueGoal(admission.goalRunId, `recovered-action:${admission.jobId}`);
    return "settled";
  }
  if (["failed", "cancelled", "denied", "expired"].includes(actionRun.state)) {
    const binding = detail?.taskBindings.find((candidate) => (
      candidate.planTaskId === data.planTaskId
      && candidate.planRevision === detail.goalRun.activePlanRevision
    ));
    if (binding?.state === "running" && binding.activeJobId === admission.jobId) {
      await input.store.updateGoalTaskBinding(binding.id, {
        expectedState: "running",
        state: "failed",
        activeJobId: null,
        lastError: actionRun.lastError ?? `Harness Action ${actionRun.state}.`,
        event: {
          type: "task.state.changed",
          actorType: "system",
          actorId: null,
          entityType: "task",
          entityId: binding.planTaskId,
          summary: "Recovered a terminal Harness Action and cleared its active task binding."
        }
      });
    }
    await moveAdmission(input.store, admission, "settled");
    await pauseRecoveredGoal(
      input.store,
      admission.goalRunId,
      "Goal Run is paused because the recovered Harness Action did not complete successfully.",
      admission
    );
    return "fenced";
  }
  if (actionRun.state === "running" && actionRun.externalExecutionId) {
    const queued = await input.enqueueAction(data, admission.jobId);
    if (queued.jobId !== admission.jobId) throw new Error("Recovered Goal Action queue returned a mismatched job ID.");
    await moveAdmission(input.store, admission, "admitted");
    return "requeued";
  }
  if (actionRun.state === "outcome_unknown" || actionRun.state === "running") {
    const reason = "Goal Run is paused because an Action crossed the effect boundary without a durable, reconcilable external outcome.";
    if (actionRun.state === "running") {
      await input.store.updateActionRun(actionRun.id, {
        expectedState: "running",
        state: "outcome_unknown",
        lastError: reason,
        event: {
          type: "action.state.changed",
          actorType: "system",
          actorId: null,
          entityType: "action",
          entityId: actionRun.id,
          summary: reason
        }
      });
    }
    const binding = detail.taskBindings.find((candidate) => (
      candidate.planTaskId === data.planTaskId
      && candidate.planRevision === detail.goalRun.activePlanRevision
    ));
    if (binding?.state === "running" && binding.activeJobId === admission.jobId) {
      await input.store.updateGoalTaskBinding(binding.id, {
        expectedState: "running",
        state: "blocked",
        activeJobId: null,
        lastError: reason,
        event: {
          type: "task.state.changed",
          actorType: "system",
          actorId: null,
          entityType: "task",
          entityId: binding.planTaskId,
          summary: "Recovered Action task is blocked pending Owner reconciliation."
        }
      });
    }
    await moveAdmission(input.store, admission, "outcome_unknown");
    await pauseRecoveredGoal(
      input.store,
      admission.goalRunId,
      reason,
      admission
    );
    return "fenced";
  }
  if (actionRun.state !== "approved" && actionRun.state !== "reserved") {
    await moveAdmission(input.store, admission, "settled");
    await pauseRecoveredGoal(
      input.store,
      admission.goalRunId,
      "Goal Run is paused because the recovered Action is not in an executable contract state.",
      admission
    );
    return "fenced";
  }
  const queued = await input.enqueueAction(data, admission.jobId);
  if (queued.jobId !== admission.jobId) throw new Error("Recovered Goal Action queue returned a mismatched job ID.");
  await moveAdmission(input.store, admission, "admitted");
  return "requeued";
}

export async function recoverGoalJobs(input: RecoverGoalJobsInput): Promise<GoalJobRecoveryResult> {
  const now = Date.parse(input.now ?? new Date().toISOString());
  if (!Number.isFinite(now)) throw new Error("Goal job recovery time is invalid.");
  const staleMs = input.staleMs ?? defaultStaleMs;
  const admissions = await input.store.getRecoverableGoalJobs();
  const result: GoalJobRecoveryResult = { checked: admissions.length, preserved: 0, rerun: 0, requeued: 0, settled: 0, fenced: 0, deferred: 0 };

  for (const retainedAdmission of admissions) {
    let admission = retainedAdmission;
    const queueJob = await input.findJob(admission.jobId);
    const queueState = queueJob ? await queueJob.getState() : null;
    let recoveredDispatchLease = false;
    if (admission.state === "dispatching") {
      const leaseExpiresAt = Date.parse(admission.dispatchLeaseExpiresAt ?? "");
      if (!admission.dispatchToken || !Number.isFinite(leaseExpiresAt)) {
        throw new Error("Recoverable Goal job dispatch lease is malformed.");
      }
      const brokerHasJob = queueState !== null && queueState !== "unknown";
      if (!brokerHasJob && leaseExpiresAt > now) {
        result.deferred += 1;
        continue;
      }
      admission = await input.store.completeGoalJobDispatch(admission.jobId, admission.dispatchToken);
      recoveredDispatchLease = true;
    }
    if (queueState && queueOwnedStates.has(queueState)) {
      result.preserved += 1;
      continue;
    }
    const terminalQueueRecovery = queueState === "failed"
      && (admission.jobName === "goal-review" || admission.jobName === "goal-action-run");
    // A live process may be running an inline Meeting/orchestration job without
    // a BullMQ record. Only startup proves that the prior Worker is gone.
    if (!input.startup && admission.state === "running" && !terminalQueueRecovery) {
      result.deferred += 1;
      continue;
    }
    if (!input.startup && !terminalQueueRecovery && !recoveredDispatchLease
      && Date.parse(admission.updatedAt) + staleMs > now) {
      result.deferred += 1;
      continue;
    }
    if (queueState === "failed" && queueJob?.retry
      && admission.jobName !== "goal-review"
      && (admission.state !== "running" || admission.jobName === "goal-action-run")) {
      await queueJob.retry("failed");
      result.requeued += 1;
      continue;
    }

    if (admission.jobName === "goal-orchestrate") {
      const run = await input.store.getGoalRun(admission.goalRunId);
      if (!run || isGoalRunTerminal(run.state)) {
        await moveAdmission(input.store, admission, "settled");
        result.settled += 1;
        continue;
      }
      await input.runOrchestrate({
        goalRunId: run.id,
        expectedRevision: run.revision,
        requestFingerprint: admission.requestFingerprint,
        requestedBy: "system"
      }, admission.jobId);
      result.rerun += 1;
      continue;
    }

    if (admission.jobName === "goal-plan") {
      await input.runPlan(recoveredPlanData(admission), admission.jobId);
      result.rerun += 1;
      continue;
    }

    const disposition = admission.jobName === "goal-review"
      ? await recoverReview(input, admission, queueJob, queueState)
      : await recoverAction(input, admission);
    result[disposition] += 1;
  }
  return result;
}
