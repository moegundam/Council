import { describe, expect, it } from "vitest";
import type { ExecutionRuntimeBinding, GoalPlanTask, GoalTaskBinding, ReviewerVerdict } from "@council/contracts";
import {
  actionAdapterEndpointDigest,
  assertIndependentReviewQuorum,
  createExecutionContract,
  goalBudgetFailureReason,
  goalBudgetReservationFailureReason,
  goalPlanDigest,
  normalizeActionAdapterEndpoint,
  parseActionAdapterEndpointAllowlist,
  readyGoalPlanTaskIds,
  resumeGoalRunState,
  transitionGoalRun
} from "./goal-run-policy.js";

const goalRunId = "20000000-0000-4000-8000-000000000001";
const firstTaskId = "20000000-0000-4000-8000-000000000002";
const secondTaskId = "20000000-0000-4000-8000-000000000003";

function planTask(id: string, dependencyIds: string[] = []): GoalPlanTask {
  return {
    id,
    decisionId: id === firstTaskId
      ? "20000000-0000-4000-8000-000000000012"
      : "20000000-0000-4000-8000-000000000013",
    title: id,
    description: "",
    acceptanceCriteria: "Verified output",
    dependencyIds,
    assigneeAgentId: "20000000-0000-4000-8000-000000000004",
    executionMode: "worker",
    allowedTools: [],
    dataScope: "meeting",
    action: null
  };
}

function binding(planTaskId: string, state: GoalTaskBinding["state"]): GoalTaskBinding {
  return {
    id: crypto.randomUUID(),
    goalRunId,
    planRevision: 1,
    planTaskId,
    taskId: null,
    state,
    attemptCount: 0,
    activeJobId: null,
    lastError: null,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z"
  };
}

function verdict(agent: string, connector: string): ReviewerVerdict {
  return {
    id: crypto.randomUUID(),
    goalRunId,
    scope: "goal",
    scopeId: goalRunId,
    reviewerAgentId: agent,
    reviewerAgentRevision: 1,
    modelConnectorId: connector,
    verdict: "pass",
    summary: "Pass",
    evidenceIds: [],
    contractDigest: "a".repeat(64),
    reviewJobId: null,
    reviewRequestFingerprint: null,
    createdAt: "2026-08-27T00:00:00.000Z"
  };
}

