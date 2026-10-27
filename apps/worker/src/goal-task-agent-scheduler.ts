import type {
  CredentialBinding,
  ExecutionRuntimeBinding,
  PlatformSnapshot,
  Task,
  TaskAgentRunJobData
} from "@council/contracts";
import type { PlatformStore } from "@council/database";
import {
  requestFingerprint,
  skillHasCurrentApprovedValidation,
  taskExecutionFingerprint
} from "@council/database";
import {
  createQueuedRuntimeRun,
  credentialIsExpired,
  resolveRuntimeProfileAdmission,
  runtimeDataScopeDigest,
  runtimeRunQueueTtlMs,
  stableRuntimeRunId
} from "@council/domain";

export type GoalTaskAgentStore = Pick<PlatformStore,
  | "getAgentReadiness"
  | "getAgentRevision"
  | "getRuntimeRun"
  | "getSnapshot"
  | "markTaskAgentRunQueued"
>;

export interface ScheduleGoalTaskAgentInput {
  store: GoalTaskAgentStore;
  taskId: string;
  jobId: string;
  enqueue(job: TaskAgentRunJobData, jobId: string): Promise<{ jobId: string }>;
}

export interface PrepareGoalTaskAgentInput {
  store: GoalTaskAgentStore;
  taskId: string;
  jobId: string;
  goalRunId?: string;
  planTaskId?: string;
  executionRuntimeBinding?: ExecutionRuntimeBinding;
  executionIsolationAttested?: boolean;
}

export interface AdmitPreparedGoalTaskAgentInput {
  store: GoalTaskAgentStore;
  prepared: PreparedGoalTaskAgentRun;
  jobId: string;
  enqueue(job: TaskAgentRunJobData, jobId: string): Promise<{ jobId: string }>;
}

export interface PreparedGoalTaskAgentRun {
  task: Task;
  job: TaskAgentRunJobData;
}

export interface ScheduledGoalTaskAgentRun {
  task: Task;
  job: TaskAgentRunJobData;
  replayed: boolean;
}

function credentialBinding(
  snapshot: PlatformSnapshot,
  connector: PlatformSnapshot["modelConnectors"][number]
): CredentialBinding | null {
  if (!connector.credentialId) {
    if (connector.location === "local" && !connector.hasSecret) return null;
    throw new Error("Goal Task Agent Model Connector has no active Credential binding.");
  }
  const credential = (snapshot.credentials ?? []).find((item) => item.id === connector.credentialId);
  if (!credential || credential.status !== "active" || !credential.hasSecret || credentialIsExpired(credential.expiresAt)) {
    throw new Error("Goal Task Agent Model Connector Credential is unavailable or expired.");
  }
  if (credential.secretRevision !== connector.secretRevision) {
    throw new Error("Goal Task Agent Model Connector Credential revision is stale.");
  }
  return {
    credentialId: credential.id,
    secretRevision: credential.secretRevision,
    provider: credential.provider,
    location: credential.location
  };
}

