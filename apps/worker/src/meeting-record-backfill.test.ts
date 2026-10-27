import { describe, expect, it } from "vitest";
import { InMemoryPlatformStore } from "@council/database";
import { createSeedSnapshot } from "@council/database/seed";
import { backfillMeetingRecords } from "./meeting-record-backfill.js";

describe("Meeting Record startup backfill", () => {
  it("creates one immutable record for a legacy closed Meeting and replays idempotently", async () => {
    const seed = createSeedSnapshot();
    const store = new InMemoryPlatformStore(seed);
    const meetingId = seed.meetings[0]!.id;
    await store.setMeetingState(meetingId, "closed", "active");

    await expect(backfillMeetingRecords(store)).resolves.toEqual({
      closedMeetings: 1,
      existingRecords: 0,
      createdRecords: 1
    });
    await expect(store.getLatestMeetingRecord(meetingId)).resolves.toMatchObject({
      meetingId,
      revision: 1,
      generationMode: "deterministic",
      createdBy: "system"
    });

    await expect(backfillMeetingRecords(store)).resolves.toEqual({
      closedMeetings: 1,
      existingRecords: 1,
      createdRecords: 0
    });
  });

  it("fails before writing when any legacy closed Meeting lacks a durable close timestamp", async () => {
    const seed = createSeedSnapshot();
    seed.meetings[0]!.state = "closed";
    seed.meetings[0]!.closedAt = null;
    const store = new InMemoryPlatformStore(seed);

    await expect(backfillMeetingRecords(store)).rejects.toThrow(
      "1 closed Meeting cannot be archived without a durable close timestamp"
    );
    await expect(store.getLatestMeetingRecord(seed.meetings[0]!.id)).resolves.toBeNull();
  });

  it("does not load a broad snapshot or rewrite an existing record", async () => {
    const base = new InMemoryPlatformStore();
    const meetingId = (await base.getSnapshot()).meetings[0]!.id;
    await base.setMeetingState(meetingId, "closed", "active");
    await backfillMeetingRecords(base);
    const existing = await base.getLatestMeetingRecord(meetingId);
    const store = {
      getViewSnapshot: (view: "discussions") => base.getViewSnapshot(view),
      getLatestMeetingRecord: (id: string) => base.getLatestMeetingRecord(id),
      getMeetingView: () => { throw new Error("existing records must not reload Meeting detail"); },
      listGoalRuns: () => { throw new Error("existing records must not reload Goal Runs"); },
      appendMeetingRecord: () => { throw new Error("existing records must not be rewritten"); },
      getSnapshot: () => { throw new Error("broad snapshot must not be loaded"); }
    };

    await expect(backfillMeetingRecords(store)).resolves.toEqual({
      closedMeetings: 1,
      existingRecords: 1,
      createdRecords: 0
    });
    await expect(base.getLatestMeetingRecord(meetingId)).resolves.toEqual(existing);
  });

  it("canonicalizes an equivalent offset timestamp before immutable persistence", async () => {
    const seed = createSeedSnapshot();
    seed.meetings[0]!.state = "closed";
    seed.meetings[0]!.closedAt = "2026-08-29T08:00:00+00:00";
    const store = new InMemoryPlatformStore(seed);

    await backfillMeetingRecords(store);

    await expect(store.getLatestMeetingRecord(seed.meetings[0]!.id)).resolves.toMatchObject({
      closedAt: "2026-08-29T08:00:00.000Z",
      generatedAt: "2026-08-29T08:00:00.000Z",
      content: {
        meeting: { closedAt: "2026-08-29T08:00:00.000Z" }
      }
    });
  });

  it("archives long Evidence references intact", async () => {
    const seed = createSeedSnapshot();
    const store = new InMemoryPlatformStore(seed);
    const meetingId = seed.meetings[0]!.id;
    const decisionId = seed.decisions[0]!.id;
    const reference = `https://example.test/evidence/${"a".repeat(1_000)}`;
    await store.setDecisionStatus(decisionId, "approved");
    const task = await store.createTask({ decisionId, title: "Preserve long Evidence" });
    await store.addTaskEvidence(task.id, {
      type: "url",
      label: "Long external Evidence",
      reference
    });
    await store.setMeetingState(meetingId, "closed", "active");

    await expect(backfillMeetingRecords(store)).resolves.toMatchObject({ createdRecords: 1 });
    const record = await store.getLatestMeetingRecord(meetingId);

    expect(record?.content.evidenceReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "url", label: "Long external Evidence", reference })
    ]));
  });
});
