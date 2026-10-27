import { describe, expect, it, vi } from "vitest";
import {
  createContractMeetingEventPublisher,
  publishTaskChangedEvent
} from "./meeting-event-publisher.js";

describe("Worker Meeting event publisher", () => {
  it("validates and publishes a canonical Meeting event on its bound channel", async () => {
    const publish = vi.fn(async () => 1);
    const publisher = createContractMeetingEventPublisher({ publish });
    const event = {
      type: "utterance.created",
      meetingId: "70000000-0000-4000-8000-000000000001",
      data: { utteranceId: "utterance-1" },
      occurredAt: "2026-08-10T00:00:00.000Z"
    };

    await publisher.publish(`council:meeting:${event.meetingId}`, JSON.stringify(event));

    expect(publish).toHaveBeenCalledWith(`council:meeting:${event.meetingId}`, JSON.stringify(event));
  });

  it("rejects malformed, secret-bearing, or cross-Meeting event payloads", async () => {
    const publish = vi.fn(async () => 1);
    const publisher = createContractMeetingEventPublisher({ publish });
    const meetingId = "70000000-0000-4000-8000-000000000001";
    const base = {
      type: "utterance.created",
      meetingId,
      data: { utteranceId: "utterance-1" },
      occurredAt: "2026-08-10T00:00:00.000Z"
    };

    await expect(publisher.publish(`council:meeting:${meetingId}`, JSON.stringify({ ...base, occurredAt: "yesterday" })))
      .rejects.toThrow();
    await expect(publisher.publish(`council:meeting:${meetingId}`, JSON.stringify({ ...base, data: { apiKey: "secret" } })))
      .rejects.toThrow();
    await expect(publisher.publish("council:meeting:70000000-0000-4000-8000-000000000002", JSON.stringify(base)))
      .rejects.toThrow(/channel/i);
    expect(publish).not.toHaveBeenCalled();
  });

  it("publishes bounded Task invalidation and keeps a transport failure non-fatal", async () => {
    const task = {
      id: "70000000-0000-4000-8000-000000000010",
      meetingId: "70000000-0000-4000-8000-000000000001",
      status: "todo" as const
    };
    const occurredAt = "2026-08-18T01:00:00.000Z";
    const publish = vi.fn(async () => 1);
    const publisher = createContractMeetingEventPublisher({ publish });

    await publishTaskChangedEvent(publisher, task, "agent_run_completed", { occurredAt });

    expect(publish).toHaveBeenCalledWith(
      `council:meeting:${task.meetingId}`,
      JSON.stringify({
        type: "task.changed",
        meetingId: task.meetingId,
        data: { taskId: task.id, status: task.status, action: "agent_run_completed" },
        occurredAt
      })
    );

    const transportFailure = new Error("redis unavailable");
    const onError = vi.fn();
    const unavailable = createContractMeetingEventPublisher({
      publish: vi.fn(async () => {
        throw transportFailure;
      })
    });

    await expect(publishTaskChangedEvent(unavailable, task, "sync_failed", { onError }))
      .resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(transportFailure);

    await expect(publishTaskChangedEvent(unavailable, task, "sync_failed", {
      onError: () => {
        throw new Error("diagnostics unavailable");
      }
    })).resolves.toBeUndefined();
  });
});
