import { describe, expect, it, vi } from "vitest";
import type { ClientMeetingEvent } from "../lib/view-model";
import { subscribeToMeetingEvents, type MeetingEventSourceFactory } from "./use-meeting-events";

const meetingId = "70000000-0000-4000-8000-000000000001";
const foreignMeetingId = "70000000-0000-4000-8000-000000000002";
const occurredAt = "2026-08-10T00:00:00.000Z";

class FakeEventSource extends EventTarget {
  readonly url: string;
  closed = false;

  constructor(url: string) {
    super();
    this.url = url;
  }

  close(): void {
    this.closed = true;
  }
}

function createSourceFactory(sources: FakeEventSource[]): MeetingEventSourceFactory {
  return (url) => {
    const source = new FakeEventSource(url);
    sources.push(source);
    return source;
  };
}

describe("subscribeToMeetingEvents", () => {
  it("closes the old subscription and creates the new meeting URL", () => {
    const sources: FakeEventSource[] = [];
    const factory = createSourceFactory(sources);
    const refresh = vi.fn(async () => undefined);

    const cleanupOld = subscribeToMeetingEvents("meeting-old", refresh, undefined, factory);
    expect(sources[0]?.url).toBe("/api/meetings/meeting-old/events");

    const cleanupNew = subscribeToMeetingEvents("meeting-new", refresh, undefined, factory);
    cleanupOld();

    expect(sources[0]?.closed).toBe(true);
    expect(sources[1]?.url).toBe("/api/meetings/meeting-new/events");
    expect(sources[1]?.closed).toBe(false);

    cleanupNew();
    expect(sources[1]?.closed).toBe(true);
  });

  it("ignores an already queued event after the old subscription is closed", () => {
    const sources: FakeEventSource[] = [];
    const refresh = vi.fn(async () => undefined);
    const onEvent = vi.fn<(event: ClientMeetingEvent) => void>();
    const cleanup = subscribeToMeetingEvents(meetingId, refresh, onEvent, createSourceFactory(sources));
    cleanup();

    const event: ClientMeetingEvent = {
      type: "chair.automation.failed",
      meetingId,
      data: { classification: "queue_unavailable" },
      occurredAt
    };
    sources[0]?.dispatchEvent(new MessageEvent("chair.automation.failed", { data: JSON.stringify(event) }));

    expect(onEvent).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("calls back and refreshes for a matching meeting event", () => {
    const sources: FakeEventSource[] = [];
    const refresh = vi.fn(async () => undefined);
    const onEvent = vi.fn<(event: ClientMeetingEvent) => void>();
    const cleanup = subscribeToMeetingEvents(meetingId, refresh, onEvent, createSourceFactory(sources));

    const event: ClientMeetingEvent = {
      type: "utterance.created",
      meetingId,
      data: { utteranceId: "utterance-1" },
      occurredAt
    };
    sources[0]?.dispatchEvent(new MessageEvent("utterance.created", { data: JSON.stringify(event) }));

    expect(onEvent).toHaveBeenCalledWith(event);
    expect(refresh).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("handles MCP cancellation so a stale authorization cannot leave the UI pending", () => {
    const sources: FakeEventSource[] = [];
    const refresh = vi.fn(async () => undefined);
    const onEvent = vi.fn<(event: ClientMeetingEvent) => void>();
    const cleanup = subscribeToMeetingEvents(meetingId, refresh, onEvent, createSourceFactory(sources));
    const event: ClientMeetingEvent = {
      type: "mcp.cancelled",
      meetingId,
      data: { jobId: "tool-job", classification: "stale_authorization" },
      occurredAt
    };

    sources[0]?.dispatchEvent(new MessageEvent("mcp.cancelled", { data: JSON.stringify(event) }));

    expect(onEvent).toHaveBeenCalledWith(event);
    expect(refresh).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("refreshes when another client changes the Meeting Agenda", () => {
    const sources: FakeEventSource[] = [];
    const refresh = vi.fn(async () => undefined);
    const onEvent = vi.fn<(event: ClientMeetingEvent) => void>();
    const cleanup = subscribeToMeetingEvents(meetingId, refresh, onEvent, createSourceFactory(sources));
    const event: ClientMeetingEvent = {
      type: "meeting.agenda.changed",
      meetingId,
      data: { revision: 3, action: "complete", currentItemId: "agenda-2" },
      occurredAt
    };

    sources[0]?.dispatchEvent(new MessageEvent("meeting.agenda.changed", { data: JSON.stringify(event) }));

    expect(onEvent).toHaveBeenCalledWith(event);
    expect(refresh).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it.each(["decision.changed", "task.changed"])("refreshes when another client emits %s", (type) => {
    const sources: FakeEventSource[] = [];
    const refresh = vi.fn(async () => undefined);
    const onEvent = vi.fn<(event: ClientMeetingEvent) => void>();
    const cleanup = subscribeToMeetingEvents(meetingId, refresh, onEvent, createSourceFactory(sources));
    const event: ClientMeetingEvent = {
      type,
      meetingId,
      data: type === "decision.changed"
        ? { decisionId: "decision-1", status: "approved", action: "approved" }
        : { taskId: "task-1", status: "in_progress", action: "status_changed" },
      occurredAt
    };

    sources[0]?.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(event) }));

    expect(onEvent).toHaveBeenCalledWith(event);
    expect(refresh).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("coalesces a burst of Chair automation events into one in-flight and one trailing refresh", async () => {
    const sources: FakeEventSource[] = [];
    const completions: Array<() => void> = [];
    const refresh = vi.fn(() => new Promise<void>((resolve) => completions.push(resolve)));
    const onEvent = vi.fn<(event: ClientMeetingEvent) => void>();
    const cleanup = subscribeToMeetingEvents(meetingId, refresh, onEvent, createSourceFactory(sources));

    for (const type of ["meeting.automation.changed", "chair.automation.applied", "chair.automation.failed"]) {
      const event: ClientMeetingEvent = { type, meetingId, data: { jobId: `${type}-job` }, occurredAt };
      sources[0]?.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(event) }));
    }

    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledTimes(1);
    completions.shift()?.();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    completions.shift()?.();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("does not start a trailing refresh after the subscription is closed", async () => {
    const sources: FakeEventSource[] = [];
    let completeRefresh: (() => void) | undefined;
    const refresh = vi.fn(() => new Promise<void>((resolve) => { completeRefresh = resolve; }));
    const cleanup = subscribeToMeetingEvents(meetingId, refresh, undefined, createSourceFactory(sources));
    const event: ClientMeetingEvent = {
      type: "meeting.automation.changed",
      meetingId,
      data: { automation: "suggest" },
      occurredAt
    };

    sources[0]?.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event) }));
    sources[0]?.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event) }));
    expect(refresh).toHaveBeenCalledTimes(1);

    cleanup();
    completeRefresh?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("releases refresh ownership after rejection and runs one trailing refresh", async () => {
    const sources: FakeEventSource[] = [];
    let rejectFirstRefresh: ((reason?: unknown) => void) | undefined;
    const refresh = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectFirstRefresh = reject; }))
      .mockResolvedValue(undefined);
    const cleanup = subscribeToMeetingEvents(meetingId, refresh, undefined, createSourceFactory(sources));

    sources[0]?.dispatchEvent(new Event("ready"));
    sources[0]?.dispatchEvent(new Event("ready"));
    expect(refresh).toHaveBeenCalledTimes(1);

    rejectFirstRefresh?.(new TypeError("unexpected projection shape"));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    cleanup();
  });

  it("refreshes but does not call back for foreign or malformed events", async () => {
    const sources: FakeEventSource[] = [];
    const refresh = vi.fn(async () => undefined);
    const onEvent = vi.fn<(event: ClientMeetingEvent) => void>();
    const cleanup = subscribeToMeetingEvents(meetingId, refresh, onEvent, createSourceFactory(sources));

    sources[0]?.dispatchEvent(new MessageEvent("utterance.created", {
      data: JSON.stringify({
        type: "utterance.created",
        meetingId: foreignMeetingId,
        data: { utteranceId: "utterance-foreign" },
        occurredAt
      })
    }));
    sources[0]?.dispatchEvent(new MessageEvent("utterance.created", { data: "not-json" }));
    sources[0]?.dispatchEvent(new MessageEvent("utterance.created", {
      data: JSON.stringify({
        type: "utterance.created",
        meetingId,
        data: { utteranceId: "missing-occurred-at" }
      })
    }));

    expect(onEvent).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    cleanup();
  });
});
