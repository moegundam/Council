import type { PlatformStore } from "@council/database";
import { buildDeterministicMeetingRecord } from "./meeting-record-builder.js";

export interface MeetingRecordBackfillResult {
  closedMeetings: number;
  existingRecords: number;
  createdRecords: number;
}

export type MeetingRecordBackfillStore = Pick<PlatformStore,
  | "getViewSnapshot"
  | "getLatestMeetingRecord"
  | "getMeetingView"
  | "listGoalRuns"
  | "appendMeetingRecord"
>;

export async function backfillMeetingRecords(
  store: MeetingRecordBackfillStore
): Promise<MeetingRecordBackfillResult> {
  const discussions = await store.getViewSnapshot("discussions");
  const closedMeetings = discussions.meetings
    .filter((meeting) => meeting.state === "closed")
    .sort((left, right) => (
      (left.closedAt ?? "").localeCompare(right.closedAt ?? "") || left.id.localeCompare(right.id)
    ));
  const pending = [] as typeof closedMeetings;
  let existingRecords = 0;
  let missingCloseTimestamps = 0;

  for (const meeting of closedMeetings) {
    if (await store.getLatestMeetingRecord(meeting.id)) {
      existingRecords += 1;
    } else if (!meeting.closedAt) {
      missingCloseTimestamps += 1;
    } else {
      pending.push(meeting);
    }
  }

  if (missingCloseTimestamps > 0) {
    throw new Error(
      `${missingCloseTimestamps} closed Meeting cannot be archived without a durable close timestamp.`
    );
  }

  const goalRuns = pending.length > 0 ? await store.listGoalRuns() : [];
  let createdRecords = 0;
  for (const meeting of pending) {
    const view = await store.getMeetingView(meeting.id);
    if (!view || view.meeting.state !== "closed" || view.meeting.closedAt !== meeting.closedAt) {
      throw new Error("Meeting changed while its immutable record was being backfilled.");
    }
    await store.appendMeetingRecord(buildDeterministicMeetingRecord(view, goalRuns));
    createdRecords += 1;
  }

  return {
    closedMeetings: closedMeetings.length,
    existingRecords,
    createdRecords
  };
}
