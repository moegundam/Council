import { describe, expect, it } from "vitest";
import type { GoalCanvasProjectionInput } from "./goal-canvas.js";
import { projectGoalCanvas } from "./goal-canvas.js";

const goalId = "30000000-0000-4000-8000-000000000001";
const meetingId = "30000000-0000-4000-8000-000000000002";
const taskId = "30000000-0000-4000-8000-000000000003";
const agentId = "30000000-0000-4000-8000-000000000004";
const roleId = "30000000-0000-4000-8000-000000000005";
const modelId = "30000000-0000-4000-8000-000000000006";
const canonicalTaskId = "30000000-0000-4000-8000-000000000017";

function fixture(): GoalCanvasProjectionInput {
  return {
    goalRun: {
      id: goalId, title: "Goal", goal: "Produce an approved result",
      threadId: "30000000-0000-4000-8000-000000000007", meetingId,
      state: "executing", revision: 3, activePlanRevision: 1,
      executionContractId: "30000000-0000-4000-8000-000000000008",
      limits: { discussionRounds: 3, maxTasks: 12, maxConcurrentTasks: 2, maxAttemptsPerTask: 3, maxReplans: 2, maxDurationMinutes: 120, maxModelCalls: 60, maxActionCalls: 30 },
      usage: { discussionRounds: 3, taskAttempts: 0, replans: 0, modelCalls: 6, actionCalls: 0 },
      deadlineAt: "2026-08-27T10:00:00.000Z", pausedFromState: null, terminalReason: null,
      createdBy: "30000000-0000-4000-8000-000000000009",
      createdAt: "2026-08-27T07:00:00.000Z", updatedAt: "2026-08-27T07:20:00.000Z"
    },
    plan: {
      id: "30000000-0000-4000-8000-000000000010", goalRunId: goalId, revision: 1,
      status: "approved", digest: "a".repeat(64), createdAt: "2026-08-27T07:10:00.000Z",
      tasks: [{ id: taskId, decisionId: "10000000-0000-4000-8000-000000000099", title: "Implement", description: "", acceptanceCriteria: "Tests pass", dependencyIds: [], assigneeAgentId: agentId, executionMode: "worker", allowedTools: [], dataScope: "meeting", action: null }]
    },
    taskBindings: [{ id: "30000000-0000-4000-8000-000000000011", goalRunId: goalId, planRevision: 1, planTaskId: taskId, taskId: null, state: "running", attemptCount: 1, activeJobId: "job-1", lastError: null, createdAt: "2026-08-27T07:10:00.000Z", updatedAt: "2026-08-27T07:20:00.000Z" }],
    actionRuns: [], reviewerVerdicts: [],
    meeting: {
      id: meetingId, threadId: "30000000-0000-4000-8000-000000000007", title: "Goal meeting", goal: "Decide", state: "active", mode: "chaired", automation: "suggest", durationMinutes: 60, startedAt: "2026-08-27T07:00:00.000Z", closedAt: null,
      agenda: { revision: 1, items: [{ id: "30000000-0000-4000-8000-000000000012", title: "Cross review", description: "", position: 0, status: "current", createdAt: "2026-08-27T07:00:00.000Z", updatedAt: "2026-08-27T07:00:00.000Z", startedAt: "2026-08-27T07:00:00.000Z", resolvedAt: null }] },
      summaryState: "not_requested", summaryJobId: null, createdAt: "2026-08-27T07:00:00.000Z"
    },
    participants: [{
      id: "30000000-0000-4000-8000-000000000013", meetingId, agentId, roleId, isChair: true, agentRevision: 2,
      roleSnapshot: { roleId, name: "Chair", usageContext: "Goal", responsibility: "Guide", speakingGuidance: "Concise", decisionScope: "Candidate only", constraints: "No approval", version: 1, templateKey: "meeting_chair", toolPolicy: "none", dataPolicy: "meeting_only", orchestrationFunctions: ["chair", "planner"], source: "meeting_created" },
      roleRevision: 1, roleHistory: []
    }],
    speakerQueue: [{ id: "speaker-1", jobId: "speaker-1", requestFingerprint: null, meetingId, agentId, kind: "agent_turn", label: "Chair", toolName: null, participantId: "30000000-0000-4000-8000-000000000013", roleRevision: 1, roleId, roleVersion: 1, roleName: "Chair", agendaRevision: 1, agendaCurrentItemId: "30000000-0000-4000-8000-000000000012", status: "running", requestedAt: "2026-08-27T07:00:00.000Z", startedAt: "2026-08-27T07:00:00.000Z", leaseExpiresAt: "2026-08-27T07:30:00.000Z", requestedBy: "system" }],
    agents: [{ id: agentId, name: "Coordinator", description: "", modelConnectorId: modelId, goalSummary: "Coordinate", toolsSummary: "None", dataSummary: "Meeting only", skillIds: [], toolGrants: [], toolPackGrants: [], runtimeProfileBinding: null, status: "online", publishedRevision: 2 }],
    roles: [{ id: roleId, name: "Chair", usageContext: "Goal", responsibility: "Guide", speakingGuidance: "Concise", decisionScope: "Candidate only", constraints: "No approval", version: 1, templateKey: "meeting_chair", toolPolicy: "none", dataPolicy: "meeting_only", deletedAt: null }],
    modelConnectors: [{ id: modelId, revision: 1, name: "Local model", location: "local", baseUrl: "http://gb10.local/v1", model: "local", enabled: true, hasSecret: false, secretRevision: 0 }]
  };
}

