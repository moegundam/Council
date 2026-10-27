import { randomUUID } from "node:crypto";
import type {
  GoalActionRunJobData,
  GoalOrchestrateJobData,
  GoalReviewJobData,
  PlatformSnapshot,
  TaskAgentRunJobData
} from "@council/contracts";
import type { GoalJobAdmission, PlatformStore } from "@council/database";
import { requestFingerprint } from "@council/database";
import { actionAdapterEndpointDigest, goalBudgetFailureReason, readyGoalPlanTaskIds } from "@council/domain";
import { beginGoalJob, settleGoalJob, type GoalJobAdmissionStore } from "./goal-job-admission.js";
import {
  createGoalReviewBinding,
  goalReviewAdmissionFingerprint,
  goalReviewJobIdDigest
} from "./goal-review-binding.js";
import { isGoalRunTerminal, pauseGoalRun } from "./goal-run-control.js";
import { processGoalPlan } from "./process-goal-plan.js";
import { prepareGoalTaskAgent } from "./goal-task-agent-scheduler.js";

export type GoalOrchestrateStore = Pick<PlatformStore,
  | "claimGoalTaskDispatch"
  | "createRuntimeRun"
  | "createDecision"
  | "appendGoalEvent"
  | "getAgentReadiness"
  | "getAgentRevision"
  | "getGoalRun"
  | "getGoalRunDetail"
  | "getGoalEvents"
  | "getSnapshot"
  | "getRuntimeRun"
  | "listActionAdapters"
  | "markTaskAgentRunQueued"
  | "reserveGoalReviewJob"
  | "saveGoalPlan"
  | "setGoalRunState"
  | "setMeetingState"
  | "updateGoalTaskBinding"
> & GoalJobAdmissionStore;

export interface ProcessGoalOrchestrateInput {
  store: GoalOrchestrateStore;
  data: GoalOrchestrateJobData;
  jobId: string;
  enqueueTaskAgent?(job: TaskAgentRunJobData, jobId: string): Promise<{ jobId: string }>;
  enqueueAction?(job: GoalActionRunJobData, jobId: string): Promise<{ jobId: string }>;
  enqueueReview?(job: GoalReviewJobData, jobId: string): Promise<{ jobId: string }>;
  runMeetingRound?(input: {
    goalRunId: string;
    meetingId: string;
    round: number;
  }): Promise<{ modelCalls: number }>;
  ompRuntimeReady?(): Promise<boolean>;
}

export type GoalOrchestrateResult = "settled" | "paused" | "stale";

function decisionDescription(goal: string, utterances: PlatformSnapshot["utterances"]): string {
  const transcript = utterances.slice(-16).map((utterance) => (
    `${utterance.speakerName} (${utterance.roleName ?? utterance.speakerType}): ${utterance.content}`
  )).join("\n");
  return [`Goal: ${goal}`, "Formal Meeting convergence record:", transcript || "No attributable Agent transcript was retained."].join("\n").slice(0, 4_000);
}

async function reserveProcessorJob(input: {
  store: GoalJobAdmissionStore;
  admission: GoalJobAdmission;
  enqueue(): Promise<{ jobId: string }>;
}): Promise<void> {
  const admission = await input.store.reserveGoalJob(input.admission);
  await dispatchReservedProcessorJob({
    store: input.store,
    admission,
    expectedAdmission: input.admission,
    enqueue: input.enqueue
  });
}

async function reserveReviewProcessorJob(input: {
  store: GoalOrchestrateStore;
  admission: GoalJobAdmission;
  data: GoalReviewJobData;
  enqueue(): Promise<{ jobId: string }>;
}): Promise<void> {
  const admission = await input.store.reserveGoalReviewJob(input.admission, input.data);
  await dispatchReservedProcessorJob({
    store: input.store,
    admission,
    expectedAdmission: input.admission,
    enqueue: input.enqueue
  });
}

async function dispatchReservedProcessorJob(input: {
  store: GoalJobAdmissionStore;
  admission: GoalJobAdmission;
  expectedAdmission: GoalJobAdmission;
  enqueue(): Promise<{ jobId: string }>;
}): Promise<void> {
  const { admission, expectedAdmission } = input;
  if (admission.goalRunId !== expectedAdmission.goalRunId
    || admission.jobName !== expectedAdmission.jobName
    || admission.entityId !== expectedAdmission.entityId
    || admission.requestFingerprint !== expectedAdmission.requestFingerprint) {
    throw new Error("Goal processor job ID is already bound to a different execution request.");
  }
  const dispatchToken = randomUUID();
  const claim = await input.store.claimGoalJobDispatch(admission.jobId, {
    dispatchToken,
    leaseDurationMs: 30_000
  });
  if (claim.status === "already_dispatched" || claim.status === "contended") return;
  const queued = await input.enqueue();
  if (queued.jobId !== admission.jobId) throw new Error("Goal processor queue returned a mismatched job ID.");
  await input.store.completeGoalJobDispatch(admission.jobId, dispatchToken);
}

