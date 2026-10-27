import { describe, expect, it } from "vitest";
import type { AgentReadiness, PlatformSnapshot } from "@council/contracts";
import {
  applyAgentTeam,
  applyMeetingPreset,
  filterAgentRoster,
  firstUnavailableTeamMemberId,
  getSettingsNavigation,
  promptLifecycleActions,
  readinessStatusUi,
  selectionAfterArchive
} from "./management-ui.js";

const baseSnapshot = (): PlatformSnapshot => ({
  groups: [], categories: [], tags: [], threads: [], roles: [
    { id: "role-1", name: "主席", usageContext: "", responsibility: "", speakingGuidance: "", decisionScope: "", constraints: "", version: 1, templateKey: "meeting_chair", toolPolicy: "none", dataPolicy: "meeting_only", deletedAt: null }
  ],
  skills: [{ id: "skill-1", name: "資料檢索", version: "1.0", instructions: "", source: "builtin", owner: "system", contentDigest: "digest", validation: { result: "passed", summary: "", checkedAt: "2026-01-01", contentDigest: "digest" }, status: "approved", approvedAt: "2026-01-01", revokedAt: null, revocationReason: null }],
  modelConnectors: [{ id: "model-1", revision: 1, name: "GB10", location: "local", baseUrl: "http://gb10/v1", model: "local-model", enabled: true, hasSecret: false, secretRevision: 0, credentialId: null }],
  mcpConnectors: [{ id: "mcp-1", revision: 1, name: "Issue MCP", location: "local", baseUrl: "http://mcp", approvedTools: ["read_issue"], enabled: true, hasSecret: false, toolRegistrations: [{ toolName: "read_issue", displayName: "讀取 Issue", kind: "mcp_tool", version: "1", owner: "system", goal: "讀取資料" }] }],
  runtimeProfiles: [{ id: "60000000-0000-4000-8000-000000000001", name: "標準文字執行", harnessKind: "openai_compatible", modelConnectorId: null, sandboxProfileId: null, policy: "read_only_tools", capabilities: ["text", "read_only_tool"], timeoutMs: 60_000, maxConcurrency: 1, enabled: true, revision: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
  runtimeProfileRevisions: [{ profileId: "60000000-0000-4000-8000-000000000001", revision: 1, name: "標準文字執行", harnessKind: "openai_compatible", modelConnectorId: null, sandboxProfileId: null, policy: "read_only_tools", capabilities: ["text", "read_only_tool"], timeoutMs: 60_000, maxConcurrency: 1, enabled: true, source: "created", recordedAt: "2026-01-01T00:00:00.000Z" }],
  taskAdapterConnectors: [], meetings: [], participants: [], speakerQueue: [], utterances: [], toolRuns: [], chairSuggestions: [], decisions: [], tasks: [],
  agents: [{ id: "agent-1", name: "架構師", description: "負責系統設計", modelConnectorId: "model-1", goalSummary: "做出可執行架構", toolsSummary: "讀取 Issue", dataSummary: "專案資料", skillIds: ["skill-1"], toolGrants: [{ connectorId: "mcp-1", toolName: "read_issue" }], toolPackGrants: [], runtimeProfileBinding: { profileId: "60000000-0000-4000-8000-000000000001", revision: 1 }, status: "online", lifecycleStatus: "published", promptBinding: { promptId: "prompt-1", version: 2 }, publishedRevision: 3, draftRevision: 3 }],
  prompts: [{ id: "prompt-1", name: "架構討論", kind: "agent", description: "", owner: "owner", status: "published", currentVersion: 2, publishedVersion: 2, createdAt: "2026-01-01", updatedAt: "2026-01-01" }]
});

describe("management UI helpers", () => {
  it("hides Prompt commands that the lifecycle will always reject", () => {
    const published = baseSnapshot().prompts![0]!;
    expect(promptLifecycleActions(published)).toEqual({
      canEdit: true,
      canPublish: false,
      canRollback: true,
      canArchive: true
    });
    expect(promptLifecycleActions({ ...published, status: "archived" })).toEqual({
      canEdit: false,
      canPublish: false,
      canRollback: false,
      canArchive: false
    });
  });

  it("exposes stable grouped settings navigation", () => {
    expect(getSettingsNavigation()).toEqual([
      { id: "roles", label: "角色", groupId: "governance", groupLabel: "治理資源" },
      { id: "skills", label: "Skills", groupId: "governance", groupLabel: "治理資源" },
      { id: "prompts", label: "Prompts", groupId: "governance", groupLabel: "治理資源" },
      { id: "models", label: "模型", groupId: "connections", groupLabel: "連線與工具" },
      { id: "credentials", label: "API 金鑰", groupId: "connections", groupLabel: "連線與工具" },
      { id: "mcp", label: "MCP 工具", groupId: "connections", groupLabel: "連線與工具" },
      { id: "task_adapters", label: "任務介接", groupId: "operations", groupLabel: "執行與整合" },
      { id: "harness", label: "Harness", groupId: "operations", groupLabel: "執行與整合" }
    ]);
  });

  it("filters an Agent roster using only canonical published readiness", () => {
    const snapshot = baseSnapshot();
    const firstAgent = snapshot.agents[0]!;
    snapshot.agents.push({ ...firstAgent, id: "agent-2", name: "安全審查", lifecycleStatus: "draft", publishedRevision: null, draftRevision: 1 });
    const readinessByAgentId: Record<string, AgentReadiness> = {
      "agent-1": { status: "warning", checks: [] },
      "agent-2": { status: "blocked", checks: [] }
    };

    expect(filterAgentRoster(snapshot, readinessByAgentId, "架構師", "all").map((item) => item.agent.id))
      .toEqual(["agent-1"]);
    expect(filterAgentRoster(snapshot, readinessByAgentId, "安全審查", "blocked").map((item) => item.agent.id))
      .toEqual(["agent-2"]);
    expect(filterAgentRoster(snapshot, readinessByAgentId, "架構師", "warning")[0]?.readiness?.status)
      .toBe("warning");
    expect(filterAgentRoster(snapshot, readinessByAgentId, "架構師", "ready")).toEqual([]);

    expect(filterAgentRoster(snapshot, {}, "架構師", "all")[0]?.readiness).toBeNull();
    expect(filterAgentRoster(snapshot, {}, "架構師", "warning")).toEqual([]);
  });

  it("presents warning readiness as runnable without a disabled tone", () => {
    expect(readinessStatusUi("warning")).toEqual({
      label: "Warning",
      className: "",
      runnable: true
    });
    expect(readinessStatusUi("ready").runnable).toBe(true);
    expect(readinessStatusUi("blocked")).toEqual({
      label: "Blocked",
      className: "disabled",
      runnable: false
    });
  });

  it("clears only the archived selection and preserves a newer selection", () => {
    expect(selectionAfterArchive("team-1", "team-1")).toBeNull();
    expect(selectionAfterArchive("team-2", "team-1")).toBe("team-2");
    expect(selectionAfterArchive(null, "team-1")).toBeNull();
  });

  it("admits warning Team members and fails closed for blocked or missing readiness", () => {
    const readinessByAgentId: Record<string, AgentReadiness> = {
      ready: { status: "ready", checks: [] },
      warning: { status: "warning", checks: [] },
      blocked: { status: "blocked", checks: [] }
    };

    expect(firstUnavailableTeamMemberId(["ready", "warning"], readinessByAgentId)).toBeNull();
    expect(firstUnavailableTeamMemberId(["warning", "blocked"], readinessByAgentId)).toBe("blocked");
    expect(firstUnavailableTeamMemberId(["warning", "missing"], readinessByAgentId)).toBe("missing");
  });

  it("applies active teams and presets without mutating inputs", () => {
    const snapshot = baseSnapshot() as PlatformSnapshot & Record<string, unknown>;
    snapshot.agentTeams = [{ id: "team-1", revision: 1, name: "架構組", description: "", status: "active", members: [{ agentId: "agent-1", roleId: "role-1", isChair: true }], createdAt: "2026-01-01", updatedAt: "2026-01-01" }];
    snapshot.meetingPresets = [{ id: "preset-1", revision: 1, name: "快速評審", description: "", status: "active", teamId: "team-1", mode: "chaired", automation: "suggest", durationMinutes: 30, agendaItems: [{ title: "範圍", description: "確認範圍" }], createdAt: "2026-01-01", updatedAt: "2026-01-01" }];
    const before = structuredClone(snapshot);
    expect(applyAgentTeam(snapshot, "team-1")).toEqual({ participantIds: ["agent-1"], roleIdByAgent: { "agent-1": "role-1" }, chairAgentId: "agent-1" });
    const preset = applyMeetingPreset(snapshot, "preset-1");
    expect(preset).toEqual({ teamId: "team-1", mode: "chaired", automation: "suggest", durationMinutes: 30, agendaItems: [{ title: "範圍", description: "確認範圍" }] });
    preset.agendaItems[0]!.title = "changed";
    expect(snapshot).toEqual(before);
  });

  it("rejects missing and archived references with concise errors", () => {
    const snapshot = baseSnapshot() as PlatformSnapshot & Record<string, unknown>;
    snapshot.agentTeams = [{ id: "team-1", revision: 1, name: "舊組", description: "", status: "archived", members: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" }];
    snapshot.meetingPresets = [{ id: "preset-1", revision: 1, name: "舊範本", description: "", status: "archived", teamId: null, mode: "open", automation: "manual", durationMinutes: 15, agendaItems: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" }];
    expect(() => applyAgentTeam(snapshot, "missing")).toThrow("找不到 Agent Team");
    expect(() => applyAgentTeam(snapshot, "team-1")).toThrow("Agent Team 已封存");
    expect(() => applyMeetingPreset(snapshot, "missing")).toThrow("找不到會議範本");
    expect(() => applyMeetingPreset(snapshot, "preset-1")).toThrow("會議範本已封存");
  });
});
