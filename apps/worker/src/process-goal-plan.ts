import { createHash } from "node:crypto";
import {
  goalPlanTaskSchema,
  type GoalPlanJobData,
  type GoalPlanTask,
  type GoalPlannerProvenance,
  type PlatformSnapshot
} from "@council/contracts";
import { roleExecutionSnapshotDigest, type PlatformStore } from "@council/database";
import { goalPlanDigest } from "@council/domain";
import { beginGoalJob, settleGoalJob, type GoalJobAdmissionStore } from "./goal-job-admission.js";
import { isGoalRunTerminal, pauseGoalRun } from "./goal-run-control.js";

export type GoalPlanStore = Pick<PlatformStore,
  | "getGoalEvents"
  | "getGoalRun"
  | "getGoalRunDetail"
  | "getSnapshot"
  | "getAgentRevision"
  | "setGoalRunState"
  | "saveGoalPlan"
> & GoalJobAdmissionStore;

export interface ProcessGoalPlanInput {
  store: GoalPlanStore;
  data: GoalPlanJobData;
  jobId: string;
}

export type GoalPlanResult = "settled" | "planned" | "stale";

const planTaskLimits = {
  title: 160,
  description: 4_000,
  acceptanceCriteria: 4_000,
  allowedTools: 20,
  allowedTool: 200
} as const;

function stableUuid(namespace: string): string {
  const bytes = Buffer.from(createHash("sha256").update(namespace).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function projectPlanTasks(input: {
  goalRunId: string;
  decisions: Awaited<ReturnType<GoalPlanStore["getSnapshot"]>>["decisions"];
  canonicalTasks: Awaited<ReturnType<GoalPlanStore["getSnapshot"]>>["tasks"];
  participants: Awaited<ReturnType<GoalPlanStore["getSnapshot"]>>["participants"];
  agents: Awaited<ReturnType<GoalPlanStore["getSnapshot"]>>["agents"];
  ownerInstructionContext: string | null;
}): GoalPlanTask[] {
  const workers = input.participants
    .filter((participant) => !participant.isChair)
    .map((participant) => input.agents.find((agent) => agent.id === participant.agentId))
    .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent && agent.lifecycleStatus !== "disabled"));
  return input.decisions.map((decision, index) => {
    const canonical = input.canonicalTasks.find((task) => task.decisionId === decision.id);
    const assignee = canonical?.assigneeAgentId
      ? input.agents.find((agent) => agent.id === canonical.assigneeAgentId) ?? null
      : workers[index % Math.max(workers.length, 1)] ?? null;
    const executionMode = canonical?.executionProfile ?? (assignee ? "worker" : "manual");
    const description = (canonical?.description ?? decision.description).trim().slice(0, planTaskLimits.description);
    const acceptanceCriteria = (canonical?.acceptanceCriteria
      || `Provide evidence that verifies: ${decision.description}`)
      .trim()
      .slice(0, planTaskLimits.acceptanceCriteria);
    const allowedTools = [...new Set(
      (canonical?.allowedTools ?? assignee?.toolGrants.map((grant) => `${grant.connectorId}:${grant.toolName}`) ?? [])
        .map((tool) => tool.trim().slice(0, planTaskLimits.allowedTool))
        .filter(Boolean)
    )].slice(0, planTaskLimits.allowedTools);
    return goalPlanTaskSchema.parse({
      id: stableUuid(`${input.goalRunId}:decision:${decision.id}`),
      decisionId: decision.id,
      title: (canonical?.title ?? decision.title).trim().slice(0, planTaskLimits.title),
      description,
      acceptanceCriteria,
      dependencyIds: [],
      assigneeAgentId: canonical?.assigneeAgentId ?? assignee?.id ?? null,
      executionMode,
      allowedTools,
      dataScope: withOwnerInstructionContext(
        canonical?.dataScope || assignee?.dataSummary || "Formal Meeting transcript, Decision, and approved evidence only.",
        input.ownerInstructionContext
      ),
      action: null
    });
  });
}

