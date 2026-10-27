import { describe, expect, it } from "vitest";
import type { TaskAdapterUpsertPayload } from "@council/contracts";
import { InMemoryPlatformStore, taskSyncAdmissionInput } from "@council/database";
import { createSeedSnapshot } from "@council/database/seed";
import { SecretVault } from "@council/domain";
import type { TaskAdapterClientConfig } from "@council/runtime";
import { processTaskSync, recordTaskSyncFailure } from "./process-task-sync.js";

async function createPendingTask(options: { secret?: string; pending?: boolean } = {}) {
  const store = new InMemoryPlatformStore(createSeedSnapshot());
  const snapshot = await store.getSnapshot();
  const decision = await store.createDecision({
    meetingId: snapshot.meetings[0]!.id,
    title: "Ship the work item",
    description: "The meeting approved a bounded implementation."
  });
  await store.setDecisionStatus(decision.id, "approved");
  let task = await store.createTask({
    decisionId: decision.id,
    title: "Implement sync",
    description: "Send the approved work item to the configured adapter.",
    assignee: "Platform owner",
    dueAt: "2026-07-20T09:00:00.000Z",
    acceptanceCriteria: "The external task is idempotently upserted.",
    executionProfile: "worker",
    allowedTools: ["task-adapter.upsert"],
    dataScope: "Task fields only"
  });
  task = await store.setTaskApproval(task.id, { expectedExecutionRevision: 0, action: "approve" });
  const vault = new SecretVault(Buffer.alloc(32, 9));
  const adapter = await store.createTaskAdapterConnector({
    name: "Reference adapter",
    location: "local",
    baseUrl: "http://task-adapter-reference:4200"
  }, options.secret ? { ciphertext: vault.encrypt(options.secret) } : undefined);
  const jobId = "task-sync-job-1";
  if (options.pending !== false) await store.markTaskSyncPending(task.id, jobId, taskSyncAdmissionInput(task, adapter.id));
  return { store, task, adapter, jobId, vault };
}

