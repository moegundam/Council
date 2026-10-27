import { describe, expect, it, vi } from "vitest";
import { createRuntimeProfileSnapshot, type ChairAutomationJobData } from "@council/contracts";
import { InMemoryPlatformStore } from "@council/database";
import { createSeedSnapshot } from "@council/database/seed";
import { automaticChairTurnJobId, decideSnapshotChairAutoApply } from "@council/database";
import {
  processChairAutomation,
  recordAutomaticChairTurnFailure,
  shouldCoordinateChairAfterAgentTurn
} from "./process-chair-automation.js";

async function automaticFixture(withAgent: boolean, eligible = true) {
  const seed = createSeedSnapshot();
  const meeting = seed.meetings[0]!;
  meeting.startedAt = eligible
    ? new Date(Date.parse(seed.utterances.at(-1)!.createdAt) - 120_000).toISOString()
    : new Date().toISOString();
  const chair = seed.participants.find((item) => item.meetingId === meeting.id && item.isChair)!;
  if (withAgent) {
    seed.modelConnectors.push({
      id: "c0000000-0000-4000-8000-000000000088",
      revision: 1,
      name: "Local Chair",
      location: "local",
      baseUrl: "http://127.0.0.1:4000/v1",
      model: "chair-local",
      enabled: true,
      hasSecret: false,
      secretRevision: 0
    });
    seed.agents.find((agent) => agent.id === chair.agentId)!.modelConnectorId = seed.modelConnectors.at(-1)!.id;
  }
  const store = new InMemoryPlatformStore(seed);
  await store.setMeetingAutomation(meeting.id, { automation: "auto", expectedAutomation: "suggest", expectedAutomationRevision: 0 });
  const current = (await store.getSnapshot()).meetings[0]!;
  const suggestion = await store.createChairSuggestion(meeting.id, seed.utterances.at(-1)!.id, withAgent ? {
    reason: "off_topic",
    suggestedMode: "chaired",
    explanation: "請主席將討論帶回目標。",
    score: 0.9,
    suggestedAgentId: chair.agentId,
    suggestedAgentName: "Chair"
  } : {
    reason: "time_remaining",
    suggestedMode: "fixed",
    explanation: "請固定順序收斂。",
    score: 1
  }, { automation: "auto", automationRevision: current.automationRevision ?? 0 });
  const data: ChairAutomationJobData = {
    meetingId: meeting.id,
    chairSuggestionId: suggestion.suggestion.id,
    sourceUtteranceId: suggestion.suggestion.sourceUtteranceId,
    automationRevision: current.automationRevision ?? 0,
    requestedBy: "system",
    ...(withAgent ? {
      agentRevision: chair.agentRevision ?? 1,
      modelConnectorBinding: {
        id: seed.modelConnectors.at(-1)!.id,
        location: seed.modelConnectors.at(-1)!.location,
        baseUrl: seed.modelConnectors.at(-1)!.baseUrl,
        model: seed.modelConnectors.at(-1)!.model,
        secretRevision: seed.modelConnectors.at(-1)!.secretRevision
      },
      runtimeProfileBinding: {
        ...seed.agents.find((agent) => agent.id === chair.agentId)!.runtimeProfileBinding!
      },
      runtimeProfileSnapshot: createRuntimeProfileSnapshot(seed.runtimeProfileRevisions!.find((revision) => {
        const binding = seed.agents.find((agent) => agent.id === chair.agentId)!.runtimeProfileBinding!;
        return revision.profileId === binding.profileId && revision.revision === binding.revision;
      })!),
      skillDigests: Object.fromEntries(seed.agents.find((agent) => agent.id === chair.agentId)!.skillIds.map((skillId) => {
        const skill = seed.skills.find((item) => item.id === skillId)!;
        return [skill.id, skill.contentDigest];
      }))
    } : {})
  };
  return { store, meeting, chair, suggestion: suggestion.suggestion, data };
}

