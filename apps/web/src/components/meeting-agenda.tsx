"use client";

import {
  Check,
  ChevronDown,
  ChevronUp,
  Eye,
  ListPlus,
  LockKeyhole,
  Play,
  SkipForward,
  Trash2
} from "lucide-react";
import type { AgendaItem, Meeting } from "@council/contracts";
import {
  agendaPrimaryCommand,
  agendaProgress,
  canEditAgendaItem,
  canRemoveAgendaItem,
  canSubmitAgendaDraft,
  moveAgendaDraftItem,
  type AgendaDraftItem,
  type AgendaPrimaryCommand
} from "../lib/agenda-ui";

const agendaStatusLabels: Record<AgendaItem["status"], string> = {
  pending: "待開始",
  current: "目前",
  completed: "已完成",
  skipped: "已略過"
};

function draftKey(item: AgendaDraftItem, index: number): string {
  return item.id ?? `draft-${index}`;
}

function updateDraftAt(items: readonly AgendaDraftItem[], index: number, patch: Partial<Pick<AgendaDraftItem, "title" | "description">>): AgendaDraftItem[] {
  return items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : { ...item });
}

export function AgendaDraftEditor({
  items,
  onChange,
  disabled = false,
  showHeading = true
}: {
  items: readonly AgendaDraftItem[];
  onChange(items: AgendaDraftItem[]): void;
  disabled?: boolean;
  showHeading?: boolean;
}) {
  function addItem() {
    if (disabled || items.length >= 12) return;
    onChange([...items.map((item) => ({ ...item })), { title: "", description: "" }]);
  }

  function removeItem(index: number) {
    if (disabled || items.length <= 1) return;
    onChange(items.filter((_, itemIndex) => itemIndex !== index).map((item) => ({ ...item })));
  }

  function moveItem(index: number, delta: -1 | 1) {
    if (disabled) return;
    onChange(moveAgendaDraftItem(items, index, delta));
  }

  return <section className="agenda-editor" aria-label="建立議程">
    {showHeading && <div className="agenda-editor-heading"><div><strong>議程</strong></div><span className="agenda-count">{items.length}/12</span></div>}
    <ol className="agenda-draft-list">
      {items.map((item, index) => <li className="agenda-draft-row" key={draftKey(item, index)}>
        <span className="agenda-position" aria-hidden="true">{index + 1}</span>
        <div className="agenda-draft-fields">
          <label>標題<input value={item.title} onChange={(event) => onChange(updateDraftAt(items, index, { title: event.currentTarget.value }))} disabled={disabled} required maxLength={160} /></label>
          <label>說明 <span className="optional-label">選填</span><textarea value={item.description} onChange={(event) => onChange(updateDraftAt(items, index, { description: event.currentTarget.value }))} disabled={disabled} maxLength={1000} rows={2} /></label>
        </div>
        <div className="agenda-row-actions">
          <button type="button" className="icon-button" onClick={() => moveItem(index, -1)} disabled={disabled || index === 0} aria-label={`第 ${index + 1} 項上移`} title="上移"><ChevronUp size={16} /></button>
          <button type="button" className="icon-button" onClick={() => moveItem(index, 1)} disabled={disabled || index === items.length - 1} aria-label={`第 ${index + 1} 項下移`} title="下移"><ChevronDown size={16} /></button>
          <button type="button" className="icon-button danger-command" onClick={() => removeItem(index)} disabled={disabled || items.length <= 1} aria-label={`刪除第 ${index + 1} 項`} title="刪除"><Trash2 size={16} /></button>
        </div>
      </li>)}
    </ol>
    <button type="button" className="secondary-button agenda-add-button" onClick={addItem} disabled={disabled || items.length >= 12}><ListPlus size={15} />新增議程</button>
  </section>;
}

export function MeetingAgendaBand({
  meeting,
  busy,
  onOpen,
  onAdvance
}: {
  meeting: Meeting;
  busy: boolean;
  onOpen(): void;
  onAdvance(command: AgendaPrimaryCommand): void;
}) {
  const progress = agendaProgress(meeting.agenda);
  const command = agendaPrimaryCommand(meeting);
  const isResolved = progress.total > 0 && progress.resolved === progress.total;
  return <section className="agenda-band" aria-label="會議議程">
    <div className="agenda-band-copy">
      <span className="agenda-band-label">議程</span>
      <strong>{progress.current?.title ?? (isResolved ? "議程已完成" : progress.pending > 0 ? "尚未開始議程" : "尚無可用議程")}</strong>
      <span className="agenda-progress-text">{progress.resolved} / {progress.total} 已完成或略過</span>
    </div>
    {progress.total > 0 && <div className="agenda-band-progress" role="progressbar" aria-label="議程進度" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.resolved} aria-valuetext={`${progress.resolved} / ${progress.total} 已完成或略過`}>
      <span style={{ width: `${progress.total ? (progress.resolved / progress.total) * 100 : 0}%` }} />
    </div>}
    <div className="agenda-band-actions">
      <button type="button" className="secondary-button small" onClick={onOpen}><Eye size={14} />查看議程</button>
      {command?.action === "complete" && <button type="button" className="primary-button small" disabled={busy} onClick={() => onAdvance(command)}><Check size={14} />完成並下一項</button>}
      {command?.action === "activate" && <button type="button" className="primary-button small" disabled={busy} onClick={() => onAdvance(command)}><Play size={14} />開始議程</button>}
    </div>
  </section>;
}

