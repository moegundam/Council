import type { PlatformSnapshot, ToolPack } from "@council/contracts";
import { describe, expect, it, vi } from "vitest";
import { InMemoryPlatformStore } from "./memory-store.js";

const encrypted = (value: string) => ({ ciphertext: `vault:v1:${value}` });

class FailingManagementAuditStore extends InMemoryPlatformStore {
  constructor(private readonly failedEvent: string) {
    super();
  }

  override async recordAudit(event: string): Promise<void> {
    if (event === this.failedEvent) throw new Error(`Injected audit failure: ${event}`);
  }
}

class DelayedFirstAgentAuditStore extends InMemoryPlatformStore {
  private attempts = 0;
  private markFirstEntered!: () => void;
  private releaseFirst!: () => void;
  readonly firstEntered = new Promise<void>((resolve) => { this.markFirstEntered = resolve; });
  private readonly firstGate = new Promise<void>((resolve) => { this.releaseFirst = resolve; });

  constructor(seed?: PlatformSnapshot) {
    super(seed);
  }

  release(): void {
    this.releaseFirst();
  }

  override async recordAudit(event: string): Promise<void> {
    if (event !== "agent.updated") return;
    this.attempts += 1;
    if (this.attempts !== 1) return;
    this.markFirstEntered();
    await this.firstGate;
    throw new Error("Injected first Agent audit failure");
  }
}

class DelayedFirstRoleAuditStore extends InMemoryPlatformStore {
  private attempts = 0;
  private markFirstEntered!: () => void;
  private releaseFirst!: () => void;
  readonly firstEntered = new Promise<void>((resolve) => { this.markFirstEntered = resolve; });
  private readonly firstGate = new Promise<void>((resolve) => { this.releaseFirst = resolve; });

  release(): void {
    this.releaseFirst();
  }

  override async recordAudit(event: string): Promise<void> {
    if (event !== "role.updated") return;
    this.attempts += 1;
    if (this.attempts !== 1) return;
    this.markFirstEntered();
    await this.firstGate;
    throw new Error("Injected first Role audit failure");
  }
}

class GatedFailingManagementAuditStore extends InMemoryPlatformStore {
  private markEntered!: () => void;
  private releaseGate!: () => void;
  readonly entered = new Promise<void>((resolve) => { this.markEntered = resolve; });
  private readonly gate = new Promise<void>((resolve) => { this.releaseGate = resolve; });

  constructor(private readonly gatedEvent: string, seed?: PlatformSnapshot) {
    super(seed);
  }

  release(): void {
    this.releaseGate();
  }

  override async recordAudit(event: string): Promise<void> {
    if (event !== this.gatedEvent) return;
    this.markEntered();
    await this.gate;
    throw new Error(`Injected delayed audit failure: ${event}`);
  }
}

class GatedSuccessfulManagementAuditStore extends InMemoryPlatformStore {
  private attempts = 0;
  private markFirstEntered!: () => void;
  private releaseFirst!: () => void;
  readonly firstEntered = new Promise<void>((resolve) => { this.markFirstEntered = resolve; });
  private readonly firstGate = new Promise<void>((resolve) => { this.releaseFirst = resolve; });

  constructor(private readonly gatedEvent: string, seed?: PlatformSnapshot) {
    super(seed);
  }

  release(): void {
    this.releaseFirst();
  }

  override async recordAudit(event: string): Promise<void> {
    if (event !== this.gatedEvent) return;
    this.attempts += 1;
    if (this.attempts !== 1) return;
    this.markFirstEntered();
    await this.firstGate;
  }
}

async function localConnector(store: InMemoryPlatformStore, name = "Local management model") {
  return store.createModelConnector({
    name,
    location: "local",
    baseUrl: "http://192.168.50.10:4000/v1",
    model: "meeting-local"
  });
}

async function capabilityPack(store: InMemoryPlatformStore, name: string): Promise<ToolPack> {
  const imageDigest = `sha256:${"d".repeat(64)}`;
  return store.createToolPack({
    name,
    version: "1.0.0",
    description: "Read-only capability used to verify the management commit boundary.",
    owner: "Platform Owner",
    sourceReference: `registry.example.com/council/management-test@${imageDigest}`,
    imageDigest,
    tools: [{
      name: "search_docs",
      kind: "command",
      goal: "Search an approved documentation snapshot.",
      access: "read_only",
      argv: { executable: "/usr/bin/rg", fixedArguments: ["--json"] },
      env: { allowedNames: ["LANG"] },
      stdin: { mode: "none" }
    }]
  });
}

async function teamReadyStore(): Promise<InMemoryPlatformStore> {
  const seedStore = new InMemoryPlatformStore();
  const seed = await seedStore.getSnapshot();
  const connectorId = "d0000000-0000-4000-8000-000000000090";
  seed.modelConnectors.push({
    id: connectorId,
    revision: 1,
    name: "Team-ready local model",
    location: "local",
    baseUrl: "http://192.168.50.10:4000/v1",
    model: "meeting-local",
    enabled: true,
    hasSecret: false,
    secretRevision: 0,
    credentialId: null
  });
  for (const agent of seed.agents) agent.modelConnectorId = connectorId;
  return new InMemoryPlatformStore(seed);
}

