import { describe, expect, it } from "vitest";
import * as contracts from "./index.js";
import {
  addTaskEvidenceSchema,
  authorizeToolSchema,
  createTaskAdapterConnectorSchema,
  createAgentSchema,
  updateCategorySchema,
  updateGroupSchema,
  createSkillSchema,
  revokeSkillSchema,
  validateSkillSchema,
  createTaskSchema,
  createThreadSchema,
  moveTaskSchema,
  runTaskAgentSchema,
  setSkillStatusSchema,
  setTaskApprovalSchema,
  taskAdapterUpsertPayloadSchema,
  taskAdapterUpsertResponseSchema,
  updateThreadSchema,
  updateTagSchema,
  updateTaskSchema
} from "./index.js";

type RuntimeSchema = {
  parse(value: unknown): unknown;
};

function modelConnectorUpdateSchema(): RuntimeSchema {
  const schema = (contracts as unknown as { updateModelConnectorSchema?: RuntimeSchema }).updateModelConnectorSchema;
  expect(schema, "updateModelConnectorSchema must be exported").toBeDefined();
  return schema!;
}

function taskSyncRequestContract(): RuntimeSchema {
  const schema = (contracts as unknown as { taskSyncRequestSchema?: RuntimeSchema }).taskSyncRequestSchema;
  expect(schema, "taskSyncRequestSchema must be exported").toBeDefined();
  return schema!;
}

const skillInput = {
  name: "Research",
  version: "1.0.0",
  instructions: "Find evidence.",
  source: "internal-review",
  owner: "platform-owner"
};

