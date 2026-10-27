import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentReadiness } from "@council/contracts";
import { RuntimeProfileRegistry } from "./runtime-profile-registry";

describe("RuntimeProfileRegistry", () => {
  it("renders the compact registry inside the Agent surface without extra primary nav", () => {
    const markup = renderToStaticMarkup(createElement(RuntimeProfileRegistry, {
      profiles: [{
        id: "70000000-0000-4000-8000-000000000001",
        name: "標準文字執行",
        harnessKind: "openai_compatible",
        modelConnectorId: null,
        sandboxProfileId: null,
        policy: "read_only_tools",
        capabilities: ["text", "read_only_tool"],
        timeoutMs: 60_000,
        maxConcurrency: 1,
        enabled: true,
        revision: 3,
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z"
      }],
      revisions: [{
        profileId: "70000000-0000-4000-8000-000000000001",
        revision: 3,
        name: "標準文字執行",
        harnessKind: "openai_compatible",
        modelConnectorId: null,
        sandboxProfileId: null,
        policy: "read_only_tools",
        capabilities: ["text", "read_only_tool"],
        timeoutMs: 60_000,
        maxConcurrency: 1,
        enabled: true,
        source: "updated",
        recordedAt: "2026-08-03T00:00:00.000Z"
      }],
      agents: [{
        id: "agent-1",
        runtimeProfileBinding: { profileId: "70000000-0000-4000-8000-000000000001", revision: 3 }
      }],
      selectedProfileId: "70000000-0000-4000-8000-000000000001",
      readAgentReadiness: (): AgentReadiness => ({ status: "ready", checks: [] }),
      pending: false,
      onSelect() {},
      onCreate() {},
      onEdit() {},
      onHistory() {}
    }));

    expect(markup).toContain("執行設定");
    expect(markup).toContain("1 個 Profile");
    expect(markup).toContain("OpenAI-compatible");
    expect(markup).toContain("read_only_tools");
    expect(markup).toContain("1 個 Agent");
    expect(markup).not.toContain("Settings 的 Harness Adapter");
    expect(markup).not.toContain("70000000-0000-4000-8000-000000000001</dd>");
    expect(markup).not.toContain("討論</span>");
    expect(markup).not.toContain("任務</span>");
  });
});
