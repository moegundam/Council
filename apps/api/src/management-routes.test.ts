import { describe, expect, it, vi } from "vitest";
import type { AgentRevision } from "@council/contracts";
import { InMemoryPlatformStore, StoreNotFoundError } from "@council/database";
import { SecretVault } from "@council/domain";
import { createApp } from "./app.js";

class MissingPublishedRevisionStore extends InMemoryPlatformStore {
  override async getAgentRevision(agentId: string, revision: number): Promise<AgentRevision> {
    void agentId;
    void revision;
    throw new StoreNotFoundError("Published Agent revision is missing.");
  }
}

class FailingPublishedRevisionStore extends InMemoryPlatformStore {
  override async getAgentRevision(agentId: string, revision: number): Promise<AgentRevision> {
    void agentId;
    void revision;
    throw new Error("Revision database is unavailable.");
  }
}

class CountingPublishedRevisionStore extends InMemoryPlatformStore {
  revisionReadCount = 0;

  override async getAgentRevision(agentId: string, revision: number): Promise<AgentRevision> {
    this.revisionReadCount += 1;
    return super.getAgentRevision(agentId, revision);
  }
}

async function createApprovedCapabilityPack(store: InMemoryPlatformStore) {
  const imageDigest = `sha256:${"d".repeat(64)}`;
  const created = await store.createToolPack({
    name: "Capability docs",
    version: "1.2.3",
    description: "Read-only documentation capability.",
    owner: "Platform Owner",
    sourceReference: `registry.example.com/council/capability-docs@${imageDigest}`,
    imageDigest,
    tools: [{
      name: "search_docs",
      kind: "command",
      goal: "Search the approved documentation snapshot.",
      access: "read_only",
      argv: { executable: "/usr/bin/rg", fixedArguments: ["--json"] },
      env: { allowedNames: ["LANG"] },
      stdin: { mode: "none" }
    }]
  });
  const validated = await store.validateToolPack(created.id, {
    expectedRevision: created.revision,
    manifestDigest: created.manifestDigest,
    result: "passed",
    summary: "Manifest and read-only behavior verified."
  });
  return store.approveToolPack(created.id, {
    expectedRevision: validated.revision,
    manifestDigest: validated.manifestDigest
  });
}

