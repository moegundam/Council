import { describe, expect, it } from "vitest";
import type { AgentTurnJobData, McpToolCallJobData, ParticipantAssignment, PlatformSnapshot } from "@council/contracts";
import { InMemoryPlatformStore } from "./memory-store.js";
import { mcpConnectorExecutionFingerprint, mcpToolRequestFingerprint } from "./store.js";
import { createSeedSnapshot } from "./seed.js";

async function runnableChairStore(
  Store: new (seed?: PlatformSnapshot) => InMemoryPlatformStore = InMemoryPlatformStore
) {
  const seed = createSeedSnapshot();
  const chair = seed.participants.find((item) => item.isChair)!;
  const mcpConnectorId = "d0000000-0000-4000-8000-000000000041";
  seed.mcpConnectors.push({
    id: mcpConnectorId,
    revision: 1,
    name: "Queue tools",
    location: "local",
    baseUrl: "http://10.20.30.40/mcp",
    approvedTools: ["search"],
    toolRegistrations: [{ toolName: "search", displayName: "search", kind: "mcp_tool", version: "unversioned", owner: "Platform Owner", goal: "以唯讀方式執行 search。" }],
    enabled: true,
    hasSecret: false
  });
  seed.agents.find((agent) => agent.id === chair.agentId)!.toolGrants = [{ connectorId: mcpConnectorId, toolName: "search" }];
  const store = new Store(seed);
  const initial = await store.getSnapshot();
  const participant = initial.participants.find((item) => item.isChair)!;
  const connector = await store.createModelConnector({
    name: "Queue local",
    location: "local",
    baseUrl: "http://192.168.50.10:4000/v1",
    model: "queue-local"
  });
  await store.setAgentModel(participant.agentId, { modelConnectorId: connector.id });
  const snapshot = await store.getSnapshot();
  const current = snapshot.participants.find((item) => item.id === participant.id)!;
  const meeting = snapshot.meetings.find((item) => item.id === current.meetingId)!;
  const job: AgentTurnJobData = {
    meetingId: meeting.id,
    agentId: current.agentId,
    participantId: current.id,
    roleRevision: current.roleRevision,
    roleId: current.roleId,
    roleVersion: current.roleSnapshot.version,
    agendaRevision: meeting.agenda.revision,
    agendaCurrentItemId: meeting.agenda.items.find((item) => item.status === "current")?.id ?? null,
    requestedBy: "owner"
  };
  return { store, snapshot, participant: current, meeting, job, mcpConnectorId };
}

