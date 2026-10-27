import { describe, expect, it } from "vitest";
import {
  agendaItemSchema,
  advanceMeetingAgendaSchema,
  createMeetingSchema,
  meetingAgendaSchema,
  setMeetingAgendaSchema
} from "./index.js";

const participant = {
  agentId: "50000000-0000-4000-8000-000000000001",
  roleId: "60000000-0000-4000-8000-000000000001",
  isChair: true
};

const meetingInput = {
  threadId: "40000000-0000-4000-8000-000000000001",
  title: "架構評審",
  goal: "確認可發布的系統邊界。",
  mode: "chaired" as const,
  durationMinutes: 30,
  participants: [participant],
  agendaItems: [
    { title: "確認目標與範圍", description: "對齊本次輸出。" },
    { title: "檢視方案與風險", description: "" }
  ]
};

describe("Meeting Agenda contracts", () => {
  it("requires one to twelve bounded Agenda items when creating a Meeting", () => {
    expect(createMeetingSchema.parse(meetingInput).agendaItems).toEqual(meetingInput.agendaItems);
    expect(() => createMeetingSchema.parse({ ...meetingInput, agendaItems: [] })).toThrow();
    expect(() => createMeetingSchema.parse({
      ...meetingInput,
      agendaItems: Array.from({ length: 13 }, (_, index) => ({ title: `Item ${index + 1}`, description: "" }))
    })).toThrow();
    expect(() => createMeetingSchema.parse({
      ...meetingInput,
      agendaItems: [{ title: "x".repeat(161), description: "" }]
    })).toThrow();
    expect(() => createMeetingSchema.parse({
      ...meetingInput,
      agendaItems: [{ title: "Valid", description: "x".repeat(1001) }]
    })).toThrow();
  });

  it("rejects duplicate normalized titles and unknown Agenda fields", () => {
    expect(() => createMeetingSchema.parse({
      ...meetingInput,
      agendaItems: [
        { title: "Risk Review", description: "" },
        { title: "  risk review  ", description: "" }
      ]
    })).toThrow(/title may appear only once/i);
    expect(() => createMeetingSchema.parse({
      ...meetingInput,
      agendaItems: [{ title: "Review", description: "", shell: "rm -rf /" }]
    })).toThrow();
  });

  it("accepts only authoritative persisted Agenda item states", () => {
    expect(agendaItemSchema.parse({
      id: "d0000000-0000-4000-8000-000000000001",
      title: "確認目標",
      description: "",
      position: 0,
      status: "current",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:01:00.000Z",
      startedAt: "2026-07-20T00:01:00.000Z",
      resolvedAt: null
    })).toMatchObject({ status: "current", position: 0 });
    expect(() => agendaItemSchema.parse({
      id: "d0000000-0000-4000-8000-000000000001",
      title: "確認目標",
      description: "",
      position: 0,
      status: "running",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:01:00.000Z",
      startedAt: null,
      resolvedAt: null
    })).toThrow();
  });

  it("requires terminal, current, and pending Agenda items to remain in lifecycle order", () => {
    const at = "2026-07-20T00:00:00.000Z";
    const item = (id: string, position: number, status: "completed" | "current" | "pending") => ({
      id,
      title: `Item ${position + 1}`,
      description: "",
      position,
      status,
      createdAt: at,
      updatedAt: at,
      startedAt: status === "pending" ? null : at,
      resolvedAt: status === "completed" ? at : null
    });
    expect(meetingAgendaSchema.parse({
      revision: 2,
      items: [
        item("d0000000-0000-4000-8000-000000000011", 0, "completed"),
        item("d0000000-0000-4000-8000-000000000012", 1, "current"),
        item("d0000000-0000-4000-8000-000000000013", 2, "pending")
      ]
    })).toMatchObject({ revision: 2 });
    expect(() => meetingAgendaSchema.parse({
      revision: 2,
      items: [
        item("d0000000-0000-4000-8000-000000000014", 0, "pending"),
        item("d0000000-0000-4000-8000-000000000015", 1, "current")
      ]
    })).toThrow(/lifecycle order/i);
  });

  it("requires a revision and a strict full Agenda edit payload", () => {
    expect(setMeetingAgendaSchema.parse({
      expectedRevision: 3,
      items: [
        {
          id: "d0000000-0000-4000-8000-000000000001",
          title: "已開始項目",
          description: "保留原內容。"
        },
        { title: "新增待處理項目", description: "" }
      ]
    })).toMatchObject({ expectedRevision: 3 });
    expect(() => setMeetingAgendaSchema.parse({ items: [] })).toThrow();
    expect(() => setMeetingAgendaSchema.parse({ expectedRevision: 0, items: [] })).toThrow();
    expect(() => setMeetingAgendaSchema.parse({ expectedRevision: -1, items: [] })).toThrow();
    expect(() => setMeetingAgendaSchema.parse({ expectedRevision: 0, items: [], force: true })).toThrow();
    expect(() => setMeetingAgendaSchema.parse({
      expectedRevision: 0,
      items: [
        { id: "d0000000-0000-4000-8000-000000000001", title: "A", description: "" },
        { id: "d0000000-0000-4000-8000-000000000001", title: "B", description: "" }
      ]
    })).toThrow(/ID may appear only once/i);
  });

  it("allows only explicit Agenda progress transitions", () => {
    expect(advanceMeetingAgendaSchema.parse({ expectedRevision: 2, action: "activate" })).toEqual({ expectedRevision: 2, action: "activate" });
    expect(advanceMeetingAgendaSchema.parse({
      expectedRevision: 2,
      action: "complete",
      itemId: "d0000000-0000-4000-8000-000000000001"
    })).toMatchObject({ action: "complete" });
    expect(advanceMeetingAgendaSchema.parse({
      expectedRevision: 2,
      action: "skip",
      itemId: "d0000000-0000-4000-8000-000000000001"
    })).toMatchObject({ action: "skip" });
    expect(() => advanceMeetingAgendaSchema.parse({ expectedRevision: 2, action: "complete" })).toThrow();
    expect(() => advanceMeetingAgendaSchema.parse({ expectedRevision: 2, action: "activate", itemId: "d0000000-0000-4000-8000-000000000001" })).toThrow();
    expect(() => advanceMeetingAgendaSchema.parse({ expectedRevision: 2, action: "reopen", itemId: "d0000000-0000-4000-8000-000000000001" })).toThrow();
  });
});