describe("management store security boundaries", () => {
  it.each([
    {
      label: "Agent",
      event: "agent.created",
      collection: "agents" as const,
      create: (store: InMemoryPlatformStore) => store.createAgent({
        name: "Invisible pending Agent",
        description: "",
        modelConnectorId: null,
        goalSummary: "Remain invisible until committed.",
        toolsSummary: "No tools.",
        dataSummary: "No data.",
        skillIds: [],
        toolGrants: [],
        runtimeProfileBinding: null,
        promptBinding: null
      })
    },
    {
      label: "Model Connector",
      event: "model_connector.created",
      collection: "modelConnectors" as const,
      create: (store: InMemoryPlatformStore) => store.createModelConnector({
        name: "Invisible pending model",
        location: "cloud",
        baseUrl: "https://1.1.1.1/v1",
        model: "pending-model"
      }, encrypted("pending-model-secret"))
    },
    {
      label: "MCP Connector",
      event: "mcp_connector.created",
      collection: "mcpConnectors" as const,
      create: (store: InMemoryPlatformStore) => store.createMcpConnector({
        name: "Invisible pending MCP",
        location: "cloud",
        baseUrl: "https://1.0.0.1/mcp",
        approvedTools: ["search"]
      }, encrypted("pending-mcp-secret"))
    },
    {
      label: "Task Adapter Connector",
      event: "task_adapter.created",
      collection: "taskAdapterConnectors" as const,
      create: (store: InMemoryPlatformStore) => store.createTaskAdapterConnector({
        name: "Invisible pending Task Adapter",
        location: "cloud",
        baseUrl: "https://1.1.1.1"
      }, encrypted("pending-task-adapter-secret"))
    },
    {
      label: "Skill",
      event: "skill.created",
      collection: "skills" as const,
      create: (store: InMemoryPlatformStore) => store.createSkill({
        name: "Invisible pending Skill",
        version: "1.0.0",
        instructions: "Remain invisible until the required audit commits.",
        source: "internal",
        owner: "owner"
      })
    },
    {
      label: "Tool Pack",
      event: "tool_pack.created",
      collection: "toolPacks" as const,
      create: (store: InMemoryPlatformStore) => capabilityPack(store, "Invisible pending Tool Pack")
    },
    {
      label: "Role",
      event: "role.created",
      collection: "roles" as const,
      create: (store: InMemoryPlatformStore) => store.createRole({
        name: "Invisible pending Role",
        usageContext: "Validate the Role commit boundary.",
        responsibility: "Remain invisible until committed.",
        speakingGuidance: "State only committed facts.",
        decisionScope: "Recommend without approving.",
        constraints: "Do not bypass required audit.",
        templateKey: null,
        toolPolicy: "none",
        dataPolicy: "meeting_only"
      })
    },
    {
      label: "Runtime Profile",
      event: "runtime_profile.created",
      collection: "runtimeProfiles" as const,
      create: (store: InMemoryPlatformStore) => store.createRuntimeProfile({
        name: "Invisible pending Runtime Profile",
        harnessKind: "openai_compatible",
        modelConnectorId: null,
        sandboxProfileId: null,
        policy: "text_only",
        capabilities: ["text", "abort"],
        timeoutMs: 60_000,
        maxConcurrency: 1,
        enabled: true
      })
    },
    {
      label: "Credential",
      event: "credential.created",
      collection: "credentials" as const,
      create: (store: InMemoryPlatformStore) => store.createCredential({
        name: "Invisible pending Credential",
        provider: "cloud-provider",
        kind: "api_key",
        location: "cloud",
        expiresAt: null
      }, encrypted("pending-credential-secret"))
    },
    {
      label: "Prompt",
      event: "prompt.created",
      collection: "prompts" as const,
      create: (store: InMemoryPlatformStore) => store.createPrompt({
        name: "Invisible pending Prompt",
        kind: "agent",
        description: "Required audit boundary fixture.",
        owner: "owner",
        content: "Remain invisible until committed.",
        variables: []
      })
    },
    {
      label: "Meeting Preset",
      event: "meeting_preset.created",
      collection: "meetingPresets" as const,
      create: (store: InMemoryPlatformStore) => store.createMeetingPreset({
        name: "Invisible pending Meeting Preset",
        description: "Required audit boundary fixture.",
        teamId: null,
        mode: "chaired",
        automation: "suggest",
        durationMinutes: 30,
        agendaItems: [{ title: "Review", description: "Review the bounded goal." }]
      })
    }
  ])("does not expose $label creation before its required audit commits", async ({ event, collection, create }) => {
    const store = new GatedFailingManagementAuditStore(event);
    const before = await store.getSnapshot();
    const creation = create(store);
    await Promise.race([
      store.entered,
      creation.then(() => { throw new Error(`${event} committed before its required audit.`); })
    ]);

    expect((await store.getSnapshot())[collection]).toEqual(before[collection]);

    store.release();
    await expect(creation).rejects.toThrow(/delayed audit failure/);
    expect((await store.getSnapshot())[collection]).toEqual(before[collection]);
  });

  it("does not expose Agent Team creation before its required audit commits", async () => {
    const ready = await teamReadyStore();
    const seed = await ready.getSnapshot();
    const store = new GatedFailingManagementAuditStore("agent_team.created", seed);
    const before = await store.getSnapshot();
    const creation = store.createAgentTeam({
      name: "Invisible pending Agent Team",
      description: "Required audit boundary fixture.",
      members: [{ agentId: seed.agents[0]!.id, roleId: seed.roles[0]!.id, isChair: true }]
    });

    await Promise.race([
      store.entered,
      creation.then(() => { throw new Error("agent_team.created committed before its required audit."); })
    ]);
    expect((await store.getSnapshot()).agentTeams).toEqual(before.agentTeams);

    store.release();
    await expect(creation).rejects.toThrow(/delayed audit failure/);
    expect((await store.getSnapshot()).agentTeams).toEqual(before.agentTeams);
  });

  it.each([
    {
      label: "Runtime Profile update",
      event: "runtime_profile.updated",
      collection: "runtimeProfiles" as const,
      prepare: async (store: InMemoryPlatformStore) => {
        const profile = await store.createRuntimeProfile({
          name: "Atomic Runtime Profile",
          harnessKind: "openai_compatible",
          modelConnectorId: null,
          sandboxProfileId: null,
          policy: "text_only",
          capabilities: ["text", "abort"],
          timeoutMs: 60_000,
          maxConcurrency: 1,
          enabled: true
        });
        return {
          mutate: () => store.updateRuntimeProfile(profile.id, { expectedRevision: 1, timeoutMs: 75_000 }),
          readExtra: () => store.getRuntimeProfileRevisions(profile.id)
        };
      }
    },
    {
      label: "Credential metadata update",
      event: "credential.updated",
      collection: "credentials" as const,
      prepare: async (store: InMemoryPlatformStore) => {
        const credential = await store.createCredential({
          name: "Atomic Credential metadata",
          provider: "cloud-provider",
          kind: "api_key",
          location: "cloud",
          expiresAt: null
        }, encrypted("credential-one"));
        return {
          mutate: () => store.updateCredential(credential.id, {
            provider: "updated-provider",
            expectedUpdatedAt: credential.updatedAt
          }),
          readExtra: () => store.getCredentialSecret(credential.id)
        };
      }
    },
    {
      label: "Credential rotation",
      event: "credential.rotated",
      collection: "credentials" as const,
      prepare: async (store: InMemoryPlatformStore) => {
        const credential = await store.createCredential({
          name: "Atomic Credential rotation",
          provider: "cloud-provider",
          kind: "api_key",
          location: "cloud",
          expiresAt: null
        }, encrypted("credential-one"));
        return {
          mutate: () => store.rotateCredential({ credentialId: credential.id, expectedSecretRevision: 1 }, encrypted("credential-two")),
          readExtra: () => store.getCredentialSecret(credential.id)
        };
      }
    },
    {
      label: "Credential status update",
      event: "credential.status.changed",
      collection: "credentials" as const,
      prepare: async (store: InMemoryPlatformStore) => {
        const credential = await store.createCredential({
          name: "Atomic Credential status",
          provider: "cloud-provider",
          kind: "api_key",
          location: "cloud",
          expiresAt: null
        }, encrypted("credential-one"));
        return {
          mutate: () => store.setCredentialStatus(credential.id, {
            status: "disabled",
            expectedUpdatedAt: credential.updatedAt
          })
        };
      }
    },
    {
      label: "Prompt update",
      event: "prompt.updated",
      collection: "prompts" as const,
      prepare: async (store: InMemoryPlatformStore) => {
        const prompt = await store.createPrompt({
          name: "Atomic Prompt update",
          kind: "agent",
          description: "Required audit boundary fixture.",
          owner: "owner",
          content: "Review bounded evidence.",
          variables: []
        });
        return {
          mutate: () => store.updatePrompt(prompt.id, { expectedCurrentVersion: 1, content: "Review bounded evidence twice." }),
          readExtra: () => store.getPromptVersions(prompt.id)
        };
      }
    },
    {
      label: "Prompt publication",
      event: "prompt.published",
      collection: "prompts" as const,
      prepare: async (store: InMemoryPlatformStore) => {
        const prompt = await store.createPrompt({
          name: "Atomic Prompt publication",
          kind: "agent",
          description: "Required audit boundary fixture.",
          owner: "owner",
          content: "Review bounded evidence.",
          variables: []
        });
        return {
          mutate: () => store.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 }),
          readExtra: () => store.getPromptVersions(prompt.id)
        };
      }
    },
    {
      label: "Prompt rollback",
      event: "prompt.rolled_back",
      collection: "prompts" as const,
      prepare: async (store: InMemoryPlatformStore) => {
        const prompt = await store.createPrompt({
          name: "Atomic Prompt rollback",
          kind: "agent",
          description: "Required audit boundary fixture.",
          owner: "owner",
          content: "Review bounded evidence.",
          variables: []
        });
        const updated = await store.updatePrompt(prompt.id, { expectedCurrentVersion: 1, content: "Review newer evidence." });
        await store.publishPrompt(prompt.id, { expectedCurrentVersion: updated.currentVersion, version: updated.currentVersion });
        return {
          mutate: () => store.rollbackPrompt(prompt.id, { expectedCurrentVersion: 2, version: 1 }),
          readExtra: () => store.getPromptVersions(prompt.id)
        };
      }
    },
    {
      label: "Prompt archival",
      event: "prompt.archived",
      collection: "prompts" as const,
      prepare: async (store: InMemoryPlatformStore) => {
        const prompt = await store.createPrompt({
          name: "Atomic Prompt archival",
          kind: "agent",
          description: "Required audit boundary fixture.",
          owner: "owner",
          content: "Review bounded evidence.",
          variables: []
        });
        return { mutate: () => store.archivePrompt(prompt.id, { expectedCurrentVersion: 1 }) };
      }
    },
    {
      label: "Agent Team update",
      event: "agent_team.updated",
      collection: "agentTeams" as const,
      seed: async () => (await teamReadyStore()).getSnapshot(),
      prepare: async (store: InMemoryPlatformStore) => {
        const snapshot = await store.getSnapshot();
        const team = await store.createAgentTeam({
          name: "Atomic Agent Team",
          description: "Required audit boundary fixture.",
          members: [{ agentId: snapshot.agents[0]!.id, roleId: snapshot.roles[0]!.id, isChair: true }]
        });
        return { mutate: () => store.updateAgentTeam(team.id, { expectedRevision: 1, description: "Changed." }) };
      }
    },
    {
      label: "Meeting Preset update",
      event: "meeting_preset.updated",
      collection: "meetingPresets" as const,
      prepare: async (store: InMemoryPlatformStore) => {
        const preset = await store.createMeetingPreset({
          name: "Atomic Meeting Preset",
          description: "Required audit boundary fixture.",
          teamId: null,
          mode: "chaired",
          automation: "suggest",
          durationMinutes: 30,
          agendaItems: [{ title: "Review", description: "Review bounded evidence." }]
        });
        return { mutate: () => store.updateMeetingPreset(preset.id, { expectedRevision: 1, durationMinutes: 45 }) };
      }
    }
  ])("does not expose $label before its required audit commits", async ({ event, collection, seed, prepare }) => {
    const store = new GatedFailingManagementAuditStore(event, seed ? await seed() : undefined);
    const prepared = await prepare(store) as {
      mutate: () => Promise<unknown>;
      readExtra?: () => Promise<unknown>;
    };
    const before = await store.getSnapshot();
    const extraBefore = prepared.readExtra ? await prepared.readExtra() : undefined;
    const mutation = prepared.mutate();

    await Promise.race([
      store.entered,
      mutation.then(() => { throw new Error(`${event} committed before its required audit.`); })
    ]);
    expect((await store.getSnapshot())[collection]).toEqual(before[collection]);
    if (prepared.readExtra) expect(await prepared.readExtra()).toEqual(extraBefore);

    store.release();
    await expect(mutation).rejects.toThrow(/delayed audit failure/);
    expect((await store.getSnapshot())[collection]).toEqual(before[collection]);
    if (prepared.readExtra) expect(await prepared.readExtra()).toEqual(extraBefore);
  });

  it("does not expose an MCP governance update before its required audit commits", async () => {
    const store = new GatedFailingManagementAuditStore("mcp_connector.updated");
    const connector = await store.createMcpConnector({
      name: "Atomic MCP update",
      location: "cloud",
      baseUrl: "https://1.0.0.1/mcp",
      approvedTools: ["search"]
    }, encrypted("old-mcp-secret"));
    const agent = await store.createAgent({
      name: "Atomic MCP Agent",
      description: "",
      modelConnectorId: null,
      goalSummary: "Keep governance changes atomic.",
      toolsSummary: "Search.",
      dataSummary: "Meeting data.",
      skillIds: [],
      toolGrants: [{ connectorId: connector.id, toolName: "search" }],
      runtimeProfileBinding: null,
      promptBinding: null
    });
    const before = await store.getSnapshot();
    const beforeRevisions = await store.getAgentRevisions(agent.id);

    const mutation = store.updateMcpConnector(
      connector.id,
      { expectedRevision: connector.revision, enabled: false },
      encrypted("new-mcp-secret")
    );
    await store.entered;

    expect(await store.getSnapshot()).toEqual(before);
    expect(await store.getConnectorSecret(connector.id)).toBe(encrypted("old-mcp-secret").ciphertext);
    expect(await store.getAgentRevisions(agent.id)).toEqual(beforeRevisions);

    store.release();
    await expect(mutation).rejects.toThrow(/delayed audit failure/);
    expect(await store.getSnapshot()).toEqual(before);
    expect(await store.getConnectorSecret(connector.id)).toBe(encrypted("old-mcp-secret").ciphertext);
    expect(await store.getAgentRevisions(agent.id)).toEqual(beforeRevisions);
  });

  it("keeps a failed Role update invisible and serializes the following update", async () => {
    const store = new DelayedFirstRoleAuditStore();
    const role = (await store.getSnapshot()).roles[0]!;
    const before = structuredClone(role);

    const first = store.updateRole(role.id, { responsibility: "Uncommitted responsibility." }, role.version);
    await store.firstEntered;
    expect((await store.getSnapshot()).roles.find((item) => item.id === role.id)).toEqual(before);

    const second = store.updateRole(role.id, { speakingGuidance: "Committed speaking guidance." }, role.version);
    store.release();
    await expect(first).rejects.toThrow(/first Role audit failure/);
    await expect(second).resolves.toMatchObject({
      version: role.version + 1,
      responsibility: before.responsibility,
      speakingGuidance: "Committed speaking guidance."
    });
    expect((await store.getRoleVersions(role.id)).map((item) => item.version)).toEqual([role.version + 1, role.version]);
  });

  it("does not expose Role rollback before its required audit commits", async () => {
    const store = new GatedFailingManagementAuditStore("role.rolled_back");
    const role = (await store.getSnapshot()).roles[0]!;
    const updated = await store.updateRole(role.id, { responsibility: "Updated before rollback." }, role.version);
    const before = await store.getSnapshot();
    const beforeVersions = await store.getRoleVersions(role.id);

    const rollback = store.rollbackRole(role.id, role.version, updated.version);
    await store.entered;
    expect(await store.getSnapshot()).toEqual(before);
    expect(await store.getRoleVersions(role.id)).toEqual(beforeVersions);

    store.release();
    await expect(rollback).rejects.toThrow(/delayed audit failure/);
    expect(await store.getSnapshot()).toEqual(before);
    expect(await store.getRoleVersions(role.id)).toEqual(beforeVersions);
  });

  it("does not expose Role deletion before its required audit commits", async () => {
    const store = new GatedFailingManagementAuditStore("role.deleted");
    const role = await store.createRole({
      name: "Atomic deletion Role",
      usageContext: "Validate tombstone commit boundaries.",
      responsibility: "Remain active until audit commits.",
      speakingGuidance: "Report deletion state precisely.",
      decisionScope: "Recommend without approving.",
      constraints: "Do not expose pending tombstones.",
      templateKey: null,
      toolPolicy: "none",
      dataPolicy: "meeting_only"
    });

    const deletion = store.deleteRole(role.id, role.version);
    await store.entered;
    expect((await store.getSnapshot()).roles.find((item) => item.id === role.id)?.deletedAt).toBeNull();

    store.release();
    await expect(deletion).rejects.toThrow(/delayed audit failure/);
    expect((await store.getSnapshot()).roles.find((item) => item.id === role.id)?.deletedAt).toBeNull();
  });

  it("prevents a new Role reference from racing a committed deletion", async () => {
    const ready = await teamReadyStore();
    const store = new GatedSuccessfulManagementAuditStore("role.deleted", await ready.getSnapshot());
    const snapshot = await store.getSnapshot();
    const role = await store.createRole({
      name: "Deletion race Role",
      usageContext: "Validate Role reference serialization.",
      responsibility: "Cannot be assigned after deletion commits.",
      speakingGuidance: "Use only active Role definitions.",
      decisionScope: "Recommend without approving.",
      constraints: "Do not create dangling Team references.",
      templateKey: null,
      toolPolicy: "none",
      dataPolicy: "meeting_only"
    });

    const deletion = store.deleteRole(role.id, role.version);
    await store.firstEntered;
    const teamCreation = store.createAgentTeam({
      name: "Deletion race Team",
      description: "Must wait for the Role deletion outcome.",
      members: [{ agentId: snapshot.agents[0]!.id, roleId: role.id, isChair: true }]
    });
    let teamSettled = false;
    void teamCreation.then(() => { teamSettled = true; }, () => { teamSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(teamSettled).toBe(false);

    store.release();
    await expect(deletion).resolves.toMatchObject({ id: role.id });
    await expect(teamCreation).rejects.toThrow(/deleted Role/i);
    expect((await store.getSnapshot()).agentTeams).toEqual([]);
  });

  it.each([
    {
      label: "Agent",
      event: "agent.created",
      collection: "agents" as const,
      create: (store: InMemoryPlatformStore) => store.createAgent({
        name: "Atomic Agent",
        description: "",
        modelConnectorId: null,
        goalSummary: "Keep management writes atomic.",
        toolsSummary: "No tools.",
        dataSummary: "No data.",
        skillIds: [],
        toolGrants: [],
        runtimeProfileBinding: null,
        promptBinding: null
      })
    },
    {
      label: "Model Connector",
      event: "model_connector.created",
      collection: "modelConnectors" as const,
      create: (store: InMemoryPlatformStore) => store.createModelConnector({
        name: "Atomic model",
        location: "cloud",
        baseUrl: "https://1.1.1.1/v1",
        model: "atomic-model"
      }, encrypted("model-secret"))
    },
    {
      label: "MCP Connector",
      event: "mcp_connector.created",
      collection: "mcpConnectors" as const,
      create: (store: InMemoryPlatformStore) => store.createMcpConnector({
        name: "Atomic MCP",
        location: "cloud",
        baseUrl: "https://1.0.0.1/mcp",
        approvedTools: ["search"]
      }, encrypted("mcp-secret"))
    },
    {
      label: "Task Adapter Connector",
      event: "task_adapter.created",
      collection: "taskAdapterConnectors" as const,
      create: (store: InMemoryPlatformStore) => store.createTaskAdapterConnector({
        name: "Atomic Task Adapter",
        location: "cloud",
        baseUrl: "https://1.1.1.1"
      }, encrypted("task-adapter-secret"))
    },
    {
      label: "Skill",
      event: "skill.created",
      collection: "skills" as const,
      create: (store: InMemoryPlatformStore) => store.createSkill({
        name: "Atomic Skill",
        version: "1.0.0",
        instructions: "Roll back this Skill if its required audit fails.",
        source: "internal",
        owner: "owner"
      })
    },
    {
      label: "Tool Pack",
      event: "tool_pack.created",
      collection: "toolPacks" as const,
      create: (store: InMemoryPlatformStore) => capabilityPack(store, "Atomic Tool Pack")
    }
  ])("rolls back $label creation when its required audit fails", async ({ event, collection, create }) => {
    const store = new FailingManagementAuditStore(event);
    const before = await store.getSnapshot();

    await expect(create(store)).rejects.toThrow(/Injected audit failure/);

    const after = await store.getSnapshot();
    expect(after[collection]).toEqual(before[collection]);
    const internals = store as unknown as {
      connectorSecrets: Map<string, string>;
      credentialSecrets: Map<string, string>;
    };
    expect(internals.connectorSecrets.size).toBe(0);
    expect(internals.credentialSecrets.size).toBe(0);
  });

  it.each([
    ["agent.updated", "description"],
    ["agent.model.changed", "modelConnectorId"]
  ] as const)("rolls back %s when its required audit fails", async (event, field) => {
    const store = new FailingManagementAuditStore(event);
    const connector = event === "agent.model.changed" ? await localConnector(store, "Atomic Agent model") : null;
    const before = await store.getSnapshot();
    const agent = before.agents[0]!;
    const revisions = await store.getAgentRevisions(agent.id);

    const mutation = event === "agent.model.changed"
      ? store.setAgentModel(agent.id, { modelConnectorId: connector!.id }, agent.draftRevision ?? 1)
      : store.updateAgent(agent.id, { [field]: "Atomic owner update" }, agent.draftRevision ?? 1);
    await expect(mutation).rejects.toThrow(/Injected audit failure/);

    expect((await store.getSnapshot()).agents.find((item) => item.id === agent.id)).toEqual(agent);
    expect(await store.getAgentRevisions(agent.id)).toEqual(revisions);
  });

  it("does not expose or retain a Model Connector update before its required audit commits", async () => {
    const store = new GatedFailingManagementAuditStore("model_connector.updated");
    const connector = await store.createModelConnector({
      name: "Committed model",
      location: "cloud",
      baseUrl: "https://1.1.1.1/v1",
      model: "committed-model"
    });
    const before = await store.getSnapshot();

    const update = store.updateModelConnector(connector.id, {
      expectedRevision: connector.revision,
      name: "Uncommitted model",
      enabled: false
    });
    await store.entered;

    expect((await store.getSnapshot()).modelConnectors).toEqual(before.modelConnectors);
    expect((await store.getSnapshot()).agents).toEqual(before.agents);

    store.release();
    await expect(update).rejects.toThrow(/delayed audit failure/);
    expect((await store.getSnapshot()).modelConnectors).toEqual(before.modelConnectors);
    expect((await store.getSnapshot()).agents).toEqual(before.agents);
  });

  it("keeps lifecycle-disabled Agents offline when their Model Connector is toggled", async () => {
    const seed = await new InMemoryPlatformStore().getSnapshot();
    const connector = {
      id: "c0000000-0000-4000-8000-000000000091",
      revision: 1,
      name: "Disabled Agent model",
      location: "local" as const,
      baseUrl: "http://10.20.30.40/v1",
      model: "local-model",
      enabled: true,
      hasSecret: false,
      secretRevision: 0,
      credentialId: null
    };
    seed.modelConnectors.push(connector);
    const agent = seed.agents[0]!;
    Object.assign(agent, {
      modelConnectorId: connector.id,
      lifecycleStatus: "disabled",
      status: "offline"
    });
    const store = new InMemoryPlatformStore(seed);

    const disabledConnector = await store.updateModelConnector(connector.id, {
      expectedRevision: connector.revision,
      enabled: false
    });
    expect((await store.getSnapshot()).agents.find((item) => item.id === agent.id)).toMatchObject({
      lifecycleStatus: "disabled",
      status: "offline"
    });

    await store.updateModelConnector(connector.id, {
      expectedRevision: disabledConnector.connector.revision,
      enabled: true
    });
    expect((await store.getSnapshot()).agents.find((item) => item.id === agent.id)).toMatchObject({
      lifecycleStatus: "disabled",
      status: "offline"
    });
  });

  it("preserves a Credential revocation that follows a delayed Model Connector audit", async () => {
    const store = new GatedSuccessfulManagementAuditStore("model_connector.updated");
    const credential = await store.createCredential({
      name: "Bound model credential",
      provider: "cloud-model",
      kind: "api_key",
      location: "cloud",
      expiresAt: null
    }, encrypted("bound-model-secret"));
    const connector = await store.createModelConnector({
      name: "Credential-bound model",
      location: "cloud",
      baseUrl: "https://1.1.1.1/v1",
      model: "bound-model",
      credentialId: credential.id
    });

    const update = store.updateModelConnector(connector.id, {
      expectedRevision: connector.revision,
      name: "Renamed bound model"
    });
    await store.firstEntered;
    const revoke = store.setCredentialStatus(credential.id, {
      status: "revoked",
      expectedUpdatedAt: credential.updatedAt
    });
    store.release();

    await expect(update).resolves.toMatchObject({ connector: { name: "Renamed bound model" } });
    await expect(revoke).resolves.toMatchObject({ status: "revoked" });
    expect((await store.getSnapshot()).modelConnectors.find((item) => item.id === connector.id)).toMatchObject({
      name: "Renamed bound model",
      credentialId: credential.id,
      hasSecret: false,
      secretRevision: credential.secretRevision
    });
  });

  it("does not commit a Model Connector from a Credential revoked during its creation audit", async () => {
    const store = new GatedSuccessfulManagementAuditStore("model_connector.created");
    const credential = await store.createCredential({
      name: "Creation-race credential",
      provider: "cloud-model",
      kind: "api_key",
      location: "cloud",
      expiresAt: null
    }, encrypted("creation-race-secret"));

    const creation = store.createModelConnector({
      name: "Creation-race model",
      location: "cloud",
      baseUrl: "https://1.0.0.1/v1",
      model: "creation-race-model",
      credentialId: credential.id
    });
    await store.firstEntered;
    const revoke = store.setCredentialStatus(credential.id, {
      status: "revoked",
      expectedUpdatedAt: credential.updatedAt
    });
    store.release();

    await expect(creation).resolves.toMatchObject({ credentialId: credential.id });
    await expect(revoke).resolves.toMatchObject({ status: "revoked" });
    expect((await store.getSnapshot()).modelConnectors.find((item) => item.name === "Creation-race model"))
      .toMatchObject({ credentialId: credential.id, hasSecret: false, secretRevision: credential.secretRevision });
  });

  it.each([
    {
      event: "skill.validated",
      mutate: (store: InMemoryPlatformStore, id: string) => store.validateSkill(id, {
        result: "passed",
        summary: "Reviewed against the current immutable content.",
        expectedCheckedAt: null
      })
    },
    {
      event: "skill.status.changed",
      prepare: (store: InMemoryPlatformStore, id: string) => store.validateSkill(id, {
        result: "passed",
        summary: "Reviewed before approval.",
        expectedCheckedAt: null
      }),
      mutate: async (store: InMemoryPlatformStore, id: string) => {
        const skill = (await store.getSnapshot()).skills.find((item) => item.id === id)!;
        return store.setSkillStatus(id, {
          status: "approved",
          expectedCheckedAt: skill.validation.checkedAt
        });
      }
    },
    {
      event: "skill.revoked",
      prepare: async (store: InMemoryPlatformStore, id: string) => {
        const validated = await store.validateSkill(id, {
          result: "passed",
          summary: "Reviewed before revocation.",
          expectedCheckedAt: null
        });
        await store.setSkillStatus(id, {
          status: "approved",
          expectedCheckedAt: validated.validation.checkedAt
        });
      },
      mutate: (store: InMemoryPlatformStore, id: string) => store.revokeSkill(id, {
        reason: "Retired from the approved Skill catalog."
      })
    }
  ])("does not expose or retain $event before its required audit commits", async ({ event, prepare, mutate }) => {
    const store = new GatedFailingManagementAuditStore(event);
    const skill = await store.createSkill({
      name: `Atomic ${event}`,
      version: "1.0.0",
      instructions: "Keep Skill lifecycle state behind its audit boundary.",
      source: "internal",
      owner: "owner"
    });
    if (prepare) await prepare(store, skill.id);
    const before = await store.getSnapshot();

    const mutation = mutate(store, skill.id);
    await store.entered;
    expect((await store.getSnapshot()).skills).toEqual(before.skills);

    store.release();
    await expect(mutation).rejects.toThrow(/delayed audit failure/);
    expect((await store.getSnapshot()).skills).toEqual(before.skills);
  });

  it("serializes concurrent creation of the same Skill version", async () => {
    const store = new GatedSuccessfulManagementAuditStore("skill.created");
    const create = () => store.createSkill({
      name: "Unique Skill",
      version: "1.0.0",
      instructions: "Only one copy of this immutable Skill may commit.",
      source: "internal",
      owner: "owner"
    });

    const first = create();
    await store.firstEntered;
    const second = create();
    store.release();

    await expect(first).resolves.toMatchObject({ name: "Unique Skill", version: "1.0.0" });
    await expect(second).rejects.toThrow(/already exist/i);
    expect((await store.getSnapshot()).skills.filter((item) => item.name === "Unique Skill")).toHaveLength(1);
  });

  it("rejects stale Skill validation evidence without overwriting the current review", async () => {
    const store = new InMemoryPlatformStore();
    const skill = await store.createSkill({
      name: "Validation CAS Skill",
      version: "1.0.0",
      instructions: "Keep the latest human validation evidence authoritative.",
      source: "internal",
      owner: "owner"
    });

    const current = await store.validateSkill(skill.id, {
      result: "failed",
      summary: "The latest reviewer found an unsafe instruction.",
      expectedCheckedAt: skill.validation.checkedAt
    });
    await expect(store.validateSkill(skill.id, {
      result: "passed",
      summary: "A stale tab must not overwrite the newer failed review.",
      expectedCheckedAt: skill.validation.checkedAt
    })).rejects.toThrow(/stale/i);

    expect((await store.getSnapshot()).skills.find((item) => item.id === skill.id)?.validation).toEqual(current.validation);
  });

  it("rejects approval that is not bound to the current Skill validation evidence", async () => {
    const store = new InMemoryPlatformStore();
    const skill = await store.createSkill({
      name: "Approval CAS Skill",
      version: "1.0.0",
      instructions: "Approve only the validation evidence shown to the owner.",
      source: "internal",
      owner: "owner"
    });
    const firstReview = await store.validateSkill(skill.id, {
      result: "passed",
      summary: "First passing review.",
      expectedCheckedAt: skill.validation.checkedAt
    });
    await store.validateSkill(skill.id, {
      result: "passed",
      summary: "A newer passing review replaced the visible evidence.",
      expectedCheckedAt: firstReview.validation.checkedAt
    });

    await expect(store.setSkillStatus(skill.id, {
      status: "approved",
      expectedCheckedAt: firstReview.validation.checkedAt
    })).rejects.toThrow(/stale/i);
    expect((await store.getSnapshot()).skills.find((item) => item.id === skill.id)?.status).toBe("draft");
  });

  it.each([
    {
      event: "tool_pack.updated",
      prepare: (store: InMemoryPlatformStore) => capabilityPack(store, "Update boundary Tool Pack"),
      mutate: (store: InMemoryPlatformStore, pack: ToolPack) => store.updateToolPack(pack.id, {
        expectedRevision: pack.revision,
        description: "This description must remain hidden until its audit commits."
      })
    },
    {
      event: "tool_pack.validation.passed",
      prepare: (store: InMemoryPlatformStore) => capabilityPack(store, "Validation boundary Tool Pack"),
      mutate: (store: InMemoryPlatformStore, pack: ToolPack) => store.validateToolPack(pack.id, {
        expectedRevision: pack.revision,
        manifestDigest: pack.manifestDigest,
        result: "passed",
        summary: "Manifest and read-only behavior verified."
      })
    },
    {
      event: "tool_pack.approved",
      prepare: async (store: InMemoryPlatformStore) => {
        const pack = await capabilityPack(store, "Approval boundary Tool Pack");
        return store.validateToolPack(pack.id, {
          expectedRevision: pack.revision,
          manifestDigest: pack.manifestDigest,
          result: "passed",
          summary: "Manifest and read-only behavior verified."
        });
      },
      mutate: (store: InMemoryPlatformStore, pack: ToolPack) => store.approveToolPack(pack.id, {
        expectedRevision: pack.revision,
        manifestDigest: pack.manifestDigest
      })
    },
    {
      event: "tool_pack.revoked",
      prepare: async (store: InMemoryPlatformStore) => {
        const pack = await capabilityPack(store, "Revocation boundary Tool Pack");
        const validated = await store.validateToolPack(pack.id, {
          expectedRevision: pack.revision,
          manifestDigest: pack.manifestDigest,
          result: "passed",
          summary: "Manifest and read-only behavior verified."
        });
        return store.approveToolPack(pack.id, {
          expectedRevision: validated.revision,
          manifestDigest: validated.manifestDigest
        });
      },
      mutate: (store: InMemoryPlatformStore, pack: ToolPack) => store.revokeToolPack(pack.id, {
        expectedRevision: pack.revision,
        reason: "Retired from the approved capability catalog."
      })
    }
  ])("does not expose or retain $event before its required audit commits", async ({ event, prepare, mutate }) => {
    const store = new GatedFailingManagementAuditStore(event);
    const pack = await prepare(store);
    const before = await store.getSnapshot();

    const mutation = mutate(store, pack);
    await store.entered;
    const pending = await store.getSnapshot();
    expect(pending.toolPacks).toEqual(before.toolPacks);
    expect(pending.toolPackRevisions).toEqual(before.toolPackRevisions);

    store.release();
    await expect(mutation).rejects.toThrow(/delayed audit failure/);
    const after = await store.getSnapshot();
    expect(after.toolPacks).toEqual(before.toolPacks);
    expect(after.toolPackRevisions).toEqual(before.toolPackRevisions);
  });

  it("serializes concurrent creation of the same Tool Pack name", async () => {
    const store = new GatedSuccessfulManagementAuditStore("tool_pack.created");
    const first = capabilityPack(store, "Unique Tool Pack");
    await store.firstEntered;
    const second = capabilityPack(store, "Unique Tool Pack");
    store.release();

    await expect(first).resolves.toMatchObject({ name: "Unique Tool Pack" });
    await expect(second).rejects.toThrow(/name already exists/i);
    expect(((await store.getSnapshot()).toolPacks ?? []).filter((item) => item.name === "Unique Tool Pack")).toHaveLength(1);
  });

  it("serializes same-Agent owner mutations across an audit rollback", async () => {
    const store = new DelayedFirstAgentAuditStore();
    const agent = (await store.getSnapshot()).agents[0]!;
    const first = store.updateAgent(agent.id, { description: "This write must roll back." }, agent.draftRevision ?? 1);
    await store.firstEntered;

    const second = store.updateAgent(agent.id, { description: "The later owner write survives." }, agent.draftRevision ?? 1);
    store.release();

    await expect(first).rejects.toThrow(/first Agent audit failure/);
    await expect(second).resolves.toMatchObject({
      description: "The later owner write survives.",
      draftRevision: (agent.draftRevision ?? 1) + 1
    });
    expect((await store.getSnapshot()).agents.find((item) => item.id === agent.id)).toMatchObject({
      description: "The later owner write survives.",
      draftRevision: (agent.draftRevision ?? 1) + 1
    });
  });

  it("does not let publish observe and commit an Agent draft whose audit later fails", async () => {
    const ready = await teamReadyStore();
    const store = new DelayedFirstAgentAuditStore(await ready.getSnapshot());
    const agent = (await store.getSnapshot()).agents[0]!;
    const nextRevision = (agent.draftRevision ?? 1) + 1;
    const update = store.updateAgent(agent.id, { description: "This draft must never become visible." }, agent.draftRevision ?? 1);
    await store.firstEntered;

    expect((await store.getSnapshot()).agents.find((item) => item.id === agent.id)).toEqual(agent);
    const publish = store.publishAgent(agent.id, { expectedDraftRevision: nextRevision });
    store.release();

    await expect(update).rejects.toThrow(/first Agent audit failure/);
    await expect(publish).rejects.toThrow(/revision is stale|not found/i);
    expect((await store.getSnapshot()).agents.find((item) => item.id === agent.id)).toEqual(agent);
  });

  it("preserves an MCP grant revocation that follows a delayed Agent audit", async () => {
    const store = new GatedSuccessfulManagementAuditStore("agent.updated");
    const connector = await store.createMcpConnector({
      name: "Serialized MCP",
      location: "cloud",
      baseUrl: "https://1.1.1.1/mcp",
      approvedTools: ["search"]
    });
    const agent = await store.createAgent({
      name: "Serialized Agent",
      description: "",
      modelConnectorId: null,
      goalSummary: "Preserve later governance changes.",
      toolsSummary: "Search.",
      dataSummary: "Meeting data.",
      skillIds: [],
      toolGrants: [{ connectorId: connector.id, toolName: "search" }],
      runtimeProfileBinding: null,
      promptBinding: null
    });
    const update = store.updateAgent(agent.id, { description: "Audited owner edit." }, agent.draftRevision ?? 1);
    await store.firstEntered;

    const revoke = store.updateMcpConnector(connector.id, {
      expectedRevision: connector.revision,
      enabled: false
    });
    store.release();

    await expect(update).resolves.toMatchObject({ description: "Audited owner edit." });
    await expect(revoke).resolves.toMatchObject({ revokedGrantCount: 1 });
    const current = (await store.getSnapshot()).agents.find((item) => item.id === agent.id)!;
    expect(current.toolGrants).toEqual([]);
    expect(current.draftRevision).toBe((agent.draftRevision ?? 1) + 2);
    expect(await store.getAgentRevisions(agent.id)).toHaveLength(3);
  });

  it.each([
    {
      label: "Model Connector",
      event: "model_connector.created",
      collection: "modelConnectors" as const,
      create: (store: InMemoryPlatformStore, name: string) => store.createModelConnector({
        name,
        location: "local",
        baseUrl: "http://10.20.30.40/v1",
        model: "serialized-model"
      })
    },
    {
      label: "MCP Connector",
      event: "mcp_connector.created",
      collection: "mcpConnectors" as const,
      create: (store: InMemoryPlatformStore, name: string) => store.createMcpConnector({
        name,
        location: "local",
        baseUrl: "http://10.20.30.40/mcp",
        approvedTools: ["search"]
      })
    },
    {
      label: "Task Adapter Connector",
      event: "task_adapter.created",
      collection: "taskAdapterConnectors" as const,
      create: (store: InMemoryPlatformStore, name: string) => store.createTaskAdapterConnector({
        name,
        location: "local",
        baseUrl: "http://10.20.30.40"
      })
    }
  ])("serializes concurrent same-name $label creation", async ({ event, collection, create }) => {
    const store = new GatedSuccessfulManagementAuditStore(event);
    const name = `Unique ${event}`;
    const first = create(store, name);
    await store.firstEntered;
    const second = create(store, name);
    store.release();

    await expect(first).resolves.toMatchObject({ name });
    await expect(second).rejects.toThrow(/name already exists|one enabled/i);
    expect((await store.getSnapshot())[collection].filter((item) => item.name === name)).toHaveLength(1);
  });

  it("keeps encrypted credential material outside the public snapshot and rejects plaintext fields", async () => {
    const store = new InMemoryPlatformStore();
    const credential = await store.createCredential({
      name: "Cloud key",
      provider: "cloud-provider",
      kind: "api_key",
      location: "cloud",
      expiresAt: null
    }, encrypted("secret-one"));

    const snapshot = await store.getSnapshot();
    expect(JSON.stringify(snapshot)).not.toContain("secret-one");
    expect(JSON.stringify(snapshot)).not.toContain("vault:v1:secret-one");
    await expect(store.getCredentialSecret(credential.id)).resolves.toBe("vault:v1:secret-one");
    await expect(store.createCredential({
      name: "Unsafe",
      provider: "test",
      kind: "api_key",
      location: "local",
      expiresAt: null,
      secret: "plaintext"
    } as never)).rejects.toThrow(/Plaintext Credential secrets/);
  });

  it("replays Credential creation by key-bound secret proof and rejects changed secret evidence", async () => {
    const store = new InMemoryPlatformStore();
    const input = {
      name: "Retry-bound Credential",
      provider: "test-provider",
      kind: "api_key" as const,
      location: "cloud" as const,
      expiresAt: null
    };
    const proof = `hmac-sha256:v1:${"a".repeat(64)}`;
    const key = "credential-memory-retry";

    await expect(store.createCredential(input, { ciphertext: "vault:v1:missing-proof" }, key))
      .rejects.toMatchObject({ apiCode: "CREDENTIAL_IDEMPOTENCY_PROOF_REQUIRED" });

    const [first, replay] = await Promise.all([
      store.createCredential(input, { ciphertext: "vault:v1:first", idempotencyProof: proof }, key),
      store.createCredential(input, { ciphertext: "vault:v1:randomized-retry", idempotencyProof: proof }, key)
    ]);

    expect(replay).toEqual(first);
    expect((await store.getCredentials()).filter((credential) => credential.name === input.name)).toHaveLength(1);
    await expect(store.getCredentialSecret(first.id)).resolves.toBe("vault:v1:first");
    await expect(store.createCredential(input, {
      ciphertext: "vault:v1:changed",
      idempotencyProof: `hmac-sha256:v1:${"b".repeat(64)}`
    }, key)).rejects.toMatchObject({ apiCode: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("supports CAS rotation and terminal revocation while updating linked models", async () => {
    const store = new InMemoryPlatformStore();
    const credential = await store.createCredential({
      name: "Local vault key",
      provider: "local",
      kind: "bearer_token",
      location: "local",
      expiresAt: null
    }, encrypted("one"));
    const connector = await store.createModelConnector({
      name: "Credential-bound local",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "meeting-local",
      credentialId: credential.id
    });

    await expect(store.rotateCredential({ credentialId: credential.id, expectedSecretRevision: 99 }, encrypted("bad")))
      .rejects.toMatchObject({ kind: "revision", message: expect.stringMatching(/stale/i) });
    await store.rotateCredential({ credentialId: credential.id, expectedSecretRevision: 1 }, encrypted("two"), "...two");
    expect(await store.getCredentialSecret(credential.id)).toBe("vault:v1:two");
    expect((await store.getSnapshot()).modelConnectors.find((item) => item.id === connector.id)).toMatchObject({
      hasSecret: true,
      secretRevision: 2,
      credentialId: credential.id
    });
    const rotatedCredential = (await store.getCredentials()).find((item) => item.id === credential.id)!;
    await store.setCredentialStatus(credential.id, {
      status: "revoked",
      expectedUpdatedAt: rotatedCredential.updatedAt
    });
    expect((await store.getSnapshot()).modelConnectors.find((item) => item.id === connector.id)).toMatchObject({ hasSecret: false });
    const revokedCredential = (await store.getCredentials()).find((item) => item.id === credential.id)!;
    await expect(store.setCredentialStatus(credential.id, {
      status: "active",
      expectedUpdatedAt: revokedCredential.updatedAt
    })).rejects.toThrow(/terminal/i);
  });

  it("rejects a stale Credential lifecycle update after an intervening disable", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-12T01:00:00.000Z"));
      const store = new InMemoryPlatformStore();
      const credential = await store.createCredential({
        name: "Credential status CAS",
        provider: "cloud-provider",
        kind: "api_key",
        location: "cloud",
        expiresAt: null
      }, encrypted("credential-status-cas"));

      vi.setSystemTime(new Date("2026-08-12T01:00:01.000Z"));
      const firstDisabled = await store.setCredentialStatus(credential.id, {
        status: "disabled",
        expectedUpdatedAt: credential.updatedAt
      });
      vi.setSystemTime(new Date("2026-08-12T01:00:02.000Z"));
      const active = await store.setCredentialStatus(credential.id, {
        status: "active",
        expectedUpdatedAt: firstDisabled.updatedAt
      });
      vi.setSystemTime(new Date("2026-08-12T01:00:03.000Z"));
      await store.setCredentialStatus(credential.id, {
        status: "disabled",
        expectedUpdatedAt: active.updatedAt
      });

      await expect(store.setCredentialStatus(credential.id, {
        status: "active",
        expectedUpdatedAt: firstDisabled.updatedAt
      })).rejects.toThrow(/stale/i);
      expect((await store.getCredentials()).find((item) => item.id === credential.id)?.status).toBe("disabled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a stale Credential metadata update after an intervening edit", async () => {
    const store = new InMemoryPlatformStore();
    const credential = await store.createCredential({
      name: "Credential metadata CAS",
      provider: "cloud-provider",
      kind: "api_key",
      location: "cloud",
      expiresAt: null
    }, encrypted("credential-metadata-cas"));

    const updated = await store.updateCredential(credential.id, {
      provider: "current-provider",
      expectedUpdatedAt: credential.updatedAt
    });
    await expect(store.updateCredential(credential.id, {
      name: "Stale overwrite",
      expectedUpdatedAt: credential.updatedAt
    })).rejects.toThrow(/stale/i);

    expect((await store.getCredentials()).find((item) => item.id === credential.id)).toMatchObject({
      name: credential.name,
      provider: updated.provider,
      updatedAt: updated.updatedAt
    });
  });

  it("invalidates a Credential metadata token after secret rotation", async () => {
    const store = new InMemoryPlatformStore();
    const credential = await store.createCredential({
      name: "Credential cross-lifecycle CAS",
      provider: "cloud-provider",
      kind: "api_key",
      location: "cloud",
      expiresAt: null
    }, encrypted("credential-before-rotation"));

    await store.rotateCredential({
      credentialId: credential.id,
      expectedSecretRevision: credential.secretRevision
    }, encrypted("credential-after-rotation"));

    await expect(store.updateCredential(credential.id, {
      provider: "stale-provider",
      expectedUpdatedAt: credential.updatedAt
    })).rejects.toThrow(/stale/i);
    expect((await store.getCredentials()).find((item) => item.id === credential.id)).toMatchObject({
      provider: credential.provider,
      secretRevision: credential.secretRevision + 1
    });
  });

  it("rejects Credential rotation when the CAS revision is missing", async () => {
    const store = new InMemoryPlatformStore();
    const credential = await store.createCredential({
      name: "CAS-required key",
      provider: "local",
      kind: "api_key",
      location: "local",
      expiresAt: null
    }, encrypted("one"));

    await expect(store.rotateCredential(
      { credentialId: credential.id } as never,
      encrypted("unsafe-overwrite")
    )).rejects.toThrow(/revision|stale/i);
    await expect(store.getCredentialSecret(credential.id)).resolves.toBe("vault:v1:one");
  });

  it("preserves legacy connector bindings for blank ciphertext and increments revision on rotation", async () => {
    const connectorId = "d0000000-0000-4000-8000-000000000011";
    const seed = new InMemoryPlatformStore();
    const snapshot = await seed.getSnapshot();
    snapshot.modelConnectors.push({
      id: connectorId,
      revision: 1,
      name: "Legacy cloud",
      location: "cloud",
      baseUrl: "https://models.example.com/v1",
      model: "legacy-model",
      enabled: true,
      hasSecret: true,
      secretRevision: 1,
      credentialId: null
    });
    const store = new InMemoryPlatformStore(snapshot);
    const internals = store as unknown as { connectorSecrets: Map<string, string> };
    internals.connectorSecrets.set(connectorId, "vault:v1:legacy");

    await expect(store.updateModelConnector(connectorId, { expectedRevision: 1, model: "legacy-v2" }, { ciphertext: "" }))
      .resolves.toMatchObject({ connector: { hasSecret: true, secretRevision: 1, credentialId: null } });
    await expect(store.updateModelConnector(connectorId, { expectedRevision: 2, model: "legacy-v3" }, encrypted("rotated")))
      .resolves.toMatchObject({ connector: { hasSecret: true, secretRevision: 2, credentialId: null } });
    await expect(store.getConnectorSecret(connectorId)).resolves.toBe("vault:v1:rotated");
  });

  it("creates a replacement Agent draft when MCP revocation removes a Tool grant", async () => {
    const store = new InMemoryPlatformStore();
    const model = await localConnector(store, "MCP revocation model");
    const prompt = await store.createPrompt({
      name: "MCP revocation prompt",
      kind: "agent",
      description: "Keeps the Agent publishable while Tool grants change.",
      owner: "Test Owner",
      content: "Review the Meeting using approved Tools only.",
      variables: []
    });
    await store.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 });
    const mcp = await store.createMcpConnector({
      name: "Revocable search",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"]
    });
    const agent = await store.createAgent({
      name: "MCP revision Agent",
      description: "",
      modelConnectorId: model.id,
      goalSummary: "Review one bounded Meeting.",
      toolsSummary: "Approved search only.",
      dataSummary: "Meeting context only.",
      skillIds: [],
      toolGrants: [{ connectorId: mcp.id, toolName: "search" }],
      runtimeProfileBinding: null,
      promptBinding: { promptId: prompt.id, version: 1 }
    });
    await store.publishAgent(agent.id, { expectedDraftRevision: 1 });
    const draftWithGrant = await store.updateAgent(agent.id, { description: "Unpublished owner edit." });

    await store.updateMcpConnector(mcp.id, { expectedRevision: mcp.revision, enabled: false });

    const afterRevocation = (await store.getSnapshot()).agents.find((candidate) => candidate.id === agent.id)!;
    expect(afterRevocation.draftRevision).toBe((draftWithGrant.draftRevision ?? 0) + 1);
    expect(afterRevocation.toolGrants).toEqual([]);
    await expect(store.getAgentRevision(agent.id, draftWithGrant.draftRevision!)).resolves.toMatchObject({
      toolGrants: [{ connectorId: mcp.id, toolName: "search" }]
    });
    await expect(store.getAgentRevision(agent.id, afterRevocation.draftRevision!)).resolves.toMatchObject({ toolGrants: [] });
    await expect(store.publishAgent(agent.id, { expectedDraftRevision: afterRevocation.draftRevision! }))
      .resolves.toMatchObject({ toolGrants: [], publishedRevision: afterRevocation.draftRevision });
  });
});

describe("runtime profile management", () => {
  it("backfills the default Runtime Profile and keeps immutable revision history", async () => {
    const store = new InMemoryPlatformStore();

    await expect(store.getRuntimeProfiles()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "76000000-0000-4000-8000-000000000001",
        harnessKind: "openai_compatible",
        policy: "text_only",
        capabilities: ["text", "abort"],
        enabled: true,
        revision: 1
      })
    ]));
    expect((await store.getSnapshot()).agents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runtimeProfileBinding: { profileId: "76000000-0000-4000-8000-000000000001", revision: 1 }
      })
    ]));

    const created = await store.createRuntimeProfile({
      name: "Bound worker runtime",
      harnessKind: "openai_compatible",
      modelConnectorId: null,
      sandboxProfileId: null,
      policy: "text_only",
      capabilities: ["text", "abort"],
      timeoutMs: 60_000,
      maxConcurrency: 1,
      enabled: true
    });
    expect(created).toMatchObject({ revision: 1, timeoutMs: 60_000 });

    const updated = await store.updateRuntimeProfile(created.id, {
      expectedRevision: 1,
      timeoutMs: 75_000,
      enabled: false
    });
    expect(updated).toMatchObject({ revision: 2, timeoutMs: 75_000, enabled: false });
    await expect(store.updateRuntimeProfile(created.id, {
      expectedRevision: 1,
      timeoutMs: 80_000
    })).rejects.toMatchObject({ kind: "revision", message: expect.stringMatching(/stale/i) });
    await expect(store.updateRuntimeProfile(created.id, {
      expectedRevision: 2,
      policy: "isolated_exec",
      capabilities: ["text", "process"]
    })).rejects.toThrow(/sandbox/i);

    await expect(store.getRuntimeProfileRevisions(created.id)).resolves.toEqual([
      expect.objectContaining({ profileId: created.id, revision: 2, timeoutMs: 75_000, enabled: false }),
      expect.objectContaining({ profileId: created.id, revision: 1, timeoutMs: 60_000, enabled: true })
    ]);
  });
});

