import { describe, expect, it, vi } from "vitest";
import { InMemoryPlatformStore } from "@council/database";
import { createApp } from "./app.js";

const utteranceId = "a0000000-0000-4000-8000-000000000001";

function meetingRecord(meetingId: string, threadId: string, closedAt: string) {
  return {
    meetingId,
    revision: 1,
    closedAt,
    generatedAt: "2026-08-29T00:01:00.000Z",
    generationMode: "deterministic",
    sourceDigest: "a".repeat(64),
    createdBy: "system",
    content: {
      meeting: {
        meetingId,
        threadId,
        title: "Architecture review",
        goal: "Choose the release boundary.",
        state: "closed",
        mode: "chaired",
        startedAt: "2026-08-28T23:00:00.000Z",
        closedAt
      },
      outcome: {
        status: "completed",
        summary: "The release boundary was agreed.",
        narrativePoints: [{ text: "The scope is fixed.", sourceReferences: [{ kind: "utterance", id: utteranceId }] }]
      },
      participants: [],
      agenda: [],
      consensus: [{ text: "Ship the bounded release.", sourceReferences: [{ kind: "utterance", id: utteranceId }] }],
      dissent: [],
      openItems: [],
      decisions: [],
      tasks: [],
      evidenceReferences: [],
      linkedGoalIds: []
    }
  };
}

describe("Meeting Record read routes", () => {
  it("returns the latest immutable record for a closed Meeting", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const meeting = snapshot.meetings[0]!;
    const closedAt = "2026-08-29T00:00:00.000Z";
    const record = meetingRecord(meeting.id, meeting.threadId, closedAt);
    Object.assign(store, {
      getLatestMeetingRecord: async (meetingId: string) => meetingId === meeting.id ? record : null
    });
    const app = await createApp({ store, authDisabled: true });

    const response = await app.inject({ method: "GET", url: `/api/v1/meetings/${meeting.id}/record` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(record);
    expect(response.body).not.toContain("utterances");
    await app.close();
  });

  it("distinguishes a missing Meeting from a closed Meeting whose record is not ready", async () => {
    const store = new InMemoryPlatformStore();
    const meeting = (await store.getSnapshot()).meetings[0]!;
    const fullMeetingView = vi.spyOn(store, "getMeetingView");
    Object.assign(store, { getLatestMeetingRecord: async () => null });
    const app = await createApp({ store, authDisabled: true });

    const pending = await app.inject({ method: "GET", url: `/api/v1/meetings/${meeting.id}/record` });
    expect(pending.statusCode).toBe(404);
    expect(pending.json().error.code).toBe("MEETING_RECORD_NOT_READY");

    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/meetings/00000000-0000-4000-8000-000000000099/record"
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("MEETING_NOT_FOUND");
    expect(fullMeetingView).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns a bounded cursor page instead of embedding the full transcript in the record", async () => {
    const store = new InMemoryPlatformStore();
    const meeting = (await store.getSnapshot()).meetings[0]!;
    const first = (await store.getSnapshot()).utterances.find((item) => item.meetingId === meeting.id)!;
    const calls: unknown[] = [];
    Object.assign(store, {
      listMeetingUtterances: async (meetingId: string, input: { cursor: string | null; limit: number }) => {
        calls.push({ meetingId, input });
        return { items: [first], nextCursor: "cursor-2" };
      }
    });
    const app = await createApp({ store, authDisabled: true });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/meetings/${meeting.id}/utterances?cursor=cursor-1&limit=100`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [expect.objectContaining({ id: first.id })], nextCursor: "cursor-2" });
    expect(calls).toEqual([{ meetingId: meeting.id, input: { cursor: "cursor-1", limit: 100 } }]);

    const rejected = await app.inject({
      method: "GET",
      url: `/api/v1/meetings/${meeting.id}/utterances?limit=101`
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe("VALIDATION_ERROR");
    await app.close();
  });
});
