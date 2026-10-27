import { describe, expect, it, vi } from "vitest";
import { InMemoryPlatformStore, type MeetingSummaryCommitInput } from "@council/database";
import { createSeedSnapshot } from "@council/database/seed";
import type { MeetingAgenda } from "@council/contracts";
import { processMeetingSummary } from "./process-meeting-summary.js";

describe("meeting summary worker", () => {
  it("adds an auditable system summary after the meeting closes", async () => {
    const seed = createSeedSnapshot();
    seed.meetings[0]!.agenda = {
      revision: 4,
      items: [
        { id: "81000000-0000-4000-8000-000000000023", title: "已完成檢查", description: "", position: 0, status: "completed", createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z", startedAt: "2026-07-20T00:00:00.000Z", resolvedAt: "2026-07-20T00:00:00.000Z" },
        { id: "81000000-0000-4000-8000-000000000024", title: "略過延伸項目", description: "", position: 1, status: "skipped", createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z", startedAt: null, resolvedAt: "2026-07-20T00:00:00.000Z" },
        { id: "81000000-0000-4000-8000-000000000022", title: "目前決策", description: "", position: 2, status: "current", createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z", startedAt: "2026-07-20T00:00:00.000Z", resolvedAt: null },
        { id: "81000000-0000-4000-8000-000000000021", title: "先確認範圍", description: "", position: 3, status: "pending", createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z", startedAt: null, resolvedAt: null }
      ]
    } satisfies MeetingAgenda;
    const store = new InMemoryPlatformStore(seed);
    await store.setMeetingState(seed.meetings[0]!.id, "closed", "active");
    await store.setMeetingSummaryState(seed.meetings[0]!.id, "pending", "current-summary-job");

    await expect(processMeetingSummary(store, seed.meetings[0]!.id, "stale-summary-job"))
      .resolves.toBeNull();
    expect((await store.getSnapshot()).utterances.filter(
      (item) => item.turnId === `meeting-summary:${seed.meetings[0]!.id}`
    )).toHaveLength(0);

    const utterance = await processMeetingSummary(store, seed.meetings[0]!.id, "current-summary-job");
    const retry = await processMeetingSummary(store, seed.meetings[0]!.id, "current-summary-job");
    if (!utterance || !retry) throw new Error("The current summary reservation must produce an utterance.");

    expect(utterance).toMatchObject({ speakerType: "system", kind: "system" });
    const agendaHeading = utterance.content.indexOf("議程：");
    const decisionsHeading = utterance.content.indexOf("決議：");
    expect(agendaHeading).toBeGreaterThanOrEqual(0);
    expect(agendaHeading).toBeLessThan(decisionsHeading);
    expect(utterance.content).toContain("- [pending] 先確認範圍");
    expect(utterance.content).toContain("- [current] 目前決策");
    expect(utterance.content).toContain("- [completed] 已完成檢查");
    expect(utterance.content).toContain("- [skipped] 略過延伸項目");
    expect(utterance.content).toContain(seed.decisions[0]!.title);
    expect(retry.id).toBe(utterance.id);
    const snapshot = await store.getSnapshot();
    expect(snapshot.meetings[0]).toMatchObject({ summaryState: "completed", summaryJobId: "current-summary-job" });
    expect(snapshot.utterances.filter((item) => item.turnId === `meeting-summary:${seed.meetings[0]!.id}`)).toHaveLength(1);
    const record = await store.getLatestMeetingRecord(seed.meetings[0]!.id);
    expect(record).toMatchObject({
      meetingId: seed.meetings[0]!.id,
      revision: 1,
      generationMode: "deterministic",
      createdBy: "system",
      content: {
        meeting: { state: "closed", closedAt: snapshot.meetings[0]!.closedAt },
        agenda: expect.arrayContaining([
          expect.objectContaining({
            agendaItemId: "81000000-0000-4000-8000-000000000023",
            sourceReferences: [{ kind: "agenda", id: "81000000-0000-4000-8000-000000000023" }]
          })
        ]),
        decisions: expect.arrayContaining([
          expect.objectContaining({
            decisionId: seed.decisions[0]!.id,
            sourceReferences: [{ kind: "decision", id: seed.decisions[0]!.id }]
          })
        ])
      }
    });
    expect(record?.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(record)).not.toContain("utterances");
  });

  it("does not insert a summary after its reservation is replaced during commit", async () => {
    const base = new InMemoryPlatformStore();
    const meetingId = (await base.getSnapshot()).meetings[0]!.id;
    await base.setMeetingState(meetingId, "closed", "active");
    await base.setMeetingSummaryState(meetingId, "pending", "summary-job-a");
    let replaced = false;
    const replaceReservation = async () => {
      if (replaced) return;
      replaced = true;
      await base.setMeetingSummaryState(meetingId, "failed", "summary-job-a");
      await base.setMeetingSummaryState(meetingId, "pending", "summary-job-b");
    };
    const store = {
      getMeetingView: (id: string) => base.getMeetingView(id),
      listGoalRuns: () => base.listGoalRuns(),
      commitMeetingSummary: async (input: MeetingSummaryCommitInput) => {
        await replaceReservation();
        return base.commitMeetingSummary(input);
      },
      getSnapshot: vi.fn(() => { throw new Error("broad snapshot must not be loaded"); })
    };

    await expect(processMeetingSummary(store, meetingId, "summary-job-a")).resolves.toBeNull();
    const snapshot = await base.getSnapshot();
    expect(snapshot.meetings.find((meeting) => meeting.id === meetingId)).toMatchObject({
      summaryState: "pending",
      summaryJobId: "summary-job-b"
    });
    expect(snapshot.utterances.filter((item) => item.turnId === `meeting-summary:${meetingId}`)).toHaveLength(0);
    await expect(base.getLatestMeetingRecord(meetingId)).resolves.toBeNull();
    expect(store.getSnapshot).not.toHaveBeenCalled();
  });

  it("rolls back insertion when the creation audit fails and repairs it on retry", async () => {
    const events: string[] = [];
    class FailOnceSummaryAuditStore extends InMemoryPlatformStore {
      private failCreationAudit = true;

      override async recordAudit(event: string): Promise<void> {
        if (event === "meeting.summary.created" && this.failCreationAudit) {
          this.failCreationAudit = false;
          throw new Error("audit unavailable");
        }
        events.push(event);
      }
    }
    const store = new FailOnceSummaryAuditStore();
    const meetingId = (await store.getSnapshot()).meetings[0]!.id;
    await store.setMeetingState(meetingId, "closed", "active");
    await store.setMeetingSummaryState(meetingId, "pending", "summary-audit-job");

    await expect(processMeetingSummary(store, meetingId, "summary-audit-job")).rejects.toThrow("audit unavailable");
    expect((await store.getSnapshot()).utterances.filter(
      (item) => item.turnId === `meeting-summary:${meetingId}`
    )).toHaveLength(0);
    await expect(store.getLatestMeetingRecord(meetingId)).resolves.toBeNull();

    await expect(processMeetingSummary(store, meetingId, "summary-audit-job")).resolves.toMatchObject({
      meetingId,
      turnId: `meeting-summary:${meetingId}`
    });
    expect(events.filter((event) => event === "meeting.summary.created")).toHaveLength(1);
    expect((await store.getSnapshot()).meetings.find((meeting) => meeting.id === meetingId)).toMatchObject({
      summaryState: "completed",
      summaryJobId: "summary-audit-job"
    });
    await expect(store.getLatestMeetingRecord(meetingId)).resolves.toMatchObject({ meetingId, revision: 1 });
  });
});
