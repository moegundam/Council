"use client";

import { AlertTriangle, Clock3, History, Pencil, Play, Plus, ShieldCheck } from "lucide-react";
import type { AgentReadiness, RuntimeProfile, RuntimeProfileRevision } from "@council/contracts";
import {
  formatRuntimeCapabilitySummary,
  formatRuntimeTimeout,
  runtimeHarnessLabel,
  runtimePolicyLabel,
  runtimeProfileUsageSummary
} from "../lib/runtime-profile-ui";

export function RuntimeProfileRegistry({
  profiles,
  revisions,
  agents,
  selectedProfileId,
  readAgentReadiness,
  pending,
  onSelect,
  onCreate,
  onEdit,
  onHistory
}: {
  profiles: RuntimeProfile[];
  revisions: RuntimeProfileRevision[];
  agents: Array<{ id: string; runtimeProfileBinding: { profileId: string; revision: number } | null }>;
  selectedProfileId: string | null;
  readAgentReadiness(agentId: string): AgentReadiness | null;
  pending: boolean;
  onSelect(profileId: string): void;
  onCreate(): void;
  onEdit(profile: RuntimeProfile): void;
  onHistory(profile: RuntimeProfile): void;
}) {
  const selected = profiles.find((profile) => profile.id === selectedProfileId) ?? profiles[0] ?? null;
  const selectedRevision = selected
    ? revisions.find((revision) => revision.profileId === selected.id && revision.revision === selected.revision) ?? null
    : null;

  return (
    <section className="agent-runtime-section">
      <div className="agent-secondary-header">
        <div>
          <strong>執行設定</strong>
          <small>{profiles.length} 個 Profile</small>
        </div>
        <button className="secondary-button small" type="button" disabled={pending} onClick={onCreate}>
          <Plus size={13} />新增
        </button>
      </div>
      <div className="agent-runtime-workbench">
        <aside className="agent-runtime-list" aria-label="Runtime Profile 清單">
          {profiles.length === 0
            ? <div className="empty-settings">尚無 Runtime Profile</div>
            : <div className="settings-list">
              {profiles
                .slice()
                .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name))
                .map((profile) => {
                  const usage = runtimeProfileUsageSummary(agents, readAgentReadiness, profile.id);
                  return (
                    <button
                      type="button"
                      key={profile.id}
                      className={`runtime-profile-row ${profile.id === selected?.id ? "active" : ""}`}
                      onClick={() => onSelect(profile.id)}
                    >
                      <span className={`row-icon ${profile.enabled ? "blue" : "muted"}`}>
                        <ShieldCheck size={16} />
                      </span>
                      <span className="runtime-profile-row-main">
                        <strong>{profile.name}</strong>
                        <small>{runtimeHarnessLabel(profile.harnessKind)} · {runtimePolicyLabel(profile.policy)} · Rev {profile.revision}</small>
                        <small>{formatRuntimeCapabilitySummary(profile.capabilities)} · {usage.total} 個 Agent</small>
                      </span>
                      <span className={`state-label ${profile.enabled ? "approved" : "disabled"}`}>
                        {profile.enabled ? "enabled" : "disabled"}
                      </span>
                    </button>
                  );
                })}
            </div>}
        </aside>
        <section className="agent-runtime-detail">
          {selected && selectedRevision
            ? <>
              <div className="section-title">
                <h2>{selected.name}</h2>
                <span>Rev {selected.revision}</span>
              </div>
              <div className="advanced-strip">
                <span role="status" aria-live="polite">
                  {selected.enabled ? <><Play size={14} />可綁定新草稿</> : <><AlertTriangle size={14} />新執行會被阻擋</>}
                </span>
                <div className="agent-head-actions">
                  <button className="secondary-button small" type="button" disabled={pending} onClick={() => onHistory(selected)}>
                    <History size={13} />版本
                  </button>
                  <button className="secondary-button small" type="button" disabled={pending} onClick={() => onEdit(selected)}>
                    <Pencil size={13} />編輯
                  </button>
                </div>
              </div>
              <dl className="agent-runtime-grid">
                <div>
                  <dt>Harness</dt>
                  <dd>{runtimeHarnessLabel(selectedRevision.harnessKind)}</dd>
                </div>
                <div>
                  <dt>Policy</dt>
                  <dd>{runtimePolicyLabel(selectedRevision.policy)}</dd>
                </div>
                <div>
                  <dt>能力</dt>
                  <dd>{formatRuntimeCapabilitySummary(selectedRevision.capabilities)}</dd>
                </div>
                <div>
                  <dt>模型限制</dt>
                  <dd>{selectedRevision.modelConnectorId ? "固定 Model Connector" : "沿用 Agent Model Connector"}</dd>
                </div>
                <div>
                  <dt>Timeout</dt>
                  <dd>{formatRuntimeTimeout(selectedRevision.timeoutMs)}</dd>
                </div>
                <div>
                  <dt>並行上限</dt>
                  <dd>{selectedRevision.maxConcurrency}</dd>
                </div>
                <div>
                  <dt>Sandbox</dt>
                  <dd>{selectedRevision.sandboxProfileId ? "已綁定" : "未啟用"}</dd>
                </div>
                <div>
                  <dt>狀態</dt>
                  <dd>{selected.enabled ? "enabled" : "disabled"}</dd>
                </div>
              </dl>
              <div className="runtime-detail-footnotes">
                <span><Clock3 size={13} />Recorded {new Date(selectedRevision.recordedAt).toLocaleString("zh-TW")}</span>
              </div>
            </>
            : <div className="empty-settings">選擇 Runtime Profile 以查看細節</div>}
        </section>
      </div>
    </section>
  );
}
