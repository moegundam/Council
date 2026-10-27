import { describe, expect, it, vi } from "vitest";
import type { SpeakerQueueItem, Utterance } from "@council/contracts";
import { StaleAgentTurnError } from "./process-agent-turn.js";
import { prepareAgentTurnExecution } from "./server.js";

const meetingId = "10000000-0000-4000-8000-000000000001";
const agentId = "20000000-0000-4000-8000-000000000001";
const jobId = "meeting-agent-turn-replay";
const now = "2026-08-11T00:00:00.000Z";

function queuedTurn(): SpeakerQueueItem {
  return {
    id: "30000000-0000-4000-8000-000000000001",
    jobId,
    requestFingerprint: null,
    meetingId,
    agentId,
    participantId: "40000000-0000-4000-8000-000000000001",
    roleRevision: 1,
    roleId: "50000000-0000-4000-8000-000000000001",
    roleVersion: 1,
    kind: "agent_turn",
    label: "Researcher",
    toolName: null,
    roleName: "Researcher",
    agendaRevision: 0,
    agendaCurrentItemId: null,
    status: "queued",
    requestedAt: now,
    startedAt: null,
    leaseExpiresAt: "2026-08-11T00:02:00.000Z",
    requestedBy: "owner"
  };
}

function persistedTurn(): Utterance {
  return {
    id: "60000000-0000-4000-8000-000000000001",
    meetingId,
    agentId,
    turnId: jobId,
    speakerType: "agent",
    speakerName: "Research Agent",
    roleName: "Researcher",
    content: "Persist once and replay delivery.",
    kind: "inference",
    evidenceCount: 0,
    createdAt: now
  };
}

function createReplayHarness() {
  let reservation: SpeakerQueueItem | null = queuedTurn();
  const utterances: Utterance[] = [];
  const cancellations: string[] = [];
  const store = {
    getSnapshot: vi.fn(async () => ({ utterances: [...utterances] })),
    getSpeakerQueue: vi.fn(async () => reservation ? [{ ...reservation }] : []),
    markSpeakerTurnRunning: vi.fn(async () => {
      if (!reservation || reservation.status !== "queued") return null;
      reservation = { ...reservation, status: "running", startedAt: now };
      return reservation;
    })
  };
  const provider = vi.fn(async () => {
    const utterance = persistedTurn();
    utterances.push(utterance);
    reservation = null;
    return utterance;
  });

  async function runAttempt(deliver: (utterance: Utterance) => Promise<void>) {
    try {
      const prepared = await prepareAgentTurnExecution({ store, jobId, meetingId, agentId });
      if (prepared.inProgress) return { ...prepared, utterance: null };
      const utterance = prepared.utterance ?? await provider();
      await deliver(utterance);
      return { ...prepared, utterance };
    } catch (error) {
      if (error instanceof StaleAgentTurnError) cancellations.push(jobId);
      throw error;
    }
  }

  return { cancellations, provider, runAttempt, store };
}

describe("Agent-turn delivery replay", () => {
  it("rejects a persisted non-Agent utterance that reuses the job ID", async () => {
    const store = {
      getSnapshot: vi.fn(async () => ({ utterances: [{ ...persistedTurn(), speakerType: "tool" as const }] })),
      getSpeakerQueue: vi.fn(async () => []),
      markSpeakerTurnRunning: vi.fn(async () => queuedTurn())
    };

    await expect(prepareAgentTurnExecution({ store, jobId, meetingId, agentId }))
      .rejects.toThrow("different meeting action");
    expect(store.markSpeakerTurnRunning).not.toHaveBeenCalled();
  });

  it("lets only one overlapping delivery claim the provider call", async () => {
    const harness = createReplayHarness();
    const results = await Promise.all([
      harness.runAttempt(async () => undefined),
      harness.runAttempt(async () => undefined)
    ]);

    expect(results.filter((result) => result.queueItem !== null)).toHaveLength(1);
    expect(harness.provider).toHaveBeenCalledOnce();
    expect(harness.cancellations).toEqual([]);
  });

  it("rejects a stalled redelivery instead of acknowledging a running reservation without a result", async () => {
    const harness = createReplayHarness();
    const first = await prepareAgentTurnExecution({
      store: harness.store,
      jobId,
      meetingId,
      agentId,
      deliveryAttempt: 1
    });

    expect(first.queueItem).not.toBeNull();
    await expect(prepareAgentTurnExecution({
      store: harness.store,
      jobId,
      meetingId,
      agentId,
      deliveryAttempt: 2
    })).rejects.toThrow("Agent turn outcome is unknown after stalled redelivery.");
    expect(harness.provider).not.toHaveBeenCalled();
  });

  it("replays a persisted utterance after delivery failure without provider re-execution or cancellation", async () => {
    const harness = createReplayHarness();
    const delivered: string[] = [];

    await expect(harness.runAttempt(async () => {
      throw new Error("event transport unavailable");
    })).rejects.toThrow("event transport unavailable");

    const replay = await harness.runAttempt(async (utterance) => {
      delivered.push(utterance.id);
    });

    expect(replay).toMatchObject({ replayed: true, queueItem: null, utterance: { turnId: jobId, meetingId } });
    expect(harness.provider).toHaveBeenCalledTimes(1);
    expect(harness.store.markSpeakerTurnRunning).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual([persistedTurn().id]);
    expect(harness.cancellations).toEqual([]);
  });

  it("replays the same utterance so Chair coordination remains idempotent after a partial failure", async () => {
    const harness = createReplayHarness();
    const coordinatedUtteranceIds = new Set<string>();
    const coordinateChair = vi.fn(async (utterance: Utterance, fail: boolean) => {
      coordinatedUtteranceIds.add(utterance.id);
      if (fail) throw new Error("Chair queue unavailable");
    });

    await expect(harness.runAttempt(async (utterance) => {
      await coordinateChair(utterance, true);
    })).rejects.toThrow("Chair queue unavailable");

    const replay = await harness.runAttempt(async (utterance) => {
      await coordinateChair(utterance, false);
    });

    expect(replay.replayed).toBe(true);
    expect(harness.provider).toHaveBeenCalledTimes(1);
    expect(coordinateChair).toHaveBeenCalledTimes(2);
    expect(coordinatedUtteranceIds).toEqual(new Set([persistedTurn().id]));
    expect(harness.cancellations).toEqual([]);
  });
});
