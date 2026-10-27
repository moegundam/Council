import { describe, expect, it, vi } from "vitest";
import { createCouncilJobEnvelope, type McpToolCallJobData } from "@council/contracts";
import {
  classifyQueuedMcpJob,
  countQueuedMcpJobs,
  queuedMcpJobMatches
} from "./mcp-queue-compatibility.js";

const baseJob = {
  meetingId: "80000000-0000-4000-8000-000000000001",
  agentId: "50000000-0000-4000-8000-000000000001",
  participantId: "90000000-0000-4000-8000-000000000001",
  roleRevision: 1,
  roleId: "60000000-0000-4000-8000-000000000001",
  roleVersion: 1,
  connectorId: "d0000000-0000-4000-8000-000000000001",
  toolName: "search",
  toolSnapshot: {
    connectorName: "Docs",
    toolName: "search",
    displayName: "Search",
    kind: "mcp_tool" as const,
    version: "1.0.0",
    owner: "Platform Owner",
    goal: "Read approved documents."
  },
  connectorFingerprint: "connector-fingerprint",
  requestedBy: "owner" as const
};

describe("MCP BullMQ compatibility inspection", () => {
  it("classifies a pre-envelope raw job from the BullMQ hash name", () => {
    const data: McpToolCallJobData = { ...baseJob, arguments: { query: "policy" } };
    expect(classifyQueuedMcpJob({ name: "mcp-tool-call", data })).toBe("legacy_plaintext");
    expect(queuedMcpJobMatches({ name: "mcp-tool-call", data }, "any")).toBe(true);
  });

  it("classifies current enveloped plaintext and encrypted jobs structurally", () => {
    const plaintext: McpToolCallJobData = { ...baseJob, arguments: {} };
    const encrypted: McpToolCallJobData = { ...baseJob, argumentEncoding: "vault_v1", argumentsCiphertext: "ciphertext" };

    expect(classifyQueuedMcpJob({
      name: "mcp-tool-call",
      data: createCouncilJobEnvelope("mcp-tool-call", plaintext)
    })).toBe("legacy_plaintext");
    expect(classifyQueuedMcpJob({
      name: "mcp-tool-call",
      data: createCouncilJobEnvelope("mcp-tool-call", encrypted)
    })).toBe("vault_v1");
  });

  it("fails closed for a malformed MCP hash and ignores other BullMQ job names", () => {
    expect(() => classifyQueuedMcpJob({ name: "mcp-tool-call", data: { arguments: {} } })).toThrow();
    expect(classifyQueuedMcpJob({ name: "agent-turn", data: { name: "mcp-tool-call" } })).toBeNull();
  });

  it("pages each BullMQ state independently without skipping a later MCP job", async () => {
    const mcpJob = {
      name: "mcp-tool-call",
      data: { ...baseJob, arguments: { query: "late page" } } satisfies McpToolCallJobData
    };
    const otherJob = { name: "agent-turn", data: {} };
    const getJobs = vi.fn(async (types: string[], start: number) => {
      expect(types).toHaveLength(1);
      if (types[0] === "active" && start === 0) return Array.from({ length: 100 }, () => otherJob);
      if (types[0] === "active" && start === 100) return [mcpJob];
      if (types[0] === "waiting" && start === 0) return Array.from({ length: 20 }, () => otherJob);
      return [];
    });

    await expect(countQueuedMcpJobs({ getJobs }, "legacy_plaintext")).resolves.toBe(1);
    expect(getJobs).toHaveBeenCalledWith(["active"], 100, 199, true);
  });
});
