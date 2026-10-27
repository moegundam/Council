import { describe, expect, it } from "vitest";
import type { PlatformSnapshot } from "@council/contracts";
import { evaluateAgentReadiness } from "./agent-readiness.js";
import { resolveRuntimeProfileAdmission } from "./runtime-policy.js";

function snapshot(overrides: Record<string, unknown> = {}): PlatformSnapshot {
  return {
    groups: [], categories: [], tags: [], threads: [], roles: [], meetings: [], participants: [],
    speakerQueue: [], utterances: [], toolRuns: [], chairSuggestions: [], decisions: [], tasks: [],
    agents: [{
      id: "agent-1", name: "Architect", description: "", modelConnectorId: "model-1",
      goalSummary: "", toolsSummary: "", dataSummary: "", skillIds: ["skill-1"],
      toolGrants: [{ connectorId: "mcp-1", toolName: "read_issue" }], status: "online",
      toolPackGrants: [],
      lifecycleStatus: "published", promptBinding: { promptId: "prompt-1", version: 2 },
      runtimeProfileBinding: { profileId: "70000000-0000-4000-8000-000000000001", revision: 1 },
      ...((overrides.agent as Record<string, unknown> | undefined) ?? {})
    } as unknown as PlatformSnapshot["agents"][number]],
    skills: [{
      id: "skill-1", name: "Issue reader", version: "1.0.0", instructions: "read",
      source: "builtin", owner: "owner", contentDigest: "digest-1",
      validation: { result: "passed", summary: "ok", checkedAt: "2026-01-01", contentDigest: "digest-1" },
      status: "approved", approvedAt: "2026-01-01", revokedAt: null, revocationReason: null
    }],
    modelConnectors: [{
      id: "model-1", name: "Local", location: "local", baseUrl: "http://localhost/v1", model: "local-model",
      enabled: true, hasSecret: false, secretRevision: 0, credentialId: null
    } as unknown as PlatformSnapshot["modelConnectors"][number]],
    mcpConnectors: [{
      id: "mcp-1", name: "Issues", baseUrl: "http://mcp", approvedTools: ["read_issue"], enabled: true,
      hasSecret: false, toolRegistrations: [{ toolName: "read_issue", displayName: "Read issue", id: "tool-1" }]
    } as unknown as PlatformSnapshot["mcpConnectors"][number]],
    prompts: [{ id: "prompt-1", kind: "agent", status: "published", publishedVersion: 2 } as unknown as NonNullable<PlatformSnapshot["prompts"]>[number]],
    taskAdapterConnectors: [],
    runtimeProfiles: [{
      id: "70000000-0000-4000-8000-000000000001", name: "Standard", harnessKind: "openai_compatible", modelConnectorId: null,
      sandboxProfileId: null, policy: "read_only_tools", capabilities: ["text", "read_only_tool"],
      timeoutMs: 90_000, maxConcurrency: 2, enabled: true, revision: 1,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
    }],
    runtimeProfileRevisions: [{
      profileId: "70000000-0000-4000-8000-000000000001", revision: 1, name: "Standard", harnessKind: "openai_compatible",
      modelConnectorId: null, sandboxProfileId: null, policy: "read_only_tools",
      capabilities: ["text", "read_only_tool"], timeoutMs: 90_000, maxConcurrency: 2,
      enabled: true, source: "created", recordedAt: "2026-01-01T00:00:00.000Z"
    }],
    toolPacks: [],
    toolPackRevisions: [],
    ...overrides
  } as unknown as PlatformSnapshot;
}

