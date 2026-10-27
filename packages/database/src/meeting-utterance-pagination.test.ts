import { describe, expect, it } from "vitest";
import { InMemoryPlatformStore } from "./memory-store.js";

describe("Meeting transcript pagination", () => {
  it("uses an opaque, Meeting-bound cursor without duplicating rows", async () => {
    const store = new InMemoryPlatformStore();
    const meeting = (await store.getSnapshot()).meetings[0]!;
    await store.addUtterance(meeting.id, {
      speakerType: "human",
      speakerName: "Owner",
      roleName: null,
      content: "First paged utterance",
      kind: "human",
      evidenceCount: 0
    });
    await store.addUtterance(meeting.id, {
      speakerType: "human",
      speakerName: "Owner",
      roleName: null,
      content: "Second paged utterance",
      kind: "human",
      evidenceCount: 0
    });

    const first = await store.listMeetingUtterances(meeting.id, { cursor: null, limit: 1 });
    expect(first?.items).toHaveLength(1);
    expect(first?.nextCursor).toEqual(expect.any(String));

    const second = await store.listMeetingUtterances(meeting.id, {
      cursor: first!.nextCursor,
      limit: 100
    });
    expect(second?.items.some((item) => item.id === first?.items[0]?.id)).toBe(false);
    expect(new Set([...first!.items, ...second!.items].map((item) => item.id)).size)
      .toBe(first!.items.length + second!.items.length);
    expect(second?.nextCursor).toBeNull();
  });

  it("rejects a cursor from another Meeting and returns null for a missing Meeting", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const meeting = snapshot.meetings[0]!;
    const first = await store.listMeetingUtterances(meeting.id, { cursor: null, limit: 1 });
    const missingId = "00000000-0000-4000-8000-000000000099";

    await expect(store.listMeetingUtterances(missingId, {
      cursor: first?.nextCursor ?? null,
      limit: 1
    })).resolves.toBeNull();
    await expect(store.listMeetingUtterances(meeting.id, {
      cursor: "not-a-valid-cursor",
      limit: 1
    })).rejects.toMatchObject({ statusCode: 400, apiCode: "INVALID_CURSOR" });
  });
});