export function MeetingAgendaModalContent({
  meeting,
  items,
  busy,
  recoveryRequired = false,
  error,
  onChange,
  onSave,
  onSkip
}: {
  meeting: Meeting;
  items: readonly AgendaDraftItem[];
  busy: boolean;
  recoveryRequired?: boolean;
  error: string;
  onChange(items: AgendaDraftItem[]): void;
  onSave(): void;
  onSkip(itemId: string): void;
}) {
  const canEdit = meeting.state !== "closed";
  const agendaItemById = new Map(meeting.agenda.items.map((item) => [item.id, item]));
  const draftHasValidItems = canSubmitAgendaDraft(items);
  const isEditableAt = (index: number): boolean => {
    const candidate = items[index];
    if (!candidate) return false;
    const record = candidate.id ? agendaItemById.get(candidate.id) : undefined;
    return record ? canEditAgendaItem(meeting, record) : canEditAgendaItem(meeting, { status: "pending" });
  };
  return <div className="agenda-modal-content">
    {error && <div className="form-error" role="alert">{error}</div>}
    <div className="agenda-modal-summary"><span>{agendaProgress(meeting.agenda).resolved} / {meeting.agenda.items.length} 已完成或略過</span><span>版本 {meeting.agenda.revision}</span></div>
    <ol className="agenda-modal-list">
      {items.map((draft, index) => {
        const source: AgendaItem = agendaItemById.get(draft.id ?? "") ?? {
          id: draft.id ?? draftKey(draft, index),
          title: draft.title,
          description: draft.description,
          position: index,
          status: "pending",
          createdAt: "",
          updatedAt: "",
          startedAt: null,
          resolvedAt: null
        };
        const editable = canEditAgendaItem(meeting, source);
        const removable = canRemoveAgendaItem(meeting, source) && items.length > 1;
        const canMoveUp = editable && index > 0 && isEditableAt(index - 1);
        const canMoveDown = editable && index < items.length - 1 && isEditableAt(index + 1);
        return <li className={`agenda-modal-row ${source.status}`} key={draftKey(draft, index)} aria-current={source.status === "current" ? "step" : undefined}>
          <div className="agenda-modal-status"><span>{index + 1}</span><small>{agendaStatusLabels[source.status]}</small></div>
          {editable ? <div className="agenda-draft-fields"><label>標題<input value={draft.title} onChange={(event) => onChange(updateDraftAt(items, index, { title: event.currentTarget.value }))} disabled={busy} required maxLength={160} /></label><label>說明 <span className="optional-label">選填</span><textarea value={draft.description} onChange={(event) => onChange(updateDraftAt(items, index, { description: event.currentTarget.value }))} disabled={busy} maxLength={1000} rows={2} /></label></div> : <div className="agenda-locked-copy"><strong>{source.title}</strong>{source.description && <p>{source.description}</p>}<span><LockKeyhole size={12} />{agendaStatusLabels[source.status]}</span></div>}
          {editable && <div className="agenda-row-actions"><button type="button" className="icon-button" onClick={() => onChange(moveAgendaDraftItem(items, index, -1))} disabled={busy || recoveryRequired || !canMoveUp} aria-label={`${source.title} 上移`} title="上移"><ChevronUp size={16} /></button><button type="button" className="icon-button" onClick={() => onChange(moveAgendaDraftItem(items, index, 1))} disabled={busy || recoveryRequired || !canMoveDown} aria-label={`${source.title} 下移`} title="下移"><ChevronDown size={16} /></button><button type="button" className="icon-button danger-command" onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))} disabled={busy || recoveryRequired || !removable} aria-label={`${source.title} 刪除`} title="刪除"><Trash2 size={16} /></button></div>}
          {source.status === "current" && meeting.state === "active" && <button type="button" className="secondary-button small agenda-skip-button" disabled={busy || recoveryRequired} onClick={() => onSkip(source.id)}><SkipForward size={14} />略過並下一項</button>}
        </li>;
      })}
    </ol>
    {canEdit && <>
      <button type="button" className="secondary-button agenda-add-button" onClick={() => items.length < 12 && onChange([...items.map((item) => ({ ...item })), { title: "", description: "" }])} disabled={busy || recoveryRequired || items.length >= 12}><ListPlus size={15} />新增議程</button>
      <div className="form-actions agenda-modal-actions"><button type="button" className="primary-button" disabled={busy || recoveryRequired || !draftHasValidItems} onClick={onSave}>儲存議程</button></div>
    </>}
  </div>;
}
