import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  runtimeRunSchema,
  type AgentRevision,
  type ExecutionRuntimeBinding,
  type ModelConnector,
  type OmpBrokerEvent,
  type OmpBrokerSession,
  type PlatformSnapshot,
  type Task,
  type TaskAgentRunJobData
} from "@council/contracts";
import { taskExecutionFingerprint } from "@council/database";
import { applyRuntimeRunMutation, runtimeDataScopeDigest } from "@council/domain";
import type { OmpBrokerClient } from "./omp-broker-client.js";
import {
  OmpRuntimeReconciliationError,
  pauseOmpRuntimeOutcomeUnknown,
  processOmpTaskRuntime
} from "./process-omp-task-runtime.js";

const ids = {
  run: "70000000-0000-4000-8000-000000000001",
  goal: "70000000-0000-4000-8000-000000000002",
  task: "70000000-0000-4000-8000-000000000003",
  planTask: "70000000-0000-4000-8000-000000000004",
  decision: "70000000-0000-4000-8000-000000000005",
  meeting: "70000000-0000-4000-8000-000000000006",
  agent: "70000000-0000-4000-8000-000000000007",
  connector: "70000000-0000-4000-8000-000000000008",
  profile: "70000000-0000-4000-8000-000000000009",
  sandbox: "70000000-0000-4000-8000-000000000010",
  lease: "70000000-0000-4000-8000-000000000011"
};

