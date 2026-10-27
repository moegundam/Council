import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createRuntimeProfileSnapshot,
  type AgentTurnJobData,
  type ParticipantRoleBinding,
  type PlatformSnapshot,
  type SpeakerQueueItem,
  type Task,
  type TaskAgentRunJobData
} from "@council/contracts";
import { createQueuedRuntimeRun } from "@council/domain";
import { createSeedSnapshot } from "./seed.js";
import { InMemoryPlatformStore } from "./memory-store.js";
import { mcpConnectorExecutionFingerprint, taskExecutionFingerprint, taskSyncAdmissionInput, taskSyncRequestFingerprint } from "./store.js";

type ModelConnectorLifecycleStore = {
  updateModelConnector(
    id: string,
    input: Partial<{
      name: string;
      location: "cloud" | "local";
      baseUrl: string;
      model: string;
      enabled: boolean;
    }>,
    secret?: { ciphertext?: string }
  ): Promise<{
    connector: {
      id: string;
      revision: number;
      name: string;
      location: "cloud" | "local";
      baseUrl: string;
      model: string;
      enabled: boolean;
      hasSecret: boolean;
      secretRevision: number;
    };
    assignedAgentCount: number;
  }>;
};

function modelConnectorLifecycle(store: InMemoryPlatformStore): ModelConnectorLifecycleStore {
  return {
    async updateModelConnector(id, input, secret) {
      const connector = (await store.getSnapshot()).modelConnectors.find((item) => item.id === id);
      if (!connector) throw new Error("Model Connector fixture not found.");
      return store.updateModelConnector(id, { expectedRevision: connector.revision, ...input }, secret);
    }
  };
}

function participantRoleBinding(
  snapshot: PlatformSnapshot,
  meetingId: string,
  agentId: string
): ParticipantRoleBinding {
  const participant = snapshot.participants.find(
    (item) => item.meetingId === meetingId && item.agentId === agentId
  );
  if (!participant) throw new Error(`Participant ${agentId} is not assigned to Meeting ${meetingId}.`);
  return {
    participantId: participant.id,
    roleRevision: participant.roleRevision,
    roleId: participant.roleId,
    roleVersion: participant.roleSnapshot.version
  };
}

function taskRuntimeBinding(snapshot: PlatformSnapshot, agentId: string) {
  const agent = snapshot.agents.find((item) => item.id === agentId);
  const binding = agent?.runtimeProfileBinding;
  const revision = binding
    ? snapshot.runtimeProfileRevisions?.find((item) => item.profileId === binding.profileId && item.revision === binding.revision)
    : undefined;
  if (!agent || !binding || !revision) throw new Error(`Runtime Profile binding is unavailable for Agent ${agentId}.`);
  return {
    agentRevision: agent.draftRevision ?? agent.publishedRevision ?? 1,
    runtimeProfileBinding: { ...binding },
    runtimeProfileSnapshot: createRuntimeProfileSnapshot(revision)
  };
}

function taskRuntimeRun(
  jobId: string,
  task: Pick<Task, "id">,
  attempt: number,
  agentId: string,
  binding: ReturnType<typeof taskRuntimeBinding>
) {
  return createQueuedRuntimeRun({
    id: randomUUID(),
    kind: "task_agent",
    scope: {
      id: `task:${task.id}:attempt:${attempt}`,
      kind: "task_attempt",
      subjectId: task.id,
      parentScopeId: null
    },
    runtimeProfile: binding.runtimeProfileSnapshot,
    agentId,
    agentRevision: binding.agentRevision,
    roleId: null,
    roleRevision: null,
    attempt,
    idempotencyKey: jobId,
    queuedAt: new Date().toISOString(),
    ttlMs: 120_000
  });
}

function createGatedAuditFailureStore(targetEvent: string) {
  let releaseAudit = () => {};
  let observeAudit = () => {};
  const auditRelease = new Promise<void>((resolve) => { releaseAudit = resolve; });
  const auditEntered = new Promise<void>((resolve) => { observeAudit = resolve; });

  class GatedAuditFailureStore extends InMemoryPlatformStore {
    override async recordAudit(event: string): Promise<void> {
      if (event !== targetEvent) return;
      observeAudit();
      await auditRelease;
      throw new Error(`${targetEvent} audit unavailable`);
    }
  }

  return { Store: GatedAuditFailureStore, auditEntered, releaseAudit };
}

function speakerQueueFixture(seed: PlatformSnapshot, jobId: string, leaseExpiresAt = "2099-01-01T00:00:00.000Z"): SpeakerQueueItem {
  const meeting = seed.meetings[0]!;
  const participant = seed.participants.find((item) => item.meetingId === meeting.id)!;
  return {
    id: jobId,
    jobId,
    requestFingerprint: null,
    meetingId: meeting.id,
    agentId: participant.agentId,
    kind: "agent_turn",
    label: "Audit atomicity turn",
    toolName: null,
    participantId: participant.id,
    roleRevision: participant.roleRevision,
    roleId: participant.roleId,
    roleVersion: participant.roleSnapshot.version,
    roleName: participant.roleSnapshot.name,
    agendaRevision: meeting.agenda.revision,
    agendaCurrentItemId: meeting.agenda.items.find((item) => item.status === "current")?.id ?? null,
    status: "queued",
    requestedAt: "2026-08-12T00:00:00.000Z",
    startedAt: null,
    leaseExpiresAt,
    requestedBy: "owner"
  };
}

class GatedAgentTurnAuditFailureStore extends InMemoryPlatformStore {
  readonly completionAuditEntered: Promise<void>;
  completionAuditAttempts = 0;
  private resolveCompletionAuditEntered!: () => void;
  private resolveCompletionAuditRelease!: () => void;
  private readonly completionAuditRelease: Promise<void>;

  constructor(seed: PlatformSnapshot) {
    super(seed);
    this.completionAuditEntered = new Promise((resolve) => { this.resolveCompletionAuditEntered = resolve; });
    this.completionAuditRelease = new Promise((resolve) => { this.resolveCompletionAuditRelease = resolve; });
  }

  releaseCompletionAudit(): void {
    this.resolveCompletionAuditRelease();
  }

  override async recordAudit(
    event: string,
    entityType: string,
    entityId: string,
    detail: Record<string, unknown> = {}
  ): Promise<void> {
    if (event !== "model.run.completed") {
      return super.recordAudit(event, entityType, entityId, detail);
    }
    this.completionAuditAttempts += 1;
    if (this.completionAuditAttempts === 1) {
      this.resolveCompletionAuditEntered();
      await this.completionAuditRelease;
    }
    throw new Error("model completion audit unavailable");
  }
}

class GatedMcpAuditFailureStore extends InMemoryPlatformStore {
  readonly toolAuditEntered: Promise<void>;
  toolAuditAttempts = 0;
  private resolveToolAuditEntered!: () => void;
  private resolveToolAuditRelease!: () => void;
  private readonly toolAuditRelease: Promise<void>;

  constructor(seed: PlatformSnapshot) {
    super(seed);
    this.toolAuditEntered = new Promise((resolve) => { this.resolveToolAuditEntered = resolve; });
    this.toolAuditRelease = new Promise((resolve) => { this.resolveToolAuditRelease = resolve; });
  }

  releaseToolAudit(): void {
    this.resolveToolAuditRelease();
  }

  override async recordAudit(
    event: string,
    entityType: string,
    entityId: string,
    detail: Record<string, unknown> = {}
  ): Promise<void> {
    if (event !== "mcp.tool.failed") return super.recordAudit(event, entityType, entityId, detail);
    this.toolAuditAttempts += 1;
    if (this.toolAuditAttempts === 1) {
      this.resolveToolAuditEntered();
      await this.toolAuditRelease;
    }
    throw new Error("MCP completion audit unavailable");
  }
}

class GatedSuccessfulCompletionAuditStore extends InMemoryPlatformStore {
  readonly auditEntered: Promise<void>;
  private resolveAuditEntered!: () => void;
  private resolveAuditRelease!: () => void;
  private readonly auditRelease: Promise<void>;

  constructor(seed: PlatformSnapshot, private readonly gatedEvent: string) {
    super(seed);
    this.auditEntered = new Promise((resolve) => { this.resolveAuditEntered = resolve; });
    this.auditRelease = new Promise((resolve) => { this.resolveAuditRelease = resolve; });
  }

  releaseAudit(): void {
    this.resolveAuditRelease();
  }

  override async recordAudit(
    event: string,
    entityType: string,
    entityId: string,
    detail: Record<string, unknown> = {}
  ): Promise<void> {
    if (event === this.gatedEvent) {
      this.resolveAuditEntered();
      await this.auditRelease;
    }
    return super.recordAudit(event, entityType, entityId, detail);
  }
}

describe("Agent turn commit atomicity", () => {
  it("keeps a turn invisible and retryable when its required completion audit fails", async () => {
    const seed = createSeedSnapshot();
    const meeting = seed.meetings[0]!;
    const participant = seed.participants.find((item) => item.meetingId === meeting.id)!;
    const store = new GatedAgentTurnAuditFailureStore(seed);
    const input = {
      ...participantRoleBinding(seed, meeting.id, participant.agentId),
      meetingId: meeting.id,
      agentId: participant.agentId,
      turnId: "agent-turn-audit-failure",
      agendaRevision: meeting.agenda.revision,
      speakerName: "Audited Agent",
      roleName: participant.roleSnapshot.name,
      content: "This output must not become visible without its audit.",
      auditDetail: { provider: "test" }
    };

    const firstCommit = store.commitAgentTurn(input);
    await store.completionAuditEntered;
    const whileAuditPending = await store.getSnapshot();
    store.releaseCompletionAudit();

    await expect(firstCommit).rejects.toThrow(/audit unavailable/i);
    expect(whileAuditPending.utterances.some((item) => item.turnId === input.turnId)).toBe(false);
    expect((await store.getSnapshot()).utterances.some((item) => item.turnId === input.turnId)).toBe(false);
    await expect(store.commitAgentTurn(input)).rejects.toThrow(/audit unavailable/i);
    expect(store.completionAuditAttempts).toBe(2);
  });

  it("serializes Agent disable behind an in-flight completion audit", async () => {
    const seed = createSeedSnapshot();
    const meeting = seed.meetings[0]!;
    const participant = seed.participants.find((item) => item.meetingId === meeting.id)!;
    const store = new GatedSuccessfulCompletionAuditStore(seed, "model.run.completed");
    const input = {
      ...participantRoleBinding(seed, meeting.id, participant.agentId),
      meetingId: meeting.id,
      agentId: participant.agentId,
      turnId: "agent-turn-management-race",
      agendaRevision: meeting.agenda.revision,
      speakerName: "Audited Agent",
      roleName: participant.roleSnapshot.name,
      content: "This output owns the management lock until its audit commits.",
      auditDetail: { provider: "test" }
    };

    const commit = store.commitAgentTurn(input);
    await store.auditEntered;
    const disable = store.setAgentStatus(input.agentId, { status: "disabled", expectedRevision: 1 });
    const disableState = await Promise.race([
      disable.then(() => "resolved" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 20))
    ]);

    expect(disableState).toBe("pending");
    expect((await store.getSnapshot()).utterances.some((item) => item.turnId === input.turnId)).toBe(false);
    store.releaseAudit();
    await expect(commit).resolves.toMatchObject({ status: "created" });
    await expect(disable).resolves.toMatchObject({ lifecycleStatus: "disabled" });
    expect((await store.getSnapshot()).utterances.some((item) => item.turnId === input.turnId)).toBe(true);
  });

  it("commits one replayable Agent failure receipt and Meeting pause", async () => {
    const seed = createSeedSnapshot();
    const input = {
      meetingId: seed.meetings[0]!.id,
      jobId: "agent-failure-receipt",
      content: "模型執行失敗。",
      classification: "provider_or_runtime_failure"
    };
    seed.speakerQueue = [speakerQueueFixture(seed, input.jobId)];
    const store = new InMemoryPlatformStore(seed);

    const created = await store.commitAgentTurnFailure(input);
    await store.releaseSpeakerTurn(input.jobId, "worker_cleanup_after_failure");
    const replayed = await store.commitAgentTurnFailure(input);

    expect(created).toMatchObject({ status: "created", meetingPaused: true, utterance: { turnId: input.jobId } });
    expect(replayed).toMatchObject({
      status: "existing",
      meetingPaused: false,
      utterance: { id: created.utterance?.id, turnId: input.jobId }
    });
    const snapshot = await store.getSnapshot();
    expect(snapshot.meetings[0]!.state).toBe("paused");
    expect(snapshot.utterances.filter((item) => item.turnId === input.jobId)).toHaveLength(1);
  });

  it.each(["paused", "closed"] as const)(
    "commits an Agent failure receipt without changing a %s Meeting",
    async (meetingState) => {
      const seed = createSeedSnapshot();
      const input = {
        meetingId: seed.meetings[0]!.id,
        jobId: `agent-failure-${meetingState}`,
        content: "模型執行結果不明。",
        classification: "provider_or_runtime_failure"
      };
      seed.meetings[0]!.state = meetingState;
      seed.speakerQueue = [speakerQueueFixture(seed, input.jobId)];
      const store = new InMemoryPlatformStore(seed);

      const result = await store.commitAgentTurnFailure(input);

      expect(result).toMatchObject({
        status: "created",
        meetingPaused: false,
        meeting: { state: meetingState },
        utterance: { turnId: input.jobId, kind: "failure" }
      });
      const snapshot = await store.getSnapshot();
      expect(snapshot.meetings[0]!.state).toBe(meetingState);
      expect(snapshot.utterances.filter((item) => item.turnId === input.jobId)).toHaveLength(1);
    }
  );

  it("keeps an Agent failure receipt and pause invisible when its required audit fails", async () => {
    class AgentFailureAuditStore extends InMemoryPlatformStore {
      override async recordAudit(event: string): Promise<void> {
        if (event === "model.run.failed") throw new Error("Agent failure audit unavailable");
      }
    }
    const seed = createSeedSnapshot();
    seed.speakerQueue = [speakerQueueFixture(seed, "agent-failure-audit-error")];
    const store = new AgentFailureAuditStore(seed);

    await expect(store.commitAgentTurnFailure({
      meetingId: seed.meetings[0]!.id,
      jobId: "agent-failure-audit-error",
      content: "模型執行失敗。",
      classification: "provider_or_runtime_failure"
    })).rejects.toThrow(/audit unavailable/i);

    const snapshot = await store.getSnapshot();
    expect(snapshot.meetings[0]!.state).toBe("active");
    expect(snapshot.utterances.some((item) => item.turnId === "agent-failure-audit-error")).toBe(false);
  });
});

describe("agent permission management", () => {
  it("backfills validated legacy MCP grants into the initial Agent revision", async () => {
    const seed = createSeedSnapshot();
    const connectorId = "d0000000-0000-4000-8000-000000000099";
    seed.mcpConnectors.push({
      id: connectorId,
      revision: 1,
      name: "Legacy MCP",
      location: "local",
      baseUrl: "http://mcp-readonly:4000/mcp",
      approvedTools: ["search"],
      toolRegistrations: [{
        toolName: "search",
        displayName: "Search",
        kind: "mcp_tool",
        version: "unversioned",
        owner: "Platform Owner",
        goal: "Read approved evidence."
      }],
      enabled: true,
      hasSecret: true
    });
    seed.agents[0]!.toolGrants = [{ connectorId, toolName: "search" }];

    const store = new InMemoryPlatformStore(seed);
    const snapshot = await store.getSnapshot();
    const revisions = await store.getAgentRevisions(seed.agents[0]!.id);

    expect(snapshot.agents[0]!.toolGrants).toEqual([{ connectorId, toolName: "search" }]);
    expect(revisions.at(-1)?.toolGrants).toEqual([{ connectorId, toolName: "search" }]);
  });

  it("does not create an Agent draft revision for structurally identical values", async () => {
    const store = new InMemoryPlatformStore();
    const before = (await store.getSnapshot()).agents[0]!;

    const unchanged = await store.updateAgent(before.id, {
      skillIds: structuredClone(before.skillIds),
      toolGrants: structuredClone(before.toolGrants),
      toolPackGrants: structuredClone(before.toolPackGrants),
      runtimeProfileBinding: structuredClone(before.runtimeProfileBinding),
      promptBinding: structuredClone(before.promptBinding)
    }, before.draftRevision);

    expect(unchanged.draftRevision).toBe(before.draftRevision);
    await expect(store.getAgentRevision(before.id, (before.draftRevision ?? 1) + 1)).rejects.toThrow(/not found/i);
  });

  it("assigns only approved skills and approved MCP tools", async () => {
    const seed = createSeedSnapshot();
    const connectorId = "d0000000-0000-4000-8000-000000000001";
    seed.mcpConnectors.push({
      id: connectorId,
      revision: 1,
      name: "Docs",
      location: "cloud",
      baseUrl: "https://mcp.example.com/mcp",
      approvedTools: ["search"],
      toolRegistrations: [{ toolName: "search", displayName: "search", kind: "mcp_tool", version: "unversioned", owner: "Platform Owner", goal: "以唯讀方式執行 search。" }],
      enabled: true,
      hasSecret: false
    });
    const store = new InMemoryPlatformStore(seed);
    const agentId = seed.agents[0]!.id;

    await expect(store.updateAgent(agentId, {
      skillIds: [seed.skills[0]!.id],
      toolGrants: [{ connectorId, toolName: "search" }]
    })).resolves.toMatchObject({
      skillIds: [seed.skills[0]!.id],
      toolGrants: [{ connectorId, toolName: "search" }]
    });

    await expect(store.updateAgent(agentId, {
      toolGrants: [{ connectorId, toolName: "update" }]
    })).rejects.toThrow(/approved/i);
  });

  it("requires explicit approval before assigning a newly created skill", async () => {
    const store = new InMemoryPlatformStore();
    const agentId = (await store.getSnapshot()).agents[0]!.id;
    const skill = await store.createSkill({ name: "Research", version: "1.0.0", instructions: "Find evidence.", source: "test", owner: "owner" });

    await expect(store.updateAgent(agentId, { skillIds: [skill.id] })).rejects.toThrow(/approved/i);
    await expect(store.setSkillStatus(skill.id, {
      status: "approved",
      expectedCheckedAt: skill.validation.checkedAt
    })).rejects.toThrow(/validation/i);
    const validated = await store.validateSkill(skill.id, {
      result: "passed",
      summary: "Reviewed.",
      expectedCheckedAt: skill.validation.checkedAt
    });
    await store.setSkillStatus(skill.id, {
      status: "approved",
      expectedCheckedAt: validated.validation.checkedAt
    });
    await expect(store.updateAgent(agentId, { skillIds: [skill.id] })).resolves.toMatchObject({ skillIds: [skill.id] });
    await expect(store.updateAgent(agentId, { skillIds: [skill.id, skill.id] })).rejects.toThrow(/only once/i);
  });

  it("governs immutable Skill versions, validation, approval, digest tampering, and revocation pruning", async () => {
    const store = new InMemoryPlatformStore();
    const agentId = (await store.getSnapshot()).agents[0]!.id;
    const input = { name: "Research", version: "1.0.0", instructions: "Find cited evidence.", source: "internal-review", owner: "platform-owner" };
    const skill = await store.createSkill(input);

    await expect(store.createSkill(input)).rejects.toThrow(/name and version/i);
    const validated = await store.validateSkill(skill.id, {
      result: "passed",
      summary: "Reviewed.",
      expectedCheckedAt: skill.validation.checkedAt
    });
    expect(validated).toMatchObject({ validation: { result: "passed" } });
    await expect(store.setSkillStatus(skill.id, {
      status: "approved",
      expectedCheckedAt: validated.validation.checkedAt
    })).resolves.toMatchObject({ status: "approved", approvedAt: expect.any(String) });
    await expect(store.updateAgent(agentId, { skillIds: [skill.id] })).resolves.toMatchObject({ skillIds: [skill.id] });

    const state = (store as unknown as { state: { skills: Array<{ id: string; instructions: string }> } }).state;
    state.skills.find((item) => item.id === skill.id)!.instructions = "Tampered after approval.";
    await expect(store.updateAgent(agentId, { skillIds: [skill.id] })).rejects.toThrow(/digest/i);

    const revoked = await store.revokeSkill(skill.id, { reason: "Tampered source material." });
    expect(revoked).toMatchObject({ skill: { status: "revoked", revocationReason: "Tampered source material." }, revokedAssignmentCount: 1 });
    const currentAgent = (await store.getSnapshot()).agents.find((agent) => agent.id === agentId)!;
    expect(currentAgent).toMatchObject({ skillIds: [], draftRevision: 3, publishedRevision: 1, lifecycleStatus: "draft" });
    await expect(store.getAgentRevision(agentId, 2)).resolves.toMatchObject({ skillIds: [skill.id] });
    await expect(store.getAgentRevision(agentId, 3)).resolves.toMatchObject({ skillIds: [] });
    await expect(store.validateSkill(skill.id, {
      result: "failed",
      summary: "Late.",
      expectedCheckedAt: validated.validation.checkedAt
    })).rejects.toThrow(/draft/i);
    await expect(store.setSkillStatus(skill.id, {
      status: "approved",
      expectedCheckedAt: validated.validation.checkedAt
    })).rejects.toThrow(/revoked/i);
  });

  it("refuses to validate a draft Skill whose immutable content no longer matches its digest", async () => {
    const store = new InMemoryPlatformStore();
    const skill = await store.createSkill({
      name: "Immutable review",
      version: "1.0.0",
      instructions: "Review the current evidence.",
      source: "internal-review",
      owner: "platform-owner"
    });
    const state = (store as unknown as { state: { skills: Array<{ id: string; instructions: string }> } }).state;
    state.skills.find((item) => item.id === skill.id)!.instructions = "Changed outside the version workflow.";

    await expect(store.validateSkill(skill.id, {
      result: "passed",
      summary: "Reviewed.",
      expectedCheckedAt: skill.validation.checkedAt
    }))
      .rejects.toThrow(/immutable version/i);
  });
});

