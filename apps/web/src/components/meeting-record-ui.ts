import type { MeetingRecord, MeetingRecordNarrativePoint } from "@council/contracts";

export interface MeetingRecordPreview {
  points: MeetingRecordNarrativePoint[];
  notes: MeetingRecordNarrativePoint[];
  counts: {
    consensus: number;
    decisions: number;
    tasks: number;
    evidence: number;
  };
}

export function meetingRecordPreview(record: MeetingRecord): MeetingRecordPreview {
  const { content } = record;
  const pointSource = content.outcome.narrativePoints.length > 0
    ? content.outcome.narrativePoints
    : content.consensus;

  return {
    points: pointSource.slice(0, 3),
    notes: [...content.dissent, ...content.openItems].slice(0, 3),
    counts: {
      consensus: content.consensus.length,
      decisions: content.decisions.length,
      tasks: content.tasks.length,
      evidence: content.evidenceReferences.length
    }
  };
}
