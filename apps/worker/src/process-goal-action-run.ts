import type {
  ActionAdapter as PersistedActionAdapter,
  ActionRunState,
  GoalActionRunJobData,
  GoalTaskState
} from "@council/contracts";
import type { PlatformStore } from "@council/database";
import { actionAdapterEndpointDigest, goalBudgetFailureReason } from "@council/domain";
import {
  ActionAdapterPolicyError,
  ActionOutcomeUnknownError,
  type ActionAdapter as RuntimeActionAdapter
} from "@council/runtime";
import { beginGoalJob, fenceGoalJobOutcome, settleGoalJob, type GoalJobAdmissionStore } from "./goal-job-admission.js";
import { isGoalRunTerminal, pauseGoalRun } from "./goal-run-control.js";

export type GoalActionRunStore = Pick<PlatformStore,
  | "admitGoalActionExecution"
  | "getGoalRunDetail"
  | "getSnapshot"
  | "listActionAdapters"
  | "setGoalRunState"
  | "updateActionRun"
  | "updateGoalTaskBinding"
> & GoalJobAdmissionStore;

export interface ProcessGoalActionRunInput {
  store: GoalActionRunStore;
  data: GoalActionRunJobData;
  jobId: string;
  createAdapter?: (adapter: PersistedActionAdapter) => Promise<RuntimeActionAdapter | null>;
}

function actionIdentity(actionRun: { actionKey: string; targetId: string; id: string; inputs: Record<string, unknown> }) {
  return {
    actionId: `${actionRun.actionKey}:${actionRun.targetId}`,
    targetId: actionRun.targetId,
    resourceId: actionRun.targetId,
    requestId: actionRun.id,
    inputs: actionRun.inputs
  };
}

function isActionRunTerminal(state: ActionRunState): boolean {
  return state === "succeeded"
    || state === "failed"
    || state === "cancelled"
    || state === "denied"
    || state === "expired";
}