describe("model connector lifecycle", () => {
  it("backfills missing legacy Connector revisions and rejects invalid persisted revisions", async () => {
    const legacy = await new InMemoryPlatformStore().getSnapshot();
    legacy.modelConnectors.push({
      id: "c0000000-0000-4000-8000-000000000081",
      name: "Legacy model",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "legacy-model",
      enabled: true,
      hasSecret: false,
      secretRevision: 0
    } as unknown as PlatformSnapshot["modelConnectors"][number]);
    legacy.mcpConnectors.push({
      id: "d0000000-0000-4000-8000-000000000081",
      name: "Legacy MCP",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: [],
      toolRegistrations: [],
      enabled: true,
      hasSecret: false
    } as unknown as PlatformSnapshot["mcpConnectors"][number]);

    const normalized = await new InMemoryPlatformStore(legacy).getSnapshot();
    expect(normalized.modelConnectors.at(-1)?.revision).toBe(1);
    expect(normalized.mcpConnectors.at(-1)?.revision).toBe(1);

    for (const revision of [0, -1, 1.5]) {
      const invalid = structuredClone(normalized);
      invalid.modelConnectors.at(-1)!.revision = revision;
      expect(() => new InMemoryPlatformStore(invalid)).toThrow(/Connector revisions must be positive integers/i);
    }
    const invalidMcp = structuredClone(normalized);
    (invalidMcp.mcpConnectors.at(-1)! as unknown as { revision: unknown }).revision = "1";
    expect(() => new InMemoryPlatformStore(invalidMcp)).toThrow(/Connector revisions must be positive integers/i);
  });

  it("uses configuration revision CAS and keeps a stale Model Connector edit from overwriting current state", async () => {
    const store = new InMemoryPlatformStore();
    const connector = await store.createModelConnector({
      name: "CAS model",
      location: "cloud",
      baseUrl: "https://models.example.com/v1",
      model: "meeting-v1"
    });

    expect(connector.revision).toBe(1);
    const updated = await store.updateModelConnector(connector.id, {
      expectedRevision: connector.revision,
      model: "meeting-v2"
    });
    expect(updated.connector).toMatchObject({ revision: 2, model: "meeting-v2" });

    await expect(store.updateModelConnector(connector.id, {
      expectedRevision: connector.revision,
      enabled: false
    })).rejects.toMatchObject({ kind: "revision" });
    expect((await store.getSnapshot()).modelConnectors.find((item) => item.id === connector.id))
      .toMatchObject({ revision: 2, model: "meeting-v2", enabled: true });
  });

  it("does not advance a Model Connector revision or audit a structural no-op", async () => {
    class AuditedConnectorStore extends InMemoryPlatformStore {
      readonly events: string[] = [];

      override async recordAudit(event: string): Promise<void> {
        this.events.push(event);
      }
    }

    const store = new AuditedConnectorStore();
    const connector = await store.createModelConnector({
      name: "No-op model",
      location: "cloud",
      baseUrl: "https://models.example.com/v1",
      model: "meeting"
    });
    const result = await store.updateModelConnector(connector.id, {
      expectedRevision: connector.revision,
      model: connector.model
    });

    expect(result.connector.revision).toBe(connector.revision);
    expect(store.events.filter((event) => event === "model_connector.updated")).toHaveLength(0);
  });

  it("rejects replacing an existing Credential secret during Model Connector creation", async () => {
    const store = new InMemoryPlatformStore();
    const credential = await store.createCredential({
      name: "Shared credential",
      provider: "shared-provider",
      kind: "api_key",
      location: "cloud"
    }, { ciphertext: "encrypted-original" });

    await expect(store.createModelConnector({
      name: "Unsafe connector",
      location: "cloud",
      baseUrl: "https://models.example.com/v1",
      model: "meeting",
      credentialId: credential.id
    }, { ciphertext: "encrypted-replacement" })).rejects.toThrow(/Credential/i);
    expect(await store.getCredentialSecret(credential.id)).toBe("encrypted-original");
  });

  it("updates name, location, base URL, model, and enabled state", async () => {
    const store = new InMemoryPlatformStore();
    const connector = await store.createModelConnector({
      name: "Cloud primary",
      location: "cloud",
      baseUrl: "https://models.example.com/v1",
      model: "meeting-v1"
    });

    await expect(modelConnectorLifecycle(store).updateModelConnector(connector.id, {
      name: "GB10 local",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "qwen3.5-35b-a3b",
      enabled: false
    })).resolves.toMatchObject({
      connector: {
        id: connector.id,
        name: "GB10 local",
        location: "local",
        baseUrl: "http://192.168.50.10:4000/v1",
        model: "qwen3.5-35b-a3b",
        enabled: false
      },
      assignedAgentCount: 0
    });
  });

  it("rejects normalized duplicate Model Connector names on create", async () => {
    const store = new InMemoryPlatformStore();
    await store.createModelConnector({
      name: "Cloud One",
      location: "cloud",
      baseUrl: "https://models.example.com/v1",
      model: "meeting"
    });

    await expect(store.createModelConnector({
      name: "  cloud one  ",
      location: "cloud",
      baseUrl: "https://backup.example.com/v1",
      model: "meeting"
    })).rejects.toThrow(/already|unique|duplicate/i);
  });

  it("rejects normalized duplicate Model Connector names on update", async () => {
    const store = new InMemoryPlatformStore();
    await store.createModelConnector({
      name: "Cloud One",
      location: "cloud",
      baseUrl: "https://models.example.com/v1",
      model: "meeting"
    });
    const archive = await store.createModelConnector({
      name: "Archive",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "archive"
    });

    await expect(modelConnectorLifecycle(store).updateModelConnector(archive.id, {
      name: "ＣＬＯＵＤ ＯＮＥ"
    })).rejects.toThrow(/already|unique|duplicate/i);
  });

  it("preserves Connector secrets on metadata updates and rotates them through Credential CAS", async () => {
    const store = new InMemoryPlatformStore();
    const connector = await store.createModelConnector({
      name: "Secret model",
      location: "cloud",
      baseUrl: "https://models.example.com/v1",
      model: "meeting"
    }, { ciphertext: "encrypted-original" });
    const lifecycle = modelConnectorLifecycle(store);

    expect(connector.secretRevision).toBe(1);
    await expect(lifecycle.updateModelConnector(connector.id, { model: "meeting-v2" }))
      .resolves.toMatchObject({ connector: { hasSecret: true, secretRevision: 1 } });
    expect(await store.getConnectorSecret(connector.id)).toBe("encrypted-original");

    await expect(lifecycle.updateModelConnector(connector.id, { name: "Secret model v2" }, { ciphertext: "" }))
      .resolves.toMatchObject({ connector: { hasSecret: true, secretRevision: 1 } });
    expect(await store.getConnectorSecret(connector.id)).toBe("encrypted-original");

    await expect(lifecycle.updateModelConnector(connector.id, {}, { ciphertext: "encrypted-rotated" }))
      .rejects.toThrow(/Credential/i);
    await expect(store.rotateCredential({
      credentialId: connector.credentialId!,
      expectedSecretRevision: 1
    }, { ciphertext: "encrypted-rotated" })).resolves.toMatchObject({ hasSecret: true, secretRevision: 2 });
    expect((await store.getSnapshot()).modelConnectors.find((item) => item.id === connector.id))
      .toMatchObject({ hasSecret: true, secretRevision: 2 });
    expect(await store.getConnectorSecret(connector.id)).toBe("encrypted-rotated");
  });

  it("reports assigned Agents when disabled without deleting their bindings", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const connector = await store.createModelConnector({
      name: "Shared model",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "meeting"
    });
    await store.setAgentModel(snapshot.agents[0]!.id, { modelConnectorId: connector.id });
    await store.setAgentModel(snapshot.agents[1]!.id, { modelConnectorId: connector.id });

    await expect(modelConnectorLifecycle(store).updateModelConnector(connector.id, { enabled: false }))
      .resolves.toMatchObject({ connector: { enabled: false }, assignedAgentCount: 2 });
    expect((await store.getSnapshot()).agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: snapshot.agents[0]!.id, modelConnectorId: connector.id, status: "attention" }),
      expect.objectContaining({ id: snapshot.agents[1]!.id, modelConnectorId: connector.id, status: "attention" })
    ]));

    await modelConnectorLifecycle(store).updateModelConnector(connector.id, { enabled: true });
    expect((await store.getSnapshot()).agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: snapshot.agents[0]!.id, modelConnectorId: connector.id, status: "online" }),
      expect.objectContaining({ id: snapshot.agents[1]!.id, modelConnectorId: connector.id, status: "online" })
    ]));
  });

  it("rejects every path that would newly assign a disabled Model Connector", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const connector = await store.createModelConnector({
      name: "Disabled model",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "meeting"
    });
    await modelConnectorLifecycle(store).updateModelConnector(connector.id, { enabled: false });

    const assignments = await Promise.allSettled([
      store.setAgentModel(snapshot.agents[0]!.id, { modelConnectorId: connector.id }),
      store.updateAgent(snapshot.agents[1]!.id, { modelConnectorId: connector.id }),
      store.createAgent({
        name: "New disabled-model Agent",
        description: "",
        modelConnectorId: connector.id,
        goalSummary: "Must not be created with a disabled model.",
        toolsSummary: "No tools.",
        dataSummary: "No data.",
        skillIds: [],
        toolGrants: [],
        runtimeProfileBinding: null,
        promptBinding: null
      })
    ]);

    expect(assignments.map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"]);
    for (const result of assignments) {
      if (result.status === "rejected") expect(String(result.reason)).toMatch(/enabled|disabled/i);
    }
  });

  it("allows unrelated Agent edits to retain an existing disabled Model Connector binding", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const connector = await store.createModelConnector({
      name: "Temporarily disabled",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "meeting"
    });
    await store.setAgentModel(snapshot.agents[0]!.id, { modelConnectorId: connector.id });
    await modelConnectorLifecycle(store).updateModelConnector(connector.id, { enabled: false });

    await expect(store.updateAgent(snapshot.agents[0]!.id, {
      name: "Agent renamed while model is offline",
      modelConnectorId: connector.id
    })).resolves.toMatchObject({
      name: "Agent renamed while model is offline",
      modelConnectorId: connector.id
    });
  });

  it("rejects a non-Agent Prompt binding at the Agent definition boundary", async () => {
    const store = new InMemoryPlatformStore();
    const prompt = await store.createPrompt({
      name: "Meeting-only Prompt",
      kind: "meeting",
      description: "Must not be bound to an Agent.",
      owner: "Test Owner",
      content: "Summarize the Meeting.",
      variables: []
    });
    await store.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 });

    await expect(store.createAgent({
      name: "Invalid Prompt Agent",
      description: "",
      modelConnectorId: null,
      goalSummary: "Reject incompatible Prompt kinds.",
      toolsSummary: "No tools.",
      dataSummary: "No data.",
      skillIds: [],
      toolGrants: [],
      toolPackGrants: [],
      runtimeProfileBinding: null,
      promptBinding: { promptId: prompt.id, version: 1 }
    })).rejects.toThrow(/Agent Prompt|Prompt kind/i);
  });
});

describe("discussion taxonomy management", () => {
  class AuditedTaxonomyStore extends InMemoryPlatformStore {
    readonly audits: Array<{ event: string; entityType: string; entityId: string; detail: Record<string, unknown> }> = [];

    override async recordAudit(event: string, entityType: string, entityId: string, detail: Record<string, unknown> = {}): Promise<void> {
      this.audits.push({ event, entityType, entityId, detail });
    }
  }

  class GatedFailingTaxonomyStore extends InMemoryPlatformStore {
    private markEntered!: () => void;
    private releaseGate!: () => void;
    readonly entered = new Promise<void>((resolve) => { this.markEntered = resolve; });
    private readonly gate = new Promise<void>((resolve) => { this.releaseGate = resolve; });

    constructor(private readonly failedEvent: string) {
      super();
    }

    release(): void {
      this.releaseGate();
    }

    override async recordAudit(event: string): Promise<void> {
      if (event !== this.failedEvent) return;
      this.markEntered();
      await this.gate;
      throw new Error(`Injected taxonomy audit failure: ${event}`);
    }
  }

  it("creates a Group, Category, and Tag with stable parent references", async () => {
    const store = new InMemoryPlatformStore();
    const group = await store.createGroup({ name: "客戶交付" }, "group-key");
    const category = await store.createCategory({ groupId: group.id, name: "上線評審" }, "category-key");
    const tag = await store.createTag({ name: "待決策", color: "amber" }, "tag-key");

    expect(await store.createGroup({ name: "客戶交付" }, "group-key")).toEqual(group);
    expect(await store.createCategory({ groupId: group.id, name: "上線評審" }, "category-key")).toEqual(category);
    expect(await store.createTag({ name: "待決策", color: "amber" }, "tag-key")).toEqual(tag);
    expect(await store.getSnapshot()).toMatchObject({
      groups: expect.arrayContaining([group]),
      categories: expect.arrayContaining([category]),
      tags: expect.arrayContaining([tag])
    });
  });

  it("rejects orphan Categories and duplicate taxonomy names", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const missingId = "ffffffff-ffff-4fff-8fff-ffffffffffff";

    await expect(store.createCategory({ groupId: missingId, name: "孤兒分類" })).rejects.toThrow(/group/i);
    await expect(store.createGroup({ name: snapshot.groups[0]!.name.toLocaleUpperCase() })).rejects.toThrow(/already|unique|duplicate/i);
    await expect(store.createCategory({
      groupId: snapshot.groups[0]!.id,
      name: snapshot.categories[0]!.name.toLocaleUpperCase()
    })).rejects.toThrow(/already|unique|duplicate/i);
    await expect(store.createTag({ name: snapshot.tags[0]!.name.toLocaleUpperCase(), color: "red" })).rejects.toThrow(/already|unique|duplicate/i);
  });

  it("normalizes Unicode names before enforcing taxonomy uniqueness", async () => {
    const store = new InMemoryPlatformStore();
    await store.createGroup({ name: "Caf\u00e9" });

    await expect(store.createGroup({ name: "Cafe\u0301" })).rejects.toThrow(/already|unique|duplicate/i);
  });

  it("binds an in-memory idempotency key to its original payload", async () => {
    const store = new InMemoryPlatformStore();
    await store.createGroup({ name: "Original" }, "bound-key");

    await expect(store.createGroup({ name: "Different" }, "bound-key")).rejects.toThrow(/idempotency key/i);
  });

  it("coalesces concurrent taxonomy retries that share an idempotency key", async () => {
    const store = new InMemoryPlatformStore();
    const [group, groupRetry] = await Promise.all([
      store.createGroup({ name: "Concurrent group" }, "concurrent-group"),
      store.createGroup({ name: "Concurrent group" }, "concurrent-group")
    ]);
    const [category, categoryRetry] = await Promise.all([
      store.createCategory({ groupId: group.id, name: "Concurrent category" }, "concurrent-category"),
      store.createCategory({ groupId: group.id, name: "Concurrent category" }, "concurrent-category")
    ]);
    const [tag, tagRetry] = await Promise.all([
      store.createTag({ name: "Concurrent tag", color: "blue" }, "concurrent-tag"),
      store.createTag({ name: "Concurrent tag", color: "blue" }, "concurrent-tag")
    ]);
    const threadInput = {
      categoryId: category.id,
      title: "Concurrent Topic",
      summary: "The same request must produce one Topic.",
      tagIds: [tag.id]
    };
    const [thread, threadRetry] = await Promise.all([
      store.createThread(threadInput, "concurrent-thread"),
      store.createThread(threadInput, "concurrent-thread")
    ]);

    expect(groupRetry).toEqual(group);
    expect(categoryRetry).toEqual(category);
    expect(tagRetry).toEqual(tag);
    expect(threadRetry).toEqual(thread);
    const snapshot = await store.getSnapshot();
    expect(snapshot.groups.filter((item) => item.id === group.id)).toHaveLength(1);
    expect(snapshot.categories.filter((item) => item.id === category.id)).toHaveLength(1);
    expect(snapshot.tags.filter((item) => item.id === tag.id)).toHaveLength(1);
    expect(snapshot.threads.filter((item) => item.id === thread.id)).toHaveLength(1);
  });

  it("coalesces concurrent Agent creation retries and binds the key to the original draft", async () => {
    const store = new InMemoryPlatformStore();
    const input = {
      name: "Retry-safe Agent",
      description: "Created once even when the acknowledgement is lost.",
      modelConnectorId: null,
      goalSummary: "Protect Agent draft creation from duplicate retries.",
      toolsSummary: "No tools.",
      dataSummary: "No data.",
      skillIds: [],
      toolGrants: [],
      toolPackGrants: [],
      runtimeProfileBinding: null,
      promptBinding: null
    };

    const [created, replayed] = await Promise.all([
      store.createAgent(input, "agent-create-retry"),
      store.createAgent(input, "agent-create-retry")
    ]);

    expect(replayed).toEqual(created);
    expect((await store.getSnapshot()).agents.filter((agent) => agent.id === created.id)).toHaveLength(1);
    await expect(store.createAgent({ ...input, name: "Changed retry" }, "agent-create-retry"))
      .rejects.toThrow(/idempotency key/i);
  });

  it.each([
    {
      label: "Group creation",
      event: "group.created",
      collection: "groups" as const,
      mutate: (store: InMemoryPlatformStore) => store.createGroup({ name: "Audit-bound Group" }, "audit-group")
    },
    {
      label: "Category creation",
      event: "category.created",
      collection: "categories" as const,
      mutate: (store: InMemoryPlatformStore, before: PlatformSnapshot) => store.createCategory({
        groupId: before.groups[0]!.id,
        name: "Audit-bound Category"
      }, "audit-category")
    },
    {
      label: "Tag creation",
      event: "tag.created",
      collection: "tags" as const,
      mutate: (store: InMemoryPlatformStore) => store.createTag({
        name: "Audit-bound Tag",
        color: "blue"
      }, "audit-tag")
    },
    {
      label: "Topic creation",
      event: "thread.created",
      collection: "threads" as const,
      mutate: (store: InMemoryPlatformStore, before: PlatformSnapshot) => store.createThread({
        categoryId: before.categories[0]!.id,
        title: "Audit-bound Topic",
        summary: "The Topic must not appear before its audit commits.",
        tagIds: [before.tags[0]!.id]
      }, "audit-thread")
    },
    {
      label: "Group update",
      event: "group.updated",
      collection: "groups" as const,
      mutate: (store: InMemoryPlatformStore, before: PlatformSnapshot) => store.updateGroup(before.groups[0]!.id, {
        expectedRevision: before.groups[0]!.revision,
        name: "Audit-bound Group update"
      })
    },
    {
      label: "Category update",
      event: "category.updated",
      collection: "categories" as const,
      mutate: (store: InMemoryPlatformStore, before: PlatformSnapshot) => store.updateCategory(before.categories[0]!.id, {
        expectedRevision: before.categories[0]!.revision,
        name: "Audit-bound Category update"
      })
    },
    {
      label: "Tag update",
      event: "tag.updated",
      collection: "tags" as const,
      mutate: (store: InMemoryPlatformStore, before: PlatformSnapshot) => store.updateTag(before.tags[0]!.id, {
        expectedRevision: before.tags[0]!.revision,
        color: "green"
      })
    },
    {
      label: "Topic update",
      event: "thread.updated",
      collection: "threads" as const,
      mutate: (store: InMemoryPlatformStore, before: PlatformSnapshot) => store.updateThread(before.threads[0]!.id, {
        expectedRevision: before.threads[0]!.revision,
        summary: "This update must remain invisible until its audit commits."
      })
    }
  ])("does not expose $label before its required audit commits", async ({ event, collection, mutate }) => {
    const store = new GatedFailingTaxonomyStore(event);
    const before = await store.getSnapshot();
    const mutation = mutate(store, before);

    await Promise.race([
      store.entered,
      mutation.then(() => { throw new Error(`${event} committed before its required audit.`); })
    ]);
    expect((await store.getSnapshot())[collection]).toEqual(before[collection]);

    store.release();
    await expect(mutation).rejects.toThrow(/taxonomy audit failure/);
    expect((await store.getSnapshot())[collection]).toEqual(before[collection]);
  });

  it("updates Group, Category, and Tag names or parents with normalized uniqueness and audit history", async () => {
    const store = new AuditedTaxonomyStore();
    const snapshot = await store.getSnapshot();
    const group = snapshot.groups[0]!;
    const category = snapshot.categories[0]!;
    const tag = snapshot.tags[0]!;
    const targetGroup = await store.createGroup({ name: "Target group" });
    await store.createCategory({ groupId: targetGroup.id, name: "Caf\u00e9" });
    const duplicateGroup = await store.createGroup({ name: "Caf\u00e9" });
    const duplicateTag = await store.createTag({ name: "Caf\u00e9 tag", color: "gray" });

    await expect(store.updateCategory(category.id, { expectedRevision: category.revision, name: category.name })).resolves.toMatchObject({ id: category.id, name: category.name });
    await expect(store.updateGroup(group.id, { expectedRevision: group.revision, name: "Cafe\u0301" })).rejects.toThrow(/already exists/i);
    await expect(store.updateTag(tag.id, { expectedRevision: tag.revision, name: "Cafe\u0301 tag" })).rejects.toThrow(/already exists/i);
    await expect(store.updateCategory(category.id, { expectedRevision: category.revision, groupId: targetGroup.id, name: "Cafe\u0301" })).rejects.toThrow(/already exists/i);
    await expect(store.updateGroup("90000000-0000-4000-8000-000000000099", { expectedRevision: 1, name: "Missing" })).rejects.toThrow(/Group not found/i);
    await expect(store.updateCategory(category.id, { expectedRevision: category.revision, groupId: "90000000-0000-4000-8000-000000000099" })).rejects.toThrow(/Group not found/i);
    await expect(store.updateTag("90000000-0000-4000-8000-000000000099", { expectedRevision: 1, color: "blue" })).rejects.toThrow(/Tag not found/i);

    const updatedGroup = await store.updateGroup(group.id, { expectedRevision: group.revision, name: "Renamed group" });
    const updatedCategory = await store.updateCategory(category.id, { expectedRevision: category.revision, groupId: targetGroup.id, name: "Moved category" });
    const updatedTag = await store.updateTag(tag.id, { expectedRevision: tag.revision, name: "Renamed tag", color: "blue" });

    expect(updatedGroup).toMatchObject({ id: group.id, name: "Renamed group" });
    expect(updatedCategory).toMatchObject({ id: category.id, groupId: targetGroup.id, name: "Moved category" });
    expect(updatedTag).toMatchObject({ id: tag.id, name: "Renamed tag", color: "blue" });
    expect(duplicateGroup.name).toBe("Caf\u00e9");
    expect(duplicateTag.name).toBe("Caf\u00e9 tag");
    expect(store.audits.slice(-3)).toEqual([
      expect.objectContaining({
        event: "group.updated",
        entityId: group.id,
        detail: { fields: ["name"], previousRevision: 1, revision: 2, previous: { name: group.name }, current: { name: "Renamed group" } }
      }),
      expect.objectContaining({
        event: "category.updated",
        entityId: category.id,
        detail: {
          fields: ["groupId", "name"],
          previousRevision: 1,
          revision: 2,
          previous: { groupId: category.groupId, name: category.name },
          current: { groupId: targetGroup.id, name: "Moved category" }
        }
      }),
      expect.objectContaining({
        event: "tag.updated",
        entityId: tag.id,
        detail: {
          fields: ["name", "color"],
          previousRevision: 1,
          revision: 2,
          previous: { name: tag.name, color: tag.color },
          current: { name: "Renamed tag", color: "blue" }
        }
      })
    ]);
  });

  it("rejects stale Group, Category, and Tag edits without changing the winning revision", async () => {
    const store = new InMemoryPlatformStore();
    const before = await store.getSnapshot();
    const group = before.groups[0]!;
    const category = before.categories[0]!;
    const tag = before.tags[0]!;

    await expect(store.updateGroup(group.id, { expectedRevision: 1, name: "Winning group" }))
      .resolves.toMatchObject({ revision: 2, name: "Winning group" });
    await expect(store.updateCategory(category.id, { expectedRevision: 1, name: "Winning category" }))
      .resolves.toMatchObject({ revision: 2, name: "Winning category" });
    await expect(store.updateTag(tag.id, { expectedRevision: 1, name: "Winning tag" }))
      .resolves.toMatchObject({ revision: 2, name: "Winning tag" });

    await expect(store.updateGroup(group.id, { expectedRevision: 1, name: "Stale group" })).rejects.toThrow(/revision/i);
    await expect(store.updateCategory(category.id, { expectedRevision: 1, name: "Stale category" })).rejects.toThrow(/revision/i);
    await expect(store.updateTag(tag.id, { expectedRevision: 1, name: "Stale tag" })).rejects.toThrow(/revision/i);

    const after = await store.getSnapshot();
    expect(after.groups.find((item) => item.id === group.id)).toMatchObject({ revision: 2, name: "Winning group" });
    expect(after.categories.find((item) => item.id === category.id)).toMatchObject({ revision: 2, name: "Winning category" });
    expect(after.tags.find((item) => item.id === tag.id)).toMatchObject({ revision: 2, name: "Winning tag" });
  });
});

