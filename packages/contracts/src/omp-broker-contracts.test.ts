import { describe, expect, it } from "vitest";
import {
  ompBrokerControlRequestSchema,
  ompBrokerSessionSchema,
  ompBrokerStartRequestSchema
} from "./omp-broker-contracts.js";

const executionBinding = {
  planTaskId: "70000000-0000-4000-8000-000000000001",
  route: "omp_coding" as const,
  runtimeProfileId: "70000000-0000-4000-8000-000000000002",
  runtimeProfileRevision: 1,
  harnessKind: "pi" as const,
  runtimeVersion: "omp-rpc-v2@18.1.2",
  policy: "isolated_exec" as const,
  capabilities: ["text", "file_read", "file_write", "process"] as const,
  agentId: "70000000-0000-4000-8000-000000000003",
  agentRevision: 1,
  modelConnectorId: "70000000-0000-4000-8000-000000000004",
  modelConnectorRevision: 2,
  modelConnectorSecretRevision: 0,
  sandboxProfileId: "70000000-0000-4000-8000-000000000005",
  sandboxImageDigest: `sha256:${"a".repeat(64)}`,
  workspaceSource: { sourceId: "council-canary", archiveDigest: `sha256:${"b".repeat(64)}` },
  allowedTools: ["read", "grep", "glob", "lsp", "edit", "bash"],
  dataScopeDigest: "c".repeat(64),
  timeoutMs: 2 * 60 * 60_000
};

const canonicalTaskId = "70000000-0000-4000-8000-000000000009";

describe("OMP Broker contracts", () => {
  it("accepts distinct canonical and Plan Task identities while enforcing the immutable model binding", () => {
    expect(ompBrokerStartRequestSchema.parse({
      runtimeRunId: "70000000-0000-4000-8000-000000000006",
      goalRunId: "70000000-0000-4000-8000-000000000007",
      taskId: canonicalTaskId,
      idempotencyKey: "omp-start-1",
      executionBinding,
      model: {
        id: executionBinding.modelConnectorId,
        revision: executionBinding.modelConnectorRevision,
        secretRevision: 0,
        location: "local",
        baseUrl: "http://model-tunnel:4001/v1",
        model: "gb10-coder"
      },
      prompt: "Implement the approved bounded task."
    })).toMatchObject({
      taskId: canonicalTaskId,
      executionBinding: {
        planTaskId: executionBinding.planTaskId,
        workspaceSource: { sourceId: "council-canary" }
      }
    });

    expect(() => ompBrokerStartRequestSchema.parse({
      runtimeRunId: "70000000-0000-4000-8000-000000000006",
      goalRunId: "70000000-0000-4000-8000-000000000007",
      taskId: canonicalTaskId,
      idempotencyKey: "omp-start-1",
      executionBinding,
      model: {
        id: executionBinding.modelConnectorId,
        revision: executionBinding.modelConnectorRevision + 1,
        secretRevision: 0,
        location: "local",
        baseUrl: "http://model-tunnel:4001/v1",
        model: "gb10-coder"
      },
      prompt: "Must not run."
    })).toThrow(/binding/i);
  });

  it("never accepts Owner guidance on non-steer controls", () => {
    expect(ompBrokerControlRequestSchema.parse({
      action: "steer",
      idempotencyKey: "control-1",
      expectedEventCursor: 3,
      message: "Focus on the failing test."
    })).toMatchObject({ action: "steer" });
    expect(() => ompBrokerControlRequestSchema.parse({
      action: "pause",
      idempotencyKey: "control-2",
      expectedEventCursor: 3,
      message: "hidden text"
    })).toThrow(/only steer/i);
  });

  it("requires an artifact manifest before a Session can be completed", () => {
    const session = {
      runtimeRunId: "70000000-0000-4000-8000-000000000006",
      goalRunId: "70000000-0000-4000-8000-000000000007",
      taskId: executionBinding.planTaskId,
      idempotencyKey: "omp-start-1",
      requestDigest: `sha256:${"d".repeat(64)}`,
      state: "completed",
      runtimeVersion: "omp-rpc-v2@18.1.2",
      leaseId: "70000000-0000-4000-8000-000000000008",
      containerId: "container-1",
      providerSessionId: "session-1",
      providerSessionFile: "/opt/council-omp-config/sessions/session.jsonl",
      eventCursor: 4,
      errorCode: null,
      artifactManifest: null,
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:01:00.000Z",
      expiresAt: "2026-09-02T02:00:00.000Z"
    };
    expect(() => ompBrokerSessionSchema.parse(session)).toThrow(/artifact/i);
  });
});
