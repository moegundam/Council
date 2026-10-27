"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  CirclePause,
  CirclePlay,
  CircleStop,
  ClipboardCheck,
  Clock3,
  FileCheck2,
  GripVertical,
  MessageSquareText,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Save,
  Send,
  Sparkles,
  X,
  XCircle
} from "lucide-react";
import type {
  ActionRun,
  ApproveGoalRunInput,
  CreateGoalRunInput,
  ExecutionContract,
  GoalCanvasLens,
  GoalCanvasSnapshot,
  GoalEvent,
  GoalPlanRevision,
  GoalPlanTask,
  GoalRun,
  GoalTaskBinding,
  RuntimeRun,
  ReviewerVerdict
} from "@council/contracts";
import { resolveCommittedMutation, usePlatform } from "../app/providers";
import { apiRequest } from "../lib/api";
import { LatestRequestGate } from "../lib/latest-request";
import {
  buildGoalWorkspaceHref,
  buildMeetingWorkspaceHref,
  parseGoalWorkspaceRoute,
  type GoalWorkspaceView
} from "../lib/workspace-navigation";
import { GoalCanvas } from "./goal-canvas";
import { RuntimeExecutionPanel } from "./runtime-execution-panel";
import { ActionNotice, Empty, PageState } from "./ui";

type GoalWorkspaceTab = GoalWorkspaceView;

interface GoalRunDetail {
  goalRun: GoalRun;
  plans: GoalPlanRevision[];
  executionContract: ExecutionContract | null;
  taskBindings: GoalTaskBinding[];
  events: GoalEvent[];
  reviewerVerdicts: ReviewerVerdict[];
  actionRuns: ActionRun[];
  runtimeRuns: RuntimeRun[];
}

interface DiscussionCategory {
  id: string;
  name: string;
}

interface DiscussionAgent {
  id: string;
  name: string;
  lifecycleStatus?: "draft" | "published" | "disabled";
}

interface DiscussionProjection {
  categories?: DiscussionCategory[];
  agents?: DiscussionAgent[];
}

interface GoalMeetingView {
  meeting: { id: string; state: "draft" | "active" | "paused" | "closed" };
  decisions: Array<{ id: string; meetingId: string; title: string; description: string; status: "proposed" | "approved" | "rejected" }>;
  tasks: Array<{ id: string; decisionId: string; status: "todo" | "in_progress" | "review" | "done" }>;
}

export function planTasksHaveCycle(tasks: readonly GoalPlanTask[]): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, "visiting" | "visited">();
  const visit = (taskId: string): boolean => {
    if (state.get(taskId) === "visiting") return true;
    if (state.get(taskId) === "visited") return false;
    state.set(taskId, "visiting");
    for (const dependencyId of byId.get(taskId)?.dependencyIds ?? []) {
      if (byId.has(dependencyId) && visit(dependencyId)) return true;
    }
    state.set(taskId, "visited");
    return false;
  };
  return tasks.some((task) => visit(task.id));
}

function fallbackTaskId(decisionId: string): string {
  const lastNibble = Number.parseInt(decisionId.at(-1) ?? "0", 16);
  return `${decisionId.slice(0, -1)}${(lastNibble ^ 1).toString(16)}`;
}

const tabItems: Array<{ id: GoalWorkspaceTab; label: string; icon: typeof MessageSquareText }> = [
  { id: "overview", label: "概覽", icon: MessageSquareText },
  { id: "activity", label: "目標事件", icon: Activity },
  { id: "canvas", label: "執行畫布", icon: Network }
];

const lensItems: Array<{ id: GoalCanvasLens; label: string }> = [
  { id: "progress", label: "進度" },
  { id: "collaboration", label: "協作" },
  { id: "resources", label: "資源" }
];

const stateLabels: Record<GoalRun["state"], string> = {
  draft: "草稿",
  planning: "規劃中",
  awaiting_approval: "等待核准",
  executing: "執行中",
  reviewing: "審查中",
  replanning: "重新規劃",
  paused: "已暫停",
  completed: "已完成",
  failed: "失敗",
  cancelled: "已取消"
};

const eventLabels: Partial<Record<GoalEvent["type"], string>> = {
  "goal.created": "已建立目標",
  "goal.state.changed": "狀態已變更",
  "meeting.linked": "已連結會議",
  "meeting.round.started": "會議輪次開始",
  "meeting.round.completed": "會議輪次完成",
  "chair.intervened": "主席介入",
  "plan.created": "已建立計畫",
  "plan.revised": "已更新計畫",
  "contract.approved": "已核准執行契約",
  "task.bound": "已建立任務",
  "task.state.changed": "任務狀態已變更",
  "action.state.changed": "Action 狀態已變更",
  "review.recorded": "已記錄審查",
  "owner.message": "Owner 補充訊息",
  "owner.takeover": "Owner 已接管"
};

function idempotencyKey(prefix: string): string {
  const token = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${token}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-TW", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"
  }).format(new Date(value));
}

