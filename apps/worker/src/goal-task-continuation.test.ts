import { describe, expect, it, vi } from "vitest";
import { continueGoalForTask } from "./goal-task-continuation.js";

function fixture(state = "executing", planRevision = 2) {
  const store = {
    listGoalRuns: vi.fn(async () => [{ id: "goal", state }]),
    getGoalRunDetail: vi.fn(async () => ({
      goalRun: { id: "goal", state, activePlanRevision: 2 },
      taskBindings: [{ taskId: "task", planRevision }]
    }))
  };
  const continueGoal = vi.fn(async () => {});
  return { store, continueGoal };
}

describe("canonical Task Goal continuation", () => {
  it("uses the immutable Goal binding without listing unrelated Goals", async () => {
    const { store, continueGoal } = fixture();
    store.listGoalRuns.mockRejectedValue(new Error("unbounded read"));
    await continueGoalForTask({ store: store as never, continueGoal, taskId: "task", goalRunId: "goal", trigger: "runtime:run" });
    expect(store.listGoalRuns).not.toHaveBeenCalled();
    expect(store.getGoalRunDetail).toHaveBeenCalledExactlyOnceWith("goal");
    expect(continueGoal).toHaveBeenCalledExactlyOnceWith("goal", "runtime:run");
  });

  it.each(["paused", "completed", "cancelled"])("does not advance a %s Goal", async (state) => {
    const { store, continueGoal } = fixture(state);
    await continueGoalForTask({ store: store as never, continueGoal, taskId: "task", goalRunId: "goal", trigger: "runtime:run" });
    expect(continueGoal).not.toHaveBeenCalled();
  });

  it("does not use a task binding from an older Plan Revision", async () => {
    const { store, continueGoal } = fixture("executing", 1);
    await continueGoalForTask({ store: store as never, continueGoal, taskId: "task", goalRunId: "goal", trigger: "runtime:run" });
    expect(continueGoal).not.toHaveBeenCalled();
    expect(store.listGoalRuns).not.toHaveBeenCalled();
  });

  it("retains lookup compatibility for legacy jobs without a Goal ID", async () => {
    const { store, continueGoal } = fixture("reviewing");
    await continueGoalForTask({ store: store as never, continueGoal, taskId: "task", trigger: "task:job" });
    expect(store.listGoalRuns).toHaveBeenCalledOnce();
    expect(continueGoal).toHaveBeenCalledExactlyOnceWith("goal", "task:job");
  });
});
