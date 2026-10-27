import type {
  AgentReadiness,
  PublicTask as Task,
  TaskApprovalState,
  TaskExecutionProfile,
  TaskStatus,
  PublicTaskTransition as TaskTransition
} from "@council/contracts";

export type TaskExecutionCommand = "approve" | "run" | "retry" | "rerun" | null;
export type TaskExecutionTone = "neutral" | "queued" | "running" | "completed" | "failed";
export type TaskAgentReadinessStatus = AgentReadiness["status"] | "checking" | "unavailable";

type AgentTaskExecutionProfile = Exclude<TaskExecutionProfile, "manual">;

export interface TaskAgentReadinessState {
  taskId: string;
  assigneeAgentId: string;
  executionProfile: AgentTaskExecutionProfile;
  status: TaskAgentReadinessStatus;
  reason: string | null;
}

export interface TaskExecutionReadinessUi {
  status: TaskAgentReadinessStatus;
  summary: string;
  commandDisabledReason: string | null;
}

export interface TaskExecutionUi {
  active: boolean;
  locked: boolean;
  statusLabel: string;
  tone: TaskExecutionTone;
  command: TaskExecutionCommand;
  commandLabel: string | null;
  commandDisabledReason: string | null;
  readiness: TaskExecutionReadinessUi | null;
}

export interface TaskExecutionRequest {
  path: string;
  init: RequestInit;
}

const taskStatusLabels: Record<TaskStatus, string> = {
  todo: "待辦",
  in_progress: "進行中",
  review: "審查",
  done: "完成"
};

const approvalLabels: Record<TaskApprovalState, string> = {
  not_required: "不需核准",
  pending: "待核准",
  approved: "已核准",
  rejected: "已拒絕"
};

const updatedFieldLabels: Record<string, string> = {
  title: "標題",
  description: "工作說明",
  assignee: "負責人",
  assigneeAgentId: "Agent 負責人",
  dueAt: "到期日",
  acceptanceCriteria: "驗收條件",
  executionProfile: "執行方式",
  allowedTools: "規劃工具",
  dataScope: "執行邊界"
};

function idleCommand(task: Task): Pick<TaskExecutionUi, "statusLabel" | "command" | "commandLabel"> {
  if (task.executionProfile === "manual") {
    return { statusLabel: "人工處理", command: null, commandLabel: null };
  }
  if (task.executionProfile === "advisor") {
    return { statusLabel: "尚未提案", command: "run", commandLabel: "請 Agent 提案" };
  }
  if (task.approvalState === "approved") {
    return { statusLabel: "已核准，待產出", command: "run", commandLabel: "產出" };
  }
  return {
    statusLabel: task.approvalState === "rejected" ? "已拒絕，待重新核准" : "待 Owner 核准",
    command: "approve",
    commandLabel: "核准產出"
  };
}

function agentTaskIdentity(task: Task): Omit<TaskAgentReadinessState, "status" | "reason"> | null {
  if (task.executionProfile === "manual" || !task.assigneeAgentId) return null;
  return {
    taskId: task.id,
    assigneeAgentId: task.assigneeAgentId,
    executionProfile: task.executionProfile
  };
}

export function taskAgentReadinessState(
  task: Task,
  result: AgentReadiness | "checking" | "unavailable"
): TaskAgentReadinessState | null {
  const identity = agentTaskIdentity(task);
  if (!identity) return null;
  if (typeof result === "string") return { ...identity, status: result, reason: null };

  const reasonStatus = result.status === "blocked" ? "blocked" : result.status === "warning" ? "warning" : null;
  const reason = reasonStatus
    ? result.checks.find((check) => check.status === reasonStatus)?.message
      ?? (reasonStatus === "blocked" ? "Agent readiness 未通過。" : null)
    : null;
  return { ...identity, status: result.status, reason };
}

