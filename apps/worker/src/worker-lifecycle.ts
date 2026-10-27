export const WORKER_SHUTDOWN_DEADLINE_MS = 25_000;
export const WORKER_SHUTDOWN_FALLBACK_MS = 5_000;
export const WORKER_HEALTH_CHECK_TIMEOUT_MS = 3_000;

export const DEFERRED_BULLMQ_WORKER_OPTIONS = Object.freeze({ autorun: false as const });

type AsyncAction = () => void | Promise<void>;
type InFlightAction<T> = () => T | PromiseLike<T>;

export interface WorkerLifecycleDependency {
  name: string;
  close: AsyncAction;
}

export interface WorkerLifecycleOptions {
  cancelScheduledWork: () => void;
  closeHealthIntake: AsyncAction;
  stopWorkerIntake: AsyncAction;
  closeWorker: (force: boolean) => void | Promise<void>;
  dependencies: readonly WorkerLifecycleDependency[];
  deadlineMs?: number;
  fallbackMs?: number;
  onDeadline?: () => void;
  onResourceCloseError?: (resource: string, error: unknown) => void;
}

export interface WorkerShutdownFailure {
  resource: string;
  error: unknown;
}

export interface WorkerShutdownResult {
  deadlineExceeded: false;
}

export class WorkerShutdownError extends Error {
  constructor(public readonly failures: readonly WorkerShutdownFailure[]) {
    super(`Worker shutdown failed while closing: ${failures.map((failure) => failure.resource).join(", ")}.`);
    this.name = "WorkerShutdownError";
  }
}

export class WorkerShutdownDeadlineError extends Error {
  constructor(
    public readonly deadlineMs: number,
    public readonly forceCloseCompletion: Promise<readonly WorkerShutdownFailure[]> = Promise.resolve([])
  ) {
    super(`Worker shutdown exceeded its ${deadlineMs}ms application deadline.`);
    this.name = "WorkerShutdownDeadlineError";
  }
}

export interface WorkerLifecycle {
  isHealthAvailable(): boolean;
  markReady(): void;
  runInFlight<T>(action: InFlightAction<T>): Promise<T>;
  shutdown(): Promise<WorkerShutdownResult>;
  trackInFlight<T>(operation: Promise<T>): Promise<T>;
}

export interface WorkerStartupOptions<TShutdownRequest> {
  openHealthIntake: () => Promise<void>;
  armShutdown: () => Promise<TShutdownRequest>;
  closeAllocatedResources?: AsyncAction;
  markReady: () => void;
  startWorker: () => Promise<void>;
}

export interface ArmedWorkerStartup<TShutdownRequest> {
  shutdownRequested: Promise<TShutdownRequest>;
  workerRun: Promise<void>;
}

export interface WorkerHealthIntakeOptions {
  open: () => Promise<void>;
  close: () => Promise<void>;
}

export interface WorkerHealthIntake {
  open(): Promise<void>;
  close(): Promise<void>;
}

export class WorkerAdmissionClosedError extends Error {
  constructor() {
    super("Worker admission is closed.");
    this.name = "WorkerAdmissionClosedError";
  }
}

export function createWorkerHealthIntake(options: WorkerHealthIntakeOptions): WorkerHealthIntake {
  let openPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let closeRequested = false;
  let opened = false;

  return {
    open: () => {
      if (closeRequested) return Promise.reject(new WorkerAdmissionClosedError());
      if (!openPromise) {
        openPromise = Promise.resolve()
          .then(options.open)
          .then(() => {
            opened = true;
          });
      }
      return openPromise;
    },
    close: () => {
      if (closePromise) return closePromise;
      closeRequested = true;
      closePromise = (async () => {
        if (!openPromise) return;
        try {
          await openPromise;
        } catch {
          return;
        }
        if (!opened) return;
        opened = false;
        await options.close();
      })();
      return closePromise;
    }
  };
}

export async function withWorkerHealthCheckTimeout<T>(
  action: Promise<T>,
  timeoutMs = WORKER_HEALTH_CHECK_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Worker health dependency check timed out.")), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function armWorkerStartup<TShutdownRequest>(
  options: WorkerStartupOptions<TShutdownRequest>
): Promise<ArmedWorkerStartup<TShutdownRequest>> {
  try {
    const shutdownRequested = options.armShutdown();
    await options.openHealthIntake();
    options.markReady();
    const workerRun = options.startWorker();
    return { shutdownRequested, workerRun };
  } catch (startupError) {
    try {
      await options.closeAllocatedResources?.();
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        "Worker startup failed and allocated resources could not be closed."
      );
    }
    throw startupError;
  }
}