function fixture() {
  const at = "2026-09-02T00:00:00.000Z";
  const connector: ModelConnector = {
    id: ids.connector,
    revision: 2,
    name: "GB10 local",
    location: "local",
    baseUrl: "http://model-tunnel:4001/v1",
    model: "gb10-coder",
    enabled: true,
    hasSecret: false,
    secretRevision: 0,
    credentialId: null
  };
  const agentRevision: AgentRevision = {
    agentId: ids.agent,
    revision: 1,
    name: "Coder",
    description: "Bounded coding Agent.",
    modelConnectorId: connector.id,
    goalSummary: "Produce a reviewable patch.",
    toolsSummary: "OMP built-ins only.",
    dataSummary: "Approved archive only.",
    runtimeProfileBinding: { profileId: ids.profile, revision: 1 },
    toolGrants: [],
    toolPackGrants: [],
    skillIds: [],
    promptBinding: null,
    contentDigest: "a".repeat(64),
    contentDigestVersion: 3,
    source: "published",
    restoredFromRevision: null,
    createdAt: at,
    publishedAt: at
  };
  let task: Task = {
    id: ids.task,
    meetingId: ids.meeting,
    decisionId: ids.decision,
    revision: 1,
    boardRevision: 1,
    title: "Implement approved change",
    description: "Edit only the approved archive.",
    status: "in_progress",
    position: 0,
    assignee: null,
    assigneeAgentId: ids.agent,
    dueAt: null,
    acceptanceCriteria: "Patch and test manifest are available.",
    evidence: [],
    executionProfile: "worker",
    allowedTools: [],
    dataScope: "Approved repository archive only.",
    approvalState: "approved",
    execution: {
      revision: 1,
      status: "queued",
      jobId: "goal-task-job-1",
      requestFingerprint: "goal-task-request-1",
      agentId: ids.agent,
      profile: "worker",
      attemptCount: 1,
      requestedAt: at,
      startedAt: null,
      providerStartedAt: null,
      completedAt: null,
      lastError: null,
      resultEvidenceId: null,
      runtimeProfileBinding: { profileId: ids.profile, revision: 1 }
    },
    transitions: [],
    sync: {
      status: "not_synced",
      adapterId: null,
      jobId: null,
      requestFingerprint: null,
      externalId: null,
      attemptCount: 0,
      lastAttemptAt: null,
      lastError: null,
      syncedAt: null
    },
    createdAt: at,
    updatedAt: at
  };
  const executionBinding: ExecutionRuntimeBinding = {
    planTaskId: ids.planTask,
    route: "omp_coding",
    runtimeProfileId: ids.profile,
    runtimeProfileRevision: 1,
    harnessKind: "pi",
    runtimeVersion: "omp-rpc-v2@18.1.2",
    policy: "isolated_exec",
    capabilities: ["text", "file_read", "file_write", "process"],
    agentId: ids.agent,
    agentRevision: 1,
    modelConnectorId: connector.id,
    modelConnectorRevision: connector.revision,
    modelConnectorSecretRevision: 0,
    sandboxProfileId: ids.sandbox,
    sandboxImageDigest: `sha256:${"b".repeat(64)}`,
    workspaceSource: { sourceId: "council-canary", archiveDigest: `sha256:${"c".repeat(64)}` },
    allowedTools: ["read", "grep", "glob", "lsp", "edit", "bash"],
    dataScopeDigest: runtimeDataScopeDigest(task.dataScope),
    timeoutMs: 2 * 60 * 60_000
  };
  let run = runtimeRunSchema.parse({
    id: ids.run,
    kind: "task_agent",
    scope: { id: `task:${ids.task}:attempt:1`, kind: "task_attempt", subjectId: ids.task, parentScopeId: null },
    runtimeProfile: {
      profileId: ids.profile,
      revision: 1,
      harnessKind: "pi",
      modelConnectorId: connector.id,
      sandboxProfileId: ids.sandbox,
      policy: "isolated_exec",
      capabilities: ["text", "abort", "resume", "file_read", "file_write", "process"],
      timeoutMs: 2 * 60 * 60_000,
      maxConcurrency: 1
    },
    goalRunId: ids.goal,
    taskId: ids.task,
    agentId: ids.agent,
    agentRevision: 1,
    roleId: null,
    roleRevision: null,
    state: "queued",
    attempt: 1,
    idempotencyKey: "goal-task-job-1",
    evidenceIds: [],
    queuedAt: at,
    startedAt: null,
    completedAt: null,
    expiresAt: "2026-09-02T02:00:00.000Z",
    errorCode: null,
    runtimeVersion: "omp-rpc-v2@18.1.2"
  });
  const planTask = {
    id: ids.planTask,
    decisionId: ids.decision,
    title: task.title,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    dependencyIds: [],
    assigneeAgentId: ids.agent,
    executionMode: "worker" as const,
    allowedTools: [],
    dataScope: task.dataScope,
    action: null
  };
  const snapshot = (): PlatformSnapshot => ({
    groups: [], categories: [], tags: [], threads: [], agents: [], roles: [], skills: [],
    modelConnectors: [connector], mcpConnectors: [], taskAdapterConnectors: [], meetings: [], participants: [],
    speakerQueue: [], utterances: [], toolRuns: [], chairSuggestions: [], decisions: [], tasks: [structuredClone(task)]
  });
  const detail = {
    goalRun: { activePlanRevision: 1 },
    plans: [{ revision: 1, tasks: [planTask] }],
    executionContract: { runtimeBindings: [executionBinding] },
    taskBindings: [{ planTaskId: ids.planTask, taskId: ids.task }]
  };
  const data = (): TaskAgentRunJobData => ({
    taskId: ids.task,
    goalRunId: ids.goal,
    planTaskId: ids.planTask,
    agentId: ids.agent,
    executionProfile: "worker",
    executionRevision: 1,
    taskFingerprint: taskExecutionFingerprint(task),
    requestFingerprint: "goal-task-request-1",
    modelConnectorBinding: {
      id: connector.id,
      location: connector.location,
      baseUrl: connector.baseUrl,
      model: connector.model,
      secretRevision: 0
    },
    agentRevision: 1,
    promptBinding: null,
    skillDigests: {},
    runtimeProfileBinding: { profileId: ids.profile, revision: 1 },
    runtimeProfileSnapshot: run.runtimeProfile,
    runtimeRun: structuredClone(run),
    executionRuntimeBinding: executionBinding,
    requestedBy: "owner"
  });
  const store = {
    appendRuntimeRunEvent: vi.fn(),
    getRuntimeRun: vi.fn(async () => structuredClone(run)),
    updateRuntimeRun: vi.fn(async (_id: string, input: Parameters<typeof applyRuntimeRunMutation>[1] & { event: unknown }) => {
      const { event: _event, ...mutation } = input;
      run = applyRuntimeRunMutation(run, mutation);
      return structuredClone(run);
    }),
    getSnapshot: vi.fn(async () => snapshot()),
    getGoalRunDetail: vi.fn(async () => detail),
    getAgentRevision: vi.fn(async () => agentRevision),
    markTaskAgentRunRunning: vi.fn(async () => {
      if (task.execution.status === "queued") {
        task = { ...task, execution: { ...task.execution, status: "running", startedAt: new Date().toISOString() } };
        return { status: "updated" as const, task: structuredClone(task) };
      }
      return { status: "unchanged" as const, task: structuredClone(task) };
    }),
    claimTaskAgentProviderAttempt: vi.fn(async () => {
      if (!task.execution.providerStartedAt) {
        task = { ...task, execution: { ...task.execution, providerStartedAt: new Date().toISOString() } };
        return { status: "updated" as const, task: structuredClone(task) };
      }
      return { status: "unchanged" as const, task: structuredClone(task) };
    }),
    completeTaskAgentRun: vi.fn(async (_jobId: string, _data: TaskAgentRunJobData, content: string) => {
      if (task.execution.status === "completed") {
        return { status: "unchanged" as const, task: structuredClone(task) };
      }
      const evidenceId = randomUUID();
      task = {
        ...task,
        status: "review",
        evidence: [...task.evidence, {
          id: evidenceId, type: "note", label: "OMP result", reference: content.trim().slice(0, 4_000),
          addedBy: "system", agentId: ids.agent, jobId: "goal-task-job-1", executionProfile: "worker",
          createdAt: new Date().toISOString()
        }],
        execution: { ...task.execution, status: "completed", completedAt: new Date().toISOString(), resultEvidenceId: evidenceId }
      };
      return { status: "updated" as const, task: structuredClone(task) };
    }),
    failTaskAgentRun: vi.fn(async () => ({ status: "updated" as const, task: structuredClone(task) }))
  };
  return { store, data, getRun: () => run, getTask: () => task };
}

