import { describe, expect, it, vi } from "vitest";
import type { PlatformSnapshot, Task } from "@council/contracts";
import {
  InMemoryPlatformStore,
  mcpConnectorExecutionFingerprint,
  mcpToolRequestFingerprint,
  taskSyncRequestFingerprint
} from "@council/database";
import { recoverOrphanedAsyncState } from "./async-state-recovery.js";

const now = "2026-08-09T07:00:00.000Z";

function queuedTask(meetingId: string, decisionId: string): Task {
  const task: Task = {
    id: "d0000000-0000-4000-8000-000000000001",
    meetingId,
    decisionId,
    revision: 1,
    boardRevision: 1,
    title: "Recover queued work",
    description: "Queue-backed state must not remain stuck after Redis loss.",
    status: "in_progress",
    position: 0,
    assignee: "Architect-R",
    assigneeAgentId: "50000000-0000-4000-8000-000000000001",
    dueAt: null,
    acceptanceCriteria: "Recovery leaves an explicit retryable failure.",
    evidence: [],
    executionProfile: "worker",
    allowedTools: [],
    dataScope: "meeting",
    approvalState: "approved",
    execution: {
      revision: 1,
      status: "queued",
      jobId: "task-agent-job",
      requestFingerprint: "task-request",
      agentId: "50000000-0000-4000-8000-000000000001",
      profile: "worker",
      attemptCount: 1,
      requestedAt: now,
      startedAt: null,
      providerStartedAt: null,
      completedAt: null,
      lastError: null,
      resultEvidenceId: null
    },
    transitions: [],
    sync: {
      status: "queued",
      adapterId: "f0000000-0000-4000-8000-000000000001",
      jobId: "task-sync-job",
      requestFingerprint: null,
      externalId: null,
      attemptCount: 1,
      lastAttemptAt: now,
      lastError: null,
      syncedAt: null
    },
    createdAt: now,
    updatedAt: now
  };
  task.sync.requestFingerprint = taskSyncRequestFingerprint(task);
  return task;
}

async function recoveryFixture(
  leaseExpiresAt = "2026-08-09T07:05:00.000Z",
  speakerStatus: "queued" | "running" = "queued"
): Promise<InMemoryPlatformStore> {
  const source = new InMemoryPlatformStore();
  const seed: PlatformSnapshot = await source.getSnapshot();
  const meeting = seed.meetings[0]!;
  meeting.state = "closed";
  meeting.summaryState = "queued";
  meeting.summaryJobId = "summary-job";
  seed.tasks = [queuedTask(meeting.id, seed.decisions[0]!.id)];
  seed.speakerQueue = [{
    id: "speaker-job",
    jobId: "speaker-job",
    requestFingerprint: null,
    meetingId: meeting.id,
    agentId: seed.agents[0]!.id,
    participantId: seed.participants[1]!.id,
    roleRevision: seed.participants[1]!.roleRevision,
    roleId: seed.participants[1]!.roleId,
    roleVersion: seed.participants[1]!.roleSnapshot.version,
    kind: "agent_turn",
    label: "Architect-R",
    toolName: null,
    roleName: seed.participants[1]!.roleSnapshot.name,
    agendaRevision: meeting.agenda.revision,
    agendaCurrentItemId: meeting.agenda.items[0]!.id,
    status: speakerStatus,
    requestedAt: now,
    startedAt: speakerStatus === "running" ? now : null,
    leaseExpiresAt,
    requestedBy: "system",
    chairSuggestionId: "c0000000-0000-4000-8000-000000000001",
    automationRevision: 0
  }];
  seed.chairSuggestions = [{
    id: "c0000000-0000-4000-8000-000000000001",
    meetingId: meeting.id,
    sourceUtteranceId: seed.utterances[0]!.id,
    status: "pending",
    reason: "time_remaining",
    suggestedMode: "chaired",
    explanation: "Recover a missing automatic Chair job.",
    score: 0.9,
    suggestedAgentId: seed.agents[0]!.id,
    suggestedAgentName: seed.agents[0]!.name,
    modeAcceptedAt: now,
    requestedAgentId: seed.agents[0]!.id,
    requestedAgentJobId: "speaker-job",
    resolution: null,
    resolutionNote: null,
    resolvedBy: null,
    transitions: [],
    createdAt: now,
    resolvedAt: null
  }];
  return new InMemoryPlatformStore(seed);
}

