import { readFileSync } from "node:fs";
import type { MeetingRecord } from "@council/contracts";
import { describe, expect, it } from "vitest";
import { meetingRecordPreview } from "./meeting-record-ui";

const source = readFileSync(new URL("./meeting-record-view.tsx", import.meta.url), "utf8");
const meetingRecordFixture: MeetingRecord = {
  meetingId: "80000000-0000-4000-8000-000000000001",
  revision: 1,
  closedAt: "2026-08-29T00:00:00.000Z",
  generatedAt: "2026-08-29T00:01:00.000Z",
  generationMode: "deterministic",
  sourceDigest: "a".repeat(64),
  createdBy: "system",
  content: {
    meeting: {
      meetingId: "80000000-0000-4000-8000-000000000001",
      threadId: "40000000-0000-4000-8000-000000000001",
      title: "Architecture review",
      goal: "Choose the release boundary.",
      state: "closed",
      mode: "chaired",
      startedAt: "2026-08-28T23:00:00.000Z",
      closedAt: "2026-08-29T00:00:00.000Z"
    },
    outcome: {
      status: "completed",
      summary: "The release boundary was agreed.",
      narrativePoints: [{ text: "The group converged.", sourceReferences: [{ kind: "utterance", id: "utterance-1" }] }]
    },
    participants: [],
    agenda: [],
    consensus: [{ text: "Ship the bounded release.", sourceReferences: [{ kind: "utterance", id: "utterance-1" }] }],
    dissent: [],
    openItems: [{ text: "Confirm rollout timing.", sourceReferences: [{ kind: "agenda", id: "agenda-1" }] }],
    decisions: [{
      decisionId: "b0000000-0000-4000-8000-000000000001",
      title: "Bound the release",
      description: "Exclude unreviewed integrations.",
      status: "approved",
      sourceReferences: [{ kind: "decision", id: "b0000000-0000-4000-8000-000000000001" }]
    }],
    tasks: [{
      taskId: "c0000000-0000-4000-8000-000000000001",
      decisionId: "b0000000-0000-4000-8000-000000000001",
      title: "Publish rollout plan",
      status: "todo",
      assigneeAgentId: null,
      dueAt: null,
      sourceReferences: [{ kind: "task", id: "c0000000-0000-4000-8000-000000000001" }]
    }],
    evidenceReferences: [{
      evidenceId: "evidence-1",
      type: "meeting",
      label: "Meeting evidence",
      reference: "80000000-0000-4000-8000-000000000001",
      sourceReferences: [{ kind: "task", id: "c0000000-0000-4000-8000-000000000001" }]
    }],
    linkedGoalIds: []
  }
};

describe("MeetingRecordView", () => {
  it("loads the immutable record separately from the paged transcript", () => {
    expect(source).toContain("/api/v1/meetings/${meeting.id}/record");
    expect(source).toContain("/api/v1/meetings/${meeting.id}/utterances?");
    expect(source).toContain('new URLSearchParams({ limit: "50" })');
    expect(source).toContain("page.nextCursor");
  });

  it("keeps summary, transcript, and evidence as accessible archive tabs", () => {
    expect(source).toContain('role="tablist"');
    expect(source).toContain("摘要</button>");
    expect(source).toContain("逐字稿</button>");
    expect(source).toContain("證據</button>");
    expect(source).toContain('role="tabpanel"');
  });

  it("keeps the default archive view compact while preserving the full record", () => {
    expect(source).toContain('aria-label="封存摘要"');
    expect(source).toContain('className="record-preview-facts"');
    expect(source).toContain('className="record-full-details"');
    expect(source).toContain("完整紀錄");
    expect(source).toContain("topicSummary");
  });

  it("shows Agent and Role revisions in the archived transcript", () => {
    expect(source).toContain("Agent Rev ${utterance.agentRevision}");
    expect(source).toContain("Role Rev ${utterance.roleRevision}");
  });

  it("derives a bounded quick preview from the immutable Meeting Record", () => {
    const record = {
      ...meetingRecordFixture,
      content: {
        ...meetingRecordFixture.content,
        outcome: {
          ...meetingRecordFixture.content.outcome,
          narrativePoints: [
            ...meetingRecordFixture.content.outcome.narrativePoints,
            { text: "Second point", sourceReferences: [{ kind: "agenda" as const, id: "agenda-2" }] },
            { text: "Third point", sourceReferences: [{ kind: "agenda" as const, id: "agenda-3" }] },
            { text: "Fourth point", sourceReferences: [{ kind: "agenda" as const, id: "agenda-4" }] }
          ]
        },
        dissent: [{ text: "Keep one objection visible.", sourceReferences: [{ kind: "utterance" as const, id: "utterance-2" }] }]
      }
    };

    expect(meetingRecordPreview(record)).toEqual({
      points: record.content.outcome.narrativePoints.slice(0, 3),
      notes: [...record.content.dissent, ...record.content.openItems],
      counts: {
        consensus: 1,
        decisions: 1,
        tasks: 1,
        evidence: 1
      }
    });
  });

  it("falls back to consensus only when narrative points are empty", () => {
    const withoutNarrative = {
      ...meetingRecordFixture,
      content: {
        ...meetingRecordFixture.content,
        outcome: { ...meetingRecordFixture.content.outcome, narrativePoints: [] }
      }
    };
    const withOneNarrative = {
      ...meetingRecordFixture,
      content: {
        ...meetingRecordFixture.content,
        outcome: {
          ...meetingRecordFixture.content.outcome,
          narrativePoints: [{ text: "Only this narrative point.", sourceReferences: [{ kind: "agenda" as const, id: "agenda-only" }] }]
        }
      }
    };

    expect(meetingRecordPreview(withoutNarrative).points).toEqual(meetingRecordFixture.content.consensus);
    expect(meetingRecordPreview(withOneNarrative).points).toEqual(withOneNarrative.content.outcome.narrativePoints);
  });

  it("keeps dissent before open items and bounds preview notes", () => {
    const record = {
      ...meetingRecordFixture,
      content: {
        ...meetingRecordFixture.content,
        dissent: [
          { text: "Dissent one", sourceReferences: [{ kind: "utterance" as const, id: "dissent-1" }] },
          { text: "Dissent two", sourceReferences: [{ kind: "utterance" as const, id: "dissent-2" }] }
        ],
        openItems: [
          { text: "Open one", sourceReferences: [{ kind: "agenda" as const, id: "open-1" }] },
          { text: "Open two", sourceReferences: [{ kind: "agenda" as const, id: "open-2" }] }
        ]
      }
    };

    expect(meetingRecordPreview(record).notes.map((item) => item.text)).toEqual([
      "Dissent one",
      "Dissent two",
      "Open one"
    ]);
  });
});
