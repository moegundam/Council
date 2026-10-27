import { describe, expect, it } from "vitest";
import type { AgentReadiness, PlatformSnapshot } from "@council/contracts";
import {
  formatRuntimeBindingOption,
  initialRuntimeBindingKey,
  normalizeRuntimeCapabilities,
  runtimeBindingOptions,
  runtimeBlockedMessages,
  runtimeProfileUsageSummary
} from "./runtime-profile-ui.js";

describe("runtime profile ui helpers", () => {
  it("preserves an unbound Runtime Profile when editing an existing Agent", () => {
    const defaultBindingKey = "profile-1:3";

    expect(initialRuntimeBindingKey("create", null, defaultBindingKey)).toBe(defaultBindingKey);
    expect(initialRuntimeBindingKey("edit", null, defaultBindingKey)).toBe("");
    expect(initialRuntimeBindingKey("edit", { profileId: "profile-2", revision: 4 }, defaultBindingKey))
      .toBe("profile-2:4");
  });

  it("keeps capability selections schema-valid for the chosen policy", () => {
    expect(normalizeRuntimeCapabilities("text_only", ["text", "abort", "read_only_tool"]))
      .toEqual(["text", "abort"]);
    expect(normalizeRuntimeCapabilities("read_only_tools", []))
      .toEqual(["text", "abort", "file_read", "read_only_tool"]);
  });

  it("formats immutable binding options with current runtime status", () => {
    expect(formatRuntimeBindingOption(
      {
        id: "profile-1",
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
      },
      {
        profileId: "profile-1",
        revision: 2,
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
      }
    )).toBe("標準文字執行 · enabled · OpenAI-compatible · read_only_tools · Rev 2");
  });

  it("keeps the selected disabled revision visible in compact select options", () => {
    const snapshot = {
      runtimeProfiles: [{
        id: "profile-1",
        name: "標準文字執行",
        harnessKind: "openai_compatible",
        modelConnectorId: null,
        sandboxProfileId: null,
        policy: "read_only_tools",
        capabilities: ["text", "read_only_tool"],
        timeoutMs: 60_000,
        maxConcurrency: 1,
        enabled: false,
        revision: 3,
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z"
      }],
      runtimeProfileRevisions: [
        {
          profileId: "profile-1",
          revision: 3,
          name: "標準文字執行",
          harnessKind: "openai_compatible",
          modelConnectorId: null,
          sandboxProfileId: null,
          policy: "read_only_tools",
          capabilities: ["text", "read_only_tool"],
          timeoutMs: 60_000,
          maxConcurrency: 1,
          enabled: false,
          source: "updated",
          recordedAt: "2026-08-03T00:00:00.000Z"
        },
        {
          profileId: "profile-1",
          revision: 2,
          name: "標準文字執行",
          harnessKind: "openai_compatible",
          modelConnectorId: null,
          sandboxProfileId: null,
          policy: "read_only_tools",
          capabilities: ["text", "read_only_tool"],
          timeoutMs: 55_000,
          maxConcurrency: 1,
          enabled: true,
          source: "updated",
          recordedAt: "2026-08-02T00:00:00.000Z"
        }
      ]
    } as unknown as PlatformSnapshot;

    const options = runtimeBindingOptions(snapshot, { profileId: "profile-1", revision: 3 });

    expect(options.map((option) => option.key)).toEqual(["profile-1:3"]);
    expect(options[0]?.label).toContain("disabled");
  });

  it("omits disabled historical revisions unless that exact revision is already bound", () => {
    const base = {
      id: "profile-1",
      name: "標準文字執行",
      harnessKind: "openai_compatible" as const,
      modelConnectorId: null,
      sandboxProfileId: null,
      policy: "text_only" as const,
      capabilities: ["text" as const],
      timeoutMs: 60_000,
      maxConcurrency: 1
    };
    const snapshot = {
      runtimeProfiles: [{
        ...base,
        enabled: true,
        revision: 2,
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z"
      }],
      runtimeProfileRevisions: [
        { ...base, profileId: base.id, revision: 2, enabled: true, source: "updated", recordedAt: "2026-08-03T00:00:00.000Z" },
        { ...base, profileId: base.id, revision: 1, enabled: false, source: "created", recordedAt: "2026-08-02T00:00:00.000Z" }
      ]
    } as unknown as PlatformSnapshot;

    expect(runtimeBindingOptions(snapshot, null).map((option) => option.key)).toEqual(["profile-1:2"]);
    expect(runtimeBindingOptions(snapshot, { profileId: "profile-1", revision: 1 }).map((option) => option.key))
      .toEqual(["profile-1:2", "profile-1:1"]);
  });

  it("counts blocked agents and surfaces runtime readiness problems", () => {
    const ready = {
      status: "ready",
      checks: [{ code: "runtime", status: "passed", message: "ok" }]
    } as AgentReadiness;
    const blocked = {
      status: "blocked",
      checks: [
        { code: "runtime", status: "blocked", message: "Runtime Profile 不存在或已停用。" },
        { code: "lifecycle", status: "blocked", message: "Agent 已停用。" }
      ]
    } as AgentReadiness;

    const summary = runtimeProfileUsageSummary([
      { id: "agent-a", runtimeProfileBinding: { profileId: "profile-1", revision: 1 } },
      { id: "agent-b", runtimeProfileBinding: { profileId: "profile-1", revision: 2 } },
      { id: "agent-c", runtimeProfileBinding: null }
    ] as PlatformSnapshot["agents"], (agentId) => agentId === "agent-b" ? blocked : ready, "profile-1");

    expect(summary).toEqual({ total: 2, blocked: 1 });
    expect(runtimeBlockedMessages(blocked)).toEqual([
      "Runtime Profile 不存在或已停用。",
      "Agent 已停用。"
    ]);
  });
});
