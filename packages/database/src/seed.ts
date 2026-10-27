import {
  builtInRoleTemplates,
  createRoleExecutionSnapshot,
  type ParticipantAssignment,
  type PlatformSnapshot,
  type Role
} from "@council/contracts";
import {
  createDefaultRuntimeProfile,
  createDefaultRuntimeProfileRevision,
  defaultRuntimeProfileBinding
} from "./runtime-profiles.js";
import { skillContentDigest } from "./skill-governance.js";

const now = "2026-07-15T02:00:00.000Z";

export function createSeedSnapshot(): PlatformSnapshot {
  const defaultRuntimeProfile = createDefaultRuntimeProfile(now);
  const meetingSkill = {
    id: "70000000-0000-4000-8000-000000000001",
    name: "Meeting Facilitation",
    version: "1.0.0",
    instructions: "聚焦議程，區分推論、證據與決議。",
    source: "Council Skill Registry",
    owner: "Platform Owner"
  };
  const meetingSkillDigest = skillContentDigest(meetingSkill);
  const seededRole = (id: string, templateIndex: number): Role => {
    const template = builtInRoleTemplates[templateIndex]!;
    const { key, orchestrationFunctions, ...behavior } = template;
    return {
      id,
      ...behavior,
      orchestrationFunctions: [...orchestrationFunctions],
      version: 1,
      templateKey: key,
      deletedAt: null
    };
  };
  const roles = [
    seededRole("60000000-0000-4000-8000-000000000001", 0),
    seededRole("60000000-0000-4000-8000-000000000002", 1),
    seededRole("60000000-0000-4000-8000-000000000003", 2)
  ];
  const participant = (
    id: string,
    agentId: string,
    role: Role,
    isChair: boolean
  ): ParticipantAssignment => {
    const roleSnapshot = createRoleExecutionSnapshot(role);
    return {
      id,
      meetingId: "80000000-0000-4000-8000-000000000001",
      agentId,
      roleId: role.id,
      isChair,
      agentRevision: 1,
      roleSnapshot,
      roleRevision: 1,
      roleHistory: [{
        revision: 1,
        roleId: role.id,
        roleSnapshot: structuredClone(roleSnapshot),
        changedAt: now,
        changedBy: "owner",
        reason: "Role assigned when the Meeting was created."
      }]
    };
  };
  return {
    groups: [{ id: "10000000-0000-4000-8000-000000000001", revision: 1, name: "產品研發" }],
    categories: [{
      id: "20000000-0000-4000-8000-000000000001",
      revision: 1,
      groupId: "10000000-0000-4000-8000-000000000001",
      name: "平台架構"
    }],
    tags: [
      { id: "30000000-0000-4000-8000-000000000001", revision: 1, name: "高優先", color: "red" },
      { id: "30000000-0000-4000-8000-000000000002", revision: 1, name: "地端 AI", color: "blue" },
      { id: "30000000-0000-4000-8000-000000000003", revision: 1, name: "需人工確認", color: "amber" }
    ],
    threads: [{
      id: "40000000-0000-4000-8000-000000000001",
      revision: 1,
      categoryId: "20000000-0000-4000-8000-000000000001",
      title: "多 Agent 平台架構評審",
      summary: "確認 Meeting Core、模型與工具權限邊界。",
      status: "open",
      tagIds: ["30000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000002"],
      createdAt: now
    }],
    agents: [
      {
        id: "50000000-0000-4000-8000-000000000001",
        name: "Architect-R",
        description: "平台架構 Agent",
        modelConnectorId: null,
        goalSummary: "確認多 Agent 平台第一版架構",
        toolsSummary: "Docs MCP、Task Adapter（唯讀）",
        dataSummary: "產品文件唯讀、Agent 工作資料可寫",
        skillIds: ["70000000-0000-4000-8000-000000000001"],
        toolGrants: [],
        toolPackGrants: [],
        runtimeProfileBinding: { ...defaultRuntimeProfileBinding },
        status: "attention"
      },
      {
        id: "50000000-0000-4000-8000-000000000002",
        name: "Chair-Local",
        description: "會議主席 Agent",
        modelConnectorId: null,
        goalSummary: "維持議程、時間與決議收斂",
        toolsSummary: "會議狀態與摘要工具",
        dataSummary: "本次 Meeting Shared data",
        skillIds: ["70000000-0000-4000-8000-000000000001"],
        toolGrants: [],
        toolPackGrants: [],
        runtimeProfileBinding: { ...defaultRuntimeProfileBinding },
        status: "attention"
      },
      {
        id: "50000000-0000-4000-8000-000000000003",
        name: "Sentinel-G",
        description: "安全審查 Agent",
        modelConnectorId: null,
        goalSummary: "檢查工具權限與資料外洩風險",
        toolsSummary: "Security Docs MCP（唯讀）",
        dataSummary: "政策與稽核證據唯讀",
        skillIds: [],
        toolGrants: [],
        toolPackGrants: [],
        runtimeProfileBinding: { ...defaultRuntimeProfileBinding },
        status: "attention"
      }
    ],
    runtimeProfiles: [defaultRuntimeProfile],
    runtimeProfileRevisions: [createDefaultRuntimeProfileRevision(now)],
    toolPacks: [],
    toolPackRevisions: [],
    roles,
    skills: [{
      ...meetingSkill,
      contentDigest: meetingSkillDigest,
      validation: { result: "passed", summary: "已人工檢視並核准用於 Council 會議。", checkedAt: now, contentDigest: meetingSkillDigest },
      status: "approved",
      approvedAt: now,
      revokedAt: null,
      revocationReason: null
    }],
    modelConnectors: [],
    mcpConnectors: [],
    taskAdapterConnectors: [],
    credentials: [],
    prompts: [],
    agentTeams: [],
    meetingPresets: [],
    meetings: [{
      id: "80000000-0000-4000-8000-000000000001",
      threadId: "40000000-0000-4000-8000-000000000001",
      title: "多 Agent 平台架構評審",
      goal: "確認會議核心與 Agent Runtime 的邊界",
      state: "active",
      mode: "chaired",
      automation: "suggest",
      automationRevision: 0,
      durationMinutes: 30,
      startedAt: now,
      closedAt: null,
      agenda: {
        revision: 1,
        items: [
          {
            id: "81000000-0000-4000-8000-000000000001",
            title: "確認目標與範圍",
            description: "確認本次會議的目標、邊界與預期輸出。",
            position: 0,
            status: "current",
            createdAt: now,
            updatedAt: now,
            startedAt: now,
            resolvedAt: null
          },
          {
            id: "81000000-0000-4000-8000-000000000002",
            title: "檢視方案與風險",
            description: "比較候選方案並整理主要風險。",
            position: 1,
            status: "pending",
            createdAt: now,
            updatedAt: now,
            startedAt: null,
            resolvedAt: null
          },
          {
            id: "81000000-0000-4000-8000-000000000003",
            title: "收斂決議與下一步",
            description: "形成候選決議並確認後續任務。",
            position: 2,
            status: "pending",
            createdAt: now,
            updatedAt: now,
            startedAt: null,
            resolvedAt: null
          }
        ]
      },
      summaryState: "not_requested",
      summaryJobId: null,
      createdAt: now
    }],
    participants: [
      participant("90000000-0000-4000-8000-000000000001", "50000000-0000-4000-8000-000000000002", roles[1]!, true),
      participant("90000000-0000-4000-8000-000000000002", "50000000-0000-4000-8000-000000000001", roles[0]!, false),
      participant("90000000-0000-4000-8000-000000000003", "50000000-0000-4000-8000-000000000003", roles[2]!, false)
    ],
    speakerQueue: [],
    utterances: [
      { id: "a0000000-0000-4000-8000-000000000001", meetingId: "80000000-0000-4000-8000-000000000001", speakerType: "system", speakerName: "Council", roleName: null, content: "會議已開始，主席模式為建議。", kind: "system", evidenceCount: 0, createdAt: now },
      { id: "a0000000-0000-4000-8000-000000000002", meetingId: "80000000-0000-4000-8000-000000000001", speakerType: "agent", speakerName: "Architect-R", roleName: "平台架構師", content: "建議把 Meeting Core 與 Agent 執行器分離，先維持統一 ModelConnector。", kind: "inference", evidenceCount: 0, createdAt: now },
      { id: "a0000000-0000-4000-8000-000000000003", meetingId: "80000000-0000-4000-8000-000000000001", speakerType: "agent", speakerName: "Sentinel-G", roleName: "安全審查", content: "Phase 1 的 MCP 必須是伺服器端白名單，而且只允許唯讀操作。", kind: "verified", evidenceCount: 1, createdAt: now }
    ],
    toolRuns: [],
    chairSuggestions: [],
    decisions: [{
      id: "b0000000-0000-4000-8000-000000000001",
      meetingId: "80000000-0000-4000-8000-000000000001",
      title: "會議核心與 Runtime 分離",
      description: "平台掌握角色、政策與決議；模型與執行器透過 Adapter 接入。",
      status: "proposed",
      createdAt: now
    }],
    tasks: []
  };
}
