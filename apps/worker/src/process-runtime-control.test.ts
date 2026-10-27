import { describe, expect, it, vi } from "vitest";
import { InMemoryPlatformStore } from "@council/database";
import { runtimeRunSchema } from "@council/contracts";
import {
  processRuntimeControl,
  RuntimeControlPendingCommitError,
  type OmpRuntimeController
} from "./process-runtime-control.js";

const runId = "77000000-0000-4000-8000-000000000301";

function ompRun(state: "running" | "paused" | "provisioning", revision: number) {
  const at = "2026-09-02T00:00:00.000Z";
  return runtimeRunSchema.parse({
    id: runId,
    kind: "task_agent",
    scope: {
      id: "task:77000000-0000-4000-8000-000000000302:attempt:1",
      kind: "task_attempt",
      subjectId: "77000000-0000-4000-8000-000000000302",
      parentScopeId: null
    },
    runtimeProfile: {
      profileId: "77000000-0000-4000-8000-000000000303",
      revision: 1,
      harnessKind: "pi",
      modelConnectorId: "77000000-0000-4000-8000-000000000304",
      sandboxProfileId: "77000000-0000-4000-8000-000000000305",
      policy: "isolated_exec",
      capabilities: ["text", "abort", "resume", "file_read", "file_write", "process"],
      timeoutMs: 7_200_000,
      maxConcurrency: 1
    },
    goalRunId: "77000000-0000-4000-8000-000000000306",
    taskId: "77000000-0000-4000-8000-000000000302",
    agentId: "77000000-0000-4000-8000-000000000307",
    agentRevision: 1,
    roleId: null,
    roleRevision: null,
    state,
    attempt: 1,
    idempotencyKey: "omp-run-1",
    evidenceIds: [],
    queuedAt: at,
    startedAt: state === "running" ? at : null,
    completedAt: null,
    expiresAt: "2026-09-02T02:00:00.000Z",
    errorCode: state === "paused" ? "provider_outcome_unknown" : null,
    runtimeVersion: "omp-rpc-v2@18.1.2",
    providerSessionId: "session-1",
    leaseId: "77000000-0000-4000-8000-000000000308",
    revision,
    heartbeatAt: at,
    eventCursor: 5,
    pausedAt: state === "paused" ? at : null,
    updatedAt: at
  });
}

async function fixture(run: ReturnType<typeof ompRun>) {
  const store = new InMemoryPlatformStore();
  await store.createRuntimeRun(run, {
    type: "state.changed", phase: statePhase(run.state), summary: "seed", toolName: null,
    progressPercent: null, usage: null, errorCode: null, actorType: "system", occurredAt: run.queuedAt
  });
  const control = vi.fn(async () => ({}));
  return { store, controller: { control } satisfies OmpRuntimeController, control };
}

function statePhase(state: string) {
  return state === "paused" ? "paused" as const : state === "provisioning" ? "provisioning" as const : "executing" as const;
}

describe("Runtime control processor", () => {
  it("delivers revision-bound Owner guidance without storing the message in Runtime events", async () => {
    const run = ompRun("running", 4);
    const { store, controller, control } = await fixture(run);
    await expect(processRuntimeControl({
      store,
      controller,
      data: { runtimeRunId: run.id, action: "steer", commandRevision: 4, message: "Focus on the failing test.", requestedBy: "owner" }
    })).resolves.toBe("applied");
    expect(control).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: `runtime-control:${run.id}:4` }));
    expect(JSON.stringify(await store.getRuntimeRunEvents(run.id, 0, 100))).not.toContain("Focus on the failing test");
  });

  it("waits for the API revision commit and treats a newer revision as replayed", async () => {
    const run = ompRun("running", 4);
    const { store, controller, control } = await fixture(run);
    await expect(processRuntimeControl({
      store, controller,
      data: { runtimeRunId: run.id, action: "steer", commandRevision: 5, message: "continue", requestedBy: "owner" }
    })).rejects.toBeInstanceOf(RuntimeControlPendingCommitError);
    await expect(processRuntimeControl({
      store, controller,
      data: { runtimeRunId: run.id, action: "steer", commandRevision: 3, message: "old", requestedBy: "owner" }
    })).resolves.toBe("replayed");
    expect(control).not.toHaveBeenCalled();
  });

  it("moves a resumed Broker Session from provisioning to ready", async () => {
    const run = ompRun("provisioning", 7);
    const { store, controller, control } = await fixture(run);
    control.mockResolvedValueOnce({ eventCursor: 9 });
    await processRuntimeControl({
      store, controller,
      data: { runtimeRunId: run.id, action: "resume", commandRevision: 7, requestedBy: "owner" }
    });
    await expect(store.getRuntimeRun(run.id)).resolves.toMatchObject({ state: "ready", revision: 8, eventCursor: 5 });
  });
});