describe("Goal Canvas projection", () => {
  it("projects the fixed meeting, decision, task, and review path without coordinates", () => {
    const canvas = projectGoalCanvas(fixture(), "progress", "2026-08-27T07:20:00.000Z");
    expect(canvas.nodes.find((node) => node.id === "phase:discussion")).toMatchObject({ status: "completed", detail: { agenda: "Cross review", speaker: "Chair", remainingMinutes: 40 } });
    expect(canvas.nodes.find((node) => node.id === `task:${taskId}`)).toMatchObject({ status: "running" });
    expect(canvas.edges.map((edge) => edge.id)).toContain("sequence:discussion:decision");
    expect(JSON.stringify(canvas)).not.toContain("position");
  });

  it("projects role assignments and model/data resources from canonical records", () => {
    const collaboration = projectGoalCanvas(fixture(), "collaboration", "2026-08-27T07:20:00.000Z");
    expect(collaboration.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([`agent:${agentId}`, `role:${roleId}`, `task:${taskId}`]));
    expect(collaboration.edges.some((edge) => edge.type === "assignment")).toBe(true);
    const resources = projectGoalCanvas(fixture(), "resources", "2026-08-27T07:20:00.000Z");
    expect(resources.nodes.find((node) => node.id === `model:${modelId}`)).toMatchObject({ detail: { location: "local" } });
    expect(resources.nodes.find((node) => node.id === `data:${agentId}`)?.label).toBe("Meeting only");
  });

  it("projects an OMP Session from the durable RuntimeRun without creating canvas state", () => {
    const base = fixture();
    const input: GoalCanvasProjectionInput = {
      ...base,
      taskBindings: base.taskBindings.map((binding, index) => index === 0
        ? { ...binding, taskId: canonicalTaskId }
        : binding),
      runtimeRuns: [{
      id: "30000000-0000-4000-8000-000000000018",
      kind: "task_agent",
      scope: { id: `task:${canonicalTaskId}:attempt:1`, kind: "task_attempt", subjectId: canonicalTaskId, parentScopeId: `goal:${goalId}` },
      runtimeProfile: {
        profileId: "30000000-0000-4000-8000-000000000019",
        revision: 2,
        harnessKind: "pi",
        modelConnectorId: modelId,
        sandboxProfileId: "30000000-0000-4000-8000-000000000020",
        policy: "isolated_exec",
        capabilities: ["text", "abort", "resume", "file_read", "file_write", "process"],
        timeoutMs: 7_200_000,
        maxConcurrency: 1
      },
      goalRunId: goalId,
      taskId: canonicalTaskId,
      agentId,
      agentRevision: 2,
      roleId: null,
      roleRevision: null,
      state: "running",
      attempt: 1,
      idempotencyKey: "goal-task-runtime-1",
      evidenceIds: [],
      queuedAt: "2026-08-27T07:10:00.000Z",
      startedAt: "2026-08-27T07:11:00.000Z",
      completedAt: null,
      expiresAt: "2026-08-27T09:10:00.000Z",
      errorCode: null,
      runtimeVersion: "omp-rpc-v2@18.1.2",
      providerSessionId: "omp-session-1",
      leaseId: "30000000-0000-4000-8000-000000000021",
      revision: 4,
      heartbeatAt: "2026-08-27T07:20:00.000Z",
      eventCursor: 12,
      pausedAt: null,
      updatedAt: "2026-08-27T07:20:00.000Z"
      }]
    };

    const progress = projectGoalCanvas(input, "progress", "2026-08-27T07:20:00.000Z");
    expect(progress.nodes.find((node) => node.type === "runtime")).toMatchObject({
      label: "OMP Session",
      status: "running",
      detail: { taskId: canonicalTaskId, checkpoint: 12, session: "omp-session-1" }
    });
    expect(progress.edges).toContainEqual(expect.objectContaining({
      source: `task:${taskId}`,
      target: "runtime:30000000-0000-4000-8000-000000000018"
    }));
    const resources = projectGoalCanvas(input, "resources", "2026-08-27T07:20:00.000Z");
    expect(resources.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "runtime", label: "OMP Session" }),
      expect.objectContaining({ id: "tool:runtime:30000000-0000-4000-8000-000000000018:process" })
    ]));
  });

  it("connects an Action Reviewer to the Action node instead of a nonexistent Task ID", () => {
    const input = fixture();
    const actionRunId = "30000000-0000-4000-8000-000000000014";
    input.plan!.tasks[0] = {
      ...input.plan!.tasks[0]!,
      executionMode: "action",
      assigneeAgentId: null,
      action: {
        adapterId: "30000000-0000-4000-8000-000000000015",
        actionKey: "deploy-preview",
        targetId: "staging",
        inputs: {},
        riskClass: "ordinary"
      }
    };
    input.actionRuns = [{
      id: actionRunId,
      goalRunId: goalId,
      planTaskId: taskId,
      adapterId: input.plan!.tasks[0]!.action!.adapterId,
      adapterCatalogRevision: 1,
      actionKey: "deploy-preview",
      targetId: "staging",
      inputs: {},
      state: "succeeded",
      requestFingerprint: "b".repeat(64),
      contractDigest: "c".repeat(64),
      externalExecutionId: "execution-1",
      verificationSummary: "Verified.",
      lastError: null,
      createdAt: "2026-08-27T07:10:00.000Z",
      updatedAt: "2026-08-27T07:20:00.000Z"
    }];
    input.reviewerVerdicts = [{
      id: "30000000-0000-4000-8000-000000000016",
      goalRunId: goalId,
      scope: "action",
      scopeId: actionRunId,
      reviewerAgentId: agentId,
      reviewerAgentRevision: 2,
      modelConnectorId: modelId,
      verdict: "pass",
      summary: "Action evidence passed.",
      evidenceIds: [actionRunId],
      contractDigest: "c".repeat(64),
      reviewJobId: null,
      reviewRequestFingerprint: null,
      createdAt: "2026-08-27T07:21:00.000Z"
    }];

    const canvas = projectGoalCanvas(input, "progress", "2026-08-27T07:22:00.000Z");
    expect(canvas.edges).toContainEqual(expect.objectContaining({
      source: `action:${actionRunId}`,
      target: "review:30000000-0000-4000-8000-000000000016"
    }));
  });
});
