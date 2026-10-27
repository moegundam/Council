import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  armWorkerStartup,
  createWorkerHealthIntake,
  createWorkerLifecycle,
  DEFERRED_BULLMQ_WORKER_OPTIONS,
  WorkerAdmissionClosedError,
  withWorkerHealthCheckTimeout,
  WorkerShutdownDeadlineError,
  WorkerShutdownError,
  WORKER_HEALTH_CHECK_TIMEOUT_MS
} from "./worker-lifecycle.js";

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

describe("Worker lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("arms shutdown before health intake and explicitly starts a non-autorun BullMQ Worker", async () => {
    const events: string[] = [];
    const shutdownRequested = createDeferred<NodeJS.Signals>();
    const workerRun = createDeferred();

    const startup = await armWorkerStartup({
      openHealthIntake: async () => {
        events.push("health");
      },
      armShutdown: () => {
        events.push("shutdown");
        return shutdownRequested.promise;
      },
      markReady: () => {
        events.push("ready");
      },
      startWorker: () => {
        events.push("worker");
        return workerRun.promise;
      }
    });

    expect(DEFERRED_BULLMQ_WORKER_OPTIONS).toEqual({ autorun: false });
    expect(events).toEqual(["shutdown", "health", "ready", "worker"]);
    expect(startup.shutdownRequested).toBe(shutdownRequested.promise);
    expect(startup.workerRun).toBe(workerRun.promise);
  });

  it("installs shutdown ownership while startup health intake is still pending", async () => {
    const healthIntake = createDeferred();
    const shutdownRequested = createDeferred<NodeJS.Signals>();
    const armShutdown = vi.fn(() => shutdownRequested.promise);
    const startup = armWorkerStartup({
      openHealthIntake: () => healthIntake.promise,
      armShutdown,
      markReady: vi.fn(),
      startWorker: vi.fn(async () => undefined)
    });

    await Promise.resolve();
    expect(armShutdown).toHaveBeenCalledTimes(1);

    healthIntake.resolve();
    await startup;
  });

  it("waits for an in-progress health listen before closing the intake", async () => {
    const listening = createDeferred();
    const close = vi.fn(async () => undefined);
    const intake = createWorkerHealthIntake({
      open: () => listening.promise,
      close
    });

    const opening = intake.open();
    await Promise.resolve();
    const closing = intake.close();
    expect(close).not.toHaveBeenCalled();

    listening.resolve();
    await expect(opening).resolves.toBeUndefined();
    await expect(closing).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
    await intake.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes every allocated resource exactly once when startup fails", async () => {
    const startupFailure = new Error("worker start failed");
    const closeHealthIntake = vi.fn(async () => undefined);
    const stopWorkerIntake = vi.fn(async () => undefined);
    const closeWorker = vi.fn(async () => undefined);
    const closeQueue = vi.fn(async () => undefined);
    const closePublisher = vi.fn(async () => undefined);
    const closeStore = vi.fn(async () => undefined);
    const lifecycle = createWorkerLifecycle({
      cancelScheduledWork: vi.fn(),
      closeHealthIntake,
      stopWorkerIntake,
      closeWorker,
      dependencies: [
        { name: "queue", close: closeQueue },
        { name: "publisher", close: closePublisher },
        { name: "store", close: closeStore }
      ]
    });

    const startup = armWorkerStartup({
      openHealthIntake: async () => undefined,
      armShutdown: () => new Promise<NodeJS.Signals>(() => undefined),
      markReady: () => lifecycle.markReady(),
      startWorker: () => {
        throw startupFailure;
      },
      closeAllocatedResources: async () => {
        await lifecycle.shutdown();
      }
    });

    await expect(startup).rejects.toBe(startupFailure);
    expect(closeHealthIntake).toHaveBeenCalledTimes(1);
    expect(stopWorkerIntake).toHaveBeenCalledTimes(1);
    expect(closeWorker).toHaveBeenCalledTimes(1);
    expect(closeQueue).toHaveBeenCalledTimes(1);
    expect(closePublisher).toHaveBeenCalledTimes(1);
    expect(closeStore).toHaveBeenCalledTimes(1);

    await lifecycle.shutdown();
    expect(closeHealthIntake).toHaveBeenCalledTimes(1);
    expect(stopWorkerIntake).toHaveBeenCalledTimes(1);
    expect(closeWorker).toHaveBeenCalledTimes(1);
    expect(closeQueue).toHaveBeenCalledTimes(1);
    expect(closePublisher).toHaveBeenCalledTimes(1);
    expect(closeStore).toHaveBeenCalledTimes(1);
  });

  it("makes shutdown single-flight and closes intake while marking health unavailable synchronously", async () => {
    const cancelScheduledWork = vi.fn();
    const closeHealthIntake = vi.fn(async () => undefined);
    const stopWorkerIntake = vi.fn(async () => undefined);
    const closeWorker = vi.fn(async () => undefined);
    const closeStore = vi.fn(async () => undefined);
    const lifecycle = createWorkerLifecycle({
      cancelScheduledWork,
      closeHealthIntake,
      stopWorkerIntake,
      closeWorker,
      dependencies: [{ name: "store", close: closeStore }]
    });
    lifecycle.markReady();

    const first = lifecycle.shutdown();
    const second = lifecycle.shutdown();

    expect(first).toBe(second);
    expect(lifecycle.isHealthAvailable()).toBe(false);
    expect(cancelScheduledWork).toHaveBeenCalledTimes(1);
    expect(closeHealthIntake).toHaveBeenCalledTimes(1);
    expect(stopWorkerIntake).toHaveBeenCalledTimes(1);
    await expect(first).resolves.toEqual({ deadlineExceeded: false });
    expect(closeWorker).toHaveBeenCalledTimes(1);
    expect(closeStore).toHaveBeenCalledTimes(1);
  });

  it("reserves admitted work before it starts and rejects admission after shutdown begins", async () => {
    const work = createDeferred<string>();
    const action = vi.fn(() => work.promise);
    const closeWorker = vi.fn(async () => undefined);
    const lifecycle = createWorkerLifecycle({
      cancelScheduledWork: vi.fn(),
      closeHealthIntake: vi.fn(async () => undefined),
      stopWorkerIntake: vi.fn(async () => undefined),
      closeWorker,
      dependencies: []
    });

    const admitted = lifecycle.runInFlight(action);
    const shutdown = lifecycle.shutdown();
    const lateAction = vi.fn(async () => undefined);

    await expect(lifecycle.runInFlight(lateAction)).rejects.toBeInstanceOf(WorkerAdmissionClosedError);
    expect(lateAction).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(action).toHaveBeenCalledTimes(1);
    expect(closeWorker).not.toHaveBeenCalled();

    work.resolve("completed");
    await expect(admitted).resolves.toBe("completed");
    await expect(shutdown).resolves.toEqual({ deadlineExceeded: false });
    expect(closeWorker).toHaveBeenCalledTimes(1);
  });

  it("bounds Worker health dependency checks", async () => {
    vi.useFakeTimers();
    const result = withWorkerHealthCheckTimeout(
      new Promise<void>(() => undefined),
      WORKER_HEALTH_CHECK_TIMEOUT_MS
    ).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(WORKER_HEALTH_CHECK_TIMEOUT_MS - 1);
    expect(await Promise.race([result, Promise.resolve("pending")])).toBe("pending");

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual(expect.objectContaining({
      message: "Worker health dependency check timed out."
    }));
  });

  it("rejects invalid shutdown deadline and fallback budgets", () => {
    const options = {
      cancelScheduledWork: vi.fn(),
      closeHealthIntake: vi.fn(),
      stopWorkerIntake: vi.fn(),
      closeWorker: vi.fn(),
      dependencies: []
    };

    expect(() => createWorkerLifecycle({ ...options, deadlineMs: 0 }))
      .toThrow("Worker shutdown deadline must be a positive integer.");
    expect(() => createWorkerLifecycle({ ...options, fallbackMs: 0 }))
      .toThrow("Worker shutdown fallback window must be a positive integer.");
  });

  it("wires admission, startup cleanup, bounded health, and terminal deadlines into the Worker server", () => {
    const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");

    expect(source).toContain("lifecycle.runInFlight(() => observability.observeJob({");
    expect(source).toContain("await withWorkerHealthCheckTimeout(Promise.all(checks));");
    expect(source).toContain("const healthIntake = createWorkerHealthIntake({");
    expect(source).toContain("closeHealthIntake: () => healthIntake.close(),");
    expect(source).toContain("await healthIntake.open();");
    expect(source).toMatch(/closeAllocatedResources:\s*async \(\) => \{\s*await lifecycle\.shutdown\(\);\s*\}/);
    expect(source.match(/deliveryAttempt: job\.attemptsStarted/g)).toHaveLength(2);
    expect(source).toContain('await publishTaskChanged(completed, "agent_run_completed", jobId);');
    expect(source).toContain('await publishTaskChanged(completed, "sync_completed", jobId);');
    expect(source).toContain('await publishTaskChanged(failed.task, "sync_failed", jobId);');

    const deadlineHandler = source.slice(
      source.indexOf("onDeadline: () => {"),
      source.indexOf("onResourceCloseError:")
    );
    expect(deadlineHandler).toContain("process.exit(1);");
  });

  it("attempts every later resource close when an earlier close rejects", async () => {
    const closeFailure = new Error("worker close failed");
    const closeWorker = vi.fn(async () => {
      throw closeFailure;
    });
    const closeQueue = vi.fn(async () => {
      throw new Error("queue close failed");
    });
    const closePublisher = vi.fn(async () => undefined);
    const closeStore = vi.fn(async () => undefined);
    const lifecycle = createWorkerLifecycle({
      cancelScheduledWork: vi.fn(),
      closeHealthIntake: vi.fn(async () => undefined),
      stopWorkerIntake: vi.fn(async () => undefined),
      closeWorker,
      dependencies: [
        { name: "queue", close: closeQueue },
        { name: "publisher", close: closePublisher },
        { name: "store", close: closeStore }
      ]
    });

    const result = lifecycle.shutdown().catch((error: unknown) => error);

    await expect(result).resolves.toBeInstanceOf(WorkerShutdownError);
    const error = await result as WorkerShutdownError;
    expect(error.failures.map((failure) => failure.resource)).toEqual(["worker", "queue"]);
    expect(closeWorker).toHaveBeenCalledTimes(1);
    expect(closeQueue).toHaveBeenCalledTimes(1);
    expect(closePublisher).toHaveBeenCalledTimes(1);
    expect(closeStore).toHaveBeenCalledTimes(1);
  });

  it("forces retry-safe closure at the deadline instead of waiting forever for in-flight reconciliation", async () => {
    vi.useFakeTimers();
    const deadlineMs = 5;
    const fallbackMs = 3;
    const reconciliation = createDeferred();
    const storeClose = createDeferred();
    const closeWorker = vi.fn(async () => undefined);
    const closeStore = vi.fn(() => storeClose.promise);
    const onDeadline = vi.fn();
    const lifecycle = createWorkerLifecycle({
      cancelScheduledWork: vi.fn(),
      closeHealthIntake: vi.fn(async () => undefined),
      stopWorkerIntake: vi.fn(async () => undefined),
      closeWorker,
      dependencies: [{ name: "store", close: closeStore }],
      deadlineMs,
      fallbackMs,
      onDeadline
    });
    lifecycle.trackInFlight(reconciliation.promise);

    const result = lifecycle.shutdown().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(deadlineMs - 1);
    expect(closeWorker).not.toHaveBeenCalled();
    expect(closeStore).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(closeWorker).toHaveBeenCalledWith(true);
    expect(closeStore).toHaveBeenCalledTimes(1);
    expect(onDeadline).not.toHaveBeenCalled();

    storeClose.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toBeInstanceOf(WorkerShutdownDeadlineError);
    const deadlineError = await result as WorkerShutdownDeadlineError;
    expect(deadlineError.deadlineMs).toBe(deadlineMs);
    expect(onDeadline).toHaveBeenCalledTimes(1);
    await expect(deadlineError.forceCloseCompletion).resolves.toEqual([]);
    reconciliation.reject(new Error("reconciler completed after deadline"));
    await vi.runAllTimersAsync();
    expect(closeWorker).toHaveBeenCalledTimes(1);
    expect(closeStore).toHaveBeenCalledTimes(1);
  });

  it("bounds forced resource closes before invoking the terminal deadline handler", async () => {
    vi.useFakeTimers();
    const deadlineMs = 5;
    const fallbackMs = 3;
    const never = new Promise<void>(() => undefined);
    const onDeadline = vi.fn();
    const lifecycle = createWorkerLifecycle({
      cancelScheduledWork: vi.fn(),
      closeHealthIntake: vi.fn(async () => undefined),
      stopWorkerIntake: vi.fn(async () => undefined),
      closeWorker: vi.fn(() => never),
      dependencies: [{ name: "store", close: () => never }],
      deadlineMs,
      fallbackMs,
      onDeadline
    });

    const result = lifecycle.shutdown().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(deadlineMs);
    expect(onDeadline).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(fallbackMs - 1);
    expect(onDeadline).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBeInstanceOf(WorkerShutdownDeadlineError);
    expect(onDeadline).toHaveBeenCalledTimes(1);
  });
});
