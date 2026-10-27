"use client";

import Link from "next/link";
import { useDraggable, useDroppable, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bot,
  CalendarClock,
  FileText,
  GripVertical,
  Link2,
  LoaderCircle,
  RefreshCw,
  Save,
  Send,
  User,
  TextSearch
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { PublicTask as Task, RuntimeRun, TaskExecutionProfile, TaskStatus } from "@council/contracts";
import { CommittedMutationProjectionError, resolveCommittedMutation, usePlatform } from "../app/providers";
import { ApiError, apiRequest, managementApi } from "../lib/api";
import {
  groupTasks,
  orderedTaskTransitions,
  preferredTaskStatus,
  snapshotNeedsPolling,
  taskSyncStateLabel
} from "../lib/view-model";
import {
  createTaskExecutionRequest,
  deriveTaskExecutionUi,
  reloadTaskAgentReadiness,
  taskAgentReadinessState,
  taskTransitionLabel,
  taskTransitionSummary,
  type TaskAgentReadinessState,
  type TaskExecutionCommand
} from "../lib/task-execution-ui";
import {
  canSubmitTaskSync,
  createTaskDraft,
  prepareTaskDraftUpdate,
  rebaseTaskDraft,
  staleTaskDraftMessage,
  taskDraftHasChanges,
  taskDraftIsStale,
  type TaskDraft,
  type TaskDraftFields
} from "../lib/task-draft-ui";
import { TaskMoveSelectionOwnership } from "../lib/task-move-ui";
import { startTaskPollingLoop, taskProjectionStatusLabel } from "../lib/task-polling-ui";
import { TaskEvidenceRetryOwnership } from "../lib/task-evidence-ui";
import { TaskAgentRunRetryOwnership, type TaskAgentRunRetryRequest } from "../lib/task-agent-run-retry-ownership";
import { buildMeetingWorkspaceHref, parseWorkspaceSourceContext } from "../lib/workspace-navigation";
import { SourceContextBar } from "./source-context-bar";
import { TaskExecutionBand } from "./task-execution-band";
import { ActionNotice, Empty, Modal, PageState } from "./ui";

const columns: Array<{ status: TaskStatus; label: string }> = [
  { status: "todo", label: "待辦" },
  { status: "in_progress", label: "進行中" },
  { status: "review", label: "審查" },
  { status: "done", label: "完成" }
];

export const taskMoveConflictMessage = "看板已由其他操作更新，已載入最新狀態，請再試一次。";

export async function refreshTaskBoardAfterConflict(refresh: () => Promise<void>): Promise<string> {
  await refresh();
  return taskMoveConflictMessage;
}

const taskDetailTabs = [
  { id: "content", label: "內容" },
  { id: "evidence", label: "證據" },
  { id: "history", label: "歷程" }
] as const;
type TaskDetailTab = (typeof taskDetailTabs)[number]["id"];

interface TaskEvidenceDraft {
  type: "url" | "note";
  label: string;
  reference: string;
}

const emptyTaskEvidenceDraft: TaskEvidenceDraft = { type: "url", label: "", reference: "" };

function taskEvidenceDraftHasChanges(draft: TaskEvidenceDraft): boolean {
  return draft.type !== emptyTaskEvidenceDraft.type
    || draft.label.trim() !== emptyTaskEvidenceDraft.label
    || draft.reference.trim() !== emptyTaskEvidenceDraft.reference;
}

export function tabIndexForNavigationKey(key: string, currentIndex: number, total: number): number | null {
  if (total <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return total - 1;
  if (key === "ArrowRight") return (currentIndex + 1) % total;
  if (key === "ArrowLeft") return (currentIndex - 1 + total) % total;
  return null;
}

export function TaskStatusTabs({ selectedStatus, counts, onSelect }: {
  selectedStatus: TaskStatus;
  counts: Record<TaskStatus, number>;
  onSelect(status: TaskStatus): void;
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const nextIndex = tabIndexForNavigationKey(event.key, index, columns.length);
    if (nextIndex === null) return;
    event.preventDefault();
    const nextStatus = columns[nextIndex]?.status;
    if (!nextStatus) return;
    onSelect(nextStatus);
    document.getElementById(`task-status-tab-${nextStatus}`)?.focus();
  }

  return <div className="task-status-tabs" role="tablist" aria-label="任務狀態" aria-orientation="horizontal">
    {columns.map((column, index) => <button
      key={column.status}
      id={`task-status-tab-${column.status}`}
      type="button"
      role="tab"
      tabIndex={selectedStatus === column.status ? 0 : -1}
      aria-selected={selectedStatus === column.status}
      aria-controls={`task-status-panel-${column.status}`}
      className={selectedStatus === column.status ? "active" : ""}
      onKeyDown={(event) => handleKeyDown(event, index)}
      onClick={() => onSelect(column.status)}
    ><span>{column.label}</span><b>{counts[column.status]}</b></button>)}
  </div>;
}

export function TaskDetailTabs({ activeTab, onSelect }: {
  activeTab: TaskDetailTab;
  onSelect(tab: TaskDetailTab): void;
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const nextIndex = tabIndexForNavigationKey(event.key, index, taskDetailTabs.length);
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = taskDetailTabs[nextIndex]?.id;
    if (!nextTab) return;
    onSelect(nextTab);
    document.getElementById(`task-detail-tab-${nextTab}`)?.focus();
  }

  return <div className="task-tabs" role="tablist" aria-label="任務詳情分類" aria-orientation="horizontal">
    {taskDetailTabs.map((item, index) => <button
      key={item.id}
      id={`task-detail-tab-${item.id}`}
      className={`task-tab ${activeTab === item.id ? "active" : ""}`}
      type="button"
      role="tab"
      tabIndex={activeTab === item.id ? 0 : -1}
      aria-selected={activeTab === item.id}
      aria-controls={`task-detail-panel-${item.id}`}
      onKeyDown={(event) => handleKeyDown(event, index)}
      onClick={() => onSelect(item.id)}
    >{item.label}</button>)}
  </div>;
}

function dueDateLabel(value: string | null): string {
  if (!value) return "未設定";
  try {
    return new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  } catch {
    return "日期格式異常";
  }
}

function taskRunIdempotencyKey(taskId: string): string {
  const token = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `task-agent-run:${taskId}:${token}`;
}

function DraggableTask({
  task,
  agentName,
  disabled,
  onMove,
  onOpen
}: {
  task: Task;
  agentName: string;
  disabled: boolean;
  onMove(status: TaskStatus): void;
  onOpen(task: Task): void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: task.id, data: { status: task.status }, disabled });
  const index = columns.findIndex((column) => column.status === task.status);
  const AssigneeIcon = task.assigneeAgentId ? Bot : User;
  return <article ref={setNodeRef} className={`task-card ${isDragging ? "dragging" : ""}`} style={{ transform: CSS.Translate.toString(transform) }} aria-busy={disabled || undefined}>
    <header>
      <button className="drag-handle" disabled={disabled} {...listeners} {...attributes} aria-label={`拖拉 ${task.title}`}><GripVertical size={15} /></button>
      <span className="task-assignee"><AssigneeIcon size={13} /><span>{agentName}</span></span>
    </header>
    <h2>{task.title}</h2>
    <div className="task-meta">
      <span><CalendarClock size={13} />{dueDateLabel(task.dueAt)}</span>
    </div>
    <footer>
      <div className="task-card-actions">
        {index > 0 && <button className="icon-button small-icon" disabled={disabled} onClick={() => onMove(columns[index - 1]!.status)} aria-label={`移至${columns[index - 1]!.label}`} title={`移至${columns[index - 1]!.label}`}><ArrowLeft size={13} /></button>}
        {index < columns.length - 1 && <button className="icon-button small-icon" disabled={disabled} onClick={() => onMove(columns[index + 1]!.status)} aria-label={`移至${columns[index + 1]!.label}`} title={`移至${columns[index + 1]!.label}`}><ArrowRight size={13} /></button>}
        <button className="icon-button small-icon" onClick={() => onOpen(task)} aria-label={`開啟${task.title}詳細`} title={`開啟${task.title}詳細`}><TextSearch size={13} /></button>
      </div>
    </footer>
  </article>;
}

function TaskColumn({ status, label, tasks, active, pendingTaskId, agentNameForTask, onMove, onOpen }: {
  status: TaskStatus;
  label: string;
  tasks: Task[];
  active: boolean;
  pendingTaskId: string | null;
  agentNameForTask(task: Task): string;
  onMove(task: Task, status: TaskStatus): void;
  onOpen(task: Task): void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return <section
    ref={setNodeRef}
    id={`task-status-panel-${status}`}
    className={`task-column ${active ? "mobile-active" : ""} ${isOver ? "over" : ""}`}
    role="tabpanel"
    tabIndex={active ? 0 : -1}
    aria-labelledby={`task-status-tab-${status}`}
  >
    <header><h2>{label}</h2><span>{tasks.length}</span></header>
    <div className="task-list">{tasks.map((task) => <DraggableTask
      key={task.id}
      task={task}
      agentName={agentNameForTask(task)}
      disabled={pendingTaskId !== null || task.execution.status === "queued" || task.execution.status === "running"}
      onMove={(next) => onMove(task, next)}
      onOpen={onOpen}
    />)}{tasks.length === 0 && <Empty>無任務</Empty>}</div>
  </section>;
}

export function TasksView() {
  return <Suspense fallback={<PageState loading error={null} />}><TasksViewContent /></Suspense>;
}

function TasksViewContent() {
  const {
    platformProjectionStale,
    platformProjectionRefreshing,
    platformProjectionLastSuccessfulAt,
    snapshot,
    loading,
    error,
    mutate,
    refresh,
    refreshRequired
  } = usePlatform();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const sourceContext = parseWorkspaceSourceContext(searchParams);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [activeStatus, setActiveStatus] = useState<TaskStatus | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const [discardRequested, setDiscardRequested] = useState(false);
  const [selectedAdapterId, setSelectedAdapterId] = useState("");
  const [tab, setTab] = useState<TaskDetailTab>("content");
  const [detailNotice, setDetailNotice] = useState("");
  const [detailError, setDetailError] = useState("");
  const [detailBusy, setDetailBusy] = useState<string | null>(null);
  const [evidenceDraft, setEvidenceDraft] = useState<TaskEvidenceDraft>(emptyTaskEvidenceDraft);
  const [taskAgentReadiness, setTaskAgentReadiness] = useState<TaskAgentReadinessState | null>(null);
  const [runtimeRun, setRuntimeRun] = useState<RuntimeRun | null>(null);
  const dismissedDeepLinkRef = useRef<string | null>(null);
  const taskAgentRunRetryOwnershipRef = useRef(new TaskAgentRunRetryOwnership());
  const evidenceRetryOwnershipRef = useRef(new TaskEvidenceRetryOwnership());
  const taskMoveSelectionOwnershipRef = useRef(new TaskMoveSelectionOwnership());
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor)
  );

  const shouldPoll = snapshot ? snapshotNeedsPolling(snapshot) : false;
  const deepLinkedTaskId = searchParams.get("taskId");
  const openTask = snapshot?.tasks.find((task) => task.id === openTaskId) ?? null;
  const draftStale = taskDraftIsStale(draft, openTask);
  const evidenceDraftDirty = taskEvidenceDraftHasChanges(evidenceDraft);
  const taskDetailDirty = draftDirty || evidenceDraftDirty;

  useEffect(() => {
    return startTaskPollingLoop({
      activeWork: shouldPoll,
      refresh: refreshRequired
    });
  }, [shouldPoll, refreshRequired]);

  useEffect(() => {
    if (!deepLinkedTaskId) {
      dismissedDeepLinkRef.current = null;
      return;
    }
    if (!snapshot || dismissedDeepLinkRef.current === deepLinkedTaskId || openTaskId === deepLinkedTaskId) return;
    const linkedTask = snapshot.tasks.find((task) => task.id === deepLinkedTaskId);
    if (!linkedTask) return;
    setOpenTaskId(linkedTask.id);
    setDraft(createTaskDraft(linkedTask));
    setDraftDirty(false);
    setDiscardRequested(false);
    setSelectedAdapterId("");
    setEvidenceDraft(emptyTaskEvidenceDraft);
    taskMoveSelectionOwnershipRef.current.claimUserSelection();
    setActiveStatus(linkedTask.status);
    setTab("content");
  }, [deepLinkedTaskId, openTaskId, snapshot]);

  useEffect(() => {
    if (!openTask) {
      setDetailNotice("");
      setDetailError("");
      setTab("content");
      return;
    }
    if (!draft || draft.taskId !== openTask.id || !draftDirty) setDraft(createTaskDraft(openTask));
  }, [draft?.taskId, draftDirty, openTask?.id, openTask?.updatedAt]);

  useEffect(() => {
    const task = openTask;
    const agentId = task?.assigneeAgentId;
    if (!task || task.executionProfile === "manual" || !agentId) {
      setTaskAgentReadiness(null);
      return;
    }

    let cancelled = false;
    setTaskAgentReadiness(taskAgentReadinessState(task, "checking"));
    void reloadTaskAgentReadiness(
      task,
      async (agentIds) => (await managementApi.getAgentReadinessBatch(agentIds)).results
    ).then((readiness) => {
      if (!cancelled) setTaskAgentReadiness(readiness);
    });
    return () => { cancelled = true; };
  }, [openTask?.id, openTask?.assigneeAgentId, openTask?.executionProfile]);

  useEffect(() => {
    const task = openTask;
    if (!task || !task.execution.runtimeProfileBinding) {
      setRuntimeRun(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const run = await apiRequest<RuntimeRun>(`/api/v1/runtime-runs/by-task/${task.id}`);
        if (!cancelled) setRuntimeRun(run);
      } catch (cause) {
        if (!cancelled && cause instanceof ApiError && cause.status === 404) setRuntimeRun(null);
        else if (!cancelled) setDetailError(cause instanceof Error ? cause.message : "無法載入 Runtime 狀態。");
      }
    };
    void load();
    const active = task.execution.status === "queued" || task.execution.status === "running";
    const stopPolling = active
      ? startTaskPollingLoop({ activeWork: true, refresh: load })
      : null;
    return () => {
      cancelled = true;
      stopPolling?.();
    };
  }, [openTask?.id, openTask?.execution.runtimeProfileBinding?.profileId, openTask?.execution.runtimeProfileBinding?.revision, openTask?.execution.status]);

  useEffect(() => {
    if (!notice || actionError) return;
    const timer = window.setTimeout(() => setNotice(""), 3_500);
    return () => window.clearTimeout(timer);
  }, [actionError, notice]);

  if (loading || error || !snapshot) return <PageState loading={loading} error={error} />;
  const grouped = groupTasks(snapshot.tasks);
  const allTasks = snapshot.tasks;
  const agents = snapshot.agents;
  const selectedStatus = activeStatus ?? preferredTaskStatus(snapshot.tasks);
  const queuedSyncText = openTask ? taskSyncStateLabel(openTask.sync.status) : "";
  const enabledAdapters = snapshot.taskAdapterConnectors.filter((adapter) => adapter.enabled);
  const selectedAdapter = enabledAdapters.find((adapter) => adapter.id === selectedAdapterId) ?? null;
  const syncedAdapter = openTask?.sync.adapterId
    ? snapshot.taskAdapterConnectors.find((adapter) => adapter.id === openTask.sync.adapterId) ?? null
    : null;
  const executionUi = openTask ? deriveTaskExecutionUi(openTask, taskAgentReadiness) : null;
  const commandDisabledReason = draftDirty ? "請先儲存變更" : executionUi?.commandDisabledReason ?? null;
  const controlsLocked = Boolean(executionUi?.locked || detailBusy);

  function agentNameForTask(task: Task): string {
    if (!task.assigneeAgentId) return task.assignee ?? "未指派";
    return agents.find((agent) => agent.id === task.assigneeAgentId)?.name ?? task.assignee ?? "未知 Agent";
  }

  function updateDraft(changes: Partial<TaskDraftFields>) {
    if (!draft) return;
    const nextDraft = { ...draft, ...changes };
    setDraft(nextDraft);
    setDraftDirty(taskDraftHasChanges(nextDraft));
  }

  function selectStatus(status: TaskStatus) {
    taskMoveSelectionOwnershipRef.current.claimUserSelection();
    setActiveStatus(status);
  }

  function openDetail(task: Task) {
    dismissedDeepLinkRef.current = null;
    setOpenTaskId(task.id);
    setDraft(createTaskDraft(task));
    setDraftDirty(false);
    setDiscardRequested(false);
    setSelectedAdapterId("");
    setEvidenceDraft(emptyTaskEvidenceDraft);
    setDetailNotice("");
    setDetailError("");
    setTab("content");
    taskMoveSelectionOwnershipRef.current.claimUserSelection();
    setActiveStatus(task.status);
    const params = new URLSearchParams(searchParams.toString());
    params.set("taskId", task.id);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  function closeDetail() {
    if (openTaskId) dismissedDeepLinkRef.current = openTaskId;
    setOpenTaskId(null);
    setDraft(null);
    setDraftDirty(false);
    setDiscardRequested(false);
    setSelectedAdapterId("");
    setEvidenceDraft(emptyTaskEvidenceDraft);
    setTab("content");
    setDetailNotice("");
    setDetailError("");
    setDetailBusy(null);
    setTaskAgentReadiness(null);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("taskId");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function requestCloseDetail() {
    if (detailBusy) return;
    if (discardRequested) {
      setDiscardRequested(false);
      return;
    }
    if (taskDetailDirty) {
      setDiscardRequested(true);
      return;
    }
    closeDetail();
  }

  async function move(task: Task, status: TaskStatus) {
    if (pendingTaskId || task.execution.status === "queued" || task.execution.status === "running") return;
    const moveRequest = taskMoveSelectionOwnershipRef.current.beginMove();
    setPendingTaskId(task.id);
    setActionError("");
    setNotice("");
    try {
      await mutate(`/api/tasks/${task.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({
          status,
          position: grouped[status].length,
          expectedBoardRevision: task.boardRevision,
          expectedExecutionRevision: task.execution.revision
        })
      });
      if (taskMoveSelectionOwnershipRef.current.ownsSelection(moveRequest)) setActiveStatus(status);
      setNotice(`「${task.title}」已移至${columns.find((column) => column.status === status)?.label ?? "新狀態"}。`);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        try {
          setActionError(await refreshTaskBoardAfterConflict(refreshRequired));
        } catch {
          setActionError("看板已由其他操作更新，但最新狀態載入失敗，請重新整理後再試。");
        }
      } else {
        setActionError(cause instanceof Error ? cause.message : "無法移動任務。");
      }
    } finally {
      taskMoveSelectionOwnershipRef.current.finishMove(moveRequest);
      setPendingTaskId(null);
    }
  }

  async function onDragEnd(event: DragEndEvent) {
    const task = allTasks.find((item) => item.id === event.active.id);
    const status = event.over?.id as TaskStatus | undefined;
    if (task && status && columns.some((column) => column.status === status) && status !== task.status) await move(task, status);
  }

  async function patchTask(event: FormEvent<HTMLFormElement>, task: Task) {
    event.preventDefault();
    if (!draft || draft.taskId !== task.id) return;
    const preparedUpdate = prepareTaskDraftUpdate(draft, task);
    if (!preparedUpdate.ok && preparedUpdate.reason === "stale") {
      setDetailError(preparedUpdate.message);
      return;
    }
    if (executionUi?.locked) {
      setDetailError("Agent 執行期間不可修改任務設定。");
      return;
    }
    const title = draft.title.trim();
    const humanAssignee = draft.assignee.trim();
    const assigneeAgentId = draft.assigneeAgentId || null;
    if (!title) {
      setDetailError("請填寫任務標題。");
      return;
    }
    if (draft.executionProfile === "worker" && !draft.acceptanceCriteria.trim()) {
      setDetailError("Agent 產出必須填寫驗收條件。");
      return;
    }
    if (draft.executionProfile !== "manual" && !assigneeAgentId) {
      setDetailError("Agent 顧問與 Agent 產出必須指派 Agent。");
      return;
    }
    if (humanAssignee && assigneeAgentId) {
      setDetailError("人工負責人與 Agent 不可同時指派。");
      return;
    }

    if (!preparedUpdate.ok) {
      setDetailError(preparedUpdate.message);
      return;
    }

    setDetailBusy("patch");
    setDetailError("");
    setDetailNotice("");
    try {
      const updateOutcome = await resolveCommittedMutation(() => mutate<Task>(`/api/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify(preparedUpdate.patch)
      }));
      const updated = updateOutcome.result;
      setDraft(createTaskDraft(updated));
      setDraftDirty(false);
      setDetailNotice(updateOutcome.projectionFresh
        ? "任務已更新。"
        : "任務已更新，但最新資料刷新失敗；請重新整理以載入其他變更。");
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        try {
          await refreshRequired();
          setDetailError(staleTaskDraftMessage);
        } catch {
          setDetailError("任務已由其他操作更新，但最新內容載入失敗；目前畫面可能過期。");
        }
      } else {
        setDetailError(cause instanceof Error ? cause.message : "無法更新任務。");
      }
    } finally {
      setDetailBusy(null);
    }
  }

  function mergeLatestTaskContent() {
    if (!draft || !openTask) return;
    const rebased = rebaseTaskDraft(draft, openTask);
    if (!rebased.ok) {
      setDetailError(`${rebased.message} 衝突欄位：${rebased.conflictingFields.join("、")}。`);
      setDetailNotice("");
      return;
    }
    setDraft(rebased.draft);
    setDraftDirty(taskDraftHasChanges(rebased.draft));
    setDetailError("");
    setDetailNotice(rebased.rebased ? "已保留本機變更並合併最新內容。" : "草稿已是最新版本。");
  }

  function reloadLatestTaskContent() {
    if (!openTask) return;
    if (draftDirty && !window.confirm("重新載入會捨棄這份本機草稿，確定繼續？")) return;
    setDraft(createTaskDraft(openTask));
    setDraftDirty(false);
    setDetailError("");
    setDetailNotice("已載入最新任務內容。");
  }

  async function submitTaskExecutionCommand(task: Task, command: Exclude<TaskExecutionCommand, null>) {
    const currentUi = deriveTaskExecutionUi(task, taskAgentReadiness);
    if (currentUi.command !== command || detailBusy || draftDirty || currentUi.commandDisabledReason) return;
    let retry: TaskAgentRunRetryRequest | null = null;
    setDetailBusy(command === "approve" ? "approve" : "run");
    setDetailError("");
    setDetailNotice("");
    try {
      if (command === "approve") {
        const request = createTaskExecutionRequest(task, command);
        await mutate<Task>(request.path, request.init);
        setDetailNotice("Agent 產出已核准，尚未排程。");
        return;
      }

      setTaskAgentReadiness(taskAgentReadinessState(task, "checking"));
      const refreshedReadiness = await reloadTaskAgentReadiness(
        task,
        async (agentIds) => (await managementApi.getAgentReadinessBatch(agentIds)).results
      );
      setTaskAgentReadiness(refreshedReadiness);
      const refreshedUi = deriveTaskExecutionUi(task, refreshedReadiness);
      if (refreshedUi.command !== command || refreshedUi.commandDisabledReason) {
        setDetailError(refreshedUi.commandDisabledReason ?? "任務執行狀態已變更，請重新確認。");
        return;
      }

      const executionRevision = task.execution.revision;
      retry = taskAgentRunRetryOwnershipRef.current.acquire(
        task.id,
        executionRevision,
        () => taskRunIdempotencyKey(task.id)
      );
      const runRequest = createTaskExecutionRequest(task, command, retry.idempotencyKey);
      await mutate<{ task: Task; jobId: string; replayed: boolean }>(runRequest.path, runRequest.init);
      taskAgentRunRetryOwnershipRef.current.clear(retry);
      setDetailNotice(task.executionProfile === "advisor" ? "Agent 提案已排程。" : "Agent 產出已排程，完成後只會移至審查。");
    } catch (cause) {
      if (retry && cause instanceof CommittedMutationProjectionError) {
        taskAgentRunRetryOwnershipRef.current.clear(retry);
        setDetailNotice("Agent 已排程，但最新狀態刷新失敗；請重新整理以確認進度。");
      } else {
        if (retry && cause instanceof ApiError && cause.status < 500) {
          taskAgentRunRetryOwnershipRef.current.clear(retry);
        }
        setDetailError(cause instanceof Error
          ? cause.message
          : command === "approve"
            ? "無法核准 Agent 產出。"
            : "無法排程 Agent 產出。");
      }
      await refresh().catch(() => undefined);
    } finally {
      setDetailBusy(null);
    }
  }

  async function submitEvidence(event: FormEvent<HTMLFormElement>, task: Task) {
    event.preventDefault();
    const type = evidenceDraft.type;
    const label = evidenceDraft.label.trim();
    const reference = evidenceDraft.reference.trim();

    if (!label || !reference) {
      setDetailError("請填寫證據標題與內容。");
      return;
    }
    if (type !== "url" && type !== "note") {
      setDetailError("證據類型僅接受 URL 或備註。");
      return;
    }

    const requestPayload = { type, label, reference };
    const retryToken = evidenceRetryOwnershipRef.current.acquire(
      task.id,
      JSON.stringify(requestPayload),
      () => crypto.randomUUID()
    );

    setDetailBusy("evidence");
    setDetailError("");
    setDetailNotice("");
    try {
      await mutate(`/api/tasks/${task.id}/evidence`, {
        method: "POST",
        headers: { "Idempotency-Key": retryToken.idempotencyKey },
        body: JSON.stringify(requestPayload)
      });
      evidenceRetryOwnershipRef.current.clear(retryToken);
      setEvidenceDraft(emptyTaskEvidenceDraft);
      setDetailNotice("已新增證據。");
    } catch (cause) {
      if (cause instanceof CommittedMutationProjectionError) {
        evidenceRetryOwnershipRef.current.clear(retryToken);
        setEvidenceDraft(emptyTaskEvidenceDraft);
        setDetailNotice("已新增證據，但最新列表刷新失敗；請重新整理以載入最新資料。");
      } else {
        if (cause instanceof ApiError && cause.status < 500) evidenceRetryOwnershipRef.current.clear(retryToken);
        setDetailError(cause instanceof Error ? cause.message : "無法新增證據。");
      }
    } finally {
      setDetailBusy(null);
    }
  }

  async function syncTask(task: Task) {
    if (detailBusy) return;
    if (draftDirty) {
      setDetailError("請先儲存變更後再同步。");
      return;
    }
    if (!selectedAdapter) {
      setDetailError("請先在設定建立 Task Adapter。");
      return;
    }
    if (!canSubmitTaskSync(task, true, false)) {
      setDetailError("任務執行或同步進行中，暫時無法再次同步。");
      return;
    }
    setDetailBusy("sync");
    setDetailError("");
    setDetailNotice("");
    try {
      await mutate(`/api/tasks/${task.id}/sync`, {
        method: "POST",
        body: JSON.stringify({
          adapterId: selectedAdapter.id,
          expectedRevision: task.revision,
          expectedStatus: task.status,
          expectedApprovalState: task.approvalState,
          expectedSyncAttemptCount: task.sync.attemptCount
        })
      });
      setSelectedAdapterId("");
      setDetailNotice("已提交同步，排程中將自動刷新。");
    } catch (cause) {
      if (cause instanceof CommittedMutationProjectionError) {
        setSelectedAdapterId("");
        setDetailNotice("同步已提交，但最新狀態刷新失敗；請重新整理以確認排程進度。");
      } else if (cause instanceof ApiError && cause.status === 409) {
        try {
          await refreshRequired();
          setDetailError("任務已由其他操作更新。已載入最新內容，請確認後再同步。");
        } catch {
          setDetailError("任務已由其他操作更新，但最新內容載入失敗；目前畫面可能過期。");
        }
      } else {
        setDetailError(cause instanceof Error ? cause.message : "無法提交同步。");
      }
    } finally {
      setDetailBusy(null);
    }
  }

  const canSync = openTask
    ? canSubmitTaskSync(openTask, Boolean(selectedAdapter), draftDirty)
    : false;

  const projectionStatus = taskProjectionStatusLabel({
    stale: platformProjectionStale,
    refreshing: platformProjectionRefreshing,
    lastSuccessfulAt: platformProjectionLastSuccessfulAt
  });

  return <main className="workspace-page"><header className="page-header"><div><span className="eyebrow">會議後續</span><h1>任務</h1></div><div className="task-page-header-state">{projectionStatus && <span className={`task-projection-status ${platformProjectionStale ? "stale" : ""}`} role={platformProjectionStale ? "alert" : "status"}>{platformProjectionStale && <AlertTriangle size={13} />}{projectionStatus}</span>}{platformProjectionStale && <button className="icon-button" type="button" disabled={platformProjectionRefreshing} onClick={() => void refreshRequired().catch(() => undefined)} aria-label="重新整理任務資料" title="重新整理任務資料"><RefreshCw size={14} className={platformProjectionRefreshing ? "spin-icon" : undefined} /></button>}<span className="page-count">{pendingTaskId ? "更新中" : `${snapshot.tasks.length} 項`}</span></div></header>
    <SourceContextBar source={sourceContext} label="目前從正式會議進入任務看板" />
    <ActionNotice message={actionError || notice} error={Boolean(actionError)} />
    <TaskStatusTabs selectedStatus={selectedStatus} counts={{ todo: grouped.todo.length, in_progress: grouped.in_progress.length, review: grouped.review.length, done: grouped.done.length }} onSelect={selectStatus} />
    <DndContext sensors={sensors} onDragEnd={(event) => void onDragEnd(event)}>
      <div className="kanban-board">
        {columns.map((column) => <TaskColumn key={column.status} {...column} active={selectedStatus === column.status} tasks={grouped[column.status]} pendingTaskId={pendingTaskId} agentNameForTask={agentNameForTask} onMove={(task, status) => void move(task, status)} onOpen={openDetail} />)}
      </div>
    </DndContext>

    <Modal
      title={discardRequested ? "捨棄未儲存變更？" : openTask ? `${openTask.title} 工作詳情` : "任務詳情"}
      open={Boolean(openTask)}
      onClose={requestCloseDetail}
      closeDisabled={detailBusy !== null}
      focusKey={discardRequested ? "discard-confirmation" : tab}
      variant="drawer"
    >
      {openTask && discardRequested && <div className="task-discard-confirmation" role="alert">
        <p>這份任務草稿尚未儲存。捨棄後無法復原。</p>
        <div className="form-actions">
          <button type="button" className="secondary-button" onClick={() => setDiscardRequested(false)}>繼續編輯</button>
          <button type="button" className="primary-button danger-button" onClick={closeDetail}>捨棄變更</button>
        </div>
      </div>}
      {openTask && !discardRequested && <>
        <ActionNotice message={detailError || detailNotice} error={Boolean(detailError)} />
        <TaskDetailTabs activeTab={tab} onSelect={setTab} />
        <section id="task-detail-panel-content" role="tabpanel" aria-labelledby="task-detail-tab-content" className="task-panel" tabIndex={0} hidden={tab !== "content"}>
          {draft && <form className="form-stack task-detail-form" onSubmit={(event) => void patchTask(event, openTask)}>
            {executionUi && <TaskExecutionBand
              task={openTask}
              executionUi={executionUi}
              commandDisabledReason={commandDisabledReason}
              disabled={detailBusy !== null}
              commandBusy={detailBusy === (executionUi.command === "approve" ? "approve" : "run")}
              runtimeRun={runtimeRun}
              onRuntimeUpdated={setRuntimeRun}
              onCommand={(command) => void submitTaskExecutionCommand(openTask, command)}
            />}
            <label>標題<input name="title" required value={draft.title} disabled={controlsLocked} onChange={(event) => updateDraft({ title: event.target.value })} /></label>
            <fieldset className="task-assignment-fields" disabled={controlsLocked}>
              <legend>執行與負責人</legend>
              <div className="form-grid">
                <label>執行方式<select name="executionProfile" value={draft.executionProfile} onChange={(event) => {
                  const executionProfile = event.target.value as TaskExecutionProfile;
                  updateDraft({ executionProfile, ...(executionProfile === "manual" ? {} : { assignee: "" }) });
                }}><option value="manual">人工處理</option><option value="advisor">Agent 顧問</option><option value="worker">Agent 產出</option></select></label>
                <label>Agent 負責人<select name="assigneeAgentId" value={draft.assigneeAgentId} onChange={(event) => updateDraft({ assigneeAgentId: event.target.value, ...(event.target.value ? { assignee: "" } : {}) })}>
                  <option value="">不指派 Agent</option>
                  {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                </select></label>
              </div>
              {draft.executionProfile === "manual" && <label>人工負責人<input name="assignee" value={draft.assignee} disabled={Boolean(draft.assigneeAgentId)} placeholder={draft.assigneeAgentId ? "已指派 Agent" : "輸入人員名稱"} onChange={(event) => updateDraft({ assignee: event.target.value, ...(event.target.value ? { assigneeAgentId: "" } : {}) })} /></label>}
            </fieldset>
            <label>到期日<input name="dueAt" type="datetime-local" value={draft.dueAt} disabled={controlsLocked} onChange={(event) => updateDraft({ dueAt: event.target.value })} /></label>
            <label>工作說明<textarea name="description" rows={3} value={draft.description} disabled={controlsLocked} onChange={(event) => updateDraft({ description: event.target.value })} /></label>
            <label>驗收條件<textarea name="acceptanceCriteria" rows={3} value={draft.acceptanceCriteria} disabled={controlsLocked} onChange={(event) => updateDraft({ acceptanceCriteria: event.target.value })} /></label>
            <label>規劃工具（本階段不會執行）<input name="allowedTools" value={draft.allowedTools} disabled={controlsLocked} onChange={(event) => updateDraft({ allowedTools: event.target.value })} /></label>
            <label>執行邊界<textarea name="dataScope" rows={3} value={draft.dataScope} disabled={controlsLocked} onChange={(event) => updateDraft({ dataScope: event.target.value })} /></label>
            <div className="task-sync-detail">
              <div><span>外部同步</span><strong>{queuedSyncText}</strong><small>{openTask.sync.lastError ?? syncedAdapter?.name ?? "次要操作，需明確選擇 Adapter。"}</small></div>
              <label>Task Adapter<select value={selectedAdapterId} disabled={detailBusy !== null || executionUi?.active} onChange={(event) => setSelectedAdapterId(event.target.value)}><option value="">選擇 Adapter</option>{enabledAdapters.map((adapter) => <option key={adapter.id} value={adapter.id}>{adapter.name}</option>)}</select></label>
              <button type="button" className="secondary-button" onClick={() => void syncTask(openTask)} disabled={detailBusy !== null || !canSync}>{detailBusy === "sync" ? <><LoaderCircle size={14} className="spin-icon" />提交中</> : queuedSyncText === "已同步" ? "再次同步" : "同步至 Adapter"}</button>
            </div>
            <div className="form-actions">
              {draftStale && <><button type="button" className="secondary-button" disabled={detailBusy !== null} onClick={reloadLatestTaskContent}>重新載入最新內容</button><button type="button" className="secondary-button" disabled={detailBusy !== null} onClick={mergeLatestTaskContent}>合併最新內容</button></>}
              <button className="primary-button" disabled={detailBusy !== null || executionUi?.locked || !draftDirty || draftStale}><Save size={13} />{detailBusy === "patch" ? <><LoaderCircle size={13} className="spin-icon" />儲存中</> : "儲存變更"}</button>
            </div>
          </form>}
        </section>

        <section id="task-detail-panel-evidence" role="tabpanel" aria-labelledby="task-detail-tab-evidence" className="task-panel" tabIndex={0} hidden={tab !== "evidence"}>
          <ul className="task-evidence-list">
            {openTask.evidence.map((item) => {
              const agentOutput = item.addedBy === "system" && Boolean(item.agentId);
              const Icon = agentOutput ? Bot : item.type === "url" ? Link2 : FileText;
              const typeLabel = item.type === "meeting" ? "來源會議" : item.type === "decision" ? "來源決議" : item.type === "url" ? "URL" : agentOutput ? "Agent 產出" : "備註";
              const sourceDecision = item.type === "decision"
                ? snapshot.decisions.find((decision) => decision.id === item.reference)
                : null;
              const sourceMeetingId = item.type === "meeting" ? item.reference : sourceDecision?.meetingId ?? null;
              const sourceMeeting = sourceMeetingId ? snapshot.meetings.find((meeting) => meeting.id === sourceMeetingId) : null;
              const reference = item.type === "meeting"
                ? sourceMeeting?.title ?? item.reference
                : item.type === "decision"
                  ? sourceDecision?.title ?? item.reference
                  : item.reference;
              return <li key={item.id} className={agentOutput ? "agent-output" : undefined}><div className="task-evidence-meta"><Icon size={12} />{typeLabel}<span>· {item.addedBy === "owner" ? "Owner" : "System"}</span>{agentOutput && <b>未驗證</b>}</div><span>{item.label}</span>{item.type === "url" ? <a href={reference} target="_blank" rel="noreferrer">{reference}</a> : sourceMeeting ? <Link href={buildMeetingWorkspaceHref({ meetingId: sourceMeeting.id, threadId: sourceMeeting.threadId, fromGoalId: sourceContext.goalId, view: "meeting" })}>{reference}</Link> : <small>{reference}</small>}</li>;
            })}
            {!openTask.evidence.length && <li className="task-empty">尚無證據。</li>}
          </ul>
          <form className="form-stack task-detail-form" onSubmit={(event) => void submitEvidence(event, openTask)}>
            <label>類型<select name="type" value={evidenceDraft.type} disabled={detailBusy !== null} onChange={(event) => setEvidenceDraft((current) => ({ ...current, type: event.target.value as TaskEvidenceDraft["type"] }))}><option value="url">URL</option><option value="note">備註</option></select></label>
            <label>標題<input name="label" required value={evidenceDraft.label} disabled={detailBusy !== null} onChange={(event) => setEvidenceDraft((current) => ({ ...current, label: event.target.value }))} /></label>
            <label>內容
              <textarea name="reference" rows={3} required value={evidenceDraft.reference} disabled={detailBusy !== null} onChange={(event) => setEvidenceDraft((current) => ({ ...current, reference: event.target.value }))} placeholder="請輸入 URL 或文字備註" />
            </label>
            <div className="form-actions">
              <button className="primary-button" disabled={detailBusy !== null}>
                {detailBusy === "evidence" ? <><LoaderCircle size={13} className="spin-icon" />提交中</> : <Send size={13} />}新增證據
              </button>
            </div>
          </form>
        </section>

        <section id="task-detail-panel-history" role="tabpanel" aria-labelledby="task-detail-tab-history" className="task-panel" tabIndex={0} hidden={tab !== "history"}>
          <ul className="task-transition-list">
            {orderedTaskTransitions(openTask).map((transition) => <li key={transition.id}><div><span>{taskTransitionLabel(transition.type)}</span><time dateTime={transition.at}>{dueDateLabel(transition.at)}</time></div><p>{taskTransitionSummary(transition)}</p></li>)}
            {!openTask.transitions.length && <li><div>尚無歷程紀錄。</div></li>}
          </ul>
        </section>
      </>}
    </Modal>
  </main>;
}
