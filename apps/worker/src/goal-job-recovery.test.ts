import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { GoalJobAdmission } from "@council/database";
import type {
  GoalPlanTask,
  GoalReviewJobData,
  GoalRun,
  GoalTaskBinding,
  LegacyGoalReviewJobData
} from "@council/contracts";
import { goalExecutionLimitsSchema } from "@council/contracts";
import { InMemoryPlatformStore, roleExecutionSnapshotDigest } from "@council/database";
import { createSeedSnapshot } from "@council/database/seed";
import { createExecutionContract, goalPlanDigest } from "@council/domain";
import { recoverFailedGoalTaskBindings, recoverGoalJobs } from "./goal-job-recovery.js";
import {
  processGoalReview as processGoalReviewImpl,
  processLegacyGoalReview as processLegacyGoalReviewImpl
} from "./process-goal-review.js";
import {
  createGoalReviewBinding,
  goalReviewAdmissionFingerprint,
  legacyGoalReviewAdmissionFingerprint
} from "./goal-review-binding.js";

const ownerId = "30000000-0000-4000-8000-000000000001";
const now = "2026-08-27T00:00:00.000Z";
const recoveryConnectorId = "53000000-0000-4000-8000-000000000001";
const recoveryPlannerConnectorId = "53000000-0000-4000-8000-000000000002";

