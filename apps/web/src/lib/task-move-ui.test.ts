import { describe, expect, it, vi } from "vitest";
import {
  refreshTaskBoardAfterConflict,
  taskMoveConflictMessage
} from "../components/tasks-view";
import { TaskMoveSelectionOwnership } from "./task-move-ui";

describe("Task move status selection ownership", () => {
  it("lets the current move select its destination while it owns the selection", () => {
    const ownership = new TaskMoveSelectionOwnership();
    const request = ownership.beginMove();

    expect(ownership.ownsSelection(request)).toBe(true);
    ownership.finishMove(request);
    expect(ownership.ownsSelection(request)).toBe(false);
  });

  it("keeps a newer user status selection when an older move response finishes", async () => {
    const ownership = new TaskMoveSelectionOwnership();
    let selectedStatus = "todo";
    let finishMove!: () => void;
    const moveResponse = new Promise<void>((resolve) => {
      finishMove = resolve;
    });
    const request = ownership.beginMove();
    const completion = moveResponse.then(() => {
      if (ownership.ownsSelection(request)) selectedStatus = "done";
      ownership.finishMove(request);
    });

    ownership.claimUserSelection();
    selectedStatus = "review";
    finishMove();
    await completion;

    expect(selectedStatus).toBe("review");
  });
});

describe("Task move conflict recovery", () => {
  it("waits for an authoritative board refresh before returning the retry message", async () => {
    let finishRefresh!: () => void;
    let recoveryFinished = false;
    const refresh = vi.fn(() => new Promise<void>((resolve) => {
      finishRefresh = resolve;
    }));

    const recovery = refreshTaskBoardAfterConflict(refresh).then((message) => {
      recoveryFinished = true;
      return message;
    });
    await Promise.resolve();

    expect(refresh).toHaveBeenCalledOnce();
    expect(recoveryFinished).toBe(false);

    finishRefresh();
    await expect(recovery).resolves.toBe(taskMoveConflictMessage);
  });
});
