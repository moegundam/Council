import { describe, expect, it } from "vitest";
import { createRoleExecutionSnapshot, type PlatformSnapshot, type Role } from "@council/contracts";
import {
  agentRoleUsage,
  effectiveAgentTools,
  initialMeetingRoleSelection,
  meetingPrefillForAgent,
  meetingRoleSelectionIsValid,
  participantRoleSelectionIsNoop,
  preferredMeetingChairAgentId,
  reconcileMeetingRoleSelection,
  roleUsageSummary,
  roleVersionDifferences
} from "./role-ui.js";

const roles = [
  { id: "architect", templateKey: "platform_architect" },
  { id: "chair", templateKey: "meeting_chair" }
] as const;

function roleUsageFixture(): PlatformSnapshot {
  const createdAt = "2026-07-20T00:00:00.000Z";
  const role: Role = {
    id: "role-architect",
    name: "平台架構師",
    usageContext: "架構評審。",
    responsibility: "提出邊界。",
    speakingGuidance: "先界定範圍。",
    decisionScope: "提出候選決議。",
    constraints: "需要證據。",
    version: 1,
    templateKey: "platform_architect",
    toolPolicy: "agent_read_only_grants",
    dataPolicy: "agent_declared_scope",
    deletedAt: null
  };
  return {
    groups: [], categories: [], tags: [], threads: [], utterances: [], toolRuns: [], chairSuggestions: [], decisions: [], tasks: [], taskAdapterConnectors: [], speakerQueue: [],
    agents: [{ id: "agent-architect", name: "Architect-R", description: "", modelConnectorId: null, goalSummary: "架構", toolsSummary: "Docs", dataSummary: "文件", skillIds: ["skill-meeting"], toolGrants: [], toolPackGrants: [], runtimeProfileBinding: null, status: "attention" }],
    roles: [role],
    skills: [{ id: "skill-meeting", name: "Meeting", version: "1.0.0", instructions: "Stay on topic.", source: "Internal", owner: "Owner", contentDigest: "digest", validation: { result: "passed", summary: "Reviewed", checkedAt: createdAt, contentDigest: "digest" }, status: "approved", approvedAt: createdAt, revokedAt: null, revocationReason: null }],
    modelConnectors: [],
    mcpConnectors: [],
    meetings: [{ id: "meeting-1", threadId: "thread-1", title: "架構評審", goal: "確認邊界", state: "active", mode: "open", automation: "suggest", durationMinutes: 30, startedAt: createdAt, closedAt: null, agenda: { revision: 0, items: [] }, summaryState: "not_requested", summaryJobId: null, createdAt }],
    participants: [{ id: "participant-1", meetingId: "meeting-1", agentId: "agent-architect", roleId: role.id, roleRevision: 1, roleHistory: [{ revision: 1, roleId: role.id, roleSnapshot: createRoleExecutionSnapshot(role), changedAt: createdAt, changedBy: "owner", reason: "fixture" }], isChair: false, roleSnapshot: createRoleExecutionSnapshot(role) }]
  };
}