describe("prompt and agent lifecycle management", () => {
  it("classifies every stale Prompt CAS mutation as a revision conflict", async () => {
    const mutations = [
      (store: InMemoryPlatformStore, id: string) => store.updatePrompt(id, {
        expectedCurrentVersion: 1,
        content: "Stale update."
      }),
      (store: InMemoryPlatformStore, id: string) => store.publishPrompt(id, {
        expectedCurrentVersion: 1,
        version: 1
      }),
      (store: InMemoryPlatformStore, id: string) => store.rollbackPrompt(id, {
        expectedCurrentVersion: 1,
        version: 1
      }),
      (store: InMemoryPlatformStore, id: string) => store.archivePrompt(id, {
        expectedCurrentVersion: 1
      })
    ];

    for (const [index, mutate] of mutations.entries()) {
      const store = new InMemoryPlatformStore();
      const prompt = await store.createPrompt({
        name: `Prompt CAS ${index}`,
        kind: "agent",
        description: "Classify stale optimistic concurrency.",
        owner: "owner",
        content: "Version one.",
        variables: []
      });
      await store.updatePrompt(prompt.id, { expectedCurrentVersion: 1, content: "Version two." });

      await expect(mutate(store, prompt.id)).rejects.toMatchObject({ kind: "revision" });
    }
  });

  it("rejects a Prompt rename that collides with another Prompt", async () => {
    const store = new InMemoryPlatformStore();
    await store.createPrompt({
      name: "Canonical Prompt",
      kind: "agent",
      description: "Existing name owner.",
      owner: "owner",
      content: "Review bounded evidence.",
      variables: []
    });
    const candidate = await store.createPrompt({
      name: "Rename candidate",
      kind: "agent",
      description: "Must retain its own name.",
      owner: "owner",
      content: "Review another bounded scope.",
      variables: []
    });

    await expect(store.updatePrompt(candidate.id, {
      expectedCurrentVersion: 1,
      name: " canonical prompt "
    })).rejects.toThrow(/name already exists/i);
    expect((await store.getSnapshot()).prompts?.find((prompt) => prompt.id === candidate.id))
      .toMatchObject({ name: "Rename candidate", currentVersion: 1 });
    await expect(store.getPromptVersions(candidate.id)).resolves.toHaveLength(1);
  });

  it("keeps a Prompt version's first publication timestamp immutable", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-10T01:00:00.000Z"));
      const store = new InMemoryPlatformStore();
      const prompt = await store.createPrompt({
        name: "Immutable publication timestamp",
        kind: "agent",
        description: "Do not rewrite first-publication evidence.",
        owner: "owner",
        content: "Review bounded evidence.",
        variables: []
      });
      await store.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 });
      const firstPublishedAt = (await store.getPromptVersion(prompt.id, 1)).publishedAt;

      vi.setSystemTime(new Date("2026-08-10T02:00:00.000Z"));
      await expect(store.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 }))
        .rejects.toThrow(/already published/i);

      expect((await store.getPromptVersion(prompt.id, 1)).publishedAt).toBe(firstPublishedAt);

      const updated = await store.updatePrompt(prompt.id, {
        expectedCurrentVersion: 1,
        content: "Review bounded evidence and record provenance."
      });
      await store.publishPrompt(prompt.id, { expectedCurrentVersion: updated.currentVersion, version: updated.currentVersion });
      vi.setSystemTime(new Date("2026-08-10T03:00:00.000Z"));

      await expect(store.publishPrompt(prompt.id, { expectedCurrentVersion: 2, version: 1 }))
        .rejects.toThrow(/already published|current version/i);
      expect((await store.getPromptVersion(prompt.id, 1)).publishedAt).toBe(firstPublishedAt);
      expect((await store.getSnapshot()).prompts?.find((item) => item.id === prompt.id)).toMatchObject({
        currentVersion: 2,
        publishedVersion: 2
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects Prompt rollback targets that are not older without changing state or history", async () => {
    const store = new InMemoryPlatformStore();
    const prompt = await store.createPrompt({
      name: "Rollback direction guard",
      kind: "agent",
      description: "Only historical Prompt versions can be rollback targets.",
      owner: "owner",
      content: "Review bounded evidence.",
      variables: []
    });
    const current = await store.updatePrompt(prompt.id, {
      expectedCurrentVersion: prompt.currentVersion,
      content: "Review bounded evidence and record provenance."
    });
    const beforePrompt = (await store.getSnapshot()).prompts?.find((item) => item.id === prompt.id);
    const beforeVersions = await store.getPromptVersions(prompt.id);

    for (const version of [current.currentVersion, current.currentVersion + 1]) {
      await expect(store.rollbackPrompt(prompt.id, {
        expectedCurrentVersion: current.currentVersion,
        version
      })).rejects.toThrow(/older than the current version/i);
      expect((await store.getSnapshot()).prompts?.find((item) => item.id === prompt.id)).toEqual(beforePrompt);
      expect(await store.getPromptVersions(prompt.id)).toEqual(beforeVersions);
    }
  });

  it("validates Prompt tokens and keeps immutable version history through publish and rollback", async () => {
    const store = new InMemoryPlatformStore();
    await expect(store.createPrompt({
      name: "Invalid undeclared",
      kind: "agent",
      description: "",
      owner: "owner",
      content: "Use {{UNKNOWN}}.",
      variables: []
    })).rejects.toThrow(/undeclared/i);
    await expect(store.createPrompt({
      name: "Invalid unused",
      kind: "agent",
      description: "",
      owner: "owner",
      content: "No variable.",
      variables: ["GOAL"]
    })).rejects.toThrow(/unused/i);

    const prompt = await store.createPrompt({
      name: "Meeting Agent Prompt",
      kind: "agent",
      description: "A controlled prompt.",
      owner: "owner",
      content: "Focus on {{GOAL}}.",
      variables: ["GOAL"]
    });
    await store.updatePrompt(prompt.id, {
      expectedCurrentVersion: 1,
      content: "Focus on {{GOAL}} and record evidence."
    });
    await store.publishPrompt(prompt.id, { expectedCurrentVersion: 2, version: 2 });
    const rolled = await store.rollbackPrompt(prompt.id, { expectedCurrentVersion: 2, version: 1 });
    expect(rolled).toMatchObject({ currentVersion: 3, publishedVersion: 3, status: "published" });
    const versions = await store.getPromptVersions(prompt.id);
    expect(versions.map((item) => item.version)).toEqual([3, 2, 1]);
    expect(versions.find((item) => item.version === 1)?.content).toBe("Focus on {{GOAL}}.");
    expect(versions.find((item) => item.version === 3)).toMatchObject({ restoredFromVersion: 1, publishedAt: expect.any(String) });
    expect(versions[0]!.contentDigest).toHaveLength(64);
  });

  it("keeps published Agent revisions stable while editing a new draft", async () => {
    const store = new InMemoryPlatformStore();
    const connector = await localConnector(store);
    const prompt = await store.createPrompt({
      name: "Revision prompt",
      kind: "agent",
      description: "",
      owner: "owner",
      content: "Review the meeting goal.",
      variables: []
    });
    await store.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 });
    const agent = await store.createAgent({
      name: "Revision Agent",
      description: "",
      modelConnectorId: connector.id,
      goalSummary: "Review meetings.",
      toolsSummary: "No external tools.",
      dataSummary: "Meeting data.",
      skillIds: [],
      toolGrants: [],
      runtimeProfileBinding: null,
      promptBinding: { promptId: prompt.id, version: 1 }
    });
    await expect(store.publishAgent(agent.id, { expectedDraftRevision: 99 }))
      .rejects.toMatchObject({ kind: "revision", message: expect.stringMatching(/stale/i) });
    await expect(store.publishAgent(agent.id, { expectedDraftRevision: 1 })).resolves.toMatchObject({ publishedRevision: 1, lifecycleStatus: "published" });
    await store.updateAgent(agent.id, { name: "Revision Agent v2" });
    expect((await store.getSnapshot()).agents.find((item) => item.id === agent.id)).toMatchObject({
      name: "Revision Agent v2",
      draftRevision: 2,
      publishedRevision: 1,
      lifecycleStatus: "draft"
    });
    await expect(store.publishAgent(agent.id, { expectedDraftRevision: 2 })).resolves.toMatchObject({
      publishedRevision: 2,
      lifecycleStatus: "published"
    });
    await expect(store.publishAgent(agent.id, { expectedDraftRevision: 2 })).rejects.toThrow(/no unpublished draft/i);
    const revisions = await store.getAgentRevisions(agent.id);
    expect(revisions.map((item) => item.revision)).toEqual([2, 1]);
    expect(revisions.find((item) => item.revision === 1)?.name).toBe("Revision Agent");

    await expect(store.rollbackAgent(agent.id, {
      expectedPublishedRevision: 1,
      expectedDraftRevision: 2,
      revision: 1
    })).rejects.toMatchObject({ kind: "revision", message: expect.stringMatching(/stale/i) });
    const restored = await store.rollbackAgent(agent.id, {
      expectedPublishedRevision: 2,
      expectedDraftRevision: 2,
      revision: 1
    });
    expect(restored).toMatchObject({ name: "Revision Agent", draftRevision: 3, publishedRevision: 2 });
    await store.publishAgent(agent.id, { expectedDraftRevision: 3 });
    const unpublished = await store.updateAgent(agent.id, { name: "Revision Agent protected draft" });
    await expect(store.rollbackAgent(agent.id, {
      expectedPublishedRevision: 3,
      expectedDraftRevision: unpublished.draftRevision!,
      revision: 1
    })).rejects.toThrow(/unpublished draft/i);
    expect((await store.getSnapshot()).agents.find((item) => item.id === agent.id)).toMatchObject({
      name: "Revision Agent protected draft",
      draftRevision: unpublished.draftRevision,
      publishedRevision: 3
    });
  });

  it("publishes an OMP Agent from static bindings while runtime readiness remains attestation-gated", async () => {
    const store = new InMemoryPlatformStore();
    const connector = await localConnector(store, "OMP publish model");
    const prompt = await store.createPrompt({
      name: "OMP publish prompt",
      kind: "agent",
      description: "",
      owner: "owner",
      content: "Execute only the approved isolated task.",
      variables: []
    });
    await store.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 });
    const profile = await store.createRuntimeProfile({
      name: "OMP publish runtime",
      harnessKind: "pi",
      modelConnectorId: connector.id,
      sandboxProfileId: "70000000-0000-4000-8000-000000000204",
      policy: "isolated_exec",
      capabilities: ["text", "abort", "resume", "file_read", "file_write", "process"],
      timeoutMs: 2 * 60 * 60_000,
      maxConcurrency: 1,
      enabled: true
    });
    const agent = await store.createAgent({
      name: "OMP publish Agent",
      description: "",
      modelConnectorId: connector.id,
      goalSummary: "Execute approved coding tasks.",
      toolsSummary: "Isolated workspace tools only.",
      dataSummary: "Approved workspace archive only.",
      skillIds: [],
      toolGrants: [],
      toolPackGrants: [],
      runtimeProfileBinding: { profileId: profile.id, revision: profile.revision },
      promptBinding: { promptId: prompt.id, version: 1 }
    });

    await expect(store.publishAgent(agent.id, { expectedDraftRevision: agent.draftRevision! }))
      .resolves.toMatchObject({ lifecycleStatus: "published", publishedRevision: 1 });
    await expect(store.getAgentReadiness(agent.id)).resolves.toMatchObject({
      status: "blocked",
      checks: expect.arrayContaining([
        expect.objectContaining({ code: "runtime", status: "blocked" })
      ])
    });
    await expect(store.getAgentReadiness(agent.id, { executionIsolationAttested: true }))
      .resolves.toMatchObject({ status: "ready" });
  });

  it("rejects a publish when the Agent draft changes during readiness evaluation", async () => {
    let holdReadiness = false;
    let signalReadinessStarted!: () => void;
    let releaseReadiness!: () => void;
    const readinessStarted = new Promise<void>((resolve) => { signalReadinessStarted = resolve; });
    const readinessRelease = new Promise<void>((resolve) => { releaseReadiness = resolve; });
    class GatedReadinessStore extends InMemoryPlatformStore {
      override async getAgentReadiness(id: string) {
        const readiness = await super.getAgentReadiness(id);
        if (holdReadiness) {
          signalReadinessStarted();
          await readinessRelease;
        }
        return readiness;
      }
    }

    const store = new GatedReadinessStore();
    const connector = await localConnector(store, "Publish CAS model");
    const prompt = await store.createPrompt({
      name: "Publish CAS Prompt",
      kind: "agent",
      description: "",
      owner: "owner",
      content: "Review the bounded goal.",
      variables: []
    });
    await store.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 });
    const agent = await store.createAgent({
      name: "Publish CAS Agent",
      description: "",
      modelConnectorId: connector.id,
      goalSummary: "Review one bounded goal.",
      toolsSummary: "No external tools.",
      dataSummary: "Meeting data.",
      skillIds: [],
      toolGrants: [],
      runtimeProfileBinding: null,
      promptBinding: { promptId: prompt.id, version: 1 }
    });

    holdReadiness = true;
    const pendingPublish = store.publishAgent(agent.id, { expectedDraftRevision: 1 });
    await readinessStarted;
    const newerDraft = await store.updateAgent(agent.id, { name: "Publish CAS Agent v2" });
    releaseReadiness();

    await expect(pendingPublish).rejects.toMatchObject({
      kind: "revision",
      message: expect.stringMatching(/stale/i)
    });
    expect((await store.getSnapshot()).agents.find((item) => item.id === agent.id)).toMatchObject({
      name: "Publish CAS Agent v2",
      lifecycleStatus: "draft",
      draftRevision: newerDraft.draftRevision,
      publishedRevision: null
    });
    expect(await store.getAgentRevision(agent.id, 1)).toMatchObject({ publishedAt: null });
  });

  it("preserves a newly created Agent as unpublished after snapshot rehydration", async () => {
    const store = new InMemoryPlatformStore();
    const connector = await localConnector(store, "Rehydrated local model");
    const prompt = await store.createPrompt({
      name: "Rehydrated Agent Prompt",
      kind: "agent",
      description: "",
      owner: "owner",
      content: "Review the meeting goal.",
      variables: []
    });
    await store.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 });
    const agent = await store.createAgent({
      name: "Rehydrated draft Agent",
      description: "",
      modelConnectorId: connector.id,
      goalSummary: "Review meetings.",
      toolsSummary: "No external tools.",
      dataSummary: "Meeting data.",
      skillIds: [],
      toolGrants: [],
      runtimeProfileBinding: null,
      promptBinding: { promptId: prompt.id, version: 1 }
    });
    const rehydrated = new InMemoryPlatformStore(await store.getSnapshot(), {
      agentRevisions: await store.getAgentRevisions(agent.id),
      promptVersions: await store.getPromptVersions(prompt.id)
    });

    expect((await rehydrated.getSnapshot()).agents.find((item) => item.id === agent.id))
      .toMatchObject({ lifecycleStatus: "draft", draftRevision: 1, publishedRevision: null });
    await expect(rehydrated.publishAgent(agent.id, { expectedDraftRevision: 1 }))
      .resolves.toMatchObject({ lifecycleStatus: "published", publishedRevision: 1 });
  });

  it("does not strand a never-published Agent in the disabled lifecycle state", async () => {
    const store = new InMemoryPlatformStore();
    const agent = await store.createAgent({
      name: "Draft lifecycle Agent",
      description: "",
      modelConnectorId: null,
      goalSummary: "Remain recoverable before first publication.",
      toolsSummary: "No tools.",
      dataSummary: "No data.",
      skillIds: [],
      toolGrants: [],
      runtimeProfileBinding: null,
      promptBinding: null
    });

    await expect(store.setAgentStatus(agent.id, {
      status: "disabled",
      expectedRevision: agent.draftRevision!
    })).rejects.toThrow(/publish/i);
    expect((await store.getSnapshot()).agents.find((item) => item.id === agent.id))
      .toMatchObject({ lifecycleStatus: "draft", publishedRevision: null });

    const legacySnapshot = await store.getSnapshot();
    const legacyAgent = legacySnapshot.agents.find((item) => item.id === agent.id)!;
    legacyAgent.lifecycleStatus = "disabled";
    legacyAgent.status = "offline";
    const legacyStore = new InMemoryPlatformStore(legacySnapshot, {
      agentRevisions: await store.getAgentRevisions(agent.id)
    });
    await expect(legacyStore.setAgentStatus(agent.id, {
      status: "draft",
      expectedRevision: agent.draftRevision!
    })).resolves.toMatchObject({ lifecycleStatus: "draft", publishedRevision: null });

    const published = (await legacyStore.getSnapshot()).agents.find((candidate) => (
      candidate.id !== agent.id && candidate.publishedRevision != null
    ))!;
    await expect(legacyStore.setAgentStatus(published.id, {
      status: "draft",
      expectedRevision: published.draftRevision!
    })).rejects.toThrow(/transition|publish/i);

    const changed = await legacyStore.updateAgent(published.id, {
      description: "Keep this unpublished revision behind the publish gate."
    }, published.draftRevision!);
    await expect(legacyStore.setAgentStatus(published.id, {
      status: "published",
      expectedRevision: changed.draftRevision!
    })).rejects.toThrow(/transition|publish/i);
  });

  it("advances the Agent resource revision and rejects stale lifecycle mutations", async () => {
    const store = new InMemoryPlatformStore();
    const [contentAgent, lifecycleAgent] = (await store.getSnapshot()).agents;
    const contentRevision = contentAgent!.revision ?? contentAgent!.draftRevision ?? contentAgent!.publishedRevision ?? 1;
    const lifecycleRevision = lifecycleAgent!.revision ?? lifecycleAgent!.draftRevision ?? lifecycleAgent!.publishedRevision ?? 1;

    const updated = await store.updateAgent(contentAgent!.id, {
      description: "Advance the Agent resource revision without changing lifecycle through this stale client."
    }, contentAgent!.draftRevision);
    expect(updated.revision).toBe(contentRevision + 1);
    await expect(store.updateAgent(contentAgent!.id, {
      description: "Reject a stale Agent draft overwrite."
    }, contentAgent!.draftRevision)).rejects.toMatchObject({
      kind: "revision",
      message: expect.stringMatching(/stale/i)
    });
    await expect(store.setAgentStatus(contentAgent!.id, {
      status: "disabled",
      expectedRevision: contentRevision
    })).rejects.toMatchObject({ kind: "revision", message: expect.stringMatching(/stale/i) });

    const disabled = await store.setAgentStatus(lifecycleAgent!.id, {
      status: "disabled",
      expectedRevision: lifecycleRevision
    });
    expect(disabled).toMatchObject({ lifecycleStatus: "disabled", revision: lifecycleRevision + 1 });
    await expect(store.setAgentStatus(lifecycleAgent!.id, {
      status: "published",
      expectedRevision: lifecycleRevision
    })).rejects.toMatchObject({ kind: "revision", message: expect.stringMatching(/stale/i) });

    await expect(store.setAgentStatus(lifecycleAgent!.id, {
      status: "published",
      expectedRevision: disabled.revision!
    })).resolves.toMatchObject({ lifecycleStatus: "published", revision: lifecycleRevision + 2 });
  });

  it.each([
    {
      label: "status change",
      event: "agent.status.changed",
      prepare: async (store: InMemoryPlatformStore) => {
        const agent = (await store.getSnapshot()).agents.find((item) => item.publishedRevision != null)!;
        return {
          agentId: agent.id,
          mutate: () => store.setAgentStatus(agent.id, {
            status: "disabled",
            expectedRevision: agent.draftRevision ?? agent.publishedRevision ?? 1
          })
        };
      }
    },
    {
      label: "publication",
      event: "agent.published",
      prepare: async (store: InMemoryPlatformStore) => {
        const connector = await localConnector(store, "Agent publication audit model");
        const runtimeProfile = (await store.getRuntimeProfiles()).find((item) => item.enabled)!;
        const prompt = await store.createPrompt({
          name: "Agent publication audit Prompt",
          kind: "agent",
          description: "Published Prompt fixture.",
          owner: "owner",
          content: "Review the bounded meeting goal.",
          variables: []
        });
        await store.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 });
        const draft = await store.createAgent({
          name: "Agent publication audit",
          description: "Publish only after the required audit commits.",
          modelConnectorId: connector.id,
          goalSummary: "Verify publication audit atomicity.",
          toolsSummary: "No tools.",
          dataSummary: "Meeting data.",
          skillIds: [],
          toolGrants: [],
          runtimeProfileBinding: { profileId: runtimeProfile.id, revision: runtimeProfile.revision },
          promptBinding: { promptId: prompt.id, version: 1 }
        });
        return {
          agentId: draft.id,
          mutate: () => store.publishAgent(draft.id, { expectedDraftRevision: draft.draftRevision! })
        };
      }
    },
    {
      label: "rollback",
      event: "agent.rolled_back",
      prepare: async (store: InMemoryPlatformStore) => {
        const connector = await localConnector(store, "Agent rollback audit model");
        const runtimeProfile = (await store.getRuntimeProfiles()).find((item) => item.enabled)!;
        const prompt = await store.createPrompt({
          name: "Agent rollback audit Prompt",
          kind: "agent",
          description: "Published Prompt fixture.",
          owner: "owner",
          content: "Review the bounded meeting goal.",
          variables: []
        });
        await store.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 });
        const agent = await store.createAgent({
          name: "Agent rollback audit",
          description: "Create the first published revision.",
          modelConnectorId: connector.id,
          goalSummary: "Verify rollback audit atomicity.",
          toolsSummary: "No tools.",
          dataSummary: "Meeting data.",
          skillIds: [],
          toolGrants: [],
          runtimeProfileBinding: { profileId: runtimeProfile.id, revision: runtimeProfile.revision },
          promptBinding: { promptId: prompt.id, version: 1 }
        });
        await store.publishAgent(agent.id, { expectedDraftRevision: agent.draftRevision! });
        const draft = await store.updateAgent(agent.id, {
          description: "Create a second published revision before rollback."
        }, agent.draftRevision!);
        const published = await store.publishAgent(agent.id, { expectedDraftRevision: draft.draftRevision! });
        return {
          agentId: agent.id,
          mutate: () => store.rollbackAgent(agent.id, {
            expectedPublishedRevision: published.publishedRevision!,
            expectedDraftRevision: published.draftRevision!,
            revision: 1
          })
        };
      }
    }
  ])("does not expose Agent $label before its required audit commits", async ({ event, prepare }) => {
    const store = new GatedFailingManagementAuditStore(event);
    const prepared = await prepare(store);
    const before = await store.getSnapshot();
    const revisionsBefore = await store.getAgentRevisions(prepared.agentId);
    const mutation = prepared.mutate();

    await Promise.race([
      store.entered,
      mutation.then(() => { throw new Error(`${event} committed before its required audit.`); })
    ]);
    expect(await store.getSnapshot()).toEqual(before);
    expect(await store.getAgentRevisions(prepared.agentId)).toEqual(revisionsBefore);

    store.release();
    await expect(mutation).rejects.toThrow(/delayed audit failure/);
    expect(await store.getSnapshot()).toEqual(before);
    expect(await store.getAgentRevisions(prepared.agentId)).toEqual(revisionsBefore);
  });
});

