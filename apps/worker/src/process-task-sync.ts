import type { TaskAdapterUpsertPayload } from "@council/contracts";
import { taskAdapterUpsertPayload, taskSyncRequestFingerprint, type PlatformStore } from "@council/database";
import type { SecretVault } from "@council/domain";
import { TaskAdapterClient, type TaskAdapterClientConfig } from "@council/runtime";

type TaskAdapterUpsertClient = Pick<TaskAdapterClient, "upsert">;

export type TaskSyncStore = Pick<PlatformStore,
  | "completeTaskSync"
  | "getConnectorSecret"
  | "getSnapshot"
>;

export type TaskSyncFailureStore = Pick<PlatformStore, "failTaskSync">;

export interface ProcessTaskSyncInput {
  store: TaskSyncStore;
  taskId: string;
  adapterId: string;
  jobId: string;
  secretVault?: SecretVault;
  clientFactory?: (config: TaskAdapterClientConfig) => TaskAdapterUpsertClient;
}

export class StaleTaskSyncError extends Error {
  constructor() {
    super("The queued Task sync is no longer current.");
    this.name = "StaleTaskSyncError";
  }
}

export class TaskSyncNotReadyError extends Error {
  constructor() {
    super("The queued Task sync is waiting for its Task state commit.");
    this.name = "TaskSyncNotReadyError";
  }
}

export class TaskSyncPayloadChangedError extends Error {
  constructor(
    readonly requestFingerprint: string,
    message = "The Task changed while its synchronization request was in flight."
  ) {
    super(message);
    this.name = "TaskSyncPayloadChangedError";
  }
}

export class TaskSyncExternalIdentityChangedError extends TaskSyncPayloadChangedError {
  constructor(requestFingerprint: string) {
    super(requestFingerprint, "The Task Adapter changed the external identity for one Task.");
    this.name = "TaskSyncExternalIdentityChangedError";
  }
}

export class TaskSyncAttemptError extends Error {
  constructor(readonly requestFingerprint: string, readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : "Task synchronization attempt failed.");
    this.name = "TaskSyncAttemptError";
  }
}

const maxPayloadRefreshes = 3;

export async function processTaskSync(input: ProcessTaskSyncInput) {
  let expectedExternalId: string | null = null;
  for (let refreshCount = 0; refreshCount <= maxPayloadRefreshes; refreshCount += 1) {
    const snapshot = await input.store.getSnapshot();
    const task = snapshot.tasks.find((item) => item.id === input.taskId);
    const adapter = snapshot.taskAdapterConnectors.find((item) => item.id === input.adapterId && item.enabled);
    if (!task) throw new Error("Task not found.");
    if (!adapter) throw new Error("Task Adapter connector is unavailable.");
    if (task.sync.status !== "queued") {
      if (task.sync.jobId !== input.jobId) throw new TaskSyncNotReadyError();
      throw new StaleTaskSyncError();
    }
    if (task.sync.jobId !== input.jobId || task.sync.adapterId !== input.adapterId) {
      throw new StaleTaskSyncError();
    }
    const requestFingerprint = taskSyncRequestFingerprint(task);
    if (!task.sync.requestFingerprint || task.sync.requestFingerprint !== requestFingerprint) {
      throw new StaleTaskSyncError();
    }
    if (task.sync.externalId) {
      if (expectedExternalId && expectedExternalId !== task.sync.externalId) {
        throw new TaskSyncExternalIdentityChangedError(requestFingerprint);
      }
      expectedExternalId = task.sync.externalId;
    }

    let response: Awaited<ReturnType<TaskAdapterUpsertClient["upsert"]>>;
    try {
      const ciphertext = await input.store.getConnectorSecret(adapter.id);
      if (adapter.hasSecret && (!ciphertext || !input.secretVault)) {
        throw new Error("Task Adapter secret is unavailable.");
      }
      const bearerToken = ciphertext && input.secretVault ? input.secretVault.decrypt(ciphertext) : undefined;
      const config: TaskAdapterClientConfig = {
        baseUrl: adapter.baseUrl,
        ...(bearerToken ? { bearerToken } : {}),
        allowPrivate: adapter.location === "local"
      };
      const client = input.clientFactory?.(config) ?? new TaskAdapterClient(config);
      response = await client.upsert(taskAdapterUpsertPayload(task), `${task.id}:${requestFingerprint}`);
    } catch (error) {
      let current;
      try {
        current = (await input.store.getSnapshot()).tasks.find((item) => item.id === input.taskId);
      } catch {
        throw new TaskSyncAttemptError(requestFingerprint, error);
      }
      if (!current
        || current.sync.status !== "queued"
        || current.sync.jobId !== input.jobId
        || current.sync.adapterId !== input.adapterId
        || !current.sync.requestFingerprint
        || current.sync.requestFingerprint !== taskSyncRequestFingerprint(current)) {
        throw new StaleTaskSyncError();
      }
      if (current.sync.requestFingerprint !== requestFingerprint) {
        if (refreshCount < maxPayloadRefreshes) continue;
        throw new TaskSyncPayloadChangedError(current.sync.requestFingerprint);
      }
      throw new TaskSyncAttemptError(requestFingerprint, error);
    }

    if (expectedExternalId && response.externalId !== expectedExternalId) {
      throw new TaskSyncExternalIdentityChangedError(requestFingerprint);
    }
    expectedExternalId = response.externalId;

    const committed = await input.store.completeTaskSync(task.id, input.jobId, response.externalId, requestFingerprint);
    if (committed.status !== "stale") return committed.task;
    if (committed.task.sync.status === "queued"
      && committed.task.sync.jobId === input.jobId
      && committed.task.sync.adapterId === input.adapterId
      && committed.task.sync.requestFingerprint) {
      if (refreshCount < maxPayloadRefreshes) continue;
      throw new TaskSyncPayloadChangedError(committed.task.sync.requestFingerprint);
    }
    throw new StaleTaskSyncError();
  }
  throw new TaskSyncPayloadChangedError("payload-refresh-limit");
}

export function recordTaskSyncFailure(
  store: TaskSyncFailureStore,
  binding: { taskId: string; adapterId: string; jobId: string; requestFingerprint: string },
  classification = "provider_or_runtime_failure"
) {
  return store.failTaskSync(binding, classification);
}
