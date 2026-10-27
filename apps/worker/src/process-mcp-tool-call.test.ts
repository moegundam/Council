import { describe, expect, it, vi } from "vitest";
import { InMemoryPlatformStore, mcpConnectorExecutionFingerprint, mcpToolRequestFingerprint } from "@council/database";
import { createSeedSnapshot } from "@council/database/seed";
import type { ParticipantRoleBinding } from "@council/contracts";
import { encryptMcpToolArguments, SecretVault } from "@council/domain";
import {
  GovernanceDeniedError,
  GovernanceUnavailableError,
  type GovernanceProvider
} from "@council/runtime";
import {
  legacyMcpArgumentReaderEnabledFromEnv,
  prepareMcpToolCallExecution,
  resolveMcpToolCallArguments
} from "./mcp-job-lifecycle.js";
import {
  McpToolOutcomeUnknownError,
  processMcpToolCall,
  recordMcpToolFailure,
  recordReservedMcpToolFailure,
  StaleMcpToolRunError
} from "./process-mcp-tool-call.js";

function roleBinding(
  seed: ReturnType<typeof createSeedSnapshot>,
  agentId = seed.agents[0]!.id
): ParticipantRoleBinding {
  const participant = seed.participants.find((item) => item.meetingId === seed.meetings[0]!.id && item.agentId === agentId)!;
  return {
    participantId: participant.id,
    roleRevision: participant.roleRevision,
    roleId: participant.roleId,
    roleVersion: participant.roleSnapshot.version
  };
}

function configuredStore() {
  const seed = createSeedSnapshot();
  const connectorId = "d0000000-0000-4000-8000-000000000001";
  seed.mcpConnectors.push({
    id: connectorId,
    revision: 1,
    name: "Docs",
    location: "local",
    baseUrl: "http://10.20.30.40/mcp",
    approvedTools: ["search"],
    toolRegistrations: [{
      toolName: "search",
      displayName: "政策搜尋",
      kind: "mcp_tool",
      version: "1.0.0",
      owner: "Platform Owner",
      goal: "搜尋已核准的政策文件。"
    }],
    enabled: true,
    hasSecret: false
  });
  seed.agents[0]!.toolGrants = [{ connectorId, toolName: "search" }];
  return { seed, connectorId, store: new InMemoryPlatformStore(seed) };
}

function governanceProvider(
  decision: "allow" | "deny" | "warn" | "escalate" | "transform" = "allow"
): GovernanceProvider {
  return {
    metadata: {
      providerId: "test-governance",
      providerVersion: "1.0.0",
      policyDigest: `sha256:${"c".repeat(64)}`
    },
    evaluate: vi.fn(async () => ({ decision, reason: `council.test.${decision}` }))
  };
}