export async function reloadTaskAgentReadiness(
  task: Task,
  loadReadinessBatch: (agentIds: readonly string[]) => Promise<readonly { agentId: string; readiness: AgentReadiness }[]>
): Promise<TaskAgentReadinessState | null> {
  const identity = agentTaskIdentity(task);
  if (!identity) return null;
  try {
    const results = await loadReadinessBatch([identity.assigneeAgentId]);
    if (results.length !== 1 || results[0]?.agentId !== identity.assigneeAgentId) {
      throw new Error("Agent readiness batch response did not match the Task assignee.");
    }
    return taskAgentReadinessState(task, results[0].readiness);
  } catch {
    return taskAgentReadinessState(task, "unavailable");
  }
}

function readinessForTask(task: Task, state: TaskAgentReadinessState | null | undefined): TaskAgentReadinessState | null {
  const identity = agentTaskIdentity(task);
  if (!identity) return null;
  if (
    !state
    || state.taskId !== identity.taskId
    || state.assigneeAgentId !== identity.assigneeAgentId
    || state.executionProfile !== identity.executionProfile
  ) {
    return { ...identity, status: "checking", reason: null };
  }
  return state;
}

function readinessUi(state: TaskAgentReadinessState | null): TaskExecutionReadinessUi | null {
  if (!state) return null;
  if (state.status === "checking") {
    return {
      status: state.status,
      summary: "Agent readiness：檢查中。",
      commandDisabledReason: "Agent readiness 檢查中"
    };
  }
  if (state.status === "unavailable") {
    return {
      status: state.status,
      summary: "Agent readiness：無法完成檢查，暫停執行。",
      commandDisabledReason: "無法完成 Agent readiness 檢查"
    };
  }
  if (state.status === "blocked") {
    const reason = state.reason ?? "Agent readiness 未通過。";
    return {
      status: state.status,
      summary: `Agent readiness：blocked · ${reason}`,
      commandDisabledReason: `Agent readiness blocked：${reason}`
    };
  }
  if (state.status === "warning") {
    return {
      status: state.status,
      summary: `Agent readiness：warning${state.reason ? ` · ${state.reason}` : ""}；可執行，Server 仍會再次授權。`,
      commandDisabledReason: null
    };
  }
  return {
    status: state.status,
    summary: "Agent readiness：ready；Server 仍會再次授權。",
    commandDisabledReason: null
  };
}

function isRunCommand(command: TaskExecutionCommand): command is "run" | "retry" | "rerun" {
  return command === "run" || command === "retry" || command === "rerun";
}

export function deriveTaskExecutionUi(task: Task, agentReadiness?: TaskAgentReadinessState | null): TaskExecutionUi {
  const active = task.execution.status === "queued" || task.execution.status === "running";
  let state: Pick<TaskExecutionUi, "statusLabel" | "tone" | "command" | "commandLabel">;

  if (task.executionProfile === "manual") {
    state = { ...idleCommand(task), tone: "neutral" };
  } else if (task.execution.status === "queued") {
    state = { statusLabel: "已排程", tone: "queued", command: null, commandLabel: null };
  } else if (task.execution.status === "running") {
    state = {
      statusLabel: task.executionProfile === "advisor" ? "Agent 提案中" : "Agent 產出中",
      tone: "running",
      command: null,
      commandLabel: null
    };
  } else if (task.execution.status === "completed") {
    state = task.executionProfile === "advisor"
      ? { statusLabel: "提案已保存", tone: "completed", command: "rerun", commandLabel: "再次提案" }
      : { statusLabel: "產出待審查", tone: "completed", command: null, commandLabel: null };
  } else if (task.execution.status === "failed") {
    state = {
      statusLabel: task.executionProfile === "advisor" ? "提案失敗" : "產出失敗",
      tone: "failed",
      command: "retry",
      commandLabel: "重試"
    };
  } else {
    state = { ...idleCommand(task), tone: "neutral" };
  }

  const readiness = readinessUi(readinessForTask(task, agentReadiness));
  let commandDisabledReason: string | null = null;
  if (state.command && !task.assigneeAgentId) commandDisabledReason = "請先指派 Agent";
  if (state.command && task.executionProfile === "worker" && !task.acceptanceCriteria.trim()) {
    commandDisabledReason = "請先填寫驗收條件";
  }
  if (state.command && task.status === "done") commandDisabledReason = "已完成任務不可執行 Agent";
  if (!commandDisabledReason && isRunCommand(state.command) && readiness?.commandDisabledReason) {
    commandDisabledReason = readiness.commandDisabledReason;
  }

  return {
    active,
    locked: active,
    ...state,
    commandDisabledReason,
    readiness
  };
}

