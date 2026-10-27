import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgendaItem, DiscussionThread, MeetingAgenda } from "@council/contracts";
import {
  agendaConflictRecovery,
  agendaDraftHasChanges,
  topicConflictRecovery,
  topicDraftBaseFromThread,
  topicDraftHasChanges
} from "./discussion-conflict-recovery";

function thread(overrides: Partial<DiscussionThread> = {}): DiscussionThread {
  return {
    id: "thread-1",
    revision: 1,
    categoryId: "category-1",
    title: "Original title",
    summary: "Original summary",
    status: "open",
    tagIds: ["tag-1"],
    createdAt: "2026-08-11T00:00:00.000Z",
    ...overrides
  };
}

function agendaItem(id: string, title: string, overrides: Partial<AgendaItem> = {}): AgendaItem {
  return {
    id,
    title,
    description: `${title} description`,
    position: id === "agenda-a" ? 0 : 1,
    status: "pending",
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    startedAt: null,
    resolvedAt: null,
    ...overrides
  };
}

function agenda(revision: number, items: AgendaItem[]): MeetingAgenda {
  return { revision, items };
}

describe("Topic conflict recovery", () => {
  it("rebases non-overlapping local and authoritative field changes", () => {
    const base = topicDraftBaseFromThread(thread());
    const local = { ...base.fields, title: "Local title" };
    const latest = thread({ revision: 2, summary: "Authoritative summary" });

    expect(topicConflictRecovery(base, local, latest)).toEqual({
      kind: "rebased",
      draft: {
        categoryId: "category-1",
        title: "Local title",
        summary: "Authoritative summary",
        status: "open",
        tagIds: ["tag-1"]
      }
    });
  });

  it("blocks a rebase when both sides changed the same field differently", () => {
    const base = topicDraftBaseFromThread(thread());
    const local = { ...base.fields, title: "Local title" };
    const latest = thread({ revision: 2, title: "Authoritative title" });

    expect(topicConflictRecovery(base, local, latest)).toEqual({
      kind: "conflict",
      fields: ["title"]
    });
  });

  it("treats equivalent tag sets as the same edit and detects dirty drafts", () => {
    const base = topicDraftBaseFromThread(thread({ tagIds: ["tag-1", "tag-2"] }));

    expect(topicDraftHasChanges(base, { ...base.fields, tagIds: ["tag-2", "tag-1"] })).toBe(false);
    expect(topicDraftHasChanges(base, { ...base.fields, summary: "Local summary" })).toBe(true);
    expect(topicConflictRecovery(
      base,
      { ...base.fields, tagIds: ["tag-2", "tag-3"] },
      thread({ revision: 2, tagIds: ["tag-3", "tag-2"] })
    )).toMatchObject({ kind: "rebased" });
  });
});