export function goalStateTone(state: GoalRun["state"]): "active" | "complete" | "warning" | "danger" | "neutral" {
  if (state === "completed") return "complete";
  if (state === "failed" || state === "cancelled") return "danger";
  if (state === "paused" || state === "awaiting_approval") return "warning";
  if (state === "executing" || state === "planning" || state === "reviewing" || state === "replanning") return "active";
  return "neutral";
}

export function goalPhaseLabel(run: GoalRun): string {
  if (run.state === "planning" || run.state === "awaiting_approval") return "討論";
  if (run.state === "executing" || run.state === "reviewing" || run.state === "replanning") return "任務";
  if (run.executionContractId) return "決議";
  return "討論";
}

export function canApproveGoal(detail: GoalRunDetail): boolean {
  const plan = detail.plans.find((item) => item.revision === detail.goalRun.activePlanRevision);
  return detail.goalRun.state === "awaiting_approval" && Boolean(plan) && !detail.executionContract;
}

function activePlan(detail: GoalRunDetail): GoalPlanRevision | null {
  return detail.plans.find((plan) => plan.revision === detail.goalRun.activePlanRevision) ?? null;
}

function GoalRunList({ runs, selectedId, onSelect }: { runs: GoalRun[]; selectedId: string | null; onSelect(id: string): void }) {
  if (runs.length === 0) return <Empty>尚未建立目標。輸入目標後，系統會先建立正式會議。</Empty>;
  return <ul className="goal-run-list" aria-label="目標清單">
    {runs.map((run) => <li key={run.id}>
      <button className={`goal-run-list-item ${selectedId === run.id ? "selected" : ""}`} type="button" onClick={() => onSelect(run.id)} aria-current={selectedId === run.id ? "page" : undefined}>
        <span className={`goal-state-dot ${goalStateTone(run.state)}`} aria-hidden="true" />
        <span><strong>{run.title}</strong><small>{goalPhaseLabel(run)} · {stateLabels[run.state]}</small></span>
      </button>
    </li>)}
  </ul>;
}

function GoalComposer({ categories, busy, onCreate, onCancel }: {
  categories: DiscussionCategory[];
  busy: boolean;
  onCreate(input: CreateGoalRunInput): Promise<boolean>;
  onCancel?: () => void;
}) {
  const [goal, setGoal] = useState("");
  const [title, setTitle] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!goal.trim() || !categoryId) {
      setError("請輸入目標並選擇討論分類。");
      return;
    }
    setError(null);
    const created = await onCreate({ goal: goal.trim(), ...(title.trim() ? { title: title.trim() } : {}), categoryId, tagIds: [] });
    if (created) {
      setGoal("");
      setTitle("");
    }
  }

  return <form className="goal-composer" onSubmit={(event) => void submit(event)}>
    <div className="goal-composer-heading"><div><span className="eyebrow">Goal Run</span><h1>從目標開始</h1></div><div className="goal-composer-heading-actions"><Sparkles size={19} aria-hidden="true" />{onCancel && <button className="icon-button" type="button" onClick={onCancel} aria-label="收合新增目標" title="收合新增目標"><X size={16} /></button>}</div></div>
    <label className="goal-field"><span>目標</span><textarea value={goal} onChange={(event) => setGoal(event.currentTarget.value)} placeholder="描述要完成的結果與驗收條件" rows={3} maxLength={8000} disabled={busy} /></label>
    <div className="goal-composer-options">
      <label className="goal-field"><span>名稱</span><input value={title} onChange={(event) => setTitle(event.currentTarget.value)} placeholder="選填" maxLength={160} disabled={busy} /></label>
      <label className="goal-field"><span>討論分類</span><select value={categoryId} onChange={(event) => setCategoryId(event.currentTarget.value)} disabled={busy || categories.length === 0}><option value="">選擇分類</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
      <button className="primary-action goal-create-action" type="submit" disabled={busy || categories.length === 0} title="建立目標與正式會議" aria-label="建立目標與正式會議"><Plus size={17} /><span>{busy ? "建立中" : "建立目標"}</span></button>
    </div>
    {categories.length === 0 && <p className="field-note">尚無可用討論分類，請先在討論工作區建立分類。</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
  </form>;
}

function GoalStatusHeader({ detail, busy, onControl, onApprove }: {
  detail: GoalRunDetail;
  busy: boolean;
  onControl(action: "pause" | "resume" | "cancel"): Promise<void>;
  onApprove(): Promise<void>;
}) {
  const { goalRun } = detail;
  const plan = activePlan(detail);
  const approvalAvailable = canApproveGoal(detail);
  return <header className="goal-status-header">
    <div className="goal-title-block"><span className="eyebrow">{goalPhaseLabel(goalRun)} · Goal Run</span><h1>{goalRun.title}</h1><p>{goalRun.goal}</p></div>
    <div className="goal-status-actions">
      <span className={`status-pill ${goalStateTone(goalRun.state)}`}>{stateLabels[goalRun.state]}</span>
      {(goalRun.state === "planning" || goalRun.state === "awaiting_approval" || goalRun.state === "executing" || goalRun.state === "reviewing" || goalRun.state === "replanning") && <button className="icon-button" type="button" disabled={busy} onClick={() => void onControl("pause")} aria-label="暫停目標" title="暫停目標"><CirclePause size={17} /></button>}
      {goalRun.state === "paused" && <button className="icon-button" type="button" disabled={busy} onClick={() => void onControl("resume")} aria-label="繼續目標" title="繼續目標"><CirclePlay size={17} /></button>}
      {!(["completed", "failed", "cancelled"] as GoalRun["state"][]).includes(goalRun.state) && <button className="icon-button danger" type="button" disabled={busy} onClick={() => void onControl("cancel")} aria-label="取消目標" title="取消目標"><CircleStop size={17} /></button>}
      {approvalAvailable && <button className="primary-action" type="button" disabled={busy || !plan} onClick={() => void onApprove()}><ClipboardCheck size={16} />核准執行</button>}
    </div>
  </header>;
}

