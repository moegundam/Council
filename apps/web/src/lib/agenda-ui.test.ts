import { describe, expect, it } from "vitest";
import type { AgendaItem, Meeting } from "@council/contracts";
import {
  agendaDraftRevisionMatches,
  agendaProgress,
  agendaPrimaryCommand,
  canEditAgendaItem,
  canRemoveAgendaItem,
  canSubmitAgendaDraft,
  moveAgendaDraftItem,
  updateAgendaDraftItem,
  type AgendaDraftItem
} from "./agenda-ui";

const draft = (title: string, id?: string): AgendaDraftItem => id ? { id, title, description: "" } : { title, description: "" };

function item(id: string, title: string, status: AgendaItem["status"], position: number): AgendaItem {
  return {
    id,
    title,
    description: "",
    position,
    status,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    startedAt: status === "current" ? "2026-07-20T00:01:00.000Z" : null,
    resolvedAt: status === "completed" || status === "skipped" ? "2026-07-20T00:02:00.000Z" : null
  };
}

describe("agenda UI helpers", () => {
  it("keeps an open draft bound to the Agenda revision it was copied from", () => {
    expect(agendaDraftRevisionMatches(3, { revision: 3 })).toBe(true);
    expect(agendaDraftRevisionMatches(3, { revision: 4 })).toBe(false);
    expect(agendaDraftRevisionMatches(null, { revision: 0 })).toBe(false);
  });

  it("requires one to twelve non-empty, unique agenda titles", () => {
    expect(canSubmitAgendaDraft([draft("目標")])).toBe(true);
    expect(canSubmitAgendaDraft([])).toBe(false);
    expect(canSubmitAgendaDraft(Array.from({ length: 13 }, (_, index) => draft(`項目 ${index}`)))).toBe(false);
    expect(canSubmitAgendaDraft([draft("  "), draft("範圍")])).toBe(false);
    expect(canSubmitAgendaDraft([draft("目標"), draft("  目標 ")])).toBe(false);
  });

  it("updates and reorders draft items without mutating the source", () => {
    const source = [draft("一", "one"), draft("二", "two"), draft("三", "three")];
    expect(updateAgendaDraftItem(source, "two", { description: "細節" })).toEqual([
      draft("一", "one"),
      { ...draft("二", "two"), description: "細節" },
      draft("三", "three")
    ]);
    expect(moveAgendaDraftItem(source, 1, -1).map((entry) => entry.title)).toEqual(["二", "一", "三"]);
    expect(moveAgendaDraftItem(source, 0, -1)).toEqual(source);
    expect(source.map((entry) => entry.title)).toEqual(["一", "二", "三"]);
  });

  it("counts completed and skipped items from the authoritative agenda snapshot", () => {
    expect(agendaProgress({
      revision: 4,
      items: [item("one", "一", "completed", 0), item("two", "二", "skipped", 1), item("three", "三", "current", 2), item("four", "四", "pending", 3)]
    })).toEqual({ resolved: 2, total: 4, current: item("three", "三", "current", 2), pending: 1 });
  });

  it("only exposes active Meeting advance commands", () => {
    const agenda = { revision: 1, items: [item("one", "一", "pending", 0)] };
    expect(agendaPrimaryCommand({ state: "active", agenda })).toEqual({ action: "activate" });
    expect(agendaPrimaryCommand({ state: "paused", agenda })).toBeNull();
    expect(agendaPrimaryCommand({ state: "closed", agenda })).toBeNull();
    expect(agendaPrimaryCommand({ state: "active", agenda: { revision: 1, items: [item("one", "一", "current", 0)] } })).toEqual({ action: "complete", itemId: "one" });
  });

  it("locks history and current items according to Meeting state", () => {
    const current = item("current", "目前", "current", 0);
    const pending = item("pending", "下一項", "pending", 1);
    const closed = { state: "closed" } as Meeting;
    expect(canEditAgendaItem({ state: "draft" } as Meeting, current)).toBe(true);
    expect(canEditAgendaItem({ state: "active" } as Meeting, current)).toBe(false);
    expect(canEditAgendaItem({ state: "active" } as Meeting, pending)).toBe(true);
    expect(canEditAgendaItem({ state: "paused" } as Meeting, pending)).toBe(true);
    expect(canEditAgendaItem(closed, pending)).toBe(false);
    expect(canRemoveAgendaItem({ state: "active" } as Meeting, current)).toBe(false);
    expect(canRemoveAgendaItem({ state: "active" } as Meeting, pending)).toBe(true);
  });
});
