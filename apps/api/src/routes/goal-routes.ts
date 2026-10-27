import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  approveGoalRunSchema,
  createGoalRunSchema,
  goalExecutionLimitsSchema,
  goalCanvasLensSchema,
  goalCanvasSnapshotSchema,
  goalEventSchema,
  goalRunControlSchema,
  goalRunMessageSchema,
  goalRunPlanUpdateSchema,
  goalRunSchema,
  runtimeRunSchema,
  type ExecutionActionBinding,
  type ExecutionRuntimeBinding,
  type GoalEvent,
  type GoalPlanRevision,
  type GoalPlannerProvenance,
  type GoalRun
} from "@council/contracts";
import {
  actionAdapterEndpointDigest,
  createExecutionRuntimeBinding,
  createExecutionContract,
  ExecutionRuntimeBindingError,
  goalPlanDigest,
  projectGoalCanvas,
  resolveRuntimeProfileAdmission,
  resumeGoalRunState,
  transitionGoalRun
} from "@council/domain";
import type {
  AppendGoalEventInput,
  GoalJobAdmission,
  GoalRunDetail,
  GoalRunStateMutationInput,
  PlatformStore
} from "@council/database";
import {
  goalPlannerProvenanceFromDetail,
  requestFingerprint,
  roleExecutionSnapshotDigest
} from "@council/database";
import { goalOrchestrateJobId } from "../agent-queue.js";
import { idempotencyKey, parse, sendError, type AppOptionsFor } from "../route-support.js";

const uuidParamsSchema = z.object({ id: z.string().uuid() }).strict();
const eventQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }).strict();
const canvasQuerySchema = z.object({ lens: goalCanvasLensSchema.default("progress") }).strict();
const maxSseBufferedBytes = 256 * 1024;
const goalDispatchLeaseMs = 30_000;
const defaultGoalSseConnectionLimits = { global: 64, perOwnerSession: 4 };
const goalRouteStoreMethods = [
  "appendGoalEvent",
  "addUtteranceWithDisposition",
  "approveGoalRun",
  "claimGoalJobDispatch",
  "completeGoalJobDispatch",
  "createGoalRun",
  "createMeeting",
  "createThread",
  "findSession",
  "getAgentReadiness",
  "getAgentRevision",
  "getGoalEvents",
  "getGoalJobAdmission",
  "getGoalRun",
  "getGoalRunDetail",
  "getSnapshot",
  "listActionAdapters",
  "listGoalRuns",
  "listRuntimeRunsForGoal",
  "reserveGoalJob",
  "setGoalJobState",
  "setMeetingState",
  "setGoalRunState",
  "saveGoalPlan"
] as const satisfies readonly (keyof PlatformStore)[];

type GoalRouteStoreMethod = (typeof goalRouteStoreMethods)[number];
export interface GoalSseConnectionLimits {
  global: number;
  perOwnerSession: number;
}

export type GoalRouteOptions = AppOptionsFor<GoalRouteStoreMethod> & {
  goalSseConnectionLimits?: GoalSseConnectionLimits;
};

function detailResponse(detail: GoalRunDetail): GoalRunDetail {
  return {
    goalRun: goalRunSchema.parse(detail.goalRun),
    plans: detail.plans.map((plan) => structuredClone(plan)),
    executionContract: detail.executionContract ? structuredClone(detail.executionContract) : null,
    taskBindings: detail.taskBindings.map((binding) => structuredClone(binding)),
    events: detail.events.map((event) => goalEventSchema.parse(event)),
    reviewerVerdicts: detail.reviewerVerdicts.map((verdict) => structuredClone(verdict)),
    actionRuns: detail.actionRuns.map((run) => structuredClone(run)),
    runtimeRuns: (detail.runtimeRuns ?? []).map((run) => runtimeRunSchema.parse(run))
  };
}

function requireOwner(request: FastifyRequest, reply: FastifyReply): string | null {
  const owner = request.ownerSession;
  if (!owner || new Date(owner.expiresAt).getTime() <= Date.now()) {
    sendError(reply, 401, "OWNER_SESSION_REQUIRED", "An attributable Owner session is required for Goal Run control.");
    return null;
  }
  return owner.userId;
}

function routeFailure(message: string, apiCode: string, statusCode = 409): Error {
  return Object.assign(new Error(message), { apiCode, statusCode });
}

async function createRuntimeBindingsForApproval(input: {
  options: GoalRouteOptions;
  snapshot: Awaited<ReturnType<PlatformStore["getSnapshot"]>>;
  tasks: GoalPlanRevision["tasks"];
}): Promise<ExecutionRuntimeBinding[]> {
  const bindings: ExecutionRuntimeBinding[] = [];
  let ompReady = false;
  for (const task of input.tasks.filter((candidate) => (
    candidate.executionMode === "worker" || candidate.executionMode === "advisor"
  ))) {
    if (!task.assigneeAgentId) {
      throw routeFailure("Automatic Goal tasks require an assigned published Agent.", "RUNTIME_ASSIGNEE_REQUIRED");
    }
    const agent = input.snapshot.agents.find((candidate) => candidate.id === task.assigneeAgentId);
    if (!agent || agent.lifecycleStatus === "disabled" || !agent.publishedRevision) {
      throw routeFailure("Automatic Goal task Agent is unavailable or unpublished.", "RUNTIME_AGENT_UNAVAILABLE");
    }
    const revision = await input.options.store.getAgentRevision(agent.id, agent.publishedRevision).catch(() => null);
    if (!revision?.modelConnectorId || !revision.runtimeProfileBinding) {
      throw routeFailure("Automatic Goal task Agent has an incomplete Runtime binding.", "RUNTIME_BINDING_INCOMPLETE");
    }
    const connector = input.snapshot.modelConnectors.find((candidate) => (
      candidate.id === revision.modelConnectorId && candidate.enabled
    ));
    if (!connector) {
      throw routeFailure("Automatic Goal task Model Connector is unavailable.", "RUNTIME_MODEL_UNAVAILABLE");
    }
    const profileRevision = input.snapshot.runtimeProfileRevisions?.find((candidate) => (
      candidate.profileId === revision.runtimeProfileBinding!.profileId
      && candidate.revision === revision.runtimeProfileBinding!.revision
    ));
    const currentProfile = input.snapshot.runtimeProfiles?.find((candidate) => (
      candidate.id === revision.runtimeProfileBinding!.profileId && candidate.enabled
    ));
    if (!profileRevision || !currentProfile) {
      throw routeFailure("Automatic Goal task Runtime Profile is unavailable or stale.", "RUNTIME_PROFILE_UNAVAILABLE");
    }
    const needsOmpAttestation = profileRevision.harnessKind === "pi";
    if (needsOmpAttestation && !ompReady) {
      if (!input.options.ompRuntime?.enabled) {
        throw routeFailure("OMP Runtime is disabled; select a text Runtime or enable an attested OMP Broker.", "OMP_RUNTIME_DISABLED");
      }
      try {
        await input.options.ompRuntime.check();
        ompReady = true;
      } catch {
        throw routeFailure("OMP Runtime approval requires a ready, attested Worker and Sandbox Broker.", "OMP_RUNTIME_UNAVAILABLE", 503);
      }
    }
    let runtimeProfile;
    try {
      runtimeProfile = resolveRuntimeProfileAdmission({
        binding: revision.runtimeProfileBinding,
        platform: input.snapshot,
        agentModelConnectorId: revision.modelConnectorId,
        executionIsolationAttested: needsOmpAttestation ? ompReady : false
      });
    } catch {
      throw routeFailure("Automatic Goal task Runtime Profile failed admission.", "RUNTIME_PROFILE_UNAVAILABLE");
    }
    try {
      bindings.push(createExecutionRuntimeBinding({
        task,
        agentRevision: revision,
        runtimeProfile,
        modelConnector: connector,
        ...(input.options.ompRuntime?.enabled
          && input.options.ompRuntime.sandboxProfileId
          && input.options.ompRuntime.sandboxImageDigest
          && input.options.ompRuntime.workspaceSourceId
          && input.options.ompRuntime.workspaceArchiveDigest
          ? {
              omp: {
                enabled: true,
                sandboxProfileId: input.options.ompRuntime.sandboxProfileId,
                sandboxImageDigest: input.options.ompRuntime.sandboxImageDigest,
                workspaceSourceId: input.options.ompRuntime.workspaceSourceId,
                workspaceArchiveDigest: input.options.ompRuntime.workspaceArchiveDigest
              },
              ompHostToolsEnabled: input.options.ompRuntime.hostToolsEnabled
            }
          : {})
      }));
    } catch (error) {
      if (error instanceof ExecutionRuntimeBindingError) {
        throw routeFailure(error.message, error.code);
      }
      throw error;
    }
  }
  return bindings;
}

