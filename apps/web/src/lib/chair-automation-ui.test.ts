import { describe, expect, it } from "vitest";
import type { ChairAutomationLevel } from "@council/contracts";
import {
  chairAutomationLabel,
  chairAutomationOptions,
  chairAutomationSuggestionStatusLabel,
  chairUsesCloudModel,
  canChangeChairAutomation,
  canRequestChairIntervention,
  shouldShowChairSuggestion
} from "./chair-automation-ui";

const agents = [
  { id: "agent-cloud", modelConnectorId: "connector-cloud" },
  { id: "agent-local", modelConnectorId: "connector-local" },
  { id: "agent-unassigned", modelConnectorId: null }
];
const connectors = [
  { id: "connector-cloud", location: "cloud" as const },
  { id: "connector-local", location: "local" as const }
];

describe("chair automation UI rules", () => {
  it("keeps the three compact options in the product order", () => {
    expect(chairAutomationOptions).toEqual([
      { value: "manual", label: "手動" },
      { value: "suggest", label: "建議" },
      { value: "auto", label: "自動" }
    ]);
    expect((Object.keys(chairAutomationLabel) as ChairAutomationLevel[]).map((key) => chairAutomationLabel[key])).toEqual(["手動", "建議", "自動"]);
  });

  it("only shows the existing chair suggestion band outside manual mode", () => {
    expect(shouldShowChairSuggestion("manual")).toBe(false);
    expect(shouldShowChairSuggestion("suggest")).toBe(true);
    expect(shouldShowChairSuggestion("auto")).toBe(true);
  });

  it("distinguishes running automation from an open suggestion that needs an owner", () => {
    expect(chairAutomationSuggestionStatusLabel("pending")).toBe("主席自動處理中");
    expect(chairAutomationSuggestionStatusLabel("open")).toBe("自動未套用，待人工處理");
  });

  it("blocks closed or pending changes, but permits emergency downshift during a queue", () => {
    expect(canChangeChairAutomation({ meetingState: "closed", from: "auto", to: "suggest", requestPending: false, queueActive: false })).toBe(false);
    expect(canChangeChairAutomation({ meetingState: "active", from: "suggest", to: "auto", requestPending: true, queueActive: false })).toBe(false);
    expect(canChangeChairAutomation({ meetingState: "active", from: "auto", to: "manual", requestPending: false, queueActive: true })).toBe(true);
    expect(canChangeChairAutomation({ meetingState: "active", from: "auto", to: "suggest", requestPending: false, queueActive: true })).toBe(true);
    expect(canChangeChairAutomation({ meetingState: "active", from: "auto", to: "manual", requestPending: true, queueActive: true })).toBe(true);
    expect(canChangeChairAutomation({ meetingState: "active", from: "suggest", to: "auto", requestPending: false, queueActive: true })).toBe(false);
    expect(canChangeChairAutomation({ meetingState: "active", from: "manual", to: "suggest", requestPending: false, queueActive: true })).toBe(true);
  });

  it("warns only when the selected Chair uses a cloud model in auto mode", () => {
    expect(chairUsesCloudModel({ automation: "auto", chairAgentId: "agent-cloud", agents, connectors })).toBe(true);
    expect(chairUsesCloudModel({ automation: "suggest", chairAgentId: "agent-cloud", agents, connectors })).toBe(false);
    expect(chairUsesCloudModel({ automation: "auto", chairAgentId: "agent-local", agents, connectors })).toBe(false);
    expect(chairUsesCloudModel({ automation: "auto", chairAgentId: "agent-unassigned", agents, connectors })).toBe(false);
  });

  it("only enables a suggested Chair intervention during an idle active Meeting", () => {
    expect(canRequestChairIntervention({ meetingState: "active", busy: false, actionPending: false })).toBe(true);
    expect(canRequestChairIntervention({ meetingState: "paused", busy: false, actionPending: false })).toBe(false);
    expect(canRequestChairIntervention({ meetingState: "closed", busy: false, actionPending: false })).toBe(false);
    expect(canRequestChairIntervention({ meetingState: "active", busy: true, actionPending: false })).toBe(false);
    expect(canRequestChairIntervention({ meetingState: "active", busy: false, actionPending: true })).toBe(false);
  });
});