function admission(input: {
  jobId: string;
  goalRunId: string;
  jobName: GoalJobAdmission["jobName"];
  entityId: string;
  requestFingerprint: string;
}): GoalJobAdmission {
  const now = new Date().toISOString();
  return {
    ...input,
    state: "reserved",
    reservedAt: now,
    admittedAt: null,
    startedAt: null,
    settledAt: null,
    updatedAt: now
  };
}

async function synchronizeBindings(store: GoalOrchestrateStore, goalRunId: string): Promise<void> {
  let detail = await store.getGoalRunDetail(goalRunId);
  if (!detail) return;
  const plan = detail.plans.find((candidate) => candidate.revision === detail!.goalRun.activePlanRevision);
  if (!plan) return;
  const snapshot = await store.getSnapshot();
  const readyIds = new Set(readyGoalPlanTaskIds(plan.tasks, detail.taskBindings));
  for (const binding of detail.taskBindings.filter((candidate) => candidate.planRevision === plan.revision)) {
    if (binding.state === "waiting" && readyIds.has(binding.planTaskId)) {
      await store.updateGoalTaskBinding(binding.id, {
        expectedState: "waiting",
        state: "ready",
        event: {
          type: "task.state.changed",
          actorType: "system",
          actorId: null,
          entityType: "task",
          entityId: binding.planTaskId,
          summary: "Goal task dependencies are complete and the task is ready."
        }
      });
      continue;
    }
    const task = binding.taskId ? snapshot.tasks.find((candidate) => candidate.id === binding.taskId) : null;
    if (!task || !["ready", "running", "failed"].includes(binding.state)) continue;
    if (task.status === "done" || task.execution.status === "completed") {
      await store.updateGoalTaskBinding(binding.id, {
        expectedState: binding.state,
        state: "reviewing",
        activeJobId: null,
        event: {
          type: "task.state.changed",
          actorType: "system",
          actorId: null,
          entityType: "task",
          entityId: binding.planTaskId,
          summary: "Canonical Task execution completed and is awaiting independent review."
        }
      });
    } else if (task.execution.status === "failed" && binding.state === "running") {
      const outcomeUnknown = task.execution.lastError === "provider_outcome_unknown";
      const exhausted = outcomeUnknown || binding.attemptCount >= detail.goalRun.limits.maxAttemptsPerTask;
      await store.updateGoalTaskBinding(binding.id, {
        expectedState: "running",
        state: exhausted ? "failed" : "ready",
        activeJobId: null,
        lastError: task.execution.lastError,
        event: {
          type: "task.state.changed",
          actorType: "system",
          actorId: null,
          entityType: "task",
          entityId: binding.planTaskId,
          summary: outcomeUnknown
            ? "Goal task stopped because the model provider outcome is unknown; automatic retry is fenced."
            : exhausted
            ? "Goal task exhausted its execution attempts."
            : "Goal task execution failed and is ready for a bounded retry."
        }
      });
    }
  }
  detail = await store.getGoalRunDetail(goalRunId);
  if (!detail) return;
  const failed = detail.taskBindings.find((binding) => (
    binding.planRevision === detail!.goalRun.activePlanRevision && binding.state === "failed"
  ));
  if (failed && detail.goalRun.state !== "paused") {
    const outcomeUnknown = failed.lastError === "provider_outcome_unknown";
    await pauseGoalRun(store, detail.goalRun, outcomeUnknown
      ? "Goal Run is paused because a Task Agent provider outcome is unknown and cannot be retried safely."
      : "Goal Run is paused because a task exhausted its bounded execution attempts.", {
      planTaskId: failed.planTaskId,
      attempts: failed.attemptCount,
      outcomeUnknown
    });
  }
}

async function pauseDispatchFailure(input: ProcessGoalOrchestrateInput, reason: string, planTaskId: string): Promise<void> {
  const current = await input.store.getGoalRun(input.data.goalRunId);
  if (current && current.state !== "paused" && !isGoalRunTerminal(current.state)) {
    await pauseGoalRun(input.store, current, reason, { planTaskId });
  }
}