export function createWorkerLifecycle(options: WorkerLifecycleOptions): WorkerLifecycle {
  const deadlineMs = options.deadlineMs ?? WORKER_SHUTDOWN_DEADLINE_MS;
  const fallbackMs = options.fallbackMs ?? WORKER_SHUTDOWN_FALLBACK_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
    throw new Error("Worker shutdown deadline must be a positive integer.");
  }
  if (!Number.isSafeInteger(fallbackMs) || fallbackMs < 1) {
    throw new Error("Worker shutdown fallback window must be a positive integer.");
  }
  const inFlight = new Set<Promise<void>>();
  const closeAttempts = new Map<string, Promise<WorkerShutdownFailure | null>>();
  let admissionOpen = true;
  let healthAvailable = false;
  let shutdownPromise: Promise<WorkerShutdownResult> | undefined;

  const reportCloseError = (resource: string, error: unknown) => {
    try {
      options.onResourceCloseError?.(resource, error);
    } catch {
      // Shutdown reporting must not prevent the remaining close attempts.
    }
  };

  const closeOnce = (resource: string, action: AsyncAction): Promise<WorkerShutdownFailure | null> => {
    const existing = closeAttempts.get(resource);
    if (existing) return existing;

    let result: void | Promise<void>;
    try {
      result = action();
    } catch (error) {
      reportCloseError(resource, error);
      const failed = Promise.resolve({ resource, error });
      closeAttempts.set(resource, failed);
      return failed;
    }

    const attempt = Promise.resolve(result).then(
      () => null,
      (error: unknown) => {
        reportCloseError(resource, error);
        return { resource, error };
      }
    );
    closeAttempts.set(resource, attempt);
    return attempt;
  };

  const waitForInFlight = async (): Promise<void> => {
    while (inFlight.size > 0) {
      await Promise.all(inFlight);
    }
  };

  const trackInFlight = <T>(operation: Promise<T>): Promise<T> => {
    let observer!: Promise<void>;
    observer = operation.then(
      () => {
        inFlight.delete(observer);
      },
      () => {
        inFlight.delete(observer);
      }
    );
    inFlight.add(observer);
    return operation;
  };

  const runInFlight = <T>(action: InFlightAction<T>): Promise<T> => {
    if (!admissionOpen) return Promise.reject(new WorkerAdmissionClosedError());

    // Reserve the barrier slot before user code can start or yield.
    return trackInFlight(Promise.resolve().then(action));
  };

  const shutdown = (): Promise<WorkerShutdownResult> => {
    if (shutdownPromise) return shutdownPromise;

    admissionOpen = false;
    let resolveShutdown!: (result: WorkerShutdownResult) => void;
    let rejectShutdown!: (error: unknown) => void;
    shutdownPromise = new Promise<WorkerShutdownResult>((resolve, reject) => {
      resolveShutdown = resolve;
      rejectShutdown = reject;
    });

    healthAvailable = false;
    const scheduledWorkClose = closeOnce("scheduled-work", options.cancelScheduledWork);
    const healthIntakeClose = closeOnce("health-intake", options.closeHealthIntake);
    const workerIntakeClose = closeOnce("worker-intake", options.stopWorkerIntake);

    const gracefulCleanup = async (): Promise<WorkerShutdownFailure[]> => {
      await workerIntakeClose;
      await waitForInFlight();

      const workerClose = await closeOnce("worker", () => options.closeWorker(true));
      const dependencyCloses = await Promise.all(
        options.dependencies.map((dependency) => closeOnce(dependency.name, dependency.close))
      );
      const immediateCloses = await Promise.all([scheduledWorkClose, healthIntakeClose, workerIntakeClose]);
      return [...immediateCloses, workerClose, ...dependencyCloses].filter(
        (failure): failure is WorkerShutdownFailure => failure !== null
      );
    };

    const cleanup = gracefulCleanup();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
      deadlineTimer = setTimeout(() => resolve("deadline"), deadlineMs);
      deadlineTimer.unref?.();
    });

    const completion = Promise.race([
      cleanup.then((failures) => ({ kind: "cleanup" as const, failures })),
      deadline.then(() => ({ kind: "deadline" as const }))
    ]).then(async (outcome) => {
      if (outcome.kind === "cleanup") {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (outcome.failures.length > 0) throw new WorkerShutdownError(outcome.failures);
        return { deadlineExceeded: false } as const;
      }

      // Force-closing BullMQ abandons unfinished jobs without acknowledging them;
      // their locks expire and BullMQ can retry them after the process terminates.
      const forcedCloses = [
        scheduledWorkClose,
        healthIntakeClose,
        workerIntakeClose,
        closeOnce("worker", () => options.closeWorker(true)),
        ...options.dependencies.map((dependency) => closeOnce(dependency.name, dependency.close))
      ];
      const forceCloseCompletion = Promise.all(forcedCloses).then((failures) => failures.filter(
        (failure): failure is WorkerShutdownFailure => failure !== null
      ));
      let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
      const fallbackDeadline = new Promise<void>((resolve) => {
        fallbackTimer = setTimeout(resolve, fallbackMs);
        fallbackTimer.unref?.();
      });
      await Promise.race([
        forceCloseCompletion.then(() => undefined),
        fallbackDeadline
      ]);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      try {
        options.onDeadline?.();
      } catch {
        // The terminal deadline error remains authoritative for embedders that do not terminate here.
      }
      throw new WorkerShutdownDeadlineError(deadlineMs, forceCloseCompletion);
    });

    completion.then(resolveShutdown, rejectShutdown);
    return shutdownPromise;
  };

  return {
    isHealthAvailable: () => healthAvailable,
    markReady: () => {
      if (shutdownPromise) throw new Error("Worker cannot become ready after shutdown has started.");
      healthAvailable = true;
    },
    runInFlight,
    shutdown,
    trackInFlight
  };
}