describe("management control-plane routes", () => {
  it("lists Runtime Profiles through the focused Store read", async () => {
    const store = new InMemoryPlatformStore();
    const app = await createApp({ store, authDisabled: true });
    const snapshot = vi.spyOn(store, "getSnapshot").mockRejectedValue(new Error("Runtime Profile listing must not load the platform snapshot."));

    try {
      const response = await app.inject({ method: "GET", url: "/api/runtime-profiles" });

      expect(response.statusCode).toBe(200);
      expect(snapshot).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("binds OMP Runtime Profiles to the operator-approved Sandbox Profile", async () => {
    const store = new InMemoryPlatformStore();
    const connector = await store.createModelConnector({
      name: "OMP local model",
      location: "local",
      baseUrl: "http://model-tunnel:4001/v1",
      model: "omp-local-test"
    });
    const sandboxProfileId = "70000000-0000-4000-8000-000000000204";
    const app = await createApp({
      store,
      authDisabled: true,
      ompRuntimeEnabled: true,
      ompRuntime: {
        enabled: true,
        sandboxProfileId,
        sandboxImageDigest: `sha256:${"a".repeat(64)}`,
        workspaceSourceId: "council-canary",
        workspaceArchiveDigest: `sha256:${"b".repeat(64)}`,
        hostToolsEnabled: false,
        check: async () => undefined
      }
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/runtime-profiles",
      headers: { "idempotency-key": "omp-operator-bound-profile" },
      payload: {
        name: "OMP canary",
        harnessKind: "pi",
        modelConnectorId: connector.id,
        sandboxProfileId: null,
        policy: "isolated_exec",
        capabilities: ["text", "abort", "resume", "file_read", "file_write", "process"],
        timeoutMs: 2 * 60 * 60_000,
        maxConcurrency: 1,
        enabled: true
      }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ harnessKind: "pi", sandboxProfileId });

    const drifted = await app.inject({
      method: "POST",
      url: "/api/runtime-profiles",
      headers: { "idempotency-key": "omp-drifted-profile" },
      payload: {
        name: "Drifted OMP",
        harnessKind: "pi",
        modelConnectorId: connector.id,
        sandboxProfileId: "70000000-0000-4000-8000-000000000205",
        policy: "isolated_exec",
        capabilities: ["text", "abort", "resume", "file_read", "file_write", "process"],
        timeoutMs: 2 * 60 * 60_000,
        maxConcurrency: 1,
        enabled: true
      }
    });
    expect(drifted.statusCode).toBe(409);
    expect(drifted.json()).toMatchObject({ error: { code: "OMP_SANDBOX_PROFILE_MISMATCH" } });
    await app.close();
  });

  it("blocks legacy Meeting Presets whose active Team references a deleted Role", async () => {
    const stagingStore = new InMemoryPlatformStore();
    const seed = await stagingStore.getSnapshot();
    const agent = seed.agents[0]!;
    const role = seed.roles[0]!;
    const now = new Date().toISOString();
    role.deletedAt = now;
    const teamId = crypto.randomUUID();
    const presetId = crypto.randomUUID();
    seed.agentTeams = [{
      id: teamId,
      revision: 1,
      name: "Legacy dangling-role team",
      description: "Imported before Role reference validation existed.",
      status: "active",
      members: [{ agentId: agent.id, roleId: role.id, isChair: true }],
      createdAt: now,
      updatedAt: now
    }];
    seed.meetingPresets = [{
      id: presetId,
      revision: 1,
      name: "Legacy dangling-role preset",
      description: "Must fail closed during preflight.",
      teamId,
      mode: "chaired",
      automation: "suggest",
      durationMinutes: 30,
      agendaItems: [{ title: "Review", description: "Review legacy references." }],
      status: "active",
      createdAt: now,
      updatedAt: now
    }];
    const app = await createApp({ store: new InMemoryPlatformStore(seed), authDisabled: true });

    const response = await app.inject({
      method: "GET",
      url: `/api/meeting-presets/${presetId}/preflight`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      presetId,
      status: "blocked",
      invalidRoleIds: [role.id]
    });
    await app.close();
  });

  it("versions Runtime Profiles and binds an immutable revision to a published Agent", async () => {
    const store = new InMemoryPlatformStore();
    const app = await createApp({ store, authDisabled: true });
    const initial = await store.getSnapshot();
    const agent = initial.agents[0]!;
    const connector = await store.createModelConnector({
      name: "Runtime test model",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "runtime-test"
    });
    const prompt = await store.createPrompt({
      name: "Runtime test prompt",
      kind: "agent",
      description: "Published Prompt required by Agent readiness.",
      owner: "Platform Owner",
      content: "聚焦 {{MEETING_GOAL}}。",
      variables: ["MEETING_GOAL"]
    });
    await store.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 });

    const listed = await app.inject({ method: "GET", url: "/api/runtime-profiles" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().runtimeProfiles).toContainEqual(expect.objectContaining({
      harnessKind: "openai_compatible",
      enabled: true,
      revision: 1
    }));

    const created = await app.inject({
      method: "POST",
      url: "/api/runtime-profiles",
      headers: { "idempotency-key": "runtime-profile-versioning-fixture" },
      payload: {
        name: "Bound text runtime",
        harnessKind: "openai_compatible",
        modelConnectorId: null,
        sandboxProfileId: null,
        policy: "text_only",
        capabilities: ["text", "abort"],
        timeoutMs: 60_000,
        maxConcurrency: 1,
        enabled: true
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ revision: 1, policy: "text_only" });
    const profileId = created.json().id as string;

    const bound = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}`,
      payload: {
        expectedDraftRevision: agent.draftRevision,
        modelConnectorId: connector.id,
        promptBinding: { promptId: prompt.id, version: 1 },
        runtimeProfileBinding: { profileId, revision: 1 }
      }
    });
    expect(bound.statusCode).toBe(200);
    const draftRevision = bound.json().draftRevision as number;
    const publish = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/publish`,
      payload: { expectedDraftRevision: draftRevision }
    });
    expect(publish.statusCode).toBe(200);

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/runtime-profiles/${profileId}`,
      payload: { expectedRevision: 1, timeoutMs: 75_000 }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ revision: 2, timeoutMs: 75_000 });

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/runtime-profiles/${profileId}`,
      payload: { expectedRevision: 1, timeoutMs: 80_000 }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: "REVISION_CONFLICT" } });

    const versions = await app.inject({ method: "GET", url: `/api/runtime-profiles/${profileId}/revisions` });
    expect(versions.statusCode).toBe(200);
    expect(versions.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ profileId, revision: 1, timeoutMs: 60_000 }),
      expect.objectContaining({ profileId, revision: 2, timeoutMs: 75_000 })
    ]));

    const effective = await app.inject({ method: "GET", url: `/api/agents/${agent.id}/effective-configuration` });
    expect(effective.statusCode).toBe(200);
    expect(effective.json()).toMatchObject({
      runtimeProfile: {
        binding: { profileId, revision: 1 },
        revision: { profileId, revision: 1, timeoutMs: 60_000 },
        current: { id: profileId, revision: 2, timeoutMs: 75_000 }
      },
      readiness: { status: expect.not.stringMatching(/^blocked$/) }
    });

    const disabled = await app.inject({
      method: "PATCH",
      url: `/api/runtime-profiles/${profileId}`,
      payload: { expectedRevision: 2, enabled: false }
    });
    expect(disabled.statusCode).toBe(200);
    const blockedReadiness = await app.inject({ method: "GET", url: `/api/agents/${agent.id}/readiness` });
    expect(blockedReadiness.json()).toMatchObject({
      status: "blocked",
      checks: expect.arrayContaining([expect.objectContaining({ code: "runtime", status: "blocked" })])
    });
    await app.close();
  });

  it("does not invent a published revision for a draft-only Agent", async () => {
    const store = new InMemoryPlatformStore();
    const app = await createApp({ store, authDisabled: true });
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "idempotency-key": "draft-only-agent" },
      payload: {
        name: "Draft-only Agent",
        goalSummary: "Remain visibly unpublished until an explicit publish succeeds.",
        toolsSummary: "No tools.",
        dataSummary: "No data."
      }
    });
    expect(created.statusCode).toBe(201);

    const effective = await app.inject({
      method: "GET",
      url: `/api/agents/${created.json().id}/effective-configuration`
    });
    expect(effective.statusCode).toBe(200);
    expect(effective.json()).toMatchObject({
      source: { kind: "draft", revision: 1 },
      agent: { draftRevision: 1, publishedRevision: null },
      readiness: { status: "blocked" }
    });
    await app.close();
  });

  it("keeps a disabled Agent on its immutable published configuration while readiness is blocked", async () => {
    const store = new InMemoryPlatformStore();
    const initial = await store.getSnapshot();
    const agent = initial.agents[0]!;
    const updated = await store.updateAgent(agent.id, { name: "Mutable disabled draft" });
    await store.setAgentStatus(agent.id, { status: "disabled", expectedRevision: updated.draftRevision! });
    const app = await createApp({ store, authDisabled: true });

    const effective = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/effective-configuration`
    });

    expect(effective.statusCode).toBe(200);
    expect(effective.json()).toMatchObject({
      source: { kind: "published", revision: 1 },
      agent: {
        id: agent.id,
        name: agent.name,
        lifecycleStatus: "disabled",
        draftRevision: 2,
        publishedRevision: 1
      },
      readiness: { status: "blocked" }
    });
    expect(effective.json().agent.name).not.toBe("Mutable disabled draft");
    await app.close();
  });

  it("reads an available published revision only once while building the summary", async () => {
    const store = new CountingPublishedRevisionStore();
    const agent = (await store.getSnapshot()).agents[0]!;
    const app = await createApp({ store, authDisabled: true });

    const effective = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/effective-configuration`
    });

    expect(effective.statusCode).toBe(200);
    expect(effective.json()).toMatchObject({ source: { kind: "published", revision: 1 } });
    expect(store.revisionReadCount).toBe(1);
    await app.close();
  });

  it("reports a claimed missing published revision without presenting the mutable draft as published", async () => {
    const stagingStore = new InMemoryPlatformStore();
    const pack = await createApprovedCapabilityPack(stagingStore);
    const seed = await stagingStore.getSnapshot();
    const agent = seed.agents[0]!;
    const modelId = crypto.randomUUID();
    const credentialId = crypto.randomUUID();
    const connectorId = crypto.randomUUID();
    const promptId = crypto.randomUUID();
    const now = new Date().toISOString();
    seed.credentials = [{
      id: credentialId,
      name: "Mutable draft credential",
      provider: "private-provider",
      kind: "api_key",
      location: "cloud",
      status: "active",
      hasSecret: true,
      secretRevision: 3,
      maskedHint: "...1234",
      expiresAt: null,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
      rotatedAt: now
    }];
    seed.modelConnectors.push({
      id: modelId,
      revision: 1,
      name: "Mutable draft model",
      location: "cloud",
      baseUrl: "https://models.internal.example/v1",
      model: "mutable-draft-model",
      enabled: true,
      hasSecret: true,
      secretRevision: 3,
      credentialId
    });
    seed.mcpConnectors.push({
      id: connectorId,
      revision: 1,
      name: "Mutable draft MCP",
      location: "local",
      baseUrl: "http://127.0.0.1:4311",
      approvedTools: ["search_docs"],
      toolRegistrations: [{
        toolName: "search_docs",
        displayName: "Search docs",
        kind: "mcp_tool",
        version: "1.0.0",
        owner: "Platform Owner",
        goal: "Search mutable draft documentation."
      }],
      enabled: true,
      hasSecret: false
    });
    seed.prompts = [{
      id: promptId,
      name: "Mutable draft prompt",
      kind: "agent",
      description: "Must not be presented as effective.",
      owner: "Platform Owner",
      status: "published",
      currentVersion: 1,
      publishedVersion: 1,
      createdAt: now,
      updatedAt: now
    }];
    Object.assign(agent, {
      name: "Mutable fallback draft",
      modelConnectorId: modelId,
      skillIds: [seed.skills[0]!.id],
      toolGrants: [{ connectorId, toolName: "search_docs" }],
      toolPackGrants: [{
        packId: pack.id,
        revision: pack.revision,
        manifestDigest: pack.manifestDigest,
        toolName: "search_docs"
      }],
      promptBinding: { promptId, version: 1 },
      lifecycleStatus: "draft",
      draftRevision: 2,
      publishedRevision: 1
    });
    const store = new MissingPublishedRevisionStore(seed);
    const app = await createApp({ store, authDisabled: true });

    const effective = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/effective-configuration`
    });

    expect(effective.statusCode).toBe(200);
    const payload = effective.json();
    expect(payload).toMatchObject({
      source: { kind: "published_missing", revision: 1 },
      agent: {
        id: agent.id,
        name: "Mutable fallback draft",
        draftRevision: 2,
        publishedRevision: 1
      },
      bindingCounts: {
        skills: { configured: 1, ready: 0 },
        tools: { configured: 1, ready: 0 },
        toolPacks: { configured: 1, ready: 0 }
      },
      readiness: { status: "blocked" }
    });
    expect(payload).toMatchObject({
      model: null,
      credential: null,
      prompt: null,
      runtimeProfile: null,
      skills: [],
      tools: [],
      toolPacks: []
    });
    await app.close();
  });

  it("returns HTTP 500 when the published revision store fails", async () => {
    const store = new FailingPublishedRevisionStore();
    const agent = (await store.getSnapshot()).agents[0]!;
    const app = await createApp({ store, authDisabled: true });

    const effective = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/effective-configuration`
    });

    expect(effective.statusCode).toBe(500);
    expect(effective.json()).not.toMatchObject({ source: { kind: "published_missing" } });
    await app.close();
  });

  it("returns compact ready-only capability summaries, counts every binding, and excludes inactive role memberships", async () => {
    const stagingStore = new InMemoryPlatformStore();
    const imageDigest = `sha256:${"d".repeat(64)}`;
    const createdPack = await stagingStore.createToolPack({
      name: "Capability docs",
      version: "1.2.3",
      description: "Read-only documentation capability.",
      owner: "Platform Owner",
      sourceReference: `registry.example.com/council/capability-docs@${imageDigest}`,
      imageDigest,
      tools: [{
        name: "search_docs",
        kind: "command",
        goal: "Search the approved documentation snapshot.",
        access: "read_only",
        argv: { executable: "/usr/bin/rg", fixedArguments: ["--json"] },
        env: { allowedNames: ["LANG"] },
        stdin: { mode: "none" }
      }]
    });
    const validatedPack = await stagingStore.validateToolPack(createdPack.id, {
      expectedRevision: createdPack.revision,
      manifestDigest: createdPack.manifestDigest,
      result: "passed",
      summary: "Manifest and read-only behavior verified."
    });
    const pack = await stagingStore.approveToolPack(createdPack.id, {
      expectedRevision: validatedPack.revision,
      manifestDigest: validatedPack.manifestDigest
    });
    const seed = await stagingStore.getSnapshot();
    const agent = seed.agents[0]!;
    const readySkill = seed.skills[0]!;
    const missingSkillId = crypto.randomUUID();
    const modelId = crypto.randomUUID();
    const credentialId = crypto.randomUUID();
    const connectorId = crypto.randomUUID();
    const currentRoleId = crypto.randomUUID();
    const deletedRoleId = crypto.randomUUID();
    const now = new Date().toISOString();
    const registration = {
      toolName: "search_docs",
      displayName: "Search docs",
      kind: "mcp_tool" as const,
      version: "2.0.0",
      owner: "Platform Owner",
      goal: "Search approved documentation."
    };
    const currentRole = {
      id: currentRoleId,
      name: "Capability reviewer",
      usageContext: "Capability reviews",
      responsibility: "Review current Agent capabilities.",
      speakingGuidance: "State readiness evidence.",
      decisionScope: "Recommend capability changes.",
      constraints: "Do not expose secret material.",
      version: 4,
      templateKey: null,
      toolPolicy: "agent_read_only_grants" as const,
      dataPolicy: "agent_declared_scope" as const,
      deletedAt: null
    };
    const deletedRole = {
      ...currentRole,
      id: deletedRoleId,
      name: "Deleted role",
      version: 1,
      deletedAt: now
    };
    seed.roles.push(currentRole, deletedRole);
    seed.credentials = [{
      id: credentialId,
      name: "Capability credential",
      provider: "private-provider",
      kind: "api_key",
      location: "cloud",
      status: "active",
      hasSecret: true,
      secretRevision: 7,
      maskedHint: "...7890",
      expiresAt: null,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
      rotatedAt: now
    }];
    seed.modelConnectors.push({
      id: modelId,
      revision: 1,
      name: "Capability model",
      location: "cloud",
      baseUrl: "https://models.internal.example/v1",
      model: "capability-model-v1",
      enabled: true,
      hasSecret: true,
      secretRevision: 7,
      credentialId
    });
    seed.mcpConnectors.push({
      id: connectorId,
      revision: 1,
      name: "Capability MCP",
      location: "local",
      baseUrl: "http://127.0.0.1:4310",
      approvedTools: [registration.toolName],
      toolRegistrations: [registration],
      enabled: true,
      hasSecret: false
    });
    seed.agentTeams = [{
      id: crypto.randomUUID(),
      revision: 1,
      name: "Current capability team",
      description: "Active team with a current role.",
      status: "active",
      members: [{ agentId: agent.id, roleId: currentRole.id, isChair: true }],
      createdAt: now,
      updatedAt: now
    }, {
      id: crypto.randomUUID(),
      revision: 1,
      name: "Archived capability team",
      description: "Must not appear.",
      status: "archived",
      members: [{ agentId: agent.id, roleId: currentRole.id, isChair: true }],
      createdAt: now,
      updatedAt: now
    }, {
      id: crypto.randomUUID(),
      revision: 1,
      name: "Deleted-role capability team",
      description: "Must not appear.",
      status: "active",
      members: [{ agentId: agent.id, roleId: deletedRole.id, isChair: true }],
      createdAt: now,
      updatedAt: now
    }];
    Object.assign(agent, {
      name: "Mutable capability draft",
      lifecycleStatus: "published",
      draftRevision: 2,
      publishedRevision: 1
    });
    const revision: AgentRevision = {
      agentId: agent.id,
      revision: 1,
      name: "Immutable capability Agent",
      description: "Published capability configuration.",
      modelConnectorId: modelId,
      goalSummary: "Report ready capabilities.",
      toolsSummary: "Expose only ready tool summaries.",
      dataSummary: "Expose compact metadata only.",
      skillIds: [readySkill.id, missingSkillId],
      toolGrants: [
        { connectorId, toolName: registration.toolName },
        { connectorId, toolName: "unapproved_tool" }
      ],
      toolPackGrants: [{
        packId: pack.id,
        revision: pack.revision,
        manifestDigest: pack.manifestDigest,
        toolName: "search_docs"
      }, {
        packId: pack.id,
        revision: pack.revision,
        manifestDigest: pack.manifestDigest,
        toolName: "undeclared_tool"
      }],
      runtimeProfileBinding: agent.runtimeProfileBinding,
      promptBinding: null,
      contentDigest: "legacy-agent-revision",
      contentDigestVersion: 1,
      source: "published",
      restoredFromRevision: null,
      createdAt: now,
      publishedAt: now
    };
    const store = new InMemoryPlatformStore(seed, { agentRevisions: [revision] });
    const app = await createApp({ store, authDisabled: true });

    const effective = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/effective-configuration`
    });

    expect(effective.statusCode).toBe(200);
    const payload = effective.json();
    expect(payload).toMatchObject({
      source: { kind: "published", revision: 1 },
      agent: { id: agent.id, name: revision.name, draftRevision: 2, publishedRevision: 1 },
      bindingCounts: {
        skills: { configured: 2, ready: 1 },
        tools: { configured: 2, ready: 1 },
        toolPacks: { configured: 2, ready: 1 }
      },
      readiness: { status: "blocked" }
    });
    expect(payload.model).toEqual({
      id: modelId,
      name: "Capability model",
      location: "cloud",
      model: "capability-model-v1",
      enabled: true
    });
    expect(payload.credential).toEqual({
      id: credentialId,
      name: "Capability credential",
      location: "cloud",
      status: "active",
      hasSecret: true,
      maskedHint: "...7890",
      expiresAt: null
    });
    expect(payload.skills).toEqual([{
      id: readySkill.id,
      name: readySkill.name,
      version: readySkill.version,
      source: readySkill.source,
      owner: readySkill.owner
    }]);
    expect(payload.tools).toEqual([{ connectorId, connectorName: "Capability MCP", ...registration }]);
    expect(payload.toolPacks).toEqual([{
      packId: pack.id,
      packName: pack.name,
      revision: pack.revision,
      version: pack.version,
      toolName: "search_docs",
      toolGoal: "Search the approved documentation snapshot."
    }]);
    expect(payload.teams).toEqual([{
      id: seed.agentTeams![0]!.id,
      name: "Current capability team",
      isChair: true,
      role: {
        id: currentRole.id,
        name: currentRole.name,
        version: currentRole.version,
        toolPolicy: currentRole.toolPolicy,
        dataPolicy: currentRole.dataPolicy
      }
    }]);
    const serialized = JSON.stringify(payload);
    for (const forbiddenKey of [
      "baseUrl",
      "provider",
      "secretRevision",
      "instructions",
      "contentDigest",
      "ciphertext"
    ]) {
      expect(serialized).not.toContain(`"${forbiddenKey}"`);
    }
    await app.close();
  });

  it("manages Credential metadata and rotation without returning secret material", async () => {
    const store = new InMemoryPlatformStore();
    const secretVault = new SecretVault(Buffer.alloc(32, 21));
    const app = await createApp({ store, authDisabled: true, secretVault });

    const created = await app.inject({
      method: "POST",
      url: "/api/credentials",
      headers: { "idempotency-key": "credential-management-create" },
      payload: {
        name: "OpenAI production",
        provider: "OpenAI",
        kind: "api_key",
        location: "cloud",
        secret: "sk-first-secret"
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: "OpenAI production",
      status: "active",
      hasSecret: true,
      secretRevision: 1
    });
    expect(JSON.stringify(created.json())).not.toContain("sk-first-secret");
    expect(JSON.stringify(created.json())).not.toContain("ciphertext");

    const credentialId = created.json().id as string;
    const originalCiphertext = await store.getCredentialSecret(credentialId);
    const genericRotation = await app.inject({
      method: "PATCH",
      url: `/api/credentials/${credentialId}`,
      payload: { secret: "must-use-dedicated-rotation" }
    });
    expect(genericRotation.statusCode).toBe(400);
    expect(await store.getCredentialSecret(credentialId)).toBe(originalCiphertext);

    const rotated = await app.inject({
      method: "POST",
      url: `/api/credentials/${credentialId}/rotate`,
      headers: { "idempotency-key": "credential-management-rotation" },
      payload: { credentialId, secret: "sk-rotated-secret", expectedSecretRevision: 1 }
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json()).toMatchObject({ hasSecret: true, secretRevision: 2, status: "active" });
    expect(JSON.stringify(rotated.json())).not.toContain("sk-rotated-secret");
    const ciphertext = await store.getCredentialSecret(credentialId);
    expect(ciphertext).not.toBe("sk-rotated-secret");
    expect(secretVault.decrypt(ciphertext!)).toBe("sk-rotated-secret");

    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(bootstrap.json().credentials).toContainEqual(expect.objectContaining({ id: credentialId, secretRevision: 2 }));
    expect(JSON.stringify(bootstrap.json())).not.toContain("sk-rotated-secret");
    expect(JSON.stringify(bootstrap.json())).not.toContain(ciphertext);

    const metadataOnly = await app.inject({
      method: "POST",
      url: "/api/credentials",
      headers: { "idempotency-key": "credential-management-metadata-only" },
      payload: { name: "Cloud key later", provider: "OpenAI", kind: "api_key", location: "cloud" }
    });
    expect(metadataOnly.statusCode).toBe(201);
    expect(metadataOnly.json()).toMatchObject({ hasSecret: false, secretRevision: 0, status: "active" });
    const deferredModel = await app.inject({
      method: "POST",
      url: "/api/model-connectors",
      headers: { "idempotency-key": "deferred-cloud-model" },
      payload: {
        name: "Deferred cloud model",
        location: "cloud",
        baseUrl: "https://api.openai.com/v1",
        model: "cloud-model",
        credentialId: metadataOnly.json().id
      }
    });
    expect(deferredModel.statusCode).toBe(201);
    expect(deferredModel.json()).toMatchObject({ credentialId: metadataOnly.json().id, hasSecret: false, secretRevision: 0 });
    await app.inject({
      method: "POST",
      url: `/api/credentials/${metadataOnly.json().id}/rotate`,
      headers: { "idempotency-key": "credential-management-deferred-rotation" },
      payload: { credentialId: metadataOnly.json().id, secret: "sk-added-later", expectedSecretRevision: 0 }
    });
    const afterDeferredRotation = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(afterDeferredRotation.json().modelConnectors).toContainEqual(expect.objectContaining({
      id: deferredModel.json().id,
      hasSecret: true,
      secretRevision: 1
    }));

    const revoked = await app.inject({
      method: "PATCH",
      url: `/api/credentials/${credentialId}/status`,
      headers: { "idempotency-key": "credential-lifecycle-revoke" },
      payload: { status: "revoked", expectedUpdatedAt: rotated.json().updatedAt }
    });
    expect(revoked.statusCode).toBe(200);
    const reactivate = await app.inject({
      method: "PATCH",
      url: `/api/credentials/${credentialId}/status`,
      headers: { "idempotency-key": "credential-lifecycle-reactivate" },
      payload: { status: "active", expectedUpdatedAt: revoked.json().updatedAt }
    });
    expect(reactivate.statusCode).toBe(409);
    await app.close();
  });

  it("rejects a stale Credential lifecycle update", async () => {
    const store = new InMemoryPlatformStore();
    const secretVault = new SecretVault(Buffer.alloc(32, 27));
    const credential = await store.createCredential({
      name: "Credential lifecycle CAS",
      provider: "OpenAI",
      kind: "api_key",
      location: "cloud",
      expiresAt: null
    }, { ciphertext: secretVault.encrypt("credential-cas-secret") });
    const app = await createApp({ store, authDisabled: true, secretVault });

    const disabled = await app.inject({
      method: "PATCH",
      url: `/api/credentials/${credential.id}/status`,
      headers: { "idempotency-key": "credential-cas-disable-first" },
      payload: { status: "disabled", expectedUpdatedAt: credential.updatedAt }
    });
    const active = await app.inject({
      method: "PATCH",
      url: `/api/credentials/${credential.id}/status`,
      headers: { "idempotency-key": "credential-cas-activate" },
      payload: { status: "active", expectedUpdatedAt: disabled.json().updatedAt }
    });
    const disabledAgain = await app.inject({
      method: "PATCH",
      url: `/api/credentials/${credential.id}/status`,
      headers: { "idempotency-key": "credential-cas-disable-second" },
      payload: { status: "disabled", expectedUpdatedAt: active.json().updatedAt }
    });
    const staleEnable = await app.inject({
      method: "PATCH",
      url: `/api/credentials/${credential.id}/status`,
      headers: { "idempotency-key": "credential-cas-stale-enable" },
      payload: { status: "active", expectedUpdatedAt: disabled.json().updatedAt }
    });

    expect(disabled.statusCode).toBe(200);
    expect(active.statusCode).toBe(200);
    expect(disabledAgain.statusCode).toBe(200);
    expect(staleEnable.statusCode).toBe(409);
    expect(staleEnable.json()).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
    expect((await store.getCredentials()).find((item) => item.id === credential.id)?.status).toBe("disabled");
    await app.close();
  });

  it("rejects a stale Credential metadata update without overwriting the current record", async () => {
    const store = new InMemoryPlatformStore();
    const credential = await store.createCredential({
      name: "Credential metadata API CAS",
      provider: "OpenAI",
      kind: "api_key",
      location: "cloud",
      expiresAt: null
    });
    const app = await createApp({ store, authDisabled: true });

    const current = await app.inject({
      method: "PATCH",
      url: `/api/credentials/${credential.id}`,
      payload: { provider: "Current provider", expectedUpdatedAt: credential.updatedAt }
    });
    const stale = await app.inject({
      method: "PATCH",
      url: `/api/credentials/${credential.id}`,
      payload: { name: "Stale overwrite", expectedUpdatedAt: credential.updatedAt }
    });

    expect(current.statusCode).toBe(200);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
    expect((await store.getCredentials()).find((item) => item.id === credential.id)).toMatchObject({
      name: credential.name,
      provider: "Current provider",
      updatedAt: current.json().updatedAt
    });
    await app.close();
  });

  it("requires a Credential secret revision for rotation", async () => {
    const store = new InMemoryPlatformStore();
    const secretVault = new SecretVault(Buffer.alloc(32, 22));
    const credential = await store.createCredential({
      name: "Concurrent rotation guard",
      provider: "OpenAI",
      kind: "api_key",
      location: "cloud",
      expiresAt: null
    }, { ciphertext: secretVault.encrypt("first-secret") });
    const app = await createApp({ store, authDisabled: true, secretVault });

    const response = await app.inject({
      method: "POST",
      url: `/api/credentials/${credential.id}/rotate`,
      headers: { "idempotency-key": "credential-management-missing-revision" },
      payload: { credentialId: credential.id, secret: "unsafe-overwrite" }
    });

    expect(response.statusCode).toBe(400);
    expect((await store.getCredentials()).find((item) => item.id === credential.id)?.secretRevision).toBe(1);
    expect(secretVault.decrypt((await store.getCredentialSecret(credential.id))!)).toBe("first-secret");
    await app.close();
  });

  it("rejects a secret-bearing Credential list at the runtime response boundary", async () => {
    const store = new InMemoryPlatformStore();
    const credential = await store.createCredential({
      name: "Response boundary key",
      provider: "local",
      kind: "api_key",
      location: "local",
      expiresAt: null
    });
    vi.spyOn(store, "getCredentials").mockResolvedValue([
      { ...credential, ciphertext: "must-not-leak" }
    ] as never);
    const app = await createApp({ store, authDisabled: true });

    const response = await app.inject({ method: "GET", url: "/api/credentials" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "RESPONSE_CONTRACT_VIOLATION" } });
    expect(response.body).not.toContain("must-not-leak");
    await app.close();
  });

  it("versions, publishes, previews, rolls back, and archives Prompts", async () => {
    const store = new InMemoryPlatformStore();
    const app = await createApp({ store, authDisabled: true });

    const created = await app.inject({
      method: "POST",
      url: "/api/prompts",
      headers: { "idempotency-key": "management-prompt-lifecycle" },
      payload: {
        name: "Architecture reviewer",
        kind: "agent",
        description: "Reusable architecture review behavior",
        owner: "Platform Owner",
        content: "你是 {{AGENT_NAME}}，請檢查 {{MEETING_GOAL}}。",
        variables: ["AGENT_NAME", "MEETING_GOAL"]
      }
    });
    expect(created.statusCode).toBe(201);
    const promptId = created.json().id as string;
    expect(created.json()).toMatchObject({ status: "draft", currentVersion: 1, publishedVersion: null });

    const published = await app.inject({
      method: "POST",
      url: `/api/prompts/${promptId}/publish`,
      payload: { expectedCurrentVersion: 1, version: 1 }
    });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({ status: "published", publishedVersion: 1 });

    const preview = await app.inject({
      method: "POST",
      url: `/api/prompts/${promptId}/preview`,
      payload: { version: 1, variables: { AGENT_NAME: "Architect-R", MEETING_GOAL: "收斂平台邊界" } }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({ content: "你是 Architect-R，請檢查 收斂平台邊界。", version: 1 });

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/prompts/${promptId}`,
      payload: {
        expectedCurrentVersion: 1,
        content: "你是 {{AGENT_NAME}}，先確認 {{MEETING_GOAL}}，再列風險。",
        variables: ["AGENT_NAME", "MEETING_GOAL"]
      }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ status: "draft", currentVersion: 2, publishedVersion: 1 });

    const rolledBack = await app.inject({
      method: "POST",
      url: `/api/prompts/${promptId}/rollback`,
      payload: { expectedCurrentVersion: 2, version: 1 }
    });
    expect(rolledBack.statusCode).toBe(200);
    expect(rolledBack.json()).toMatchObject({ status: "published", currentVersion: 3, publishedVersion: 3 });
    const versions = await app.inject({ method: "GET", url: `/api/prompts/${promptId}/versions` });
    expect(versions.statusCode).toBe(200);
    expect(versions.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: 3, source: "rollback", restoredFromVersion: 1 }),
      expect.objectContaining({ version: 1, publishedAt: expect.any(String) })
    ]));

    const archived = await app.inject({
      method: "POST",
      url: `/api/prompts/${promptId}/archive`,
      payload: { expectedCurrentVersion: 3 }
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ status: "archived" });
    await app.close();
  });

  it("rejects current and future Prompt rollback targets without changing the resource", async () => {
    const store = new InMemoryPlatformStore();
    const prompt = await store.createPrompt({
      name: "API rollback direction guard",
      kind: "agent",
      description: "Reject non-historical rollback targets.",
      owner: "Platform Owner",
      content: "Review bounded evidence.",
      variables: []
    });
    const current = await store.updatePrompt(prompt.id, {
      expectedCurrentVersion: prompt.currentVersion,
      content: "Review bounded evidence and record provenance."
    });
    const beforePrompt = (await store.getSnapshot()).prompts?.find((item) => item.id === prompt.id);
    const beforeVersions = await store.getPromptVersions(prompt.id);
    const app = await createApp({ store, authDisabled: true });

    for (const version of [current.currentVersion, current.currentVersion + 1]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/prompts/${prompt.id}/rollback`,
        payload: { expectedCurrentVersion: current.currentVersion, version }
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: "REQUEST_FAILED" } });
      expect((await store.getSnapshot()).prompts?.find((item) => item.id === prompt.id)).toEqual(beforePrompt);
      expect(await store.getPromptVersions(prompt.id)).toEqual(beforeVersions);
    }
    await app.close();
  });

  it("publishes Agent revisions and reuses Team and Meeting Preset snapshots", async () => {
    const store = new InMemoryPlatformStore();
    const app = await createApp({ store, authDisabled: true });
    const initial = await store.getSnapshot();
    const agent = initial.agents[0]!;
    const secondAgent = initial.agents[1]!;
    const role = initial.roles[0]!;
    const chairRole = initial.roles[1]!;

    const promptResponse = await app.inject({
      method: "POST",
      url: "/api/prompts",
      headers: { "idempotency-key": "management-meeting-agent-prompt" },
      payload: {
        name: "Meeting agent",
        kind: "agent",
        description: "Agent meeting behavior",
        owner: "Platform Owner",
        content: "聚焦 {{MEETING_GOAL}}。",
        variables: ["MEETING_GOAL"]
      }
    });
    const promptId = promptResponse.json().id as string;
    await app.inject({
      method: "POST",
      url: `/api/prompts/${promptId}/publish`,
      payload: { expectedCurrentVersion: 1, version: 1 }
    });
    const model = await app.inject({
      method: "POST",
      url: "/api/model-connectors",
      headers: { "idempotency-key": "management-local-model" },
      payload: { name: "Local model", location: "local", baseUrl: "http://192.168.50.10:4000/v1", model: "local" }
    });
    const modelId = model.json().id as string;

    const edited = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}`,
      payload: { expectedDraftRevision: agent.draftRevision, modelConnectorId: modelId, promptBinding: { promptId, version: 1 } }
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ lifecycleStatus: "draft", draftRevision: 2, publishedRevision: 1 });
    const readiness = await app.inject({ method: "GET", url: `/api/agents/${agent.id}/readiness` });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json().checks.filter((item: { code: string }) => item.code !== "lifecycle"))
      .toEqual(expect.not.arrayContaining([expect.objectContaining({ status: "blocked" })]));
    const published = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/publish`,
      payload: { expectedDraftRevision: 2 }
    });
    expect(published.statusCode).toBe(200);
    expect(published.json()).toMatchObject({ lifecycleStatus: "published", publishedRevision: 2 });

    await app.inject({
      method: "PATCH",
      url: `/api/agents/${secondAgent.id}`,
      payload: { expectedDraftRevision: secondAgent.draftRevision, modelConnectorId: modelId, promptBinding: { promptId, version: 1 } }
    });
    const secondEdited = (await store.getSnapshot()).agents.find((item) => item.id === secondAgent.id)!;
    await app.inject({
      method: "POST",
      url: `/api/agents/${secondAgent.id}/publish`,
      payload: { expectedDraftRevision: secondEdited.draftRevision }
    });

    const teamResponse = await app.inject({
      method: "POST",
      url: "/api/agent-teams",
      headers: { "idempotency-key": "management-route-agent-team" },
      payload: {
        name: "Platform review team",
        description: "Architecture and chair",
        members: [
          { agentId: agent.id, roleId: role.id, isChair: false },
          { agentId: secondAgent.id, roleId: chairRole.id, isChair: true }
        ]
      }
    });
    expect(teamResponse.statusCode).toBe(201);
    const teamId = teamResponse.json().id as string;
    const teamRevision = teamResponse.json().revision as number;
    const presetResponse = await app.inject({
      method: "POST",
      url: "/api/meeting-presets",
      headers: { "idempotency-key": "management-route-meeting-preset" },
      payload: {
        name: "Architecture decision",
        description: "Standard architecture review",
        teamId,
        mode: "chaired",
        automation: "suggest",
        durationMinutes: 30,
        agendaItems: [
          { title: "確認範圍", description: "確認目標" },
          { title: "形成決議", description: "收斂下一步" }
        ]
      }
    });
    expect(presetResponse.statusCode).toBe(201);
    const presetId = presetResponse.json().id as string;
    const presetRevision = presetResponse.json().revision as number;

    const thread = await app.inject({
      method: "POST",
      url: "/api/threads",
      headers: { "idempotency-key": crypto.randomUUID() },
      payload: {
        categoryId: initial.categories[0]!.id,
        title: "Management control-plane validation",
        summary: "Fresh Topic for the reusable Team and Preset.",
        tagIds: []
      }
    });
    expect(thread.statusCode).toBe(201);

    const meeting = await app.inject({
      method: "POST",
      url: "/api/meetings",
      headers: { "idempotency-key": crypto.randomUUID() },
      payload: {
        threadId: thread.json().id,
        title: "Architecture decision",
        goal: "Confirm boundaries",
        mode: "chaired",
        automation: "suggest",
        durationMinutes: 30,
        sourceTeamId: teamId,
        sourcePresetId: presetId,
        participants: [
          { agentId: agent.id, roleId: role.id, isChair: false },
          { agentId: secondAgent.id, roleId: chairRole.id, isChair: true }
        ],
        agendaItems: [
          { title: "確認範圍", description: "確認目標" },
          { title: "形成決議", description: "收斂下一步" }
        ]
      }
    });
    expect(meeting.statusCode).toBe(201);
    expect(meeting.json()).toMatchObject({ sourceTeamId: teamId, sourcePresetId: presetId });
    const participants = (await store.getSnapshot()).participants.filter((item) => item.meetingId === meeting.json().id);
    expect(participants.map((item) => item.agentRevision)).toEqual([2, 2]);

    const mutableDraft = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}`,
      payload: { expectedDraftRevision: 2, name: "Mutable draft only" }
    });
    const missingRollbackCas = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/rollback`,
      payload: { expectedPublishedRevision: 2, revision: 1 }
    });
    expect(missingRollbackCas.statusCode).toBe(400);
    const protectedRollback = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/rollback`,
      payload: { expectedPublishedRevision: 2, expectedDraftRevision: mutableDraft.json().draftRevision, revision: 1 }
    });
    expect(protectedRollback.statusCode).toBe(409);
    expect((await store.getSnapshot()).agents.find((item) => item.id === agent.id)).toMatchObject({
      name: "Mutable draft only",
      draftRevision: 3,
      publishedRevision: 2
    });
    const draftReadiness = await app.inject({ method: "GET", url: `/api/agents/${agent.id}/readiness` });
    expect(draftReadiness.json()).toMatchObject({ status: "warning" });
    const teamAfterDraft = await app.inject({
      method: "PATCH",
      url: `/api/agent-teams/${teamId}`,
      payload: {
        expectedRevision: teamRevision,
        description: "Published runtime remains reusable while a new draft is edited."
      }
    });
    expect(teamAfterDraft.statusCode).toBe(200);
    expect(teamAfterDraft.json()).toMatchObject({ revision: teamRevision + 1 });
    const staleTeamUpdate = await app.inject({
      method: "PATCH",
      url: `/api/agent-teams/${teamId}`,
      payload: { expectedRevision: teamRevision, description: "Stale overwrite" }
    });
    expect(staleTeamUpdate.statusCode).toBe(409);
    expect(staleTeamUpdate.json()).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
    const presetUpdate = await app.inject({
      method: "PATCH",
      url: `/api/meeting-presets/${presetId}`,
      payload: { expectedRevision: presetRevision, durationMinutes: 45 }
    });
    expect(presetUpdate.statusCode).toBe(200);
    expect(presetUpdate.json()).toMatchObject({ revision: presetRevision + 1, durationMinutes: 45 });
    const stalePresetUpdate = await app.inject({
      method: "PATCH",
      url: `/api/meeting-presets/${presetId}`,
      payload: { expectedRevision: presetRevision, description: "Stale overwrite" }
    });
    expect(stalePresetUpdate.statusCode).toBe(409);
    expect(stalePresetUpdate.json()).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
    const presetPreflight = await app.inject({ method: "GET", url: `/api/meeting-presets/${presetId}/preflight` });
    expect(presetPreflight.json()).toMatchObject({
      status: "ready",
      agents: expect.arrayContaining([expect.objectContaining({
        agentId: agent.id,
        agentRevision: 2,
        readiness: expect.objectContaining({ status: "ready" })
      })])
    });
    const secondThread = await app.inject({
      method: "POST",
      url: "/api/threads",
      headers: { "idempotency-key": crypto.randomUUID() },
      payload: {
        categoryId: initial.categories[0]!.id,
        title: "Published revision remains available",
        summary: "A mutable draft must not stop the last published Agent revision.",
        tagIds: []
      }
    });
    const meetingFromPublishedRevision = await app.inject({
      method: "POST",
      url: "/api/meetings",
      headers: { "idempotency-key": crypto.randomUUID() },
      payload: {
        threadId: secondThread.json().id,
        title: "Published revision meeting",
        goal: "Confirm immutable runtime behavior",
        mode: "chaired",
        automation: "suggest",
        durationMinutes: 30,
        sourceTeamId: teamId,
        sourcePresetId: presetId,
        participants: [
          { agentId: agent.id, roleId: role.id, isChair: false, agentRevision: 2 },
          { agentId: secondAgent.id, roleId: chairRole.id, isChair: true, agentRevision: 2 }
        ],
        agendaItems: [{ title: "確認已發布版本", description: "草稿不影響正式執行" }]
      }
    });
    expect(meetingFromPublishedRevision.statusCode).toBe(201);

    const effective = await app.inject({ method: "GET", url: `/api/agents/${agent.id}/effective-configuration` });
    expect(effective.statusCode).toBe(200);
    expect(effective.json()).toMatchObject({
      agent: { id: agent.id, name: agent.name, publishedRevision: 2, draftRevision: 3 },
      model: { id: modelId },
      prompt: { id: promptId, version: 1 },
      readiness: { status: "ready" }
    });
    expect(effective.json().agent.name).not.toBe("Mutable draft only");
    expect(JSON.stringify(effective.json())).not.toContain("ciphertext");
    await app.close();
  });
});