describe("evaluateAgentReadiness", () => {
  it("returns ready when all execution dependencies pass", () => {
    const result = evaluateAgentReadiness(snapshot(), "agent-1");

    expect(result.status).toBe("ready");
    expect(result.checks.every((check) => check.status === "passed")).toBe(true);
  });

  it("blocks a credential mismatch and reports checks deterministically", () => {
    const result = evaluateAgentReadiness(snapshot({
      agent: { promptBinding: null },
      modelConnectors: [{
        id: "model-1", name: "Cloud", location: "cloud", baseUrl: "https://api.example.com/v1", model: "cloud-model",
        enabled: true, hasSecret: true, secretRevision: 3, credentialId: "credential-1"
      }],
      credentials: [{ id: "credential-1", status: "active", hasSecret: true, secretRevision: 2 }]
    }), "agent-1");

    expect(result.status).toBe("blocked");
    expect(result.checks.map((check) => check.code)).toEqual([
      "lifecycle", "runtime", "model", "credential", "prompt", "skill", "tool"
    ]);
    expect(result.checks.find((check) => check.code === "credential")?.status).toBe("blocked");
    expect(result.checks.find((check) => check.code === "prompt")?.status).toBe("warning");
  });

  it("blocks an expired active Credential", () => {
    const result = evaluateAgentReadiness(snapshot({
      agent: { promptBinding: null },
      modelConnectors: [{
        id: "model-1", name: "Cloud", location: "cloud", baseUrl: "https://api.example.com/v1", model: "cloud-model",
        enabled: true, hasSecret: true, secretRevision: 3, credentialId: "credential-1"
      }],
      credentials: [{
        id: "credential-1",
        status: "active",
        hasSecret: true,
        secretRevision: 3,
        expiresAt: "2000-01-01T00:00:00.000Z"
      }]
    }), "agent-1");

    expect(result.status).toBe("blocked");
    expect(result.checks.find((check) => check.code === "credential")).toMatchObject({
      status: "blocked",
      message: expect.stringMatching(/expired|\u904e\u671f/i)
    });
  });

  it("blocks draft agents and invalid prompt, skill, and tool dependencies", () => {
    const result = evaluateAgentReadiness(snapshot({
      agent: { lifecycleStatus: "draft", promptBinding: { promptId: "missing", version: 1 }, skillIds: ["missing"], toolGrants: [{ connectorId: "mcp-1", toolName: "write_issue" }] },
      skills: [],
      mcpConnectors: [{ id: "mcp-1", name: "Issues", baseUrl: "http://mcp", approvedTools: [], enabled: true, toolRegistrations: [] }],
      prompts: []
    }), "agent-1");

    expect(result.status).toBe("blocked");
    expect(result.checks.filter((check) => check.status === "blocked").map((check) => check.code)).toEqual([
      "lifecycle", "prompt", "skill", "tool"
    ]);
  });

  it("warns about an unpublished draft while keeping its published runtime distinct", () => {
    const result = evaluateAgentReadiness(snapshot({
      agent: { lifecycleStatus: "draft", draftRevision: 3, publishedRevision: 2 }
    }), "agent-1");

    expect(result.status).toBe("warning");
    expect(result.checks.find((check) => check.code === "lifecycle")?.status).toBe("warning");
  });

  it("requires an exact published prompt version", () => {
    const result = evaluateAgentReadiness(snapshot({
      prompts: [{ id: "prompt-1", status: "published", publishedVersion: 2, versions: [{ version: 2, status: "draft" }] }]
    }), "agent-1");

    expect(result.status).toBe("blocked");
    expect(result.checks.find((check) => check.code === "prompt")?.status).toBe("blocked");
  });

  it("blocks a published Prompt whose kind is not Agent", () => {
    const result = evaluateAgentReadiness(snapshot({
      prompts: [{ id: "prompt-1", kind: "meeting", status: "published", publishedVersion: 2 }]
    }), "agent-1");

    expect(result.status).toBe("blocked");
    expect(result.checks.find((check) => check.code === "prompt")).toMatchObject({
      status: "blocked",
      message: expect.stringMatching(/Agent|類型/i)
    });
  });

  it("keeps an older published binding valid while a newer Prompt draft exists", () => {
    const result = evaluateAgentReadiness(snapshot({
      agent: { promptBinding: { promptId: "prompt-1", version: 1 } },
      prompts: [{ id: "prompt-1", kind: "agent", status: "draft", currentVersion: 2, publishedVersion: 1 }]
    }), "agent-1");

    expect(result.status).toBe("ready");
    expect(result.checks.find((check) => check.code === "prompt")?.status).toBe("passed");
  });

  it("blocks a missing, disabled, stale, or model-mismatched Runtime Profile", () => {
    const missing = evaluateAgentReadiness(snapshot({ agent: { runtimeProfileBinding: null } }), "agent-1");
    expect(missing.checks.find((check) => check.code === "runtime")?.status).toBe("blocked");

    const disabled = evaluateAgentReadiness(snapshot({
      runtimeProfiles: [{ ...snapshot().runtimeProfiles![0]!, enabled: false }]
    }), "agent-1");
    expect(disabled.checks.find((check) => check.code === "runtime")?.status).toBe("blocked");

    const stale = evaluateAgentReadiness(snapshot({
      runtimeProfileRevisions: []
    }), "agent-1");
    expect(stale.checks.find((check) => check.code === "runtime")?.status).toBe("blocked");

    const disabledRevision = evaluateAgentReadiness(snapshot({
      runtimeProfileRevisions: [{ ...snapshot().runtimeProfileRevisions![0]!, enabled: false }]
    }), "agent-1");
    expect(disabledRevision.checks.find((check) => check.code === "runtime")?.status).toBe("blocked");

    const mismatched = evaluateAgentReadiness(snapshot({
      runtimeProfileRevisions: [{
        ...snapshot().runtimeProfileRevisions![0]!, modelConnectorId: "70000000-0000-4000-8000-000000000002"
      }]
    }), "agent-1");
    expect(mismatched.checks.find((check) => check.code === "runtime")?.status).toBe("blocked");
  });

  it("does not report isolated execution ready when admission lacks a verified attestation", () => {
    const base = snapshot();
    const isolatedRevision = {
      ...base.runtimeProfileRevisions![0]!,
      sandboxProfileId: "70000000-0000-4000-8000-000000000004",
      policy: "isolated_exec" as const,
      capabilities: ["text", "abort", "file_read", "file_write", "process"] as const
    };
    const isolatedSnapshot = snapshot({
      runtimeProfiles: [{
        ...base.runtimeProfiles![0]!,
        sandboxProfileId: isolatedRevision.sandboxProfileId,
        policy: isolatedRevision.policy,
        capabilities: [...isolatedRevision.capabilities]
      }],
      runtimeProfileRevisions: [{
        ...isolatedRevision,
        capabilities: [...isolatedRevision.capabilities]
      }]
    });

    expect(() => resolveRuntimeProfileAdmission({
      binding: isolatedSnapshot.agents[0]!.runtimeProfileBinding!,
      platform: isolatedSnapshot,
      agentModelConnectorId: isolatedSnapshot.agents[0]!.modelConnectorId
    })).toThrow(/isolation attestation/i);

    const result = evaluateAgentReadiness(isolatedSnapshot, "agent-1");
    expect(result.checks.find((item) => item.code === "runtime")?.status).toBe("blocked");
    expect(result.status).toBe("blocked");

    const attested = evaluateAgentReadiness(isolatedSnapshot, "agent-1", {
      executionIsolationAttested: true
    });
    expect(attested.checks.find((item) => item.code === "runtime")?.status).toBe("passed");
    expect(attested.status).toBe("ready");
  });

  it("blocks revoked, stale, digest-drifted, and undeclared Tool Pack grants", () => {
    const manifestDigest = `sha256:${"b".repeat(64)}`;
    const grant = {
      packId: "a1000000-0000-4000-8000-000000000001",
      revision: 4,
      manifestDigest,
      toolName: "search"
    };
    const pack = {
      id: grant.packId,
      name: "Documentation search",
      version: "1.0.0",
      description: "Read-only documentation search.",
      owner: "Platform Owner",
      sourceReference: `registry.example.com/council/docs@sha256:${"a".repeat(64)}`,
      imageDigest: `sha256:${"a".repeat(64)}`,
      manifestDigest,
      tools: [{
        name: "search",
        kind: "command" as const,
        goal: "Search documentation.",
        access: "read_only" as const,
        argv: { executable: "/usr/bin/rg", fixedArguments: ["--json"] },
        env: { allowedNames: ["LANG"] },
        stdin: { mode: "none" as const }
      }],
      revision: 4,
      status: "approved" as const,
      validation: {
        result: "passed" as const,
        summary: "Reviewed.",
        checkedAt: "2026-08-03T00:00:00.000Z",
        manifestDigest
      },
      approvedAt: "2026-08-03T00:00:00.000Z",
      revokedAt: null,
      revocationReason: null,
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z"
    };
    const toolStatus = (
      agentGrant: typeof grant,
      currentPack: NonNullable<PlatformSnapshot["toolPacks"]>[number]
    ) => evaluateAgentReadiness(snapshot({
      agent: { toolPackGrants: [agentGrant] },
      toolPacks: [currentPack]
    }), "agent-1").checks.find((item) => item.code === "tool")?.status;

    expect(toolStatus(grant, { ...pack, status: "revoked", revokedAt: pack.updatedAt, revocationReason: "Revoked." })).toBe("blocked");
    expect(toolStatus({ ...grant, revision: 3 }, pack)).toBe("blocked");
    expect(toolStatus({ ...grant, manifestDigest: `sha256:${"d".repeat(64)}` }, pack)).toBe("blocked");
    expect(toolStatus({ ...grant, toolName: "missing" }, pack)).toBe("blocked");
  });
});
