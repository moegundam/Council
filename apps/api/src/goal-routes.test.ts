import { EventEmitter } from "node:events";
import argon2 from "argon2";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type GoalEvent, type GoalPlannerProvenance, type GoalPlanTask, type GoalRun } from "@council/contracts";
import { InMemoryPlatformStore, roleExecutionSnapshotDigest } from "@council/database";
import { createSeedSnapshot } from "@council/database/seed";
import { actionAdapterEndpointDigest, goalPlanDigest } from "@council/domain";
import { createApp } from "./app.js";
import { registerGoalRoutes } from "./routes/goal-routes.js";

const origin = "https://council.test";
const ownerPassword = "correct horse battery staple";

function configureReviewQuorum(seed: ReturnType<typeof createSeedSnapshot>) {
  const connectorIds = [
    "c0000000-0000-4000-8000-000000000091",
    "c0000000-0000-4000-8000-000000000092",
    "c0000000-0000-4000-8000-000000000093",
    "c0000000-0000-4000-8000-000000000094"
  ];
  seed.modelConnectors = connectorIds.map((id, index) => ({
    id, revision: 1, name: `Reviewer connector ${index + 1}`, location: "local" as const,
    baseUrl: `http://127.0.0.1:${4000 + index}/v1`, model: `reviewer-model-${index + 1}`,
    enabled: true, hasSecret: false, secretRevision: 0
  }));
  const reviewerRole = seed.roles.find((role) => role.templateKey === "security_reviewer")!;
  reviewerRole.orchestrationFunctions = ["reviewer"];
  const extraReviewerId = "50000000-0000-4000-8000-000000000004";
  const reviewer = seed.participants.find((participant) => participant.roleId === reviewerRole.id)!;
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
}

async function ownerSession(app: Awaited<ReturnType<typeof createApp>>, store: InMemoryPlatformStore) {
  await store.createOwner("goal-owner@example.com", await argon2.hash(ownerPassword, { type: argon2.argon2id }));
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "goal-owner@example.com", password: ownerPassword }
  });
  expect(login.statusCode).toBe(200);
  return login.cookies.find((entry) => entry.name === "council_session")!.value;
}

async function plannerProvenanceForMeeting(
  store: InMemoryPlatformStore,
  meetingId: string
): Promise<GoalPlannerProvenance> {
  const snapshot = await store.getSnapshot();
  const participant = snapshot.participants.find((candidate) => (
    candidate.meetingId === meetingId
    && candidate.roleSnapshot.orchestrationFunctions.includes("planner")
  ))!;
  const agent = snapshot.agents.find((candidate) => candidate.id === participant.agentId)!;
  const revision = await store.getAgentRevision(agent.id, participant.agentRevision ?? agent.publishedRevision!);
  const roleHistory = participant.roleHistory.find((entry) => entry.revision === participant.roleRevision)!;
  return {
    plannerParticipantId: participant.id,
    plannerAgentId: agent.id,
    plannerAgentRevision: revision.revision,
    plannerModelConnectorId: revision.modelConnectorId!,
    plannerRoleId: roleHistory.roleId,
    plannerRoleRevision: roleHistory.revision,
    plannerRoleSnapshotDigest: roleExecutionSnapshotDigest(roleHistory.roleSnapshot)
  };
}

async function createActionApprovalFixture(
  withActiveCredential: boolean,
  actionAdapterRuntime: { enabled: boolean; check: (adapterIds: readonly string[]) => Promise<void> } = { enabled: true, check: async () => undefined },
  harnessActionAdapterEndpointAllowlist = ["http://127.0.0.1:8999/mcp"],
  includePlannerProvenance = true
) {
  const seed = createSeedSnapshot();
  configureReviewQuorum(seed);
  const store = new InMemoryPlatformStore(seed);
  const meeting = (await store.getSnapshot()).meetings[0]!;
  const run: GoalRun = {
    id: crypto.randomUUID(),
    title: "Immutable Action approval",
    goal: "Approve a version-pinned external Action.",
    threadId: meeting.threadId,
    meetingId: meeting.id,
    state: "planning",
    revision: 1,
    activePlanRevision: 0,
    executionContractId: null,
    limits: { discussionRounds: 3, maxTasks: 12, maxConcurrentTasks: 2, maxAttemptsPerTask: 3, maxReplans: 2, maxDurationMinutes: 120, maxModelCalls: 60, maxActionCalls: 30 },
    usage: { discussionRounds: 0, taskAttempts: 0, replans: 0, modelCalls: 0, actionCalls: 0 },
    deadlineAt: "2026-08-28T00:00:00.000Z",
    pausedFromState: null,
    terminalReason: null,
    createdBy: "90000000-0000-4000-8000-000000000010",
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z"
  };
  await store.createGoalRun(run, {
    type: "goal.created", actorType: "system", actorId: null, entityType: "goal", entityId: run.id, summary: "Created."
  }, `goal-action-approval:${run.id}`);
  const decision = await store.createDecision({ meetingId: meeting.id, title: "Deploy the reviewed preview", description: "Use the configured external deployment Action." });
  const adapterId = crypto.randomUUID();
  const task: GoalPlanTask = {
    id: crypto.randomUUID(), decisionId: decision.id, title: decision.title, description: decision.description,
    acceptanceCriteria: "The preview deployment is independently verified.", dependencyIds: [], assigneeAgentId: null,
    executionMode: "action", allowedTools: [], dataScope: "Meeting-approved deployment inputs only.",
    action: { adapterId, actionKey: "deploy-preview", targetId: "pipeline-preview", inputs: { branch: "feature/goal-run" }, riskClass: "ordinary" }
  };
  const plan = {
    id: crypto.randomUUID(), goalRunId: run.id, revision: 1, status: "draft" as const,
    digest: goalPlanDigest([task]), tasks: [task],
    ...(includePlannerProvenance ? { plannerProvenance: await plannerProvenanceForMeeting(store, meeting.id) } : {}),
    createdAt: "2026-08-27T00:00:00.000Z"
  };
  const planned = await store.saveGoalPlan(run.id, {
    expectedRevision: 1, expectedPlanRevision: 0, plan,
    event: { type: "plan.created", actorType: "system", actorId: null, entityType: "plan", entityId: plan.id, summary: "Action Plan created." }
  });
  const credential = withActiveCredential ? await store.createCredential({
    name: `Action credential ${run.id}`, provider: "harness", kind: "bearer_token", location: "local"
  }, { ciphertext: "vault:v1:action-credential" }) : null;
  await store.createActionAdapter({
    id: adapterId, name: `Action adapter ${run.id}`, kind: "harness_pipeline", enabled: true,
    baseUrl: "http://127.0.0.1:8999/mcp", credentialId: credential?.id ?? null, catalogRevision: 7,
    actions: [{ key: "deploy-preview", displayName: "Deploy preview", targetIds: ["pipeline-preview"], inputKeys: ["branch"], riskClass: "ordinary", timeoutMs: 10_000, supportsCancellation: true, supportsCompensation: true }],
    createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z"
  });
  const queue = { enqueueGoalOrchestrate: vi.fn(async (_job, requestedJobId: string) => ({ jobId: requestedJobId })), close: vi.fn(async () => undefined) };
  const app = await createApp({
    store,
    authDisabled: false,
    secureCookies: false,
    allowedOrigin: origin,
    agentQueue: queue as never,
    actionAdapterRuntime,
    harnessActionAdapterEndpointAllowlist
  });
  return { app, credential, plan, planned, queue, run, session: await ownerSession(app, store), store, task };
}

