import { describe, expect, it } from "vitest";
import { adviseExecution } from "./execution-advisor.js";

const baseTask = {
  id: "20000000-0000-4000-8000-000000000002",
  decisionId: "20000000-0000-4000-8000-000000000012",
  title: "Implement the bounded change",
  description: "Edit source files and run focused tests.",
  acceptanceCriteria: "A reviewable patch and test evidence exist.",
  dependencyIds: [],
  assigneeAgentId: "20000000-0000-4000-8000-000000000004",
  executionMode: "worker" as const,
  allowedTools: ["read", "grep", "edit", "bash"],
  dataScope: "approved repository snapshot",
  action: null
};

describe("Council-native ExecutionAdvisor", () => {
  it("recommends OMP coding without granting capabilities outside the approved profile", () => {
    expect(adviseExecution({
      task: baseTask,
      approvedCapabilities: ["text", "file_read", "file_write", "process"],
      approvedTools: ["read", "grep", "edit"]
    })).toEqual({
      route: "omp_coding",
      policy: "isolated_exec",
      capabilities: ["text", "file_read", "file_write", "process"],
      tools: ["read", "grep", "edit"],
      reason: "The approved task requires isolated repository editing."
    });
  });

  it("routes actions and research explicitly and never widens approved authority", () => {
    expect(adviseExecution({
      task: {
        ...baseTask,
        executionMode: "action",
        action: {
          adapterId: "20000000-0000-4000-8000-000000000020",
          actionKey: "deploy-preview",
          targetId: "preview",
          inputs: {},
          riskClass: "ordinary"
        }
      },
      approvedCapabilities: ["text", "external_write"],
      approvedTools: []
    }).route).toBe("approved_action");

    const research = adviseExecution({
      task: { ...baseTask, executionMode: "advisor", allowedTools: ["search", "read_only_mcp"] },
      approvedCapabilities: ["text", "read_only_tool", "file_write"],
      approvedTools: ["read_only_mcp"]
    });
    expect(research).toMatchObject({
      route: "read_only_research",
      policy: "read_only_tools",
      capabilities: ["text", "read_only_tool"],
      tools: ["read_only_mcp"]
    });
    expect(research.capabilities).not.toContain("file_write");
  });

  it("keeps Worker tasks on the native text path unless the approved Profile has the full OMP capability set", () => {
    expect(adviseExecution({
      task: baseTask,
      approvedCapabilities: ["text", "file_read"],
      approvedTools: ["read"]
    })).toMatchObject({
      route: "native_text",
      policy: "text_only",
      capabilities: ["text"],
      tools: []
    });
  });
});
