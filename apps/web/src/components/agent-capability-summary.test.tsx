import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AgentCapabilitySummary,
  agentConfigurationSourceLabel,
  type AgentCapabilitySummaryConfiguration
} from "./agent-capability-summary";

function configuration(
  overrides: Partial<AgentCapabilitySummaryConfiguration> = {}
): AgentCapabilitySummaryConfiguration {
  return {
    source: { kind: "published", revision: 4 },
    agent: {
      goalSummary: "Produce an evidence-backed recommendation.",
      toolsSummary: "Read approved evidence sources.",
      dataSummary: "Meeting evidence and declared Agent scope."
    },
    bindingCounts: {
      skills: { configured: 2, ready: 1 },
      tools: { configured: 2, ready: 1 },
      toolPacks: { configured: 1, ready: 1 }
    },
    model: {
      name: "Council Local",
      model: "council-32b",
      location: "local",
      enabled: true
    },
    credential: {
      name: "Council Runtime",
      location: "local",
      status: "active"
    },
    prompt: {
      name: "Evidence Agent Prompt",
      version: 3
    },
    skills: [{ id: "skill-ready", name: "Evidence Search", version: "1.2.0" }],
    tools: [{
      connectorId: "connector-ready",
      connectorName: "Knowledge MCP",
      toolName: "search",
      displayName: "Search knowledge",
      version: "2.0.0"
    }],
    toolPacks: [{
      packId: "pack-ready",
      packName: "Document Tools",
      version: "1.0.0",
      revision: 2,
      toolName: "extract",
      toolGoal: "Extract evidence from documents."
    }],
    teams: [{
      id: "team-1",
      name: "Research Team",
      isChair: false,
      role: {
        id: "role-1",
        name: "Evidence Analyst",
        version: 2,
        toolPolicy: "agent_read_only_grants",
        dataPolicy: "agent_declared_scope"
      }
    }],
    runtimeProfile: {
      binding: { profileId: "runtime-1", revision: 7 },
      revision: {
        name: "Read-only Runtime",
        revision: 7,
        harnessKind: "openai_compatible",
        policy: "read_only_tools",
        enabled: true
      }
    },
    readiness: { status: "ready", checks: [] },
    ...overrides
  };
}

function render(
  value: AgentCapabilitySummaryConfiguration | null,
  state: "loading" | "ready" | "unavailable" = "ready",
  onRetry?: () => void
): string {
  return renderToStaticMarkup(createElement(AgentCapabilitySummary, {
    configuration: value,
    state,
    ...(onRetry ? { onRetry } : {}),
    relationshipContent: createElement("p", null, "保留的任務與會議關係")
  }));
}

describe("AgentCapabilitySummary", () => {
  it("renders exactly three expandable rows with published goal, prompt, roles, and parent relationships", () => {
    const markup = render(configuration());

    expect(markup.match(/<details/g)).toHaveLength(3);
    expect(markup).toContain("目標");
    expect(markup).toContain("工具");
    expect(markup).toContain("資料");
    expect(markup).toContain("已發布 Rev 4");
    expect(markup).toContain("Evidence Agent Prompt · v3");
    expect(markup).toContain("Research Team");
    expect(markup).toContain("Evidence Analyst v2");
    expect(markup).toContain("保留的任務與會議關係");
  });

  it("labels published, draft, and missing-published sources without conflating them", () => {
    expect(agentConfigurationSourceLabel({ kind: "published", revision: 4 })).toBe("已發布 Rev 4");
    expect(agentConfigurationSourceLabel({ kind: "draft", revision: 5 })).toBe("草稿 Rev 5");
    expect(agentConfigurationSourceLabel({ kind: "published_missing", revision: 2 }))
      .toBe("已發布 Rev 2 無法取得");

    expect(render(configuration({ source: { kind: "draft", revision: 5 } }))).toContain("草稿 Rev 5");
    expect(render(configuration({ source: { kind: "published_missing", revision: 2 } })))
      .toContain("已發布 Rev 2 無法取得");
    expect(render(configuration({ source: { kind: "published_missing", revision: 2 } })))
      .toContain("已發布 Agent 組態遺失；以下摘要不是可執行組態。");
  });

  it("shows ready/configured counts, ready-only lists, and explicit blocked totals", () => {
    const markup = render(configuration());

    expect(markup).toContain("Skills 1/2");
    expect(markup).toContain("MCP 1/2");
    expect(markup).toContain("Tool Packs 1/1");
    expect(markup).toContain("已設定但受阻：Skills 1、MCP 1、Tool Packs 0");
    expect(markup).toContain("Evidence Search v1.2.0");
    expect(markup).toContain("Knowledge MCP / Search knowledge");
    expect(markup).toContain("Document Tools / extract");
    expect(markup).not.toContain("Configured but blocked capability name");
  });

  it("renders explicit empty states when no capability is configured or ready", () => {
    const markup = render(configuration({
      bindingCounts: {
        skills: { configured: 0, ready: 0 },
        tools: { configured: 0, ready: 0 },
        toolPacks: { configured: 0, ready: 0 }
      },
      skills: [],
      tools: [],
      toolPacks: []
    }));

    expect(markup).toContain("Skills 0/0");
    expect(markup).toContain("尚無已就緒 Skill");
    expect(markup).toContain("尚無已就緒 MCP 工具");
    expect(markup).toContain("尚無已就緒 Tool Pack");
    expect(markup).toContain("目前沒有受阻的已設定能力");
  });

  it("renders role tool and data policies in their relevant rows", () => {
    const markup = render(configuration({
      teams: [{
        id: "team-2",
        name: "Meeting Team",
        isChair: true,
        role: {
          id: "role-2",
          name: "Meeting Chair",
          version: 6,
          toolPolicy: "none",
          dataPolicy: "meeting_only"
        }
      }]
    }));

    expect(markup).toContain("Meeting Chair v6 · 主席");
    expect(markup).toContain("不使用外部工具");
    expect(markup).toContain("僅限會議資料");
  });

  it("renders only compact model and credential fields, never secrets or endpoint URLs", () => {
    const unsafe = configuration({
      model: {
        name: "Cloud Model",
        model: "reasoner-1",
        location: "cloud",
        enabled: true,
        baseUrl: "https://owner:secret@example.invalid/v1",
        secret: "model-secret-value"
      } as AgentCapabilitySummaryConfiguration["model"],
      credential: {
        name: "Production Credential",
        location: "cloud",
        status: "active",
        maskedHint: "****1234",
        secret: "credential-secret-value"
      } as AgentCapabilitySummaryConfiguration["credential"]
    });
    const markup = render(unsafe);

    expect(markup).toContain("Cloud Model · reasoner-1 · 雲端 · 啟用");
    expect(markup).toContain("Production Credential · 雲端 · 啟用");
    expect(markup).not.toContain("example.invalid");
    expect(markup).not.toContain("model-secret-value");
    expect(markup).not.toContain("credential-secret-value");
    expect(markup).not.toContain("****1234");
  });

  it("uses explicit loading and unavailable states without readiness labels", () => {
    const loading = render(null, "loading");
    const unavailable = render(null, "unavailable", () => undefined);

    expect(loading).toContain("正在載入 Agent 能力摘要");
    expect(unavailable).toContain("Agent 能力摘要目前無法取得");
    expect(unavailable).toContain("重新載入");
    expect(`${loading}${unavailable}`).not.toContain("Warning");
    expect(`${loading}${unavailable}`).not.toContain("Ready");
    expect(`${loading}${unavailable}`).not.toContain("Blocked");
  });
});