describe("MCP tool worker", () => {
  it("decrypts current job-bound arguments while retaining bounded legacy job compatibility", () => {
    const vault = new SecretVault(Buffer.alloc(32, 21));
    const argumentsValue = { query: "confidential policy", filters: { active: true } };
    const argumentsCiphertext = encryptMcpToolArguments(vault, "tool-job-encrypted", argumentsValue);

    expect(resolveMcpToolCallArguments({ argumentEncoding: "vault_v1", argumentsCiphertext }, "tool-job-encrypted", vault)).toEqual(argumentsValue);
    expect(resolveMcpToolCallArguments({ arguments: argumentsValue }, "tool-job-legacy", vault)).toEqual(argumentsValue);
    expect(() => resolveMcpToolCallArguments({ argumentEncoding: "vault_v1", argumentsCiphertext }, "different-job", vault)).toThrow(/job binding/i);
    expect(() => resolveMcpToolCallArguments({ argumentEncoding: "vault_v1", argumentsCiphertext }, "tool-job-encrypted")).toThrow(/Secret Vault/i);
    expect(() => resolveMcpToolCallArguments({ arguments: argumentsValue }, "tool-job-legacy", vault, false)).toThrow(/disabled/i);
    expect(legacyMcpArgumentReaderEnabledFromEnv({})).toBe(true);
    expect(legacyMcpArgumentReaderEnabledFromEnv({ MCP_LEGACY_ARGUMENT_READER_ENABLED: "false" })).toBe(false);
    expect(() => legacyMcpArgumentReaderEnabledFromEnv({ MCP_LEGACY_ARGUMENT_READER_ENABLED: "later" })).toThrow(/true or false/i);
  });

  it("calls an approved read-only tool and records verified evidence", async () => {
    const { seed, connectorId, store } = configuredStore();
    const call = vi.fn(async () => ({ documents: [{ title: "Policy" }] }));

    const utterance = await processMcpToolCall({
      store,
      jobId: "tool-job-success",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...roleBinding(seed),
      connectorId,
      toolName: "search",
      arguments: { query: "MCP policy" },
      call
    });

    expect(call).toHaveBeenCalledWith("search", { query: "MCP policy" });
    const participant = seed.participants.find((item) => item.agentId === seed.agents[0]!.id)!;
    expect(utterance).toMatchObject({
      speakerType: "tool",
      kind: "verified",
      evidenceCount: 1,
      agentRevision: participant.agentRevision ?? null,
      roleId: participant.roleId,
      roleRevision: participant.roleRevision
    });
    expect(utterance.content).toContain("Policy");
    expect((await store.getSnapshot()).toolRuns).toEqual([
      expect.objectContaining({
        jobId: "tool-job-success",
        requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        status: "succeeded",
        toolSnapshot: expect.objectContaining({ connectorName: "Docs", displayName: "政策搜尋", version: "1.0.0" }),
        utteranceId: utterance.id
      })
    ]);
  });

  it("records a shadow denial without changing the approved MCP call", async () => {
    const { seed, connectorId, store } = configuredStore();
    const provider = governanceProvider("deny");
    const audit = vi.spyOn(store, "recordAudit");
    const call = vi.fn(async () => ({ documents: [] }));

    await processMcpToolCall({
      store,
      jobId: "tool-job-governance-shadow",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...roleBinding(seed),
      connectorId,
      toolName: "search",
      arguments: { query: "confidential shadow query" },
      governance: { mode: "shadow", provider },
      call
    });

    expect(provider.evaluate).toHaveBeenCalledWith(expect.objectContaining({
      point: "pre_tool_call",
      snapshot: expect.objectContaining({
        tool_call: { name: "council_mcp_readonly", args: { query: "confidential shadow query" } },
        council: expect.objectContaining({ tool_name: "search" })
      })
    }));
    expect(call).toHaveBeenCalledOnce();
    const governanceAudit = audit.mock.calls.find(([event]) => event === "governance.mcp.pre_tool_call.evaluated");
    expect(governanceAudit?.[3]).toEqual(expect.objectContaining({
      mode: "shadow",
      decision: "deny",
      effect: "allow",
      wouldBlock: true
    }));
    expect(JSON.stringify(governanceAudit?.[3])).not.toContain("confidential shadow query");
  });

  it("isolates outbound MCP arguments from governance provider mutation", async () => {
    const { seed, connectorId, store } = configuredStore();
    const provider = governanceProvider("allow");
    vi.mocked(provider.evaluate).mockImplementationOnce(async (request) => {
      const toolCall = request.snapshot.tool_call as { args: Record<string, unknown> };
      toolCall.args.query = "provider-mutated";
      return { decision: "allow", reason: "council.test.allow" };
    });
    const call = vi.fn(async () => ({ documents: [] }));

    await processMcpToolCall({
      store,
      jobId: "tool-job-governance-immutable-args",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...roleBinding(seed),
      connectorId,
      toolName: "search",
      arguments: { query: "original-query", filters: { active: true } },
      governance: { mode: "shadow", provider },
      call
    });

    expect(call).toHaveBeenCalledWith("search", {
      query: "original-query",
      filters: { active: true }
    });
  });

  it("blocks an ACS denial before outbound MCP execution in enforce mode", async () => {
    const { seed, connectorId, store } = configuredStore();
    const provider = governanceProvider("deny");
    const call = vi.fn();

    await expect(processMcpToolCall({
      store,
      jobId: "tool-job-governance-denied",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...roleBinding(seed),
      connectorId,
      toolName: "search",
      arguments: { query: "blocked" },
      governance: { mode: "enforce", provider },
      call
    })).rejects.toBeInstanceOf(GovernanceDeniedError);

    expect(call).not.toHaveBeenCalled();
    expect((await store.getSnapshot()).toolRuns).toEqual([]);
  });

  it("fails closed before MCP when the governance provider or enforce audit is unavailable", async () => {
    const providerFailure = governanceProvider();
    vi.mocked(providerFailure.evaluate).mockRejectedValueOnce(new Error("provider unavailable"));
    const first = configuredStore();
    const firstCall = vi.fn();

    await expect(processMcpToolCall({
      store: first.store,
      jobId: "tool-job-governance-provider-error",
      meetingId: first.seed.meetings[0]!.id,
      agentId: first.seed.agents[0]!.id,
      ...roleBinding(first.seed),
      connectorId: first.connectorId,
      toolName: "search",
      arguments: {},
      governance: { mode: "enforce", provider: providerFailure },
      call: firstCall
    })).rejects.toBeInstanceOf(GovernanceUnavailableError);
    expect(firstCall).not.toHaveBeenCalled();

    const second = configuredStore();
    const auditFailure = vi.spyOn(second.store, "recordAudit").mockRejectedValueOnce(new Error("audit unavailable"));
    const secondCall = vi.fn();
    await expect(processMcpToolCall({
      store: second.store,
      jobId: "tool-job-governance-audit-error",
      meetingId: second.seed.meetings[0]!.id,
      agentId: second.seed.agents[0]!.id,
      ...roleBinding(second.seed),
      connectorId: second.connectorId,
      toolName: "search",
      arguments: {},
      governance: { mode: "enforce", provider: governanceProvider("allow") },
      call: secondCall
    })).rejects.toBeInstanceOf(GovernanceUnavailableError);
    expect(auditFailure).toHaveBeenCalledOnce();
    expect(secondCall).not.toHaveBeenCalled();
  });

  it("runs native authorization before consulting external governance", async () => {
    const { seed, connectorId, store } = configuredStore();
    seed.agents[0]!.toolGrants = [];
    const staleStore = new InMemoryPlatformStore(seed);
    const provider = governanceProvider("allow");
    const call = vi.fn();

    await expect(processMcpToolCall({
      store: staleStore,
      jobId: "tool-job-native-deny-first",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...roleBinding(seed),
      connectorId,
      toolName: "search",
      arguments: {},
      governance: { mode: "enforce", provider },
      call
    })).rejects.toThrow(/grant|allowlist|approved/i);

    expect(provider.evaluate).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("marks the outcome unknown instead of replaying after an outbound result cannot be committed", async () => {
    const { seed, connectorId, store } = configuredStore();
    const call = vi.fn(async () => ({ documents: [{ title: "Policy" }] }));
    const commit = vi.spyOn(store, "commitMcpToolRun").mockRejectedValue(new Error("database acknowledgement lost"));

    await expect(processMcpToolCall({
      store,
      jobId: "tool-job-commit-unknown",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...roleBinding(seed),
      connectorId,
      toolName: "search",
      arguments: { query: "MCP policy" },
      call
    })).rejects.toBeInstanceOf(McpToolOutcomeUnknownError);

    expect(call).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect((await store.getSnapshot()).toolRuns).toEqual([]);
  });

  it("rejects a queued tool when its Connector target changes before execution", async () => {
    const { seed, connectorId, store } = configuredStore();
    const participantBinding = roleBinding(seed);
    const connector = (await store.getSnapshot()).mcpConnectors.find((item) => item.id === connectorId)!;
    const queued = {
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...participantBinding,
      connectorId,
      toolName: "search",
      toolSnapshot: { connectorName: connector.name, ...connector.toolRegistrations[0]! },
      connectorFingerprint: mcpConnectorExecutionFingerprint(connector, null),
      arguments: { query: "queued" },
      requestedBy: "owner" as const
    };
    await store.reserveMcpToolCall("tool-job-connector-stale", {
      ...queued,
      requestFingerprint: mcpToolRequestFingerprint(queued)
    });
    await store.updateMcpConnector(connectorId, {
      expectedRevision: connector.revision,
      baseUrl: "http://10.20.30.41/mcp"
    });
    const call = vi.fn();

    await expect(processMcpToolCall({
      store,
      jobId: "tool-job-connector-stale",
      ...queued,
      reservationRequired: true,
      call
    })).rejects.toBeInstanceOf(StaleMcpToolRunError);
    expect(call).not.toHaveBeenCalled();
    expect((await store.getSnapshot()).toolRuns).toEqual([]);
  });

  it("fails an in-flight legacy reservation closed when its migration fingerprint is unverifiable", async () => {
    const { seed, connectorId } = configuredStore();
    const binding = roleBinding(seed);
    const participant = seed.participants.find((item) => item.id === binding.participantId)!;
    const connector = seed.mcpConnectors.find((item) => item.id === connectorId)!;
    const requestedAt = new Date().toISOString();
    const jobId = "tool-job-legacy-reservation";
    const queued = {
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...binding,
      connectorId,
      toolName: "search",
      toolSnapshot: { connectorName: connector.name, ...connector.toolRegistrations[0]! },
      connectorFingerprint: mcpConnectorExecutionFingerprint(connector, null),
      arguments: { query: "legacy pending request" },
      requestedBy: "owner" as const
    };
    seed.speakerQueue = [{
      id: jobId,
      jobId,
      requestFingerprint: null,
      meetingId: queued.meetingId,
      agentId: queued.agentId,
      participantId: queued.participantId,
      roleRevision: queued.roleRevision,
      roleId: queued.roleId,
      roleVersion: queued.roleVersion,
      kind: "mcp_tool_call",
      label: "政策搜尋 工具",
      toolName: queued.toolName,
      roleName: participant.roleSnapshot.name,
      agendaRevision: null,
      agendaCurrentItemId: null,
      status: "queued",
      requestedAt,
      startedAt: null,
      leaseExpiresAt: new Date(Date.parse(requestedAt) + 5 * 60_000).toISOString(),
      requestedBy: "owner",
      chairSuggestionId: null,
      automationRevision: null
    }];
    const store = new InMemoryPlatformStore(seed);
    await store.markSpeakerTurnRunning(jobId);
    const call = vi.fn(async () => ({ documents: [{ title: "Legacy result" }] }));

    await expect(processMcpToolCall({
      store,
      jobId,
      ...queued,
      reservationRequired: true,
      call
    })).rejects.toBeInstanceOf(StaleMcpToolRunError);
    expect(call).not.toHaveBeenCalled();
    expect((await store.getSnapshot()).toolRuns).toEqual([]);
  });

  it("rejects Worker arguments that do not match the durable MCP reservation", async () => {
    const { seed, connectorId, store } = configuredStore();
    const binding = roleBinding(seed);
    const connector = (await store.getSnapshot()).mcpConnectors.find((item) => item.id === connectorId)!;
    const queued = {
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...binding,
      connectorId,
      toolName: "search",
      toolSnapshot: { connectorName: connector.name, ...connector.toolRegistrations[0]! },
      connectorFingerprint: mcpConnectorExecutionFingerprint(connector, null),
      arguments: { query: "approved" },
      requestedBy: "owner" as const
    };
    const jobId = "tool-job-argument-mismatch";
    await store.reserveMcpToolCall(jobId, {
      ...queued,
      requestFingerprint: mcpToolRequestFingerprint(queued)
    });
    await store.markSpeakerTurnRunning(jobId);
    const call = vi.fn(async () => ({ documents: [] }));

    await expect(processMcpToolCall({
      store,
      jobId,
      ...queued,
      arguments: { query: "different" },
      reservationRequired: true,
      call
    })).rejects.toBeInstanceOf(StaleMcpToolRunError);
    expect(call).not.toHaveBeenCalled();
    expect((await store.getSnapshot()).toolRuns).toEqual([]);
  });

  it("rejects a queue fingerprint that does not match decrypted arguments before calling MCP", async () => {
    const { seed, connectorId, store } = configuredStore();
    const connector = (await store.getSnapshot()).mcpConnectors.find((item) => item.id === connectorId)!;
    const queued = {
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...roleBinding(seed),
      connectorId,
      toolName: "search",
      toolSnapshot: { connectorName: connector.name, ...connector.toolRegistrations[0]! },
      connectorFingerprint: mcpConnectorExecutionFingerprint(connector, null),
      arguments: { query: "approved" },
      requestedBy: "owner" as const
    };
    const jobId = "tool-job-queue-fingerprint-mismatch";
    const durableFingerprint = mcpToolRequestFingerprint(queued);
    await store.reserveMcpToolCall(jobId, { ...queued, requestFingerprint: durableFingerprint });
    await store.markSpeakerTurnRunning(jobId);
    const call = vi.fn(async () => ({ documents: [] }));

    await expect(processMcpToolCall({
      store,
      jobId,
      ...queued,
      requestFingerprint: mcpToolRequestFingerprint({ ...queued, arguments: { query: "tampered" } }),
      reservationRequired: true,
      call
    })).rejects.toBeInstanceOf(StaleMcpToolRunError);
    expect(call).not.toHaveBeenCalled();
    expect((await store.getSnapshot()).toolRuns).toEqual([]);
  });

  it("rejects queue metadata that diverges from the durable MCP reservation", async () => {
    const { seed, connectorId, store } = configuredStore();
    const binding = roleBinding(seed);
    const connector = (await store.getSnapshot()).mcpConnectors.find((item) => item.id === connectorId)!;
    const queued = {
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...binding,
      connectorId,
      toolName: "search",
      toolSnapshot: { connectorName: connector.name, ...connector.toolRegistrations[0]! },
      connectorFingerprint: mcpConnectorExecutionFingerprint(connector, null),
      arguments: { query: "approved" },
      requestedBy: "owner" as const
    };
    const tampered = { ...queued, roleRevision: queued.roleRevision + 1 };
    const jobId = "tool-job-metadata-mismatch";
    await store.reserveMcpToolCall(jobId, {
      ...queued,
      requestFingerprint: mcpToolRequestFingerprint(tampered)
    });
    await store.markSpeakerTurnRunning(jobId);
    const call = vi.fn(async () => ({ documents: [] }));

    await expect(processMcpToolCall({
      store,
      jobId,
      ...tampered,
      reservationRequired: true,
      call
    })).rejects.toThrow(/durable reservation/i);
    expect(call).not.toHaveBeenCalled();
    expect((await store.getSnapshot()).toolRuns).toEqual([]);
  });

  it("executes a keyed MCP reservation and persists the reservation fingerprint", async () => {
    const { seed, connectorId, store } = configuredStore();
    const vault = new SecretVault(Buffer.alloc(32, 22));
    const connector = (await store.getSnapshot()).mcpConnectors.find((item) => item.id === connectorId)!;
    const queued = {
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...roleBinding(seed),
      connectorId,
      toolName: "search",
      toolSnapshot: { connectorName: connector.name, ...connector.toolRegistrations[0]! },
      connectorFingerprint: mcpConnectorExecutionFingerprint(connector, null),
      arguments: { query: "keyed request" },
      requestedBy: "owner" as const
    };
    const jobId = "tool-job-keyed-reservation";
    const requestFingerprint = mcpToolRequestFingerprint(queued, vault);
    await store.reserveMcpToolCall(jobId, { ...queued, requestFingerprint });
    await store.markSpeakerTurnRunning(jobId);

    const utterance = await processMcpToolCall({
      store,
      jobId,
      ...queued,
      reservationRequired: true,
      secretVault: vault,
      call: vi.fn(async () => ({ documents: [] }))
    });

    expect(utterance.kind).toBe("verified");
    expect((await store.getSnapshot()).toolRuns[0]?.requestFingerprint).toBe(requestFingerprint);
    expect(requestFingerprint).toMatch(/^hmac-sha256:v1:[a-f0-9]{64}$/);
  });

  it("redacts sensitive fields, credential patterns, and echoed arguments before evidence is persisted", async () => {
    const { seed, connectorId, store } = configuredStore();
    const privateKey = "-----BEGIN PRIVATE KEY-----\nvery-private-material\n-----END PRIVATE KEY-----";
    const bearer = "Bearer top-secret-access-token";
    const argumentSecret = "owner-confidential-query";

    const utterance = await processMcpToolCall({
      store,
      jobId: "tool-job-redaction",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...roleBinding(seed),
      connectorId,
      toolName: "search",
      arguments: { query: argumentSecret, pin: 1234 },
      call: vi.fn(async () => ({
        [argumentSecret]: "echoed in an object key",
        authorization: bearer,
        nested: { apiKey: "sk-exposedcredential", result: `matched ${argumentSecret} and 1234` },
        text: `${privateKey}\n${bearer}\nhttps://owner:password@example.com/path`
      }))
    });

    expect(utterance.content).toContain("[REDACTED]");
    expect(utterance.content).toContain("[REDACTED_INPUT]");
    expect(utterance.content).not.toContain("top-secret-access-token");
    expect(utterance.content).not.toContain("sk-exposedcredential");
    expect(utterance.content).not.toContain("very-private-material");
    expect(utterance.content).not.toContain(argumentSecret);
    expect(utterance.content).not.toContain("owner:password");
    expect(utterance.content).not.toContain("1234");
  });

  it("redacts secrets embedded in compound result keys before the utterance is persisted", async () => {
    const { seed, connectorId, store } = configuredStore();
    const secrets = [
      "raw-db-password-value",
      "raw-oauth-access-token",
      "raw-integration-secret",
      "raw-service-api-key"
    ];

    const utterance = await processMcpToolCall({
      store,
      jobId: "tool-job-compound-key-redaction",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...roleBinding(seed),
      connectorId,
      toolName: "search",
      arguments: { query: "public policy" },
      call: vi.fn(async () => ({
        db_password_value: secrets[0],
        oauth_access_token_metadata: { value: secrets[1], expiresIn: 3600 },
        integration_secret_reference: secrets[2],
        service_api_key_hint: secrets[3],
        normal_metadata: { title: "Approved policy", status: "current" }
      }))
    });

    expect(utterance.content).toContain("Approved policy");
    expect(utterance.content).toContain('"normal_metadata"');
    for (const secret of secrets) expect(utterance.content).not.toContain(secret);

    const snapshot = await store.getSnapshot();
    const persistedUtterance = snapshot.utterances.find((item) => item.id === utterance.id);
    expect(persistedUtterance).toEqual(utterance);
    const persistedSnapshot = JSON.stringify(snapshot);
    for (const secret of secrets) expect(persistedSnapshot).not.toContain(secret);
  });

  it("validates the bounded argument contract before outbound execution and redacts its last permitted scalar", async () => {
    const { seed, connectorId, store } = configuredStore();
    const call = vi.fn(async () => ({ echoed: "last-permitted-secret" }));
    const boundedArguments = {
      first: Array.from({ length: 100 }, (_, index) => `first-${index}`),
      second: Array.from({ length: 100 }, (_, index) => `second-${index}`),
      third: Array.from({ length: 56 }, (_, index) => index === 55 ? "last-permitted-secret" : `third-${index}`)
    };

    const utterance = await processMcpToolCall({
      store,
      jobId: "tool-job-bounded-redaction",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...roleBinding(seed),
      connectorId,
      toolName: "search",
      arguments: boundedArguments,
      call
    });
    expect(utterance.content).toContain("[REDACTED_INPUT]");
    expect(utterance.content).not.toContain("last-permitted-secret");

    const rejectedCall = vi.fn();
    await expect(processMcpToolCall({
      store,
      jobId: "tool-job-oversized-arguments",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...roleBinding(seed),
      connectorId,
      toolName: "search",
      arguments: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`field_${index}`, index])),
      call: rejectedCall
    })).rejects.toThrow(/100 fields/i);
    expect(rejectedCall).not.toHaveBeenCalled();
  });

  it("replays a persisted Tool Run without calling the external MCP again", async () => {
    const { seed, connectorId, store } = configuredStore();
    const call = vi.fn(async () => ({ documents: [{ title: "Policy" }] }));
    const input = {
      store,
      jobId: "tool-job-replay",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...roleBinding(seed),
      connectorId,
      toolName: "search",
      arguments: { query: "MCP policy" },
      call
    };

    const first = await processMcpToolCall(input);
    const replay = await processMcpToolCall(input);

    expect(replay.id).toBe(first.id);
    expect(call).toHaveBeenCalledTimes(1);
    expect((await store.getSnapshot()).toolRuns).toHaveLength(1);
  });

  it("skips speaker admission when retrying delivery for a persisted Tool Run", async () => {
    const { seed, connectorId, store } = configuredStore();
    const input = {
      store,
      jobId: "tool-job-delivery-retry",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...roleBinding(seed),
      connectorId,
      toolName: "search",
      arguments: { query: "MCP policy" }
    };
    const call = vi.fn(async () => ({ documents: [{ title: "Policy" }] }));
    const persisted = await processMcpToolCall({ ...input, call });
    const markSpeakerTurnRunning = vi.spyOn(store, "markSpeakerTurnRunning");

    const prepared = await prepareMcpToolCallExecution(input);

    expect(prepared).toEqual({ utterance: persisted, queueItem: null, inProgress: false, replayed: true });
    expect(markSpeakerTurnRunning).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledOnce();
  });

  it("lets only one overlapping delivery claim the external MCP call", async () => {
    const { seed, connectorId, store } = configuredStore();
    const connector = (await store.getSnapshot()).mcpConnectors.find((item) => item.id === connectorId)!;
    const jobId = "tool-job-overlapping-delivery";
    const execution = {
      store,
      jobId,
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...roleBinding(seed),
      connectorId,
      toolName: "search",
      toolSnapshot: { connectorName: connector.name, ...connector.toolRegistrations[0]! },
      connectorFingerprint: mcpConnectorExecutionFingerprint(connector, null),
      arguments: { query: "one external call" },
      requestedBy: "owner" as const,
      reservationRequired: true
    };
    const requestFingerprint = mcpToolRequestFingerprint(execution);
    await store.reserveMcpToolCall(jobId, { ...execution, requestFingerprint });
    const prepared = await Promise.all([
      prepareMcpToolCallExecution(execution),
      prepareMcpToolCallExecution(execution)
    ]);
    const call = vi.fn(async () => ({ documents: [] }));

    await Promise.all(prepared.map(async (item) => {
      if (item.inProgress) return;
      await processMcpToolCall({ ...execution, requestFingerprint, call });
    }));

    expect(prepared.filter((item) => item.queueItem !== null)).toHaveLength(1);
    expect(prepared.filter((item) => item.inProgress)).toHaveLength(1);
    expect(call).toHaveBeenCalledOnce();
    expect((await store.getSnapshot()).toolRuns).toHaveLength(1);
  });

  it("rejects a stalled redelivery instead of acknowledging a running MCP reservation without evidence", async () => {
    const { seed, connectorId, store } = configuredStore();
    const connector = (await store.getSnapshot()).mcpConnectors.find((item) => item.id === connectorId)!;
    const jobId = "tool-job-stalled-redelivery";
    const execution = {
      store,
      jobId,
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...roleBinding(seed),
      connectorId,
      toolName: "search",
      toolSnapshot: { connectorName: connector.name, ...connector.toolRegistrations[0]! },
      connectorFingerprint: mcpConnectorExecutionFingerprint(connector, null),
      arguments: { query: "stalled delivery" },
      requestedBy: "owner" as const,
      reservationRequired: true
    };
    const requestFingerprint = mcpToolRequestFingerprint(execution);
    await store.reserveMcpToolCall(jobId, { ...execution, requestFingerprint });

    const first = await prepareMcpToolCallExecution({ ...execution, deliveryAttempt: 1 });

    expect(first.queueItem).not.toBeNull();
    await expect(prepareMcpToolCallExecution({ ...execution, deliveryAttempt: 2 }))
      .rejects.toBeInstanceOf(McpToolOutcomeUnknownError);
    expect((await store.getSnapshot()).toolRuns).toEqual([]);
  });

  it("rejects a reused job ID when the tool arguments changed", async () => {
    const { seed, connectorId, store } = configuredStore();
    const call = vi.fn(async () => ({ documents: [{ title: "Policy" }] }));
    const baseInput = {
      store,
      jobId: "tool-job-fingerprint",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...roleBinding(seed),
      connectorId,
      toolName: "search",
      call
    };

    await processMcpToolCall({ ...baseInput, arguments: { query: "first" } });
    await expect(processMcpToolCall({ ...baseInput, arguments: { query: "changed" } }))
      .rejects.toThrow(/job ID|different meeting action/i);

    expect(call).toHaveBeenCalledTimes(1);
    expect((await store.getSnapshot()).toolRuns).toHaveLength(1);
  });

  it("fails closed before MCP when a configured secret cannot be loaded", async () => {
    const { seed, connectorId, store } = configuredStore();
    const state = (store as unknown as { state: { mcpConnectors: Array<{ id: string; hasSecret: boolean }> } }).state;
    state.mcpConnectors.find((item) => item.id === connectorId)!.hasSecret = true;
    const call = vi.fn();

    await expect(processMcpToolCall({
      store,
      jobId: "tool-job-secret-missing",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...roleBinding(seed),
      connectorId,
      toolName: "search",
      arguments: {},
      call
    })).rejects.toThrow(/secret/i);
    expect(call).not.toHaveBeenCalled();
  });

  it("denies an allowlisted tool whose Catalog registration is missing", async () => {
    const { seed, connectorId, store } = configuredStore();
    const state = (store as unknown as { state: { mcpConnectors: Array<{ id: string; toolRegistrations: unknown[] }> } }).state;
    state.mcpConnectors.find((item) => item.id === connectorId)!.toolRegistrations = [];
    const call = vi.fn();

    await expect(processMcpToolCall({
      store,
      jobId: "tool-job-catalog-missing",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...roleBinding(seed),
      connectorId,
      toolName: "search",
      arguments: {},
      call
    })).rejects.toThrow(/Catalog|allowlist/i);
    expect(call).not.toHaveBeenCalled();
  });

  it("denies tools that are not granted to the Agent", async () => {
    const { seed, connectorId, store } = configuredStore();
    await expect(processMcpToolCall({
      store,
      jobId: "tool-job-denied",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[2]!.id,
      ...roleBinding(seed, seed.agents[2]!.id),
      connectorId,
      toolName: "search",
      arguments: {},
      call: vi.fn()
    })).rejects.toThrow(/grant|allowlist|approved/i);
  });

  it("rejects a disabled Agent before outbound MCP execution", async () => {
    const { seed, connectorId, store } = configuredStore();
    await store.setAgentStatus(seed.agents[0]!.id, { status: "disabled", expectedRevision: 1 });
    const call = vi.fn(async () => ({ documents: [] }));

    await expect(processMcpToolCall({
      store,
      jobId: "tool-job-disabled-agent",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...roleBinding(seed),
      connectorId,
      toolName: "search",
      arguments: {},
      call
    })).rejects.toBeInstanceOf(StaleMcpToolRunError);
    expect(call).not.toHaveBeenCalled();
  });

  it("does not authorize MCP from a grant added only to an unpublished Agent draft", async () => {
    const configured = configuredStore();
    configured.seed.agents[0]!.toolGrants = [];
    const store = new InMemoryPlatformStore(configured.seed);
    await store.updateAgent(configured.seed.agents[0]!.id, {
      toolGrants: [{ connectorId: configured.connectorId, toolName: "search" }]
    });
    const call = vi.fn(async () => ({ documents: [] }));

    await expect(processMcpToolCall({
      store,
      jobId: "tool-job-unpublished-grant",
      meetingId: configured.seed.meetings[0]!.id,
      agentId: configured.seed.agents[0]!.id,
      ...roleBinding(configured.seed),
      connectorId: configured.connectorId,
      toolName: "search",
      arguments: {},
      call
    })).rejects.toThrow(/grant|revision|approved/i);
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    { toolPolicy: "none" as const, dataPolicy: "agent_declared_scope" as const },
    { toolPolicy: "agent_read_only_grants" as const, dataPolicy: "meeting_only" as const }
  ])("denies MCP before outbound execution when the Meeting Role snapshot is restrictive", async ({ toolPolicy, dataPolicy }) => {
    const { seed, connectorId } = configuredStore();
    const assignment = seed.participants.find((item) => item.agentId === seed.agents[0]!.id)!;
    assignment.roleSnapshot = { ...assignment.roleSnapshot, toolPolicy, dataPolicy };
    assignment.roleHistory[assignment.roleHistory.length - 1]!.roleSnapshot = structuredClone(assignment.roleSnapshot);
    const restrictedStore = new InMemoryPlatformStore(seed);
    const call = vi.fn();

    await expect(processMcpToolCall({
      store: restrictedStore,
      jobId: `tool-job-role-${toolPolicy}-${dataPolicy}`,
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...roleBinding(seed),
      connectorId,
      toolName: "search",
      arguments: {},
      call
    })).rejects.toThrow(/Role policy/i);
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    { label: "disabled connector", enabled: false, approvedTools: ["search"] },
    { label: "removed allowlist tool", enabled: true, approvedTools: [] }
  ])("rejects a stale grant for a $label before calling MCP", async ({ enabled, approvedTools }) => {
    const { seed, connectorId } = configuredStore();
    seed.mcpConnectors[0]!.enabled = enabled;
    seed.mcpConnectors[0]!.approvedTools = approvedTools;
    const store = new InMemoryPlatformStore(seed);
    const call = vi.fn();

    await expect(processMcpToolCall({
      store,
      jobId: `tool-job-stale-${enabled}-${approvedTools.length}`,
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...roleBinding(seed),
      connectorId,
      toolName: "search",
      arguments: {},
      call
    })).rejects.toThrow(/unavailable|grant|allowlist/i);
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects a queued MCP call whose Participant Role revision changed before outbound execution", async () => {
    const { seed, connectorId, store } = configuredStore();
    const queuedBinding = roleBinding(seed);
    const snapshot = await store.getSnapshot();
    const participant = snapshot.participants.find((item) => item.id === queuedBinding.participantId)!;
    const targetRole = snapshot.roles.find((role) => role.id !== participant.roleId)!;
    await store.switchParticipantRole(participant.meetingId, participant.id, {
      roleId: targetRole.id,
      expectedRoleRevision: participant.roleRevision,
      reason: "Change Role before the queued tool starts."
    });
    const call = vi.fn(async () => ({ documents: [] }));

    await expect(processMcpToolCall({
      store,
      jobId: "tool-job-role-stale-before-call",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...queuedBinding,
      connectorId,
      toolName: "search",
      arguments: {},
      call
    })).rejects.toBeInstanceOf(StaleMcpToolRunError);
    expect(call).not.toHaveBeenCalled();
    expect((await store.getSnapshot()).toolRuns).toEqual([]);
  });

  it("rejects MCP evidence when the Participant Role revision changes during the external call", async () => {
    const { seed, connectorId, store } = configuredStore();
    const queuedBinding = roleBinding(seed);
    let releaseCall!: () => void;
    let markStarted!: () => void;
    const callGate = new Promise<void>((resolve) => { releaseCall = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const processing = processMcpToolCall({
      store,
      jobId: "tool-job-role-changed-during-call",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...queuedBinding,
      connectorId,
      toolName: "search",
      arguments: {},
      call: async () => {
        markStarted();
        await callGate;
        return { documents: [{ title: "Stale evidence" }] };
      }
    });

    await started;
    const snapshot = await store.getSnapshot();
    const participant = snapshot.participants.find((item) => item.id === queuedBinding.participantId)!;
    const targetRole = snapshot.roles.find((role) => role.id !== participant.roleId)!;
    await store.switchParticipantRole(participant.meetingId, participant.id, {
      roleId: targetRole.id,
      expectedRoleRevision: participant.roleRevision,
      reason: "Change Role while the tool is running."
    });
    releaseCall();

    await expect(processing).rejects.toBeInstanceOf(McpToolOutcomeUnknownError);
    expect((await store.getSnapshot()).toolRuns).toEqual([]);
  });

  it("rejects MCP evidence when the queued Connector changes during the external call", async () => {
    const { seed, connectorId, store } = configuredStore();
    const participantBinding = roleBinding(seed);
    const connector = (await store.getSnapshot()).mcpConnectors.find((item) => item.id === connectorId)!;
    const queued = {
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...participantBinding,
      connectorId,
      toolName: "search",
      toolSnapshot: { connectorName: connector.name, ...connector.toolRegistrations[0]! },
      connectorFingerprint: mcpConnectorExecutionFingerprint(connector, null),
      arguments: {},
      requestedBy: "owner" as const
    };
    await store.reserveMcpToolCall("tool-job-connector-changed-during-call", {
      ...queued,
      requestFingerprint: mcpToolRequestFingerprint(queued)
    });
    await store.markSpeakerTurnRunning("tool-job-connector-changed-during-call");
    let releaseCall!: () => void;
    let markStarted!: () => void;
    const callGate = new Promise<void>((resolve) => { releaseCall = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const processing = processMcpToolCall({
      store,
      jobId: "tool-job-connector-changed-during-call",
      ...queued,
      reservationRequired: true,
      call: async () => {
        markStarted();
        await callGate;
        return { documents: [{ title: "Stale connector evidence" }] };
      }
    });

    await started;
    await store.updateMcpConnector(connectorId, {
      expectedRevision: connector.revision,
      baseUrl: "http://10.20.30.42/mcp"
    });
    releaseCall();

    await expect(processing).rejects.toBeInstanceOf(McpToolOutcomeUnknownError);
    await expect(recordReservedMcpToolFailure({
      store,
      jobId: "tool-job-connector-changed-during-call",
      message: "The Connector changed after outbound execution; manual reconciliation is required."
    })).resolves.toMatchObject({ recorded: true, existingRunStatus: "failed" });
    const reconciled = await store.getSnapshot();
    expect(reconciled.speakerQueue).toEqual([]);
    expect(reconciled.toolRuns).toEqual([
      expect.objectContaining({ jobId: "tool-job-connector-changed-during-call", status: "failed" })
    ]);
    expect(reconciled.meetings.find((item) => item.id === queued.meetingId)?.state).toBe("paused");
  });

  it("does not pause the Meeting when final failure recording has a stale Role binding", async () => {
    const { seed, connectorId, store } = configuredStore();
    const queuedBinding = roleBinding(seed);
    const snapshot = await store.getSnapshot();
    const participant = snapshot.participants.find((item) => item.id === queuedBinding.participantId)!;
    const targetRole = snapshot.roles.find((role) => role.id !== participant.roleId)!;
    await store.switchParticipantRole(participant.meetingId, participant.id, {
      roleId: targetRole.id,
      expectedRoleRevision: participant.roleRevision,
      reason: "Invalidate the failed tool job."
    });

    await expect(recordMcpToolFailure({
      store,
      jobId: "tool-job-stale-failure",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...queuedBinding,
      connectorId,
      toolName: "search",
      arguments: {},
      message: "Connector unavailable."
    })).resolves.toBe(false);
    const after = await store.getSnapshot();
    expect(after.meetings[0]!.state).toBe("active");
    expect(after.toolRuns).toEqual([]);
  });

  it("pauses an active meeting after the final MCP failure", async () => {
    const { seed, connectorId, store } = configuredStore();
    const setMeetingState = vi.spyOn(store, "setMeetingState");
    await recordMcpToolFailure({
      store,
      jobId: "tool-job-failure",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...roleBinding(seed),
      connectorId,
      toolName: "search",
      arguments: { credential: "failure-secret" },
      message: "工具連線失敗：failure-secret。"
    });
    const snapshot = await store.getSnapshot();
    expect(snapshot.meetings[0]!.state).toBe("paused");
    expect(snapshot.utterances.at(-1)).toMatchObject({ kind: "failure", content: "工具連線失敗：[REDACTED_INPUT]。", turnId: "tool-job-failure" });
    expect(snapshot.toolRuns).toEqual([
      expect.objectContaining({ jobId: "tool-job-failure", status: "failed", utteranceId: snapshot.utterances.at(-1)!.id })
    ]);
    expect(setMeetingState).not.toHaveBeenCalled();
  });

  it("records an encrypted-payload failure against its keyed durable reservation without plaintext arguments", async () => {
    const { seed, connectorId, store } = configuredStore();
    const vault = new SecretVault(Buffer.alloc(32, 23));
    const connector = (await store.getSnapshot()).mcpConnectors.find((item) => item.id === connectorId)!;
    const queued = {
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      ...roleBinding(seed),
      connectorId,
      toolName: "search",
      toolSnapshot: { connectorName: connector.name, ...connector.toolRegistrations[0]! },
      connectorFingerprint: mcpConnectorExecutionFingerprint(connector, null),
      arguments: { query: "ciphertext-could-not-be-opened" },
      requestedBy: "owner" as const
    };
    const jobId = "tool-job-encrypted-failure";
    const requestFingerprint = mcpToolRequestFingerprint(queued, vault);
    await store.reserveMcpToolCall(jobId, { ...queued, requestFingerprint });

    await expect(recordReservedMcpToolFailure({
      store,
      jobId,
      message: "Encrypted MCP arguments could not be loaded."
    })).resolves.toMatchObject({ recorded: true, queueItem: { jobId } });

    const snapshot = await store.getSnapshot();
    expect(snapshot.meetings[0]!.state).toBe("paused");
    expect(snapshot.toolRuns[0]).toMatchObject({
      jobId,
      requestFingerprint,
      connectorId,
      toolSnapshot: queued.toolSnapshot,
      status: "failed"
    });
  });
});
