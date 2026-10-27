import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ActionRun, GoalPlanTask, GoalRun, GoalTaskBinding } from "@council/contracts";
import { InMemoryPlatformStore, requestFingerprint } from "@council/database";
import { createSeedSnapshot } from "@council/database/seed";
import { actionAdapterEndpointDigest, createExecutionContract, goalPlanDigest } from "@council/domain";
import type { ActionAdapter as RuntimeActionAdapter } from "@council/runtime";
import { processGoalActionRun } from "./process-goal-action-run.js";

const ownerId = "30000000-0000-4000-8000-000000000001";
const createdAt = "2026-08-27T00:00:00.000Z";

async function queuedActionFixture(deadlineAt: string) {
  const seed = createSeedSnapshot();
  seed.decisions = [];
  seed.tasks = [];
  const store = new InMemoryPlatformStore(seed);
  const meeting = seed.meetings[0]!;
  const goalRun: GoalRun = {
    id: randomUUID(),
    title: "Bounded external action",
    goal: "Execute one approved Harness action safely.",
    threadId: meeting.threadId,
    meetingId: meeting.id,
    state: "planning",
    revision: 1,
    activePlanRevision: 0,
    executionContractId: null,
    limits: {
      discussionRounds: 3,
      maxTasks: 12,
      maxConcurrentTasks: 2,
      maxAttemptsPerTask: 3,
      maxReplans: 2,
      maxDurationMinutes: 120,
      maxModelCalls: 60,
      maxActionCalls: 30
    },
    usage: { discussionRounds: 0, taskAttempts: 1, replans: 0, modelCalls: 0, actionCalls: 1 },
    deadlineAt,
    pausedFromState: null,
    terminalReason: null,
    createdBy: ownerId,
    createdAt,
    updatedAt: createdAt
  };
  await store.createGoalRun(goalRun, {
    type: "goal.created",
    actorType: "owner",
    actorId: ownerId,
    entityType: "goal",
    entityId: goalRun.id,
    summary: "Goal Run created."
  }, `goal:${goalRun.id}`);

  const decision = await store.createDecision({
    meetingId: meeting.id,
    title: "Approve bounded preview deployment",
    description: "Only the immutable staging target may be used."
  });
  const adapterId = randomUUID();
  const planTask: GoalPlanTask = {
    id: randomUUID(),
    decisionId: decision.id,
    title: "Deploy staging preview",
    description: "",
    acceptanceCriteria: "Harness verification succeeds.",
    dependencyIds: [],
    assigneeAgentId: null,
    executionMode: "action",
    allowedTools: [],
    dataScope: "Execution Contract only",
    action: {
      adapterId,
      actionKey: "deploy-preview",
      targetId: "staging",
      inputs: { branch: "feature/goal-run" },
      riskClass: "ordinary"
    }
  };
  const plan = {
    id: randomUUID(),
    goalRunId: goalRun.id,
    revision: 1,
    status: "draft" as const,
    digest: goalPlanDigest([planTask]),
    tasks: [planTask],
    createdAt
  };
  const planned = await store.saveGoalPlan(goalRun.id, {
    expectedRevision: 1,
    expectedPlanRevision: 0,
    plan,
    event: {
      type: "plan.created",
      actorType: "system",
      actorId: null,
      entityType: "plan",
      entityId: plan.id,
      summary: "Plan created."
    }
  });
  const endpoint = "http://127.0.0.1:8999/mcp";
  const contract = createExecutionContract({
    goalRunId: goalRun.id,
    planRevision: 1,
    tasks: [planTask],
    limits: goalRun.limits,
    approvedBy: ownerId,
    approvedAt: createdAt,
    actionBindings: [{
      planTaskId: planTask.id,
      adapterId,
      adapterCatalogRevision: 1,
      endpointDigest: actionAdapterEndpointDigest(endpoint),
      credentialId: null,
      credentialSecretRevision: null
    }]
  });
  const binding: GoalTaskBinding = {
    id: randomUUID(),
    goalRunId: goalRun.id,
    planRevision: 1,
    planTaskId: planTask.id,
    taskId: null,
    state: "ready",
    attemptCount: 0,
    activeJobId: null,
    lastError: null,
    createdAt,
    updatedAt: createdAt
  };
  const approved = await store.approveGoalRun(goalRun.id, {
    expectedRevision: planned.goalRun.revision,
    contract,
    bindings: [binding],
    event: {
      type: "contract.approved",
      actorType: "owner",
      actorId: ownerId,
      entityType: "goal",
      entityId: goalRun.id,
      summary: "Contract approved."
    }
  });
  await store.createActionAdapter({
    id: adapterId,
    name: `Harness ${goalRun.id}`,
    kind: "harness_pipeline",
    enabled: true,
    baseUrl: endpoint,
    credentialId: null,
    catalogRevision: 1,
    actions: [{
      key: "deploy-preview",
      displayName: "Deploy preview",
      targetIds: ["staging"],
      inputKeys: ["branch"],
      riskClass: "ordinary",
      timeoutMs: 10_000,
      supportsCancellation: true,
      supportsCompensation: true
    }],
    createdAt,
    updatedAt: createdAt
  });
  const actionRun: ActionRun = {
    id: randomUUID(),
    goalRunId: goalRun.id,
    planTaskId: planTask.id,
    adapterId,
    adapterCatalogRevision: 1,
    actionKey: "deploy-preview",
    targetId: "staging",
    inputs: { branch: "feature/goal-run" },
    state: "approved",
    requestFingerprint: requestFingerprint({
      goalRunId: goalRun.id,
      planTaskId: planTask.id,
      contractDigest: contract.contractDigest,
      adapterCatalogRevision: 1,
      action: planTask.action
    }),
    contractDigest: contract.contractDigest,
    externalExecutionId: null,
    verificationSummary: null,
    lastError: null,
    createdAt,
    updatedAt: createdAt
  };
  await store.createActionRun(actionRun, {
    type: "action.state.changed",
    actorType: "owner",
    actorId: ownerId,
    entityType: "action",
    entityId: actionRun.id,
    summary: "Action approved."
  });
  const jobId = `goal-action-${actionRun.id}`;
  const persistedBinding = approved.taskBindings.find((candidate) => candidate.planTaskId === planTask.id)!;
  await store.updateGoalTaskBinding(persistedBinding.id, {
    expectedState: "ready",
    state: "running",
    activeJobId: jobId,
    attemptCount: 1,
    event: {
      type: "task.state.changed",
      actorType: "system",
      actorId: null,
      entityType: "task",
      entityId: planTask.id,
      summary: "Action job queued."
    }
  });
  await store.reserveGoalJob({
    jobId,
    goalRunId: goalRun.id,
    jobName: "goal-action-run",
    entityId: actionRun.id,
    requestFingerprint: `${goalRun.id}:${planTask.id}:${actionRun.id}:${contract.contractDigest}`,
    state: "reserved",
    reservedAt: createdAt,
    admittedAt: null,
    startedAt: null,
    settledAt: null,
    updatedAt: createdAt
  });

  const runtimeAdapter: RuntimeActionAdapter = {
    catalog: vi.fn(),
    preview: vi.fn(),
    execute: vi.fn(),
    verify: vi.fn(),
    status: vi.fn(),
    cancel: vi.fn(),
    compensate: vi.fn()
  };
  const createAdapter = vi.fn(async () => runtimeAdapter);
  return { store, goalRun: approved.goalRun, planTask, actionRun, contract, jobId, runtimeAdapter, createAdapter };
}

