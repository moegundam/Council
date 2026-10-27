import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ActionAdapter as PersistedActionAdapter,
  ActionRun,
  ExecutionActionBinding,
  ExecutionRuntimeBinding,
  GoalActionRunJobData,
  GoalPlannerProvenance,
  GoalReviewJobData,
  LegacyGoalReviewJobData,
  GoalPlanTask,
  GoalRun,
  GoalTaskBinding,
  TaskAgentRunJobData
} from "@council/contracts";
import { goalExecutionLimitsSchema } from "@council/contracts";
import { InMemoryPlatformStore, requestFingerprint, roleExecutionSnapshotDigest } from "@council/database";
import { createSeedSnapshot } from "@council/database/seed";
import {
  actionAdapterEndpointDigest,
  createExecutionContract,
  createExecutionRuntimeBinding,
  goalPlanDigest,
  resolveRuntimeProfileAdmission,
  SecretVault
} from "@council/domain";
import type { ActionAdapter as RuntimeActionAdapter } from "@council/runtime";
import { processGoalActionRun as processGoalActionRunImpl } from "./process-goal-action-run.js";
import { processGoalOrchestrate as processGoalOrchestrateImpl } from "./process-goal-orchestrate.js";
import { processGoalPlan as processGoalPlanImpl } from "./process-goal-plan.js";
import {
  processGoalReview as processGoalReviewImpl,
  processLegacyGoalReview as processLegacyGoalReviewImpl
} from "./process-goal-review.js";
import { processTaskAgentRun, recordTaskAgentRunFailure } from "./process-task-agent-run.js";
import { prepareGoalTaskAgent } from "./goal-task-agent-scheduler.js";
import {
  createGoalReviewBinding,
  goalReviewAdmissionFingerprint,
  legacyGoalReviewAdmissionFingerprint
} from "./goal-review-binding.js";

const ownerId = "30000000-0000-4000-8000-000000000001";
const now = "2026-08-27T00:00:00.000Z";

function createRunnableStore(): InMemoryPlatformStore {
  const seed = createSeedSnapshot();
  seed.decisions = [];
  seed.tasks = [];
  const connectorIds = [
    "51000000-0000-4000-8000-000000000001",
    "51000000-0000-4000-8000-000000000002",
    "51000000-0000-4000-8000-000000000003",
    "51000000-0000-4000-8000-000000000004"
  ];
  seed.modelConnectors = connectorIds.map((id, index) => ({
    id,
    revision: 1,
    name: `Local reviewer ${index + 1}`,
    location: "local" as const,
    baseUrl: `http://127.0.0.1:${4100 + index}/v1`,
    model: `local-model-${index + 1}`,
    enabled: true,
    hasSecret: false,
    secretRevision: 0
  }));
  const reviewerRole = seed.roles.find((role) => role.templateKey === "security_reviewer")!;
  reviewerRole.orchestrationFunctions = ["reviewer"];
  const reviewer = seed.participants.find((participant) => participant.roleId === reviewerRole.id)!;
  const extraReviewerId = "50000000-0000-4000-8000-000000000004";
  seed.agents.push({ ...structuredClone(seed.agents[0]!), id: extraReviewerId, name: "Evidence-R" });
  seed.participants.push({
    ...structuredClone(reviewer),
    id: "90000000-0000-4000-8000-000000000004",
    agentId: extraReviewerId,
    isChair: false
  });
  seed.agents.forEach((agent, index) => {
    agent.modelConnectorId = connectorIds[index]!;
    agent.status = "online";
  });
  return new InMemoryPlatformStore(seed);
}

async function createGoal(
  store?: InMemoryPlatformStore,
  limitOverrides: Partial<GoalRun["limits"]> = {}
): Promise<{ store: InMemoryPlatformStore; goalRun: GoalRun }> {
  if (!store) {
    const seed = createSeedSnapshot();
    seed.decisions = [];
    seed.tasks = [];
    store = new InMemoryPlatformStore(seed);
  }
  const meeting = (await store.getSnapshot()).meetings[0]!;
  const goalRun: GoalRun = {
    id: randomUUID(),
    title: "Produce a verified delivery",
    goal: "Produce a verified delivery through the formal Council meeting.",
    threadId: meeting.threadId,
    meetingId: meeting.id,
    state: "planning",
    revision: 1,
    activePlanRevision: 0,
    executionContractId: null,
    limits: goalExecutionLimitsSchema.parse(limitOverrides),
    usage: { discussionRounds: 0, taskAttempts: 0, replans: 0, modelCalls: 0, actionCalls: 0 },
    deadlineAt: "2027-08-27T02:00:00.000Z",
    pausedFromState: null,
    terminalReason: null,
    createdBy: ownerId,
    createdAt: now,
    updatedAt: now
  };
  await store.createGoalRun(goalRun, {
    type: "goal.created",
    actorType: "owner",
    actorId: ownerId,
    entityType: "goal",
    entityId: goalRun.id,
    summary: "Goal Run created."
  }, `goal-create:${goalRun.id}`);
  return { store, goalRun };
}

async function plannerProvenanceFor(
  store: InMemoryPlatformStore,
  goalRun: GoalRun
): Promise<GoalPlannerProvenance | undefined> {
  const snapshot = await store.getSnapshot();
  const participant = snapshot.participants.find((candidate) => (
    candidate.meetingId === goalRun.meetingId
    && candidate.roleSnapshot.orchestrationFunctions.includes("planner")
  ));
  if (!participant) return undefined;
  const agent = snapshot.agents.find((candidate) => candidate.id === participant.agentId);
  if (!agent?.publishedRevision) return undefined;
  const revision = await store.getAgentRevision(agent.id, participant.agentRevision ?? agent.publishedRevision).catch(() => null);
  if (!revision?.modelConnectorId) return undefined;
  const roleHistory = participant.roleHistory.find((entry) => entry.revision === participant.roleRevision);
  if (!roleHistory) return undefined;
  return {
    plannerParticipantId: participant.id,
    plannerAgentId: agent.id,
    plannerAgentRevision: revision.revision,
    plannerModelConnectorId: revision.modelConnectorId,
    plannerRoleId: roleHistory.roleId,
    plannerRoleRevision: roleHistory.revision,
    plannerRoleSnapshotDigest: roleExecutionSnapshotDigest(roleHistory.roleSnapshot)
  };
}

function planTask(overrides: Partial<GoalPlanTask> = {}): GoalPlanTask {
  return {
    id: randomUUID(),
    decisionId: randomUUID(),
    title: "Produce the bounded artifact",
    description: "",
    acceptanceCriteria: "Evidence is independently reviewable.",
    dependencyIds: [],
    assigneeAgentId: null,
    executionMode: "manual",
    allowedTools: [],
    dataScope: "meeting",
    action: null,
    ...overrides
  };
}

async function approveTasks(input: {
  store: InMemoryPlatformStore;
  goalRun: GoalRun;
  tasks: GoalPlanTask[];
  actionBindings?: ExecutionActionBinding[];
  runtimeBindings?: ExecutionRuntimeBinding[];
  plannerProvenance?: GoalPlannerProvenance;
  legacyPlannerProvenance?: boolean;
}) {
  for (const task of input.tasks) {
    const decision = await input.store.createDecision({
      meetingId: input.goalRun.meetingId,
      title: task.title,
      description: task.description || task.acceptanceCriteria
    });
    task.decisionId = decision.id;
  }
  const plannerProvenance = input.legacyPlannerProvenance
    ? undefined
    : input.plannerProvenance ?? await plannerProvenanceFor(input.store, input.goalRun);
  const plan = {
    id: randomUUID(),
    goalRunId: input.goalRun.id,
    revision: 1,
    status: "draft" as const,
    digest: goalPlanDigest(input.tasks),
    tasks: input.tasks,
    createdAt: now,
    ...(plannerProvenance ? { plannerProvenance } : {})
  };
  const planned = await input.store.saveGoalPlan(input.goalRun.id, {
    expectedRevision: 1,
    expectedPlanRevision: 0,
    plan,
    event: {
      type: "plan.created",
      actorType: "owner",
      actorId: ownerId,
      entityType: "plan",
      entityId: plan.id,
      summary: "Owner supplied plan revision."
    }
  });
  const contract = createExecutionContract({
    goalRunId: input.goalRun.id,
    planRevision: 1,
    tasks: input.tasks,
    limits: planned.goalRun.limits,
    approvedBy: ownerId,
    approvedAt: now,
    actionBindings: input.actionBindings ?? input.tasks.filter((task) => task.action).map((task) => ({
      planTaskId: task.id,
      adapterId: task.action!.adapterId,
      adapterCatalogRevision: 1,
      endpointDigest: actionAdapterEndpointDigest("http://127.0.0.1:8999/mcp"),
      credentialId: null,
      credentialSecretRevision: null
    })),
    runtimeBindings: input.runtimeBindings ?? []
  });
  const bindings: GoalTaskBinding[] = input.tasks.map((task) => ({
    id: randomUUID(),
    goalRunId: input.goalRun.id,
    planRevision: 1,
    planTaskId: task.id,
    taskId: null,
    state: task.dependencyIds.length === 0 ? "ready" : "waiting",
    attemptCount: 0,
    activeJobId: null,
    lastError: null,
    createdAt: now,
    updatedAt: now
  }));
  const approved = await input.store.approveGoalRun(input.goalRun.id, {
    expectedRevision: planned.goalRun.revision,
    contract,
    bindings,
    event: {
      type: "contract.approved",
      actorType: "owner",
      actorId: ownerId,
      entityType: "goal",
      entityId: input.goalRun.id,
      summary: "Owner approved immutable Execution Contract."
    }
  });
  return { plan, contract, bindings: approved.taskBindings.filter((binding) => binding.planRevision === 1), approved };
}

async function approvePlan(input: {
  store: InMemoryPlatformStore;
  goalRun: GoalRun;
  task: GoalPlanTask;
  actionBindings?: ExecutionActionBinding[];
  runtimeBindings?: ExecutionRuntimeBinding[];
  legacyPlannerProvenance?: boolean;
}) {
  const result = await approveTasks({
    store: input.store,
    goalRun: input.goalRun,
    tasks: [input.task],
    ...(input.runtimeBindings === undefined ? {} : { runtimeBindings: input.runtimeBindings }),
    ...(input.legacyPlannerProvenance === undefined
      ? {}
      : { legacyPlannerProvenance: input.legacyPlannerProvenance })
  });
  return { ...result, binding: result.bindings[0]! };
}

async function addCanonicalTaskEvidence(
  store: InMemoryPlatformStore,
  binding: GoalTaskBinding,
  label = "Canonical execution evidence"
): Promise<string> {
  if (!binding.taskId) throw new Error("Expected approved Goal Task binding to reference a canonical Task.");
  const task = await store.addTaskEvidence(binding.taskId, {
    type: "note",
    label,
    reference: "The bounded execution result is available for independent review."
  });
  return task.evidence.at(-1)!.id;
}

async function reserveGoalAdmission(input: {
  store: InMemoryPlatformStore;
  jobId: string;
  goalRunId: string;
  jobName: "goal-action-run" | "goal-orchestrate" | "goal-plan" | "goal-review";
  entityId: string;
  requestFingerprint: string;
}): Promise<void> {
  const timestamp = new Date().toISOString();
  const { store, ...admission } = input;
  await store.reserveGoalJob({
    ...admission,
    state: "reserved",
    reservedAt: timestamp,
    admittedAt: null,
    startedAt: null,
    settledAt: null,
    updatedAt: timestamp
  });
}

async function reserveGoalPlanAdmission(input: Parameters<typeof processGoalPlanImpl>[0]): Promise<void> {
  await reserveGoalAdmission({
    store: input.store as InMemoryPlatformStore,
    jobId: input.jobId,
    goalRunId: input.data.goalRunId,
    jobName: "goal-plan",
    entityId: String(input.data.expectedPlanRevision),
    requestFingerprint: `${input.data.goalRunId}:${input.data.expectedRevision}:${input.data.expectedPlanRevision}`
  });
}

async function reserveGoalOrchestrateAdmission(input: Parameters<typeof processGoalOrchestrateImpl>[0]): Promise<void> {
  await reserveGoalAdmission({
    store: input.store as InMemoryPlatformStore,
    jobId: input.jobId,
    goalRunId: input.data.goalRunId,
    jobName: "goal-orchestrate",
    entityId: input.data.goalRunId,
    requestFingerprint: input.data.requestFingerprint
  });
}

async function reserveGoalReviewAdmission(input: Parameters<typeof processGoalReviewImpl>[0]): Promise<void> {
  const store = input.store as InMemoryPlatformStore;
  const timestamp = new Date().toISOString();
  await store.reserveGoalReviewJob({
    jobId: input.jobId,
    goalRunId: input.data.goalRunId,
    jobName: "goal-review",
    entityId: `${input.data.scope}:${input.data.scopeId}:${input.data.reviewerAgentId}`,
    requestFingerprint: goalReviewAdmissionFingerprint(input.data),
    state: "reserved",
    reservedAt: timestamp,
    admittedAt: null,
    startedAt: null,
    settledAt: null,
    updatedAt: timestamp
  }, input.data);
}

async function reserveGoalActionRunAdmission(input: Parameters<typeof processGoalActionRunImpl>[0]): Promise<void> {
  await reserveGoalAdmission({
    store: input.store as InMemoryPlatformStore,
    jobId: input.jobId,
    goalRunId: input.data.goalRunId,
    jobName: "goal-action-run",
    entityId: input.data.actionRunId,
    requestFingerprint: `${input.data.goalRunId}:${input.data.planTaskId}:${input.data.actionRunId}:${input.data.contractDigest}`
  });
}

async function processGoalPlan(input: Parameters<typeof processGoalPlanImpl>[0]) {
  await reserveGoalPlanAdmission(input);
  return processGoalPlanImpl(input);
}