describe("Agent Teams, Presets, and meeting source snapshots", () => {
  it("replays Team and Preset creation only for an equal complete payload", async () => {
    const store = await teamReadyStore();
    const snapshot = await store.getSnapshot();
    const teamInput = {
      name: "Retry-safe Agent Team",
      description: "One canonical Team per caller key.",
      members: [{ agentId: snapshot.agents[0]!.id, roleId: snapshot.roles[0]!.id, isChair: true }]
    };

    const [team, concurrentTeam] = await Promise.all([
      store.createAgentTeam(teamInput, "agent-team-create-retry"),
      store.createAgentTeam(structuredClone(teamInput), "agent-team-create-retry")
    ]);
    const laterTeam = await store.createAgentTeam(teamInput, "agent-team-create-retry");

    expect(concurrentTeam).toEqual(team);
    expect(laterTeam).toEqual(team);
    await expect(store.createAgentTeam({ ...teamInput, description: "Changed retry." }, "agent-team-create-retry"))
      .rejects.toMatchObject({ apiCode: "IDEMPOTENCY_KEY_CONFLICT" });
    expect((await store.getSnapshot()).agentTeams?.filter((item) => item.name === teamInput.name)).toHaveLength(1);

    const presetInput = {
      name: "Retry-safe Meeting Preset",
      description: "One canonical Preset per caller key.",
      teamId: team.id,
      mode: "chaired" as const,
      automation: "suggest" as const,
      durationMinutes: 30,
      agendaItems: [{ title: "Review", description: "Review one bounded goal." }]
    };
    const [preset, concurrentPreset] = await Promise.all([
      store.createMeetingPreset(presetInput, "meeting-preset-create-retry"),
      store.createMeetingPreset(structuredClone(presetInput), "meeting-preset-create-retry")
    ]);
    const laterPreset = await store.createMeetingPreset(presetInput, "meeting-preset-create-retry");

    expect(concurrentPreset).toEqual(preset);
    expect(laterPreset).toEqual(preset);
    await expect(store.createMeetingPreset({ ...presetInput, durationMinutes: 45 }, "meeting-preset-create-retry"))
      .rejects.toMatchObject({ apiCode: "IDEMPOTENCY_KEY_CONFLICT" });
    expect((await store.getSnapshot()).meetingPresets?.filter((item) => item.name === presetInput.name)).toHaveLength(1);
  });

  it("rejects a Team member whose current published Agent revision is not runnable", async () => {
    const store = new InMemoryPlatformStore();
    const seed = await store.getSnapshot();

    await expect(store.createAgentTeam({
      name: "Unrunnable Team",
      description: "Must not bypass API readiness.",
      members: [{ agentId: seed.agents[0]!.id, roleId: seed.roles[0]!.id, isChair: true }]
    })).rejects.toThrow(/runnable current published revision/i);
    expect((await store.getSnapshot()).agentTeams).toEqual([]);
  });

  it("blocks active Team updates after runtime readiness is lost but still allows archival", async () => {
    const store = await teamReadyStore();
    const seed = await store.getSnapshot();
    const team = await store.createAgentTeam({
      name: "Readiness-bound Team",
      description: "Ready when created.",
      members: [{ agentId: seed.agents[0]!.id, roleId: seed.roles[0]!.id, isChair: true }]
    });
    const connectorId = seed.agents[0]!.modelConnectorId!;
    const connector = seed.modelConnectors.find((item) => item.id === connectorId)!;
    await store.updateModelConnector(connectorId, { expectedRevision: connector.revision, enabled: false });

    await expect(store.updateAgentTeam(team.id, {
      expectedRevision: team.revision,
      description: "Must not mask a broken member."
    })).rejects.toThrow(/runnable current published revision/i);
    await expect(store.updateAgentTeam(team.id, {
      expectedRevision: team.revision,
      status: "archived"
    })).resolves.toMatchObject({ status: "archived", revision: team.revision + 1 });
  });

  it("backfills revision one for legacy Team and Preset snapshots", async () => {
    const store = await teamReadyStore();
    const seed = await store.getSnapshot();
    const team = await store.createAgentTeam({
      name: "Legacy revision Team",
      description: "Created before management CAS.",
      members: [{ agentId: seed.agents[0]!.id, roleId: seed.roles[0]!.id, isChair: true }]
    });
    const preset = await store.createMeetingPreset({
      name: "Legacy revision Preset",
      description: "Created before management CAS.",
      teamId: team.id,
      mode: "chaired",
      automation: "suggest",
      durationMinutes: 30,
      agendaItems: [{ title: "Review", description: "Review legacy data." }]
    });
    const legacy = await store.getSnapshot();
    delete (legacy.agentTeams!.find((item) => item.id === team.id)! as { revision?: number }).revision;
    delete (legacy.meetingPresets!.find((item) => item.id === preset.id)! as { revision?: number }).revision;

    const rehydrated = new InMemoryPlatformStore(legacy);
    const normalized = await rehydrated.getSnapshot();

    expect(normalized.agentTeams!.find((item) => item.id === team.id)?.revision).toBe(1);
    expect(normalized.meetingPresets!.find((item) => item.id === preset.id)?.revision).toBe(1);
    await expect(rehydrated.updateAgentTeam(team.id, {
      expectedRevision: 1,
      description: "CAS enabled."
    })).resolves.toMatchObject({ revision: 2 });
    await expect(rehydrated.updateMeetingPreset(preset.id, {
      expectedRevision: 1,
      durationMinutes: 45
    })).resolves.toMatchObject({ revision: 2 });
  });

  it("validates active references and pins meeting participants to Agent revisions", async () => {
    const store = await teamReadyStore();
    const seed = await store.getSnapshot();
    const teamInput = {
      name: "Architecture Team",
      description: "",
      members: [
        { agentId: seed.agents[0]!.id, roleId: seed.roles[0]!.id, isChair: true },
        { agentId: seed.agents[1]!.id, roleId: seed.roles[1]!.id, isChair: false }
      ]
    };
    const team = await store.createAgentTeam(teamInput);
    const preset = await store.createMeetingPreset({
      name: "Architecture Review",
      description: "",
      teamId: team.id,
      mode: "chaired",
      automation: "suggest",
      durationMinutes: 30,
      agendaItems: [{ title: "Review", description: "" }]
    });
    await expect(store.createMeetingPreset({
      name: "Broken preset",
      description: "",
      teamId: "60000000-0000-4000-8000-000000000099",
      mode: "chaired",
      automation: "suggest",
      durationMinutes: 30,
      agendaItems: [{ title: "Review", description: "" }]
    })).rejects.toThrow(/Agent Team/);

    const existing = seed.meetings[0]!;
    await store.setMeetingState(existing.id, "closed", "active");
    const meeting = await store.createMeeting({
      threadId: seed.threads[0]!.id,
      title: "Source-stable meeting",
      goal: "Keep source references stable.",
      mode: "chaired",
      automation: "suggest",
      durationMinutes: 30,
      sourceTeamId: team.id,
      sourcePresetId: preset.id,
      participants: teamInput.members,
      agendaItems: [{ title: "Review", description: "" }]
    });
    expect(meeting).toMatchObject({ sourceTeamId: team.id, sourcePresetId: preset.id });
    const participantBefore = (await store.getSnapshot()).participants.filter((item) => item.meetingId === meeting.id);
    expect(participantBefore.every((item) => item.agentRevision === 1)).toBe(true);
    const updatedTeam = await store.updateAgentTeam(team.id, {
      expectedRevision: team.revision,
      description: "Updated roster note."
    });
    expect(updatedTeam.revision).toBe(team.revision + 1);
    await expect(store.updateAgentTeam(team.id, {
      expectedRevision: team.revision,
      name: "Stale Team overwrite"
    })).rejects.toMatchObject({ kind: "revision", message: expect.stringMatching(/stale/i) });
    const updatedPreset = await store.updateMeetingPreset(preset.id, {
      expectedRevision: preset.revision,
      durationMinutes: 45
    });
    expect(updatedPreset.revision).toBe(preset.revision + 1);
    await expect(store.updateMeetingPreset(preset.id, {
      expectedRevision: preset.revision,
      description: "Stale Preset overwrite"
    })).rejects.toMatchObject({ kind: "revision", message: expect.stringMatching(/stale/i) });
    const snapshot = await store.getSnapshot();
    expect(snapshot.meetings.find((item) => item.id === meeting.id)).toMatchObject({ sourceTeamId: team.id, sourcePresetId: preset.id });
    expect(snapshot.participants.filter((item) => item.meetingId === meeting.id)).toEqual(participantBefore);
  });

  it("atomically pins only the requested current published Agent revision", async () => {
    const store = new InMemoryPlatformStore();
    const initial = await store.getSnapshot();
    const connector = await localConnector(store, "Meeting revision model");
    const prompt = await store.createPrompt({
      name: "Meeting revision Prompt",
      kind: "agent",
      description: "Immutable Meeting participant fixture.",
      owner: "Test Owner",
      content: "Discuss the bounded Meeting goal.",
      variables: []
    });
    await store.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 });
    const agent = await store.createAgent({
      name: "Meeting revision Agent",
      description: "",
      modelConnectorId: connector.id,
      goalSummary: "Discuss one bounded Meeting.",
      toolsSummary: "No tools.",
      dataSummary: "Meeting context only.",
      skillIds: [],
      toolGrants: [],
      runtimeProfileBinding: null,
      promptBinding: { promptId: prompt.id, version: 1 }
    });
    await store.publishAgent(agent.id, { expectedDraftRevision: 1 });
    const firstThread = await store.createThread({
      categoryId: initial.categories[0]!.id,
      title: "Published participant revision",
      summary: "A draft must not replace the pinned runtime.",
      tagIds: []
    });
    const participant = {
      agentId: agent.id,
      roleId: initial.roles[0]!.id,
      isChair: true,
      agentRevision: 1
    };

    await store.updateAgent(agent.id, { modelConnectorId: null });
    const meeting = await store.createMeeting({
      threadId: firstThread.id,
      title: "Pinned revision one",
      goal: "Use the last published revision.",
      mode: "open",
      durationMinutes: 20,
      participants: [participant],
      agendaItems: [{ title: "Confirm pinned revision", description: "" }]
    });
    expect((await store.getSnapshot()).participants.find((item) => item.meetingId === meeting.id))
      .toMatchObject({ agentId: agent.id, agentRevision: 1 });
    await store.setMeetingState(meeting.id, "closed", "draft");

    const nextDraft = await store.updateAgent(agent.id, {
      name: "Meeting revision Agent v3",
      modelConnectorId: connector.id
    });
    const published = await store.publishAgent(agent.id, { expectedDraftRevision: nextDraft.draftRevision! });
    const staleThread = await store.createThread({
      categoryId: initial.categories[0]!.id,
      title: "Stale participant revision",
      summary: "A superseded revision must fail atomically.",
      tagIds: []
    });
    const beforeStale = await store.getSnapshot();
    await expect(store.createMeeting({
      threadId: staleThread.id,
      title: "Reject stale revision",
      goal: "Do not substitute a newer runtime silently.",
      mode: "open",
      durationMinutes: 20,
      participants: [participant],
      agendaItems: [{ title: "Reject stale revision", description: "" }]
    })).rejects.toThrow(/published|revision|ready/i);
    expect((await store.getSnapshot()).meetings).toHaveLength(beforeStale.meetings.length);

    await store.setAgentStatus(agent.id, { status: "disabled", expectedRevision: published.revision! });
    const disabledParticipant = { ...participant, agentRevision: published.publishedRevision! };
    await expect(store.createMeeting({
      threadId: staleThread.id,
      title: "Reject disabled Agent",
      goal: "A disabled Agent cannot enter a Meeting.",
      mode: "open",
      durationMinutes: 20,
      participants: [disabledParticipant],
      agendaItems: [{ title: "Reject disabled Agent", description: "" }]
    })).rejects.toThrow(/disabled|published|ready/i);
    const afterDisabled = await store.getSnapshot();
    expect(afterDisabled.meetings).toHaveLength(beforeStale.meetings.length);
    expect(afterDisabled.participants).toHaveLength(beforeStale.participants.length);
  });
});

