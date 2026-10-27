import { describe, expect, it } from "vitest";
import type { RuntimeProfile, RuntimeProfileRevision } from "@council/contracts";
import { resolveRuntimeProfileSnapshotForBinding } from "./runtime-profiles.js";

const revision: RuntimeProfileRevision = {
  profileId: "70000000-0000-4000-8000-000000000001",
  revision: 1,
  name: "Bound runtime",
  harnessKind: "openai_compatible",
  modelConnectorId: null,
  sandboxProfileId: null,
  policy: "read_only_tools",
  capabilities: ["text", "abort", "read_only_tool"],
  timeoutMs: 90_000,
  maxConcurrency: 2,
  enabled: true,
  source: "created",
  recordedAt: "2026-08-03T00:00:00.000Z"
};

const currentProfile: RuntimeProfile = {
  id: revision.profileId,
  name: "Current runtime",
  harnessKind: "codex",
  modelConnectorId: null,
  sandboxProfileId: null,
  policy: "text_only",
  capabilities: ["text", "abort"],
  timeoutMs: 60_000,
  maxConcurrency: 1,
  enabled: true,
  revision: 2,
  createdAt: "2026-08-03T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z"
};

describe("resolveRuntimeProfileSnapshotForBinding", () => {
  it("resolves the bound immutable revision while the current profile has advanced", () => {
    expect(resolveRuntimeProfileSnapshotForBinding({
      binding: { profileId: revision.profileId, revision: revision.revision },
      runtimeProfiles: [currentProfile],
      runtimeProfileRevisions: [revision],
      agentModelConnectorId: null
    })).toMatchObject({
      profileId: revision.profileId,
      revision: revision.revision,
      harnessKind: revision.harnessKind,
      timeoutMs: revision.timeoutMs
    });
  });

  it("fails closed for disabled current profiles and unattested isolated execution", () => {
    const binding = { profileId: revision.profileId, revision: revision.revision };
    expect(resolveRuntimeProfileSnapshotForBinding({
      binding,
      runtimeProfiles: [{ ...currentProfile, enabled: false }],
      runtimeProfileRevisions: [revision],
      agentModelConnectorId: null
    })).toBeNull();

    const isolatedRevision: RuntimeProfileRevision = {
      ...revision,
      sandboxProfileId: "70000000-0000-4000-8000-000000000004",
      policy: "isolated_exec",
      capabilities: ["text", "abort", "file_read", "file_write", "process"]
    };
    const isolatedProfile: RuntimeProfile = {
      ...currentProfile,
      sandboxProfileId: isolatedRevision.sandboxProfileId,
      policy: isolatedRevision.policy,
      capabilities: [...isolatedRevision.capabilities]
    };
    const input = {
      binding,
      runtimeProfiles: [isolatedProfile],
      runtimeProfileRevisions: [isolatedRevision],
      agentModelConnectorId: null
    };

    expect(resolveRuntimeProfileSnapshotForBinding(input)).toBeNull();
    expect(resolveRuntimeProfileSnapshotForBinding({
      ...input,
      executionIsolationAttested: true
    })).toMatchObject({ policy: "isolated_exec", sandboxProfileId: isolatedRevision.sandboxProfileId });
  });
});