async function ownerAgentRecoveryFixture(): Promise<{ store: InMemoryPlatformStore; jobId: string }> {
  const seed = await new InMemoryPlatformStore().getSnapshot();
  const meeting = seed.meetings[0]!;
  const participant = seed.participants.find((item) => item.meetingId === meeting.id)!;
  const jobId = "owner-agent-async-outcome-unknown";
  seed.tasks = [];
  seed.chairSuggestions = [];
  meeting.state = "active";
  meeting.summaryState = "not_requested";
  meeting.summaryJobId = null;
  seed.speakerQueue = [{
    id: jobId,
    jobId,
    requestFingerprint: null,
    meetingId: meeting.id,
    agentId: participant.agentId,
    participantId: participant.id,
    roleRevision: participant.roleRevision,
    roleId: participant.roleId,
    roleVersion: participant.roleSnapshot.version,
    kind: "agent_turn",
    label: "Owner-requested Agent turn",
    toolName: null,
    roleName: participant.roleSnapshot.name,
    agendaRevision: meeting.agenda.revision,
    agendaCurrentItemId: meeting.agenda.items[0]?.id ?? null,
    status: "running",
    requestedAt: now,
    startedAt: now,
    leaseExpiresAt: "2026-08-09T07:05:00.000Z",
    requestedBy: "owner"
  }];
  return { store: new InMemoryPlatformStore(seed), jobId };
}

async function pendingSummaryRecoveryFixture(): Promise<InMemoryPlatformStore> {
  const source = new InMemoryPlatformStore();
  const seed = await source.getSnapshot();
  const meeting = seed.meetings[0]!;
  meeting.state = "closed";
  meeting.summaryState = "pending";
  meeting.summaryJobId = "fresh-summary-admission";
  seed.tasks = [];
  seed.speakerQueue = [];
  seed.chairSuggestions = [];
  return new InMemoryPlatformStore(seed);
}

class AuditedRecoveryStore extends InMemoryPlatformStore {
  readonly audits: Array<{
    event: string;
    entityType: string;
    entityId: string;
    detail: Record<string, unknown>;
  }> = [];

  override async recordAudit(
    event: string,
    entityType: string,
    entityId: string,
    detail: Record<string, unknown> = {}
  ): Promise<void> {
    this.audits.push({ event, entityType, entityId, detail });
    await super.recordAudit(event, entityType, entityId, detail);
  }
}

async function chairParentRecoveryFixture() {
  const seed = await new InMemoryPlatformStore().getSnapshot();
  const meeting = seed.meetings[0]!;
  seed.tasks = [];
  seed.speakerQueue = [];
  seed.chairSuggestions = [];
  meeting.summaryState = "not_requested";
  meeting.summaryJobId = null;
  meeting.automation = "auto";
  meeting.automationRevision = 1;
  const store = new AuditedRecoveryStore(seed);
  const created = await store.createChairSuggestion(meeting.id, seed.utterances.at(-1)!.id, {
    reason: "off_topic",
    suggestedMode: "chaired",
    explanation: "Recover the deterministic Chair parent job.",
    score: 0.91
  }, {
    automation: "auto",
    automationRevision: 1
  });
  const jobId = `${meeting.id}-chair-auto-${created.suggestion.id}`;
  await store.reserveChairAutomationJobAdmission(created.suggestion.id, jobId, 1);
  await store.confirmChairAutomationJobAdmission(created.suggestion.id, jobId);
  return { created, jobId, meeting, store };
}