describe("topic lifecycle management", () => {
  class AuditedStore extends InMemoryPlatformStore {
    readonly events: string[] = [];

    override async recordAudit(event: string, _entityType: string, _entityId: string, _detail: Record<string, unknown> = {}): Promise<void> {
      this.events.push(event);
    }
  }

  function createAuditFailureStore(targetEvent: string, triggerOnOccurrence = 1) {
    let release = () => {};
    const awaiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opened = false;
    let observed = 0;
    let reached = () => {};
    const openedPromise = new Promise<void>((resolve) => {
      reached = resolve;
    });

    class MeetingAuditFailureStore extends InMemoryPlatformStore {
      override async recordAudit(event: string, _entityType: string, _entityId: string, _detail: Record<string, unknown> = {}): Promise<void> {
        if (event === targetEvent) {
          observed += 1;
        }
        if (event === targetEvent && !opened && observed === triggerOnOccurrence) {
          opened = true;
          reached();
          await awaiting;
          throw new Error("meeting audit unavailable");
        }
      }
    }

    return {
      Store: MeetingAuditFailureStore,
      allowAudit: async () => release(),
      waitForFailure: openedPromise
    };
  }

  it("supports partial Topic updates and blocks closed status while meetings are active", async () => {
    const store = new AuditedStore();
    const snapshot = await store.getSnapshot();
    const tag = snapshot.tags[0]!;

    const thread = await store.createThread({
      categoryId: snapshot.categories[0]!.id,
      title: "可變更主題",
      summary: "可變更主題摘要。",
      tagIds: []
    });

    const updated = await store.updateThread(thread.id, {
      expectedRevision: thread.revision,
      title: "更新後標題",
      status: "resolved",
      tagIds: [tag.id]
    });
    expect(updated).toMatchObject({
      id: thread.id,
      revision: thread.revision + 1,
      title: "更新後標題",
      status: "resolved",
      tagIds: [tag.id]
    });
    expect(store.events).toContain("thread.updated");

    await expect(store.updateThread(thread.id, {
      expectedRevision: thread.revision,
      summary: "不得覆寫較新的 Topic。"
    })).rejects.toThrow(/revision.*stale/i);
    expect((await store.getSnapshot()).threads.find((item) => item.id === thread.id))
      .toMatchObject({ revision: updated.revision, summary: thread.summary });

    await expect(store.updateThread(thread.id, { expectedRevision: updated.revision, tagIds: [tag.id, tag.id] })).rejects.toThrow(/Each tag may be assigned only once/i);
    await expect(store.updateThread(thread.id, { expectedRevision: updated.revision, categoryId: "90000000-0000-4000-8000-000000000099" })).rejects.toThrow(/Category not found/i);
    await expect(store.updateThread(thread.id, { expectedRevision: updated.revision, tagIds: ["90000000-0000-4000-8000-000000000099"] })).rejects.toThrow(/Tag not found/i);

    const withActiveMeeting = createSeedSnapshot();
    const storeWithActive = new AuditedStore(withActiveMeeting);
    const activeThread = withActiveMeeting.threads[0]!;
    await expect(storeWithActive.updateThread(activeThread.id, { expectedRevision: activeThread.revision, status: "archived" })).rejects.toThrow(/unfinished/i);

    const withClosedSnapshot = createSeedSnapshot();
    const withClosedMeeting = new AuditedStore(withClosedSnapshot);
    const closedThread = await withClosedMeeting.createThread({
      categoryId: snapshot.categories[0]!.id,
      title: "可解封主題",
      summary: "先有關閉會議的主題。",
      tagIds: []
    });
    const closedMeeting = await withClosedMeeting.createMeeting({
      threadId: closedThread.id,
      title: "關閉會議",
      goal: "先建立再關閉",
      mode: "fixed",
      durationMinutes: 20,
      participants: [{ agentId: withClosedSnapshot.agents[0]!.id, roleId: withClosedSnapshot.roles[0]!.id, isChair: true }],
      agendaItems: [{ title: "確認關閉流程", description: "" }]
    });
    await withClosedMeeting.setMeetingState(closedMeeting.id, "closed");
    const closedUpdate = await withClosedMeeting.updateThread(closedThread.id, { expectedRevision: closedThread.revision, status: "archived" });
    expect(closedUpdate.status).toBe("archived");

  });

  it("prevents creating Meetings from non-open Topics and allows when the Topic is open", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const thread = await store.createThread({
      categoryId: snapshot.categories[0]!.id,
      title: "非開放主題",
      summary: "確認非 open Topic 的行為。",
      tagIds: []
    });

    const resolved = await store.updateThread(thread.id, { expectedRevision: thread.revision, status: "resolved" });
    expect(resolved.status).toBe("resolved");

    await expect(store.createMeeting({
      threadId: thread.id,
      title: "Blocked by Topic",
      goal: "Should not allow meeting",
      mode: "fixed",
      durationMinutes: 30,
      participants: [{ agentId: snapshot.agents[0]!.id, roleId: snapshot.roles[0]!.id, isChair: true }],
      agendaItems: [{ title: "確認 Topic 狀態", description: "" }]
    })).rejects.toThrow(/open Topics/);

    const archived = await store.updateThread(thread.id, { expectedRevision: resolved.revision, status: "archived" });
    expect(archived.status).toBe("archived");
    await expect(store.createMeeting({
      threadId: thread.id,
      title: "Archived Topic",
      goal: "Archived Topic should also reject a new Meeting",
      mode: "fixed",
      durationMinutes: 30,
      participants: [{ agentId: snapshot.agents[0]!.id, roleId: snapshot.roles[0]!.id, isChair: true }],
      agendaItems: [{ title: "確認封存狀態", description: "" }]
    })).rejects.toThrow(/open Topics/);

    const reopened = await store.updateThread(thread.id, { expectedRevision: archived.revision, status: "open" });
    expect(reopened.status).toBe("open");

    const meeting = await store.createMeeting({
      threadId: thread.id,
      title: "Allowed when open",
      goal: "Seed participants can create meeting",
      mode: "fixed",
      durationMinutes: 30,
      participants: [{ agentId: snapshot.agents[0]!.id, roleId: snapshot.roles[0]!.id, isChair: true }],
      agendaItems: [{ title: "確認開放狀態", description: "" }]
    });
    expect(meeting).toMatchObject({ threadId: thread.id, state: "draft" });
  });

  it("allows only one unfinished Meeting per Topic and permits the next session after close", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const thread = await store.createThread({
      categoryId: snapshot.categories[0]!.id,
      title: "多場會議主題",
      summary: "同時只能有一場未結束會議。",
      tagIds: []
    });
    const input = {
      threadId: thread.id,
      title: "第一場",
      goal: "驗證場次互斥",
      mode: "fixed" as const,
      durationMinutes: 30,
      participants: [{ agentId: snapshot.agents[0]!.id, roleId: snapshot.roles[0]!.id, isChair: true }],
      agendaItems: [{ title: "確認場次互斥", description: "" }]
    };

    const first = await store.createMeeting(input);
    await expect(store.createMeeting({ ...input, title: "不應建立的第二場" })).rejects.toThrow(/unfinished Meeting/i);

    await expect(store.setMeetingState(first.id, "closed", "draft")).resolves.toMatchObject({
      state: "closed",
      summaryState: "pending"
    });
    const second = await store.createMeeting({ ...input, title: "第二場" });
    expect(second).toMatchObject({
      threadId: thread.id,
      title: "第二場",
      state: "draft",
      summaryState: "not_requested"
    });

    await expect(store.setMeetingState(first.id, "paused", "draft")).rejects.toMatchObject({
      kind: "revision",
      message: expect.stringMatching(/state changed/i)
    });
    await expect(store.setMeetingState(first.id, "paused")).rejects.toThrow(/another unfinished Meeting/i);
    expect((await store.getSnapshot()).meetings.find((meeting) => meeting.id === first.id)?.state).toBe("closed");
  });

  it("returns one Meeting for concurrent retries that share an idempotency key", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const thread = await store.createThread({
      categoryId: snapshot.categories[0]!.id,
      title: "冪等建立場次",
      summary: "同一請求不得互相衝突。",
      tagIds: []
    });
    const input = {
      threadId: thread.id,
      title: "唯一場次",
      goal: "驗證並行重試",
      mode: "open" as const,
      durationMinutes: 20,
      participants: [{ agentId: snapshot.agents[0]!.id, roleId: snapshot.roles[0]!.id, isChair: true }],
      agendaItems: [{ title: "確認並行重試", description: "" }]
    };

    const [first, retry] = await Promise.all([
      store.createMeeting(input, "same-meeting-key"),
      store.createMeeting(input, "same-meeting-key")
    ]);

    expect(retry).toEqual(first);
    const current = await store.getSnapshot();
    expect(current.meetings.filter((meeting) => meeting.threadId === thread.id)).toHaveLength(1);
    expect(current.participants.filter((participant) => participant.meetingId === first.id)).toHaveLength(1);
  });

  it("does not overwrite a Worker summary failure with a late queued update", async () => {
    const store = new InMemoryPlatformStore();
    const meetingId = (await store.getSnapshot()).meetings[0]!.id;
    await store.setMeetingState(meetingId, "closed", "active");
    await store.setMeetingSummaryState(meetingId, "failed", "failed-job");

    await expect(store.setMeetingSummaryState(meetingId, "queued", "failed-job")).rejects.toThrow(/cannot change/i);
    expect((await store.getSnapshot()).meetings.find((meeting) => meeting.id === meetingId)).toMatchObject({
      summaryState: "failed",
      summaryJobId: "failed-job"
    });

    await store.setMeetingSummaryState(meetingId, "pending");
    await expect(store.setMeetingSummaryState(meetingId, "pending")).resolves.toMatchObject({
      summaryState: "pending",
      summaryJobId: null
    });
    await expect(store.setMeetingSummaryState(meetingId, "queued", "retry-job")).resolves.toMatchObject({
      summaryState: "queued",
      summaryJobId: "retry-job"
    });
    await expect(store.setMeetingSummaryState(meetingId, "queued", "retry-job")).resolves.toMatchObject({
      summaryState: "queued",
      summaryJobId: "retry-job"
    });
  });

  it("does not let stale summary jobs replace a newer pending reservation", async () => {
    for (const staleState of ["queued", "completed", "failed"] as const) {
      const store = new InMemoryPlatformStore();
      const meetingId = (await store.getSnapshot()).meetings[0]!.id;
      await store.setMeetingState(meetingId, "closed", "active");
      await store.setMeetingSummaryState(meetingId, "pending", "stale-job");
      await store.setMeetingSummaryState(meetingId, "failed", "stale-job");
      await store.setMeetingSummaryState(meetingId, "pending", "current-job");

      await expect(store.setMeetingSummaryState(meetingId, staleState, "stale-job")).resolves.toMatchObject({
        summaryState: "pending",
        summaryJobId: "current-job"
      });
      expect((await store.getSnapshot()).meetings.find((meeting) => meeting.id === meetingId)).toMatchObject({
        summaryState: "pending",
        summaryJobId: "current-job"
      });
    }
  });

  it("rolls back Meeting and participant writes when an in-memory creation audit fails", async () => {
    class FailOnceMeetingAuditStore extends InMemoryPlatformStore {
      private failed = false;

      override async recordAudit(event: string): Promise<void> {
        if (event === "meeting.created" && !this.failed) {
          this.failed = true;
          throw new Error("audit unavailable");
        }
      }
    }

    const store = new FailOnceMeetingAuditStore();
    const snapshot = await store.getSnapshot();
    const thread = await store.createThread({
      categoryId: snapshot.categories[0]!.id,
      title: "可回滾場次",
      summary: "audit 失敗不得留下半成品。",
      tagIds: []
    });
    const input = {
      threadId: thread.id,
      title: "原子建立",
      goal: "驗證本機交易語意",
      mode: "open" as const,
      durationMinutes: 20,
      participants: [{ agentId: snapshot.agents[0]!.id, roleId: snapshot.roles[0]!.id, isChair: true }],
      agendaItems: [{ title: "確認原子建立", description: "" }]
    };

    await expect(store.createMeeting(input, "retry-after-audit")).rejects.toThrow(/audit unavailable/i);
    let current = await store.getSnapshot();
    expect(current.meetings.filter((meeting) => meeting.threadId === thread.id)).toEqual([]);
    expect(current.participants.filter((participant) => current.meetings.some((meeting) => meeting.id === participant.meetingId))).toHaveLength(snapshot.participants.length);

    await expect(store.createMeeting(input, "retry-after-audit")).resolves.toMatchObject({ threadId: thread.id, state: "draft" });
    current = await store.getSnapshot();
    expect(current.meetings.filter((meeting) => meeting.threadId === thread.id)).toHaveLength(1);
  });

  it("keeps a Meeting and its participants invisible until the creation audit commits", async () => {
    const { Store, allowAudit, waitForFailure } = createAuditFailureStore("meeting.created");
    const store = new Store();
    const snapshot = await store.getSnapshot();
    const thread = await store.createThread({
      categoryId: snapshot.categories[0]!.id,
      title: "Pending Meeting audit",
      summary: "The Meeting must not be addressable before its audit commits.",
      tagIds: []
    });
    const creation = store.createMeeting({
      threadId: thread.id,
      title: "Invisible until audited",
      goal: "Prevent orphan workflow records.",
      mode: "open",
      durationMinutes: 20,
      participants: [{
        agentId: snapshot.agents[0]!.id,
        roleId: snapshot.roles[0]!.id,
        isChair: true
      }],
      agendaItems: [{ title: "Audit boundary", description: "" }]
    });

    await waitForFailure;
    const pending = await store.getSnapshot();
    expect(pending.meetings.some((meeting) => meeting.threadId === thread.id)).toBe(false);
    expect(pending.participants.some((participant) => (
      pending.meetings.some((meeting) => meeting.id === participant.meetingId && meeting.threadId === thread.id)
    ))).toBe(false);
    await expect(store.createDecision({
      meetingId: pending.meetings.find((meeting) => meeting.threadId === thread.id)?.id ?? "00000000-0000-4000-8000-000000000099",
      title: "Must not be created",
      description: "A pending Meeting cannot own a Decision."
    })).rejects.toThrow(/Meeting not found/i);

    await allowAudit();
    await expect(creation).rejects.toThrow(/meeting audit unavailable/i);
    const settled = await store.getSnapshot();
    expect(settled.meetings.some((meeting) => meeting.threadId === thread.id)).toBe(false);
    expect(settled.decisions.some((decision) => decision.title === "Must not be created")).toBe(false);
  });

  it("preserves unrelated Task/Decision writes when setMeetingState audit fails", async () => {
    const { Store, allowAudit, waitForFailure } = createAuditFailureStore("meeting.start");
    const store = new Store();
    const seed = await store.getSnapshot();
    const thread = await store.createThread({
      categoryId: seed.categories[0]!.id,
      title: "Audit gate state test",
      summary: "Keep independent meeting state",
      tagIds: []
    });
    const meeting = await store.createMeeting({
      threadId: thread.id,
      title: "Audit Gate Meeting",
      goal: "Validate state rollback",
      mode: "open",
      durationMinutes: 20,
      participants: [{ agentId: seed.agents[0]!.id, roleId: seed.roles[0]!.id, isChair: true }],
      agendaItems: [{ title: "Agenda check", description: "for rollback" }]
    });
    const approvedDecision = await store.createDecision({
      meetingId: meeting.id,
      title: "Approved decision for concurrent task",
      description: "Keep its task stable while Meeting state changes fail."
    });
    await store.setDecisionStatus(approvedDecision.id, "approved");
    const stableTask = await store.createTask({
      decisionId: approvedDecision.id,
      title: "Stable task",
      description: "Task changes must survive Meeting rollback."
    });
    const concurrentDecision = await store.createDecision({
      meetingId: meeting.id,
      title: "Concurrent decision",
      description: "Status should still be updated even if Meeting audit fails."
    });

    const meetingMutation = store.setMeetingState(meeting.id, "active");
    const taskMutation = waitForFailure.then(() => store.updateTask(stableTask.id, {
      expectedRevision: stableTask.revision,
      expectedExecutionRevision: stableTask.execution.revision,
      title: "Concurrent task update"
    }));
    const decisionMutation = waitForFailure.then(() => store.setDecisionStatus(concurrentDecision.id, "approved"));

    await waitForFailure;
    await allowAudit();
    const [meetingResult, taskResult, decisionResult] = await Promise.allSettled([meetingMutation, taskMutation, decisionMutation]);
    expect(meetingResult).toMatchObject({ status: "rejected" });
    expect(taskResult).toMatchObject({ status: "fulfilled" });
    expect(decisionResult).toMatchObject({ status: "fulfilled" });

    const current = await store.getSnapshot();
    expect(current.meetings.find((item) => item.id === meeting.id)).toMatchObject({
      state: "draft"
    });
    expect(current.tasks.find((item) => item.id === stableTask.id)).toMatchObject({
      title: "Concurrent task update"
    });
    expect(current.decisions.find((item) => item.id === concurrentDecision.id)).toMatchObject({
      status: "approved"
    });
  });

  it("does not expose a Meeting state transition while its required audit is pending", async () => {
    const { Store, allowAudit, waitForFailure } = createAuditFailureStore("meeting.pause");
    const store = new Store();
    const meeting = (await store.getSnapshot()).meetings[0]!;

    const pausing = store.setMeetingState(meeting.id, "paused", "active");
    await waitForFailure;
    const whileAuditPending = await store.getSnapshot();
    await allowAudit();
    const [pauseResult] = await Promise.allSettled([pausing]);

    expect(whileAuditPending.meetings.find((item) => item.id === meeting.id)?.state).toBe("active");
    expect(pauseResult).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/audit unavailable/i) }) });
    expect((await store.getSnapshot()).meetings.find((item) => item.id === meeting.id)?.state).toBe("active");
  });

  it("does not create a second unfinished Meeting while a close audit rolls back", async () => {
    const { Store, allowAudit, waitForFailure } = createAuditFailureStore("meeting.close");
    const store = new Store();
    const seed = await store.getSnapshot();
    const thread = await store.createThread({
      categoryId: seed.categories[0]!.id,
      title: "Close rollback serialization",
      summary: "A failed close must preserve the one unfinished Meeting invariant.",
      tagIds: []
    });
    const meetingInput = {
      threadId: thread.id,
      title: "Original Meeting",
      goal: "Keep one unfinished Meeting per Topic",
      mode: "open" as const,
      durationMinutes: 20,
      participants: [{ agentId: seed.agents[0]!.id, roleId: seed.roles[0]!.id, isChair: true }],
      agendaItems: [{ title: "Check rollback", description: "" }]
    };
    const original = await store.createMeeting(meetingInput);

    const closing = store.setMeetingState(original.id, "closed", "draft");
    await waitForFailure;
    const concurrentCreate = store.createMeeting({
      ...meetingInput,
      title: "Concurrent Meeting"
    });
    await Promise.resolve();
    await Promise.resolve();
    await allowAudit();

    const [closeResult, createResult] = await Promise.allSettled([closing, concurrentCreate]);
    expect(closeResult).toMatchObject({ status: "rejected" });
    expect(createResult).toMatchObject({ status: "rejected" });
    const current = await store.getSnapshot();
    expect(current.meetings.filter((meeting) => meeting.threadId === thread.id && meeting.state !== "closed"))
      .toEqual([expect.objectContaining({ id: original.id, state: "draft" })]);
  });

  it("rolls back Decision creation and permits the same idempotency retry when audit fails", async () => {
    const { Store, allowAudit, waitForFailure } = createAuditFailureStore("decision.proposed");
    const store = new Store();
    const before = await store.getSnapshot();
    const input = {
      meetingId: before.meetings[0]!.id,
      title: "Audited Decision",
      description: "A failed required audit must not commit this Decision."
    };

    const first = store.createDecision(input, "decision-audit-retry");
    await waitForFailure;
    await allowAudit();
    await expect(first).rejects.toThrow(/audit unavailable/i);
    expect((await store.getSnapshot()).decisions).toHaveLength(before.decisions.length);

    await expect(store.createDecision(input, "decision-audit-retry")).resolves.toMatchObject(input);
    const current = await store.getSnapshot();
    expect(current.decisions.filter((decision) => decision.title === input.title)).toHaveLength(1);
  });

  it("does not expose a Decision approval while its required audit is pending", async () => {
    const { Store, allowAudit, waitForFailure } = createAuditFailureStore("decision.approve");
    const store = new Store();
    const snapshot = await store.getSnapshot();
    const decision = await store.createDecision({
      meetingId: snapshot.meetings[0]!.id,
      title: "Pending audited approval",
      description: "Task creation must wait for the approval audit."
    });

    const approval = store.setDecisionStatus(decision.id, "approved");
    await waitForFailure;
    const taskCreation = store.createTask({
      decisionId: decision.id,
      title: "Must not be created",
      description: "The approval will roll back."
    });
    await Promise.resolve();
    await Promise.resolve();
    await allowAudit();

    const [approvalResult, taskResult] = await Promise.allSettled([approval, taskCreation]);
    expect(approvalResult).toMatchObject({ status: "rejected" });
    expect(taskResult).toMatchObject({ status: "rejected" });
    const current = await store.getSnapshot();
    expect(current.decisions.find((item) => item.id === decision.id)?.status).toBe("proposed");
    expect(current.tasks.some((task) => task.decisionId === decision.id)).toBe(false);
  });

  it("does not advance the Task board or consume an idempotency retry when creation audit fails", async () => {
    const { Store, allowAudit, waitForFailure } = createAuditFailureStore("task.created");
    const store = new Store();
    const snapshot = await store.getSnapshot();
    const decision = await store.createDecision({
      meetingId: snapshot.meetings[0]!.id,
      title: "Task audit source",
      description: "Approve before exercising Task audit rollback."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const before = await store.getSnapshot();
    const input = {
      decisionId: decision.id,
      title: "Audited Task",
      description: "A failed audit must not change the board."
    };

    const first = store.createTask(input, "task-audit-retry");
    await waitForFailure;
    await allowAudit();
    await expect(first).rejects.toThrow(/audit unavailable/i);
    expect((await store.getSnapshot()).tasks.map((task) => ({ id: task.id, boardRevision: task.boardRevision })))
      .toEqual(before.tasks.map((task) => ({ id: task.id, boardRevision: task.boardRevision })));

    await expect(store.createTask(input, "task-audit-retry")).resolves.toMatchObject(input);
    expect((await store.getSnapshot()).tasks.filter((task) => task.decisionId === decision.id)).toHaveLength(1);
  });

  it("coalesces Task Evidence retries and binds the key to one Task payload", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const decision = await store.createDecision({
      meetingId: snapshot.meetings[0]!.id,
      title: "Evidence retry source",
      description: "Create one retry-safe evidence entry."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({ decisionId: decision.id, title: "Evidence retry Task" });
    const input = { type: "note" as const, label: "Retry proof", reference: "Same evidence" };

    const [first, replay] = await Promise.all([
      store.addTaskEvidence(task.id, input, "task-evidence-retry"),
      store.addTaskEvidence(task.id, input, "task-evidence-retry")
    ]);

    expect(replay).toEqual(first);
    expect((await store.getSnapshot()).tasks.find((item) => item.id === task.id)?.evidence
      .filter((evidence) => evidence.label === input.label)).toHaveLength(1);
    await expect(store.addTaskEvidence(task.id, { ...input, reference: "Changed" }, "task-evidence-retry"))
      .rejects.toThrow(/idempotency key/i);
  });

  it.each([
    {
      event: "task.updated",
      mutate: (store: InMemoryPlatformStore, task: Task) => store.updateTask(task.id, {
        expectedRevision: task.revision,
        expectedExecutionRevision: task.execution.revision,
        dueAt: "2026-08-12T12:00:00.000Z"
      })
    },
    {
      event: "task.approval.changed",
      mutate: (store: InMemoryPlatformStore, task: Task) => store.setTaskApproval(task.id, {
        expectedExecutionRevision: task.execution.revision,
        action: "approve"
      })
    },
    {
      event: "task.evidence.added",
      mutate: (store: InMemoryPlatformStore, task: Task) => store.addTaskEvidence(task.id, {
        type: "note",
        label: "Required audit evidence",
        reference: "Evidence must not be visible before its audit commits."
      })
    },
    {
      event: "task.moved",
      mutate: (store: InMemoryPlatformStore, task: Task) => store.moveTask(task.id, {
        expectedBoardRevision: task.boardRevision,
        expectedExecutionRevision: task.execution.revision,
        status: "in_progress",
        position: 0
      })
    }
  ])("does not expose an Owner Task mutation before the $event audit commits", async ({ event, mutate }) => {
    const { Store, allowAudit, waitForFailure } = createAuditFailureStore(event);
    const store = new Store();
    const snapshot = await store.getSnapshot();
    const decision = await store.createDecision({
      meetingId: snapshot.meetings[0]!.id,
      title: `Owner audit fixture ${event}`,
      description: "Required audit failure must leave the Task slice unchanged."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({
      decisionId: decision.id,
      title: decision.title,
      description: decision.description,
      executionProfile: "worker",
      acceptanceCriteria: "The Task mutation is committed only after its required audit."
    });
    const before = (await store.getSnapshot()).tasks;

    const mutation = mutate(store, task);
    await waitForFailure;
    expect((await store.getSnapshot()).tasks).toEqual(before);
    await allowAudit();
    await expect(mutation).rejects.toThrow(/audit unavailable/i);
    expect((await store.getSnapshot()).tasks).toEqual(before);
  });

  it.each([
    "task.agent_run.requested",
    "task.agent_run.started",
    "task.agent_run.provider_started",
    "task.agent_run.completed",
    "task.moved",
    "task.agent_run.failed"
  ])("does not expose a Task Agent lifecycle mutation before the %s audit commits", async (event) => {
    const { Store, allowAudit, waitForFailure } = createAuditFailureStore(event);
    const seed = createSeedSnapshot();
    const connector = {
      id: "c1000000-0000-4000-8000-000000000091",
      revision: 1,
      name: "Task audit local runtime",
      location: "local" as const,
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "task-audit-model",
      enabled: true,
      hasSecret: false,
      secretRevision: 0,
      credentialId: null
    };
    seed.modelConnectors.push(connector);
    seed.agents[0]!.modelConnectorId = connector.id;
    const store = new Store(seed);
    const initial = await store.getSnapshot();
    const agent = initial.agents[0]!;
    const decision = await store.createDecision({
      meetingId: initial.meetings[0]!.id,
      title: `Task Agent audit fixture ${event}`,
      description: "Agent lifecycle state must remain private until audit commit."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({
      decisionId: decision.id,
      title: decision.title,
      assigneeAgentId: agent.id,
      acceptanceCriteria: "Return bounded text evidence.",
      executionProfile: "worker"
    });
    const approved = await store.setTaskApproval(task.id, {
      expectedExecutionRevision: task.execution.revision,
      action: "approve"
    });
    const current = await store.getSnapshot();
    const runtimeBinding = taskRuntimeBinding(current, agent.id);
    const jobId = `task-agent-audit-${event}`;
    const job: TaskAgentRunJobData = {
      taskId: task.id,
      agentId: agent.id,
      executionProfile: "worker",
      executionRevision: approved.execution.revision + 1,
      taskFingerprint: taskExecutionFingerprint(approved),
      requestFingerprint: `request-${event}`,
      modelConnectorBinding: {
        id: connector.id,
        location: connector.location,
        baseUrl: connector.baseUrl,
        model: connector.model,
        secretRevision: connector.secretRevision
      },
      promptBinding: null,
      ...runtimeBinding,
      runtimeRun: taskRuntimeRun(jobId, task, approved.execution.attemptCount + 1, agent.id, runtimeBinding),
      skillDigests: Object.fromEntries(current.skills
        .filter((skill) => agent.skillIds.includes(skill.id))
        .map((skill) => [skill.id, skill.contentDigest])),
      requestedBy: "owner"
    };

    if (event !== "task.agent_run.requested") await store.markTaskAgentRunQueued(jobId, job);
    if (event === "task.agent_run.provider_started" || event === "task.agent_run.completed" || event === "task.moved" || event === "task.agent_run.failed") {
      await store.markTaskAgentRunRunning(jobId, job);
    }
    if (event === "task.agent_run.completed" || event === "task.moved") {
      await store.claimTaskAgentProviderAttempt(jobId, job);
    }
    const before = (await store.getSnapshot()).tasks;
    const mutation = event === "task.agent_run.requested"
      ? store.markTaskAgentRunQueued(jobId, job)
      : event === "task.agent_run.started"
        ? store.markTaskAgentRunRunning(jobId, job)
        : event === "task.agent_run.provider_started"
          ? store.claimTaskAgentProviderAttempt(jobId, job)
        : event === "task.agent_run.completed" || event === "task.moved"
          ? store.completeTaskAgentRun(jobId, job, "Audited bounded result.")
          : store.failTaskAgentRun({
            taskId: task.id,
            jobId,
            executionRevision: job.executionRevision,
            requestFingerprint: job.requestFingerprint,
            agentId: job.agentId,
            executionProfile: job.executionProfile
          }, "provider_unavailable");

    await waitForFailure;
    expect((await store.getSnapshot()).tasks).toEqual(before);
    await allowAudit();
    await expect(mutation).rejects.toThrow(/audit unavailable/i);
    expect((await store.getSnapshot()).tasks).toEqual(before);
  });

  it.each([
    "task.sync.requested",
    "task.sync.succeeded",
    "task.sync.failed"
  ])("does not expose a Task Sync lifecycle mutation before the %s audit commits", async (event) => {
    const { Store, allowAudit, waitForFailure } = createAuditFailureStore(event);
    const store = new Store();
    const initial = await store.getSnapshot();
    const decision = await store.createDecision({
      meetingId: initial.meetings[0]!.id,
      title: `Task Sync audit fixture ${event}`,
      description: "Sync lifecycle state must remain private until audit commit."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({ decisionId: decision.id, title: decision.title });
    const adapter = await store.createTaskAdapterConnector({
      name: `Task audit adapter ${event}`,
      location: "local",
      baseUrl: "http://task-adapter-reference:4200"
    });
    const jobId = `task-sync-audit-${event}`;
    if (event !== "task.sync.requested") {
      await store.markTaskSyncPending(task.id, jobId, taskSyncAdmissionInput(task, adapter.id));
    }
    const queued = (await store.getSnapshot()).tasks.find((item) => item.id === task.id)!;
    const before = (await store.getSnapshot()).tasks;
    const mutation = event === "task.sync.requested"
      ? store.markTaskSyncPending(task.id, jobId, taskSyncAdmissionInput(task, adapter.id))
      : event === "task.sync.succeeded"
        ? store.completeTaskSync(task.id, jobId, "EXT-audit", queued.sync.requestFingerprint!)
        : store.failTaskSync({
          taskId: task.id,
          adapterId: adapter.id,
          jobId,
          requestFingerprint: queued.sync.requestFingerprint!
        }, "provider_unavailable");

    await waitForFailure;
    expect((await store.getSnapshot()).tasks).toEqual(before);
    await allowAudit();
    await expect(mutation).rejects.toThrow(/audit unavailable/i);
    expect((await store.getSnapshot()).tasks).toEqual(before);
  });

  it("preserves unrelated Task/Decision writes when setMeetingAgenda audit fails", async () => {
    const { Store, allowAudit, waitForFailure } = createAuditFailureStore("meeting.agenda.updated");
    const store = new Store();
    const seed = await store.getSnapshot();
    const thread = await store.createThread({
      categoryId: seed.categories[0]!.id,
      title: "Audit gate agenda test",
      summary: "Keep independent meeting agenda mutation stable",
      tagIds: []
    });
    const meeting = await store.createMeeting({
      threadId: thread.id,
      title: "Agenda Audit Gate Meeting",
      goal: "Validate agenda rollback",
      mode: "open",
      durationMinutes: 20,
      participants: [{ agentId: seed.agents[0]!.id, roleId: seed.roles[0]!.id, isChair: true }],
      agendaItems: [
        { title: "Agenda anchor", description: "for rollback" },
        { title: "Backup agenda", description: "for uniqueness" }
      ]
    });
    const approvedDecision = await store.createDecision({
      meetingId: meeting.id,
      title: "Approved decision for concurrent task",
      description: "Keep its task stable while Meeting agenda changes fail."
    });
    await store.setDecisionStatus(approvedDecision.id, "approved");
    const stableTask = await store.createTask({
      decisionId: approvedDecision.id,
      title: "Stable task",
      description: "Task changes must survive Meeting rollback."
    });
    const concurrentDecision = await store.createDecision({
      meetingId: meeting.id,
      title: "Concurrent decision",
      description: "Status should still be updated even if Meeting audit fails."
    });
    const expectedAgenda = structuredClone(meeting.agenda);

    const meetingMutation = store.setMeetingAgenda(meeting.id, {
      expectedRevision: expectedAgenda.revision,
      items: meeting.agenda.items.map((item, index) => {
        return {
          id: item.id,
          title: index === 0 ? "Updated in failed mutation" : item.title,
          description: item.description
        };
      })
    });
    const taskMutation = waitForFailure.then(() => store.updateTask(stableTask.id, {
      expectedRevision: stableTask.revision,
      expectedExecutionRevision: stableTask.execution.revision,
      description: "Concurrent task edit"
    }));
    const decisionMutation = waitForFailure.then(() => store.setDecisionStatus(concurrentDecision.id, "approved"));

    await waitForFailure;
    await allowAudit();
    const [meetingResult, taskResult, decisionResult] = await Promise.allSettled([meetingMutation, taskMutation, decisionMutation]);
    expect(meetingResult).toMatchObject({ status: "rejected" });
    expect(taskResult).toMatchObject({ status: "fulfilled" });
    expect(decisionResult).toMatchObject({ status: "fulfilled" });

    const current = await store.getSnapshot();
    expect(current.meetings.find((item) => item.id === meeting.id)?.agenda).toEqual(expectedAgenda);
    expect(current.tasks.find((item) => item.id === stableTask.id)).toMatchObject({
      description: "Concurrent task edit"
    });
    expect(current.decisions.find((item) => item.id === concurrentDecision.id)).toMatchObject({
      status: "approved"
    });
  });

  it("preserves unrelated Task/Decision writes when advanceMeetingAgenda audit fails", async () => {
    const { Store, allowAudit, waitForFailure } = createAuditFailureStore("meeting.agenda.advanced", 2);
    const store = new Store();
    const seed = await store.getSnapshot();
    const thread = await store.createThread({
      categoryId: seed.categories[0]!.id,
      title: "Audit gate advance test",
      summary: "Keep independent meeting advancement rollback",
      tagIds: []
    });
    const meeting = await store.createMeeting({
      threadId: thread.id,
      title: "Advance Audit Gate Meeting",
      goal: "Validate advance rollback",
      mode: "open",
      durationMinutes: 20,
      participants: [{ agentId: seed.agents[0]!.id, roleId: seed.roles[0]!.id, isChair: true }],
      agendaItems: [
        { title: "Agenda anchor", description: "for rollback" },
        { title: "Backup agenda", description: "fallback" }
      ]
    });
    const approvedDecision = await store.createDecision({
      meetingId: meeting.id,
      title: "Approved decision for concurrent task",
      description: "Keep its task stable while Meeting agenda advances fail."
    });
    await store.setDecisionStatus(approvedDecision.id, "approved");
    const stableTask = await store.createTask({
      decisionId: approvedDecision.id,
      title: "Stable task",
      description: "Task changes must survive Meeting rollback."
    });
    const concurrentDecision = await store.createDecision({
      meetingId: meeting.id,
      title: "Concurrent decision",
      description: "Status should still be updated even if Meeting audit fails."
    });

    const activeMeeting = await store.setMeetingState(meeting.id, "active");
    const expectedAgenda = structuredClone(activeMeeting.agenda);
    const current = activeMeeting.agenda.items.find((item) => item.status === "current");
    if (!current) throw new Error("Expected an active agenda item before advancing.");

    const meetingMutation = store.advanceMeetingAgenda(activeMeeting.id, {
      expectedRevision: expectedAgenda.revision,
      action: "complete",
      itemId: current.id
    });
    const taskMutation = waitForFailure.then(() => store.updateTask(stableTask.id, {
      expectedRevision: stableTask.revision,
      expectedExecutionRevision: stableTask.execution.revision,
      title: "Concurrent task rebase"
    }));
    const decisionMutation = waitForFailure.then(() => store.setDecisionStatus(concurrentDecision.id, "approved"));

    await waitForFailure;
    await allowAudit();
    const [meetingResult, taskResult, decisionResult] = await Promise.allSettled([meetingMutation, taskMutation, decisionMutation]);
    expect(meetingResult).toMatchObject({ status: "rejected" });
    expect(taskResult).toMatchObject({ status: "fulfilled" });
    expect(decisionResult).toMatchObject({ status: "fulfilled" });

    const currentState = await store.getSnapshot();
    expect(currentState.meetings.find((item) => item.id === activeMeeting.id)?.agenda).toEqual(expectedAgenda);
    expect(currentState.tasks.find((item) => item.id === stableTask.id)).toMatchObject({
      title: "Concurrent task rebase"
    });
    expect(currentState.decisions.find((item) => item.id === concurrentDecision.id)).toMatchObject({
      status: "approved"
    });
  });
});

describe("Task work-item lifecycle", () => {
  it("backfills a legacy Task snapshot idempotently", async () => {
    const legacy = createSeedSnapshot();
    Reflect.deleteProperty(legacy, "taskAdapterConnectors");
    legacy.tasks.push({
      id: "92000000-0000-4000-8000-000000000001",
      meetingId: legacy.meetings[0]!.id,
      decisionId: "92000000-0000-4000-8000-000000000002",
      title: "Legacy Task",
      description: "Created before Task work-item fields existed.",
      status: "todo",
      position: 0,
      assignee: null,
      createdAt: "2026-07-01T00:00:00.000Z"
    } as (typeof legacy.tasks)[number]);

    const migrated = await new InMemoryPlatformStore(legacy).getSnapshot();
    expect(migrated.taskAdapterConnectors).toEqual([]);
    expect(migrated.tasks[0]).toMatchObject({
      revision: 1,
      boardRevision: 1,
      acceptanceCriteria: "",
      evidence: [
        expect.objectContaining({ type: "meeting", reference: legacy.meetings[0]!.id }),
        expect.objectContaining({ type: "decision", reference: "92000000-0000-4000-8000-000000000002" })
      ],
      executionProfile: "manual",
      allowedTools: [],
      approvalState: "not_required",
      execution: expect.objectContaining({
        revision: 0,
        status: "idle",
        jobId: null,
        attemptCount: 0,
        providerStartedAt: null,
        resultEvidenceId: null
      }),
      transitions: [expect.objectContaining({ type: "created", actor: "system" })],
      sync: expect.objectContaining({ status: "not_synced", attemptCount: 0 }),
      updatedAt: "2026-07-01T00:00:00.000Z"
    });

    await expect(new InMemoryPlatformStore(migrated).getSnapshot()).resolves.toEqual(migrated);
  });

  it("persists bounded Task details, provenance Evidence, and append-only transitions", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const decision = await store.createDecision({
      meetingId: snapshot.meetings[0]!.id,
      title: "Complete Task synchronization",
      description: "Keep Council authoritative."
    });
    await store.setDecisionStatus(decision.id, "approved");

    const task = await store.createTask({
      decisionId: decision.id,
      title: decision.title,
      description: decision.description,
      assignee: "Owner",
      assigneeAgentId: null,
      dueAt: "2026-08-01T09:00:00.000Z",
      acceptanceCriteria: "The external ID survives reload.",
      executionProfile: "worker",
      allowedTools: ["task.upsert"],
      dataScope: "Decision summary only",
      approvalState: "pending"
    });

    expect(task).toMatchObject({
      revision: 1,
      boardRevision: 1,
      dueAt: "2026-08-01T09:00:00.000Z",
      acceptanceCriteria: "The external ID survives reload.",
      evidence: [
        expect.objectContaining({ type: "meeting", reference: decision.meetingId }),
        expect.objectContaining({ type: "decision", reference: decision.id })
      ],
      transitions: [expect.objectContaining({ type: "created", actor: "owner" })],
      execution: expect.objectContaining({ revision: 0, status: "idle" }),
      sync: expect.objectContaining({ status: "not_synced", jobId: null })
    });

    const dueAtUpdated = await store.updateTask(task.id, {
      expectedRevision: task.revision,
      expectedExecutionRevision: 0,
      dueAt: "2026-08-02T09:00:00.000Z"
    });
    expect(dueAtUpdated).toMatchObject({ revision: 2, dueAt: "2026-08-02T09:00:00.000Z", execution: { revision: 0 } });
    await expect(store.updateTask(task.id, {
      expectedRevision: task.revision,
      expectedExecutionRevision: 0,
      dueAt: "2026-08-03T09:00:00.000Z"
    })).rejects.toThrow(/revision is stale/i);

    const updated = await store.updateTask(task.id, {
      expectedRevision: dueAtUpdated.revision,
      expectedExecutionRevision: 0,
      acceptanceCriteria: "The external ID and history survive reload."
    });
    expect(updated).toMatchObject({ revision: 3, approvalState: "pending", execution: { revision: 1, status: "idle" } });
    expect(updated.transitions.at(-1)).toMatchObject({ type: "updated", actor: "owner", executionRevision: 1 });

    const approved = await store.setTaskApproval(task.id, { expectedExecutionRevision: 1, action: "approve" });
    expect(approved).toMatchObject({ approvalState: "approved", execution: { revision: 2, status: "idle" } });
    expect(approved.transitions.at(-1)).toMatchObject({
      type: "approval_changed",
      fromApprovalState: "pending",
      toApprovalState: "approved"
    });

    const evidenced = await store.addTaskEvidence(task.id, {
      type: "url",
      label: "Acceptance runbook",
      reference: "https://docs.example.com/acceptance"
    });
    expect(evidenced.evidence.at(-1)).toMatchObject({ type: "url", addedBy: "owner" });
    expect(evidenced.transitions.at(-1)).toMatchObject({ type: "evidence_added" });

    const moved = await store.moveTask(task.id, {
      status: "in_progress",
      position: 0,
      expectedBoardRevision: task.boardRevision,
      expectedExecutionRevision: 2
    });
    expect(moved.boardRevision).toBe(task.boardRevision + 1);
    expect(moved.transitions.at(-1)).toMatchObject({
      type: "moved",
      fromStatus: "todo",
      toStatus: "in_progress"
    });
  });

  it("rejects a stale board move after another Task changes shared ordering", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const createApprovedTask = async (title: string) => {
      const decision = await store.createDecision({
        meetingId: snapshot.meetings[0]!.id,
        title,
        description: `${title} decision`
      });
      await store.setDecisionStatus(decision.id, "approved");
      return store.createTask({ decisionId: decision.id, title, description: "", assignee: null });
    };
    await createApprovedTask("First Task");
    await createApprovedTask("Second Task");
    const before = await store.getSnapshot();
    const first = before.tasks.find((task) => task.title === "First Task")!;
    const second = before.tasks.find((task) => task.title === "Second Task")!;
    expect(first.boardRevision).toBe(second.boardRevision);

    const moved = await store.moveTask(second.id, {
      status: "in_progress",
      position: 0,
      expectedBoardRevision: second.boardRevision,
      expectedExecutionRevision: second.execution.revision
    });
    expect(moved.boardRevision).toBe(second.boardRevision + 1);

    await expect(store.moveTask(first.id, {
      status: "review",
      position: 0,
      expectedBoardRevision: first.boardRevision,
      expectedExecutionRevision: first.execution.revision
    })).rejects.toThrow(/board revision is stale/i);
    expect((await store.getSnapshot()).tasks.find((task) => task.id === first.id)).toMatchObject({
      status: "todo",
      boardRevision: moved.boardRevision
    });
  });

  it("canonicalizes Agent assignment and commits bounded Worker output only to Evidence and Review", async () => {
    const store = new InMemoryPlatformStore();
    const initial = await store.getSnapshot();
    const agent = initial.agents[0]!;
    const connector = await store.createModelConnector({
      name: "Task local",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "task-local"
    });
    const prompt = await store.createPrompt({
      name: "Task execution Prompt",
      kind: "agent",
      description: "Immutable Task execution fixture.",
      owner: "Test Owner",
      content: "Complete the approved Task using the bounded context.",
      variables: []
    });
    await store.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 });
    const configuredAgent = await store.updateAgent(agent.id, {
      modelConnectorId: connector.id,
      promptBinding: { promptId: prompt.id, version: 1 }
    });
    await store.publishAgent(agent.id, { expectedDraftRevision: configuredAgent.draftRevision! });
    const decision = await store.createDecision({
      meetingId: initial.meetings[0]!.id,
      title: "Prepare bounded implementation proposal",
      description: "Return text evidence only."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({
      decisionId: decision.id,
      title: decision.title,
      description: decision.description,
      assignee: "Spoofed display name",
      assigneeAgentId: agent.id,
      acceptanceCriteria: "The text result is concrete and reviewable.",
      executionProfile: "worker"
    });

    expect(task).toMatchObject({
      assignee: agent.name,
      assigneeAgentId: agent.id,
      approvalState: "pending",
      execution: { revision: 0, status: "idle" }
    });

    const approved = await store.setTaskApproval(task.id, { expectedExecutionRevision: 0, action: "approve" });
    const current = await store.getSnapshot();
    const skillDigests = Object.fromEntries(current.skills
      .filter((skill) => agent.skillIds.includes(skill.id))
      .map((skill) => [skill.id, skill.contentDigest]));
    const jobId = "task-agent-job-1";
    const runtimeBinding = taskRuntimeBinding(current, agent.id);
    const job: TaskAgentRunJobData = {
      taskId: task.id,
      agentId: agent.id,
      executionProfile: "worker",
      executionRevision: approved.execution.revision + 1,
      taskFingerprint: taskExecutionFingerprint(approved),
      requestFingerprint: "worker-request-fingerprint",
      modelConnectorBinding: {
        id: connector.id,
        location: connector.location,
        baseUrl: connector.baseUrl,
        model: connector.model,
        secretRevision: connector.secretRevision
      },
      promptBinding: { promptId: prompt.id, version: 1 },
      ...runtimeBinding,
      runtimeRun: taskRuntimeRun(jobId, task, task.execution.attemptCount + 1, agent.id, runtimeBinding),
      skillDigests,
      requestedBy: "owner"
    };

    await store.updateAgent(agent.id, { modelConnectorId: null });
    expect((await store.getSnapshot()).agents.find((item) => item.id === agent.id)).toMatchObject({
      lifecycleStatus: "draft",
      publishedRevision: job.agentRevision,
      modelConnectorId: null
    });

    const queued = await store.markTaskAgentRunQueued(jobId, job);
    expect(queued).toMatchObject({ status: "updated", task: { execution: { status: "queued", revision: job.executionRevision } } });
    await expect(store.updateTask(task.id, {
      expectedRevision: task.revision,
      expectedExecutionRevision: job.executionRevision,
      title: "Changed while running"
    })).rejects.toThrow(/executing/i);
    await expect(store.moveTask(task.id, {
      expectedBoardRevision: task.boardRevision,
      expectedExecutionRevision: job.executionRevision,
      status: "done",
      position: 0
    })).rejects.toThrow(/executing/i);

    await expect(store.markTaskAgentRunRunning(jobId, job)).resolves.toMatchObject({
      status: "updated",
      task: { execution: { status: "running" } }
    });
    await expect(store.completeTaskAgentRun(jobId, job, "Must not commit before provider claim."))
      .resolves.toMatchObject({ status: "stale", task: { execution: { status: "running" } } });
    await expect(store.claimTaskAgentProviderAttempt(jobId, {
      ...job,
      requestFingerprint: "different-provider-request"
    })).resolves.toMatchObject({ status: "stale", task: { execution: { providerStartedAt: null } } });
    const providerClaim = await store.claimTaskAgentProviderAttempt(jobId, job);
    expect(providerClaim).toMatchObject({
      status: "updated",
      task: { execution: { status: "running", providerStartedAt: expect.any(String) } }
    });
    await expect(store.claimTaskAgentProviderAttempt(jobId, job)).resolves.toMatchObject({
      status: "unchanged",
      task: { execution: { providerStartedAt: providerClaim.task.execution.providerStartedAt } }
    });
    const outcomeUnknown = await store.failTaskAgentRun({
      taskId: task.id,
      jobId,
      executionRevision: job.executionRevision,
      requestFingerprint: job.requestFingerprint,
      agentId: job.agentId,
      executionProfile: job.executionProfile
    }, "provider_outcome_unknown");
    expect(outcomeUnknown).toMatchObject({
      status: "updated",
      task: { execution: { status: "failed", lastError: "provider_outcome_unknown" } }
    });
    const completed = await store.completeTaskAgentRun(jobId, job, "Implementation proposal with bounded evidence.", {
      promptTokens: 12,
      completionTokens: 8,
      totalTokens: 20
    });

    expect(completed).toMatchObject({
      status: "updated",
      task: {
        status: "review",
        approvalState: "approved",
        execution: { status: "completed", resultEvidenceId: expect.any(String) },
        evidence: expect.arrayContaining([expect.objectContaining({
          type: "note",
          label: `Agent 執行結果 · ${agent.name}`,
          reference: "Implementation proposal with bounded evidence.",
          addedBy: "system",
          agentId: agent.id,
          jobId,
          executionProfile: "worker"
        })])
      }
    });
    expect(completed.task.transitions.slice(-4).map((item) => item.type)).toEqual([
      "agent_run_started",
      "agent_run_failed",
      "agent_run_completed",
      "moved"
    ]);

    const nextDraft = await store.updateAgent(agent.id, {
      name: "Task Agent next published revision",
      modelConnectorId: connector.id
    });
    await store.publishAgent(agent.id, { expectedDraftRevision: nextDraft.draftRevision! });
    const staleJobId = "task-agent-job-stale-revision";
    const staleJob: TaskAgentRunJobData = {
      ...job,
      executionRevision: completed.task.execution.revision + 1,
      taskFingerprint: taskExecutionFingerprint(completed.task),
      requestFingerprint: "stale-published-revision-request",
      runtimeRun: taskRuntimeRun(
        staleJobId,
        completed.task,
        completed.task.execution.attemptCount + 1,
        agent.id,
        runtimeBinding
      )
    };
    await expect(store.markTaskAgentRunQueued(staleJobId, staleJob))
      .rejects.toThrow(/stale/i);
    expect((await store.getSnapshot()).tasks.find((item) => item.id === task.id)?.execution)
      .toEqual(completed.task.execution);
  });

  it("enforces one Runtime Profile concurrency slot across Task and Meeting admissions", async () => {
    let gateTaskAdmission = false;
    let gateSpeakerAdmission = false;
    let releaseTaskAdmission!: () => void;
    let observeTaskAdmission!: () => void;
    let releaseSpeakerAdmission!: () => void;
    let observeSpeakerAdmission!: () => void;
    const taskAdmissionObserved = new Promise<void>((resolve) => { observeTaskAdmission = resolve; });
    const taskAdmissionGate = new Promise<void>((resolve) => { releaseTaskAdmission = resolve; });
    const speakerAdmissionObserved = new Promise<void>((resolve) => { observeSpeakerAdmission = resolve; });
    const speakerAdmissionGate = new Promise<void>((resolve) => { releaseSpeakerAdmission = resolve; });
    class CapacityStore extends InMemoryPlatformStore {
      override async recordAudit(event: string): Promise<void> {
        if (gateTaskAdmission && event === "task.agent_run.requested") {
          observeTaskAdmission();
          await taskAdmissionGate;
        }
        if (gateSpeakerAdmission && event === "speaker.queue.reserved") {
          observeSpeakerAdmission();
          await speakerAdmissionGate;
          throw new Error("speaker reservation audit unavailable");
        }
      }
    }
    const seed = createSeedSnapshot();
    seed.runtimeProfiles![0]!.maxConcurrency = 1;
    seed.runtimeProfileRevisions![0]!.maxConcurrency = 1;
    const connector = {
      id: "c1000000-0000-4000-8000-000000000001",
      revision: 1,
      name: "Single-slot local runtime",
      location: "local" as const,
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "single-slot-model",
      enabled: true,
      hasSecret: false,
      secretRevision: 0,
      credentialId: null
    };
    seed.modelConnectors.push(connector);
    seed.agents[1]!.modelConnectorId = connector.id;
    const store = new CapacityStore(seed);
    const initial = await store.getSnapshot();
    const meeting = initial.meetings[0]!;
    const agent = initial.agents[1]!;
    const participant = initial.participants.find((item) => (
      item.meetingId === meeting.id && item.agentId === agent.id
    ))!;
    const createApprovedTask = async (title: string) => {
      const decision = await store.createDecision({
        meetingId: meeting.id,
        title,
        description: "Meeting and Task work must not overlap."
      });
      await store.setDecisionStatus(decision.id, "approved");
      const created = await store.createTask({
        decisionId: decision.id,
        title,
        assigneeAgentId: agent.id,
        acceptanceCriteria: "Return bounded text evidence.",
        executionProfile: "worker"
      });
      return store.setTaskApproval(created.id, { expectedExecutionRevision: 0, action: "approve" });
    };
    const firstTask = await createApprovedTask("First single-slot Task");
    const secondTask = await createApprovedTask("Second single-slot Task");
    const snapshot = await store.getSnapshot();
    const runtimeBinding = taskRuntimeBinding(snapshot, agent.id);
    const skillDigests = Object.fromEntries(snapshot.skills
      .filter((skill) => agent.skillIds.includes(skill.id))
      .map((skill) => [skill.id, skill.contentDigest]));
    const modelConnectorBinding = {
      id: connector.id,
      location: connector.location,
      baseUrl: connector.baseUrl,
      model: connector.model,
      secretRevision: connector.secretRevision
    };
    const taskJob = (task: Task, jobId: string): TaskAgentRunJobData => ({
      taskId: task.id,
      agentId: agent.id,
      executionProfile: "worker",
      executionRevision: task.execution.revision + 1,
      taskFingerprint: taskExecutionFingerprint(task),
      requestFingerprint: `${jobId}-request`,
      modelConnectorBinding,
      promptBinding: null,
      ...runtimeBinding,
      runtimeRun: taskRuntimeRun(jobId, task, task.execution.attemptCount + 1, agent.id, runtimeBinding),
      skillDigests,
      requestedBy: "owner"
    });
    const firstTaskJobId = "single-slot-task-1";
    const firstTaskJob = taskJob(firstTask, firstTaskJobId);
    const secondTaskJobId = "single-slot-task-2";
    const secondTaskJob = taskJob(secondTask, secondTaskJobId);
    const speakerJobId = "single-slot-speaker";
    const speakerJob: AgentTurnJobData = {
      meetingId: meeting.id,
      agentId: agent.id,
      ...participantRoleBinding(snapshot, meeting.id, agent.id),
      agendaRevision: meeting.agenda.revision,
      agendaCurrentItemId: meeting.agenda.items.find((item) => item.status === "current")?.id ?? null,
      requestedBy: "owner",
      modelConnectorBinding,
      promptBinding: null,
      ...runtimeBinding,
      runtimeRun: createQueuedRuntimeRun({
        id: randomUUID(),
        kind: "meeting_turn",
        scope: {
          id: `meeting:${meeting.id}:participant:${participant.id}`,
          kind: "meeting_participant",
          subjectId: participant.id,
          parentScopeId: `meeting:${meeting.id}`
        },
        runtimeProfile: runtimeBinding.runtimeProfileSnapshot,
        agentId: agent.id,
        agentRevision: runtimeBinding.agentRevision,
        roleId: participant.roleId,
        roleRevision: participant.roleRevision,
        attempt: 1,
        idempotencyKey: speakerJobId,
        queuedAt: new Date().toISOString(),
        ttlMs: 120_000
      }),
      skillDigests
    };

    await store.markTaskAgentRunQueued(firstTaskJobId, firstTaskJob);
    await expect(store.reserveSpeakerTurn(speakerJobId, speakerJob)).rejects.toThrow(/concurrency limit/i);
    await store.markTaskAgentRunRunning(firstTaskJobId, firstTaskJob);
    await store.failTaskAgentRun({
      taskId: firstTask.id,
      jobId: firstTaskJobId,
      executionRevision: firstTaskJob.executionRevision,
      requestFingerprint: firstTaskJob.requestFingerprint,
      agentId: firstTaskJob.agentId,
      executionProfile: firstTaskJob.executionProfile
    }, "fixture_complete");

    await expect(store.markTaskAgentRunQueued(secondTaskJobId, {
      ...secondTaskJob,
      runtimeRun: { ...secondTaskJob.runtimeRun!, idempotencyKey: "wrong-job" }
    })).rejects.toThrow(/Runtime Run binding is stale/i);
    expect((await store.getSnapshot()).tasks.find((item) => item.id === secondTask.id)?.execution.status).toBe("idle");

    const speakerReservation = await store.reserveSpeakerTurn(speakerJobId, speakerJob);
    expect(speakerReservation).toMatchObject({
      jobId: speakerJobId,
      runtimeProfileBinding: runtimeBinding.runtimeProfileBinding
    });
    await expect(store.reserveSpeakerTurn(speakerJobId, speakerJob)).resolves.toMatchObject({ jobId: speakerJobId });
    await expect(store.markTaskAgentRunQueued(secondTaskJobId, secondTaskJob)).rejects.toThrow(/concurrency limit/i);
    await store.releaseSpeakerTurn(speakerJobId, "fixture_complete", speakerReservation.reservationId!);
    await expect(store.markTaskAgentRunQueued(secondTaskJobId, secondTaskJob)).resolves.toMatchObject({
      status: "updated",
      task: { execution: { status: "queued", runtimeProfileBinding: runtimeBinding.runtimeProfileBinding } }
    });
    await store.markTaskAgentRunRunning(secondTaskJobId, secondTaskJob);
    await store.failTaskAgentRun({
      taskId: secondTask.id,
      jobId: secondTaskJobId,
      executionRevision: secondTaskJob.executionRevision,
      requestFingerprint: secondTaskJob.requestFingerprint,
      agentId: secondTaskJob.agentId,
      executionProfile: secondTaskJob.executionProfile
    }, "fixture_complete");

    const thirdTask = await createApprovedTask("Concurrent admission Task");
    const thirdTaskJobId = "single-slot-task-concurrent";
    const thirdTaskJob = taskJob(thirdTask, thirdTaskJobId);
    const concurrentSpeakerJobId = "single-slot-speaker-concurrent";
    const concurrentSpeakerJob: AgentTurnJobData = {
      ...speakerJob,
      runtimeRun: {
        ...speakerJob.runtimeRun!,
        id: randomUUID(),
        idempotencyKey: concurrentSpeakerJobId
      }
    };
    gateTaskAdmission = true;
    const taskAdmission = store.markTaskAgentRunQueued(thirdTaskJobId, thirdTaskJob);
    await taskAdmissionObserved;
    let speakerSettled = false;
    const speakerAdmission = store.reserveSpeakerTurn(concurrentSpeakerJobId, concurrentSpeakerJob).then(
      (value) => {
        speakerSettled = true;
        return value;
      },
      (error: unknown) => {
        speakerSettled = true;
        throw error;
      }
    );
    await Promise.resolve();
    await Promise.resolve();
    const speakerSettledBeforeTaskCommit = speakerSettled;
    releaseTaskAdmission();
    await expect(taskAdmission).resolves.toMatchObject({ status: "updated" });
    const speakerResult = await Promise.allSettled([speakerAdmission]);

    expect(speakerSettledBeforeTaskCommit).toBe(false);
    expect(speakerResult[0]).toMatchObject({ status: "rejected", reason: expect.objectContaining({
      message: expect.stringMatching(/concurrency limit/i)
    }) });

    await store.failTaskAgentRun({
      taskId: thirdTask.id,
      jobId: thirdTaskJobId,
      executionRevision: thirdTaskJob.executionRevision,
      requestFingerprint: thirdTaskJob.requestFingerprint,
      agentId: thirdTaskJob.agentId,
      executionProfile: thirdTaskJob.executionProfile
    }, "fixture_complete");
    const queueBeforeRejectedAudit = (await store.getSnapshot()).speakerQueue;
    const rejectedSpeakerJobId = "single-slot-speaker-audit-rejected";
    const rejectedSpeakerJob: AgentTurnJobData = {
      ...speakerJob,
      runtimeRun: {
        ...speakerJob.runtimeRun!,
        id: randomUUID(),
        idempotencyKey: rejectedSpeakerJobId
      }
    };
    gateSpeakerAdmission = true;
    const rejectedSpeakerAdmission = store.reserveSpeakerTurn(rejectedSpeakerJobId, rejectedSpeakerJob);
    const rejectedSpeakerExpectation = expect(rejectedSpeakerAdmission)
      .rejects.toThrow("speaker reservation audit unavailable");
    await speakerAdmissionObserved;
    const queueWhileAuditPending = (await store.getSnapshot()).speakerQueue;
    releaseSpeakerAdmission();
    await rejectedSpeakerExpectation;

    expect(queueWhileAuditPending).toEqual(queueBeforeRejectedAudit);
    expect((await store.getSnapshot()).speakerQueue).toEqual(queueBeforeRejectedAudit);
    const fourthTask = await createApprovedTask("Admission after rejected speaker audit");
    const fourthTaskJobId = "single-slot-task-after-speaker-audit-rejection";
    await expect(store.markTaskAgentRunQueued(
      fourthTaskJobId,
      taskJob(fourthTask, fourthTaskJobId)
    )).resolves.toMatchObject({ status: "updated" });
  });

  it("requires acceptance criteria before a Worker Task can be approved", async () => {
    const store = new InMemoryPlatformStore();
    const initial = await store.getSnapshot();
    const decision = await store.createDecision({
      meetingId: initial.meetings[0]!.id,
      title: "Acceptance-gated work",
      description: "Do not approve incomplete execution scope."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({
      decisionId: decision.id,
      title: decision.title,
      assigneeAgentId: initial.agents[0]!.id,
      executionProfile: "worker"
    });

    await expect(store.setTaskApproval(task.id, {
      expectedExecutionRevision: 0,
      action: "approve"
    })).rejects.toThrow(/acceptance criteria/i);
    const scoped = await store.updateTask(task.id, {
      expectedRevision: task.revision,
      expectedExecutionRevision: 0,
      acceptanceCriteria: "Owner can review a bounded text result."
    });
    await expect(store.setTaskApproval(task.id, {
      expectedExecutionRevision: scoped.execution.revision,
      action: "approve"
    })).resolves.toMatchObject({ approvalState: "approved" });
  });

  it("keeps Advisor output in Evidence without changing Task status and records terminal failure for retry", async () => {
    const store = new InMemoryPlatformStore();
    const initial = await store.getSnapshot();
    const agent = initial.agents[2]!;
    const connector = await store.createModelConnector({
      name: "Task local",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "advisor-model"
    });
    const prompt = await store.createPrompt({
      name: "Advisor Task Prompt",
      kind: "agent",
      description: "Immutable Advisor Task fixture.",
      owner: "Test Owner",
      content: "Review the bounded Task and return a proposal.",
      variables: []
    });
    await store.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 });
    const configuredAgent = await store.updateAgent(agent.id, {
      modelConnectorId: connector.id,
      promptBinding: { promptId: prompt.id, version: 1 }
    });
    await store.publishAgent(agent.id, { expectedDraftRevision: configuredAgent.draftRevision! });
    const decision = await store.createDecision({ meetingId: initial.meetings[0]!.id, title: "Review risk", description: "Propose a review." });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({
      decisionId: decision.id,
      title: decision.title,
      assigneeAgentId: agent.id,
      executionProfile: "advisor"
    });
    const jobId = "task-agent-advisor-1";
    const runtimeBinding = taskRuntimeBinding(await store.getSnapshot(), agent.id);
    const job: TaskAgentRunJobData = {
      taskId: task.id,
      agentId: agent.id,
      executionProfile: "advisor",
      executionRevision: 1,
      taskFingerprint: taskExecutionFingerprint(task),
      requestFingerprint: "advisor-request-fingerprint",
      modelConnectorBinding: {
        id: connector.id,
        location: connector.location,
        baseUrl: connector.baseUrl,
        model: connector.model,
        secretRevision: connector.secretRevision
      },
      promptBinding: { promptId: prompt.id, version: 1 },
      ...runtimeBinding,
      runtimeRun: taskRuntimeRun(jobId, task, task.execution.attemptCount + 1, agent.id, runtimeBinding),
      skillDigests: {},
      requestedBy: "owner"
    };

    await store.markTaskAgentRunQueued(jobId, job);
    await store.markTaskAgentRunRunning(jobId, job);
    const running = (await store.getSnapshot()).tasks.find((item) => item.id === task.id)!;
    const staleFailure = await store.failTaskAgentRun({
      taskId: task.id,
      jobId,
      executionRevision: job.executionRevision,
      requestFingerprint: "stale-request-fingerprint",
      agentId: job.agentId,
      executionProfile: job.executionProfile
    }, "stale_execution_binding");
    expect(staleFailure).toMatchObject({ status: "stale", task: { execution: { status: "running" } } });
    expect((await store.getSnapshot()).tasks.find((item) => item.id === task.id)).toEqual(running);
    const failed = await store.failTaskAgentRun({
      taskId: task.id,
      jobId,
      executionRevision: job.executionRevision,
      requestFingerprint: job.requestFingerprint,
      agentId: job.agentId,
      executionProfile: job.executionProfile
    }, "provider_unavailable");
    expect(failed).toMatchObject({ status: "updated", task: { status: "todo", execution: { status: "failed", lastError: "provider_unavailable" } } });
    await expect(store.completeTaskAgentRun(jobId, job, "Late result from an ordinary failure."))
      .resolves.toMatchObject({ status: "stale", task: { execution: { status: "failed", lastError: "provider_unavailable" } } });

    const retryJobId = "task-agent-advisor-2";
    const retryJob = {
      ...job,
      executionRevision: 2,
      taskFingerprint: taskExecutionFingerprint(failed.task),
      requestFingerprint: "advisor-retry-fingerprint",
      runtimeRun: taskRuntimeRun(
        retryJobId,
        failed.task,
        failed.task.execution.attemptCount + 1,
        agent.id,
        runtimeBinding
      )
    };
    await store.markTaskAgentRunQueued(retryJobId, retryJob);
    await store.markTaskAgentRunRunning(retryJobId, retryJob);
    await store.claimTaskAgentProviderAttempt(retryJobId, retryJob);
    const completed = await store.completeTaskAgentRun(retryJobId, retryJob, "Risk review proposal.");
    expect(completed).toMatchObject({
      status: "updated",
      task: {
        status: "todo",
        approvalState: "not_required",
        execution: { status: "completed" },
        evidence: expect.arrayContaining([expect.objectContaining({ label: `Agent 提案 · ${agent.name}`, reference: "Risk review proposal." })])
      }
    });
  });

  it("keeps the internal Task authoritative across sync failure, stale completion, and retry", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const decision = await store.createDecision({ meetingId: snapshot.meetings[0]!.id, title: "Sync safely", description: "Never lose internal work." });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({ decisionId: decision.id, title: decision.title, description: decision.description, assignee: null });
    const adapter = await store.createTaskAdapterConnector({
      name: "Reference",
      location: "local",
      baseUrl: "http://task-adapter-reference:4200"
    });

    await store.markTaskSyncPending(task.id, "sync-job-1", taskSyncAdmissionInput(task, adapter.id));
    const firstFingerprint = (await store.getSnapshot()).tasks.find((item) => item.id === task.id)!.sync.requestFingerprint!;
    await expect(store.completeTaskSync(task.id, "stale-job", "EXT-stale", firstFingerprint)).resolves.toMatchObject({ status: "stale" });
    const failed = await store.failTaskSync({
      taskId: task.id,
      adapterId: adapter.id,
      jobId: "sync-job-1",
      requestFingerprint: firstFingerprint
    }, "provider_unavailable");
    expect(failed).toMatchObject({ status: "updated", task: { status: "todo", sync: { status: "failed", lastError: "provider_unavailable" } } });

    await store.markTaskSyncPending(task.id, "sync-job-2", taskSyncAdmissionInput(failed.task, adapter.id));
    const secondFingerprint = (await store.getSnapshot()).tasks.find((item) => item.id === task.id)!.sync.requestFingerprint!;
    const completed = await store.completeTaskSync(task.id, "sync-job-2", "EXT-42", secondFingerprint);
    expect(completed).toMatchObject({ status: "updated", task: { status: "todo", sync: { status: "synced", externalId: "EXT-42" } } });
    expect(completed.task.transitions.slice(-3).map((item) => item.type)).toEqual(["sync_failed", "sync_requested", "sync_succeeded"]);

    const changed = await store.updateTask(task.id, {
      expectedRevision: completed.task.revision,
      expectedExecutionRevision: completed.task.execution.revision,
      description: "The authoritative Task changed after synchronization."
    });
    expect(changed.sync).toMatchObject({ status: "not_synced", jobId: null, externalId: "EXT-42", syncedAt: null });
  });

  it("replays the prior Task synchronization without dispatching a new attempt", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const decision = await store.createDecision({
      meetingId: snapshot.meetings[0]!.id,
      title: "Replay synchronized Task",
      description: "A lost HTTP acknowledgement must not dispatch the external write twice."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({ decisionId: decision.id, title: decision.title });
    const adapter = await store.createTaskAdapterConnector({
      name: "Replay-safe adapter",
      location: "local",
      baseUrl: "http://task-adapter-reference:4200"
    });
    const originalAdmission = {
      ...taskSyncAdmissionInput(task, adapter.id),
      expectedSyncAttemptCount: 0
    };

    const queued = await store.markTaskSyncPending(task.id, "sync-job-original", originalAdmission);
    await store.completeTaskSync(
      task.id,
      "sync-job-original",
      "EXT-replayed",
      queued.task.sync.requestFingerprint!
    );

    const replayed = await store.markTaskSyncPending(task.id, "sync-job-duplicate", originalAdmission);
    expect(replayed).toMatchObject({
      status: "unchanged",
      task: {
        sync: {
          status: "synced",
          jobId: "sync-job-original",
          externalId: "EXT-replayed",
          attemptCount: 1
        }
      }
    });

    const refreshedAdmission = taskSyncAdmissionInput(replayed.task, adapter.id);
    const retried = await store.markTaskSyncPending(task.id, "sync-job-next", refreshedAdmission);
    expect(retried).toMatchObject({
      status: "updated",
      task: { sync: { status: "queued", jobId: "sync-job-next", attemptCount: 2 } }
    });
  });

  it("rejects stale Task sync admission atomically before creating a reservation", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const decision = await store.createDecision({
      meetingId: snapshot.meetings[0]!.id,
      title: "Fence stale sync admission",
      description: "External work must match the reviewed Task."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({ decisionId: decision.id, title: decision.title });
    const adapter = await store.createTaskAdapterConnector({
      name: "Admission fence adapter",
      location: "local",
      baseUrl: "http://task-adapter-reference:4200"
    });
    const staleAdmission = taskSyncAdmissionInput(task, adapter.id);
    await store.updateTask(task.id, {
      expectedRevision: task.revision,
      expectedExecutionRevision: task.execution.revision,
      description: "New authoritative content."
    });

    await expect(store.markTaskSyncPending(task.id, "stale-admission-job", staleAdmission))
      .rejects.toThrow(/revision is stale/i);
    expect((await store.getSnapshot()).tasks.find((item) => item.id === task.id)).toMatchObject({
      description: "New authoritative content.",
      sync: { status: "not_synced", jobId: null, requestFingerprint: null }
    });
  });

  it("fences Task sync by payload state without conflicting on unrelated board changes", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const statusDecision = await store.createDecision({
      meetingId: snapshot.meetings[0]!.id,
      title: "Fence exact adapter status",
      description: "Only payload-affecting changes should reject synchronization."
    });
    const approvalDecision = await store.createDecision({
      meetingId: snapshot.meetings[0]!.id,
      title: "Fence exact adapter approval",
      description: "Approval changes must reject stale synchronization."
    });
    const stableDecision = await store.createDecision({
      meetingId: snapshot.meetings[0]!.id,
      title: "Allow unrelated board changes",
      description: "Unrelated ordering must not reject a stable payload."
    });
    await store.setDecisionStatus(statusDecision.id, "approved");
    await store.setDecisionStatus(approvalDecision.id, "approved");
    await store.setDecisionStatus(stableDecision.id, "approved");
    const statusTask = await store.createTask({ decisionId: statusDecision.id, title: "Status changes" });
    const approvalTask = await store.createTask({
      decisionId: approvalDecision.id,
      title: "Approval changes",
      executionProfile: "worker",
      acceptanceCriteria: "Owner approval is required."
    });
    const stableTask = await store.createTask({ decisionId: stableDecision.id, title: "Payload stays stable" });
    const adapter = await store.createTaskAdapterConnector({
      name: "Exact payload adapter",
      location: "local",
      baseUrl: "http://task-adapter-reference:4200"
    });
    const currentTasks = (await store.getSnapshot()).tasks;
    const currentStatusTask = currentTasks.find((task) => task.id === statusTask.id)!;
    const currentApprovalTask = currentTasks.find((task) => task.id === approvalTask.id)!;
    const currentStableTask = currentTasks.find((task) => task.id === stableTask.id)!;
    const statusAdmission = taskSyncAdmissionInput(currentStatusTask, adapter.id);
    const approvalAdmission = taskSyncAdmissionInput(currentApprovalTask, adapter.id);
    const stableAdmission = taskSyncAdmissionInput(currentStableTask, adapter.id);

    await store.moveTask(statusTask.id, {
      status: "in_progress",
      position: 0,
      expectedBoardRevision: currentStatusTask.boardRevision,
      expectedExecutionRevision: currentStatusTask.execution.revision
    });
    await store.setTaskApproval(approvalTask.id, {
      expectedExecutionRevision: currentApprovalTask.execution.revision,
      action: "approve"
    });

    await expect(store.markTaskSyncPending(statusTask.id, "stale-status-job", statusAdmission))
      .rejects.toThrow(/status changed/i);
    await expect(store.markTaskSyncPending(approvalTask.id, "stale-approval-job", approvalAdmission))
      .rejects.toThrow(/approval state changed/i);
    await expect(store.markTaskSyncPending(stableTask.id, "stable-payload-job", stableAdmission))
      .resolves.toMatchObject({ status: "updated", task: { sync: { status: "queued" } } });
  });

  it("does not let a stale Task Sync payload fail the current queued payload", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const decision = await store.createDecision({
      meetingId: snapshot.meetings[0]!.id,
      title: "Fence stale sync failure",
      description: "Only the payload that actually failed may settle the synchronization state."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({ decisionId: decision.id, title: decision.title });
    const adapter = await store.createTaskAdapterConnector({
      name: "Stale failure fence adapter",
      location: "local",
      baseUrl: "http://task-adapter-reference:4200"
    });
    const jobId = "sync-stale-failure-fence";
    const queued = await store.markTaskSyncPending(task.id, jobId, taskSyncAdmissionInput(task, adapter.id));
    const firstFingerprint = queued.task.sync.requestFingerprint!;
    const updated = await store.updateTask(task.id, {
      expectedRevision: task.revision,
      expectedExecutionRevision: task.execution.revision,
      description: "A newer authoritative payload."
    });
    const current = (await store.getSnapshot()).tasks.find((item) => item.id === task.id)!;
    expect(current.sync.requestFingerprint).not.toBe(firstFingerprint);

    const stale = await store.failTaskSync({
      taskId: task.id,
      adapterId: adapter.id,
      jobId,
      requestFingerprint: firstFingerprint
    }, "provider_unavailable");

    expect(stale).toMatchObject({ status: "stale", task: { sync: { status: "queued" } } });
    expect(stale.task.sync.requestFingerprint).toBe(current.sync.requestFingerprint);
    expect((await store.getSnapshot()).tasks.find((item) => item.id === task.id)).toEqual(current);
    expect(updated.sync.requestFingerprint).toBe(current.sync.requestFingerprint);
  });

  it("keeps an Agent assignee label as an assignment-time snapshot across rename and reload", async () => {
    const store = new InMemoryPlatformStore();
    const initial = await store.getSnapshot();
    const agent = initial.agents[0]!;
    const originalName = agent.name;
    const decision = await store.createDecision({
      meetingId: initial.meetings[0]!.id,
      title: "Stable assignee label",
      description: "A renamed Agent must not silently alter a synchronized adapter payload."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({
      decisionId: decision.id,
      title: decision.title,
      assigneeAgentId: agent.id
    });
    const adapter = await store.createTaskAdapterConnector({
      name: "Stable assignee adapter",
      location: "local",
      baseUrl: "http://task-adapter-reference:4200"
    });
    await store.markTaskSyncPending(task.id, "stable-assignee-sync", taskSyncAdmissionInput(task, adapter.id));
    const queued = (await store.getSnapshot()).tasks.find((item) => item.id === task.id)!;
    await store.completeTaskSync(task.id, "stable-assignee-sync", "EXT-stable", taskSyncRequestFingerprint(queued));
    await store.updateAgent(agent.id, { name: "Renamed Agent" }, agent.draftRevision);

    const reloaded = new InMemoryPlatformStore(await store.getSnapshot());
    const reloadedTask = (await reloaded.getSnapshot()).tasks.find((item) => item.id === task.id)!;
    expect(reloadedTask).toMatchObject({
      assignee: originalName,
      assigneeAgentId: agent.id,
      sync: { status: "synced", externalId: "EXT-stable" }
    });
    expect(reloadedTask.sync.requestFingerprint).toBe(taskSyncRequestFingerprint(reloadedTask));
  });
});

describe("role behavior management", () => {
  it("backfills known legacy seed Roles by stable ID and keeps same-name custom Roles least privilege", async () => {
    const seed = createSeedSnapshot();
    const legacyRoles = seed.roles.map(({ usageContext: _usageContext, version: _version, templateKey: _templateKey, toolPolicy: _toolPolicy, dataPolicy: _dataPolicy, deletedAt: _deletedAt, ...role }) => role);
    legacyRoles.push({
      id: "60000000-0000-4000-8000-000000000099",
      name: "會議主席",
      responsibility: "同名但不是內建主席。",
      speakingGuidance: "只處理自訂議題。",
      decisionScope: "不得核准。",
      constraints: "不得取得外部資料。"
    });
    const store = new InMemoryPlatformStore({ ...seed, roles: legacyRoles } as typeof seed);
    const roles = (await store.getSnapshot()).roles;

    expect(roles.find((role) => role.id === "60000000-0000-4000-8000-000000000002")).toMatchObject({
      usageContext: "用於需要控制議程、發言秩序與時間的會議。",
      templateKey: "meeting_chair",
      toolPolicy: "none",
      dataPolicy: "meeting_only"
    });
    expect(roles.find((role) => role.id === "60000000-0000-4000-8000-000000000099")).toMatchObject({
      usageContext: "同名但不是內建主席。",
      templateKey: null,
      toolPolicy: "none",
      dataPolicy: "meeting_only"
    });
  });

  it("normalizes blank legacy Role context and rejects a custom Role with no truthful fallback", async () => {
    const seed = createSeedSnapshot();
    seed.roles[0]!.usageContext = "   ";
    expect((await new InMemoryPlatformStore(seed).getSnapshot()).roles[0]!.usageContext).toBe("用於架構邊界、整合取捨與技術方案評審。");

    const invalid = createSeedSnapshot();
    invalid.roles[0] = { ...invalid.roles[0]!, id: "60000000-0000-4000-8000-000000000098", templateKey: null, usageContext: "", responsibility: " " };
    expect(() => new InMemoryPlatformStore(invalid)).toThrow(/usage context/i);
  });

  it("rejects an effective Role policy that exposes tools without declared Agent data scope", async () => {
    const store = new InMemoryPlatformStore();
    const role = (await store.getSnapshot()).roles[1]!;

    await expect(store.updateRole(role.id, {
      toolPolicy: "agent_read_only_grants",
      dataPolicy: "meeting_only"
    }, role.version)).rejects.toThrow(/declared data scope/i);
  });

  it("persists editable meeting behavior for an existing role", async () => {
    const store = new InMemoryPlatformStore();
    const roleId = (await store.getSnapshot()).roles[0]!.id;

    await expect(store.updateRole(roleId, {
      usageContext: "用於需要界定平台邊界與取捨的會議。",
      speakingGuidance: "先界定邊界，再提出一項可執行建議。",
      decisionScope: "可提出候選決議，不代替擁有者核准。",
      constraints: "沒有證據時必須標示假設。"
    }, 1)).resolves.toMatchObject({
      usageContext: "用於需要界定平台邊界與取捨的會議。",
      speakingGuidance: "先界定邊界，再提出一項可執行建議。",
      decisionScope: "可提出候選決議，不代替擁有者核准。",
      constraints: "沒有證據時必須標示假設。"
    });

    expect((await store.getSnapshot()).roles[0]).toMatchObject({
      usageContext: "用於需要界定平台邊界與取捨的會議。",
      speakingGuidance: "先界定邊界，再提出一項可執行建議。",
      decisionScope: "可提出候選決議，不代替擁有者核准。",
      constraints: "沒有證據時必須標示假設。"
    });
  });

  it("versions effective Role changes and preserves an immutable Role snapshot per Meeting", async () => {
    const store = new InMemoryPlatformStore();
    const initial = await store.getSnapshot();
    const role = initial.roles[0]!;
    const existingAssignment = initial.participants.find((item) => item.roleId === role.id)!;

    expect(role).toMatchObject({ version: 1, templateKey: "platform_architect" });
    expect(existingAssignment.roleSnapshot).toMatchObject({
      roleId: role.id,
      version: 1,
      responsibility: role.responsibility
    });

    const updated = await store.updateRole(role.id, {
      usageContext: "用於新版平台架構與整合評審。",
      responsibility: "以新版邊界評估平台架構。",
      toolPolicy: "none",
      dataPolicy: "meeting_only"
    }, 1);
    expect(updated).toMatchObject({ version: 2, usageContext: "用於新版平台架構與整合評審。", responsibility: "以新版邊界評估平台架構。" });
    await expect(store.updateRole(role.id, {
      responsibility: "以新版邊界評估平台架構。"
    }, 2)).resolves.toMatchObject({ version: 2 });

    const afterUpdate = await store.getSnapshot();
    expect(afterUpdate.participants.find((item) => item.id === existingAssignment.id)?.roleSnapshot).toEqual(existingAssignment.roleSnapshot);

    const thread = await store.createThread({
      categoryId: initial.categories[0]!.id,
      title: "Role v2 驗收",
      summary: "確認新會議使用新版角色。",
      tagIds: []
    });
    const meeting = await store.createMeeting({
      threadId: thread.id,
      title: "新版角色會議",
      goal: "確認角色版本",
      mode: "fixed",
      durationMinutes: 20,
      participants: [{ agentId: initial.agents[0]!.id, roleId: role.id, isChair: true }],
      agendaItems: [{ title: "確認角色版本", description: "" }]
    });
    expect((await store.getSnapshot()).participants.find((item) => item.meetingId === meeting.id)?.roleSnapshot).toMatchObject({
      roleId: role.id,
      version: 2,
      usageContext: "用於新版平台架構與整合評審。",
      responsibility: "以新版邊界評估平台架構。",
      toolPolicy: "none",
      dataPolicy: "meeting_only"
    });
  });

  it("keeps append-only Role history across create, effective update, no-op, and rollback", async () => {
    const store = new InMemoryPlatformStore();
    const role = await store.createRole({
      name: "研究主持",
      usageContext: "用於研究問題與證據收斂。",
      responsibility: "收斂研究證據。",
      speakingGuidance: "先說明來源，再提出問題。",
      decisionScope: "可整理候選決議，不可核准。",
      constraints: "不得把推論當成事實。",
      templateKey: null,
      toolPolicy: "none",
      dataPolicy: "meeting_only"
    });

    expect(await store.getRoleVersions(role.id)).toEqual([
      expect.objectContaining({ roleId: role.id, version: 1, source: "created", restoredFromVersion: null })
    ]);

    await store.updateRole(role.id, { usageContext: "用於研究評審與缺口盤點。", responsibility: "收斂研究證據並指出缺口。" }, 1);
    await store.updateRole(role.id, { usageContext: "用於研究評審與缺口盤點。", responsibility: "收斂研究證據並指出缺口。" }, 2);
    expect((await store.getRoleVersions(role.id)).map((version) => [version.version, version.source])).toEqual([
      [2, "updated"],
      [1, "created"]
    ]);

    const restored = await store.rollbackRole(role.id, 1, 2);
    expect(restored).toMatchObject({
      version: 3,
      usageContext: "用於研究問題與證據收斂。",
      responsibility: "收斂研究證據。"
    });
    expect(await store.getRoleVersions(role.id)).toEqual([
      expect.objectContaining({ version: 3, source: "rollback", restoredFromVersion: 1 }),
      expect.objectContaining({ version: 2, source: "updated", restoredFromVersion: null }),
      expect.objectContaining({ version: 1, source: "created", restoredFromVersion: null })
    ]);
    await expect(store.rollbackRole(role.id, 3, 3)).rejects.toThrow(/current version/i);
    await expect(store.rollbackRole(role.id, 99, 3)).rejects.toThrow(/version/i);
    await expect(store.rollbackRole(role.id, 1, 2)).rejects.toMatchObject({
      kind: "revision",
      message: expect.stringMatching(/version changed/i)
    });
  });

  it("blocks Role deletion for unfinished Meetings and preserves closed Meeting evidence", async () => {
    const store = new InMemoryPlatformStore();
    const before = await store.getSnapshot();
    const meeting = before.meetings[0]!;
    const assignment = before.participants[0]!;
    const role = before.roles.find((item) => item.id === assignment.roleId)!;

    await expect(store.deleteRole(role.id, role.version)).rejects.toThrow(/unfinished Meeting/i);
    await store.setMeetingState(meeting.id, "closed");
    await expect(store.deleteRole(role.id, role.version)).resolves.toEqual({
      id: role.id,
      historicalMeetingCount: 1
    });

    const after = await store.getSnapshot();
    expect(after.roles.find((item) => item.id === role.id)?.deletedAt).toEqual(expect.any(String));
    expect(after.participants.find((item) => item.id === assignment.id)?.roleSnapshot).toEqual(assignment.roleSnapshot);
    expect(await store.getRoleVersions(role.id)).toEqual([
      expect.objectContaining({ roleId: role.id, version: role.version })
    ]);
    await expect(store.createMeeting({
      threadId: before.threads[0]!.id,
      title: "不得使用已刪除角色",
      goal: "驗證 tombstone",
      mode: "fixed",
      durationMinutes: 20,
      participants: [{ agentId: before.agents[0]!.id, roleId: role.id, isChair: true }],
      agendaItems: [{ title: "確認角色刪除限制", description: "" }]
    })).rejects.toThrow(/deleted Role/i);
  });

  it("blocks Role deletion while an active Agent Team still references it", async () => {
    const store = new InMemoryPlatformStore();
    const before = await store.getSnapshot();
    const role = before.roles[0]!;
    const connector = await store.createModelConnector({
      name: "Role reference Team model",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "meeting-local"
    });
    const prompt = await store.createPrompt({
      name: "Role reference Team Prompt",
      kind: "agent",
      description: "Published fixture for Team readiness.",
      owner: "Test Owner",
      content: "Participate only within the assigned Role and Meeting scope.",
      variables: []
    });
    await store.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 });
    for (const agent of before.agents.slice(0, 2)) {
      const draft = await store.updateAgent(agent.id, {
        modelConnectorId: connector.id,
        promptBinding: { promptId: prompt.id, version: 1 }
      });
      await store.publishAgent(agent.id, { expectedDraftRevision: draft.draftRevision! });
    }
    const team = await store.createAgentTeam({
      name: "Role reference guard",
      description: "Keep active Team role references valid.",
      members: [
        { agentId: before.agents[0]!.id, roleId: role.id, isChair: true },
        { agentId: before.agents[1]!.id, roleId: before.roles[1]!.id, isChair: false }
      ]
    });
    await store.setMeetingState(before.meetings[0]!.id, "closed");

    await expect(store.getRoleLifecycle(role.id)).resolves.toMatchObject({
      canDelete: false,
      activeTeamCount: 1,
      unfinishedMeetingCount: 0
    });
    await expect(store.deleteRole(role.id, role.version)).rejects.toThrow(/active Agent Team/i);

    await store.updateAgentTeam(team.id, { expectedRevision: team.revision, status: "archived" });
    await expect(store.getRoleLifecycle(role.id)).resolves.toMatchObject({ canDelete: true, activeTeamCount: 0 });
    await expect(store.deleteRole(role.id, role.version)).resolves.toMatchObject({ id: role.id });
  });
});

describe("platform state invariants", () => {
  it("prevents a closed meeting from changing mode in the store", async () => {
    const store = new InMemoryPlatformStore();
    const meetingId = (await store.getSnapshot()).meetings[0]!.id;
    await store.setMeetingState(meetingId, "closed");

    await expect(store.setMeetingMode(meetingId, { mode: "open", reason: "too late" })).rejects.toThrow(/closed/i);
  });

  it("rejects orphan threads and meetings with invalid participant structure", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const missingId = "ffffffff-ffff-4fff-8fff-ffffffffffff";

    await expect(store.createThread({
      categoryId: missingId,
      title: "Orphan",
      summary: "",
      tagIds: []
    })).rejects.toThrow(/category/i);

    await expect(store.createMeeting({
      threadId: missingId,
      title: "Orphan meeting",
      goal: "Must fail",
      mode: "fixed",
      durationMinutes: 30,
      participants: [{ agentId: snapshot.agents[0]!.id, roleId: snapshot.roles[0]!.id, isChair: true }],
      agendaItems: [{ title: "確認孤兒防線", description: "" }]
    })).rejects.toThrow(/Topic/i);

    await expect(store.createMeeting({
      threadId: snapshot.threads[0]!.id,
      title: "Duplicate Agent",
      goal: "Must fail",
      mode: "fixed",
      durationMinutes: 30,
      participants: [
        { agentId: snapshot.agents[0]!.id, roleId: snapshot.roles[0]!.id, isChair: true },
        { agentId: snapshot.agents[0]!.id, roleId: snapshot.roles[1]!.id, isChair: false }
      ],
      agendaItems: [{ title: "確認重複 Agent", description: "" }]
    })).rejects.toThrow(/Agent.*once|duplicate/i);
  });

  it("replays Decision creation and keeps a finalized Decision terminal", async () => {
    const store = new InMemoryPlatformStore();
    const meetingId = (await store.getSnapshot()).meetings[0]!.id;
    const input = { meetingId, title: "Terminal decision", description: "Finalize exactly once." };

    const [created, replay] = await Promise.all([
      store.createDecision(input, "decision-create-key"),
      store.createDecision(input, "decision-create-key")
    ]);
    const approved = await store.setDecisionStatus(created.id, "approved");
    const approvedReplay = await store.setDecisionStatus(created.id, "approved");

    expect(replay.id).toBe(created.id);
    expect((await store.getSnapshot()).decisions.filter((decision) => decision.id === created.id)).toHaveLength(1);
    expect(approvedReplay).toEqual(approved);
    await expect(store.setDecisionStatus(created.id, "rejected")).rejects.toThrow(/final|proposed|revocation/i);
  });

  it("creates at most one task for each approved decision", async () => {
    const store = new InMemoryPlatformStore();
    const meetingId = (await store.getSnapshot()).meetings[0]!.id;
    const decision = await store.createDecision({ meetingId, title: "One task", description: "Exactly one task." });
    await store.setDecisionStatus(decision.id, "approved");

    await store.createTask({ decisionId: decision.id, title: decision.title, description: decision.description, assignee: null });
    await expect(store.createTask({
      decisionId: decision.id,
      title: decision.title,
      description: decision.description,
      assignee: null
    })).rejects.toThrow(/already.*task|one task/i);
  });

  it("coalesces concurrent Task creation with the same idempotency key", async () => {
    const store = new InMemoryPlatformStore();
    const meetingId = (await store.getSnapshot()).meetings[0]!.id;
    const decision = await store.createDecision({ meetingId, title: "One replayed task", description: "Create once." });
    await store.setDecisionStatus(decision.id, "approved");
    const input = { decisionId: decision.id, title: decision.title, description: decision.description, assignee: null };

    const [first, replay] = await Promise.all([
      store.createTask(input, "task-create-key"),
      store.createTask(input, "task-create-key")
    ]);

    expect(replay.id).toBe(first.id);
    expect((await store.getSnapshot()).tasks.filter((task) => task.decisionId === decision.id)).toHaveLength(1);
  });

  it("scopes in-memory idempotency keys by operation", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const key = "shared-key";
    const thread = await store.createThread({
      categoryId: snapshot.categories[0]!.id,
      title: "Thread",
      summary: "",
      tagIds: []
    }, key);

    const meeting = await store.createMeeting({
      threadId: thread.id,
      title: "Meeting",
      goal: "Keep operation namespaces separate",
      mode: "chaired",
      durationMinutes: 30,
      participants: [{ agentId: snapshot.agents[0]!.id, roleId: snapshot.roles[0]!.id, isChair: true }],
      agendaItems: [{ title: "確認冪等命名空間", description: "" }]
    }, key);

    expect(meeting).toMatchObject({ title: "Meeting", goal: "Keep operation namespaces separate" });
  });
});

describe("speaker queue leases", () => {
  it("renews a running turn with the running lease duration", async () => {
    const seed = createSeedSnapshot();
    const jobId = "running-speaker-lease";
    seed.speakerQueue = [speakerQueueFixture(seed, jobId)];
    const store = new InMemoryPlatformStore(seed);

    await expect(store.markSpeakerTurnRunning(jobId)).resolves.toMatchObject({ status: "running" });
    await expect(store.renewSpeakerTurnLease(jobId, "2026-08-12T00:01:00.000Z")).resolves.toMatchObject({
      status: "running",
      leaseExpiresAt: "2026-08-12T00:31:00.000Z"
    });
  });
});

describe("speaker queue audit atomicity", () => {
  it.each([
    {
      event: "speaker.queue.started",
      jobId: "speaker-audit-start",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      mutate: (store: InMemoryPlatformStore, jobId: string) => store.markSpeakerTurnRunning(jobId)
    },
    {
      event: "speaker.queue.released",
      jobId: "speaker-audit-release",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      mutate: (store: InMemoryPlatformStore, jobId: string) => store.releaseSpeakerTurn(jobId, "test_release")
    },
    {
      event: "speaker.queue.released",
      jobId: "speaker-audit-expire",
      leaseExpiresAt: "2026-08-12T00:00:30.000Z",
      mutate: (store: InMemoryPlatformStore) => store.releaseExpiredSpeakerTurns("2026-08-12T00:01:00.000Z")
    }
  ])("does not expose $jobId before its required audit commits", async ({ event, jobId, leaseExpiresAt, mutate }) => {
    const seed = createSeedSnapshot();
    seed.speakerQueue = [speakerQueueFixture(seed, jobId, leaseExpiresAt)];
    const { Store, auditEntered, releaseAudit } = createGatedAuditFailureStore(event);
    const store = new Store(seed);
    const before = (await store.getSnapshot()).speakerQueue;

    const mutation = mutate(store, jobId);
    await auditEntered;
    expect((await store.getSnapshot()).speakerQueue).toEqual(before);
    releaseAudit();
    await expect(mutation).rejects.toThrow(/audit unavailable/i);
    expect((await store.getSnapshot()).speakerQueue).toEqual(before);
  });

  it("keeps a linked Chair action and expired reservation together when a later audit fails", async () => {
    const base = new InMemoryPlatformStore();
    const seed = await base.getSnapshot();
    const participant = seed.participants.find((item) => item.meetingId === seed.meetings[0]!.id)!;
    const created = await base.createChairSuggestion(seed.meetings[0]!.id, seed.utterances.at(-1)!.id, {
      reason: "off_topic",
      suggestedMode: "chaired",
      explanation: "Return to the current agenda.",
      score: 0.9,
      suggestedAgentId: participant.agentId,
      suggestedAgentName: "Chair"
    });
    const jobId = "speaker-audit-linked-expire";
    await base.setChairSuggestionPending(created.suggestion.id, participant.agentId, jobId);
    const prepared = await base.getSnapshot();
    prepared.speakerQueue = [{
      ...speakerQueueFixture(prepared, jobId, "2026-08-12T00:00:30.000Z"),
      chairSuggestionId: created.suggestion.id
    }];
    const { Store, auditEntered, releaseAudit } = createGatedAuditFailureStore("speaker.queue.released");
    const store = new Store(prepared);
    const before = await store.getSnapshot();

    const mutation = store.releaseExpiredSpeakerTurns("2026-08-12T00:01:00.000Z");
    await auditEntered;
    await expect(store.getSnapshot()).resolves.toMatchObject({
      speakerQueue: before.speakerQueue,
      chairSuggestions: before.chairSuggestions
    });
    releaseAudit();
    await expect(mutation).rejects.toThrow(/audit unavailable/i);
    await expect(store.getSnapshot()).resolves.toMatchObject({
      speakerQueue: before.speakerQueue,
      chairSuggestions: before.chairSuggestions
    });
  });
});

describe("chair suggestion persistence", () => {
  const proposal = {
    reason: "off_topic" as const,
    suggestedMode: "chaired" as const,
    explanation: "請主席把討論帶回會議目標。",
    score: 0.82,
    suggestedAgentId: "50000000-0000-4000-8000-000000000002",
    suggestedAgentName: "Chair-Local"
  };

  it("does not supersede or publish a Chair suggestion before its creation audit commits", async () => {
    const base = new InMemoryPlatformStore();
    const seed = await base.getSnapshot();
    const meetingId = seed.meetings[0]!.id;
    await base.createChairSuggestion(meetingId, seed.utterances.at(-1)!.id, proposal);
    const newerSource = await base.addUtterance(meetingId, {
      speakerType: "human",
      speakerName: "Owner",
      roleName: "Owner",
      content: "A newer source for an atomic Chair suggestion.",
      kind: "human",
      evidenceCount: 0
    });
    const { Store, auditEntered, releaseAudit } = createGatedAuditFailureStore("chair.suggestion.created");
    const store = new Store(await base.getSnapshot());
    const before = (await store.getSnapshot()).chairSuggestions;

    const mutation = store.createChairSuggestion(meetingId, newerSource.id, proposal);
    await auditEntered;
    expect((await store.getSnapshot()).chairSuggestions).toEqual(before);
    releaseAudit();
    await expect(mutation).rejects.toThrow(/audit unavailable/i);
    expect((await store.getSnapshot()).chairSuggestions).toEqual(before);
  });

  it("does not expose a pending Chair action before its request audit commits", async () => {
    const base = new InMemoryPlatformStore();
    const seed = await base.getSnapshot();
    const created = await base.createChairSuggestion(seed.meetings[0]!.id, seed.utterances.at(-1)!.id, proposal);
    const { Store, auditEntered, releaseAudit } = createGatedAuditFailureStore("chair.suggestion.agent.requested");
    const store = new Store(await base.getSnapshot());
    const before = (await store.getSnapshot()).chairSuggestions;

    const mutation = store.setChairSuggestionPending(created.suggestion.id, proposal.suggestedAgentId, "chair-audit-pending");
    await auditEntered;
    expect((await store.getSnapshot()).chairSuggestions).toEqual(before);
    releaseAudit();
    await expect(mutation).rejects.toThrow(/audit unavailable/i);
    expect((await store.getSnapshot()).chairSuggestions).toEqual(before);
  });

  it("does not reopen a pending Chair action before its release audit commits", async () => {
    const base = new InMemoryPlatformStore();
    const seed = await base.getSnapshot();
    const created = await base.createChairSuggestion(seed.meetings[0]!.id, seed.utterances.at(-1)!.id, proposal);
    await base.setChairSuggestionPending(created.suggestion.id, proposal.suggestedAgentId, "chair-audit-release");
    const { Store, auditEntered, releaseAudit } = createGatedAuditFailureStore("chair.suggestion.agent.released");
    const store = new Store(await base.getSnapshot());
    const before = (await store.getSnapshot()).chairSuggestions;

    const mutation = store.releaseChairSuggestion(created.suggestion.id, "chair-audit-release", "test_release");
    await auditEntered;
    expect((await store.getSnapshot()).chairSuggestions).toEqual(before);
    releaseAudit();
    await expect(mutation).rejects.toThrow(/audit unavailable/i);
    expect((await store.getSnapshot()).chairSuggestions).toEqual(before);
  });

  it("does not resolve an open Chair suggestion before its dismissal audit commits", async () => {
    const base = new InMemoryPlatformStore();
    const seed = await base.getSnapshot();
    const created = await base.createChairSuggestion(seed.meetings[0]!.id, seed.utterances.at(-1)!.id, proposal);
    const { Store, auditEntered, releaseAudit } = createGatedAuditFailureStore("chair.suggestion.resolved");
    const store = new Store(await base.getSnapshot());
    const before = (await store.getSnapshot()).chairSuggestions;

    const mutation = store.dismissChairSuggestion(created.suggestion.id, "Owner dismissed this suggestion.");
    await auditEntered;
    expect((await store.getSnapshot()).chairSuggestions).toEqual(before);
    releaseAudit();
    await expect(mutation).rejects.toThrow(/audit unavailable/i);
    expect((await store.getSnapshot()).chairSuggestions).toEqual(before);
  });

  it("backfills suggestion history for a legacy snapshot", async () => {
    const legacy = createSeedSnapshot();
    Reflect.deleteProperty(legacy, "chairSuggestions");

    await expect(new InMemoryPlatformStore(legacy).getSnapshot()).resolves.toMatchObject({ chairSuggestions: [] });
  });

  it("persists one suggestion per source utterance and supersedes an older unresolved suggestion", async () => {
    const seed = createSeedSnapshot();
    const store = new InMemoryPlatformStore(seed);
    const meetingId = seed.meetings[0]!.id;
    const source = seed.utterances.at(-1)!;

    const first = await store.createChairSuggestion(meetingId, source.id, proposal);
    const replay = await store.createChairSuggestion(meetingId, source.id, proposal);
    expect(first).toMatchObject({ status: "created", suggestion: { status: "open", sourceUtteranceId: source.id } });
    expect(replay).toMatchObject({ status: "existing", suggestion: { id: first.suggestion.id } });

    const newerSource = await store.addUtterance(meetingId, {
      speakerType: "human",
      speakerName: "Owner",
      roleName: "決策者",
      content: "再提出一段需要主席收斂的內容。",
      kind: "human",
      evidenceCount: 0
    });
    const second = await store.createChairSuggestion(meetingId, newerSource.id, proposal);
    const snapshot = await store.getSnapshot();

    expect(second).toMatchObject({ status: "created", supersededSuggestionIds: [first.suggestion.id] });
    expect(snapshot.chairSuggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.suggestion.id, status: "resolved", resolution: "superseded" }),
      expect.objectContaining({ id: second.suggestion.id, status: "open", resolution: null })
    ]));
  });

  it("reports whether an idempotent Utterance was created or replayed", async () => {
    const seed = createSeedSnapshot();
    const store = new InMemoryPlatformStore(seed);
    const meetingId = seed.meetings[0]!.id;
    const input = {
      turnId: "human-idempotent-disposition",
      speakerType: "human" as const,
      speakerName: "Owner",
      roleName: "決策者",
      content: "Persist this Human utterance once.",
      kind: "human" as const,
      evidenceCount: 0
    };

    const created = await store.addUtteranceWithDisposition(meetingId, input);
    const replayed = await store.addUtteranceWithDisposition(meetingId, input);

    expect(created).toMatchObject({ status: "created", utterance: { meetingId, turnId: input.turnId } });
    expect(replayed).toMatchObject({ status: "existing", utterance: { id: created.utterance.id } });
    expect((await store.getSnapshot()).utterances).toHaveLength(seed.utterances.length + 1);
  });

  it("rejects a new Utterance after its Meeting is closed", async () => {
    const seed = createSeedSnapshot();
    const store = new InMemoryPlatformStore(seed);
    const meetingId = seed.meetings[0]!.id;
    await store.setMeetingState(meetingId, "closed");

    await expect(store.addUtterance(meetingId, {
      speakerType: "human",
      speakerName: "Owner",
      roleName: "Owner",
      content: "This message arrived after closure.",
      kind: "human",
      evidenceCount: 0
    })).rejects.toThrow("Meeting must be active");

    expect((await store.getSnapshot()).utterances).toHaveLength(seed.utterances.length);
  });

  it("allows only the idempotent system summary after its Meeting is closed", async () => {
    const seed = createSeedSnapshot();
    const store = new InMemoryPlatformStore(seed);
    const meetingId = seed.meetings[0]!.id;
    await store.setMeetingState(meetingId, "closed");

    const summary = await store.addUtterance(meetingId, {
      turnId: `meeting-summary:${meetingId}`,
      speakerType: "system",
      speakerName: "Council",
      roleName: null,
      content: "Closed Meeting summary.",
      kind: "system",
      evidenceCount: 0
    });
    await expect(store.addUtterance(meetingId, {
      turnId: `system-message:${meetingId}`,
      speakerType: "system",
      speakerName: "Council",
      roleName: null,
      content: "Not a Meeting summary.",
      kind: "system",
      evidenceCount: 0
    })).rejects.toThrow("Meeting must be active");

    await expect(store.addUtterance(meetingId, {
      turnId: `meeting-summary:${meetingId}`,
      speakerType: "system",
      speakerName: "Council",
      roleName: null,
      content: "A retry must return the first summary.",
      kind: "system",
      evidenceCount: 0
    })).resolves.toEqual(summary);
  });

  it("keeps a mode-approved suggestion open until the requested chair turn commits", async () => {
    const seed = createSeedSnapshot();
    seed.modelConnectors.push({
      id: "c0000000-0000-4000-8000-000000000001",
      revision: 1,
      name: "Local",
      location: "local",
      baseUrl: "http://127.0.0.1:4000/v1",
      model: "local",
      enabled: true,
      hasSecret: false,
      secretRevision: 0
    });
    seed.agents[1]!.modelConnectorId = seed.modelConnectors[0]!.id;
    const store = new InMemoryPlatformStore(seed);
    const meeting = seed.meetings[0]!;
    const source = seed.utterances.at(-1)!;
    const created = await store.createChairSuggestion(meeting.id, source.id, proposal);

    const modeChange = await store.setMeetingMode(meeting.id, {
      mode: "chaired",
      reason: "Owner accepted the Chair suggestion.",
      chairSuggestionId: created.suggestion.id
    });
    expect(modeChange).toMatchObject({
      meeting: { mode: "chaired" },
      chairSuggestion: { id: created.suggestion.id, status: "open", modeAcceptedAt: expect.any(String) }
    });

    await store.setChairSuggestionPending(created.suggestion.id, proposal.suggestedAgentId, "job-chair");
    const binding = participantRoleBinding(await store.getSnapshot(), meeting.id, proposal.suggestedAgentId);
    const committed = await store.commitAgentTurn({
      ...binding,
      meetingId: meeting.id,
      agentId: proposal.suggestedAgentId,
      turnId: "job-chair",
      agendaRevision: meeting.agenda.revision,
      chairSuggestionId: created.suggestion.id,
      speakerName: "Chair-Local",
      roleName: "會議主席",
      content: "請回到 Meeting Core 的責任邊界。",
      auditDetail: { model: "local" }
    });

    expect(committed).toMatchObject({
      status: "created",
      chairSuggestion: { id: created.suggestion.id, status: "resolved", resolution: "completed" }
    });
    await expect(store.setChairSuggestionPending(created.suggestion.id, proposal.suggestedAgentId, "job-chair")).resolves.toMatchObject({
      status: "unchanged",
      suggestion: { status: "resolved", resolution: "completed" }
    });
    expect((await store.getSnapshot()).chairSuggestions).toContainEqual(expect.objectContaining({
      id: created.suggestion.id,
      status: "resolved",
      requestedAgentJobId: "job-chair",
      resolution: "completed",
      resolvedAt: expect.any(String),
      transitions: expect.arrayContaining([
        expect.objectContaining({ type: "created" }),
        expect.objectContaining({ type: "mode_accepted", actor: "owner" }),
        expect.objectContaining({ type: "agent_requested", jobId: "job-chair" }),
        expect.objectContaining({ type: "completed", jobId: "job-chair" })
      ])
    }));
  });

  it("reopens a failed pending action and preserves a later dismissal in history", async () => {
    const seed = createSeedSnapshot();
    seed.modelConnectors.push({
      id: "c0000000-0000-4000-8000-000000000001",
      revision: 1,
      name: "Local",
      location: "local",
      baseUrl: "http://127.0.0.1:4000/v1",
      model: "local",
      enabled: true,
      hasSecret: false,
      secretRevision: 0
    });
    seed.agents[1]!.modelConnectorId = seed.modelConnectors[0]!.id;
    const store = new InMemoryPlatformStore(seed);
    const created = await store.createChairSuggestion(seed.meetings[0]!.id, seed.utterances.at(-1)!.id, proposal);
    await store.setChairSuggestionPending(created.suggestion.id, proposal.suggestedAgentId, "job-chair");

    await expect(store.releaseChairSuggestion(created.suggestion.id, "job-chair", "stale_turn")).resolves.toMatchObject({
      status: "updated",
      suggestion: { status: "open", requestedAgentJobId: null }
    });
    await expect(store.dismissChairSuggestion(created.suggestion.id, "Owner kept the current meeting direction.")).resolves.toMatchObject({
      status: "updated",
      suggestion: {
        status: "resolved",
        resolution: "dismissed",
        resolutionNote: "Owner kept the current meeting direction.",
        transitions: [
          expect.objectContaining({ type: "created" }),
          expect.objectContaining({ type: "agent_requested", jobId: "job-chair" }),
          expect.objectContaining({ type: "request_released", jobId: "job-chair" }),
          expect.objectContaining({ type: "dismissed", actor: "owner" })
        ]
      }
    });
  });

  it("restores an unresolved suggestion when a Meeting close is rolled back", async () => {
    const seed = createSeedSnapshot();
    const store = new InMemoryPlatformStore(seed);
    const meetingId = seed.meetings[0]!.id;
    const created = await store.createChairSuggestion(meetingId, seed.utterances.at(-1)!.id, proposal);

    await store.setMeetingState(meetingId, "closed");
    expect((await store.getSnapshot()).chairSuggestions).toContainEqual(expect.objectContaining({
      id: created.suggestion.id,
      status: "resolved",
      resolution: "meeting_closed"
    }));

    await store.setMeetingState(meetingId, "active");
    expect((await store.getSnapshot()).chairSuggestions).toContainEqual(expect.objectContaining({
      id: created.suggestion.id,
      status: "open",
      resolution: null,
      resolvedAt: null,
      transitions: expect.arrayContaining([
        expect.objectContaining({ type: "meeting_closed" }),
        expect.objectContaining({ type: "close_reverted" })
      ])
    }));
  });

  it("does not mutate mode or transcript when a suggestion action fails validation", async () => {
    const seed = createSeedSnapshot();
    seed.modelConnectors.push({
      id: "c0000000-0000-4000-8000-000000000001",
      revision: 1,
      name: "Local",
      location: "local",
      baseUrl: "http://127.0.0.1:4000/v1",
      model: "local",
      enabled: true,
      hasSecret: false,
      secretRevision: 0
    });
    seed.agents[1]!.modelConnectorId = seed.modelConnectors[0]!.id;
    const store = new InMemoryPlatformStore(seed);
    const created = await store.createChairSuggestion(seed.meetings[0]!.id, seed.utterances.at(-1)!.id, proposal);

    await expect(store.setMeetingMode(seed.meetings[0]!.id, {
      mode: "fixed",
      reason: "Invalid approval.",
      chairSuggestionId: created.suggestion.id
    })).rejects.toThrow(/does not recommend/i);
    expect((await store.getSnapshot()).meetings[0]!.mode).toBe("chaired");

    await store.setChairSuggestionPending(created.suggestion.id, proposal.suggestedAgentId, "expected-job");
    const utteranceCount = (await store.getSnapshot()).utterances.length;
    const binding = participantRoleBinding(await store.getSnapshot(), seed.meetings[0]!.id, proposal.suggestedAgentId);
    await expect(store.commitAgentTurn({
      ...binding,
      meetingId: seed.meetings[0]!.id,
      agentId: proposal.suggestedAgentId,
      turnId: "different-job",
      agendaRevision: seed.meetings[0]!.agenda.revision,
      chairSuggestionId: created.suggestion.id,
      speakerName: "Chair-Local",
      roleName: "會議主席",
      content: "This turn must not persist.",
      auditDetail: { model: "local" }
    })).rejects.toThrow(/does not match/i);
    expect((await store.getSnapshot()).utterances).toHaveLength(utteranceCount);
  });

  it("updates MCP connector metadata through store update calls", async () => {
    const store = new InMemoryPlatformStore();
    const connector = await store.createMcpConnector({
      name: "Docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"]
    });
    const result = await store.updateMcpConnector(connector.id, {
      expectedRevision: connector.revision,
      name: "Docs v2",
      baseUrl: "http://10.20.30.40/mcp-v2",
      approvedTools: ["search", "update"],
      enabled: false
    });
    expect(result.connector).toMatchObject({
      id: connector.id,
      name: "Docs v2",
      baseUrl: "http://10.20.30.40/mcp-v2",
      approvedTools: ["search", "update"],
      enabled: false
    });
  });

  it("uses configuration revision CAS and keeps a stale MCP Connector edit from overwriting current state", async () => {
    const store = new InMemoryPlatformStore();
    const connector = await store.createMcpConnector({
      name: "CAS Docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"]
    });

    expect(connector.revision).toBe(1);
    const updated = await store.updateMcpConnector(connector.id, {
      expectedRevision: connector.revision,
      name: "CAS Docs v2"
    });
    expect(updated.connector).toMatchObject({ revision: 2, name: "CAS Docs v2" });

    await expect(store.updateMcpConnector(connector.id, {
      expectedRevision: connector.revision,
      enabled: false
    })).rejects.toMatchObject({ kind: "revision" });
    expect((await store.getSnapshot()).mcpConnectors.find((item) => item.id === connector.id))
      .toMatchObject({ revision: 2, name: "CAS Docs v2", enabled: true });
  });

  it("does not advance an MCP Connector revision or audit a structural no-op", async () => {
    class AuditedMcpConnectorStore extends InMemoryPlatformStore {
      readonly events: string[] = [];

      override async recordAudit(event: string): Promise<void> {
        this.events.push(event);
      }
    }

    const store = new AuditedMcpConnectorStore();
    const connector = await store.createMcpConnector({
      name: "No-op MCP",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"]
    });
    const result = await store.updateMcpConnector(connector.id, {
      expectedRevision: connector.revision,
      approvedTools: [...connector.approvedTools]
    });

    expect(result).toMatchObject({ connector: { revision: connector.revision }, revokedGrantCount: 0 });
    expect(store.events.filter((event) => event === "mcp_connector.updated")).toHaveLength(0);
  });

  it("normalizes legacy allowlist entries into conservative Tool Catalog metadata", async () => {
    const seed = createSeedSnapshot();
    seed.mcpConnectors.push({
      id: "d0000000-0000-4000-8000-000000000001",
      name: "Docs",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"],
      enabled: true,
      hasSecret: false
    } as PlatformSnapshot["mcpConnectors"][number]);
    seed.toolRuns.push({
      id: "e0000000-0000-4000-8000-000000000001",
      jobId: "legacy-tool-job",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      connectorId: "d0000000-0000-4000-8000-000000000001",
      toolName: "search",
      status: "succeeded",
      utteranceId: seed.utterances[0]!.id,
      createdAt: "2026-07-18T00:00:00.000Z"
    } as PlatformSnapshot["toolRuns"][number]);

    const snapshot = await new InMemoryPlatformStore(seed).getSnapshot();
    expect(snapshot.mcpConnectors[0]?.toolRegistrations).toEqual([{
      toolName: "search",
      displayName: "search",
      kind: "mcp_tool",
      version: "unversioned",
      owner: "Platform Owner",
      goal: "以唯讀方式執行 search。"
    }]);
    expect(snapshot.toolRuns[0]).toMatchObject({
      requestFingerprint: "legacy-unverifiable",
      toolSnapshot: {
        connectorName: "Unknown legacy connector",
        toolName: "search",
        displayName: "search",
        kind: "mcp_tool",
        version: "legacy-unknown",
        owner: "Unknown legacy owner",
        goal: "Legacy Tool Run did not capture request-time metadata."
      }
    });
  });

  it("updates Tool Catalog metadata and prunes stale registrations with grants", async () => {
    const store = new InMemoryPlatformStore();
    const agentId = (await store.getSnapshot()).agents[0]!.id;
    const connector = await store.createMcpConnector({
      name: "Docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search", "read"],
      toolRegistrations: [{
        toolName: "search",
        displayName: "政策搜尋",
        kind: "library_wrapper",
        version: "2.1.0",
        owner: "Knowledge Team",
        goal: "搜尋唯讀政策資料。"
      }]
    });
    await store.updateAgent(agentId, {
      toolGrants: [
        { connectorId: connector.id, toolName: "search" },
        { connectorId: connector.id, toolName: "read" }
      ]
    });

    expect(connector.toolRegistrations).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: "search", displayName: "政策搜尋", kind: "library_wrapper" }),
      expect.objectContaining({ toolName: "read", kind: "mcp_tool" })
    ]));

    const narrowed = await store.updateMcpConnector(connector.id, {
      expectedRevision: connector.revision,
      approvedTools: ["search"]
    });
    expect(narrowed.connector.toolRegistrations.map((item) => item.toolName)).toEqual(["search"]);
    expect((await store.getSnapshot()).agents.find((item) => item.id === agentId)?.toolGrants)
      .toEqual([{ connectorId: connector.id, toolName: "search" }]);

    const disabled = await store.updateMcpConnector(connector.id, {
      expectedRevision: narrowed.connector.revision,
      enabled: false
    });
    expect(disabled.connector.toolRegistrations).toEqual([]);
    expect((await store.getSnapshot()).agents.find((item) => item.id === agentId)?.toolGrants).toEqual([]);
  });

  it("commits one structured Tool Run and replays the same job without another utterance", async () => {
    const seed = createSeedSnapshot();
    const connectorId = "d0000000-0000-4000-8000-000000000001";
    seed.mcpConnectors.push({
      id: connectorId,
      revision: 1,
      name: "Docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"],
      toolRegistrations: [{ toolName: "search", displayName: "政策搜尋", kind: "mcp_tool", version: "1.0.0", owner: "Platform Owner", goal: "搜尋政策。" }],
      enabled: true,
      hasSecret: false
    });
    seed.agents[0]!.toolGrants = [{ connectorId, toolName: "search" }];
    const store = new InMemoryPlatformStore(seed);
    const binding = participantRoleBinding(await store.getSnapshot(), seed.meetings[0]!.id, seed.agents[0]!.id);
    const input = {
      ...binding,
      jobId: "tool-job-1",
      requestFingerprint: "fingerprint-1",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      connectorId,
      toolName: "search",
      toolSnapshot: { connectorName: "Docs", toolName: "search", displayName: "政策搜尋", kind: "mcp_tool" as const, version: "1.0.0", owner: "Platform Owner", goal: "搜尋政策。" },
      status: "succeeded" as const,
      content: "{\"documents\":1}"
    };

    await expect(store.commitMcpToolRun(input)).resolves.toMatchObject({
      status: "created",
      run: { jobId: "tool-job-1", status: "succeeded", toolName: "search" },
      utterance: { speakerType: "tool", kind: "verified", evidenceCount: 1 }
    });
    await expect(store.commitMcpToolRun(input)).resolves.toMatchObject({ status: "existing" });

    await expect(store.admitMcpToolCall(input.jobId, {
      ...binding,
      meetingId: input.meetingId,
      agentId: input.agentId,
      connectorId: input.connectorId,
      toolName: input.toolName,
      toolSnapshot: input.toolSnapshot,
      connectorFingerprint: mcpConnectorExecutionFingerprint(seed.mcpConnectors.at(-1)!, null),
      requestFingerprint: input.requestFingerprint,
      acceptedRequestFingerprints: [input.requestFingerprint]
    })).resolves.toMatchObject({
      status: "existing_run",
      run: { jobId: input.jobId },
      reservation: null,
      clearedReservation: false
    });
    expect((await store.getSnapshot()).speakerQueue).toEqual([]);

    const snapshot = await store.getSnapshot();
    expect(snapshot.toolRuns).toHaveLength(1);
    expect(snapshot.toolRuns[0]?.toolSnapshot).toMatchObject({ connectorName: "Docs", displayName: "政策搜尋", version: "1.0.0" });
    expect(snapshot.utterances.filter((item) => item.turnId === "tool-job-1")).toHaveLength(1);
    await expect(store.commitMcpToolRun({ ...input, meetingId: "80000000-0000-4000-8000-000000000099" }))
      .rejects.toThrow(/already used|different/i);
    await expect(store.commitMcpToolRun({ ...input, requestFingerprint: "fingerprint-2" }))
      .rejects.toThrow(/already used|different/i);
  });

  it("serializes MCP Connector disable behind an in-flight Tool completion audit", async () => {
    const seed = createSeedSnapshot();
    const connectorId = "d0000000-0000-4000-8000-000000000090";
    const registration = { toolName: "search", displayName: "政策搜尋", kind: "mcp_tool" as const, version: "1.0.0", owner: "Platform Owner", goal: "搜尋政策。" };
    const connector = {
      id: connectorId,
      revision: 1,
      name: "Lock-aware Docs",
      location: "local" as const,
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"],
      toolRegistrations: [registration],
      enabled: true,
      hasSecret: false
    };
    seed.mcpConnectors.push(connector);
    seed.agents[0]!.toolGrants = [{ connectorId, toolName: "search" }];
    const store = new GatedSuccessfulCompletionAuditStore(seed, "mcp.tool.succeeded");
    const binding = participantRoleBinding(seed, seed.meetings[0]!.id, seed.agents[0]!.id);
    const input = {
      ...binding,
      jobId: "tool-job-management-race",
      requestFingerprint: "tool-management-race-fingerprint",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      connectorId,
      connectorFingerprint: mcpConnectorExecutionFingerprint(connector, null),
      toolName: "search",
      toolSnapshot: { connectorName: connector.name, ...registration },
      status: "succeeded" as const,
      content: "{\"documents\":1}"
    };

    const commit = store.commitMcpToolRun(input);
    await store.auditEntered;
    const disable = store.updateMcpConnector(connectorId, { expectedRevision: 1, enabled: false });
    const disableState = await Promise.race([
      disable.then(() => "resolved" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 20))
    ]);

    expect(disableState).toBe("pending");
    const whileAuditPending = await store.getSnapshot();
    expect(whileAuditPending.mcpConnectors.find((item) => item.id === connectorId)?.enabled).toBe(true);
    expect(whileAuditPending.toolRuns.some((item) => item.jobId === input.jobId)).toBe(false);
    store.releaseAudit();
    await expect(commit).resolves.toMatchObject({ status: "created" });
    await expect(disable).resolves.toMatchObject({ connector: { enabled: false } });
    expect((await store.getSnapshot()).toolRuns.some((item) => item.jobId === input.jobId)).toBe(true);
  });

  it("keeps a failed Tool Run and Meeting pause invisible when its required audit fails", async () => {
    const seed = createSeedSnapshot();
    const connectorId = "d0000000-0000-4000-8000-000000000091";
    const registration = { toolName: "search", displayName: "政策搜尋", kind: "mcp_tool" as const, version: "1.0.0", owner: "Platform Owner", goal: "搜尋政策。" };
    seed.mcpConnectors.push({
      id: connectorId,
      revision: 1,
      name: "Audit Docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"],
      toolRegistrations: [registration],
      enabled: true,
      hasSecret: false
    });
    seed.agents[0]!.toolGrants = [{ connectorId, toolName: "search" }];
    const store = new GatedMcpAuditFailureStore(seed);
    const binding = participantRoleBinding(seed, seed.meetings[0]!.id, seed.agents[0]!.id);
    const input = {
      ...binding,
      jobId: "tool-job-audit-failure",
      requestFingerprint: "tool-audit-fingerprint",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      connectorId,
      toolName: "search",
      toolSnapshot: { connectorName: "Audit Docs", ...registration },
      status: "failed" as const,
      content: "Connector unavailable."
    };

    const firstCommit = store.commitMcpToolRun(input);
    await store.toolAuditEntered;
    const whileAuditPending = await store.getSnapshot();
    store.releaseToolAudit();

    await expect(firstCommit).rejects.toThrow(/audit unavailable/i);
    expect(whileAuditPending.toolRuns.some((item) => item.jobId === input.jobId)).toBe(false);
    expect(whileAuditPending.utterances.some((item) => item.turnId === input.jobId)).toBe(false);
    expect(whileAuditPending.meetings[0]!.state).toBe("active");
    const afterFailure = await store.getSnapshot();
    expect(afterFailure.toolRuns.some((item) => item.jobId === input.jobId)).toBe(false);
    expect(afterFailure.meetings[0]!.state).toBe("active");
    await expect(store.commitMcpToolRun(input)).rejects.toThrow(/audit unavailable/i);
    expect(store.toolAuditAttempts).toBe(2);
  });

  it("rejects MCP admission when the assigned Agent has been disabled", async () => {
    const seed = createSeedSnapshot();
    const connectorId = "d0000000-0000-4000-8000-000000000021";
    const connector = {
      id: connectorId,
      revision: 1,
      name: "Disabled Agent Docs",
      location: "local" as const,
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"],
      toolRegistrations: [{ toolName: "search", displayName: "搜尋", kind: "mcp_tool" as const, version: "1.0.0", owner: "Platform Owner", goal: "搜尋政策。" }],
      enabled: true,
      hasSecret: false
    };
    seed.mcpConnectors.push(connector);
    seed.agents[0]!.toolGrants = [{ connectorId, toolName: "search" }];
    const store = new InMemoryPlatformStore(seed);
    const meetingId = seed.meetings[0]!.id;
    const agentId = seed.agents[0]!.id;
    const binding = participantRoleBinding(await store.getSnapshot(), meetingId, agentId);
    await store.setAgentStatus(agentId, { status: "disabled", expectedRevision: 1 });

    await expect(store.admitMcpToolCall("disabled-agent-tool-job", {
      ...binding,
      meetingId,
      agentId,
      connectorId,
      toolName: "search",
      toolSnapshot: { connectorName: connector.name, ...connector.toolRegistrations[0]! },
      connectorFingerprint: mcpConnectorExecutionFingerprint(connector, null),
      requestFingerprint: "disabled-agent-fingerprint",
      acceptedRequestFingerprints: ["disabled-agent-fingerprint"]
    })).rejects.toMatchObject({ apiCode: "AGENT_DISABLED" });
    expect((await store.getSnapshot()).speakerQueue).toEqual([]);
  });

  it("authorizes MCP admission from the Meeting-pinned Agent revision, not an unpublished draft", async () => {
    const seed = createSeedSnapshot();
    const connectorId = "d0000000-0000-4000-8000-000000000022";
    const connector = {
      id: connectorId,
      revision: 1,
      name: "Pinned Revision Docs",
      location: "local" as const,
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"],
      toolRegistrations: [{ toolName: "search", displayName: "搜尋", kind: "mcp_tool" as const, version: "1.0.0", owner: "Platform Owner", goal: "搜尋政策。" }],
      enabled: true,
      hasSecret: false
    };
    seed.mcpConnectors.push(connector);
    const store = new InMemoryPlatformStore(seed);
    const meetingId = seed.meetings[0]!.id;
    const agentId = seed.agents[0]!.id;
    await store.updateAgent(agentId, { toolGrants: [{ connectorId, toolName: "search" }] });
    const binding = participantRoleBinding(await store.getSnapshot(), meetingId, agentId);

    await expect(store.admitMcpToolCall("unpublished-grant-tool-job", {
      ...binding,
      meetingId,
      agentId,
      connectorId,
      toolName: "search",
      toolSnapshot: { connectorName: connector.name, ...connector.toolRegistrations[0]! },
      connectorFingerprint: mcpConnectorExecutionFingerprint(connector, null),
      requestFingerprint: "unpublished-grant-fingerprint",
      acceptedRequestFingerprints: ["unpublished-grant-fingerprint"]
    })).rejects.toMatchObject({ apiCode: "TOOL_DENIED" });
    expect((await store.getSnapshot()).speakerQueue).toEqual([]);
  });

  it("refuses to persist successful Tool output after authorization becomes stale", async () => {
    const seed = createSeedSnapshot();
    const connectorId = "d0000000-0000-4000-8000-000000000001";
    seed.mcpConnectors.push({
      id: connectorId,
      revision: 1,
      name: "Docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"],
      toolRegistrations: [{ toolName: "search", displayName: "搜尋", kind: "mcp_tool", version: "1.0.0", owner: "Platform Owner", goal: "搜尋政策。" }],
      enabled: false,
      hasSecret: false
    });
    seed.agents[0]!.toolGrants = [{ connectorId, toolName: "search" }];
    const store = new InMemoryPlatformStore(seed);
    const binding = participantRoleBinding(await store.getSnapshot(), seed.meetings[0]!.id, seed.agents[0]!.id);

    await expect(store.commitMcpToolRun({
      ...binding,
      jobId: "tool-job-stale",
      requestFingerprint: "fingerprint-stale",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      connectorId,
      toolName: "search",
      toolSnapshot: { connectorName: "Docs", toolName: "search", displayName: "搜尋", kind: "mcp_tool", version: "1.0.0", owner: "Platform Owner", goal: "搜尋政策。" },
      status: "succeeded",
      content: "must not persist"
    })).resolves.toMatchObject({ status: "stale", run: null, utterance: null });
    expect((await store.getSnapshot()).toolRuns).toEqual([]);
  });

  it("pauses the Meeting in the same mutation as a failed Tool Run and preserves request-time provenance", async () => {
    const seed = createSeedSnapshot();
    const connectorId = "d0000000-0000-4000-8000-000000000011";
    seed.mcpConnectors.push({
      id: connectorId,
      revision: 1,
      name: "Docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"],
      toolRegistrations: [{ toolName: "search", displayName: "政策搜尋", kind: "library_wrapper", version: "2.1.0", owner: "Knowledge Team", goal: "搜尋政策。" }],
      enabled: true,
      hasSecret: false
    });
    seed.agents[0]!.toolGrants = [{ connectorId, toolName: "search" }];
    const store = new InMemoryPlatformStore(seed);
    const toolSnapshot = { connectorName: "Docs", ...seed.mcpConnectors.at(-1)!.toolRegistrations[0]! };
    const binding = participantRoleBinding(await store.getSnapshot(), seed.meetings[0]!.id, seed.agents[0]!.id);

    const result = await store.commitMcpToolRun({
      ...binding,
      jobId: "tool-job-failed-atomic",
      requestFingerprint: "fingerprint-failed",
      meetingId: seed.meetings[0]!.id,
      agentId: seed.agents[0]!.id,
      connectorId,
      toolName: "search",
      toolSnapshot,
      status: "failed",
      content: "Connector unavailable."
    });
    await store.updateMcpConnector(connectorId, {
      expectedRevision: seed.mcpConnectors.at(-1)!.revision,
      toolRegistrations: [{ ...seed.mcpConnectors.at(-1)!.toolRegistrations[0]!, displayName: "已改名", version: "3.0.0" }]
    });

    const snapshot = await store.getSnapshot();
    expect(result).toMatchObject({ status: "created", meetingPaused: true });
    expect(snapshot.meetings[0]!.state).toBe("paused");
    expect(snapshot.toolRuns[0]?.toolSnapshot).toEqual(toolSnapshot);
  });

  it("revokes matching grants when allowlist shrinks and fully revokes grants on disable", async () => {
    const store = new InMemoryPlatformStore();
    const seed = await store.getSnapshot();
    const connector = await store.createMcpConnector({
      name: "Search",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search", "read"]
    });

    await store.updateAgent(seed.agents[0]!.id, {
      toolGrants: [
        { connectorId: connector.id, toolName: "search" },
        { connectorId: connector.id, toolName: "read" }
      ]
    });
    await store.updateAgent(seed.agents[1]!.id, {
      toolGrants: [{ connectorId: connector.id, toolName: "read" }]
    });

    const narrowed = await store.updateMcpConnector(connector.id, {
      expectedRevision: connector.revision,
      approvedTools: ["search"]
    });
    const afterNarrowing = await store.getSnapshot();
    expect(narrowed.connector).toMatchObject({ enabled: true, approvedTools: ["search"] });
    expect(narrowed.revokedGrantCount).toBe(2);
    expect(afterNarrowing.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: seed.agents[0]!.id, toolGrants: [{ connectorId: connector.id, toolName: "search" }] }),
      expect.objectContaining({ id: seed.agents[1]!.id, toolGrants: [] })
    ]));

    const disabled = await store.updateMcpConnector(connector.id, {
      expectedRevision: narrowed.connector.revision,
      enabled: false
    });
    const afterDisable = await store.getSnapshot();
    expect(disabled.connector).toMatchObject({ enabled: false, approvedTools: ["search"] });
    expect(disabled.revokedGrantCount).toBe(1);
    expect(afterDisable.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: seed.agents[0]!.id, toolGrants: [] }),
      expect.objectContaining({ id: seed.agents[1]!.id, toolGrants: [] })
    ]));
  });

  it("rejects duplicate MCP connector names on create and update", async () => {
    const store = new InMemoryPlatformStore();
    await store.createMcpConnector({
      name: "Docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"]
    });

    await expect(store.createMcpConnector({
      name: "docs",
      location: "local",
      baseUrl: "http://10.20.30.41/mcp",
      approvedTools: ["search"]
    })).rejects.toThrow(/already|unique|duplicate/i);

    const second = await store.createMcpConnector({
      name: "Archive",
      location: "local",
      baseUrl: "http://10.20.30.42/mcp",
      approvedTools: ["search"]
    });

    await expect(store.updateMcpConnector(second.id, {
      expectedRevision: second.revision,
      name: "DOCS"
    })).rejects.toThrow(/already|unique|duplicate/i);
  });

  it("rejects MCP connector updates with blocked baseUrl hostnames", async () => {
    const store = new InMemoryPlatformStore();
    const connector = await store.createMcpConnector({
      name: "Docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"]
    });

    await expect(store.updateMcpConnector(connector.id, {
      expectedRevision: connector.revision,
      baseUrl: "http://localhost:4000/mcp"
    })).rejects.toThrow(/url|allowed|connector|blocked/i);
  });
});