async function processGoalOrchestrate(input: Parameters<typeof processGoalOrchestrateImpl>[0]) {
  await reserveGoalOrchestrateAdmission(input);
  return processGoalOrchestrateImpl(input);
}

async function processGoalReview(input: Parameters<typeof processGoalReviewImpl>[0]) {
  await reserveGoalReviewAdmission(input);
  return processGoalReviewImpl(input);
}

function legacyReviewJob(data: GoalReviewJobData): LegacyGoalReviewJobData {
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

async function processLegacyGoalReview(input: Parameters<typeof processLegacyGoalReviewImpl>[0]) {
  await reserveGoalAdmission({
    store: input.store as InMemoryPlatformStore,
    jobId: input.jobId,
    goalRunId: input.data.goalRunId,
    jobName: "goal-review",
    entityId: `${input.data.scope}:${input.data.scopeId}:${input.data.reviewerAgentId}`,
    requestFingerprint: legacyGoalReviewAdmissionFingerprint(input.data)
  });
  return processLegacyGoalReviewImpl(input);
}

async function processGoalActionRun(input: Parameters<typeof processGoalActionRunImpl>[0]) {
  await reserveGoalActionRunAdmission(input);
  return processGoalActionRunImpl(input);
}

async function reviewJob(input: {
  store: InMemoryPlatformStore;
  goalRun: GoalRun;
  contractDigest: string;
  scope: GoalReviewJobData["scope"];
  scopeId: string;
}): Promise<GoalReviewJobData> {
  const detail = (await input.store.getGoalRunDetail(input.goalRun.id))!;
  const plan = detail.plans.find((candidate) => candidate.revision === detail.goalRun.activePlanRevision)!;
  const reviewer = (await input.store.getSnapshot()).participants.find((candidate) => (
    candidate.meetingId === input.goalRun.meetingId
    && candidate.roleSnapshot.orchestrationFunctions.includes("reviewer")
    && candidate.agentId !== plan.plannerProvenance?.plannerAgentId
  ));
  if (!reviewer) throw new Error("Expected an independent Reviewer participant.");
  const revision = await input.store.getAgentRevision(reviewer.agentId, reviewer.agentRevision ?? 1);
  if (!revision.modelConnectorId) throw new Error("Expected Reviewer Agent revision to bind a Model Connector.");
  const binding = createGoalReviewBinding(await input.store.getSnapshot(), revision.modelConnectorId, reviewer);
  return {
    goalRunId: input.goalRun.id,
    scope: input.scope,
    scopeId: input.scopeId,
    reviewerAgentId: reviewer.agentId,
    reviewerAgentRevision: revision.revision,
    modelConnectorId: revision.modelConnectorId,
    ...binding,
    contractDigest: input.contractDigest,
    requestedBy: "system"
  };
}

async function bindReviewerCredential(input: {
  store: InMemoryPlatformStore;
  job: GoalReviewJobData;
  vault: SecretVault;
  expiresAt?: string | null;
}) {
  const credential = await input.store.createCredential({
    name: "Reviewer credential",
    provider: "openai",
    kind: "api_key",
    location: "cloud",
    expiresAt: input.expiresAt ?? null
  }, { ciphertext: input.vault.encrypt("reviewer-secret") });
  const state = Reflect.get(input.store, "state") as ReturnType<typeof createSeedSnapshot>;
  const connector = state.modelConnectors.find((candidate) => candidate.id === input.job.modelConnectorId);
  if (!connector) throw new Error("Expected Reviewer Model Connector.");
  Object.assign(connector, {
    revision: connector.revision + 1,
    location: "cloud",
    baseUrl: "https://api.openai.test/v1",
    credentialId: credential.id,
    hasSecret: true,
    secretRevision: credential.secretRevision
  });
  return credential;
}

describe("Goal Run Worker processors", () => {
  it("rejects raw Orchestrate, Plan, Review, and Action envelopes that lack trusted durable admission", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    const orchestrateJobId = "raw-goal-orchestrate";
    const planJobId = "raw-goal-plan";

    await expect(processGoalOrchestrateImpl({
      store,
      jobId: orchestrateJobId,
      data: {
        goalRunId: goalRun.id,
        expectedRevision: goalRun.revision,
        requestFingerprint: "8".repeat(64),
        requestedBy: "system"
      }
    })).rejects.toThrow(/admission was not found/i);
    await expect(processGoalPlanImpl({
      store,
      jobId: planJobId,
      data: {
        goalRunId: goalRun.id,
        expectedRevision: goalRun.revision,
        expectedPlanRevision: goalRun.activePlanRevision,
        requestedBy: "system"
      }
    })).rejects.toThrow(/admission was not found/i);

    const task = planTask();
    const { contract } = await approvePlan({ store, goalRun, task });
    const review = await reviewJob({
      store,
      goalRun,
      contractDigest: contract.contractDigest,
      scope: "task",
      scopeId: task.id
    });
    const reviewJobId = "raw-goal-review";
    const actionJobId = "raw-goal-action";
    await expect(processGoalReviewImpl({ store, data: review, jobId: reviewJobId, complete: vi.fn() }))
      .rejects.toThrow(/admission was not found/i);
    await expect(processGoalActionRunImpl({
      store,
      jobId: actionJobId,
      data: {
        goalRunId: goalRun.id,
        planTaskId: randomUUID(),
        actionRunId: randomUUID(),
        contractDigest: contract.contractDigest,
        requestedBy: "system"
      }
    })).rejects.toThrow(/admission was not found/i);

    await expect(store.getGoalJobAdmission(orchestrateJobId)).resolves.toBeNull();
    await expect(store.getGoalJobAdmission(planJobId)).resolves.toBeNull();
    await expect(store.getGoalJobAdmission(reviewJobId)).resolves.toBeNull();
    await expect(store.getGoalJobAdmission(actionJobId)).resolves.toBeNull();
  });

  it("pins the actual Planner participant on a generated Goal Plan", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    await store.createDecision({
      meetingId: goalRun.meetingId,
      title: "Prepare a verified plan",
      description: "Create a bounded plan with attributable provenance."
    });

    await expect(processGoalPlan({
      store,
      jobId: "goal-plan-planner-provenance",
      data: { goalRunId: goalRun.id, expectedRevision: 1, expectedPlanRevision: 0, requestedBy: "system" }
    })).resolves.toBe("planned");

    const snapshot = await store.getSnapshot();
    const participant = snapshot.participants.find((candidate) => (
      candidate.meetingId === goalRun.meetingId
      && candidate.roleSnapshot.orchestrationFunctions.includes("planner")
    ))!;
    const agent = snapshot.agents.find((candidate) => candidate.id === participant.agentId)!;
    const revision = await store.getAgentRevision(agent.id, participant.agentRevision ?? agent.publishedRevision!);
    const roleHistory = participant.roleHistory.find((entry) => entry.revision === participant.roleRevision)!;
    const expectedProvenance = {
      plannerParticipantId: participant.id,
      plannerAgentId: agent.id,
      plannerAgentRevision: revision.revision,
      plannerModelConnectorId: revision.modelConnectorId,
      plannerRoleId: roleHistory.roleId,
      plannerRoleRevision: roleHistory.revision,
      plannerRoleSnapshotDigest: roleExecutionSnapshotDigest(roleHistory.roleSnapshot)
    };
    const detail = (await store.getGoalRunDetail(goalRun.id))!;
    expect(detail.plans[0]!.plannerProvenance).toEqual(expectedProvenance);
    expect(detail.events.find((event) => event.type === "plan.created")).toMatchObject({
      actorType: "agent",
      actorId: agent.id,
      detail: expectedProvenance
    });
  });

  it("bounds projected acceptance criteria when a formal Decision reaches its contract limit", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    await store.createDecision({
      meetingId: goalRun.meetingId,
      title: "Prepare a contract-bounded plan",
      description: "x".repeat(4_000)
    });

    await expect(processGoalPlan({
      store,
      jobId: "goal-plan-bounded-decision",
      data: { goalRunId: goalRun.id, expectedRevision: 1, expectedPlanRevision: 0, requestedBy: "system" }
    })).resolves.toBe("planned");

    const task = (await store.getGoalRunDetail(goalRun.id))!.plans[0]!.tasks[0]!;
    expect(task.description).toHaveLength(4_000);
    expect(task.acceptanceCriteria.length).toBeLessThanOrEqual(4_000);
    expect(task.acceptanceCriteria).toMatch(/^Provide evidence that verifies:/);
  });

  it("pauses planning and settles durable admission when Plan persistence fails", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    await store.createDecision({
      meetingId: goalRun.meetingId,
      title: "Prepare a recoverable plan",
      description: "Create a bounded plan and preserve recoverable state."
    });
    vi.spyOn(store, "saveGoalPlan").mockRejectedValueOnce(new Error("synthetic Plan persistence failure"));

    await expect(processGoalPlan({
      store,
      jobId: "goal-plan-persistence-failure",
      data: { goalRunId: goalRun.id, expectedRevision: 1, expectedPlanRevision: 0, requestedBy: "system" }
    })).resolves.toBe("settled");

    expect(await store.getGoalRun(goalRun.id)).toMatchObject({
      state: "paused",
      pausedFromState: "planning",
      terminalReason: expect.stringContaining("Plan generation failed")
    });
    expect(await store.getGoalJobAdmission("goal-plan-persistence-failure")).toMatchObject({ state: "settled" });
  });

  it("pauses planning when the Meeting has no attributable Planner participant", async () => {
    const seed = createSeedSnapshot();
    seed.roles.forEach((role) => {
      role.orchestrationFunctions = (role.orchestrationFunctions ?? [])
        .filter((capability) => capability !== "planner");
    });
    seed.participants.forEach((participant) => {
      participant.roleSnapshot.orchestrationFunctions = participant.roleSnapshot.orchestrationFunctions
        .filter((capability) => capability !== "planner");
      participant.roleHistory.forEach((entry) => {
        entry.roleSnapshot.orchestrationFunctions = entry.roleSnapshot.orchestrationFunctions
          .filter((capability) => capability !== "planner");
      });
    });
    seed.decisions = [];
    seed.tasks = [];
    const store = new InMemoryPlatformStore(seed);
    const { goalRun } = await createGoal(store);
    await store.createDecision({
      meetingId: goalRun.meetingId,
      title: "Plan with explicit ownership",
      description: "Planning must not silently proceed without an attributable Planner."
    });

    await expect(processGoalPlan({
      store,
      jobId: "goal-plan-missing-planner",
      data: { goalRunId: goalRun.id, expectedRevision: 1, expectedPlanRevision: 0, requestedBy: "system" }
    })).resolves.toBe("settled");

    expect(await store.getGoalRun(goalRun.id)).toMatchObject({
      state: "paused",
      terminalReason: expect.stringContaining("Planner capability")
    });
  });

  it("keeps the original Planner excluded after an Owner plan revision", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    await store.createDecision({
      meetingId: goalRun.meetingId,
      title: "Prepare a verified plan",
      description: "Create a bounded plan with attributable provenance."
    });
    await processGoalPlan({
      store,
      jobId: "goal-plan-owner-retention-source",
      data: { goalRunId: goalRun.id, expectedRevision: 1, expectedPlanRevision: 0, requestedBy: "system" }
    });
    const first = (await store.getGoalRunDetail(goalRun.id))!;
    const originalPlan = first.plans[0]!;
    const revisedTasks = originalPlan.tasks.map((task, index) => index === 0
      ? { ...task, description: `${task.description}\nOwner clarification retained with Planner provenance.`.trim() }
      : task);
    await expect(store.saveGoalPlan(goalRun.id, {
      expectedRevision: first.goalRun.revision,
      expectedPlanRevision: originalPlan.revision,
      plan: {
        id: randomUUID(),
        goalRunId: goalRun.id,
        revision: 2,
        status: "draft",
        digest: goalPlanDigest(revisedTasks),
        tasks: revisedTasks,
        createdAt: now
      },
      event: { type: "plan.revised", actorType: "owner", actorId: ownerId, entityType: "plan", entityId: randomUUID(), summary: "Owner attempted to replace Planner provenance." }
    })).rejects.toThrow(/retain immutable Planner provenance/i);
    const ownerRevision = await store.saveGoalPlan(goalRun.id, {
      expectedRevision: first.goalRun.revision,
      expectedPlanRevision: originalPlan.revision,
      plan: {
        id: randomUUID(),
        goalRunId: goalRun.id,
        revision: 2,
        status: "draft",
        digest: goalPlanDigest(revisedTasks),
        tasks: revisedTasks,
        plannerProvenance: originalPlan.plannerProvenance,
        createdAt: now
      },
      event: { type: "plan.revised", actorType: "owner", actorId: ownerId, entityType: "plan", entityId: randomUUID(), summary: "Owner refined the Plan." }
    });
    const contract = createExecutionContract({
      goalRunId: goalRun.id,
      planRevision: 2,
      tasks: revisedTasks,
      limits: ownerRevision.goalRun.limits,
      approvedBy: ownerId,
      approvedAt: now
    });
    await store.approveGoalRun(goalRun.id, {
      expectedRevision: ownerRevision.goalRun.revision,
      contract,
      bindings: revisedTasks.map((task) => ({
        id: randomUUID(), goalRunId: goalRun.id, planRevision: 2, planTaskId: task.id, taskId: null,
        state: "ready" as const, attemptCount: 0, activeJobId: null, lastError: null, createdAt: now, updatedAt: now
      })),
      event: { type: "contract.approved", actorType: "owner", actorId: ownerId, entityType: "goal", entityId: goalRun.id, summary: "Owner approved revised Plan." }
    });
    const provenance = originalPlan.plannerProvenance!;
    const plannerSnapshot = await store.getSnapshot();
    const authorizationParticipant = plannerSnapshot.participants.find((candidate) => (
      candidate.meetingId === goalRun.meetingId
      && candidate.roleSnapshot.orchestrationFunctions.includes("reviewer")
    ))!;
    const plannerBinding = createGoalReviewBinding(plannerSnapshot, provenance.plannerModelConnectorId, authorizationParticipant);

    await expect(processGoalReview({
      store,
      jobId: "goal-review-owner-retention",
      data: {
        goalRunId: goalRun.id,
        scope: "goal",
        scopeId: goalRun.id,
        reviewerAgentId: provenance.plannerAgentId,
        reviewerAgentRevision: provenance.plannerAgentRevision,
        modelConnectorId: provenance.plannerModelConnectorId,
        ...plannerBinding,
        contractDigest: contract.contractDigest,
        requestedBy: "system"
      },
      complete: async () => ({ content: JSON.stringify({ verdict: "pass", summary: "This must never run.", evidenceIds: [goalRun.meetingId] }) })
    })).resolves.toBe("paused");
    expect(await store.getGoalRun(goalRun.id)).toMatchObject({
      state: "paused",
      terminalReason: expect.stringContaining("Reviewer is not independent")
    });
  });

  it("pauses final review when a legacy Plan has no Planner provenance", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    const { contract } = await approvePlan({ store, goalRun, task: planTask(), legacyPlannerProvenance: true });
    const snapshot = await store.getSnapshot();
    const reviewer = snapshot.participants.find((candidate) => (
      candidate.meetingId === goalRun.meetingId
      && candidate.roleSnapshot.orchestrationFunctions.includes("reviewer")
    ))!;
    const reviewerRevision = await store.getAgentRevision(reviewer.agentId, reviewer.agentRevision ?? 1);
    const reviewerBinding = createGoalReviewBinding(snapshot, reviewerRevision.modelConnectorId!, reviewer);

    await expect(processGoalReview({
      store,
      jobId: "goal-review-legacy-provenance",
      data: {
        goalRunId: goalRun.id,
        scope: "goal",
        scopeId: goalRun.id,
        reviewerAgentId: reviewer.agentId,
        reviewerAgentRevision: reviewerRevision.revision,
        modelConnectorId: reviewerRevision.modelConnectorId!,
        ...reviewerBinding,
        contractDigest: contract.contractDigest,
        requestedBy: "system"
      },
      complete: async () => ({ content: JSON.stringify({ verdict: "pass", summary: "This must never run.", evidenceIds: [goalRun.meetingId] }) })
    })).resolves.toBe("paused");
    expect(await store.getGoalRun(goalRun.id)).toMatchObject({
      state: "paused",
      terminalReason: expect.stringContaining("Planner provenance")
    });
  });

  it("limits parallel Task Agent work, then unlocks a dependent task after completion", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    const executor = (await store.getSnapshot()).agents[0]!;
    const first = planTask({ title: "First ready task", executionMode: "worker", assigneeAgentId: executor.id });
    const second = planTask({ title: "Second ready task", executionMode: "worker", assigneeAgentId: executor.id });
    const third = planTask({ title: "Dependent task", executionMode: "worker", assigneeAgentId: executor.id, dependencyIds: [first.id] });
    const { approved } = await approveTasks({ store, goalRun, tasks: [first, second, third] });
    const queued: Array<{ job: TaskAgentRunJobData; jobId: string }> = [];
    const enqueueTaskAgent = vi.fn(async (job: TaskAgentRunJobData, jobId: string) => {
      queued.push({ job, jobId });
      return { jobId };
    });

    await expect(processGoalOrchestrate({
      store,
      jobId: "goal-orchestrate-parallel-1",
      data: { goalRunId: goalRun.id, expectedRevision: approved.goalRun.revision, requestFingerprint: "e".repeat(64), requestedBy: "system" },
      enqueueTaskAgent
    })).resolves.toBe("settled");

    expect(queued).toHaveLength(2);
    let detail = (await store.getGoalRunDetail(goalRun.id))!;
    expect(detail.taskBindings.filter((binding) => binding.state === "running")).toHaveLength(2);
    expect(detail.taskBindings.find((binding) => binding.planTaskId === third.id)).toMatchObject({ state: "waiting" });
    expect(detail.goalRun.usage).toMatchObject({ taskAttempts: 2, modelCalls: 2 });

    await processTaskAgentRun({
      store,
      data: queued[0]!.job,
      jobId: queued[0]!.jobId,
      queueAttempt: 1,
      complete: async () => ({ content: "First task completed with durable text evidence." })
    });
    const firstBinding = detail.taskBindings.find((binding) => binding.planTaskId === first.id)!;
    await store.updateGoalTaskBinding(firstBinding.id, {
      expectedState: "running",
      state: "completed",
      activeJobId: null,
      event: { type: "task.state.changed", actorType: "system", actorId: null, entityType: "task", entityId: first.id, summary: "Test review completed." }
    });
    const resumed = (await store.getGoalRun(goalRun.id))!;
    const secondResult = await processGoalOrchestrate({
      store,
      jobId: "goal-orchestrate-parallel-2",
      data: { goalRunId: goalRun.id, expectedRevision: resumed.revision, requestFingerprint: "f".repeat(64), requestedBy: "system" },
      enqueueTaskAgent
    });
    const afterSecondRun = (await store.getGoalRun(goalRun.id))!;
    expect({ result: secondResult, terminalReason: afterSecondRun.terminalReason }).toEqual({ result: "settled", terminalReason: null });

    detail = (await store.getGoalRunDetail(goalRun.id))!;
    expect(queued).toHaveLength(3);
    expect(detail.taskBindings.find((binding) => binding.planTaskId === third.id)).toMatchObject({ state: "running" });
    expect(detail.goalRun.usage).toMatchObject({ taskAttempts: 3, modelCalls: 3 });
  });

  it("admits an attested OMP Task against its immutable Execution Contract binding", async () => {
    const store = createRunnableStore();
    const connector = (await store.getSnapshot()).modelConnectors[0]!;
    const prompt = await store.createPrompt({
      name: "OMP Goal execution Prompt",
      kind: "agent",
      description: "Bounded OMP Goal fixture.",
      owner: "Test Owner",
      content: "Execute only the approved isolated coding task.",
      variables: []
    });
    await store.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 });
    const profile = await store.createRuntimeProfile({
      name: "OMP Goal runtime",
      harnessKind: "pi",
      modelConnectorId: connector.id,
      sandboxProfileId: "70000000-0000-4000-8000-000000000304",
      policy: "isolated_exec",
      capabilities: ["text", "abort", "resume", "file_read", "file_write", "process"],
      timeoutMs: 2 * 60 * 60_000,
      maxConcurrency: 1,
      enabled: true
    });
    const agent = await store.createAgent({
      name: "OMP Goal Executor",
      description: "Executes one approved isolated coding task.",
      modelConnectorId: connector.id,
      goalSummary: "Produce bounded workspace evidence.",
      toolsSummary: "OMP phase-one workspace tools.",
      dataSummary: "Approved workspace archive only.",
      skillIds: [],
      toolGrants: [],
      toolPackGrants: [],
      runtimeProfileBinding: { profileId: profile.id, revision: profile.revision },
      promptBinding: { promptId: prompt.id, version: 1 }
    });
    const published = await store.publishAgent(agent.id, { expectedDraftRevision: agent.draftRevision! });
    const { goalRun } = await createGoal(store);
    const task = planTask({
      title: "Create the OMP canary artifact",
      executionMode: "worker",
      assigneeAgentId: published.id,
      allowedTools: ["read", "grep", "glob", "lsp", "edit", "bash"],
      dataScope: "Approved immutable workspace archive only."
    });
    const snapshot = await store.getSnapshot();
    const revision = await store.getAgentRevision(published.id, published.publishedRevision!);
    const runtimeProfile = resolveRuntimeProfileAdmission({
      binding: revision.runtimeProfileBinding,
      platform: snapshot,
      agentModelConnectorId: revision.modelConnectorId,
      executionIsolationAttested: true
    });
    const runtimeBinding = createExecutionRuntimeBinding({
      task,
      agentRevision: revision,
      runtimeProfile,
      modelConnector: connector,
      omp: {
        enabled: true,
        sandboxProfileId: profile.sandboxProfileId!,
        sandboxImageDigest: `sha256:${"a".repeat(64)}`,
        workspaceSourceId: "council-test",
        workspaceArchiveDigest: `sha256:${"b".repeat(64)}`
      },
      ompHostToolsEnabled: false
    });
    const { approved } = await approvePlan({
      store,
      goalRun,
      task,
      runtimeBindings: [runtimeBinding]
    });
    const approvedBinding = approved.taskBindings.find((candidate) => candidate.planTaskId === task.id)!;
    const forgedJobId = "goal-task-omp-forged-binding";
    const forged = await prepareGoalTaskAgent({
      store,
      taskId: approvedBinding.taskId!,
      jobId: forgedJobId,
      goalRunId: goalRun.id,
      planTaskId: task.id,
      executionRuntimeBinding: {
        ...runtimeBinding,
        sandboxImageDigest: `sha256:${"c".repeat(64)}`
      },
      executionIsolationAttested: true
    });
    await expect(store.markTaskAgentRunQueued(forgedJobId, forged.job))
      .rejects.toThrow(/execution binding is stale/i);
    const queued: Array<{ job: TaskAgentRunJobData; jobId: string }> = [];

    const result = await processGoalOrchestrate({
      store,
      jobId: "goal-orchestrate-omp-admission",
      data: {
        goalRunId: goalRun.id,
        expectedRevision: approved.goalRun.revision,
        requestFingerprint: "6".repeat(64),
        requestedBy: "system"
      },
      ompRuntimeReady: async () => true,
      enqueueTaskAgent: async (job, jobId) => {
        queued.push({ job, jobId });
        return { jobId };
      }
    });
    const detail = (await store.getGoalRunDetail(goalRun.id))!;
    expect({ result, terminalReason: detail.goalRun.terminalReason }).toEqual({
      result: "settled",
      terminalReason: null
    });

    expect(queued).toHaveLength(1);
    expect(queued[0]!.job.executionRuntimeBinding).toEqual(runtimeBinding);
    expect(detail).toMatchObject({
      goalRun: { state: "executing", terminalReason: null },
      taskBindings: [expect.objectContaining({ state: "running", attemptCount: 1 })],
      runtimeRuns: [expect.objectContaining({
        runtimeVersion: "omp-rpc-v2@18.1.2",
        runtimeProfile: expect.objectContaining({ harnessKind: "pi", policy: "isolated_exec" })
      })]
    });
  });

  it("atomically claims one Task Agent dispatch when two orchestrators observe the same ready binding", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    const executor = (await store.getSnapshot()).agents[0]!;
    const task = planTask({ executionMode: "worker", assigneeAgentId: executor.id });
    const { approved } = await approvePlan({ store, goalRun, task });
    const queued: Array<{ job: TaskAgentRunJobData; jobId: string }> = [];
    const enqueueTaskAgent = vi.fn(async (job: TaskAgentRunJobData, jobId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      queued.push({ job, jobId });
      return { jobId };
    });

    const results = await Promise.all([
      processGoalOrchestrate({
        store,
        jobId: "goal-orchestrate-contender-1",
        data: {
          goalRunId: goalRun.id,
          expectedRevision: approved.goalRun.revision,
          requestFingerprint: "7".repeat(64),
          requestedBy: "system"
        },
        enqueueTaskAgent
      }),
      processGoalOrchestrate({
        store,
        jobId: "goal-orchestrate-contender-2",
        data: {
          goalRunId: goalRun.id,
          expectedRevision: approved.goalRun.revision,
          requestFingerprint: "8".repeat(64),
          requestedBy: "system"
        },
        enqueueTaskAgent
      })
    ]);

    const detail = (await store.getGoalRunDetail(goalRun.id))!;
    expect(results.every((result) => result === "settled" || result === "stale")).toBe(true);
    expect(queued).toHaveLength(1);
    expect(detail.goalRun).toMatchObject({
      state: "executing",
      terminalReason: null,
      usage: { taskAttempts: 1, modelCalls: 1 }
    });
    expect(detail.taskBindings.find((binding) => binding.planTaskId === task.id)).toMatchObject({
      state: "running",
      attemptCount: 1
    });
  });

  it("does not claim Goal budget when canonical Task admission fails", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    const executor = (await store.getSnapshot()).agents[0]!;
    const task = planTask({ executionMode: "worker", assigneeAgentId: executor.id });
    const { approved } = await approvePlan({ store, goalRun, task });
    const claim = vi.spyOn(store, "claimGoalTaskDispatch");
    vi.spyOn(store, "markTaskAgentRunQueued").mockRejectedValueOnce(new Error("canonical Task store unavailable"));

    await expect(processGoalOrchestrate({
      store,
      jobId: "goal-orchestrate-task-admission-failure",
      data: {
        goalRunId: goalRun.id,
        expectedRevision: approved.goalRun.revision,
        requestFingerprint: "9".repeat(64),
        requestedBy: "system"
      },
      enqueueTaskAgent: vi.fn()
    })).resolves.toBe("paused");

    const detail = (await store.getGoalRunDetail(goalRun.id))!;
    expect(claim).not.toHaveBeenCalled();
    expect(detail.goalRun).toMatchObject({
      state: "paused",
      usage: { taskAttempts: 0, modelCalls: 0 }
    });
    expect(detail.taskBindings.find((binding) => binding.planTaskId === task.id)).toMatchObject({
      state: "ready",
      attemptCount: 0,
      activeJobId: null
    });
  });

  it("fences an unknown Task Agent provider outcome without another model dispatch", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    const executor = (await store.getSnapshot()).agents[0]!;
    const task = planTask({ executionMode: "worker", assigneeAgentId: executor.id });
    const { approved } = await approvePlan({ store, goalRun, task });
    const queued: Array<{ job: TaskAgentRunJobData; jobId: string }> = [];
    const enqueueTaskAgent = vi.fn(async (job: TaskAgentRunJobData, jobId: string) => {
      queued.push({ job, jobId });
      return { jobId };
    });
    await processGoalOrchestrate({
      store,
      jobId: "goal-orchestrate-outcome-unknown-1",
      data: {
        goalRunId: goalRun.id,
        expectedRevision: approved.goalRun.revision,
        requestFingerprint: "0".repeat(64),
        requestedBy: "system"
      },
      enqueueTaskAgent
    });
    expect(queued).toHaveLength(1);
    await recordTaskAgentRunFailure(store, queued[0]!.job, queued[0]!.jobId, "provider_outcome_unknown");
    const beforeRecovery = (await store.getGoalRun(goalRun.id))!;

    await expect(processGoalOrchestrate({
      store,
      jobId: "goal-orchestrate-outcome-unknown-2",
      data: {
        goalRunId: goalRun.id,
        expectedRevision: beforeRecovery.revision,
        requestFingerprint: "1".repeat(64),
        requestedBy: "system"
      },
      enqueueTaskAgent
    })).resolves.toBe("paused");

    const detail = (await store.getGoalRunDetail(goalRun.id))!;
    expect(detail.goalRun).toMatchObject({
      state: "paused",
      usage: { taskAttempts: 1, modelCalls: 1 }
    });
    expect(detail.taskBindings.find((binding) => binding.planTaskId === task.id)).toMatchObject({
      state: "failed",
      activeJobId: null,
      lastError: "provider_outcome_unknown"
    });
    expect(queued).toHaveLength(1);
  });

  it("atomically creates one Action Run and one queue admission for concurrent orchestrators", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    const adapterId = randomUUID();
    const task = planTask({
      executionMode: "action",
      action: {
        adapterId,
        actionKey: "deploy-preview",
        targetId: "pipeline-preview",
        inputs: { branch: "feature/goal-run" },
        riskClass: "ordinary"
      }
    });
    const { approved } = await approvePlan({ store, goalRun, task });
    await store.createActionAdapter({
      id: adapterId,
      name: "Atomic Harness preview",
      kind: "harness_pipeline",
      enabled: true,
      baseUrl: "http://127.0.0.1:8999/mcp",
      credentialId: null,
      catalogRevision: 1,
      actions: [{
        key: "deploy-preview",
        displayName: "Deploy preview",
        targetIds: ["pipeline-preview"],
        inputKeys: ["branch"],
        riskClass: "ordinary",
        timeoutMs: 10_000,
        supportsCancellation: true,
        supportsCompensation: true
      }],
      createdAt: now,
      updatedAt: now
    });
    const queued: Array<{ job: GoalActionRunJobData; jobId: string }> = [];
    const enqueueAction = vi.fn(async (job: GoalActionRunJobData, jobId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      queued.push({ job, jobId });
      return { jobId };
    });

    const results = await Promise.all([
      processGoalOrchestrate({
        store,
        jobId: "goal-action-orchestrate-contender-1",
        data: {
          goalRunId: goalRun.id,
          expectedRevision: approved.goalRun.revision,
          requestFingerprint: "9".repeat(64),
          requestedBy: "system"
        },
        enqueueAction
      }),
      processGoalOrchestrate({
        store,
        jobId: "goal-action-orchestrate-contender-2",
        data: {
          goalRunId: goalRun.id,
          expectedRevision: approved.goalRun.revision,
          requestFingerprint: "a".repeat(64),
          requestedBy: "system"
        },
        enqueueAction
      })
    ]);

    const detail = (await store.getGoalRunDetail(goalRun.id))!;
    expect(results.every((result) => result === "settled" || result === "stale")).toBe(true);
    expect(queued).toHaveLength(1);
    expect(detail.goalRun).toMatchObject({ state: "executing", terminalReason: null, usage: { actionCalls: 1 } });
    expect(detail.actionRuns).toHaveLength(1);
    expect(detail.taskBindings.find((binding) => binding.planTaskId === task.id)).toMatchObject({
      state: "running",
      attemptCount: 1,
      activeJobId: queued[0]!.jobId
    });
    expect((await store.getRecoverableGoalJobs()).filter((job) => job.jobName === "goal-action-run")).toEqual([
      expect.objectContaining({ jobId: queued[0]!.jobId, state: "admitted" })
    ]);
  });

  it("serializes parallel Action tasks that target the same approved external resource", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    const adapterId = randomUUID();
    const action = (branch: string) => ({
      adapterId,
      actionKey: "deploy-preview",
      targetId: "pipeline-preview",
      inputs: { branch },
      riskClass: "ordinary" as const
    });
    const first = planTask({ executionMode: "action", action: action("feature/first") });
    const second = planTask({ executionMode: "action", action: action("feature/second") });
    const { approved } = await approveTasks({ store, goalRun, tasks: [first, second] });
    await store.createActionAdapter({
      id: adapterId,
      name: "Serialized Harness target",
      kind: "harness_pipeline",
      enabled: true,
      baseUrl: "http://127.0.0.1:8999/mcp",
      credentialId: null,
      catalogRevision: 1,
      actions: [{
        key: "deploy-preview",
        displayName: "Deploy preview",
        targetIds: ["pipeline-preview"],
        inputKeys: ["branch"],
        riskClass: "ordinary",
        timeoutMs: 10_000,
        supportsCancellation: true,
        supportsCompensation: true
      }],
      createdAt: now,
      updatedAt: now
    });
    const queued: Array<{ job: GoalActionRunJobData; jobId: string }> = [];

    await expect(processGoalOrchestrate({
      store,
      jobId: "goal-action-shared-target",
      data: {
        goalRunId: goalRun.id,
        expectedRevision: approved.goalRun.revision,
        requestFingerprint: "b".repeat(64),
        requestedBy: "system"
      },
      enqueueAction: async (job, jobId) => {
        queued.push({ job, jobId });
        return { jobId };
      }
    })).resolves.toBe("settled");

    const detail = (await store.getGoalRunDetail(goalRun.id))!;
    expect(queued).toHaveLength(1);
    expect(detail.goalRun.usage.actionCalls).toBe(1);
    expect(detail.taskBindings.filter((binding) => binding.state === "running")).toHaveLength(1);
    expect(detail.taskBindings.filter((binding) => binding.state === "ready")).toHaveLength(1);
    expect(detail.actionRuns).toHaveLength(1);
  });

  it("completes task and Goal review with two Agents on different Model Connectors at the exact model budget", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store, { maxModelCalls: 4 });
    const executor = (await store.getSnapshot()).agents[0]!;
    const task = planTask({ executionMode: "worker", assigneeAgentId: executor.id });
    const { contract, binding, approved } = await approvePlan({ store, goalRun, task });
    const evidenceId = await addCanonicalTaskEvidence(store, binding);
    await store.updateGoalTaskBinding(binding.id, {
      expectedState: "ready",
      state: "reviewing",
      event: { type: "task.state.changed", actorType: "system", actorId: null, entityType: "task", entityId: task.id, summary: "Execution evidence is ready for review." }
    });
    const reviewJobs: Array<{ job: GoalReviewJobData; jobId: string }> = [];
    const enqueueReview = vi.fn(async (job: GoalReviewJobData, jobId: string) => {
      reviewJobs.push({ job, jobId });
      return { jobId };
    });
    const scheduleTaskReviews = (await store.getGoalRun(goalRun.id))!;
    await processGoalOrchestrate({
      store,
      jobId: "goal-orchestrate-task-review",
      data: { goalRunId: goalRun.id, expectedRevision: scheduleTaskReviews.revision, requestFingerprint: "1".repeat(64), requestedBy: "system" },
      enqueueReview
    });
    expect(reviewJobs).toHaveLength(2);

    const complete = vi.fn(async () => ({
      content: JSON.stringify({ verdict: "pass", summary: "Canonical task evidence satisfies the scoped acceptance criteria.", evidenceIds: [evidenceId] })
    }));
    await expect(processGoalReview({ store, data: reviewJobs[0]!.job, jobId: reviewJobs[0]!.jobId, complete })).resolves.toBe("settled");
    await expect(processGoalReview({ store, data: reviewJobs[1]!.job, jobId: reviewJobs[1]!.jobId, complete })).resolves.toBe("completed");
    expect((await store.getGoalRunDetail(goalRun.id))!.taskBindings.find((candidate) => candidate.id === binding.id)).toMatchObject({ state: "completed" });

    const scheduleGoalReviews = (await store.getGoalRun(goalRun.id))!;
    await processGoalOrchestrate({
      store,
      jobId: "goal-orchestrate-final-review",
      data: { goalRunId: goalRun.id, expectedRevision: scheduleGoalReviews.revision, requestFingerprint: "2".repeat(64), requestedBy: "system" },
      enqueueReview
    });
    expect(reviewJobs).toHaveLength(4);
    await expect(processGoalReview({ store, data: reviewJobs[2]!.job, jobId: reviewJobs[2]!.jobId, complete })).resolves.toBe("settled");
    await expect(processGoalReview({ store, data: reviewJobs[3]!.job, jobId: reviewJobs[3]!.jobId, complete })).resolves.toBe("completed");

    const completed = (await store.getGoalRunDetail(goalRun.id))!;
    expect(completed.goalRun).toMatchObject({ state: "completed", usage: { modelCalls: 4 } });
    expect(completed.executionContract?.contractDigest).toBe(contract.contractDigest);
    expect(completed.reviewerVerdicts).toHaveLength(4);
    expect(new Set(completed.reviewerVerdicts.map((verdict) => verdict.modelConnectorId)).size).toBe(2);
    expect((await store.getSnapshot()).tasks.find((candidate) => candidate.id === binding.taskId)).toMatchObject({ status: "done" });
    expect(complete).toHaveBeenCalledTimes(4);
    expect(approved.goalRun.state).toBe("executing");
  });

  it("keeps two reserved Reviewers available for final review of a four-Agent multi-assignee Plan", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store, { maxModelCalls: 2 });
    const snapshot = await store.getSnapshot();
    const worker = snapshot.agents[0]!;
    const chair = snapshot.agents[1]!;
    const reviewers = snapshot.participants
      .filter((participant) => {
        const role = snapshot.roles.find((candidate) => candidate.id === participant.roleId);
        return !participant.isChair && role?.orchestrationFunctions?.includes("reviewer");
      })
      .map((participant) => participant.agentId);
    const first = planTask({ title: "Architecture work", executionMode: "worker", assigneeAgentId: worker.id });
    const second = planTask({ title: "Chair-owned handoff", executionMode: "worker", assigneeAgentId: chair.id });
    const { bindings, approved } = await approveTasks({ store, goalRun, tasks: [first, second] });
    for (const binding of bindings) {
      await store.updateGoalTaskBinding(binding.id, {
        expectedState: binding.state,
        state: "completed",
        event: { type: "task.state.changed", actorType: "system", actorId: null, entityType: "task", entityId: binding.planTaskId, summary: "Task evidence completed for final review." }
      });
    }
    const reviewJobs: Array<{ job: GoalReviewJobData; jobId: string }> = [];
    const enqueueReview = vi.fn(async (job: GoalReviewJobData, jobId: string) => {
      reviewJobs.push({ job, jobId });
      return { jobId };
    });

    await expect(processGoalOrchestrate({
      store,
      jobId: "goal-orchestrate-four-agent-final-review",
      data: { goalRunId: goalRun.id, expectedRevision: approved.goalRun.revision, requestFingerprint: "4".repeat(64), requestedBy: "system" },
      enqueueReview
    })).resolves.toBe("settled");

    expect(reviewJobs).toHaveLength(2);
    expect(reviewJobs.map(({ job }) => job.reviewerAgentId).sort()).toEqual([...reviewers].sort());
    expect(new Set(reviewJobs.map(({ job }) => job.modelConnectorId)).size).toBe(2);
    expect(reviewJobs.every(({ job }) => ![worker.id, chair.id].includes(job.reviewerAgentId))).toBe(true);
  });

  it("runs the configured formal discussion rounds before creating a candidate Decision and Plan", async () => {
    const { store, goalRun } = await createGoal(createRunnableStore());
    const meeting = (await store.getSnapshot()).meetings.find((candidate) => candidate.id === goalRun.meetingId)!;
    if (meeting.state === "draft") await store.setMeetingState(meeting.id, "active", "draft");
    const runMeetingRound = vi.fn(async () => ({ modelCalls: 2 }));

    await expect(processGoalOrchestrate({
      store,
      jobId: "goal-orchestrate-autonomous-rounds",
      data: { goalRunId: goalRun.id, expectedRevision: 1, requestFingerprint: "d".repeat(64), requestedBy: "owner" },
      runMeetingRound
    })).resolves.toBe("settled");

    expect(runMeetingRound).toHaveBeenCalledTimes(3);
    expect(await store.getGoalRun(goalRun.id)).toMatchObject({
      state: "awaiting_approval",
      activePlanRevision: 1,
      usage: { discussionRounds: 3, modelCalls: 6 }
    });
    const snapshot = await store.getSnapshot();
    expect(snapshot.decisions.filter((decision) => decision.meetingId === goalRun.meetingId)).toHaveLength(1);
    expect(snapshot.meetings.find((candidate) => candidate.id === goalRun.meetingId)).toMatchObject({ state: "paused" });
    expect(await store.getGoalJobAdmission(`goal-plan-${goalRun.id}-1`)).toMatchObject({
      goalRunId: goalRun.id,
      jobName: "goal-plan",
      state: "settled"
    });
  });

  it("keeps a transcript-saturated formal Decision within the Plan contract", async () => {
    const { store, goalRun } = await createGoal(createRunnableStore());
    const meeting = (await store.getSnapshot()).meetings.find((candidate) => candidate.id === goalRun.meetingId)!;
    if (meeting.state === "draft") await store.setMeetingState(meeting.id, "active", "draft");

    await expect(processGoalOrchestrate({
      store,
      jobId: "goal-orchestrate-transcript-saturation",
      data: { goalRunId: goalRun.id, expectedRevision: 1, requestFingerprint: "f".repeat(64), requestedBy: "owner" },
      runMeetingRound: async ({ meetingId, round }) => {
        await store.addUtterance(meetingId, {
          turnId: `goal-run:${goalRun.id}:round:${round}`,
          speakerType: "agent",
          speakerName: `Round ${round} analyst`,
          roleName: "分析者",
          content: `${round}:`.padEnd(2_000, "x"),
          kind: "inference",
          evidenceCount: 0
        });
        return { modelCalls: 1 };
      }
    })).resolves.toBe("settled");

    const snapshot = await store.getSnapshot();
    const decision = snapshot.decisions.find((candidate) => candidate.meetingId === goalRun.meetingId)!;
    const detail = (await store.getGoalRunDetail(goalRun.id))!;
    expect(decision.description).toHaveLength(4_000);
    expect(detail.goalRun).toMatchObject({ state: "awaiting_approval", activePlanRevision: 1 });
    expect(detail.plans[0]!.tasks[0]!.acceptanceCriteria.length).toBeLessThanOrEqual(4_000);
    expect(await store.getGoalJobAdmission(`goal-plan-${goalRun.id}-1`)).toMatchObject({ state: "settled" });
  });

  it("keeps an active formal Meeting open, then projects its Decisions into a reviewable Plan", async () => {
    const { store, goalRun } = await createGoal(createRunnableStore());
    const orchestrated = await processGoalOrchestrate({
      store,
      jobId: "goal-orchestrate-1",
      data: { goalRunId: goalRun.id, expectedRevision: 1, requestFingerprint: "a".repeat(64), requestedBy: "owner" }
    });
    expect(orchestrated).toBe("settled");
    expect(await store.getGoalRun(goalRun.id)).toMatchObject({ state: "planning" });

    const replay = await processGoalOrchestrate({
      store,
      jobId: "goal-orchestrate-1",
      data: { goalRunId: goalRun.id, expectedRevision: 1, requestFingerprint: "a".repeat(64), requestedBy: "owner" }
    });
    expect(replay).toBe("settled");

    const { store: plannerStore, goalRun: plannerGoal } = await createGoal(createRunnableStore());
    await expect(processGoalPlan({
      store: plannerStore,
      jobId: "goal-plan-1",
      data: { goalRunId: plannerGoal.id, expectedRevision: 1, expectedPlanRevision: 0, requestedBy: "system" }
    })).resolves.toBe("settled");
    expect(await plannerStore.getGoalRun(plannerGoal.id)).toMatchObject({ state: "planning" });

    await plannerStore.createDecision({
      meetingId: plannerGoal.meetingId,
      title: "Produce the verified delivery",
      description: "Create the bounded artifact and attach evidence."
    });
    await expect(processGoalPlan({
      store: plannerStore,
      jobId: "goal-plan-2",
      data: { goalRunId: plannerGoal.id, expectedRevision: 1, expectedPlanRevision: 0, requestedBy: "system" }
    })).resolves.toBe("planned");
    expect(await plannerStore.getGoalRun(plannerGoal.id)).toMatchObject({ state: "awaiting_approval", activePlanRevision: 1 });
  });

  it("projects event-confirmed Owner instructions from the canonical Meeting transcript into the next Goal Plan", async () => {
    const { store, goalRun } = await createGoal(createRunnableStore());
    const meeting = (await store.getSnapshot()).meetings.find((candidate) => candidate.id === goalRun.meetingId)!;
    if (meeting.state === "draft") await store.setMeetingState(meeting.id, "active", "draft");
    await store.addUtterance(meeting.id, {
      turnId: `goal-run:${goalRun.id}:owner-message:unconfirmed`,
      speakerType: "human",
      speakerName: "Owner",
      roleName: "決策者",
      content: "This unconfirmed instruction must not affect Goal planning.",
      kind: "human",
      evidenceCount: 0
    });
    const utterance = await store.addUtterance(meeting.id, {
      turnId: `goal-run:${goalRun.id}:owner-message:test`,
      speakerType: "human",
      speakerName: "Owner",
      roleName: "決策者",
      content: "Do not execute until the evidence package is independently reviewed.",
      kind: "human",
      evidenceCount: 0
    });
    await store.appendGoalEvent(goalRun.id, {
      type: "owner.message",
      actorType: "owner",
      actorId: ownerId,
      entityType: "meeting",
      entityId: utterance.id,
      summary: "Owner added a Goal Run instruction.",
      detail: { meetingId: meeting.id, utteranceId: utterance.id }
    });
    await store.createDecision({
      meetingId: meeting.id,
      title: "Produce the verified delivery",
      description: "Create the bounded artifact and attach evidence."
    });

    await expect(processGoalPlan({
      store,
      jobId: "goal-plan-owner-instruction",
      data: { goalRunId: goalRun.id, expectedRevision: 1, expectedPlanRevision: 0, requestedBy: "system" }
    })).resolves.toBe("planned");

    const detail = (await store.getGoalRunDetail(goalRun.id))!;
    expect(detail.plans[0]!.tasks[0]!.dataScope).toContain("Do not execute until the evidence package is independently reviewed.");
    expect(detail.plans[0]!.tasks[0]!.dataScope).not.toContain("This unconfirmed instruction must not affect Goal planning.");
  });

  it("fails a legacy Reviewer job closed when no durable verdict exists", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    const task = planTask();
    const { contract } = await approvePlan({ store, goalRun, task });
    const current = await reviewJob({
      store,
      goalRun,
      contractDigest: contract.contractDigest,
      scope: "task",
      scopeId: task.id
    });
    const legacy = legacyReviewJob(current);
    const jobId = "goal-review-legacy-without-verdict";

    await expect(processLegacyGoalReview({ store, data: legacy, jobId })).resolves.toBe("paused");

    expect(await store.getGoalRun(goalRun.id)).toMatchObject({
      state: "paused",
      usage: { modelCalls: 0 }
    });
    expect(await store.getGoalJobAdmission(jobId)).toMatchObject({ state: "settled" });
  });

  it("reconciles persisted legacy Reviewer verdicts without another model call", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    const executor = (await store.getSnapshot()).agents[0]!;
    const task = planTask({ executionMode: "worker", assigneeAgentId: executor.id });
    const { contract, binding, approved } = await approvePlan({ store, goalRun, task });
    const evidenceId = await addCanonicalTaskEvidence(store, binding);
    await store.updateGoalTaskBinding(binding.id, {
      expectedState: "ready",
      state: "reviewing",
      event: {
        type: "task.state.changed",
        actorType: "system",
        actorId: null,
        entityType: "task",
        entityId: task.id,
        summary: "Execution evidence is ready for legacy reconciliation."
      }
    });
    const queued: Array<{ job: GoalReviewJobData; jobId: string }> = [];
    await processGoalOrchestrate({
      store,
      jobId: "goal-orchestrate-legacy-review-reconciliation",
      data: {
        goalRunId: goalRun.id,
        expectedRevision: approved.goalRun.revision,
        requestFingerprint: "c".repeat(64),
        requestedBy: "system"
      },
      enqueueReview: async (job, jobId) => {
        queued.push({ job, jobId });
        return { jobId };
      }
    });
    expect(queued).toHaveLength(2);
    for (const scheduled of queued) {
      expect(await store.getGoalReviewJobData(scheduled.jobId)).toEqual(scheduled.job);
      const verdictId = randomUUID();
      await store.addReviewerVerdict({
        id: verdictId,
        goalRunId: goalRun.id,
        scope: scheduled.job.scope,
        scopeId: scheduled.job.scopeId,
        reviewerAgentId: scheduled.job.reviewerAgentId,
        reviewerAgentRevision: scheduled.job.reviewerAgentRevision,
        modelConnectorId: scheduled.job.modelConnectorId,
        verdict: "pass",
        summary: "Persisted evidence passed before the version 1 Worker restarted.",
        evidenceIds: [evidenceId],
        contractDigest: contract.contractDigest,
        reviewJobId: null,
        reviewRequestFingerprint: null,
        createdAt: now
      }, {
        type: "review.recorded",
        actorType: "agent",
        actorId: scheduled.job.reviewerAgentId,
        entityType: "review",
        entityId: verdictId,
        summary: "Legacy Reviewer verdict was durably recorded."
      });
    }
    const legacy = legacyReviewJob(queued[0]!.job);

    await expect(processLegacyGoalReview({
      store,
      data: legacy,
      jobId: "goal-review-legacy-persisted-verdict"
    })).resolves.toBe("completed");

    expect(await store.getGoalRun(goalRun.id)).toMatchObject({ usage: { modelCalls: 0 } });
    expect((await store.getGoalRunDetail(goalRun.id))?.taskBindings.find((candidate) => candidate.id === binding.id))
      .toMatchObject({ state: "completed", activeJobId: null });
  });

  it("pauses reviewer work when its attributable Agent binding is unavailable", async () => {
    const { store, goalRun } = await createGoal();
    const task = planTask();
    const { contract } = await approvePlan({ store, goalRun, task });
    const snapshot = await store.getSnapshot();
    const reviewerParticipant = snapshot.participants.find((participant) => (
      participant.meetingId === goalRun.meetingId
      && participant.roleSnapshot.orchestrationFunctions.includes("reviewer")
    ))!;
    const reviewer = snapshot.agents.find((agent) => agent.id === reviewerParticipant.agentId)!;
    const reviewerRole = reviewerParticipant.roleHistory.find((entry) => entry.revision === reviewerParticipant.roleRevision)!;
    const missingConnectorId = randomUUID();
    await expect(processGoalReview({
      store,
      jobId: "goal-review-1",
      data: {
        goalRunId: goalRun.id,
        scope: "task",
        scopeId: task.id,
        reviewerAgentId: reviewer.id,
        reviewerAgentRevision: reviewer.publishedRevision ?? 1,
        reviewerParticipantId: reviewerParticipant.id,
        reviewerRoleId: reviewerRole.roleId,
        reviewerRoleRevision: reviewerRole.revision,
        reviewerRoleSnapshotDigest: roleExecutionSnapshotDigest(reviewerRole.roleSnapshot),
        modelConnectorId: missingConnectorId,
        modelConnectorBinding: {
          id: missingConnectorId,
          revision: 1,
          location: "local",
          baseUrl: "http://127.0.0.1:4999/v1",
          model: "missing-reviewer",
          credentialId: null,
          secretRevision: 0
        },
        contractDigest: contract.contractDigest,
        requestedBy: "system"
      }
    })).resolves.toBe("paused");
    expect(await store.getGoalRun(goalRun.id)).toMatchObject({ state: "paused", usage: { modelCalls: 0 } });
  });

  it("rejects Meeting and Decision IDs as context-only Reviewer pass evidence", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    const task = planTask();
    const { contract } = await approvePlan({ store, goalRun, task });
    const job = await reviewJob({ store, goalRun, contractDigest: contract.contractDigest, scope: "task", scopeId: task.id });
    const complete = vi.fn(async () => ({
      content: JSON.stringify({
        verdict: "pass",
        summary: "The source Meeting and Decision are sufficient.",
        evidenceIds: [goalRun.meetingId, task.decisionId]
      })
    }));

    await expect(processGoalReview({ store, data: job, jobId: "goal-review-context-only", complete })).resolves.toBe("paused");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(await store.getGoalRun(goalRun.id)).toMatchObject({ state: "paused", usage: { modelCalls: 1 } });
  });

  it("fails closed when a persisted pass has no qualifying execution evidence", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    const task = planTask();
    const { contract } = await approvePlan({ store, goalRun, task });
    const job = await reviewJob({ store, goalRun, contractDigest: contract.contractDigest, scope: "task", scopeId: task.id });
    const jobId = "goal-review-persisted-context-only";
    await reserveGoalReviewAdmission({ store, data: job, jobId });
    await store.addReviewerVerdict({
      id: randomUUID(),
      goalRunId: goalRun.id,
      scope: job.scope,
      scopeId: job.scopeId,
      reviewerAgentId: job.reviewerAgentId,
      reviewerAgentRevision: job.reviewerAgentRevision,
      modelConnectorId: job.modelConnectorId,
      verdict: "pass",
      summary: "Legacy verdict cited only source context.",
      evidenceIds: [task.decisionId],
      contractDigest: contract.contractDigest,
      reviewJobId: jobId,
      reviewRequestFingerprint: goalReviewAdmissionFingerprint(job),
      createdAt: now
    }, {
      type: "review.recorded",
      actorType: "agent",
      actorId: job.reviewerAgentId,
      entityType: "review",
      entityId: randomUUID(),
      summary: "Persisted legacy pass verdict."
    });
    const complete = vi.fn(async () => {
      throw new Error("Persisted verdict must not call the Reviewer model.");
    });

    await expect(processGoalReview({ store, data: job, jobId, complete })).resolves.toBe("paused");
    expect(complete).not.toHaveBeenCalled();
    expect(await store.getGoalRun(goalRun.id)).toMatchObject({ state: "paused" });
  });

  it("rejects canonical evidence outside the exact task review scope", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    const first = planTask({ title: "First scoped task" });
    const second = planTask({ title: "Second scoped task" });
    const { contract, bindings } = await approveTasks({ store, goalRun, tasks: [first, second] });
    const secondEvidenceId = await addCanonicalTaskEvidence(store, bindings.find((binding) => binding.planTaskId === second.id)!);
    const job = await reviewJob({ store, goalRun, contractDigest: contract.contractDigest, scope: "task", scopeId: first.id });

    await expect(processGoalReview({
      store,
      data: job,
      jobId: "goal-review-cross-task-evidence",
      complete: async () => ({
        content: JSON.stringify({ verdict: "pass", summary: "A different task was completed.", evidenceIds: [secondEvidenceId] })
      })
    })).resolves.toBe("paused");
    expect(await store.getGoalRun(goalRun.id)).toMatchObject({ state: "paused" });
  });

  it("does not let a canonical Task note replace verified Action evidence", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    const task = planTask({
      executionMode: "action",
      action: {
        adapterId: randomUUID(),
        actionKey: "deploy-preview",
        targetId: "pipeline-preview",
        inputs: { branch: "feature/goal-run" },
        riskClass: "ordinary"
      }
    });
    const { contract, binding } = await approvePlan({ store, goalRun, task });
    const taskEvidenceId = await addCanonicalTaskEvidence(store, binding, "Owner task note");
    await store.createActionAdapter({
      id: task.action!.adapterId,
      name: "Unverified reviewer evidence adapter",
      kind: "harness_pipeline",
      enabled: true,
      baseUrl: "http://127.0.0.1:8999/mcp",
      credentialId: null,
      catalogRevision: 1,
      actions: [{
        key: task.action!.actionKey,
        displayName: "Deploy preview",
        targetIds: [task.action!.targetId],
        inputKeys: ["branch"],
        riskClass: "ordinary",
        timeoutMs: 10_000,
        supportsCancellation: true,
        supportsCompensation: true
      }],
      createdAt: now,
      updatedAt: now
    });
    const actionRun: ActionRun = {
      id: randomUUID(),
      goalRunId: goalRun.id,
      planTaskId: task.id,
      adapterId: task.action!.adapterId,
      adapterCatalogRevision: 1,
      actionKey: task.action!.actionKey,
      targetId: task.action!.targetId,
      inputs: task.action!.inputs,
      state: "approved",
      requestFingerprint: requestFingerprint({
        goalRunId: goalRun.id,
        planTaskId: task.id,
        contractDigest: contract.contractDigest,
        adapterCatalogRevision: 1,
        action: task.action
      }),
      contractDigest: contract.contractDigest,
      externalExecutionId: null,
      verificationSummary: null,
      lastError: null,
      createdAt: now,
      updatedAt: now
    };
    await store.createActionRun(actionRun, {
      type: "action.state.changed", actorType: "owner", actorId: ownerId, entityType: "action", entityId: actionRun.id,
      summary: "Action is approved but not executed or verified."
    });
    const job = await reviewJob({ store, goalRun, contractDigest: contract.contractDigest, scope: "action", scopeId: actionRun.id });

    await expect(processGoalReview({
      store,
      data: job,
      jobId: "goal-review-action-task-note",
      complete: async () => ({
        content: JSON.stringify({ verdict: "pass", summary: "The Task note is enough.", evidenceIds: [taskEvidenceId] })
      })
    })).resolves.toBe("paused");
    expect(await store.getGoalRun(goalRun.id)).toMatchObject({ state: "paused" });
  });

  it("accepts verified Action Run evidence only from the active contract and exact Action scope", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    const task = planTask({
      executionMode: "action",
      action: {
        adapterId: randomUUID(),
        actionKey: "deploy-preview",
        targetId: "pipeline-preview",
        inputs: { branch: "feature/goal-run" },
        riskClass: "ordinary"
      }
    });
    const { contract } = await approvePlan({ store, goalRun, task });
    await store.createActionAdapter({
      id: task.action!.adapterId,
      name: "Reviewer evidence adapter",
      kind: "harness_pipeline",
      enabled: true,
      baseUrl: "http://127.0.0.1:8999/mcp",
      credentialId: null,
      catalogRevision: 1,
      actions: [{
        key: task.action!.actionKey,
        displayName: "Deploy preview",
        targetIds: [task.action!.targetId],
        inputKeys: ["branch"],
        riskClass: "ordinary",
        timeoutMs: 10_000,
        supportsCancellation: true,
        supportsCompensation: true
      }],
      createdAt: now,
      updatedAt: now
    });
    const actionRun: ActionRun = {
      id: randomUUID(),
      goalRunId: goalRun.id,
      planTaskId: task.id,
      adapterId: task.action!.adapterId,
      adapterCatalogRevision: 1,
      actionKey: task.action!.actionKey,
      targetId: task.action!.targetId,
      inputs: task.action!.inputs,
      state: "succeeded",
      requestFingerprint: requestFingerprint({
        goalRunId: goalRun.id,
        planTaskId: task.id,
        contractDigest: contract.contractDigest,
        adapterCatalogRevision: 1,
        action: task.action
      }),
      contractDigest: contract.contractDigest,
      externalExecutionId: "external-verified-1",
      verificationSummary: "The approved Action completed and verify returned succeeded.",
      lastError: null,
      createdAt: now,
      updatedAt: now
    };
    await store.createActionRun(actionRun, {
      type: "action.state.changed", actorType: "system", actorId: null, entityType: "action", entityId: actionRun.id,
      summary: "Action verified for Reviewer evidence."
    });
    const job = await reviewJob({ store, goalRun, contractDigest: contract.contractDigest, scope: "action", scopeId: actionRun.id });

    await expect(processGoalReview({
      store,
      data: job,
      jobId: "goal-review-verified-action",
      complete: async () => ({
        content: JSON.stringify({ verdict: "pass", summary: "The exact Action was verified.", evidenceIds: [actionRun.id] })
      })
    })).resolves.toBe("settled");
  });

  it("rejects stale Action Run IDs even when their verification record says succeeded", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    const task = planTask({
      executionMode: "action",
      action: {
        adapterId: randomUUID(),
        actionKey: "deploy-preview",
        targetId: "pipeline-preview",
        inputs: { branch: "feature/goal-run" },
        riskClass: "ordinary"
      }
    });
    const { contract } = await approvePlan({ store, goalRun, task });
    await store.createActionAdapter({
      id: task.action!.adapterId,
      name: "Stale reviewer evidence adapter",
      kind: "harness_pipeline",
      enabled: true,
      baseUrl: "http://127.0.0.1:8999/mcp",
      credentialId: null,
      catalogRevision: 1,
      actions: [{
        key: task.action!.actionKey,
        displayName: "Deploy preview",
        targetIds: [task.action!.targetId],
        inputKeys: ["branch"],
        riskClass: "ordinary",
        timeoutMs: 10_000,
        supportsCancellation: true,
        supportsCompensation: true
      }],
      createdAt: now,
      updatedAt: now
    });
    const actionRun: ActionRun = {
      id: randomUUID(),
      goalRunId: goalRun.id,
      planTaskId: task.id,
      adapterId: task.action!.adapterId,
      adapterCatalogRevision: 1,
      actionKey: task.action!.actionKey,
      targetId: task.action!.targetId,
      inputs: task.action!.inputs,
      state: "succeeded",
      requestFingerprint: requestFingerprint({
        goalRunId: goalRun.id,
        planTaskId: task.id,
        contractDigest: contract.contractDigest,
        adapterCatalogRevision: 1,
        action: task.action
      }),
      contractDigest: "f".repeat(64),
      externalExecutionId: "external-stale-1",
      verificationSummary: "A prior contract Action was verified.",
      lastError: null,
      createdAt: now,
      updatedAt: now
    };
    await store.createActionRun(actionRun, {
      type: "action.state.changed", actorType: "system", actorId: null, entityType: "action", entityId: actionRun.id,
      summary: "Stale Action Run retained for audit."
    });
    const job = await reviewJob({ store, goalRun, contractDigest: contract.contractDigest, scope: "action", scopeId: actionRun.id });

    await expect(processGoalReview({
      store,
      data: job,
      jobId: "goal-review-stale-action",
      complete: async () => ({
        content: JSON.stringify({ verdict: "pass", summary: "A stale Action was verified.", evidenceIds: [actionRun.id] })
      })
    })).resolves.toBe("paused");
    expect(await store.getGoalRun(goalRun.id)).toMatchObject({ state: "paused" });
  });

  it.each(["disabled", "revoked", "expired", "rotated"] as const)("pauses before Reviewer completion when its queued Credential is %s", async (drift) => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    const task = planTask();
    const { contract, binding } = await approvePlan({ store, goalRun, task });
    const evidenceId = await addCanonicalTaskEvidence(store, binding);
    let job = await reviewJob({ store, goalRun, contractDigest: contract.contractDigest, scope: "task", scopeId: task.id });
    const vault = new SecretVault(Buffer.alloc(32, 9));
    const credential = await bindReviewerCredential({
      store,
      job,
      vault
    });
    job = await reviewJob({ store, goalRun, contractDigest: contract.contractDigest, scope: "task", scopeId: task.id });
    if (drift === "disabled" || drift === "revoked") {
      await store.setCredentialStatus(credential.id, { status: drift, expectedUpdatedAt: credential.updatedAt });
    } else if (drift === "expired") {
      const mutableState = Reflect.get(store, "state") as ReturnType<typeof createSeedSnapshot>;
      mutableState.credentials!.find((candidate) => candidate.id === credential.id)!.expiresAt = "2020-01-01T00:00:00.000Z";
    } else if (drift === "rotated") {
      await store.rotateCredential({
        credentialId: credential.id,
        expectedSecretRevision: credential.secretRevision
      }, { ciphertext: vault.encrypt("rotated-reviewer-secret") });
    }
    const complete = vi.fn(async () => ({
      content: JSON.stringify({ verdict: "pass", summary: "This must not run.", evidenceIds: [evidenceId] })
    }));

    await expect(processGoalReview({
      store,
      data: job,
      jobId: `goal-review-credential-${drift}`,
      secretVault: vault,
      complete
    })).resolves.toBe("paused");
    expect(complete).not.toHaveBeenCalled();
    expect(await store.getGoalRun(goalRun.id)).toMatchObject({ state: "paused", usage: { modelCalls: 0 } });
  });

  it.each(["endpoint", "model", "revision", "disabled"] as const)("pauses before Reviewer completion when its queued Connector has %s drift", async (drift) => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    const task = planTask();
    const { contract, binding } = await approvePlan({ store, goalRun, task });
    const evidenceId = await addCanonicalTaskEvidence(store, binding);
    const job = await reviewJob({ store, goalRun, contractDigest: contract.contractDigest, scope: "task", scopeId: task.id });
    const state = Reflect.get(store, "state") as ReturnType<typeof createSeedSnapshot>;
    const connector = state.modelConnectors.find((candidate) => candidate.id === job.modelConnectorId)!;
    if (drift === "endpoint") connector.baseUrl = `${connector.baseUrl}/changed`;
    if (drift === "model") connector.model = `${connector.model}-changed`;
    if (drift === "revision") connector.revision += 1;
    if (drift === "disabled") connector.enabled = false;
    const complete = vi.fn(async () => ({
      content: JSON.stringify({ verdict: "pass", summary: "This must not run.", evidenceIds: [evidenceId] })
    }));

    await expect(processGoalReview({ store, data: job, jobId: `goal-review-connector-${drift}`, complete }))
      .resolves.toBe("paused");
    expect(complete).not.toHaveBeenCalled();
    expect(await store.getGoalRun(goalRun.id)).toMatchObject({ state: "paused", usage: { modelCalls: 0 } });
  });

  it("pauses without persisting a verdict when its Reviewer Agent is disabled during inference", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    const task = planTask();
    const { contract, binding } = await approvePlan({ store, goalRun, task });
    const evidenceId = await addCanonicalTaskEvidence(store, binding);
    const job = await reviewJob({
      store,
      goalRun,
      contractDigest: contract.contractDigest,
      scope: "task",
      scopeId: task.id
    });
    const complete = vi.fn(async () => {
      const mutableState = Reflect.get(store, "state") as ReturnType<typeof createSeedSnapshot>;
      const reviewer = mutableState.agents.find((candidate) => candidate.id === job.reviewerAgentId)!;
      reviewer.lifecycleStatus = "disabled";
      return {
        content: JSON.stringify({
          verdict: "pass",
          summary: "The Reviewer returned after its authority was revoked.",
          evidenceIds: [evidenceId]
        })
      };
    });

    await expect(processGoalReview({
      store,
      data: job,
      jobId: "goal-review-agent-disabled-during-inference",
      complete
    })).resolves.toBe("paused");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(await store.getGoalRun(goalRun.id)).toMatchObject({ state: "paused", usage: { modelCalls: 1 } });
    expect((await store.getGoalRunDetail(goalRun.id))?.reviewerVerdicts).toHaveLength(0);
  });

  it("revokes an unexecuted Reviewer job when its Meeting participant switches to a non-Reviewer Role", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    const task = planTask();
    const { contract } = await approvePlan({ store, goalRun, task });
    const job = await reviewJob({ store, goalRun, contractDigest: contract.contractDigest, scope: "task", scopeId: task.id });
    const snapshot = await store.getSnapshot();
    const participant = snapshot.participants.find((candidate) => candidate.id === job.reviewerParticipantId)!;
    const replacementRole = snapshot.roles.find((role) => !role.orchestrationFunctions?.includes("reviewer"))!;
    await store.switchParticipantRole(goalRun.meetingId, participant.id, {
      roleId: replacementRole.id,
      expectedRoleRevision: participant.roleRevision,
      reason: "Reviewer authority was explicitly reassigned before execution."
    });
    const complete = vi.fn(async () => ({ content: "{}" }));

    await expect(processGoalReview({
      store,
      data: job,
      jobId: "goal-review-role-revoked",
      complete
    })).resolves.toBe("paused");

    expect(complete).not.toHaveBeenCalled();
    expect(await store.getGoalRun(goalRun.id)).toMatchObject({
      state: "paused",
      terminalReason: expect.stringMatching(/Reviewer execution failed|Role|authorization/i),
      usage: { modelCalls: 0 }
    });
  });

  it("rejects a queued Reviewer after Credential rotation, then admits a fresh binding after Owner resume", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    const executor = (await store.getSnapshot()).agents[0]!;
    const task = planTask({ executionMode: "worker", assigneeAgentId: executor.id });
    const { contract, binding, approved } = await approvePlan({ store, goalRun, task });
    const evidenceId = await addCanonicalTaskEvidence(store, binding);
    await store.updateGoalTaskBinding(binding.id, {
      expectedState: "ready",
      state: "reviewing",
      event: {
        type: "task.state.changed",
        actorType: "system",
        actorId: null,
        entityType: "task",
        entityId: task.id,
        summary: "Execution evidence is ready for immutable Reviewer queue admission."
      }
    });
    const candidate = await reviewJob({ store, goalRun, contractDigest: contract.contractDigest, scope: "task", scopeId: task.id });
    const vault = new SecretVault(Buffer.alloc(32, 9));
    const credential = await bindReviewerCredential({ store, job: candidate, vault });
    const queued: Array<{ job: GoalReviewJobData; jobId: string }> = [];

    await expect(processGoalOrchestrate({
      store,
      jobId: "goal-orchestrate-queued-reviewer-rotation",
      data: {
        goalRunId: goalRun.id,
        expectedRevision: approved.goalRun.revision,
        requestFingerprint: "7".repeat(64),
        requestedBy: "system"
      },
      enqueueReview: async (job, jobId) => {
        queued.push({ job, jobId });
        return { jobId };
      }
    })).resolves.toBe("settled");

    const cloudReview = queued.find(({ job }) => job.modelConnectorId === candidate.modelConnectorId)!;
    expect(cloudReview.job.credentialBinding).toMatchObject({
      credentialId: credential.id,
      secretRevision: credential.secretRevision
    });
    await expect(store.getGoalJobAdmission(cloudReview.jobId)).resolves.toMatchObject({
      state: "admitted",
      requestFingerprint: goalReviewAdmissionFingerprint(cloudReview.job)
    });
    await store.rotateCredential({
      credentialId: credential.id,
      expectedSecretRevision: credential.secretRevision
    }, { ciphertext: vault.encrypt("rotated-after-queue") });
    const complete = vi.fn(async () => ({
      content: JSON.stringify({ verdict: "pass", summary: "This must not run.", evidenceIds: [evidenceId] })
    }));

    await expect(processGoalReview({
      store,
      data: cloudReview.job,
      jobId: cloudReview.jobId,
      secretVault: vault,
      complete
    })).resolves.toBe("paused");
    expect(complete).not.toHaveBeenCalled();
    expect(await store.getGoalRun(goalRun.id)).toMatchObject({ state: "paused", usage: { modelCalls: 0 } });

    const paused = (await store.getGoalRun(goalRun.id))!;
    const resumed = await store.setGoalRunState(goalRun.id, {
      expectedRevision: paused.revision,
      state: "executing",
      event: {
        type: "goal.state.changed",
        actorType: "owner",
        actorId: ownerId,
        entityType: "goal",
        entityId: goalRun.id,
        summary: "Owner resumed Goal after rotating the Reviewer Credential."
      }
    });
    const queuedBeforeResume = queued.length;
    await expect(processGoalOrchestrate({
      store,
      jobId: "goal-orchestrate-requeue-rotated-reviewer",
      data: {
        goalRunId: goalRun.id,
        expectedRevision: resumed.revision,
        requestFingerprint: "b".repeat(64),
        requestedBy: "owner"
      },
      enqueueReview: async (job, jobId) => {
        queued.push({ job, jobId });
        return { jobId };
      }
    })).resolves.toBe("settled");

    const replacement = queued.slice(queuedBeforeResume).find(({ job }) => job.modelConnectorId === candidate.modelConnectorId)!;
    expect(replacement.jobId).not.toBe(cloudReview.jobId);
    expect(replacement.job.credentialBinding).toMatchObject({
      credentialId: credential.id,
      secretRevision: credential.secretRevision + 1
    });
    await expect(store.getGoalJobAdmission(replacement.jobId)).resolves.toMatchObject({ state: "admitted" });
    await expect(processGoalReview({
      store,
      data: replacement.job,
      jobId: replacement.jobId,
      secretVault: vault,
      complete
    })).resolves.toBe("settled");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(await store.getGoalRun(goalRun.id)).toMatchObject({ state: "executing", usage: { modelCalls: 1 } });
  });

  it("uses an active current cloud Reviewer Credential binding", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    const task = planTask();
    const { contract, binding } = await approvePlan({ store, goalRun, task });
    const evidenceId = await addCanonicalTaskEvidence(store, binding);
    let job = await reviewJob({ store, goalRun, contractDigest: contract.contractDigest, scope: "task", scopeId: task.id });
    const vault = new SecretVault(Buffer.alloc(32, 9));
    await bindReviewerCredential({ store, job, vault });
    job = await reviewJob({ store, goalRun, contractDigest: contract.contractDigest, scope: "task", scopeId: task.id });
    const complete = vi.fn(async (request: { apiKey?: string }) => {
      expect(request.apiKey).toBe("reviewer-secret");
      return {
        content: JSON.stringify({ verdict: "pass", summary: "The current cloud Credential is valid.", evidenceIds: [evidenceId] })
      };
    });

    await expect(processGoalReview({
      store,
      data: job,
      jobId: "goal-review-cloud-credential",
      secretVault: vault,
      complete
    })).resolves.toBe("settled");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("allows an active local Reviewer Connector with no Credential", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store);
    const task = planTask();
    const { contract, binding } = await approvePlan({ store, goalRun, task });
    const evidenceId = await addCanonicalTaskEvidence(store, binding);
    const job = await reviewJob({ store, goalRun, contractDigest: contract.contractDigest, scope: "task", scopeId: task.id });
    const complete = vi.fn(async (request: { responseFormat?: string; timeoutMs?: number }) => {
      expect(request.timeoutMs).toBe(180_000);
      expect(request.responseFormat).toBe("json_object");
      return {
        content: JSON.stringify({ verdict: "pass", summary: "Canonical local task evidence is sufficient.", evidenceIds: [evidenceId] })
      };
    });

    await expect(processGoalReview({ store, data: job, jobId: "goal-review-local-no-credential", complete })).resolves.toBe("settled");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("reconciles an asynchronous Harness Action after Adapter recreation without repeating execution", async () => {
    const { store, goalRun } = await createGoal();
    const adapterId = randomUUID();
    const task = planTask({
      executionMode: "action",
      action: {
        adapterId,
        actionKey: "deploy-preview",
        targetId: "pipeline-preview",
        inputs: { branch: "feature/goal-run" },
        riskClass: "ordinary"
      }
    });
    const { contract, binding } = await approvePlan({ store, goalRun, task });
    const adapter: PersistedActionAdapter = {
      id: adapterId,
      name: "Harness preview",
      kind: "harness_pipeline",
      enabled: true,
      baseUrl: "http://127.0.0.1:8999/mcp",
      credentialId: null,
      catalogRevision: 1,
      actions: [{
        key: "deploy-preview",
        displayName: "Deploy preview",
        targetIds: ["pipeline-preview"],
        inputKeys: ["branch"],
        riskClass: "ordinary",
        timeoutMs: 10_000,
        supportsCancellation: true,
        supportsCompensation: true
      }],
      createdAt: now,
      updatedAt: now
    };
    await store.createActionAdapter(adapter);
    const actionRun: ActionRun = {
      id: randomUUID(),
      goalRunId: goalRun.id,
      planTaskId: task.id,
      adapterId,
      adapterCatalogRevision: 1,
      actionKey: "deploy-preview",
      targetId: "pipeline-preview",
      inputs: { branch: "feature/goal-run" },
      state: "approved",
      requestFingerprint: requestFingerprint({
        goalRunId: goalRun.id,
        planTaskId: task.id,
        contractDigest: contract.contractDigest,
        adapterCatalogRevision: 1,
        action: task.action
      }),
      contractDigest: contract.contractDigest,
      externalExecutionId: null,
      verificationSummary: null,
      lastError: null,
      createdAt: now,
      updatedAt: now
    };
    await store.createActionRun(actionRun, {
      type: "action.state.changed",
      actorType: "owner",
      actorId: ownerId,
      entityType: "action",
      entityId: actionRun.id,
      summary: "Action Run approved."
    });
    const runtimeAdapter: RuntimeActionAdapter = {
      catalog: vi.fn(),
      preview: vi.fn(async () => ({ actionId: "deploy-preview:pipeline-preview", targetId: "pipeline-preview", resourceId: "pipeline-preview", requestId: actionRun.id, catalog: { catalogId: adapterId, version: 1, actions: [] }, inputs: actionRun.inputs })),
      execute: vi.fn(async () => ({ actionId: "deploy-preview:pipeline-preview", targetId: "pipeline-preview", resourceId: "pipeline-preview", requestId: actionRun.id, executionId: "external-1", status: "running" as const })),
      verify: vi.fn(async () => ({ actionId: "deploy-preview:pipeline-preview", targetId: "pipeline-preview", resourceId: "pipeline-preview", requestId: actionRun.id, executionId: "external-1", status: "running" as const })),
      status: vi.fn(),
      cancel: vi.fn(),
      compensate: vi.fn()
    };
    const job = {
      goalRunId: goalRun.id,
      planTaskId: task.id,
      actionRunId: actionRun.id,
      contractDigest: contract.contractDigest,
      requestedBy: "system" as const
    };
    await expect(processGoalActionRun({
      store,
      jobId: "goal-action-1",
      data: job,
      createAdapter: async () => runtimeAdapter
    })).resolves.toBe("pending");
    const previewCall = (runtimeAdapter.preview as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    const executeCall = (runtimeAdapter.execute as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    const verifyCall = (runtimeAdapter.verify as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    expect(previewCall).toBeLessThan(executeCall);
    expect(executeCall).toBeLessThan(verifyCall);
    expect(await store.getGoalRun(goalRun.id)).toMatchObject({ state: "executing" });
    expect((await store.getGoalRunDetail(goalRun.id))?.actionRuns[0]).toMatchObject({ state: "running", externalExecutionId: "external-1" });
    expect((await store.getGoalRunDetail(goalRun.id))?.taskBindings.find((item) => item.id === binding.id)).toMatchObject({ state: "running" });

    await expect(processGoalActionRun({
      store,
      jobId: "goal-action-1",
      data: job,
      createAdapter: async () => null
    })).resolves.toBe("pending");
    expect(await store.getGoalRun(goalRun.id)).toMatchObject({ state: "executing" });
    expect((await store.getGoalRunDetail(goalRun.id))?.actionRuns[0]).toMatchObject({
      state: "running",
      externalExecutionId: "external-1"
    });
    expect((await store.getRecoverableGoalJobs()).find((candidate) => candidate.jobId === "goal-action-1"))
      .toMatchObject({ state: "running" });

    const restartedAdapter: RuntimeActionAdapter = {
      catalog: vi.fn(),
      preview: vi.fn(),
      execute: vi.fn(),
      verify: vi.fn(async () => ({
        actionId: "deploy-preview:pipeline-preview",
        targetId: "pipeline-preview",
        resourceId: "pipeline-preview",
        requestId: actionRun.id,
        executionId: "external-1",
        status: "succeeded" as const
      })),
      status: vi.fn(),
      cancel: vi.fn(),
      compensate: vi.fn()
    };
    await expect(processGoalActionRun({
      store,
      jobId: "goal-action-1",
      data: job,
      createAdapter: async () => restartedAdapter
    })).resolves.toBe("succeeded");
    expect(restartedAdapter.preview).not.toHaveBeenCalled();
    expect(restartedAdapter.execute).not.toHaveBeenCalled();
    expect(restartedAdapter.verify).toHaveBeenCalledWith(expect.objectContaining({ executionId: "external-1" }));
    expect((await store.getGoalRunDetail(goalRun.id))?.actionRuns[0]).toMatchObject({ state: "succeeded", externalExecutionId: "external-1" });
    expect((await store.getGoalRunDetail(goalRun.id))?.taskBindings.find((item) => item.id === binding.id)).toMatchObject({ state: "reviewing" });
  });

  it("finishes a persisted second Reviewer verdict after restart without another model call", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store, { maxModelCalls: 2 });
    const executor = (await store.getSnapshot()).agents[0]!;
    const task = planTask({ executionMode: "worker", assigneeAgentId: executor.id });
    const { contract, binding, approved } = await approvePlan({ store, goalRun, task });
    const evidenceId = await addCanonicalTaskEvidence(store, binding);
    await store.updateGoalTaskBinding(binding.id, {
      expectedState: "ready",
      state: "reviewing",
      event: {
        type: "task.state.changed",
        actorType: "system",
        actorId: null,
        entityType: "task",
        entityId: task.id,
        summary: "Execution evidence is ready for review."
      }
    });
    const reviewJobs: Array<{ job: GoalReviewJobData; jobId: string }> = [];
    await processGoalOrchestrate({
      store,
      jobId: "goal-orchestrate-review-crash",
      data: {
        goalRunId: goalRun.id,
        expectedRevision: approved.goalRun.revision,
        requestFingerprint: "5".repeat(64),
        requestedBy: "system"
      },
      enqueueReview: async (job, jobId) => {
        reviewJobs.push({ job, jobId });
        return { jobId };
      }
    });
    expect(reviewJobs).toHaveLength(2);
    const complete = vi.fn(async () => ({
      content: JSON.stringify({
        verdict: "pass",
        summary: "Canonical task evidence satisfies the scoped acceptance criteria.",
        evidenceIds: [evidenceId]
      })
    }));
    await expect(processGoalReview({
      store,
      data: reviewJobs[0]!.job,
      jobId: reviewJobs[0]!.jobId,
      complete
    })).resolves.toBe("settled");

    const second = reviewJobs[1]!;
    await store.setGoalJobState(second.jobId, "admitted", "running");
    await store.addReviewerVerdict({
      id: randomUUID(),
      goalRunId: goalRun.id,
      scope: second.job.scope,
      scopeId: second.job.scopeId,
      reviewerAgentId: second.job.reviewerAgentId,
      reviewerAgentRevision: second.job.reviewerAgentRevision,
      modelConnectorId: second.job.modelConnectorId,
      verdict: "pass",
      summary: "The second Reviewer verdict was committed before Worker restart.",
      evidenceIds: [evidenceId],
      contractDigest: contract.contractDigest,
      reviewJobId: second.jobId,
      reviewRequestFingerprint: goalReviewAdmissionFingerprint(second.job),
      createdAt: now
    }, {
      type: "review.recorded",
      actorType: "agent",
      actorId: second.job.reviewerAgentId,
      entityType: "review",
      entityId: randomUUID(),
      summary: "Second Reviewer verdict committed."
    });
    await store.setGoalJobState(second.jobId, "running", "outcome_unknown");
    const replayModel = vi.fn(async () => {
      throw new Error("Persisted Reviewer verdict must not call the model again.");
    });

    await expect(processGoalReview({
      store,
      data: second.job,
      jobId: second.jobId,
      complete: replayModel
    })).resolves.toBe("completed");
    expect(replayModel).not.toHaveBeenCalled();
    expect((await store.getGoalRunDetail(goalRun.id))?.taskBindings.find((candidate) => candidate.id === binding.id))
      .toMatchObject({ state: "completed", activeJobId: null });
  });

  it("does not reconcile an unknown Reviewer outcome from another admitted job", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store, { maxModelCalls: 2 });
    const executor = (await store.getSnapshot()).agents[0]!;
    const task = planTask({ executionMode: "worker", assigneeAgentId: executor.id });
    const { contract, binding } = await approvePlan({ store, goalRun, task });
    const evidenceId = await addCanonicalTaskEvidence(store, binding);
    await store.updateGoalTaskBinding(binding.id, {
      expectedState: "ready",
      state: "reviewing",
      event: {
        type: "task.state.changed",
        actorType: "system",
        actorId: null,
        entityType: "task",
        entityId: task.id,
        summary: "Execution evidence is ready for exact Reviewer job reconciliation."
      }
    });
    const job = await reviewJob({
      store,
      goalRun,
      contractDigest: contract.contractDigest,
      scope: "task",
      scopeId: task.id
    });
    const currentJobId = "goal-review-current-outcome-unknown";
    const otherJobId = "goal-review-other-durable-verdict";
    await reserveGoalReviewAdmission({ store, data: job, jobId: currentJobId });
    await reserveGoalReviewAdmission({ store, data: job, jobId: otherJobId });
    await store.setGoalJobState(currentJobId, "reserved", "admitted");
    await store.setGoalJobState(currentJobId, "admitted", "running");
    await store.setGoalJobState(currentJobId, "running", "outcome_unknown");
    await store.setGoalJobState(otherJobId, "reserved", "admitted");
    await store.setGoalJobState(otherJobId, "admitted", "running");
    const otherVerdictId = randomUUID();
    await store.addReviewerVerdict({
      id: otherVerdictId,
      goalRunId: goalRun.id,
      scope: job.scope,
      scopeId: job.scopeId,
      reviewerAgentId: job.reviewerAgentId,
      reviewerAgentRevision: job.reviewerAgentRevision,
      modelConnectorId: job.modelConnectorId,
      verdict: "pass",
      summary: "A different admitted Reviewer job produced this durable verdict.",
      evidenceIds: [evidenceId],
      contractDigest: contract.contractDigest,
      reviewJobId: otherJobId,
      reviewRequestFingerprint: goalReviewAdmissionFingerprint(job),
      createdAt: now
    }, {
      type: "review.recorded",
      actorType: "agent",
      actorId: job.reviewerAgentId,
      entityType: "review",
      entityId: otherVerdictId,
      summary: "Another Reviewer job recorded a durable verdict."
    });
    await store.setGoalJobState(otherJobId, "running", "settled");
    const complete = vi.fn(async () => {
      throw new Error("An unknown Reviewer outcome must never be replayed.");
    });

    await expect(processGoalReviewImpl({
      store,
      data: job,
      jobId: currentJobId,
      complete
    })).resolves.toBe("paused");

    expect(complete).not.toHaveBeenCalled();
    expect(await store.getGoalRun(goalRun.id)).toMatchObject({ state: "paused", usage: { modelCalls: 0 } });
    expect(await store.getGoalJobAdmission(currentJobId)).toMatchObject({ state: "outcome_unknown" });
  });

  it("fences Reviewer uncertainty when verdict persistence fails after provider success", async () => {
    const store = createRunnableStore();
    const { goalRun } = await createGoal(store, { maxModelCalls: 4 });
    const executor = (await store.getSnapshot()).agents[0]!;
    const task = planTask({ executionMode: "worker", assigneeAgentId: executor.id });
    const { binding, approved } = await approvePlan({ store, goalRun, task });
    const evidenceId = await addCanonicalTaskEvidence(store, binding);
    await store.updateGoalTaskBinding(binding.id, {
      expectedState: "ready",
      state: "reviewing",
      event: {
        type: "task.state.changed",
        actorType: "system",
        actorId: null,
        entityType: "task",
        entityId: task.id,
        summary: "Execution evidence is ready for fault-injected review."
      }
    });
    const reviewJobs: Array<{ job: GoalReviewJobData; jobId: string }> = [];
    await processGoalOrchestrate({
      store,
      jobId: "goal-orchestrate-review-persistence-failure",
      data: {
        goalRunId: goalRun.id,
        expectedRevision: approved.goalRun.revision,
        requestFingerprint: "6".repeat(64),
        requestedBy: "system"
      },
      enqueueReview: async (job, jobId) => {
        reviewJobs.push({ job, jobId });
        return { jobId };
      }
    });
    const review = reviewJobs[0]!;
    const complete = vi.fn(async () => ({
      content: JSON.stringify({
        verdict: "pass",
        summary: "Provider returned before the injected verdict-store failure.",
        evidenceIds: [evidenceId]
      })
    }));
    vi.spyOn(store, "addReviewerVerdict").mockRejectedValueOnce(new Error("verdict store unavailable"));

    await expect(processGoalReview({
      store,
      data: review.job,
      jobId: review.jobId,
      complete
    })).resolves.toBe("paused");
    await expect(processGoalReview({
      store,
      data: review.job,
      jobId: review.jobId,
      complete
    })).resolves.toBe("paused");

    expect(complete).toHaveBeenCalledTimes(1);
    expect(await store.reserveGoalJob({
      jobId: review.jobId,
      goalRunId: review.job.goalRunId,
      jobName: "goal-review",
      entityId: `${review.job.scope}:${review.job.scopeId}:${review.job.reviewerAgentId}`,
      requestFingerprint: goalReviewAdmissionFingerprint(review.job),
      state: "reserved",
      reservedAt: now,
      admittedAt: null,
      startedAt: null,
      settledAt: null,
      updatedAt: now
    })).toMatchObject({ state: "outcome_unknown" });
    expect(await store.getGoalRun(goalRun.id)).toMatchObject({ state: "paused" });
  });

  it("pauses before runtime Adapter invocation when an immutable Action binding drifts", async () => {
    for (const drift of ["catalog", "endpoint", "credential-revision"] as const) {
      const { store, goalRun } = await createGoal();
      const adapterId = randomUUID();
      const credential = await store.createCredential({
        name: `Action credential ${drift}`, provider: "harness", kind: "bearer_token", location: "local"
      }, { ciphertext: "vault:v1:action-credential" });
      const task = planTask({
        executionMode: "action",
        action: { adapterId, actionKey: "deploy-preview", targetId: "pipeline-preview", inputs: { branch: "feature/goal-run" }, riskClass: "ordinary" }
      });
      const endpoint = "http://127.0.0.1:8999/mcp";
      const { contract } = await approvePlan({
        store, goalRun, task,
        actionBindings: [{
          planTaskId: task.id, adapterId, adapterCatalogRevision: 1, endpointDigest: actionAdapterEndpointDigest(endpoint),
          credentialId: credential.id, credentialSecretRevision: credential.secretRevision
        }]
      });
      const adapter: PersistedActionAdapter = {
        id: adapterId, name: `Harness drift ${drift}`, kind: "harness_pipeline", enabled: true, baseUrl: endpoint,
        credentialId: credential.id, catalogRevision: 1,
        actions: [{ key: "deploy-preview", displayName: "Deploy preview", targetIds: ["pipeline-preview"], inputKeys: ["branch"], riskClass: "ordinary", timeoutMs: 10_000, supportsCancellation: true, supportsCompensation: true }],
        createdAt: now, updatedAt: now
      };
      await store.createActionAdapter(adapter);
      const actionRun: ActionRun = {
        id: randomUUID(), goalRunId: goalRun.id, planTaskId: task.id, adapterId, adapterCatalogRevision: 1,
        actionKey: "deploy-preview", targetId: "pipeline-preview", inputs: { branch: "feature/goal-run" }, state: "approved",
        requestFingerprint: requestFingerprint({
          goalRunId: goalRun.id,
          planTaskId: task.id,
          contractDigest: contract.contractDigest,
          adapterCatalogRevision: 1,
          action: task.action
        }), contractDigest: contract.contractDigest,
        externalExecutionId: null, verificationSummary: null, lastError: null, createdAt: now, updatedAt: now
      };
      await store.createActionRun(actionRun, {
        type: "action.state.changed", actorType: "owner", actorId: ownerId, entityType: "action", entityId: actionRun.id, summary: "Action Run approved."
      });
      const driftStore = Object.create(store) as InMemoryPlatformStore;
      driftStore.listActionAdapters = vi.fn(async () => [
        drift === "catalog" ? { ...adapter, catalogRevision: 2 } : drift === "endpoint" ? { ...adapter, baseUrl: "http://127.0.0.1:9444/mcp" } : adapter
      ]);
      if (drift === "credential-revision") {
        const snapshot = await store.getSnapshot();
        driftStore.getSnapshot = vi.fn(async () => ({
          ...snapshot,
          credentials: snapshot.credentials!.map((item) => item.id === credential.id ? { ...item, secretRevision: item.secretRevision + 1 } : item)
        }));
      }
      const runtimeAdapter: RuntimeActionAdapter = {
        catalog: vi.fn(), preview: vi.fn(), execute: vi.fn(), verify: vi.fn(), status: vi.fn(), cancel: vi.fn(), compensate: vi.fn()
      };
      const createAdapter = vi.fn(async () => runtimeAdapter);

      await expect(processGoalActionRun({
        store: driftStore,
        jobId: `goal-action-drift-${drift}`,
        data: { goalRunId: goalRun.id, planTaskId: task.id, actionRunId: actionRun.id, contractDigest: contract.contractDigest, requestedBy: "system" },
        createAdapter
      })).resolves.toBe("paused");
      expect(createAdapter).not.toHaveBeenCalled();
      expect(runtimeAdapter.preview).not.toHaveBeenCalled();
      expect(runtimeAdapter.execute).not.toHaveBeenCalled();
      expect(await store.getGoalRun(goalRun.id)).toMatchObject({ state: "paused" });
    }
  });

  it("fences Harness execution uncertainty after the effect boundary", async () => {
    const { store, goalRun } = await createGoal();
    const adapterId = randomUUID();
    const task = planTask({
      executionMode: "action",
      action: {
        adapterId,
        actionKey: "deploy-preview",
        targetId: "pipeline-preview",
        inputs: { branch: "feature/goal-run" },
        riskClass: "ordinary"
      }
    });
    const { contract } = await approvePlan({ store, goalRun, task });
    await store.createActionAdapter({
      id: adapterId,
      name: "Harness preview uncertainty",
      kind: "harness_pipeline",
      enabled: true,
      baseUrl: "http://127.0.0.1:8999/mcp",
      credentialId: null,
      catalogRevision: 1,
      actions: [{
        key: "deploy-preview", displayName: "Deploy preview", targetIds: ["pipeline-preview"], inputKeys: ["branch"],
        riskClass: "ordinary", timeoutMs: 10_000, supportsCancellation: true, supportsCompensation: true
      }],
      createdAt: now,
      updatedAt: now
    });
    const actionRun: ActionRun = {
      id: randomUUID(),
      goalRunId: goalRun.id,
      planTaskId: task.id,
      adapterId,
      adapterCatalogRevision: 1,
      actionKey: "deploy-preview",
      targetId: "pipeline-preview",
      inputs: { branch: "feature/goal-run" },
      state: "approved",
      requestFingerprint: requestFingerprint({
        goalRunId: goalRun.id,
        planTaskId: task.id,
        contractDigest: contract.contractDigest,
        adapterCatalogRevision: 1,
        action: task.action
      }),
      contractDigest: contract.contractDigest,
      externalExecutionId: null,
      verificationSummary: null,
      lastError: null,
      createdAt: now,
      updatedAt: now
    };
    await store.createActionRun(actionRun, {
      type: "action.state.changed", actorType: "owner", actorId: ownerId, entityType: "action", entityId: actionRun.id,
      summary: "Action Run approved."
    });
    const runtimeAdapter: RuntimeActionAdapter = {
      catalog: vi.fn(),
      preview: vi.fn(async () => ({ actionId: "deploy-preview:pipeline-preview", targetId: "pipeline-preview", resourceId: "pipeline-preview", requestId: actionRun.id, catalog: { catalogId: adapterId, version: 1, actions: [] }, inputs: actionRun.inputs })),
      execute: vi.fn(async () => { throw new Error("connection dropped after request write"); }),
      verify: vi.fn(),
      status: vi.fn(),
      cancel: vi.fn(),
      compensate: vi.fn()
    };
    await expect(processGoalActionRun({
      store,
      jobId: "goal-action-unknown-1",
      data: { goalRunId: goalRun.id, planTaskId: task.id, actionRunId: actionRun.id, contractDigest: contract.contractDigest, requestedBy: "system" },
      createAdapter: async () => runtimeAdapter
    })).resolves.toBe("paused");
    expect((await store.getGoalRunDetail(goalRun.id))?.actionRuns[0]).toMatchObject({ state: "outcome_unknown" });
    expect(await store.getGoalRun(goalRun.id)).toMatchObject({ state: "paused" });
    expect(runtimeAdapter.execute).toHaveBeenCalledTimes(1);
  });
});
