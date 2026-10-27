import { describe, expect, it } from "vitest";
import { agentSetupRows, effectiveModelConnectionIdentity, selectedSkillInstructionBudget } from "./agent-setup-ui";

describe("agent setup UI", () => {
  it("keeps the compact readiness categories actionable without claiming tool execution", () => {
    expect(agentSetupRows({ status: "ready", checks: [
      { code: "lifecycle", status: "passed", message: "Agent 已可供檢查。" },
      { code: "runtime", status: "passed", message: "Runtime Profile Rev 1 可用。" },
      { code: "model", status: "passed", message: "模型 Connector 已啟用。" },
      { code: "credential", status: "passed", message: "地端 Connector 不需要雲端憑證。" },
      { code: "prompt", status: "warning", message: "沿用舊版 Agent Prompt。" },
      { code: "skill", status: "passed", message: "未綁定 Skill。" },
      { code: "tool", status: "passed", message: "未綁定外部工具。" }
    ] }).map((row) => [row.id, row.status, row.detail, row.action])).toEqual([
      ["lifecycle", "ready", "Agent 已可供檢查。", "edit"],
      ["runtime", "ready", "Runtime Profile Rev 1 可用。", "edit"],
      ["model", "ready", "模型 Connector 已啟用。", "test_connection"],
      ["credential", "ready", "地端 Connector 不需要雲端憑證。", "manage_credentials"],
      ["prompt", "attention", "沿用舊版 Agent Prompt。", "manage_prompts"],
      ["skill", "ready", "未綁定 Skill。", "manage_skills"],
      ["tool", "ready", "未綁定外部工具。", "manage_mcp"]
    ]);
  });

  it("does not mark revoked or invalid bindings ready when readiness blocks them", () => {
    const rows = agentSetupRows({ status: "blocked", checks: [
      { code: "model", status: "blocked", message: "模型 Connector 不存在或已停用。" },
      { code: "skill", status: "blocked", message: "所有 Skill 必須已核准。" }
    ] });

    expect(rows.find((row) => row.id === "model")).toMatchObject({ status: "blocked", action: "manage_models" });
    expect(rows.find((row) => row.id === "skill")).toMatchObject({ status: "blocked", action: "manage_skills" });
  });

  it("keeps setup rows loading until the authoritative readiness response arrives", () => {
    expect(agentSetupRows("loading").every((row) => row.status === "unavailable" && row.detail === "正在載入 Readiness")).toBe(true);
  });

  it("identifies a connection test by the displayed effective revision and connector", () => {
    expect(effectiveModelConnectionIdentity({ agentId: "agent-1", source: { kind: "published", revision: 4 }, connectorId: "model-1" }))
      .toBe(JSON.stringify(["agent-1", "published", 4, "model-1", null, null, null]));
    expect(effectiveModelConnectionIdentity({ agentId: "agent-1", source: { kind: "published", revision: 4 }, connectorId: null }))
      .toBeNull();
  });

  it("retains a result across identical refreshes but invalidates changed connector or credential revisions", () => {
    const target = { agentId: "agent-1", source: { kind: "published" as const, revision: 4 }, connectorId: "model-1", connectorRevision: 2, credentialRevision: 3 };
    const identity = effectiveModelConnectionIdentity(target);
    expect(effectiveModelConnectionIdentity(structuredClone(target))).toBe(identity);
    expect(effectiveModelConnectionIdentity({ ...target, connectorRevision: 3 })).not.toBe(identity);
    expect(effectiveModelConnectionIdentity({ ...target, credentialRevision: 4 })).not.toBe(identity);
  });

  it("counts all selected skill instructions in snapshot order and visibly retains over-budget selections", () => {
    const budget = selectedSkillInstructionBudget(["skill-b", "skill-a", "missing"], [
      { id: "skill-a", instructions: "1234" },
      { id: "skill-b", instructions: "123" }
    ]);

    expect(budget).toEqual({ instructionCharacters: 7, limit: 20000, withinLimit: true });
  });
});
