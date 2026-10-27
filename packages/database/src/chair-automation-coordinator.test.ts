import { describe, expect, it, vi } from "vitest";
import type { ChairAutomationJobData } from "@council/contracts";
import { coordinateChairIntervention } from "./chair-automation-coordinator.js";
import { InMemoryPlatformStore } from "./memory-store.js";
import { createSeedSnapshot } from "./seed.js";

function enableChairModel(seed: ReturnType<typeof createSeedSnapshot>, agentId: string): void {
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

async function automaticChairFixture() {
  const seed = createSeedSnapshot();
  const meeting = seed.meetings[0]!;
  const evaluationNow = Date.now();
  meeting.startedAt = new Date(evaluationNow - 2 * 60_000).toISOString();
  const chair = seed.participants.find((item) => item.meetingId === meeting.id && item.isChair)!;
  enableChairModel(seed, chair.agentId);
  const store = new InMemoryPlatformStore(seed);
  await store.setMeetingAutomation(meeting.id, {
    automation: "auto",
    expectedAutomation: "suggest",
    expectedAutomationRevision: 0
  });
  await store.addUtterance(meeting.id, {
    speakerType: "human",
    speakerName: "Owner",
    roleName: "決策者",
    content: "先確認目前議程與驗收條件。",
    kind: "human",
    evidenceCount: 0
  });
  const source = await store.addUtterance(meeting.id, {
    speakerType: "human",
    speakerName: "Owner",
    roleName: "決策者",
    content: "今天午餐想吃義大利麵",
    kind: "human",
    evidenceCount: 0
  });
  return { evaluationNow, meeting, source, store };
}

describe("chair automation coordinator", () => {
  it("queues automatic Chair jobs with exact runtime bindings and immutable snapshots", async () => {
    const seed = createSeedSnapshot();
    const meeting = seed.meetings[0]!;
    const evaluationNow = Date.now();
    meeting.startedAt = new Date(evaluationNow - 2 * 60_000).toISOString();
    const chair = seed.participants.find((item) => item.meetingId === meeting.id && item.isChair)!;
    enableChairModel(seed, chair.agentId);
    const store = new InMemoryPlatformStore(seed);
    await store.setMeetingAutomation(meeting.id, {
      automation: "auto",
      expectedAutomation: "suggest",
      expectedAutomationRevision: 0
    });
    await store.addUtterance(meeting.id, {
      speakerType: "human",
      speakerName: "Owner",
      roleName: "決策者",
      content: "先確認目前議程與驗收條件。",
      kind: "human",
      evidenceCount: 0
    });
    const source = await store.addUtterance(meeting.id, {
      speakerType: "human",
      speakerName: "Owner",
      roleName: "決策者",
      content: "今天午餐想吃義大利麵",
      kind: "human",
      evidenceCount: 0
    });

    let queuedJob: ChairAutomationJobData | null = null;
    let admissionAtEnqueue: Awaited<ReturnType<InMemoryPlatformStore["getChairAutomationJobAdmissions"]>>[number] | undefined;
    const result = await coordinateChairIntervention({
      store,
      meetingId: meeting.id,
      sourceUtteranceId: source.id,
      now: evaluationNow + 1_000,
      enqueue: async (job, requestedJobId) => {
        queuedJob = job;
        admissionAtEnqueue = (await store.getChairAutomationJobAdmissions())
          .find((admission) => admission.jobId === requestedJobId);
        return { jobId: requestedJobId };
      }
    });

    const runtimeBinding = (await store.getSnapshot()).agents.find((item) => item.id === chair.agentId)!.runtimeProfileBinding!;
    expect(result).toMatchObject({ disposition: "queued", jobId: expect.any(String) });
    expect(admissionAtEnqueue).toMatchObject({
      chairSuggestionId: result.suggestion!.id,
      meetingId: meeting.id,
      jobId: result.jobId,
      automationRevision: 1,
      status: "reserved",
      admittedAt: null,
      reconciliationRequiredAt: null,
      reconciliationReason: null
    });
    await expect(store.getChairAutomationJobAdmissions()).resolves.toContainEqual(expect.objectContaining({
      chairSuggestionId: result.suggestion!.id,
      meetingId: meeting.id,
      jobId: result.jobId,
      automationRevision: 1,
      status: "admitted",
      admittedAt: expect.any(String),
      reconciliationRequiredAt: null,
      reconciliationReason: null
    }));
    expect(queuedJob).toMatchObject({
      requestedBy: "system",
      runtimeProfileBinding: runtimeBinding,
      runtimeProfileSnapshot: {
        profileId: runtimeBinding.profileId,
        revision: runtimeBinding.revision,
        timeoutMs: 90_000,
        maxConcurrency: 2
      }
    });

    const replayEnqueue = vi.fn(async (_job: ChairAutomationJobData, requestedJobId: string) => ({
      jobId: requestedJobId
    }));
    const replay = await coordinateChairIntervention({
      store,
      meetingId: meeting.id,
      sourceUtteranceId: source.id,
      now: evaluationNow + 2_000,
      enqueue: replayEnqueue
    });
    expect(replay).toMatchObject({ disposition: "queued", jobId: result.jobId });
    expect(replayEnqueue).not.toHaveBeenCalled();
  });

  it("defers automatic Chair jobs when the bound runtime revision conflicts with the Agent model", async () => {
    const seed = createSeedSnapshot();
    const meeting = seed.meetings[0]!;
    const evaluationNow = Date.now();
    meeting.startedAt = new Date(evaluationNow - 2 * 60_000).toISOString();
    const chair = seed.participants.find((item) => item.meetingId === meeting.id && item.isChair)!;
    enableChairModel(seed, chair.agentId);
    const runtimeBinding = seed.agents.find((item) => item.id === chair.agentId)!.runtimeProfileBinding!;
    seed.runtimeProfileRevisions!.find((item) =>
      item.profileId === runtimeBinding.profileId && item.revision === runtimeBinding.revision
    )!.modelConnectorId = "c0000000-0000-4000-8000-000000000111";
    const store = new InMemoryPlatformStore(seed);
    await store.setMeetingAutomation(meeting.id, {
      automation: "auto",
      expectedAutomation: "suggest",
      expectedAutomationRevision: 0
    });
    await store.addUtterance(meeting.id, {
      speakerType: "human",
      speakerName: "Owner",
      roleName: "決策者",
      content: "先確認目前議程與驗收條件。",
      kind: "human",
      evidenceCount: 0
    });
    const source = await store.addUtterance(meeting.id, {
      speakerType: "human",
      speakerName: "Owner",
      roleName: "決策者",
      content: "今天午餐想吃義大利麵",
      kind: "human",
      evidenceCount: 0
    });

    const result = await coordinateChairIntervention({
      store,
      meetingId: meeting.id,
      sourceUtteranceId: source.id,
      now: evaluationNow + 1_000,
      enqueue: async (_job, requestedJobId) => ({ jobId: requestedJobId })
    });

    expect(result).toMatchObject({ disposition: "deferred", jobId: null });
  });

  it("requires reconciliation when enqueue acknowledgement and ownership inspection are both unavailable", async () => {
    const { evaluationNow, meeting, source, store } = await automaticChairFixture();

    const result = await coordinateChairIntervention({
      store,
      meetingId: meeting.id,
      sourceUtteranceId: source.id,
      now: evaluationNow + 1_000,
      enqueue: async () => { throw new Error("Queue acknowledgement timed out."); },
      hasJob: async () => { throw new Error("Queue ownership lookup timed out."); }
    });

    expect(result).toMatchObject({ disposition: "reconciliation_required", jobId: expect.any(String) });
    await expect(store.getChairAutomationJobAdmissions()).resolves.toContainEqual(expect.objectContaining({
      chairSuggestionId: result.suggestion!.id,
      jobId: result.jobId,
      status: "reconciliation_required",
      reconciliationReason: "queue_ownership_unknown"
    }));
  });

  it("requires reconciliation when the stable Chair parent job is already terminal", async () => {
    const { evaluationNow, meeting, source, store } = await automaticChairFixture();

    const result = await coordinateChairIntervention({
      store,
      meetingId: meeting.id,
      sourceUtteranceId: source.id,
      now: evaluationNow + 1_000,
      enqueue: async () => { throw new Error("Retained job is terminal."); },
      getJobState: async () => "failed"
    });

    expect(result).toMatchObject({ disposition: "reconciliation_required", jobId: expect.any(String) });
    await expect(store.getChairAutomationJobAdmissions()).resolves.toContainEqual(expect.objectContaining({
      chairSuggestionId: result.suggestion!.id,
      jobId: result.jobId,
      status: "reconciliation_required",
      reconciliationReason: "queue_state_terminal"
    }));

    await expect(store.confirmChairAutomationJobAdmission(result.suggestion!.id, result.jobId!))
      .rejects.toThrow(/requires reconciliation/i);
    const retryEnqueue = vi.fn(async (_job: ChairAutomationJobData, requestedJobId: string) => ({
      jobId: requestedJobId
    }));
    const retry = await coordinateChairIntervention({
      store,
      meetingId: meeting.id,
      sourceUtteranceId: source.id,
      now: evaluationNow + 2_000,
      enqueue: retryEnqueue
    });

    expect(retry).toMatchObject({
      suggestion: { id: result.suggestion!.id },
      disposition: "reconciliation_required",
      jobId: result.jobId
    });
    expect(retryEnqueue).not.toHaveBeenCalled();
    await expect(store.getChairAutomationJobAdmissions()).resolves.toContainEqual(expect.objectContaining({
      chairSuggestionId: result.suggestion!.id,
      jobId: result.jobId,
      status: "reconciliation_required",
      reconciliationReason: "queue_state_terminal"
    }));
  });

  it("releases the reservation only after a successful inspection proves the job is missing", async () => {
    const { evaluationNow, meeting, source, store } = await automaticChairFixture();

    const result = await coordinateChairIntervention({
      store,
      meetingId: meeting.id,
      sourceUtteranceId: source.id,
      now: evaluationNow + 1_000,
      enqueue: async () => { throw new Error("Queue write failed."); },
      getJobState: async () => null
    });

    expect(result).toMatchObject({ disposition: "queue_unavailable", jobId: null });
    await expect(store.getChairAutomationJobAdmissions()).resolves.toEqual([]);
  });
});