describe("processChairAutomation", () => {
  it("never starts another Chair analysis after a system-requested turn", () => {
    expect(shouldCoordinateChairAfterAgentTurn({ requestedBy: "system" })).toBe(false);
    expect(shouldCoordinateChairAfterAgentTurn({ requestedBy: "owner" })).toBe(true);
  });

  it("applies a mode-only suggestion without enqueueing a model turn", async () => {
    const fixture = await automaticFixture(false);
    const enqueueAgentTurn = vi.fn(async () => ({ jobId: "unexpected" }));

    const result = await processChairAutomation({
      store: fixture.store,
      data: fixture.data,
      automationJobId: "automation-mode-only",
      enqueueAgentTurn
    });

    expect(result).toMatchObject({ status: "applied", agentTurnJobId: null });
    expect(enqueueAgentTurn).not.toHaveBeenCalled();
    expect((await fixture.store.getSnapshot()).meetings[0]).toMatchObject({ state: "active", mode: "fixed" });
  });

  it("queues exactly one stable revision-bound Chair turn", async () => {
    const fixture = await automaticFixture(true);
    expect(decideSnapshotChairAutoApply(
      await fixture.store.getSnapshot(),
      fixture.meeting.id,
      fixture.suggestion
    )).toEqual({ allowed: true, reason: "allowed" });
    const expectedTurnJobId = automaticChairTurnJobId(
      fixture.meeting.id,
      fixture.chair.agentId,
      fixture.suggestion.id
    );
    const enqueueAgentTurn = vi.fn(async (_job, requestedJobId: string) => ({ jobId: requestedJobId }));

    const result = await processChairAutomation({
      store: fixture.store,
      data: fixture.data,
      automationJobId: "automation-with-turn",
      enqueueAgentTurn
    });

    expect(result).toMatchObject({ status: "queued", agentTurnJobId: expectedTurnJobId });
    expect(enqueueAgentTurn).toHaveBeenCalledTimes(1);
    expect(enqueueAgentTurn).toHaveBeenCalledWith(expect.objectContaining({
      requestedBy: "system",
      chairSuggestionId: fixture.suggestion.id,
      automationRevision: fixture.data.automationRevision,
      runtimeRun: expect.objectContaining({
        kind: "meeting_turn",
        agentId: fixture.chair.agentId,
        agentRevision: fixture.data.agentRevision,
        idempotencyKey: expectedTurnJobId,
        state: "queued",
        scope: expect.objectContaining({
          kind: "meeting_participant",
          subjectId: fixture.chair.id
        })
      })
    }), expectedTurnJobId);
    expect((await fixture.store.getSnapshot()).speakerQueue).toContainEqual(expect.objectContaining({
      jobId: expectedTurnJobId,
      requestedBy: "system"
    }));
  });

  it("re-enqueues the same reserved Chair turn after a crash between commit and enqueue", async () => {
    const fixture = await automaticFixture(true);
    const expectedTurnJobId = automaticChairTurnJobId(
      fixture.meeting.id,
      fixture.chair.agentId,
      fixture.suggestion.id
    );
    const suggestionCount = (await fixture.store.getSnapshot()).chairSuggestions.length;
    const applyChairAutomation = fixture.store.applyChairAutomation.bind(fixture.store);
    vi.spyOn(fixture.store, "applyChairAutomation").mockImplementationOnce(async (input) => {
      await applyChairAutomation(input);
      throw new Error("simulated process crash before enqueue");
    });
    const enqueueAgentTurn = vi.fn(async (_job, requestedJobId: string) => ({ jobId: requestedJobId }));

    await expect(processChairAutomation({
      store: fixture.store,
      data: fixture.data,
      automationJobId: "automation-lost-ack",
      enqueueAgentTurn
    })).rejects.toThrow("simulated process crash before enqueue");
    expect(enqueueAgentTurn).not.toHaveBeenCalled();

    const committed = await fixture.store.getSnapshot();
    const reservation = committed.speakerQueue.find((item) => item.jobId === expectedTurnJobId)!;
    expect(reservation).toMatchObject({
      jobId: expectedTurnJobId,
      meetingId: fixture.meeting.id,
      agentId: fixture.chair.agentId,
      participantId: fixture.chair.id,
      status: "queued",
      requestedBy: "system",
      chairSuggestionId: fixture.suggestion.id,
      automationRevision: fixture.data.automationRevision
    });
    expect(committed.chairSuggestions).toContainEqual(expect.objectContaining({
      id: fixture.suggestion.id,
      status: "pending",
      requestedAgentId: fixture.chair.agentId,
      requestedAgentJobId: expectedTurnJobId
    }));

    await expect(processChairAutomation({
      store: fixture.store,
      data: fixture.data,
      automationJobId: "automation-lost-ack",
      enqueueAgentTurn
    })).resolves.toMatchObject({ status: "queued", agentTurnJobId: expectedTurnJobId });

    expect(enqueueAgentTurn).toHaveBeenCalledTimes(1);
    expect(enqueueAgentTurn).toHaveBeenCalledWith(expect.objectContaining({
      meetingId: reservation.meetingId,
      agentId: reservation.agentId,
      participantId: reservation.participantId,
      roleId: reservation.roleId,
      roleRevision: reservation.roleRevision,
      roleVersion: reservation.roleVersion,
      agendaRevision: reservation.agendaRevision,
      agendaCurrentItemId: reservation.agendaCurrentItemId,
      requestedBy: "system",
      chairSuggestionId: fixture.suggestion.id,
      automationRevision: fixture.data.automationRevision,
      runtimeRun: expect.objectContaining({
        idempotencyKey: expectedTurnJobId,
        roleId: reservation.roleId,
        roleRevision: reservation.roleRevision,
        scope: expect.objectContaining({ subjectId: reservation.participantId })
      })
    }), expectedTurnJobId);
    const recovered = await fixture.store.getSnapshot();
    expect(recovered.chairSuggestions).toHaveLength(suggestionCount);
    expect(recovered.speakerQueue).toEqual([reservation]);
  });

  it("stale-cancels an ABA automation job before enqueue", async () => {
    const fixture = await automaticFixture(false);
    await fixture.store.setMeetingAutomation(fixture.meeting.id, { automation: "manual", expectedAutomation: "auto", expectedAutomationRevision: 1 });
    await fixture.store.setMeetingAutomation(fixture.meeting.id, { automation: "auto", expectedAutomation: "manual", expectedAutomationRevision: 2 });
    const enqueueAgentTurn = vi.fn(async () => ({ jobId: "unexpected" }));

    await expect(processChairAutomation({
      store: fixture.store,
      data: fixture.data,
      automationJobId: "stale-automation",
      enqueueAgentTurn
    })).resolves.toMatchObject({ status: "stale", agentTurnJobId: null });
    expect(enqueueAgentTurn).not.toHaveBeenCalled();
  });

  it("stale-cancels before reservation when the queued local Chair binding changed to cloud", async () => {
    const fixture = await automaticFixture(true);
    await fixture.store.updateModelConnector(fixture.data.modelConnectorBinding!.id, {
      expectedRevision: (await fixture.store.getSnapshot()).modelConnectors.find((item) => item.id === fixture.data.modelConnectorBinding!.id)!.revision,
      location: "cloud",
      baseUrl: "https://models.example.com/v1",
      model: "chair-cloud"
    });
    const enqueueAgentTurn = vi.fn(async () => ({ jobId: "unexpected" }));

    await expect(processChairAutomation({
      store: fixture.store,
      data: fixture.data,
      automationJobId: "local-to-cloud-drift",
      enqueueAgentTurn
    })).resolves.toMatchObject({ status: "stale", agentTurnJobId: null });
    expect(enqueueAgentTurn).not.toHaveBeenCalled();
    expect((await fixture.store.getSnapshot()).speakerQueue).toHaveLength(0);
  });

  it("rechecks the auto policy and defers a directly injected job during cooldown", async () => {
    const fixture = await automaticFixture(true, false);
    const enqueueAgentTurn = vi.fn(async () => ({ jobId: "unexpected" }));

    await expect(processChairAutomation({
      store: fixture.store,
      data: fixture.data,
      automationJobId: "injected-during-cooldown",
      enqueueAgentTurn
    })).resolves.toMatchObject({ status: "deferred", agentTurnJobId: null });
    expect(enqueueAgentTurn).not.toHaveBeenCalled();
    expect((await fixture.store.getSnapshot()).chairSuggestions.find(
      (item) => item.id === fixture.suggestion.id
    )).toMatchObject({ status: "open" });
  });

  it("releases the reservation and reopens the suggestion on definite enqueue failure", async () => {
    const fixture = await automaticFixture(true);
    const enqueueAgentTurn = vi.fn(async () => { throw new Error("Redis unavailable"); });

    const result = await processChairAutomation({
      store: fixture.store,
      data: fixture.data,
      automationJobId: "automation-enqueue-failure",
      enqueueAgentTurn,
      hasJob: async () => false
    });

    expect(result).toMatchObject({ status: "queue_unavailable" });
    const snapshot = await fixture.store.getSnapshot();
    expect(snapshot.meetings[0]).toMatchObject({ state: "active", mode: "chaired" });
    expect(snapshot.speakerQueue).toEqual([]);
    expect(snapshot.chairSuggestions).toContainEqual(expect.objectContaining({
      id: fixture.suggestion.id,
      status: "open",
      requestedAgentJobId: null
    }));
  });

  it("keeps a short-lived reservation when queue acceptance is confirmed after a timeout", async () => {
    const fixture = await automaticFixture(true);
    const enqueueAgentTurn = vi.fn(async () => { throw new Error("Redis response timed out"); });

    const result = await processChairAutomation({
      store: fixture.store,
      data: fixture.data,
      automationJobId: "automation-ambiguous",
      enqueueAgentTurn,
      hasJob: async () => true
    });

    expect(result).toMatchObject({ status: "queued", agentTurnJobId: expect.any(String) });
    expect((await fixture.store.getSnapshot()).speakerQueue).toHaveLength(1);
  });

  it("reopens the suggestion without pausing the Meeting after an automatic model failure", async () => {
    const fixture = await automaticFixture(true);
    let queuedJob: Parameters<typeof recordAutomaticChairTurnFailure>[1] | null = null;
    let queuedJobId = "";
    const result = await processChairAutomation({
      store: fixture.store,
      data: fixture.data,
      automationJobId: "automatic-model-failure",
      enqueueAgentTurn: async (job, requestedJobId) => {
        queuedJob = job;
        queuedJobId = requestedJobId;
        return { jobId: requestedJobId };
      }
    });
    expect(result).toMatchObject({ status: "queued", agentTurnJobId: queuedJobId });
    if (!queuedJob) throw new Error("Expected an automatic Chair turn.");

    await recordAutomaticChairTurnFailure(
      fixture.store,
      queuedJob,
      queuedJobId
    );

    const snapshot = await fixture.store.getSnapshot();
    expect(snapshot.meetings[0]).toMatchObject({ state: "active" });
    expect(snapshot.speakerQueue).toEqual([]);
    expect(snapshot.chairSuggestions).toContainEqual(expect.objectContaining({
      id: fixture.suggestion.id,
      status: "open",
      requestedAgentJobId: null
    }));
    expect(snapshot.utterances.some((utterance) => utterance.kind === "failure")).toBe(false);
  });
});
