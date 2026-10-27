import { describe, expect, it } from "vitest";
import {
  chairAutomationLevels,
  createMeetingSchema,
  setMeetingAutomationSchema
} from "./index.js";

const meetingInput = {
  threadId: "30000000-0000-4000-8000-000000000001",
  title: "主席自動化驗收",
  goal: "確認主席策略可按會議切換",
  mode: "open" as const,
  durationMinutes: 30,
  participants: [{
    agentId: "50000000-0000-4000-8000-000000000001",
    roleId: "60000000-0000-4000-8000-000000000001",
    isChair: true
  }],
  agendaItems: [{ title: "確認策略", description: "" }]
};

describe("Chair automation contracts", () => {
  it("keeps legacy Meeting creation on suggestion mode and accepts all explicit levels", () => {
    expect(chairAutomationLevels).toEqual(["manual", "suggest", "auto"]);
    expect(createMeetingSchema.parse(meetingInput).automation).toBe("suggest");

    for (const automation of chairAutomationLevels) {
      expect(createMeetingSchema.parse({ ...meetingInput, automation }).automation).toBe(automation);
    }
    expect(() => createMeetingSchema.parse({ ...meetingInput, automation: "unbounded" })).toThrow();
  });

  it("requires an optimistic concurrency precondition for policy changes", () => {
    expect(setMeetingAutomationSchema.parse({
      automation: "auto",
      expectedAutomation: "suggest",
      expectedAutomationRevision: 0
    })).toEqual({ automation: "auto", expectedAutomation: "suggest", expectedAutomationRevision: 0 });
    expect(() => setMeetingAutomationSchema.parse({ automation: "auto" })).toThrow();
    expect(() => setMeetingAutomationSchema.parse({
      automation: "auto",
      expectedAutomation: "suggest",
      expectedAutomationRevision: 0,
      actor: "system"
    })).toThrow();
    expect(() => setMeetingAutomationSchema.parse({
      automation: "auto",
      expectedAutomation: "suggest",
      expectedAutomationRevision: -1
    })).toThrow();
  });
});
