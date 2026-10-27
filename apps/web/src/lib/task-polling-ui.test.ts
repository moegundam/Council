import { describe, expect, it } from "vitest";
import {
  activeTaskPollingIntervalMs,
  idleTaskPollingIntervalMs,
  startTaskPollingLoop,
  taskPollingDelayMs,
  taskProjectionStatusLabel
} from "./task-polling-ui";

function pollingEnvironment(initiallyVisible = true) {
  let nextId = 1;
  let visible = initiallyVisible;
  let visibilityListener: (() => void) | null = null;
  const timers = new Map<number, { callback: () => void; delayMs: number }>();
  return {
    environment: {
      schedule(callback: () => void, delayMs: number) {
        const id = nextId++;
        timers.set(id, { callback, delayMs });
        return id;
      },
      cancel(handle: unknown) {
        timers.delete(handle as number);
      },
      isVisible() {
        return visible;
      },
      subscribeVisibility(listener: () => void) {
        visibilityListener = listener;
        return () => {
          if (visibilityListener === listener) visibilityListener = null;
        };
      }
    },
    emitVisibility(nextVisible: boolean) {
      visible = nextVisible;
      visibilityListener?.();
    },
    onlyTimer() {
      expect(timers.size).toBe(1);
      return [...timers.entries()][0]!;
    },
    runTimer(id: number) {
      const timer = timers.get(id);
      if (!timer) throw new Error(`Timer ${id} is not scheduled.`);
      timers.delete(id);
      timer.callback();
    },
    timerCount() {
      return timers.size;
    }
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("Task polling UI", () => {
  it("uses one bounded backoff for active work and a low-rate idle refresh", () => {
    expect(taskPollingDelayMs(true, 0)).toBe(activeTaskPollingIntervalMs);
    expect(taskPollingDelayMs(true, 1)).toBe(6_000);
    expect(taskPollingDelayMs(true, 2)).toBe(12_000);
    expect(taskPollingDelayMs(true, 8)).toBe(idleTaskPollingIntervalMs);
    expect(taskPollingDelayMs(false, 0)).toBe(idleTaskPollingIntervalMs);
    expect(taskPollingDelayMs(false, 8)).toBe(idleTaskPollingIntervalMs);
  });

  it("labels a retained projection as stale without discarding it", () => {
    expect(taskProjectionStatusLabel({
      stale: true,
      refreshing: false,
      lastSuccessfulAt: "2026-08-18T01:00:00.000Z"
    })).toMatch(/^資料可能過期 · 上次更新 /);
    expect(taskProjectionStatusLabel({ stale: true, refreshing: false, lastSuccessfulAt: null }))
      .toBe("資料可能過期 · 上次更新 尚未成功更新");
    expect(taskProjectionStatusLabel({ stale: false, refreshing: true, lastSuccessfulAt: null }))
      .toBe("更新中");
    expect(taskProjectionStatusLabel({ stale: false, refreshing: false, lastSuccessfulAt: null }))
      .toBe("");
  });

  it("keeps a slow refresh single-flight and coalesces a visible-page wake", async () => {
    const browser = pollingEnvironment();
    const firstRefresh = deferred();
    let calls = 0;
    const stop = startTaskPollingLoop({
      activeWork: true,
      environment: browser.environment,
      refresh: async () => {
        calls += 1;
        if (calls === 1) await firstRefresh.promise;
      }
    });
    const [firstTimerId, firstTimer] = browser.onlyTimer();
    expect(firstTimer.delayMs).toBe(activeTaskPollingIntervalMs);

    browser.runTimer(firstTimerId);
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(browser.timerCount()).toBe(0);

    browser.emitVisibility(true);
    expect(browser.timerCount()).toBe(0);
    expect(calls).toBe(1);

    firstRefresh.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const [wakeTimerId, wakeTimer] = browser.onlyTimer();
    expect(wakeTimer.delayMs).toBe(0);

    browser.runTimer(wakeTimerId);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(2);
    expect(browser.onlyTimer()[1].delayMs).toBe(activeTaskPollingIntervalMs);
    stop();
    expect(browser.timerCount()).toBe(0);
  });

  it("does not refresh while hidden and refreshes immediately after becoming visible", async () => {
    const browser = pollingEnvironment(false);
    let calls = 0;
    const stop = startTaskPollingLoop({
      activeWork: true,
      environment: browser.environment,
      refresh: async () => {
        calls += 1;
      }
    });

    browser.runTimer(browser.onlyTimer()[0]);
    await Promise.resolve();
    expect(calls).toBe(0);
    expect(browser.onlyTimer()[1].delayMs).toBe(idleTaskPollingIntervalMs);

    browser.emitVisibility(true);
    const [wakeTimerId, wakeTimer] = browser.onlyTimer();
    expect(wakeTimer.delayMs).toBe(0);
    browser.runTimer(wakeTimerId);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    stop();
  });
});
