import argon2 from "argon2";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeRun } from "@council/contracts";
import { InMemoryPlatformStore } from "@council/database";
import type { AgentTurnQueue } from "./agent-queue.js";
import { createApp } from "./app.js";

const origin = "https://council.test";
const password = "correct horse battery staple";

function queuedRun(): RuntimeRun {
  return {
    id: "70000000-0000-4000-8000-000000000201",
    kind: "task_agent",
    scope: {
      id: "task:70000000-0000-4000-8000-000000000202:attempt:1",
      kind: "task_attempt",
      subjectId: "70000000-0000-4000-8000-000000000202",
      parentScopeId: "goal:70000000-0000-4000-8000-000000000203"
    },
    runtimeProfile: {
      profileId: "70000000-0000-4000-8000-000000000204",
      revision: 1,
      harnessKind: "pi",
      modelConnectorId: "70000000-0000-4000-8000-000000000205",
      sandboxProfileId: "70000000-0000-4000-8000-000000000206",
      policy: "isolated_exec",
      capabilities: ["text", "abort", "resume", "file_read", "file_write", "process"],
      timeoutMs: 2 * 60 * 60_000,
      maxConcurrency: 1
    },
    goalRunId: "70000000-0000-4000-8000-000000000203",
    taskId: "70000000-0000-4000-8000-000000000202",
    agentId: "70000000-0000-4000-8000-000000000207",
    agentRevision: 2,
    roleId: null,
    roleRevision: null,
    state: "queued",
    attempt: 1,
    idempotencyKey: "runtime-route-fixture",
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

const baseEvent = {
  type: "state.changed" as const,
  phase: "queued" as const,
  summary: "Runtime queued.",
  toolName: null,
  progressPercent: 0,
  usage: null,
  errorCode: null,
  actorType: "system" as const,
  occurredAt: "2026-09-02T00:00:00.000Z"
};

async function runningFixture(store: InMemoryPlatformStore): Promise<RuntimeRun> {
  let run = await store.createRuntimeRun(queuedRun(), baseEvent);
  run = await store.updateRuntimeRun(run.id, {
    expectedRevision: run.revision,
    state: "provisioning",
    leaseId: "70000000-0000-4000-8000-000000000208",
    at: "2026-09-02T00:00:01.000Z",
    event: { ...baseEvent, phase: "provisioning", summary: "Lease bound." }
  });
  run = await store.updateRuntimeRun(run.id, {
    expectedRevision: run.revision,
    state: "ready",
    at: "2026-09-02T00:00:02.000Z",
    event: { ...baseEvent, phase: "ready", summary: "Runtime ready." }
  });
  return store.updateRuntimeRun(run.id, {
    expectedRevision: run.revision,
    state: "running",
    providerSessionId: "omp-session-route-fixture",
    expiresAt: "2026-09-02T02:00:03.000Z",
    at: "2026-09-02T00:00:03.000Z",
    event: { ...baseEvent, phase: "executing", summary: "Runtime running." }
  });
}

async function ownerSession(app: Awaited<ReturnType<typeof createApp>>, store: InMemoryPlatformStore): Promise<string> {
  await store.createOwner("runtime-owner@example.com", await argon2.hash(password, { type: argon2.argon2id }));
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "runtime-owner@example.com", password }
  });
  return login.cookies.find((entry) => entry.name === "council_session")!.value;
}

describe("OMP Runtime Run routes", () => {
  it("keeps reads Owner-only and controls a run through revision-bound Worker jobs", async () => {
    const store = new InMemoryPlatformStore();
    const run = await runningFixture(store);
    const enqueueRuntimeControl = vi.fn(async (_job, requestedJobId: string) => ({ jobId: requestedJobId }));
    const queue = { enqueueRuntimeControl, close: async () => undefined } as unknown as AgentTurnQueue;
    const app = await createApp({
      store,
      authDisabled: false,
      secureCookies: false,
      allowedOrigin: origin,
      ompRuntimeEnabled: true,
      agentQueue: queue
    });

    expect((await app.inject({ method: "GET", url: `/api/v1/runtime-runs/${run.id}` })).statusCode).toBe(401);
    const session = await ownerSession(app, store);
    const headers = { origin };
    const cookies = { council_session: session };

    const read = await app.inject({ method: "GET", url: `/api/v1/runtime-runs/${run.id}`, cookies });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ id: run.id, state: "running", revision: 4 });
    const taskRead = await app.inject({ method: "GET", url: `/api/v1/runtime-runs/by-task/${run.taskId}`, cookies });
    expect(taskRead.statusCode).toBe(200);
    expect(taskRead.json()).toMatchObject({ id: run.id, taskId: run.taskId });

    const events = await app.inject({
      method: "GET",
      url: `/api/v1/runtime-runs/${run.id}/events?afterSequence=2&limit=2`,
      cookies
    });
    expect(events.statusCode).toBe(200);
    expect(events.json().events.map((event: { sequence: number }) => event.sequence)).toEqual([3, 4]);

    const steer = await app.inject({
      method: "POST",
      url: `/api/v1/runtime-runs/${run.id}/steer`,
      headers,
      cookies,
      payload: { expectedRevision: 4, message: "Run the focused regression tests before finalizing the patch." }
    });
    expect(steer.statusCode).toBe(200);
    expect(steer.json()).toMatchObject({ state: "running", revision: 5 });

    const pause = await app.inject({
      method: "POST",
      url: `/api/v1/runtime-runs/${run.id}/pause`,
      headers,
      cookies,
      payload: { expectedRevision: 5 }
    });
    expect(pause.statusCode).toBe(200);
    expect(pause.json()).toMatchObject({ state: "paused", revision: 6 });
    expect(enqueueRuntimeControl).toHaveBeenNthCalledWith(2, expect.objectContaining({
      runtimeRunId: run.id,
      action: "pause",
      commandRevision: 6,
      requestedBy: "owner"
    }), `${run.id}-runtime-pause-6`);

    const resume = await app.inject({
      method: "POST",
      url: `/api/v1/runtime-runs/${run.id}/resume`,
      headers,
      cookies,
      payload: { expectedRevision: 6 }
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json()).toMatchObject({ state: "provisioning", revision: 7 });
    await app.close();
  });

  it("keeps mutations disabled while preserving historical reads", async () => {
    const store = new InMemoryPlatformStore();
    const run = await runningFixture(store);
    const app = await createApp({ store, authDisabled: false, secureCookies: false, allowedOrigin: origin, ompRuntimeEnabled: false });
    const session = await ownerSession(app, store);
    const cookies = { council_session: session };
    expect((await app.inject({ method: "GET", url: `/api/v1/runtime-runs/${run.id}`, cookies })).statusCode).toBe(200);
    const disabled = await app.inject({
      method: "POST",
      url: `/api/v1/runtime-runs/${run.id}/pause`,
      headers: { origin },
      cookies,
      payload: { expectedRevision: run.revision }
    });
    expect(disabled.statusCode).toBe(404);
    expect(disabled.json()).toMatchObject({ error: { code: "FEATURE_DISABLED" } });
    await app.close();
  });
});