describe("Role UI selection", () => {
  it("selects a chair template by stable metadata rather than Role name or render index", () => {
    expect(initialMeetingRoleSelection(["agent-b", "agent-a"], roles, "agent-a")).toEqual({
      "agent-b": "architect",
      "agent-a": "chair"
    });
  });

  it("requires every selected Agent to have an explicit Role and the chair to be selected", () => {
    expect(meetingRoleSelectionIsValid(["agent-a", "agent-b"], "agent-a", { "agent-a": "chair", "agent-b": "architect" })).toBe(true);
    expect(meetingRoleSelectionIsValid(["agent-a", "agent-b"], "agent-a", { "agent-a": "chair" })).toBe(false);
    expect(meetingRoleSelectionIsValid(["agent-b"], "agent-a", { "agent-a": "chair", "agent-b": "architect" })).toBe(false);
  });

  it("allows the same Role identity when a newer current version is available", () => {
    const snapshot = roleUsageFixture();
    const participant = snapshot.participants[0]!;
    const role = snapshot.roles[0]!;

    expect(participantRoleSelectionIsNoop(participant, role)).toBe(true);
    expect(participantRoleSelectionIsNoop(participant, { id: role.id, version: role.version + 1 })).toBe(false);
  });

  it("compares a selected historical Role version with the current definition", () => {
    const base = {
      roleId: "role-1",
      name: "架構師",
      usageContext: "架構評審。",
      responsibility: "提出邊界。",
      speakingGuidance: "先界定範圍。",
      decisionScope: "提出候選決議。",
      constraints: "需要證據。",
      templateKey: "platform_architect" as const,
      toolPolicy: "none" as const,
      dataPolicy: "meeting_only" as const,
      source: "created" as const,
      restoredFromVersion: null,
      recordedAt: "2026-07-20T00:00:00.000Z"
    };
    const selected = { ...base, version: 1 };
    const current = {
      ...base,
      version: 2,
      usageContext: "架構與整合評審。",
      responsibility: "提出可維護邊界。",
      toolPolicy: "agent_read_only_grants" as const,
      dataPolicy: "agent_declared_scope" as const,
      source: "updated" as const
    };

    expect(roleVersionDifferences(selected, current)).toEqual([
      { field: "usageContext", label: "適用情境", selected: "架構評審。", current: "架構與整合評審。" },
      { field: "responsibility", label: "職責", selected: "提出邊界。", current: "提出可維護邊界。" },
      { field: "toolPolicy", label: "工具政策", selected: "不使用外部工具", current: "Agent 已授權唯讀工具" },
      { field: "dataPolicy", label: "資料政策", selected: "只限本場會議", current: "Agent 宣告資料範圍" }
    ]);
  });

  it("prefills the requested Agent with the available default chair and only maps selected participants", () => {
    expect(meetingPrefillForAgent(["architect", "chair", "security"], "chair", "architect", roles)).toEqual({
      participantIds: ["architect", "chair"],
      chairAgentId: "chair",
      roleIdByAgent: { architect: "architect", chair: "chair" }
    });
    expect(meetingPrefillForAgent(["architect", "chair"], "chair", "chair", roles)).toEqual({
      participantIds: ["chair"],
      chairAgentId: "chair",
      roleIdByAgent: { chair: "chair" }
    });
    expect(meetingPrefillForAgent(["chair"], "chair", "missing", roles)).toBeNull();
  });

  it("chooses the latest actual chair without inferring from an Agent display name", () => {
    const snapshot = roleUsageFixture();
    const architect = snapshot.agents[0]!;
    architect.name = "Chair Impostor";
    snapshot.agents.push({
      ...architect,
      id: "agent-facilitator",
      name: "主持人甲",
      skillIds: [],
      toolGrants: []
    });
    snapshot.meetings.push({
      ...snapshot.meetings[0]!,
      id: "meeting-2",
      title: "最新會議",
      createdAt: "2026-07-20T01:00:00.000Z"
    });
    snapshot.participants.push({
      ...snapshot.participants[0]!,
      id: "participant-2",
      meetingId: "meeting-2",
      agentId: "agent-facilitator",
      isChair: true
    });

    expect(preferredMeetingChairAgentId(snapshot, [architect.id, "agent-facilitator"])).toBe("agent-facilitator");
    expect(preferredMeetingChairAgentId(snapshot, [architect.id])).toBeNull();
  });

  it("preserves valid Role choices, fills a newly selected Agent, and removes stale mappings", () => {
    expect(reconcileMeetingRoleSelection(
      ["agent-a", "agent-b"],
      "agent-a",
      { "agent-a": "chair", stale: "architect" },
      roles
    )).toEqual({
      "agent-a": "chair",
      "agent-b": "architect"
    });
    expect(reconcileMeetingRoleSelection(
      ["agent-a"],
      "agent-a",
      { "agent-a": "deleted-role" },
      roles
    )).toEqual({ "agent-a": "chair" });
  });

  it("reports Agent Role usage from immutable Meeting snapshots instead of the current Role", () => {
    const snapshot = roleUsageFixture();
    const agent = snapshot.agents[0]!;
    const assignment = snapshot.participants.find((item) => item.agentId === agent.id)!;
    assignment.roleSnapshot = {
      ...assignment.roleSnapshot,
      name: "歷史架構評審",
      usageContext: "歷史適用情境",
      version: 7
    };
    snapshot.roles[0]!.name = "目前架構師";
    snapshot.roles[0]!.usageContext = "目前適用情境";

    expect(agentRoleUsage(snapshot, agent.id)).toEqual([
      expect.objectContaining({
        meetingTitle: snapshot.meetings[0]!.title,
        roleName: "歷史架構評審",
        roleVersion: 7,
        usageContext: "歷史適用情境",
        isChair: false
      })
    ]);
  });

  it("summarizes real Role relationships and gates effective tools through Role policy", () => {
    const snapshot = roleUsageFixture();
    const role = snapshot.roles[0]!;
    const agent = snapshot.agents[0]!;
    const connectorId = "d0000000-0000-4000-8000-000000000001";
    snapshot.modelConnectors.push({ id: "c0000000-0000-4000-8000-000000000001", revision: 1, name: "Local", location: "local", baseUrl: "http://127.0.0.1:4000/v1", model: "local", enabled: true, hasSecret: false, secretRevision: 0 });
    agent.modelConnectorId = snapshot.modelConnectors[0]!.id;
    snapshot.mcpConnectors.push({
      id: connectorId,
      revision: 1,
      name: "Docs",
      location: "local",
      baseUrl: "http://127.0.0.1:4100/mcp",
      approvedTools: ["search"],
      toolRegistrations: [{ toolName: "search", displayName: "Search", kind: "mcp_tool", version: "1.0.0", owner: "Owner", goal: "Find docs" }],
      enabled: true,
      hasSecret: false
    });
    agent.toolGrants = [{ connectorId, toolName: "search" }];

    expect(roleUsageSummary(snapshot, role.id)).toMatchObject({
      agentNames: [agent.name],
      meetingCount: 1,
      unfinishedMeetingCount: 1,
      runnableAgentCount: 1,
      skillCount: 1,
      toolCount: 1
    });
    role.toolPolicy = "none";
    expect(roleUsageSummary(snapshot, role.id).toolCount).toBe(0);
  });

  it("lists Agent tools only while Connector, allowlist, registration, and grant are all effective", () => {
    const snapshot = roleUsageFixture();
    const agent = snapshot.agents[0]!;
    const connectorId = "d0000000-0000-4000-8000-000000000002";
    snapshot.mcpConnectors.push({
      id: connectorId,
      revision: 1,
      name: "Docs",
      location: "local",
      baseUrl: "http://127.0.0.1:4100/mcp",
      approvedTools: ["search"],
      toolRegistrations: [{ toolName: "search", displayName: "Search", kind: "mcp_tool", version: "1.0.0", owner: "Owner", goal: "Find docs" }],
      enabled: true,
      hasSecret: false
    });
    agent.toolGrants = [{ connectorId, toolName: "search" }];

    expect(effectiveAgentTools(snapshot, agent.id)).toHaveLength(1);
    snapshot.mcpConnectors[0]!.enabled = false;
    expect(effectiveAgentTools(snapshot, agent.id)).toEqual([]);
    snapshot.mcpConnectors[0]!.enabled = true;
    snapshot.mcpConnectors[0]!.approvedTools = [];
    expect(effectiveAgentTools(snapshot, agent.id)).toEqual([]);
  });
});
