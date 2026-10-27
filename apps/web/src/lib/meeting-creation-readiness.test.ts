import { describe, expect, it, vi } from "vitest";
import type { AgentReadiness, MeetingPresetPreflightResponse, PlatformSnapshot } from "@council/contracts";
import {
  loadPublishedAgentReadiness,
  meetingAgentAvailability,
  meetingParticipantPreflight,
  meetingPresetBlockingReason
} from "./view-model.js";

const ready = (status: AgentReadiness["status"], message: string): AgentReadiness => ({
  status,
  checks: [{
    code: status === "blocked" ? "prompt" : "lifecycle",
    status: status === "blocked" ? "blocked" : status === "warning" ? "warning" : "passed",
    message
  }]
});

function meetingSnapshot(): PlatformSnapshot {
  return {
    agents: [
      { id: "ready", name: "Ready Agent", modelConnectorId: "model" },
      { id: "warning", name: "Warning Agent", modelConnectorId: "model" },
      { id: "blocked", name: "Blocked Agent", modelConnectorId: "model" }
    ],
    modelConnectors: [{ id: "model", enabled: true }]
  } as PlatformSnapshot;
}

describe("meeting creation published readiness", () => {
  it("uses source-provided published readiness instead of enabled model presence", async () => {
    const published = {
      ready: ready("ready", "已發布版本可用。"),
      warning: ready("warning", "已發布版本有 warning。"),
      blocked: ready("blocked", "已發布 Prompt 版本不可用。")
    };
    const load = vi.fn(async (agentIds: readonly string[]) => agentIds.map((agentId) => ({
      agentId,
      readiness: published[agentId as keyof typeof published]
    })));

    const readinessByAgentId = await loadPublishedAgentReadiness(
      ["ready", "warning", "blocked", "blocked"],
      load
    );
    const availability = meetingAgentAvailability(meetingSnapshot(), readinessByAgentId);

    expect(load.mock.calls.map(([agentIds]) => agentIds)).toEqual([["ready", "warning", "blocked"]]);
    expect(availability.map(({ agent, available, readiness }) => ({
      agentId: agent.id,
      available,
      status: readiness?.status ?? null
    }))).toEqual([
      { agentId: "ready", available: true, status: "ready" },
      { agentId: "warning", available: true, status: "warning" },
      { agentId: "blocked", available: false, status: "blocked" }
    ]);
    expect(availability[2]?.blockingReason).toBe("已發布 Prompt 版本不可用。");
  });

  it("uses bounded batches and fails closed when a response is incomplete", async () => {
    const agentIds = Array.from({ length: 51 }, (_item, index) => `agent-${index}`);
    const load = vi.fn(async (batchAgentIds: readonly string[]) => batchAgentIds.map((agentId) => ({
      agentId,
      readiness: ready("ready", "可用。")
    })));

    const readinessByAgentId = await loadPublishedAgentReadiness(agentIds, load);
    expect(load.mock.calls.map(([batchAgentIds]) => batchAgentIds.length)).toEqual([50, 1]);
    expect(Object.keys(readinessByAgentId)).toHaveLength(51);

    await expect(loadPublishedAgentReadiness(["missing"], async () => [])).rejects.toThrow(
      "Agent readiness batch response was incomplete."
    );
  });

  it("fails closed with a concise published-readiness reason", () => {
    const snapshot = meetingSnapshot();
    const readinessByAgentId = {
      warning: ready("warning", "已發布版本有 warning。"),
      blocked: ready("blocked", "已發布 Prompt 版本不可用。")
    };

    expect(meetingParticipantPreflight(snapshot, ["blocked", "warning"], readinessByAgentId)).toEqual({
      status: "blocked",
      reason: "Blocked Agent：已發布 Prompt 版本不可用。",
      blockedAgentIds: ["blocked"],
      warningAgentIds: ["warning"]
    });
    expect(meetingParticipantPreflight(snapshot, ["warning"], readinessByAgentId)).toEqual({
      status: "warning",
      reason: null,
      blockedAgentIds: [],
      warningAgentIds: ["warning"]
    });
    expect(meetingParticipantPreflight(snapshot, ["ready"], readinessByAgentId).status).toBe("checking");
  });

  it("surfaces the first blocked Agent reason from preset preflight", () => {
    const preflight = {
      presetId: "preset",
      status: "blocked",
      team: null,
      invalidRoleIds: [],
      agents: [{
        agentId: "blocked",
        roleId: "role",
        isChair: true,
        agentRevision: 3,
        readiness: ready("blocked", "Runtime Profile 已停用。")
      }]
    } as MeetingPresetPreflightResponse;

    expect(meetingPresetBlockingReason(preflight, meetingSnapshot().agents)).toBe(
      "Blocked Agent：Runtime Profile 已停用。"
    );
  });

  it("surfaces dangling Role references before generic preset failures", () => {
    const preflight = {
      presetId: "preset",
      status: "blocked",
      team: null,
      invalidRoleIds: ["deleted-role"],
      agents: []
    } as MeetingPresetPreflightResponse;

    expect(meetingPresetBlockingReason(preflight, meetingSnapshot().agents)).toBe(
      "Agent Team 包含已刪除或不存在的角色。"
    );
  });
});
