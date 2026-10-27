import { describe, expect, it } from "vitest";
import type { RuntimeProfile, RuntimeProfileRevision, RuntimeProfileSnapshot } from "@council/contracts";
import {
  resolveRuntimeProfileAdmission,
  runtimePolicyCanTighten,
  RuntimeProfileAdmissionError
} from "./runtime-policy.js";

const revision: RuntimeProfileRevision = {
  profileId: "70000000-0000-4000-8000-000000000001",
  revision: 2,
  name: "Standard runtime",
  harnessKind: "openai_compatible",
  modelConnectorId: null,
  sandboxProfileId: null,
  policy: "read_only_tools",
  capabilities: ["text", "abort", "read_only_tool"],
  timeoutMs: 90_000,
  maxConcurrency: 2,
  enabled: true,
  source: "updated",
  recordedAt: "2026-08-03T00:00:00.000Z"
};

const profile: RuntimeProfile = {
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
  revision: 3,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z"
};

function admission(overrides: Partial<Parameters<typeof resolveRuntimeProfileAdmission>[0]> = {}) {
  return resolveRuntimeProfileAdmission({
    binding: { profileId: revision.profileId, revision: revision.revision },
    platform: {
      runtimeProfiles: [profile],
      runtimeProfileRevisions: [revision]
    },
    agentModelConnectorId: "70000000-0000-4000-8000-000000000002",
    ...overrides
  });
}

describe("Runtime Profile policy", () => {
  it("allows lower layers to tighten but never elevate the policy floor", () => {
    expect(runtimePolicyCanTighten("isolated_exec", "read_only_tools")).toBe(true);
    expect(runtimePolicyCanTighten("read_only_tools", "text_only")).toBe(true);
    expect(runtimePolicyCanTighten("text_only", "read_only_tools")).toBe(false);
  });

  it("resolves an exact enabled revision to an immutable execution snapshot", () => {
    const snapshot = admission();

    expect(snapshot).toEqual({
      profileId: revision.profileId,
      revision: revision.revision,
      harnessKind: revision.harnessKind,
      modelConnectorId: null,
      sandboxProfileId: null,
      policy: revision.policy,
      capabilities: revision.capabilities,
      timeoutMs: revision.timeoutMs,
      maxConcurrency: revision.maxConcurrency
    });
    expect(snapshot.capabilities).not.toBe(revision.capabilities);
  });

  it("rejects missing, unavailable, stale, disabled, or model-mismatched runtime bindings", () => {
    const binding = { profileId: revision.profileId, revision: revision.revision };
    expect(() => admission({ binding: null })).toThrow(RuntimeProfileAdmissionError);
    expect(() => admission({
      platform: { runtimeProfiles: [{ ...profile, enabled: false }], runtimeProfileRevisions: [revision] }
    })).toThrow(/disabled/i);
    expect(() => admission({ binding: { ...binding, revision: 1 } })).toThrow(/stale/i);
    expect(() => admission({
      platform: { runtimeProfiles: [profile], runtimeProfileRevisions: [{ ...revision, enabled: false }] }
    })).toThrow(/disabled/i);
    expect(() => admission({
      platform: {
        runtimeProfiles: [profile],
        runtimeProfileRevisions: [{ ...revision, modelConnectorId: "70000000-0000-4000-8000-000000000003" }]
      }
    })).toThrow(/model/i);
  });

  it("requires a supplied queued snapshot to equal the admitted immutable snapshot", () => {
    const queuedSnapshot: RuntimeProfileSnapshot = {
      profileId: revision.profileId,
      revision: revision.revision,
      harnessKind: revision.harnessKind,
      modelConnectorId: revision.modelConnectorId,
      sandboxProfileId: revision.sandboxProfileId,
      policy: revision.policy,
      capabilities: [...revision.capabilities],
      timeoutMs: revision.timeoutMs,
      maxConcurrency: revision.maxConcurrency
    };

    expect(admission({ queuedSnapshot })).toEqual(queuedSnapshot);
    expect(() => admission({
      queuedSnapshot: { ...queuedSnapshot, timeoutMs: queuedSnapshot.timeoutMs + 1_000 }
    })).toThrow(/queued Runtime Profile snapshot is stale/i);
  });

  it("fails closed for isolated execution until a verified deployment attests the boundary", () => {
    const isolatedRevision: RuntimeProfileRevision = {
      ...revision,
      policy: "isolated_exec",
      sandboxProfileId: "70000000-0000-4000-8000-000000000004",
      capabilities: ["text", "abort", "file_read", "file_write", "process"]
    };
    const input = {
      binding: { profileId: isolatedRevision.profileId, revision: isolatedRevision.revision },
      platform: {
        runtimeProfiles: [{
          ...profile,
          sandboxProfileId: isolatedRevision.sandboxProfileId,
          policy: isolatedRevision.policy,
          capabilities: [...isolatedRevision.capabilities]
        }],
        runtimeProfileRevisions: [isolatedRevision]
      },
      agentModelConnectorId: null
    };

    expect(() => resolveRuntimeProfileAdmission(input)).toThrow(/isolation attestation/i);
    expect(resolveRuntimeProfileAdmission({
      ...input,
      executionIsolationAttested: true
    })).toMatchObject({ policy: "isolated_exec", sandboxProfileId: isolatedRevision.sandboxProfileId });
  });
});
