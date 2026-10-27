import { describe, expect, it } from "vitest";
import type { PlatformSnapshot } from "@council/contracts";
import { evaluateMeetingChairSuggestion, permittedAgentIdsForMeeting, remainingMeetingMinutes } from "./meeting-policy.js";

function snapshot(mode: "chaired" | "open" | "fixed" = "chaired"): PlatformSnapshot {
  const startedAt = "2026-07-16T00:00:00.000Z";
  const roleSnapshot = (roleId: string, name: string) => ({
    roleId,
    name,
    usageContext: "Use in this Meeting.",
    responsibility: "Participate in the Meeting.",
    speakingGuidance: "Stay on topic.",
    decisionScope: "Propose only.",
    constraints: "Do not approve decisions.",
    version: 1,
    templateKey: null,
    toolPolicy: "none" as const,
    dataPolicy: "meeting_only" as const,
    orchestrationFunctions: [],
    source: "meeting_created" as const
  });
  const participant = (id: string, agentId: string, roleId: string, roleName: string, isChair: boolean) => {
    const snapshot = roleSnapshot(roleId, roleName);
    return {
      id,
      meetingId: "meeting",
      agentId,
      roleId,
      roleRevision: 1,
      agentRevision: 1,
      roleHistory: [{ revision: 1, roleId, roleSnapshot: snapshot, changedAt: startedAt, changedBy: "system" as const, reason: "fixture" }],
      isChair,
      roleSnapshot: snapshot
    };
  };
  return {
    groups: [], categories: [], tags: [], threads: [], skills: [], mcpConnectors: [], taskAdapterConnectors: [], decisions: [], tasks: [], chairSuggestions: [], toolRuns: [], speakerQueue: [],
    roles: [
      { id: "role-chair", name: "Chair", usageContext: "Keep the agenda focused.", responsibility: "Chair the meeting.", speakingGuidance: "Refocus.", decisionScope: "Propose.", constraints: "Do not approve.", version: 1, templateKey: "meeting_chair", toolPolicy: "none", dataPolicy: "meeting_only", deletedAt: null },
      { id: "role-architect", name: "Architect", usageContext: "Architecture review.", responsibility: "Review architecture.", speakingGuidance: "State tradeoffs.", decisionScope: "Propose.", constraints: "Do not approve.", version: 1, templateKey: "platform_architect", toolPolicy: "none", dataPolicy: "meeting_only", deletedAt: null },
      { id: "role-reviewer", name: "Reviewer", usageContext: "Security review.", responsibility: "Review risks.", speakingGuidance: "State risks.", decisionScope: "Propose.", constraints: "Do not approve.", version: 1, templateKey: "security_reviewer", toolPolicy: "none", dataPolicy: "meeting_only", deletedAt: null },
      { id: "role-evidence", name: "Evidence", usageContext: "Evidence review.", responsibility: "Check sources.", speakingGuidance: "Separate evidence from inference.", decisionScope: "Propose.", constraints: "Do not approve.", version: 2, templateKey: "evidence_analyst", toolPolicy: "none", dataPolicy: "meeting_only", deletedAt: null }
    ],
    modelConnectors: [{ id: "model", revision: 1, name: "Local", location: "local", baseUrl: "http://localhost/v1", model: "test", enabled: true, hasSecret: false, secretRevision: 0 }],
    agents: [
      { id: "chair", name: "Chair", description: "", modelConnectorId: "model", goalSummary: "主持", toolsSummary: "無", dataSummary: "會議", skillIds: [], toolGrants: [], toolPackGrants: [], runtimeProfileBinding: null, status: "online" },
      { id: "architect", name: "Architect", description: "", modelConnectorId: "model", goalSummary: "架構", toolsSummary: "無", dataSummary: "會議", skillIds: [], toolGrants: [], toolPackGrants: [], runtimeProfileBinding: null, status: "online" },
      { id: "reviewer", name: "Reviewer", description: "", modelConnectorId: "model", goalSummary: "審查", toolsSummary: "無", dataSummary: "會議", skillIds: [], toolGrants: [], toolPackGrants: [], runtimeProfileBinding: null, status: "online" }
    ],
    meetings: [{ id: "meeting", threadId: "thread", title: "Review", goal: "確認模型與工具權限", state: "active", mode, automation: "suggest", durationMinutes: 30, startedAt, closedAt: null, agenda: {
      revision: 1,
      items: [{ id: "agenda-current", title: "模型與工具權限", description: "確認白名單與資料邊界", position: 0, status: "current", createdAt: startedAt, updatedAt: startedAt, startedAt, resolvedAt: null }]
    }, summaryState: "not_requested", summaryJobId: null, createdAt: startedAt }],
    participants: [
      participant("p-chair", "chair", "role-chair", "Chair", true),
      participant("p-architect", "architect", "role-architect", "Architect", false),
      participant("p-reviewer", "reviewer", "role-reviewer", "Reviewer", false)
    ],
    utterances: []
  };
}