describe("Agenda conflict recovery", () => {
  it("rebases non-overlapping item changes onto the authoritative revision", () => {
    const base = agenda(1, [agendaItem("agenda-a", "A"), agendaItem("agenda-b", "B")]);
    const local = [
      { id: "agenda-a", title: "Local A", description: "A description" },
      { id: "agenda-b", title: "B", description: "B description" }
    ];
    const latest = agenda(2, [
      agendaItem("agenda-a", "A"),
      agendaItem("agenda-b", "B", { description: "Authoritative B" })
    ]);

    expect(agendaConflictRecovery(base, local, latest)).toEqual({
      kind: "rebased",
      draft: [
        { id: "agenda-a", title: "Local A", description: "A description" },
        { id: "agenda-b", title: "B", description: "Authoritative B" }
      ]
    });
  });

  it("rebases changes to different fields on the same pending item", () => {
    const base = agenda(1, [agendaItem("agenda-a", "A")]);
    const local = [{ id: "agenda-a", title: "Local A", description: "A description" }];
    const latest = agenda(2, [agendaItem("agenda-a", "A", { description: "Authoritative A" })]);

    expect(agendaConflictRecovery(base, local, latest)).toEqual({
      kind: "rebased",
      draft: [{ id: "agenda-a", title: "Local A", description: "Authoritative A" }]
    });
  });

  it("requires discard when the same field changed differently", () => {
    const base = agenda(1, [agendaItem("agenda-a", "A")]);
    const local = [{ id: "agenda-a", title: "Local A", description: "A description" }];
    const latest = agenda(2, [agendaItem("agenda-a", "Authoritative A")]);

    expect(agendaConflictRecovery(base, local, latest)).toEqual({
      kind: "conflict",
      conflicts: ["agenda-a:title"]
    });
  });

  it("requires discard when progress locks an item with local edits", () => {
    const base = agenda(1, [agendaItem("agenda-a", "A")]);
    const local = [{ id: "agenda-a", title: "Local A", description: "A description" }];
    const latest = agenda(2, [agendaItem("agenda-a", "A", { status: "current", startedAt: "2026-08-11T00:01:00.000Z" })]);

    expect(agendaConflictRecovery(base, local, latest)).toEqual({
      kind: "conflict",
      conflicts: ["agenda-a:status"]
    });
  });

  it("keeps a local addition when the server only changed existing content", () => {
    const base = agenda(1, [agendaItem("agenda-a", "A"), agendaItem("agenda-b", "B")]);
    const local = [
      { id: "agenda-a", title: "A", description: "A description" },
      { id: "agenda-b", title: "B", description: "B description" },
      { title: "Local C", description: "" }
    ];
    const latest = agenda(2, [
      agendaItem("agenda-a", "A", { description: "Authoritative A" }),
      agendaItem("agenda-b", "B")
    ]);

    expect(agendaConflictRecovery(base, local, latest)).toEqual({
      kind: "rebased",
      draft: [
        { id: "agenda-a", title: "A", description: "Authoritative A" },
        { id: "agenda-b", title: "B", description: "B description" },
        { title: "Local C", description: "" }
      ]
    });
    expect(agendaDraftHasChanges(base, local)).toBe(true);
  });

  it("requires discard for concurrent structural edits", () => {
    const base = agenda(1, [agendaItem("agenda-a", "A"), agendaItem("agenda-b", "B")]);
    const local = [
      { id: "agenda-b", title: "B", description: "B description" },
      { id: "agenda-a", title: "A", description: "A description" }
    ];
    const latest = agenda(2, [
      agendaItem("agenda-a", "A"),
      agendaItem("agenda-b", "B"),
      agendaItem("agenda-c", "C", { position: 2 })
    ]);

    expect(agendaConflictRecovery(base, local, latest)).toEqual({
      kind: "conflict",
      conflicts: ["agenda:structure"]
    });
  });
});

describe("Discussion conflict UI wiring", () => {
  const source = readFileSync(new URL("../components/discussions-view.tsx", import.meta.url), "utf8");

  it("refreshes authoritative state after both 409 paths while retaining controlled drafts", () => {
    expect(source).toContain("isRevisionConflictError(cause)");
    expect(source).toContain("await refreshMeeting(meeting.id)");
    expect(source).toContain("await refresh()");
    expect(source).toContain("setAgendaConflict(true)");
    expect(source).toContain("setEditThreadConflict(true)");
  });

  it("blocks stale Topic resubmission until explicit recovery", () => {
    expect(source).toContain("topicConflictRecovery(");
    expect(source).toContain("disabled={busy || editThreadConflict}");
    expect(source).toContain("重新載入最新內容");
    expect(source).toContain("合併最新內容");
  });

  it("routes Topic escape, backdrop, close, and cancel through one dirty-draft guard", () => {
    expect(source).toContain("onClose={requestCloseThreadEditor}");
    expect(source).toContain("onClick={requestCloseThreadEditor}");
    expect(source).toContain("topicDraftHasChanges(");
    expect(source).toContain("window.confirm(");
  });
});
