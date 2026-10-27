"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Pencil, X } from "lucide-react";
import type { Category, DiscussionGroup, PublicPlatformSnapshot as PlatformSnapshot, Tag } from "@council/contracts";
import { CommittedMutationProjectionError, usePlatform } from "../app/providers";
import { ApiError, isRevisionConflictError } from "../lib/api";
import {
  emptyTaxonomyDraft,
  mergeTaxonomyConflictDraft,
  taxonomyCreateRequestSignature,
  taxonomyDraftHasChanges,
  type TaxonomyDraft,
  type TaxonomyMode
} from "../lib/taxonomy-manager-ui";
import { idempotencyRetryToken } from "../lib/view-model";
import { Modal } from "./ui";

const modeLabels = { group: "群組", category: "分類", tag: "標籤" } as const;
const tagColorOptions: Array<{ value: Tag["color"]; label: string }> = [
  { value: "green", label: "綠" },
  { value: "blue", label: "藍" },
  { value: "amber", label: "琥珀" },
  { value: "red", label: "紅" },
  { value: "gray", label: "灰" }
];

type EditingEntity =
  | { mode: "group"; id: string; revision: number; name: string }
  | { mode: "category"; id: string; revision: number; groupId: string; name: string }
  | { mode: "tag"; id: string; revision: number; name: string; color: Tag["color"] };
type SavedTaxonomyEntity = { id: string; revision: number; name: string };
type ConflictRecovery = {
  mode: TaxonomyMode;
  id: string;
  previousRevision: number;
  baseline: TaxonomyDraft;
  draft: TaxonomyDraft;
};

function currentTaxonomyEntity(
  snapshot: Pick<PlatformSnapshot, "groups" | "categories" | "tags"> | null,
  recovery: ConflictRecovery
): EditingEntity | null {
  if (!snapshot) return null;
  if (recovery.mode === "group") {
    const group = snapshot.groups.find((item) => item.id === recovery.id);
    return group ? { mode: "group", ...group } : null;
  }
  if (recovery.mode === "category") {
    const category = snapshot.categories.find((item) => item.id === recovery.id);
    return category ? { mode: "category", ...category } : null;
  }
  const tag = snapshot.tags.find((item) => item.id === recovery.id);
  return tag ? { mode: "tag", ...tag } : null;
}

interface TaxonomyManagerModalProps {
  open: boolean;
  onClose(): void;
}

