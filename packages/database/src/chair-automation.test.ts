import { describe, expect, it } from "vitest";
import { createRuntimeProfileSnapshot, type AgentTurnJobData } from "@council/contracts";
import { createQueuedRuntimeRun } from "@council/domain";
import { InMemoryPlatformStore } from "./memory-store.js";
import { createSeedSnapshot } from "./seed.js";

class AuditedChairAutomationStore extends InMemoryPlatformStore {
  readonly audits: Array<{ event: string; detail: Record<string, unknown> }> = [];

  override async recordAudit(
    event: string,
    _entityType: string,
    _entityId: string,
    detail: Record<string, unknown> = {}
  ): Promise<void> {
    this.audits.push({ event, detail });
  }
}

describe("Chair automation persistence", () => {
  function enableParticipantModel(seed: ReturnType<typeof createSeedSnapshot>, agentId: string): void {
    seed.modelConnectors.push({
      id: "c0000000-0000-4000-8000-000000000099",
      revision: 1,
      name: "Local Chair",
      location: "local",
      baseUrl: "http://127.0.0.1:4000/v1",
      model: "chair-local",
      enabled: true,
      hasSecret: false,
      secretRevision: 0
    });
    seed.agents.find((agent) => agent.id === agentId)!.modelConnectorId = seed.modelConnectors.at(-1)!.id;
  }

  function executionBinding(seed: ReturnType<typeof createSeedSnapshot>, agentId: string, jobId: string) {
    const agent = seed.agents.find((item) => item.id === agentId)!;
    const participant = seed.participants.find((item) => item.agentId === agentId && item.isChair)!;
    const meeting = seed.meetings.find((item) => item.id === participant.meetingId)!;
    const connector = seed.modelConnectors.find((item) => item.id === agent.modelConnectorId)!;
    const runtimeProfileBinding = agent.runtimeProfileBinding!;
    const runtimeProfileRevision = seed.runtimeProfileRevisions!.find((item) =>
      item.profileId === runtimeProfileBinding.profileId && item.revision === runtimeProfileBinding.revision
    )!;
    const agentRevision = participant.agentRevision ?? agent.publishedRevision ?? 1;
    const runtimeProfileSnapshot = createRuntimeProfileSnapshot(runtimeProfileRevision);
    return {
      agentRevision,
      modelConnectorBinding: {
        id: connector.id,
        location: connector.location,
        baseUrl: connector.baseUrl,
        model: connector.model,
        secretRevision: connector.secretRevision
      },
      runtimeProfileBinding: { ...runtimeProfileBinding },
      runtimeProfileSnapshot,
      runtimeRun: createQueuedRuntimeRun({
        id: "f0000000-0000-4000-8000-000000000001",
        kind: "meeting_turn",
        scope: {
          id: `meeting:${meeting.id}:participant:${participant.id}`,
          kind: "meeting_participant",
          subjectId: participant.id,
          parentScopeId: `meeting:${meeting.id}`
        },
        runtimeProfile: runtimeProfileSnapshot,
        agentId,
        agentRevision,
        roleId: participant.roleId,
        roleRevision: participant.roleRevision,
        attempt: 1,
        idempotencyKey: jobId,
        queuedAt: new Date().toISOString(),
        ttlMs: 5 * 60_000
      }),
      skillDigests: Object.fromEntries(agent.skillIds.map((skillId) => {
        const skill = seed.skills.find((item) => item.id === skillId)!;
        return [skill.id, skill.contentDigest];
      }))
    };
  }

  it("applies an immutable Chair Role recommendation only at the bound participant revision", async () => {
    const seed = createSeedSnapshot();
    const store = new AuditedChairAutomationStore(seed);
    const meeting = seed.meetings[0]!;
    const participant = seed.participants.find((item) => !item.isChair)!;
    const targetRole = seed.roles.find((role) => role.templateKey === "meeting_chair")!;
    const source = await store.addUtterance(meeting.id, {
      speakerType: "agent",
      speakerName: "Architect-R",
      roleName: participant.roleSnapshot.name,
      agentId: participant.agentId,
      content: "最新發言偏離議程。",
      kind: "inference",
      evidenceCount: 0
    });
    const created = await store.createChairSuggestion(meeting.id, source.id, {
      reason: "off_topic",
      suggestedMode: "chaired",
      explanation: "建議重新聚焦。",
      score: 0.9,
      suggestedParticipantId: participant.id,
      suggestedParticipantAgentId: participant.agentId,
      suggestedParticipantAgentName: "Architect-R",
      suggestedParticipantRoleRevision: participant.roleRevision,
      suggestedRoleId: targetRole.id,
      suggestedRoleName: targetRole.name,
      suggestedRoleVersion: targetRole.version
    });

    await expect(store.applyChairSuggestedRole(created.suggestion.id, { expectedRoleRevision: participant.roleRevision + 1 }))
      .rejects.toThrow(/revision/i);
    const applied = await store.applyChairSuggestedRole(created.suggestion.id, { expectedRoleRevision: participant.roleRevision });

    expect(applied.participant).toMatchObject({
      roleId: targetRole.id,
      roleRevision: participant.roleRevision + 1,
      roleHistory: expect.arrayContaining([expect.objectContaining({ roleId: targetRole.id, changedBy: "owner" })])
    });
    expect(applied.suggestion).toMatchObject({
      status: "resolved",
      resolution: "completed",
      resolvedBy: "owner",
      transitions: expect.arrayContaining([expect.objectContaining({ type: "role_accepted", actor: "owner" })])
    });
    expect(store.audits).toContainEqual(expect.objectContaining({ event: "chair.suggestion.role.accepted" }));
  });

  it("changes policy with optimistic concurrency and resolves an older suggestion", async () => {
    const seed = createSeedSnapshot();
    const store = new AuditedChairAutomationStore(seed);
    const meeting = seed.meetings[0]!;
    const created = await store.createChairSuggestion(meeting.id, seed.utterances.at(-1)!.id, {
      reason: "time_remaining",
      suggestedMode: "fixed",
      explanation: "剩餘時間不足，請固定順序收斂。",
      score: 0.9
    });

    await expect(store.setMeetingAutomation(meeting.id, {
      automation: "auto",
      expectedAutomation: "manual",
      expectedAutomationRevision: 0
    })).rejects.toMatchObject({
      kind: "revision",
      message: expect.stringMatching(/changed|suggest/i)
    });

    await expect(store.setMeetingAutomation(meeting.id, {
      automation: "auto",
      expectedAutomation: "suggest",
      expectedAutomationRevision: 0
    })).resolves.toMatchObject({ automation: "auto" });

    expect((await store.getSnapshot()).chairSuggestions).toContainEqual(expect.objectContaining({
      id: created.suggestion.id,
      status: "resolved",
      resolution: "manual_override",
      resolvedBy: "owner"
    }));
    expect(store.audits).toContainEqual(expect.objectContaining({
      event: "meeting.automation.changed",
      detail: expect.objectContaining({ from: "suggest", to: "auto", actor: "owner" })
    }));
  });

  it("blocks policy changes for closed Meetings and while a speaker action is reserved", async () => {
    const closedSeed = createSeedSnapshot();
    const closedStore = new InMemoryPlatformStore(closedSeed);
    await closedStore.setMeetingState(closedSeed.meetings[0]!.id, "closed");
    await expect(closedStore.setMeetingAutomation(closedSeed.meetings[0]!.id, {
      automation: "manual",
      expectedAutomation: "suggest",
      expectedAutomationRevision: 0
    })).rejects.toThrow(/closed/i);

    const seed = createSeedSnapshot();
    enableParticipantModel(seed, seed.participants[0]!.agentId);
    const store = new InMemoryPlatformStore(seed);
    const meeting = seed.meetings[0]!;
    const participant = seed.participants[0]!;
    const job: AgentTurnJobData = {
      meetingId: meeting.id,
      agentId: participant.agentId,
      participantId: participant.id,
      roleRevision: participant.roleRevision,
      roleId: participant.roleId,
      roleVersion: participant.roleSnapshot.version,
      agendaRevision: meeting.agenda.revision,
      agendaCurrentItemId: meeting.agenda.items.find((item) => item.status === "current")?.id ?? null,
      requestedBy: "owner"
    };
    await store.reserveSpeakerTurn("chair-policy-blocking-turn", job);

    await expect(store.setMeetingAutomation(meeting.id, {
      automation: "auto",
      expectedAutomation: "suggest",
      expectedAutomationRevision: 0
    })).rejects.toThrow(/queued|running|speaker/i);
  });

  it("requires auto policy and a matching open suggestion for a system Chair reservation", async () => {
    const seed = createSeedSnapshot();
    const meeting = seed.meetings[0]!;
    const chair = seed.participants.find((item) => item.meetingId === meeting.id && item.isChair)!;
    enableParticipantModel(seed, chair.agentId);
    const store = new InMemoryPlatformStore(seed);
    const suggestion = await store.createChairSuggestion(meeting.id, seed.utterances.at(-1)!.id, {
      reason: "off_topic",
      suggestedMode: "chaired",
      explanation: "請主席將討論帶回目標。",
      score: 0.85,
      suggestedAgentId: chair.agentId,
      suggestedAgentName: "Chair"
    });
    const job: AgentTurnJobData = {
      meetingId: meeting.id,
      agentId: chair.agentId,
      participantId: chair.id,
      roleRevision: chair.roleRevision,
      roleId: chair.roleId,
      roleVersion: chair.roleSnapshot.version,
      agendaRevision: meeting.agenda.revision,
      agendaCurrentItemId: meeting.agenda.items.find((item) => item.status === "current")?.id ?? null,
      requestedBy: "system",
      automationRevision: meeting.automationRevision ?? 0,
      chairSuggestionId: suggestion.suggestion.id
    };

    await expect(store.reserveSpeakerTurn("system-chair-turn", job)).rejects.toThrow(/automatic|auto/i);
    await store.setMeetingAutomation(meeting.id, { automation: "auto", expectedAutomation: "suggest", expectedAutomationRevision: 0 });
    const freshSource = await store.addUtterance(meeting.id, {
      speakerType: "human",
      speakerName: "Owner",
      roleName: "決策者",
      content: "重新產生可供自動處理的主席建議。",
      kind: "human",
      evidenceCount: 0
    });
    const fresh = await store.createChairSuggestion(meeting.id, freshSource.id, {
      reason: "off_topic",
      suggestedMode: "chaired",
      explanation: "請主席將討論帶回目標。",
      score: 0.86,
      suggestedAgentId: chair.agentId,
      suggestedAgentName: "Chair"
    });
    await expect(store.reserveSpeakerTurn("system-chair-turn", {
      ...job,
      automationRevision: (await store.getSnapshot()).meetings[0]!.automationRevision ?? 0,
      chairSuggestionId: fresh.suggestion.id
    })).resolves.toMatchObject({ requestedAt: expect.any(String), kind: "agent_turn" });
  });

  it("atomically applies a stricter mode and reserves one revision-bound Chair turn", async () => {
    const seed = createSeedSnapshot();
    const meeting = seed.meetings[0]!;
    const chair = seed.participants.find((item) => item.meetingId === meeting.id && item.isChair)!;
    enableParticipantModel(seed, chair.agentId);
    const store = new AuditedChairAutomationStore(seed);
    await store.setMeetingAutomation(meeting.id, { automation: "auto", expectedAutomation: "suggest", expectedAutomationRevision: 0 });
    const current = (await store.getSnapshot()).meetings[0]!;
    const suggestion = await store.createChairSuggestion(meeting.id, seed.utterances.at(-1)!.id, {
      reason: "off_topic",
      suggestedMode: "chaired",
      explanation: "請主席將討論帶回目標。",
      score: 0.88,
      suggestedAgentId: chair.agentId,
      suggestedAgentName: "Chair"
    }, { automation: "auto", automationRevision: current.automationRevision ?? 0 });

    const result = await store.applyChairAutomation({
      meetingId: meeting.id,
      chairSuggestionId: suggestion.suggestion.id,
      sourceUtteranceId: suggestion.suggestion.sourceUtteranceId,
      automationRevision: current.automationRevision ?? 0,
      agentTurnJobId: "automatic-chair-turn",
      ...executionBinding(await store.getSnapshot(), chair.agentId, "automatic-chair-turn")
    });

    expect(result).toMatchObject({
      status: "applied",
      meeting: { mode: "chaired" },
      suggestion: { status: "pending", requestedAgentJobId: "automatic-chair-turn" },
      queueItem: {
        jobId: "automatic-chair-turn",
        requestedBy: "system",
        chairSuggestionId: suggestion.suggestion.id,
        automationRevision: current.automationRevision
      },
      agentTurnJob: {
        requestedBy: "system",
        chairSuggestionId: suggestion.suggestion.id,
        automationRevision: current.automationRevision,
        modelConnectorBinding: expect.objectContaining({ location: "local", model: "chair-local" }),
        runtimeRun: expect.objectContaining({
          kind: "meeting_turn",
          idempotencyKey: "automatic-chair-turn",
          state: "queued"
        }),
        skillDigests: expect.any(Object)
      }
    });
    expect(store.audits).toContainEqual(expect.objectContaining({ event: "chair.automation.applied" }));
  });

  it("does not expose or roll back over an Owner mode change while Chair audit is pending", async () => {
    let gateChairAudit = false;
    let observeChairAudit!: () => void;
    let releaseChairAudit!: () => void;
    const chairAuditObserved = new Promise<void>((resolve) => { observeChairAudit = resolve; });
    const chairAuditGate = new Promise<void>((resolve) => { releaseChairAudit = resolve; });
    class GatedChairStore extends InMemoryPlatformStore {
      override async recordAudit(event: string): Promise<void> {
        if (gateChairAudit && event === "meeting.mode.changed") {
          gateChairAudit = false;
          observeChairAudit();
          await chairAuditGate;
          throw new Error("Chair mode audit unavailable");
        }
      }
    }
    const seed = createSeedSnapshot();
    const meeting = seed.meetings[0]!;
    const store = new GatedChairStore(seed);
    await store.setMeetingAutomation(meeting.id, {
      automation: "auto",
      expectedAutomation: "suggest",
      expectedAutomationRevision: 0
    });
    const current = (await store.getSnapshot()).meetings.find((item) => item.id === meeting.id)!;
    const suggestion = await store.createChairSuggestion(meeting.id, seed.utterances.at(-1)!.id, {
      reason: "time_remaining",
      suggestedMode: "fixed",
      explanation: "請固定順序收斂。",
      score: 1
    }, { automation: "auto", automationRevision: current.automationRevision ?? 0 });
    const ownerMode = current.mode === "open" ? "chaired" : "open";

    gateChairAudit = true;
    const chairMutation = store.applyChairAutomation({
      meetingId: meeting.id,
      chairSuggestionId: suggestion.suggestion.id,
      sourceUtteranceId: suggestion.suggestion.sourceUtteranceId,
      automationRevision: current.automationRevision ?? 0
    });
    const chairRejection = expect(chairMutation).rejects.toThrow("Chair mode audit unavailable");
    await chairAuditObserved;
    const modeWhileChairAuditPending = (await store.getSnapshot()).meetings
      .find((item) => item.id === meeting.id)!.mode;
    let ownerSettled = false;
    const ownerMutation = store.setMeetingMode(meeting.id, {
      mode: ownerMode,
      reason: "Owner override while automatic Chair audit is pending."
    }).then((result) => {
      ownerSettled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    const ownerSettledWhileChairAuditPending = ownerSettled;
    releaseChairAudit();
    await chairRejection;
    await expect(ownerMutation).resolves.toMatchObject({ meeting: { mode: ownerMode } });

    expect(modeWhileChairAuditPending).toBe(current.mode);
    expect(ownerSettledWhileChairAuditPending).toBe(false);
    expect((await store.getSnapshot()).meetings.find((item) => item.id === meeting.id)?.mode).toBe(ownerMode);
  });

  it("releases only automatic Chair reservations on an emergency auto downshift", async () => {
    const seed = createSeedSnapshot();
    const meeting = seed.meetings[0]!;
    const chair = seed.participants.find((item) => item.meetingId === meeting.id && item.isChair)!;
    enableParticipantModel(seed, chair.agentId);
    const store = new AuditedChairAutomationStore(seed);
    await store.setMeetingAutomation(meeting.id, { automation: "auto", expectedAutomation: "suggest", expectedAutomationRevision: 0 });
    const current = (await store.getSnapshot()).meetings[0]!;
    const suggestion = await store.createChairSuggestion(meeting.id, seed.utterances.at(-1)!.id, {
      reason: "off_topic",
      suggestedMode: "chaired",
      explanation: "請主席收斂。",
      score: 0.9,
      suggestedAgentId: chair.agentId,
      suggestedAgentName: "Chair"
    }, { automation: "auto", automationRevision: current.automationRevision ?? 0 });
    const applied = await store.applyChairAutomation({
      meetingId: meeting.id,
      chairSuggestionId: suggestion.suggestion.id,
      sourceUtteranceId: suggestion.suggestion.sourceUtteranceId,
      automationRevision: current.automationRevision ?? 0,
      agentTurnJobId: "automatic-chair-downshift",
      ...executionBinding(await store.getSnapshot(), chair.agentId, "automatic-chair-downshift")
    });
    expect(applied).toMatchObject({ status: "applied", queueItem: { jobId: "automatic-chair-downshift" } });

    await store.setMeetingAutomation(meeting.id, {
      automation: "manual",
      expectedAutomation: "auto",
      expectedAutomationRevision: 1
    });

    const snapshot = await store.getSnapshot();
    expect(snapshot.speakerQueue).toHaveLength(0);
    expect(snapshot.chairSuggestions.find((item) => item.id === suggestion.suggestion.id)).toMatchObject({
      status: "resolved",
      resolution: "manual_override"
    });
    expect(store.audits).toContainEqual(expect.objectContaining({
      event: "speaker.queue.released",
      detail: expect.objectContaining({ jobId: "automatic-chair-downshift", reason: "chair_automation_downshift" })
    }));
  });

  it("does not supersede a pending automatic Chair intervention with a newer suggestion", async () => {
    const seed = createSeedSnapshot();
    const meeting = seed.meetings[0]!;
    const chair = seed.participants.find((item) => item.meetingId === meeting.id && item.isChair)!;
    enableParticipantModel(seed, chair.agentId);
    const store = new InMemoryPlatformStore(seed);
    await store.setMeetingAutomation(meeting.id, { automation: "auto", expectedAutomation: "suggest", expectedAutomationRevision: 0 });
    const current = (await store.getSnapshot()).meetings[0]!;
    const suggestion = await store.createChairSuggestion(meeting.id, seed.utterances.at(-1)!.id, {
      reason: "off_topic",
      suggestedMode: "chaired",
      explanation: "請主席收斂。",
      score: 0.9,
      suggestedAgentId: chair.agentId,
      suggestedAgentName: "Chair"
    }, { automation: "auto", automationRevision: current.automationRevision ?? 0 });
    await store.applyChairAutomation({
      meetingId: meeting.id,
      chairSuggestionId: suggestion.suggestion.id,
      sourceUtteranceId: suggestion.suggestion.sourceUtteranceId,
      automationRevision: current.automationRevision ?? 0,
      agentTurnJobId: "pending-chair-intervention",
      ...executionBinding(await store.getSnapshot(), chair.agentId, "pending-chair-intervention")
    });
    const source = await store.addUtterance(meeting.id, {
      speakerType: "human",
      speakerName: "Owner",
      roleName: "決策者",
      content: "另一段可能離題的內容。",
      kind: "human",
      evidenceCount: 0
    });

    await expect(store.createChairSuggestion(meeting.id, source.id, {
      reason: "off_topic",
      suggestedMode: "chaired",
      explanation: "較新的主席建議。",
      score: 0.91,
      suggestedAgentId: chair.agentId,
      suggestedAgentName: "Chair"
    }, { automation: "auto", automationRevision: current.automationRevision ?? 0 })).rejects.toThrow(/pending Chair intervention/i);
    const snapshot = await store.getSnapshot();
    expect(snapshot.speakerQueue).toContainEqual(expect.objectContaining({ jobId: "pending-chair-intervention" }));
    expect(snapshot.chairSuggestions).toHaveLength(1);
    expect(snapshot.chairSuggestions[0]).toMatchObject({ status: "pending" });
  });

  it("applies a mode-only time warning once without reserving an Agent turn", async () => {
    const seed = createSeedSnapshot();
    const meeting = seed.meetings[0]!;
    const store = new AuditedChairAutomationStore(seed);
    await store.setMeetingAutomation(meeting.id, { automation: "auto", expectedAutomation: "suggest", expectedAutomationRevision: 0 });
    const current = (await store.getSnapshot()).meetings[0]!;
    const suggestion = await store.createChairSuggestion(meeting.id, seed.utterances.at(-1)!.id, {
      reason: "time_remaining",
      suggestedMode: "fixed",
      explanation: "只剩三分鐘，請固定順序收斂。",
      score: 1
    }, { automation: "auto", automationRevision: current.automationRevision ?? 0 });

    await expect(store.applyChairAutomation({
      meetingId: meeting.id,
      chairSuggestionId: suggestion.suggestion.id,
      sourceUtteranceId: suggestion.suggestion.sourceUtteranceId,
      automationRevision: current.automationRevision ?? 0
    })).resolves.toMatchObject({
      status: "applied",
      meeting: { mode: "fixed" },
      suggestion: { status: "resolved", resolution: "completed", resolvedBy: "system" },
      queueItem: null,
      agentTurnJob: null
    });
  });

  it("returns stale without mutation after an automation revision changes", async () => {
    const seed = createSeedSnapshot();
    const store = new AuditedChairAutomationStore(seed);
    const meeting = seed.meetings[0]!;
    await store.setMeetingAutomation(meeting.id, { automation: "auto", expectedAutomation: "suggest", expectedAutomationRevision: 0 });
    const auto = (await store.getSnapshot()).meetings[0]!;
    const suggestion = await store.createChairSuggestion(meeting.id, seed.utterances.at(-1)!.id, {
      reason: "time_remaining",
      suggestedMode: "fixed",
      explanation: "請收斂。",
      score: 1
    }, { automation: "auto", automationRevision: auto.automationRevision ?? 0 });
    await store.setMeetingAutomation(meeting.id, { automation: "manual", expectedAutomation: "auto", expectedAutomationRevision: 1 });
    await store.setMeetingAutomation(meeting.id, { automation: "auto", expectedAutomation: "manual", expectedAutomationRevision: 2 });
    const before = await store.getSnapshot();

    await expect(store.applyChairAutomation({
      meetingId: meeting.id,
      chairSuggestionId: suggestion.suggestion.id,
      sourceUtteranceId: suggestion.suggestion.sourceUtteranceId,
      automationRevision: auto.automationRevision ?? 0
    })).resolves.toMatchObject({ status: "stale" });
    expect(await store.getSnapshot()).toEqual(before);
  });

  it("reopens an automatic suggestion when its speaker lease expires", async () => {
    const seed = createSeedSnapshot();
    const meeting = seed.meetings[0]!;
    const chair = seed.participants.find((item) => item.meetingId === meeting.id && item.isChair)!;
    enableParticipantModel(seed, chair.agentId);
    const store = new InMemoryPlatformStore(seed);
    await store.setMeetingAutomation(meeting.id, { automation: "auto", expectedAutomation: "suggest", expectedAutomationRevision: 0 });
    const current = (await store.getSnapshot()).meetings[0]!;
    const suggestion = await store.createChairSuggestion(meeting.id, seed.utterances.at(-1)!.id, {
      reason: "off_topic",
      suggestedMode: "chaired",
      explanation: "請主席收斂。",
      score: 0.9,
      suggestedAgentId: chair.agentId,
      suggestedAgentName: "Chair"
    }, { automation: "auto", automationRevision: current.automationRevision ?? 0 });
    const applied = await store.applyChairAutomation({
      meetingId: meeting.id,
      chairSuggestionId: suggestion.suggestion.id,
      sourceUtteranceId: suggestion.suggestion.sourceUtteranceId,
      automationRevision: current.automationRevision ?? 0,
      agentTurnJobId: "expiring-automatic-chair-turn",
      ...executionBinding(await store.getSnapshot(), chair.agentId, "expiring-automatic-chair-turn")
    });
    if (applied.status !== "applied" || !applied.queueItem) throw new Error("Expected a reserved Chair turn.");

    await store.releaseExpiredSpeakerTurns(applied.queueItem.leaseExpiresAt);
    expect((await store.getSnapshot()).chairSuggestions).toContainEqual(expect.objectContaining({
      id: suggestion.suggestion.id,
      status: "open",
      requestedAgentJobId: null,
      transitions: expect.arrayContaining([expect.objectContaining({ type: "request_released", actor: "system" })])
    }));
  });
});
