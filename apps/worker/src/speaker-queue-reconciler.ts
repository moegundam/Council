import type { SpeakerQueueItem } from "@council/contracts";
import type { PlatformStore } from "@council/database";
import { recordReservedAgentTurnFailure } from "./process-agent-turn.js";
import { recordReservedMcpToolFailure } from "./process-mcp-tool-call.js";

const ownedQueueStates = new Set(["active", "delayed", "paused", "prioritized", "waiting", "waiting-children"]);

export interface SpeakerQueueJobReference {
  getState(): Promise<string>;
}

export interface SpeakerQueueReconciliationInput {
  store: Pick<PlatformStore,
    | "commitAgentTurnFailure"
    | "commitMcpToolRun"
    | "getSnapshot"
    | "getSpeakerQueue"
    | "renewSpeakerTurnLease"
    | "releaseChairSuggestion"
    | "releaseSpeakerTurn"
  >;
  findJob(jobId: string): Promise<SpeakerQueueJobReference | null>;
  now?: string;
}

async function releaseExpiredSpeakerReservation(
  store: SpeakerQueueReconciliationInput["store"],
  item: SpeakerQueueItem,
  reason: string
): Promise<SpeakerQueueItem | null> {
  if (item.chairSuggestionId) {
    await store.releaseChairSuggestion(
      item.chairSuggestionId,
      item.jobId,
      `Speaker Queue reconciliation released the reservation (${reason}).`
    );
  }
  return item.reservationId
    ? store.releaseSpeakerTurn(item.jobId, reason, item.reservationId)
    : store.releaseSpeakerTurn(item.jobId, reason);
}

async function resolveExpiredMcpReservation(
  store: SpeakerQueueReconciliationInput["store"],
  item: SpeakerQueueItem,
  reason: string
): Promise<{ item: SpeakerQueueItem; reason: string } | null> {
  const failure = await recordReservedMcpToolFailure({
    store,
    jobId: item.jobId,
    message: `MCP 工具工作失去可驗證的佇列所有權（${reason}）。外部執行結果未知，系統不會自動重送；請先人工對帳。`
  });
  if (failure.recorded) return { item: failure.queueItem ?? item, reason: "mcp_outcome_unknown" };
  const stillReserved = (await store.getSnapshot()).speakerQueue.some((candidate) => candidate.jobId === item.jobId);
  if (!stillReserved) return null;
  throw new Error(`MCP reservation ${item.jobId} could not be resolved durably.`);
}

async function resolveExpiredAgentReservation(
  store: SpeakerQueueReconciliationInput["store"],
  item: SpeakerQueueItem,
  reason: string
): Promise<{ item: SpeakerQueueItem; reason: string } | null> {
  const failure = await recordReservedAgentTurnFailure({
    store,
    item,
    message: `Agent 發言失去可驗證的佇列所有權（${reason}）。模型執行結果未知，系統不會自動重送；會議已暫停，請先人工確認。`
  });
  if (failure.recorded) {
    const queueItem = failure.queueItem ?? item;
    const released = await releaseExpiredSpeakerReservation(store, queueItem, "agent_outcome_unknown");
    return released ? { item: released, reason: "agent_outcome_unknown" } : null;
  }
  const stillReserved = (await store.getSnapshot()).speakerQueue.some((candidate) => candidate.jobId === item.jobId);
  if (!stillReserved) return null;
  throw new Error(`Agent reservation ${item.jobId} could not be resolved durably.`);
}

export interface SpeakerQueueReconciliationResult {
  renewed: SpeakerQueueItem[];
  released: Array<{ item: SpeakerQueueItem; reason: string }>;
}

export async function reconcileSpeakerQueueLeases(
  input: SpeakerQueueReconciliationInput
): Promise<SpeakerQueueReconciliationResult> {
  const now = input.now ?? new Date().toISOString();
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) throw new Error("Speaker Queue reconciliation time is invalid.");

  const result: SpeakerQueueReconciliationResult = { renewed: [], released: [] };
  const expired = (await input.store.getSpeakerQueue()).filter(
    (item) => Date.parse(item.leaseExpiresAt) <= timestamp
  );

  for (const item of expired) {
    const job = await input.findJob(item.jobId);
    if (job) {
      const state = await job.getState();
      if (ownedQueueStates.has(state)) {
        const renewed = await (item.reservationId
          ? input.store.renewSpeakerTurnLease(item.jobId, now, item.reservationId)
          : input.store.renewSpeakerTurnLease(item.jobId, now));
        if (renewed) result.renewed.push(renewed);
        continue;
      }
      const reason = `queue_job_${state}`;
      if (item.kind === "mcp_tool_call") {
        const resolved = await resolveExpiredMcpReservation(input.store, item, reason);
        if (resolved) result.released.push(resolved);
        continue;
      }
      if (item.kind === "agent_turn" && item.status === "running") {
        const resolved = await resolveExpiredAgentReservation(input.store, item, reason);
        if (resolved) result.released.push(resolved);
        continue;
      }
      const released = await releaseExpiredSpeakerReservation(input.store, item, reason);
      if (released) result.released.push({ item: released, reason });
      continue;
    }

    const reason = "queue_job_missing";
    if (item.kind === "mcp_tool_call") {
      const resolved = await resolveExpiredMcpReservation(input.store, item, reason);
      if (resolved) result.released.push(resolved);
      continue;
    }
    if (item.kind === "agent_turn" && item.status === "running") {
      const resolved = await resolveExpiredAgentReservation(input.store, item, reason);
      if (resolved) result.released.push(resolved);
      continue;
    }
    const released = await releaseExpiredSpeakerReservation(input.store, item, reason);
    if (released) result.released.push({ item: released, reason });
  }

  return result;
}
