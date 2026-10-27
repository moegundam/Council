import { describe, expect, it } from "vitest";
import {
  createRuntimeProfileSnapshot,
  type AgentRevision,
  type PlatformSnapshot,
  type RuntimeProfile,
  type RuntimeProfileRevision
} from "@council/contracts";
import {
  resolveQueuedRuntimeProfile,
  StaleRuntimeProfileBindingError
} from "./runtime-profile-binding.js";

const revision: RuntimeProfileRevision = {
  profileId: "70000000-0000-4000-8000-000000000001",
  revision: 1,
  name: "Worker runtime",
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

const profile: RuntimeProfile = {
  id: revision.profileId,
  name: revision.name,
  harnessKind: revision.harnessKind,
  modelConnectorId: revision.modelConnectorId,
  sandboxProfileId: revision.sandboxProfileId,
  policy: revision.policy,
  capabilities: [...revision.capabilities],
  timeoutMs: revision.timeoutMs,
  maxConcurrency: revision.maxConcurrency,
  enabled: true,
  revision: revision.revision,
  createdAt: revision.recordedAt,
  updatedAt: revision.recordedAt
};

const agentRevision: AgentRevision = {
  agentId: "70000000-0000-4000-8000-000000000010",
  revision: 1,
  name: "Worker Agent",
  description: "",
  modelConnectorId: null,
  goalSummary: "",
  toolsSummary: "",
  dataSummary: "",
  skillIds: [],
  toolGrants: [],
  toolPackGrants: [],
  runtimeProfileBinding: { profileId: revision.profileId, revision: revision.revision },
  promptBinding: null,
  contentDigest: "digest",
  contentDigestVersion: 2,
  source: "created",
  restoredFromRevision: null,
  createdAt: revision.recordedAt,
  publishedAt: revision.recordedAt
};

function platform(
  runtimeProfile: RuntimeProfile = profile,
  runtimeRevision: RuntimeProfileRevision = revision
): PlatformSnapshot {
  return {
    runtimeProfiles: [runtimeProfile],
    runtimeProfileRevisions: [runtimeRevision]
  } as PlatformSnapshot;
}

describe("resolveQueuedRuntimeProfile", () => {
  it("revalidates the published binding and exact queued snapshot", () => {
    const queuedSnapshot = createRuntimeProfileSnapshot(revision);
    const input = {
      platform: platform(),
      agentRevision,
      queuedBinding: agentRevision.runtimeProfileBinding!,
      queuedSnapshot
    };

    expect(resolveQueuedRuntimeProfile(input)).toEqual(queuedSnapshot);
    expect(() => resolveQueuedRuntimeProfile({
      ...input,
      queuedBinding: { ...input.queuedBinding, revision: input.queuedBinding.revision + 1 }
    })).toThrow(StaleRuntimeProfileBindingError);
    expect(() => resolveQueuedRuntimeProfile({
      ...input,
      queuedSnapshot: { ...queuedSnapshot, timeoutMs: queuedSnapshot.timeoutMs + 1_000 }
    })).toThrow(StaleRuntimeProfileBindingError);
  });

  it("requires verified isolation attestation through the shared admission path", () => {
    const isolatedRevision: RuntimeProfileRevision = {
      ...revision,
      sandboxProfileId: "70000000-0000-4000-8000-000000000004",
      policy: "isolated_exec",
      capabilities: ["text", "abort", "file_read", "file_write", "process"]
    };
    const isolatedProfile: RuntimeProfile = {
      ...profile,
      sandboxProfileId: isolatedRevision.sandboxProfileId,
      policy: isolatedRevision.policy,
      capabilities: [...isolatedRevision.capabilities]
    };
    const queuedSnapshot = createRuntimeProfileSnapshot(isolatedRevision);
    const input = {
      platform: platform(isolatedProfile, isolatedRevision),
      agentRevision,
      queuedBinding: agentRevision.runtimeProfileBinding!,
      queuedSnapshot
    };

    expect(() => resolveQueuedRuntimeProfile(input)).toThrow(StaleRuntimeProfileBindingError);
    expect(resolveQueuedRuntimeProfile({
      ...input,
      executionIsolationAttested: true
    })).toEqual(queuedSnapshot);
  });
});