describe("Goal Run policy", () => {
  it("allows the fixed lifecycle and rejects approval bypass", () => {
    expect(transitionGoalRun("draft", "plan")).toBe("planning");
    expect(transitionGoalRun("planning", "plan_ready")).toBe("awaiting_approval");
    expect(() => transitionGoalRun("planning", "approve")).toThrow(/Invalid Goal Run transition/);
    expect(transitionGoalRun("planning", "pause")).toBe("paused");
    expect(resumeGoalRunState("planning")).toBe("planning");
    expect(resumeGoalRunState("awaiting_approval")).toBe("awaiting_approval");
    expect(() => resumeGoalRunState(null)).toThrow(/resumable/i);
  });

  it("produces the same digest for equivalent key ordering", () => {
    const left = planTask(firstTaskId);
    const right = { ...left, action: null, dataScope: "meeting" };
    expect(goalPlanDigest([left])).toBe(goalPlanDigest([right]));
  });

  it("binds Action endpoint and Credential revisions into the immutable contract digest", () => {
    const actionTask: GoalPlanTask = {
      ...planTask(firstTaskId),
      executionMode: "action",
      assigneeAgentId: null,
      action: {
        adapterId: "20000000-0000-4000-8000-000000000030",
        actionKey: "deploy-preview",
        targetId: "staging",
        inputs: { release: "v1" },
        riskClass: "ordinary"
      }
    };
    const limits = { discussionRounds: 3, maxTasks: 12, maxConcurrentTasks: 2, maxAttemptsPerTask: 3, maxReplans: 2, maxDurationMinutes: 120, maxModelCalls: 60, maxActionCalls: 30 };
    const binding = {
      planTaskId: actionTask.id,
      adapterId: actionTask.action!.adapterId,
      adapterCatalogRevision: 4,
      endpointDigest: actionAdapterEndpointDigest("https://harness.example.test/mcp"),
      credentialId: "20000000-0000-4000-8000-000000000031",
      credentialSecretRevision: 7
    };
    const first = createExecutionContract({ goalRunId, planRevision: 1, tasks: [actionTask], limits, approvedBy: "20000000-0000-4000-8000-000000000032", approvedAt: "2026-08-27T00:00:00.000Z", actionBindings: [binding] });
    const changed = createExecutionContract({ goalRunId, planRevision: 1, tasks: [actionTask], limits, approvedBy: first.approvedBy, approvedAt: first.approvedAt, actionBindings: [{ ...binding, credentialSecretRevision: 8 }] });
    expect(first.contractDigest).not.toBe(changed.contractDigest);
    expect(first.actionBindings).toEqual([binding]);
  });

  it("binds the OMP profile, Agent, model, image, tools, and data scope into the contract digest", () => {
    const task = planTask(firstTaskId);
    const limits = { discussionRounds: 3, maxTasks: 12, maxConcurrentTasks: 2, maxAttemptsPerTask: 3, maxReplans: 2, maxDurationMinutes: 120, maxModelCalls: 60, maxActionCalls: 30 };
    const runtimeBinding: ExecutionRuntimeBinding = {
      planTaskId: task.id,
      route: "omp_coding",
      runtimeProfileId: "70000000-0000-4000-8000-000000000001",
      runtimeProfileRevision: 3,
      harnessKind: "pi",
      runtimeVersion: "omp-rpc-v2@18.1.2",
      policy: "isolated_exec",
      capabilities: ["text", "file_read", "file_write", "process"],
      agentId: task.assigneeAgentId!,
      agentRevision: 5,
      modelConnectorId: "70000000-0000-4000-8000-000000000002",
      modelConnectorRevision: 4,
      modelConnectorSecretRevision: 0,
      sandboxProfileId: "70000000-0000-4000-8000-000000000003",
      sandboxImageDigest: `sha256:${"a".repeat(64)}`,
      workspaceSource: {
        sourceId: "council-canary",
        archiveDigest: `sha256:${"d".repeat(64)}`
      },
      allowedTools: ["read", "grep", "edit", "bash"],
      dataScopeDigest: "b".repeat(64),
      timeoutMs: 2 * 60 * 60_000
    };
    const first = createExecutionContract({
      goalRunId,
      planRevision: 1,
      tasks: [task],
      limits,
      approvedBy: "20000000-0000-4000-8000-000000000032",
      approvedAt: "2026-09-02T00:00:00.000Z",
      runtimeBindings: [runtimeBinding]
    });
    const changed = createExecutionContract({
      goalRunId,
      planRevision: 1,
      tasks: [task],
      limits,
      approvedBy: first.approvedBy,
      approvedAt: first.approvedAt,
      runtimeBindings: [{ ...runtimeBinding, sandboxImageDigest: `sha256:${"c".repeat(64)}` }]
    });
    expect(first.runtimeBindings).toEqual([runtimeBinding]);
    expect(first.contractDigest).not.toBe(changed.contractDigest);
  });

  it("normalizes the operator Action endpoint allowlist and rejects embedded request data", () => {
    expect(parseActionAdapterEndpointAllowlist("https://harness.example.test,http://harness.internal/mcp")).toEqual([
      "https://harness.example.test/",
      "http://harness.internal/mcp"
    ]);
    expect(normalizeActionAdapterEndpoint("https://harness.example.test/mcp")).toBe("https://harness.example.test/mcp");
    expect(() => parseActionAdapterEndpointAllowlist("https://token@example.test/mcp")).toThrow(/credential-free/i);
    expect(() => parseActionAdapterEndpointAllowlist("https://harness.example.test/mcp?token=secret")).toThrow(/query/i);
  });

  it("only schedules tasks whose dependencies are complete", () => {
    const tasks = [planTask(firstTaskId), planTask(secondTaskId, [firstTaskId])];
    expect(readyGoalPlanTaskIds(tasks, [binding(firstTaskId, "ready"), binding(secondTaskId, "waiting")])).toEqual([firstTaskId]);
    expect(readyGoalPlanTaskIds(tasks, [binding(firstTaskId, "completed"), binding(secondTaskId, "waiting")])).toEqual([secondTaskId]);
  });

  it("requires two different agents and model connectors", () => {
    const first = verdict(
      "20000000-0000-4000-8000-000000000010",
      "20000000-0000-4000-8000-000000000020"
    );
    const second = verdict(
      "20000000-0000-4000-8000-000000000011",
      "20000000-0000-4000-8000-000000000021"
    );
    expect(() => assertIndependentReviewQuorum([first, second], [])).not.toThrow();
    expect(() => assertIndependentReviewQuorum([first, { ...second, modelConnectorId: first.modelConnectorId }], [])).toThrow(/Model Connectors/);
    expect(() => assertIndependentReviewQuorum([first, second], [first.reviewerAgentId])).toThrow(/excluded/);
  });

  it("allows a Goal to settle at its exact budget while rejecting another reservation", () => {
    const limits = { discussionRounds: 3, maxTasks: 12, maxConcurrentTasks: 2, maxAttemptsPerTask: 3, maxReplans: 2, maxDurationMinutes: 120, maxModelCalls: 4, maxActionCalls: 0 };
    const usage = { discussionRounds: 3, taskAttempts: 1, replans: 0, modelCalls: 4, actionCalls: 0 };
    const deadlineAt = "2027-08-27T00:00:00.000Z";
    expect(goalBudgetFailureReason({ limits, usage, deadlineAt, now: Date.parse("2026-08-27T00:00:00.000Z") })).toBeNull();
    expect(goalBudgetReservationFailureReason({ limits, usage, increments: { modelCalls: 1 }, deadlineAt, now: Date.parse("2026-08-27T00:00:00.000Z") })).toMatch(/Model call/);
    expect(goalBudgetReservationFailureReason({ limits, usage, increments: { actionCalls: 1 }, deadlineAt, now: Date.parse("2026-08-27T00:00:00.000Z") })).toMatch(/Action call/);
  });
});
