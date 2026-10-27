import type { PlatformStore } from "@council/database";

type GoalTaskContinuationStore = Pick<PlatformStore, "getGoalRunDetail" | "listGoalRuns">;

export async function continueGoalForTask(input: {
  store: GoalTaskContinuationStore;
  taskId: string;
  goalRunId?: string | null;
  trigger: string;
  continueGoal: (goalRunId: string, trigger: string) => Promise<void>;
}): Promise<void> {
  const candidateIds = input.goalRunId
    ? [input.goalRunId]
    : (await input.store.listGoalRuns())
      .filter((run) => run.state === "executing" || run.state === "reviewing")
      .map((run) => run.id);

  for (const id of candidateIds) {
    const detail = await input.store.getGoalRunDetail(id);
    if (!detail || !["executing", "reviewing"].includes(detail.goalRun.state)) continue;
    if (!detail.taskBindings.some((binding) => (
      binding.taskId === input.taskId && binding.planRevision === detail.goalRun.activePlanRevision
    ))) continue;
    await input.continueGoal(id, input.trigger);
    return;
  }
}
