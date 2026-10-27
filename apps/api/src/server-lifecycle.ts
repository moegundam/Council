export const API_SHUTDOWN_DEADLINE_MS = 8_000;
export const API_SHUTDOWN_FALLBACK_MS = 4_000;

export interface ApiShutdownResource {
  name: string;
  close: () => void | Promise<void>;
}

export interface ApiShutdownOptions {
  deadlineMs?: number;
  fallbackMs?: number;
}

export interface ApiShutdownFailure {
  resource: string;
  error: unknown;
}

export class ApiShutdownError extends Error {
  constructor(public readonly failures: readonly ApiShutdownFailure[]) {
    super(`API shutdown failed while closing: ${failures.map((failure) => failure.resource).join(", ")}.`);
    this.name = "ApiShutdownError";
  }
}

export class ApiShutdownDeadlineError extends Error {
  constructor(public readonly deadlineMs: number) {
    super(`API shutdown exceeded its ${deadlineMs}ms application deadline.`);
    this.name = "ApiShutdownDeadlineError";
  }
}

export function createApiShutdown(
  resources: readonly ApiShutdownResource[],
  options: ApiShutdownOptions = {}
): () => Promise<void> {
  const deadlineMs = options.deadlineMs ?? API_SHUTDOWN_DEADLINE_MS;
  const fallbackMs = options.fallbackMs ?? API_SHUTDOWN_FALLBACK_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
    throw new Error("API shutdown deadline must be a positive integer.");
  }
  if (!Number.isSafeInteger(fallbackMs) || fallbackMs < 1) {
    throw new Error("API shutdown fallback window must be a positive integer.");
  }
  let shutdownPromise: Promise<void> | undefined;

  return () => {
    if (shutdownPromise) return shutdownPromise;

    const closeAttempts = new Map<ApiShutdownResource, Promise<ApiShutdownFailure | null>>();
    const closeOnce = (resource: ApiShutdownResource): Promise<ApiShutdownFailure | null> => {
      const existing = closeAttempts.get(resource);
      if (existing) return existing;
      let attempt: Promise<ApiShutdownFailure | null>;
      try {
        attempt = Promise.resolve(resource.close()).then(
          () => null,
          (error: unknown) => ({ resource: resource.name, error })
        );
      } catch (error) {
        attempt = Promise.resolve({ resource: resource.name, error });
      }
      closeAttempts.set(resource, attempt);
      return attempt;
    };
    const cleanup = (async () => {
      const failures: ApiShutdownFailure[] = [];
      for (const resource of resources) {
        const failure = await closeOnce(resource);
        if (failure) failures.push(failure);
      }
      return failures;
    })();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
      deadlineTimer = setTimeout(() => resolve("deadline"), deadlineMs);
      deadlineTimer.unref?.();
    });

    shutdownPromise = Promise.race([
      cleanup.then((failures) => ({ kind: "cleanup" as const, failures })),
      deadline.then(() => ({ kind: "deadline" as const }))
    ]).then(async (outcome) => {
      if (outcome.kind === "deadline") {
        const fallbackAttempts = resources.map((resource) => closeOnce(resource));
        let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
        const fallbackDeadline = new Promise<void>((resolve) => {
          fallbackTimer = setTimeout(resolve, fallbackMs);
          fallbackTimer.unref?.();
        });
        await Promise.race([
          Promise.all(fallbackAttempts).then(() => undefined),
          fallbackDeadline
        ]);
        if (fallbackTimer) clearTimeout(fallbackTimer);
        throw new ApiShutdownDeadlineError(deadlineMs);
      }
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (outcome.failures.length > 0) throw new ApiShutdownError(outcome.failures);
    });
    return shutdownPromise;
  };
}