function addAgentUtterance(value: PlatformSnapshot, agentId: string, content = "模型與工具權限需要白名單"): void {
  const agent = value.agents.find((item) => item.id === agentId)!;
  value.utterances.push({ id: `u-${value.utterances.length}`, meetingId: "meeting", agentId, speakerType: "agent", speakerName: agent.name, roleName: "Role", content, kind: "inference", evidenceCount: 0, createdAt: new Date().toISOString() });
}

describe("meeting mode policy", () => {
  it("keeps open mode available to every runnable participant", () => {
    expect(permittedAgentIdsForMeeting(snapshot("open"), "meeting")).toEqual(["chair", "architect", "reviewer"]);
    const value = snapshot("open");
    value.agents.find((agent) => agent.id === "reviewer")!.modelConnectorId = null;
    expect(permittedAgentIdsForMeeting(value, "meeting")).toEqual(["chair", "architect", "reviewer"]);

    value.agents.find((agent) => agent.id === "reviewer")!.lifecycleStatus = "disabled";
    expect(permittedAgentIdsForMeeting(value, "meeting")).toEqual(["chair", "architect"]);
  });

  it("keeps the mutable connector check only for legacy unpinned participants", () => {
    const value = snapshot("open");
    const reviewer = value.participants.find((participant) => participant.agentId === "reviewer")!;
    delete reviewer.agentRevision;
    value.agents.find((agent) => agent.id === "reviewer")!.modelConnectorId = null;

    expect(permittedAgentIdsForMeeting(value, "meeting")).toEqual(["chair", "architect"]);
  });

  it("enforces fixed participant order", () => {
    const value = snapshot("fixed");
    expect(permittedAgentIdsForMeeting(value, "meeting")).toEqual(["chair"]);
    addAgentUtterance(value, "chair");
    expect(permittedAgentIdsForMeeting(value, "meeting")).toEqual(["architect"]);
    addAgentUtterance(value, "architect");
    expect(permittedAgentIdsForMeeting(value, "meeting")).toEqual(["reviewer"]);
  });

  it("alternates chaired mode between the chair and one invited role", () => {
    const value = snapshot("chaired");
    expect(permittedAgentIdsForMeeting(value, "meeting")).toEqual(["chair"]);
    addAgentUtterance(value, "chair");
    expect(permittedAgentIdsForMeeting(value, "meeting")).toEqual(["architect", "reviewer"]);
    addAgentUtterance(value, "architect");
    expect(permittedAgentIdsForMeeting(value, "meeting")).toEqual(["chair"]);
    addAgentUtterance(value, "chair");
    value.utterances.push({ id: "tool", meetingId: "meeting", speakerType: "tool", speakerName: "Docs", roleName: null, content: "查詢結果", kind: "verified", evidenceCount: 1, createdAt: new Date().toISOString() });
    expect(permittedAgentIdsForMeeting(value, "meeting")).toEqual(["architect", "reviewer"]);
    value.utterances.push({ id: "owner", meetingId: "meeting", speakerType: "human", speakerName: "Owner", roleName: "決策者", content: "請重新聚焦", kind: "human", evidenceCount: 0, createdAt: new Date().toISOString() });
    expect(permittedAgentIdsForMeeting(value, "meeting")).toEqual(["chair"]);
  });

  it("computes remaining time without going negative", () => {
    const meeting = snapshot().meetings[0]!;
    expect(remainingMeetingMinutes(meeting, Date.parse("2026-07-16T00:10:30.000Z"))).toBe(20);
    expect(remainingMeetingMinutes(meeting, Date.parse("2026-07-16T00:31:00.000Z"))).toBe(0);
  });

  it("keeps fixed order stable when an Agent is renamed after speaking", () => {
    const value = snapshot("fixed");
    addAgentUtterance(value, "chair");
    value.agents.find((agent) => agent.id === "chair")!.name = "Renamed Chair";
    expect(permittedAgentIdsForMeeting(value, "meeting")).toEqual(["architect"]);
  });

  it("targets the chair for a human-triggered intervention", () => {
    const value = snapshot("open");
    value.utterances.push(
      { id: "u-1", meetingId: "meeting", speakerType: "human", speakerName: "Owner", roleName: "決策者", content: "完全無關的午餐內容", kind: "human", evidenceCount: 0, createdAt: "2026-07-16T00:01:00.000Z" }
    );
    const suggestion = evaluateMeetingChairSuggestion(value, "meeting", Date.parse("2026-07-16T00:02:00.000Z"));
    expect(suggestion).toMatchObject({ reason: "off_topic", suggestedMode: "chaired", suggestedAgentId: "chair", suggestedAgentName: "Chair" });
  });

  it("uses stable Agent identity when a non-chair has the same display name", () => {
    const value = snapshot("open");
    value.agents.find((agent) => agent.id === "architect")!.name = "Chair";
    addAgentUtterance(value, "architect", "完全無關的午餐內容");

    expect(evaluateMeetingChairSuggestion(value, "meeting", Date.parse("2026-07-16T00:02:00.000Z"))).toMatchObject({
      reason: "off_topic",
      suggestedAgentId: "chair",
      suggestedParticipantId: "p-architect",
      suggestedParticipantAgentId: "architect",
      suggestedParticipantRoleRevision: 1,
      suggestedRoleId: "role-chair",
      suggestedRoleVersion: 1
    });
  });

  it("binds repetition Role advice to the speaking participant and immutable target version", () => {
    const value = snapshot("open");
    addAgentUtterance(value, "architect", "模型權限需要白名單與人工核准");
    addAgentUtterance(value, "architect", "模型權限需要白名單與人工核准");

    expect(evaluateMeetingChairSuggestion(value, "meeting", Date.parse("2026-07-16T00:02:00.000Z"))).toMatchObject({
      reason: "repetition",
      suggestedParticipantId: "p-architect",
      suggestedParticipantAgentName: "Architect",
      suggestedParticipantRoleRevision: 1,
      suggestedRoleId: "role-evidence",
      suggestedRoleName: "Evidence",
      suggestedRoleVersion: 2
    });
  });

  it("uses the Meeting goal and current Agenda title and description for relevance", () => {
    const value = snapshot("open");
    value.meetings[0]!.goal = "確認完全不同的治理邊界";
    value.meetings[0]!.agenda = {
      revision: 2,
      items: [{
        id: "agenda-current",
        title: "資料工作項目",
        description: "確認資料保留期限與刪除策略",
        position: 0,
        status: "current",
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
        startedAt: "2026-07-16T00:00:00.000Z",
        resolvedAt: null
      }]
    };
    value.utterances.push({ id: "goal-match", meetingId: "meeting", speakerType: "human", speakerName: "Owner", roleName: "決策者", content: "治理邊界", kind: "human", evidenceCount: 0, createdAt: "2026-07-16T00:01:00.000Z" });
    expect(evaluateMeetingChairSuggestion(value, "meeting", Date.parse("2026-07-16T00:02:00.000Z"))).toBeNull();

    value.utterances.at(-1)!.content = "保留期限與刪除策略";
    expect(evaluateMeetingChairSuggestion(value, "meeting", Date.parse("2026-07-16T00:02:00.000Z"))).toBeNull();
  });

  it("keeps an exact goal match relevant when the Agenda description contains many unrelated terms", () => {
    const value = snapshot("open");
    value.meetings[0]!.goal = "release readiness";
    value.meetings[0]!.agenda.items[0]!.title = "Detailed review";
    value.meetings[0]!.agenda.items[0]!.description = Array.from(
      { length: 100 },
      (_, index) => `unrelated-term-${index}`
    ).join(" ");
    value.utterances.push({
      id: "goal-match-long-agenda",
      meetingId: "meeting",
      speakerType: "human",
      speakerName: "Owner",
      roleName: "決策者",
      content: "release readiness",
      kind: "human",
      evidenceCount: 0,
      createdAt: "2026-07-16T00:01:00.000Z"
    });

    expect(evaluateMeetingChairSuggestion(value, "meeting", Date.parse("2026-07-16T00:02:00.000Z"))).toBeNull();
  });
});