function GoalBudget({ run }: { run: GoalRun }) {
  const entries = [
    ["討論", run.usage.discussionRounds, run.limits.discussionRounds],
    ["模型", run.usage.modelCalls, run.limits.maxModelCalls],
    ["Action", run.usage.actionCalls, run.limits.maxActionCalls],
    ["重規劃", run.usage.replans, run.limits.maxReplans]
  ] as const;
  return <dl className="goal-budget" aria-label="執行預算">{entries.map(([label, used, limit]) => <div key={label}><dt>{label}</dt><dd>{used} / {limit}</dd></div>)}<div><dt>期限</dt><dd>{formatDate(run.deadlineAt)}</dd></div></dl>;
}

function GoalInstructionBar({ busy, disabled, onSend }: {
  busy: boolean;
  disabled: boolean;
  onSend(content: string): Promise<void>;
}) {
  const [content, setContent] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = content.trim();
    if (!message) return;
    try {
      await onSend(message);
      setContent("");
    } catch {
      // The parent renders the attributable API failure next to this control.
    }
  }
  return <form className="goal-instruction-bar" onSubmit={(event) => void submit(event)}>
    <label><MessageSquareText size={15} aria-hidden="true" /><span className="sr-only">Owner 補充指令</span><input value={content} onChange={(event) => setContent(event.currentTarget.value)} placeholder="補充限制、資料或執行指令" maxLength={4000} disabled={busy || disabled} /></label>
    <button className="icon-button" type="submit" disabled={busy || disabled || !content.trim()} aria-label="送出 Owner 指令" title="送出 Owner 指令"><Send size={16} /></button>
  </form>;
}

