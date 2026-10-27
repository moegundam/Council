import { describe, expect, it } from "vitest";
import type { RuntimeRun } from "@council/contracts";
import { InMemoryPlatformStore, StoreConflictError } from "./index.js";

function queuedRun(): RuntimeRun {
  return {
    id: "70000000-0000-4000-8000-000000000101",
    kind: "task_agent",
    scope: {
      id: "task:70000000-0000-4000-8000-000000000102:attempt:1",
      kind: "task_attempt",
      subjectId: "70000000-0000-4000-8000-000000000102",
      parentScopeId: "goal:70000000-0000-4000-8000-000000000103"
    },
    runtimeProfile: {
      profileId: "70000000-0000-4000-8000-000000000104",
      revision: 3,
      harnessKind: "pi",
      modelConnectorId: "70000000-0000-4000-8000-000000000105",
      sandboxProfileId: "70000000-0000-4000-8000-000000000106",
      policy: "isolated_exec",
      capabilities: ["text", "abort", "resume", "file_read", "file_write", "process"],
      timeoutMs: 2 * 60 * 60_000,
      maxConcurrency: 1
    },
    goalRunId: "70000000-0000-4000-8000-000000000103",
    taskId: "70000000-0000-4000-8000-000000000102",
    agentId: "70000000-0000-4000-8000-000000000107",
    agentRevision: 4,
    roleId: null,
    roleRevision: null,
    state: "queued",
    attempt: 1,
    idempotencyKey: "goal-task:70000000-0000-4000-8000-000000000102:attempt:1",
    evidenceIds: [],
    queuedAt: "2026-09-02T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    expiresAt: "2026-09-02T00:30:00.000Z",
    errorCode: null,
    runtimeVersion: "omp-rpc-v2@18.1.2",
    providerSessionId: null,
    leaseId: null,
    revision: 1,
    heartbeatAt: null,
    eventCursor: 0,
    pausedAt: null,
    updatedAt: "2026-09-02T00:00:00.000Z"
  };
}

const queuedEvent = {
  type: "state.changed" as const,
  phase: "queued" as const,
  summary: "OMP Runtime Run queued.",
  toolName: null,
  progressPercent: 0,
  usage: null,
  errorCode: null,
  actorType: "system" as const,
  occurredAt: "2026-09-02T00:00:00.000Z"
};

describe("Runtime Run store", () => {
  it("persists idempotently and assigns monotonic append-only event sequences", async () => {
    const store = new InMemoryPlatformStore();
    const run = queuedRun();
    expect(await store.createRuntimeRun(run, queuedEvent)).toEqual(run);
    expect(await store.createRuntimeRun(run, queuedEvent)).toEqual(run);

    const event = await store.appendRuntimeRunEvent(run.id, {
      ...queuedEvent,
      type: "progress.updated",
      phase: "provisioning",
      summary: "Sandbox lease requested.",
      progressPercent: 5,
      occurredAt: "2026-09-02T00:00:01.000Z"
    });
    expect(event.sequence).toBe(2);
    await expect(store.getRuntimeRunEvents(run.id, 1, 100)).resolves.toEqual([event]);
  });

  it("updates state and event atomically with optimistic revisions", async () => {
    const store = new InMemoryPlatformStore();
    const run = await store.createRuntimeRun(queuedRun(), queuedEvent);
    const updated = await store.updateRuntimeRun(run.id, {
      expectedRevision: 1,
      state: "provisioning",
      leaseId: "70000000-0000-4000-8000-000000000108",
      at: "2026-09-02T00:00:01.000Z",
      event: {
        ...queuedEvent,
        phase: "provisioning",
        summary: "Sandbox lease bound.",
        progressPercent: 5,
        occurredAt: "2026-09-02T00:00:01.000Z"
      }
    });

    expect(updated).toMatchObject({ state: "provisioning", revision: 2 });
    await expect(store.updateRuntimeRun(run.id, {
      expectedRevision: 1,
      state: "ready",
      at: "2026-09-02T00:00:02.000Z",
      event: {
        ...queuedEvent,
        phase: "ready",
        summary: "Runtime is ready.",
        occurredAt: "2026-09-02T00:00:02.000Z"
      }
    })).rejects.toThrow(/revision/i);
    expect((await store.getRuntimeRunEvents(run.id)).map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("rejects conflicting idempotency replays and immutable binding replacement", async () => {
    const store = new InMemoryPlatformStore();
    const run = await store.createRuntimeRun(queuedRun(), queuedEvent);
    await expect(store.createRuntimeRun({ ...run, agentRevision: 5 }, queuedEvent)).rejects.toBeInstanceOf(StoreConflictError);

    const provisioning = await store.updateRuntimeRun(run.id, {
      expectedRevision: 1,
      state: "provisioning",
      leaseId: "70000000-0000-4000-8000-000000000108",
      at: "2026-09-02T00:00:01.000Z",
      event: { ...queuedEvent, phase: "provisioning", summary: "Lease bound." }
    });
    await expect(store.updateRuntimeRun(run.id, {
      expectedRevision: provisioning.revision,
      state: "ready",
      leaseId: "70000000-0000-4000-8000-000000000109",
      at: "2026-09-02T00:00:02.000Z",
      event: { ...queuedEvent, phase: "ready", summary: "Ready." }
    })).rejects.toThrow(/lease/i);
  });

  it("lists only non-terminal OMP Runtime Runs for bounded startup recovery", async () => {
    const store = new InMemoryPlatformStore();
    const run = await store.createRuntimeRun(queuedRun(), queuedEvent);
    await expect(store.listRecoverableOmpRuntimeRuns()).resolves.toEqual([run]);
    const cancelled = await store.updateRuntimeRun(run.id, {
      expectedRevision: run.revision,
      state: "cancelled",
      errorCode: "owner_cancelled",
      at: "2026-09-02T00:00:01.000Z",
      event: {
        ...queuedEvent,
        phase: "completed",
        summary: "Cancelled.",
        errorCode: "owner_cancelled",
        occurredAt: "2026-09-02T00:00:01.000Z"
      }
    });
    expect(cancelled.state).toBe("cancelled");
    await expect(store.listRecoverableOmpRuntimeRuns()).resolves.toEqual([]);
    await expect(store.listRecoverableOmpRuntimeRuns(0)).rejects.toThrow(/limit/i);
  });
});
