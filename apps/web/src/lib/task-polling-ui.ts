import { projectionFreshnessLabel } from "./platform-projection";

export { projectionFreshnessLabel };

export const activeTaskPollingIntervalMs = 3_000;
export const idleTaskPollingIntervalMs = 30_000;

export function taskPollingDelayMs(activeWork: boolean, consecutiveFailures: number): number {
  const base = activeWork ? activeTaskPollingIntervalMs : idleTaskPollingIntervalMs;
  if (consecutiveFailures <= 0) return base;
  const backoff = activeTaskPollingIntervalMs * (2 ** Math.min(consecutiveFailures, 4));
  return Math.min(idleTaskPollingIntervalMs, Math.max(base, backoff));
}

export interface TaskPollingEnvironment {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
  isVisible(): boolean;
  subscribeVisibility(listener: () => void): () => void;
}

export interface TaskPollingLoopOptions {
  activeWork: boolean;
  refresh(): Promise<void>;
  environment?: TaskPollingEnvironment;
}

function browserTaskPollingEnvironment(): TaskPollingEnvironment {
  return {
    schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
    cancel: (handle) => window.clearTimeout(handle as number),
    isVisible: () => document.visibilityState === "visible",
    subscribeVisibility: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    }
  };
}

export function startTaskPollingLoop(options: TaskPollingLoopOptions): () => void {
  const environment = options.environment ?? browserTaskPollingEnvironment();
  let stopped = false;
  let timer: unknown | null = null;
  let inFlight = false;
  let wakeRequested = false;
  let consecutiveFailures = 0;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = environment.schedule(() => {
      timer = null;
      void runCycle();
    }, delayMs);
  };
  const runCycle = async () => {
    if (stopped || inFlight) return;
    if (!environment.isVisible()) {
      schedule(idleTaskPollingIntervalMs);
      return;
    }
    inFlight = true;
    try {
      await options.refresh();
      consecutiveFailures = 0;
    } catch {
      consecutiveFailures += 1;
    } finally {
      inFlight = false;
    }
    if (stopped) return;
    const delayMs = wakeRequested ? 0 : taskPollingDelayMs(options.activeWork, consecutiveFailures);
    wakeRequested = false;
    schedule(delayMs);
  };
  const onVisibilityChange = () => {
    if (!environment.isVisible()) return;
    if (timer !== null) {
      environment.cancel(timer);
      timer = null;
    }
    if (inFlight) {
      wakeRequested = true;
      return;
    }
    schedule(0);
  };

  schedule(taskPollingDelayMs(options.activeWork, 0));
  const unsubscribeVisibility = environment.subscribeVisibility(onVisibilityChange);
  return () => {
    stopped = true;
    if (timer !== null) environment.cancel(timer);
    timer = null;
    unsubscribeVisibility();
  };
}

export const taskProjectionStatusLabel = projectionFreshnessLabel;