function withOwnerInstructionContext(dataScope: string, ownerInstructionContext: string | null): string {
  if (!ownerInstructionContext) return dataScope.slice(0, 2_000);
  const context = `\n\nOwner instructions from the canonical Meeting transcript:\n${ownerInstructionContext}`.slice(0, 1_000);
  return `${dataScope.slice(0, 2_000 - context.length)}${context}`;
}

function confirmedOwnerInstructionContext(input: {
  goalRunId: string;
  meetingId: string;
  utterances: Awaited<ReturnType<GoalPlanStore["getSnapshot"]>>["utterances"];
  events: Awaited<ReturnType<GoalPlanStore["getGoalEvents"]>>;
}): string | null {
  const confirmedUtteranceIds = new Set(input.events
    .filter((event) => (
      event.type === "owner.message"
      && event.actorType === "owner"
      && event.entityType === "meeting"
      && event.detail.meetingId === input.meetingId
      && event.detail.utteranceId === event.entityId
    ))
    .map((event) => event.entityId));
  const instructions = input.utterances
    .filter((utterance) => (
      utterance.meetingId === input.meetingId
      && utterance.turnId?.startsWith(`goal-run:${input.goalRunId}:owner-message:`)
      && utterance.speakerType === "human"
      && utterance.speakerName === "Owner"
      && utterance.roleName === "決策者"
      && confirmedUtteranceIds.has(utterance.id)
    ))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .slice(-4)
    .map((utterance) => `Owner (${utterance.roleName}): ${utterance.content.slice(0, 220)}`);
  return instructions.length > 0 ? instructions.join("\n") : null;
}

async function loadGoalEvents(store: GoalPlanStore, goalRunId: string): Promise<Awaited<ReturnType<GoalPlanStore["getGoalEvents"]>>> {
  const events: Awaited<ReturnType<GoalPlanStore["getGoalEvents"]>> = [];
  let afterSequence = 0;
  while (true) {
    const page = await store.getGoalEvents(goalRunId, afterSequence, 500);
    events.push(...page);
    const last = page.at(-1);
    if (page.length < 500 || !last || last.sequence <= afterSequence) return events;
    afterSequence = last.sequence;
  }
}

