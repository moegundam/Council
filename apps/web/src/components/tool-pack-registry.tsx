"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  History,
  Pencil,
  Plus,
  Braces,
  ShieldCheck,
  XCircle
} from "lucide-react";
import type { ToolPackRevision } from "@council/contracts";
import {
  availableToolPackCommands,
  formatToolPackUsage,
  maskToolPackDigest,
  redactToolPackSummary,
  toolPackLifecycleMessage,
  toolPackSourceName,
  toolPackStatusClass,
  toolPackStatusLabel,
  toolPackToolKindLabel,
  toolPackValidationClass,
  toolPackValidationLabel,
  type ToolPackRegistryItem,
  type ToolPackUsageSummary
} from "../lib/tool-pack-ui";

export interface ToolPackRegistryProps {
  packs: readonly ToolPackRegistryItem[];
  revisions: readonly ToolPackRevision[];
  selectedPackId: string | null;
  readUsage(packId: string): ToolPackUsageSummary;
  pending: boolean;
  onSelect(packId: string): void;
  onCreate(): void;
  onValidate(pack: ToolPackRegistryItem): void;
  onApprove(pack: ToolPackRegistryItem): void;
  onRevoke(pack: ToolPackRegistryItem): void;
  onEdit(pack: ToolPackRegistryItem): void;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "尚未";
  return new Intl.DateTimeFormat("zh-TW", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function lifecycleIcon(pack: ToolPackRegistryItem) {
  if (pack.status === "approved") return <CheckCircle2 size={14} />;
  if (pack.status === "revoked" || pack.validation.result === "failed") return <AlertTriangle size={14} />;
  return <ClipboardCheck size={14} />;
}

export function ToolPackRegistry({
  packs,
  revisions,
  selectedPackId,
  readUsage,
  pending,
  onSelect,
  onCreate,
  onValidate,
  onApprove,
  onRevoke,
  onEdit
}: ToolPackRegistryProps) {
  const selected = packs.find((pack) => pack.id === selectedPackId) ?? packs[0] ?? null;
  const selectedRevisions = selected
    ? revisions
      .filter((revision) => revision.packId === selected.id)
      .slice()
      .sort((left, right) => right.revision - left.revision)
    : [];
  const commands = selected ? availableToolPackCommands(selected) : [];

  return (
    <section className="agent-runtime-section" aria-label="Tool Pack 管理">
      <div className="agent-secondary-header">
        <div>
          <strong>Tool Packs</strong>
          <small>{packs.length} 個 Pack</small>
        </div>
        <button className="secondary-button small" type="button" disabled={pending} onClick={onCreate}>
          <Plus size={13} />新增
        </button>
      </div>
      <div className="agent-runtime-workbench">
        <aside className="agent-runtime-list" aria-label="Tool Pack 清單">
          {packs.length === 0
            ? <div className="empty-settings">尚無 Tool Pack</div>
            : <div className="settings-list">
              {packs
                .slice()
                .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name))
                .map((pack) => {
                  const usage = readUsage(pack.id);
                  return (
                    <button
                      type="button"
                      key={pack.id}
                      className={`runtime-profile-row ${pack.id === selected?.id ? "active" : ""}`}
                      aria-current={pack.id === selected?.id ? "true" : undefined}
                      onClick={() => onSelect(pack.id)}
                    >
                      <span className={`row-icon ${pack.status === "approved" ? "blue" : "muted"}`}>
                        <Braces size={16} />
                      </span>
                      <span className="runtime-profile-row-main">
                        <strong>{pack.name}</strong>
                        <small>
                          v{pack.version} · Rev {pack.revision} · {pack.tools.length} 個工具
                        </small>
                        <small>{formatToolPackUsage(usage)}</small>
                      </span>
                      <span className={`state-label skill-state ${toolPackStatusClass(pack.status)}`}>
                        {toolPackStatusLabel(pack.status)}
                      </span>
                    </button>
                  );
                })}
            </div>}
        </aside>

        <section className="agent-runtime-detail">
          {selected
            ? <>
              <div className="section-title">
                <h2>{selected.name}</h2>
                <span>v{selected.version} · Rev {selected.revision}</span>
              </div>

              <div className="advanced-strip">
                <span role="status" aria-live="polite">
                  {lifecycleIcon(selected)}{toolPackLifecycleMessage(selected)}
                </span>
                {commands.length > 0
                  ? <div className="agent-head-actions">
                    {commands.includes("edit")
                      ? <button
                        className="secondary-button small"
                        type="button"
                        aria-label={`編輯 ${selected.name}`}
                        title="編輯"
                        disabled={pending}
                        onClick={() => onEdit(selected)}
                      >
                        <Pencil size={13} />編輯
                      </button>
                      : null}
                    {commands.includes("validate")
                      ? <button
                        className="secondary-button small"
                        type="button"
                        aria-label={`記錄 ${selected.name} 驗證`}
                        title="記錄驗證"
                        disabled={pending}
                        onClick={() => onValidate(selected)}
                      >
                        <ClipboardCheck size={13} />記錄驗證
                      </button>
                      : null}
                    {commands.includes("approve")
                      ? <button
                        className="secondary-button small"
                        type="button"
                        aria-label={`核准 ${selected.name}`}
                        title="核准"
                        disabled={pending}
                        onClick={() => onApprove(selected)}
                      >
                        <ShieldCheck size={13} />核准
                      </button>
                      : null}
                    {commands.includes("revoke")
                      ? <button
                        className="secondary-button small"
                        type="button"
                        aria-label={`撤銷 ${selected.name}`}
                        title="撤銷"
                        disabled={pending}
                        onClick={() => onRevoke(selected)}
                      >
                        <XCircle size={13} />撤銷
                      </button>
                      : null}
                  </div>
                  : null}
              </div>

              <dl className="agent-runtime-grid">
                <div>
                  <dt>狀態</dt>
                  <dd>{toolPackStatusLabel(selected.status)}</dd>
                </div>
                <div>
                  <dt>Revision</dt>
                  <dd>Rev {selected.revision}</dd>
                </div>
                <div>
                  <dt>擁有者</dt>
                  <dd>{redactToolPackSummary(selected.owner)}</dd>
                </div>
                <div>
                  <dt>來源</dt>
                  <dd>{toolPackSourceName(selected.sourceReference)}</dd>
                </div>
                <div>
                  <dt>Image ID</dt>
                  <dd>{maskToolPackDigest(selected.imageDigest)}</dd>
                </div>
                <div>
                  <dt>Manifest ID</dt>
                  <dd>{maskToolPackDigest(selected.manifestDigest)}</dd>
                </div>
                <div>
                  <dt>核准時間</dt>
                  <dd>{formatTimestamp(selected.approvedAt)}</dd>
                </div>
                <div>
                  <dt>撤銷時間</dt>
                  <dd>{formatTimestamp(selected.revokedAt)}</dd>
                </div>
                <div>
                  <dt>使用狀態</dt>
                  <dd>{formatToolPackUsage(readUsage(selected.id))}</dd>
                </div>
                <div>
                  <dt>用途</dt>
                  <dd>{redactToolPackSummary(selected.description) || "未說明"}</dd>
                </div>
              </dl>

              <dl className="tool-run-summary">
                <div>
                  <dt>驗證</dt>
                  <dd>
                    <span className={`state-label skill-state ${toolPackValidationClass(selected.validation.result)}`}>
                      {toolPackValidationLabel(selected.validation.result)}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>摘要</dt>
                  <dd>{redactToolPackSummary(selected.validation.summary) || "尚無驗證摘要"}</dd>
                </div>
                <div>
                  <dt>檢查時間</dt>
                  <dd>{formatTimestamp(selected.validation.checkedAt)}</dd>
                </div>
              </dl>

              <div className="section-title">
                <h2>宣告工具</h2>
                <span>{selected.tools.length} 個唯讀工具</span>
              </div>
              <ul className="tool-catalog-list">
                {selected.tools.map((tool) => (
                  <li className="tool-catalog-row" key={tool.name}>
                    <div>
                      <strong>{tool.name}</strong>
                      <span>{toolPackToolKindLabel(tool.kind)} · 唯讀</span>
                      <p>{redactToolPackSummary(tool.goal)}</p>
                    </div>
                  </li>
                ))}
              </ul>

              <div className="section-title">
                <h2>版本記錄</h2>
                <span>{selectedRevisions.length} 個版本記錄</span>
              </div>
              {selectedRevisions.length > 0
                ? <ul className="agent-tool-summary">
                  {selectedRevisions.map((revision) => (
                    <li key={`${revision.packId}:${revision.revision}`}>
                      <strong>Rev {revision.revision} · {toolPackStatusLabel(revision.status)}</strong>
                      <span>{revision.source} · {formatTimestamp(revision.recordedAt)}</span>
                    </li>
                  ))}
                </ul>
                : <div className="empty-settings"><History size={14} />尚無版本記錄</div>}

              <div className="runtime-detail-footnotes">
                <span><Clock3 size={13} />Updated {formatTimestamp(selected.updatedAt)}</span>
              </div>
            </>
            : <div className="empty-settings">選擇 Tool Pack 以查看細節</div>}
        </section>
      </div>
    </section>
  );
}
