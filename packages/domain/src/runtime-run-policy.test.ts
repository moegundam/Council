import { describe, expect, it } from "vitest";
import type { RuntimeProfileSnapshot } from "@council/contracts";
import {
  applyRuntimeRunMutation,
  createQueuedRuntimeRun,
  runtimeRunQueueTtlMs,
  validateQueuedRuntimeRun,
  RuntimeRunAdmissionError
} from "./runtime-run-policy.js";

const profile: RuntimeProfileSnapshot = {
  profileId: "70000000-0000-4000-8000-000000000001",
  revision: 2,
  harnessKind: "openai_compatible",
  modelConnectorId: null,
  sandboxProfileId: null,
  policy: "text_only",
  capabilities: ["text", "abort"],
  timeoutMs: 60_000,
  maxConcurrency: 1
};

describe("Runtime Run queue expiry", () => {
  it("derives a bounded TTL from the immutable Runtime Profile", () => {
    expect(runtimeRunQueueTtlMs({ timeoutMs: 1_000 })).toBe(5 * 60_000);
    expect(runtimeRunQueueTtlMs({ timeoutMs: 120_000 })).toBe(5 * 60_000);
    expect(runtimeRunQueueTtlMs({ timeoutMs: 900_000 })).toBe(30 * 60_000);
  });

  it("reserves long queue lifetimes for OMP pi profiles", () => {
    expect(runtimeRunQueueTtlMs({ harnessKind: "pi", timeoutMs: 8 * 60 * 60_000 }))
      .toBe(8 * 60 * 60_000);
  });
});

function queuedRun() {
  return createQueuedRuntimeRun({
    id: "70000000-0000-4000-8000-000000000002",
    kind: "meeting_turn",
    scope: {
      id: "meeting:70000000-0000-4000-8000-000000000003:participant:70000000-0000-4000-8000-000000000004",
      kind: "meeting_participant",
      subjectId: "70000000-0000-4000-8000-000000000004",
      parentScopeId: "meeting:70000000-0000-4000-8000-000000000003"
    },
    runtimeProfile: profile,
    agentId: "70000000-0000-4000-8000-000000000005",
    agentRevision: 3,
    roleId: "70000000-0000-4000-8000-000000000006",
    roleRevision: 2,
    attempt: 1,
    idempotencyKey: "meeting-turn-job-1",
    queuedAt: "2026-08-03T00:00:00.000Z",
    ttlMs: 120_000
  });
}