describe("Goal Action durable execution admission", () => {
  it("settles as stale when Owner cancellation wins before preview admission", async () => {
    const fixture = await queuedActionFixture("2027-08-27T00:00:00.000Z");
    const admit = fixture.store.admitGoalActionExecution.bind(fixture.store);
    vi.spyOn(fixture.store, "admitGoalActionExecution").mockImplementation(async (...args) => {
      const current = (await fixture.store.getGoalRun(fixture.goalRun.id))!;
      await fixture.store.setGoalRunState(fixture.goalRun.id, {
        expectedRevision: current.revision,
        state: "cancelled",
        pausedFromState: null,
        terminalReason: "cancelled_by_owner",
        event: {
          type: "goal.state.changed",
          actorType: "owner",
          actorId: ownerId,
          entityType: "goal",
          entityId: fixture.goalRun.id,
          summary: "Owner cancelled before preview admission."
        }
      });
      return admit(...args);
    });

    await expect(processGoalActionRun({
      store: fixture.store,
      jobId: fixture.jobId,
      data: {
        goalRunId: fixture.goalRun.id,
        planTaskId: fixture.planTask.id,
        actionRunId: fixture.actionRun.id,
        contractDigest: fixture.contract.contractDigest,
        requestedBy: "system"
      },
      createAdapter: fixture.createAdapter
    })).resolves.toBe("stale");

    expect(fixture.runtimeAdapter.preview).not.toHaveBeenCalled();
    expect(fixture.runtimeAdapter.execute).not.toHaveBeenCalled();
    const detail = (await fixture.store.getGoalRunDetail(fixture.goalRun.id))!;
    expect(detail.goalRun).toMatchObject({ state: "cancelled", terminalReason: "cancelled_by_owner" });
    expect(detail.actionRuns[0]).toMatchObject({ state: "cancelled" });
    expect(detail.taskBindings.find((binding) => binding.planTaskId === fixture.planTask.id)).toMatchObject({
      state: "cancelled",
      activeJobId: null
    });
    expect(await fixture.store.getGoalJobAdmission(fixture.jobId)).toMatchObject({ state: "settled" });
    expect(detail.events.filter((event) => event.type === "goal.state.changed").at(-1)?.summary)
      .toBe("Owner cancelled before preview admission.");
  });

  it("settles as stale when Owner cancellation wins after preview but before execute admission", async () => {
    const fixture = await queuedActionFixture("2027-08-27T00:00:00.000Z");
    const admit = fixture.store.admitGoalActionExecution.bind(fixture.store);
    let admissionCount = 0;
    vi.spyOn(fixture.store, "admitGoalActionExecution").mockImplementation(async (...args) => {
      admissionCount += 1;
      if (admissionCount === 2) {
        const current = (await fixture.store.getGoalRun(fixture.goalRun.id))!;
        await fixture.store.setGoalRunState(fixture.goalRun.id, {
          expectedRevision: current.revision,
          state: "cancelled",
          pausedFromState: null,
          terminalReason: "cancelled_by_owner",
          event: {
            type: "goal.state.changed",
            actorType: "owner",
            actorId: ownerId,
            entityType: "goal",
            entityId: fixture.goalRun.id,
            summary: "Owner cancelled before execute admission."
          }
        });
      }
      return admit(...args);
    });

    await expect(processGoalActionRun({
      store: fixture.store,
      jobId: fixture.jobId,
      data: {
        goalRunId: fixture.goalRun.id,
        planTaskId: fixture.planTask.id,
        actionRunId: fixture.actionRun.id,
        contractDigest: fixture.contract.contractDigest,
        requestedBy: "system"
      },
      createAdapter: fixture.createAdapter
    })).resolves.toBe("stale");

    expect(fixture.runtimeAdapter.preview).toHaveBeenCalledTimes(1);
    expect(fixture.runtimeAdapter.execute).not.toHaveBeenCalled();
    const detail = (await fixture.store.getGoalRunDetail(fixture.goalRun.id))!;
    expect(detail.goalRun).toMatchObject({ state: "cancelled", terminalReason: "cancelled_by_owner" });
    expect(detail.actionRuns[0]).toMatchObject({ state: "cancelled" });
    expect(detail.taskBindings.find((binding) => binding.planTaskId === fixture.planTask.id)).toMatchObject({
      state: "cancelled",
      activeJobId: null
    });
    expect(await fixture.store.getGoalJobAdmission(fixture.jobId)).toMatchObject({ state: "settled" });
    expect(detail.events.filter((event) => event.type === "goal.state.changed").at(-1)?.summary)
      .toBe("Owner cancelled before execute admission.");
  });

  it("does not invoke the Adapter when Owner pause commits before queued job pickup", async () => {
    const fixture = await queuedActionFixture("2027-08-27T00:00:00.000Z");
    await fixture.store.setGoalRunState(fixture.goalRun.id, {
      expectedRevision: fixture.goalRun.revision,
      state: "paused",
      pausedFromState: "executing",
      event: {
        type: "goal.state.changed",
        actorType: "owner",
        actorId: ownerId,
        entityType: "goal",
        entityId: fixture.goalRun.id,
        summary: "Owner paused before pickup."
      }
    });

    await expect(processGoalActionRun({
      store: fixture.store,
      jobId: fixture.jobId,
      data: {
        goalRunId: fixture.goalRun.id,
        planTaskId: fixture.planTask.id,
        actionRunId: fixture.actionRun.id,
        contractDigest: fixture.contract.contractDigest,
        requestedBy: "system"
      },
      createAdapter: fixture.createAdapter
    })).resolves.toBe("paused");

    expect(fixture.createAdapter).not.toHaveBeenCalled();
    expect(fixture.runtimeAdapter.preview).not.toHaveBeenCalled();
    expect(fixture.runtimeAdapter.execute).not.toHaveBeenCalled();
    const detail = await fixture.store.getGoalRunDetail(fixture.goalRun.id);
    expect(detail?.actionRuns[0]).toMatchObject({ state: "cancelled" });
    expect(detail?.taskBindings.find((binding) => binding.planTaskId === fixture.planTask.id)).toMatchObject({
      state: "failed",
      activeJobId: null
    });
  });

  it("keeps Action admission recoverable when terminal cleanup cannot be persisted", async () => {
    const fixture = await queuedActionFixture("2027-08-27T00:00:00.000Z");
    await fixture.store.setGoalRunState(fixture.goalRun.id, {
      expectedRevision: fixture.goalRun.revision,
      state: "paused",
      pausedFromState: "executing",
      event: {
        type: "goal.state.changed",
        actorType: "owner",
        actorId: ownerId,
        entityType: "goal",
        entityId: fixture.goalRun.id,
        summary: "Owner paused before pickup."
      }
    });
    vi.spyOn(fixture.store, "updateActionRun").mockRejectedValueOnce(new Error("Action cleanup store unavailable"));

    await expect(processGoalActionRun({
      store: fixture.store,
      jobId: fixture.jobId,
      data: {
        goalRunId: fixture.goalRun.id,
        planTaskId: fixture.planTask.id,
        actionRunId: fixture.actionRun.id,
        contractDigest: fixture.contract.contractDigest,
        requestedBy: "system"
      },
      createAdapter: fixture.createAdapter
    })).rejects.toThrow("Action cleanup store unavailable");

    expect((await fixture.store.getRecoverableGoalJobs()).find((candidate) => candidate.jobId === fixture.jobId))
      .toMatchObject({ state: "running" });
    expect((await fixture.store.getGoalRunDetail(fixture.goalRun.id))?.taskBindings
      .find((binding) => binding.planTaskId === fixture.planTask.id)).toMatchObject({
        state: "running",
        activeJobId: fixture.jobId
      });
  });

  it("does not invoke the Adapter when the deadline expires before queued job pickup", async () => {
    const fixture = await queuedActionFixture("2026-08-26T23:59:59.000Z");

    await expect(processGoalActionRun({
      store: fixture.store,
      jobId: fixture.jobId,
      data: {
        goalRunId: fixture.goalRun.id,
        planTaskId: fixture.planTask.id,
        actionRunId: fixture.actionRun.id,
        contractDigest: fixture.contract.contractDigest,
        requestedBy: "system"
      },
      createAdapter: fixture.createAdapter
    })).resolves.toBe("paused");

    expect(fixture.createAdapter).not.toHaveBeenCalled();
    expect(fixture.runtimeAdapter.preview).not.toHaveBeenCalled();
    expect(fixture.runtimeAdapter.execute).not.toHaveBeenCalled();
    expect(await fixture.store.getGoalRun(fixture.goalRun.id)).toMatchObject({ state: "paused" });
    const detail = await fixture.store.getGoalRunDetail(fixture.goalRun.id);
    expect(detail?.actionRuns[0]).toMatchObject({ state: "expired" });
    expect(detail?.taskBindings.find((binding) => binding.planTaskId === fixture.planTask.id)).toMatchObject({
      state: "failed",
      activeJobId: null
    });
  });
});
