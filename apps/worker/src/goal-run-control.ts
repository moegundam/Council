import type { GoalRun, GoalRunState } from "@council/contracts";
import type { PlatformStore } from "@council/database";

export type GoalRunControlStore = Pick<PlatformStore, "setGoalRunState">;

export async function pauseGoalRun(
  store: GoalRunControlStore,
  goalRun: GoalRun,
  reason: string,
  detail: Record<string, string | number | boolean | null> = {}
): Promise<GoalRun> {
  if (["completed", "failed", "cancelled", "paused"].includes(goalRun.state)) return goalRun;
  return store.setGoalRunState(goalRun.id, {
    expectedRevision: goalRun.revision,
    state: "paused",
    pausedFromState: goalRun.state,
    terminalReason: reason,
    event: {
      type: "goal.state.changed",
      actorType: "system",
      actorId: null,
      entityType: "goal",
      entityId: goalRun.id,
      summary: reason,
      detail
    }
  });
}

export async function failGoalRun(
  store: GoalRunControlStore,
  goalRun: GoalRun,
  reason: string
): Promise<GoalRun> {
  if (["completed", "failed", "cancelled"].includes(goalRun.state)) return goalRun;
  return store.setGoalRunState(goalRun.id, {
    expectedRevision: goalRun.revision,
    state: "failed",
    terminalReason: reason,
    event: {
      type: "goal.state.changed",
      actorType: "system",
      actorId: null,
      entityType: "goal",
      entityId: goalRun.id,
      summary: reason
    }
  });
}

export function isGoalRunTerminal(state: GoalRunState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}
