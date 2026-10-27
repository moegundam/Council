import { AlertTriangle, CheckCircle2, LoaderCircle, Pencil, Settings2, Stethoscope } from "lucide-react";
import type { AgentSetupAction, AgentSetupRow } from "../lib/agent-setup-ui";

export function AgentSetupPanel({
  rows,
  instructionBudget,
  instructionBudgetLabel,
  connectionState,
  onAction
}: {
  rows: readonly AgentSetupRow[];
  instructionBudget: { instructionCharacters: number; limit: number; withinLimit: boolean } | null;
  instructionBudgetLabel: string;
  connectionState: "idle" | "pending" | "healthy" | "unhealthy" | "error";
  onAction: (action: AgentSetupAction) => void;
}) {
  const actionLabel = (action: AgentSetupAction) => action === "test_connection"
    ? connectionState === "pending" ? "測試中" : "連線測試"
    : action === "manage_models" ? "管理模型"
      : action === "manage_credentials" ? "管理憑證"
        : action === "manage_prompts" ? "管理 Prompt"
          : action === "manage_skills" ? "管理 Skill"
            : action === "manage_mcp" ? "管理 MCP"
              : "編輯綁定";
  const ActionIcon = (action: AgentSetupAction) => action === "test_connection" ? Stethoscope : action === "edit" ? Pencil : Settings2;
  const connectionMessage = connectionState === "healthy" ? "模型連線正常。"
    : connectionState === "unhealthy" ? "模型連線未通過。"
      : connectionState === "error" ? "模型連線測試失敗，請重試。" : null;

  return <section className="agent-setup-panel" aria-labelledby="agent-setup-heading">
    <div className="section-title"><h2 id="agent-setup-heading">Setup</h2><span className={instructionBudget?.withinLimit === false ? "agent-setup-over-budget" : ""}>{instructionBudget ? `${instructionBudgetLabel} ${instructionBudget.instructionCharacters} / ${instructionBudget.limit} 字元` : `${instructionBudgetLabel} 載入中`}</span></div>
    {instructionBudget?.withinLimit === false && <p className="agent-setup-budget-warning"><AlertTriangle size={13} />會議 Skill 指令超過上限；請在既有 Agent 綁定中調整。</p>}
    <div className="agent-setup-rows">{rows.map((row) => {
      const Icon = ActionIcon(row.action);
      const isTest = row.action === "test_connection";
      return <div className="agent-setup-row" key={row.id} role="group" aria-label={`${row.label}：${row.detail}`}>
        <span className={`agent-setup-status ${row.status}`}>{row.status === "ready" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}</span>
        <strong>{row.label}</strong><span>{row.detail}</span>
        <button className="secondary-button small" type="button" aria-label={`${row.label}：${actionLabel(row.action)}`} disabled={connectionState === "pending"} onClick={() => onAction(row.action)}>
          {isTest && connectionState === "pending" ? <LoaderCircle className="spin-icon" size={13} /> : <Icon size={13} />}{actionLabel(row.action)}
        </button>
      </div>;
    })}</div>
    {connectionMessage && <p className={connectionState === "healthy" ? "agent-setup-connection ready" : "agent-setup-connection blocked"} role="status">{connectionMessage}</p>}
  </section>;
}