describe("Runtime Run admission", () => {
  it("creates a bounded queued run with an explicit expiry", () => {
    expect(queuedRun()).toMatchObject({
      state: "queued",
      queuedAt: "2026-08-03T00:00:00.000Z",
      expiresAt: "2026-08-03T00:02:00.000Z",
      completedAt: null,
      runtimeProfile: profile
    });
  });

  it("accepts only the exact unexpired scope, profile, Agent, and idempotency binding", () => {
    const run = queuedRun();
    const expected = {
      kind: run.kind,
      scope: run.scope,
      runtimeProfile: profile,
      agentId: run.agentId,
      agentRevision: run.agentRevision,
      roleId: run.roleId,
      roleRevision: run.roleRevision,
      idempotencyKey: run.idempotencyKey
    };
    expect(validateQueuedRuntimeRun(run, expected, "2026-08-03T00:01:59.999Z")).toEqual(run);
    expect(() => validateQueuedRuntimeRun(
      { ...run, expiresAt: "2026-08-03T00:00:30.000Z" },
      expected,
      "2026-08-03T00:00:30.000Z"
    )).toThrow(RuntimeRunAdmissionError);
    expect(() => validateQueuedRuntimeRun(run, { ...expected, agentRevision: 4 }, "2026-08-03T00:01:00.000Z"))
      .toThrow(/binding/i);
    expect(() => validateQueuedRuntimeRun(run, {
      ...expected,
      runtimeProfile: { ...profile, timeoutMs: 61_000 }
    }, "2026-08-03T00:01:00.000Z")).toThrow(/binding/i);
  });

  it("rejects unbounded or excessive queue lifetimes", () => {
    expect(() => createQueuedRuntimeRun({
      id: "70000000-0000-4000-8000-000000000002",
      kind: "task_agent",
      scope: {
        id: "task:70000000-0000-4000-8000-000000000003:attempt:1",
        kind: "task_attempt",
        subjectId: "70000000-0000-4000-8000-000000000003",
        parentScopeId: null
      },
      runtimeProfile: profile,
      agentId: "70000000-0000-4000-8000-000000000005",
      agentRevision: 3,
      roleId: null,
      roleRevision: null,
      attempt: 1,
      idempotencyKey: "task-job-1",
      queuedAt: "2026-08-03T00:00:00.000Z",
      ttlMs: 1_800_001
    })).toThrow(/ttl/i);
  });

  it("admits an eight-hour OMP task without widening other runtimes", () => {
    const taskId = "70000000-0000-4000-8000-000000000030";
    const goalRunId = "70000000-0000-4000-8000-000000000031";
    const ompProfile: RuntimeProfileSnapshot = {
      profileId: "70000000-0000-4000-8000-000000000032",
      revision: 1,
      harnessKind: "pi",
      modelConnectorId: "70000000-0000-4000-8000-000000000033",
      sandboxProfileId: "70000000-0000-4000-8000-000000000034",
      policy: "isolated_exec",
      capabilities: ["text", "abort", "resume", "file_read", "file_write", "process"],
      timeoutMs: 8 * 60 * 60_000,
      maxConcurrency: 1
    };

    expect(createQueuedRuntimeRun({
      id: "70000000-0000-4000-8000-000000000035",
      kind: "task_agent",
      scope: {
        id: `task:${taskId}:attempt:1`,
        kind: "task_attempt",
        subjectId: taskId,
        parentScopeId: `goal:${goalRunId}`
      },
      runtimeProfile: ompProfile,
      goalRunId,
      taskId,
      runtimeVersion: "omp-rpc-v2@18.1.2",
      agentId: "70000000-0000-4000-8000-000000000036",
      agentRevision: 1,
      roleId: null,
      roleRevision: null,
      attempt: 1,
      idempotencyKey: "omp-task-job-1",
      queuedAt: "2026-08-03T00:00:00.000Z",
      ttlMs: runtimeRunQueueTtlMs(ompProfile)
    })).toMatchObject({
      state: "queued",
      expiresAt: "2026-08-03T08:00:00.000Z"
    });
  });
});

