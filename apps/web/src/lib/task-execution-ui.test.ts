import { describe, expect, it, vi } from "vitest";
import type { AgentReadiness, Task, TaskTransition } from "@council/contracts";
import {
  createTaskExecutionRequest,
  deriveTaskExecutionUi,
  reloadTaskAgentReadiness,
  taskAgentReadinessState,
  taskTransitionLabel,
  taskTransitionSummary
} from "./task-execution-ui.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task",
    meetingId: "meeting",
    decisionId: "decision",
    revision: 1,
    boardRevision: 1,
    title: "整理架構建議",
    description: "",
    status: "todo",
    position: 0,
    assignee: null,
    assigneeAgentId: "11111111-1111-4111-8111-111111111111",
    dueAt: null,
    acceptanceCriteria: "",
    evidence: [],
    executionProfile: "manual",
    allowedTools: [],
    dataScope: "",
    approvalState: "not_required",
    execution: {
      revision: 0,
      status: "idle",
      jobId: null,
      requestFingerprint: null,
      agentId: null,
      profile: null,
      attemptCount: 0,
      requestedAt: null,
      startedAt: null,
      completedAt: null,
      lastError: null,
      resultEvidenceId: null
    },
    transitions: [],
    sync: {
      status: "not_synced",
      adapterId: null,
      jobId: null,
      requestFingerprint: null,
      externalId: null,
      attemptCount: 0,
      lastAttemptAt: null,
      lastError: null,
      syncedAt: null
    },
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...overrides
  };
}

function readiness(status: AgentReadiness["status"]): AgentReadiness {
  return {
    status,
    checks: status === "ready"
      ? [{ code: "runtime", status: "passed", message: "Runtime Profile 可用。" }]
      : status === "warning"
        ? [{ code: "runtime", status: "warning", message: "Runtime Profile 尚未完成健康檢查。" }]
        : [
            { code: "runtime", status: "blocked", message: "Runtime Profile 已停用。" },
            { code: "credential", status: "blocked", message: "Credential 已撤銷。" }
          ]
  };
}

