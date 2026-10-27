import type { PlatformStore } from "@council/database";
import { buildDeterministicMeetingRecord } from "./meeting-record-builder.js";

export type MeetingSummaryStore = Pick<PlatformStore,
  | "commitMeetingSummary"
  | "getMeetingView"
  | "listGoalRuns"
>;

export async function processMeetingSummary(store: MeetingSummaryStore, meetingId: string, jobId: string) {
  const view = await store.getMeetingView(meetingId);
  const meeting = view?.meeting;
  if (!meeting || meeting.state !== "closed") throw new Error("Meeting must be closed before it can be summarized.");
  const record = buildDeterministicMeetingRecord(view, await store.listGoalRuns());
  const turnId = `meeting-summary:${meetingId}`;
  const decisions = view.decisions;
  const agendaLines = (meeting.agenda?.items ?? []).length
    ? (meeting.agenda?.items ?? []).map((item) => `- [${item.status}] ${item.title}`)
    : ["- 尚無議程"];
  const lines = decisions.length
    ? decisions.map((decision) => `- [${decision.status}] ${decision.title}`)
    : ["- 尚無決議"];
  const result = await store.commitMeetingSummary({
    meetingId,
    jobId,
    utterance: {
      turnId,
      speakerType: "system",
      speakerName: "Council",
      roleName: null,
      content: [`會議摘要：${meeting.title}`, `目標：${meeting.goal}`, "議程：", ...agendaLines, "決議：", ...lines].join("\n"),
      kind: "system",
      evidenceCount: decisions.length
    },
    record,
    auditDetail: {
      decisionCount: decisions.length,
      meetingRecordRevision: record.revision,
      meetingRecordSourceDigest: record.sourceDigest
    }
  });
  return result.status === "stale" ? null : result.utterance;
}