export function TaxonomyManagerModal({ open, onClose }: TaxonomyManagerModalProps) {
  const { snapshot, mutate, refreshRequired } = usePlatform();
  const [mode, setMode] = useState<TaxonomyMode>("group");
  const [editing, setEditing] = useState<EditingEntity | null>(null);
  const [name, setName] = useState("");
  const [groupId, setGroupId] = useState("");
  const [color, setColor] = useState<Tag["color"]>("green");
  const [draftBaseline, setDraftBaseline] = useState<TaxonomyDraft>(() => emptyTaxonomyDraft());
  const [committedGroupFallback, setCommittedGroupFallback] = useState<DiscussionGroup | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [conflictRecovery, setConflictRecovery] = useState<ConflictRecovery | null>(null);
  const [conflictRefreshFailed, setConflictRefreshFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const createRetryRef = useRef<{ signature: string; idempotencyKey: string } | null>(null);
  const draft: TaxonomyDraft = { name, groupId, color };
  const conflictLoading = conflictRecovery !== null && !conflictRefreshFailed;
  const interactionLocked = busy || conflictLoading;

  useEffect(() => {
    if (!open) resetDraft();
  }, [open]);

  useEffect(() => {
    if (committedGroupFallback && snapshot?.groups.some((group) => group.id === committedGroupFallback.id)) {
      setCommittedGroupFallback(null);
    }
  }, [committedGroupFallback, snapshot]);

  useEffect(() => {
    if (!open) return;
    const groupIdIsValid = snapshot?.groups.some((group) => group.id === groupId)
      || committedGroupFallback?.id === groupId;
    const nextGroupId = snapshot?.groups[0]?.id ?? committedGroupFallback?.id;
    if (groupIdIsValid || !nextGroupId) return;
    setGroupId(nextGroupId);
    if (mode === "category" && !editing) {
      setDraftBaseline((current) => ({ ...current, groupId: nextGroupId }));
    }
  }, [committedGroupFallback, editing, groupId, mode, open, snapshot]);

  useEffect(() => {
    if (!open || !conflictRecovery) return;
    const latest = currentTaxonomyEntity(snapshot, conflictRecovery);
    if (!latest || latest.revision <= conflictRecovery.previousRevision) return;

    const latestDraft: TaxonomyDraft = {
      name: latest.name,
      groupId: latest.mode === "category" ? latest.groupId : "",
      color: latest.mode === "tag" ? latest.color : "green"
    };
    const merged = mergeTaxonomyConflictDraft(
      conflictRecovery.mode,
      conflictRecovery.baseline,
      conflictRecovery.draft,
      latestDraft
    );

    setEditing(latest);
    setName(merged.draft.name);
    setGroupId(merged.draft.groupId);
    setColor(merged.draft.color);
    setDraftBaseline(latestDraft);
    setConflictRecovery(null);
    setConflictRefreshFailed(false);
    setError(merged.conflictingFields.length > 0
      ? `${modeLabels[conflictRecovery.mode]}已由其他操作更新。草稿已保留，最新版本已載入；相同欄位也有遠端變更，請比較列表後再次儲存。`
      : `${modeLabels[conflictRecovery.mode]}已由其他操作更新。草稿已保留，未修改欄位已套用最新版本；請確認後再次儲存。`);
  }, [conflictRecovery, open, snapshot]);

  if (!snapshot) return null;

  const categoryGroups = committedGroupFallback
    && !snapshot.groups.some((group) => group.id === committedGroupFallback.id)
    ? [...snapshot.groups, committedGroupFallback]
    : snapshot.groups;

  function resetDraft(nextMode: TaxonomyMode = mode, nextGroupId = groupId) {
    const nextDraft = emptyTaxonomyDraft(nextGroupId);
    setMode(nextMode);
    setEditing(null);
    setName(nextDraft.name);
    setGroupId(nextDraft.groupId);
    setColor(nextDraft.color);
    setDraftBaseline(nextDraft);
    setConflictRecovery(null);
    setConflictRefreshFailed(false);
    setError("");
    setNotice("");
  }

  function requestDraftTransition(transition: () => void) {
    if (busyRef.current || conflictLoading) return;
    if (taxonomyDraftHasChanges(mode, draftBaseline, draft)
      && !window.confirm("目前草稿尚未儲存，確定捨棄？")) return;
    transition();
  }

  function requestClose() {
    requestDraftTransition(() => {
      resetDraft();
      onClose();
    });
  }

  function changeMode(nextMode: TaxonomyMode) {
    if (nextMode === mode) return;
    requestDraftTransition(() => resetDraft(nextMode));
  }

  function startEdit(entity: EditingEntity) {
    if (editing?.mode === entity.mode && editing.id === entity.id) return;
    requestDraftTransition(() => {
      const nextDraft: TaxonomyDraft = {
        name: entity.name,
        groupId: entity.mode === "category" ? entity.groupId : groupId,
        color: entity.mode === "tag" ? entity.color : "green"
      };
      setMode(entity.mode);
      setEditing(entity);
      setName(nextDraft.name);
      setGroupId(nextDraft.groupId);
      setColor(nextDraft.color);
      setDraftBaseline(nextDraft);
      setConflictRecovery(null);
      setConflictRefreshFailed(false);
      setError("");
      setNotice("");
    });
  }

  function cancelEdit() {
    requestDraftTransition(() => resetDraft());
  }

  function applySavedMutation(
    saved: SavedTaxonomyEntity,
    submittedMode: TaxonomyMode,
    currentEditing: EditingEntity | null,
    projectionRefreshFailed = false
  ) {
    const wasCreatingGroup = !currentEditing && submittedMode === "group";
    if (wasCreatingGroup) {
      setCommittedGroupFallback(projectionRefreshFailed ? saved : null);
      resetDraft("category", saved.id);
      setNotice(projectionRefreshFailed
        ? `群組「${saved.name}」已新增，但最新列表刷新失敗；已選取該群組，可接著建立分類。請重新整理以載入最新資料。`
        : `群組「${saved.name}」已新增，可接著建立分類。`);
      return;
    }

    resetDraft(submittedMode);
    const action = currentEditing ? "更新" : "新增";
    setNotice(projectionRefreshFailed
      ? `${modeLabels[submittedMode]}「${saved.name}」已${action}，但最新列表刷新失敗；請重新整理以載入最新資料。`
      : `${modeLabels[submittedMode]}「${saved.name}」已${action}。`);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current || conflictRecovery) return;
    const submittedMode = mode;
    const currentEditing = editing?.mode === submittedMode ? editing : null;
    const endpointBase = submittedMode === "group" ? "/api/groups" : submittedMode === "category" ? "/api/categories" : "/api/tags";
    const endpoint = currentEditing ? `${endpointBase}/${currentEditing.id}` : endpointBase;
    const entityPayload = submittedMode === "group"
      ? { name }
      : submittedMode === "category"
        ? { groupId, name }
        : { name, color };
    const payload = {
      ...entityPayload,
      ...(currentEditing ? { expectedRevision: currentEditing.revision } : {})
    };
    const retryToken = currentEditing
      ? null
      : idempotencyRetryToken(
          createRetryRef.current,
          taxonomyCreateRequestSignature(submittedMode, draft),
          () => crypto.randomUUID()
        );
    if (retryToken) createRetryRef.current = retryToken;

    setError("");
    setNotice("");
    busyRef.current = true;
    setBusy(true);
    try {
      const saved = await mutate<SavedTaxonomyEntity>(endpoint, {
        method: currentEditing ? "PATCH" : "POST",
        ...(retryToken ? { headers: { "Idempotency-Key": retryToken.idempotencyKey } } : {}),
        body: JSON.stringify(payload)
      });
      if (!currentEditing) createRetryRef.current = null;
      applySavedMutation(saved, submittedMode, currentEditing);
    } catch (cause) {
      if (cause instanceof CommittedMutationProjectionError) {
        if (!currentEditing) createRetryRef.current = null;
        applySavedMutation(cause.result as SavedTaxonomyEntity, submittedMode, currentEditing, true);
      } else if (isRevisionConflictError(cause) && currentEditing) {
        setConflictRecovery({
          mode: currentEditing.mode,
          id: currentEditing.id,
          previousRevision: currentEditing.revision,
          baseline: draftBaseline,
          draft
        });
        setConflictRefreshFailed(false);
        setError(`${modeLabels[submittedMode]}已由其他操作更新。草稿已保留，正在重新載入最新版本。`);
        try {
          await refreshRequired();
        } catch {
          setConflictRefreshFailed(true);
          setError(`${modeLabels[submittedMode]}已由其他操作更新。草稿已保留，但最新列表也無法刷新；請重新整理後再確認。`);
        }
      } else {
        if (!currentEditing && cause instanceof ApiError && cause.status < 500) createRetryRef.current = null;
        setError(cause instanceof Error ? cause.message : `無法${currentEditing ? "更新" : "新增"}${modeLabels[submittedMode]}。`);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function retryConflictRefresh() {
    if (!conflictRecovery || busyRef.current) return;
    setConflictRefreshFailed(false);
    setError(`${modeLabels[conflictRecovery.mode]}草稿已保留，正在重新載入最新版本。`);
    busyRef.current = true;
    setBusy(true);
    try {
      await refreshRequired();
    } catch {
      setConflictRefreshFailed(true);
      setError(`${modeLabels[conflictRecovery.mode]}草稿已保留，但最新列表仍無法刷新；請稍後再試。`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const editingCurrentMode = editing?.mode === mode;
  const submitLabel = interactionLocked
    ? `${editingCurrentMode ? "更新" : "新增"}${modeLabels[mode]}中`
    : `${editingCurrentMode ? "更新" : "新增"}${modeLabels[mode]}`;

  return <Modal title="整理討論分類" open={open} onClose={requestClose} closeDisabled={interactionLocked} busy={interactionLocked}>
    <div className="taxonomy-mode-selector segmented" role="group" aria-label="分類資料類型">
      {(Object.keys(modeLabels) as TaxonomyMode[]).map((item) => <button key={item} type="button" className={mode === item ? "active" : ""} aria-pressed={mode === item} disabled={interactionLocked} onClick={() => changeMode(item)}>{modeLabels[item]}</button>)}
    </div>
    {notice && <div className="taxonomy-modal-notice" role="status">{notice}</div>}
    <section className="taxonomy-entity-section" aria-labelledby={`${mode}-list-heading`}>
      <div className="taxonomy-list-heading">
        <h3 id={`${mode}-list-heading`}>現有{modeLabels[mode]}</h3>
        <span>{mode === "group" ? snapshot.groups.length : mode === "category" ? snapshot.categories.length : snapshot.tags.length}</span>
      </div>
      <div className="taxonomy-entity-list" role="list">
        {mode === "group" && snapshot.groups.map((group: DiscussionGroup) => <div className="taxonomy-entity-row" role="listitem" key={group.id}>
          <div className="taxonomy-entity-copy"><strong>{group.name}</strong></div>
          <button type="button" className="icon-button taxonomy-edit-button" title={`編輯群組「${group.name}」`} aria-label={`編輯群組「${group.name}」`} disabled={interactionLocked} onClick={() => startEdit({ mode: "group", ...group })}><Pencil size={15} aria-hidden="true" /></button>
        </div>)}
        {mode === "category" && snapshot.categories.map((category: Category) => {
          const group = categoryGroups.find((item) => item.id === category.groupId);
          return <div className="taxonomy-entity-row" role="listitem" key={category.id}>
            <div className="taxonomy-entity-copy"><strong>{category.name}</strong><small>{group?.name ?? "未指定群組"}</small></div>
            <button type="button" className="icon-button taxonomy-edit-button" title={`編輯分類「${category.name}」`} aria-label={`編輯分類「${category.name}」`} disabled={interactionLocked} onClick={() => startEdit({ mode: "category", ...category })}><Pencil size={15} aria-hidden="true" /></button>
          </div>;
        })}
        {mode === "tag" && snapshot.tags.map((tag) => <div className="taxonomy-entity-row" role="listitem" key={tag.id}>
          <div className="taxonomy-entity-copy taxonomy-tag-copy"><span className={`tag-dot ${tag.color}`} aria-hidden="true" /><strong>{tag.name}</strong><small>{tagColorOptions.find((option) => option.value === tag.color)?.label}</small></div>
          <button type="button" className="icon-button taxonomy-edit-button" title={`編輯標籤「${tag.name}」`} aria-label={`編輯標籤「${tag.name}」`} disabled={interactionLocked} onClick={() => startEdit({ mode: "tag", ...tag })}><Pencil size={15} aria-hidden="true" /></button>
        </div>)}
        {mode === "group" && snapshot.groups.length === 0 && <div className="taxonomy-entity-empty">尚未建立群組。</div>}
        {mode === "category" && snapshot.categories.length === 0 && <div className="taxonomy-entity-empty">尚未建立分類。</div>}
        {mode === "tag" && snapshot.tags.length === 0 && <div className="taxonomy-entity-empty">尚未建立標籤。</div>}
      </div>
    </section>
    <form className="form-stack taxonomy-editor" onSubmit={submit} aria-busy={interactionLocked || undefined} inert={interactionLocked ? true : undefined}>
      <div className="taxonomy-editor-heading">
        <h3>{editingCurrentMode ? `編輯${modeLabels[mode]}` : `新增${modeLabels[mode]}`}</h3>
        {editingCurrentMode && <button type="button" className="secondary-button small" title="取消編輯並清除草稿" aria-label="取消編輯並清除草稿" disabled={interactionLocked} onClick={cancelEdit}><X size={14} aria-hidden="true" />取消編輯</button>}
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
      {conflictRecovery && conflictRefreshFailed && <button type="button" className="secondary-button small" onClick={() => void retryConflictRefresh()}>重新載入最新版</button>}
      {mode === "group" && <label>群組名稱<input name="name" value={name} onChange={(event) => setName(event.currentTarget.value)} required maxLength={100} autoComplete="off" /></label>}
      {mode === "category" && <>
        {categoryGroups.length === 0 && <div className="form-error">請先建立至少一個群組。</div>}
        <label>所屬群組<select name="groupId" value={groupId} onChange={(event) => setGroupId(event.currentTarget.value)} required>{categoryGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
        <label>分類名稱<input name="name" value={name} onChange={(event) => setName(event.currentTarget.value)} required maxLength={100} autoComplete="off" /></label>
      </>}
      {mode === "tag" && <>
        <label>標籤名稱<input name="name" value={name} onChange={(event) => setName(event.currentTarget.value)} required maxLength={100} autoComplete="off" /></label>
        <fieldset><legend>標籤顏色</legend><div className="color-swatch-options">{tagColorOptions.map((option) => <label key={option.value} title={`選擇${option.label}色`}><input className="sr-only" type="radio" name="color" value={option.value} checked={color === option.value} onChange={() => setColor(option.value)} /><span className={`color-swatch ${option.value}`} aria-hidden="true" /><span>{option.label}</span></label>)}</div></fieldset>
      </>}
      <div className="form-actions"><button type="button" className="secondary-button" disabled={interactionLocked} onClick={requestClose}>取消</button><button className="primary-button" disabled={interactionLocked || conflictRecovery !== null || (mode === "category" && categoryGroups.length === 0)}>{submitLabel}</button></div>
    </form>
  </Modal>;
}
