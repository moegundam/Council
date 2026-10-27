import { describe, expect, it, vi } from "vitest";
import type { PlatformSnapshot, SpeakerQueueItem } from "@council/contracts";
import { InMemoryPlatformStore, mcpConnectorExecutionFingerprint, mcpToolRequestFingerprint } from "@council/database";
import { reconcileSpeakerQueueLeases } from "./speaker-queue-reconciler.js";

function queueItem(status: SpeakerQueueItem["status"] = "queued"): SpeakerQueueItem {
  return {
    id: "meeting-action-1",
    jobId: "meeting-action-1",
    requestFingerprint: null,
    meetingId: "00000000-0000-4000-8000-000000000001",
    agentId: "00000000-0000-4000-8000-000000000002",
    participantId: "00000000-0000-4000-8000-000000000003",
    roleRevision: 1,
    roleId: "00000000-0000-4000-8000-000000000004",
    roleVersion: 1,
    roleName: "Chair",
    kind: "agent_turn",
    label: "Chair speaks",
    toolName: null,
    agendaRevision: 1,
    agendaCurrentItemId: null,
    status,
    requestedAt: "2026-01-01T00:00:00.000Z",
    startedAt: status === "running" ? "2026-01-01T00:00:30.000Z" : null,
    leaseExpiresAt: "2026-01-01T00:05:00.000Z"
  };
}

function reconciliationStore(item: SpeakerQueueItem) {
  return {
    getSnapshot: vi.fn(async () => ({ speakerQueue: [item], toolRuns: [] }) as unknown as PlatformSnapshot),
    commitAgentTurnFailure: vi.fn(async () => { throw new Error("Agent commit was not expected in this test."); }),
    commitMcpToolRun: vi.fn(async () => { throw new Error("MCP commit was not expected in this test."); }),
    getSpeakerQueue: vi.fn(async () => [item]),
    renewSpeakerTurnLease: vi.fn(async () => ({ ...item, leaseExpiresAt: "2026-01-01T00:10:01.000Z" })),
    releaseChairSuggestion: vi.fn(async () => { throw new Error("Chair release was not expected in this test."); }),
    releaseSpeakerTurn: vi.fn(async () => item)
  };
}

async function chairReconciliationStore(status: SpeakerQueueItem["status"] = "queued") {
  const source = new InMemoryPlatformStore();
  const seed = await source.getSnapshot();
  const meeting = seed.meetings[0]!;
  const participant = seed.participants.find((item) => item.meetingId === meeting.id)!;
  const agent = seed.agents.find((item) => item.id === participant.agentId)!;
  const chairSuggestionId = "c0000000-0000-4000-8000-000000000001";
  const jobId = "automatic-chair-turn";
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
    label: "Automatic Chair turn",
    toolName: null,
    roleName: participant.roleSnapshot.name,
    agendaRevision: meeting.agenda.revision,
    agendaCurrentItemId: meeting.agenda.items[0]?.id ?? null,
    status,
    requestedAt: "2026-01-01T00:00:00.000Z",
    startedAt: status === "running" ? "2026-01-01T00:00:30.000Z" : null,
    leaseExpiresAt: "2026-01-01T00:05:00.000Z",
    requestedBy: "system",
    chairSuggestionId,
    automationRevision: meeting.automationRevision ?? 0
  }];
  seed.chairSuggestions = [{
    id: chairSuggestionId,
    meetingId: meeting.id,
    sourceUtteranceId: seed.utterances[0]!.id,
    status: "pending",
    reason: "off_topic",
    suggestedMode: "chaired",
    explanation: "Return the meeting to its agenda.",
    score: 0.9,
    suggestedAgentId: participant.agentId,
    suggestedAgentName: agent.name,
    modeAcceptedAt: "2026-01-01T00:00:00.000Z",
    requestedAgentId: participant.agentId,
    requestedAgentJobId: jobId,
    resolution: null,
    resolutionNote: null,
    resolvedBy: null,
    transitions: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    resolvedAt: null
  }];
  return { store: new InMemoryPlatformStore(seed), chairSuggestionId, jobId };
}

