import { describe, expect, it } from "vitest";
import {
  createGoalRunSchema,
  createActionAdapterSchema,
  goalExecutionLimitsSchema,
  goalPlanRevisionSchema,
  goalRunControlSchema,
  goalRunPlanUpdateSchema,
  reviewerVerdictSchema
} from "./goal-run-contracts.js";

const goalRunId = "10000000-0000-4000-8000-000000000001";
const meetingId = "10000000-0000-4000-8000-000000000002";
const threadId = "10000000-0000-4000-8000-000000000003";
const firstTaskId = "10000000-0000-4000-8000-000000000004";
const secondTaskId = "10000000-0000-4000-8000-000000000005";
const agentId = "10000000-0000-4000-8000-000000000006";
const connectorId = "10000000-0000-4000-8000-000000000007";
const participantId = "10000000-0000-4000-8000-000000000008";
const roleId = "10000000-0000-4000-8000-000000000010";

function task(id: string, dependencyIds: string[] = []) {
  return {
    id,
    decisionId: id === firstTaskId
      ? "10000000-0000-4000-8000-000000000011"
      : "10000000-0000-4000-8000-000000000012",
    title: `Task ${id.slice(-2)}`,
    description: "Produce a bounded result.",
    acceptanceCriteria: "The result is independently verifiable.",
    dependencyIds,
    assigneeAgentId: agentId,
    executionMode: "worker" as const,
    allowedTools: [],
    dataScope: "meeting",
    action: null
  };
}

describe("Goal Run contracts", () => {
  it("requires exactly one discussion source", () => {
    expect(createGoalRunSchema.safeParse({ goal: "Ship the verified result.", threadId }).success).toBe(true);
    expect(createGoalRunSchema.safeParse({ goal: "Ship the verified result." }).success).toBe(false);
    expect(createGoalRunSchema.safeParse({
      goal: "Ship the verified result.",
      threadId,
      categoryId: "10000000-0000-4000-8000-000000000008"
    }).success).toBe(false);
  });

  it("rejects cyclic task plans", () => {
    const parsed = goalPlanRevisionSchema.safeParse({
      id: "10000000-0000-4000-8000-000000000009",
      goalRunId,
      revision: 1,
      status: "draft",
      digest: "a".repeat(64),
      tasks: [task(firstTaskId, [secondTaskId]), task(secondTaskId, [firstTaskId])],
      createdAt: "2026-08-27T00:00:00.000Z"
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts complete immutable Planner provenance but rejects partial provenance", () => {
    const plan = {
      id: "10000000-0000-4000-8000-000000000009",
      goalRunId,
      revision: 1,
      status: "draft" as const,
      digest: "a".repeat(64),
      tasks: [task(firstTaskId)],
      createdAt: "2026-08-27T00:00:00.000Z",
      plannerProvenance: {
        plannerParticipantId: participantId,
        plannerAgentId: agentId,
        plannerAgentRevision: 2,
        plannerModelConnectorId: connectorId,
        plannerRoleId: roleId,
        plannerRoleRevision: 3,
        plannerRoleSnapshotDigest: "b".repeat(64)
      }
    };
    expect(goalPlanRevisionSchema.safeParse(plan).success).toBe(true);
    expect(goalPlanRevisionSchema.safeParse({
      ...plan,
      plannerProvenance: {
        plannerParticipantId: participantId,
        plannerAgentId: agentId,
        plannerAgentRevision: 2,
        plannerModelConnectorId: connectorId,
        plannerRoleId: roleId,
        plannerRoleRevision: 3
      }
    }).success).toBe(false);
  });

  it("rejects actions that are not bound to action execution mode", () => {
    const parsed = goalRunPlanUpdateSchema.safeParse({
      expectedPlanRevision: 0,
      tasks: [{
        ...task(firstTaskId),
        action: {
          adapterId: connectorId,
          actionKey: "deploy-preview",
          targetId: "pipeline-preview",
          inputs: { branch: "feature/goal-run" },
          riskClass: "ordinary"
        }
      }]
    });
    expect(parsed.success).toBe(false);
  });

  it("requires optimistic revision control for mutations", () => {
    expect(goalRunControlSchema.safeParse({ expectedRevision: 3 }).success).toBe(true);
    expect(goalRunControlSchema.safeParse({ expectedRevision: 0 }).success).toBe(false);
  });

  it("requires a nonempty fixed Harness Action Adapter catalog", () => {
    const base = {
      name: "Preview deployment",
      baseUrl: "https://harness.example.test/mcp",
      credentialId: connectorId,
      actions: [{
        key: "deploy-preview",
        displayName: "Deploy preview",
        targetIds: ["pipeline-preview"],
        inputKeys: ["branch"],
        riskClass: "ordinary" as const,
        timeoutMs: 10_000,
        supportsCancellation: true,
        supportsCompensation: true
      }]
    };
    expect(createActionAdapterSchema.safeParse(base).success).toBe(true);
    expect(createActionAdapterSchema.safeParse({ ...base, actions: [] }).success).toBe(false);
  });

  it("enforces the platform-wide maximum of two concurrent Goal tasks", () => {
    expect(goalExecutionLimitsSchema.safeParse({ maxConcurrentTasks: 2 }).success).toBe(true);
    expect(goalExecutionLimitsSchema.safeParse({ maxConcurrentTasks: 3 }).success).toBe(false);
  });

  it("accepts attributable independent reviewer verdicts with an exact job binding", () => {
    const verdict = {
      id: "10000000-0000-4000-8000-000000000010",
      goalRunId,
      scope: "goal",
      scopeId: goalRunId,
      reviewerAgentId: agentId,
      reviewerAgentRevision: 2,
      modelConnectorId: connectorId,
      verdict: "pass",
      summary: "Acceptance criteria are supported by the evidence.",
      evidenceIds: [meetingId],
      contractDigest: "b".repeat(64),
      reviewJobId: "goal-review-exact-binding",
      reviewRequestFingerprint: `v2:${"c".repeat(64)}`,
      createdAt: "2026-08-27T00:00:00.000Z"
    };
    expect(reviewerVerdictSchema.safeParse(verdict).success).toBe(true);
    expect(reviewerVerdictSchema.safeParse({ ...verdict, reviewJobId: null }).success).toBe(false);
    expect(reviewerVerdictSchema.safeParse({
      ...verdict,
      reviewJobId: null,
      reviewRequestFingerprint: null
    }).success).toBe(true);
  });
});
