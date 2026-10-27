import { describe, expect, it } from "vitest";
import {
  meetingRecordSchema,
  meetingResponseSchema,
  utteranceResponseSchema
} from "./api-contracts.js";

const meetingId = "80000000-0000-4000-8000-000000000001";
const threadId = "40000000-0000-4000-8000-000000000001";
const participantId = "90000000-0000-4000-8000-000000000001";
const agentId = "50000000-0000-4000-8000-000000000001";
const roleId = "60000000-0000-4000-8000-000000000001";
const decisionId = "b0000000-0000-4000-8000-000000000001";
const taskId = "c0000000-0000-4000-8000-000000000001";
const utteranceId = "a0000000-0000-4000-8000-000000000001";
const closedAt = "2026-08-29T00:00:00.000Z";

export const meetingRecordFixture = {
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
      narrativePoints: [{
        text: "The group converged on the scoped release.",
        sourceReferences: [{ kind: "utterance", id: utteranceId }]
      }]
    },
    participants: [{
      participantId,
      agentId,
      agentRevision: 2,
      roleId,
      roleRevision: 3,
      isChair: true
    }],
    agenda: [{
      agendaItemId: "81000000-0000-4000-8000-000000000001",
      title: "Release boundary",
      status: "completed",
      outcome: "The scope is fixed for this release.",
      sourceReferences: [{ kind: "agenda", id: "81000000-0000-4000-8000-000000000001" }]
    }],
    consensus: [{ text: "Ship the bounded release.", sourceReferences: [{ kind: "utterance", id: utteranceId }] }],
    dissent: [],
    openItems: [{ text: "Confirm rollout timing.", sourceReferences: [{ kind: "utterance", id: utteranceId }] }],
    decisions: [{
      decisionId,
      title: "Bound the release",
      description: "Exclude unreviewed integrations.",
      status: "approved",
      sourceReferences: [{ kind: "decision", id: decisionId }]
    }],
    tasks: [{
      taskId,
      decisionId,
      title: "Publish rollout plan",
      status: "todo",
      assigneeAgentId: agentId,
      dueAt: null,
      sourceReferences: [{ kind: "task", id: taskId }]
    }],
    evidenceReferences: [{
      evidenceId: "e0000000-0000-4000-8000-000000000001",
      type: "meeting",
      label: "Meeting evidence",
      reference: meetingId,
      sourceReferences: [{ kind: "task", id: taskId }]
    }],
    linkedGoalIds: ["f0000000-0000-4000-8000-000000000001"]
  }
} as const;

describe("Meeting Record contracts", () => {
  it("exposes closed timestamps while allowing legacy Meeting and Utterance rows", () => {
    const legacyMeeting = {
      id: meetingId,
      threadId,
      title: "Architecture review",
      goal: "Choose the release boundary.",
      state: "active",
      mode: "chaired",
      automation: "suggest",
      durationMinutes: 30,
      startedAt: "2026-08-28T23:00:00.000Z",
      agenda: { revision: 0, items: [] },
      summaryState: "not_requested",
      summaryJobId: null,
      createdAt: "2026-08-28T22:00:00.000Z"
    };
    expect(meetingResponseSchema.parse(legacyMeeting)).toMatchObject({ closedAt: null });

    expect(utteranceResponseSchema.parse({
      id: utteranceId,
      meetingId,
      agentId,
      turnId: "record-contract-turn",
      speakerType: "agent",
      speakerName: "Architect",
      roleName: "Platform architect",
      content: "The scope is ready.",
      kind: "inference",
      evidenceCount: 0,
      createdAt: "2026-08-28T23:30:00.000Z",
      agentRevision: null,
      roleId: null,
      roleRevision: null
    })).toMatchObject({ agentRevision: null, roleId: null, roleRevision: null });
  });

  it("requires source utterance IDs for every persisted narrative point", () => {
    expect(meetingRecordSchema.parse(meetingRecordFixture)).toMatchObject({
      meetingId,
      content: { meeting: { meetingId }, linkedGoalIds: ["f0000000-0000-4000-8000-000000000001"] }
    });
    expect(() => meetingRecordSchema.parse({
      ...meetingRecordFixture,
      content: {
        ...meetingRecordFixture.content,
        consensus: [{ text: "Unattributed narrative." }]
      }
    })).toThrow(/sourceReferences/i);
  });

  it("does not permit transcript payloads in a persisted Meeting Record", () => {
    expect(() => meetingRecordSchema.parse({
      ...meetingRecordFixture,
      content: { ...meetingRecordFixture.content, utterances: [] }
    })).toThrow();
  });

  it("preserves bounded long Evidence references without inheriting the generic text limit", () => {
    const reference = `https://example.test/evidence/${"a".repeat(1_000)}`;
    const parsed = meetingRecordSchema.parse({
      ...meetingRecordFixture,
      content: {
        ...meetingRecordFixture.content,
        evidenceReferences: [{
          ...meetingRecordFixture.content.evidenceReferences[0],
          type: "url",
          reference
        }]
      }
    });

    expect(parsed.content.evidenceReferences[0]?.reference).toBe(reference);
    expect(() => meetingRecordSchema.parse({
      ...meetingRecordFixture,
      content: {
        ...meetingRecordFixture.content,
        evidenceReferences: [{
          ...meetingRecordFixture.content.evidenceReferences[0],
          type: "note",
          reference: "a".repeat(4_001)
        }]
      }
    })).toThrow(/4000|4,000|too_big/i);
  });
});