async function ownerAgentReconciliationStore(): Promise<{ store: InMemoryPlatformStore; jobId: string }> {
  const seed = await new InMemoryPlatformStore().getSnapshot();
  const meeting = seed.meetings[0]!;
  const participant = seed.participants.find((item) => item.meetingId === meeting.id)!;
  const jobId = "owner-agent-outcome-unknown";
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
    requestedAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:30.000Z",
    leaseExpiresAt: "2026-01-01T00:05:00.000Z",
    requestedBy: "owner"
  }];
  return { store: new InMemoryPlatformStore(seed), jobId };
}

async function mcpReconciliationStore(status: SpeakerQueueItem["status"] = "queued") {
  const seed = await new InMemoryPlatformStore().getSnapshot();
  const seedParticipant = seed.participants[0]!;
  const connectorId = "d0000000-0000-4000-8000-000000000051";
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
        reason: "Prepare an MCP reconciliation fixture."
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
  const jobId = "mcp-reconciliation-job";
  await store.reserveMcpToolCall(jobId, { ...job, requestFingerprint: mcpToolRequestFingerprint(job) });
  if (status === "running") await store.markSpeakerTurnRunning(jobId);
  const state = Reflect.get(store, "state") as PlatformSnapshot;
  state.speakerQueue[0]!.leaseExpiresAt = "2026-01-01T00:05:00.000Z";
  return { store, jobId };
}