describe("Goal Run API", () => {
  afterEach(() => vi.useRealTimers());

  it("fails closed when the Goal Run autonomy feature flag is disabled", async () => {
    const app = await createApp({ store: new InMemoryPlatformStore(), authDisabled: true, goalRunEnabled: false });
    const response = await app.inject({ method: "GET", url: "/api/v1/goal-runs" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "FEATURE_DISABLED" } });
    await app.close();
  });

  it("creates a canonical Topic and Meeting, records durable events, then admits orchestration", async () => {
    const seed = createSeedSnapshot();
    configureReviewQuorum(seed);
    const store = new InMemoryPlatformStore(seed);
    const createGoalRun = vi.spyOn(store, "createGoalRun");
    const queue = { enqueueGoalOrchestrate: vi.fn(async (_job, requestedJobId: string) => ({ jobId: requestedJobId })), close: vi.fn(async () => undefined) };
    const app = await createApp({ store, authDisabled: false, secureCookies: false, allowedOrigin: origin, agentQueue: queue as never });
    const session = await ownerSession(app, store);
    const categoryId = (await store.getSnapshot()).categories[0]!.id;

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/goal-runs",
      headers: { origin, "idempotency-key": "goal-run-create-1" },
      cookies: { council_session: session },
      payload: {
        goal: "Produce a reviewed plan for the autonomous multi-agent meeting platform.",
        categoryId,
        tagIds: []
      }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ goalRun: GoalRun; meeting: { id: string }; jobId: string }>();
    expect(body.goalRun.threadId).toEqual(expect.any(String));
    expect(body.goalRun.meetingId).toBe(body.meeting.id);
    expect(body.meeting).toMatchObject({ state: "active", startedAt: expect.any(String) });
    expect(queue.enqueueGoalOrchestrate).toHaveBeenCalledWith(
      expect.objectContaining({ goalRunId: body.goalRun.id, expectedRevision: 1, requestedBy: "owner" }),
      body.jobId
    );
    expect(createGoalRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: body.goalRun.id }),
      expect.objectContaining({ type: "goal.created" }),
      "goal-run-create-1",
      expect.objectContaining({
        jobId: body.jobId,
        goalRunId: body.goalRun.id,
        jobName: "goal-orchestrate",
        state: "reserved"
      })
    );
    expect(await store.getGoalEvents(body.goalRun.id, 0, 10)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "goal.created" }),
      expect.objectContaining({ type: "meeting.linked", entityId: body.meeting.id })
    ]));
    await expect(store.getRecoverableGoalJobs()).resolves.toEqual([
      expect.objectContaining({ jobId: body.jobId, state: "admitted" })
    ]);
    await app.close();
  });

  it("pins the canonical Meeting Planner when the Owner creates the first reviewable Plan", async () => {
    const seed = createSeedSnapshot();
    configureReviewQuorum(seed);
    const store = new InMemoryPlatformStore(seed);
    const queue = {
      enqueueGoalOrchestrate: vi.fn(async (_job, requestedJobId: string) => ({ jobId: requestedJobId })),
      close: vi.fn(async () => undefined)
    };
    const app = await createApp({
      store,
      authDisabled: false,
      secureCookies: false,
      allowedOrigin: origin,
      agentQueue: queue as never
    });
    const session = await ownerSession(app, store);
    const categoryId = (await store.getSnapshot()).categories[0]!.id;
    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/v1/goal-runs",
      headers: { origin, "idempotency-key": "goal-owner-initial-plan" },
      cookies: { council_session: session },
      payload: {
        title: "Owner reviewable Plan",
        goal: "Retain Planner responsibility while the Owner edits the first Plan.",
        categoryId,
        tagIds: []
      }
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json<{ goalRun: GoalRun }>().goalRun;
    const decision = await store.createDecision({
      meetingId: created.meetingId,
      title: "Keep Planner responsibility attributable",
      description: "The Owner edit and assigned Planner revision must both remain visible."
    });
    const task: GoalPlanTask = {
      id: crypto.randomUUID(),
      decisionId: decision.id,
      title: decision.title,
      description: decision.description,
      acceptanceCriteria: "The first Plan pins the canonical Meeting Planner revision and connector.",
      dependencyIds: [],
      assigneeAgentId: null,
      executionMode: "manual",
      allowedTools: [],
      dataScope: "Canonical Meeting Decision only.",
      action: null
    };

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/goal-runs/${created.id}/plan`,
      headers: { origin },
      cookies: { council_session: session },
      payload: { expectedPlanRevision: 0, tasks: [task] }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      plans: Array<{ plannerProvenance?: GoalPlannerProvenance }>;
      events: Array<{ type: string; actorType: string; actorId: string | null }>;
    }>();
    expect(body.plans[0]?.plannerProvenance).toEqual(
      await plannerProvenanceForMeeting(store, created.meetingId)
    );
    expect(body.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "plan.created", actorType: "owner", actorId: expect.any(String) })
    ]));
    await app.close();
  });

  it("retries Goal creation after the canonical Meeting was activated but Goal persistence failed", async () => {
    const seed = createSeedSnapshot();
    configureReviewQuorum(seed);
    const store = new InMemoryPlatformStore(seed);
    vi.spyOn(store, "createGoalRun").mockRejectedValueOnce(new Error("simulated persistence interruption"));
    const queue = { enqueueGoalOrchestrate: vi.fn(async (_job, requestedJobId: string) => ({ jobId: requestedJobId })), close: vi.fn(async () => undefined) };
    const app = await createApp({ store, authDisabled: false, secureCookies: false, allowedOrigin: origin, agentQueue: queue as never });
    const session = await ownerSession(app, store);
    const categoryId = (await store.getSnapshot()).categories[0]!.id;
    const request = {
      method: "POST" as const,
      url: "/api/v1/goal-runs",
      headers: { origin, "idempotency-key": "goal-run-create-recovery" },
      cookies: { council_session: session },
      payload: { goal: "Resume an interrupted canonical Goal creation.", categoryId, tagIds: [] }
    };

    const interrupted = await app.inject(request);
    expect(interrupted.statusCode).toBe(500);
    expect(queue.enqueueGoalOrchestrate).not.toHaveBeenCalled();
    expect((await store.getSnapshot()).meetings.filter((meeting) => meeting.title === "Resume an interrupted canonical Goal creation.")).toEqual([
      expect.objectContaining({ state: "active" })
    ]);

    const retried = await app.inject(request);
    expect(retried.statusCode).toBe(201);
    expect(retried.json()).toMatchObject({ goalRun: { state: "planning" }, meeting: { state: "active" } });
    expect(queue.enqueueGoalOrchestrate).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("creates separate Chair and Planner participants when Role capabilities are split", async () => {
    const seed = createSeedSnapshot();
    configureReviewQuorum(seed);
    const chairRole = seed.roles.find((role) => role.templateKey === "meeting_chair")!;
    chairRole.orchestrationFunctions = ["chair"];
    const connectorId = "c0000000-0000-4000-8000-000000000099";
    const agentId = "50000000-0000-4000-8000-000000000099";
    seed.modelConnectors.push({
      id: connectorId, revision: 1, name: "Planner connector", location: "local", baseUrl: "http://127.0.0.1:4099/v1",
      model: "planner-model", enabled: true, hasSecret: false, secretRevision: 0
    });
    seed.agents.push({ ...structuredClone(seed.agents[0]!), id: agentId, name: "Dedicated Planner", modelConnectorId: connectorId });
    const store = new InMemoryPlatformStore(seed);
    const queue = { enqueueGoalOrchestrate: vi.fn(async (_job, requestedJobId: string) => ({ jobId: requestedJobId })), close: vi.fn(async () => undefined) };
    const app = await createApp({ store, authDisabled: false, secureCookies: false, allowedOrigin: origin, agentQueue: queue as never });
    const session = await ownerSession(app, store);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/goal-runs",
      headers: { origin, "idempotency-key": "goal-run-split-chair-planner" },
      cookies: { council_session: session },
      payload: { goal: "Use distinct Chair and Planner roles.", categoryId: (await store.getSnapshot()).categories[0]!.id, tagIds: [] }
    });

    expect(response.statusCode).toBe(201);
    const meetingId = response.json<{ meeting: { id: string } }>().meeting.id;
    const participants = (await store.getSnapshot()).participants.filter((participant) => participant.meetingId === meetingId);
    const chair = participants.find((participant) => participant.isChair)!;
    const planner = participants.find((participant) => !participant.isChair && participant.roleSnapshot.orchestrationFunctions.includes("planner"))!;
    expect(chair.roleSnapshot.orchestrationFunctions).toContain("chair");
    expect(chair.roleSnapshot.orchestrationFunctions).not.toContain("planner");
    expect(planner.agentId).not.toBe(chair.agentId);
    await app.close();
  });

  it("rejects the currently allowed two-Agent autonomous Meeting before it can enter execution", async () => {
    const seed = createSeedSnapshot();
    seed.modelConnectors = [
      { id: "c0000000-0000-4000-8000-000000000095", revision: 1, name: "Local A", location: "local", baseUrl: "http://127.0.0.1:4010/v1", model: "local-a", enabled: true, hasSecret: false, secretRevision: 0 },
      { id: "c0000000-0000-4000-8000-000000000096", revision: 1, name: "Local B", location: "local", baseUrl: "http://127.0.0.1:4011/v1", model: "local-b", enabled: true, hasSecret: false, secretRevision: 0 }
    ];
    seed.agents = seed.agents.slice(0, 2);
    seed.agents.forEach((agent, index) => {
      agent.modelConnectorId = seed.modelConnectors[index]!.id;
      agent.status = "online";
    });
    const store = new InMemoryPlatformStore(seed);
    const queue = { enqueueGoalOrchestrate: vi.fn(async (_job, requestedJobId: string) => ({ jobId: requestedJobId })), close: vi.fn(async () => undefined) };
    const app = await createApp({ store, authDisabled: false, secureCookies: false, allowedOrigin: origin, agentQueue: queue as never });
    const session = await ownerSession(app, store);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/goal-runs",
      headers: { origin, "idempotency-key": "goal-run-two-agent-team" },
      cookies: { council_session: session },
      payload: { goal: "Attempt an under-provisioned autonomous Goal.", categoryId: (await store.getSnapshot()).categories[0]!.id, tagIds: [] }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "GOAL_TEAM_UNAVAILABLE" } });
    expect(queue.enqueueGoalOrchestrate).not.toHaveBeenCalled();
    await app.close();
  });

  it("records an Owner instruction in the canonical Meeting transcript and Goal activity", async () => {
    const store = new InMemoryPlatformStore();
    const meeting = (await store.getSnapshot()).meetings[0]!;
    if (meeting.state === "draft") await store.setMeetingState(meeting.id, "active", "draft");
    const run: GoalRun = {
      id: crypto.randomUUID(),
      title: "Owner instruction",
      goal: "Keep the canonical Meeting record authoritative.",
      threadId: meeting.threadId,
      meetingId: meeting.id,
      state: "planning",
      revision: 1,
      activePlanRevision: 0,
      executionContractId: null,
      limits: { discussionRounds: 3, maxTasks: 12, maxConcurrentTasks: 2, maxAttemptsPerTask: 3, maxReplans: 2, maxDurationMinutes: 120, maxModelCalls: 60, maxActionCalls: 30 },
      usage: { discussionRounds: 0, taskAttempts: 0, replans: 0, modelCalls: 0, actionCalls: 0 },
      deadlineAt: "2026-08-28T00:00:00.000Z",
      pausedFromState: null,
      terminalReason: null,
      createdBy: crypto.randomUUID(),
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z"
    };
    await store.createGoalRun(run, {
      type: "goal.created", actorType: "system", actorId: null, entityType: "goal", entityId: run.id, summary: "Created."
    }, `goal-message:${run.id}`);
    const app = await createApp({ store, authDisabled: false, secureCookies: false, allowedOrigin: origin });
    const session = await ownerSession(app, store);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/goal-runs/${run.id}/messages`,
      headers: { origin },
      cookies: { council_session: session },
      payload: { expectedRevision: 1, content: "Prioritize the evidence package before external execution." }
    });

    expect(response.statusCode).toBe(201);
    const event = response.json<GoalEvent>();
    const utterance = (await store.getSnapshot()).utterances.find((candidate) => candidate.id === event.entityId);
    expect(utterance).toMatchObject({
      meetingId: meeting.id,
      speakerType: "human",
      speakerName: "Owner",
      roleName: "決策者",
      kind: "human",
      content: "Prioritize the evidence package before external execution."
    });
    expect(event).toMatchObject({
      type: "owner.message",
      actorType: "owner",
      actorId: expect.any(String),
      entityType: "meeting",
      entityId: utterance?.id,
      detail: expect.objectContaining({ meetingId: meeting.id, utteranceId: utterance?.id })
    });
    expect(await store.getGoalEvents(run.id, 0, 10)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: event.id, entityId: utterance?.id })
    ]));
    await app.close();
  });

  it("requires an attributable Owner session to approve even when development authentication bypass is enabled", async () => {
    const store = new InMemoryPlatformStore();
    const runId = "90000000-0000-4000-8000-000000000001";
    const task: GoalPlanTask = {
      id: "90000000-0000-4000-8000-000000000002",
      decisionId: "90000000-0000-4000-8000-000000000004",
      title: "Review",
      description: "",
      acceptanceCriteria: "Evidence is recorded.",
      dependencyIds: [],
      assigneeAgentId: null,
      executionMode: "manual",
      allowedTools: [],
      dataScope: "Meeting evidence only.",
      action: null
    };
    const run: GoalRun = {
      id: runId,
      title: "Owner approval gate",
      goal: "Verify the approval boundary.",
      threadId: "40000000-0000-4000-8000-000000000001",
      meetingId: "80000000-0000-4000-8000-000000000001",
      state: "planning",
      revision: 1,
      activePlanRevision: 0,
      executionContractId: null,
      limits: { discussionRounds: 3, maxTasks: 12, maxConcurrentTasks: 2, maxAttemptsPerTask: 3, maxReplans: 2, maxDurationMinutes: 120, maxModelCalls: 60, maxActionCalls: 30 },
      usage: { discussionRounds: 0, taskAttempts: 0, replans: 0, modelCalls: 0, actionCalls: 0 },
      deadlineAt: "2026-08-28T00:00:00.000Z",
      pausedFromState: null,
      terminalReason: null,
      createdBy: "90000000-0000-4000-8000-000000000010",
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z"
    };
    await store.createGoalRun(run, {
      type: "goal.created", actorType: "system", actorId: null, entityType: "goal", entityId: runId, summary: "Created."
    }, "goal-approval-gate");
    const decision = await store.createDecision({
      meetingId: run.meetingId,
      title: task.title,
      description: task.acceptanceCriteria
    });
    task.decisionId = decision.id;
    await store.saveGoalPlan(runId, {
      expectedRevision: 1,
      expectedPlanRevision: 0,
      plan: { id: "90000000-0000-4000-8000-000000000003", goalRunId: runId, revision: 1, status: "draft", digest: goalPlanDigest([task]), tasks: [task], createdAt: "2026-08-27T00:00:00.000Z" },
      event: { type: "plan.created", actorType: "system", actorId: null, entityType: "plan", entityId: "90000000-0000-4000-8000-000000000003", summary: "Plan created." }
    });
    const app = await createApp({ store, authDisabled: true });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/goal-runs/${runId}/approve`,
      payload: { expectedRevision: 2, expectedPlanRevision: 1, expectedPlanDigest: goalPlanDigest([task]) }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "OWNER_SESSION_REQUIRED" } });
    await app.close();
  });

  it("rejects Action approval when its Adapter has no active versioned Credential", async () => {
    const fixture = await createActionApprovalFixture(false);
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/goal-runs/${fixture.run.id}/approve`,
      headers: { origin },
      cookies: { council_session: fixture.session },
      payload: { expectedRevision: fixture.planned.goalRun.revision, expectedPlanRevision: 1, expectedPlanDigest: fixture.plan.digest }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "ACTION_CREDENTIAL_UNAVAILABLE" } });
    expect(await fixture.store.getGoalRun(fixture.run.id)).toMatchObject({ state: "awaiting_approval", executionContractId: null });
    await fixture.app.close();
  });

  it("rejects approval before committing execution when Planner provenance is absent", async () => {
    const fixture = await createActionApprovalFixture(true, { enabled: true, check: async () => undefined }, ["http://127.0.0.1:8999/mcp"], false);
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/goal-runs/${fixture.run.id}/approve`,
      headers: { origin },
      cookies: { council_session: fixture.session },
      payload: {
        expectedRevision: fixture.planned.goalRun.revision,
        expectedPlanRevision: fixture.plan.revision,
        expectedPlanDigest: fixture.plan.digest
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "GOAL_PLANNER_PROVENANCE_REQUIRED" } });
    expect(await fixture.store.getGoalRun(fixture.run.id)).toMatchObject({
      state: "awaiting_approval",
      executionContractId: null
    });
    await fixture.app.close();
  });

  it("rejects Action approval before creating an immutable contract when the Worker Harness runtime is disabled", async () => {
    const fixture = await createActionApprovalFixture(false, { enabled: false, check: async () => undefined });
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/goal-runs/${fixture.run.id}/approve`,
      headers: { origin },
      cookies: { council_session: fixture.session },
      payload: { expectedRevision: fixture.planned.goalRun.revision, expectedPlanRevision: 1, expectedPlanDigest: fixture.plan.digest }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "ACTION_ADAPTER_RUNTIME_DISABLED" } });
    expect(await fixture.store.getGoalRun(fixture.run.id)).toMatchObject({ executionContractId: null });
    await fixture.app.close();
  });

  it("rejects Action approval before creating an immutable contract when the Worker Harness runtime is unavailable", async () => {
    const fixture = await createActionApprovalFixture(true, {
      enabled: true,
      check: async () => { throw new Error("Worker Harness readiness failed"); }
    });
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/goal-runs/${fixture.run.id}/approve`,
      headers: { origin },
      cookies: { council_session: fixture.session },
      payload: { expectedRevision: fixture.planned.goalRun.revision, expectedPlanRevision: 1, expectedPlanDigest: fixture.plan.digest }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "ACTION_ADAPTER_RUNTIME_UNAVAILABLE" } });
    expect(await fixture.store.getGoalRun(fixture.run.id)).toMatchObject({ executionContractId: null });
    await fixture.app.close();
  });

  it("rejects Action approval before creating an immutable contract when the Adapter endpoint is not operator-approved", async () => {
    const fixture = await createActionApprovalFixture(true, { enabled: true, check: async () => undefined }, []);
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/goal-runs/${fixture.run.id}/approve`,
      headers: { origin },
      cookies: { council_session: fixture.session },
      payload: { expectedRevision: fixture.planned.goalRun.revision, expectedPlanRevision: 1, expectedPlanDigest: fixture.plan.digest }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "ACTION_ADAPTER_ENDPOINT_UNAPPROVED" } });
    expect(await fixture.store.getGoalRun(fixture.run.id)).toMatchObject({ executionContractId: null });
    await fixture.app.close();
  });

  it("pins the Action Adapter catalog, endpoint, and active Credential revision into the approved contract", async () => {
    const check = vi.fn(async () => undefined);
    const fixture = await createActionApprovalFixture(true, { enabled: true, check });
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/goal-runs/${fixture.run.id}/approve`,
      headers: { origin },
      cookies: { council_session: fixture.session },
      payload: { expectedRevision: fixture.planned.goalRun.revision, expectedPlanRevision: 1, expectedPlanDigest: fixture.plan.digest }
    });

    expect(response.statusCode).toBe(200);
    const approved = response.json<{ executionContract: { actionBindings: Array<Record<string, unknown>> } }>();
    expect(approved.executionContract.actionBindings).toEqual([expect.objectContaining({
      planTaskId: fixture.task.id,
      adapterCatalogRevision: 7,
      endpointDigest: actionAdapterEndpointDigest("http://127.0.0.1:8999/mcp"),
      credentialId: fixture.credential!.id,
      credentialSecretRevision: fixture.credential!.secretRevision
    })]);
    expect(check).toHaveBeenCalledWith([fixture.task.action!.adapterId]);
    await fixture.app.close();
  });

  it("atomically approves the Meeting Decision, binds its canonical Task, and queues approval and resume orchestration", async () => {
    const seed = createSeedSnapshot();
    configureReviewQuorum(seed);
    const store = new InMemoryPlatformStore(seed);
    const snapshot = await store.getSnapshot();
    const meeting = snapshot.meetings[0]!;
    const runId = "90000000-0000-4000-8000-000000000021";
    const run: GoalRun = {
      id: runId,
      title: "Canonical approval and resume",
      goal: "Approve a formal Meeting Decision and continue its autonomous execution.",
      threadId: meeting.threadId,
      meetingId: meeting.id,
      state: "planning",
      revision: 1,
      activePlanRevision: 0,
      executionContractId: null,
      limits: { discussionRounds: 3, maxTasks: 12, maxConcurrentTasks: 2, maxAttemptsPerTask: 3, maxReplans: 2, maxDurationMinutes: 120, maxModelCalls: 60, maxActionCalls: 30 },
      usage: { discussionRounds: 0, taskAttempts: 0, replans: 0, modelCalls: 0, actionCalls: 0 },
      deadlineAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      pausedFromState: null,
      terminalReason: null,
      createdBy: "90000000-0000-4000-8000-000000000022",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await store.createGoalRun(run, {
      type: "goal.created", actorType: "system", actorId: null, entityType: "goal", entityId: runId, summary: "Created."
    }, "goal-canonical-approval");
    const decision = await store.createDecision({
      meetingId: meeting.id,
      title: "Create the canonical execution Task",
      description: "The Task must retain its Decision and Meeting lineage."
    });
    const task: GoalPlanTask = {
      id: "90000000-0000-4000-8000-000000000023",
      decisionId: decision.id,
      title: decision.title,
      description: decision.description,
      acceptanceCriteria: "The canonical Task is bound and execution can resume.",
      dependencyIds: [],
      assigneeAgentId: null,
      executionMode: "manual",
      allowedTools: [],
      dataScope: "Meeting Decision only.",
      action: null
    };
    const planDigest = goalPlanDigest([task]);
    await store.saveGoalPlan(runId, {
      expectedRevision: 1,
      expectedPlanRevision: 0,
      plan: {
        id: "90000000-0000-4000-8000-000000000024",
        goalRunId: runId,
        revision: 1,
        status: "draft",
        digest: planDigest,
        tasks: [task],
        plannerProvenance: await plannerProvenanceForMeeting(store, meeting.id),
        createdAt: new Date().toISOString()
      },
      event: { type: "plan.created", actorType: "system", actorId: null, entityType: "plan", entityId: runId, summary: "Plan created." }
    });
    const queue = {
      enqueueGoalOrchestrate: vi.fn(async (_job, requestedJobId: string) => ({ jobId: requestedJobId })),
      close: vi.fn(async () => undefined)
    };
    const approveGoalRun = vi.spyOn(store, "approveGoalRun");
    const setGoalRunState = vi.spyOn(store, "setGoalRunState");
    const app = await createApp({ store, authDisabled: false, secureCookies: false, allowedOrigin: origin, agentQueue: queue as never });
    const session = await ownerSession(app, store);

    const approvalRequest = {
      method: "POST",
      url: `/api/v1/goal-runs/${runId}/approve`,
      headers: { origin },
      cookies: { council_session: session },
      payload: { expectedRevision: 2, expectedPlanRevision: 1, expectedPlanDigest: planDigest }
    } as const;
    queue.enqueueGoalOrchestrate.mockRejectedValueOnce(new Error("Redis reply was interrupted"));
    const interruptedApproval = await app.inject(approvalRequest);
    expect(interruptedApproval.statusCode).toBe(500);
    expect(await store.getGoalRun(runId)).toMatchObject({ state: "executing", revision: 3 });
    const approvalJobId = queue.enqueueGoalOrchestrate.mock.calls[0]?.[1];
    expect(approvalJobId).toEqual(expect.any(String));
    const pendingApprovalDispatch = await store.getGoalJobAdmission(approvalJobId!);
    expect(pendingApprovalDispatch).toMatchObject({ state: "dispatching", dispatchToken: expect.any(String) });

    const pendingApprovalReplays = await Promise.all([
      app.inject(approvalRequest),
      app.inject(approvalRequest)
    ]);
    expect(pendingApprovalReplays.map((response) => response.statusCode)).toEqual([503, 503]);
    expect(pendingApprovalReplays.map((response) => response.json())).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: "GOAL_JOB_DISPATCH_PENDING" }) }),
      expect.objectContaining({ error: expect.objectContaining({ code: "GOAL_JOB_DISPATCH_PENDING" }) })
    ]);
    expect(queue.enqueueGoalOrchestrate).toHaveBeenCalledTimes(1);
    await store.completeGoalJobDispatch(approvalJobId!, pendingApprovalDispatch!.dispatchToken!);

    const [approval, concurrentApprovalReplay] = await Promise.all([
      app.inject(approvalRequest),
      app.inject(approvalRequest)
    ]);

    expect(approval.statusCode).toBe(200);
    expect(concurrentApprovalReplay.statusCode).toBe(200);
    const approved = approval.json<{ goalRun: GoalRun; taskBindings: Array<{ taskId: string | null }>; executionContract: { contractDigest: string }; jobId: string }>();
    expect(concurrentApprovalReplay.json()).toMatchObject({ jobId: approved.jobId });
    expect(approved.goalRun).toMatchObject({ state: "executing", revision: 3 });
    expect(approved.taskBindings[0]?.taskId).toEqual(expect.any(String));
    expect(queue.enqueueGoalOrchestrate).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ goalRunId: runId, expectedRevision: 3, requestedBy: "owner" }),
      approved.jobId
    );
    expect(queue.enqueueGoalOrchestrate).toHaveBeenCalledTimes(1);
    expect(approveGoalRun).toHaveBeenCalledWith(runId, expect.objectContaining({
      orchestrationAdmission: expect.objectContaining({
        jobId: approved.jobId,
        goalRunId: runId,
        jobName: "goal-orchestrate",
        entityId: runId,
        state: "reserved"
      })
    }));
    const approvedSnapshot = await store.getSnapshot();
    expect(approvedSnapshot.decisions.find((candidate) => candidate.id === decision.id)?.status).toBe("approved");
    expect(approvedSnapshot.tasks.find((candidate) => candidate.id === approved.taskBindings[0]?.taskId)).toMatchObject({
      meetingId: meeting.id,
      decisionId: decision.id,
      executionProfile: "manual"
    });

    const paused = await app.inject({
      method: "POST",
      url: `/api/v1/goal-runs/${runId}/pause`,
      headers: { origin },
      cookies: { council_session: session },
      payload: { expectedRevision: 3 }
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ state: "paused", revision: 4, pausedFromState: "executing" });

    const resumed = await app.inject({
      method: "POST",
      url: `/api/v1/goal-runs/${runId}/resume`,
      headers: { origin },
      cookies: { council_session: session },
      payload: { expectedRevision: 4 }
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ state: "executing", revision: 5, pausedFromState: null });
    expect(queue.enqueueGoalOrchestrate).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ goalRunId: runId, expectedRevision: 5, requestedBy: "owner" }),
      expect.not.stringContaining(approved.jobId)
    );
    expect(setGoalRunState.mock.calls.find(([, mutation]) => mutation.state === "executing")?.[1])
      .toEqual(expect.objectContaining({
        orchestrationAdmission: expect.objectContaining({
          goalRunId: runId,
          jobName: "goal-orchestrate",
          state: "reserved"
        })
      }));
    expect((await store.getRecoverableGoalJobs()).filter((admission) => admission.jobName === "goal-orchestrate"))
      .toHaveLength(2);

    const pausedAgain = await app.inject({
      method: "POST",
      url: `/api/v1/goal-runs/${runId}/pause`,
      headers: { origin },
      cookies: { council_session: session },
      payload: { expectedRevision: 5 }
    });
    expect(pausedAgain.statusCode).toBe(200);
    queue.enqueueGoalOrchestrate.mockRejectedValueOnce(new Error("Redis reply was interrupted"));
    const interruptedResume = await app.inject({
      method: "POST",
      url: `/api/v1/goal-runs/${runId}/resume`,
      headers: { origin },
      cookies: { council_session: session },
      payload: { expectedRevision: 6 }
    });
    expect(interruptedResume.statusCode).toBe(500);
    expect(await store.getGoalRun(runId)).toMatchObject({ state: "executing", revision: 7 });
    const interruptedResumeJobId = queue.enqueueGoalOrchestrate.mock.calls.at(-1)?.[1];
    expect(interruptedResumeJobId).toEqual(expect.any(String));
    await expect(store.getGoalJobAdmission(interruptedResumeJobId!)).resolves.toMatchObject({
      goalRunId: runId,
      entityId: runId,
      state: "dispatching",
      dispatchToken: expect.any(String)
    });
    const resumeRetryRequest = {
      method: "POST",
      url: `/api/v1/goal-runs/${runId}/resume`,
      headers: { origin },
      cookies: { council_session: session },
      payload: { expectedRevision: 6 }
    } as const;
    const [resumedAfterRetry, concurrentResumeReplay] = await Promise.all([
      app.inject(resumeRetryRequest),
      app.inject(resumeRetryRequest)
    ]);
    expect(resumedAfterRetry.statusCode).toBe(503);
    expect(concurrentResumeReplay.statusCode).toBe(503);
    expect(resumedAfterRetry.json()).toMatchObject({ error: { code: "GOAL_JOB_DISPATCH_PENDING" } });
    expect(concurrentResumeReplay.json()).toMatchObject({ error: { code: "GOAL_JOB_DISPATCH_PENDING" } });
    expect(queue.enqueueGoalOrchestrate).toHaveBeenCalledTimes(3);
    await app.close();
  });

  it("replays durable Goal events after Last-Event-ID before keeping the stream open", async () => {
    vi.useFakeTimers();
    let handler: ((request: any, reply: any) => Promise<unknown>) | undefined;
    const app = {
      get(path: string, route: (request: any, reply: any) => Promise<unknown>) {
        if (path === "/api/goal-runs/:id/events") handler = route;
        return this;
      },
      post() { return this; },
      put() { return this; },
      addHook() { return this; }
    } as unknown as FastifyInstance;
    const goalRunId = "90000000-0000-4000-8000-000000000011";
    const replayed: GoalEvent = {
      id: "90000000-0000-4000-8000-000000000012",
      goalRunId,
      sequence: 6,
      type: "owner.message",
      actorType: "owner",
      actorId: "90000000-0000-4000-8000-000000000013",
      entityType: "goal",
      entityId: goalRunId,
      summary: "Owner added an instruction.",
      detail: { content: "Keep the meeting canonical." },
      occurredAt: "2026-08-27T00:00:00.000Z"
    };
    const getGoalEvents = vi.fn(async (_id: string, after: number) => after < 6 ? [replayed] : []);
    const listRuntimeRunsForGoal = vi.fn(async () => [{
      id: "90000000-0000-4000-8000-000000000014",
      revision: 4,
      state: "running",
      eventCursor: 9
    }]);
    registerGoalRoutes(app, {
      authDisabled: true,
      store: { getGoalRun: vi.fn(async () => ({ id: goalRunId })), getGoalEvents, listRuntimeRunsForGoal } as never
    });
    const requestRaw = new EventEmitter();
    const replyRaw = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn>; writeHead: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
    replyRaw.write = vi.fn(() => true);
    replyRaw.writeHead = vi.fn();
    replyRaw.destroy = vi.fn();
    await handler!({ params: { id: goalRunId }, query: {}, headers: { "last-event-id": "5" }, raw: requestRaw, log: { error: vi.fn() } }, { hijack: vi.fn(), raw: replyRaw });

    expect(getGoalEvents).toHaveBeenCalledWith(goalRunId, 5, 100);
    expect(replyRaw.write).toHaveBeenCalledWith(expect.stringContaining("id: 6\nevent: goal.event"));
    expect(replyRaw.write).toHaveBeenCalledWith(expect.stringContaining("event: runtime.refresh"));
    requestRaw.emit("close");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps Goal SSE connections before hijacking and releases the reservation on close", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T00:00:00.000Z"));
    let handler: ((request: any, reply: any) => Promise<unknown>) | undefined;
    const app = {
      get(path: string, route: (request: any, reply: any) => Promise<unknown>) {
        if (path === "/api/goal-runs/:id/events") handler = route;
        return this;
      },
      post() { return this; }, put() { return this; }, addHook() { return this; }
    } as unknown as FastifyInstance;
    const goalRunId = "90000000-0000-4000-8000-000000000041";
    const session = { userId: "owner", tokenHash: "limited-goal-session", expiresAt: "2026-08-27T01:00:00.000Z" };
    const secondSession = { userId: "owner", tokenHash: "second-goal-session", expiresAt: "2026-08-27T01:00:00.000Z" };
    const thirdSession = { userId: "owner", tokenHash: "third-goal-session", expiresAt: "2026-08-27T01:00:00.000Z" };
    registerGoalRoutes(app, {
      authDisabled: false,
      goalSseConnectionLimits: { global: 2, perOwnerSession: 1 },
      store: {
        getGoalRun: vi.fn(async () => ({ id: goalRunId })),
        getGoalEvents: vi.fn(async () => []),
        listRuntimeRunsForGoal: vi.fn(async () => []),
        findSession: vi.fn(async (tokenHash: string) => [session, secondSession, thirdSession].find((candidate) => candidate.tokenHash === tokenHash) ?? null)
      } as never
    } as never);
    const stream = (ownerSession = session) => {
      const requestRaw = new EventEmitter();
      const replyRaw = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn>; writeHead: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
      replyRaw.write = vi.fn(() => true); replyRaw.writeHead = vi.fn(); replyRaw.destroy = vi.fn();
      const reply = { hijack: vi.fn(), raw: replyRaw, code: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() };
      return {
        requestRaw,
        reply,
        handling: handler!({ params: { id: goalRunId }, query: {}, headers: {}, raw: requestRaw, ownerSession, log: { error: vi.fn() } }, reply)
      };
    };

    const first = stream();
    await first.handling;
    const excess = stream();
    await excess.handling;
    expect(excess.reply.code).toHaveBeenCalledWith(429);
    expect(excess.reply.send).toHaveBeenCalledWith({
      error: { code: "GOAL_SSE_CONNECTION_LIMIT_EXCEEDED", message: "Goal event stream connection limit exceeded." }
    });
    expect(excess.reply.hijack).not.toHaveBeenCalled();

    const second = stream(secondSession);
    await second.handling;
    expect(second.reply.hijack).toHaveBeenCalledOnce();
    const globalExcess = stream(thirdSession);
    await globalExcess.handling;
    expect(globalExcess.reply.code).toHaveBeenCalledWith(429);
    expect(globalExcess.reply.hijack).not.toHaveBeenCalled();

    first.requestRaw.emit("close");
    const replacement = stream(thirdSession);
    await replacement.handling;
    expect(replacement.reply.hijack).toHaveBeenCalledOnce();
    replacement.requestRaw.emit("error", new Error("client stream failed"));
    const afterError = stream(thirdSession);
    await afterError.handling;
    expect(afterError.reply.hijack).toHaveBeenCalledOnce();
    afterError.reply.raw.emit("close");
    second.requestRaw.emit("close");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not reserve or hijack an SSE stream that disconnects during session revalidation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T00:00:00.000Z"));
    let handler: ((request: any, reply: any) => Promise<unknown>) | undefined;
    const app = {
      get(path: string, route: (request: any, reply: any) => Promise<unknown>) {
        if (path === "/api/goal-runs/:id/events") handler = route;
        return this;
      },
      post() { return this; }, put() { return this; }, addHook() { return this; }
    } as unknown as FastifyInstance;
    const goalRunId = "90000000-0000-4000-8000-000000000043";
    const session = { userId: "owner", tokenHash: "race-goal-session", expiresAt: "2026-08-27T01:00:00.000Z" };
    let validationStarted!: () => void;
    const started = new Promise<void>((resolve) => { validationStarted = resolve; });
    let releaseValidation: ((value: typeof session) => void) | undefined;
    const findSession = vi.fn(() => {
      validationStarted();
      return new Promise<typeof session>((resolve) => { releaseValidation = resolve; });
    });
    registerGoalRoutes(app, {
      authDisabled: false,
      goalSseConnectionLimits: { global: 1, perOwnerSession: 1 },
      store: {
        getGoalRun: vi.fn(async () => ({ id: goalRunId })),
        getGoalEvents: vi.fn(async () => []),
        listRuntimeRunsForGoal: vi.fn(async () => []),
        findSession
      } as never
    } as never);
    const requestRaw = Object.assign(new EventEmitter(), { destroyed: false });
    const replyRaw = Object.assign(new EventEmitter(), {
      write: vi.fn(() => true), writeHead: vi.fn(), destroy: vi.fn()
    });
    const reply = { hijack: vi.fn(), raw: replyRaw, code: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() };

    const handling = handler!({ params: { id: goalRunId }, query: {}, headers: {}, raw: requestRaw, ownerSession: session, log: { error: vi.fn() } }, reply);
    await started;
    expect(findSession).toHaveBeenCalledOnce();
    requestRaw.destroyed = true;
    requestRaw.emit("close");
    releaseValidation!(session);
    await handling;

    expect(reply.hijack).not.toHaveBeenCalled();
    expect(replyRaw.writeHead).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases Goal SSE connection reservations after session revocation, expiry, and server shutdown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T00:00:00.000Z"));
    let handler: ((request: any, reply: any) => Promise<unknown>) | undefined;
    let preClose: (() => Promise<void>) | undefined;
    const app = {
      get(path: string, route: (request: any, reply: any) => Promise<unknown>) {
        if (path === "/api/goal-runs/:id/events") handler = route;
        return this;
      },
      post() { return this; }, put() { return this; },
      addHook(name: string, hook: () => Promise<void>) { if (name === "preClose") preClose = hook; return this; }
    } as unknown as FastifyInstance;
    const goalRunId = "90000000-0000-4000-8000-000000000042";
    const active = { userId: "owner", tokenHash: "active-goal-session", expiresAt: "2026-08-27T01:00:00.000Z" };
    const expiring = { userId: "owner", tokenHash: "expiring-goal-session", expiresAt: "2026-08-27T00:00:02.000Z" };
    let revoked = false;
    registerGoalRoutes(app, {
      authDisabled: false,
      goalSseConnectionLimits: { global: 1, perOwnerSession: 1 },
      store: {
        getGoalRun: vi.fn(async () => ({ id: goalRunId })),
        getGoalEvents: vi.fn(async () => []),
        listRuntimeRunsForGoal: vi.fn(async () => []),
        findSession: vi.fn(async (tokenHash: string) => revoked && tokenHash === active.tokenHash ? null : tokenHash === expiring.tokenHash ? expiring : active)
      } as never
    } as never);
    const stream = (session: typeof active) => {
      const requestRaw = new EventEmitter();
      const replyRaw = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn>; writeHead: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
      replyRaw.write = vi.fn(() => true); replyRaw.writeHead = vi.fn(); replyRaw.destroy = vi.fn();
      const reply = { hijack: vi.fn(), raw: replyRaw, code: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() };
      return { requestRaw, replyRaw, handling: handler!({ params: { id: goalRunId }, query: {}, headers: {}, raw: requestRaw, ownerSession: session, log: { error: vi.fn() } }, reply) };
    };

    const revokedStream = stream(active);
    await revokedStream.handling;
    revoked = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(revokedStream.replyRaw.destroy).toHaveBeenCalledOnce();

    const expiringStream = stream(expiring);
    await expiringStream.handling;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(expiringStream.replyRaw.destroy).toHaveBeenCalledOnce();

    revoked = false;
    const shutdownStream = stream(active);
    await shutdownStream.handling;
    await preClose!();
    expect(shutdownStream.replyRaw.destroy).toHaveBeenCalledOnce();

    const replacement = stream(active);
    await replacement.handling;
    replacement.requestRaw.emit("close");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disconnects an established Goal event stream when its Owner session is revoked", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T00:00:00.000Z"));
    let handler: ((request: any, reply: any) => Promise<unknown>) | undefined;
    const app = {
      get(path: string, route: (request: any, reply: any) => Promise<unknown>) {
        if (path === "/api/goal-runs/:id/events") handler = route;
        return this;
      },
      post() { return this; }, put() { return this; }, addHook() { return this; }
    } as unknown as FastifyInstance;
    const goalRunId = "90000000-0000-4000-8000-000000000021";
    const session = { userId: "owner", tokenHash: "goal-session", expiresAt: "2026-08-27T01:00:00.000Z" };
    const findSession = vi.fn(async () => session as typeof session | null);
    registerGoalRoutes(app, {
      authDisabled: false,
      store: { getGoalRun: vi.fn(async () => ({ id: goalRunId })), getGoalEvents: vi.fn(async () => []), listRuntimeRunsForGoal: vi.fn(async () => []), findSession } as never
    });
    const requestRaw = new EventEmitter();
    const replyRaw = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn>; writeHead: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
    replyRaw.write = vi.fn(() => true); replyRaw.writeHead = vi.fn(); replyRaw.destroy = vi.fn();

    await handler!({ params: { id: goalRunId }, query: {}, headers: {}, raw: requestRaw, ownerSession: session, log: { error: vi.fn() } }, { hijack: vi.fn(), raw: replyRaw });
    findSession.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(replyRaw.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disconnects an idle Goal event stream at Owner session expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T00:00:00.000Z"));
    let handler: ((request: any, reply: any) => Promise<unknown>) | undefined;
    const app = {
      get(path: string, route: (request: any, reply: any) => Promise<unknown>) {
        if (path === "/api/goal-runs/:id/events") handler = route;
        return this;
      },
      post() { return this; }, put() { return this; }, addHook() { return this; }
    } as unknown as FastifyInstance;
    const goalRunId = "90000000-0000-4000-8000-000000000031";
    const session = { userId: "owner", tokenHash: "expiring-goal-session", expiresAt: "2026-08-27T00:00:01.000Z" };
    registerGoalRoutes(app, {
      authDisabled: false,
      store: {
        getGoalRun: vi.fn(async () => ({ id: goalRunId })),
        getGoalEvents: vi.fn(async () => []),
        listRuntimeRunsForGoal: vi.fn(async () => []),
        findSession: vi.fn(async () => session)
      } as never
    });
    const requestRaw = new EventEmitter();
    const replyRaw = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn>; writeHead: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
    replyRaw.write = vi.fn(() => true); replyRaw.writeHead = vi.fn(); replyRaw.destroy = vi.fn();

    await handler!({ params: { id: goalRunId }, query: {}, headers: {}, raw: requestRaw, ownerSession: session, log: { error: vi.fn() } }, { hijack: vi.fn(), raw: replyRaw });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(replyRaw.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