export function createTaskExecutionRequest(
  task: Task,
  command: Exclude<TaskExecutionCommand, null>,
  idempotencyKey?: string
): TaskExecutionRequest {
  if (command === "approve") {
    return {
      path: `/api/tasks/${task.id}/approval`,
      init: {
        method: "POST",
        body: JSON.stringify({ expectedExecutionRevision: task.execution.revision, action: "approve" })
      }
    };
  }
  if (!idempotencyKey) throw new Error("Agent run requires an idempotency key.");
  return {
    path: `/api/tasks/${task.id}/run`,
    init: {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ expectedExecutionRevision: task.execution.revision })
    }
  };
}

export function taskTransitionLabel(type: TaskTransition["type"]): string {
  const labels: Record<TaskTransition["type"], string> = {
    created: "建立任務",
    updated: "更新任務",
    moved: "狀態變更",
    evidence_added: "補充證據",
    approval_changed: "Owner 核准",
    agent_run_requested: "已排程 Agent",
    agent_run_started: "Agent 開始產出",
    agent_run_completed: "Agent 產出完成",
    agent_run_failed: "Agent 產出失敗",
    sync_requested: "發起外部同步",
    sync_succeeded: "外部同步完成",
    sync_failed: "外部同步失敗"
  };
  return labels[type];
}

function profileAction(note?: string): "提案" | "產出" {
  return note === "advisor" ? "提案" : "產出";
}

export function taskTransitionSummary(transition: TaskTransition): string {
  if (transition.type === "created") return "任務已建立。";
  if (transition.type === "updated") {
    const labels = [...new Set((transition.note ?? "")
      .split(",")
      .map((field) => updatedFieldLabels[field.trim()])
      .filter((label): label is string => Boolean(label)))];
    return labels.length ? `更新：${labels.join("、")}` : "任務內容已更新。";
  }
  if (transition.type === "moved") {
    const from = transition.fromStatus ? taskStatusLabels[transition.fromStatus] : "原狀態";
    const to = transition.toStatus ? taskStatusLabels[transition.toStatus] : "新狀態";
    return `由${from}移至${to}`;
  }
  if (transition.type === "evidence_added") return transition.note ? `已新增證據「${transition.note}」` : "已新增證據。";
  if (transition.type === "approval_changed") {
    const from = transition.fromApprovalState ? approvalLabels[transition.fromApprovalState] : "未設定";
    const to = transition.toApprovalState ? approvalLabels[transition.toApprovalState] : "未設定";
    return `核准狀態由${from}改為${to}`;
  }
  if (transition.type === "agent_run_requested") return `Agent ${profileAction(transition.note)}已排程。`;
  if (transition.type === "agent_run_started") return `Agent ${profileAction(transition.note)}已開始。`;
  if (transition.type === "agent_run_completed") return `Agent ${profileAction(transition.note)}已保存為未驗證證據。`;
  if (transition.type === "agent_run_failed") return "Agent 產出失敗，請檢查模型連線後重試。";
  if (transition.type === "sync_requested") return "已提交至外部 Adapter 排程。";
  if (transition.type === "sync_succeeded") return "外部 Adapter 已完成同步。";
  return "外部 Adapter 同步失敗。";
}