async function mcpRecoveryFixture(): Promise<{ store: InMemoryPlatformStore; jobId: string }> {
  const seed = await new InMemoryPlatformStore().getSnapshot();
  const seedParticipant = seed.participants[0]!;
  const connectorId = "d0000000-0000-4000-8000-000000000052";
  seed.mcpConnectors.push({
    id: connectorId,
    revision: 1,
    name: "Recovery Docs",
    location: "local",
    baseUrl: "http://10.20.30.40/mcp",
    approvedTools: ["search"],
    toolRegistrations: [{ toolName: "search", displayName: "search", kind: "mcp_tool", version: "unversioned", owner: "Platform Owner", goal: "以唯讀方式執行 search。" }],
    enabled: true,
    hasSecret: false
  });
  seed.agents.find((agent) => agent.id === seedParticipant.agentId)!.toolGrants = [{ connectorId, toolName: "search" }];
  const store = new InMemoryPlatformStore(seed);
  const initial = await store.getSnapshot();
  const participant = initial.participants[0]!;
  const toolRole = initial.roles.find((role) =>
    role.toolPolicy === "agent_read_only_grants" && role.dataPolicy === "agent_declared_scope"
  )!;
  const assigned = participant.roleId === toolRole.id
    ? participant
    : await store.switchParticipantRole(participant.meetingId, participant.id, {
        roleId: toolRole.id,
        expectedRoleRevision: participant.roleRevision,
        reason: "Prepare an MCP recovery fixture."
      });
  const currentConnector = (await store.getSnapshot()).mcpConnectors.find((item) => item.id === connectorId)!;
  const connector = currentConnector;
  const job = {
    meetingId: assigned.meetingId,
    agentId: assigned.agentId,
    participantId: assigned.id,
    roleRevision: assigned.roleRevision,
    roleId: assigned.roleId,
    roleVersion: assigned.roleSnapshot.version,
    connectorId: connector.id,
    toolName: "search",
    toolSnapshot: { connectorName: connector.name, ...currentConnector.toolRegistrations[0]! },
    connectorFingerprint: mcpConnectorExecutionFingerprint(currentConnector, null),
    arguments: { query: "policy" },
    requestedBy: "owner" as const
  };
  const jobId = "mcp-async-recovery-job";
  await store.reserveMcpToolCall(jobId, { ...job, requestFingerprint: mcpToolRequestFingerprint(job) });
  const state = Reflect.get(store, "state") as PlatformSnapshot;
  state.tasks = [];
  state.chairSuggestions = [];
  for (const meeting of state.meetings) {
    meeting.summaryState = "not_requested";
    meeting.summaryJobId = null;
  }
  state.speakerQueue[0]!.leaseExpiresAt = "2026-08-09T06:59:00.000Z";
  return { store, jobId };
}