function isGoalTaskTerminal(state: GoalTaskState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

async function pauseLatestGoal(store: GoalActionRunStore, goalRunId: string, reason: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const latest = await store.getGoalRunDetail(goalRunId);
    if (!latest || latest.goalRun.state === "paused" || isGoalRunTerminal(latest.goalRun.state)) return;
    try {
      await pauseGoalRun(store, latest.goalRun, reason);
      return;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
}

export type GoalActionRunResult = "settled" | "paused" | "stale" | "pending" | "succeeded";

export async function processGoalActionRun(input: ProcessGoalActionRunInput): Promise<GoalActionRunResult> {
  const admission = await beginGoalJob({
    store: input.store,
    jobId: input.jobId,
    goalRunId: input.data.goalRunId,
    jobName: "goal-action-run",
    entityId: input.data.actionRunId,
    requestFingerprint: `${input.data.goalRunId}:${input.data.planTaskId}:${input.data.actionRunId}:${input.data.contractDigest}`
  });
  if (admission.status === "settled") return "settled";
  if (admission.status === "outcome_unknown") {
    await pauseLatestGoal(input.store, input.data.goalRunId, "Goal Run remains paused because a prior Action delivery has an unknown external outcome.");
    return "paused";
  }
  const settleIfTerminalizedBeforeEffect = async (): Promise<boolean> => {
    const latest = await input.store.getGoalRunDetail(input.data.goalRunId);
    if (!latest) {
      await settleGoalJob(input.store, admission.admission);
      return true;
    }
    if (!isGoalRunTerminal(latest.goalRun.state)) return false;
    const latestAction = latest.actionRuns.find((item) => item.id === input.data.actionRunId);
    const latestBinding = latest.taskBindings.find((item) => item.planTaskId === input.data.planTaskId);
    if (latestAction && !isActionRunTerminal(latestAction.state)) return false;
    if (latestBinding && !isGoalTaskTerminal(latestBinding.state)) return false;
    await settleGoalJob(input.store, admission.admission);
    return true;
  };
  const detail = await input.store.getGoalRunDetail(input.data.goalRunId);
  const actionRun = detail?.actionRuns.find((item) => item.id === input.data.actionRunId);
  const binding = detail?.taskBindings.find((item) => item.planTaskId === input.data.planTaskId);
  const plan = detail?.plans.find((item) => item.revision === detail.goalRun.activePlanRevision);
  const task = plan?.tasks.find((item) => item.id === input.data.planTaskId);
  if (!detail || !actionRun || !binding || !task || isGoalRunTerminal(detail.goalRun.state)
    || detail.executionContract?.contractDigest !== input.data.contractDigest
    || actionRun.contractDigest !== input.data.contractDigest
    || task.executionMode !== "action"
    || task.action?.adapterId !== actionRun.adapterId
    || task.action.actionKey !== actionRun.actionKey
    || task.action.targetId !== actionRun.targetId) {
    await settleGoalJob(input.store, admission.admission);
    return "stale";
  }
  let executionBinding = binding;
  const failExecutionBinding = async (reason: string): Promise<void> => {
    if (executionBinding.state !== "running") return;
    executionBinding = await input.store.updateGoalTaskBinding(executionBinding.id, {
      expectedState: "running",
      state: "failed",
      activeJobId: null,
      lastError: reason,
      event: {
        type: "task.state.changed", actorType: "system", actorId: null, entityType: "task", entityId: binding.planTaskId,
        summary: "Action task stopped after a terminal Harness result."
      }
    });
  };
  const blockExecutionBinding = async (reason: string): Promise<void> => {
    if (executionBinding.state !== "running") return;
    executionBinding = await input.store.updateGoalTaskBinding(executionBinding.id, {
      expectedState: "running",
      state: "blocked",
      activeJobId: null,
      lastError: reason,
      event: {
        type: "task.state.changed", actorType: "system", actorId: null, entityType: "task", entityId: binding.planTaskId,
        summary: "Action task is blocked until its external outcome is reconciled."
      }
    });
  };
  if (actionRun.state === "succeeded") {
    if (executionBinding.state === "running") {
      executionBinding = await input.store.updateGoalTaskBinding(executionBinding.id, {
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
    await settleGoalJob(input.store, admission.admission);
    return "succeeded";
  }
  if (actionRun.state === "outcome_unknown") {
    const reason = "Goal Run remains paused because the prior Action outcome is unknown and cannot be retried safely.";
    await blockExecutionBinding(reason);
    await pauseLatestGoal(input.store, detail.goalRun.id, reason);
    await fenceGoalJobOutcome(input.store, admission.admission);
    return "paused";
  }
  if (actionRun.state === "running" && !actionRun.externalExecutionId) {
    const reason = "Goal Run is paused because a prior Action delivery crossed the effect boundary without a durable external execution identity.";
    await input.store.updateActionRun(actionRun.id, {
      expectedState: "running",
      state: "outcome_unknown",
      lastError: reason,
      event: {
        type: "action.state.changed", actorType: "system", actorId: null, entityType: "action", entityId: actionRun.id, summary: reason
      }
    });
    await blockExecutionBinding(reason);
    await pauseLatestGoal(input.store, detail.goalRun.id, reason);
    await fenceGoalJobOutcome(input.store, admission.admission);
    return "paused";
  }
  if (actionRun.state !== "approved" && actionRun.state !== "reserved" && actionRun.state !== "running") {
    const reason = "Goal Run is paused because the Action Run is not explicitly approved in the Execution Contract.";
    await failExecutionBinding(reason);
    await pauseLatestGoal(input.store, detail.goalRun.id, reason);
    await settleGoalJob(input.store, admission.admission);
    return "paused";
  }
  if (binding.state !== "ready" && binding.state !== "running") {
    await pauseGoalRun(input.store, detail.goalRun, "Goal Run is paused because Action task dependencies are not ready for execution.");
    await settleGoalJob(input.store, admission.admission);
    return "paused";
  }
  const reconcilingKnownExecution = actionRun.state === "running" && Boolean(actionRun.externalExecutionId);
  if (!reconcilingKnownExecution && detail.goalRun.state !== "executing") {
    const reason = "Harness Action was cancelled before the external effect boundary because the Goal Run is not executing.";
    if (actionRun.state === "approved" || actionRun.state === "reserved") {
      await input.store.updateActionRun(actionRun.id, {
        expectedState: actionRun.state,
        state: "cancelled",
        lastError: reason,
        event: {
          type: "action.state.changed", actorType: "system", actorId: null, entityType: "action", entityId: actionRun.id, summary: reason
        }
      });
      await failExecutionBinding(reason);
    }
    await settleGoalJob(input.store, admission.admission);
    return "paused";
  }
  if (!reconcilingKnownExecution) {
    const budgetReason = goalBudgetFailureReason({
      limits: detail.goalRun.limits,
      usage: detail.goalRun.usage,
      deadlineAt: detail.goalRun.deadlineAt
    });
    if (budgetReason) {
      if (actionRun.state === "approved" || actionRun.state === "reserved") {
        await input.store.updateActionRun(actionRun.id, {
          expectedState: actionRun.state,
          state: "expired",
          lastError: budgetReason,
          event: {
            type: "action.state.changed", actorType: "system", actorId: null, entityType: "action", entityId: actionRun.id,
            summary: `Harness Action expired before the external effect boundary: ${budgetReason}`
          }
        });
        await failExecutionBinding(budgetReason);
      }
      await pauseLatestGoal(input.store, detail.goalRun.id, `Goal Run is paused before Action pickup because ${budgetReason}`);
      await settleGoalJob(input.store, admission.admission);
      return "paused";
    }
  }
  const approvedBinding = detail.executionContract.actionBindings.find((candidate) => candidate.planTaskId === task.id);
  const adapterRecord = (await input.store.listActionAdapters()).find((adapter) => (
    adapter.id === actionRun.adapterId
    && adapter.enabled
    && adapter.catalogRevision === actionRun.adapterCatalogRevision
    && adapter.catalogRevision === approvedBinding?.adapterCatalogRevision
    && adapter.credentialId === approvedBinding?.credentialId
    && actionAdapterEndpointDigest(adapter.baseUrl) === approvedBinding?.endpointDigest
  ));
  const snapshot = await input.store.getSnapshot();
  const credential = approvedBinding?.credentialId
    ? (snapshot.credentials ?? []).find((candidate) => candidate.id === approvedBinding.credentialId)
    : null;
  const credentialMatches = approvedBinding?.credentialId === null
    ? adapterRecord?.credentialId === null
    : Boolean(credential
      && credential.status === "active"
      && credential.hasSecret
      && credential.secretRevision === approvedBinding?.credentialSecretRevision
      && (credential.expiresAt === null || Date.parse(credential.expiresAt) > Date.now()));
  const catalogEntry = adapterRecord?.actions.find((entry) => (
    entry.key === actionRun.actionKey
    && entry.targetIds.includes(actionRun.targetId)
    && entry.riskClass === task.action?.riskClass
    && Object.keys(actionRun.inputs).every((key) => entry.inputKeys.includes(key))
  ));
  const immutableAdapterIdentityAvailable = Boolean(approvedBinding && credentialMatches && adapterRecord && catalogEntry);
  const adapter = approvedBinding && credentialMatches && adapterRecord && catalogEntry
    ? await input.createAdapter?.(adapterRecord) ?? null
    : null;
  if (!adapter) {
    const reason = "Goal Run is paused because the approved Harness Action Adapter identity or Credential revision is unavailable.";
    if (reconcilingKnownExecution) {
      if (immutableAdapterIdentityAvailable) {
        return "pending";
      }
      await input.store.updateActionRun(actionRun.id, {
        expectedState: "running",
        state: "outcome_unknown",
        externalExecutionId: actionRun.externalExecutionId,
        lastError: reason,
        event: {
          type: "action.state.changed", actorType: "system", actorId: null, entityType: "action", entityId: actionRun.id,
          summary: "Harness Action status cannot be reconciled with the immutable Adapter and Credential binding."
        }
      });
      await blockExecutionBinding(reason);
      await pauseLatestGoal(input.store, detail.goalRun.id, reason);
      await fenceGoalJobOutcome(input.store, admission.admission);
      return "paused";
    }
    if (actionRun.state === "approved" || actionRun.state === "reserved") {
      await input.store.updateActionRun(actionRun.id, {
        expectedState: actionRun.state,
        state: "failed",
        lastError: reason,
        event: {
          type: "action.state.changed", actorType: "system", actorId: null, entityType: "action", entityId: actionRun.id, summary: reason
        }
      });
      await failExecutionBinding(reason);
    }
    await pauseLatestGoal(input.store, detail.goalRun.id, reason);
    await settleGoalJob(input.store, admission.admission);
    return "paused";
  }
  const request = actionIdentity(actionRun);
  let crossedEffectBoundary = false;
  let durableExternalExecutionId = actionRun.externalExecutionId;
  const recordVerification = async (
    verified: Awaited<ReturnType<RuntimeActionAdapter["verify"]>>,
    externalExecutionId: string
  ): Promise<"pending" | "paused" | "succeeded"> => {
    if (verified.status === "succeeded") {
      await input.store.updateActionRun(actionRun.id, {
        expectedState: "running",
        state: "succeeded",
        externalExecutionId,
        verificationSummary: "Harness preview, execute, and verify completed successfully.",
        event: {
          type: "action.state.changed", actorType: "system", actorId: null, entityType: "action", entityId: actionRun.id,
          summary: "Harness Action verified successfully; independent review is required."
        }
      });
      await input.store.updateGoalTaskBinding(executionBinding.id, {
        expectedState: "running",
        state: "reviewing",
        activeJobId: null,
        event: {
          type: "task.state.changed", actorType: "system", actorId: null, entityType: "task", entityId: binding.planTaskId,
          summary: "Action task is awaiting two independent Reviewer verdicts."
        }
      });
      await settleGoalJob(input.store, admission.admission);
      return "succeeded";
    }
    if (verified.status === "failed" || verified.status === "cancelled") {
      const reason = verified.status === "cancelled"
        ? "Harness Action was cancelled before successful verification."
        : "Harness Action failed external verification.";
      await input.store.updateActionRun(actionRun.id, {
        expectedState: "running",
        state: verified.status,
        externalExecutionId,
        lastError: reason,
        event: {
          type: "action.state.changed", actorType: "system", actorId: null, entityType: "action", entityId: actionRun.id, summary: reason
        }
      });
      await failExecutionBinding(reason);
      await pauseLatestGoal(input.store, detail.goalRun.id, reason);
      await settleGoalJob(input.store, admission.admission);
      return "paused";
    }
    await input.store.updateActionRun(actionRun.id, {
      expectedState: "running",
      state: "running",
      externalExecutionId,
      lastError: null,
      event: {
        type: "action.state.changed", actorType: "system", actorId: null, entityType: "action", entityId: actionRun.id,
        summary: "Harness Action remains asynchronous; a bounded status reconciliation will continue."
      }
    });
    return "pending";
  };

  if (reconcilingKnownExecution) {
    try {
      const verified = await adapter.verify({ ...request, executionId: durableExternalExecutionId! });
      return await recordVerification(verified, durableExternalExecutionId!);
    } catch (error) {
      if (!(error instanceof ActionOutcomeUnknownError) && !(error instanceof ActionAdapterPolicyError)) {
        return "pending";
      }
      const reason = error instanceof ActionAdapterPolicyError
        ? `Goal Run is paused because persisted Harness execution reconciliation violated Adapter policy: ${error.message}`
        : "Goal Run is paused because Harness reported an unknown outcome for the persisted external execution.";
      await input.store.updateActionRun(actionRun.id, {
        expectedState: "running",
        state: "outcome_unknown",
        lastError: reason,
        event: {
          type: "action.state.changed", actorType: "system", actorId: null, entityType: "action", entityId: actionRun.id, summary: reason
        }
      });
      await blockExecutionBinding(reason);
      await pauseLatestGoal(input.store, detail.goalRun.id, reason);
      await fenceGoalJobOutcome(input.store, admission.admission);
      return "paused";
    }
  }

  try {
    const previewAdmission = await input.store.admitGoalActionExecution(actionRun.id, {
      goalRunId: detail.goalRun.id,
      planTaskId: task.id,
      contractDigest: input.data.contractDigest,
      jobId: input.jobId,
      phase: "preview",
      event: {
        type: "action.state.changed", actorType: "system", actorId: null, entityType: "action", entityId: actionRun.id,
        summary: "Harness Action was atomically admitted for read-only preview."
      },
      bindingEvent: {
        type: "task.state.changed", actorType: "system", actorId: null, entityType: "task", entityId: binding.planTaskId,
        summary: "Action task is running through the approved Harness Adapter."
      }
    });
    if (previewAdmission.status === "rejected") {
      if (await settleIfTerminalizedBeforeEffect()) return "stale";
      const terminalState = previewAdmission.reason.includes("duration budget")
        ? "expired"
        : previewAdmission.reason.includes("not executing")
          ? "cancelled"
          : "denied";
      await input.store.updateActionRun(actionRun.id, {
        expectedState: actionRun.state === "reserved" ? "reserved" : "approved",
        state: terminalState,
        lastError: previewAdmission.reason,
        event: {
          type: "action.state.changed", actorType: "system", actorId: null, entityType: "action", entityId: actionRun.id,
          summary: `Harness Action was rejected before preview: ${previewAdmission.reason}`
        }
      });
      await failExecutionBinding(previewAdmission.reason);
      await pauseLatestGoal(input.store, detail.goalRun.id, `Goal Run is paused before Harness preview because ${previewAdmission.reason}`);
      await settleGoalJob(input.store, admission.admission);
      return "paused";
    }
    executionBinding = previewAdmission.taskBinding;
    await adapter.preview(request);
    const executeAdmission = await input.store.admitGoalActionExecution(actionRun.id, {
      goalRunId: detail.goalRun.id,
      planTaskId: task.id,
      contractDigest: input.data.contractDigest,
      jobId: input.jobId,
      phase: "execute",
      event: {
        type: "action.state.changed", actorType: "system", actorId: null, entityType: "action", entityId: actionRun.id,
        summary: "Harness Action preview passed and external execution was atomically admitted."
      },
      bindingEvent: {
        type: "task.state.changed", actorType: "system", actorId: null, entityType: "task", entityId: binding.planTaskId,
        summary: "Action task retained exclusive execution ownership."
      }
    });
    if (executeAdmission.status === "rejected") {
      if (await settleIfTerminalizedBeforeEffect()) return "stale";
      const terminalActionState = executeAdmission.reason.includes("duration budget") ? "expired" : "cancelled";
      await input.store.updateActionRun(actionRun.id, {
        expectedState: "reserved",
        state: terminalActionState,
        lastError: executeAdmission.reason,
        event: {
          type: "action.state.changed", actorType: "system", actorId: null, entityType: "action", entityId: actionRun.id,
          summary: `Harness Action did not cross the effect boundary: ${executeAdmission.reason}`
        }
      });
      await failExecutionBinding(executeAdmission.reason);
      await pauseLatestGoal(input.store, detail.goalRun.id, `Goal Run is paused before Harness execution because ${executeAdmission.reason}`);
      await settleGoalJob(input.store, admission.admission);
      return "paused";
    }
    executionBinding = executeAdmission.taskBinding;
    crossedEffectBoundary = true;
    const execution = await adapter.execute(request);
    await input.store.updateActionRun(actionRun.id, {
      expectedState: "running",
      state: "running",
      externalExecutionId: execution.executionId,
      event: {
        type: "action.state.changed", actorType: "system", actorId: null, entityType: "action", entityId: actionRun.id,
        summary: "Harness returned a durable external execution identity; verification is in progress."
      }
    });
    durableExternalExecutionId = execution.executionId;
    const verified = await adapter.verify({
      actionId: request.actionId,
      targetId: request.targetId,
      resourceId: request.resourceId,
      requestId: request.requestId,
      executionId: execution.executionId
    });
    return await recordVerification(verified, execution.executionId);
  } catch (error) {
    if (!crossedEffectBoundary && await settleIfTerminalizedBeforeEffect()) return "stale";
    const reason = error instanceof Error ? error.message : "Harness Action execution failed with an unknown error.";
    if (durableExternalExecutionId && !(error instanceof ActionOutcomeUnknownError) && !(error instanceof ActionAdapterPolicyError)) {
      return "pending";
    }
    const outcomeUnknown = (crossedEffectBoundary && !durableExternalExecutionId)
      || error instanceof ActionOutcomeUnknownError
      || (Boolean(durableExternalExecutionId) && error instanceof ActionAdapterPolicyError);
    const fencedReason = outcomeUnknown
      ? "Goal Run is paused because Harness Action outcome is unknown and cannot be retried safely."
      : `Goal Run is paused because Harness Action preview or execution failed: ${reason}`;
    if (outcomeUnknown) {
      await input.store.updateActionRun(actionRun.id, {
        expectedState: "running",
        state: "outcome_unknown",
        lastError: fencedReason,
        event: {
          type: "action.state.changed", actorType: "system", actorId: null, entityType: "action", entityId: actionRun.id, summary: fencedReason
        }
      });
      await blockExecutionBinding(fencedReason);
    } else {
      await input.store.updateActionRun(actionRun.id, {
        expectedState: "reserved",
        state: "failed",
        lastError: fencedReason,
        event: {
          type: "action.state.changed", actorType: "system", actorId: null, entityType: "action", entityId: actionRun.id, summary: fencedReason
        }
      });
      await failExecutionBinding(fencedReason);
    }
    await pauseLatestGoal(input.store, detail.goalRun.id, fencedReason);
    if (outcomeUnknown) await fenceGoalJobOutcome(input.store, admission.admission);
    else await settleGoalJob(input.store, admission.admission);
    return "paused";
  }
}
