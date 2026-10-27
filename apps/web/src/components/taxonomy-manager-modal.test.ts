import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./taxonomy-manager-modal.tsx", import.meta.url), "utf8");

function sourceBetween(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("TaxonomyManagerModal wiring", () => {
  it("makes the dialog and complete form inert while a mutation is pending", () => {
    expect(source).toContain('const conflictLoading = conflictRecovery !== null && !conflictRefreshFailed;');
    expect(source).toContain('const interactionLocked = busy || conflictLoading;');
    expect(source).toContain('open={open} onClose={requestClose} closeDisabled={interactionLocked} busy={interactionLocked}');
    expect(source).toContain('onSubmit={submit} aria-busy={interactionLocked || undefined} inert={interactionLocked ? true : undefined}');
    expect(source).toContain('disabled={interactionLocked} onClick={() => changeMode(item)}');
    expect(source).toContain('disabled={interactionLocked} onClick={() => startEdit(');
  });

  it("routes close, mode, entity, and cancel-edit transitions through one dirty-draft confirmation", () => {
    const transitionSource = sourceBetween("  function requestDraftTransition(", "  function requestClose(");
    const closeSource = sourceBetween("  function requestClose(", "  function changeMode(");
    const modeSource = sourceBetween("  function changeMode(", "  function startEdit(");
    const editSource = sourceBetween("  function startEdit(", "  function cancelEdit(");
    const cancelEditSource = sourceBetween("  function cancelEdit(", "  function applySavedMutation(");

    expect(transitionSource).toContain("if (busyRef.current || conflictLoading) return;");
    expect(transitionSource).toContain("taxonomyDraftHasChanges(");
    expect(transitionSource).toContain("window.confirm(");
    expect(closeSource).toContain("requestDraftTransition(");
    expect(modeSource).toContain("requestDraftTransition(");
    expect(editSource).toContain("requestDraftTransition(");
    expect(cancelEditSource).toContain("requestDraftTransition(");
    expect(source).toContain("onClose={requestClose}");
    expect(source).toContain("disabled={interactionLocked} onClick={requestClose}>取消</button>");
    expect(source).toContain("disabled={interactionLocked} onClick={cancelEdit}");
  });

  it("retains create retry ownership only for ambiguous failures", () => {
    const submitSource = sourceBetween("  async function submit(", "  const editingCurrentMode");

    expect(source).toContain("idempotencyRetryToken");
    expect(source).toContain("taxonomyCreateRequestSignature");
    expect(source).toContain("const createRetryRef = useRef<");
    expect(submitSource).toContain("const retryToken = currentEditing");
    expect(submitSource).toContain('"Idempotency-Key": retryToken.idempotencyKey');
    expect(submitSource).toContain("if (!currentEditing) createRetryRef.current = null;");
    expect(submitSource).toContain("cause instanceof ApiError && cause.status < 500");
    expect(submitSource).not.toContain("cause instanceof ApiError && cause.status >= 500");
  });

  it("uses a committed Group result in the same Category transition as a normal success", () => {
    const applySavedSource = sourceBetween("  function applySavedMutation(", "  async function submit(");
    const submitSource = sourceBetween("  async function submit(", "  const editingCurrentMode");

    expect(applySavedSource).toContain('const wasCreatingGroup = !currentEditing && submittedMode === "group";');
    expect(applySavedSource).toContain('resetDraft("category", saved.id);');
    expect(applySavedSource).toContain("setCommittedGroupFallback(projectionRefreshFailed ? saved : null);");
    expect(applySavedSource).toContain("最新列表刷新失敗");
    expect(applySavedSource).toContain("請重新整理");
    expect(source).toContain("categoryGroups.map((group)");
    expect(submitSource).toContain("applySavedMutation(saved, submittedMode, currentEditing);");
    expect(submitSource).toContain("cause instanceof CommittedMutationProjectionError");
    expect(submitSource).toContain("applySavedMutation(cause.result as SavedTaxonomyEntity, submittedMode, currentEditing, true);");
  });

  it("binds edits to their revision and preserves the draft while refreshing after a conflict", () => {
    const submitSource = sourceBetween("  async function submit(", "  const editingCurrentMode");

    expect(source).toContain('revision: number');
    expect(source).toContain('import { ApiError, isRevisionConflictError } from "../lib/api";');
    expect(submitSource).toContain('...(currentEditing ? { expectedRevision: currentEditing.revision } : {})');
    expect(submitSource).toContain('if (isRevisionConflictError(cause) && currentEditing)');
    expect(submitSource).toContain('setConflictRecovery({');
    expect(submitSource).toContain('await refreshRequired()');
    expect(submitSource).toContain('草稿已保留');
    expect(submitSource).not.toContain('resetDraft(submittedMode)');
    expect(source).toContain('const latest = currentTaxonomyEntity(snapshot, conflictRecovery);');
    expect(source).toContain('setEditing(latest);');
    expect(source).toContain('最新版本已載入');
    expect(source).toContain('mergeTaxonomyConflictDraft(');
    expect(source).toContain('未修改欄位已套用最新版本');
    expect(source).toContain('conflictRefreshFailed');
    expect(source).toContain('retryConflictRefresh');
    expect(source).toContain('重新載入最新版');
  });
});