async function resolvePlannerProvenance(
  store: GoalPlanStore,
  snapshot: PlatformSnapshot,
  meetingId: string
): Promise<GoalPlannerProvenance | null> {
  for (const participant of snapshot.participants.filter((candidate) => candidate.meetingId === meetingId)) {
    if (!participant.roleSnapshot.orchestrationFunctions.includes("planner")) continue;
    const agent = snapshot.agents.find((candidate) => candidate.id === participant.agentId);
    if (!agent || agent.lifecycleStatus === "disabled" || !agent.publishedRevision) continue;
    const agentRevision = participant.agentRevision ?? agent.publishedRevision;
    const revision = await store.getAgentRevision(agent.id, agentRevision).catch(() => null);
    if (!revision?.modelConnectorId) continue;
    const roleHistory = participant.roleHistory.find((entry) => (
      entry.revision === participant.roleRevision
      && entry.roleId === participant.roleId
      && entry.roleSnapshot.orchestrationFunctions.includes("planner")
    ));
    if (!roleHistory) continue;
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
  return null;
}

export async function processGoalPlan(input: ProcessGoalPlanInput): Promise<GoalPlanResult> {
  const requestFingerprint = `${input.data.goalRunId}:${input.data.expectedRevision}:${input.data.expectedPlanRevision}`;
  const admission = await beginGoalJob({
    store: input.store,
    jobId: input.jobId,
    goalRunId: input.data.goalRunId,
    jobName: "goal-plan",
    entityId: String(input.data.expectedPlanRevision),
    requestFingerprint
  });
  if (admission.status !== "run") return "settled";
  const detail = await input.store.getGoalRunDetail(input.data.goalRunId);
  if (!detail
    || detail.goalRun.revision !== input.data.expectedRevision
    || detail.goalRun.activePlanRevision !== input.data.expectedPlanRevision
    || isGoalRunTerminal(detail.goalRun.state)
    || !["planning", "awaiting_approval", "replanning"].includes(detail.goalRun.state)) {
    await settleGoalJob(input.store, admission.admission);
    return "stale";
  }
  const snapshot = await input.store.getSnapshot();
  const meeting = snapshot.meetings.find((candidate) => candidate.id === detail.goalRun.meetingId);
  if (!meeting || meeting.threadId !== detail.goalRun.threadId) {
    await settleGoalJob(input.store, admission.admission);
    return "stale";
  }
  const decisions = snapshot.decisions
    .filter((decision) => decision.meetingId === meeting.id && decision.status !== "rejected")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .slice(0, detail.goalRun.limits.maxTasks);
  if (decisions.length === 0) {
    await settleGoalJob(input.store, admission.admission);
    return "settled";
  }
  const plannerProvenance = await resolvePlannerProvenance(input.store, snapshot, meeting.id);
  if (!plannerProvenance) {
    const current = await input.store.getGoalRun(detail.goalRun.id);
    if (current && current.state !== "paused" && !isGoalRunTerminal(current.state)) {
      await pauseGoalRun(
        input.store,
        current,
        "Goal Run is paused because no ready Meeting participant has an attributable Planner capability."
      );
    }
    await settleGoalJob(input.store, admission.admission);
    return "settled";
  }
  try {
    const tasks = projectPlanTasks({
      goalRunId: detail.goalRun.id,
      decisions,
      canonicalTasks: snapshot.tasks,
      participants: snapshot.participants.filter((participant) => participant.meetingId === meeting.id),
      agents: snapshot.agents,
      ownerInstructionContext: confirmedOwnerInstructionContext({
        goalRunId: detail.goalRun.id,
        meetingId: meeting.id,
        utterances: snapshot.utterances,
        events: await loadGoalEvents(input.store, detail.goalRun.id)
      })
    });
    const digest = goalPlanDigest(tasks);
    const activePlan = detail.plans.find((plan) => plan.revision === detail.goalRun.activePlanRevision);
    if (activePlan?.digest === digest) {
      await settleGoalJob(input.store, admission.admission);
      return "settled";
    }
    const revision = detail.goalRun.activePlanRevision + 1;
    const plan = {
      id: stableUuid(`${detail.goalRun.id}:plan:${revision}:${digest}`),
      goalRunId: detail.goalRun.id,
      revision,
      status: "draft" as const,
      digest,
      tasks,
      plannerProvenance,
      createdAt: new Date().toISOString()
    };
    await input.store.saveGoalPlan(detail.goalRun.id, {
      expectedRevision: detail.goalRun.revision,
      expectedPlanRevision: detail.goalRun.activePlanRevision,
      plan,
      event: {
        type: detail.goalRun.activePlanRevision === 0 ? "plan.created" : "plan.revised",
        actorType: "agent",
        actorId: plannerProvenance.plannerAgentId,
        entityType: "plan",
        entityId: plan.id,
        summary: "Formal Meeting Decisions were projected into a reviewable Goal Plan.",
        detail: {
          revision,
          digest,
          decisionCount: decisions.length,
          source: "formal_meeting_decisions",
          ...plannerProvenance
        }
      }
    });
    await settleGoalJob(input.store, admission.admission);
    return "planned";
  } catch (error) {
    const current = await input.store.getGoalRun(detail.goalRun.id);
    if (current && current.state !== "paused" && !isGoalRunTerminal(current.state)) {
      await pauseGoalRun(
        input.store,
        current,
        "Goal Run is paused because Goal Plan generation failed. Correct the Planner input or infrastructure, then resume.",
        {
          jobId: input.jobId,
          jobName: "goal-plan",
          errorType: error instanceof Error ? error.name : "UnknownError"
        }
      );
    }
    await settleGoalJob(input.store, admission.admission);
    return "settled";
  }
}
