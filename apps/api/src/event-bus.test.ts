import { describe, expect, it, vi } from "vitest";
import {
  MeetingEventBus,
  parseMeetingEvent,
  type MeetingEventRedisPublisher,
  type MeetingEventRedisSubscriber
} from "./event-bus.js";

describe("meeting event parsing", () => {
  it("ignores malformed and structurally invalid Redis messages", () => {
    expect(parseMeetingEvent("not-json")).toBeNull();
    expect(parseMeetingEvent('{"type":"utterance.created"}')).toBeNull();
  });

  it("accepts a complete meeting event", () => {
    const event = {
      type: "utterance.created",
      meetingId: "70000000-0000-4000-8000-000000000001",
      data: { id: "utterance" },
      occurredAt: "2026-07-16T00:00:00.000Z"
    };
    expect(parseMeetingEvent(JSON.stringify(event))).toEqual(event);
  });

  it("rejects invalid identifiers, timestamps, and secret-bearing event data", () => {
    expect(parseMeetingEvent(JSON.stringify({
      type: "utterance.created",
      meetingId: "meeting",
      data: {},
      occurredAt: "2026-07-16T00:00:00.000Z"
    }))).toBeNull();
    expect(parseMeetingEvent(JSON.stringify({
      type: "utterance.created",
      meetingId: "70000000-0000-4000-8000-000000000001",
      data: { connector: { apiKey: "must-not-leak" } },
      occurredAt: "not-a-date"
    }))).toBeNull();
  });

  it("rolls back a failed Redis subscription so the next listener can retry", async () => {
    const messageListeners: Array<(channel: string, payload: string) => void> = [];
    const subscribe = vi.fn()
      .mockRejectedValueOnce(new Error("Redis unavailable"))
      .mockResolvedValue(1);
    const publisher: MeetingEventRedisPublisher = {
      ping: vi.fn(async () => "PONG"),
      publish: vi.fn(async () => 1),
      quit: vi.fn(async () => "OK")
    };
    const subscriber: MeetingEventRedisSubscriber = {
      ping: vi.fn(async () => "PONG"),
      subscribe,
      unsubscribe: vi.fn(async () => 1),
      quit: vi.fn(async () => "OK"),
      on: (_event, listener) => messageListeners.push(listener)
    };
    const bus = new MeetingEventBus(undefined, { publisher, subscriber });
    const meetingId = "70000000-0000-4000-8000-000000000001";

    await expect(bus.subscribe(meetingId, vi.fn())).rejects.toThrow("Redis unavailable");
    const received = vi.fn();
    const unsubscribe = await bus.subscribe(meetingId, received);

    expect(subscribe).toHaveBeenCalledTimes(2);
    messageListeners[0]!("council:meeting:ignored", JSON.stringify({
      type: "utterance.created",
      meetingId,
      data: { id: "utterance" },
      occurredAt: "2026-07-16T00:00:00.000Z"
    }));
    expect(received).toHaveBeenCalledTimes(1);

    unsubscribe();
    await bus.close();
  });

  it("handles a failed Redis unsubscribe and permits a later subscription", async () => {
    const subscribe = vi.fn(async () => 1);
    let redisUnsubscribeCalls = 0;
    const redisUnsubscribe = async () => {
      redisUnsubscribeCalls += 1;
      if (redisUnsubscribeCalls === 1) throw new Error("Redis unsubscribe unavailable");
      return 1;
    };
    const publisher: MeetingEventRedisPublisher = {
      ping: vi.fn(async () => "PONG"),
      publish: vi.fn(async () => 1),
      quit: vi.fn(async () => "OK")
    };
    const subscriber: MeetingEventRedisSubscriber = {
      ping: vi.fn(async () => "PONG"),
      subscribe,
      unsubscribe: redisUnsubscribe,
      quit: vi.fn(async () => "OK"),
      on: vi.fn()
    };
    const bus = new MeetingEventBus(undefined, { publisher, subscriber });
    const meetingId = "70000000-0000-4000-8000-000000000001";
    const unhandledRejections: unknown[] = [];
    const recordUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    let removeSecondListener: (() => void) | undefined;

    process.on("unhandledRejection", recordUnhandledRejection);
    try {
      const removeFirstListener = await bus.subscribe(meetingId, vi.fn());
      removeFirstListener();
      await new Promise<void>((resolve) => setImmediate(resolve));

      removeSecondListener = await bus.subscribe(meetingId, vi.fn());

      expect(unhandledRejections).toEqual([]);
      expect(redisUnsubscribeCalls).toBe(1);
      expect(subscribe).toHaveBeenCalledTimes(2);
    } finally {
      removeSecondListener?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      process.off("unhandledRejection", recordUnhandledRejection);
      await bus.close();
    }
  });

  it("serializes a replacement subscription behind an in-flight Redis unsubscribe", async () => {
    let resolveRedisUnsubscribe!: () => void;
    const redisUnsubscribeGate = new Promise<void>((resolve) => { resolveRedisUnsubscribe = resolve; });
    const subscribe = vi.fn(async () => 1);
    const unsubscribe = vi.fn(async () => {
      await redisUnsubscribeGate;
      return 1;
    });
    const publisher: MeetingEventRedisPublisher = {
      ping: vi.fn(async () => "PONG"),
      publish: vi.fn(async () => 1),
      quit: vi.fn(async () => "OK")
    };
    const subscriber: MeetingEventRedisSubscriber = {
      ping: vi.fn(async () => "PONG"),
      subscribe,
      unsubscribe,
      quit: vi.fn(async () => "OK"),
      on: vi.fn()
    };
    const bus = new MeetingEventBus(undefined, { publisher, subscriber });
    const meetingId = "70000000-0000-4000-8000-000000000001";
    const removeFirst = await bus.subscribe(meetingId, vi.fn());

    removeFirst();
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
    let replacementReady = false;
    const replacement = bus.subscribe(meetingId, vi.fn()).then((remove) => {
      replacementReady = true;
      return remove;
    });
    await Promise.resolve();

    expect(replacementReady).toBe(false);
    expect(subscribe).toHaveBeenCalledTimes(1);

    resolveRedisUnsubscribe();
    const removeReplacement = await replacement;
    expect(subscribe).toHaveBeenCalledTimes(2);

    removeReplacement();
    await bus.close();
  });
});
