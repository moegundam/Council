import { describe, expect, it } from "vitest";
import {
  createRuntimeProfileRevision,
  createRuntimeProfileSchema,
  runtimeProfileSchema,
  runtimeProfileRevisionSchema,
  runtimeRunEventSchema,
  runtimeRunSchema,
  sandboxLeaseSchema,
  updateRuntimeProfileSchema,
  type RuntimeProfile
} from "./runtime-contracts.js";

const profile: RuntimeProfile = {
  id: "70000000-0000-4000-8000-000000000001",
  name: "GB10 meeting runtime",
  harnessKind: "openai_compatible" as const,
  modelConnectorId: "70000000-0000-4000-8000-000000000002",
  sandboxProfileId: null,
  policy: "read_only_tools" as const,
  capabilities: ["text", "read_only_tool"],
  timeoutMs: 90_000,
  maxConcurrency: 2,
  enabled: true,
  revision: 3,
  createdAt: "2026-08-03T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:00.000Z"
};

describe("Runtime contracts", () => {
  it("accepts a bounded Runtime Profile and rejects duplicate or escalating capabilities", () => {
    expect(runtimeProfileSchema.parse(profile)).toEqual(profile);
    expect(() => runtimeProfileSchema.parse({
      ...profile,
      capabilities: ["text", "text"]
    })).toThrow(/unique/i);
    expect(() => runtimeProfileSchema.parse({
      ...profile,
      policy: "text_only",
      capabilities: ["text", "process"]
    })).toThrow(/policy/i);
    expect(() => runtimeProfileSchema.parse({
      ...profile,
      policy: "isolated_exec",
      sandboxProfileId: null,
      capabilities: ["text", "process"]
    })).toThrow(/sandbox/i);
    expect(() => runtimeProfileSchema.parse({
      ...profile,
      policy: "isolated_exec",
      sandboxProfileId: "70000000-0000-4000-8000-000000000009",
      capabilities: ["text", "external_write"]
    })).toThrow(/policy/i);
  });

  it("validates create/update commands and records immutable Runtime Profile revisions", () => {
    const createInput = {
      name: profile.name,
      harnessKind: profile.harnessKind,
      modelConnectorId: profile.modelConnectorId,
      sandboxProfileId: profile.sandboxProfileId,
      policy: profile.policy,
      capabilities: [...profile.capabilities],
      timeoutMs: profile.timeoutMs,
      maxConcurrency: profile.maxConcurrency,
      enabled: profile.enabled
    };
    expect(createRuntimeProfileSchema.parse(createInput)).toEqual(createInput);
    expect(updateRuntimeProfileSchema.parse({
      expectedRevision: 3,
      timeoutMs: 120_000
    })).toEqual({ expectedRevision: 3, timeoutMs: 120_000 });
    expect(() => updateRuntimeProfileSchema.parse({ expectedRevision: 3 })).toThrow(/field/i);

    const revision = createRuntimeProfileRevision(profile, "updated", profile.updatedAt);
    expect(runtimeProfileRevisionSchema.parse(revision)).toEqual({
      profileId: profile.id,
      revision: profile.revision,
      name: profile.name,
      harnessKind: profile.harnessKind,
      modelConnectorId: profile.modelConnectorId,
      sandboxProfileId: profile.sandboxProfileId,
      policy: profile.policy,
      capabilities: [...profile.capabilities],
      timeoutMs: profile.timeoutMs,
      maxConcurrency: profile.maxConcurrency,
      enabled: profile.enabled,
      source: "updated",
      recordedAt: profile.updatedAt
    });
  });

  it("requires immutable run bindings and terminal-state timestamps", () => {
    const run = {
      id: "70000000-0000-4000-8000-000000000003",
      kind: "meeting_turn" as const,
      scope: {
        id: "meeting:70000000-0000-4000-8000-000000000004:participant:70000000-0000-4000-8000-000000000005",
        kind: "meeting_participant" as const,
        subjectId: "70000000-0000-4000-8000-000000000005",
        parentScopeId: "meeting:70000000-0000-4000-8000-000000000004"
      },
      runtimeProfile: {
        profileId: profile.id,
        revision: profile.revision,
        harnessKind: profile.harnessKind,
        modelConnectorId: profile.modelConnectorId,
        sandboxProfileId: profile.sandboxProfileId,
        policy: profile.policy,
        capabilities: [...profile.capabilities],
        timeoutMs: profile.timeoutMs,
        maxConcurrency: profile.maxConcurrency
      },
      agentId: "70000000-0000-4000-8000-000000000006",
      agentRevision: 4,
      roleId: "70000000-0000-4000-8000-000000000007",
      roleRevision: 2,
      state: "completed" as const,
      attempt: 1,
      idempotencyKey: "meeting-turn:stable-key",
      evidenceIds: ["70000000-0000-4000-8000-000000000008"],
      queuedAt: "2026-08-03T00:00:00.000Z",
      startedAt: "2026-08-03T00:00:01.000Z",
      completedAt: "2026-08-03T00:00:02.000Z",
      expiresAt: null,
      errorCode: null
    };

    expect(runtimeRunSchema.parse(run)).toMatchObject({
      ...run,
      goalRunId: null,
      taskId: null,
      runtimeVersion: null,
      providerSessionId: null,
      leaseId: null,
      revision: 1,
      heartbeatAt: null,
      eventCursor: 0,
      pausedAt: null,
      updatedAt: run.queuedAt
    });
    expect(() => runtimeRunSchema.parse({ ...run, completedAt: null })).toThrow(/terminal/i);
    expect(() => runtimeRunSchema.parse({ ...run, attempt: 0 })).toThrow();
    expect(() => runtimeRunSchema.parse({
      ...run,
      state: "queued",
      startedAt: null,
      completedAt: null,
      expiresAt: null
    })).toThrow(/expiry/i);
  });

  it("keeps the public pi kind while enforcing the OMP isolated-task boundary", () => {
    const ompProfile = {
      ...profile,
      name: "OMP long task runtime",
      harnessKind: "pi" as const,
      sandboxProfileId: "70000000-0000-4000-8000-000000000009",
      policy: "isolated_exec" as const,
      capabilities: ["text", "abort", "resume", "file_read", "file_write", "process"] as const,
      timeoutMs: 2 * 60 * 60_000,
      maxConcurrency: 1
    };
    expect(runtimeProfileSchema.parse(ompProfile)).toMatchObject({
      harnessKind: "pi",
      policy: "isolated_exec",
      timeoutMs: 7_200_000
    });
    expect(() => runtimeProfileSchema.parse({ ...ompProfile, policy: "text_only", sandboxProfileId: null })).toThrow(/isolated_exec/i);
    expect(() => runtimeProfileSchema.parse({ ...ompProfile, timeoutMs: 12 * 60 * 60_000 + 1 })).toThrow(/12 hours/i);
    expect(() => runtimeProfileSchema.parse({ ...profile, timeoutMs: 900_001 })).toThrow(/15 minutes/i);

    const queued = runtimeRunSchema.parse({
      id: "70000000-0000-4000-8000-000000000020",
      kind: "task_agent",
      scope: {
        id: "task:70000000-0000-4000-8000-000000000021:attempt:1",
        kind: "task_attempt",
        subjectId: "70000000-0000-4000-8000-000000000021",
        parentScopeId: "goal:70000000-0000-4000-8000-000000000022"
      },
      runtimeProfile: {
        profileId: ompProfile.id,
        revision: ompProfile.revision,
        harnessKind: ompProfile.harnessKind,
        modelConnectorId: ompProfile.modelConnectorId,
        sandboxProfileId: ompProfile.sandboxProfileId,
        policy: ompProfile.policy,
        capabilities: [...ompProfile.capabilities],
        timeoutMs: ompProfile.timeoutMs,
        maxConcurrency: ompProfile.maxConcurrency
      },
      goalRunId: "70000000-0000-4000-8000-000000000022",
      taskId: "70000000-0000-4000-8000-000000000021",
      agentId: "70000000-0000-4000-8000-000000000023",
      agentRevision: 2,
      roleId: null,
      roleRevision: null,
      state: "paused",
      attempt: 1,
      idempotencyKey: "omp-task-1",
      evidenceIds: [],
      queuedAt: "2026-09-02T00:00:00.000Z",
      startedAt: "2026-09-02T00:00:01.000Z",
      completedAt: null,
      expiresAt: "2026-09-02T02:00:00.000Z",
      errorCode: "provider_outcome_unknown",
      runtimeVersion: "omp-rpc-v2@18.1.2",
      providerSessionId: "omp-session-1",
      leaseId: "70000000-0000-4000-8000-000000000024",
      revision: 4,
      heartbeatAt: "2026-09-02T00:00:15.000Z",
      eventCursor: 8,
      pausedAt: "2026-09-02T00:00:16.000Z",
      updatedAt: "2026-09-02T00:00:16.000Z"
    });
    expect(queued.state).toBe("paused");
    expect(queued.errorCode).toBe("provider_outcome_unknown");
    expect(() => runtimeRunSchema.parse({ ...queued, kind: "meeting_turn" })).toThrow(/task_agent/i);
  });

  it("accepts only standardized Runtime events and rejects model reasoning fields", () => {
    const event = {
      id: "70000000-0000-4000-8000-000000000030",
      runtimeRunId: "70000000-0000-4000-8000-000000000020",
      sequence: 9,
      type: "tool.completed" as const,
      phase: "executing" as const,
      summary: "Tests completed with a bounded result.",
      toolName: "bash",
      progressPercent: 75,
      usage: { inputTokens: 120, outputTokens: 40, toolCalls: 3 },
      errorCode: null,
      actorType: "runtime" as const,
      occurredAt: "2026-09-02T00:00:17.000Z"
    };
    expect(runtimeRunEventSchema.parse(event)).toEqual(event);
    expect(() => runtimeRunEventSchema.parse({ ...event, reasoning: "hidden chain of thought" })).toThrow();
    expect(() => runtimeRunEventSchema.parse({ ...event, sequence: 0 })).toThrow();
  });

  it("requires sandbox TTL and a digest-pinned image without host control surfaces", () => {
    const lease = {
      id: "70000000-0000-4000-8000-000000000009",
      scopeId: "task:70000000-0000-4000-8000-000000000010:attempt:1",
      backend: "rootless_docker" as const,
      instanceId: "sandbox-1",
      state: "active" as const,
      imageDigest: "sha256:" + "a".repeat(64),
      cpuLimit: 1,
      memoryMb: 1024,
      diskMb: 2048,
      processLimit: 64,
      networkPolicy: "deny_all" as const,
      allowlistedHosts: [] as string[],
      createdAt: "2026-08-03T00:00:00.000Z",
      lastUsedAt: "2026-08-03T00:00:00.000Z",
      expiresAt: "2026-08-03T00:30:00.000Z",
      destroyedAt: null,
      checkpointRef: null
    };

    expect(sandboxLeaseSchema.parse(lease)).toEqual(lease);
    expect(() => sandboxLeaseSchema.parse({ ...lease, imageDigest: "latest" })).toThrow();
    expect(() => sandboxLeaseSchema.parse({ ...lease, expiresAt: null })).toThrow();
    expect(() => sandboxLeaseSchema.parse({
      ...lease,
      allowlistedHosts: ["127.0.0.1"]
    })).toThrow(/host/i);
  });
});