function admission(input: Pick<GoalJobAdmission, "jobId" | "goalRunId" | "jobName" | "entityId" | "requestFingerprint">): GoalJobAdmission {
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

async function createGoal(store: InMemoryPlatformStore): Promise<GoalRun> {
  const meeting = (await store.getSnapshot()).meetings[0]!;
  const goalRun: GoalRun = {
    id: randomUUID(),
    title: "Recover durable Goal work",
    goal: "Recover durable Goal work without replaying an uncertain external effect.",
    threadId: meeting.threadId,
    meetingId: meeting.id,
    state: "planning",
    revision: 1,
    activePlanRevision: 0,
    executionContractId: null,
    limits: goalExecutionLimitsSchema.parse({}),
    usage: { discussionRounds: 0, taskAttempts: 0, replans: 0, modelCalls: 0, actionCalls: 0 },
    deadlineAt: "2027-08-27T00:00:00.000Z",
    pausedFromState: null,
    terminalReason: null,
    createdBy: ownerId,
    createdAt: now,
    updatedAt: now
  };
  return store.createGoalRun(goalRun, {
    type: "goal.created", actorType: "owner", actorId: ownerId, entityType: "goal", entityId: goalRun.id,
    summary: "Goal created for recovery test."
  }, `recover-goal:${goalRun.id}`);
}

async function approvedGoal() {
  const seed = createSeedSnapshot();
  seed.decisions = [];
  seed.tasks = [];
  seed.modelConnectors.push({
    id: recoveryConnectorId,
    revision: 1,
    name: "Recovery Reviewer",
    location: "local",
    baseUrl: "http://127.0.0.1:4300/v1",
    model: "recovery-reviewer",
    enabled: true,
    hasSecret: false,
    secretRevision: 0,
    credentialId: null
  }, {
    id: recoveryPlannerConnectorId,
    revision: 1,
    name: "Recovery Planner",
    location: "local",
    baseUrl: "http://127.0.0.1:4301/v1",
    model: "recovery-planner",
    enabled: true,
    hasSecret: false,
    secretRevision: 0,
    credentialId: null
  });
  const seededReviewer = seed.participants.find((participant) => participant.roleSnapshot.orchestrationFunctions.includes("reviewer"))!;
  const seededPlanner = seed.participants.find((participant) => participant.roleSnapshot.orchestrationFunctions.includes("planner"))!;
  seed.agents.find((agent) => agent.id === seededReviewer.agentId)!.modelConnectorId = recoveryConnectorId;
  seed.agents.find((agent) => agent.id === seededReviewer.agentId)!.status = "online";
  seed.agents.find((agent) => agent.id === seededPlanner.agentId)!.modelConnectorId = recoveryPlannerConnectorId;
  seed.agents.find((agent) => agent.id === seededPlanner.agentId)!.status = "online";
  const store = new InMemoryPlatformStore(seed);
  const goalRun = await createGoal(store);
  const snapshot = await store.getSnapshot();
  const planner = snapshot.participants.find((participant) => (
    participant.meetingId === goalRun.meetingId
    && participant.roleSnapshot.orchestrationFunctions.includes("planner")
  ))!;
  const plannerRevision = await store.getAgentRevision(planner.agentId, planner.agentRevision ?? 1);
  const plannerRole = planner.roleHistory.find((entry) => entry.revision === planner.roleRevision)!;
  const decision = await store.createDecision({ meetingId: goalRun.meetingId, title: "Recover review", description: "Retain attributable evidence." });
  const task: GoalPlanTask = {
    id: randomUUID(),
    decisionId: decision.id,
    title: decision.title,
    description: decision.description,
    acceptanceCriteria: "The recovery path is attributable and does not replay uncertain model work.",
    dependencyIds: [],
    assigneeAgentId: null,
    executionMode: "manual",
    allowedTools: [],
    dataScope: "Formal Meeting evidence only.",
    action: null
  };
  const plan = {
    id: randomUUID(), goalRunId: goalRun.id, revision: 1, status: "draft" as const,
    digest: goalPlanDigest([task]), tasks: [task], createdAt: now,
    plannerProvenance: {
      plannerParticipantId: planner.id,
      plannerAgentId: planner.agentId,
      plannerAgentRevision: plannerRevision.revision,
      plannerModelConnectorId: plannerRevision.modelConnectorId!,
      plannerRoleId: plannerRole.roleId,
      plannerRoleRevision: plannerRole.revision,
      plannerRoleSnapshotDigest: roleExecutionSnapshotDigest(plannerRole.roleSnapshot)
    }
  };
  const planned = await store.saveGoalPlan(goalRun.id, {
    expectedRevision: goalRun.revision,
    expectedPlanRevision: 0,
    plan,
    event: { type: "plan.created", actorType: "system", actorId: null, entityType: "plan", entityId: plan.id, summary: "Plan created." }
  });
  const contract = createExecutionContract({ goalRunId: goalRun.id, planRevision: 1, tasks: [task], limits: planned.goalRun.limits, approvedBy: ownerId, approvedAt: now });
  const binding: GoalTaskBinding = {
    id: randomUUID(), goalRunId: goalRun.id, planRevision: 1, planTaskId: task.id, taskId: null,
    state: "ready", attemptCount: 0, activeJobId: null, lastError: null, createdAt: now, updatedAt: now
  };
  const approved = await store.approveGoalRun(goalRun.id, {
    expectedRevision: planned.goalRun.revision,
    contract,
    bindings: [binding],
    event: { type: "contract.approved", actorType: "owner", actorId: ownerId, entityType: "plan", entityId: plan.id, summary: "Contract approved." }
  });
  return { store, goalRun: approved.goalRun, task, contract, binding: approved.taskBindings[0]! };
}

async function addRecoveryEvidence(fixture: Awaited<ReturnType<typeof approvedGoal>>): Promise<string> {
  if (!fixture.binding.taskId) throw new Error("Expected approved Goal binding to reference a canonical Task.");
  const task = await fixture.store.addTaskEvidence(fixture.binding.taskId, {
    type: "note",
    label: "Durable recovery evidence",
    reference: "The recovered task result remains attributable to the immutable review scope."
  });
  return task.evidence.at(-1)!.id;
}

async function recoveryReviewJob(input: {
  store: InMemoryPlatformStore;
  goalRunId: string;
  taskId: string;
  contractDigest: string;
}): Promise<GoalReviewJobData> {
  const snapshot = await input.store.getSnapshot();
  const reviewer = snapshot.participants.find((participant) => (
    participant.roleSnapshot.orchestrationFunctions.includes("reviewer")
  ))!;
  const revision = await input.store.getAgentRevision(reviewer.agentId, reviewer.agentRevision ?? 1);
  const binding = createGoalReviewBinding(snapshot, recoveryConnectorId, reviewer);
  return {
    goalRunId: input.goalRunId,
    scope: "task",
    scopeId: input.taskId,
    reviewerAgentId: reviewer.agentId,
    reviewerAgentRevision: revision.revision,
    modelConnectorId: recoveryConnectorId,
    ...binding,
    contractDigest: input.contractDigest,
    requestedBy: "system"
  };
}

function legacyRecoveryReviewJob(data: GoalReviewJobData): LegacyGoalReviewJobData {
  return {
    goalRunId: data.goalRunId,
    scope: data.scope,
    scopeId: data.scopeId,
    reviewerAgentId: data.reviewerAgentId,
    reviewerAgentRevision: data.reviewerAgentRevision,
    modelConnectorId: data.modelConnectorId,
    contractDigest: data.contractDigest,
    requestedBy: data.requestedBy
  };
}

function noOpRecoveryCallbacks() {
  return {
    runPlan: vi.fn(async () => undefined),
    runReview: vi.fn(async () => undefined),
    enqueueReview: vi.fn(async (_data: unknown, jobId: string) => ({ jobId })),
    enqueueAction: vi.fn(async (_data: unknown, jobId: string) => ({ jobId })),
    continueGoal: vi.fn(async () => undefined)
  };
}

describe("Goal job recovery", () => {
  it.each([
    { queueState: "failed", continued: 1, preserved: 0 },
    { queueState: "active", continued: 0, preserved: 1 }
  ])("recovers a failed canonical Goal Task only after queue ownership is terminal ($queueState)", async ({ queueState, continued, preserved }) => {
    const goalRunId = randomUUID();
    const taskId = randomUUID();
    const bindingId = randomUUID();
    const jobId = `goal-task-${taskId}-attempt-1`;
    const continueGoal = vi.fn(async () => undefined);
    const store = {
      getSnapshot: vi.fn(async () => ({
        tasks: [{ id: taskId, execution: { status: "failed", jobId } }]
      })),
      listGoalRuns: vi.fn(async () => [{ id: goalRunId, state: "executing", activePlanRevision: 1 }]),
      getGoalRunDetail: vi.fn(async () => ({
        taskBindings: [{
          id: bindingId,
          goalRunId,
          planRevision: 1,
          planTaskId: randomUUID(),
          taskId,
          state: "running",
          activeJobId: jobId
        }]
      }))
    };

    const result = await recoverFailedGoalTaskBindings({
      store: store as never,
      findJob: async () => ({ getState: async () => queueState }),
      continueGoal
    });

    expect(result).toEqual({ checked: 1, continued, preserved });
    expect(continueGoal).toHaveBeenCalledTimes(continued);
    if (continued === 1) {
      expect(continueGoal).toHaveBeenCalledWith(goalRunId, `recovered-task-agent:${jobId}`);
    }
  });

  it("recovers a failed canonical Task reserved before its Goal binding claim committed", async () => {
    const goalRunId = randomUUID();
    const planTaskId = randomUUID();
    const taskId = randomUUID();
    const jobId = `goal-task-${goalRunId}-${planTaskId}-a1-e1`;
    const continueGoal = vi.fn(async () => undefined);
    const store = {
      getSnapshot: vi.fn(async () => ({
        tasks: [{ id: taskId, execution: { status: "failed", jobId } }]
      })),
      listGoalRuns: vi.fn(async () => [{ id: goalRunId, state: "executing", activePlanRevision: 1 }]),
      getGoalRunDetail: vi.fn(async () => ({
        taskBindings: [{
          id: randomUUID(),
          goalRunId,
          planRevision: 1,
          planTaskId,
          taskId,
          state: "ready",
          activeJobId: null
        }]
      }))
    };

    const result = await recoverFailedGoalTaskBindings({
      store: store as never,
      findJob: async () => null,
      continueGoal
    });

    expect(result).toEqual({ checked: 1, continued: 1, preserved: 0 });
    expect(continueGoal).toHaveBeenCalledWith(goalRunId, `recovered-task-agent:${jobId}`);
  });

  it("reruns an idempotent orchestration admission after Worker restart", async () => {
    const seed = createSeedSnapshot();
    seed.decisions = [];
    seed.tasks = [];
    const store = new InMemoryPlatformStore(seed);
    const goalRun = await createGoal(store);
    const record = admission({
      jobId: `goal-orchestrate-${goalRun.id}`,
      goalRunId: goalRun.id,
      jobName: "goal-orchestrate",
      entityId: goalRun.id,
      requestFingerprint: "a".repeat(64)
    });
    await store.reserveGoalJob(record);
    await store.setGoalJobState(record.jobId, "reserved", "admitted");
    await store.setGoalJobState(record.jobId, "admitted", "running");
    const runOrchestrate = vi.fn(async () => undefined);

    const result = await recoverGoalJobs({
      store,
      startup: true,
      findJob: async () => null,
      runOrchestrate,
      ...noOpRecoveryCallbacks()
    });

    expect(result).toMatchObject({ checked: 1, rerun: 1, fenced: 0 });
    expect(runOrchestrate).toHaveBeenCalledWith(expect.objectContaining({
      goalRunId: goalRun.id,
      expectedRevision: goalRun.revision,
      requestFingerprint: record.requestFingerprint
    }), record.jobId);
  });

  it("defers an owned dispatch lease and recovers it immediately after expiry", async () => {
    const store = new InMemoryPlatformStore(createSeedSnapshot());
    const goalRun = await createGoal(store);
    const record = admission({
      jobId: `goal-orchestrate-dispatch-${goalRun.id}`,
      goalRunId: goalRun.id,
      jobName: "goal-orchestrate",
      entityId: goalRun.id,
      requestFingerprint: "f".repeat(64)
    });
    await store.reserveGoalJob(record);
    await store.claimGoalJobDispatch(record.jobId, {
      dispatchToken: "dispatch-owner-a",
      leaseDurationMs: 30_000,
      now: "2026-08-27T00:00:00.000Z"
    });
    const runOrchestrate = vi.fn(async () => undefined);
    const callbacks = {
      store,
      findJob: async () => null,
      runOrchestrate,
      ...noOpRecoveryCallbacks()
    };

    await expect(recoverGoalJobs({ ...callbacks, now: "2026-08-27T00:00:29.999Z" }))
      .resolves.toMatchObject({ deferred: 1, rerun: 0 });
    expect(runOrchestrate).not.toHaveBeenCalled();

    await expect(recoverGoalJobs({ ...callbacks, now: "2026-08-27T00:00:30.001Z" }))
      .resolves.toMatchObject({ deferred: 0, rerun: 1 });
    expect(runOrchestrate).toHaveBeenCalledWith(expect.objectContaining({ goalRunId: goalRun.id }), record.jobId);
    await expect(store.getGoalJobAdmission(record.jobId)).resolves.toMatchObject({
      state: "admitted",
      dispatchToken: null,
      dispatchLeaseExpiresAt: null
    });
  });

  it("requeues an admitted Reviewer that never started, but fences an uncertain running Reviewer", async () => {
    const safe = await approvedGoal();
    const safeJob = await recoveryReviewJob({
      store: safe.store,
      goalRunId: safe.goalRun.id,
      taskId: safe.task.id,
      contractDigest: safe.contract.contractDigest
    });
    const reviewerAgentId = safeJob.reviewerAgentId;
    const safeRecord = admission({
      jobId: `goal-review-task-${safe.task.id}-${reviewerAgentId}`,
      goalRunId: safe.goalRun.id,
      jobName: "goal-review",
      entityId: `task:${safe.task.id}:${reviewerAgentId}`,
      requestFingerprint: goalReviewAdmissionFingerprint(safeJob)
    });
    await safe.store.reserveGoalReviewJob(safeRecord, safeJob);
    await safe.store.setGoalJobState(safeRecord.jobId, "reserved", "admitted");
    const enqueueReview = vi.fn(async (_data: unknown, jobId: string) => ({ jobId }));
    const safeResult = await recoverGoalJobs({
      store: safe.store,
      startup: true,
      findJob: async () => null,
      runOrchestrate: vi.fn(async () => undefined),
      ...noOpRecoveryCallbacks(),
      enqueueReview
    });
    expect(safeResult).toMatchObject({ requeued: 1, fenced: 0 });
    expect(enqueueReview).toHaveBeenCalledWith(expect.objectContaining({ reviewerAgentId, modelConnectorId: recoveryConnectorId }), safeRecord.jobId);
    expect(await safe.store.reserveGoalJob(safeRecord)).toMatchObject({ state: "admitted" });

    const uncertain = await approvedGoal();
    const uncertainJob = await recoveryReviewJob({
      store: uncertain.store,
      goalRunId: uncertain.goalRun.id,
      taskId: uncertain.task.id,
      contractDigest: uncertain.contract.contractDigest
    });
    const uncertainRecord = admission({
      ...safeRecord,
      jobId: `goal-review-task-${uncertain.task.id}-${reviewerAgentId}`,
      goalRunId: uncertain.goalRun.id,
      entityId: `task:${uncertain.task.id}:${reviewerAgentId}`,
      requestFingerprint: goalReviewAdmissionFingerprint(uncertainJob)
    });
    await uncertain.store.reserveGoalReviewJob(uncertainRecord, uncertainJob);
    await uncertain.store.setGoalJobState(uncertainRecord.jobId, "reserved", "admitted");
    await uncertain.store.setGoalJobState(uncertainRecord.jobId, "admitted", "running");
    const uncertainResult = await recoverGoalJobs({
      store: uncertain.store,
      startup: true,
      findJob: async () => null,
      runOrchestrate: vi.fn(async () => undefined),
      ...noOpRecoveryCallbacks()
    });
    expect(uncertainResult).toMatchObject({ fenced: 1, requeued: 0 });
    expect(await uncertain.store.getGoalRun(uncertain.goalRun.id)).toMatchObject({ state: "paused", pausedFromState: "executing" });
    expect(await uncertain.store.reserveGoalJob(uncertainRecord)).toMatchObject({ state: "outcome_unknown" });
  });

  it("pauses instead of requeueing a recovered Reviewer after its immutable Connector binding drifts", async () => {
    const fixture = await approvedGoal();
    const job = await recoveryReviewJob({
      store: fixture.store,
      goalRunId: fixture.goalRun.id,
      taskId: fixture.task.id,
      contractDigest: fixture.contract.contractDigest
    });
    const reviewerAgentId = job.reviewerAgentId;
    const record = admission({
      jobId: `goal-review-task-${fixture.task.id}-${reviewerAgentId}`,
      goalRunId: fixture.goalRun.id,
      jobName: "goal-review",
      entityId: `task:${fixture.task.id}:${reviewerAgentId}`,
      requestFingerprint: goalReviewAdmissionFingerprint(job)
    });
    await fixture.store.reserveGoalReviewJob(record, job);
    await fixture.store.setGoalJobState(record.jobId, "reserved", "admitted");
    const state = Reflect.get(fixture.store, "state") as ReturnType<typeof createSeedSnapshot>;
    state.modelConnectors.find((candidate) => candidate.id === recoveryConnectorId)!.revision += 1;
    const enqueueReview = vi.fn(async (_data: unknown, jobId: string) => ({ jobId }));

    const result = await recoverGoalJobs({
      store: fixture.store,
      startup: true,
      findJob: async () => null,
      runOrchestrate: vi.fn(async () => undefined),
      ...noOpRecoveryCallbacks(),
      enqueueReview
    });

    expect(result).toMatchObject({ requeued: 0, fenced: 1 });
    expect(enqueueReview).not.toHaveBeenCalled();
    expect(await fixture.store.getGoalJobAdmission(record.jobId)).toMatchObject({ state: "settled" });
    expect(await fixture.store.getGoalRun(fixture.goalRun.id)).toMatchObject({ state: "paused" });
  });

  it("fences a failed running Reviewer during periodic recovery", async () => {
    const fixture = await approvedGoal();
    const job = await recoveryReviewJob({
      store: fixture.store,
      goalRunId: fixture.goalRun.id,
      taskId: fixture.task.id,
      contractDigest: fixture.contract.contractDigest
    });
    const reviewerAgentId = job.reviewerAgentId;
    const record = admission({
      jobId: `goal-review-task-${fixture.task.id}-${reviewerAgentId}`,
      goalRunId: fixture.goalRun.id,
      jobName: "goal-review",
      entityId: `task:${fixture.task.id}:${reviewerAgentId}`,
      requestFingerprint: goalReviewAdmissionFingerprint(job)
    });
    await fixture.store.reserveGoalReviewJob(record, job);
    await fixture.store.setGoalJobState(record.jobId, "reserved", "admitted");
    await fixture.store.setGoalJobState(record.jobId, "admitted", "running");
    const retry = vi.fn(async () => undefined);

    const result = await recoverGoalJobs({
      store: fixture.store,
      startup: false,
      now: "2026-08-27T00:00:01.000Z",
      findJob: async () => ({ getState: async () => "failed", retry }),
      runOrchestrate: vi.fn(async () => undefined),
      ...noOpRecoveryCallbacks()
    });

    expect(result).toMatchObject({ fenced: 1, deferred: 0, requeued: 0 });
    expect(retry).not.toHaveBeenCalled();
    expect(await fixture.store.reserveGoalJob(record)).toMatchObject({ state: "outcome_unknown" });
    expect(await fixture.store.getGoalRun(fixture.goalRun.id)).toMatchObject({ state: "paused" });
  });

  it("retries a failed running asynchronous Action during periodic recovery", async () => {
    const record: GoalJobAdmission = {
      ...admission({
        jobId: "goal-action-running-external-1",
        goalRunId: randomUUID(),
        jobName: "goal-action-run",
        entityId: randomUUID(),
        requestFingerprint: `${randomUUID()}:${randomUUID()}:${randomUUID()}:${"a".repeat(64)}`
      }),
      state: "running",
      admittedAt: now,
      startedAt: now
    };
    const retry = vi.fn(async () => undefined);
    const store = {
      getRecoverableGoalJobs: vi.fn(async () => [record])
    };

    const result = await recoverGoalJobs({
      store: store as never,
      startup: false,
      now: "2026-08-27T00:00:01.000Z",
      findJob: async () => ({ getState: async () => "failed", retry }),
      runOrchestrate: vi.fn(async () => undefined),
      ...noOpRecoveryCallbacks()
    });

    expect(result).toMatchObject({ requeued: 1, deferred: 0 });
    expect(retry).toHaveBeenCalledWith("failed");
  });

  it("runs persisted Reviewer completion directly without requeueing model work", async () => {
    const fixture = await approvedGoal();
    const evidenceId = await addRecoveryEvidence(fixture);
    const job = await recoveryReviewJob({
      store: fixture.store,
      goalRunId: fixture.goalRun.id,
      taskId: fixture.task.id,
      contractDigest: fixture.contract.contractDigest
    });
    const reviewerAgentId = job.reviewerAgentId;
    const record = admission({
      jobId: `goal-review-task-${fixture.task.id}-${reviewerAgentId}`,
      goalRunId: fixture.goalRun.id,
      jobName: "goal-review",
      entityId: `task:${fixture.task.id}:${reviewerAgentId}`,
      requestFingerprint: goalReviewAdmissionFingerprint(job)
    });
    await fixture.store.reserveGoalReviewJob(record, job);
    await fixture.store.setGoalJobState(record.jobId, "reserved", "admitted");
    await fixture.store.setGoalJobState(record.jobId, "admitted", "running");
    await fixture.store.addReviewerVerdict({
      id: randomUUID(),
      goalRunId: fixture.goalRun.id,
      scope: "task",
      scopeId: fixture.task.id,
      reviewerAgentId,
      reviewerAgentRevision: 1,
      modelConnectorId: recoveryConnectorId,
      verdict: "pass",
      summary: "The durable verdict survived the Worker interruption.",
      evidenceIds: [evidenceId],
      contractDigest: fixture.contract.contractDigest,
      reviewJobId: record.jobId,
      reviewRequestFingerprint: record.requestFingerprint,
      createdAt: now
    }, {
      type: "review.recorded",
      actorType: "agent",
      actorId: reviewerAgentId,
      entityType: "review",
      entityId: randomUUID(),
      summary: "Reviewer verdict committed before restart."
    });
    const enqueueReview = vi.fn(async (_data: unknown, jobId: string) => ({ jobId }));
    const complete = vi.fn(async () => {
      throw new Error("Persisted Reviewer recovery must not call the model.");
    });
    const runReview = vi.fn(async (data: GoalReviewJobData | LegacyGoalReviewJobData, jobId: string) => (
      processGoalReviewImpl({ store: fixture.store, data: data as GoalReviewJobData, jobId, complete })
    ));
    const continueGoal = vi.fn(async () => undefined);

    const result = await recoverGoalJobs({
      store: fixture.store,
      startup: true,
      findJob: async () => null,
      runOrchestrate: vi.fn(async () => undefined),
      ...noOpRecoveryCallbacks(),
      runReview,
      enqueueReview,
      continueGoal
    });

    expect(result).toMatchObject({ requeued: 0, settled: 1, fenced: 0 });
    expect(runReview).toHaveBeenCalledWith(expect.objectContaining({
      reviewerAgentId,
      modelConnectorId: recoveryConnectorId,
      contractDigest: fixture.contract.contractDigest
    }), record.jobId);
    expect(enqueueReview).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(continueGoal).toHaveBeenCalledWith(fixture.goalRun.id, `recovered-review:${record.jobId}`);
    expect(await fixture.store.reserveGoalJob(record)).toMatchObject({ state: "settled" });
    expect(await fixture.store.getGoalRun(fixture.goalRun.id)).toMatchObject({ state: "executing" });
  });

  it("settles a legacy Reviewer without a verdict and requires an Owner-created version 2 job", async () => {
    const fixture = await approvedGoal();
    const current = await recoveryReviewJob({
      store: fixture.store,
      goalRunId: fixture.goalRun.id,
      taskId: fixture.task.id,
      contractDigest: fixture.contract.contractDigest
    });
    const reviewerAgentId = current.reviewerAgentId;
    const legacy = legacyRecoveryReviewJob(current);
    const record = admission({
      jobId: `goal-review-legacy-${fixture.task.id}-${reviewerAgentId}`,
      goalRunId: fixture.goalRun.id,
      jobName: "goal-review",
      entityId: `task:${fixture.task.id}:${reviewerAgentId}`,
      requestFingerprint: legacyGoalReviewAdmissionFingerprint(legacy)
    });
    await fixture.store.reserveGoalJob(record);
    const runReview = vi.fn(async () => undefined);
    const enqueueReview = vi.fn(async (_data: unknown, jobId: string) => ({ jobId }));

    const result = await recoverGoalJobs({
      store: fixture.store,
      startup: true,
      findJob: async () => null,
      runOrchestrate: vi.fn(async () => undefined),
      ...noOpRecoveryCallbacks(),
      runReview,
      enqueueReview
    });

    expect(result).toMatchObject({ fenced: 1, requeued: 0, settled: 0 });
    expect(runReview).not.toHaveBeenCalled();
    expect(enqueueReview).not.toHaveBeenCalled();
    expect(await fixture.store.getGoalJobAdmission(record.jobId)).toMatchObject({ state: "settled" });
    expect(await fixture.store.getGoalRun(fixture.goalRun.id)).toMatchObject({ state: "paused" });
  });

  it("routes a persisted legacy Reviewer verdict to reconciliation without model requeue", async () => {
    const fixture = await approvedGoal();
    const evidenceId = await addRecoveryEvidence(fixture);
    const current = await recoveryReviewJob({
      store: fixture.store,
      goalRunId: fixture.goalRun.id,
      taskId: fixture.task.id,
      contractDigest: fixture.contract.contractDigest
    });
    const reviewerAgentId = current.reviewerAgentId;
    const legacy = legacyRecoveryReviewJob(current);
    const record = admission({
      jobId: `goal-review-legacy-persisted-${fixture.task.id}-${reviewerAgentId}`,
      goalRunId: fixture.goalRun.id,
      jobName: "goal-review",
      entityId: `task:${fixture.task.id}:${reviewerAgentId}`,
      requestFingerprint: legacyGoalReviewAdmissionFingerprint(legacy)
    });
    await fixture.store.reserveGoalJob(record);
    await fixture.store.setGoalJobState(record.jobId, "reserved", "admitted");
    await fixture.store.setGoalJobState(record.jobId, "admitted", "running");
    await fixture.store.addReviewerVerdict({
      id: randomUUID(),
      goalRunId: fixture.goalRun.id,
      scope: legacy.scope,
      scopeId: legacy.scopeId,
      reviewerAgentId,
      reviewerAgentRevision: legacy.reviewerAgentRevision,
      modelConnectorId: legacy.modelConnectorId,
      verdict: "pass",
      summary: "Legacy Reviewer verdict was durable before restart.",
      evidenceIds: [evidenceId],
      contractDigest: fixture.contract.contractDigest,
      reviewJobId: null,
      reviewRequestFingerprint: null,
      createdAt: now
    }, {
      type: "review.recorded",
      actorType: "agent",
      actorId: reviewerAgentId,
      entityType: "review",
      entityId: randomUUID(),
      summary: "Legacy Reviewer verdict committed."
    });
    const runReview = vi.fn(async (data: GoalReviewJobData | LegacyGoalReviewJobData, jobId: string) => (
      processLegacyGoalReviewImpl({ store: fixture.store, data: data as LegacyGoalReviewJobData, jobId })
    ));
    const enqueueReview = vi.fn(async (_data: unknown, jobId: string) => ({ jobId }));

    const result = await recoverGoalJobs({
      store: fixture.store,
      startup: true,
      findJob: async () => null,
      runOrchestrate: vi.fn(async () => undefined),
      ...noOpRecoveryCallbacks(),
      runReview,
      enqueueReview
    });

    expect(result).toMatchObject({ settled: 1, fenced: 0, requeued: 0 });
    expect(runReview).toHaveBeenCalledWith(legacy, record.jobId);
    expect(enqueueReview).not.toHaveBeenCalled();
    expect(await fixture.store.getGoalJobAdmission(record.jobId)).toMatchObject({ state: "settled" });
    expect(await fixture.store.getGoalRun(fixture.goalRun.id)).toMatchObject({ state: "executing" });
  });

  it("isolates a malformed Reviewer admission and continues the recovery batch", async () => {
    const fixture = await approvedGoal();
    const malformed = admission({
      jobId: `goal-review-malformed-${fixture.goalRun.id}`,
      goalRunId: fixture.goalRun.id,
      jobName: "goal-review",
      entityId: `task:${fixture.task.id}:${randomUUID()}`,
      requestFingerprint: "v2:not-a-valid-digest"
    });
    const healthy = admission({
      jobId: `goal-orchestrate-${fixture.goalRun.id}-healthy`,
      goalRunId: fixture.goalRun.id,
      jobName: "goal-orchestrate",
      entityId: fixture.goalRun.id,
      requestFingerprint: "d".repeat(64)
    });
    await fixture.store.reserveGoalJob(malformed);
    await fixture.store.reserveGoalJob(healthy);
    const runOrchestrate = vi.fn(async () => undefined);

    const result = await recoverGoalJobs({
      store: fixture.store,
      startup: true,
      findJob: async () => null,
      runOrchestrate,
      ...noOpRecoveryCallbacks()
    });

    expect(result).toMatchObject({ checked: 2, fenced: 1, rerun: 1 });
    expect(runOrchestrate).toHaveBeenCalledWith(expect.objectContaining({ goalRunId: fixture.goalRun.id }), healthy.jobId);
    expect(await fixture.store.getGoalJobAdmission(malformed.jobId)).toMatchObject({ state: "settled" });
    expect(await fixture.store.getGoalRun(fixture.goalRun.id)).toMatchObject({ state: "paused" });
  });
});
