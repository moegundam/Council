import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryPlatformStore } from "@council/database";
import { createApp } from "./app.js";
import { MeetingEventBus } from "./event-bus.js";
import { registerMeetingRoutes } from "./routes/meeting-routes.js";

describe("Meeting SSE route lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("unsubscribes a late Redis subscription when the client already disconnected", async () => {
    vi.useFakeTimers();
    let eventsHandler: ((request: any, reply: any) => Promise<unknown>) | undefined;
    const app = {
      get(path: string, handler: (request: any, reply: any) => Promise<unknown>) {
        if (path === "/api/meetings/:id/events") eventsHandler = handler;
        return this;
      },
      post() { return this; },
      patch() { return this; },
      addHook() { return this; }
    } as unknown as FastifyInstance;
    let resolveSubscription!: (unsubscribe: () => void) => void;
    const subscription = new Promise<() => void>((resolve) => { resolveSubscription = resolve; });
    const unsubscribe = vi.fn();
    const eventBus = {
      subscribe: vi.fn(async () => subscription)
    } as unknown as MeetingEventBus;
    registerMeetingRoutes(app, { store: {} as never, eventBus, authDisabled: true });
    const requestRaw = new EventEmitter();
    const replyRaw = { write: vi.fn(), writeHead: vi.fn() };
    const reply = { hijack: vi.fn(), raw: replyRaw };
    const request = {
      params: { id: "70000000-0000-4000-8000-000000000001" },
      raw: requestRaw,
      log: { error: vi.fn() }
    };

    const handling = eventsHandler!(request, reply);
    await vi.waitFor(() => expect(eventBus.subscribe).toHaveBeenCalledTimes(1));
    requestRaw.emit("close");
    resolveSubscription(unsubscribe);
    await handling;

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(replyRaw.writeHead).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for drain before writing later Meeting events to a slow client", async () => {
    vi.useFakeTimers();
    let eventsHandler: ((request: any, reply: any) => Promise<unknown>) | undefined;
    const app = {
      get(path: string, handler: (request: any, reply: any) => Promise<unknown>) {
        if (path === "/api/meetings/:id/events") eventsHandler = handler;
        return this;
      },
      post() { return this; },
      patch() { return this; },
      addHook() { return this; }
    } as unknown as FastifyInstance;
    let listener: ((event: any) => void) | undefined;
    const unsubscribe = vi.fn();
    const eventBus = {
      subscribe: vi.fn(async (_meetingId: string, subscribed: (event: any) => void) => {
        listener = subscribed;
        return unsubscribe;
      })
    } as unknown as MeetingEventBus;
    registerMeetingRoutes(app, { store: {} as never, eventBus, authDisabled: true });
    const requestRaw = new EventEmitter();
    const replyRaw = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      writeHead: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    replyRaw.write = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    replyRaw.writeHead = vi.fn();
    replyRaw.destroy = vi.fn();
    const reply = { hijack: vi.fn(), raw: replyRaw };
    const request = {
      params: { id: "70000000-0000-4000-8000-000000000001" },
      raw: requestRaw,
      log: { error: vi.fn() }
    };

    await eventsHandler!(request, reply);
    expect(replyRaw.write).toHaveBeenCalledTimes(1);
    listener!({
      type: "utterance.created",
      meetingId: request.params.id,
      data: { utteranceId: "utterance-1" },
      occurredAt: "2026-08-10T00:00:00.000Z"
    });
    expect(replyRaw.write).toHaveBeenCalledTimes(1);

    replyRaw.emit("drain");
    expect(replyRaw.write).toHaveBeenCalledTimes(2);
    expect(replyRaw.write.mock.calls[1]![0]).toContain("event: utterance.created");

    requestRaw.emit("close");
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disconnects a client whose backpressure buffer exceeds the bound", async () => {
    vi.useFakeTimers();
    let eventsHandler: ((request: any, reply: any) => Promise<unknown>) | undefined;
    const app = {
      get(path: string, handler: (request: any, reply: any) => Promise<unknown>) {
        if (path === "/api/meetings/:id/events") eventsHandler = handler;
        return this;
      },
      post() { return this; },
      patch() { return this; },
      addHook() { return this; }
    } as unknown as FastifyInstance;
    let listener: ((event: any) => void) | undefined;
    const unsubscribe = vi.fn();
    const eventBus = {
      subscribe: vi.fn(async (_meetingId: string, subscribed: (event: any) => void) => {
        listener = subscribed;
        return unsubscribe;
      })
    } as unknown as MeetingEventBus;
    registerMeetingRoutes(app, { store: {} as never, eventBus, authDisabled: true });
    const requestRaw = new EventEmitter();
    const replyRaw = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      writeHead: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    replyRaw.write = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    replyRaw.writeHead = vi.fn();
    replyRaw.destroy = vi.fn();
    const logError = vi.fn();
    const reply = { hijack: vi.fn(), raw: replyRaw };
    const request = {
      params: { id: "70000000-0000-4000-8000-000000000001" },
      raw: requestRaw,
      log: { error: logError }
    };

    await eventsHandler!(request, reply);
    listener!({
      type: "utterance.created",
      meetingId: request.params.id,
      data: { content: "x".repeat(300 * 1024) },
      occurredAt: "2026-08-10T00:00:00.000Z"
    });

    expect(replyRaw.destroy).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledWith(
      { meetingId: request.params.id },
      "Meeting event stream exceeded its bounded slow-client buffer."
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes an established stream before delivering an event after logout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
    let eventsHandler: ((request: any, reply: any) => Promise<unknown>) | undefined;
    const app = {
      get(path: string, handler: (request: any, reply: any) => Promise<unknown>) {
        if (path === "/api/meetings/:id/events") eventsHandler = handler;
        return this;
      },
      post() { return this; },
      patch() { return this; },
      addHook() { return this; }
    } as unknown as FastifyInstance;
    let listener: ((event: any) => void) | undefined;
    const unsubscribe = vi.fn();
    const eventBus = {
      subscribe: vi.fn(async (_meetingId: string, subscribed: (event: any) => void) => {
        listener = subscribed;
        return unsubscribe;
      })
    } as unknown as MeetingEventBus;
    const activeSession = {
      userId: "owner",
      tokenHash: "session-hash",
      expiresAt: "2026-08-10T12:00:00.000Z"
    };
    const findSession = vi.fn()
      .mockResolvedValueOnce(activeSession)
      .mockResolvedValue(null);
    registerMeetingRoutes(app, { store: { findSession } as never, eventBus, authDisabled: false });
    const requestRaw = new EventEmitter();
    const replyRaw = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      writeHead: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    replyRaw.write = vi.fn().mockReturnValue(true);
    replyRaw.writeHead = vi.fn();
    replyRaw.destroy = vi.fn();
    const reply = { hijack: vi.fn(), raw: replyRaw };
    const request = {
      params: { id: "70000000-0000-4000-8000-000000000001" },
      raw: requestRaw,
      ownerSession: activeSession,
      log: { error: vi.fn() }
    };

    await eventsHandler!(request, reply);
    expect(replyRaw.write).toHaveBeenCalledTimes(1);
    listener!({
      type: "utterance.created",
      meetingId: request.params.id,
      data: { utteranceId: "after-logout" },
      occurredAt: "2026-08-10T00:01:00.000Z"
    });
    await vi.waitFor(() => expect(replyRaw.destroy).toHaveBeenCalledOnce());

    expect(findSession).toHaveBeenCalledWith("session-hash");
    expect(replyRaw.write).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a session revoked while the Redis subscription is pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
    let eventsHandler: ((request: any, reply: any) => Promise<unknown>) | undefined;
    const app = {
      get(path: string, handler: (request: any, reply: any) => Promise<unknown>) {
        if (path === "/api/meetings/:id/events") eventsHandler = handler;
        return this;
      },
      post() { return this; },
      patch() { return this; },
      addHook() { return this; }
    } as unknown as FastifyInstance;
    let resolveSubscription!: (unsubscribe: () => void) => void;
    const subscription = new Promise<() => void>((resolve) => { resolveSubscription = resolve; });
    const unsubscribe = vi.fn();
    const eventBus = { subscribe: vi.fn(async () => subscription) } as unknown as MeetingEventBus;
    const findSession = vi.fn(async () => null);
    registerMeetingRoutes(app, { store: { findSession } as never, eventBus, authDisabled: false });
    const requestRaw = new EventEmitter();
    const replyRaw = { write: vi.fn(), writeHead: vi.fn(), destroy: vi.fn() };
    const reply = {
      hijack: vi.fn(),
      raw: replyRaw,
      code: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis()
    };
    const request = {
      params: { id: "70000000-0000-4000-8000-000000000001" },
      raw: requestRaw,
      ownerSession: {
        userId: "owner",
        tokenHash: "session-hash",
        expiresAt: "2026-08-10T12:00:00.000Z"
      },
      log: { error: vi.fn() }
    };

    const handling = eventsHandler!(request, reply);
    await vi.waitFor(() => expect(eventBus.subscribe).toHaveBeenCalledOnce());
    resolveSubscription(unsubscribe);
    await handling;

    expect(findSession).toHaveBeenCalledWith("session-hash");
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(replyRaw.writeHead).not.toHaveBeenCalled();
    expect(replyRaw.write).not.toHaveBeenCalled();
    expect(reply.hijack).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disconnects when pre-ready Meeting events exceed the bounded buffer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
    let eventsHandler: ((request: any, reply: any) => Promise<unknown>) | undefined;
    const app = {
      get(path: string, handler: (request: any, reply: any) => Promise<unknown>) {
        if (path === "/api/meetings/:id/events") eventsHandler = handler;
        return this;
      },
      post() { return this; },
      patch() { return this; },
      addHook() { return this; }
    } as unknown as FastifyInstance;
    let listener: ((event: any) => void) | undefined;
    const unsubscribe = vi.fn();
    const eventBus = {
      subscribe: vi.fn(async (_meetingId: string, subscribed: (event: any) => void) => {
        listener = subscribed;
        return unsubscribe;
      })
    } as unknown as MeetingEventBus;
    const activeSession = {
      userId: "owner",
      tokenHash: "session-hash",
      expiresAt: "2026-08-10T12:00:00.000Z"
    };
    let resolveSession!: (session: typeof activeSession) => void;
    const findSession = vi.fn(() => new Promise<typeof activeSession>((resolve) => { resolveSession = resolve; }));
    registerMeetingRoutes(app, { store: { findSession } as never, eventBus, authDisabled: false });
    const requestRaw = new EventEmitter();
    const replyRaw = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      writeHead: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    replyRaw.write = vi.fn().mockReturnValue(true);
    replyRaw.writeHead = vi.fn();
    replyRaw.destroy = vi.fn();
    const logError = vi.fn();
    const reply = { hijack: vi.fn(), raw: replyRaw };
    const request = {
      params: { id: "70000000-0000-4000-8000-000000000001" },
      raw: requestRaw,
      ownerSession: activeSession,
      log: { error: logError }
    };

    const handling = eventsHandler!(request, reply);
    await vi.waitFor(() => expect(listener).toBeTypeOf("function"));
    await vi.waitFor(() => expect(findSession).toHaveBeenCalledOnce());
    listener!({
      type: "utterance.created",
      meetingId: request.params.id,
      data: { content: "x".repeat(300 * 1024) },
      occurredAt: "2026-08-10T00:00:00.000Z"
    });

    expect(replyRaw.destroy).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledWith(
      { meetingId: request.params.id },
      "Meeting event stream exceeded its bounded pre-ready buffer."
    );
    resolveSession(activeSession);
    await handling;
    expect(replyRaw.writeHead).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes an idle established stream at its authenticated session expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
    let eventsHandler: ((request: any, reply: any) => Promise<unknown>) | undefined;
    const app = {
      get(path: string, handler: (request: any, reply: any) => Promise<unknown>) {
        if (path === "/api/meetings/:id/events") eventsHandler = handler;
        return this;
      },
      post() { return this; },
      patch() { return this; },
      addHook() { return this; }
    } as unknown as FastifyInstance;
    const unsubscribe = vi.fn();
    const eventBus = {
      subscribe: vi.fn(async () => unsubscribe)
    } as unknown as MeetingEventBus;
    const activeSession = {
      userId: "owner",
      tokenHash: "session-hash",
      expiresAt: "2026-08-10T00:00:01.000Z"
    };
    registerMeetingRoutes(app, {
      store: { findSession: vi.fn(async () => activeSession) } as never,
      eventBus,
      authDisabled: false
    });
    const requestRaw = new EventEmitter();
    const replyRaw = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      writeHead: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    replyRaw.write = vi.fn().mockReturnValue(true);
    replyRaw.writeHead = vi.fn();
    replyRaw.destroy = vi.fn();
    const reply = { hijack: vi.fn(), raw: replyRaw };
    const request = {
      params: { id: "70000000-0000-4000-8000-000000000001" },
      raw: requestRaw,
      ownerSession: activeSession,
      log: { error: vi.fn() }
    };

    await eventsHandler!(request, reply);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(replyRaw.destroy).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes the API while a Meeting SSE client remains connected", async () => {
    const store = new InMemoryPlatformStore();
    const meeting = (await store.getSnapshot()).meetings[0]!;
    const eventBus = new MeetingEventBus();
    const app = await createApp({ store, authDisabled: true, eventBus });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("API did not expose a test port.");

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/meetings/${meeting.id}/events`, {
      signal: controller.signal
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSE response body is unavailable.");
    await reader.read();

    const closePromise = app.close();
    const outcome = await Promise.race([
      closePromise.then(() => "closed" as const),
      delay(300).then(() => "timeout" as const)
    ]);

    controller.abort();
    await closePromise;
    await eventBus.close();
    expect(outcome).toBe("closed");
  });
});