describe("reconcileSpeakerQueueLeases", () => {
  it("renews an expired queued reservation while BullMQ still owns a waiting job", async () => {
    const item = queueItem();
    const store = reconciliationStore(item);

    const result = await reconcileSpeakerQueueLeases({
      store,
      findJob: vi.fn(async () => ({ getState: async () => "waiting" })),
      now: "2026-01-01T00:05:01.000Z"
    });

    expect(store.renewSpeakerTurnLease).toHaveBeenCalledWith(item.jobId, "2026-01-01T00:05:01.000Z");
    expect(store.releaseSpeakerTurn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ renewed: [expect.objectContaining({ jobId: item.jobId })], released: [] });
  });

  it.each(["delayed", "paused", "prioritized", "waiting-children", "active"])(
    "keeps a queued reservation while its BullMQ job is %s",
    async (state) => {
      const item = queueItem();
      const store = reconciliationStore(item);

      await reconcileSpeakerQueueLeases({
        store,
        findJob: vi.fn(async () => ({ getState: async () => state })),
        now: "2026-01-01T00:05:01.000Z"
      });

      expect(store.renewSpeakerTurnLease).toHaveBeenCalledOnce();
      expect(store.releaseSpeakerTurn).not.toHaveBeenCalled();
    }
  );

  it.each([
    [null, "queue_job_missing"],
    ["completed", "queue_job_completed"],
    ["failed", "queue_job_failed"],
    ["unknown", "queue_job_unknown"]
  ])("releases an orphaned queued reservation for job state %s", async (state, reason) => {
    const item = queueItem();
    const store = reconciliationStore(item);

    const result = await reconcileSpeakerQueueLeases({
      store,
      findJob: vi.fn(async () => state === null ? null : { getState: async () => state }),
      now: "2026-01-01T00:05:01.000Z"
    });

    expect(store.releaseSpeakerTurn).toHaveBeenCalledWith(item.jobId, reason);
    expect(store.renewSpeakerTurnLease).not.toHaveBeenCalled();
    expect(result).toMatchObject({ renewed: [], released: [{ item: expect.objectContaining({ jobId: item.jobId }), reason }] });
  });

  it("renews an expired running reservation while BullMQ still owns the active job", async () => {
    const item = queueItem("running");
    const store = reconciliationStore(item);
    const findJob = vi.fn(async () => ({ getState: async () => "active" }));

    await reconcileSpeakerQueueLeases({ store, findJob, now: "2026-01-01T00:05:01.000Z" });

    expect(findJob).toHaveBeenCalledWith(item.jobId);
    expect(store.renewSpeakerTurnLease).toHaveBeenCalledWith(item.jobId, "2026-01-01T00:05:01.000Z");
    expect(store.releaseSpeakerTurn).not.toHaveBeenCalled();
  });

  it("records an unknown Agent outcome before releasing a running owner reservation", async () => {
    const { store, jobId } = await ownerAgentReconciliationStore();
    const renew = vi.spyOn(store, "renewSpeakerTurnLease");
    const release = vi.spyOn(store, "releaseSpeakerTurn");

    const result = await reconcileSpeakerQueueLeases({
      store,
      findJob: vi.fn(async () => null),
      now: "2026-01-01T00:05:01.000Z"
    });

    expect(renew).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(jobId, "agent_outcome_unknown");
    expect(result.released).toEqual([
      expect.objectContaining({ item: expect.objectContaining({ jobId }), reason: "agent_outcome_unknown" })
    ]);
    const snapshot = await store.getSnapshot();
    expect(snapshot.speakerQueue).toEqual([]);
    expect(snapshot.utterances.at(-1)).toMatchObject({ turnId: jobId, kind: "failure" });
    expect(snapshot.meetings.find((meeting) => meeting.id === snapshot.utterances.at(-1)!.meetingId)?.state)
      .toBe("paused");
  });

  it("leaves reservations unchanged when BullMQ state cannot be verified", async () => {
    const item = queueItem();
    const store = reconciliationStore(item);

    await expect(reconcileSpeakerQueueLeases({
      store,
      findJob: vi.fn(async () => { throw new Error("redis unavailable"); }),
      now: "2026-01-01T00:05:01.000Z"
    })).rejects.toThrow("redis unavailable");

    expect(store.renewSpeakerTurnLease).not.toHaveBeenCalled();
    expect(store.releaseSpeakerTurn).not.toHaveBeenCalled();
  });

  it("reopens a pending Chair suggestion before releasing its orphaned reservation", async () => {
    const { store, chairSuggestionId, jobId } = await chairReconciliationStore();

    await reconcileSpeakerQueueLeases({
      store,
      findJob: vi.fn(async () => null),
      now: "2026-01-01T00:05:01.000Z"
    });

    const snapshot = await store.getSnapshot();
    expect(snapshot.speakerQueue).toEqual([]);
    expect(snapshot.chairSuggestions.find((item) => item.id === chairSuggestionId)).toMatchObject({
      status: "open",
      requestedAgentId: null,
      requestedAgentJobId: null,
      transitions: [expect.objectContaining({ type: "request_released", jobId })]
    });
  });

  it("records an unknown automatic Chair outcome and pauses before releasing its running reservation", async () => {
    const { store, chairSuggestionId, jobId } = await chairReconciliationStore("running");

    const result = await reconcileSpeakerQueueLeases({
      store,
      findJob: vi.fn(async () => null),
      now: "2026-01-01T00:05:01.000Z"
    });

    expect(result.released).toEqual([
      expect.objectContaining({ item: expect.objectContaining({ jobId }), reason: "agent_outcome_unknown" })
    ]);
    const snapshot = await store.getSnapshot();
    expect(snapshot.speakerQueue).toEqual([]);
    expect(snapshot.utterances.at(-1)).toMatchObject({ turnId: jobId, kind: "failure" });
    expect(snapshot.meetings.find((meeting) => meeting.id === snapshot.utterances.at(-1)!.meetingId)?.state)
      .toBe("paused");
    expect(snapshot.chairSuggestions.find((item) => item.id === chairSuggestionId)).toMatchObject({
      status: "open",
      requestedAgentId: null,
      requestedAgentJobId: null
    });
  });

  it.each([
    ["queued", "failed"],
    ["running", null]
  ] as const)("commits an argument-free terminal receipt for an orphaned %s MCP reservation", async (status, queueState) => {
    const { store, jobId } = await mcpReconciliationStore(status);
    const release = vi.spyOn(store, "releaseSpeakerTurn");

    const result = await reconcileSpeakerQueueLeases({
      store,
      findJob: vi.fn(async () => queueState === null ? null : { getState: async () => queueState }),
      now: "2026-01-01T00:05:01.000Z"
    });

    expect(result.released).toEqual([
      expect.objectContaining({ item: expect.objectContaining({ jobId }), reason: "mcp_outcome_unknown" })
    ]);
    expect(release).not.toHaveBeenCalled();
    const snapshot = await store.getSnapshot();
    expect(snapshot.speakerQueue).toEqual([]);
    expect(snapshot.toolRuns).toEqual([expect.objectContaining({ jobId, status: "failed" })]);
    expect(snapshot.utterances.at(-1)).toMatchObject({ turnId: jobId, kind: "failure" });
    expect(snapshot.utterances.at(-1)?.content).not.toContain("policy");
    expect(snapshot.meetings.find((meeting) => meeting.id === snapshot.toolRuns[0]!.meetingId)?.state).toBe("paused");
  });
});
