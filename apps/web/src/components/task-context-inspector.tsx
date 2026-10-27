import Link from "next/link";
import { Bot, CalendarClock, CheckCircle2, ListChecks, User } from "lucide-react";
import type { PublicTask as Task } from "@council/contracts";
import type { WorkspaceSourceContext } from "../lib/workspace-navigation";
import { buildTaskWorkspaceHref } from "../lib/workspace-navigation";
import { Modal } from "./ui";

const statusLabels: Record<Task["status"], string> = {
  todo: "待辦",
  in_progress: "進行中",
  review: "審查",
  done: "完成"
};

export function TaskContextInspector({
  task,
  assigneeName,
  source,
  onClose
}: {
  task: Task | null;
  assigneeName: string;
  source: WorkspaceSourceContext;
  onClose(): void;
}) {
  return <Modal
    title={task ? `${task.title} · 任務摘要` : "任務摘要"}
    open={Boolean(task)}
    onClose={onClose}
    variant="drawer"
    restoreFocusId="meeting-task-step"
  >
    {task && <div className="context-inspector">
      <div className="context-inspector-status"><span className={`status-chip ${task.status}`}>{statusLabels[task.status]}</span><small>工作內容仍在任務看板管理</small></div>
      <dl className="context-inspector-facts">
        <div><dt><User size={13} aria-hidden="true" />負責人</dt><dd>{assigneeName}</dd></div>
        <div><dt><CalendarClock size={13} aria-hidden="true" />到期</dt><dd>{task.dueAt ? new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short" }).format(new Date(task.dueAt)) : "未設定"}</dd></div>
        <div><dt><Bot size={13} aria-hidden="true" />執行方式</dt><dd>{task.executionProfile === "manual" ? "人工處理" : task.executionProfile === "advisor" ? "Agent 顧問" : "Agent 產出"}</dd></div>
        <div><dt><CheckCircle2 size={13} aria-hidden="true" />證據</dt><dd>{task.evidence.length} 筆</dd></div>
      </dl>
      <section><h3>工作說明</h3><p>{task.description || "尚未補充工作說明。"}</p></section>
      <section><h3>驗收條件</h3><p>{task.acceptanceCriteria || "尚未設定驗收條件。"}</p></section>
      <div className="context-inspector-actions"><button type="button" className="secondary-button" onClick={onClose}>留在會議</button><Link className="primary-button" href={buildTaskWorkspaceHref({ taskId: task.id, source })}><ListChecks size={14} aria-hidden="true" />到任務看板管理</Link></div>
    </div>}
  </Modal>;
}