describe("Task execution UI", () => {
  it("never offers an Agent command for manual Tasks", () => {
    expect(deriveTaskExecutionUi(task())).toMatchObject({
      active: false,
      locked: false,
      statusLabel: "人工處理",
      command: null,
      commandLabel: null
    });
  });

  it("offers proposal, retry, and rerun commands for Advisor Tasks", () => {
    const advisor = task({ executionProfile: "advisor" });
    expect(deriveTaskExecutionUi(advisor)).toMatchObject({ command: "run", commandLabel: "請 Agent 提案" });
    expect(deriveTaskExecutionUi(
      task({ executionProfile: "advisor", approvalState: "pending" }),
      taskAgentReadinessState(advisor, readiness("ready"))
    )).toMatchObject({ command: "run", commandLabel: "請 Agent 提案", commandDisabledReason: null });
    expect(deriveTaskExecutionUi(task({
      executionProfile: "advisor",
      execution: { ...advisor.execution, status: "failed", lastError: "provider_error" }
    }))).toMatchObject({ statusLabel: "提案失敗", command: "retry", commandLabel: "重試" });
    expect(deriveTaskExecutionUi(task({
      executionProfile: "advisor",
      execution: { ...advisor.execution, status: "completed", resultEvidenceId: "evidence" }
    }))).toMatchObject({ statusLabel: "提案已保存", command: "rerun", commandLabel: "再次提案" });
  });

  it("separates Worker approval from run into two explicit persisted commands", () => {
    const worker = task({ executionProfile: "worker", approvalState: "pending", acceptanceCriteria: "Owner 核對輸出內容" });
    expect(deriveTaskExecutionUi(worker)).toMatchObject({
      statusLabel: "待 Owner 核准",
      command: "approve",
      commandLabel: "核准產出"
    });

    const approvalRequest = createTaskExecutionRequest(worker, "approve");
    expect(approvalRequest.path).toBe(`/api/tasks/${worker.id}/approval`);
    expect(approvalRequest.init.method).toBe("POST");
    expect(JSON.parse(String(approvalRequest.init.body))).toEqual({
      expectedExecutionRevision: worker.execution.revision,
      action: "approve"
    });

    const approved = task({ executionProfile: "worker", approvalState: "approved", acceptanceCriteria: "Owner 核對輸出內容" });
    expect(deriveTaskExecutionUi(approved, taskAgentReadinessState(approved, readiness("ready")))).toMatchObject({
      statusLabel: "已核准，待產出",
      command: "run",
      commandLabel: "產出",
      commandDisabledReason: null
    });

    const runRequest = createTaskExecutionRequest(approved, "run", "run-key");
    expect(runRequest.path).toBe(`/api/tasks/${approved.id}/run`);
    expect(runRequest.init.headers).toEqual({ "Idempotency-Key": "run-key" });
    expect(deriveTaskExecutionUi(task({
      executionProfile: "worker",
      approvalState: "approved",
      execution: { ...worker.execution, status: "failed", lastError: "timeout" }
    }), taskAgentReadinessState(worker, readiness("ready")))).toMatchObject({ statusLabel: "產出失敗", command: "retry", commandLabel: "重試" });
  });

  it("requires acceptance criteria before a Worker command can run", () => {
    expect(deriveTaskExecutionUi(task({
      executionProfile: "worker",
      approvalState: "pending",
      acceptanceCriteria: "   "
    }))).toMatchObject({
      command: "approve",
      commandDisabledReason: "請先填寫驗收條件"
    });
  });

  it("fails run commands closed until published Agent readiness is ready or warning", () => {
    const worker = task({
      executionProfile: "worker",
      approvalState: "approved",
      acceptanceCriteria: "Owner 核對輸出內容"
    });

    expect(deriveTaskExecutionUi(worker)).toMatchObject({
      readiness: { status: "checking", summary: "Agent readiness：檢查中。" },
      command: "run",
      commandDisabledReason: "Agent readiness 檢查中"
    });
    expect(deriveTaskExecutionUi(worker, taskAgentReadinessState(worker, readiness("warning")))).toMatchObject({
      readiness: { status: "warning", summary: expect.stringContaining("Agent readiness：warning") },
      command: "run",
      commandDisabledReason: null
    });
    expect(deriveTaskExecutionUi(worker, taskAgentReadinessState(worker, readiness("blocked")))).toMatchObject({
      readiness: { status: "blocked", summary: "Agent readiness：blocked · Runtime Profile 已停用。" },
      command: "run",
      commandDisabledReason: "Agent readiness blocked：Runtime Profile 已停用。"
    });
    expect(deriveTaskExecutionUi(worker, taskAgentReadinessState(worker, "unavailable"))).toMatchObject({
      readiness: { status: "unavailable", summary: "Agent readiness：無法完成檢查，暫停執行。" },
      command: "run",
      commandDisabledReason: "無法完成 Agent readiness 檢查"
    });
  });

  it("treats readiness for a different persisted assignee or profile as still checking", () => {
    const advisor = task({ executionProfile: "advisor" });
    const previousReadiness = taskAgentReadinessState(advisor, readiness("ready"));
    const reassigned = task({
      executionProfile: "advisor",
      assigneeAgentId: "22222222-2222-4222-8222-222222222222"
    });
    const changedProfile = task({ executionProfile: "worker", approvalState: "approved", acceptanceCriteria: "驗收" });

    expect(deriveTaskExecutionUi(reassigned, previousReadiness)).toMatchObject({
      readiness: { status: "checking" },
      commandDisabledReason: "Agent readiness 檢查中"
    });
    expect(deriveTaskExecutionUi(changedProfile, previousReadiness)).toMatchObject({
      readiness: { status: "checking" },
      commandDisabledReason: "Agent readiness 檢查中"
    });
  });

  it("reloads published Agent readiness immediately before a run command", async () => {
    const worker = task({
      executionProfile: "worker",
      approvalState: "approved",
      acceptanceCriteria: "Owner 核對輸出內容"
    });
    const load = vi.fn()
      .mockResolvedValueOnce([{ agentId: worker.assigneeAgentId!, readiness: readiness("ready") }])
      .mockResolvedValueOnce([{ agentId: worker.assigneeAgentId!, readiness: readiness("blocked") }]);

    await expect(reloadTaskAgentReadiness(worker, load)).resolves.toMatchObject({ status: "ready" });
    const refreshed = await reloadTaskAgentReadiness(worker, load);
    expect(deriveTaskExecutionUi(worker, refreshed)).toMatchObject({
      command: "run",
      commandDisabledReason: "Agent readiness blocked：Runtime Profile 已停用。"
    });
    expect(load).toHaveBeenNthCalledWith(2, [worker.assigneeAgentId]);
  });

  it("fails a readiness reload closed when the batch result is incomplete", async () => {
    const worker = task({ executionProfile: "advisor" });
    await expect(reloadTaskAgentReadiness(worker, async () => [])).resolves.toMatchObject({
      status: "unavailable"
    });
  });

  it("locks controls while queued or running and identifies missing assignments", () => {
    const advisor = task({ executionProfile: "advisor" });
    expect(deriveTaskExecutionUi(task({
      executionProfile: "advisor",
      execution: { ...advisor.execution, status: "queued" }
    }))).toMatchObject({ active: true, locked: true, statusLabel: "已排程", command: null });
    expect(deriveTaskExecutionUi(task({
      executionProfile: "advisor",
      execution: { ...advisor.execution, status: "running" }
    }))).toMatchObject({ active: true, locked: true, statusLabel: "Agent 提案中", command: null });
    expect(deriveTaskExecutionUi(task({ executionProfile: "advisor", assigneeAgentId: null, assignee: null }))).toMatchObject({
      command: "run",
      commandDisabledReason: "請先指派 Agent"
    });
  });

  it("renders new transitions in readable Chinese without leaking field keys", () => {
    const updated = {
      id: "transition",
      type: "updated",
      actor: "owner",
      at: "2026-07-20T00:00:00.000Z",
      note: "assigneeAgentId,acceptanceCriteria,executionProfile"
    } satisfies TaskTransition;
    expect(taskTransitionLabel("agent_run_requested")).toBe("已排程 Agent");
    expect(taskTransitionLabel("agent_run_completed")).toBe("Agent 產出完成");
    expect(taskTransitionSummary(updated)).toBe("更新：Agent 負責人、驗收條件、執行方式");
    expect(taskTransitionSummary({ ...updated, type: "approval_changed", fromApprovalState: "pending", toApprovalState: "approved" })).toBe("核准狀態由待核准改為已核准");
    expect(taskTransitionSummary({ ...updated, type: "agent_run_failed", note: "provider_timeout" })).toBe("Agent 產出失敗，請檢查模型連線後重試。");
  });
});
