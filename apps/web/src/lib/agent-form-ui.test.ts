import { describe, expect, it } from "vitest";
import type { McpConnector, PromptTemplate } from "@council/contracts";
import {
  agentEditableDraft,
  agentPromptBindingOptions,
  agentStatusTransition,
  approvedAgentToolOptions,
  canEditAgentManagementItem,
  mergeAgentDraftAfterConflict,
  parseAgentPromptBindingKey,
  serializeAgentPromptBinding
} from "./agent-form-ui.js";

const prompts: PromptTemplate[] = [
  {
    id: "prompt-a",
    name: "架構討論",
    kind: "agent",
    description: "",
    owner: "owner",
    status: "published",
    currentVersion: 4,
    publishedVersion: 4,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01"
  },
  {
    id: "prompt-b",
    name: "安全審查",
    kind: "agent",
    description: "",
    owner: "owner",
    status: "published",
    currentVersion: 3,
    publishedVersion: 3,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01"
  },
  {
    id: "prompt-c",
    name: "舊版主持",
    kind: "agent",
    description: "",
    owner: "owner",
    status: "archived",
    currentVersion: 5,
    publishedVersion: 5,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01"
  },
  {
    id: "prompt-d",
    name: "執行摘要",
    kind: "agent",
    description: "",
    owner: "owner",
    status: "draft",
    currentVersion: 4,
    publishedVersion: 2,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01"
  },
  {
    id: "prompt-e",
    name: "會議摘要",
    kind: "meeting",
    description: "",
    owner: "owner",
    status: "published",
    currentVersion: 2,
    publishedVersion: 2,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01"
  }
];

describe("Agent form UI helpers", () => {
  it("round-trips the exact Prompt binding and reserves an empty key for explicit unbind", () => {
    const binding = { promptId: "prompt-a", version: 2 };

    expect(parseAgentPromptBindingKey(serializeAgentPromptBinding(binding))).toEqual(binding);
    expect(parseAgentPromptBindingKey("")).toBeNull();
    expect(parseAgentPromptBindingKey("not-a-binding")).toBeUndefined();
  });

  it("keeps a historical binding while offering current published versions", () => {
    const options = agentPromptBindingOptions(prompts, { promptId: "prompt-a", version: 2 });

    expect(options.map((option) => option.key)).toEqual([
      "prompt-a:4",
      "prompt-b:3",
      "prompt-d:2",
      "prompt-a:2"
    ]);
    expect(options.at(-1)?.label).toContain("目前綁定");
    expect(options.at(-1)?.label).toContain("歷史版本");
  });

  it("keeps only the exact archived binding as a legacy choice", () => {
    const options = agentPromptBindingOptions(prompts, { promptId: "prompt-c", version: 4 });

    expect(options.map((option) => option.key)).toEqual([
      "prompt-a:4",
      "prompt-b:3",
      "prompt-d:2",
      "prompt-c:4"
    ]);
    expect(options.at(-1)?.label).toContain("已封存");
  });

  it("offers only Agent-kind Prompts while retaining an exact incompatible legacy binding", () => {
    expect(agentPromptBindingOptions(prompts, null).map((option) => option.key)).not.toContain("prompt-e:2");

    const options = agentPromptBindingOptions(prompts, { promptId: "prompt-e", version: 2 });
    expect(options.at(-1)).toMatchObject({ key: "prompt-e:2" });
    expect(options.at(-1)?.label).toContain("類型不符");
  });

  it("allows edit forms only for active Agent management items", () => {
    expect(canEditAgentManagementItem("active")).toBe(true);
    expect(canEditAgentManagementItem("archived")).toBe(false);
  });

  it("prevents draft-only Agent disablement and recovers legacy disabled drafts", () => {
    expect(agentStatusTransition({ lifecycleStatus: "draft", publishedRevision: null })).toBeNull();
    expect(agentStatusTransition({ lifecycleStatus: "draft", publishedRevision: 1 })).toBe("disabled");
    expect(agentStatusTransition({ lifecycleStatus: "published", publishedRevision: 1 })).toBe("disabled");
    expect(agentStatusTransition({ lifecycleStatus: "disabled", publishedRevision: 1 })).toBe("published");
    expect(agentStatusTransition({ lifecycleStatus: "disabled", publishedRevision: null })).toBe("draft");
  });

  it("offers only approved tools from enabled MCP Connectors", () => {
    const connectors: McpConnector[] = [
      {
        id: "enabled",
        revision: 1,
        name: "Enabled MCP",
        location: "local",
        baseUrl: "http://enabled",
        approvedTools: ["read_issue"],
        enabled: true,
        hasSecret: false,
        toolRegistrations: [
          { toolName: "read_issue", displayName: "Read issue", kind: "mcp_tool", version: "1", owner: "owner", goal: "Read" },
          { toolName: "write_issue", displayName: "Write issue", kind: "mcp_tool", version: "1", owner: "owner", goal: "Write" }
        ]
      },
      {
        id: "disabled",
        revision: 1,
        name: "Disabled MCP",
        location: "local",
        baseUrl: "http://disabled",
        approvedTools: ["read_secret"],
        enabled: false,
        hasSecret: false,
        toolRegistrations: [
          { toolName: "read_secret", displayName: "Read secret", kind: "mcp_tool", version: "1", owner: "owner", goal: "Read" }
        ]
      }
    ];

    expect(approvedAgentToolOptions(connectors).map((option) => ({
      connectorId: option.connector.id,
      toolName: option.registration.toolName
    }))).toEqual([{ connectorId: "enabled", toolName: "read_issue" }]);
  });

  it("three-way merges Agent edits without overwriting untouched remote fields", () => {
    const base = agentEditableDraft({
      id: "agent-1",
      name: "Reviewer",
      description: "Review architecture",
      modelConnectorId: "model-a",
      goalSummary: "Find risks",
      toolsSummary: "Read only",
      dataSummary: "Meeting data",
      skillIds: ["skill-a"],
      toolGrants: [],
      toolPackGrants: [],
      runtimeProfileBinding: null,
      promptBinding: { promptId: "prompt-a", version: 4 },
      status: "online"
    });
    const local = { ...base, goalSummary: "Find security risks", skillIds: ["skill-a", "skill-b"] };
    const latest = {
      ...base,
      name: "Security reviewer",
      goalSummary: "Find operational risks",
      toolGrants: [{ connectorId: "mcp-a", toolName: "read" }]
    };

    expect(mergeAgentDraftAfterConflict(base, local, latest)).toEqual({
      draft: {
        ...latest,
        goalSummary: "Find operational risks",
        skillIds: ["skill-a", "skill-b"]
      },
      conflictingFields: ["goalSummary"]
    });
  });
});