describe("management lifecycle mutation replay", () => {
  it("replays Role deletion, Skill revocation, and Credential status only for the exact intent", async () => {
    const store = new InMemoryPlatformStore();
    const role = await store.createRole({
      name: "Store lifecycle retry Role",
      usageContext: "Exercise exact deletion replay.",
      responsibility: "Remain independently deletable.",
      speakingGuidance: "State the bounded result.",
      decisionScope: "No unrelated decisions.",
      constraints: "No Meeting or Team references.",
      templateKey: null,
      toolPolicy: "none",
      dataPolicy: "meeting_only"
    });
    const roleInput = { roleId: role.id, expectedCurrentVersion: role.version };
    const [deleted, concurrentDelete] = await Promise.all([
      store.deleteRole(role.id, role.version, "role-delete-retry"),
      store.deleteRole(role.id, role.version, "role-delete-retry")
    ]);
    expect(concurrentDelete).toEqual(deleted);
    await expect(store.deleteRole(role.id, role.version + 1, "role-delete-retry"))
      .rejects.toMatchObject({ apiCode: "IDEMPOTENCY_KEY_CONFLICT" });
    expect(roleInput.roleId).toBe(deleted.id);

    const skill = await store.createSkill({
      name: "Store lifecycle retry Skill",
      version: "1.0.0",
      instructions: "Exercise exact revocation replay.",
      source: "internal",
      owner: "Platform Owner"
    });
    const validated = await store.validateSkill(skill.id, {
      result: "passed",
      summary: "Validated for lifecycle retry tests.",
      expectedCheckedAt: null
    });
    await store.setSkillStatus(skill.id, {
      status: "approved",
      expectedCheckedAt: validated.validation.checkedAt
    });
    const revocationInput = { reason: "Superseded by a reviewed Skill." };
    const [revoked, concurrentRevoke] = await Promise.all([
      store.revokeSkill(skill.id, revocationInput, "skill-revoke-retry"),
      store.revokeSkill(skill.id, structuredClone(revocationInput), "skill-revoke-retry")
    ]);
    expect(concurrentRevoke).toEqual(revoked);
    await expect(store.revokeSkill(skill.id, { reason: "Changed intent." }, "skill-revoke-retry"))
      .rejects.toMatchObject({ apiCode: "IDEMPOTENCY_KEY_CONFLICT" });

    const credential = await store.createCredential({
      name: "Store lifecycle retry Credential",
      provider: "test-provider",
      kind: "api_key",
      location: "cloud",
      expiresAt: null
    });
    const statusInput = { status: "disabled" as const, expectedUpdatedAt: credential.updatedAt };
    const [disabled, concurrentDisable] = await Promise.all([
      store.setCredentialStatus(credential.id, statusInput, "credential-status-retry"),
      store.setCredentialStatus(credential.id, structuredClone(statusInput), "credential-status-retry")
    ]);
    expect(concurrentDisable).toEqual(disabled);
    expect(await store.setCredentialStatus(credential.id, statusInput, "credential-status-retry")).toEqual(disabled);
    await expect(store.setCredentialStatus(credential.id, {
      status: "revoked",
      expectedUpdatedAt: credential.updatedAt
    }, "credential-status-retry")).rejects.toMatchObject({ apiCode: "IDEMPOTENCY_KEY_CONFLICT" });
  });
});