export async function prepareGoalTaskAgent(input: PrepareGoalTaskAgentInput): Promise<PreparedGoalTaskAgentRun> {
  const snapshot = await input.store.getSnapshot();
  const task = snapshot.tasks.find((candidate) => candidate.id === input.taskId);
  if (!task) throw new Error("Goal canonical Task was not found.");
  if (task.executionProfile === "manual") throw new Error("Manual Goal Tasks cannot run through Task Agent.");
  if (!task.assigneeAgentId) throw new Error("Goal Task requires an assigned Agent.");
  if (task.executionProfile === "worker" && task.approvalState !== "approved") {
    throw new Error("Goal Worker Task is not covered by an approved execution boundary.");
  }
  if (task.status === "done") throw new Error("Completed Goal Task cannot start another Agent run.");
  const replayingActiveJob = task.execution.status === "queued" || task.execution.status === "running";
  if (task.execution.status === "queued" || task.execution.status === "running") {
    if (task.execution.jobId !== input.jobId || !task.execution.agentId || !task.execution.profile
      || !task.execution.requestFingerprint) {
      throw new Error("Goal Task already has a different active Agent execution.");
    }
  }
  const decision = snapshot.decisions.find((candidate) => candidate.id === task.decisionId && candidate.meetingId === task.meetingId);
  if (!decision || decision.status !== "approved") throw new Error("Goal Task source Decision is not approved.");
  const readiness = await input.store.getAgentReadiness(
    task.assigneeAgentId,
    input.executionIsolationAttested === undefined
      ? undefined
      : { executionIsolationAttested: input.executionIsolationAttested }
  );
  const blocked = readiness.checks.find((check) => check.status === "blocked");
  if (blocked) throw new Error(`Goal Task Agent is not ready: ${blocked.message}`);
  const agent = snapshot.agents.find((candidate) => candidate.id === task.assigneeAgentId);
  const publishedRevision = agent?.publishedRevision ?? null;
  if (!agent || agent.lifecycleStatus === "disabled" || !publishedRevision) {
    throw new Error("Goal Task Agent has no current published revision.");
  }
  const revision = await input.store.getAgentRevision(agent.id, publishedRevision);
  if (!revision.modelConnectorId || !revision.runtimeProfileBinding) {
    throw new Error("Goal Task Agent runtime binding is incomplete.");
  }
  const connector = snapshot.modelConnectors.find((candidate) => candidate.id === revision.modelConnectorId && candidate.enabled);
  if (!connector) throw new Error("Goal Task Agent Model Connector is disabled or unavailable.");
  const runtimeProfileSnapshot = resolveRuntimeProfileAdmission({
    binding: revision.runtimeProfileBinding,
    platform: snapshot,
    agentModelConnectorId: revision.modelConnectorId,
    executionIsolationAttested: input.executionIsolationAttested
  });
  const approvedRuntime = input.executionRuntimeBinding;
  if ((input.goalRunId !== undefined || input.planTaskId !== undefined || approvedRuntime !== undefined)
    && (!input.goalRunId || !input.planTaskId || !approvedRuntime)) {
    throw new Error("Goal Task requires complete immutable Runtime dispatch bindings.");
  }
  if (approvedRuntime) {
    const bindingMatches = approvedRuntime.planTaskId === input.planTaskId
      && approvedRuntime.agentId === agent.id
      && approvedRuntime.agentRevision === revision.revision
      && approvedRuntime.runtimeProfileId === runtimeProfileSnapshot.profileId
      && approvedRuntime.runtimeProfileRevision === runtimeProfileSnapshot.revision
      && approvedRuntime.harnessKind === runtimeProfileSnapshot.harnessKind
      && approvedRuntime.modelConnectorId === connector.id
      && approvedRuntime.modelConnectorRevision === connector.revision
      && approvedRuntime.modelConnectorSecretRevision === connector.secretRevision
      && approvedRuntime.timeoutMs === runtimeProfileSnapshot.timeoutMs
      && approvedRuntime.dataScopeDigest === runtimeDataScopeDigest(task.dataScope)
      && JSON.stringify(approvedRuntime.allowedTools) === JSON.stringify(task.allowedTools.filter((tool) => approvedRuntime.allowedTools.includes(tool)));
    if (!bindingMatches) throw new Error("Goal Task no longer matches its approved Execution Runtime binding.");
  }
  const skills = revision.skillIds.map((skillId) => snapshot.skills.find((skill) => skill.id === skillId));
  if (skills.some((skill) => !skill || !skillHasCurrentApprovedValidation(skill))) {
    throw new Error("Goal Task Agent has a Skill binding that is no longer approved.");
  }
  const credential = credentialBinding(snapshot, connector);
  const runRequestFingerprint = replayingActiveJob
    ? task.execution.requestFingerprint!
    : requestFingerprint({
      goalContractScheduling: true,
      taskId: task.id,
      expectedExecutionRevision: task.execution.revision,
      assigneeAgentId: task.assigneeAgentId,
      executionProfile: task.executionProfile
    });
  const executionRevision = replayingActiveJob ? task.execution.revision : task.execution.revision + 1;
  const executionAttempt = replayingActiveJob ? task.execution.attemptCount : task.execution.attemptCount + 1;
  const runtimeRunId = stableRuntimeRunId(input.jobId);
  const existingRuntimeRun = await input.store.getRuntimeRun(runtimeRunId);
  const runtimeRun = existingRuntimeRun ?? createQueuedRuntimeRun({
    id: runtimeRunId,
    kind: "task_agent",
    scope: {
      id: `task:${task.id}:attempt:${executionAttempt}`,
      kind: "task_attempt",
      subjectId: task.id,
      parentScopeId: null
    },
    runtimeProfile: runtimeProfileSnapshot,
    goalRunId: input.goalRunId ?? null,
    taskId: task.id,
    runtimeVersion: approvedRuntime?.runtimeVersion ?? null,
    agentId: agent.id,
    agentRevision: revision.revision,
    roleId: null,
    roleRevision: null,
    attempt: executionAttempt,
    idempotencyKey: input.jobId,
    queuedAt: new Date().toISOString(),
    ttlMs: runtimeRunQueueTtlMs(runtimeProfileSnapshot)
  });
  const job: TaskAgentRunJobData = {
    taskId: task.id,
    ...(input.goalRunId ? { goalRunId: input.goalRunId } : {}),
    ...(input.planTaskId ? { planTaskId: input.planTaskId } : {}),
    agentId: agent.id,
    executionProfile: task.executionProfile,
    executionRevision,
    taskFingerprint: taskExecutionFingerprint(task),
    requestFingerprint: runRequestFingerprint,
    modelConnectorBinding: {
      id: connector.id,
      location: connector.location,
      baseUrl: connector.baseUrl,
      model: connector.model,
      secretRevision: connector.secretRevision
    },
    agentRevision: revision.revision,
    promptBinding: revision.promptBinding,
    ...(credential ? { credentialBinding: credential } : {}),
    skillDigests: Object.fromEntries(skills.map((skill) => [skill!.id, skill!.contentDigest])),
    runtimeProfileBinding: { ...revision.runtimeProfileBinding },
    runtimeProfileSnapshot,
    runtimeRun,
    ...(approvedRuntime ? { executionRuntimeBinding: structuredClone(approvedRuntime) } : {}),
    requestedBy: "owner"
  };
  return { task, job };
}

export async function admitPreparedGoalTaskAgent(
  input: AdmitPreparedGoalTaskAgentInput
): Promise<ScheduledGoalTaskAgentRun> {
  const reserved = await input.store.markTaskAgentRunQueued(input.jobId, input.prepared.job);
  if (reserved.status === "unchanged") return { task: reserved.task, job: input.prepared.job, replayed: true };
  const queued = await input.enqueue(input.prepared.job, input.jobId);
  if (queued.jobId !== input.jobId) throw new Error("Goal Task Agent queue returned a mismatched job ID.");
  return { task: reserved.task, job: input.prepared.job, replayed: false };
}

export async function scheduleGoalTaskAgent(input: ScheduleGoalTaskAgentInput): Promise<ScheduledGoalTaskAgentRun> {
  const prepared = await prepareGoalTaskAgent(input);
  return admitPreparedGoalTaskAgent({
    store: input.store,
    prepared,
    jobId: input.jobId,
    enqueue: input.enqueue
  });
}