function goalTitle(goal: string, requestedTitle?: string): string {
  if (requestedTitle) return requestedTitle;
  const normalized = goal.replace(/\s+/g, " ").trim();
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}...`;
}

async function defaultGoalParticipants(
  store: Pick<PlatformStore, "getAgentReadiness">,
  snapshot: Awaited<ReturnType<PlatformStore["getSnapshot"]>>
) {
  const roles = snapshot.roles.filter((role) => !role.deletedAt);
  if (roles.length === 0) {
    throw Object.assign(new Error("At least one active Role is required to create a Goal Meeting."), {
      statusCode: 409,
      apiCode: "GOAL_TEAM_UNAVAILABLE"
    });
  }
  const candidates = (await Promise.all(snapshot.agents.map(async (agent) => ({
    agent,
    readiness: await store.getAgentReadiness(agent.id).catch(() => null),
    connector: snapshot.modelConnectors.find((connector) => connector.id === agent.modelConnectorId && connector.enabled) ?? null
  })))).filter((candidate) => (
    candidate.agent.lifecycleStatus !== "disabled"
    && candidate.agent.status !== "offline"
    && candidate.agent.publishedRevision !== null
    && candidate.readiness !== null
    && candidate.readiness.status !== "blocked"
    && candidate.connector !== null
  )).sort((left, right) => {
    const readiness = Number(left.readiness!.status !== "ready") - Number(right.readiness!.status !== "ready");
    if (readiness !== 0) return readiness;
    return Number(left.agent.status !== "online") - Number(right.agent.status !== "online");
  });
  let reviewerPair: [(typeof candidates)[number], (typeof candidates)[number]] | null = null;
  for (const first of candidates) {
    const second = candidates.find((candidate) => (
      candidate.agent.id !== first.agent.id
      && candidate.connector!.id !== first.connector!.id
    ));
    if (second) {
      reviewerPair = [first, second];
      break;
    }
  }
  const reviewers = reviewerPair ?? [];
  const operators = candidates.filter((candidate) => !reviewers.some((reviewer) => reviewer.agent.id === candidate.agent.id));
  const chairRole = roles.find((role) => role.orchestrationFunctions?.includes("chair"));
  const plannerRole = roles.find((role) => role.orchestrationFunctions?.includes("planner"));
  const workerRole = roles.find((role) => role.orchestrationFunctions?.includes("worker"));
  const reviewerRole = roles.find((role) => role.orchestrationFunctions?.includes("reviewer"));
  if (!chairRole || !plannerRole || !workerRole || !reviewerRole) {
    throw Object.assign(new Error("Goal autonomy requires active Chair, Planner, Worker, and Reviewer Role capabilities."), {
      statusCode: 409,
      apiCode: "GOAL_TEAM_UNAVAILABLE"
    });
  }
  const chairAlsoPlans = chairRole.orchestrationFunctions?.includes("planner") === true;
  const requiredOperators = chairAlsoPlans ? 2 : 3;
  if (reviewers.length !== 2 || operators.length < requiredOperators) {
    const minimum = requiredOperators + 2;
    throw Object.assign(new Error(`At least ${minimum} ready published Agents are required for the available Chair and Planner Role capabilities, including two reserved Reviewers on different Model Connectors.`), {
      statusCode: 409,
      apiCode: "GOAL_TEAM_UNAVAILABLE"
    });
  }
  const participants = [
    { agentId: operators[0]!.agent.id, roleId: chairRole.id, isChair: true },
    ...(chairAlsoPlans ? [] : [{ agentId: operators[1]!.agent.id, roleId: plannerRole.id, isChair: false }]),
    {
      agentId: operators[chairAlsoPlans ? 1 : 2]!.agent.id,
      roleId: workerRole.id,
      isChair: false
    },
    ...reviewers.map(({ agent }) => ({
      agentId: agent.id,
      roleId: reviewerRole.id,
      isChair: false
    }))
  ];
  return participants;
}

async function canonicalMeetingPlannerProvenance(
  store: Pick<PlatformStore, "getAgentRevision">,
  snapshot: Awaited<ReturnType<PlatformStore["getSnapshot"]>>,
  run: Pick<GoalRun, "meetingId" | "threadId">
): Promise<GoalPlannerProvenance | null> {
  const meeting = snapshot.meetings.find((candidate) => (
    candidate.id === run.meetingId && candidate.threadId === run.threadId
  ));
  if (!meeting) return null;
  for (const participant of snapshot.participants) {
    if (participant.meetingId !== meeting.id
      || participant.agentRevision === undefined
      || !participant.roleSnapshot.orchestrationFunctions.includes("planner")) continue;
    const agent = snapshot.agents.find((candidate) => candidate.id === participant.agentId);
    if (!agent || agent.lifecycleStatus === "disabled") continue;
    const revision = await store.getAgentRevision(agent.id, participant.agentRevision).catch(() => null);
    if (!revision?.modelConnectorId || revision.revision !== participant.agentRevision) continue;
    const roleHistory = participant.roleHistory.find((entry) => (
      entry.revision === participant.roleRevision
      && entry.roleId === participant.roleId
      && entry.roleSnapshot.orchestrationFunctions.includes("planner")
    ));
    if (!roleHistory) continue;
    const connector = snapshot.modelConnectors.find((candidate) => (
      candidate.id === revision.modelConnectorId && candidate.enabled
    ));
    if (!connector) continue;
    return {
      plannerParticipantId: participant.id,
      plannerAgentId: agent.id,
      plannerAgentRevision: revision.revision,
      plannerModelConnectorId: connector.id,
      plannerRoleId: roleHistory.roleId,
      plannerRoleRevision: roleHistory.revision,
      plannerRoleSnapshotDigest: roleExecutionSnapshotDigest(roleHistory.roleSnapshot)
    };
  }
  return null;
}

async function reservedMeetingReviewerIds(
  store: Pick<PlatformStore, "getAgentRevision">,
  snapshot: Awaited<ReturnType<PlatformStore["getSnapshot"]>>,
  meetingId: string,
  excludedAgentIds: ReadonlySet<string> = new Set()
): Promise<string[]> {
  const reviewers: string[] = [];
  const connectorIds = new Set<string>();
  for (const participant of snapshot.participants) {
    if (participant.meetingId !== meetingId
      || participant.isChair
      || excludedAgentIds.has(participant.agentId)
      || !participant.roleSnapshot.orchestrationFunctions.includes("reviewer")) continue;
    const agent = snapshot.agents.find((candidate) => candidate.id === participant.agentId);
    const revision = agent && participant.agentRevision
      ? await store.getAgentRevision(agent.id, participant.agentRevision).catch(() => null)
      : null;
    const connector = revision?.modelConnectorId
      ? snapshot.modelConnectors.find((candidate) => candidate.id === revision.modelConnectorId && candidate.enabled)
      : null;
    if (!agent || agent.lifecycleStatus === "disabled" || agent.status === "offline" || !revision || !connector || connectorIds.has(connector.id)) continue;
    reviewers.push(agent.id);
    connectorIds.add(connector.id);
    if (reviewers.length === 2) return reviewers;
  }
  return [];
}

function initialGoalRun(input: {
  id: string;
  title: string;
  goal: string;
  threadId: string;
  meetingId: string;
  createdBy: string;
  limits?: { [Key in keyof GoalRun["limits"]]?: GoalRun["limits"][Key] | undefined };
}): GoalRun {
  const now = new Date();
  const limits = goalExecutionLimitsSchema.parse({
    discussionRounds: 3,
    maxTasks: 12,
    maxConcurrentTasks: 2,
    maxAttemptsPerTask: 3,
    maxReplans: 2,
    maxDurationMinutes: 120,
    maxModelCalls: 60,
    maxActionCalls: 30,
    ...input.limits
  });
  return goalRunSchema.parse({
    id: input.id,
    title: input.title,
    goal: input.goal,
    threadId: input.threadId,
    meetingId: input.meetingId,
    state: "planning",
    revision: 1,
    activePlanRevision: 0,
    executionContractId: null,
    limits,
    usage: { discussionRounds: 0, taskAttempts: 0, replans: 0, modelCalls: 0, actionCalls: 0 },
    deadlineAt: new Date(now.getTime() + limits.maxDurationMinutes * 60_000).toISOString(),
    pausedFromState: null,
    terminalReason: null,
    createdBy: input.createdBy,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  });
}

function createGoalOrchestrationReservation(input: {
  goalRunId: string;
  expectedRevision: number;
  requestKey: string;
}): {
  job: { goalRunId: string; expectedRevision: number; requestFingerprint: string; requestedBy: "owner" };
  jobId: string;
  admission: GoalJobAdmission;
} {
  const fingerprint = requestFingerprint({ goalRunId: input.goalRunId, requestKey: input.requestKey });
  const job = {
    goalRunId: input.goalRunId,
    expectedRevision: input.expectedRevision,
    requestFingerprint: fingerprint,
    requestedBy: "owner" as const
  };
  const jobId = goalOrchestrateJobId(input.goalRunId, fingerprint);
  const reservedAt = new Date().toISOString();
  return {
    job,
    jobId,
    admission: {
      jobId,
      goalRunId: input.goalRunId,
      jobName: "goal-orchestrate",
      entityId: input.goalRunId,
      requestFingerprint: fingerprint,
      state: "reserved",
      reservedAt,
      admittedAt: null,
      startedAt: null,
      settledAt: null,
      updatedAt: reservedAt
    }
  };
}

async function reconcileGoalOrchestrationAdmission(input: {
  store: Pick<PlatformStore, "claimGoalJobDispatch" | "completeGoalJobDispatch">;
  enqueue: (job: {
    goalRunId: string;
    expectedRevision: number;
    requestFingerprint: string;
    requestedBy: "owner";
  }, jobId: string) => Promise<{ jobId: string }>;
  admission: GoalJobAdmission;
  job: {
    goalRunId: string;
    expectedRevision: number;
    requestFingerprint: string;
    requestedBy: "owner";
  };
  jobId: string;
  entityId: string;
}): Promise<GoalJobAdmission> {
  const admission = input.admission;
  if (admission.goalRunId !== input.job.goalRunId
    || admission.jobName !== "goal-orchestrate"
    || admission.entityId !== input.entityId
    || admission.requestFingerprint !== input.job.requestFingerprint) {
    throw Object.assign(new Error("The retained Goal orchestration admission belongs to another request."), {
      statusCode: 409,
      apiCode: "GOAL_JOB_RECONCILIATION_REQUIRED"
    });
  }
  const dispatchToken = randomUUID();
  const claim = await input.store.claimGoalJobDispatch(input.jobId, {
    dispatchToken,
    leaseDurationMs: goalDispatchLeaseMs
  });
  if (claim.status === "contended") {
    throw Object.assign(new Error("Another request currently owns the bounded Goal queue dispatch lease; retry shortly."), {
      statusCode: 503,
      apiCode: "GOAL_JOB_DISPATCH_PENDING"
    });
  }
  let reconciled = claim.admission;
  if (claim.status === "claimed") {
    const queued = await input.enqueue(input.job, input.jobId);
    if (queued.jobId !== input.jobId) throw new Error("Goal orchestration queue returned a mismatched job ID.");
    reconciled = await input.store.completeGoalJobDispatch(input.jobId, dispatchToken);
  }
  if (!["admitted", "running", "settled"].includes(reconciled.state)) {
    throw Object.assign(new Error("The retained Goal orchestration admission requires operator reconciliation."), {
      statusCode: 409,
      apiCode: "GOAL_JOB_RECONCILIATION_REQUIRED"
    });
  }
  return reconciled;
}

function goalEvent(
  type: AppendGoalEventInput["type"],
  actorType: AppendGoalEventInput["actorType"],
  actorId: string | null,
  entityType: AppendGoalEventInput["entityType"],
  entityId: string,
  summary: string,
  detail: Record<string, string | number | boolean | null> = {}
): AppendGoalEventInput {
  return { type, actorType, actorId, entityType, entityId, summary, detail };
}

function transitionInput(
  run: GoalRun,
  state: GoalRunStateMutationInput["state"],
  actorId: string,
  summary: string,
  terminalReason: string | null = null
): GoalRunStateMutationInput {
  const actions = ["plan", "plan_ready", "approve", "begin_review", "complete", "replan", "pause", "resume", "fail", "cancel"] as const;
  const transitionExists = (run.state === "paused" && run.pausedFromState === state) || actions.some((action) => {
    try {
      return transitionGoalRun(run.state, action) === state;
    } catch {
      return false;
    }
  });
  if (!transitionExists) {
    throw Object.assign(new Error(`Goal Run cannot transition from ${run.state} to ${state}.`), {
      statusCode: 409,
      apiCode: "GOAL_STATE_TRANSITION_INVALID"
    });
  }
  return {
    expectedRevision: run.revision,
    state,
    pausedFromState: state === "paused" ? run.state : null,
    terminalReason,
    event: goalEvent("goal.state.changed", "owner", actorId, "goal", run.id, summary, {
      from: run.state,
      to: state
    })
  };
}

function parseLastEventId(headers: Record<string, string | string[] | undefined>): number {
  const raw = headers["last-event-id"];
  if (raw === undefined) return 0;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^\d+$/.test(value)) throw Object.assign(new Error("Last-Event-ID must be a positive integer."), { statusCode: 400 });
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw Object.assign(new Error("Last-Event-ID is out of range."), { statusCode: 400 });
  return parsed;
}

function sseFrame(event: GoalEvent): string {
  return `id: ${event.sequence}\nevent: goal.event\ndata: ${JSON.stringify(goalEventSchema.parse(event))}\n\n`;
}

export function registerGoalRoutes(app: FastifyInstance, options: GoalRouteOptions): void {
  const activeDisconnects = new Set<() => void>();
  const activeGoalSseConnectionsBySession = new Map<string, number>();
  const goalSseConnectionLimits = options.goalSseConnectionLimits ?? defaultGoalSseConnectionLimits;
  let activeGoalSseConnections = 0;
  const reserveGoalSseConnection = (ownerSession: FastifyRequest["ownerSession"]): (() => void) | null => {
    const sessionKey = ownerSession?.tokenHash ?? null;
    const sessionConnections = sessionKey ? activeGoalSseConnectionsBySession.get(sessionKey) ?? 0 : 0;
    if (activeGoalSseConnections >= goalSseConnectionLimits.global
      || (sessionKey !== null && sessionConnections >= goalSseConnectionLimits.perOwnerSession)) return null;
    activeGoalSseConnections += 1;
    if (sessionKey !== null) activeGoalSseConnectionsBySession.set(sessionKey, sessionConnections + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeGoalSseConnections -= 1;
      if (sessionKey === null) return;
      const remaining = (activeGoalSseConnectionsBySession.get(sessionKey) ?? 1) - 1;
      if (remaining === 0) activeGoalSseConnectionsBySession.delete(sessionKey);
      else activeGoalSseConnectionsBySession.set(sessionKey, remaining);
    };
  };
  app.addHook("preHandler", async (request, reply) => {
    if (options.goalRunEnabled === false && request.routeOptions.url?.startsWith("/api/goal-runs")) {
      return sendError(reply, 404, "FEATURE_DISABLED", "Goal Run autonomy is not enabled.");
    }
  });
  app.addHook("preClose", async () => {
    for (const disconnect of [...activeDisconnects]) disconnect();
  });

  app.get("/api/goal-runs", async (_request, reply) => {
    return reply.send({ goalRuns: (await options.store.listGoalRuns()).map((run) => goalRunSchema.parse(run)) });
  });

  app.post("/api/goal-runs", async (request, reply) => {
    const ownerId = requireOwner(request, reply);
    if (!ownerId) return;
    const queue = options.agentQueue;
    if (!queue?.enqueueGoalOrchestrate) {
      return sendError(reply, 503, "GOAL_QUEUE_UNAVAILABLE", "Goal orchestration is not configured.");
    }
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header is required.");
    const input = parse(createGoalRunSchema, request.body);
    const snapshot = await options.store.getSnapshot();
    const title = goalTitle(input.goal, input.title);
    let threadId = input.threadId;
    let existingMeeting = threadId
      ? snapshot.meetings.find((meeting) => meeting.threadId === threadId && meeting.state !== "closed")
      : undefined;
    let participants: Awaited<ReturnType<typeof defaultGoalParticipants>> | null = null;
    if (threadId) {
      if (!snapshot.threads.some((thread) => thread.id === threadId && thread.status === "open")) {
        return sendError(reply, 404, "TOPIC_NOT_FOUND", "The selected open Topic was not found.");
      }
    } else {
      const categoryId = input.categoryId!;
      if (!snapshot.categories.some((category) => category.id === categoryId)) {
        return sendError(reply, 404, "CATEGORY_NOT_FOUND", "The destination Category was not found.");
      }
      participants = await defaultGoalParticipants(options.store, snapshot);
      threadId = (await options.store.createThread({
        categoryId,
        title,
        summary: input.goal.slice(0, 1_000),
        tagIds: input.tagIds
      }, requestKey)).id;
    }
    let meetingWasCreated = false;
    if (!existingMeeting) {
      participants ??= await defaultGoalParticipants(options.store, snapshot);
      existingMeeting = await options.store.createMeeting({
        threadId,
        title,
        goal: input.goal.slice(0, 1_000),
        mode: "chaired",
        automation: "suggest",
        durationMinutes: Math.min(input.limits?.maxDurationMinutes ?? 120, 240),
        participants,
        agendaItems: [
          { title: "Analysis", description: "Frame the objective, evidence, and constraints." },
          { title: "Cross review", description: "Challenge assumptions and identify missing evidence." },
          { title: "Chair convergence", description: "Record consensus, dissent, and a candidate decision." }
        ]
      }, requestKey, "runnable");
      meetingWasCreated = true;
    }
    let meeting = existingMeeting;
    if (meetingWasCreated) {
      const authoritativeMeeting = (await options.store.getSnapshot()).meetings.find((candidate) => candidate.id === existingMeeting.id);
      if (!authoritativeMeeting) {
        return sendError(reply, 409, "GOAL_MEETING_RECONCILIATION_REQUIRED", "The canonical Goal Meeting could not be reloaded after idempotent creation.");
      }
      if (authoritativeMeeting.state === "draft") {
        meeting = await options.store.setMeetingState(authoritativeMeeting.id, "active", "draft");
      } else if (authoritativeMeeting.state === "active") {
        meeting = authoritativeMeeting;
      } else {
        return sendError(reply, 409, "GOAL_MEETING_RECONCILIATION_REQUIRED", "The canonical Goal Meeting is no longer in a creatable or active state.");
      }
    }
    const tentative = initialGoalRun({
      id: randomUUID(),
      title,
      goal: input.goal,
      threadId,
      meetingId: meeting.id,
      createdBy: ownerId,
      ...(input.limits ? { limits: input.limits } : {})
    });
    const tentativeReservation = createGoalOrchestrationReservation({
      goalRunId: tentative.id,
      expectedRevision: tentative.revision,
      requestKey
    });
    const created = await options.store.createGoalRun(tentative, goalEvent(
      "goal.created", "owner", ownerId, "goal", tentative.id, "Goal Run created with its canonical Meeting discussion.",
      { threadId, meetingId: meeting.id }
    ), requestKey, tentativeReservation.admission);
    if (created.id === tentative.id) {
      await options.store.appendGoalEvent(created.id, goalEvent(
        "meeting.linked", "system", null, "meeting", meeting.id, "Goal Run linked to Meeting discussion.", { threadId }
      ));
    }
    const reservation = created.id === tentative.id
      ? tentativeReservation
      : createGoalOrchestrationReservation({ goalRunId: created.id, expectedRevision: created.revision, requestKey });
    const admission = await options.store.reserveGoalJob(reservation.admission);
    await reconcileGoalOrchestrationAdmission({
      store: options.store,
      enqueue: queue.enqueueGoalOrchestrate.bind(queue),
      admission,
      job: reservation.job,
      jobId: reservation.jobId,
      entityId: created.id
    });
    return reply.code(201).send({ goalRun: goalRunSchema.parse(created), meeting, jobId: reservation.jobId });
  });

  app.get("/api/goal-runs/:id", async (request, reply) => {
    const { id } = parse(uuidParamsSchema, request.params);
    const detail = await options.store.getGoalRunDetail(id);
    if (!detail) return sendError(reply, 404, "NOT_FOUND", "Goal Run not found.");
    return reply.send(detailResponse(detail));
  });

  app.put("/api/goal-runs/:id/plan", async (request, reply) => {
    const ownerId = requireOwner(request, reply);
    if (!ownerId) return;
    const { id } = parse(uuidParamsSchema, request.params);
    const input = parse(goalRunPlanUpdateSchema, request.body);
    const currentDetail = await options.store.getGoalRunDetail(id);
    if (!currentDetail) return sendError(reply, 404, "NOT_FOUND", "Goal Run not found.");
    const run = currentDetail.goalRun;
    if (!["planning", "awaiting_approval", "paused", "replanning"].includes(run.state)) {
      return sendError(reply, 409, "GOAL_PLAN_LOCKED", "Pause or replan the Goal Run before changing its Plan.");
    }
    const plannerProvenance = goalPlannerProvenanceFromDetail(currentDetail)
      ?? await canonicalMeetingPlannerProvenance(options.store, await options.store.getSnapshot(), run);
    if (!plannerProvenance) {
      return sendError(reply, 409, "GOAL_PLANNER_PROVENANCE_REQUIRED", "A Goal Plan must first be attributable to a Planner participant in the canonical Meeting.");
    }
    const plan: GoalPlanRevision = {
      id: randomUUID(),
      goalRunId: id,
      revision: input.expectedPlanRevision + 1,
      status: "draft",
      digest: goalPlanDigest(input.tasks),
      tasks: input.tasks,
      plannerProvenance,
      createdAt: new Date().toISOString()
    };
    const detail = await options.store.saveGoalPlan(id, {
      expectedRevision: run.revision,
      expectedPlanRevision: input.expectedPlanRevision,
      plan,
      event: goalEvent(
        input.expectedPlanRevision === 0 ? "plan.created" : "plan.revised",
        "owner",
        ownerId,
        "plan",
        plan.id,
        "Owner saved a reviewable Goal Plan.",
        {
          revision: plan.revision,
          digest: plan.digest,
          ...(plannerProvenance ?? {})
        }
      )
    });
    return reply.send(detailResponse(detail));
  });

  app.post("/api/goal-runs/:id/approve", async (request, reply) => {
    const ownerId = requireOwner(request, reply);
    if (!ownerId) return;
    const queue = options.agentQueue;
    if (!queue?.enqueueGoalOrchestrate) {
      return sendError(reply, 503, "GOAL_QUEUE_UNAVAILABLE", "Goal orchestration is not configured.");
    }
    const { id } = parse(uuidParamsSchema, request.params);
    const input = parse(approveGoalRunSchema, request.body);
    const detail = await options.store.getGoalRunDetail(id);
    if (!detail) return sendError(reply, 404, "NOT_FOUND", "Goal Run not found.");
    const plan = detail.plans.find((candidate) => candidate.revision === input.expectedPlanRevision);
    const replayContract = detail.executionContract;
    if (plan
      && plan.digest === input.expectedPlanDigest
      && plan.status === "approved"
      && replayContract
      && replayContract.planRevision === plan.revision
      && replayContract.planDigest === plan.digest
      && detail.goalRun.executionContractId === replayContract.id
      && detail.goalRun.activePlanRevision === plan.revision
      && detail.goalRun.revision > input.expectedRevision) {
      const fingerprint = requestFingerprint({ goalRunId: id, contractDigest: replayContract.contractDigest });
      const job = {
        goalRunId: id,
        expectedRevision: input.expectedRevision + 1,
        requestFingerprint: fingerprint,
        requestedBy: "owner" as const
      };
      const jobId = goalOrchestrateJobId(id, fingerprint);
      const admission = await options.store.getGoalJobAdmission(jobId);
      if (!admission) {
        return sendError(reply, 409, "GOAL_JOB_RECONCILIATION_REQUIRED", "The approved Execution Contract has no matching durable orchestration admission.");
      }
      await reconcileGoalOrchestrationAdmission({
        store: options.store,
        enqueue: queue.enqueueGoalOrchestrate.bind(queue),
        admission,
        job,
        jobId,
        entityId: id
      });
      return reply.send({ ...detailResponse(detail), jobId });
    }
    if (!plan || plan.digest !== input.expectedPlanDigest || detail.goalRun.revision !== input.expectedRevision) {
      return sendError(reply, 409, "EXECUTION_CONTRACT_STALE", "The Goal Plan or Goal Run revision is stale.");
    }
    const plannerProvenance = plan.plannerProvenance;
    if (!plannerProvenance) {
      return sendError(reply, 409, "GOAL_PLANNER_PROVENANCE_REQUIRED", "Execution approval requires immutable Planner provenance from the canonical Meeting.");
    }
    if (plan.tasks.some((task) => task.action?.riskClass === "critical")) {
      return sendError(reply, 409, "ACTION_LIVE_APPROVAL_REQUIRED", "Critical Actions require a separate live Owner approval and cannot be included in one-time Goal approval.");
    }
    if (plan.tasks.some((task) => task.action !== null)) {
      if (!options.actionAdapterRuntime || !options.actionAdapterRuntime.enabled) {
        return sendError(reply, 409, "ACTION_ADAPTER_RUNTIME_DISABLED", "Action approval requires the Worker Harness Action Adapter runtime to be explicitly enabled.");
      }
      try {
        await options.actionAdapterRuntime.check([...new Set(
          plan.tasks.flatMap((task) => task.action ? [task.action.adapterId] : [])
        )]);
      } catch {
        return sendError(reply, 503, "ACTION_ADAPTER_RUNTIME_UNAVAILABLE", "Action approval requires a ready Worker Harness Action Adapter runtime.");
      }
    }
    const [snapshot, actionAdapters] = await Promise.all([
      options.store.getSnapshot(),
      options.store.listActionAdapters()
    ]);
    const approvedHarnessEndpoints = new Set(options.harnessActionAdapterEndpointAllowlist ?? []);
    const plannerAgentId = plannerProvenance.plannerAgentId;
    const reviewerIds = await reservedMeetingReviewerIds(
      options.store,
      snapshot,
      detail.goalRun.meetingId,
      new Set(plannerAgentId ? [plannerAgentId] : [])
    );
    if (reviewerIds.length !== 2) {
      return sendError(reply, 409, "REVIEW_QUORUM_UNAVAILABLE", "Approval requires two non-Chair Meeting Reviewers on different enabled Model Connectors.");
    }
    if (plan.tasks.some((task) => task.assigneeAgentId !== null && reviewerIds.includes(task.assigneeAgentId))) {
      return sendError(reply, 409, "REVIEWER_EXECUTION_CONFLICT", "Reserved Meeting Reviewers cannot be assigned Goal execution work.");
    }
    const actionBindings: ExecutionActionBinding[] = [];
    for (const task of plan.tasks.filter((candidate) => candidate.action !== null)) {
      const action = task.action!;
      const adapter = actionAdapters.find((candidate) => candidate.id === action.adapterId && candidate.enabled);
      if (adapter && !approvedHarnessEndpoints.has(adapter.baseUrl)) {
        return sendError(reply, 409, "ACTION_ADAPTER_ENDPOINT_UNAPPROVED", "An Action Adapter endpoint is not in the operator-approved Harness allowlist.");
      }
      const catalogEntry = adapter?.actions.find((candidate) => (
        candidate.key === action.actionKey
        && candidate.targetIds.includes(action.targetId)
        && candidate.riskClass === action.riskClass
        && Object.keys(action.inputs).every((key) => candidate.inputKeys.includes(key))
      ));
      if (!adapter || !catalogEntry) {
        return sendError(reply, 409, "ACTION_CATALOG_STALE", "An Action no longer matches an enabled approved Adapter catalog entry.");
      }
      const credential = adapter.credentialId
        ? (snapshot.credentials ?? []).find((candidate) => candidate.id === adapter.credentialId)
        : null;
      if (!credential || credential.status !== "active" || !credential.hasSecret
        || (credential.expiresAt !== null && Date.parse(credential.expiresAt) <= Date.now())) {
        return sendError(reply, 409, "ACTION_CREDENTIAL_UNAVAILABLE", "Every approved external Action requires an active versioned Credential.");
      }
      actionBindings.push({
        planTaskId: task.id,
        adapterId: adapter.id,
        adapterCatalogRevision: adapter.catalogRevision,
        endpointDigest: actionAdapterEndpointDigest(adapter.baseUrl),
        credentialId: credential.id,
        credentialSecretRevision: credential.secretRevision
      });
    }
    const runtimeBindings = await createRuntimeBindingsForApproval({
      options,
      snapshot,
      tasks: plan.tasks
    });
    const contract = createExecutionContract({
      goalRunId: id,
      planRevision: plan.revision,
      tasks: plan.tasks,
      approvedBy: ownerId,
      limits: detail.goalRun.limits,
      actionBindings,
      runtimeBindings
    });
    const bindings = plan.tasks.map((task) => ({
      id: randomUUID(), goalRunId: id, planRevision: plan.revision, planTaskId: task.id,
      taskId: null, state: task.dependencyIds.length === 0 ? "ready" as const : "waiting" as const,
      attemptCount: 0, activeJobId: null, lastError: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }));
    const job = {
      goalRunId: id,
      expectedRevision: input.expectedRevision + 1,
      requestFingerprint: requestFingerprint({ goalRunId: id, contractDigest: contract.contractDigest }),
      requestedBy: "owner" as const
    };
    const jobId = goalOrchestrateJobId(id, job.requestFingerprint);
    const reservedAt = new Date().toISOString();
    const approved = await options.store.approveGoalRun(id, {
      expectedRevision: input.expectedRevision,
      contract,
      bindings,
      orchestrationAdmission: {
        jobId,
        goalRunId: id,
        jobName: "goal-orchestrate",
        entityId: id,
        requestFingerprint: job.requestFingerprint,
        state: "reserved",
        reservedAt,
        admittedAt: null,
        startedAt: null,
        settledAt: null,
        updatedAt: reservedAt
      },
      event: goalEvent("contract.approved", "owner", ownerId, "plan", plan.id, "Owner approved the immutable Execution Contract.", { planRevision: plan.revision, contractDigest: contract.contractDigest })
    });
    if (approved.goalRun.revision !== job.expectedRevision) {
      throw new Error("Approved Goal revision does not match its durable orchestration admission.");
    }
    const approvedAdmission = await options.store.getGoalJobAdmission(jobId);
    if (!approvedAdmission) throw new Error("Approved Goal orchestration admission was not persisted.");
    await reconcileGoalOrchestrationAdmission({
      store: options.store,
      enqueue: queue.enqueueGoalOrchestrate.bind(queue),
      admission: approvedAdmission,
      job,
      jobId,
      entityId: id
    });
    return reply.send({ ...detailResponse(approved), jobId });
  });

  for (const [action, target, summary] of [
    ["pause", "paused", "Owner paused Goal Run execution."],
    ["resume", "executing", "Owner resumed Goal Run execution."],
    ["cancel", "cancelled", "Owner cancelled Goal Run execution."]
  ] as const) {
    app.post(`/api/goal-runs/:id/${action}`, async (request, reply) => {
      const ownerId = requireOwner(request, reply);
      if (!ownerId) return;
      const { id } = parse(uuidParamsSchema, request.params);
      const input = parse(goalRunControlSchema, request.body);
      if (action === "resume" && !options.agentQueue?.enqueueGoalOrchestrate) {
        return sendError(reply, 503, "GOAL_QUEUE_UNAVAILABLE", "Goal orchestration is not configured.");
      }
      const run = await options.store.getGoalRun(id);
      if (!run) return sendError(reply, 404, "NOT_FOUND", "Goal Run not found.");
      if (action === "resume" && run.revision > input.expectedRevision) {
        const fingerprint = requestFingerprint({ goalRunId: id, revision: input.expectedRevision + 1, action: "resume" });
        const job = {
          goalRunId: id,
          expectedRevision: input.expectedRevision + 1,
          requestFingerprint: fingerprint,
          requestedBy: "owner" as const
        };
        const jobId = goalOrchestrateJobId(id, fingerprint);
        const admission = await options.store.getGoalJobAdmission(jobId);
        if (admission) {
          await reconcileGoalOrchestrationAdmission({
            store: options.store,
            enqueue: options.agentQueue!.enqueueGoalOrchestrate!.bind(options.agentQueue),
            admission,
            job,
            jobId,
            entityId: id
          });
          return reply.send(goalRunSchema.parse(run));
        }
      }
      if (run.revision !== input.expectedRevision) return sendError(reply, 409, "REVISION_CONFLICT", "Goal Run revision is stale.");
      if (action === "cancel" || action === "resume") {
        const detail = await options.store.getGoalRunDetail(id);
        const unresolvedAction = detail?.actionRuns.find((candidate) => (
          candidate.state === "running" || candidate.state === "outcome_unknown"
        ));
        if (unresolvedAction) {
          return sendError(
            reply,
            409,
            "GOAL_ACTION_RECONCILIATION_REQUIRED",
            `The Goal cannot be ${action === "cancel" ? "cancelled" : "resumed"} while a Harness Action has an active or unknown external outcome. Reconcile that Action first.`
          );
        }
      }
      const resolvedTarget = action === "resume" ? resumeGoalRunState(run.pausedFromState) : target;
      let resumeJob: {
        jobId: string;
        data: { goalRunId: string; expectedRevision: number; requestFingerprint: string; requestedBy: "owner" };
        reservedAt: string;
      } | null = null;
      if (action === "resume") {
        const fingerprint = requestFingerprint({ goalRunId: id, revision: run.revision + 1, action: "resume" });
        resumeJob = {
          jobId: goalOrchestrateJobId(id, fingerprint),
          data: {
            goalRunId: id,
            expectedRevision: run.revision + 1,
            requestFingerprint: fingerprint,
            requestedBy: "owner"
          },
          reservedAt: new Date().toISOString()
        };
      }
      const updated = await options.store.setGoalRunState(id, {
        ...transitionInput(run, resolvedTarget, ownerId, summary, action === "cancel" ? "cancelled_by_owner" : null),
        ...(resumeJob ? {
          orchestrationAdmission: {
            jobId: resumeJob.jobId,
            goalRunId: id,
            jobName: "goal-orchestrate" as const,
            entityId: id,
            requestFingerprint: resumeJob.data.requestFingerprint,
            state: "reserved" as const,
            reservedAt: resumeJob.reservedAt,
            admittedAt: null,
            startedAt: null,
            settledAt: null,
            updatedAt: resumeJob.reservedAt
          }
        } : {})
      });
      if (action === "resume") {
        if (!resumeJob || updated.revision !== resumeJob.data.expectedRevision) {
          throw new Error("Resumed Goal revision does not match its durable orchestration admission.");
        }
        const resumedAdmission = await options.store.getGoalJobAdmission(resumeJob.jobId);
        if (!resumedAdmission) throw new Error("Resumed Goal orchestration admission was not persisted.");
        await reconcileGoalOrchestrationAdmission({
          store: options.store,
          enqueue: options.agentQueue!.enqueueGoalOrchestrate!.bind(options.agentQueue),
          admission: resumedAdmission,
          job: resumeJob.data,
          jobId: resumeJob.jobId,
          entityId: id
        });
      }
      return reply.send(goalRunSchema.parse(updated));
    });
  }

  app.post("/api/goal-runs/:id/messages", async (request, reply) => {
    const ownerId = requireOwner(request, reply);
    if (!ownerId) return;
    const { id } = parse(uuidParamsSchema, request.params);
    const input = parse(goalRunMessageSchema, request.body);
    const run = await options.store.getGoalRun(id);
    if (!run) return sendError(reply, 404, "NOT_FOUND", "Goal Run not found.");
    if (run.revision !== input.expectedRevision) return sendError(reply, 409, "REVISION_CONFLICT", "Goal Run revision is stale.");
    const meeting = (await options.store.getSnapshot()).meetings.find((candidate) => (
      candidate.id === run.meetingId && candidate.threadId === run.threadId
    ));
    if (!meeting) return sendError(reply, 409, "GOAL_MEETING_LINK_INVALID", "Goal Run canonical Meeting linkage is no longer valid.");
    if (meeting.state !== "active") return sendError(reply, 409, "MEETING_NOT_ACTIVE", "The canonical Meeting must be active before posting a Goal Run instruction.");
    const utterance = (await options.store.addUtteranceWithDisposition(meeting.id, {
      turnId: `goal-run:${id}:owner-message:${randomUUID()}`,
      speakerType: "human",
      speakerName: "Owner",
      roleName: "決策者",
      content: input.content,
      kind: "human",
      evidenceCount: 0
    })).utterance;
    let event: GoalEvent;
    try {
      event = await options.store.appendGoalEvent(id, goalEvent(
        "owner.message", "owner", ownerId, "meeting", utterance.id, "Owner added a Goal Run instruction.",
        { content: input.content, meetingId: meeting.id, utteranceId: utterance.id }
      ));
    } catch (error) {
      request.log.error({ err: error, goalRunId: id, utteranceId: utterance.id }, "Goal instruction activity event could not be recorded.");
      return sendError(
        reply,
        503,
        "GOAL_INSTRUCTION_ACTIVITY_UNAVAILABLE",
        "The instruction was recorded in the canonical Meeting transcript but activity confirmation failed; it will not be used for Goal planning."
      );
    }
    return reply.code(201).send(goalEventSchema.parse(event));
  });

  app.get("/api/goal-runs/:id/canvas", async (request, reply) => {
    const { id } = parse(uuidParamsSchema, request.params);
    const { lens } = parse(canvasQuerySchema, request.query);
    const [detail, snapshot, actionAdapters] = await Promise.all([
      options.store.getGoalRunDetail(id),
      options.store.getSnapshot(),
      options.store.listActionAdapters()
    ]);
    if (!detail) return sendError(reply, 404, "NOT_FOUND", "Goal Run not found.");
    const plan = detail.plans.find((candidate) => candidate.revision === detail.goalRun.activePlanRevision) ?? null;
    return reply.send(goalCanvasSnapshotSchema.parse(projectGoalCanvas({
      goalRun: detail.goalRun,
      plan,
      taskBindings: detail.taskBindings,
      actionRuns: detail.executionContract
        ? detail.actionRuns.filter((run) => run.contractDigest === detail.executionContract!.contractDigest)
        : [],
      reviewerVerdicts: detail.executionContract
        ? detail.reviewerVerdicts.filter((verdict) => verdict.contractDigest === detail.executionContract!.contractDigest)
        : [],
      runtimeRuns: detail.runtimeRuns ?? [],
      meeting: snapshot.meetings.find((meeting) => meeting.id === detail.goalRun.meetingId) ?? null,
      participants: snapshot.participants,
      speakerQueue: snapshot.speakerQueue,
      agents: snapshot.agents,
      roles: snapshot.roles,
      modelConnectors: snapshot.modelConnectors,
      skills: snapshot.skills,
      mcpConnectors: snapshot.mcpConnectors,
      actionAdapters
    }, lens)));
  });

  app.get("/api/goal-runs/:id/events", async (request, reply) => {
    const { id } = parse(uuidParamsSchema, request.params);
    const { limit } = parse(eventQuerySchema, request.query);
    const ownerSession = request.ownerSession;
    const sessionAuthorizationRequired = !(options.authDisabled ?? false);
    if (sessionAuthorizationRequired && (
      !ownerSession
      || new Date(ownerSession.expiresAt).getTime() <= Date.now()
    )) {
      return sendError(reply, 401, "UNAUTHORIZED", "Authentication required.");
    }
    const afterSequence = parseLastEventId(request.headers);
    let closed = Boolean(request.raw.destroyed);
    let cleaned = false;
    let lastSequence = afterSequence;
    let runtimeRefreshSignature: string | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let sessionExpiry: ReturnType<typeof setTimeout> | null = null;
    let replaying = false;
    let pendingBytes = 0;
    let blocked = false;
    const pending: string[] = [];
    let releaseConnection: (() => void) | null = null;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      closed = true;
      releaseConnection?.();
      releaseConnection = null;
      if (timer) clearInterval(timer);
      if (heartbeat) clearInterval(heartbeat);
      if (sessionExpiry) clearTimeout(sessionExpiry);
      pending.length = 0;
      pendingBytes = 0;
      request.raw.off("close", cleanup);
      request.raw.off("error", cleanup);
      reply.raw.off("close", cleanup);
      reply.raw.off("drain", flush);
      reply.raw.off("error", cleanup);
      activeDisconnects.delete(disconnect);
    };
    const disconnect = () => { cleanup(); reply.raw.destroy(); };
    request.raw.once("close", cleanup);
    request.raw.once("error", cleanup);
    reply.raw.once("close", cleanup);
    reply.raw.once("error", cleanup);
    const flush = () => {
      if (closed) return;
      blocked = false;
      while (pending.length > 0) {
        const frame = pending.shift()!;
        pendingBytes -= Buffer.byteLength(frame);
        if (!reply.raw.write(frame)) { blocked = true; reply.raw.once("drain", flush); return; }
      }
    };
    const write = (frame: string) => {
      if (closed) return false;
      if (blocked) {
        const bytes = Buffer.byteLength(frame);
        if (pendingBytes + bytes > maxSseBufferedBytes) { disconnect(); return false; }
        pending.push(frame); pendingBytes += bytes; return true;
      }
      if (!reply.raw.write(frame)) { blocked = true; reply.raw.once("drain", flush); }
      return true;
    };
    const sessionIsActive = async (): Promise<boolean> => {
      if (!sessionAuthorizationRequired) return true;
      if (!ownerSession || new Date(ownerSession.expiresAt).getTime() <= Date.now()) return false;
      try {
        const current = await options.store.findSession(ownerSession.tokenHash);
        return Boolean(current
          && current.userId === ownerSession.userId
          && current.tokenHash === ownerSession.tokenHash
          && new Date(current.expiresAt).getTime() > Date.now());
      } catch (error) {
        request.log.error({ err: error, goalRunId: id }, "Goal event stream session could not be revalidated.");
        return false;
      }
    };
    const replay = async () => {
      if (closed || replaying) return;
      replaying = true;
      try {
        if (!(await sessionIsActive())) {
          disconnect();
          return;
        }
        const events = await options.store.getGoalEvents(id, lastSequence, limit);
        for (const event of events) {
          if (!(await sessionIsActive())) {
            disconnect();
            return;
          }
          if (!write(sseFrame(event))) return;
          lastSequence = event.sequence;
        }
        const runtimeRuns = await options.store.listRuntimeRunsForGoal(id);
        const runtimeSummary = runtimeRuns.map((run) => ({
          id: run.id,
          revision: run.revision,
          state: run.state,
          eventCursor: run.eventCursor
        }));
        const nextRuntimeSignature = JSON.stringify(runtimeSummary);
        if (runtimeRefreshSignature !== nextRuntimeSignature) {
          runtimeRefreshSignature = nextRuntimeSignature;
          if (runtimeSummary.length > 0) {
            write(`event: runtime.refresh\ndata: ${JSON.stringify({ goalRunId: id, runtimeRuns: runtimeSummary })}\n\n`);
          }
        }
      } finally {
        replaying = false;
      }
    };
    const goalRun = await options.store.getGoalRun(id);
    if (closed || request.raw.destroyed || reply.raw.destroyed) {
      cleanup();
      return;
    }
    if (!goalRun) {
      cleanup();
      return sendError(reply, 404, "NOT_FOUND", "Goal Run not found.");
    }
    const activeSession = await sessionIsActive();
    if (closed || request.raw.destroyed || reply.raw.destroyed) {
      cleanup();
      return;
    }
    if (!activeSession) {
      cleanup();
      return sendError(reply, 401, "UNAUTHORIZED", "Authentication required.");
    }
    releaseConnection = reserveGoalSseConnection(ownerSession);
    if (!releaseConnection) {
      cleanup();
      return sendError(reply, 429, "GOAL_SSE_CONNECTION_LIMIT_EXCEEDED", "Goal event stream connection limit exceeded.");
    }
    if (closed || request.raw.destroyed || reply.raw.destroyed) {
      cleanup();
      return;
    }
    activeDisconnects.add(disconnect);
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    try {
      await replay();
    } catch (error) {
      request.log.error({ err: error, goalRunId: id }, "Goal event replay failed.");
      disconnect();
      return;
    }
    if (closed) return;
    write(`event: ready\ndata: ${JSON.stringify({ goalRunId: id, lastSequence })}\n\n`);
    timer = setInterval(() => { void replay().catch(() => disconnect()); }, 1_000);
    heartbeat = setInterval(() => {
      void sessionIsActive().then((active) => {
        if (!active) disconnect();
        else write(": heartbeat\n\n");
      }).catch(() => disconnect());
    }, 15_000);
    if (sessionAuthorizationRequired && ownerSession) {
      sessionExpiry = setTimeout(disconnect, Math.max(0, new Date(ownerSession.expiresAt).getTime() - Date.now()));
    }
  });
}
