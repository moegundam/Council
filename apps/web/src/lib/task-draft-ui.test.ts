import { describe, expect, it } from "vitest";
import type { Task } from "@council/contracts";
import {
  canSubmitTaskSync,
  createTaskDraft,
  prepareTaskDraftUpdate,
  rebaseTaskDraft,
  taskDraftConflictMessage,
  taskDraftHasChanges
} from "./task-draft-ui";

function task(title: string, revision: number, executionRevision = 1): Task {
  return {
    id: "task-1",
    meetingId: "meeting-1",
    decisionId: "decision-1",
    title,
    revision,
    boardRevision: 1,
    description: "Server description",
    status: "todo",
    position: 0,
    assignee: null,
    assigneeAgentId: null,
    dueAt: null,
    acceptanceCriteria: "",
    evidence: [],
    executionProfile: "manual",
    allowedTools: [],
    dataScope: "",
    approvalState: "not_required",
    execution: {
      revision: executionRevision,
      status: "idle",
      jobId: null,
      requestFingerprint: null,
      agentId: null,
      profile: null,
      attemptCount: 0,
      requestedAt: null,
      startedAt: null,
      completedAt: null,
      lastError: null,
      resultEvidenceId: null
    },
    transitions: [],
    sync: {
      status: "not_synced",
      adapterId: null,
      jobId: null,
      requestFingerprint: null,
      externalId: null,
      attemptCount: 0,
      lastAttemptAt: null,
      lastError: null,
      syncedAt: null
    },
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: `2026-08-11T00:00:0${revision}.000Z`
  };
}

describe("Task draft concurrency", () => {
  it("returns to a clean draft after a field is changed and then restored", () => {
    const draft = createTaskDraft(task("A", 1));
    const changed = { ...draft, title: "B" };
    const restored = { ...changed, title: "A" };

    expect(taskDraftHasChanges(changed)).toBe(true);
    expect(taskDraftHasChanges(restored)).toBe(false);
  });

  it("keeps a sparse local edit bound to the Task snapshot and revision it came from", () => {
    const revision1 = task("A", 1, 3);
    const draft = { ...createTaskDraft(revision1), description: "Local description" };

    expect(prepareTaskDraftUpdate(draft, revision1)).toEqual({
      ok: true,
      patch: {
        expectedRevision: 1,
        expectedExecutionRevision: 3,
        description: "Local description"
      }
    });
  });

  it("blocks a revision 1 draft after the server changes the title at revision 2", () => {
    const revision1 = task("A", 1, 3);
    const draft = { ...createTaskDraft(revision1), description: "Local description" };
    const revision2 = { ...task("B", 2, 3), description: revision1.description };

    expect(prepareTaskDraftUpdate(draft, revision2)).toEqual({
      ok: false,
      reason: "stale",
      message: "任務已更新，這份草稿仍保留。請先合併最新內容再重試。"
    });
  });

  it("rebases a local-only edit over remote-only fields and submits current revisions", () => {
    const revision1 = task("A", 1, 3);
    const draft = { ...createTaskDraft(revision1), description: "Local description" };
    const revision2 = {
      ...task("A", 2, 7),
      description: revision1.description,
      acceptanceCriteria: "Remote acceptance criteria",
      dataScope: "Remote data scope"
    };

    const rebased = rebaseTaskDraft(draft, revision2);

    expect(rebased.ok).toBe(true);
    if (!rebased.ok) return;
    expect(rebased.rebased).toBe(true);
    expect(rebased.draft).toMatchObject({
      taskId: revision2.id,
      baseRevision: 2,
      baseExecutionRevision: 7,
      description: "Local description",
      acceptanceCriteria: "Remote acceptance criteria",
      dataScope: "Remote data scope"
    });
    expect(rebased.draft.baseSnapshot).toMatchObject({
      description: revision2.description,
      acceptanceCriteria: "Remote acceptance criteria",
      dataScope: "Remote data scope"
    });
    expect(prepareTaskDraftUpdate(rebased.draft, revision2)).toEqual({
      ok: true,
      patch: {
        expectedRevision: 2,
        expectedExecutionRevision: 7,
        description: "Local description"
      }
    });
  });

  it("refuses a three-way rebase when local and remote edit the same field differently", () => {
    const revision1 = task("A", 1, 3);
    const draft = { ...createTaskDraft(revision1), title: "Local title" };
    const revision2 = task("Remote title", 2, 4);

    expect(rebaseTaskDraft(draft, revision2)).toEqual({
      ok: false,
      reason: "conflict",
      conflictingFields: ["title"],
      message: taskDraftConflictMessage
    });
  });

  it("treats execution profile and assignee changes as one conflict boundary", () => {
    const revision1 = task("A", 1, 3);
    const draft = { ...createTaskDraft(revision1), assignee: "Local owner" };
    const revision2 = {
      ...task("A", 2, 4),
      assignee: "Remote Agent",
      assigneeAgentId: "agent-2"
    };

    const rebased = rebaseTaskDraft(draft, revision2);

    expect(rebased.ok).toBe(false);
    if (rebased.ok) return;
    expect(rebased.reason).toBe("conflict");
    expect(rebased.conflictingFields).toEqual(expect.arrayContaining(["assignee", "assigneeAgentId"]));
  });

  it("does not allow external sync while the visible Task draft is unsaved", () => {
    const current = task("A", 1);

    expect(canSubmitTaskSync(current, true, false)).toBe(true);
    expect(canSubmitTaskSync(current, true, true)).toBe(false);
    expect(canSubmitTaskSync(current, false, false)).toBe(false);
    expect(canSubmitTaskSync({
      ...current,
      sync: { ...current.sync, status: "queued" }
    }, true, false)).toBe(false);
    expect(canSubmitTaskSync({
      ...current,
      execution: { ...current.execution, status: "running" }
    }, true, false)).toBe(false);
  });
});