function GoalOverviewTab({ detail, onRuntimeUpdated }: { detail: GoalRunDetail; onRuntimeUpdated(run: RuntimeRun): void }) {
  const run = detail.goalRun;
  const plan = activePlan(detail);
  const [instructionBusy, setInstructionBusy] = useState(false);
  const [instructionStatus, setInstructionStatus] = useState("");
  async function sendInstruction(content: string) {
    setInstructionBusy(true); setInstructionStatus("");
    try {
      await apiRequest<GoalEvent>(`/api/v1/goal-runs/${run.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision: run.revision, content })
      });
      setInstructionStatus("Owner 指令已寫入正式會議與活動紀錄，於下次規劃生效。");
    } catch (cause) {
      setInstructionStatus(cause instanceof Error ? cause.message : "送出 Owner 指令失敗。");
      throw cause;
    } finally { setInstructionBusy(false); }
  }
  return <section className="goal-tab-panel goal-formal-meeting-panel" aria-labelledby="goal-meeting-title">
    <div className="goal-meeting-summary"><div><span className="eyebrow">Goal 控制台</span><h2 id="goal-meeting-title">討論 → 決議 → 任務</h2><p>這裡追蹤目標、計畫與執行；正式發言、主席介入、共識與異議統一留在會議室。</p></div><Link className="primary-action" href={buildMeetingWorkspaceHref({ meetingId: run.meetingId, threadId: run.threadId, fromGoalId: run.id, view: "meeting" })}><MessageSquareText size={16} />進入正式會議</Link></div>
    <dl className="goal-meeting-facts"><div><dt>目前階段</dt><dd>{goalPhaseLabel(run)}</dd></div><div><dt>目前計畫</dt><dd>{plan ? `v${plan.revision} · ${plan.tasks.length} 個任務` : "尚未形成計畫"}</dd></div><div><dt>執行契約</dt><dd>{detail.executionContract ? "已核准" : "尚未核准"}</dd></div></dl>
    {detail.runtimeRuns.length > 0 && <div className="goal-runtime-list" aria-label="目標 Runtime 執行">
      {detail.runtimeRuns.map((runtimeRun) => <RuntimeExecutionPanel key={runtimeRun.id} runtimeRun={runtimeRun} onUpdated={onRuntimeUpdated} />)}
    </div>}
    <GoalInstructionBar busy={instructionBusy} disabled={(["completed", "failed", "cancelled"] as GoalRun["state"][]).includes(run.state)} onSend={sendInstruction} />
    {instructionStatus && <p className="goal-instruction-status" role="status">{instructionStatus}</p>}
    {run.terminalReason && <p className="goal-terminal-reason"><XCircle size={16} aria-hidden="true" />{run.terminalReason}</p>}
  </section>;
}

function GoalActivityTab({ events, runtimeRuns, onRuntimeUpdated }: { events: GoalEvent[]; runtimeRuns: RuntimeRun[]; onRuntimeUpdated(run: RuntimeRun): void }) {
  if (events.length === 0 && runtimeRuns.length === 0) return <Empty>尚未有活動紀錄。</Empty>;
  return <section className="goal-tab-panel goal-activity-panel" aria-labelledby="goal-activity-title"><header><div><span className="eyebrow">目標事件</span><h2 id="goal-activity-title">執行活動</h2></div><span>{events.length} 筆正式事件</span></header>{runtimeRuns.length > 0 && <div className="goal-runtime-list activity-runtime-list">{runtimeRuns.map((runtimeRun) => <RuntimeExecutionPanel key={runtimeRun.id} runtimeRun={runtimeRun} compact onUpdated={onRuntimeUpdated} />)}</div>}<ol className="activity-list">{events.map((event) => <li key={event.id} className="activity-item"><Clock3 size={17} aria-hidden="true" /><div><div className="activity-item-heading"><strong>{eventLabels[event.type] ?? event.type}</strong><time dateTime={event.occurredAt}>{formatDate(event.occurredAt)}</time></div><p>{event.summary}</p><span>{event.actorType === "owner" ? "Owner" : event.actorType === "agent" ? "Agent" : "系統"}</span></div></li>)}</ol></section>;
}

function PlanEditor({ detail, meetingView, agents, busy, onSave }: {
  detail: GoalRunDetail;
  meetingView: GoalMeetingView | null;
  agents: DiscussionAgent[];
  busy: boolean;
  onSave(tasks: GoalPlanTask[]): Promise<void>;
}) {
  const plan = activePlan(detail);
  const [tasks, setTasks] = useState<GoalPlanTask[]>([]);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editable = ["planning", "awaiting_approval", "paused", "replanning"].includes(detail.goalRun.state);
  const decisions = (meetingView?.decisions ?? []).filter((decision) => decision.status !== "rejected");
  const decisionKey = decisions.map((decision) => `${decision.id}:${decision.status}:${decision.title}:${decision.description}`).join("|");

  useEffect(() => {
    if (plan) {
      setTasks(plan.tasks.map((task) => ({ ...task, dependencyIds: [...task.dependencyIds], allowedTools: [...task.allowedTools] })));
      return;
    }
    setTasks(decisions.map((decision) => ({
      id: globalThis.crypto?.randomUUID?.() ?? fallbackTaskId(decision.id),
      decisionId: decision.id,
      title: decision.title,
      description: decision.description,
      acceptanceCriteria: `提供可驗證證據：${decision.description}`.slice(0, 4_000),
      dependencyIds: [],
      assigneeAgentId: null,
      executionMode: "manual",
      allowedTools: [],
      dataScope: "正式會議逐字稿、決議與已核准證據。",
      action: null
    })));
  }, [plan?.id, plan?.digest, decisionKey]);

  function updateTask(id: string, update: Partial<GoalPlanTask>) {
    setTasks((current) => current.map((task) => task.id === id ? { ...task, ...update } : task));
  }

  function moveTask(id: string, offset: -1 | 1) {
    setTasks((current) => {
      const sourceIndex = current.findIndex((task) => task.id === id);
      const targetIndex = sourceIndex + offset;
      if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved!);
      return next;
    });
  }

  function toggleDependency(taskId: string, dependencyId: string, checked: boolean) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    const dependencies = new Set(task.dependencyIds);
    if (checked) dependencies.add(dependencyId);
    else dependencies.delete(dependencyId);
    updateTask(taskId, { dependencyIds: [...dependencies] });
  }

  function dropTask(event: DragEvent<HTMLLIElement>, targetId: string) {
    event.preventDefault();
    if (!draggedId || draggedId === targetId) return;
    setTasks((current) => {
      const next = [...current];
      const sourceIndex = next.findIndex((task) => task.id === draggedId);
      const targetIndex = next.findIndex((task) => task.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved!);
      return next;
    });
    setDraggedId(null);
  }

  async function save() {
    if (tasks.length === 0) { setError("正式會議尚未形成可規劃的 Decision。"); return; }
    if (tasks.some((task) => task.title.trim().length === 0 || task.acceptanceCriteria.trim().length === 0)) {
      setError("每個任務都必須有名稱與驗收條件。");
      return;
    }
    if (tasks.some((task) => task.executionMode !== "manual" && task.executionMode !== "action" && !task.assigneeAgentId)) {
      setError("Advisor 或 Worker 任務必須指定 Agent。");
      return;
    }
    if (planTasksHaveCycle(tasks)) {
      setError("任務依賴形成循環，請移除其中一項前置關係。");
      return;
    }
    setError(null);
    await onSave(tasks);
  }

  return <section className="goal-plan-editor" aria-labelledby="goal-plan-editor-title">
    <header><div><span className="eyebrow">Plan {plan ? `v${plan.revision}` : "draft"}</span><h2 id="goal-plan-editor-title">核准前任務計畫</h2></div>{editable && <button className="primary-action" type="button" disabled={busy || tasks.length === 0} onClick={() => void save()}><Save size={16} />儲存新版</button>}</header>
    {!editable && <p className="field-note">Execution Contract 已鎖定；請先暫停並建立新版本。</p>}
    {tasks.length === 0 ? <Empty>會議尚未形成候選 Decision。完成討論後，系統會在這裡建立 Plan。</Empty> : <ol>{tasks.map((task, index) => {
      const decision = decisions.find((candidate) => candidate.id === task.decisionId);
      return <li key={task.id} onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropTask(event, task.id)}>
        <div className="goal-plan-order-controls">
          <span className="goal-plan-index" aria-label={`任務 ${index + 1}`}>{index + 1}</span>
          <span className="goal-plan-drag" draggable={editable} onDragStart={() => setDraggedId(task.id)} title="拖拉調整順序"><GripVertical size={17} aria-hidden="true" /></span>
          <button className="icon-button" type="button" disabled={!editable || index === 0} onClick={() => moveTask(task.id, -1)} aria-label={`上移 ${task.title}`} title="上移任務"><ArrowUp size={15} /></button>
          <button className="icon-button" type="button" disabled={!editable || index === tasks.length - 1} onClick={() => moveTask(task.id, 1)} aria-label={`下移 ${task.title}`} title="下移任務"><ArrowDown size={15} /></button>
        </div>
        <div className="goal-plan-editor-fields">
          <label className="goal-field"><span>任務</span><input value={task.title} maxLength={160} disabled={!editable} onChange={(event) => updateTask(task.id, { title: event.currentTarget.value })} /></label>
          <div className="goal-plan-editor-row">
            <label className="goal-field"><span>執行方式</span><select value={task.executionMode} disabled={!editable || task.executionMode === "action"} onChange={(event) => updateTask(task.id, { executionMode: event.currentTarget.value as GoalPlanTask["executionMode"], action: null })}><option value="manual">人工</option><option value="advisor">Advisor</option><option value="worker">Worker</option>{task.executionMode === "action" && <option value="action">Action</option>}</select></label>
            <label className="goal-field"><span>Agent</span><select value={task.assigneeAgentId ?? ""} disabled={!editable || task.executionMode === "manual" || task.executionMode === "action"} onChange={(event) => updateTask(task.id, { assigneeAgentId: event.currentTarget.value || null })}><option value="">選擇 Agent</option>{agents.filter((agent) => agent.lifecycleStatus !== "disabled").map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
          </div>
          <label className="goal-field"><span>驗收條件</span><textarea rows={2} maxLength={4000} disabled={!editable} value={task.acceptanceCriteria} onChange={(event) => updateTask(task.id, { acceptanceCriteria: event.currentTarget.value })} /></label>
          <fieldset className="goal-plan-dependencies" disabled={!editable}><legend>前置任務</legend><div>{tasks.filter((candidate) => candidate.id !== task.id).length === 0 ? <span>無</span> : tasks.filter((candidate) => candidate.id !== task.id).map((candidate) => <label key={candidate.id}><input type="checkbox" checked={task.dependencyIds.includes(candidate.id)} onChange={(event) => toggleDependency(task.id, candidate.id, event.currentTarget.checked)} /><span>{candidate.title}</span></label>)}</div></fieldset>
          <small>來源 Decision：{decision?.title ?? task.decisionId}</small>
        </div>
      </li>;
    })}</ol>}
    {error && <p className="field-error" role="alert">{error}</p>}
  </section>;
}

function GoalCanvasTab({ canvas, lens, run, onLens }: { canvas: GoalCanvasSnapshot | null; lens: GoalCanvasLens; run: GoalRun; onLens(lens: GoalCanvasLens): void }) {
  return <section className="goal-tab-panel goal-canvas-panel" aria-labelledby="goal-canvas-title"><header><div><span className="eyebrow">執行畫布</span><h2 id="goal-canvas-title">執行狀態</h2></div><div className="goal-lens-tabs" role="tablist" aria-label="畫布視角">{lensItems.map((item) => <button key={item.id} id={`goal-canvas-lens-${item.id}`} type="button" role="tab" aria-selected={lens === item.id} className={lens === item.id ? "active" : ""} onClick={() => onLens(item.id)}>{item.label}</button>)}</div></header>{canvas ? <><p className="canvas-instruction" role="status">{canvas.nodes.length} 個節點 · {canvas.edges.length} 條關係 · {formatDate(canvas.generatedAt)}</p><GoalCanvas snapshot={canvas} context={{ goalId: run.id, meetingId: run.meetingId, threadId: run.threadId }} /></> : <Empty>畫布資料載入中。</Empty>}</section>;
}

export function GoalWorkspace() {
  return <Suspense fallback={<PageState loading error={null} />}><GoalWorkspaceContent /></Suspense>;
}

function GoalWorkspaceContent() {
  const { commitMutation } = usePlatform();
  const router = useRouter();
  const searchParams = useSearchParams();
  const routeState = parseGoalWorkspaceRoute(searchParams);
  const [runs, setRuns] = useState<GoalRun[]>([]);
  const [categories, setCategories] = useState<DiscussionCategory[]>([]);
  const [agents, setAgents] = useState<DiscussionAgent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<GoalRunDetail | null>(null);
  const [meetingView, setMeetingView] = useState<GoalMeetingView | null>(null);
  const [events, setEvents] = useState<GoalEvent[]>([]);
  const [canvas, setCanvas] = useState<GoalCanvasSnapshot | null>(null);
  const [tab, setTab] = useState<GoalWorkspaceTab>(routeState.view);
  const [lens, setLens] = useState<GoalCanvasLens>(routeState.lens);
  const [composerOpen, setComposerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(routeState.view === "canvas");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const detailRequestGateRef = useRef(new LatestRequestGate());
  const lensRef = useRef<GoalCanvasLens>(routeState.lens);
  const detailRef = useRef<HTMLElement>(null);
  const detailScrollByRouteRef = useRef(new Map<string, number>());
  const previousDetailRouteRef = useRef<{ goalId: string | null; view: GoalWorkspaceTab } | null>(null);
  const previousViewRef = useRef<GoalWorkspaceTab>(routeState.view);

  const refreshRuns = useCallback(async () => {
    const response = await apiRequest<{ goalRuns: GoalRun[] }>("/api/v1/goal-runs");
    setRuns(response.goalRuns);
  }, []);

  const refreshCategories = useCallback(async () => {
    const response = await apiRequest<DiscussionProjection>("/api/v1/views/discussions");
    setCategories(response.categories ?? []);
    setAgents(response.agents ?? []);
  }, []);

  const refreshDetail = useCallback(async (goalRunId: string, requestedLens = lensRef.current) => {
    const requestToken = detailRequestGateRef.current.begin();
    try {
      const nextDetail = await apiRequest<GoalRunDetail>(`/api/v1/goal-runs/${goalRunId}`);
      const [nextCanvas, nextMeetingView] = await Promise.all([
        apiRequest<GoalCanvasSnapshot>(`/api/v1/goal-runs/${goalRunId}/canvas?lens=${requestedLens}`),
        apiRequest<GoalMeetingView>(`/api/v1/meetings/${nextDetail.goalRun.meetingId}/view`)
      ]);
      if (!detailRequestGateRef.current.isCurrent(requestToken)) return;
      setDetail(nextDetail);
      setEvents(nextDetail.events);
      setCanvas(nextCanvas);
      setMeetingView(nextMeetingView);
    } catch (cause) {
      if (detailRequestGateRef.current.isCurrent(requestToken)) throw cause;
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { await Promise.all([refreshRuns(), refreshCategories()]); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "無法載入目標工作區。"); }
    finally { setLoading(false); }
  }, [refreshCategories, refreshRuns]);

  useEffect(() => { void refreshAll(); }, [refreshAll]);
  useEffect(() => { lensRef.current = lens; }, [lens]);
  useEffect(() => {
    if (loading) return;
    const requestedExists = Boolean(routeState.goalId && runs.some((run) => run.id === routeState.goalId));
    const nextSelectedId = requestedExists ? routeState.goalId : (runs[0]?.id ?? null);
    if (nextSelectedId !== selectedId) setSelectedId(nextSelectedId);
    if (runs.length === 0) setComposerOpen(true);
    if (nextSelectedId && nextSelectedId !== routeState.goalId) {
      router.replace(buildGoalWorkspaceHref({ goalId: nextSelectedId, view: routeState.view, lens: routeState.lens }), { scroll: false });
    }
  }, [loading, routeState.goalId, routeState.lens, routeState.view, router, runs, selectedId]);
  useEffect(() => {
    setTab(routeState.view);
    setLens(routeState.lens);
  }, [routeState.lens, routeState.view]);
  useEffect(() => {
    const syncHistoryRoute = () => {
      const historyRoute = parseGoalWorkspaceRoute(new URLSearchParams(window.location.search));
      setTab(historyRoute.view);
      setLens(historyRoute.lens);
    };
    window.addEventListener("popstate", syncHistoryRoute);
    return () => window.removeEventListener("popstate", syncHistoryRoute);
  }, []);
  useEffect(() => {
    if (previousViewRef.current !== tab) {
      setSidebarCollapsed(tab === "canvas");
      previousViewRef.current = tab;
    }
  }, [tab]);
  useEffect(() => {
    const detailElement = detailRef.current;
    const previous = previousDetailRouteRef.current;
    if (detailElement && previous?.goalId) {
      detailScrollByRouteRef.current.set(`${previous.goalId}:${previous.view}`, detailElement.scrollTop);
    }
    const goalChanged = previous?.goalId !== selectedId;
    const nextKey = selectedId ? `${selectedId}:${tab}` : null;
    previousDetailRouteRef.current = { goalId: selectedId, view: tab };
    const frame = window.requestAnimationFrame(() => {
      if (!detailElement) return;
      if (window.matchMedia("(max-width: 680px)").matches) {
        if (goalChanged && selectedId) detailElement.scrollIntoView({ block: "start" });
        return;
      }
      detailElement.scrollTop = goalChanged || !nextKey
        ? 0
        : detailScrollByRouteRef.current.get(nextKey) ?? 0;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedId, tab]);
  useEffect(() => {
    if (!selectedId) {
      detailRequestGateRef.current.cancel();
      setDetail(null); setMeetingView(null); setEvents([]); setCanvas(null);
      return;
    }
    void refreshDetail(selectedId, lens).catch((cause) => setError(cause instanceof Error ? cause.message : "無法載入目標詳細資料。"));
  }, [lens, refreshDetail, selectedId]);
  useEffect(() => {
    if (!selectedId || typeof EventSource === "undefined") return;
    const source = new EventSource(`/api/v1/goal-runs/${selectedId}/events`);
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const onEvent = (message: MessageEvent<string>) => {
      try {
        const event = JSON.parse(message.data) as GoalEvent;
        setEvents((current) => current.some((candidate) => candidate.id === event.id)
          ? current
          : [...current, event].sort((left, right) => left.sequence - right.sequence));
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          void refreshDetail(selectedId).catch((cause) => setError(cause instanceof Error ? cause.message : "無法同步目標狀態。"));
        }, 250);
      } catch {
        setError("收到無法驗證的目標事件。");
      }
    };
    source.addEventListener("goal.event", onEvent as EventListener);
    const onRuntimeRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void refreshDetail(selectedId).catch((cause) => setError(cause instanceof Error ? cause.message : "無法同步 Runtime 狀態。"));
      }, 100);
    };
    source.addEventListener("runtime.refresh", onRuntimeRefresh);
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      source.removeEventListener("goal.event", onEvent as EventListener);
      source.removeEventListener("runtime.refresh", onRuntimeRefresh);
      source.close();
    };
  }, [refreshDetail, selectedId]);

  async function createGoal(input: CreateGoalRunInput): Promise<boolean> {
    setBusy(true); setNotice(""); setError(null);
    try {
      const created = await resolveCommittedMutation(() => commitMutation(
        () => apiRequest<{ goalRun: GoalRun }>("/api/v1/goal-runs", { method: "POST", headers: { "Idempotency-Key": idempotencyKey("goal-run") }, body: JSON.stringify(input) })
      ));
      setRuns((current) => [created.result.goalRun, ...current.filter((run) => run.id !== created.result.goalRun.id)]);
      router.push(buildGoalWorkspaceHref({ goalId: created.result.goalRun.id, view: "overview" }), { scroll: false });
      setComposerOpen(false);
      try { await refreshRuns(); }
      catch { setError("目標已建立，但目標清單刷新失敗；請重新整理後確認。"); }
      setNotice(created.projectionFresh
        ? "已建立目標與正式會議，正在進行第一輪討論。"
        : "已建立目標與正式會議，但討論資料刷新失敗；請重新整理後確認。");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "建立目標失敗。");
      return false;
    }
    finally { setBusy(false); }
  }

  async function controlGoal(action: "pause" | "resume" | "cancel") {
    if (!detail) return;
    setBusy(true); setNotice("");
    try {
      await apiRequest<GoalRun>(`/api/v1/goal-runs/${detail.goalRun.id}/${action}`, { method: "POST", body: JSON.stringify({ expectedRevision: detail.goalRun.revision }) });
      await Promise.all([refreshRuns(), refreshDetail(detail.goalRun.id)]); setNotice(action === "pause" ? "目標已暫停。" : action === "resume" ? "目標已繼續。" : "目標已取消。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "目標操作失敗。"); }
    finally { setBusy(false); }
  }

  async function approveGoal() {
    const plan = detail && activePlan(detail);
    if (!detail || !plan) return;
    const input: ApproveGoalRunInput = { expectedRevision: detail.goalRun.revision, expectedPlanRevision: plan.revision, expectedPlanDigest: plan.digest };
    setBusy(true); setNotice("");
    try {
      await apiRequest<GoalRunDetail>(`/api/v1/goal-runs/${detail.goalRun.id}/approve`, { method: "POST", body: JSON.stringify(input) });
      await Promise.all([refreshRuns(), refreshDetail(detail.goalRun.id)]); setNotice("執行契約已核准，任務依序開始執行。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "核准失敗。"); }
    finally { setBusy(false); }
  }

  async function savePlan(tasks: GoalPlanTask[]) {
    if (!detail) return;
    setBusy(true); setNotice(""); setError(null);
    try {
      await apiRequest<GoalRunDetail>(`/api/v1/goal-runs/${detail.goalRun.id}/plan`, {
        method: "PUT",
        body: JSON.stringify({ expectedPlanRevision: detail.goalRun.activePlanRevision, tasks })
      });
      await Promise.all([refreshRuns(), refreshDetail(detail.goalRun.id)]);
      setNotice("已建立新的 Plan Revision，核准前仍可調整順序與依賴。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "儲存 Plan 失敗。"); }
    finally { setBusy(false); }
  }

  function selectGoal(nextGoalId: string) {
    if (nextGoalId === selectedId) return;
    router.push(buildGoalWorkspaceHref({ goalId: nextGoalId, view: tab, lens }), { scroll: false });
  }

  function selectTab(nextView: GoalWorkspaceTab) {
    if (nextView === tab) return;
    window.history.pushState(
      window.history.state,
      "",
      buildGoalWorkspaceHref({ goalId: selectedId, view: nextView, lens })
    );
    setTab(nextView);
  }

  function changeLens(nextLens: GoalCanvasLens) {
    if (nextLens === lens) return;
    window.history.pushState(
      window.history.state,
      "",
      buildGoalWorkspaceHref({ goalId: selectedId, view: "canvas", lens: nextLens })
    );
    setTab("canvas");
    setLens(nextLens);
  }

  function updateRuntimeRun(updated: RuntimeRun) {
    setDetail((current) => current && current.goalRun.id === updated.goalRunId
      ? { ...current, runtimeRuns: current.runtimeRuns.map((run) => run.id === updated.id ? updated : run) }
      : current);
    if (selectedId) {
      void refreshDetail(selectedId).catch((cause) => setError(cause instanceof Error ? cause.message : "無法同步 Runtime 狀態。"));
    }
  }

  const selectedDetail = detail?.goalRun.id === selectedId ? detail : null;
  const selectedRun = selectedDetail?.goalRun ?? runs.find((run) => run.id === selectedId) ?? null;
  const plan = selectedDetail ? activePlan(selectedDetail) : null;
  const activeBindings = selectedDetail && plan
    ? selectedDetail.taskBindings.filter((binding) => binding.planRevision === plan.revision)
    : [];
  return <main className={`goal-workspace ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
    <section className="goal-workspace-sidebar" aria-label="目標導覽">
      <div className="goal-sidebar-toolbar">
        <button className="icon-button goal-sidebar-collapse" type="button" onClick={() => setSidebarCollapsed((current) => !current)} aria-expanded={!sidebarCollapsed} aria-label={sidebarCollapsed ? "展開目標清單" : "收合目標清單"} title={sidebarCollapsed ? "展開目標清單" : "收合目標清單"}>{sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button>
        {!sidebarCollapsed && <button className="primary-button small" type="button" onClick={() => setComposerOpen(true)} disabled={busy}><Plus size={14} />新增目標</button>}
      </div>
      <div className="goal-sidebar-content">
        {composerOpen && <GoalComposer categories={categories} busy={busy} onCreate={createGoal} {...(runs.length > 0 ? { onCancel: () => setComposerOpen(false) } : {})} />}
        <div className="goal-list-heading"><h2>目標</h2><button className="icon-button" type="button" onClick={() => void refreshAll()} disabled={loading || busy} aria-label="重新整理目標" title="重新整理目標"><RefreshCw size={16} className={loading ? "spin-icon" : undefined} /></button></div>
        <GoalRunList runs={runs} selectedId={selectedId} onSelect={selectGoal} />
      </div>
    </section>
    <section ref={detailRef} className="goal-workspace-detail">
      {loading && !selectedRun ? <PageState loading error={null} /> : error && !selectedRun ? <PageState loading={false} error={error} /> : !selectedRun ? <Empty>選擇一個目標，或先建立新的目標。</Empty> : selectedDetail ? <>
        <GoalStatusHeader detail={selectedDetail} busy={busy} onControl={controlGoal} onApprove={approveGoal} />
        <GoalBudget run={selectedDetail.goalRun} />
        <ActionNotice message={notice || error || ""} error={Boolean(error)} />
        <div className="goal-workspace-tabs" role="tablist" aria-label="目標工作區">{tabItems.map((item) => {
          const Icon = item.icon;
          return <button key={item.id} id={`goal-tab-${item.id}`} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? "active" : ""} onClick={() => selectTab(item.id)}><Icon size={16} aria-hidden="true" />{item.label}</button>;
        })}</div>
        <div role="tabpanel" aria-labelledby={`goal-tab-${tab}`}>
          {tab === "overview" && <GoalOverviewTab detail={selectedDetail} onRuntimeUpdated={updateRuntimeRun} />}
          {tab === "activity" && <GoalActivityTab events={events} runtimeRuns={selectedDetail.runtimeRuns} onRuntimeUpdated={updateRuntimeRun} />}
          {tab === "canvas" && <GoalCanvasTab canvas={canvas} lens={lens} run={selectedDetail.goalRun} onLens={changeLens} />}
        </div>
        {tab === "overview" && <PlanEditor detail={selectedDetail} meetingView={meetingView} agents={agents} busy={busy} onSave={savePlan} />}
        {plan && <section className="goal-plan-summary" aria-labelledby="goal-plan-summary-title"><header><div><span className="eyebrow">Plan v{plan.revision}</span><h2 id="goal-plan-summary-title">任務與審查</h2></div><span>{activeBindings.filter((binding) => binding.state === "completed").length} / {plan.tasks.length} 完成</span></header><ol>{plan.tasks.map((task) => <li key={task.id}><span className="goal-state-dot" aria-hidden="true" /><div><strong>{task.title}</strong><small>{task.executionMode} · {task.acceptanceCriteria}</small></div></li>)}</ol>{selectedDetail.reviewerVerdicts.length > 0 && <p><FileCheck2 size={15} aria-hidden="true" />已收到 {selectedDetail.reviewerVerdicts.length} 筆 Reviewer Verdict。</p>}</section>}
      </> : <PageState loading error={null} />}
    </section>
  </main>;
}