function brokerFixture() {
  let state: OmpBrokerSession["state"] = "running";
  let cursor = 2;
  const events: OmpBrokerEvent[] = [
    { sequence: 1, kind: "state.changed", summary: "Provisioned.", toolName: null, progressPercent: 0, inputTokens: null, outputTokens: null, toolCalls: null, errorCode: null, occurredAt: "2026-09-02T00:00:01.000Z" },
    { sequence: 2, kind: "agent.started", summary: "Agent started.", toolName: null, progressPercent: 10, inputTokens: null, outputTokens: null, toolCalls: null, errorCode: null, occurredAt: "2026-09-02T00:00:02.000Z" }
  ];
  const session = (): OmpBrokerSession => ({
    runtimeRunId: ids.run,
    goalRunId: ids.goal,
    taskId: ids.task,
    idempotencyKey: "goal-task-job-1",
    requestDigest: `sha256:${"d".repeat(64)}`,
    state,
    runtimeVersion: "omp-rpc-v2@18.1.2",
    leaseId: ids.lease,
    containerId: "rootless-1",
    providerSessionId: "omp-session-1",
    providerSessionFile: "/opt/council-omp-config/sessions/session.jsonl",
    eventCursor: cursor,
    errorCode: null,
    artifactManifest: state === "completed" ? {
      artifactRef: `runtime-run/${ids.run}/artifacts/manifest.json`,
      patchDigest: `sha256:${"e".repeat(64)}`,
      manifestDigest: `sha256:${"f".repeat(64)}`,
      changedFiles: [{ path: "src/result.ts", status: "modified", digest: `sha256:${"1".repeat(64)}` }],
      tests: [{ commandDigest: `sha256:${"2".repeat(64)}`, exitCode: 0, durationMs: 30, outputDigest: `sha256:${"3".repeat(64)}` }],
      createdAt: "2026-09-02T00:10:00.000Z"
    } : null,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:10:00.000Z",
    expiresAt: "2026-09-02T02:00:00.000Z"
  });
  const start = vi.fn(async () => session());
  const broker: OmpBrokerClient = {
    health: vi.fn(),
    get: vi.fn(async () => null),
    start,
    events: vi.fn(async (_id, after) => events.filter((event) => event.sequence > after)),
    control: vi.fn()
  };
  return {
    broker,
    start,
    complete() {
      state = "completed";
      cursor = 3;
      events.push({ sequence: 3, kind: "agent.completed", summary: "Agent completed.", toolName: null, progressPercent: 90, inputTokens: null, outputTokens: null, toolCalls: null, errorCode: null, occurredAt: "2026-09-02T00:09:00.000Z" });
      vi.mocked(broker.get).mockResolvedValue(session());
    }
  };
}

