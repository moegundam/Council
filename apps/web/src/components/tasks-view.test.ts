import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./tasks-view.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

describe("Task detail dirty-close guard", () => {
  it("treats unsaved evidence input as dirty when deciding whether to confirm detail close", () => {
    expect(source).toContain("function taskEvidenceDraftHasChanges(draft: TaskEvidenceDraft): boolean {");
    expect(source).toContain("const evidenceDraftDirty = taskEvidenceDraftHasChanges(evidenceDraft);");
    expect(source).toContain("const taskDetailDirty = draftDirty || evidenceDraftDirty;");
    expect(source).toContain("if (taskDetailDirty) {");
  });

  it("keeps the discard screen triggered by the same detail close path", () => {
    expect(source).toContain("onClose={requestCloseDetail}");
    expect(source).toContain("setDiscardRequested(true);");
    expect(source).toContain("繼續編輯");
    expect(source).toContain("捨棄變更");
  });

  it("binds Adapter synchronization to the exact Task payload state", () => {
    expect(source).toContain("expectedRevision: task.revision");
    expect(source).toContain("expectedStatus: task.status");
    expect(source).toContain("expectedApprovalState: task.approvalState");
    expect(source).toContain("expectedSyncAttemptCount: task.sync.attemptCount");
  });

  it("reuses one Task Evidence key until the committed result is confirmed", () => {
    const submitSource = source.slice(
      source.indexOf("  async function submitEvidence("),
      source.indexOf("  async function syncTask(")
    );

    expect(source).toContain("const evidenceRetryOwnershipRef = useRef(new TaskEvidenceRetryOwnership());");
    expect(submitSource).toContain("const requestPayload = { type, label, reference };");
    expect(submitSource).toContain("const retryToken = evidenceRetryOwnershipRef.current.acquire(");
    expect(submitSource).toContain("task.id,");
    expect(submitSource).toContain('"Idempotency-Key": retryToken.idempotencyKey');
    expect(submitSource).toContain("cause instanceof CommittedMutationProjectionError");
    expect(submitSource).toContain("cause instanceof ApiError && cause.status < 500");
    expect(submitSource).toContain("evidenceRetryOwnershipRef.current.clear(retryToken)");
  });

  it("keeps Task Agent run ownership in task and execution-revision slots", () => {
    const runSource = source.slice(
      source.indexOf("  async function submitTaskExecutionCommand("),
      source.indexOf("  async function submitEvidence(")
    );

    const normalizedRunSource = runSource.replace(/\s+/g, " ");
    expect(source).toContain("new TaskAgentRunRetryOwnership()");
    expect(runSource).toContain("taskAgentRunRetryOwnershipRef.current.acquire(");
    expect(normalizedRunSource).toContain("task.id, executionRevision");
    expect(runSource).toContain("retry.idempotencyKey");
    expect(runSource).toContain("taskAgentRunRetryOwnershipRef.current.clear(retry)");
    expect(runSource).toContain("cause instanceof CommittedMutationProjectionError");
    expect(runSource).toContain("cause instanceof ApiError && cause.status < 500");
  });

  it("acknowledges a committed Task sync when only the projection refresh fails", () => {
    const syncSource = source.slice(
      source.indexOf("  async function syncTask("),
      source.indexOf("  const canSync =")
    );
    const committedBranch = syncSource.slice(
      syncSource.indexOf("if (cause instanceof CommittedMutationProjectionError)"),
      syncSource.indexOf("if (cause instanceof ApiError && cause.status === 409")
    );

    expect(syncSource).toContain("cause instanceof CommittedMutationProjectionError");
    expect(committedBranch).toContain('setSelectedAdapterId("");');
    expect(committedBranch).toContain("同步已提交，但最新狀態刷新失敗；請重新整理以確認排程進度。");
    expect(syncSource.indexOf("cause instanceof CommittedMutationProjectionError"))
      .toBeLessThan(syncSource.indexOf("cause instanceof ApiError && cause.status === 409"));
  });

  it("adopts a committed Task update when only the projection refresh fails", () => {
    const patchSource = source.slice(
      source.indexOf("  async function patchTask("),
      source.indexOf("  function mergeLatestTaskContent(")
    );

    expect(source).toContain("resolveCommittedMutation");
    expect(patchSource).toContain("const updateOutcome = await resolveCommittedMutation(() => mutate<Task>(");
    expect(patchSource).toContain("const updated = updateOutcome.result;");
    expect(patchSource).toContain("setDraft(createTaskDraft(updated));");
    expect(patchSource).toContain("setDraftDirty(false);");
    expect(patchSource).toContain("updateOutcome.projectionFresh");
    expect(patchSource).toContain("任務已更新，但最新資料刷新失敗；請重新整理以載入其他變更。");
  });

  it("makes retained stale Task data visible while background polling keeps retrying", () => {
    expect(source).toContain("platformProjectionStale");
    expect(source).toContain("taskProjectionStatusLabel");
    expect(source).toContain("重新整理任務資料");
    expect(source).toContain("startTaskPollingLoop");
    expect(source).not.toContain("window.setInterval");
    expect(source).toContain("refresh: refreshRequired");
  });

  it("does not claim a conflict refresh succeeded when the required projection remains unavailable", () => {
    expect(source).toContain("setActionError(await refreshTaskBoardAfterConflict(refreshRequired));");
    expect(source).toContain("任務已由其他操作更新，但最新內容載入失敗；目前畫面可能過期。");
  });

  it("lets opening a Task own the visible status over an older move response", () => {
    const openDetail = source.slice(
      source.indexOf("  function openDetail("),
      source.indexOf("  function closeDetail(")
    );

    expect(openDetail).toContain("taskMoveSelectionOwnershipRef.current.claimUserSelection();");
    expect(openDetail.indexOf("taskMoveSelectionOwnershipRef.current.claimUserSelection();"))
      .toBeLessThan(openDetail.indexOf("setActiveStatus(task.status);"));
  });

  it("clears dirty state when a Task field is changed back to its baseline", () => {
    const updateDraft = source.slice(
      source.indexOf("  function updateDraft("),
      source.indexOf("  function selectStatus(")
    );

    expect(updateDraft).toContain("const nextDraft = { ...draft, ...changes };");
    expect(updateDraft).toContain("setDraftDirty(taskDraftHasChanges(nextDraft));");
    expect(updateDraft).not.toContain("setDraftDirty(true)");
  });

  it("keeps long modal titles from colliding with the close control on narrow screens", () => {
    expect(styles).toMatch(/\.modal > header\s*\{[^}]*min-height:\s*52px;[^}]*gap:/s);
    expect(styles).toMatch(/\.modal > header h2\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/s);
    expect(styles).toMatch(/\.modal > header \.icon-button\s*\{[^}]*flex:\s*0 0 auto;/s);
  });
});