describe("Participant Role transitions and speaker queue", () => {
  it("backfills one immutable initial Role history entry and an empty queue", async () => {
    const legacy = structuredClone(createSeedSnapshot()) as unknown as {
      speakerQueue?: unknown;
      participants: Array<Partial<ParticipantAssignment>>;
    };
    delete legacy.speakerQueue;
    for (const participant of legacy.participants) {
      delete participant.roleRevision;
      delete participant.roleHistory;
    }
    const snapshot = await new InMemoryPlatformStore(legacy as unknown as PlatformSnapshot).getSnapshot();

    expect(snapshot.speakerQueue).toEqual([]);
    for (const participant of snapshot.participants) {
      expect(participant.roleRevision).toBe(1);
      expect(participant.roleHistory).toEqual([
        expect.objectContaining({
          revision: 1,
          roleId: participant.roleId,
          roleSnapshot: participant.roleSnapshot,
          changedBy: "system",
          reason: expect.any(String)
        })
      ]);
    }
  });

  it("switches an unfinished Meeting participant by appending history without rewriting the old snapshot", async () => {
    const store = new InMemoryPlatformStore(createSeedSnapshot());
    const before = await store.getSnapshot();
    const participant = before.participants[0]!;
    const previousSnapshot = structuredClone(participant.roleSnapshot);
    const target = before.roles.find((role) => role.id !== participant.roleId)!;

    const updated = await store.switchParticipantRole(participant.meetingId, participant.id, {
      roleId: target.id,
      expectedRoleRevision: participant.roleRevision,
      reason: "改由另一個觀點收斂目前議程。"
    });

    expect(updated).toMatchObject({
      roleId: target.id,
      roleRevision: 2,
      roleSnapshot: { roleId: target.id, version: target.version, source: "meeting_role_switched" }
    });
    expect(updated.roleHistory).toEqual([
      expect.objectContaining({ revision: 1, roleSnapshot: previousSnapshot }),
      expect.objectContaining({
        revision: 2,
        roleId: target.id,
        roleSnapshot: expect.objectContaining({ roleId: target.id, source: "meeting_role_switched" }),
        changedBy: "owner",
        reason: "改由另一個觀點收斂目前議程。"
      })
    ]);
    expect(previousSnapshot).toEqual(participant.roleSnapshot);
  });

  it("rejects stale, closed, deleted, no-op, and currently queued Role switches", async () => {
    const { store, participant, meeting, job } = await runnableChairStore();
    const roles = (await store.getSnapshot()).roles;

    await expect(store.switchParticipantRole(meeting.id, participant.id, {
      roleId: roles[0]!.id,
      expectedRoleRevision: participant.roleRevision + 1,
      reason: "stale"
    })).rejects.toMatchObject({
      kind: "revision",
      message: expect.stringMatching(/revision/i)
    });

    await store.reserveSpeakerTurn("speaker-job-busy", job);
    await expect(store.switchParticipantRole(meeting.id, participant.id, {
      roleId: roles[0]!.id,
      expectedRoleRevision: participant.roleRevision,
      reason: "busy"
    })).rejects.toThrow(/queued|running/i);
    await store.releaseSpeakerTurn("speaker-job-busy", "enqueue_failed");

    await expect(store.switchParticipantRole(meeting.id, participant.id, {
      roleId: participant.roleId,
      expectedRoleRevision: participant.roleRevision,
      reason: "no-op"
    })).rejects.toThrow(/already uses/i);

    const deleted = roles.find((role) => role.id !== participant.roleId)!;
    const mutableState = Reflect.get(store, "state") as { roles: typeof roles };
    mutableState.roles.find((role) => role.id === deleted.id)!.deletedAt = new Date().toISOString();
    await expect(store.switchParticipantRole(meeting.id, participant.id, {
      roleId: deleted.id,
      expectedRoleRevision: participant.roleRevision,
      reason: "deleted"
    })).rejects.toThrow(/deleted|available/i);

    await store.setMeetingState(meeting.id, "closed");
    await expect(store.switchParticipantRole(meeting.id, participant.id, {
      roleId: roles.find((role) => role.id !== participant.roleId && !role.deletedAt)!.id,
      expectedRoleRevision: participant.roleRevision,
      reason: "closed"
    })).rejects.toThrow(/closed/i);
  });

  it("serializes Role switching behind an in-flight speaker reservation", async () => {
    let observeReservation = () => {};
    let releaseReservation = () => {};
    const reservationEntered = new Promise<void>((resolve) => { observeReservation = resolve; });
    const reservationGate = new Promise<void>((resolve) => { releaseReservation = resolve; });
    class GatedReservationStore extends InMemoryPlatformStore {
      override async recordAudit(event: string): Promise<void> {
        if (event === "speaker.queue.reserved") {
          observeReservation();
          await reservationGate;
        }
      }
    }
    const { store, participant, meeting, job } = await runnableChairStore(GatedReservationStore);
    const target = (await store.getSnapshot()).roles.find((role) => role.id !== participant.roleId)!;

    const reservation = store.reserveSpeakerTurn("speaker-role-race", job);
    await reservationEntered;
    const roleSwitch = store.switchParticipantRole(meeting.id, participant.id, {
      roleId: target.id,
      expectedRoleRevision: participant.roleRevision,
      reason: "Do not cross a pending speaker reservation."
    });
    const switchBeforeRelease = await Promise.race([
      roleSwitch.then(() => "resolved" as const, () => "rejected" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 20))
    ]);
    releaseReservation();
    const [reservationResult, switchResult] = await Promise.allSettled([reservation, roleSwitch]);

    expect(switchBeforeRelease).toBe("pending");
    expect(reservationResult).toMatchObject({ status: "fulfilled" });
    expect(switchResult).toMatchObject({ status: "rejected" });
    const current = await store.getSnapshot();
    const currentParticipant = current.participants.find((item) => item.id === participant.id)!;
    const queued = current.speakerQueue.find((item) => item.jobId === "speaker-role-race")!;
    expect(queued).toMatchObject({
      participantId: currentParticipant.id,
      roleRevision: currentParticipant.roleRevision,
      roleId: currentParticipant.roleId
    });
  });

  it("does not expose a Role switch while its required audit is pending", async () => {
    let observeRoleAudit = () => {};
    let releaseRoleAudit = () => {};
    const roleAuditEntered = new Promise<void>((resolve) => { observeRoleAudit = resolve; });
    const roleAuditGate = new Promise<void>((resolve) => { releaseRoleAudit = resolve; });
    class GatedRoleAuditStore extends InMemoryPlatformStore {
      override async recordAudit(event: string): Promise<void> {
        if (event === "meeting.participant.role.changed") {
          observeRoleAudit();
          await roleAuditGate;
        }
      }
    }
    const { store, participant, meeting } = await runnableChairStore(GatedRoleAuditStore);
    const target = (await store.getSnapshot()).roles.find((role) => role.id !== participant.roleId)!;

    const roleSwitch = store.switchParticipantRole(meeting.id, participant.id, {
      roleId: target.id,
      expectedRoleRevision: participant.roleRevision,
      reason: "Publish only after the required audit."
    });
    await roleAuditEntered;
    const whileAuditPending = await store.getSnapshot();
    releaseRoleAudit();
    await roleSwitch;

    expect(whileAuditPending.participants.find((item) => item.id === participant.id)).toMatchObject({
      roleId: participant.roleId,
      roleRevision: participant.roleRevision
    });
  });

  it("persists one truthful speaker action per Meeting and tracks queued, running, and released states", async () => {
    const { store, job, meeting } = await runnableChairStore();

    const queued = await store.reserveSpeakerTurn("speaker-job-1", job);
    expect(queued).toMatchObject({
      id: "speaker-job-1",
      jobId: "speaker-job-1",
      meetingId: meeting.id,
      participantId: job.participantId,
      roleRevision: job.roleRevision,
      status: "queued",
      startedAt: null
    });
    await expect(store.reserveSpeakerTurn("speaker-job-2", job)).rejects.toThrow(/queued|active|action/i);

    const running = await store.markSpeakerTurnRunning("speaker-job-1");
    expect(running).toMatchObject({ status: "running", startedAt: expect.any(String) });
    await expect(store.markSpeakerTurnRunning("speaker-job-1")).resolves.toBeNull();
    expect((await store.getSnapshot()).speakerQueue).toEqual([expect.objectContaining({ jobId: "speaker-job-1", status: "running" })]);

    const released = await store.releaseSpeakerTurn("speaker-job-1", "stale_turn");
    expect(released).toMatchObject({ jobId: "speaker-job-1" });
    expect((await store.getSnapshot()).speakerQueue).toEqual([]);
    await expect(store.releaseSpeakerTurn("speaker-job-1", "stale_turn")).resolves.toBeNull();
  });

  it("rejects a speaker job replay whose durable request fingerprint changed", async () => {
    const { store, job } = await runnableChairStore();
    const queued = await store.reserveSpeakerTurn("speaker-job-fingerprint", job);

    await expect(store.reserveSpeakerTurn("speaker-job-fingerprint", {
      ...job,
      agendaRevision: job.agendaRevision + 1
    })).rejects.toThrow(/job ID|request|action|fingerprint/i);

    expect((await store.getSnapshot()).speakerQueue).toEqual([queued]);
  });

  it("uses the same durable Meeting action slot for MCP and Agent work", async () => {
    const { store, meeting, participant, mcpConnectorId } = await runnableChairStore();
    const toolRole = (await store.getSnapshot()).roles.find((role) =>
      role.toolPolicy === "agent_read_only_grants" && role.dataPolicy === "agent_declared_scope"
    )!;
    const toolParticipant = participant.roleId === toolRole.id
      ? participant
      : await store.switchParticipantRole(meeting.id, participant.id, {
          roleId: toolRole.id,
          expectedRoleRevision: participant.roleRevision,
          reason: "Test the MCP execution queue."
        });
    const currentConnector = (await store.getSnapshot()).mcpConnectors.find((item) => item.id === mcpConnectorId)!;
    const connector = currentConnector;
    const registration = currentConnector.toolRegistrations[0]!;
    const toolJob: McpToolCallJobData = {
      meetingId: meeting.id,
      agentId: toolParticipant.agentId,
      participantId: toolParticipant.id,
      roleRevision: toolParticipant.roleRevision,
      roleId: toolParticipant.roleId,
      roleVersion: toolParticipant.roleSnapshot.version,
      connectorId: connector.id,
      toolName: registration.toolName,
      toolSnapshot: { connectorName: connector.name, ...registration },
      connectorFingerprint: mcpConnectorExecutionFingerprint(currentConnector, null),
      arguments: { query: "policy" },
      requestedBy: "owner"
    };

    const toolRequestFingerprint = mcpToolRequestFingerprint({ ...toolJob, arguments: toolJob.arguments! });
    const queued = await store.reserveMcpToolCall("tool-job-1", {
      ...toolJob,
      requestFingerprint: toolRequestFingerprint
    });
    expect(queued).toMatchObject({
      kind: "mcp_tool_call",
      requestFingerprint: toolRequestFingerprint,
      toolName: "search",
      status: "queued",
      agendaRevision: null,
      mcpExecutionBinding: {
        connectorId: connector.id,
        toolSnapshot: toolJob.toolSnapshot,
        connectorFingerprint: toolJob.connectorFingerprint
      }
    });
    await expect(store.reserveMcpToolCall("tool-job-1", {
      ...toolJob,
      requestFingerprint: mcpToolRequestFingerprint({
        ...toolJob,
        arguments: { query: "different policy" }
      })
    })).rejects.toThrow(/another Meeting action/i);
    await expect(store.commitMcpToolRun({
      ...toolJob,
      jobId: "tool-job-1",
      requestFingerprint: mcpToolRequestFingerprint({
        ...toolJob,
        arguments: { query: "different policy" }
      }),
      status: "succeeded",
      content: "must not persist",
      reservationRequired: true
    })).resolves.toMatchObject({ status: "stale", run: null, utterance: null });
    expect((await store.getSnapshot()).speakerQueue).toContainEqual(expect.objectContaining({
      jobId: "tool-job-1",
      requestFingerprint: toolRequestFingerprint
    }));

    const mutableState = Reflect.get(store, "state") as PlatformSnapshot;
    const reservedTool = mutableState.speakerQueue.find((item) => item.jobId === "tool-job-1")!;
    const reservedRoleId = reservedTool.roleId;
    reservedTool.roleId = "00000000-0000-4000-8000-000000000099";
    await expect(store.commitMcpToolRun({
      ...toolJob,
      jobId: "tool-job-1",
      requestFingerprint: toolRequestFingerprint,
      status: "succeeded",
      content: "must not persist",
      reservationRequired: true
    })).resolves.toMatchObject({ status: "stale", run: null, utterance: null });
    reservedTool.roleId = reservedRoleId;

    const reservedRoleVersion = reservedTool.roleVersion;
    reservedTool.roleVersion += 1;
    await expect(store.commitMcpToolRun({
      ...toolJob,
      jobId: "tool-job-1",
      requestFingerprint: toolRequestFingerprint,
      status: "succeeded",
      content: "must not persist",
      reservationRequired: true
    })).resolves.toMatchObject({ status: "stale", run: null, utterance: null });
    reservedTool.roleVersion = reservedRoleVersion;

    const currentMeeting = (await store.getSnapshot()).meetings.find((item) => item.id === meeting.id)!;
    const agentJob: AgentTurnJobData = {
      meetingId: meeting.id,
      agentId: toolParticipant.agentId,
      participantId: toolParticipant.id,
      roleRevision: toolParticipant.roleRevision,
      roleId: toolParticipant.roleId,
      roleVersion: toolParticipant.roleSnapshot.version,
      agendaRevision: currentMeeting.agenda.revision,
      agendaCurrentItemId: currentMeeting.agenda.items.find((item) => item.status === "current")?.id ?? null,
      requestedBy: "owner"
    };
    await expect(store.reserveSpeakerTurn("speaker-blocked-by-tool", agentJob)).rejects.toThrow(/queued|active|action/i);

    const running = await store.markSpeakerTurnRunning("tool-job-1");
    expect(running).toMatchObject({ kind: "mcp_tool_call", status: "running", leaseExpiresAt: expect.any(String) });
  });

  it("reclaims an expired reservation so an API crash cannot block the Meeting forever", async () => {
    const { store, job } = await runnableChairStore();
    await store.reserveSpeakerTurn("speaker-expired", job);
    const mutableState = Reflect.get(store, "state") as PlatformSnapshot;
    mutableState.speakerQueue[0]!.leaseExpiresAt = "2026-01-01T00:00:00.000Z";

    await expect(store.releaseExpiredSpeakerTurns("2026-01-01T00:00:01.000Z")).resolves.toEqual([
      expect.objectContaining({ jobId: "speaker-expired" })
    ]);
    await expect(store.reserveSpeakerTurn("speaker-after-expiry", job)).resolves.toMatchObject({ jobId: "speaker-after-expiry" });
  });

  it("never bulk-releases an expired running reservation with an unknown provider outcome", async () => {
    const { store, job } = await runnableChairStore();
    await store.reserveSpeakerTurn("speaker-running-expired", job);
    await store.markSpeakerTurnRunning("speaker-running-expired");
    const mutableState = Reflect.get(store, "state") as PlatformSnapshot;
    mutableState.speakerQueue[0]!.leaseExpiresAt = "2026-01-01T00:00:00.000Z";

    await expect(store.releaseExpiredSpeakerTurns("2026-01-01T00:00:01.000Z")).resolves.toEqual([]);
    expect((await store.getSpeakerQueue()).find((item) => item.jobId === "speaker-running-expired")).toMatchObject({
      status: "running"
    });
  });

  it("renews an accepted queued action so it can start after the original lease expires", async () => {
    const { store, job } = await runnableChairStore();
    await store.reserveSpeakerTurn("speaker-waiting-in-bullmq", job);
    const mutableState = Reflect.get(store, "state") as PlatformSnapshot;
    mutableState.speakerQueue[0]!.leaseExpiresAt = "2026-01-01T00:00:00.000Z";

    const renewed = await store.renewSpeakerTurnLease(
      "speaker-waiting-in-bullmq",
      "2026-01-01T00:00:01.000Z"
    );

    expect(renewed).toMatchObject({
      jobId: "speaker-waiting-in-bullmq",
      status: "queued",
      leaseExpiresAt: "2026-01-01T00:05:01.000Z"
    });
    await expect(store.markSpeakerTurnRunning("speaker-waiting-in-bullmq")).resolves.toMatchObject({
      jobId: "speaker-waiting-in-bullmq",
      status: "running"
    });
  });

  it("invalidates a queued action when the Meeting closes so reopening cannot revive it", async () => {
    const { store, job, meeting } = await runnableChairStore();
    await store.reserveSpeakerTurn("speaker-job-before-close", job);

    await store.setMeetingState(meeting.id, "closed");
    await store.setMeetingState(meeting.id, "active");

    expect((await store.getSnapshot()).speakerQueue).toEqual([]);
    await expect(store.markSpeakerTurnRunning("speaker-job-before-close")).resolves.toBeNull();
    await expect(store.commitAgentTurn({
      ...job,
      turnId: "speaker-job-before-close",
      speakerName: "Chair-Local",
      roleName: "主席",
      content: "不應在重開後寫入",
      auditDetail: {},
      reservationRequired: true
    })).resolves.toMatchObject({ status: "stale", utterance: null });

    await expect(store.commitAgentTurnFailure({
      meetingId: meeting.id,
      jobId: "speaker-job-before-close",
      content: "A released pre-close job must not pause a reopened Meeting.",
      classification: "stale_reservation"
    })).resolves.toMatchObject({
      status: "stale",
      meeting: { state: "active" },
      utterance: null,
      meetingPaused: false
    });
    await expect(store.releaseSpeakerTurn("speaker-job-before-close", "worker_cleanup_after_stale"))
      .resolves.toBeNull();

    const reopened = await store.getSnapshot();
    expect(reopened.meetings.find((item) => item.id === meeting.id)?.state).toBe("active");
    expect(reopened.utterances.some((item) => item.turnId === "speaker-job-before-close" && item.kind === "failure"))
      .toBe(false);
  });

  it("rejects an old Role binding at Agent commit and atomically removes the exact queue item on success", async () => {
    const { store, job, participant, meeting } = await runnableChairStore();
    await store.reserveSpeakerTurn("speaker-job-stale", job);
    await store.releaseSpeakerTurn("speaker-job-stale", "test_role_switch");
    const target = (await store.getSnapshot()).roles.find((role) => role.id !== participant.roleId)!;
    await store.switchParticipantRole(meeting.id, participant.id, {
      roleId: target.id,
      expectedRoleRevision: participant.roleRevision,
      reason: "切換執行觀點。"
    });

    await expect(store.commitAgentTurn({
      ...job,
      turnId: "speaker-job-stale",
      speakerName: "Chair-Local",
      roleName: participant.roleSnapshot.name,
      content: "舊角色回覆",
      auditDetail: {}
    })).resolves.toMatchObject({ status: "stale", utterance: null });

    const current = (await store.getSnapshot()).participants.find((item) => item.id === participant.id)!;
    const currentJob = { ...job, roleRevision: current.roleRevision, roleId: current.roleId, roleVersion: current.roleSnapshot.version };
    await store.reserveSpeakerTurn("speaker-job-current", currentJob);
    await expect(store.commitAgentTurn({
      ...currentJob,
      turnId: "speaker-job-current",
      speakerName: "Chair-Local",
      roleName: current.roleSnapshot.name,
      content: "新角色回覆",
      auditDetail: {}
    })).resolves.toMatchObject({ status: "created", utterance: expect.objectContaining({ content: "新角色回覆" }) });
    expect((await store.getSnapshot()).speakerQueue).toEqual([]);
  });

  it("fences a late Agent execution from a replacement reservation with the same job key", async () => {
    const { store, job, meeting } = await runnableChairStore();
    const oldReservationId = "old-agent-reservation";
    const newReservationId = "new-agent-reservation";

    await store.reserveSpeakerTurn("stable-agent-job", { ...job, reservationId: oldReservationId });
    await store.releaseSpeakerTurn("stable-agent-job", "recovery", oldReservationId);
    await store.reserveSpeakerTurn("stable-agent-job", { ...job, reservationId: newReservationId });

    await expect(store.markSpeakerTurnRunning("stable-agent-job", oldReservationId)).resolves.toBeNull();
    await expect(store.commitAgentTurn({
      ...job,
      reservationId: oldReservationId,
      turnId: "stable-agent-job",
      speakerName: "Chair-Local",
      roleName: "主席",
      content: "late success",
      auditDetail: {},
      reservationRequired: true
    })).resolves.toMatchObject({ status: "stale", utterance: null });
    await expect(store.commitAgentTurnFailure({
      meetingId: meeting.id,
      jobId: "stable-agent-job",
      reservationId: oldReservationId,
      content: "late failure",
      classification: "stale_reservation"
    })).resolves.toMatchObject({ status: "stale", utterance: null, meetingPaused: false });
    await expect(store.releaseSpeakerTurn("stable-agent-job", "late_cleanup", oldReservationId)).resolves.toBeNull();

    expect((await store.getSnapshot()).speakerQueue).toEqual([
      expect.objectContaining({ jobId: "stable-agent-job", reservationId: newReservationId, status: "queued" })
    ]);
  });
});