async function dispatchReadyWork(input: ProcessGoalOrchestrateInput): Promise<void> {
  const detail = await input.store.getGoalRunDetail(input.data.goalRunId);
  if (!detail || detail.goalRun.state !== "executing" || !detail.executionContract) return;
  const plan = detail.plans.find((candidate) => candidate.revision === detail.goalRun.activePlanRevision);
  if (!plan) return;
  const activeBindings = detail.taskBindings.filter((binding) => binding.planRevision === plan.revision);
  let slots = Math.max(0, detail.goalRun.limits.maxConcurrentTasks - activeBindings.filter((binding) => binding.state === "running").length);
  for (const binding of activeBindings.filter((candidate) => candidate.state === "ready")) {
    if (slots <= 0) break;
    const planTask = plan.tasks.find((candidate) => candidate.id === binding.planTaskId);
    if (!planTask) continue;
    if (planTask.executionMode === "manual") continue;
    if (planTask.executionMode === "action") {
      if (!input.enqueueAction || !planTask.action) continue;
      const approvedBinding = detail.executionContract.actionBindings.find((candidate) => candidate.planTaskId === planTask.id);
      const adapter = (await input.store.listActionAdapters()).find((candidate) => (
        candidate.id === planTask.action!.adapterId
        && candidate.enabled
        && candidate.catalogRevision === approvedBinding?.adapterCatalogRevision
        && candidate.credentialId === approvedBinding?.credentialId
        && actionAdapterEndpointDigest(candidate.baseUrl) === approvedBinding?.endpointDigest
        && candidate.actions.some((action) => (
          action.key === planTask.action!.actionKey
          && action.targetIds.includes(planTask.action!.targetId)
          && action.riskClass === planTask.action!.riskClass
        ))
      ));
      const snapshot = await input.store.getSnapshot();
      const credential = approvedBinding?.credentialId
        ? (snapshot.credentials ?? []).find((candidate) => candidate.id === approvedBinding.credentialId)
        : null;
      const credentialMatches = approvedBinding?.credentialId === null
        ? adapter?.credentialId === null
        : Boolean(credential
          && credential.status === "active"
          && credential.hasSecret
          && credential.secretRevision === approvedBinding?.credentialSecretRevision
          && (credential.expiresAt === null || Date.parse(credential.expiresAt) > Date.now()));
      if (!approvedBinding || !adapter || !credentialMatches) {
        await pauseDispatchFailure(input, "Goal Run is paused because the Owner-approved Action Adapter, endpoint, catalog, or Credential revision changed.", planTask.id);
        return;
      }
      let actionRun = detail.actionRuns.find((candidate) => (
        candidate.planTaskId === planTask.id
        && candidate.contractDigest === detail.executionContract!.contractDigest
      )) ?? null;
      if (!actionRun) {
        const fingerprint = requestFingerprint({
          goalRunId: detail.goalRun.id,
          planTaskId: planTask.id,
          contractDigest: detail.executionContract.contractDigest,
          adapterCatalogRevision: approvedBinding.adapterCatalogRevision,
          action: planTask.action
        });
        actionRun = {
          id: randomUUID(),
          goalRunId: detail.goalRun.id,
          planTaskId: planTask.id,
          adapterId: adapter.id,
          adapterCatalogRevision: adapter.catalogRevision,
          actionKey: planTask.action.actionKey,
          targetId: planTask.action.targetId,
          inputs: planTask.action.inputs,
          state: "approved",
          requestFingerprint: fingerprint,
          contractDigest: detail.executionContract.contractDigest,
          externalExecutionId: null,
          verificationSummary: null,
          lastError: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
      }
      const jobId = `goal-action-${actionRun.id}`;
      const job: GoalActionRunJobData = {
        goalRunId: detail.goalRun.id,
        planTaskId: planTask.id,
        actionRunId: actionRun.id,
        contractDigest: detail.executionContract.contractDigest,
        requestedBy: "system"
      };
      try {
        const fingerprint = `${job.goalRunId}:${job.planTaskId}:${job.actionRunId}:${job.contractDigest}`;
        const actionAdmission = admission({
          jobId,
          goalRunId: job.goalRunId,
          jobName: "goal-action-run",
          entityId: job.actionRunId,
          requestFingerprint: fingerprint
        });
        const claim = await input.store.claimGoalTaskDispatch({
          goalRunId: detail.goalRun.id,
          bindingId: binding.id,
          planRevision: plan.revision,
          planTaskId: planTask.id,
          taskId: binding.taskId,
          expectedAttemptCount: binding.attemptCount,
          jobId,
          contractDigest: detail.executionContract.contractDigest,
          usageIncrements: { taskAttempts: 0, modelCalls: 0, actionCalls: 1 },
          budgetEvent: {
            type: "goal.state.changed",
            actorType: "system",
            actorId: null,
            entityType: "goal",
            entityId: detail.goalRun.id,
            summary: "Goal Run atomically reserved bounded Action execution budget.",
            detail: { actionCalls: 1 }
          },
          bindingEvent: {
            type: "task.state.changed",
            actorType: "system",
            actorId: null,
            entityType: "task",
            entityId: binding.planTaskId,
            summary: "Goal Action task was admitted for bounded execution."
          },
          action: {
            actionRun,
            actionEvent: {
              type: "action.state.changed",
              actorType: "system",
              actorId: null,
              entityType: "action",
              entityId: actionRun.id,
              summary: "Ordinary Action Run admitted by the Owner-approved Execution Contract."
            },
            jobAdmission: actionAdmission
          }
        });
        if (claim.status === "contended") continue;
        if (claim.status === "rejected") {
          await pauseDispatchFailure(input, `Goal Run is paused before Action queue admission because ${claim.reason}`, planTask.id);
          return;
        }
        await reserveProcessorJob({
          store: input.store,
          admission: claim.jobAdmission ?? actionAdmission,
          enqueue: () => input.enqueueAction!(job, jobId)
        });
      } catch (error) {
        await pauseDispatchFailure(input, `Goal Run is paused because Action queue admission could not be verified: ${error instanceof Error ? error.message : "unknown queue error"}`, planTask.id);
        return;
      }
      slots -= 1;
      continue;
    }
    if (!input.enqueueTaskAgent || !binding.taskId) continue;
    if (binding.attemptCount >= detail.goalRun.limits.maxAttemptsPerTask) {
      await pauseDispatchFailure(input, "Goal Run is paused because the task exhausted its bounded execution attempts.", planTask.id);
      return;
    }
    try {
      const canonicalTask = (await input.store.getSnapshot()).tasks.find((candidate) => candidate.id === binding.taskId);
      if (!canonicalTask) throw new Error("Goal canonical Task was not found before dispatch admission.");
      const jobPrefix = `goal-task-${detail.goalRun.id}-${planTask.id}`;
      const replaysGoalJob = ["queued", "running"].includes(canonicalTask.execution.status)
        && canonicalTask.execution.jobId?.startsWith(`${jobPrefix}-`) === true;
      const jobId = replaysGoalJob
        ? canonicalTask.execution.jobId!
        : `${jobPrefix}-a${binding.attemptCount + 1}-e${canonicalTask.execution.revision + 1}`;
      const approvedRuntime = detail.executionContract.runtimeBindings.find((candidate) => candidate.planTaskId === planTask.id);
      if (detail.executionContract.runtimeBindings.length > 0 && !approvedRuntime) {
        throw new Error("Approved Execution Contract is missing the Task Runtime binding.");
      }
      const ompExecution = approvedRuntime?.route === "omp_coding";
      const isolationAttested = ompExecution ? await input.ompRuntimeReady?.() === true : false;
      if (ompExecution && !isolationAttested) {
        throw new Error("OMP Runtime isolation is not currently attested.");
      }
      const prepared = await prepareGoalTaskAgent({
        store: input.store,
        taskId: binding.taskId,
        jobId,
        ...(approvedRuntime ? {
          goalRunId: detail.goalRun.id,
          planTaskId: planTask.id,
          executionRuntimeBinding: approvedRuntime,
          executionIsolationAttested: isolationAttested
        } : {})
      });
      const taskAdmission = await input.store.markTaskAgentRunQueued(jobId, prepared.job);
      if (taskAdmission.status === "stale") {
        throw new Error("Goal canonical Task execution binding changed before dispatch claim.");
      }
      const requestedAt = taskAdmission.task.execution.requestedAt;
      if (!requestedAt || !prepared.job.runtimeRun?.expiresAt) {
        throw new Error("Goal canonical Task did not retain the Runtime Run admission timestamp.");
      }
      const runtimeTtlMs = Date.parse(prepared.job.runtimeRun.expiresAt)
        - Date.parse(prepared.job.runtimeRun.queuedAt);
      prepared.job.runtimeRun = {
        ...prepared.job.runtimeRun,
        queuedAt: requestedAt,
        expiresAt: new Date(Date.parse(requestedAt) + runtimeTtlMs).toISOString(),
        updatedAt: requestedAt
      };
      await input.store.createRuntimeRun(prepared.job.runtimeRun, {
        type: "state.changed",
        phase: "queued",
        summary: "Runtime Run durably admitted before queue dispatch.",
        toolName: null,
        progressPercent: 0,
        usage: null,
        errorCode: null,
        actorType: "system",
        occurredAt: prepared.job.runtimeRun.queuedAt
      });
      const claim = await input.store.claimGoalTaskDispatch({
        goalRunId: detail.goalRun.id,
        bindingId: binding.id,
        planRevision: plan.revision,
        planTaskId: planTask.id,
        taskId: binding.taskId,
        expectedAttemptCount: binding.attemptCount,
        jobId,
        contractDigest: detail.executionContract.contractDigest,
        usageIncrements: { taskAttempts: 1, modelCalls: 1, actionCalls: 0 },
        budgetEvent: {
          type: "goal.state.changed",
          actorType: "system",
          actorId: null,
          entityType: "goal",
          entityId: detail.goalRun.id,
          summary: "Goal Run atomically reserved bounded Task Agent execution budget.",
          detail: { taskAttempts: 1, modelCalls: 1 }
        },
        bindingEvent: {
          type: "task.state.changed",
          actorType: "system",
          actorId: null,
          entityType: "task",
          entityId: binding.planTaskId,
          summary: "Goal Task Agent execution was queued under the approved contract."
        },
        action: null,
        taskAgentJob: prepared.job
      });
      if (claim.status === "contended") continue;
      if (claim.status === "rejected") {
        await pauseDispatchFailure(input, `Goal Run is paused before Task Agent queue admission because ${claim.reason}`, planTask.id);
        return;
      }
      const queued = await input.enqueueTaskAgent(prepared.job, jobId);
      if (queued.jobId !== jobId) throw new Error("Goal Task Agent queue returned a mismatched job ID.");
    } catch (error) {
      await pauseDispatchFailure(input, `Goal Run is paused because Task Agent queue admission could not be verified: ${error instanceof Error ? error.message : "unknown queue error"}`, planTask.id);
      return;
    }
    slots -= 1;
  }
}

type ReservedReviewer = {
  agentId: string;
  revision: number;
  connectorId: string;
  modelConnectorBinding: GoalReviewJobData["modelConnectorBinding"];
  credentialBinding?: GoalReviewJobData["credentialBinding"];
  reviewerParticipantId: string;
  reviewerRoleId: string;
  reviewerRoleRevision: number;
  reviewerRoleSnapshotDigest: string;
};

async function reservedReviewerCandidates(
  store: GoalOrchestrateStore,
  detail: NonNullable<Awaited<ReturnType<GoalOrchestrateStore["getGoalRunDetail"]>>>
): Promise<ReservedReviewer[]> {
  const snapshot = await store.getSnapshot();
  const activePlan = detail.plans.find((plan) => plan.revision === detail.goalRun.activePlanRevision);
  const plannerAgentId = activePlan?.plannerProvenance?.plannerAgentId ?? null;
  const candidates: ReservedReviewer[] = [];
  for (const participant of snapshot.participants.filter((candidate) => candidate.meetingId === detail.goalRun.meetingId && !candidate.isChair)) {
    if (!participant.roleSnapshot.orchestrationFunctions.includes("reviewer")) continue;
    if (participant.agentId === plannerAgentId) continue;
    const agent = snapshot.agents.find((candidate) => candidate.id === participant.agentId);
    if (!agent || agent.lifecycleStatus === "disabled" || !participant.agentRevision) continue;
    const readiness = await store.getAgentReadiness(agent.id).catch(() => null);
    if (!readiness || readiness.status === "blocked") continue;
    const revision = await store.getAgentRevision(agent.id, participant.agentRevision).catch(() => null);
    if (!revision?.modelConnectorId) continue;
    if (candidates.some((candidate) => candidate.agentId === agent.id || candidate.connectorId === revision.modelConnectorId)) continue;
    try {
      const binding = createGoalReviewBinding(snapshot, revision.modelConnectorId, participant);
      candidates.push({ agentId: agent.id, revision: revision.revision, connectorId: revision.modelConnectorId, ...binding });
    } catch {
      continue;
    }
    if (candidates.length === 2) break;
  }
  return candidates;
}

async function executionReviewQuorumFailure(
  store: GoalOrchestrateStore,
  goalRunId: string
): Promise<{ reason: string; detail: Record<string, string | number | boolean | null> } | null> {
  const detail = await store.getGoalRunDetail(goalRunId);
  if (!detail?.executionContract) return { reason: "Goal Run is paused because its approved Execution Contract is unavailable.", detail: {} };
  const plan = detail.plans.find((candidate) => candidate.revision === detail.goalRun.activePlanRevision);
  if (!plan) return { reason: "Goal Run is paused because its approved Plan revision is unavailable.", detail: {} };
  if (!plan.plannerProvenance) {
    return { reason: "Goal Run is paused because immutable Planner provenance is unavailable.", detail: {} };
  }
  const reviewers = await reservedReviewerCandidates(store, detail);
  if (reviewers.length !== 2) {
    return {
      reason: "Goal Run is paused because two reserved non-Chair Reviewer Agents with different Model Connectors are unavailable.",
      detail: { reviewerCount: reviewers.length }
    };
  }
  const reviewerIds = new Set(reviewers.map((reviewer) => reviewer.agentId));
  const conflictingTask = plan.tasks.find((task) => task.assigneeAgentId !== null && reviewerIds.has(task.assigneeAgentId));
  if (conflictingTask) {
    return {
      reason: "Goal Run is paused because a reserved Reviewer is assigned execution work.",
      detail: { planTaskId: conflictingTask.id, reviewerAgentId: conflictingTask.assigneeAgentId }
    };
  }
  return null;
}

async function scheduleReviews(input: ProcessGoalOrchestrateInput): Promise<void> {
  if (!input.enqueueReview) return;
  const detail = await input.store.getGoalRunDetail(input.data.goalRunId);
  if (!detail?.executionContract || !["executing", "reviewing"].includes(detail.goalRun.state)) return;
  const plan = detail.plans.find((candidate) => candidate.revision === detail.goalRun.activePlanRevision);
  if (!plan) return;
  if (!plan.plannerProvenance) {
    const current = await input.store.getGoalRun(detail.goalRun.id);
    if (current && current.state !== "paused") {
      await pauseGoalRun(input.store, current, "Goal Run is paused because immutable Planner provenance is unavailable.");
    }
    return;
  }
  const reservedReviewers = await reservedReviewerCandidates(input.store, detail);
  if (reservedReviewers.length !== 2) {
    const current = await input.store.getGoalRun(detail.goalRun.id);
    if (current && current.state !== "paused") {
      await pauseGoalRun(input.store, current, "Goal Run is paused because two reserved non-Chair Reviewer Agents with different Model Connectors are unavailable.");
    }
    return;
  }
  const scopes: Array<{ scope: GoalReviewJobData["scope"]; scopeId: string; excluded: Set<string> }> = [];
  for (const binding of detail.taskBindings.filter((candidate) => candidate.planRevision === plan.revision && candidate.state === "reviewing")) {
    const planTask = plan.tasks.find((candidate) => candidate.id === binding.planTaskId)!;
    const actionRun = planTask.executionMode === "action"
      ? detail.actionRuns.find((candidate) => (
        candidate.planTaskId === planTask.id
        && candidate.contractDigest === detail.executionContract!.contractDigest
      ))
      : null;
    scopes.push({
      scope: actionRun ? "action" : "task",
      scopeId: actionRun?.id ?? planTask.id,
      excluded: new Set([planTask.assigneeAgentId].filter((agentId): agentId is string => Boolean(agentId)))
    });
  }
  const activeBindings = detail.taskBindings.filter((candidate) => candidate.planRevision === plan.revision);
  if (activeBindings.length > 0 && activeBindings.every((binding) => binding.state === "completed")) {
    if (detail.goalRun.state === "executing") {
      await input.store.setGoalRunState(detail.goalRun.id, {
        expectedRevision: detail.goalRun.revision,
        state: "reviewing",
        event: {
          type: "goal.state.changed",
          actorType: "system",
          actorId: null,
          entityType: "goal",
          entityId: detail.goalRun.id,
          summary: "All Goal tasks passed review; final Goal review started."
        }
      });
    }
    scopes.push({
      scope: "goal",
      scopeId: detail.goalRun.id,
      excluded: new Set(plan.tasks.map((task) => task.assigneeAgentId).filter((agentId): agentId is string => Boolean(agentId)))
    });
  }
  for (const scope of scopes) {
    const existing = detail.reviewerVerdicts.filter((verdict) => (
      verdict.scope === scope.scope
      && verdict.scopeId === scope.scopeId
      && verdict.contractDigest === detail.executionContract!.contractDigest
    ));
    if (existing.length >= 2) continue;
    existing.forEach((verdict) => scope.excluded.add(verdict.reviewerAgentId));
    const candidates = reservedReviewers.filter((reviewer) => !scope.excluded.has(reviewer.agentId));
    if (candidates.length < 2 - existing.length) {
      const current = await input.store.getGoalRun(detail.goalRun.id);
      if (current && current.state !== "paused") {
        await pauseGoalRun(input.store, current, "Goal Run is paused because two independent Reviewer Agents with different Model Connectors are unavailable.", {
          scope: scope.scope,
          scopeId: scope.scopeId
        });
      }
      return;
    }
    for (const reviewer of candidates.slice(0, 2 - existing.length)) {
      const job: GoalReviewJobData = {
        goalRunId: detail.goalRun.id,
        scope: scope.scope,
        scopeId: scope.scopeId,
        reviewerAgentId: reviewer.agentId,
        reviewerAgentRevision: reviewer.revision,
        reviewerParticipantId: reviewer.reviewerParticipantId,
        reviewerRoleId: reviewer.reviewerRoleId,
        reviewerRoleRevision: reviewer.reviewerRoleRevision,
        reviewerRoleSnapshotDigest: reviewer.reviewerRoleSnapshotDigest,
        modelConnectorId: reviewer.connectorId,
        modelConnectorBinding: reviewer.modelConnectorBinding,
        ...(reviewer.credentialBinding ? { credentialBinding: reviewer.credentialBinding } : {}),
        contractDigest: detail.executionContract.contractDigest,
        requestedBy: "system"
      };
      const jobId = `goal-review-${scope.scope}-${scope.scopeId}-${reviewer.agentId}-${detail.executionContract.contractDigest.slice(0, 16)}-${goalReviewJobIdDigest(job)}`;
      let fingerprint: string;
      try {
        fingerprint = goalReviewAdmissionFingerprint(job);
      } catch (error) {
        const current = await input.store.getGoalRun(detail.goalRun.id);
        if (current && current.state !== "paused") {
          await pauseGoalRun(input.store, current, `Goal Run is paused because the Reviewer queue binding cannot be durably admitted: ${error instanceof Error ? error.message : "unknown binding error"}`, {
            scope: scope.scope,
            scopeId: scope.scopeId,
            reviewerAgentId: reviewer.agentId
          });
        }
        return;
      }
      await reserveReviewProcessorJob({
        store: input.store,
        admission: admission({
          jobId,
          goalRunId: job.goalRunId,
          jobName: "goal-review",
          entityId: `${job.scope}:${job.scopeId}:${job.reviewerAgentId}`,
          requestFingerprint: fingerprint
        }),
        data: job,
        enqueue: () => input.enqueueReview!(job, jobId)
      });
    }
  }
}

export async function processGoalOrchestrate(input: ProcessGoalOrchestrateInput): Promise<GoalOrchestrateResult> {
  const admissionResult = await beginGoalJob({
    store: input.store,
    jobId: input.jobId,
    goalRunId: input.data.goalRunId,
    jobName: "goal-orchestrate",
    entityId: input.data.goalRunId,
    requestFingerprint: input.data.requestFingerprint
  });
  if (admissionResult.status !== "run") return admissionResult.status === "settled" ? "settled" : "paused";

  const goalRun = await input.store.getGoalRun(input.data.goalRunId);
  if (!goalRun || goalRun.revision !== input.data.expectedRevision || isGoalRunTerminal(goalRun.state)) {
    await settleGoalJob(input.store, admissionResult.admission);
    return "stale";
  }
  const budgetReason = goalBudgetFailureReason({ limits: goalRun.limits, usage: goalRun.usage, deadlineAt: goalRun.deadlineAt });
  if (budgetReason) {
    await pauseGoalRun(input.store, goalRun, budgetReason);
    await settleGoalJob(input.store, admissionResult.admission);
    return "paused";
  }
  const snapshot = await input.store.getSnapshot();
  const meeting = snapshot.meetings.find((item) => item.id === goalRun.meetingId);
  if (!meeting || meeting.threadId !== goalRun.threadId) {
    await pauseGoalRun(input.store, goalRun, "Goal Run meeting linkage is no longer valid; owner intervention is required.", { meetingId: goalRun.meetingId });
    await settleGoalJob(input.store, admissionResult.admission);
    return "paused";
  }
  if (["planning", "replanning"].includes(goalRun.state)) {
    let currentRun = goalRun;
    let currentSnapshot = snapshot;
    let decisions = currentSnapshot.decisions.filter((decision) => decision.meetingId === meeting.id && decision.status !== "rejected");
    if (decisions.length === 0 && input.runMeetingRound && meeting.state === "active") {
      try {
        while (currentRun.usage.discussionRounds < currentRun.limits.discussionRounds) {
          const participantCount = currentSnapshot.participants.filter((participant) => participant.meetingId === meeting.id).length;
          if (currentRun.usage.modelCalls + participantCount > currentRun.limits.maxModelCalls) {
            await pauseGoalRun(input.store, currentRun, "Goal Run is paused before a Meeting round because its model-call budget would be exceeded.");
            await settleGoalJob(input.store, admissionResult.admission);
            return "paused";
          }
          const round = currentRun.usage.discussionRounds + 1;
          await input.store.appendGoalEvent(currentRun.id, {
            type: "meeting.round.started",
            actorType: "system",
            actorId: null,
            entityType: "meeting",
            entityId: meeting.id,
            summary: `Formal Meeting discussion round ${round} started.`,
            detail: { round }
          });
          const result = await input.runMeetingRound({ goalRunId: currentRun.id, meetingId: meeting.id, round });
          const latest = await input.store.getGoalRun(currentRun.id);
          if (!latest || latest.state === "paused") throw new Error("Goal Run changed while the formal Meeting round was running.");
          currentRun = await input.store.setGoalRunState(latest.id, {
            expectedRevision: latest.revision,
            state: latest.state,
            usage: {
              ...latest.usage,
              discussionRounds: round,
              modelCalls: latest.usage.modelCalls + result.modelCalls
            },
            event: {
              type: "meeting.round.completed",
              actorType: "system",
              actorId: null,
              entityType: "meeting",
              entityId: meeting.id,
              summary: `Formal Meeting discussion round ${round} completed.`,
              detail: { round, modelCalls: result.modelCalls }
            }
          });
          currentSnapshot = await input.store.getSnapshot();
        }
        decisions = currentSnapshot.decisions.filter((decision) => decision.meetingId === meeting.id && decision.status !== "rejected");
        if (decisions.length === 0) {
          await input.store.createDecision({
            meetingId: meeting.id,
            title: currentRun.title,
            description: decisionDescription(
              currentRun.goal,
              currentSnapshot.utterances.filter((utterance) => utterance.meetingId === meeting.id)
            )
          }, `goal-run:${currentRun.id}:converged-decision:1`);
          currentSnapshot = await input.store.getSnapshot();
          decisions = currentSnapshot.decisions.filter((decision) => decision.meetingId === meeting.id && decision.status !== "rejected");
        }
        const latestMeeting = currentSnapshot.meetings.find((candidate) => candidate.id === meeting.id);
        if (latestMeeting?.state === "active") await input.store.setMeetingState(meeting.id, "paused", "active");
      } catch (error) {
        const latest = await input.store.getGoalRun(currentRun.id);
        if (latest && latest.state !== "paused") {
          await pauseGoalRun(input.store, latest, `Goal Run is paused because autonomous formal Meeting discussion failed: ${error instanceof Error ? error.message : "unknown Meeting error"}`);
        }
        await settleGoalJob(input.store, admissionResult.admission);
        return "paused";
      }
    }
    if (decisions.length > 0) {
      const latest = await input.store.getGoalRun(currentRun.id);
      if (latest && ["planning", "replanning"].includes(latest.state)) {
        const planJobId = `goal-plan-${latest.id}-${latest.activePlanRevision + 1}`;
        const planRequestFingerprint = `${latest.id}:${latest.revision}:${latest.activePlanRevision}`;
        await input.store.reserveGoalJob(admission({
          jobId: planJobId,
          goalRunId: latest.id,
          jobName: "goal-plan",
          entityId: String(latest.activePlanRevision),
          requestFingerprint: planRequestFingerprint
        }));
        await processGoalPlan({
          store: input.store,
          jobId: planJobId,
          data: {
            goalRunId: latest.id,
            expectedRevision: latest.revision,
            expectedPlanRevision: latest.activePlanRevision,
            requestedBy: "system"
          }
        });
      }
    }
  } else if (goalRun.state === "executing") {
    const reviewQuorumFailure = await executionReviewQuorumFailure(input.store, goalRun.id);
    if (reviewQuorumFailure) {
      const current = await input.store.getGoalRun(goalRun.id);
      if (current && current.state !== "paused") await pauseGoalRun(input.store, current, reviewQuorumFailure.reason, reviewQuorumFailure.detail);
      await settleGoalJob(input.store, admissionResult.admission);
      return "paused";
    }
    await synchronizeBindings(input.store, goalRun.id);
    const current = await input.store.getGoalRun(goalRun.id);
    if (current?.state === "paused") {
      await settleGoalJob(input.store, admissionResult.admission);
      return "paused";
    }
    await dispatchReadyWork(input);
    const afterDispatch = await input.store.getGoalRun(goalRun.id);
    if (afterDispatch?.state === "paused") {
      await settleGoalJob(input.store, admissionResult.admission);
      return "paused";
    }
    await scheduleReviews(input);
  } else if (goalRun.state === "reviewing") {
    await scheduleReviews(input);
  }
  await settleGoalJob(input.store, admissionResult.admission);
  return "settled";
}