describe("OMP Task Runtime processor", () => {
  it.each([false, true])("repairs the Task/Runtime completion crash window with bounded whitespace=%s", async (boundedWhitespace) => {
    const state = fixture();
    const runtime = brokerFixture();
    const input = { store: state.store as never, broker: runtime.broker, runtimeRunId: ids.run };
    await processOmpTaskRuntime(input);
    runtime.complete();
    if (boundedWhitespace) {
      const session = (await runtime.broker.get(ids.run))!;
      session.artifactManifest!.changedFiles[0]!.path = `src/${" ".repeat(5_000)}`;
      vi.mocked(runtime.broker.get).mockResolvedValue(session);
    }
    const update = state.store.updateRuntimeRun.getMockImplementation()!;
    state.store.updateRuntimeRun.mockImplementation(async (id, mutation) => {
      if (mutation.state === "completed") throw new Error("simulated interrupted Runtime commit");
      return update(id, mutation);
    });
    await expect(processOmpTaskRuntime(input)).rejects.toThrow("simulated interrupted Runtime commit");
    expect(state.getTask().execution.status).toBe("completed");
    expect(state.getRun().state).toBe("running");
    const evidenceId = state.getTask().execution.resultEvidenceId;
    const claims = state.store.claimTaskAgentProviderAttempt.mock.calls.length;
    state.store.updateRuntimeRun.mockImplementation(update);

    await expect(processOmpTaskRuntime(input)).resolves.toMatchObject({ state: "completed", pollRequired: false });
    expect(state.getRun()).toMatchObject({ state: "completed", evidenceIds: [evidenceId] });
    expect(state.getTask().evidence).toHaveLength(1);
    await expect(state.store.completeTaskAgentRun.mock.results.at(-1)!.value).resolves.toMatchObject({ status: "unchanged" });
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(state.store.claimTaskAgentProviderAttempt).toHaveBeenCalledTimes(claims);
  });

  it("never replaces a missing Session after the Task result was committed", async () => {
    const state = fixture();
    const runtime = brokerFixture();
    const input = { store: state.store as never, broker: runtime.broker, runtimeRunId: ids.run };
    await processOmpTaskRuntime(input);
    await state.store.completeTaskAgentRun("goal-task-job-1", state.data(), "existing result");
    vi.mocked(runtime.broker.get).mockResolvedValue(null);
    await expect(processOmpTaskRuntime(input)).rejects.toBeInstanceOf(OmpRuntimeReconciliationError);
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(state.getTask().evidence).toHaveLength(1);
    expect(state.getRun().state).toBe("running");
  });

  it.each(["manifest", "lease", "session", "job", "missing-evidence"] as const)("rejects mismatched %s during completion reconciliation", async (mismatch) => {
    const state = fixture();
    const runtime = brokerFixture();
    const input = { store: state.store as never, broker: runtime.broker, runtimeRunId: ids.run };
    await processOmpTaskRuntime(input);
    runtime.complete();
    const update = state.store.updateRuntimeRun.getMockImplementation()!;
    state.store.updateRuntimeRun.mockImplementation(async (id, mutation) => {
      if (mutation.state === "completed") throw new Error("interrupted");
      return update(id, mutation);
    });
    await expect(processOmpTaskRuntime(input)).rejects.toThrow("interrupted");
    state.store.updateRuntimeRun.mockImplementation(update);
    const session = (await runtime.broker.get(ids.run))!;
    if (mismatch === "manifest") session.artifactManifest!.patchDigest = `sha256:${"0".repeat(64)}`;
    if (mismatch === "lease") session.leaseId = randomUUID();
    if (mismatch === "session") session.providerSessionId = "replacement-session";
    if (mismatch === "job") session.idempotencyKey = "replacement-job";
    if (mismatch === "missing-evidence") state.getTask().execution.resultEvidenceId = randomUUID();
    vi.mocked(runtime.broker.get).mockResolvedValue(session);
    await expect(processOmpTaskRuntime(input)).rejects.toThrow(/does not match the original Session/);
    expect(state.getRun().state).toBe("running");
    expect(state.getTask().evidence).toHaveLength(1);
    expect(runtime.start).toHaveBeenCalledTimes(1);
  });

  it("keeps an Owner-paused Runtime paused even when the Broker has completed", async () => {
    const state = fixture();
    const runtime = brokerFixture();
    const input = { store: state.store as never, broker: runtime.broker, runtimeRunId: ids.run };
    await processOmpTaskRuntime(input);
    await pauseOmpRuntimeOutcomeUnknown(state.store as never, ids.run);
    runtime.complete();
    await expect(processOmpTaskRuntime(input)).resolves.toMatchObject({ state: "paused", pollRequired: false });
    expect(state.getRun().state).toBe("paused");
    expect(state.store.completeTaskAgentRun).not.toHaveBeenCalled();
    expect(runtime.start).toHaveBeenCalledTimes(1);
  });

  it("starts one idempotent Session, reconciles events, and commits digest-only Evidence", async () => {
    const fixtureState = fixture();
    const runtime = brokerFixture();
    const first = await processOmpTaskRuntime({
      store: fixtureState.store as never,
      broker: runtime.broker,
      runtimeRunId: ids.run,
      data: fixtureState.data()
    });
    expect(first).toMatchObject({ state: "running", pollRequired: true });
    expect(fixtureState.getRun()).toMatchObject({ state: "running", eventCursor: 2, providerSessionId: "omp-session-1", leaseId: ids.lease });
    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      executionBinding: expect.objectContaining({ allowedTools: ["read", "grep", "glob", "lsp", "edit", "bash"] }),
      model: expect.objectContaining({ location: "local", secretRevision: 0 })
    }));

    runtime.complete();
    const completed = await processOmpTaskRuntime({
      store: fixtureState.store as never,
      broker: runtime.broker,
      runtimeRunId: ids.run
    });
    expect(completed).toMatchObject({ state: "completed", pollRequired: false });
    expect(fixtureState.getRun()).toMatchObject({ state: "completed", eventCursor: 3, evidenceIds: [expect.any(String)] });
    expect(fixtureState.getTask().evidence[0]?.reference).toContain(`sha256:${"e".repeat(64)}`);
    expect(fixtureState.getTask().evidence[0]?.reference).not.toContain("messages");
    expect(runtime.start).toHaveBeenCalledTimes(1);
  });

  it("rejects a Broker cursor gap and fences the Runtime as outcome unknown", async () => {
    const fixtureState = fixture();
    const runtime = brokerFixture();
    vi.mocked(runtime.broker.events).mockResolvedValueOnce([{
      sequence: 2,
      kind: "agent.started",
      summary: "Skipped sequence.",
      toolName: null,
      progressPercent: 10,
      inputTokens: null,
      outputTokens: null,
      toolCalls: null,
      errorCode: null,
      occurredAt: "2026-09-02T00:00:02.000Z"
    }]);
    await expect(processOmpTaskRuntime({
      store: fixtureState.store as never,
      broker: runtime.broker,
      runtimeRunId: ids.run,
      data: fixtureState.data()
    })).rejects.toBeInstanceOf(OmpRuntimeReconciliationError);
    await pauseOmpRuntimeOutcomeUnknown(fixtureState.store as never, ids.run);
    expect(fixtureState.getRun()).toMatchObject({ state: "paused", errorCode: "provider_outcome_unknown" });
  });

  it("never creates a replacement Broker Session for a non-fresh RuntimeRun", async () => {
    const fixtureState = fixture();
    const runtime = brokerFixture();
    const current = fixtureState.getRun();
    await fixtureState.store.updateRuntimeRun(ids.run, {
      expectedRevision: current.revision,
      state: "provisioning",
      at: "2026-09-02T00:00:01.000Z",
      event: {}
    });
    await expect(processOmpTaskRuntime({
      store: fixtureState.store as never,
      broker: runtime.broker,
      runtimeRunId: ids.run,
      data: fixtureState.data()
    })).rejects.toThrow(/replay is fenced/i);
    expect(runtime.start).not.toHaveBeenCalled();
  });
});