describe("Runtime Run durable lifecycle", () => {
  it("allows short runtimes to start directly but requires OMP provisioning", () => {
    expect(applyRuntimeRunMutation(queuedRun(), {
      expectedRevision: 1,
      state: "running",
      at: "2026-08-03T00:00:01.000Z"
    })).toMatchObject({ state: "running", revision: 2 });

    const taskId = "70000000-0000-4000-8000-000000000040";
    const omp = createQueuedRuntimeRun({
      id: "70000000-0000-4000-8000-000000000041",
      kind: "task_agent",
      scope: { id: `task:${taskId}:attempt:1`, kind: "task_attempt", subjectId: taskId, parentScopeId: null },
      runtimeProfile: {
        profileId: "70000000-0000-4000-8000-000000000042",
        revision: 1,
        harnessKind: "pi",
        modelConnectorId: "70000000-0000-4000-8000-000000000043",
        sandboxProfileId: "70000000-0000-4000-8000-000000000044",
        policy: "isolated_exec",
        capabilities: ["text", "abort", "resume", "file_read", "file_write", "process"],
        timeoutMs: 2 * 60 * 60_000,
        maxConcurrency: 1
      },
      goalRunId: "70000000-0000-4000-8000-000000000045",
      taskId,
      runtimeVersion: "omp-rpc-v2@18.1.2",
      agentId: "70000000-0000-4000-8000-000000000046",
      agentRevision: 1,
      roleId: null,
      roleRevision: null,
      attempt: 1,
      idempotencyKey: "omp-provisioning-test",
      queuedAt: "2026-08-03T00:00:00.000Z",
      ttlMs: 2 * 60 * 60_000
    });
    expect(() => applyRuntimeRunMutation(omp, {
      expectedRevision: 1,
      state: "running",
      at: "2026-08-03T00:00:01.000Z"
    })).toThrow(/provisioning/i);
  });

  it("can fail closed from queued when recovery observes an uncommitted start", () => {
    expect(applyRuntimeRunMutation(queuedRun(), {
      expectedRevision: 1,
      state: "paused",
      errorCode: "provider_outcome_unknown",
      at: "2026-08-03T00:00:01.000Z"
    })).toMatchObject({ state: "paused", errorCode: "provider_outcome_unknown" });
    expect(applyRuntimeRunMutation(queuedRun(), {
      expectedRevision: 1,
      state: "failed",
      errorCode: "runtime_setup_failed",
      at: "2026-08-03T00:00:01.000Z"
    })).toMatchObject({ state: "failed", errorCode: "runtime_setup_failed" });
  });

  it("uses optimistic revisions and fails unknown provider outcomes closed", () => {
    const run = queuedRun();
    const provisioning = applyRuntimeRunMutation(run, {
      expectedRevision: 1,
      state: "provisioning",
      leaseId: "70000000-0000-4000-8000-000000000020",
      at: "2026-08-03T00:00:01.000Z"
    });
    const ready = applyRuntimeRunMutation(provisioning, {
      expectedRevision: 2,
      state: "ready",
      at: "2026-08-03T00:00:02.000Z"
    });
    const running = applyRuntimeRunMutation(ready, {
      expectedRevision: 3,
      state: "running",
      providerSessionId: "omp-session-1",
      expiresAt: "2026-08-03T02:00:01.000Z",
      at: "2026-08-03T00:00:03.000Z"
    });
    const paused = applyRuntimeRunMutation(running, {
      expectedRevision: 4,
      state: "paused",
      errorCode: "provider_outcome_unknown",
      eventCursor: 9,
      at: "2026-08-03T00:01:00.000Z"
    });

    expect(paused).toMatchObject({
      state: "paused",
      revision: 5,
      providerSessionId: "omp-session-1",
      leaseId: "70000000-0000-4000-8000-000000000020",
      eventCursor: 9,
      pausedAt: "2026-08-03T00:01:00.000Z",
      errorCode: "provider_outcome_unknown"
    });
    expect(() => applyRuntimeRunMutation(paused, {
      expectedRevision: 4,
      state: "running",
      at: "2026-08-03T00:01:01.000Z"
    })).toThrow(/revision/i);
  });

  it("rejects illegal transitions and replacement Session or Lease bindings", () => {
    const run = queuedRun();
    expect(() => applyRuntimeRunMutation(run, {
      expectedRevision: 1,
      state: "completed",
      at: "2026-08-03T00:00:01.000Z"
    })).toThrow(/transition/i);

    const provisioning = applyRuntimeRunMutation(run, {
      expectedRevision: 1,
      state: "provisioning",
      leaseId: "70000000-0000-4000-8000-000000000020",
      at: "2026-08-03T00:00:01.000Z"
    });
    expect(() => applyRuntimeRunMutation(provisioning, {
      expectedRevision: 2,
      state: "ready",
      leaseId: "70000000-0000-4000-8000-000000000021",
      at: "2026-08-03T00:00:02.000Z"
    })).toThrow(/lease/i);

    const ready = applyRuntimeRunMutation(provisioning, {
      expectedRevision: 2,
      state: "ready",
      at: "2026-08-03T00:00:02.000Z"
    });
    const running = applyRuntimeRunMutation(ready, {
      expectedRevision: 3,
      state: "running",
      providerSessionId: "omp-session-1",
      at: "2026-08-03T00:00:03.000Z"
    });
    expect(() => applyRuntimeRunMutation(running, {
      expectedRevision: 4,
      state: "running",
      providerSessionId: "omp-session-2",
      at: "2026-08-03T00:00:04.000Z"
    })).toThrow(/session/i);
  });
});