describe("Task work-item contracts", () => {
  it("exports the strict Task sync request used by handlers and OpenAPI", () => {
    const adapterId = "30000000-0000-4000-8000-000000000001";
    const request = {
      adapterId,
      expectedRevision: 4,
      expectedStatus: "in_progress",
      expectedApprovalState: "approved",
      expectedSyncAttemptCount: 2
    };
    expect(taskSyncRequestContract().parse(request)).toEqual(request);
    expect(() => taskSyncRequestContract().parse({ adapterId })).toThrow();
    expect(() => taskSyncRequestContract().parse({ ...request, unexpected: true })).toThrow();
    expect(() => taskSyncRequestContract().parse({ ...request, adapterId: "not-a-uuid" })).toThrow();
    expect(() => taskSyncRequestContract().parse({ ...request, expectedSyncAttemptCount: -1 })).toThrow();
    expect(() => taskSyncRequestContract().parse({ ...request, expectedSyncAttemptCount: 1.5 })).toThrow();
  });

  it("accepts only Model Connector metadata and Credential bindings as a partial update", () => {
    expect(modelConnectorUpdateSchema().parse({
      expectedRevision: 3,
      name: "GB10 Council v2",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "qwen3.5-35b-a3b",
      credentialId: "30000000-0000-4000-8000-000000000001",
      enabled: false
    })).toEqual({
      expectedRevision: 3,
      name: "GB10 Council v2",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "qwen3.5-35b-a3b",
      credentialId: "30000000-0000-4000-8000-000000000001",
      enabled: false
    });
    expect(() => modelConnectorUpdateSchema().parse({ expectedRevision: 3, apiKey: "must-use-credential-rotation" })).toThrow();
  });

  it("keeps Model Connector updates strict and non-empty", () => {
    const schema = modelConnectorUpdateSchema();

    expect(() => schema.parse({})).toThrow();
    expect(() => schema.parse({ expectedRevision: 1 })).toThrow(/At least one Model Connector field is required/);
    expect(() => schema.parse({ expectedRevision: 0, enabled: true })).toThrow();
    expect(() => schema.parse({ expectedRevision: 1, name: "" })).toThrow();
    expect(() => schema.parse({ expectedRevision: 1, baseUrl: "file:///tmp/model" })).toThrow();
    expect(() => schema.parse({ expectedRevision: 1, arbitraryPolicy: "fallback" })).toThrow();
    expect(() => schema.parse({ expectedRevision: 1, enabled: true, arbitraryPolicy: "fallback" })).toThrow();
  });

  it("accepts bounded partial taxonomy maintenance updates", () => {
    expect(updateGroupSchema.parse({ expectedRevision: 2, name: "Renamed group" })).toEqual({ expectedRevision: 2, name: "Renamed group" });
    expect(updateCategorySchema.parse({
      expectedRevision: 3,
      groupId: "30000000-0000-4000-8000-000000000001",
      name: "Renamed category"
    })).toMatchObject({ expectedRevision: 3, name: "Renamed category" });
    expect(updateTagSchema.parse({ expectedRevision: 4, name: "Renamed tag", color: "blue" })).toEqual({ expectedRevision: 4, name: "Renamed tag", color: "blue" });

    expect(() => updateGroupSchema.parse({ expectedRevision: 1 })).toThrow(/At least one/);
    expect(() => updateCategorySchema.parse({ expectedRevision: 1, arbitraryCommand: "rm -rf /" })).toThrow();
    expect(() => updateTagSchema.parse({ expectedRevision: 1, color: "purple" })).toThrow();
  });

  it("requires governed Skill provenance, validation evidence, revocation reasons, and unique Agent assignments", () => {
    expect(createSkillSchema.parse(skillInput)).toMatchObject(skillInput);
    expect(() => createSkillSchema.parse({ ...skillInput, source: "" })).toThrow();
    expect(validateSkillSchema.parse({
      result: "passed",
      summary: "Static review passed.",
      expectedCheckedAt: null
    })).toMatchObject({ result: "passed", expectedCheckedAt: null });
    expect(validateSkillSchema.parse({
      result: "failed",
      summary: "Unsafe instruction found.",
      expectedCheckedAt: "2026-08-12T00:00:00.000Z"
    })).toMatchObject({ result: "failed", expectedCheckedAt: "2026-08-12T00:00:00.000Z" });
    expect(() => validateSkillSchema.parse({ result: "passed", summary: "Missing concurrency token." })).toThrow();
    expect(() => validateSkillSchema.parse({ result: "pending", summary: "No." })).toThrow();
    expect(() => validateSkillSchema.parse({ result: "passed" })).toThrow();
    expect(setSkillStatusSchema.parse({
      status: "approved",
      expectedCheckedAt: "2026-08-12T00:00:00.000Z"
    })).toEqual({ status: "approved", expectedCheckedAt: "2026-08-12T00:00:00.000Z" });
    expect(() => setSkillStatusSchema.parse({ status: "approved" })).toThrow();
    expect(revokeSkillSchema.parse({ reason: "Superseded by a reviewed version." })).toMatchObject({ reason: expect.any(String) });
    expect(() => revokeSkillSchema.parse({ reason: "" })).toThrow();

    const agent = {
      name: "Review Agent",
      goalSummary: "Review evidence.",
      toolsSummary: "No tools.",
      dataSummary: "Meeting data.",
      skillIds: ["30000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000001"]
    };
    expect(() => createAgentSchema.parse(agent)).toThrow(/Each Skill may be assigned only once/);
  });
  it("validates Topic create input and status lifecycle constraints", () => {
    expect(createThreadSchema.parse({
      categoryId: "30000000-0000-4000-8000-000000000001",
      title: "地端模型邊界",
      summary: "確認權限邊界與工具清單。",
      tagIds: ["30000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000002"]
    })).toMatchObject({ summary: expect.any(String) });
    expect(() => createThreadSchema.parse({
      categoryId: "not-a-uuid",
      title: "bad"
    })).toThrow();

    expect(() => createThreadSchema.parse({
      categoryId: "30000000-0000-4000-8000-000000000001",
      title: "重複標籤",
      summary: "",
      tagIds: ["30000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000001"]
    })).toThrow(/Each tag may be assigned only once/);
  });

  it("supports partial Topic updates and rejects empty payloads", () => {
    expect(updateThreadSchema.parse({
      expectedRevision: 3,
      status: "resolved",
      title: "新主題名稱"
    })).toMatchObject({ expectedRevision: 3, status: "resolved", title: "新主題名稱" });
    expect(() => updateThreadSchema.parse({ expectedRevision: 3 })).toThrow(/At least one Topic field is required/);
    expect(() => updateThreadSchema.parse({})).toThrow();
    expect(() => updateThreadSchema.parse({ status: "resolved" })).toThrow();
    expect(() => updateThreadSchema.parse({
      expectedRevision: 3,
      tagIds: ["30000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000001"]
    })).toThrow(/Each tag may be assigned only once/);
  });

  it("applies bounded defaults to Tasks created from approved Decisions", () => {
    expect(createTaskSchema.parse({
      decisionId: "b0000000-0000-4000-8000-000000000001",
      title: "Ship the adapter",
      description: "",
      assignee: null
    })).toEqual({
      decisionId: "b0000000-0000-4000-8000-000000000001",
      title: "Ship the adapter",
      description: "",
      assignee: null,
      assigneeAgentId: null,
      dueAt: null,
      acceptanceCriteria: "",
      executionProfile: "manual",
      allowedTools: [],
      dataScope: "",
      approvalState: "not_required"
    });
  });

  it("accepts a partial Task detail update and rejects unknown fields", () => {
    expect(updateTaskSchema.parse({
      expectedRevision: 1,
      expectedExecutionRevision: 0,
      dueAt: "2026-08-01T09:00:00.000Z",
      acceptanceCriteria: "External ID is retained after reload.",
      executionProfile: "worker",
      allowedTools: ["plane.issue.upsert"],
      dataScope: "Decision summary only"
    })).toMatchObject({ expectedRevision: 1, expectedExecutionRevision: 0, executionProfile: "worker" });
    expect(() => updateTaskSchema.parse({ expectedRevision: 1, expectedExecutionRevision: 0, approvalState: "approved" })).toThrow();
    expect(() => updateTaskSchema.parse({ expectedRevision: 1, expectedExecutionRevision: 0 })).toThrow(/At least one Task field is required/);
    expect(() => updateTaskSchema.parse({ expectedExecutionRevision: 0, dueAt: null })).toThrow();
    expect(() => updateTaskSchema.parse({ arbitraryCommand: "rm -rf /" })).toThrow();
  });

  it("defaults Worker Tasks to pending approval and rejects pre-approved creation", () => {
    expect(createTaskSchema.parse({
      decisionId: "b0000000-0000-4000-8000-000000000001",
      title: "Run bounded work",
      executionProfile: "worker"
    })).toMatchObject({ executionProfile: "worker", approvalState: "pending" });
    expect(() => createTaskSchema.parse({
      decisionId: "b0000000-0000-4000-8000-000000000001",
      title: "Bypass approval",
      executionProfile: "worker",
      approvalState: "approved"
    })).toThrow(/cannot be created as approved/i);
    expect(() => createTaskSchema.parse({
      decisionId: "b0000000-0000-4000-8000-000000000001",
      title: "Manual metadata mismatch",
      executionProfile: "manual",
      approvalState: "pending"
    })).toThrow(/does not use approval/i);
  });

  it("requires optimistic execution revisions for approval, run, and movement commands", () => {
    expect(setTaskApprovalSchema.parse({ expectedExecutionRevision: 3, action: "approve" })).toEqual({
      expectedExecutionRevision: 3,
      action: "approve"
    });
    expect(runTaskAgentSchema.parse({ expectedExecutionRevision: 4 })).toEqual({ expectedExecutionRevision: 4 });
    expect(moveTaskSchema.parse({ status: "review", position: 0, expectedBoardRevision: 7, expectedExecutionRevision: 4 })).toEqual({
      status: "review",
      position: 0,
      expectedBoardRevision: 7,
      expectedExecutionRevision: 4
    });
    expect(() => setTaskApprovalSchema.parse({ action: "approve" })).toThrow();
    expect(() => runTaskAgentSchema.parse({ expectedExecutionRevision: -1 })).toThrow();
    expect(() => moveTaskSchema.parse({ status: "review", position: 0, expectedExecutionRevision: 4 })).toThrow();
  });

  it("allows only owner URL or note Evidence", () => {
    expect(addTaskEvidenceSchema.parse({ type: "url", label: "Runbook", reference: "https://docs.example.com/runbook" })).toMatchObject({ type: "url" });
    expect(addTaskEvidenceSchema.parse({ type: "note", label: "Acceptance", reference: "Verified by the owner." })).toMatchObject({ type: "note" });
    expect(() => addTaskEvidenceSchema.parse({ type: "verified", label: "Forged", reference: "yes" })).toThrow();
    expect(() => addTaskEvidenceSchema.parse({ type: "url", label: "Unsafe", reference: "file:///etc/passwd" })).toThrow();
  });

  it("defines one fixed Task Adapter Connector protocol", () => {
    expect(createTaskAdapterConnectorSchema.parse({
      name: "Internal Task Bridge",
      location: "local",
      baseUrl: "http://task-adapter-reference:4200",
      bearerToken: "secret"
    })).toMatchObject({ name: "Internal Task Bridge", location: "local" });
    expect(() => createTaskAdapterConnectorSchema.parse({
      name: "Unsafe",
      location: "cloud",
      baseUrl: "file:///tmp/tasks"
    })).toThrow();
    expect(() => createTaskAdapterConnectorSchema.parse({
      name: "Ignored path",
      location: "cloud",
      baseUrl: "https://tasks.example.com/adapter"
    })).toThrow();
    expect(() => createTaskAdapterConnectorSchema.parse({
      name: "Embedded credential",
      location: "cloud",
      baseUrl: "https://owner:secret@tasks.example.com/"
    })).toThrow();
  });

  it("defines one bounded read or write Tool authorization request", () => {
    expect(authorizeToolSchema.parse({
      connectorId: "Docs",
      toolName: "search",
      effect: "read",
      agentId: "10000000-0000-4000-8000-000000000001"
    })).toEqual({
      connectorId: "Docs",
      toolName: "search",
      effect: "read",
      agentId: "10000000-0000-4000-8000-000000000001"
    });
    expect(() => authorizeToolSchema.parse({ connectorId: "Docs", toolName: "search", effect: "delete" })).toThrow();
    expect(() => authorizeToolSchema.parse({ connectorId: "Docs", toolName: "search", effect: "read", secret: "leak" })).toThrow();
  });

  it("allows only the fixed outbound Task payload and bounded response", () => {
    expect(taskAdapterUpsertPayloadSchema.parse({
      taskId: "10000000-0000-4000-8000-000000000001",
      meetingId: "20000000-0000-4000-8000-000000000001",
      decisionId: "30000000-0000-4000-8000-000000000001",
      title: "Ship",
      description: "Bounded payload",
      status: "todo",
      assignee: null,
      dueAt: null,
      acceptanceCriteria: "External ID returned",
      executionProfile: "manual",
      allowedTools: [],
      dataScope: "Decision only",
      approvalState: "not_required"
    })).toMatchObject({ title: "Ship" });
    expect(() => taskAdapterUpsertPayloadSchema.parse({
      taskId: "10000000-0000-4000-8000-000000000001",
      meetingId: "20000000-0000-4000-8000-000000000001",
      decisionId: "30000000-0000-4000-8000-000000000001",
      title: "Ship",
      description: "",
      status: "todo",
      assignee: null,
      dueAt: null,
      acceptanceCriteria: "",
      executionProfile: "manual",
      allowedTools: [],
      dataScope: "",
      approvalState: "not_required",
      transcript: "must not leave Council"
    })).toThrow();
    expect(taskAdapterUpsertResponseSchema.parse({ externalId: "REF-42" })).toEqual({ externalId: "REF-42" });
  });
});
