import { describe, expect, it } from "vitest";
import {
  createCouncilJobEnvelope,
  parseCouncilJobEnvelope,
  safeParseCouncilJobEnvelope
} from "./job-contracts.js";

const uuid = (suffix: number): string => `70000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

const runtimeProfileSnapshot = {
  profileId: uuid(1),
  revision: 1,
  harnessKind: "openai_compatible" as const,
  modelConnectorId: uuid(2),
  sandboxProfileId: null,
  policy: "text_only" as const,
  capabilities: ["text" as const],
  timeoutMs: 60_000,
  maxConcurrency: 1
};

const modelConnectorBinding = {
  id: uuid(2),
  location: "local" as const,
  baseUrl: "http://127.0.0.1:4000/v1",
  model: "council-local",
  secretRevision: 0
};

const runtimeProfileBinding = {
  profileId: runtimeProfileSnapshot.profileId,
  revision: runtimeProfileSnapshot.revision
};

function runtimeRun(kind: "meeting_turn" | "task_agent") {
  const isMeetingTurn = kind === "meeting_turn";
  return {
    id: uuid(isMeetingTurn ? 3 : 4),
    kind,
    scope: {
      id: isMeetingTurn ? `meeting:${uuid(5)}:participant:${uuid(6)}` : `task:${uuid(7)}:attempt:1`,
      kind: isMeetingTurn ? ("meeting_participant" as const) : ("task_attempt" as const),
      subjectId: isMeetingTurn ? uuid(6) : uuid(7),
      parentScopeId: isMeetingTurn ? `meeting:${uuid(5)}` : null
    },
    runtimeProfile: runtimeProfileSnapshot,
    goalRunId: null,
    taskId: isMeetingTurn ? null : uuid(7),
    agentId: uuid(8),
    agentRevision: 1,
    roleId: isMeetingTurn ? uuid(9) : null,
    roleRevision: isMeetingTurn ? 1 : null,
    state: "queued" as const,
    attempt: 1,
    idempotencyKey: isMeetingTurn ? "meeting-turn-job" : "task-agent-job",
    evidenceIds: [],
    queuedAt: "2026-08-07T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    expiresAt: "2026-08-07T00:05:00.000Z",
    errorCode: null,
    runtimeVersion: null,
    providerSessionId: null,
    leaseId: null,
    revision: 1,
    heartbeatAt: null,
    eventCursor: 0,
    pausedAt: null,
    updatedAt: "2026-08-07T00:00:00.000Z"
  };
}

const agentTurnData = {
  meetingId: uuid(10),
  agentId: uuid(8),
  participantId: uuid(6),
  roleRevision: 1,
  roleId: uuid(9),
  roleVersion: 1,
  agendaRevision: 2,
  agendaCurrentItemId: uuid(11),
  requestedBy: "owner" as const,
  modelConnectorBinding,
  agentRevision: 3,
  promptBinding: null,
  skillDigests: {},
  runtimeProfileBinding,
  runtimeProfileSnapshot,
  runtimeRun: runtimeRun("meeting_turn")
};

const chairAutomationData = {
  meetingId: uuid(10),
  chairSuggestionId: uuid(12),
  sourceUtteranceId: uuid(13),
  automationRevision: 2,
  requestedBy: "system" as const,
  modelConnectorBinding,
  agentRevision: 3,
  promptBinding: null,
  skillDigests: {},
  runtimeProfileBinding,
  runtimeProfileSnapshot
};

const modeOnlyChairAutomationData = {
  meetingId: uuid(10),
  chairSuggestionId: uuid(12),
  sourceUtteranceId: uuid(13),
  automationRevision: 2,
  requestedBy: "system" as const
};

const mcpToolCallData = {
  meetingId: uuid(10),
  agentId: uuid(8),
  participantId: uuid(6),
  roleRevision: 1,
  roleId: uuid(9),
  roleVersion: 1,
  requestFingerprint: "hmac-sha256:v1:request-fingerprint",
  connectorId: uuid(14),
  toolName: "search",
  toolSnapshot: {
    connectorName: "Docs",
    toolName: "search",
    displayName: "Search",
    kind: "mcp_tool" as const,
    version: "1.0.0",
    owner: "Platform",
    goal: "Search approved documentation."
  },
  connectorFingerprint: "sha256:connector-fingerprint",
  arguments: { query: "runtime contracts" },
  requestedBy: "owner" as const
};

const encryptedMcpToolCallData = {
  ...withoutKey(mcpToolCallData, "arguments"),
  argumentEncoding: "vault_v1" as const,
  argumentsCiphertext: "v1.nonce.tag.ciphertext"
};

const meetingSummaryData = {
  meetingId: uuid(10),
  requestedBy: "system" as const
};

const taskSyncData = {
  taskId: uuid(15),
  adapterId: uuid(16),
  requestedBy: "owner" as const
};

const taskAgentRunData = {
  taskId: uuid(15),
  agentId: uuid(8),
  executionProfile: "worker" as const,
  executionRevision: 2,
  taskFingerprint: "sha256:task-fingerprint",
  requestFingerprint: "sha256:request-fingerprint",
  modelConnectorBinding,
  agentRevision: 3,
  promptBinding: null,
  skillDigests: {},
  runtimeProfileBinding,
  runtimeProfileSnapshot,
  runtimeRun: runtimeRun("task_agent"),
  requestedBy: "owner" as const
};

const goalOrchestrateData = {
  goalRunId: uuid(30),
  expectedRevision: 1,
  requestFingerprint: "sha256:goal-orchestrate",
  requestedBy: "owner" as const
};

const goalPlanData = {
  goalRunId: uuid(30),
  expectedRevision: 2,
  expectedPlanRevision: 0,
  requestedBy: "system" as const
};

const goalReviewData = {
  goalRunId: uuid(30),
  scope: "goal" as const,
  scopeId: uuid(30),
  reviewerAgentId: uuid(31),
  reviewerAgentRevision: 2,
  reviewerParticipantId: uuid(35),
  reviewerRoleId: uuid(36),
  reviewerRoleRevision: 4,
  reviewerRoleSnapshotDigest: "b".repeat(64),
  modelConnectorId: uuid(32),
  modelConnectorBinding: {
    id: uuid(32),
    revision: 3,
    location: "local" as const,
    baseUrl: "http://127.0.0.1:4000/v1",
    model: "reviewer-local",
    credentialId: null,
    secretRevision: 0
  },
  contractDigest: "a".repeat(64),
  requestedBy: "system" as const
};

const legacyGoalReviewData = {
  goalRunId: goalReviewData.goalRunId,
  scope: goalReviewData.scope,
  scopeId: goalReviewData.scopeId,
  reviewerAgentId: goalReviewData.reviewerAgentId,
  reviewerAgentRevision: goalReviewData.reviewerAgentRevision,
  modelConnectorId: goalReviewData.modelConnectorId,
  contractDigest: goalReviewData.contractDigest,
  requestedBy: "system" as const
};

const goalActionRunData = {
  goalRunId: uuid(30),
  planTaskId: uuid(33),
  actionRunId: uuid(34),
  contractDigest: "a".repeat(64),
  requestedBy: "system" as const
};

const validEnvelopes = [
  { contractVersion: 1 as const, name: "agent-turn" as const, data: agentTurnData },
  { contractVersion: 1 as const, name: "chair-automation" as const, data: chairAutomationData },
  { contractVersion: 1 as const, name: "mcp-tool-call" as const, data: mcpToolCallData },
  { contractVersion: 1 as const, name: "meeting-summary" as const, data: meetingSummaryData },
  { contractVersion: 1 as const, name: "task-sync" as const, data: taskSyncData },
  { contractVersion: 1 as const, name: "task-agent-run" as const, data: taskAgentRunData },
  { contractVersion: 1 as const, name: "goal-orchestrate" as const, data: goalOrchestrateData },
  { contractVersion: 1 as const, name: "goal-plan" as const, data: goalPlanData },
  { contractVersion: 2 as const, name: "goal-review" as const, data: goalReviewData },
  { contractVersion: 1 as const, name: "goal-action-run" as const, data: goalActionRunData }
] as const;

function withoutKey<T extends Record<string, unknown>>(value: T, key: keyof T): Partial<T> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

describe("BullMQ Council job contracts", () => {
  it("accepts every job name with its corresponding data and preserves the envelope", () => {
    for (const envelope of validEnvelopes) {
      expect(parseCouncilJobEnvelope(envelope)).toEqual(envelope);
    }
    expect(parseCouncilJobEnvelope({
      ...validEnvelopes[1],
      data: modeOnlyChairAutomationData
    })).toEqual({
      ...validEnvelopes[1],
      data: modeOnlyChairAutomationData
    });
    expect(parseCouncilJobEnvelope({
      contractVersion: 1,
      name: "mcp-tool-call",
      data: encryptedMcpToolCallData
    })).toEqual({
      contractVersion: 1,
      name: "mcp-tool-call",
      data: encryptedMcpToolCallData
    });
    expect(createCouncilJobEnvelope("goal-review", goalReviewData)).toEqual(validEnvelopes[8]);
  });

  it("accepts only the bounded legacy Reviewer shape at contract version 1", () => {
    expect(parseCouncilJobEnvelope({
      contractVersion: 1,
      name: "goal-review",
      data: legacyGoalReviewData
    })).toEqual({
      contractVersion: 1,
      name: "goal-review",
      data: legacyGoalReviewData
    });
    expect(() => parseCouncilJobEnvelope({
      contractVersion: 1,
      name: "goal-review",
      data: goalReviewData
    })).toThrow();
    expect(() => parseCouncilJobEnvelope({
      contractVersion: 2,
      name: "goal-review",
      data: legacyGoalReviewData
    })).toThrow();
  });

  it("binds the discriminant to the matching data shape", () => {
    expect(() => parseCouncilJobEnvelope({
      ...validEnvelopes[0],
      name: "meeting-summary"
    })).toThrow();
    expect(() => parseCouncilJobEnvelope({
      ...validEnvelopes[3],
      name: "agent-turn"
    })).toThrow();
  });

  it("rejects unknown envelope, data, and nested security binding keys", () => {
    expect(() => parseCouncilJobEnvelope({
      ...validEnvelopes[3],
      traceId: "unexpected"
    })).toThrow();
    expect(() => parseCouncilJobEnvelope({
      ...validEnvelopes[3],
      data: { ...meetingSummaryData, traceId: "unexpected" }
    })).toThrow();
    expect(() => parseCouncilJobEnvelope({
      ...validEnvelopes[2],
      data: {
        ...mcpToolCallData,
        toolSnapshot: { ...mcpToolCallData.toolSnapshot, canWrite: true }
      }
    })).toThrow();
  });

  it("requires the security-critical bindings for agent, tool, and task execution", () => {
    for (const field of [
      "modelConnectorBinding",
      "agentRevision",
      "skillDigests",
      "runtimeProfileBinding",
      "runtimeProfileSnapshot",
      "runtimeRun"
    ] as const) {
      expect(() => parseCouncilJobEnvelope({
        ...validEnvelopes[0],
        data: withoutKey(agentTurnData, field)
      })).toThrow();
    }

    for (const field of ["toolSnapshot", "connectorFingerprint"] as const) {
      expect(() => parseCouncilJobEnvelope({
        ...validEnvelopes[2],
        data: withoutKey(mcpToolCallData, field)
      })).toThrow();
    }
    expect(() => parseCouncilJobEnvelope({
      ...validEnvelopes[2],
      data: withoutKey(mcpToolCallData, "arguments")
    })).toThrow();
    expect(() => parseCouncilJobEnvelope({
      ...validEnvelopes[2],
      data: { ...mcpToolCallData, argumentsCiphertext: "v1.nonce.tag.ciphertext" }
    })).toThrow();
    expect(() => parseCouncilJobEnvelope({
      ...validEnvelopes[2],
      data: {
        ...withoutKey(mcpToolCallData, "arguments"),
        argumentsCiphertext: "v1.nonce.tag.ciphertext"
      }
    })).toThrow();

    for (const field of [
      "taskFingerprint",
      "requestFingerprint",
      "modelConnectorBinding",
      "agentRevision",
      "skillDigests",
      "runtimeProfileBinding",
      "runtimeProfileSnapshot",
      "runtimeRun"
    ] as const) {
      expect(() => parseCouncilJobEnvelope({
        ...validEnvelopes[5],
        data: withoutKey(taskAgentRunData, field)
      })).toThrow();
    }

    for (const field of [
      "reviewerParticipantId",
      "reviewerRoleId",
      "reviewerRoleRevision",
      "reviewerRoleSnapshotDigest",
      "modelConnectorBinding"
    ] as const) {
      expect(() => parseCouncilJobEnvelope({
        ...validEnvelopes[8],
        data: withoutKey(goalReviewData, field)
      })).toThrow();
    }
    expect(() => parseCouncilJobEnvelope({
      ...validEnvelopes[8],
      data: {
        ...goalReviewData,
        modelConnectorBinding: { ...goalReviewData.modelConnectorBinding, id: uuid(33) }
      }
    })).toThrow();
    expect(() => parseCouncilJobEnvelope({
      ...validEnvelopes[8],
      data: {
        ...goalReviewData,
        modelConnectorBinding: {
          ...goalReviewData.modelConnectorBinding,
          credentialId: uuid(33),
          secretRevision: 1
        }
      }
    })).toThrow();
  });

  it("provides a safe parser for producer and consumer boundaries", () => {
    expect(safeParseCouncilJobEnvelope(validEnvelopes[1])).toMatchObject({ success: true });
    expect(safeParseCouncilJobEnvelope({
      ...validEnvelopes[1],
      contractVersion: 2
    })).toMatchObject({ success: false });
  });
});
