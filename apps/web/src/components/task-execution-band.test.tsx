import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentReadiness, Task } from "@council/contracts";
import { TaskExecutionBand } from "./task-execution-band";
import { deriveTaskExecutionUi, taskAgentReadinessState } from "../lib/task-execution-ui";

function workerTask(overrides: Partial<Task> = {}): Task {
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
    acceptanceCriteria: "Owner 核對輸出內容",
    evidence: [],
    executionProfile: "worker",
    allowedTools: [],
    dataScope: "",
    approvalState: "approved",
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

function readiness(status: "warning" | "blocked"): AgentReadiness {
  return {
    status,
    checks: [{
      code: "runtime",
      status,
      message: status === "blocked" ? "Runtime Profile 已停用。" : "Runtime Profile 尚未完成健康檢查。"
    }]
  };
}

describe("TaskExecutionBand", () => {
  it("shows the first blocked reason and disables run", () => {
    const task = workerTask();
    const executionUi = deriveTaskExecutionUi(task, taskAgentReadinessState(task, readiness("blocked")));
    const markup = renderToStaticMarkup(createElement(TaskExecutionBand, {
      task,
      executionUi,
      commandDisabledReason: executionUi.commandDisabledReason,
      disabled: false,
      commandBusy: false,
      onCommand() {}
    }));

    expect(markup).toContain("Agent readiness：blocked · Runtime Profile 已停用。");
    expect(markup).toContain("disabled=\"\"");
    expect(markup).toContain("產出</button>");
    expect(markup).not.toContain("核准並產出");
  });

  it("shows warning clearly without disabling run", () => {
    const task = workerTask();
    const executionUi = deriveTaskExecutionUi(task, taskAgentReadinessState(task, readiness("warning")));
    const markup = renderToStaticMarkup(createElement(TaskExecutionBand, {
      task,
      executionUi,
      commandDisabledReason: executionUi.commandDisabledReason,
      disabled: false,
      commandBusy: false,
      onCommand() {}
    }));

    expect(markup).toContain("Agent readiness：warning");
    expect(markup).toContain("Server 仍會再次授權");
    expect(markup).not.toContain("disabled=\"\"");
  });

  it("allows the explicit approval mutation without presenting it as a run", () => {
    const task = workerTask({ approvalState: "pending" });
    const executionUi = deriveTaskExecutionUi(task, taskAgentReadinessState(task, readiness("blocked")));
    const markup = renderToStaticMarkup(createElement(TaskExecutionBand, {
      task,
      executionUi,
      commandDisabledReason: executionUi.commandDisabledReason,
      disabled: false,
      commandBusy: false,
      onCommand() {}
    }));

    expect(markup).toContain("Agent readiness：blocked · Runtime Profile 已停用。");
    expect(markup).toContain("核准產出</button>");
    expect(markup).not.toContain("disabled=\"\"");
    expect(markup).not.toContain("核准並產出");
  });

  it("does not label an unrelated pending form action as an Agent command", () => {
    const task = workerTask({ approvalState: "pending" });
    const executionUi = deriveTaskExecutionUi(task, taskAgentReadinessState(task, readiness("blocked")));
    const markup = renderToStaticMarkup(createElement(TaskExecutionBand, {
      task,
      executionUi,
      commandDisabledReason: executionUi.commandDisabledReason,
      disabled: true,
      commandBusy: false,
      onCommand() {}
    }));

    expect(markup).toContain("disabled=\"\"");
    expect(markup).toContain("核准產出</button>");
    expect(markup).not.toContain("核准中");
  });
});