describe("Task sync worker", () => {
  it("sends only the fixed task payload and records the returned external ID", async () => {
    const fixture = await createPendingTask({ secret: "adapter-token" });
    let clientConfig: TaskAdapterClientConfig | undefined;
    let outbound: TaskAdapterUpsertPayload | undefined;
    let outboundIdempotencyKey: string | undefined;

    const result = await processTaskSync({
      ...fixture,
      taskId: fixture.task.id,
      adapterId: fixture.adapter.id,
      secretVault: fixture.vault,
      clientFactory: (config) => {
        clientConfig = config;
        return {
          upsert: async (payload, idempotencyKey) => {
            outbound = payload;
            outboundIdempotencyKey = idempotencyKey;
            return { externalId: `reference:${payload.taskId}` };
          }
        };
      }
    });

    expect(clientConfig).toEqual({
      baseUrl: "http://task-adapter-reference:4200",
      bearerToken: "adapter-token",
      allowPrivate: true
    });
    expect(outbound).toMatchObject({
      taskId: fixture.task.id,
      meetingId: fixture.task.meetingId,
      decisionId: fixture.task.decisionId,
      title: "Implement sync",
      status: "todo",
      allowedTools: ["task-adapter.upsert"]
    });
    expect(JSON.stringify(outbound)).not.toContain("utterances");
    expect(outboundIdempotencyKey).toMatch(new RegExp(`^${fixture.task.id}:[a-f0-9]{64}$`));
    expect(result.sync).toMatchObject({
      status: "synced",
      externalId: `reference:${fixture.task.id}`,
      lastError: null
    });
  });

  it("rejects a stale job without contacting the adapter", async () => {
    const fixture = await createPendingTask();
    const queued = (await fixture.store.getSnapshot()).tasks.find((item) => item.id === fixture.task.id)!;
    await fixture.store.failTaskSync({
      taskId: fixture.task.id,
      adapterId: fixture.adapter.id,
      jobId: fixture.jobId,
      requestFingerprint: queued.sync.requestFingerprint!
    }, "first_attempt_failed");
    await fixture.store.markTaskSyncPending(
      fixture.task.id,
      "task-sync-job-2",
      taskSyncAdmissionInput(fixture.task, fixture.adapter.id)
    );
    let called = false;

    await expect(processTaskSync({
      ...fixture,
      taskId: fixture.task.id,
      adapterId: fixture.adapter.id,
      clientFactory: () => ({
        upsert: async () => {
          called = true;
          return { externalId: "not-used" };
        }
      })
    })).rejects.toMatchObject({ name: "StaleTaskSyncError" });
    expect(called).toBe(false);
  });

  it("retries the retained job with the latest payload when the Task changes during outbound sync", async () => {
    const fixture = await createPendingTask();
    let releaseUpsert!: () => void;
    let signalUpsert!: () => void;
    const upsertStarted = new Promise<void>((resolve) => { signalUpsert = resolve; });
    const upsertGate = new Promise<void>((resolve) => { releaseUpsert = resolve; });
    const outbound: TaskAdapterUpsertPayload[] = [];
    const idempotencyKeys: string[] = [];
    const pending = processTaskSync({
      ...fixture,
      taskId: fixture.task.id,
      adapterId: fixture.adapter.id,
      clientFactory: () => ({
        upsert: async (payload, idempotencyKey) => {
          outbound.push(payload);
          idempotencyKeys.push(idempotencyKey);
          if (outbound.length === 1) {
            signalUpsert();
            await upsertGate;
            return { externalId: "stable-external-task" };
          }
          return { externalId: "stable-external-task" };
        }
      })
    });
    await upsertStarted;

    await fixture.store.updateTask(fixture.task.id, {
      expectedRevision: fixture.task.revision,
      expectedExecutionRevision: fixture.task.execution.revision,
      title: "Updated while sync was running"
    });
    releaseUpsert();

    const synced = await pending;
    expect(outbound).toHaveLength(2);
    expect(outbound[0]).toMatchObject({ title: "Implement sync" });
    expect(outbound[1]).toMatchObject({ title: "Updated while sync was running" });
    expect(new Set(idempotencyKeys).size).toBe(2);
    expect(idempotencyKeys.every((key) => key.startsWith(`${fixture.task.id}:`))).toBe(true);
    expect(synced.sync).toMatchObject({
      status: "synced",
      jobId: fixture.jobId,
      externalId: "stable-external-task"
    });
  });

  it("fails closed when one Task receives different external identities across refreshed payloads", async () => {
    const fixture = await createPendingTask();
    let attempts = 0;

    await expect(processTaskSync({
      ...fixture,
      taskId: fixture.task.id,
      adapterId: fixture.adapter.id,
      clientFactory: () => ({
        upsert: async () => {
          attempts += 1;
          if (attempts === 1) {
            const current = (await fixture.store.getSnapshot()).tasks.find((item) => item.id === fixture.task.id)!;
            await fixture.store.updateTask(fixture.task.id, {
              expectedRevision: current.revision,
              expectedExecutionRevision: current.execution.revision,
              title: "Changed during identity check"
            });
            return { externalId: "external-task-one" };
          }
          return { externalId: "external-task-two" };
        }
      })
    })).rejects.toMatchObject({
      name: "TaskSyncExternalIdentityChangedError",
      requestFingerprint: expect.any(String)
    });

    expect(attempts).toBe(2);
    expect((await fixture.store.getSnapshot()).tasks.find((item) => item.id === fixture.task.id)).toMatchObject({
      sync: { status: "queued", externalId: null }
    });
  });

  it("rebases a failed stale payload before consuming a provider retry", async () => {
    const fixture = await createPendingTask();
    let releaseUpsert!: () => void;
    let signalUpsert!: () => void;
    const upsertStarted = new Promise<void>((resolve) => { signalUpsert = resolve; });
    const upsertGate = new Promise<void>((resolve) => { releaseUpsert = resolve; });
    const outbound: TaskAdapterUpsertPayload[] = [];
    const pending = processTaskSync({
      ...fixture,
      taskId: fixture.task.id,
      adapterId: fixture.adapter.id,
      clientFactory: () => ({
        upsert: async (payload) => {
          outbound.push(payload);
          if (outbound.length === 1) {
            signalUpsert();
            await upsertGate;
            throw new Error("stale payload provider failure");
          }
          return { externalId: "rebased-external-task" };
        }
      })
    });
    await upsertStarted;
    await fixture.store.updateTask(fixture.task.id, {
      expectedRevision: fixture.task.revision,
      expectedExecutionRevision: fixture.task.execution.revision,
      title: "New payload after stale failure"
    });
    releaseUpsert();

    const synced = await pending;
    expect(outbound).toHaveLength(2);
    expect(outbound[1]).toMatchObject({ title: "New payload after stale failure" });
    expect(synced.sync).toMatchObject({ status: "synced", externalId: "rebased-external-task" });
  });

  it("bounds continuous payload churn without misclassifying it as a provider failure", async () => {
    const fixture = await createPendingTask();
    let attempts = 0;

    await expect(processTaskSync({
      ...fixture,
      taskId: fixture.task.id,
      adapterId: fixture.adapter.id,
      clientFactory: () => ({
        upsert: async () => {
          attempts += 1;
          const current = (await fixture.store.getSnapshot()).tasks.find((item) => item.id === fixture.task.id)!;
          await fixture.store.updateTask(fixture.task.id, {
            expectedRevision: current.revision,
            expectedExecutionRevision: current.execution.revision,
            description: `Payload churn ${attempts}`
          });
          return { externalId: "churn-stable" };
        }
      })
    })).rejects.toMatchObject({
      name: "TaskSyncPayloadChangedError",
      requestFingerprint: expect.any(String)
    });

    expect(attempts).toBe(4);
    expect((await fixture.store.getSnapshot()).tasks.find((item) => item.id === fixture.task.id)).toMatchObject({
      sync: { status: "queued", lastError: null }
    });
  });

  it("retries when the queued job becomes visible before its Task state commit", async () => {
    const fixture = await createPendingTask({ pending: false });
    let called = false;

    await expect(processTaskSync({
      ...fixture,
      taskId: fixture.task.id,
      adapterId: fixture.adapter.id,
      clientFactory: () => ({
        upsert: async () => {
          called = true;
          return { externalId: "not-used" };
        }
      })
    })).rejects.toMatchObject({ name: "TaskSyncNotReadyError" });
    expect(called).toBe(false);
    expect((await fixture.store.getSnapshot()).tasks.find((item) => item.id === fixture.task.id)?.sync.status).toBe("not_synced");
  });

  it("marks only the matching final failure and preserves the internal task", async () => {
    const fixture = await createPendingTask();
    const queued = (await fixture.store.getSnapshot()).tasks.find((item) => item.id === fixture.task.id)!;
    const binding = {
      taskId: fixture.task.id,
      adapterId: fixture.adapter.id,
      jobId: fixture.jobId,
      requestFingerprint: queued.sync.requestFingerprint!
    };
    const failed = await recordTaskSyncFailure(fixture.store, binding);
    expect(failed.status).toBe("updated");
    expect(failed.task).toMatchObject({
      id: fixture.task.id,
      status: "todo",
      title: "Implement sync",
      sync: { status: "failed", lastError: "provider_or_runtime_failure" }
    });

    const stale = await recordTaskSyncFailure(fixture.store, { ...binding, jobId: "different-job" });
    expect(stale.status).toBe("stale");
    expect(stale.task.sync.status).toBe("failed");
  });
});
