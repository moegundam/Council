import type { Agent, ChairAutomationLevel, ChairSuggestionRecord, MeetingState, ModelConnector } from "@council/contracts";

export const chairAutomationLabel: Record<ChairAutomationLevel, string> = {
  manual: "手動",
  suggest: "建議",
  auto: "自動"
};

export const chairAutomationOptions: Array<{ value: ChairAutomationLevel; label: string }> = [
  { value: "manual", label: chairAutomationLabel.manual },
  { value: "suggest", label: chairAutomationLabel.suggest },
  { value: "auto", label: chairAutomationLabel.auto }
];

export function shouldShowChairSuggestion(automation: ChairAutomationLevel): boolean {
  return automation !== "manual";
}

export function chairAutomationSuggestionStatusLabel(status: ChairSuggestionRecord["status"]): string {
  return status === "pending" ? "主席自動處理中" : "自動未套用，待人工處理";
}

export function canChangeChairAutomation(input: {
  meetingState: MeetingState;
  from: ChairAutomationLevel;
  to: ChairAutomationLevel;
  requestPending: boolean;
  queueActive: boolean;
}): boolean {
  if (input.meetingState === "closed" || input.from === input.to) return false;
  if (input.from === "auto" && input.to !== "auto") return true;
  if (input.requestPending) return false;
  if (input.to === "auto" && input.queueActive && input.from !== "auto") return false;
  return true;
}

export function canRequestChairIntervention(input: {
  meetingState: MeetingState;
  busy: boolean;
  actionPending: boolean;
}): boolean {
  return input.meetingState === "active" && !input.busy && !input.actionPending;
}

export function chairUsesCloudModel(input: {
  automation: ChairAutomationLevel;
  chairAgentId: string | null;
  agents: ReadonlyArray<Pick<Agent, "id" | "modelConnectorId">>;
  connectors: ReadonlyArray<Pick<ModelConnector, "id" | "location">>;
}): boolean {
  if (input.automation !== "auto" || !input.chairAgentId) return false;
  const agent = input.agents.find((candidate) => candidate.id === input.chairAgentId);
  const connector = agent?.modelConnectorId ? input.connectors.find((candidate) => candidate.id === agent.modelConnectorId) : undefined;
  return connector?.location === "cloud";
}
