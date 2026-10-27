import { describe, expect, it, vi } from "vitest";
import type { MeetingRecord } from "@council/contracts";
import type { Pool, PoolClient } from "pg";
import { InMemoryPlatformStore } from "./memory-store.js";
import { additiveMigrations } from "./migrations.js";
import { PostgresPlatformStore } from "./postgres-store.js";
import { createSeedSnapshot } from "./seed.js";

const record: MeetingRecord = {
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
      narrativePoints: [{
        text: "The group converged on the scoped release.",
        sourceReferences: [{ kind: "utterance", id: "a0000000-0000-4000-8000-000000000001" }]
      }]
    },
    participants: [{
      participantId: "90000000-0000-4000-8000-000000000001",
      agentId: "50000000-0000-4000-8000-000000000001",
      agentRevision: 2,
      roleId: "60000000-0000-4000-8000-000000000001",
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
    consensus: [{ text: "Ship the bounded release.", sourceReferences: [{ kind: "utterance", id: "a0000000-0000-4000-8000-000000000001" }] }],
    dissent: [],
    openItems: [{ text: "Confirm rollout timing.", sourceReferences: [{ kind: "utterance", id: "a0000000-0000-4000-8000-000000000001" }] }],
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
      assigneeAgentId: "50000000-0000-4000-8000-000000000001",
      dueAt: null,
      sourceReferences: [{ kind: "task", id: "c0000000-0000-4000-8000-000000000001" }]
    }],
    evidenceReferences: [{
      evidenceId: "e0000000-0000-4000-8000-000000000001",
      type: "meeting",
      label: "Meeting evidence",
      reference: "80000000-0000-4000-8000-000000000001",
      sourceReferences: [{ kind: "task", id: "c0000000-0000-4000-8000-000000000001" }]
    }],
    linkedGoalIds: ["f0000000-0000-4000-8000-000000000001"]
  }
};

function postgresMeetingRecordHarness() {
  const records = new Map<string, MeetingRecord>();
  const key = (meetingId: string, revision: number) => `${meetingId}:${revision}`;
  const clientQuery = vi.fn(async (text: string, values: unknown[] = []) => {
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (text.includes("INSERT INTO meeting_records")) {
      const candidate = JSON.parse(String(values[5])) as MeetingRecord["content"];
      const next: MeetingRecord = {
        meetingId: String(values[0]),
        revision: Number(values[1]),
        closedAt: String(values[2]),
        generatedAt: String(values[3]),
        generationMode: values[4] as MeetingRecord["generationMode"],
        content: candidate,
        sourceDigest: String(values[6]),
        createdBy: values[7] as MeetingRecord["createdBy"]
      };
      if (records.has(key(next.meetingId, next.revision))) return { rows: [], rowCount: 0 };
      records.set(key(next.meetingId, next.revision), structuredClone(next));
      return { rows: [{
        meetingId: next.meetingId,
        revision: next.revision,
        closedAt: next.closedAt,
        generatedAt: next.generatedAt,
        generationMode: next.generationMode,
        content: next.content,
        sourceDigest: next.sourceDigest,
        createdBy: next.createdBy
      }], rowCount: 1 };
    }
    if (text.includes("FROM meeting_records") && text.includes("revision = $2")) {
      const found = records.get(key(String(values[0]), Number(values[1])));
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }
    if (text.includes("FROM meeting_records")) {
      const found = [...records.values()]
        .filter((item) => item.meetingId === String(values[0]))
        .sort((left, right) => right.revision - left.revision)[0];
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  });
  const client = { query: clientQuery, release: vi.fn() } as unknown as PoolClient;
  return {
    clientQuery,
    pool: { connect: vi.fn(async () => client), query: clientQuery } as unknown as Pool
  };
}

describe("Meeting Record persistence", () => {
  it("normalizes a missing legacy closedAt and persists it when a Meeting closes", async () => {
    const legacy = createSeedSnapshot() as unknown as { meetings: Array<Record<string, unknown>> };
    delete legacy.meetings[0]!.closedAt;
    const store = new InMemoryPlatformStore(legacy as never);
    expect((await store.getSnapshot()).meetings[0]!.closedAt).toBeNull();

    const meeting = await store.setMeetingState((await store.getSnapshot()).meetings[0]!.id, "closed");
    expect(meeting.closedAt).toEqual(expect.any(String));
  });

  it("replays an identical in-memory record and fails closed for changed payloads", async () => {
    const store = new InMemoryPlatformStore();
    await store.setMeetingState(record.meetingId, "closed");
    const closed = (await store.getSnapshot()).meetings[0]!.closedAt!;
    const input = { ...record, closedAt: closed, content: { ...record.content, meeting: { ...record.content.meeting, closedAt: closed } } };

    await expect(store.appendMeetingRecord(input)).resolves.toEqual(input);
    await expect(store.appendMeetingRecord(structuredClone(input))).resolves.toEqual(input);
    await expect(store.appendMeetingRecord({
      ...input,
      content: { ...input.content, outcome: { ...input.content.outcome, summary: "Changed after retry." } }
    })).rejects.toMatchObject({ statusCode: 409 });
    await expect(store.getLatestMeetingRecord(input.meetingId)).resolves.toEqual(input);
  });

  it("uses the same replay and latest-record behavior in PostgreSQL", async () => {
    const harness = postgresMeetingRecordHarness();
    const store = new PostgresPlatformStore(harness.pool);

    await expect(store.appendMeetingRecord(record)).resolves.toEqual(record);
    await expect(store.appendMeetingRecord(structuredClone(record))).resolves.toEqual(record);
    await expect(store.appendMeetingRecord({
      ...record,
      content: { ...record.content, outcome: { ...record.content.outcome, summary: "Changed after retry." } }
    })).rejects.toMatchObject({ statusCode: 409 });
    await expect(store.getLatestMeetingRecord(record.meetingId)).resolves.toEqual(record);
    expect(harness.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO meeting_records"))).toBe(true);
  });

  it("declares an append-only, indexed Meeting Record table migration", () => {
    const migration = additiveMigrations.find((item) => item.version === "040_meeting_records")?.sql;
    expect(migration).toContain("audit_events");
    expect(migration).toContain("meeting.close");
    expect(migration).toContain("MAX(close_event.created_at)");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS meeting_records");
    expect(migration).toContain("UNIQUE (meeting_id, revision)");
    expect(migration).toContain("CREATE INDEX IF NOT EXISTS meeting_records_meeting_latest_idx");
    expect(migration).toContain("BEFORE UPDATE OR DELETE");
  });
});
