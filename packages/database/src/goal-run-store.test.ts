import { describe, expect, it } from "vitest";
import { goalExecutionLimitsSchema, type ActionRun, type GoalPlanTask, type GoalReviewJobData, type GoalRun, type GoalTaskBinding } from "@council/contracts";
import { createExecutionContract, goalPlanDigest } from "@council/domain";
import { InMemoryPlatformStore } from "./memory-store.js";
import { goalReviewRequestFingerprint, requestFingerprint, roleExecutionSnapshotDigest } from "./store.js";

const ownerId = "30000000-0000-4000-8000-000000000001";

function task(id: string, decisionId: string): GoalPlanTask {
  return {
    id,
    decisionId,
    title: "Prepare result",
    description: "",
    acceptanceCriteria: "Evidence is attached.",
    dependencyIds: [],
    assigneeAgentId: null,
    executionMode: "manual",
    allowedTools: [],
    dataScope: "meeting",
    action: null
  };
}

describe("In-memory Goal Run store", () => {
  it("pins Planner provenance to immutable Meeting role history across role switches", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const meeting = snapshot.meetings[0]!;
    const planner = snapshot.participants.find((participant) => (
      participant.meetingId === meeting.id && participant.roleSnapshot.orchestrationFunctions.includes("planner")
    ))!;
    const plannerHistory = planner.roleHistory.find((entry) => entry.revision === planner.roleRevision)!;
    const nonPlannerRole = snapshot.roles.find((role) => !role.orchestrationFunctions?.includes("planner"))!;
    const now = "2026-08-27T00:00:00.000Z";
    const goalRun: GoalRun = {
      id: crypto.randomUUID(), title: "Planner provenance", goal: "Retain verifiable Planner authority.",
      threadId: meeting.threadId, meetingId: meeting.id, state: "planning", revision: 1, activePlanRevision: 0, executionContractId: null,
      limits: goalExecutionLimitsSchema.parse({}), usage: { discussionRounds: 0, taskAttempts: 0, replans: 0, modelCalls: 0, actionCalls: 0 },
      deadlineAt: "2026-08-27T02:00:00.000Z", pausedFromState: null, terminalReason: null, createdBy: ownerId, createdAt: now, updatedAt: now
    };
    await store.createGoalRun(goalRun, {
      type: "goal.created", actorType: "owner", actorId: ownerId, entityType: "goal", entityId: goalRun.id, summary: "Goal Run created."
    }, `goal-planner-provenance-${goalRun.id}`);
    const decision = await store.createDecision({
      meetingId: meeting.id, title: "Verify Planner", description: "Preserve Planner role authority."
    });
    const planTask = task(crypto.randomUUID(), decision.id);
    const plannerProvenance = {
      plannerParticipantId: planner.id,
      plannerAgentId: planner.agentId,
      plannerAgentRevision: planner.agentRevision!,
      plannerModelConnectorId: crypto.randomUUID(),
      plannerRoleId: plannerHistory.roleId,
      plannerRoleRevision: plannerHistory.revision,
      plannerRoleSnapshotDigest: roleExecutionSnapshotDigest(plannerHistory.roleSnapshot)
    };
    const plan = {
      id: crypto.randomUUID(), goalRunId: goalRun.id, revision: 1, status: "draft" as const,
      digest: goalPlanDigest([planTask]), tasks: [planTask], plannerProvenance, createdAt: now
    };
    await expect(store.saveGoalPlan(goalRun.id, {
      expectedRevision: 1, expectedPlanRevision: 0,
      plan: { ...plan, plannerProvenance: { ...plannerProvenance, plannerRoleSnapshotDigest: "0".repeat(64) } },
      event: { type: "plan.created", actorType: "agent", actorId: planner.agentId, entityType: "plan", entityId: plan.id, summary: "Invalid Planner Plan." }
    })).rejects.toThrow(/Planner provenance/i);
    const planned = await store.saveGoalPlan(goalRun.id, {
      expectedRevision: 1, expectedPlanRevision: 0, plan,
      event: { type: "plan.created", actorType: "agent", actorId: planner.agentId, entityType: "plan", entityId: plan.id, summary: "Planner Plan created." }
    });
    await store.switchParticipantRole(meeting.id, planner.id, {
      expectedRoleRevision: planner.roleRevision,
      roleId: nonPlannerRole.id,
      reason: "Planner role is no longer assigned."
    });
    const ownerRevision = {
      ...plan,
      id: crypto.randomUUID(),
      revision: 2,
      plannerProvenance,
      createdAt: "2026-08-27T00:01:00.000Z"
    };
    const ownerRevised = await store.saveGoalPlan(goalRun.id, {
      expectedRevision: planned.goalRun.revision, expectedPlanRevision: 1, plan: ownerRevision,
      event: { type: "plan.revised", actorType: "owner", actorId: ownerId, entityType: "plan", entityId: ownerRevision.id, summary: "Owner revision preserves Planner provenance." }
    });
    expect(ownerRevised.plans.at(-1)).toMatchObject({ plannerProvenance });

    const switchedPlanner = (await store.getSnapshot()).participants.find((participant) => participant.id === planner.id)!;
    const currentHistory = switchedPlanner.roleHistory.find((entry) => entry.revision === switchedPlanner.roleRevision)!;
    await expect(store.saveGoalPlan(goalRun.id, {
      expectedRevision: 3, expectedPlanRevision: 2,
      plan: {
        ...ownerRevision,
        id: crypto.randomUUID(),
        revision: 3,
        plannerProvenance: {
          ...plannerProvenance,
          plannerRoleId: currentHistory.roleId,
          plannerRoleRevision: currentHistory.revision,
          plannerRoleSnapshotDigest: roleExecutionSnapshotDigest(currentHistory.roleSnapshot)
        },
        createdAt: "2026-08-27T00:02:00.000Z"
      },
      event: { type: "plan.revised", actorType: "agent", actorId: planner.agentId, entityType: "plan", entityId: crypto.randomUUID(), summary: "Non-Planner revision." }
    })).rejects.toThrow(/Planner capability/i);
  });

  it("persists a plan, one-time contract, task bindings, and replayable events", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const meeting = snapshot.meetings[0]!;
    const now = "2026-08-27T00:00:00.000Z";
    const goalRun: GoalRun = {
      id: crypto.randomUUID(),
      title: "Verified delivery",
      goal: "Produce and verify the requested delivery.",
      threadId: meeting.threadId,
      meetingId: meeting.id,
      state: "planning",
      revision: 1,
      activePlanRevision: 0,
      executionContractId: null,
      limits: goalExecutionLimitsSchema.parse({}),
      usage: { discussionRounds: 0, taskAttempts: 0, replans: 0, modelCalls: 0, actionCalls: 0 },
      deadlineAt: "2026-08-27T02:00:00.000Z",
      pausedFromState: null,
      terminalReason: null,
      createdBy: ownerId,
      createdAt: now,
      updatedAt: now
    };
    const creationJobId = `goal-orchestrate-${goalRun.id}`;
    const creationAdmission = {
      jobId: creationJobId,
      goalRunId: goalRun.id,
      jobName: "goal-orchestrate" as const,
      entityId: goalRun.id,
      requestFingerprint: "c".repeat(64),
      state: "reserved" as const,
      reservedAt: now,
      admittedAt: null,
      startedAt: null,
      settledAt: null,
      updatedAt: now
    };
    const created = await store.createGoalRun(goalRun, {
      type: "goal.created",
      actorType: "owner",
      actorId: ownerId,
      entityType: "goal",
      entityId: goalRun.id,
      summary: "Goal Run created."
    }, "goal-create", creationAdmission);
    expect(await store.getRecoverableGoalJobs()).toEqual([
      expect.objectContaining({ jobId: creationJobId, goalRunId: goalRun.id, state: "reserved" })
    ]);
    const replay = await store.createGoalRun({
      ...goalRun,
      id: crypto.randomUUID(),
      createdAt: "2026-08-27T00:00:05.000Z",
      updatedAt: "2026-08-27T00:00:05.000Z",
      deadlineAt: "2026-08-27T02:00:05.000Z"
    }, {
      type: "goal.created",
      actorType: "owner",
      actorId: ownerId,
      entityType: "goal",
      entityId: "retry-generated-id",
      summary: "Goal Run created."
    }, "goal-create");
    expect(replay.id).toBe(created.id);

    const decision = await store.createDecision({
      meetingId: meeting.id,
      title: "Prepare result",
      description: "Approve the canonical result Task."
    });
    const planTask = task(crypto.randomUUID(), decision.id);
    const plan = {
      id: crypto.randomUUID(),
      goalRunId: goalRun.id,
      revision: 1,
      status: "draft" as const,
      digest: goalPlanDigest([planTask]),
      tasks: [planTask],
      createdAt: now
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
    expect(planned.goalRun.state).toBe("awaiting_approval");

    const contract = createExecutionContract({
      goalRunId: goalRun.id,
      planRevision: 1,
      tasks: [planTask],
      limits: goalRun.limits,
      approvedBy: ownerId,
      approvedAt: now
    });
    const binding: GoalTaskBinding = {
      id: crypto.randomUUID(),
      goalRunId: goalRun.id,
      planRevision: 1,
      planTaskId: planTask.id,
      taskId: null,
      state: "ready",
      attemptCount: 0,
      activeJobId: null,
      lastError: null,
      createdAt: now,
      updatedAt: now
    };
    const approvalJobId = `goal-orchestrate-${goalRun.id}-approval`;
    const approvalAdmission = {
      jobId: approvalJobId,
      goalRunId: goalRun.id,
      jobName: "goal-orchestrate" as const,
      entityId: goalRun.id,
      requestFingerprint: "a".repeat(64),
      state: "reserved" as const,
      reservedAt: now,
      admittedAt: null,
      startedAt: null,
      settledAt: null,
      updatedAt: now
    };
    const approved = await store.approveGoalRun(goalRun.id, {
      expectedRevision: 2,
      contract,
      bindings: [binding],
      orchestrationAdmission: approvalAdmission,
      event: {
        type: "contract.approved",
        actorType: "owner",
        actorId: ownerId,
        entityType: "goal",
        entityId: goalRun.id,
        summary: "Execution Contract approved."
      }
    });
    expect(approved.goalRun.state).toBe("executing");
    expect(approved.executionContract?.contractDigest).toBe(contract.contractDigest);
    await expect(store.getGoalJobAdmission(approvalJobId)).resolves.toMatchObject({
      goalRunId: goalRun.id,
      entityId: goalRun.id,
      state: "reserved"
    });
    expect((await store.getGoalEvents(goalRun.id, 1)).map((event) => event.type)).toEqual([
      "plan.created",
      "task.bound",
      "contract.approved"
    ]);

    await expect(store.approveGoalRun(goalRun.id, {
      expectedRevision: 3,
      contract,
      bindings: [binding],
      event: {
        type: "contract.approved",
        actorType: "owner",
        actorId: ownerId,
        entityType: "goal",
        entityId: goalRun.id,
        summary: "Duplicate approval."
      }
    })).rejects.toThrow(/one-time approval/);

    const paused = await store.setGoalRunState(goalRun.id, {
      expectedRevision: 3,
      state: "paused",
      pausedFromState: "executing",
      event: {
        type: "goal.state.changed",
        actorType: "owner",
        actorId: ownerId,
        entityType: "goal",
        entityId: goalRun.id,
        summary: "Paused before revising the approved Plan."
      }
    });
    const revisedDecision = await store.createDecision({
      meetingId: meeting.id,
      title: "Prepare revised result",
      description: "Approve the revised canonical result Task."
    });
    const revisedTask = task(crypto.randomUUID(), revisedDecision.id);
    revisedTask.title = "Prepare revised result";
    const revisedPlan = {
      ...plan,
      id: crypto.randomUUID(),
      revision: 2,
      digest: goalPlanDigest([revisedTask]),
      tasks: [revisedTask]
    };
    const revised = await store.saveGoalPlan(goalRun.id, {
      expectedRevision: paused.revision,
      expectedPlanRevision: 1,
      plan: revisedPlan,
      event: {
        type: "plan.revised",
        actorType: "owner",
        actorId: ownerId,
        entityType: "plan",
        entityId: revisedPlan.id,
        summary: "Revised Plan requires a new approval."
      }
    });
    expect(revised.goalRun).toMatchObject({ state: "awaiting_approval", activePlanRevision: 2, executionContractId: null });
    expect(revised.executionContract).toBeNull();

    const revisedContract = createExecutionContract({
      goalRunId: goalRun.id,
      planRevision: 2,
      tasks: [revisedTask],
      limits: goalRun.limits,
      approvedBy: ownerId,
      approvedAt: "2026-08-27T00:10:00.000Z"
    });
    const revisedBinding = {
      ...binding,
      id: crypto.randomUUID(),
      planRevision: 2,
      planTaskId: revisedTask.id,
      taskId: null,
      createdAt: "2026-08-27T00:10:00.000Z",
      updatedAt: "2026-08-27T00:10:00.000Z"
    };
    const reapproved = await store.approveGoalRun(goalRun.id, {
      expectedRevision: revised.goalRun.revision,
      contract: revisedContract,
      bindings: [revisedBinding],
      event: {
        type: "contract.approved",
        actorType: "owner",
        actorId: ownerId,
        entityType: "goal",
        entityId: goalRun.id,
        summary: "Revised Execution Contract approved."
      }
    });
    expect(reapproved.goalRun).toMatchObject({ state: "executing", activePlanRevision: 2, executionContractId: revisedContract.id });

    const reviewerAgentId = crypto.randomUUID();
    const reviewerModelConnectorId = crypto.randomUUID();
    const verdict = {
      id: crypto.randomUUID(),
      goalRunId: goalRun.id,
      scope: "goal" as const,
      scopeId: goalRun.id,
      reviewerAgentId,
      reviewerAgentRevision: 1,
      modelConnectorId: reviewerModelConnectorId,
      verdict: "pass" as const,
      summary: "The first contract was reviewed independently.",
      evidenceIds: [meeting.id],
      contractDigest: contract.contractDigest,
      reviewJobId: null,
      reviewRequestFingerprint: null,
      createdAt: now
    };
    await store.addReviewerVerdict(verdict, {
      type: "review.recorded", actorType: "agent", actorId: reviewerAgentId,
      entityType: "review", entityId: verdict.id, summary: "First contract reviewed."
    });
    await expect(store.addReviewerVerdict({
      ...verdict,
      id: crypto.randomUUID(),
      contractDigest: revisedContract.contractDigest,
      summary: "The revised contract was reviewed independently.",
      createdAt: "2026-08-27T00:11:00.000Z"
    }, {
      type: "review.recorded", actorType: "agent", actorId: reviewerAgentId,
      entityType: "review", entityId: crypto.randomUUID(), summary: "Revised contract reviewed."
    })).resolves.toMatchObject({ contractDigest: revisedContract.contractDigest });
    expect((await store.getGoalRunDetail(goalRun.id))?.reviewerVerdicts).toHaveLength(2);

    const activeBinding = (await store.getGoalRunDetail(goalRun.id))!.taskBindings.find((candidate) => (
      candidate.planRevision === revisedPlan.revision
    ))!;
    await store.updateGoalTaskBinding(activeBinding.id, {
      expectedState: "ready",
      state: "reviewing",
      activeJobId: `goal-review-${activeBinding.id}`,
      event: {
        type: "task.state.changed",
        actorType: "system",
        actorId: null,
        entityType: "task",
        entityId: revisedTask.id,
        summary: "Task entered review."
      }
    });
    const cancellableAction: ActionRun = {
      id: crypto.randomUUID(),
      goalRunId: goalRun.id,
      planTaskId: revisedTask.id,
      adapterId: crypto.randomUUID(),
      adapterCatalogRevision: 1,
      actionKey: "preview",
      targetId: "test-target",
      inputs: {},
      state: "approved",
      requestFingerprint: "a".repeat(64),
      contractDigest: revisedContract.contractDigest,
      externalExecutionId: null,
      verificationSummary: null,
      lastError: null,
      createdAt: now,
      updatedAt: now
    };
    const actionRuns = store as unknown as { actionRuns: Map<string, ActionRun> };
    actionRuns.actionRuns.set(cancellableAction.id, cancellableAction);
    const beforeCancellation = (await store.getGoalRunDetail(goalRun.id))!;
    const cancellationInput = {
      expectedRevision: beforeCancellation.goalRun.revision,
      state: "cancelled" as const,
      pausedFromState: null,
      terminalReason: "cancelled_by_owner",
      event: {
        type: "goal.state.changed" as const,
        actorType: "owner" as const,
        actorId: ownerId,
        entityType: "goal" as const,
        entityId: goalRun.id,
        summary: "Goal Run cancelled by Owner."
      }
    };
    const unresolvedAction: ActionRun = {
      ...cancellableAction,
      id: crypto.randomUUID(),
      planTaskId: crypto.randomUUID(),
      state: "outcome_unknown",
      requestFingerprint: "b".repeat(64)
    };
    actionRuns.actionRuns.set(unresolvedAction.id, unresolvedAction);
    await expect(store.setGoalRunState(goalRun.id, cancellationInput)).rejects.toMatchObject({
      apiCode: "GOAL_ACTION_RECONCILIATION_REQUIRED"
    });
    expect((await store.getGoalRunDetail(goalRun.id))?.taskBindings.find((candidate) => candidate.id === activeBinding.id)).toMatchObject({
      state: "reviewing",
      activeJobId: `goal-review-${activeBinding.id}`
    });
    actionRuns.actionRuns.delete(unresolvedAction.id);

    const cancelled = await store.setGoalRunState(goalRun.id, cancellationInput);
    expect(cancelled).toMatchObject({ state: "cancelled", terminalReason: "cancelled_by_owner" });
    const cancelledDetail = (await store.getGoalRunDetail(goalRun.id))!;
    expect(cancelledDetail.taskBindings.find((candidate) => candidate.id === activeBinding.id)).toMatchObject({
      state: "cancelled",
      activeJobId: null
    });
    expect(cancelledDetail.actionRuns.find((candidate) => candidate.id === cancellableAction.id)).toMatchObject({
      state: "cancelled"
    });
    expect(cancelledDetail.events.slice(-3).map((event) => event.type)).toEqual([
      "task.state.changed",
      "action.state.changed",
      "goal.state.changed"
    ]);
    expect(cancelledDetail.events.at(-3)?.detail).toMatchObject({
      fromState: "reviewing",
      toState: "cancelled",
      reason: "goal_cancelled"
    });
    expect(cancelledDetail.events.at(-2)?.detail).toMatchObject({
      fromState: "approved",
      toState: "cancelled",
      reason: "goal_cancelled"
    });
  });

  it("rejects an Action execution contract without its immutable Adapter binding", async () => {
    const store = new InMemoryPlatformStore();
    const meeting = (await store.getSnapshot()).meetings[0]!;
    const now = "2026-08-27T00:00:00.000Z";
    const goalRun: GoalRun = {
      id: crypto.randomUUID(), title: "Bound Action contract", goal: "Reject incomplete external Action contracts.",
      threadId: meeting.threadId, meetingId: meeting.id, state: "planning", revision: 1, activePlanRevision: 0, executionContractId: null,
      limits: goalExecutionLimitsSchema.parse({}), usage: { discussionRounds: 0, taskAttempts: 0, replans: 0, modelCalls: 0, actionCalls: 0 },
      deadlineAt: "2026-08-27T02:00:00.000Z", pausedFromState: null, terminalReason: null, createdBy: ownerId, createdAt: now, updatedAt: now
    };
    await store.createGoalRun(goalRun, { type: "goal.created", actorType: "owner", actorId: ownerId, entityType: "goal", entityId: goalRun.id, summary: "Goal Run created." }, `goal-action-binding-${goalRun.id}`);
    const decision = await store.createDecision({ meetingId: meeting.id, title: "Run external Action", description: "This requires a pinned Adapter." });
    const actionTask = {
      ...task(crypto.randomUUID(), decision.id), executionMode: "action" as const,
      action: { adapterId: crypto.randomUUID(), actionKey: "deploy-preview", targetId: "pipeline-preview", inputs: {}, riskClass: "ordinary" as const }
    };
    const plan = { id: crypto.randomUUID(), goalRunId: goalRun.id, revision: 1, status: "draft" as const, digest: goalPlanDigest([actionTask]), tasks: [actionTask], createdAt: now };
    const planned = await store.saveGoalPlan(goalRun.id, {
      expectedRevision: 1, expectedPlanRevision: 0, plan,
      event: { type: "plan.created", actorType: "system", actorId: null, entityType: "plan", entityId: plan.id, summary: "Action Plan created." }
    });
    const contract = createExecutionContract({ goalRunId: goalRun.id, planRevision: 1, tasks: [actionTask], limits: goalRun.limits, approvedBy: ownerId, approvedAt: now });
    const binding: GoalTaskBinding = {
      id: crypto.randomUUID(), goalRunId: goalRun.id, planRevision: 1, planTaskId: actionTask.id, taskId: null,
      state: "ready", attemptCount: 0, activeJobId: null, lastError: null, createdAt: now, updatedAt: now
    };

    await expect(store.approveGoalRun(goalRun.id, {
      expectedRevision: planned.goalRun.revision, contract, bindings: [binding],
      event: { type: "contract.approved", actorType: "owner", actorId: ownerId, entityType: "goal", entityId: goalRun.id, summary: "Incomplete Action contract approved." }
    })).rejects.toThrow(/Every Action task must pin exactly one Adapter identity/);
    expect(await store.getGoalRun(goalRun.id)).toMatchObject({ state: "awaiting_approval", executionContractId: null });
  });

  it("rejects a mismatched canonical Task binding without partially approving Meeting records", async () => {
    const store = new InMemoryPlatformStore();
    const meeting = (await store.getSnapshot()).meetings[0]!;
    const now = "2026-08-27T00:00:00.000Z";
    const goalRun: GoalRun = {
      id: crypto.randomUUID(), title: "Atomic approval", goal: "Reject partial canonical mutations.",
      threadId: meeting.threadId, meetingId: meeting.id, state: "planning", revision: 1, activePlanRevision: 0, executionContractId: null,
      limits: goalExecutionLimitsSchema.parse({}), usage: { discussionRounds: 0, taskAttempts: 0, replans: 0, modelCalls: 0, actionCalls: 0 },
      deadlineAt: "2026-08-27T02:00:00.000Z", pausedFromState: null, terminalReason: null, createdBy: ownerId, createdAt: now, updatedAt: now
    };
    await store.createGoalRun(goalRun, {
      type: "goal.created", actorType: "owner", actorId: ownerId, entityType: "goal", entityId: goalRun.id, summary: "Goal Run created."
    }, `goal-atomic-approval-${goalRun.id}`);
    const decision = await store.createDecision({ meetingId: meeting.id, title: "Atomic decision", description: "No partial approval." });
    const planTask = task(crypto.randomUUID(), decision.id);
    const plan = {
      id: crypto.randomUUID(), goalRunId: goalRun.id, revision: 1, status: "draft" as const,
      digest: goalPlanDigest([planTask]), tasks: [planTask], createdAt: now
    };
    const planned = await store.saveGoalPlan(goalRun.id, {
      expectedRevision: 1, expectedPlanRevision: 0, plan,
      event: { type: "plan.created", actorType: "owner", actorId: ownerId, entityType: "plan", entityId: plan.id, summary: "Plan created." }
    });
    const contract = createExecutionContract({
      goalRunId: goalRun.id, planRevision: 1, tasks: [planTask], limits: goalRun.limits, approvedBy: ownerId, approvedAt: now
    });
    const binding: GoalTaskBinding = {
      id: crypto.randomUUID(), goalRunId: goalRun.id, planRevision: 1, planTaskId: planTask.id,
      taskId: crypto.randomUUID(), state: "ready", attemptCount: 0, activeJobId: null, lastError: null, createdAt: now, updatedAt: now
    };
    const beforeSnapshot = await store.getSnapshot();
    const beforeDetail = (await store.getGoalRunDetail(goalRun.id))!;

    await expect(store.approveGoalRun(goalRun.id, {
      expectedRevision: planned.goalRun.revision,
      contract,
      bindings: [binding],
      event: { type: "contract.approved", actorType: "owner", actorId: ownerId, entityType: "goal", entityId: goalRun.id, summary: "Invalid approval." }
    })).rejects.toThrow(/different canonical Task/);

    const afterSnapshot = await store.getSnapshot();
    const afterDetail = (await store.getGoalRunDetail(goalRun.id))!;
    expect(afterSnapshot.decisions).toEqual(beforeSnapshot.decisions);
    expect(afterSnapshot.tasks).toEqual(beforeSnapshot.tasks);
    expect(afterDetail.goalRun).toEqual(beforeDetail.goalRun);
    expect(afterDetail.plans).toEqual(beforeDetail.plans);
    expect(afterDetail.executionContract).toBeNull();
    expect(afterDetail.taskBindings).toEqual([]);
    expect(afterDetail.events).toEqual(beforeDetail.events);
  });

  it("rejects a reused Goal job ID when any immutable identity field changes", async () => {
    const store = new InMemoryPlatformStore();
    const meeting = (await store.getSnapshot()).meetings[0]!;
    const now = "2026-08-27T00:00:00.000Z";
    const goalRun: GoalRun = {
      id: crypto.randomUUID(), title: "Job identity", goal: "Keep job admissions immutable.",
      threadId: meeting.threadId, meetingId: meeting.id, state: "planning", revision: 1, activePlanRevision: 0, executionContractId: null,
      limits: goalExecutionLimitsSchema.parse({}), usage: { discussionRounds: 0, taskAttempts: 0, replans: 0, modelCalls: 0, actionCalls: 0 },
      deadlineAt: "2026-08-27T02:00:00.000Z", pausedFromState: null, terminalReason: null, createdBy: ownerId, createdAt: now, updatedAt: now
    };
    await store.createGoalRun(goalRun, {
      type: "goal.created", actorType: "owner", actorId: ownerId, entityType: "goal", entityId: goalRun.id, summary: "Goal Run created."
    }, `goal-job-identity-${goalRun.id}`);
    const admission = {
      jobId: `goal-job-${goalRun.id}`, goalRunId: goalRun.id, jobName: "goal-orchestrate" as const,
      entityId: goalRun.id, requestFingerprint: "d".repeat(64), state: "reserved" as const,
      reservedAt: now, admittedAt: null, startedAt: null, settledAt: null, updatedAt: now
    };
    await store.reserveGoalJob(admission);
    await expect(store.getGoalJobAdmission(admission.jobId)).resolves.toEqual({
      ...admission,
      dispatchToken: null,
      dispatchLeaseExpiresAt: null
    });
    await expect(store.getGoalJobAdmission("missing-goal-job")).resolves.toBeNull();

    await expect(store.reserveGoalJob({
      ...admission,
      jobName: "goal-review",
      entityId: `goal:${goalRun.id}:reviewer`
    })).rejects.toThrow(/another request/);
  });

  it("stores a complete immutable Goal Review binding behind its compact admission fingerprint", async () => {
    const store = new InMemoryPlatformStore();
    const meeting = (await store.getSnapshot()).meetings[0]!;
    const now = "2026-08-27T00:00:00.000Z";
    const goalRun: GoalRun = {
      id: crypto.randomUUID(), title: "Review binding", goal: "Recover the complete reviewer job payload.",
      threadId: meeting.threadId, meetingId: meeting.id, state: "planning", revision: 1, activePlanRevision: 0, executionContractId: null,
      limits: goalExecutionLimitsSchema.parse({}), usage: { discussionRounds: 0, taskAttempts: 0, replans: 0, modelCalls: 0, actionCalls: 0 },
      deadlineAt: "2026-08-27T02:00:00.000Z", pausedFromState: null, terminalReason: null, createdBy: ownerId, createdAt: now, updatedAt: now
    };
    await store.createGoalRun(goalRun, {
      type: "goal.created", actorType: "owner", actorId: ownerId, entityType: "goal", entityId: goalRun.id, summary: "Goal Run created."
    }, `goal-review-binding-${goalRun.id}`);
    const reviewerAgentId = crypto.randomUUID();
    const data: GoalReviewJobData = {
      goalRunId: goalRun.id,
      scope: "goal",
      scopeId: goalRun.id,
      reviewerAgentId,
      reviewerAgentRevision: 1,
      reviewerParticipantId: crypto.randomUUID(),
      reviewerRoleId: crypto.randomUUID(),
      reviewerRoleRevision: 1,
      reviewerRoleSnapshotDigest: "b".repeat(64),
      modelConnectorId: crypto.randomUUID(),
      modelConnectorBinding: {
        id: crypto.randomUUID(), revision: 1, location: "cloud",
        baseUrl: `https://review.example.test/${"a".repeat(1_900)}`,
        model: "m".repeat(500), credentialId: crypto.randomUUID(), secretRevision: 7
      },
      credentialBinding: { credentialId: crypto.randomUUID(), secretRevision: 7, provider: "review-provider", location: "cloud" },
      contractDigest: "a".repeat(64),
      requestedBy: "system"
    };
    data.modelConnectorId = data.modelConnectorBinding.id;
    data.credentialBinding!.credentialId = data.modelConnectorBinding.credentialId!;
    const fingerprint = goalReviewRequestFingerprint(data);
    expect(fingerprint).toBe(`v2:${requestFingerprint(data)}`);
    expect(fingerprint).toHaveLength(67);
    const admission = {
      jobId: `goal-review-${goalRun.id}`,
      goalRunId: goalRun.id,
      jobName: "goal-review" as const,
      entityId: `goal:${goalRun.id}:${reviewerAgentId}`,
      requestFingerprint: fingerprint,
      state: "reserved" as const,
      reservedAt: now,
      admittedAt: null,
      startedAt: null,
      settledAt: null,
      updatedAt: now
    };
    await expect(store.reserveGoalReviewJob(admission, data)).resolves.toMatchObject(admission);
    await expect(store.reserveGoalReviewJob(admission, data)).resolves.toMatchObject(admission);
    const recovered = await store.getGoalReviewJobData(admission.jobId);
    expect(recovered).toEqual(data);
    await store.setGoalJobState(admission.jobId, "reserved", "outcome_unknown");
    await expect(store.getRecoverableGoalJobs()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: admission.jobId, jobName: "goal-review", state: "outcome_unknown" })
    ]));
    recovered!.modelConnectorBinding.model = "tampered";
    await expect(store.getGoalReviewJobData(admission.jobId)).resolves.toEqual(data);
    const bindings = store as unknown as { goalReviewJobBindings: Map<string, GoalReviewJobData> };
    bindings.goalReviewJobBindings.get(admission.jobId)!.contractDigest = "b".repeat(64);
    await expect(store.getGoalReviewJobData(admission.jobId)).rejects.toThrow(/immutable binding/i);
    await expect(store.reserveGoalReviewJob({ ...admission, requestFingerprint: "v2:" + "b".repeat(64) }, data))
      .rejects.toThrow(/immutable binding/i);
  });

  it("claims and completes Goal job dispatch through a bounded recoverable lease", async () => {
    const store = new InMemoryPlatformStore();
    const meeting = (await store.getSnapshot()).meetings[0]!;
    const reservedAt = "2026-08-27T00:00:00.000Z";
    const goalRun: GoalRun = {
      id: crypto.randomUUID(), title: "Durable dispatch", goal: "Recover job dispatch after a crash.",
      threadId: meeting.threadId, meetingId: meeting.id, state: "planning", revision: 1, activePlanRevision: 0, executionContractId: null,
      limits: goalExecutionLimitsSchema.parse({}), usage: { discussionRounds: 0, taskAttempts: 0, replans: 0, modelCalls: 0, actionCalls: 0 },
      deadlineAt: "2026-08-27T02:00:00.000Z", pausedFromState: null, terminalReason: null, createdBy: ownerId, createdAt: reservedAt, updatedAt: reservedAt
    };
    await store.createGoalRun(goalRun, {
      type: "goal.created", actorType: "owner", actorId: ownerId, entityType: "goal", entityId: goalRun.id, summary: "Goal Run created."
    }, `goal-dispatch-lease-${goalRun.id}`);
    const admission = {
      jobId: `goal-job-${goalRun.id}`, goalRunId: goalRun.id, jobName: "goal-orchestrate" as const,
      entityId: goalRun.id, requestFingerprint: "e".repeat(64), state: "reserved" as const,
      reservedAt, admittedAt: null, startedAt: null, settledAt: null, updatedAt: reservedAt
    };
    await expect(store.reserveGoalJob(admission)).resolves.toMatchObject({
      ...admission,
      dispatchToken: null,
      dispatchLeaseExpiresAt: null
    });

    const [firstClaim, concurrentClaim] = await Promise.all([
      store.claimGoalJobDispatch(admission.jobId, {
        dispatchToken: "dispatcher-a",
        now: "2026-08-27T00:00:10.000Z"
      }),
      store.claimGoalJobDispatch(admission.jobId, {
        dispatchToken: "dispatcher-b",
        now: "2026-08-27T00:00:10.000Z"
      })
    ]);
    expect(firstClaim).toEqual({
      status: "claimed",
      admission: expect.objectContaining({
        state: "dispatching",
        dispatchToken: "dispatcher-a",
        dispatchLeaseExpiresAt: "2026-08-27T00:00:40.000Z",
        updatedAt: "2026-08-27T00:00:10.000Z"
      })
    });
    expect(concurrentClaim).toEqual({ status: "contended", admission: firstClaim.admission });
    await expect(store.getRecoverableGoalJobs()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: admission.jobId, state: "dispatching" })
    ]));

    await expect(store.claimGoalJobDispatch(admission.jobId, {
      dispatchToken: "dispatcher-a",
      leaseDurationMs: 60_000,
      now: "2026-08-27T00:00:20.000Z"
    })).resolves.toEqual(firstClaim);
    await expect(store.claimGoalJobDispatch(admission.jobId, {
      dispatchToken: "dispatcher-b",
      now: "2026-08-27T00:00:39.999Z"
    })).resolves.toEqual({ status: "contended", admission: firstClaim.admission });

    const reclaimed = await store.claimGoalJobDispatch(admission.jobId, {
      dispatchToken: "dispatcher-b",
      leaseDurationMs: 1_000,
      now: "2026-08-27T00:00:40.000Z"
    });
    expect(reclaimed).toEqual({
      status: "claimed",
      admission: expect.objectContaining({
        state: "dispatching",
        dispatchToken: "dispatcher-b",
        dispatchLeaseExpiresAt: "2026-08-27T00:00:41.000Z",
        updatedAt: "2026-08-27T00:00:40.000Z"
      })
    });
    await expect(store.setGoalJobState(admission.jobId, "dispatching", "admitted"))
      .rejects.toThrow(/dispatch lease/i);
    await expect(store.completeGoalJobDispatch(admission.jobId, "dispatcher-a"))
      .rejects.toThrow(/dispatch token/i);

    const completed = await store.completeGoalJobDispatch(admission.jobId, "dispatcher-b");
    expect(completed).toMatchObject({
      state: "admitted",
      admittedAt: expect.any(String),
      dispatchToken: null,
      dispatchLeaseExpiresAt: null
    });
    await expect(store.completeGoalJobDispatch(admission.jobId, "dispatcher-b")).resolves.toEqual(completed);
    await expect(store.claimGoalJobDispatch(admission.jobId, { dispatchToken: "dispatcher-c" }))
      .resolves.toEqual({ status: "already_dispatched", admission: completed });
    await expect(store.setGoalJobState(admission.jobId, "admitted", "dispatching"))
      .rejects.toThrow(/dispatch lease/i);
    const running = await store.setGoalJobState(admission.jobId, "admitted", "running");
    await expect(store.claimGoalJobDispatch(admission.jobId, { dispatchToken: "dispatcher-c" }))
      .resolves.toEqual({ status: "already_dispatched", admission: running });
    await expect(store.completeGoalJobDispatch(admission.jobId, "dispatcher-c")).resolves.toEqual(running);
    const settled = await store.setGoalJobState(admission.jobId, "running", "settled");
    await expect(store.claimGoalJobDispatch(admission.jobId, { dispatchToken: "dispatcher-c" }))
      .resolves.toEqual({ status: "already_dispatched", admission: settled });
    await expect(store.completeGoalJobDispatch(admission.jobId, "dispatcher-c")).resolves.toEqual(settled);

    for (const invalidInput of [
      { dispatchToken: "" },
      { dispatchToken: " dispatcher-c" },
      { dispatchToken: "x".repeat(201) },
      { dispatchToken: "dispatcher-c", leaseDurationMs: 999 },
      { dispatchToken: "dispatcher-c", leaseDurationMs: 60_001 },
      { dispatchToken: "dispatcher-c", now: "not-a-date" }
    ]) {
      await expect(store.claimGoalJobDispatch(admission.jobId, invalidInput)).rejects.toThrow();
    }
  });

  it("fails closed when a reserved or outcome-unknown Goal job cannot be completed safely", async () => {
    const store = new InMemoryPlatformStore();
    const meeting = (await store.getSnapshot()).meetings[0]!;
    const now = "2026-08-27T00:00:00.000Z";
    const goalRun: GoalRun = {
      id: crypto.randomUUID(), title: "Dispatch fencing", goal: "Do not duplicate uncertain work.",
      threadId: meeting.threadId, meetingId: meeting.id, state: "planning", revision: 1, activePlanRevision: 0, executionContractId: null,
      limits: goalExecutionLimitsSchema.parse({}), usage: { discussionRounds: 0, taskAttempts: 0, replans: 0, modelCalls: 0, actionCalls: 0 },
      deadlineAt: "2026-08-27T02:00:00.000Z", pausedFromState: null, terminalReason: null, createdBy: ownerId, createdAt: now, updatedAt: now
    };
    await store.createGoalRun(goalRun, {
      type: "goal.created", actorType: "owner", actorId: ownerId, entityType: "goal", entityId: goalRun.id, summary: "Goal Run created."
    }, `goal-dispatch-fence-${goalRun.id}`);
    const admission = {
      jobId: `goal-job-${goalRun.id}`, goalRunId: goalRun.id, jobName: "goal-orchestrate" as const,
      entityId: goalRun.id, requestFingerprint: "f".repeat(64), state: "reserved" as const,
      reservedAt: now, admittedAt: null, startedAt: null, settledAt: null, updatedAt: now
    };
    await store.reserveGoalJob(admission);
    await expect(store.completeGoalJobDispatch(admission.jobId, "dispatcher-a"))
      .rejects.toThrow(/reserved/i);
    await store.setGoalJobState(admission.jobId, "reserved", "outcome_unknown");
    await expect(store.claimGoalJobDispatch(admission.jobId, { dispatchToken: "dispatcher-a" }))
      .rejects.toThrow(/outcome is unknown/i);
    await expect(store.completeGoalJobDispatch(admission.jobId, "dispatcher-a"))
      .rejects.toThrow(/outcome is unknown/i);
  });
});
