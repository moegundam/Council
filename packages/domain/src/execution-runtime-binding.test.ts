import { describe, expect, it } from "vitest";
import type { AgentRevision, GoalPlanTask, ModelConnector, RuntimeProfileSnapshot } from "@council/contracts";
import { createExecutionRuntimeBinding, runtimeDataScopeDigest } from "./execution-runtime-binding.js";

const task: GoalPlanTask = {
  id: "70000000-0000-4000-8000-000000000001",
  decisionId: "70000000-0000-4000-8000-000000000002",
  title: "Implement the approved patch",
  description: "Edit and test the repository snapshot.",
  acceptanceCriteria: "Patch and test evidence are available.",
  dependencyIds: [],
  assigneeAgentId: "70000000-0000-4000-8000-000000000003",
  executionMode: "worker",
  allowedTools: ["read", "grep", "edit", "bash", "browser"],
  dataScope: "Approved repository commit only.",
  action: null
};

const agentRevision = {
  agentId: task.assigneeAgentId!,
  revision: 4,
  name: "Coder",
  description: "Implements bounded tasks.",
  modelConnectorId: "70000000-0000-4000-8000-000000000004",
  goalSummary: "Produce a reviewable patch.",
  toolsSummary: "Bounded repository tools.",
  dataSummary: "Approved repository snapshot.",
  runtimeProfileBinding: { profileId: "70000000-0000-4000-8000-000000000005", revision: 3 },
  toolGrants: [],
  toolPackGrants: [],
  skillIds: [],
  promptBinding: null,
  contentDigest: "a".repeat(64),
  contentDigestVersion: 3,
  source: "published",
  restoredFromRevision: null,
  createdAt: "2026-09-02T00:00:00.000Z",
  publishedAt: "2026-09-02T00:00:00.000Z"
} satisfies AgentRevision;

const connector: ModelConnector = {
  id: agentRevision.modelConnectorId!,
  revision: 5,
  name: "GB10 local",
  location: "local",
  baseUrl: "http://model-tunnel:4001/v1",
  model: "gb10-coder",
  enabled: true,
  hasSecret: false,
  secretRevision: 0,
  credentialId: null
};

const profile: RuntimeProfileSnapshot = {
  profileId: agentRevision.runtimeProfileBinding!.profileId,
  revision: agentRevision.runtimeProfileBinding!.revision,
  harnessKind: "pi",
  modelConnectorId: connector.id,
  sandboxProfileId: "70000000-0000-4000-8000-000000000006",
  policy: "isolated_exec",
  capabilities: ["text", "abort", "resume", "file_read", "file_write", "process"],
  timeoutMs: 2 * 60 * 60_000,
  maxConcurrency: 1
};

describe("Execution Runtime binding", () => {
  it("pins an OMP task to immutable Agent, model, profile, image, tool, and data revisions", () => {
    expect(createExecutionRuntimeBinding({
      task,
      agentRevision,
      runtimeProfile: profile,
      modelConnector: connector,
      omp: {
        enabled: true,
        sandboxProfileId: profile.sandboxProfileId!,
        sandboxImageDigest: `sha256:${"a".repeat(64)}`,
        workspaceSourceId: "council-canary",
        workspaceArchiveDigest: `sha256:${"d".repeat(64)}`
      }
    })).toEqual({
      planTaskId: task.id,
      route: "omp_coding",
      runtimeProfileId: profile.profileId,
      runtimeProfileRevision: profile.revision,
      harnessKind: "pi",
      runtimeVersion: "omp-rpc-v2@18.1.2",
      policy: "isolated_exec",
      capabilities: ["text", "file_read", "file_write", "process"],
      agentId: agentRevision.agentId,
      agentRevision: agentRevision.revision,
      modelConnectorId: connector.id,
      modelConnectorRevision: connector.revision,
      modelConnectorSecretRevision: 0,
      sandboxProfileId: profile.sandboxProfileId,
      sandboxImageDigest: `sha256:${"a".repeat(64)}`,
      workspaceSource: {
        sourceId: "council-canary",
        archiveDigest: `sha256:${"d".repeat(64)}`
      },
      allowedTools: ["read", "grep", "glob", "lsp", "edit", "bash"],
      dataScopeDigest: runtimeDataScopeDigest(task.dataScope),
      timeoutMs: profile.timeoutMs
    });
  });

  it("fails closed when OMP is disabled or its operator Sandbox binding drifts", () => {
    expect(() => createExecutionRuntimeBinding({ task, agentRevision, runtimeProfile: profile, modelConnector: connector }))
      .toThrow(/operator-enabled/i);
    expect(() => createExecutionRuntimeBinding({
      task,
      agentRevision,
      runtimeProfile: profile,
      modelConnector: connector,
      omp: {
        enabled: true,
        sandboxProfileId: "70000000-0000-4000-8000-000000000099",
        sandboxImageDigest: `sha256:${"a".repeat(64)}`,
        workspaceSourceId: "council-canary",
        workspaceArchiveDigest: `sha256:${"d".repeat(64)}`
      }
    })).toThrow(/Sandbox Profile/i);
  });

  it("keeps a text-only Worker on the native runtime while still pinning revisions", () => {
    const textProfile: RuntimeProfileSnapshot = {
      ...profile,
      harnessKind: "openai_compatible",
      modelConnectorId: null,
      sandboxProfileId: null,
      policy: "text_only",
      capabilities: ["text", "abort"],
      timeoutMs: 90_000,
      maxConcurrency: 2
    };
    const textAgent = {
      ...agentRevision,
      runtimeProfileBinding: { profileId: textProfile.profileId, revision: textProfile.revision }
    };
    expect(createExecutionRuntimeBinding({
      task,
      agentRevision: textAgent,
      runtimeProfile: textProfile,
      modelConnector: connector
    })).toMatchObject({
      route: "native_text",
      harnessKind: "openai_compatible",
      runtimeVersion: "council-openai-compatible-v1",
      capabilities: ["text"],
      allowedTools: [],
      sandboxImageDigest: null,
      workspaceSource: null
    });
  });
});