describe("orphaned async state recovery", () => {
  it("fails missing queue-backed work and releases speaker and Chair reservations", async () => {
    const store = await recoveryFixture();

    const result = await recoverOrphanedAsyncState({ store, findJob: async () => null });

    expect(result).toEqual({
      checkedJobs: 4,
      preservedJobs: 0,
      deferredTaskRuns: 0,
      deferredTaskSyncs: 0,
      deferredSpeakerTurns: 0,
      failedTaskRuns: 1,
      failedTaskSyncs: 1,
      failedMeetingSummaries: 1,
      requeuedMeetingSummaries: 0,
      deferredMeetingSummaries: 0,
      releasedSpeakerTurns: 1,
      releasedChairSuggestions: 1,
      requiredChairAutomationReconciliations: 0
    });
    const snapshot = await store.getSnapshot();
    expect(snapshot.tasks[0]!.execution).toMatchObject({ status: "failed", lastError: "queue_state_missing" });
    expect(snapshot.tasks[0]!.sync).toMatchObject({ status: "failed", lastError: "queue_state_missing" });
    expect(snapshot.meetings[0]).toMatchObject({ summaryState: "failed", summaryJobId: "summary-job" });
    expect(snapshot.speakerQueue).toEqual([]);
    expect(snapshot.chairSuggestions[0]).toMatchObject({
      status: "open",
      requestedAgentId: null,
      requestedAgentJobId: null
    });
  });

  it("preserves states whose jobs are still owned by BullMQ", async () => {
    const store = await recoveryFixture();

    const result = await recoverOrphanedAsyncState({
      store,
      findJob: async () => ({ getState: async () => "waiting" })
    });

    expect(result).toMatchObject({ checkedJobs: 4, preservedJobs: 4 });
    const snapshot = await store.getSnapshot();
    expect(snapshot.tasks[0]!.execution.status).toBe("queued");
    expect(snapshot.tasks[0]!.sync.status).toBe("queued");
    expect(snapshot.meetings[0]!.summaryState).toBe("queued");
    expect(snapshot.speakerQueue).toHaveLength(1);
    expect(snapshot.chairSuggestions[0]!.status).toBe("pending");
  });

  it("does not fail a pending Summary from an ownership observation taken before admission", async () => {
    const store = await pendingSummaryRecoveryFixture();
    let queueJob: { getState(): Promise<string> } | null = null;
    let releaseLookup = () => {};
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    let lookupObserved = () => {};
    const lookupObservedPromise = new Promise<void>((resolve) => {
      lookupObserved = resolve;
    });
    const enqueueMeetingSummary = vi.fn(async (meetingId: string, jobId: string) => {
      expect(meetingId).toBe((await store.getSnapshot()).meetings[0]!.id);
      expect(jobId).toBe("fresh-summary-admission");
      queueJob ??= { getState: async () => "waiting" };
    });

    const recovery = recoverOrphanedAsyncState({
      store,
      findJob: async () => {
        const observed = queueJob;
        lookupObserved();
        await lookupGate;
        return observed;
      },
      enqueueMeetingSummary
    });
    await lookupObservedPromise;
    queueJob = { getState: async () => "waiting" };
    releaseLookup();

    const result = await recovery;
    expect(enqueueMeetingSummary).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ failedMeetingSummaries: 0, requeuedMeetingSummaries: 1 });
    expect((await store.getSnapshot()).meetings[0]).toMatchObject({
      summaryState: "queued",
      summaryJobId: "fresh-summary-admission"
    });
  });

  it("audits a pending Summary that recovery successfully requeues", async () => {
    const fixture = await pendingSummaryRecoveryFixture();
    const store = new AuditedRecoveryStore(await fixture.getSnapshot());
    let lookupCount = 0;

    const result = await recoverOrphanedAsyncState({
      store,
      findJob: async () => {
        lookupCount += 1;
        return lookupCount === 1 ? null : { getState: async () => "waiting" };
      },
      enqueueMeetingSummary: async () => undefined
    });

    expect(result.requeuedMeetingSummaries).toBe(1);
    expect(store.audits).toContainEqual({
      event: "async_state.recovered",
      entityType: "queue",
      entityId: "worker-startup",
      detail: expect.objectContaining({ requeuedMeetingSummaries: 1 })
    });
  });

  it("keeps a pending Summary durable when re-enqueue acknowledgement and ownership are unavailable", async () => {
    const store = await pendingSummaryRecoveryFixture();
    const enqueueMeetingSummary = vi.fn(async () => {
      throw new Error("Redis write result unknown");
    });

    const result = await recoverOrphanedAsyncState({
      store,
      findJob: async () => null,
      enqueueMeetingSummary
    });

    expect(enqueueMeetingSummary).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      failedMeetingSummaries: 0,
      requeuedMeetingSummaries: 0,
      deferredMeetingSummaries: 1
    });
    expect((await store.getSnapshot()).meetings[0]).toMatchObject({
      summaryState: "pending",
      summaryJobId: "fresh-summary-admission"
    });
  });

  it("does not downgrade a Summary that completes before the post-enqueue ownership check", async () => {
    const store = await pendingSummaryRecoveryFixture();
    const meetingId = (await store.getSnapshot()).meetings[0]!.id;
    let lookupCount = 0;

    const result = await recoverOrphanedAsyncState({
      store,
      findJob: async () => {
        lookupCount += 1;
        return lookupCount === 1 ? null : { getState: async () => "completed" };
      },
      enqueueMeetingSummary: async (requeuedMeetingId, jobId) => {
        expect(requeuedMeetingId).toBe(meetingId);
        await store.setMeetingSummaryState(meetingId, "completed", jobId);
      }
    });

    expect(result).toMatchObject({ failedMeetingSummaries: 0, requeuedMeetingSummaries: 0 });
    expect((await store.getSnapshot()).meetings[0]).toMatchObject({
      summaryState: "completed",
      summaryJobId: "fresh-summary-admission"
    });
  });

  it("does not mutate state when queue inspection is unavailable", async () => {
    const store = await recoveryFixture();
    const before = await store.getSnapshot();

    await expect(recoverOrphanedAsyncState({
      store,
      findJob: async () => { throw new Error("redis unavailable"); }
    })).rejects.toThrow("redis unavailable");

    expect(await store.getSnapshot()).toEqual(before);
  });

  it("defers a fresh reservation that may still be between database commit and queue admission", async () => {
    const store = await recoveryFixture("2099-08-09T07:05:00.000Z");

    const result = await recoverOrphanedAsyncState({
      store,
      findJob: async () => null,
      now: "2026-08-09T07:00:00.000Z"
    });

    expect(result).toMatchObject({
      deferredTaskRuns: 1,
      deferredTaskSyncs: 1,
      failedTaskRuns: 0,
      failedTaskSyncs: 0,
      deferredSpeakerTurns: 1,
      releasedSpeakerTurns: 0,
      releasedChairSuggestions: 0
    });
    const snapshot = await store.getSnapshot();
    expect(snapshot.tasks[0]!.execution.status).toBe("queued");
    expect(snapshot.tasks[0]!.sync.status).toBe("queued");
    expect(snapshot.speakerQueue).toHaveLength(1);
    expect(snapshot.chairSuggestions[0]!.status).toBe("pending");
  });

  it("records an unknown outcome before releasing a missing running Speaker turn in a closed Meeting", async () => {
    const store = await recoveryFixture("2099-08-09T07:30:00.000Z", "running");

    const result = await recoverOrphanedAsyncState({
      store,
      findJob: async () => null,
      now: "2026-08-09T07:00:00.000Z"
    });

    expect(result).toMatchObject({ deferredSpeakerTurns: 0, releasedSpeakerTurns: 1, releasedChairSuggestions: 1 });
    const snapshot = await store.getSnapshot();
    expect(snapshot.speakerQueue).toEqual([]);
    expect(snapshot.chairSuggestions[0]!.status).toBe("open");
    expect(snapshot.utterances.at(-1)).toMatchObject({ turnId: "speaker-job", kind: "failure" });
    expect(snapshot.meetings[0]!.state).toBe("closed");
  });

  it("records an unknown Agent outcome before startup recovery releases a running owner reservation", async () => {
    const { store, jobId } = await ownerAgentRecoveryFixture();

    const result = await recoverOrphanedAsyncState({
      store,
      findJob: async () => null,
      now: "2026-08-09T07:10:00.000Z"
    });

    expect(result).toMatchObject({ checkedJobs: 1, releasedSpeakerTurns: 1 });
    const snapshot = await store.getSnapshot();
    expect(snapshot.speakerQueue).toEqual([]);
    expect(snapshot.utterances.at(-1)).toMatchObject({ turnId: jobId, kind: "failure" });
    expect(snapshot.meetings.find((meeting) => meeting.id === snapshot.utterances.at(-1)!.meetingId)?.state)
      .toBe("paused");
  });

  it("reconciles expired Task Agent admissions without mutating other async state", async () => {
    const store = await recoveryFixture();

    const result = await recoverOrphanedAsyncState({
      store,
      findJob: async () => null,
      now: "2026-08-09T07:10:00.000Z",
      scope: "task-agent"
    });

    expect(result).toMatchObject({
      checkedJobs: 1,
      failedTaskRuns: 1,
      failedTaskSyncs: 0,
      failedMeetingSummaries: 0,
      releasedSpeakerTurns: 0,
      releasedChairSuggestions: 0
    });
    const snapshot = await store.getSnapshot();
    expect(snapshot.tasks[0]!.execution).toMatchObject({ status: "failed", lastError: "queue_state_missing" });
    expect(snapshot.tasks[0]!.sync.status).toBe("queued");
    expect(snapshot.meetings[0]!.summaryState).toBe("queued");
    expect(snapshot.speakerQueue).toHaveLength(1);
    expect(snapshot.chairSuggestions[0]!.status).toBe("pending");
  });

  it.each([
    ["missing", null],
    ["terminal", { getState: async () => "failed" }]
  ] as const)("marks a provider-started Task Agent outcome unknown when its queue job is %s", async (_state, job) => {
    const store = await recoveryFixture();
    const durable = Reflect.get(store, "state") as PlatformSnapshot;
    durable.tasks[0]!.execution.status = "running";
    durable.tasks[0]!.execution.startedAt = now;
    durable.tasks[0]!.execution.providerStartedAt = now;

    const result = await recoverOrphanedAsyncState({
      store,
      findJob: async () => job,
      now: "2026-08-09T07:10:00.000Z",
      scope: "task-agent"
    });

    expect(result).toMatchObject({ failedTaskRuns: 1 });
    expect((await store.getSnapshot()).tasks[0]!.execution).toMatchObject({
      status: "failed",
      lastError: "provider_outcome_unknown",
      providerStartedAt: now
    });
  });

  it("periodically reconciles durable jobs without consuming Speaker Queue ownership", async () => {
    const store = await recoveryFixture();

    const result = await recoverOrphanedAsyncState({
      store,
      findJob: async () => null,
      now: "2026-08-09T07:10:00.000Z",
      scope: "background-jobs"
    });

    expect(result).toMatchObject({
      checkedJobs: 3,
      failedTaskRuns: 1,
      failedTaskSyncs: 1,
      failedMeetingSummaries: 1,
      releasedSpeakerTurns: 0,
      releasedChairSuggestions: 0
    });
    const snapshot = await store.getSnapshot();
    expect(snapshot.tasks[0]!.execution.status).toBe("failed");
    expect(snapshot.tasks[0]!.sync.status).toBe("failed");
    expect(snapshot.meetings[0]!.summaryState).toBe("failed");
    expect(snapshot.speakerQueue).toHaveLength(1);
    expect(snapshot.chairSuggestions[0]!.status).toBe("pending");
  });

  it("requires durable reconciliation when an admitted Chair parent job disappears from Redis", async () => {
    const { created, jobId, meeting, store } = await chairParentRecoveryFixture();

    const result = await recoverOrphanedAsyncState({
      store,
      findJob: async () => null,
      now,
      scope: "background-jobs"
    });

    expect(result).toMatchObject({
      checkedJobs: 1,
      requiredChairAutomationReconciliations: 1
    });
    await expect(store.getChairAutomationJobAdmissions()).resolves.toContainEqual(expect.objectContaining({
      chairSuggestionId: created.suggestion.id,
      jobId,
      status: "reconciliation_required",
      admittedAt: expect.any(String),
      reconciliationRequiredAt: now,
      reconciliationReason: "queue_state_missing"
    }));
    expect(store.audits).toContainEqual({
      event: "chair.automation.reconciliation_required",
      entityType: "chair_suggestion",
      entityId: created.suggestion.id,
      detail: expect.objectContaining({
        meetingId: meeting.id,
        jobId,
        classification: "queue_state_missing"
      })
    });
  });

  it("requires durable reconciliation when an admitted Chair parent job is terminal", async () => {
    const { created, jobId, meeting, store } = await chairParentRecoveryFixture();

    const result = await recoverOrphanedAsyncState({
      store,
      findJob: async () => ({ getState: async () => "failed" }),
      now,
      scope: "background-jobs"
    });

    expect(result).toMatchObject({
      checkedJobs: 1,
      requiredChairAutomationReconciliations: 1
    });
    await expect(store.getChairAutomationJobAdmissions()).resolves.toContainEqual(expect.objectContaining({
      chairSuggestionId: created.suggestion.id,
      jobId,
      status: "reconciliation_required",
      admittedAt: expect.any(String),
      reconciliationRequiredAt: now,
      reconciliationReason: "queue_state_terminal"
    }));
    expect(store.audits).toContainEqual({
      event: "chair.automation.reconciliation_required",
      entityType: "chair_suggestion",
      entityId: created.suggestion.id,
      detail: expect.objectContaining({
        meetingId: meeting.id,
        jobId,
        classification: "queue_state_terminal"
      })
    });
  });

  it("records an MCP outcome-unknown receipt before releasing an orphaned reservation", async () => {
    const { store, jobId } = await mcpRecoveryFixture();

    const result = await recoverOrphanedAsyncState({
      store,
      findJob: async () => null,
      now: "2026-08-09T07:10:00.000Z"
    });

    expect(result).toMatchObject({ checkedJobs: 1, releasedSpeakerTurns: 1 });
    const snapshot = await store.getSnapshot();
    expect(snapshot.speakerQueue).toEqual([]);
    expect(snapshot.toolRuns).toEqual([expect.objectContaining({ jobId, status: "failed" })]);
    expect(snapshot.utterances.at(-1)?.content).not.toContain("policy");
  });
});
