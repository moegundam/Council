import Link from "next/link";
import { Bot, Database, Target, Wrench } from "lucide-react";
import type { Agent } from "@council/contracts";
import type { WorkspaceSourceContext } from "../lib/workspace-navigation";
import { buildAgentWorkspaceHref } from "../lib/workspace-navigation";
import { Modal } from "./ui";

export function AgentContextInspector({
  agent,
  roleName,
  roleResponsibility,
  source,
  onClose
}: {
  agent: Agent | null;
  roleName: string;
  roleResponsibility: string;
  source: WorkspaceSourceContext;
  onClose(): void;
}) {
  return <Modal
    title={agent ? `${agent.name} · Agent 摘要` : "Agent 摘要"}
    open={Boolean(agent)}
    onClose={onClose}
    variant="drawer"
  >
    {agent && <div className="context-inspector">
      <div className="context-inspector-status"><span className={`status-chip ${agent.status}`}>{agent.status === "online" ? "可用" : agent.status === "attention" ? "需注意" : "離線"}</span><small>{roleName} · 本場角色</small></div>
      <p className="context-inspector-lead">{agent.description || roleResponsibility}</p>
      <dl className="context-inspector-summary">
        <div><dt><Target size={14} aria-hidden="true" />目標</dt><dd>{agent.goalSummary || roleResponsibility || "未設定"}</dd></div>
        <div><dt><Wrench size={14} aria-hidden="true" />工具</dt><dd>{agent.toolsSummary || "未設定"}</dd></div>
        <div><dt><Database size={14} aria-hidden="true" />資料</dt><dd>{agent.dataSummary || "未設定"}</dd></div>
      </dl>
      <div className="context-inspector-actions"><button type="button" className="secondary-button" onClick={onClose}>留在會議</button><Link className="primary-button" href={buildAgentWorkspaceHref({ agentId: agent.id, source })}><Bot size={14} aria-hidden="true" />到 Agent 管理</Link></div>
    </div>}
  </Modal>;
}
