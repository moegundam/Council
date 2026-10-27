import { describe, expect, it, vi } from "vitest";
import {
  ApiShutdownDeadlineError,
  ApiShutdownError,
  createApiShutdown
} from "./server-lifecycle.js";

describe("API server lifecycle", () => {
  it("attempts every resource close in order and reports all failures", async () => {
    const calls: string[] = [];
    const shutdown = createApiShutdown([
      {
        name: "http-and-store",
        close: async () => {
          calls.push("http-and-store");
          throw new Error("store close failed");
        }
      },
      {
        name: "event-bus",
        close: () => {
          calls.push("event-bus");
          throw new Error("event bus close failed");
        }
      },
      {
        name: "agent-queue",
        close: async () => {
          calls.push("agent-queue");
        }
      }
    ]);

    const result = shutdown();
    await expect(result).rejects.toMatchObject({
      failures: [
        { resource: "http-and-store", error: expect.objectContaining({ message: "store close failed" }) },
        { resource: "event-bus", error: expect.objectContaining({ message: "event bus close failed" }) }
      ]
    });
    expect(calls).toEqual(["http-and-store", "event-bus", "agent-queue"]);
  });

  it("shares one shutdown attempt across repeated signals", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = vi.fn(async () => {
      await gate;
    });
    const shutdown = createApiShutdown([{ name: "http-and-store", close }]);

    const first = shutdown();
    const second = shutdown();

    expect(second).toBe(first);
    expect(close).toHaveBeenCalledOnce();
    release();
    await expect(first).resolves.toBeUndefined();
  });

  it("preserves graceful close order and starts remaining closes at the deadline", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      let releaseHttp!: () => void;
      const httpGate = new Promise<void>((resolve) => {
        releaseHttp = resolve;
      });
      let releaseEventBus!: () => void;
      const eventBusGate = new Promise<void>((resolve) => {
        releaseEventBus = resolve;
      });
      const shutdown = createApiShutdown([
        {
          name: "http-and-store",
          close: async () => {
            calls.push("http-and-store");
            await httpGate;
          }
        },
        {
          name: "event-bus",
          close: async () => {
            calls.push("event-bus");
            await eventBusGate;
          }
        },
        {
          name: "agent-queue",
          close: async () => {
            calls.push("agent-queue");
          }
        }
      ], { deadlineMs: 25, fallbackMs: 10 });

      const result = shutdown();
      expect(calls).toEqual(["http-and-store"]);
      await vi.advanceTimersByTimeAsync(24);
      let settled = false;
      void result.then(
        () => { settled = true; },
        () => { settled = true; }
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toEqual(["http-and-store", "event-bus", "agent-queue"]);
      expect(settled).toBe(false);
      releaseEventBus();
      releaseHttp();
      await vi.advanceTimersByTimeAsync(0);
      await expect(result).rejects.toMatchObject({
        name: "ApiShutdownDeadlineError",
        deadlineMs: 25
      });
      expect(new ApiShutdownDeadlineError(25).message)
        .toBe("API shutdown exceeded its 25ms application deadline.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds fallback closes after the graceful deadline", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<void>(() => undefined);
      const calls: string[] = [];
      const shutdown = createApiShutdown([
        { name: "http-and-store", close: async () => { calls.push("http-and-store"); await never; } },
        { name: "event-bus", close: async () => { calls.push("event-bus"); await never; } }
      ], { deadlineMs: 25, fallbackMs: 10 });

      const result = shutdown();
      let settled = false;
      void result.then(
        () => { settled = true; },
        () => { settled = true; }
      );
      await vi.advanceTimersByTimeAsync(25);
      expect(calls).toEqual(["http-and-store", "event-bus"]);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(9);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).rejects.toBeInstanceOf(ApiShutdownDeadlineError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes a bounded error message", () => {
    const error = new ApiShutdownError([
      { resource: "event-bus", error: new Error("secret internal detail") }
    ]);

    expect(error.message).toBe("API shutdown failed while closing: event-bus.");
    expect(error.message).not.toContain("secret internal detail");
  });
});
