import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeProfileSnapshot,
  createRoleVersion,
  type CreateToolPackInput,
  type ParticipantRoleBinding,
  type PlatformSnapshot,
  type SpeakerQueueItem,
  type Task,
  type TaskAgentRunJobData
} from "@council/contracts";
import type { Pool, PoolClient, QueryResult } from "pg";
import { createQueuedRuntimeRun } from "@council/domain";
import { emptyPlatformSnapshot, platformSnapshotCollectionNames } from "@council/domain/platform-views";
import { InMemoryPlatformStore } from "./memory-store.js";
import { createSeedSnapshot } from "./seed.js";
import { PostgresPlatformStore } from "./postgres-store.js";
import {
  credentialCreateIdempotencyInput,
  mcpConnectorExecutionFingerprint,
  requestFingerprint,
  taskExecutionFingerprint
} from "./store.js";

type ModelConnectorLifecycleStore = {
  updateModelConnector(
    id: string,
    input: { expectedRevision: number } & Partial<{
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

function modelConnectorLifecycle(store: PostgresPlatformStore): ModelConnectorLifecycleStore {
  return store as unknown as ModelConnectorLifecycleStore;
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

function speakerQueueFixture(snapshot: PlatformSnapshot, jobId: string): SpeakerQueueItem {
  const meeting = snapshot.meetings[0]!;
  const participant = snapshot.participants.find((item) => item.meetingId === meeting.id)!;
  return {
    id: jobId,
    jobId,
    requestFingerprint: null,
    meetingId: meeting.id,
    agentId: participant.agentId,
    kind: "agent_turn",
    label: "PostgreSQL Agent failure turn",
    toolName: null,
    participantId: participant.id,
    roleRevision: participant.roleRevision,
    roleId: participant.roleId,
    roleVersion: participant.roleSnapshot.version,
    roleName: participant.roleSnapshot.name,
    agendaRevision: meeting.agenda.revision,
    agendaCurrentItemId: meeting.agenda.items.find((item) => item.status === "current")?.id ?? null,
    status: "running",
    requestedAt: "2026-08-12T00:00:00.000Z",
    startedAt: "2026-08-12T00:00:01.000Z",
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    requestedBy: "owner"
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

function transactionPool(
  cachedIdempotency?: { response: unknown; requestFingerprint: string | null },
  state = createSeedSnapshot(),
  roleVersions: Array<Record<string, unknown>> = [],
  managementHistory: {
    agentRevisions?: unknown[];
    promptVersions?: unknown[];
    runtimeProfileRevisions?: unknown[];
    toolPackRevisions?: unknown[];
    credentialSecrets?: Array<{ credentialId: string; ciphertext: string }>;
    connectorSecrets?: Array<{ connectorId: string; ciphertext: string }>;
  } = {},
  projectedUtterances?: PlatformSnapshot["utterances"]
) {
  const clientQuery = vi.fn(async (text: string, values: unknown[] = []) => {
    if (text.includes("SELECT state FROM platform_state")) return { rows: [{ state }], rowCount: 1 };
    if (text.includes("utterance_projection_backfill_progress") && projectedUtterances) {
      return { rows: [{ complete: true, utterances: projectedUtterances }], rowCount: 1 };
    }
    if (text.includes("FROM agent_revisions")) {
      const rows = (managementHistory.agentRevisions ?? []).map((snapshot) => ({ snapshot }));
      return { rows, rowCount: rows.length };
    }
    if (text.includes("FROM prompt_versions")) {
      const rows = (managementHistory.promptVersions ?? []).map((snapshot) => ({ snapshot }));
      return { rows, rowCount: rows.length };
    }
    if (text.includes("FROM runtime_profile_revisions")) {
      const rows = (managementHistory.runtimeProfileRevisions ?? []).map((snapshot) => ({ snapshot }));
      return { rows, rowCount: rows.length };
    }
    if (text.includes("FROM tool_pack_revisions")) {
      const rows = (managementHistory.toolPackRevisions ?? []).map((snapshot) => ({ snapshot }));
      return { rows, rowCount: rows.length };
    }
    if (text.includes("FROM credential_secrets")) {
      const rows = managementHistory.credentialSecrets ?? [];
      return { rows, rowCount: rows.length };
    }
    if (text.includes("FROM connector_secrets")) {
      const rows = managementHistory.connectorSecrets ?? [];
      return { rows, rowCount: rows.length };
    }
    if (text.includes("FROM role_versions")) {
      const version = Number(values[1]);
      const matching = Number.isFinite(version)
        ? roleVersions.filter((item) => item.roleId === values[0] && item.version === version)
        : roleVersions.filter((item) => item.roleId === values[0]);
      return { rows: matching.map((snapshot) => ({ snapshot })), rowCount: matching.length };
    }
    if (text.includes("FROM idempotency_records")) {
      return cachedIdempotency ? { rows: [cachedIdempotency], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 1 };
  });
  const client = { query: clientQuery, release: vi.fn() } as unknown as PoolClient;
  const poolQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }) as unknown as QueryResult);
  const pool = { connect: vi.fn(async () => client), query: poolQuery } as unknown as Pool;
  return { pool, poolQuery, clientQuery };
}

async function postgresTeamReadyFixture() {
  const memory = new InMemoryPlatformStore(createSeedSnapshot());
  const agentId = (await memory.getSnapshot()).agents[0]!.id;
  const connector = await memory.createModelConnector({
    name: "PostgreSQL Team-ready local model",
    location: "local",
    baseUrl: "http://192.168.50.10:4000/v1",
    model: "team-ready"
  });
  const prompt = await memory.createPrompt({
    name: "PostgreSQL Team-ready Agent Prompt",
    kind: "agent",
    description: "Makes the test Agent publishable through the governed Prompt lifecycle.",
    owner: "database-test",
    content: "Participate in the bounded Team meeting.",
    variables: []
  });
  await memory.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 });
  await memory.setAgentModel(agentId, { modelConnectorId: connector.id });
  await memory.updateAgent(agentId, {
    skillIds: [],
    toolGrants: [],
    toolPackGrants: [],
    promptBinding: { promptId: prompt.id, version: 1 }
  });
  const draft = (await memory.getSnapshot()).agents.find((item) => item.id === agentId)!;
  await memory.publishAgent(agentId, { expectedDraftRevision: draft.draftRevision! });
  const state = await memory.getSnapshot();
  return {
    agentId,
    memory,
    state,
    history: {
      agentRevisions: await memory.getAgentRevisions(agentId),
      promptVersions: await memory.getPromptVersions(prompt.id),
      runtimeProfileRevisions: state.runtimeProfileRevisions ?? []
    }
  };
}

function statefulFailurePool(
  state: ReturnType<typeof createSeedSnapshot>,
  connectorId: string,
  failOn: string
) {
  type DurableState = {
    state: ReturnType<typeof createSeedSnapshot>;
    secrets: Map<string, string>;
    audits: unknown[][];
    roleVersions: Array<Record<string, unknown>>;
  };
  let durable: DurableState = {
    state: structuredClone(state),
    secrets: new Map(connectorId ? [[connectorId, "encrypted-original"]] : []),
    audits: [],
    roleVersions: []
  };
  let staged: DurableState | null = null;
  const clientQuery = vi.fn(async (text: string, values: unknown[] = []) => {
    if (text === "BEGIN") {
      staged = {
        state: structuredClone(durable.state),
        secrets: new Map(durable.secrets),
        audits: structuredClone(durable.audits),
        roleVersions: structuredClone(durable.roleVersions)
      };
      return { rows: [], rowCount: 1 };
    }
    if (text === "ROLLBACK") {
      staged = null;
      return { rows: [], rowCount: 1 };
    }
    if (text === "COMMIT") {
      if (!staged) throw new Error("No active transaction.");
      durable = staged;
      staged = null;
      return { rows: [], rowCount: 1 };
    }
    if (!staged) throw new Error("Query executed outside a transaction.");
    if (text.includes("SELECT state FROM platform_state")) {
      return { rows: [{ state: structuredClone(staged.state) }], rowCount: 1 };
    }
    if (text.includes("FROM role_versions")) {
      const version = Number(values[1]);
      const matching = Number.isFinite(version)
        ? staged.roleVersions.filter((item) => item.roleId === values[0] && item.version === version)
        : staged.roleVersions.filter((item) => item.roleId === values[0]);
      return { rows: matching.map((snapshot) => ({ snapshot })), rowCount: matching.length };
    }
    if (text.includes(failOn)) throw new Error(`Injected failure: ${failOn}`);
    if (text.includes("INSERT INTO connector_secrets")) {
      staged.secrets.set(String(values[0]), String(values[1]));
    } else if (text.includes("DELETE FROM connector_secrets")) {
      staged.secrets.delete(String(values[0]));
    } else if (text.includes("INSERT INTO role_versions")) {
      staged.roleVersions.push(JSON.parse(String(values[2])) as Record<string, unknown>);
    } else if (text.includes("INSERT INTO audit_events")) {
      staged.audits.push(structuredClone(values));
    } else if (text.includes("UPDATE platform_state")) {
      staged.state = JSON.parse(String(values[0]));
    }
    return { rows: [], rowCount: 1 };
  });
  const client = { query: clientQuery, release: vi.fn() } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client), query: vi.fn() } as unknown as Pool;
  return {
    pool,
    clientQuery,
    readDurable: () => ({
      state: structuredClone(durable.state),
      secrets: new Map(durable.secrets),
      audits: structuredClone(durable.audits),
      roleVersions: structuredClone(durable.roleVersions)
    })
  };
}

function repeatableReadPool(
  query: (text: string, values?: unknown[]) => Promise<unknown>
) {
  const clientQuery = vi.fn(query);
  const client = { query: clientQuery, release: vi.fn() } as unknown as PoolClient;
  const poolQuery = vi.fn();
  const pool = {
    connect: vi.fn(async () => client),
    query: poolQuery
  } as unknown as Pool;
  return { pool, client, clientQuery, poolQuery };
}

async function toolPackProjectionFixture(): Promise<{
  state: PlatformSnapshot;
  pack: NonNullable<PlatformSnapshot["toolPacks"]>[number];
}> {
  const memory = new InMemoryPlatformStore(createSeedSnapshot());
  const imageDigest = `sha256:${"b".repeat(64)}`;
  const pack = await memory.createToolPack({
    name: "Projection snapshot Tool Pack",
    version: "1.0.0",
    description: "Verify one-snapshot projection reads.",
    owner: "Platform Owner",
    sourceReference: `registry.example.com/council/projection@${imageDigest}`,
    imageDigest,
    tools: [{
      name: "search",
      kind: "command",
      goal: "Search documentation.",
      access: "read_only",
      argv: { executable: "/usr/bin/rg", fixedArguments: ["--json"] },
      env: { allowedNames: [] },
      stdin: { mode: "none" }
    }]
  });
  return { state: await memory.getSnapshot(), pack };
}

describe("PostgresPlatformStore transactions", () => {
  it("checks initialized database readiness without loading the platform JSONB snapshot", async () => {
    const query = vi.fn(async (_text: string) => ({ rows: [{ initialized: true }], rowCount: 1 }) as unknown as QueryResult);
    const store = new PostgresPlatformStore({ query } as unknown as Pool);

    await expect(store.checkHealth()).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledOnce();
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("platform_state");
    expect(sql).not.toContain("SELECT state");
    expect(sql).not.toContain("meeting_utterances");
  });

  it("fails readiness when the singleton platform state is not initialized", async () => {
    const query = vi.fn(async (_text: string) => ({ rows: [{ initialized: false }], rowCount: 1 }) as unknown as QueryResult);
    const store = new PostgresPlatformStore({ query } as unknown as Pool);

    await expect(store.checkHealth()).rejects.toThrow(/not initialized/i);
  });

  it("persists Chair parent admission state and its audits in the same transactions", async () => {
    const memory = new InMemoryPlatformStore();
    const seed = await memory.getSnapshot();
    const meeting = seed.meetings[0]!;
    await memory.setMeetingAutomation(meeting.id, {
      automation: "auto",
      expectedAutomation: "suggest",
      expectedAutomationRevision: 0
    });
    const created = await memory.createChairSuggestion(meeting.id, seed.utterances.at(-1)!.id, {
      reason: "off_topic",
      suggestedMode: "chaired",
      explanation: "Persist the parent queue ownership boundary.",
      score: 0.92
    });
    const state = await memory.getSnapshot();
    const jobId = `${meeting.id}-chair-auto-${created.suggestion.id}`;
    const reservedAt = "2026-08-18T00:00:00.000Z";
    const admittedAt = "2026-08-18T00:00:01.000Z";
    let admission: Record<string, unknown> | null = null;
    const clientQuery = vi.fn(async (text: string, values: unknown[] = []) => {
      if (text.includes("SELECT state FROM platform_state") && text.includes("FOR UPDATE")) {
        return { rows: [{ state }], rowCount: 1 };
      }
      if (text.includes("FROM chair_automation_job_admissions") && text.includes("FOR UPDATE")) {
        return admission ? { rows: [admission], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (text.includes("INSERT INTO chair_automation_job_admissions")) {
        admission = {
          chairSuggestionId: created.suggestion.id,
          meetingId: meeting.id,
          jobId,
          automationRevision: 1,
          status: "reserved",
          reservedAt,
          admittedAt: null,
          reconciliationRequiredAt: null,
          reconciliationReason: null,
          updatedAt: reservedAt
        };
        return { rows: [admission], rowCount: 1 };
      }
      if (text.includes("UPDATE chair_automation_job_admissions") && text.includes("'admitted'")) {
        admission = { ...admission, status: "admitted", admittedAt, updatedAt: admittedAt };
        return { rows: [admission], rowCount: 1 };
      }
      if (text.includes("INSERT INTO audit_events")) return { rows: [], rowCount: 1 };
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const client = { query: clientQuery, release: vi.fn() } as unknown as PoolClient;
    const store = new PostgresPlatformStore({
      connect: vi.fn(async () => client),
      query: vi.fn()
    } as unknown as Pool);

    await expect(store.reserveChairAutomationJobAdmission(created.suggestion.id, jobId, 1))
      .resolves.toMatchObject({ status: "updated", admission: { status: "reserved", jobId } });
    await expect(store.confirmChairAutomationJobAdmission(created.suggestion.id, jobId))
      .resolves.toMatchObject({ status: "updated", admission: { status: "admitted", jobId } });

    admission = Object.assign({}, admission, {
      status: "reconciliation_required",
      reconciliationRequiredAt: admittedAt,
      reconciliationReason: "queue_state_terminal"
    });
    await expect(store.confirmChairAutomationJobAdmission(created.suggestion.id, jobId))
      .rejects.toThrow(/requires reconciliation/i);

    const calls = clientQuery.mock.calls;
    const reserveAuditIndex = calls.findIndex(([_text, values]) => values?.[1] === "chair.automation.admission.reserved");
    const queuedAuditIndex = calls.findIndex(([_text, values]) => values?.[1] === "chair.automation.queued");
    const commits = calls
      .map(([text], index) => ({ text, index }))
      .filter((call) => call.text === "COMMIT")
      .map((call) => call.index);
    expect(reserveAuditIndex).toBeGreaterThan(-1);
    expect(queuedAuditIndex).toBeGreaterThan(commits[0]!);
    expect(commits[0]).toBeGreaterThan(reserveAuditIndex);
    expect(commits[1]).toBeGreaterThan(queuedAuditIndex);
  });

  it.each([
    {
      label: "Model Connector",
      event: "model_connector.created",
      collection: "modelConnectors" as const,
      create: (store: PostgresPlatformStore) => store.createModelConnector({
        name: "Transactional model",
        location: "local",
        baseUrl: "http://10.20.30.40/v1",
        model: "transactional-model"
      })
    },
    {
      label: "MCP Connector",
      event: "mcp_connector.created",
      collection: "mcpConnectors" as const,
      create: (store: PostgresPlatformStore) => store.createMcpConnector({
        name: "Transactional MCP",
        location: "local",
        baseUrl: "http://10.20.30.40/mcp",
        approvedTools: ["search"]
      })
    }
  ])("persists one $label creation audit in the same transaction", async ({ event, collection, create }) => {
    const initial = createSeedSnapshot();
    const harness = statefulFailurePool(initial, "", "__never__");

    const created = await create(new PostgresPlatformStore(harness.pool));

    const durable = harness.readDurable();
    expect(durable.state[collection]).toContainEqual(expect.objectContaining({ id: created.id }));
    expect(durable.audits.filter((values) => values[1] === event)).toHaveLength(1);
  });

  it.each([
    {
      label: "Model Connector",
      collection: "modelConnectors" as const,
      create: (store: PostgresPlatformStore) => store.createModelConnector({
        name: "Rollback model",
        location: "local",
        baseUrl: "http://10.20.30.40/v1",
        model: "rollback-model"
      })
    },
    {
      label: "MCP Connector",
      collection: "mcpConnectors" as const,
      create: (store: PostgresPlatformStore) => store.createMcpConnector({
        name: "Rollback MCP",
        location: "local",
        baseUrl: "http://10.20.30.40/mcp",
        approvedTools: ["search"]
      })
    }
  ])("rolls back $label creation when its audit insert fails", async ({ collection, create }) => {
    const initial = createSeedSnapshot();
    const harness = statefulFailurePool(initial, "", "INSERT INTO audit_events");

    await expect(create(new PostgresPlatformStore(harness.pool))).rejects.toThrow(/Injected failure/);

    expect(harness.readDurable().state[collection]).toEqual(initial[collection]);
    expect(harness.readDurable().audits).toEqual([]);
  });

  it.each([
    ["full snapshot", (store: PostgresPlatformStore, state: PlatformSnapshot) => store.getSnapshot().then(() => state)],
    ["Meeting projection", (store: PostgresPlatformStore, state: PlatformSnapshot) => store.getMeetingView(state.meetings[0]!.id).then(() => state)]
  ])("reads %s state and Utterances inside one repeatable-read transaction", async (_label, read) => {
    const state = createSeedSnapshot();
    const clientQuery = vi.fn(async (text: string) => {
      if (text === "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY") {
        return { rows: [], rowCount: 0 };
      }
      if (text === "COMMIT" || text === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (text.includes("SELECT state FROM platform_state") || text.includes("jsonb_build_object")) {
        return { rows: [{ state }], rowCount: 1 };
      }
      if (text.includes("utterance_projection_backfill_progress")) {
        return { rows: [{ complete: true, utterances: state.utterances }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const client = { query: clientQuery, release: vi.fn() } as unknown as PoolClient;
    const poolQuery = vi.fn(async () => {
      throw new Error("Consistent snapshot reads must not escape the repeatable-read client.");
    });
    const store = new PostgresPlatformStore({
      connect: vi.fn(async () => client),
      query: poolQuery
    } as unknown as Pool);

    await expect(read(store, state)).resolves.toBe(state);
    expect(clientQuery.mock.calls[0]?.[0]).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("utterance_projection_backfill_progress"))).toBe(true);
    expect(poolQuery).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("removes a legacy connector secret when a Model Connector is rebound to a Credential", async () => {
    const memory = new InMemoryPlatformStore();
    const credentialA = await memory.createCredential({
      name: "Credential A",
      provider: "provider-a",
      kind: "api_key",
      location: "cloud",
      expiresAt: null
    }, { ciphertext: "encrypted-a" });
    const credentialB = await memory.createCredential({
      name: "Credential B",
      provider: "provider-b",
      kind: "api_key",
      location: "cloud",
      expiresAt: null
    }, { ciphertext: "encrypted-b" });
    const connector = await memory.createModelConnector({
      name: "Rebound model",
      location: "cloud",
      baseUrl: "https://models.example.com/v1",
      model: "meeting-model",
      credentialId: credentialA.id
    });
    const harness = statefulFailurePool(await memory.getSnapshot(), connector.id, "__never__");

    await new PostgresPlatformStore(harness.pool).updateModelConnector(connector.id, {
      expectedRevision: connector.revision,
      credentialId: credentialB.id
    });

    expect(harness.readDurable().secrets.has(connector.id)).toBe(false);
    expect(harness.clientQuery.mock.calls.some(([text, values]) => (
      String(text).includes("DELETE FROM connector_secrets")
      && Array.isArray(values)
      && values[0] === connector.id
    ))).toBe(true);
  });

  it("uses Model Connector metadata to select the current Credential before legacy fallback", async () => {
    const connectorId = randomUUID();
    const query = vi.fn(async (text: string, values: unknown[]) => {
      expect(text).toContain("connector->>'credentialId'");
      expect(text).toContain("connector->>'hasSecret'");
      expect(text).toContain("legacy.connector_id = $1::uuid");
      expect(text).toContain("CASE");
      expect(text).not.toContain("SELECT COALESCE");
      expect(values).toEqual([connectorId]);
      return { rows: [{ ciphertext: "encrypted-current-credential" }], rowCount: 1 } as unknown as QueryResult;
    });

    await expect(new PostgresPlatformStore({ query } as unknown as Pool).getConnectorSecret(connectorId))
      .resolves.toBe("encrypted-current-credential");
  });

  it("reads Credential metadata without loading unrelated platform collections", async () => {
    const memory = new InMemoryPlatformStore();
    const credential = await memory.createCredential({
      name: "Focused Credential metadata",
      provider: "local-provider",
      kind: "api_key",
      location: "local",
      expiresAt: null
    });
    const state = { ...emptyPlatformSnapshot(), credentials: [credential] };
    const query = vi.fn(async (_text: string) => ({ rows: [{ state }], rowCount: 1 }) as unknown as QueryResult);
    const store = new PostgresPlatformStore({ query } as unknown as Pool);
    vi.spyOn(store, "getSnapshot").mockRejectedValue(new Error("unbounded snapshot read"));

    await expect(store.getCredentials()).resolves.toEqual([credential]);
    expect(query).toHaveBeenCalledOnce();
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("state->'credentials'");
    expect(sql).not.toContain("state->'tasks'");
    expect(sql).not.toContain("state->'utterances'");
    expect(sql).not.toContain("state->'modelConnectors'");
    expect(sql).not.toContain("credential_secrets");
  });

  it("reads explicit page projections instead of selecting the full JSONB snapshot", async () => {
    const memory = new InMemoryPlatformStore();
    const connector = await memory.createMcpConnector({
      name: "Task projection MCP",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"],
      toolRegistrations: [{
        toolName: "search",
        displayName: "Search",
        kind: "mcp_tool",
        version: "1.0.0",
        owner: "Platform Owner",
        goal: "Read-only search."
      }]
    });
    const agent = (await memory.getSnapshot()).agents[0]!;
    await memory.updateAgent(agent.id, {
      toolGrants: [{ connectorId: connector.id, toolName: "search" }]
    }, agent.draftRevision);
    const state = await memory.getSnapshot();
    const query = vi.fn(async (text: string) => {
      const projected = emptyPlatformSnapshot() as unknown as Record<string, unknown>;
      const source = state as unknown as Record<string, unknown>;
      for (const name of platformSnapshotCollectionNames) {
        if (text.includes(`state->'${name}'`)) projected[name] = structuredClone(source[name]);
      }
      return { rows: [{ state: projected }], rowCount: 1 } as unknown as QueryResult;
    });
    const store = new PostgresPlatformStore({ query } as unknown as Pool);

    const projected = await store.getViewSnapshot("tasks");

    expect(projected.agents).toHaveLength(state.agents.length);
    expect(projected.roles).toEqual(state.roles.filter((role) => !role.deletedAt));
    expect(projected.agents.find((item) => item.id === agent.id)?.toolGrants)
      .toEqual([{ connectorId: connector.id, toolName: "search" }]);
    expect(projected.mcpConnectors).toEqual([]);
    expect(projected.meetings).toHaveLength(state.meetings.length);
    expect(projected.utterances).toEqual([]);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("jsonb_build_object");
    expect(sql).toContain("state->'tasks'");
    expect(sql).not.toMatch(/^SELECT state FROM platform_state/);
  });

  it("reads an explicit meeting projection without loading unrelated registries", async () => {
    const state = createSeedSnapshot();
    const transaction = repeatableReadPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "COMMIT" || text === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("utterance_projection_backfill_progress")) {
        return { rows: [{ complete: true, utterances: state.utterances }], rowCount: 1 };
      }
      return { rows: [{ state }], rowCount: 1 };
    });
    const store = new PostgresPlatformStore(transaction.pool);

    const projected = await store.getMeetingView(state.meetings[0]!.id);

    expect(projected?.meeting.id).toBe(state.meetings[0]!.id);
    expect(projected?.utterances).toHaveLength(state.utterances.length);
    const sql = transaction.clientQuery.mock.calls
      .map(([text]) => String(text))
      .find((text) => text.includes("jsonb_build_object")) ?? "";
    expect(sql).toContain("state->'utterances'");
    expect(sql).not.toContain("state->'credentials'");
    expect(sql).not.toContain("state->'prompts'");
    expect(transaction.poolQuery).not.toHaveBeenCalled();
  });

  it("compares Tool Pack projection and canonical state in one repeatable-read snapshot", async () => {
    const { state, pack } = await toolPackProjectionFixture();
    const transaction = repeatableReadPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "COMMIT" || text === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM tool_packs")) return { rows: [{ snapshot: pack }], rowCount: 1 };
      if (text.includes("SELECT state FROM platform_state")) return { rows: [{ state }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    transaction.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const store = new PostgresPlatformStore(transaction.pool);

    await expect(store.getToolPacks()).resolves.toEqual([pack]);
    expect(transaction.poolQuery).not.toHaveBeenCalled();
  });

  it("compares Tool Pack revision projection and canonical state in one repeatable-read snapshot", async () => {
    const { state, pack } = await toolPackProjectionFixture();
    const revisions = (state.toolPackRevisions ?? []).filter((revision) => revision.packId === pack.id);
    const transaction = repeatableReadPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "COMMIT" || text === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM tool_pack_revisions")) {
        return { rows: revisions.map((snapshot) => ({ snapshot })), rowCount: revisions.length };
      }
      if (text.includes("SELECT state FROM platform_state")) return { rows: [{ state }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    transaction.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const store = new PostgresPlatformStore(transaction.pool);

    await expect(store.getToolPackRevisions(pack.id)).resolves.toEqual(revisions);
    expect(transaction.poolQuery).not.toHaveBeenCalled();
  });

  it("persists Tool Pack current state, immutable revisions, and mutation audits atomically", async () => {
    const harness = statefulFailurePool(createSeedSnapshot(), "", "__never__");
    const store = new PostgresPlatformStore(harness.pool);
    const imageDigest = `sha256:${"a".repeat(64)}`;

    const input: CreateToolPackInput = {
      name: "PostgreSQL Tool Pack",
      version: "1.0.0",
      description: "Read-only documentation search.",
      owner: "Platform Owner",
      sourceReference: `registry.example.com/council/docs@${imageDigest}`,
      imageDigest,
      tools: [{
        name: "search",
        kind: "command",
        goal: "Search documentation.",
        access: "read_only",
        argv: { executable: "/usr/bin/rg", fixedArguments: ["--json"] },
        env: { allowedNames: [] },
        stdin: { mode: "none" }
      }]
    };
    const created = await store.createToolPack(input, "tool-pack-create-retry");
    const validated = await store.validateToolPack(created.id, {
      expectedRevision: 1,
      manifestDigest: created.manifestDigest,
      result: "passed",
      summary: "Manifest reviewed."
    });
    await store.approveToolPack(created.id, {
      expectedRevision: validated.revision,
      manifestDigest: validated.manifestDigest
    });

    const calls = harness.clientQuery.mock.calls;
    const idempotencyLookupIndex = calls.findIndex(([text]) => String(text).includes("FROM idempotency_records"));
    const packIndex = calls.findIndex(([text]) => String(text).includes("INSERT INTO tool_packs"));
    const revisionIndex = calls.findIndex(([text]) => String(text).includes("INSERT INTO tool_pack_revisions"));
    const idempotencyInsertIndex = calls.findIndex(([text]) => String(text).includes("INSERT INTO idempotency_records"));
    const createdAuditIndex = calls.findIndex(([_text, values]) => Array.isArray(values) && values.includes("tool_pack.created"));
    const stateIndex = calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    const commitIndex = calls.findIndex(([text]) => String(text) === "COMMIT");
    expect(calls.filter(([text]) => String(text).includes("INSERT INTO tool_pack_revisions"))).toHaveLength(3);
    expect(calls.filter(([text]) => String(text).includes("INSERT INTO tool_packs"))).toHaveLength(3);
    expect(calls.filter(([text]) => String(text).includes("INSERT INTO audit_events"))).toHaveLength(3);
    expect(calls.some(([_text, values]) => Array.isArray(values) && values.includes("tool_pack.created"))).toBe(true);
    expect(calls.some(([_text, values]) => Array.isArray(values) && values.includes("tool_pack.validation.passed"))).toBe(true);
    expect(calls.some(([_text, values]) => Array.isArray(values) && values.includes("tool_pack.approved"))).toBe(true);
    expect(idempotencyLookupIndex).toBeGreaterThan(-1);
    expect(packIndex).toBeGreaterThan(idempotencyLookupIndex);
    expect(revisionIndex).toBeGreaterThan(packIndex);
    expect(idempotencyInsertIndex).toBeGreaterThan(revisionIndex);
    expect(createdAuditIndex).toBeGreaterThan(idempotencyInsertIndex);
    expect(stateIndex).toBeGreaterThan(createdAuditIndex);
    expect(commitIndex).toBeGreaterThan(stateIndex);
    expect(JSON.stringify(calls)).not.toContain('"secret":');
    expect(JSON.stringify(calls)).not.toContain('"ciphertext":');
  });

  it("replays a PostgreSQL Tool Pack without rewriting registry, revision, audit, or state", async () => {
    const imageDigest = `sha256:${"c".repeat(64)}`;
    const input: CreateToolPackInput = {
      name: "PostgreSQL replayed Tool Pack",
      version: "1.0.0",
      description: "Read-only replay fixture.",
      owner: "Platform Owner",
      sourceReference: `registry.example.com/council/replay@${imageDigest}`,
      imageDigest,
      tools: [{
        name: "search",
        kind: "command",
        goal: "Search documentation.",
        access: "read_only",
        argv: { executable: "/usr/bin/rg", fixedArguments: ["--json"] },
        env: { allowedNames: [] },
        stdin: { mode: "none" }
      }]
    };
    const key = "tool-pack-postgres-cached-retry";
    const cachedPack = await new InMemoryPlatformStore().createToolPack(input);
    const cachedFingerprint = requestFingerprint(input);
    const replayTransaction = transactionPool({ response: cachedPack, requestFingerprint: cachedFingerprint });

    await expect(new PostgresPlatformStore(replayTransaction.pool).createToolPack(input, key))
      .resolves.toEqual(cachedPack);
    expect(replayTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO tool_packs"))).toBe(false);
    expect(replayTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO tool_pack_revisions"))).toBe(false);
    expect(replayTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(replayTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);

    const conflictTransaction = transactionPool({ response: cachedPack, requestFingerprint: cachedFingerprint });
    await expect(new PostgresPlatformStore(conflictTransaction.pool).createToolPack(
      { ...input, description: "Changed request." },
      key
    )).rejects.toMatchObject({ apiCode: "IDEMPOTENCY_KEY_CONFLICT" });
    expect(conflictTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO tool_packs"))).toBe(false);
    expect(conflictTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(conflictTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
  });

  it("persists Runtime Profile current state, immutable revisions, and audit rows in one transaction", async () => {
    const { pool, clientQuery } = transactionPool();
    const store = new PostgresPlatformStore(pool);

    const created = await store.createRuntimeProfile({
      name: "PostgreSQL runtime",
      harnessKind: "openai_compatible",
      modelConnectorId: null,
      sandboxProfileId: null,
      policy: "text_only",
      capabilities: ["text", "abort"],
      timeoutMs: 60_000,
      maxConcurrency: 1,
      enabled: true
    }, "runtime-profile-create-retry");

    expect(created).toMatchObject({ revision: 1, timeoutMs: 60_000 });
    const idempotencyLookupIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("FROM idempotency_records"));
    const profileIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO runtime_profiles"));
    const revisionIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO runtime_profile_revisions"));
    const idempotencyInsertIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO idempotency_records"));
    const auditIndex = clientQuery.mock.calls.findIndex(([_text, values]) => Array.isArray(values) && values.includes("runtime_profile.created"));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    const commitIndex = clientQuery.mock.calls.findIndex(([text]) => String(text) === "COMMIT");

    expect(idempotencyLookupIndex).toBeGreaterThan(-1);
    expect(profileIndex).toBeGreaterThan(idempotencyLookupIndex);
    expect(revisionIndex).toBeGreaterThan(profileIndex);
    expect(idempotencyInsertIndex).toBeGreaterThan(revisionIndex);
    expect(auditIndex).toBeGreaterThan(idempotencyInsertIndex);
    expect(stateIndex).toBeGreaterThan(auditIndex);
    expect(commitIndex).toBeGreaterThan(stateIndex);
  });

  it("persists Credential secret and idempotency evidence atomically without leaking secret proof", async () => {
    const { pool, clientQuery } = transactionPool();
    const store = new PostgresPlatformStore(pool);
    const input = {
      name: "PostgreSQL retry-safe Credential",
      provider: "test-provider",
      kind: "api_key" as const,
      location: "cloud" as const,
      expiresAt: null
    };
    const secret = {
      ciphertext: "v1.randomized-ciphertext",
      idempotencyProof: `hmac-sha256:v1:${"c".repeat(64)}`
    };

    const credential = await store.createCredential(input, secret, "credential-postgres-retry");

    expect(credential).toMatchObject({ name: input.name, hasSecret: true, secretRevision: 1 });
    const secretIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO credential_secrets"));
    const idempotencyIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO idempotency_records"));
    const auditIndex = clientQuery.mock.calls.findIndex(([_text, values]) => Array.isArray(values) && values.includes("credential.created"));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    const commitIndex = clientQuery.mock.calls.findIndex(([text]) => text === "COMMIT");
    const idempotencyCall = clientQuery.mock.calls[idempotencyIndex];
    const auditCall = clientQuery.mock.calls[auditIndex];
    const stateCall = clientQuery.mock.calls[stateIndex];

    expect(secretIndex).toBeGreaterThan(-1);
    expect(idempotencyIndex).toBeGreaterThan(secretIndex);
    expect(auditIndex).toBeGreaterThan(idempotencyIndex);
    expect(stateIndex).toBeGreaterThan(auditIndex);
    expect(commitIndex).toBeGreaterThan(stateIndex);
    expect(idempotencyCall?.[1]).toEqual([
      "credential.create",
      "credential-postgres-retry",
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.any(String)
    ]);
    expect(JSON.stringify(idempotencyCall)).not.toContain(secret.ciphertext);
    expect(JSON.stringify(idempotencyCall)).not.toContain(secret.idempotencyProof);
    expect(JSON.stringify(auditCall)).not.toContain(secret.ciphertext);
    expect(JSON.stringify(auditCall)).not.toContain(secret.idempotencyProof);
    expect(JSON.stringify(stateCall)).not.toContain(secret.ciphertext);
    expect(JSON.stringify(stateCall)).not.toContain(secret.idempotencyProof);
  });

  it("replays a PostgreSQL Credential without rewriting randomized ciphertext, audit, or state", async () => {
    const input = {
      name: "PostgreSQL replayed Credential",
      provider: "test-provider",
      kind: "api_key" as const,
      location: "cloud" as const,
      expiresAt: null
    };
    const key = "credential-postgres-cached-retry";
    const proof = `hmac-sha256:v1:${"d".repeat(64)}`;
    const memory = new InMemoryPlatformStore();
    const cachedCredential = await memory.createCredential(input, { ciphertext: "v1.persisted-ciphertext" });
    const cachedFingerprint = requestFingerprint(credentialCreateIdempotencyInput(
      input,
      { ciphertext: "v1.first-randomized-ciphertext", idempotencyProof: proof },
      key
    ));
    const replayTransaction = transactionPool({ response: cachedCredential, requestFingerprint: cachedFingerprint });

    await expect(new PostgresPlatformStore(replayTransaction.pool).createCredential(
      input,
      { ciphertext: "v1.second-randomized-ciphertext", idempotencyProof: proof },
      key
    )).resolves.toEqual(cachedCredential);
    expect(replayTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO credential_secrets"))).toBe(false);
    expect(replayTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(replayTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);

    const conflictTransaction = transactionPool({ response: cachedCredential, requestFingerprint: cachedFingerprint });
    await expect(new PostgresPlatformStore(conflictTransaction.pool).createCredential(
      input,
      {
        ciphertext: "v1.changed-randomized-ciphertext",
        idempotencyProof: `hmac-sha256:v1:${"e".repeat(64)}`
      },
      key
    )).rejects.toMatchObject({ apiCode: "IDEMPOTENCY_KEY_CONFLICT" });
    expect(conflictTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO credential_secrets"))).toBe(false);
    expect(conflictTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(conflictTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
  });

  it("persists Credential rotation secret, idempotency, audit, and state in one transaction", async () => {
    const memory = new InMemoryPlatformStore();
    const credential = await memory.createCredential({
      name: "PostgreSQL rotated Credential",
      provider: "test-provider",
      kind: "api_key",
      location: "cloud",
      expiresAt: null
    }, { ciphertext: "v1.initial-rotation-ciphertext" });
    const snapshot = await memory.getSnapshot();
    const { pool, clientQuery } = transactionPool(undefined, snapshot, [], {
      credentialSecrets: [{ credentialId: credential.id, ciphertext: "v1.initial-rotation-ciphertext" }]
    });
    const store = new PostgresPlatformStore(pool);
    const rotate = store.rotateCredential.bind(store) as (
      input: { credentialId: string; expectedSecretRevision: number },
      secret: { ciphertext?: string; idempotencyProof?: string },
      maskedHint?: string | null,
      idempotencyKey?: string
    ) => ReturnType<PostgresPlatformStore["rotateCredential"]>;
    const proof = `hmac-sha256:v1:${"a".repeat(64)}`;

    const rotated = await rotate(
      { credentialId: credential.id, expectedSecretRevision: credential.secretRevision },
      { ciphertext: "v1.replacement-rotation-ciphertext", idempotencyProof: proof },
      "****safe",
      "credential-postgres-rotation"
    );

    expect(rotated).toMatchObject({ id: credential.id, secretRevision: 2, maskedHint: "****safe" });
    const secretIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO credential_secrets"));
    const idempotencyIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO idempotency_records"));
    const auditIndex = clientQuery.mock.calls.findIndex(([_text, values]) => Array.isArray(values) && values.includes("credential.rotated"));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    const commitIndex = clientQuery.mock.calls.findIndex(([text]) => text === "COMMIT");
    const idempotencyCall = clientQuery.mock.calls[idempotencyIndex];

    expect(secretIndex).toBeGreaterThan(-1);
    expect(idempotencyIndex).toBeGreaterThan(secretIndex);
    expect(auditIndex).toBeGreaterThan(idempotencyIndex);
    expect(stateIndex).toBeGreaterThan(auditIndex);
    expect(commitIndex).toBeGreaterThan(stateIndex);
    expect(idempotencyCall?.[1]).toEqual([
      "credential.rotate",
      "credential-postgres-rotation",
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.any(String)
    ]);
    expect(JSON.stringify(idempotencyCall)).not.toContain("v1.replacement-rotation-ciphertext");
    expect(JSON.stringify(idempotencyCall)).not.toContain(proof);
  });

  it("replays a PostgreSQL Credential rotation without rewriting secret, audit, or state", async () => {
    const memory = new InMemoryPlatformStore();
    const credential = await memory.createCredential({
      name: "PostgreSQL replayed rotation",
      provider: "test-provider",
      kind: "api_key",
      location: "cloud",
      expiresAt: null
    }, { ciphertext: "v1.initial-replay-ciphertext" });
    const rotated = await memory.rotateCredential(
      { credentialId: credential.id, expectedSecretRevision: credential.secretRevision },
      { ciphertext: "v1.persisted-replay-ciphertext" },
      "****safe"
    );
    const key = "credential-postgres-rotation-replay";
    const proof = `hmac-sha256:v1:${"b".repeat(64)}`;
    const replayInput = {
      metadata: {
        input: { credentialId: credential.id, expectedSecretRevision: credential.secretRevision },
        maskedHint: "****safe"
      },
      idempotencyKey: key,
      secret: { present: true, proof }
    };
    const cachedFingerprint = requestFingerprint(replayInput);
    const harness = transactionPool({ response: rotated, requestFingerprint: cachedFingerprint });
    const store = new PostgresPlatformStore(harness.pool);
    const rotate = store.rotateCredential.bind(store) as (
      input: { credentialId: string; expectedSecretRevision: number },
      secret: { ciphertext?: string; idempotencyProof?: string },
      maskedHint?: string | null,
      idempotencyKey?: string
    ) => ReturnType<PostgresPlatformStore["rotateCredential"]>;

    await expect(rotate(
      { credentialId: credential.id, expectedSecretRevision: credential.secretRevision },
      { ciphertext: "v1.new-randomized-ciphertext", idempotencyProof: proof },
      "****safe",
      key
    )).resolves.toEqual(rotated);
    expect(harness.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO credential_secrets"))).toBe(false);
    expect(harness.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(harness.clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
  });

  it("persists MCP Connector secret and idempotency evidence atomically without leaking secret proof", async () => {
    const { pool, clientQuery } = transactionPool();
    const store = new PostgresPlatformStore(pool) as PostgresPlatformStore & {
      createMcpConnector(
        input: Parameters<PostgresPlatformStore["createMcpConnector"]>[0],
        secret: { ciphertext?: string; idempotencyProof?: string } | undefined,
        idempotencyKey: string
      ): ReturnType<PostgresPlatformStore["createMcpConnector"]>;
    };
    const input = {
      name: "PostgreSQL retry-safe MCP",
      location: "cloud" as const,
      baseUrl: "https://1.1.1.1/mcp",
      approvedTools: ["search_docs"],
      toolRegistrations: [{
        toolName: "search_docs",
        displayName: "Search docs",
        kind: "mcp_tool" as const,
        version: "1.0.0",
        owner: "Platform Owner",
        goal: "Search approved documents."
      }]
    };
    const secret = {
      ciphertext: "v1.randomized-mcp-ciphertext",
      idempotencyProof: `hmac-sha256:v1:${"f".repeat(64)}`
    };

    const connector = await store.createMcpConnector(input, secret, "mcp-postgres-retry");

    expect(connector).toMatchObject({ name: input.name, hasSecret: true, secretRevision: 1 });
    const secretIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO connector_secrets"));
    const idempotencyIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO idempotency_records"));
    const auditIndex = clientQuery.mock.calls.findIndex(([_text, values]) => Array.isArray(values) && values.includes("mcp_connector.created"));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    const commitIndex = clientQuery.mock.calls.findIndex(([text]) => text === "COMMIT");
    const idempotencyCall = clientQuery.mock.calls[idempotencyIndex];
    const auditCall = clientQuery.mock.calls[auditIndex];
    const stateCall = clientQuery.mock.calls[stateIndex];

    expect(secretIndex).toBeGreaterThan(-1);
    expect(idempotencyIndex).toBeGreaterThan(secretIndex);
    expect(auditIndex).toBeGreaterThan(idempotencyIndex);
    expect(stateIndex).toBeGreaterThan(auditIndex);
    expect(commitIndex).toBeGreaterThan(stateIndex);
    expect(idempotencyCall?.[1]).toEqual([
      "mcp_connector.create",
      "mcp-postgres-retry",
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.any(String)
    ]);
    expect(JSON.stringify(idempotencyCall)).not.toContain(secret.ciphertext);
    expect(JSON.stringify(idempotencyCall)).not.toContain(secret.idempotencyProof);
    expect(JSON.stringify(auditCall)).not.toContain(secret.ciphertext);
    expect(JSON.stringify(auditCall)).not.toContain(secret.idempotencyProof);
    expect(JSON.stringify(stateCall)).not.toContain(secret.ciphertext);
    expect(JSON.stringify(stateCall)).not.toContain(secret.idempotencyProof);
  });

  it("persists Model Connector Credential secret and idempotency evidence atomically", async () => {
    const { pool, clientQuery } = transactionPool();
    const store = new PostgresPlatformStore(pool) as PostgresPlatformStore & {
      createModelConnector(
        input: Parameters<PostgresPlatformStore["createModelConnector"]>[0],
        secret: { ciphertext?: string; idempotencyProof?: string } | undefined,
        idempotencyKey: string
      ): ReturnType<PostgresPlatformStore["createModelConnector"]>;
    };
    const input = {
      name: "PostgreSQL retry-safe Model",
      location: "cloud" as const,
      baseUrl: "https://1.1.1.1/v1",
      model: "meeting-model"
    };
    const secret = {
      ciphertext: "v1.randomized-model-ciphertext",
      idempotencyProof: `hmac-sha256:v1:${"3".repeat(64)}`
    };

    const connector = await store.createModelConnector(input, secret, "model-postgres-retry");

    expect(connector).toMatchObject({ name: input.name, hasSecret: true, secretRevision: 1 });
    const secretIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO credential_secrets"));
    const credentialAuditIndex = clientQuery.mock.calls.findIndex(([_text, values]) => Array.isArray(values) && values.includes("credential.created"));
    const idempotencyIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO idempotency_records"));
    const auditIndex = clientQuery.mock.calls.findIndex(([_text, values]) => Array.isArray(values) && values.includes("model_connector.created"));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    const commitIndex = clientQuery.mock.calls.findIndex(([text]) => text === "COMMIT");
    const idempotencyCall = clientQuery.mock.calls[idempotencyIndex];
    const credentialAuditCall = clientQuery.mock.calls[credentialAuditIndex];
    const auditCall = clientQuery.mock.calls[auditIndex];
    const stateCall = clientQuery.mock.calls[stateIndex];

    expect(secretIndex).toBeGreaterThan(-1);
    expect(credentialAuditIndex).toBeGreaterThan(secretIndex);
    expect(idempotencyIndex).toBeGreaterThan(credentialAuditIndex);
    expect(auditIndex).toBeGreaterThan(idempotencyIndex);
    expect(stateIndex).toBeGreaterThan(auditIndex);
    expect(commitIndex).toBeGreaterThan(stateIndex);
    expect(idempotencyCall?.[1]).toEqual([
      "model_connector.create",
      "model-postgres-retry",
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.any(String)
    ]);
    expect(JSON.stringify(idempotencyCall)).not.toContain(secret.ciphertext);
    expect(JSON.stringify(idempotencyCall)).not.toContain(secret.idempotencyProof);
    expect(JSON.stringify(credentialAuditCall)).not.toContain(secret.ciphertext);
    expect(JSON.stringify(credentialAuditCall)).not.toContain(secret.idempotencyProof);
    expect(JSON.stringify(auditCall)).not.toContain(secret.ciphertext);
    expect(JSON.stringify(auditCall)).not.toContain(secret.idempotencyProof);
    expect(JSON.stringify(stateCall)).not.toContain(secret.ciphertext);
    expect(JSON.stringify(stateCall)).not.toContain(secret.idempotencyProof);
  });

  it("loads an existing Credential secret before binding a PostgreSQL Model Connector", async () => {
    const memory = new InMemoryPlatformStore();
    const credential = await memory.createCredential({
      name: "Existing PostgreSQL Model Credential",
      provider: "test-provider",
      kind: "api_key",
      location: "local",
      expiresAt: null
    }, { ciphertext: "v1.existing-model-credential-ciphertext" });
    const snapshot = await memory.getSnapshot();
    const { pool, clientQuery } = transactionPool(undefined, snapshot, [], {
      credentialSecrets: [{
        credentialId: credential.id,
        ciphertext: "v1.existing-model-credential-ciphertext"
      }]
    });

    const connector = await new PostgresPlatformStore(pool).createModelConnector({
      name: "PostgreSQL Model with existing Credential",
      location: "local",
      baseUrl: "http://10.0.0.2:4001/v1",
      model: "local-reviewer",
      credentialId: credential.id
    }, undefined, "model-postgres-existing-credential");

    expect(connector).toMatchObject({
      credentialId: credential.id,
      hasSecret: true,
      secretRevision: credential.secretRevision
    });
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("FROM credential_secrets"))).toBe(true);
  });

  it("replays a PostgreSQL Model Connector without rewriting secret, audit, or state", async () => {
    const input = {
      name: "PostgreSQL replayed Model",
      location: "cloud" as const,
      baseUrl: "https://1.1.1.1/v1",
      model: "meeting-model"
    };
    const key = "model-postgres-cached-retry";
    const proof = `hmac-sha256:v1:${"4".repeat(64)}`;
    const memory = new InMemoryPlatformStore();
    const cachedConnector = await memory.createModelConnector(input, { ciphertext: "v1.persisted-model-ciphertext" });
    const cachedFingerprint = requestFingerprint({
      metadata: input,
      idempotencyKey: key,
      secret: { present: true, proof }
    });
    type IdempotentModelStore = {
      createModelConnector(
        connectorInput: typeof input,
        secret: { ciphertext?: string; idempotencyProof?: string } | undefined,
        idempotencyKey: string
      ): Promise<typeof cachedConnector>;
    };
    const replayTransaction = transactionPool({ response: cachedConnector, requestFingerprint: cachedFingerprint });
    const replayStore = new PostgresPlatformStore(replayTransaction.pool) as unknown as IdempotentModelStore;

    await expect(replayStore.createModelConnector(
      input,
      { ciphertext: "v1.second-randomized-model-ciphertext", idempotencyProof: proof },
      key
    )).resolves.toEqual(cachedConnector);
    expect(replayTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO credential_secrets"))).toBe(false);
    expect(replayTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(replayTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);

    const conflictTransaction = transactionPool({ response: cachedConnector, requestFingerprint: cachedFingerprint });
    const conflictStore = new PostgresPlatformStore(conflictTransaction.pool) as unknown as IdempotentModelStore;
    await expect(conflictStore.createModelConnector(
      input,
      {
        ciphertext: "v1.changed-randomized-model-ciphertext",
        idempotencyProof: `hmac-sha256:v1:${"5".repeat(64)}`
      },
      key
    )).rejects.toMatchObject({ apiCode: "IDEMPOTENCY_KEY_CONFLICT" });
    expect(conflictTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO credential_secrets"))).toBe(false);
    expect(conflictTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(conflictTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
  });

  it("rejects a direct PostgreSQL Model create that supplies plaintext apiKey", async () => {
    const { pool, clientQuery } = transactionPool();
    const plaintext = "must-not-enter-model-state";
    const store = new PostgresPlatformStore(pool);

    await expect(store.createModelConnector({
      name: "Unsafe PostgreSQL plaintext Model",
      location: "cloud",
      baseUrl: "https://1.1.1.1/v1",
      model: "unsafe-model",
      apiKey: plaintext
    } as never)).rejects.toThrow(/plaintext|api key/i);

    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO credential_secrets"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
    expect(JSON.stringify(clientQuery.mock.calls)).not.toContain(plaintext);
  });

  it("replays a PostgreSQL MCP Connector without rewriting randomized ciphertext, audit, or state", async () => {
    const input = {
      name: "PostgreSQL replayed MCP",
      location: "cloud" as const,
      baseUrl: "https://1.1.1.1/mcp",
      approvedTools: ["search_docs"],
      toolRegistrations: [{
        toolName: "search_docs",
        displayName: "Search docs",
        kind: "mcp_tool" as const,
        version: "1.0.0",
        owner: "Platform Owner",
        goal: "Search approved documents."
      }]
    };
    const key = "mcp-postgres-cached-retry";
    const proof = `hmac-sha256:v1:${"a".repeat(64)}`;
    const memory = new InMemoryPlatformStore();
    const cachedConnector = await memory.createMcpConnector(input, { ciphertext: "v1.persisted-mcp-ciphertext" });
    const cachedFingerprint = requestFingerprint({
      metadata: input,
      idempotencyKey: key,
      secret: { present: true, proof }
    });
    type IdempotentMcpStore = {
      createMcpConnector(
        connectorInput: typeof input,
        secret: { ciphertext?: string; idempotencyProof?: string } | undefined,
        idempotencyKey: string
      ): Promise<typeof cachedConnector>;
    };
    const replayTransaction = transactionPool({ response: cachedConnector, requestFingerprint: cachedFingerprint });
    const replayStore = new PostgresPlatformStore(replayTransaction.pool) as unknown as IdempotentMcpStore;

    await expect(replayStore.createMcpConnector(
      input,
      { ciphertext: "v1.second-randomized-mcp-ciphertext", idempotencyProof: proof },
      key
    )).resolves.toEqual(cachedConnector);
    expect(replayTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO connector_secrets"))).toBe(false);
    expect(replayTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(replayTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);

    const conflictTransaction = transactionPool({ response: cachedConnector, requestFingerprint: cachedFingerprint });
    const conflictStore = new PostgresPlatformStore(conflictTransaction.pool) as unknown as IdempotentMcpStore;
    await expect(conflictStore.createMcpConnector(
      input,
      {
        ciphertext: "v1.changed-randomized-mcp-ciphertext",
        idempotencyProof: `hmac-sha256:v1:${"b".repeat(64)}`
      },
      key
    )).rejects.toMatchObject({ apiCode: "IDEMPOTENCY_KEY_CONFLICT" });
    expect(conflictTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO connector_secrets"))).toBe(false);
    expect(conflictTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(conflictTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
  });

  it("persists Task Adapter secret and idempotency evidence atomically without leaking secret proof", async () => {
    const { pool, clientQuery } = transactionPool();
    const store = new PostgresPlatformStore(pool);
    const input = {
      name: "PostgreSQL retry-safe Task Adapter",
      location: "cloud" as const,
      baseUrl: "https://1.1.1.1"
    };
    const secret = {
      ciphertext: "v1.randomized-task-adapter-ciphertext",
      idempotencyProof: `hmac-sha256:v1:${"e".repeat(64)}`
    };

    const connector = await store.createTaskAdapterConnector(input, secret, "task-adapter-postgres-retry");

    expect(connector).toMatchObject({ name: input.name, hasSecret: true });
    const secretIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO connector_secrets"));
    const idempotencyIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO idempotency_records"));
    const auditIndex = clientQuery.mock.calls.findIndex(([_text, values]) => Array.isArray(values) && values.includes("task_adapter.created"));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    const commitIndex = clientQuery.mock.calls.findIndex(([text]) => text === "COMMIT");
    const idempotencyCall = clientQuery.mock.calls[idempotencyIndex];
    const auditCall = clientQuery.mock.calls[auditIndex];
    const stateCall = clientQuery.mock.calls[stateIndex];

    expect(secretIndex).toBeGreaterThan(-1);
    expect(idempotencyIndex).toBeGreaterThan(secretIndex);
    expect(auditIndex).toBeGreaterThan(idempotencyIndex);
    expect(stateIndex).toBeGreaterThan(auditIndex);
    expect(commitIndex).toBeGreaterThan(stateIndex);
    expect(idempotencyCall?.[1]).toEqual([
      "task_adapter.create",
      "task-adapter-postgres-retry",
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.any(String)
    ]);
    expect(JSON.stringify(idempotencyCall)).not.toContain(secret.ciphertext);
    expect(JSON.stringify(idempotencyCall)).not.toContain(secret.idempotencyProof);
    expect(JSON.stringify(auditCall)).not.toContain(secret.ciphertext);
    expect(JSON.stringify(auditCall)).not.toContain(secret.idempotencyProof);
    expect(JSON.stringify(stateCall)).not.toContain(secret.ciphertext);
    expect(JSON.stringify(stateCall)).not.toContain(secret.idempotencyProof);
  });

  it("replays a PostgreSQL Task Adapter without rewriting randomized ciphertext, audit, or state", async () => {
    const input = {
      name: "PostgreSQL replayed Task Adapter",
      location: "cloud" as const,
      baseUrl: "https://1.1.1.1"
    };
    const key = "task-adapter-postgres-cached-retry";
    const proof = `hmac-sha256:v1:${"f".repeat(64)}`;
    const memory = new InMemoryPlatformStore();
    const cachedConnector = await memory.createTaskAdapterConnector(input, { ciphertext: "v1.persisted-task-adapter-ciphertext" });
    const cachedFingerprint = requestFingerprint({
      metadata: input,
      idempotencyKey: key,
      secret: { present: true, proof }
    });
    const replayTransaction = transactionPool({ response: cachedConnector, requestFingerprint: cachedFingerprint });
    const replayStore = new PostgresPlatformStore(replayTransaction.pool);

    await expect(replayStore.createTaskAdapterConnector(
      input,
      { ciphertext: "v1.second-randomized-task-adapter-ciphertext", idempotencyProof: proof },
      key
    )).resolves.toEqual(cachedConnector);
    expect(replayTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO connector_secrets"))).toBe(false);
    expect(replayTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(replayTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);

    const conflictTransaction = transactionPool({ response: cachedConnector, requestFingerprint: cachedFingerprint });
    const conflictStore = new PostgresPlatformStore(conflictTransaction.pool);
    await expect(conflictStore.createTaskAdapterConnector(
      input,
      {
        ciphertext: "v1.changed-randomized-task-adapter-ciphertext",
        idempotencyProof: `hmac-sha256:v1:${"a".repeat(64)}`
      },
      key
    )).rejects.toMatchObject({ apiCode: "IDEMPOTENCY_KEY_CONFLICT" });
    expect(conflictTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO connector_secrets"))).toBe(false);
    expect(conflictTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(conflictTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
  });

  it("reads Role lifecycle state and history from one consistent PostgreSQL statement", async () => {
    const state = createSeedSnapshot();
    const role = state.roles[0]!;
    const versions = [createRoleVersion(role, "legacy_backfilled", null, "2026-07-20T00:00:00.000Z")];
    const poolQuery = vi.fn(async (text: string, values: unknown[]) => {
      expect(text).toContain("jsonb_agg(role_versions.snapshot");
      expect(values).toEqual([role.id]);
      return { rows: [{ state, versions }], rowCount: 1 } as unknown as QueryResult;
    });
    const store = new PostgresPlatformStore({ query: poolQuery } as unknown as Pool);

    await expect(store.getRoleLifecycle(role.id)).resolves.toMatchObject({
      role: { id: role.id, version: role.version },
      versions: [expect.objectContaining({ roleId: role.id, version: role.version })]
    });
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });

  it("updates a Role and records its locked predecessor version in the same transaction", async () => {
    const state = createSeedSnapshot();
    state.roles[0]!.version = 7;
    const roleId = state.roles[0]!.id;
    const { pool, poolQuery, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);

    await expect(store.updateRole(roleId, { responsibility: "以鎖定快照更新角色邊界。" }, 7))
      .resolves.toMatchObject({ version: 8, responsibility: "以鎖定快照更新角色邊界。" });

    const auditIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO audit_events"));
    const agentRevisionWrites = clientQuery.mock.calls.filter(([text]) => String(text).includes("INSERT INTO agent_revisions"));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    const auditValues = clientQuery.mock.calls[auditIndex]?.[1] as unknown[];
    expect(poolQuery).not.toHaveBeenCalled();
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("FOR UPDATE"))).toBe(true);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO role_versions"))).toBe(true);
    expect(JSON.parse(String(auditValues[4]))).toMatchObject({
      fields: ["responsibility"],
      previousVersion: 7,
      version: 8
    });
    expect(auditIndex).toBeGreaterThan(-1);
    expect(stateIndex).toBeGreaterThan(auditIndex);
  });

  it("rejects a stale Role update inside the locked transaction", async () => {
    const state = createSeedSnapshot();
    state.roles[0]!.version = 7;
    const { pool, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);

    await expect(store.updateRole(state.roles[0]!.id, { responsibility: "不得覆寫。" }, 6)).rejects.toMatchObject({
      kind: "revision",
      message: expect.stringMatching(/version changed/i)
    });
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("FOR UPDATE"))).toBe(true);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO role_versions"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
  });

  it("rolls a historical Role definition forward as a new version in one transaction", async () => {
    const state = createSeedSnapshot();
    const role = state.roles[0]!;
    role.version = 2;
    role.responsibility = "目前定義。";
    const historical = {
      roleId: role.id,
      version: 1,
      name: role.name,
      usageContext: "用於初版架構評審。",
      responsibility: "初版定義。",
      speakingGuidance: role.speakingGuidance,
      decisionScope: role.decisionScope,
      constraints: role.constraints,
      templateKey: role.templateKey,
      toolPolicy: role.toolPolicy,
      dataPolicy: role.dataPolicy,
      source: "legacy_backfilled",
      restoredFromVersion: null,
      recordedAt: "2026-07-01T00:00:00.000Z"
    };
    const { pool, clientQuery } = transactionPool(undefined, state, [historical]);
    const store = new PostgresPlatformStore(pool);

    await expect(store.rollbackRole(role.id, 1, 2)).resolves.toMatchObject({ version: 3, usageContext: "用於初版架構評審。", responsibility: "初版定義。" });
    const historyInsert = clientQuery.mock.calls.find(([text]) => String(text).includes("INSERT INTO role_versions"));
    const auditInsert = clientQuery.mock.calls.find(([text]) => String(text).includes("INSERT INTO audit_events"));
    expect(JSON.parse(String(historyInsert?.[1]?.[2]))).toMatchObject({ version: 3, source: "rollback", restoredFromVersion: 1 });
    expect(JSON.parse(String(auditInsert?.[1]?.[4]))).toMatchObject({ previousVersion: 2, version: 3, restoredFromVersion: 1 });
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(true);
  });

  it("records Role creation, initial version, and audit in one transaction", async () => {
    const { pool, clientQuery } = transactionPool();
    const store = new PostgresPlatformStore(pool);

    await store.createRole({
      name: "研究主持",
      usageContext: "用於研究問題與證據收斂。",
      responsibility: "收斂研究證據。",
      speakingGuidance: "先說明來源。",
      decisionScope: "提出候選決議。",
      constraints: "不得把推論當作事實。",
      templateKey: null,
      toolPolicy: "none",
      dataPolicy: "meeting_only"
    });

    const historyIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO role_versions"));
    const auditIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO audit_events"));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    expect(historyIndex).toBeGreaterThan(-1);
    expect(auditIndex).toBeGreaterThan(historyIndex);
    expect(stateIndex).toBeGreaterThan(auditIndex);
  });

  it("tombstones a Role only after the locked Meeting reference check", async () => {
    const state = createSeedSnapshot();
    state.meetings[0]!.state = "closed";
    const role = state.roles[0]!;
    const { pool, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);

    await expect(store.deleteRole(role.id, role.version)).resolves.toEqual({ id: role.id, historicalMeetingCount: 1 });

    const persisted = clientQuery.mock.calls.find(([text]) => String(text).includes("UPDATE platform_state"));
    const next = JSON.parse(String((persisted?.[1] as unknown[] | undefined)?.[0]));
    expect(next.roles.find((candidate: { id: string }) => candidate.id === role.id).deletedAt).toEqual(expect.any(String));
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("FOR UPDATE"))).toBe(true);
    expect(clientQuery.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("role.deleted"))).toBe(true);
  });

  it("rejects Role deletion while a locked unfinished Meeting still references it", async () => {
    const state = createSeedSnapshot();
    const role = state.roles[0]!;
    const { pool, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);

    await expect(store.deleteRole(role.id, role.version)).rejects.toThrow(/unfinished Meeting/i);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("FOR UPDATE"))).toBe(true);
    expect(clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
  });

  it("rejects Role deletion while a locked active Agent Team still references it", async () => {
    const state = createSeedSnapshot();
    state.meetings[0]!.state = "closed";
    const role = state.roles[0]!;
    state.agentTeams = [{
      id: randomUUID(),
      revision: 1,
      name: "Locked role reference",
      description: "Active Team must retain an active Role.",
      members: [
        { agentId: state.agents[0]!.id, roleId: role.id, isChair: true },
        { agentId: state.agents[1]!.id, roleId: state.roles[1]!.id, isChair: false }
      ],
      status: "active",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z"
    }];
    const { pool, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);

    await expect(store.deleteRole(role.id, role.version)).rejects.toThrow(/active Agent Team/i);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("FOR UPDATE"))).toBe(true);
    expect(clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
  });

  it.each([
    ["version persistence", "INSERT INTO role_versions"],
    ["audit persistence", "INSERT INTO audit_events"],
    ["state persistence", "UPDATE platform_state"]
  ])("rolls back a Role update when %s fails", async (_stage, failOn) => {
    const state = createSeedSnapshot();
    const original = structuredClone(state);
    const role = state.roles[0]!;
    const { pool, clientQuery, readDurable } = statefulFailurePool(state, "", failOn);
    const store = new PostgresPlatformStore(pool);

    await expect(store.updateRole(role.id, { responsibility: "不得留下部分寫入。" }, role.version))
      .rejects.toThrow(`Injected failure: ${failOn}`);

    expect(clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
    expect(clientQuery.mock.calls.some(([text]) => text === "COMMIT")).toBe(false);
    const durable = readDurable();
    expect(durable.state).toEqual(original);
    expect(durable.roleVersions).toEqual([]);
    expect(durable.audits).toEqual([]);
  });

  it("rejects a stale Meeting transition against the locked snapshot", async () => {
    const state = createSeedSnapshot();
    const original = state.meetings[0]!;
    original.state = "closed";
    original.summaryState = "pending";
    state.meetings.push({
      ...structuredClone(original),
      id: "80000000-0000-4000-8000-000000000002",
      title: "Next session",
      state: "draft",
      summaryState: "not_requested",
      summaryJobId: null
    });
    const { pool, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);

    await expect(store.setMeetingState(original.id, "paused", "active")).rejects.toMatchObject({
      kind: "revision",
      message: expect.stringMatching(/state changed/i)
    });
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("FOR UPDATE"))).toBe(true);
    expect(clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
  });

  it("rejects a second unfinished Meeting inside the locked platform-state transaction", async () => {
    const state = createSeedSnapshot();
    const { pool, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);

    await expect(store.createMeeting({
      threadId: state.threads[0]!.id,
      title: "Concurrent Meeting",
      goal: "The existing active session must win.",
      mode: "open",
      durationMinutes: 20,
      participants: [{ agentId: state.agents[0]!.id, roleId: state.roles[0]!.id, isChair: true }],
      agendaItems: [{ title: "確認並行限制", description: "不得建立第二場未結束會議。" }]
    }, "meeting-concurrency-key")).rejects.toThrow(/unfinished Meeting/i);

    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("FOR UPDATE"))).toBe(true);
    expect(clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
  });

  it("activates the first Agenda item and audits it before persisting a draft Meeting start", async () => {
    const state = createSeedSnapshot();
    const meeting = state.meetings[0]!;
    meeting.state = "draft";
    meeting.startedAt = null;
    for (const item of meeting.agenda.items) {
      item.status = "pending";
      item.startedAt = null;
      item.resolvedAt = null;
    }
    const previousRevision = meeting.agenda.revision;
    const { pool, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);

    const result = await store.setMeetingState(meeting.id, "active", "draft");
    expect(result.state).toBe("active");
    expect(result.agenda.revision).toBe(previousRevision + 1);
    expect(result.agenda.items[0]).toMatchObject({ id: meeting.agenda.items[0]!.id, status: "current" });
    expect(result.agenda.items.slice(1).every((item) => item.status === "pending")).toBe(true);

    const auditIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO audit_events"));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    const auditValues = clientQuery.mock.calls[auditIndex]?.[1] as unknown[];
    expect(auditValues.slice(1, 4)).toEqual(["meeting.agenda.advanced", "meeting", meeting.id]);
    expect(JSON.parse(String(auditValues[4]))).toEqual({
      action: "activate",
      previousRevision,
      revision: previousRevision + 1,
      currentItemId: meeting.agenda.items[0]!.id,
      source: "meeting_state"
    });
    expect(stateIndex).toBeGreaterThan(auditIndex);
  });

  it("advances the current Agenda item and audits it before state persistence", async () => {
    const state = createSeedSnapshot();
    const meeting = state.meetings[0]!;
    const current = meeting.agenda.items.find((item) => item.status === "current")!;
    const next = meeting.agenda.items.find((item) => item.status === "pending")!;
    const previousRevision = meeting.agenda.revision;
    const { pool, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);

    const result = await store.advanceMeetingAgenda(meeting.id, {
      expectedRevision: previousRevision,
      action: "complete",
      itemId: current.id
    });
    expect(result.agenda.revision).toBe(previousRevision + 1);
    expect(result.agenda.items.find((item) => item.id === current.id)).toMatchObject({ status: "completed" });
    expect(result.agenda.items.find((item) => item.id === next.id)).toMatchObject({ status: "current" });

    const auditIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO audit_events"));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    const auditValues = clientQuery.mock.calls[auditIndex]?.[1] as unknown[];
    expect(auditValues.slice(1, 4)).toEqual(["meeting.agenda.advanced", "meeting", meeting.id]);
    expect(JSON.parse(String(auditValues[4]))).toEqual({
      action: "complete",
      itemId: current.id,
      previousRevision,
      revision: previousRevision + 1,
      currentItemId: next.id
    });
    expect(stateIndex).toBeGreaterThan(auditIndex);
  });

  it("rejects a stale Agenda advance without auditing or persisting state", async () => {
    const state = createSeedSnapshot();
    const meeting = state.meetings[0]!;
    const current = meeting.agenda.items.find((item) => item.status === "current")!;
    const { pool, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);

    await expect(store.advanceMeetingAgenda(meeting.id, {
      expectedRevision: meeting.agenda.revision - 1,
      action: "skip",
      itemId: current.id
    })).rejects.toThrow(/revision changed/i);

    expect(clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
  });

  it("rolls back an Agenda advance when its audit insert fails", async () => {
    const state = createSeedSnapshot();
    const original = structuredClone(state);
    const meeting = state.meetings[0]!;
    const current = meeting.agenda.items.find((item) => item.status === "current")!;
    const { pool, clientQuery, readDurable } = statefulFailurePool(state, "", "INSERT INTO audit_events");
    const store = new PostgresPlatformStore(pool);

    await expect(store.advanceMeetingAgenda(meeting.id, {
      expectedRevision: meeting.agenda.revision,
      action: "complete",
      itemId: current.id
    })).rejects.toThrow(/Injected failure/);

    expect(clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
    expect(clientQuery.mock.calls.some(([text]) => text === "COMMIT")).toBe(false);
    expect(readDurable().state).toEqual(original);
    expect(readDurable().audits).toEqual([]);
  });

  it("updates a Meeting Agenda and records its bounded audit before state persistence", async () => {
    const state = createSeedSnapshot();
    const meeting = state.meetings[0]!;
    const { pool, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);

    await expect(store.setMeetingAgenda(meeting.id, {
      expectedRevision: meeting.agenda.revision,
      items: meeting.agenda.items.map((item) => ({
        id: item.id,
        title: item.status === "pending" && item.position === 1 ? "檢視主要方案與風險" : item.title,
        description: item.description
      }))
    })).resolves.toMatchObject({ agenda: { revision: meeting.agenda.revision + 1 } });

    const auditIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO audit_events"));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    const auditValues = clientQuery.mock.calls[auditIndex]?.[1] as unknown[];
    expect(auditValues.slice(1, 4)).toEqual(["meeting.agenda.updated", "meeting", meeting.id]);
    expect(JSON.parse(String(auditValues[4]))).toMatchObject({
      previousRevision: meeting.agenda.revision,
      revision: meeting.agenda.revision + 1,
      previousItemCount: 3,
      itemCount: 3,
      changedItemIds: [meeting.agenda.items[1]!.id]
    });
    expect(String(auditValues[4])).not.toContain("檢視主要方案與風險");
    expect(stateIndex).toBeGreaterThan(auditIndex);
  });

  it("does not persist or audit an unchanged Agenda and rejects a stale revision", async () => {
    const state = createSeedSnapshot();
    const meeting = state.meetings[0]!;
    const unchangedPool = transactionPool(undefined, state);
    const unchangedStore = new PostgresPlatformStore(unchangedPool.pool);
    const items = meeting.agenda.items.map((item) => ({ id: item.id, title: item.title, description: item.description }));

    await expect(unchangedStore.setMeetingAgenda(meeting.id, {
      expectedRevision: meeting.agenda.revision,
      items
    })).resolves.toMatchObject({ agenda: { revision: meeting.agenda.revision } });
    expect(unchangedPool.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(unchangedPool.clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);

    const stalePool = transactionPool(undefined, state);
    const staleStore = new PostgresPlatformStore(stalePool.pool);
    await expect(staleStore.setMeetingAgenda(meeting.id, {
      expectedRevision: meeting.agenda.revision - 1,
      items
    })).rejects.toThrow(/revision changed/i);
    expect(stalePool.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(stalePool.clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
    expect(stalePool.clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
  });

  it("rolls back an Agenda update when its audit insert fails", async () => {
    const state = createSeedSnapshot();
    const meeting = state.meetings[0]!;
    const { pool, readDurable } = statefulFailurePool(state, "", "INSERT INTO audit_events");
    const store = new PostgresPlatformStore(pool);

    await expect(store.setMeetingAgenda(meeting.id, {
      expectedRevision: meeting.agenda.revision,
      items: meeting.agenda.items.map((item) => ({
        id: item.id,
        title: item.status === "pending" && item.position === 1 ? "交易應回滾" : item.title,
        description: item.description
      }))
    })).rejects.toThrow(/Injected failure/);

    expect(readDurable().state).toEqual(state);
    expect(readDurable().audits).toEqual([]);
  });

  it("updates Model Connector state, secret, assignment count, and audit in one transaction", async () => {
    const state = createSeedSnapshot();
    const connectorId = "c0000000-0000-4000-8000-000000000001";
    state.modelConnectors.push({
      id: connectorId,
      revision: 1,
      name: "Cloud primary",
      location: "cloud",
      baseUrl: "https://models.example.com/v1",
      model: "meeting-v1",
      enabled: true,
      hasSecret: true,
      secretRevision: 1
    });
    state.agents[0]!.modelConnectorId = connectorId;
    state.agents[0]!.lifecycleStatus = "disabled";
    state.agents[0]!.status = "offline";
    state.agents[1]!.modelConnectorId = connectorId;
    const { pool, poolQuery, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);

    await expect(modelConnectorLifecycle(store).updateModelConnector(connectorId, {
      expectedRevision: 1,
      name: "GB10 local",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "qwen3.5-35b-a3b",
      enabled: false
    }, { ciphertext: "encrypted-next" })).resolves.toMatchObject({
      connector: {
        id: connectorId,
        name: "GB10 local",
        location: "local",
        baseUrl: "http://192.168.50.10:4000/v1",
        model: "qwen3.5-35b-a3b",
        enabled: false,
        hasSecret: true,
        secretRevision: 2
      },
      assignedAgentCount: 2
    });

    const secretIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO connector_secrets"));
    const auditIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO audit_events"));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    const commitIndex = clientQuery.mock.calls.findIndex(([text]) => text === "COMMIT");
    const agentRevisionWrites = clientQuery.mock.calls.filter(([text]) => String(text).includes("INSERT INTO agent_revisions"));
    const persistedStateCall = clientQuery.mock.calls[stateIndex];
    const persistedState = JSON.parse(String((persistedStateCall?.[1] as unknown[] | undefined)?.[0]));
    const persistedConnector = persistedState.modelConnectors.find((item: { id: string }) => item.id === connectorId);
    const auditCall = clientQuery.mock.calls[auditIndex];
    const auditValues = Array.isArray(auditCall?.[1]) ? auditCall[1] : [];

    expect(poolQuery).not.toHaveBeenCalled();
    expect(persistedConnector).toMatchObject({
      id: connectorId,
      name: "GB10 local",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "qwen3.5-35b-a3b",
      enabled: false,
      hasSecret: true,
      secretRevision: 2
    });
    expect(persistedState.agents.slice(0, 2).map((agent: { modelConnectorId: string | null }) => agent.modelConnectorId))
      .toEqual([connectorId, connectorId]);
    expect(persistedState.agents.slice(0, 2).map((agent: { status: string }) => agent.status))
      .toEqual(["offline", "attention"]);
    expect(auditValues[1]).toBe("model_connector.updated");
    expect(auditValues[2]).toBe("model_connector");
    expect(JSON.parse(String(auditValues[4]))).toMatchObject({
      fields: expect.arrayContaining(["name", "location", "baseUrl", "model", "enabled"]),
      secretRotated: true,
      enabled: false,
      assignedAgentCount: 2
    });
    expect(secretIndex).toBeGreaterThan(-1);
    expect(auditIndex).toBeGreaterThan(secretIndex);
    expect(stateIndex).toBeGreaterThan(auditIndex);
    expect(commitIndex).toBeGreaterThan(stateIndex);
  });

  it("does not persist or audit unchanged Model and MCP Connector updates", async () => {
    const state = createSeedSnapshot();
    state.modelConnectors.push({
      id: "c0000000-0000-4000-8000-000000000011",
      revision: 1,
      name: "No-op model",
      location: "cloud",
      baseUrl: "https://models.example.com/v1",
      model: "meeting-v1",
      enabled: true,
      hasSecret: false,
      secretRevision: 0
    });
    state.mcpConnectors.push({
      id: "d0000000-0000-4000-8000-000000000011",
      revision: 1,
      name: "No-op MCP",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"],
      toolRegistrations: [{ toolName: "search", displayName: "search", kind: "mcp_tool", version: "unversioned", owner: "Platform Owner", goal: "以唯讀方式執行 search。" }],
      enabled: true,
      hasSecret: false
    });

    const modelHarness = transactionPool(undefined, state);
    await expect(new PostgresPlatformStore(modelHarness.pool).updateModelConnector(
      state.modelConnectors[0]!.id,
      { expectedRevision: 1, model: "meeting-v1" }
    )).resolves.toMatchObject({ connector: { revision: 1 } });
    expect(modelHarness.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(modelHarness.clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);

    const mcpHarness = transactionPool(undefined, state);
    await expect(new PostgresPlatformStore(mcpHarness.pool).updateMcpConnector(
      state.mcpConnectors[0]!.id,
      { expectedRevision: 1, approvedTools: ["search"] }
    )).resolves.toMatchObject({ connector: { revision: 1 }, revokedGrantCount: 0 });
    expect(mcpHarness.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(mcpHarness.clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
  });

  it("persists and audits a Credential generated by an internal Model Connector update", async () => {
    const state = createSeedSnapshot();
    const connectorId = "c0000000-0000-4000-8000-000000000013";
    state.modelConnectors.push({
      id: connectorId,
      revision: 1,
      name: "Deferred secret Model",
      location: "cloud",
      baseUrl: "https://models.example.com/v1",
      model: "meeting-v1",
      enabled: true,
      hasSecret: false,
      secretRevision: 0,
      credentialId: null
    });
    const { pool, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);

    const result = await store.updateModelConnector(
      connectorId,
      { expectedRevision: 1, model: "meeting-v2" },
      { ciphertext: "encrypted-deferred-model-secret" }
    );

    expect(result.connector).toMatchObject({
      id: connectorId,
      revision: 2,
      credentialId: connectorId,
      hasSecret: true,
      secretRevision: 1
    });
    const secretIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO credential_secrets"));
    const credentialAuditIndex = clientQuery.mock.calls.findIndex(([_text, values]) => Array.isArray(values) && values.includes("credential.created"));
    const modelAuditIndex = clientQuery.mock.calls.findIndex(([_text, values]) => Array.isArray(values) && values.includes("model_connector.updated"));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    expect(secretIndex).toBeGreaterThan(-1);
    expect(credentialAuditIndex).toBeGreaterThan(secretIndex);
    expect(modelAuditIndex).toBeGreaterThan(credentialAuditIndex);
    expect(stateIndex).toBeGreaterThan(modelAuditIndex);
    expect(JSON.stringify(clientQuery.mock.calls[credentialAuditIndex])).not.toContain("encrypted-deferred-model-secret");
  });

  it("rolls back a stale Connector revision before durable side effects", async () => {
    const state = createSeedSnapshot();
    state.mcpConnectors.push({
      id: "d0000000-0000-4000-8000-000000000012",
      revision: 2,
      name: "Current MCP",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: [],
      toolRegistrations: [],
      enabled: true,
      hasSecret: false
    });
    const harness = transactionPool(undefined, state);

    await expect(new PostgresPlatformStore(harness.pool).updateMcpConnector(
      state.mcpConnectors[0]!.id,
      { expectedRevision: 1, name: "Stale MCP" }
    )).rejects.toMatchObject({ kind: "revision" });
    expect(harness.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO connector_secrets"))).toBe(false);
    expect(harness.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(harness.clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
    expect(harness.clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
  });

  it("does not overwrite a persisted Model Connector secret with a blank store-boundary value", async () => {
    const state = createSeedSnapshot();
    const connectorId = "c0000000-0000-4000-8000-000000000002";
    state.modelConnectors.push({
      id: connectorId,
      revision: 1,
      name: "Secret model",
      location: "cloud",
      baseUrl: "https://models.example.com/v1",
      model: "meeting-v1",
      enabled: true,
      hasSecret: true,
      secretRevision: 1
    });
    const { pool, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);

    await expect(modelConnectorLifecycle(store).updateModelConnector(
      connectorId,
      { expectedRevision: 1, model: "meeting-v2" },
      { ciphertext: "" }
    )).resolves.toMatchObject({ connector: { hasSecret: true, model: "meeting-v2", secretRevision: 1 } });

    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO connector_secrets"))).toBe(false);
    const auditCall = clientQuery.mock.calls.find(([text]) => String(text).includes("INSERT INTO audit_events"));
    const auditValues = Array.isArray(auditCall?.[1]) ? auditCall[1] : [];
    expect(JSON.parse(String(auditValues[4]))).toMatchObject({ secretRotated: false });
  });

  it.each([
    ["secret persistence", "INSERT INTO connector_secrets"],
    ["audit persistence", "INSERT INTO audit_events"],
    ["state persistence", "UPDATE platform_state"]
  ])("rolls back a Model Connector update when %s fails", async (_stage, failOn) => {
    const state = createSeedSnapshot();
    const connectorId = "c0000000-0000-4000-8000-000000000003";
    state.modelConnectors.push({
      id: connectorId,
      revision: 1,
      name: "Rollback model",
      location: "cloud",
      baseUrl: "https://models.example.com/v1",
      model: "meeting-v1",
      enabled: true,
      hasSecret: true,
      secretRevision: 1
    });
    const { pool, clientQuery, readDurable } = statefulFailurePool(state, connectorId, failOn);
    const store = new PostgresPlatformStore(pool);

    await expect(modelConnectorLifecycle(store).updateModelConnector(
      connectorId,
      { expectedRevision: 1, model: "meeting-v2", enabled: false },
      { ciphertext: "encrypted-next" }
    )).rejects.toThrow(`Injected failure: ${failOn}`);

    expect(clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
    expect(clientQuery.mock.calls.some(([text]) => text === "COMMIT")).toBe(false);
    const durable = readDurable();
    expect(durable.state).toEqual(state);
    expect(durable.secrets.get(connectorId)).toBe("encrypted-original");
    expect(durable.audits).toEqual([]);
  });

  it("governs Skill lifecycle, pruning, and its audit in one transaction", async () => {
    const state = createSeedSnapshot();
    state.agents[2]!.skillIds = [state.skills[0]!.id];
    const { pool, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);
    const result = await store.revokeSkill(state.skills[0]!.id, { reason: "Superseded." });

    const audits = clientQuery.mock.calls.filter(([text]) => String(text).includes("INSERT INTO audit_events"));
    const agentRevisionWrites = clientQuery.mock.calls.filter(([text]) => String(text).includes("INSERT INTO agent_revisions"));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    const commitIndex = clientQuery.mock.calls.findIndex(([text]) => text === "COMMIT");
    expect(result).toMatchObject({ skill: { status: "revoked" }, revokedAssignmentCount: 3 });
    expect(agentRevisionWrites).toHaveLength(3);
    expect(agentRevisionWrites.map(([_text, values]) => values?.[0])).toEqual(expect.arrayContaining(
      state.agents.map((agent) => agent.id)
    ));
    expect(agentRevisionWrites.every(([_text, values]) => values?.[1] === 2)).toBe(true);
    expect(audits.some(([_text, values]) => Array.isArray(values) && values.includes("skill.revoked"))).toBe(true);
    expect(stateIndex).toBeGreaterThan(clientQuery.mock.calls.lastIndexOf(audits.at(-1)!));
    expect(commitIndex).toBeGreaterThan(stateIndex);
  });
  it("updates MCP state, secret, grant revocation, and audit in one transaction", async () => {
    const state = createSeedSnapshot();
    const connectorId = "d0000000-0000-4000-8000-000000000001";
    state.mcpConnectors.push({
      id: connectorId,
      revision: 1,
      name: "Docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search", "read"],
      toolRegistrations: [
        { toolName: "search", displayName: "search", kind: "mcp_tool", version: "unversioned", owner: "Platform Owner", goal: "以唯讀方式執行 search。" },
        { toolName: "read", displayName: "read", kind: "mcp_tool", version: "unversioned", owner: "Platform Owner", goal: "以唯讀方式執行 read。" }
      ],
      enabled: true,
      hasSecret: false
    });
    state.agents[0]!.toolGrants = [{ connectorId, toolName: "read" }];
    const { pool, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);

    await expect(store.updateMcpConnector(connectorId, {
      expectedRevision: 1,
      approvedTools: ["search"],
      enabled: false
    }, { ciphertext: "encrypted-token" })).resolves.toMatchObject({
      connector: { id: connectorId, enabled: false, hasSecret: true },
      revokedGrantCount: 1
    });

    const secretIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO connector_secrets"));
    const auditIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO audit_events"));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    const commitIndex = clientQuery.mock.calls.findIndex(([text]) => text === "COMMIT");
    const agentRevisionWrites = clientQuery.mock.calls.filter(([text]) => String(text).includes("INSERT INTO agent_revisions"));
    const persistedStateCall = clientQuery.mock.calls[stateIndex];
    const persistedState = JSON.parse(String((persistedStateCall?.[1] as unknown[] | undefined)?.[0]));
    expect(persistedState.agents[0].toolGrants).toEqual([]);
    expect(persistedState.agents[0].draftRevision).toBe(2);
    expect(agentRevisionWrites).toHaveLength(1);
    expect(agentRevisionWrites[0]?.[1]?.[0]).toBe(state.agents[0]!.id);
    expect(agentRevisionWrites[0]?.[1]?.[1]).toBe(2);
    expect(secretIndex).toBeGreaterThan(-1);
    expect(auditIndex).toBeGreaterThan(secretIndex);
    expect(stateIndex).toBeGreaterThan(auditIndex);
    expect(commitIndex).toBeGreaterThan(stateIndex);
    expect(clientQuery.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("mcp_connector.updated"))).toBe(true);
  });

  it("loads immutable Agent revision history for PostgreSQL MCP admission and commit", async () => {
    const seed = createSeedSnapshot();
    const connectorId = "d0000000-0000-4000-8000-000000000061";
    const connector = {
      id: connectorId,
      revision: 1,
      name: "Historical Grant Docs",
      location: "local" as const,
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"],
      toolRegistrations: [{ toolName: "search", displayName: "search", kind: "mcp_tool" as const, version: "1.0.0", owner: "Platform Owner", goal: "搜尋政策。" }],
      enabled: true,
      hasSecret: false
    };
    seed.mcpConnectors.push(connector);
    seed.agents[0]!.toolGrants = [{ connectorId, toolName: "search" }];
    const memory = new InMemoryPlatformStore(seed);
    const agentId = seed.agents[0]!.id;
    const meetingId = seed.meetings[0]!.id;
    const participant = (await memory.getSnapshot()).participants.find((item) => item.meetingId === meetingId && item.agentId === agentId)!;
    await memory.updateAgent(agentId, { toolGrants: [] });
    const prepared = await memory.getSnapshot();
    const managementHistory = { agentRevisions: await memory.getAgentRevisions(agentId) };
    const toolSnapshot = { connectorName: connector.name, ...connector.toolRegistrations[0]! };
    const input = {
      meetingId,
      agentId,
      participantId: participant.id,
      roleRevision: participant.roleRevision,
      roleId: participant.roleId,
      roleVersion: participant.roleSnapshot.version,
      connectorId,
      toolName: "search",
      toolSnapshot,
      connectorFingerprint: mcpConnectorExecutionFingerprint(connector, null),
      requestFingerprint: "historical-grant-fingerprint"
    };

    const admissionTransaction = transactionPool(undefined, prepared, [], managementHistory);
    await expect(new PostgresPlatformStore(admissionTransaction.pool).admitMcpToolCall("historical-grant-job", {
      ...input,
      acceptedRequestFingerprints: [input.requestFingerprint]
    })).resolves.toMatchObject({ status: "reserved" });
    expect(admissionTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("FROM agent_revisions"))).toBe(true);
    expect(admissionTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("FROM prompt_versions"))).toBe(false);
    expect(admissionTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("FROM runtime_profile_revisions"))).toBe(false);
    expect(admissionTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("FROM tool_pack_revisions"))).toBe(false);
    expect(admissionTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("FROM credential_secrets"))).toBe(false);

    const commitTransaction = transactionPool(undefined, prepared, [], managementHistory);
    await expect(new PostgresPlatformStore(commitTransaction.pool).commitMcpToolRun({
      ...input,
      jobId: "historical-grant-commit",
      status: "succeeded",
      content: "{\"documents\":1}"
    })).resolves.toMatchObject({ status: "created", utterance: { kind: "verified" } });
    expect(commitTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("FROM agent_revisions"))).toBe(true);
    expect(commitTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("FROM prompt_versions"))).toBe(false);
    expect(commitTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("FROM runtime_profile_revisions"))).toBe(false);
    expect(commitTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("FROM tool_pack_revisions"))).toBe(false);
    expect(commitTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("FROM credential_secrets"))).toBe(false);
  });

  it("loads secret-bearing MCP connector credentials for admit, reserve, and commit in PostgreSQL transactions", async () => {
    const seed = createSeedSnapshot();
    const connectorId = "d0000000-0000-4000-8000-000000000081";
    const connectorSecret = "encrypted-mcp-secret";
    const connector = {
      id: connectorId,
      revision: 1,
      name: "Search MCP",
      location: "local" as const,
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"],
      toolRegistrations: [
        { toolName: "search", displayName: "search", kind: "mcp_tool" as const, version: "1.0.0", owner: "Knowledge Team", goal: "搜尋政策。" }
      ],
      enabled: true,
      hasSecret: true
    };
    seed.mcpConnectors.push(connector);
    seed.agents[0]!.toolGrants = [{ connectorId, toolName: "search" }];
    const memory = new InMemoryPlatformStore(seed);
    const snapshot = await memory.getSnapshot();
    const agentId = snapshot.agents[0]!.id;
    const meetingId = snapshot.meetings[0]!.id;
    const participant = snapshot.participants.find((item) => item.meetingId === meetingId && item.agentId === agentId)!;
    const connectorFingerprint = mcpConnectorExecutionFingerprint(connector, connectorSecret);
    const toolRegistration = { connectorName: connector.name, ...connector.toolRegistrations[0]! };
    const input = {
      meetingId,
      agentId,
      participantId: participant.id,
      roleRevision: participant.roleRevision,
      roleId: participant.roleId,
      roleVersion: participant.roleSnapshot.version,
      connectorId,
      toolName: "search",
      toolSnapshot: toolRegistration,
      connectorFingerprint,
      requestFingerprint: "mcp-secret-request"
    };
    const managementHistory = {
      agentRevisions: await memory.getAgentRevisions(agentId),
      connectorSecrets: [{ connectorId, ciphertext: connectorSecret }]
    };

    const reserveTransaction = transactionPool(undefined, snapshot, [], managementHistory);
    await expect(new PostgresPlatformStore(reserveTransaction.pool).reserveMcpToolCall(
      "mcp-secret-job",
      input
    )).resolves.toMatchObject({ kind: "mcp_tool_call", jobId: "mcp-secret-job" });
    expect(reserveTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("FROM connector_secrets"))).toBe(true);

    const admitTransaction = transactionPool(undefined, snapshot, [], managementHistory);
    await expect(new PostgresPlatformStore(admitTransaction.pool).admitMcpToolCall("mcp-secret-job", {
      ...input,
      acceptedRequestFingerprints: [input.requestFingerprint]
    })).resolves.toMatchObject({ status: "reserved", run: null });
    expect(admitTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("FROM connector_secrets"))).toBe(true);

    const commitSeed = new InMemoryPlatformStore(seed, {
      connectorSecrets: [{ connectorId, ciphertext: connectorSecret }]
    });
    await commitSeed.reserveMcpToolCall("mcp-secret-job-commit", input);
    const reservedSnapshot = await commitSeed.getSnapshot();
    const commitTransaction = transactionPool(undefined, reservedSnapshot, [], {
      agentRevisions: await commitSeed.getAgentRevisions(agentId),
      connectorSecrets: [{ connectorId, ciphertext: connectorSecret }]
    });
    await expect(new PostgresPlatformStore(commitTransaction.pool).commitMcpToolRun({
      ...input,
      requestFingerprint: input.requestFingerprint,
      jobId: "mcp-secret-job-commit",
      meetingId,
      status: "succeeded",
      content: "{}",
      connectorFingerprint,
      reservationRequired: true
    })).resolves.toMatchObject({ status: "created", run: { status: "succeeded", connectorId, toolName: "search" }, meetingPaused: false });
    expect(commitTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("FROM connector_secrets"))).toBe(true);
    expect(commitTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("FROM credential_secrets"))).toBe(false);

    const staleCommit = await commitSeed.getSnapshot();
    const staleCommitTransaction = transactionPool(undefined, staleCommit, [], {
      agentRevisions: await commitSeed.getAgentRevisions(agentId),
      connectorSecrets: [{ connectorId, ciphertext: connectorSecret }]
    });
    await expect(new PostgresPlatformStore(staleCommitTransaction.pool).commitMcpToolRun({
      ...input,
      requestFingerprint: "stale-request",
      jobId: "mcp-secret-job-commit",
      meetingId,
      status: "succeeded",
      content: "{}",
      connectorFingerprint: mcpConnectorExecutionFingerprint(connector, "previous-secret"),
      reservationRequired: true
    })).resolves.toMatchObject({ status: "stale", run: null, meetingPaused: false });
  });

  it("hydrates the exact Agent and Prompt bindings before an atomic PostgreSQL turn commit", async () => {
    const seed = createSeedSnapshot();
    seed.meetings[0]!.mode = "open";
    const memory = new InMemoryPlatformStore(seed);
    const initial = await memory.getSnapshot();
    const agentId = initial.agents[0]!.id;
    const prompt = await memory.createPrompt({
      name: "Atomic commit Prompt",
      kind: "agent",
      description: "Keep the final PostgreSQL binding fence testable.",
      owner: "Test Owner",
      content: "Stay within the Meeting scope.",
      variables: []
    });
    await memory.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 });
    const connector = await memory.createModelConnector({
      name: "Atomic commit local model",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "atomic-commit"
    });
    await memory.setAgentModel(agentId, { modelConnectorId: connector.id });
    await memory.updateAgent(agentId, { promptBinding: { promptId: prompt.id, version: 1 } });
    const draft = (await memory.getSnapshot()).agents.find((item) => item.id === agentId)!;
    await memory.publishAgent(agentId, { expectedDraftRevision: draft.draftRevision! });

    const readySnapshot = await memory.getSnapshot();
    const agent = readySnapshot.agents.find((item) => item.id === agentId)!;
    const revision = await memory.getAgentRevision(agentId, agent.publishedRevision!);
    const participant = readySnapshot.participants.find((item) => item.meetingId === readySnapshot.meetings[0]!.id && item.agentId === agentId)!;
    participant.agentRevision = revision.revision;
    const runtimeProfileRevision = readySnapshot.runtimeProfileRevisions!.find((item) => (
      item.profileId === revision.runtimeProfileBinding?.profileId
      && item.revision === revision.runtimeProfileBinding.revision
    ))!;
    const executionBinding = {
      agentRevision: revision.revision,
      promptBinding: { promptId: prompt.id, version: 1 },
      runtimeProfileBinding: revision.runtimeProfileBinding!,
      runtimeProfileSnapshot: createRuntimeProfileSnapshot(runtimeProfileRevision)
    };
    const commitInput = {
      meetingId: readySnapshot.meetings[0]!.id,
      agentId,
      participantId: participant.id,
      roleRevision: participant.roleRevision,
      roleId: participant.roleId,
      roleVersion: participant.roleSnapshot.version,
      turnId: "postgres-bound-turn",
      agendaRevision: readySnapshot.meetings[0]!.agenda.revision,
      speakerName: revision.name,
      roleName: participant.roleSnapshot.responsibility,
      content: "Bound response.",
      modelConnectorId: connector.id,
      modelConnectorSnapshot: {
        id: connector.id,
        location: connector.location,
        baseUrl: connector.baseUrl,
        model: connector.model,
        enabled: connector.enabled,
        secretRevision: connector.secretRevision
      },
      skillDigests: Object.fromEntries(revision.skillIds.map((skillId) => {
        const skill = readySnapshot.skills.find((item) => item.id === skillId)!;
        return [skillId, skill.contentDigest];
      })),
      executionBinding,
      auditDetail: { classification: "atomic_binding_test" }
    };
    const managementHistory = {
      agentRevisions: await memory.getAgentRevisions(agentId),
      promptVersions: await memory.getPromptVersions(prompt.id)
    };

    await expect(new InMemoryPlatformStore(readySnapshot, managementHistory).commitAgentTurn({
      ...commitInput,
      turnId: "memory-bound-turn"
    })).resolves.toMatchObject({ status: "created" });

    const accepted = transactionPool(undefined, readySnapshot, [], managementHistory);
    await expect(new PostgresPlatformStore(accepted.pool).commitAgentTurn(commitInput)).resolves.toMatchObject({
      status: "created",
      utterance: { turnId: "postgres-bound-turn" }
    });
    expect(accepted.clientQuery.mock.calls.some(([text]) => String(text).includes("FROM agent_revisions"))).toBe(true);
    expect(accepted.clientQuery.mock.calls.some(([text]) => String(text).includes("FROM prompt_versions"))).toBe(true);

    const currentPrompt = (await memory.getSnapshot()).prompts!.find((item) => item.id === prompt.id)!;
    await memory.archivePrompt(prompt.id, { expectedCurrentVersion: currentPrompt.currentVersion });
    const archivedSnapshot = await memory.getSnapshot();
    archivedSnapshot.participants.find((item) => item.id === participant.id)!.agentRevision = revision.revision;
    const rejected = transactionPool(undefined, archivedSnapshot, [], managementHistory);
    await expect(new PostgresPlatformStore(rejected.pool).commitAgentTurn({
      ...commitInput,
      turnId: "postgres-stale-bound-turn"
    })).resolves.toMatchObject({ status: "stale", utterance: null });
    expect(rejected.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO utterance_projection"))).toBe(false);
    expect(rejected.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
  });

  it("commits a Meeting summary projection, audit, and delivery state in one transaction", async () => {
    const state = createSeedSnapshot();
    const meetingId = state.meetings[0]!.id;
    state.meetings[0]!.state = "closed";
    state.meetings[0]!.summaryState = "pending";
    state.meetings[0]!.summaryJobId = "summary-job";
    const { pool, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);

    await expect(store.commitMeetingSummary({
      meetingId,
      jobId: "summary-job",
      utterance: {
        turnId: `meeting-summary:${meetingId}`,
        speakerType: "system",
        speakerName: "Council",
        roleName: null,
        content: "Bounded Meeting summary.",
        kind: "system",
        evidenceCount: 1
      },
      auditDetail: { decisionCount: 1 }
    })).resolves.toMatchObject({
      status: "created",
      meeting: { summaryState: "completed", summaryJobId: "summary-job" },
      utterance: { meetingId, turnId: `meeting-summary:${meetingId}` }
    });

    const projectionIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO meeting_utterances"));
    const auditIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO audit_events"));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    const commitIndex = clientQuery.mock.calls.findIndex(([text]) => text === "COMMIT");
    const persisted = JSON.parse(String(clientQuery.mock.calls[stateIndex]?.[1]?.[0])) as PlatformSnapshot;
    expect(persisted.meetings[0]).toMatchObject({ summaryState: "completed", summaryJobId: "summary-job" });
    expect(projectionIndex).toBeGreaterThan(-1);
    expect(auditIndex).toBeGreaterThan(projectionIndex);
    expect(stateIndex).toBeGreaterThan(auditIndex);
    expect(commitIndex).toBeGreaterThan(stateIndex);
  });

  it("rolls back a Meeting summary when its durable audit write fails", async () => {
    const state = createSeedSnapshot();
    const meetingId = state.meetings[0]!.id;
    state.meetings[0]!.state = "closed";
    state.meetings[0]!.summaryState = "pending";
    state.meetings[0]!.summaryJobId = "summary-job";
    const { pool, clientQuery, readDurable } = statefulFailurePool(state, "", "INSERT INTO audit_events");
    const store = new PostgresPlatformStore(pool);

    await expect(store.commitMeetingSummary({
      meetingId,
      jobId: "summary-job",
      utterance: {
        turnId: `meeting-summary:${meetingId}`,
        speakerType: "system",
        speakerName: "Council",
        roleName: null,
        content: "This summary must roll back.",
        kind: "system",
        evidenceCount: 0
      },
      auditDetail: { decisionCount: 0 }
    })).rejects.toThrow("Injected failure");

    expect(readDurable().state.meetings[0]).toMatchObject({ summaryState: "pending", summaryJobId: "summary-job" });
    expect(readDurable().state.utterances.some((item) => item.turnId === `meeting-summary:${meetingId}`)).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
    expect(clientQuery.mock.calls.some(([text]) => text === "COMMIT")).toBe(false);
  });

  it("updates a Topic, persists thread fields, and writes thread.updated audit in one transaction", async () => {
    const state = createSeedSnapshot();
    state.meetings[0]!.state = "closed";
    const { pool, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);

    const thread = state.threads[0]!.id;
    const updated = await store.updateThread(thread, {
      expectedRevision: state.threads[0]!.revision,
      title: "更新後主題標題",
      summary: "更新摘要",
      tagIds: [state.tags[0]!.id],
      status: "resolved"
    });

    const persistedStateCall = clientQuery.mock.calls.find(([text]) => String(text).includes("UPDATE platform_state"));
    const persistedState = JSON.parse(String((persistedStateCall?.[1] as unknown[] | undefined)?.[0]));
    const updatedThread = persistedState.threads.find((item: { id: string }) => item.id === thread);
    const auditCall = clientQuery.mock.calls.find(([text]) => String(text).includes("INSERT INTO audit_events"));
    const auditValues = Array.isArray(auditCall?.[1]) ? auditCall[1] : [];
    const auditIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO audit_events"));
    const commitIndex = clientQuery.mock.calls.findIndex(([text]) => text === "COMMIT");

    expect(updated).toMatchObject({ id: thread, title: "更新後主題標題", summary: "更新摘要", tagIds: [state.tags[0]!.id], status: "resolved" });
    expect(updatedThread).toMatchObject({ id: thread, title: "更新後主題標題", summary: "更新摘要", tagIds: [state.tags[0]!.id], status: "resolved" });
    expect(auditCall).toBeTruthy();
    expect(auditValues[1]).toBe("thread.updated");
    expect(JSON.parse(String(auditValues[4]))).toMatchObject({ previousStatus: "open", status: "resolved" });
    expect(auditIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(auditIndex);
  });

  it("rejects a stale Topic revision without persisting state or audit", async () => {
    const state = createSeedSnapshot();
    state.threads[0]!.revision = 2;
    const { pool, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);

    await expect(store.updateThread(state.threads[0]!.id, {
      expectedRevision: 1,
      summary: "Stale overwrite"
    })).rejects.toThrow(/revision is stale/i);

    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
  });

  it("rejects an unrunnable Agent Team member inside the locked transaction", async () => {
    const state = createSeedSnapshot();
    const { pool, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);

    await expect(store.createAgentTeam({
      name: "Unrunnable Team",
      description: "The Store transaction is authoritative.",
      members: [{ agentId: state.agents[0]!.id, roleId: state.roles[0]!.id, isChair: true }]
    })).rejects.toThrow(/runnable current published revision/i);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
  });

  it("hydrates management history before creating a ready Agent Team", async () => {
    const fixture = await postgresTeamReadyFixture();
    const transaction = transactionPool(undefined, fixture.state, [], fixture.history);

    await expect(new PostgresPlatformStore(transaction.pool).createAgentTeam({
      name: "PostgreSQL ready Team",
      description: "Creation must validate the durable published Agent revision.",
      members: [{
        agentId: fixture.agentId,
        roleId: fixture.state.roles[0]!.id,
        isChair: true
      }]
    }, "postgres-ready-team-create")).resolves.toMatchObject({
      name: "PostgreSQL ready Team",
      status: "active"
    });
    expect(transaction.clientQuery.mock.calls.some(([text]) => String(text).includes("FROM agent_revisions"))).toBe(true);
    expect(transaction.clientQuery.mock.calls.some(([text]) => String(text).includes("FROM runtime_profile_revisions"))).toBe(true);
  });

  it("hydrates management history before creating a Preset for a ready Agent Team", async () => {
    const fixture = await postgresTeamReadyFixture();
    const team = await fixture.memory.createAgentTeam({
      name: "PostgreSQL Preset-ready Team",
      description: "The Preset transaction must revalidate its durable Team members.",
      members: [{
        agentId: fixture.agentId,
        roleId: fixture.state.roles[0]!.id,
        isChair: true
      }]
    });
    const state = await fixture.memory.getSnapshot();
    const transaction = transactionPool(undefined, state, [], fixture.history);

    await expect(new PostgresPlatformStore(transaction.pool).createMeetingPreset({
      name: "PostgreSQL ready Preset",
      description: "Creation must validate the Team's durable Agent revision.",
      teamId: team.id,
      mode: "chaired",
      automation: "suggest",
      durationMinutes: 30,
      agendaItems: [{ title: "Review", description: "Review the bounded objective." }]
    }, "postgres-ready-preset-create")).resolves.toMatchObject({
      name: "PostgreSQL ready Preset",
      status: "active",
      teamId: team.id
    });
    expect(transaction.clientQuery.mock.calls.some(([text]) => String(text).includes("FROM agent_revisions"))).toBe(true);
    expect(transaction.clientQuery.mock.calls.some(([text]) => String(text).includes("FROM runtime_profile_revisions"))).toBe(true);
  });

  it("rejects an active Team update when its locked member runtime is no longer runnable", async () => {
    const state = createSeedSnapshot();
    const connectorId = "d0000000-0000-4000-8000-000000000090";
    state.modelConnectors.push({
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
    state.agents[0]!.modelConnectorId = connectorId;
    const memory = new InMemoryPlatformStore(state);
    const ready = await memory.getSnapshot();
    const team = await memory.createAgentTeam({
      name: "Locked readiness Team",
      description: "Ready before the concurrent change.",
      members: [{ agentId: ready.agents[0]!.id, roleId: ready.roles[0]!.id, isChair: true }]
    });
    const broken = await memory.getSnapshot();
    broken.modelConnectors.find((connector) => connector.id === connectorId)!.enabled = false;
    const { pool, clientQuery } = transactionPool(undefined, broken);

    await expect(new PostgresPlatformStore(pool).updateAgentTeam(team.id, {
      expectedRevision: team.revision,
      description: "Must fail against the locked state."
    })).rejects.toThrow(/runnable current published revision/i);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
  });

  it("does not persist or audit unchanged Agent Team and Meeting Preset updates", async () => {
    const state = createSeedSnapshot();
    const connectorId = "d0000000-0000-4000-8000-000000000091";
    state.modelConnectors.push({
      id: connectorId,
      revision: 1,
      name: "No-op management model",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "meeting-local",
      enabled: true,
      hasSecret: false,
      secretRevision: 0,
      credentialId: null
    });
    state.agents[0]!.modelConnectorId = connectorId;
    const memory = new InMemoryPlatformStore(state);
    const ready = await memory.getSnapshot();
    const team = await memory.createAgentTeam({
      name: "No-op Team",
      description: "Same value must not create history.",
      members: [{ agentId: ready.agents[0]!.id, roleId: ready.roles[0]!.id, isChair: true }]
    });
    const preset = await memory.createMeetingPreset({
      name: "No-op Preset",
      description: "Same value must not create history.",
      teamId: team.id,
      mode: "chaired",
      automation: "suggest",
      durationMinutes: 30,
      agendaItems: [{ title: "Review", description: "Review no-op semantics." }]
    });
    const prepared = await memory.getSnapshot();

    const teamTransaction = transactionPool(undefined, prepared);
    await expect(new PostgresPlatformStore(teamTransaction.pool).updateAgentTeam(team.id, {
      expectedRevision: team.revision,
      description: team.description
    })).resolves.toEqual(team);
    expect(teamTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(teamTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);

    const presetTransaction = transactionPool(undefined, prepared);
    await expect(new PostgresPlatformStore(presetTransaction.pool).updateMeetingPreset(preset.id, {
      expectedRevision: preset.revision,
      durationMinutes: preset.durationMinutes
    })).resolves.toEqual(preset);
    expect(presetTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(presetTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);

    const changedTeamTransaction = transactionPool(undefined, prepared);
    await expect(new PostgresPlatformStore(changedTeamTransaction.pool).updateAgentTeam(team.id, {
      expectedRevision: team.revision,
      description: "A real Team change."
    })).resolves.toMatchObject({ revision: team.revision + 1, description: "A real Team change." });
    expect(changedTeamTransaction.clientQuery.mock.calls.some(([_text, values]) =>
      Array.isArray(values) && values[1] === "agent_team.updated"
    )).toBe(true);
    expect(changedTeamTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(true);

    const changedPresetTransaction = transactionPool(undefined, prepared);
    await expect(new PostgresPlatformStore(changedPresetTransaction.pool).updateMeetingPreset(preset.id, {
      expectedRevision: preset.revision,
      durationMinutes: 45
    })).resolves.toMatchObject({ revision: preset.revision + 1, durationMinutes: 45 });
    expect(changedPresetTransaction.clientQuery.mock.calls.some(([_text, values]) =>
      Array.isArray(values) && values[1] === "meeting_preset.updated"
    )).toBe(true);
    expect(changedPresetTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(true);
  });

  it("does not persist, audit, or append history for a structurally unchanged Agent update", async () => {
    const state = await new InMemoryPlatformStore(createSeedSnapshot()).getSnapshot();
    const agent = state.agents[0]!;
    const transaction = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(transaction.pool);

    const unchanged = await store.updateAgent(agent.id, {
      skillIds: structuredClone(agent.skillIds),
      toolGrants: structuredClone(agent.toolGrants),
      toolPackGrants: structuredClone(agent.toolPackGrants),
      runtimeProfileBinding: structuredClone(agent.runtimeProfileBinding),
      promptBinding: structuredClone(agent.promptBinding)
    }, agent.draftRevision);

    expect(unchanged.draftRevision).toBe(agent.draftRevision);
    expect(transaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO agent_revisions"))).toBe(false);
    expect(transaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(transaction.clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
  });

  it("updates taxonomy state and writes prior/current values in the same transaction audit", async () => {
    const state = createSeedSnapshot();
    const { pool, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);
    const group = state.groups[0]!;

    await expect(store.updateGroup(group.id, { expectedRevision: group.revision, name: "Renamed group" })).resolves.toMatchObject({
      id: group.id,
      revision: group.revision + 1,
      name: "Renamed group"
    });

    const auditCall = clientQuery.mock.calls.find(([text]) => String(text).includes("INSERT INTO audit_events"));
    const auditValues = Array.isArray(auditCall?.[1]) ? auditCall[1] : [];
    const auditIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO audit_events"));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    const commitIndex = clientQuery.mock.calls.findIndex(([text]) => text === "COMMIT");

    expect(auditValues[1]).toBe("group.updated");
    expect(JSON.parse(String(auditValues[4]))).toEqual({
      fields: ["name"],
      previousRevision: group.revision,
      revision: group.revision + 1,
      previous: { name: group.name },
      current: { name: "Renamed group" }
    });
    expect(stateIndex).toBeGreaterThan(auditIndex);
    expect(commitIndex).toBeGreaterThan(stateIndex);
  });

  it("rejects a stale PostgreSQL taxonomy edit after the winning revision commits", async () => {
    const state = createSeedSnapshot();
    const group = state.groups[0]!;
    const winningTransaction = transactionPool(undefined, state);

    await expect(new PostgresPlatformStore(winningTransaction.pool).updateGroup(group.id, {
      expectedRevision: 1,
      name: "Winning group"
    })).resolves.toMatchObject({ revision: 2, name: "Winning group" });

    const stateCall = winningTransaction.clientQuery.mock.calls.find(([text]) => String(text).includes("UPDATE platform_state"));
    const committed = JSON.parse(String((stateCall?.[1] as unknown[])[0])) as PlatformSnapshot;
    const staleTransaction = transactionPool(undefined, committed);
    await expect(new PostgresPlatformStore(staleTransaction.pool).updateGroup(group.id, {
      expectedRevision: 1,
      name: "Stale group"
    })).rejects.toThrow(/revision/i);
    expect(staleTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
    expect(staleTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
  });

  it("blocks resolving a Topic while it has a non-closed Meeting", async () => {
    const state = createSeedSnapshot();
    state.meetings[0]!.state = "active";
    const { pool, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);

    await expect(store.updateThread(state.threads[0]!.id, {
      expectedRevision: state.threads[0]!.revision,
      status: "archived"
    })).rejects.toThrow(/unfinished/i);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
  });

  it("persists Decision idempotency, final state, and audit in the same transaction", async () => {
    const state = createSeedSnapshot();
    const input = {
      meetingId: state.meetings[0]!.id,
      title: "Atomic Decision",
      description: "Persist the proposal and audit together."
    };
    const createTransaction = transactionPool(undefined, state);
    const created = await new PostgresPlatformStore(createTransaction.pool).createDecision(input, "decision-create-key");
    const persistedStateCall = createTransaction.clientQuery.mock.calls.find(([text]) => String(text).includes("UPDATE platform_state"));
    const persistedState = JSON.parse(String((persistedStateCall?.[1] as unknown[] | undefined)?.[0]));
    const approveTransaction = transactionPool(undefined, persistedState);

    await new PostgresPlatformStore(approveTransaction.pool).setDecisionStatus(created.id, "approved");

    expect(createTransaction.clientQuery.mock.calls.some(([text, values]) => (
      String(text).includes("INSERT INTO idempotency_records")
      && Array.isArray(values)
      && values[0] === "decision.create"
      && values[1] === "decision-create-key"
    ))).toBe(true);
    expect(createTransaction.clientQuery.mock.calls.some(([text, values]) => (
      String(text).includes("INSERT INTO audit_events")
      && Array.isArray(values)
      && values[1] === "decision.proposed"
    ))).toBe(true);
    expect(approveTransaction.clientQuery.mock.calls.some(([text, values]) => (
      String(text).includes("INSERT INTO audit_events")
      && Array.isArray(values)
      && values[1] === "decision.approve"
    ))).toBe(true);
  });

  it("creates and moves a Task with transition history and audit in each transaction", async () => {
    const state = createSeedSnapshot();
    state.decisions[0]!.status = "approved";
    const createdTransaction = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(createdTransaction.pool);

    const task = await store.createTask({
      decisionId: state.decisions[0]!.id,
      title: "Atomic Task",
      description: "State, history, and audit move together.",
      assignee: null
    }, "task-create-key");
    const persistedStateCall = createdTransaction.clientQuery.mock.calls.find(([text]) => String(text).includes("UPDATE platform_state"));
    const persistedState = JSON.parse(String((persistedStateCall?.[1] as unknown[] | undefined)?.[0]));
    const movedTransaction = transactionPool(undefined, persistedState);
    await new PostgresPlatformStore(movedTransaction.pool).moveTask(task.id, {
      status: "in_progress",
      position: 0,
      expectedBoardRevision: task.boardRevision,
      expectedExecutionRevision: task.execution.revision
    });

    expect(createdTransaction.clientQuery.mock.calls.filter(([text]) => String(text).includes("INSERT INTO audit_events"))).toHaveLength(1);
    expect(movedTransaction.clientQuery.mock.calls.filter(([text]) => String(text).includes("INSERT INTO audit_events"))).toHaveLength(1);
    expect(createdTransaction.clientQuery.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("task.created"))).toBe(true);
    expect(movedTransaction.clientQuery.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("task.moved"))).toBe(true);
  });

  it("persists Task Evidence idempotency, audit, and state in one transaction", async () => {
    const memory = new InMemoryPlatformStore();
    const snapshot = await memory.getSnapshot();
    const decision = await memory.createDecision({
      meetingId: snapshot.meetings[0]!.id,
      title: "Transactional Evidence",
      description: "Persist one evidence entry."
    });
    await memory.setDecisionStatus(decision.id, "approved");
    const task = await memory.createTask({ decisionId: decision.id, title: "Transactional Evidence Task" });
    const transaction = transactionPool(undefined, await memory.getSnapshot());

    await new PostgresPlatformStore(transaction.pool).addTaskEvidence(task.id, {
      type: "note",
      label: "Retry proof",
      reference: "Same evidence"
    }, "task-evidence-transaction");

    const lookupIndex = transaction.clientQuery.mock.calls.findIndex(([text]) => String(text).includes("FROM idempotency_records"));
    const idempotencyIndex = transaction.clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO idempotency_records"));
    const auditIndex = transaction.clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO audit_events"));
    const stateIndex = transaction.clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    const commitIndex = transaction.clientQuery.mock.calls.findIndex(([text]) => text === "COMMIT");
    expect(lookupIndex).toBeGreaterThan(-1);
    expect(idempotencyIndex).toBeGreaterThan(lookupIndex);
    expect(auditIndex).toBeGreaterThan(idempotencyIndex);
    expect(stateIndex).toBeGreaterThan(auditIndex);
    expect(commitIndex).toBeGreaterThan(stateIndex);
  });

  it("guards Task content revisions and does not persist a no-op update", async () => {
    const state = createSeedSnapshot();
    state.decisions[0]!.status = "approved";
    const memory = new InMemoryPlatformStore(state);
    const task = await memory.createTask({
      decisionId: state.decisions[0]!.id,
      title: "Content CAS",
      description: "Protect owner edits.",
      assignee: null
    });
    const updateTransaction = transactionPool(undefined, await memory.getSnapshot());
    const updated = await new PostgresPlatformStore(updateTransaction.pool).updateTask(task.id, {
      expectedRevision: task.revision,
      expectedExecutionRevision: task.execution.revision,
      title: task.title,
      dueAt: "2026-08-20T09:00:00.000Z"
    });
    expect(updated).toMatchObject({ revision: 2, dueAt: "2026-08-20T09:00:00.000Z", execution: { revision: 0 } });
    const updateAuditCall = updateTransaction.clientQuery.mock.calls.find(([text, values]) => (
      String(text).includes("INSERT INTO audit_events")
      && Array.isArray(values)
      && values[1] === "task.updated"
    ));
    expect(JSON.parse(String((updateAuditCall?.[1] as unknown[] | undefined)?.[4]))).toMatchObject({
      fields: ["dueAt"]
    });
    const persistedCall = updateTransaction.clientQuery.mock.calls.find(([text]) => String(text).includes("UPDATE platform_state"));
    const persisted = JSON.parse(String((persistedCall?.[1] as unknown[] | undefined)?.[0]));

    const staleTransaction = transactionPool(undefined, persisted);
    await expect(new PostgresPlatformStore(staleTransaction.pool).updateTask(task.id, {
      expectedRevision: task.revision,
      expectedExecutionRevision: task.execution.revision,
      dueAt: "2026-08-21T09:00:00.000Z"
    })).rejects.toThrow(/revision is stale/i);
    expect(staleTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
    expect(staleTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(staleTransaction.clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);

    const noOpTransaction = transactionPool(undefined, persisted);
    await expect(new PostgresPlatformStore(noOpTransaction.pool).updateTask(task.id, {
      expectedRevision: updated.revision,
      expectedExecutionRevision: updated.execution.revision,
      dueAt: updated.dueAt
    })).resolves.toMatchObject({ revision: updated.revision });
    expect(noOpTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
    expect(noOpTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
  });

  it("rejects a stale board move after a different Task commits ordering", async () => {
    const memory = new InMemoryPlatformStore();
    const snapshot = await memory.getSnapshot();
    const createApprovedTask = async (title: string) => {
      const decision = await memory.createDecision({
        meetingId: snapshot.meetings[0]!.id,
        title,
        description: `${title} decision`
      });
      await memory.setDecisionStatus(decision.id, "approved");
      return memory.createTask({ decisionId: decision.id, title, description: "", assignee: null });
    };
    await createApprovedTask("Board A");
    await createApprovedTask("Board B");
    const before = await memory.getSnapshot();
    const first = before.tasks.find((task) => task.title === "Board A")!;
    const second = before.tasks.find((task) => task.title === "Board B")!;
    const moveTransaction = transactionPool(undefined, before);
    await new PostgresPlatformStore(moveTransaction.pool).moveTask(second.id, {
      status: "in_progress",
      position: 0,
      expectedBoardRevision: second.boardRevision,
      expectedExecutionRevision: second.execution.revision
    });
    const persistedCall = moveTransaction.clientQuery.mock.calls.find(([text]) => String(text).includes("UPDATE platform_state"));
    const persisted = JSON.parse(String((persistedCall?.[1] as unknown[] | undefined)?.[0]));

    const staleTransaction = transactionPool(undefined, persisted);
    await expect(new PostgresPlatformStore(staleTransaction.pool).moveTask(first.id, {
      status: "review",
      position: 0,
      expectedBoardRevision: first.boardRevision,
      expectedExecutionRevision: first.execution.revision
    })).rejects.toThrow(/board revision is stale/i);
    expect(staleTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
    expect(staleTransaction.clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(staleTransaction.clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
  });

  it("atomically persists Task Agent queue, start, Evidence, Review movement, and audits", async () => {
    const memory = new InMemoryPlatformStore();
    const initial = await memory.getSnapshot();
    const agent = initial.agents[0]!;
    const connector = await memory.createModelConnector({
      name: "Task execution model",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "task-model"
    });
    const prompt = await memory.createPrompt({
      name: "Postgres Task execution Prompt",
      kind: "agent",
      description: "Immutable PostgreSQL Task fixture.",
      owner: "Test Owner",
      content: "Complete the approved Task using bounded context.",
      variables: []
    });
    await memory.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 });
    const configuredAgent = await memory.updateAgent(agent.id, {
      modelConnectorId: connector.id,
      promptBinding: { promptId: prompt.id, version: 1 }
    });
    await memory.publishAgent(agent.id, { expectedDraftRevision: configuredAgent.draftRevision! });
    const decision = await memory.createDecision({ meetingId: initial.meetings[0]!.id, title: "Atomic Agent Task", description: "Persist one result." });
    await memory.setDecisionStatus(decision.id, "approved");
    let task = await memory.createTask({
      decisionId: decision.id,
      title: decision.title,
      assigneeAgentId: agent.id,
      acceptanceCriteria: "A bounded result is stored as Evidence.",
      executionProfile: "worker"
    });
    task = await memory.setTaskApproval(task.id, { expectedExecutionRevision: 0, action: "approve" });
    const published = await memory.getSnapshot();
    const jobId = "task-agent-job";
    const runtimeBinding = taskRuntimeBinding(published, agent.id);
    const job: TaskAgentRunJobData = {
      taskId: task.id,
      agentId: agent.id,
      executionProfile: "worker",
      executionRevision: task.execution.revision + 1,
      taskFingerprint: taskExecutionFingerprint(task),
      requestFingerprint: "atomic-task-agent-request",
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
      skillDigests: Object.fromEntries(published.skills
        .filter((skill) => agent.skillIds.includes(skill.id))
        .map((skill) => [skill.id, skill.contentDigest])),
      requestedBy: "owner"
    };
    await memory.updateAgent(agent.id, { modelConnectorId: null });
    const prepared = await memory.getSnapshot();
    const managementHistory = {
      agentRevisions: await memory.getAgentRevisions(agent.id),
      promptVersions: await memory.getPromptVersions(prompt.id)
    };

    const queuedTransaction = transactionPool(undefined, prepared, [], managementHistory);
    const queued = await new PostgresPlatformStore(queuedTransaction.pool).markTaskAgentRunQueued(jobId, job);
    const queuedStateCall = queuedTransaction.clientQuery.mock.calls.find(([text]) => String(text).includes("UPDATE platform_state"));
    const queuedState = JSON.parse(String((queuedStateCall?.[1] as unknown[] | undefined)?.[0])) as PlatformSnapshot;
    expect(queued).toMatchObject({
      status: "updated",
      task: {
        execution: {
          status: "queued",
          runtimeProfileBinding: runtimeBinding.runtimeProfileBinding
        }
      }
    });
    expect(queuedState.tasks.find((item) => item.id === task.id)?.execution.runtimeProfileBinding)
      .toEqual(runtimeBinding.runtimeProfileBinding);
    expect(queuedTransaction.clientQuery.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("task.agent_run.requested"))).toBe(true);

    const runningTransaction = transactionPool(undefined, queuedState, [], managementHistory);
    const running = await new PostgresPlatformStore(runningTransaction.pool).markTaskAgentRunRunning(jobId, job);
    const runningStateCall = runningTransaction.clientQuery.mock.calls.find(([text]) => String(text).includes("UPDATE platform_state"));
    const runningState = JSON.parse(String((runningStateCall?.[1] as unknown[] | undefined)?.[0])) as PlatformSnapshot;
    expect(running).toMatchObject({ status: "updated", task: { execution: { status: "running" } } });
    expect(runningTransaction.clientQuery.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("task.agent_run.started"))).toBe(true);

    const providerTransaction = transactionPool(undefined, runningState, [], managementHistory);
    const providerClaim = await new PostgresPlatformStore(providerTransaction.pool).claimTaskAgentProviderAttempt(jobId, job);
    const providerStateCall = providerTransaction.clientQuery.mock.calls.find(([text]) => String(text).includes("UPDATE platform_state"));
    const providerState = JSON.parse(String((providerStateCall?.[1] as unknown[] | undefined)?.[0])) as PlatformSnapshot;
    expect(providerClaim).toMatchObject({
      status: "updated",
      task: { execution: { status: "running", providerStartedAt: expect.any(String) } }
    });
    expect(providerTransaction.clientQuery.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("task.agent_run.provider_started"))).toBe(true);

    const completedTransaction = transactionPool(undefined, providerState, [], managementHistory);
    const completed = await new PostgresPlatformStore(completedTransaction.pool).completeTaskAgentRun(
      jobId,
      job,
      "Atomic bounded result.",
      { promptTokens: 5, completionTokens: 4, totalTokens: 9 }
    );
    const auditEvents = completedTransaction.clientQuery.mock.calls
      .filter(([text]) => String(text).includes("INSERT INTO audit_events"))
      .map(([_text, values]) => Array.isArray(values) ? values[1] : null);
    expect(completed).toMatchObject({
      status: "updated",
      task: {
        status: "review",
        execution: { status: "completed", resultEvidenceId: expect.any(String) },
        evidence: expect.arrayContaining([expect.objectContaining({ reference: "Atomic bounded result." })])
      }
    });
    expect(auditEvents).toEqual(["task.agent_run.completed", "task.moved"]);
    const movedAudit = completedTransaction.clientQuery.mock.calls.find(([_text, values]) =>
      Array.isArray(values) && values[1] === "task.moved"
    );
    expect(JSON.parse(String((movedAudit?.[1] as unknown[] | undefined)?.[4]))).toMatchObject({
      previousBoardRevision: runningState.tasks[0]!.boardRevision,
      boardRevision: completed.task.boardRevision,
      source: "task_agent_run"
    });
    const auditIndex = completedTransaction.clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO audit_events"));
    const stateIndex = completedTransaction.clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    expect(stateIndex).toBeGreaterThan(auditIndex);
  });

  it("persists a Chair suggestion and its audit in one transaction", async () => {
    const state = createSeedSnapshot();
    const { pool, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);

    await expect(store.createChairSuggestion(state.meetings[0]!.id, state.utterances.at(-1)!.id, {
      reason: "off_topic",
      suggestedMode: "chaired",
      explanation: "Return to the meeting goal.",
      score: 0.9,
      suggestedAgentId: state.agents[1]!.id,
      suggestedAgentName: state.agents[1]!.name
    })).resolves.toMatchObject({
      status: "created",
      suggestion: { status: "open", transitions: [expect.objectContaining({ type: "created" })] }
    });

    const auditIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO audit_events"));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    const commitIndex = clientQuery.mock.calls.findIndex(([text]) => text === "COMMIT");
    expect(auditIndex).toBeGreaterThan(-1);
    expect(stateIndex).toBeGreaterThan(auditIndex);
    expect(commitIndex).toBeGreaterThan(stateIndex);
  });

  it("applies a suggested Role and resolves the Chair suggestion in one transaction", async () => {
    const state = createSeedSnapshot();
    const meeting = state.meetings[0]!;
    const participant = state.participants.find((item) => item.meetingId === meeting.id && !item.isChair)!;
    const targetRole = state.roles.find((role) => role.id !== participant.roleId)!;
    const memory = new InMemoryPlatformStore(state);
    const source = await memory.addUtterance(meeting.id, {
      speakerType: "agent",
      speakerName: "Role candidate",
      roleName: participant.roleSnapshot.name,
      agentId: participant.agentId,
      content: "The latest contribution needs a different perspective.",
      kind: "inference",
      evidenceCount: 0
    });
    const created = await memory.createChairSuggestion(meeting.id, source.id, {
      reason: "off_topic",
      suggestedMode: "chaired",
      explanation: "Switch perspective and return to the Meeting goal.",
      score: 0.9,
      suggestedParticipantId: participant.id,
      suggestedParticipantAgentId: participant.agentId,
      suggestedParticipantAgentName: "Role candidate",
      suggestedParticipantRoleRevision: participant.roleRevision,
      suggestedRoleId: targetRole.id,
      suggestedRoleName: targetRole.name,
      suggestedRoleVersion: targetRole.version
    });
    const { pool, clientQuery } = transactionPool(undefined, await memory.getSnapshot());
    const result = await new PostgresPlatformStore(pool).applyChairSuggestedRole(created.suggestion.id, {
      expectedRoleRevision: participant.roleRevision
    });

    expect(result.participant).toMatchObject({
      id: participant.id,
      roleId: targetRole.id,
      roleRevision: participant.roleRevision + 1,
      roleHistory: expect.arrayContaining([
        expect.objectContaining({ roleId: targetRole.id, changedBy: "owner" })
      ])
    });
    expect(result.suggestion).toMatchObject({
      status: "resolved",
      resolution: "completed",
      transitions: expect.arrayContaining([
        expect.objectContaining({ type: "role_accepted", actor: "owner" })
      ])
    });
    const auditEvents = clientQuery.mock.calls
      .filter(([text]) => String(text).includes("INSERT INTO audit_events"))
      .map(([_text, values]) => Array.isArray(values) ? values[1] : null);
    expect(auditEvents).toEqual([
      "meeting.participant.role.changed",
      "chair.suggestion.role.accepted"
    ]);
    const lastAuditIndex = clientQuery.mock.calls.findLastIndex(([text]) => String(text).includes("INSERT INTO audit_events"));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    const commitIndex = clientQuery.mock.calls.findIndex(([text]) => text === "COMMIT");
    expect(stateIndex).toBeGreaterThan(lastAuditIndex);
    expect(commitIndex).toBeGreaterThan(stateIndex);
  });

  it("atomically applies Chair automation, reserves its turn, and audits before state commit", async () => {
    const state = createSeedSnapshot();
    const meeting = state.meetings[0]!;
    const chair = state.participants.find((participant) => participant.meetingId === meeting.id && participant.isChair)!;
    const connectorId = "c0000000-0000-4000-8000-000000000066";
    state.modelConnectors.push({ id: connectorId, revision: 1, name: "Local Auto Chair", location: "local", baseUrl: "http://127.0.0.1:4000/v1", model: "chair", enabled: true, hasSecret: false, secretRevision: 0 });
    state.agents.find((agent) => agent.id === chair.agentId)!.modelConnectorId = connectorId;
    const memory = new InMemoryPlatformStore(state);
    await memory.setMeetingAutomation(meeting.id, { automation: "auto", expectedAutomation: "suggest", expectedAutomationRevision: 0 });
    const prepared = await memory.getSnapshot();
    const preparedMeeting = prepared.meetings[0]!;
    const suggestion = await memory.createChairSuggestion(meeting.id, prepared.utterances.at(-1)!.id, {
      reason: "off_topic",
      suggestedMode: "chaired",
      explanation: "Return to the Meeting goal.",
      score: 0.9,
      suggestedAgentId: chair.agentId,
      suggestedAgentName: "Chair"
    }, { automation: "auto", automationRevision: preparedMeeting.automationRevision ?? 0 });
    const snapshot = await memory.getSnapshot();
    const boundAgent = snapshot.agents.find((agent) => agent.id === chair.agentId)!;
    const runtimeProfileBinding = boundAgent.runtimeProfileBinding!;
    const runtimeProfileRevision = snapshot.runtimeProfileRevisions!.find((revision) => (
      revision.profileId === runtimeProfileBinding.profileId && revision.revision === runtimeProfileBinding.revision
    ))!;
    const runtimeProfileSnapshot = createRuntimeProfileSnapshot(runtimeProfileRevision);
    const agentRevision = chair.agentRevision ?? 1;
    const { pool, clientQuery } = transactionPool(undefined, snapshot);
    const store = new PostgresPlatformStore(pool);

    await expect(store.applyChairAutomation({
      meetingId: meeting.id,
      chairSuggestionId: suggestion.suggestion.id,
      sourceUtteranceId: suggestion.suggestion.sourceUtteranceId,
      automationRevision: preparedMeeting.automationRevision ?? 0,
      agentTurnJobId: "postgres-auto-chair-turn",
      agentRevision,
      modelConnectorBinding: {
        id: snapshot.modelConnectors.at(-1)!.id,
        location: snapshot.modelConnectors.at(-1)!.location,
        baseUrl: snapshot.modelConnectors.at(-1)!.baseUrl,
        model: snapshot.modelConnectors.at(-1)!.model,
        secretRevision: snapshot.modelConnectors.at(-1)!.secretRevision
      },
      runtimeProfileBinding,
      runtimeProfileSnapshot,
      runtimeRun: createQueuedRuntimeRun({
        id: "70000000-0000-4000-8000-000000000094",
        kind: "meeting_turn",
        scope: {
          id: `meeting:${meeting.id}:participant:${chair.id}`,
          kind: "meeting_participant",
          subjectId: chair.id,
          parentScopeId: `meeting:${meeting.id}`
        },
        runtimeProfile: runtimeProfileSnapshot,
        agentId: chair.agentId,
        agentRevision,
        roleId: chair.roleId,
        roleRevision: chair.roleRevision,
        attempt: 1,
        idempotencyKey: "postgres-auto-chair-turn",
        queuedAt: new Date().toISOString(),
        ttlMs: 120_000
      }),
      skillDigests: Object.fromEntries(snapshot.agents.find((agent) => agent.id === chair.agentId)!.skillIds.map((skillId) => {
        const skill = snapshot.skills.find((item) => item.id === skillId)!;
        return [skill.id, skill.contentDigest];
      }))
    })).resolves.toMatchObject({
      status: "applied",
      suggestion: { status: "pending" },
      queueItem: { jobId: "postgres-auto-chair-turn", requestedBy: "system" }
    });

    const auditCalls = clientQuery.mock.calls.filter(([text]) => String(text).includes("INSERT INTO audit_events"));
    const auditEvents = auditCalls.map(([_text, values]) => (values as unknown[])[1]);
    expect(auditEvents).toEqual(expect.arrayContaining([
      "meeting.mode.changed",
      "chair.suggestion.mode.accepted",
      "speaker.queue.reserved",
      "chair.suggestion.agent.requested",
      "chair.automation.applied"
    ]));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    const commitIndex = clientQuery.mock.calls.findIndex(([text]) => text === "COMMIT");
    expect(stateIndex).toBeGreaterThan(clientQuery.mock.calls.lastIndexOf(auditCalls.at(-1)!));
    expect(commitIndex).toBeGreaterThan(stateIndex);
  });

  it("switches a Participant Role, appends history, and audits in one transaction", async () => {
    const state = createSeedSnapshot();
    const participant = state.participants[0]!;
    const targetRole = state.roles.find((role) => role.id !== participant.roleId)!;
    const { pool, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);

    await expect(store.switchParticipantRole(participant.meetingId, participant.id, {
      roleId: targetRole.id,
      expectedRoleRevision: participant.roleRevision,
      reason: "Use the security review perspective."
    })).resolves.toMatchObject({
      roleId: targetRole.id,
      roleRevision: participant.roleRevision + 1,
      roleSnapshot: { version: targetRole.version, source: "meeting_role_switched" }
    });

    const auditIndex = clientQuery.mock.calls.findIndex(([_text, values]) => Array.isArray(values) && values.includes("meeting.participant.role.changed"));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    const stateValues = clientQuery.mock.calls[stateIndex]?.[1] as unknown[];
    const persisted = JSON.parse(String(stateValues[0])) as PlatformSnapshot;
    expect(persisted.participants.find((item) => item.id === participant.id)).toMatchObject({
      roleId: targetRole.id,
      roleRevision: participant.roleRevision + 1,
      roleHistory: [
        expect.objectContaining({ revision: participant.roleRevision, roleId: participant.roleId }),
        expect.objectContaining({ revision: participant.roleRevision + 1, roleId: targetRole.id, changedBy: "owner" })
      ]
    });
    expect(auditIndex).toBeGreaterThan(-1);
    expect(stateIndex).toBeGreaterThan(auditIndex);
  });

  it("persists queued, renewed, running, and released speaker states in separate locked transactions", async () => {
    const state = createSeedSnapshot();
    state.meetings[0]!.mode = "open";
    const connectorId = "c0000000-0000-4000-8000-000000000031";
    state.modelConnectors.push({ id: connectorId, revision: 1, name: "Local", location: "local", baseUrl: "http://192.168.50.10:4000/v1", model: "local", enabled: true, hasSecret: false, secretRevision: 0 });
    state.agents[0]!.modelConnectorId = connectorId;
    const participant = state.participants.find((item) => item.meetingId === state.meetings[0]!.id && item.agentId === state.agents[0]!.id)!;
    const job = {
      meetingId: state.meetings[0]!.id,
      agentId: state.agents[0]!.id,
      ...participantRoleBinding(state, state.meetings[0]!.id, state.agents[0]!.id),
      agendaRevision: state.meetings[0]!.agenda.revision,
      agendaCurrentItemId: state.meetings[0]!.agenda.items.find((item) => item.status === "current")?.id ?? null,
      requestedBy: "owner" as const
    };

    const reservedTransaction = transactionPool(undefined, state);
    await expect(new PostgresPlatformStore(reservedTransaction.pool).reserveSpeakerTurn("speaker-job-pg", job))
      .resolves.toMatchObject({ jobId: "speaker-job-pg", participantId: participant.id, status: "queued" });
    expect(reservedTransaction.clientQuery.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("speaker.queue.reserved"))).toBe(true);
    const reservedStateCall = reservedTransaction.clientQuery.mock.calls.find(([text]) => String(text).includes("UPDATE platform_state"));
    const reservedState = JSON.parse(String((reservedStateCall?.[1] as unknown[])[0])) as PlatformSnapshot;
    const requestedAt = Date.parse(reservedState.speakerQueue[0]!.requestedAt);
    const expiredAt = new Date(requestedAt + 60_000).toISOString();
    const renewalAt = new Date(requestedAt + 120_000).toISOString();
    const renewedUntil = new Date(requestedAt + 420_000).toISOString();
    reservedState.speakerQueue[0]!.leaseExpiresAt = expiredAt;

    const renewedTransaction = transactionPool(undefined, reservedState);
    await expect(new PostgresPlatformStore(renewedTransaction.pool).renewSpeakerTurnLease(
      "speaker-job-pg",
      renewalAt
    )).resolves.toMatchObject({ status: "queued", leaseExpiresAt: renewedUntil });
    const renewalSql = renewedTransaction.clientQuery.mock.calls.map(([text]) => String(text)).join("\n");
    expect(renewalSql).not.toMatch(/FROM agent_revisions|FROM prompt_versions|FROM runtime_profile_revisions|FROM tool_pack_revisions|FROM credential_secrets/);
    const renewedStateCall = renewedTransaction.clientQuery.mock.calls.find(([text]) => String(text).includes("UPDATE platform_state"));
    const renewedState = JSON.parse(String((renewedStateCall?.[1] as unknown[])[0])) as PlatformSnapshot;

    const runningTransaction = transactionPool(undefined, renewedState);
    await expect(new PostgresPlatformStore(runningTransaction.pool).markSpeakerTurnRunning("speaker-job-pg"))
      .resolves.toMatchObject({ status: "running", startedAt: expect.any(String) });
    expect(runningTransaction.clientQuery.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("speaker.queue.started"))).toBe(true);
    const runningStateCall = runningTransaction.clientQuery.mock.calls.find(([text]) => String(text).includes("UPDATE platform_state"));
    const runningState = JSON.parse(String((runningStateCall?.[1] as unknown[])[0])) as PlatformSnapshot;

    const releasedTransaction = transactionPool(undefined, runningState);
    await expect(new PostgresPlatformStore(releasedTransaction.pool).releaseSpeakerTurn("speaker-job-pg", "stale_turn"))
      .resolves.toMatchObject({ jobId: "speaker-job-pg", status: "running" });
    expect(releasedTransaction.clientQuery.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("speaker.queue.released"))).toBe(true);
    const releasedStateCall = releasedTransaction.clientQuery.mock.calls.find(([text]) => String(text).includes("UPDATE platform_state"));
    const releasedState = JSON.parse(String((releasedStateCall?.[1] as unknown[])[0])) as PlatformSnapshot;
    expect(releasedState.speakerQueue).toEqual([]);
  });

  it("reserves a chaired Meeting delegate from the completed Utterance projection", async () => {
    const state = createSeedSnapshot();
    const meeting = state.meetings[0]!;
    const chair = state.participants.find((participant) => participant.meetingId === meeting.id && participant.isChair)!;
    const delegate = state.participants.find((participant) => participant.meetingId === meeting.id && !participant.isChair)!;
    const connectorId = "c0000000-0000-4000-8000-000000000032";
    state.modelConnectors.push({
      id: connectorId,
      revision: 1,
      name: "Projected Meeting local model",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "local",
      enabled: true,
      hasSecret: false,
      secretRevision: 0
    });
    state.agents.find((agent) => agent.id === delegate.agentId)!.modelConnectorId = connectorId;
    const projectedUtterances: PlatformSnapshot["utterances"] = [{
      id: "a0000000-0000-4000-8000-000000000032",
      meetingId: meeting.id,
      speakerType: "agent",
      speakerName: state.agents.find((agent) => agent.id === chair.agentId)!.name,
      agentId: chair.agentId,
      roleName: chair.roleSnapshot.name,
      content: "The Chair has opened the formal round.",
      kind: "inference",
      evidenceCount: 0,
      createdAt: "2026-08-12T00:00:00.000Z"
    }];
    const transaction = transactionPool(undefined, state, [], {}, projectedUtterances);
    const store = new PostgresPlatformStore(transaction.pool);

    await expect(store.reserveSpeakerTurn("projected-delegate-turn", {
      meetingId: meeting.id,
      agentId: delegate.agentId,
      ...participantRoleBinding(state, meeting.id, delegate.agentId),
      agendaRevision: meeting.agenda.revision,
      agendaCurrentItemId: meeting.agenda.items.find((item) => item.status === "current")?.id ?? null,
      requestedBy: "owner"
    })).resolves.toMatchObject({
      jobId: "projected-delegate-turn",
      agentId: delegate.agentId,
      status: "queued"
    });

    expect(transaction.clientQuery.mock.calls.some(([text]) => (
      String(text).includes("utterance_projection_backfill_progress")
    ))).toBe(true);
  });

  it("does not load management history for high-frequency Meeting state mutations", async () => {
    const state = createSeedSnapshot();
    const { pool, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);

    await store.addUtterance(state.meetings[0]!.id, {
      speakerType: "human",
      speakerName: "Owner",
      roleName: "Owner",
      content: "Keep the Meeting path lightweight.",
      kind: "human",
      evidenceCount: 0
    });

    const sql = clientQuery.mock.calls.map(([text]) => String(text)).join("\n");
    expect(sql).not.toMatch(/FROM agent_revisions|FROM prompt_versions|FROM runtime_profile_revisions|FROM tool_pack_revisions|FROM credential_secrets/);
  });

  it("reads Utterances from the completed projection instead of stale JSON state", async () => {
    const state = createSeedSnapshot();
    const projected = {
      ...state.utterances[0]!,
      id: "a9000000-0000-4000-8000-000000000001",
      content: "Projected source of truth"
    };
    const transaction = repeatableReadPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "COMMIT" || text === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("SELECT state FROM platform_state")) return { rows: [{ state }], rowCount: 1 };
      if (text.includes("utterance_projection_backfill_progress")) {
        return { rows: [{ complete: true, utterances: [projected] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const store = new PostgresPlatformStore(transaction.pool);

    await expect(store.getSnapshot()).resolves.toMatchObject({ utterances: [projected] });
  });

  it("rolls back and releases a repeatable-read client when a projected read fails", async () => {
    const state = createSeedSnapshot();
    const projectionError = new Error("projection unavailable");
    const transaction = repeatableReadPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (text.includes("SELECT state FROM platform_state")) return { rows: [{ state }], rowCount: 1 };
      if (text.includes("utterance_projection_backfill_progress")) throw projectionError;
      return { rows: [], rowCount: 0 };
    });
    const store = new PostgresPlatformStore(transaction.pool);

    await expect(store.getSnapshot()).rejects.toBe(projectionError);
    expect(transaction.clientQuery.mock.calls.map(([text]) => text)).toEqual([
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SELECT state FROM platform_state WHERE singleton_id = 1",
      expect.stringContaining("utterance_projection_backfill_progress"),
      "ROLLBACK"
    ]);
    expect(transaction.clientQuery.mock.calls.some(([text]) => text === "COMMIT")).toBe(false);
    expect(transaction.client.release).toHaveBeenCalledOnce();
    expect(transaction.poolQuery).not.toHaveBeenCalled();
  });

  it("rolls back a Meeting state transition when its required audit cannot be persisted", async () => {
    const state = createSeedSnapshot();
    const meeting = state.meetings[0]!;
    meeting.state = "active";
    const harness = statefulFailurePool(state, "", "INSERT INTO audit_events");
    const store = new PostgresPlatformStore(harness.pool);

    await expect(store.setMeetingState(meeting.id, "paused", "active")).rejects.toThrow(/Injected failure/);

    expect(harness.readDurable().state.meetings.find((item) => item.id === meeting.id)?.state).toBe("active");
    expect(harness.clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
  });

  it("appends directly to a completed Utterance projection without locking or rewriting platform_state", async () => {
    const state = createSeedSnapshot();
    const meetingId = state.meetings[0]!.id;
    const clientQuery = vi.fn(async (text: string, values: unknown[] = []) => {
      if (text.includes("utterance_projection_backfill_progress")) {
        return { rows: [{ complete: true, utterances: [] }], rowCount: 1 };
      }
      if (text.includes("SELECT snapshot FROM meeting_utterances")) return { rows: [], rowCount: 0 };
      if (text.includes("meeting->>'state'") && text.includes("state->'meetings'")) {
        return { rows: [{ state: "active" }], rowCount: 1 };
      }
      if (text.includes("INSERT INTO meeting_utterances") && text.includes("RETURNING snapshot")) {
        return { rows: [{ snapshot: JSON.parse(String(values[4])) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query: clientQuery, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client), query: clientQuery } as unknown as Pool;
    const store = new PostgresPlatformStore(pool);

    await expect(store.addUtteranceWithDisposition(meetingId, {
      turnId: "direct-projection-turn",
      speakerType: "human",
      speakerName: "Owner",
      roleName: "Owner",
      content: "Do not contend on the global row.",
      kind: "human",
      evidenceCount: 0
    })).resolves.toMatchObject({
      status: "created",
      utterance: { meetingId, turnId: "direct-projection-turn" }
    });

    const sql = clientQuery.mock.calls.map(([text]) => String(text)).join("\n");
    expect(sql).toContain("FOR SHARE OF platform");
    expect(sql).not.toContain("FOR UPDATE");
    expect(sql).not.toContain("UPDATE platform_state");
    expect(sql).toContain("INSERT INTO meeting_utterances");
  });

  it("reports an identical projected Utterance replay as existing", async () => {
    const state = createSeedSnapshot();
    const meetingId = state.meetings[0]!.id;
    const existing = {
      id: "a9000000-0000-4000-8000-000000000010",
      meetingId,
      turnId: "projected-identical-replay",
      speakerType: "human" as const,
      speakerName: "Owner",
      roleName: "Owner",
      content: "Original content",
      kind: "human" as const,
      evidenceCount: 0,
      createdAt: "2026-08-12T00:00:00.000Z"
    };
    const clientQuery = vi.fn(async (text: string) => {
      if (text.includes("utterance_projection_backfill_progress")) {
        return { rows: [{ complete: true }], rowCount: 1 };
      }
      if (text.includes("SELECT snapshot FROM meeting_utterances")) {
        return { rows: [{ snapshot: existing }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query: clientQuery, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client), query: clientQuery } as unknown as Pool;
    const store = new PostgresPlatformStore(pool);

    await expect(store.addUtteranceWithDisposition(meetingId, {
      turnId: existing.turnId,
      speakerType: existing.speakerType,
      speakerName: existing.speakerName,
      roleName: existing.roleName,
      content: existing.content,
      kind: existing.kind,
      evidenceCount: existing.evidenceCount
    })).resolves.toEqual({ status: "existing", utterance: existing });

    expect(clientQuery.mock.calls.some(([text]) => text === "COMMIT")).toBe(true);
    expect(clientQuery.mock.calls.some(([text]) => text.includes("INSERT INTO meeting_utterances"))).toBe(false);
  });

  it("rejects a projected Utterance replay when an existing turn has different content", async () => {
    const state = createSeedSnapshot();
    const meetingId = state.meetings[0]!.id;
    const existing = {
      id: "a9000000-0000-4000-8000-000000000011",
      meetingId,
      turnId: "projected-replay-conflict",
      speakerType: "human" as const,
      speakerName: "Owner",
      roleName: "Owner",
      content: "Original content",
      kind: "human" as const,
      evidenceCount: 0,
      createdAt: "2026-08-12T00:00:00.000Z"
    };
    const clientQuery = vi.fn(async (text: string) => {
      if (text.includes("utterance_projection_backfill_progress")) {
        return { rows: [{ complete: true }], rowCount: 1 };
      }
      if (text.includes("SELECT snapshot FROM meeting_utterances")) {
        return { rows: [{ snapshot: existing }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query: clientQuery, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client), query: clientQuery } as unknown as Pool;
    const store = new PostgresPlatformStore(pool);

    await expect(store.addUtterance(meetingId, {
      turnId: existing.turnId,
      speakerType: "human",
      speakerName: "Owner",
      roleName: "Owner",
      content: "Changed content",
      kind: "human",
      evidenceCount: 0
    })).rejects.toMatchObject({ apiCode: "IDEMPOTENCY_KEY_CONFLICT" });

    expect(clientQuery.mock.calls.some(([text]) => text === "COMMIT")).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
  });

  it("rejects a projected Utterance replay when a concurrent insert wins with different attribution", async () => {
    const state = createSeedSnapshot();
    const meetingId = state.meetings[0]!.id;
    const existing = {
      id: "a9000000-0000-4000-8000-000000000012",
      meetingId,
      turnId: "projected-concurrent-conflict",
      speakerType: "human" as const,
      speakerName: "Another owner",
      roleName: "Owner",
      content: "Concurrent content",
      kind: "human" as const,
      evidenceCount: 0,
      createdAt: "2026-08-12T00:00:00.000Z"
    };
    let replayLookupCount = 0;
    const clientQuery = vi.fn(async (text: string) => {
      if (text.includes("utterance_projection_backfill_progress")) {
        return { rows: [{ complete: true }], rowCount: 1 };
      }
      if (text.includes("SELECT snapshot FROM meeting_utterances")) {
        replayLookupCount += 1;
        return replayLookupCount === 1
          ? { rows: [], rowCount: 0 }
          : { rows: [{ snapshot: existing }], rowCount: 1 };
      }
      if (text.includes("meeting->>'state'") && text.includes("state->'meetings'")) {
        return { rows: [{ state: "active" }], rowCount: 1 };
      }
      if (text.includes("INSERT INTO meeting_utterances") && text.includes("RETURNING snapshot")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query: clientQuery, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client), query: clientQuery } as unknown as Pool;
    const store = new PostgresPlatformStore(pool);

    await expect(store.addUtterance(meetingId, {
      turnId: existing.turnId,
      speakerType: "human",
      speakerName: "Owner",
      roleName: "Owner",
      content: "Concurrent content",
      kind: "human",
      evidenceCount: 0
    })).rejects.toMatchObject({ apiCode: "IDEMPOTENCY_KEY_CONFLICT" });

    expect(replayLookupCount).toBe(2);
    expect(clientQuery.mock.calls.some(([text]) => text === "COMMIT")).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
  });

  it("replays the canonical projected Meeting summary across deterministic regeneration", async () => {
    const state = createSeedSnapshot();
    const meetingId = state.meetings[0]!.id;
    const existing = {
      id: "a9000000-0000-4000-8000-000000000013",
      meetingId,
      turnId: `meeting-summary:${meetingId}`,
      speakerType: "system" as const,
      speakerName: "Meeting Summary",
      roleName: "System",
      content: "Earlier deterministic summary",
      kind: "system" as const,
      evidenceCount: 0,
      createdAt: "2026-08-12T00:00:00.000Z"
    };
    const clientQuery = vi.fn(async (text: string) => {
      if (text.includes("utterance_projection_backfill_progress")) {
        return { rows: [{ complete: true }], rowCount: 1 };
      }
      if (text.includes("SELECT snapshot FROM meeting_utterances")) {
        return { rows: [{ snapshot: existing }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query: clientQuery, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client), query: clientQuery } as unknown as Pool;
    const store = new PostgresPlatformStore(pool);

    await expect(store.addUtterance(meetingId, {
      turnId: existing.turnId,
      speakerType: "system",
      speakerName: "Meeting Summary",
      roleName: "System",
      content: "Regenerated deterministic summary",
      kind: "system",
      evidenceCount: 0
    })).resolves.toEqual(existing);

    expect(clientQuery.mock.calls.some(([text]) => text === "COMMIT")).toBe(true);
    expect(clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(false);
  });

  it("rejects a direct projected Utterance when its Meeting is closed", async () => {
    const state = createSeedSnapshot();
    const meetingId = state.meetings[0]!.id;
    const clientQuery = vi.fn(async (text: string) => {
      if (text.includes("utterance_projection_backfill_progress")) {
        return { rows: [{ complete: true, utterances: [] }], rowCount: 1 };
      }
      if (text.includes("meeting->>'state'") && text.includes("state->'meetings'")) {
        return { rows: [{ state: "closed" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query: clientQuery, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client), query: clientQuery } as unknown as Pool;
    const store = new PostgresPlatformStore(pool);

    await expect(store.addUtterance(meetingId, {
      speakerType: "human",
      speakerName: "Owner",
      roleName: "Owner",
      content: "This message arrived after closure.",
      kind: "human",
      evidenceCount: 0
    })).rejects.toThrow("Meeting must be active");

    const sql = clientQuery.mock.calls.map(([text]) => String(text)).join("\n");
    expect(sql).not.toContain("INSERT INTO meeting_utterances");
    expect(sql).toContain("ROLLBACK");
  });

  it("accepts only the direct projected system summary when its Meeting is closed", async () => {
    const state = createSeedSnapshot();
    const meetingId = state.meetings[0]!.id;
    const clientQuery = vi.fn(async (text: string, values: unknown[] = []) => {
      if (text.includes("utterance_projection_backfill_progress")) {
        return { rows: [{ complete: true, utterances: [] }], rowCount: 1 };
      }
      if (text.includes("SELECT snapshot FROM meeting_utterances")) return { rows: [], rowCount: 0 };
      if (text.includes("meeting->>'state'") && text.includes("state->'meetings'")) {
        return { rows: [{ state: "closed" }], rowCount: 1 };
      }
      if (text.includes("INSERT INTO meeting_utterances") && text.includes("RETURNING snapshot")) {
        return { rows: [{ snapshot: JSON.parse(String(values[4])) }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query: clientQuery, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client), query: clientQuery } as unknown as Pool;
    const store = new PostgresPlatformStore(pool);

    await expect(store.addUtterance(meetingId, {
      turnId: `meeting-summary:${meetingId}`,
      speakerType: "system",
      speakerName: "Council",
      roleName: null,
      content: "Closed Meeting summary.",
      kind: "system",
      evidenceCount: 0
    })).resolves.toMatchObject({ meetingId, speakerType: "system", kind: "system" });

    const sql = clientQuery.mock.calls.map(([text]) => String(text)).join("\n");
    expect(sql).toContain("INSERT INTO meeting_utterances");
    expect(sql).toContain("COMMIT");
  });

  it("keeps projected Utterances out of subsequent singleton-state rewrites after cutover", async () => {
    const state = createSeedSnapshot();
    const clientQuery = vi.fn(async (text: string, values: unknown[] = []) => {
      if (text.includes("SELECT state FROM platform_state")) return { rows: [{ state }], rowCount: 1 };
      if (text.includes("utterance_projection_backfill_progress") && text.includes("AS utterances")) {
        return { rows: [{ complete: true, utterances: state.utterances }], rowCount: 1 };
      }
      if (text.includes("utterance_projection_backfill_progress")) {
        return { rows: [{ complete: true }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query: clientQuery, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client), query: clientQuery } as unknown as Pool;
    const store = new PostgresPlatformStore(pool);

    await store.updateThread(state.threads[0]!.id, {
      expectedRevision: state.threads[0]!.revision,
      summary: "A compact projected-state mutation."
    });

    const update = clientQuery.mock.calls.find(([text]) => String(text).includes("UPDATE platform_state"));
    const persisted = JSON.parse(String(update?.[1]?.[0])) as PlatformSnapshot;
    expect(persisted.utterances).toEqual([]);
    expect(persisted.threads[0]!.summary).toBe("A compact projected-state mutation.");
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("AS utterances"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("FROM meeting_utterances"))).toBe(false);
  });

  it("validates, persists, and audits an Agent turn in one transaction", async () => {
    const state = createSeedSnapshot();
    const connectorId = "c0000000-0000-4000-8000-000000000001";
    state.meetings[0]!.mode = "open";
    state.modelConnectors.push({ id: connectorId, revision: 1, name: "Local", location: "local", baseUrl: "http://192.168.50.10:4000/v1", model: "local", enabled: true, hasSecret: false, secretRevision: 0 });
    state.agents[0]!.modelConnectorId = connectorId;
    const { pool, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);
    const binding = participantRoleBinding(state, state.meetings[0]!.id, state.agents[0]!.id);

    await expect(store.commitAgentTurn({
      ...binding,
      meetingId: state.meetings[0]!.id,
      agentId: state.agents[0]!.id,
      turnId: "job-1",
      agendaRevision: state.meetings[0]!.agenda.revision,
      speakerName: state.agents[0]!.name,
      roleName: state.roles[0]!.name,
      content: "原子寫入",
      auditDetail: { model: "local" }
    })).resolves.toMatchObject({ status: "created", utterance: { turnId: "job-1" } });

    const auditIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO audit_events"));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    const commitIndex = clientQuery.mock.calls.findIndex(([text]) => text === "COMMIT");
    expect(auditIndex).toBeGreaterThan(-1);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO meeting_utterances"))).toBe(true);
    expect(clientQuery.mock.calls.some(([text, values]) => (
      String(text).includes("AS utterances") && values?.[0] === state.meetings[0]!.id
    ))).toBe(true);
    expect(stateIndex).toBeGreaterThan(auditIndex);
    expect(commitIndex).toBeGreaterThan(stateIndex);
  });

  it("rejects a stale Agent turn after a Model Connector secret revision changes", async () => {
    const state = createSeedSnapshot();
    const connectorId = "c0000000-0000-4000-8000-000000000004";
    state.meetings[0]!.mode = "open";
    state.modelConnectors.push({
      id: connectorId,
      revision: 1,
      name: "Rotated local",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "local",
      enabled: true,
      hasSecret: true,
      secretRevision: 2
    });
    state.agents[0]!.modelConnectorId = connectorId;
    state.agents[0]!.status = "online";
    const { pool, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);
    const binding = participantRoleBinding(state, state.meetings[0]!.id, state.agents[0]!.id);

    await expect(store.commitAgentTurn({
      ...binding,
      meetingId: state.meetings[0]!.id,
      agentId: state.agents[0]!.id,
      turnId: "job-stale-secret-revision",
      agendaRevision: state.meetings[0]!.agenda.revision,
      speakerName: state.agents[0]!.name,
      roleName: state.roles[0]!.name,
      content: "This used the previous secret.",
      modelConnectorId: connectorId,
      modelConnectorSnapshot: {
        id: connectorId,
        location: "local",
        baseUrl: "http://192.168.50.10:4000/v1",
        model: "local",
        enabled: true,
        secretRevision: 1
      },
      auditDetail: { model: "local" }
    })).resolves.toMatchObject({ status: "stale", utterance: null });

    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => text === "COMMIT")).toBe(true);
  });

  it("resolves a pending Chair suggestion in the same transaction as its Agent turn", async () => {
    const state = createSeedSnapshot();
    const connectorId = "c0000000-0000-4000-8000-000000000001";
    state.modelConnectors.push({ id: connectorId, revision: 1, name: "Local", location: "local", baseUrl: "http://127.0.0.1:4000/v1", model: "local", enabled: true, hasSecret: false, secretRevision: 0 });
    state.agents[1]!.modelConnectorId = connectorId;
    const memory = new InMemoryPlatformStore(state);
    const suggestion = await memory.createChairSuggestion(state.meetings[0]!.id, state.utterances.at(-1)!.id, {
      reason: "off_topic",
      suggestedMode: "chaired",
      explanation: "Return to the meeting goal.",
      score: 0.9,
      suggestedAgentId: state.agents[1]!.id,
      suggestedAgentName: state.agents[1]!.name
    });
    await memory.setChairSuggestionPending(suggestion.suggestion.id, state.agents[1]!.id, "job-chair");
    const snapshot = await memory.getSnapshot();
    const { pool, clientQuery } = transactionPool(undefined, snapshot);
    const store = new PostgresPlatformStore(pool);
    const binding = participantRoleBinding(snapshot, state.meetings[0]!.id, state.agents[1]!.id);

    await expect(store.commitAgentTurn({
      ...binding,
      meetingId: state.meetings[0]!.id,
      agentId: state.agents[1]!.id,
      turnId: "job-chair",
      agendaRevision: state.meetings[0]!.agenda.revision,
      chairSuggestionId: suggestion.suggestion.id,
      speakerName: state.agents[1]!.name,
      roleName: state.roles[1]!.name,
      content: "Back to the agenda.",
      auditDetail: { model: "local" }
    })).resolves.toMatchObject({
      status: "created",
      chairSuggestion: { status: "resolved", resolution: "completed" }
    });

    const auditCalls = clientQuery.mock.calls.filter(([text]) => String(text).includes("INSERT INTO audit_events"));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    expect(auditCalls).toHaveLength(2);
    expect(stateIndex).toBeGreaterThan(clientQuery.mock.calls.lastIndexOf(auditCalls.at(-1)!));
  });

  it("persists connector state and encrypted secret in one transaction", async () => {
    const { pool, poolQuery, clientQuery } = transactionPool();
    const store = new PostgresPlatformStore(pool);

    await store.createModelConnector({
      name: "Cloud",
      location: "cloud",
      baseUrl: "https://models.example.com/v1",
      model: "meeting"
    }, { ciphertext: "encrypted" });

    expect(poolQuery).not.toHaveBeenCalled();
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("connector_secrets"))).toBe(true);
    const commitIndex = clientQuery.mock.calls.findIndex(([text]) => text === "COMMIT");
    const secretIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("connector_secrets"));
    expect(secretIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(secretIndex);
  });

  it("rolls back before overwriting an existing Credential during connector creation", async () => {
    const memory = new InMemoryPlatformStore();
    const credential = await memory.createCredential({
      name: "Shared credential",
      provider: "shared-provider",
      kind: "api_key",
      location: "cloud"
    }, { ciphertext: "encrypted-original" });
    const snapshot = await memory.getSnapshot();
    const { pool, clientQuery } = transactionPool(undefined, snapshot, [], {
      credentialSecrets: [{ credentialId: credential.id, ciphertext: "encrypted-original" }]
    });
    const store = new PostgresPlatformStore(pool);

    await expect(store.createModelConnector({
      name: "Unsafe connector",
      location: "cloud",
      baseUrl: "https://models.example.com/v1",
      model: "meeting",
      credentialId: credential.id
    }, { ciphertext: "encrypted-replacement" })).rejects.toThrow(/Credential/i);

    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO credential_secrets"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
  });

  it("rolls back before rotating a shared Credential through Model Connector update", async () => {
    const memory = new InMemoryPlatformStore();
    const credential = await memory.createCredential({
      name: "Shared update credential",
      provider: "shared-provider",
      kind: "api_key",
      location: "cloud"
    }, { ciphertext: "encrypted-one" });
    const connector = await memory.createModelConnector({
      name: "Shared update connector",
      location: "cloud",
      baseUrl: "https://models.example.com/v1",
      model: "meeting",
      credentialId: credential.id
    });
    await memory.rotateCredential({
      credentialId: credential.id,
      expectedSecretRevision: 1
    }, { ciphertext: "encrypted-two" });
    const snapshot = await memory.getSnapshot();
    const { pool, clientQuery } = transactionPool(undefined, snapshot, [], {
      credentialSecrets: [{ credentialId: credential.id, ciphertext: "encrypted-two" }]
    });
    const store = new PostgresPlatformStore(pool);

    await expect(store.updateModelConnector(
      connector.id,
      {
        expectedRevision: snapshot.modelConnectors.find((item) => item.id === connector.id)!.revision,
        model: "stale-client-model"
      },
      { ciphertext: "stale-client-secret" }
    )).rejects.toThrow(/Credential/i);

    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO credential_secrets"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
  });

  it("persists Credential metadata and encrypted material in one transaction", async () => {
    const { pool, poolQuery, clientQuery } = transactionPool();
    const store = new PostgresPlatformStore(pool);

    const credential = await store.createCredential({
      name: "OpenAI production",
      provider: "OpenAI",
      kind: "api_key",
      location: "cloud"
    }, { ciphertext: "encrypted-credential" });

    expect(credential).toMatchObject({ hasSecret: true, secretRevision: 1, status: "active" });
    expect(poolQuery).not.toHaveBeenCalled();
    const secretIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO credential_secrets"));
    const auditIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO audit_events"));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    expect(secretIndex).toBeGreaterThan(-1);
    expect(auditIndex).toBeGreaterThan(secretIndex);
    expect(stateIndex).toBeGreaterThan(auditIndex);
    expect(JSON.stringify(clientQuery.mock.calls)).not.toContain('"secret":"');
  });

  it("records immutable Prompt and Agent revision rows before publishing state", async () => {
    const { pool, clientQuery } = transactionPool();
    const store = new PostgresPlatformStore(pool);

    const prompt = await store.createPrompt({
      name: "Architecture reviewer",
      kind: "agent",
      description: "Reusable architecture review behavior",
      owner: "Platform Owner",
      content: "Review {{MEETING_GOAL}}.",
      variables: ["MEETING_GOAL"]
    });
    const agent = await store.createAgent({
      name: "Architecture Agent",
      description: "Reviews platform boundaries.",
      modelConnectorId: null,
      promptBinding: null,
      goalSummary: "Review architecture decisions.",
      toolsSummary: "No tools.",
      dataSummary: "Meeting context only.",
      skillIds: [],
      toolGrants: [],
      runtimeProfileBinding: null
    });

    expect(prompt).toMatchObject({ currentVersion: 1, status: "draft" });
    expect(agent).toMatchObject({ draftRevision: 1, lifecycleStatus: "draft" });
    const promptVersionIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO prompt_versions"));
    const agentRevisionIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO agent_revisions"));
    expect(promptVersionIndex).toBeGreaterThan(-1);
    expect(agentRevisionIndex).toBeGreaterThan(promptVersionIndex);
    expect(clientQuery.mock.calls.filter(([text]) => String(text).includes("UPDATE platform_state"))).toHaveLength(2);
  });

  it("does not persist or audit repeated Prompt archival", async () => {
    const memory = new InMemoryPlatformStore();
    const prompt = await memory.createPrompt({
      name: "Already archived Prompt",
      kind: "agent",
      description: "No-op persistence fixture.",
      owner: "Platform Owner",
      content: "Review bounded evidence.",
      variables: []
    });
    const archived = await memory.archivePrompt(prompt.id, { expectedCurrentVersion: prompt.currentVersion });
    const state = await memory.getSnapshot();
    const promptVersions = await memory.getPromptVersions(prompt.id);
    const { pool, clientQuery } = transactionPool(undefined, state, [], { promptVersions });
    const store = new PostgresPlatformStore(pool);

    await expect(store.archivePrompt(prompt.id, { expectedCurrentVersion: archived.currentVersion }))
      .resolves.toEqual(archived);

    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
  });

  it("does not persist or audit an unchanged Credential status", async () => {
    const memory = new InMemoryPlatformStore();
    const credential = await memory.createCredential({
      name: "Unchanged Credential status",
      provider: "OpenAI",
      kind: "api_key",
      location: "cloud"
    }, { ciphertext: "encrypted-credential" });
    const state = await memory.getSnapshot();
    const { pool, clientQuery } = transactionPool(undefined, state, [], {
      credentialSecrets: [{ credentialId: credential.id, ciphertext: "encrypted-credential" }]
    });
    const store = new PostgresPlatformStore(pool);

    await expect(store.setCredentialStatus(credential.id, {
      status: credential.status,
      expectedUpdatedAt: credential.updatedAt
    })).resolves.toEqual(credential);

    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
  });

  it("rejects stale Credential metadata before PostgreSQL state or audit writes", async () => {
    const memory = new InMemoryPlatformStore();
    const credential = await memory.createCredential({
      name: "PostgreSQL Credential metadata CAS",
      provider: "OpenAI",
      kind: "api_key",
      location: "cloud"
    }, { ciphertext: "encrypted-credential" });
    await memory.updateCredential(credential.id, {
      provider: "Current provider",
      expectedUpdatedAt: credential.updatedAt
    });
    const state = await memory.getSnapshot();
    const { pool, clientQuery } = transactionPool(undefined, state, [], {
      credentialSecrets: [{ credentialId: credential.id, ciphertext: "encrypted-credential" }]
    });
    const store = new PostgresPlatformStore(pool);

    await expect(store.updateCredential(credential.id, {
      name: "Stale overwrite",
      expectedUpdatedAt: credential.updatedAt
    })).rejects.toThrow(/stale/i);

    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
  });

  it("rejects stale Skill validation before PostgreSQL state or audit writes", async () => {
    const memory = new InMemoryPlatformStore();
    const skill = await memory.createSkill({
      name: "PostgreSQL Skill validation CAS",
      version: "1.0.0",
      instructions: "Keep current validation evidence authoritative.",
      source: "internal",
      owner: "owner"
    });
    await memory.validateSkill(skill.id, {
      result: "failed",
      summary: "The current review found an unsafe instruction.",
      expectedCheckedAt: skill.validation.checkedAt
    });
    const state = await memory.getSnapshot();
    const { pool, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);

    await expect(store.validateSkill(skill.id, {
      result: "passed",
      summary: "A stale review must not replace the current failure.",
      expectedCheckedAt: skill.validation.checkedAt
    })).rejects.toThrow(/stale/i);

    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
  });

  it("checks and records idempotency inside the mutation transaction", async () => {
    const { pool, poolQuery, clientQuery } = transactionPool();
    const store = new PostgresPlatformStore(pool);
    const snapshot = createSeedSnapshot();

    await store.createThread({
      categoryId: snapshot.categories[0]!.id,
      title: "Transactional",
      summary: "",
      tagIds: []
    }, "thread-key");

    expect(poolQuery).not.toHaveBeenCalled();
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("FROM idempotency_records"))).toBe(true);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO idempotency_records"))).toBe(true);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("request_fingerprint"))).toBe(true);
    const stateLockIndex = clientQuery.mock.calls.findIndex(([text]) => (
      String(text).includes("FROM platform_state") && String(text).includes("FOR UPDATE")
    ));
    const idempotencyLookupIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("FROM idempotency_records"));
    const auditIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO audit_events"));
    const commitIndex = clientQuery.mock.calls.findIndex(([text]) => text === "COMMIT");
    expect(stateLockIndex).toBeGreaterThan(-1);
    expect(idempotencyLookupIndex).toBeGreaterThan(stateLockIndex);
    expect(auditIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(auditIndex);
  });

  it("persists Skill creation idempotency, audit, and state in one transaction", async () => {
    const { pool, poolQuery, clientQuery } = transactionPool();
    const store = new PostgresPlatformStore(pool);

    const skill = await store.createSkill({
      name: "Transactional Skill",
      version: "1.0.0",
      instructions: "Keep Skill creation retry-safe.",
      source: "internal",
      owner: "Platform Owner"
    }, "transactional-skill-create");

    expect(skill).toMatchObject({ name: "Transactional Skill", status: "draft" });
    expect(poolQuery).not.toHaveBeenCalled();
    const idempotencyLookupIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("FROM idempotency_records"));
    const idempotencyInsertIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO idempotency_records"));
    const auditIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO audit_events"));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    const commitIndex = clientQuery.mock.calls.findIndex(([text]) => text === "COMMIT");
    expect(idempotencyLookupIndex).toBeGreaterThan(-1);
    expect(idempotencyInsertIndex).toBeGreaterThan(idempotencyLookupIndex);
    expect(auditIndex).toBeGreaterThan(idempotencyInsertIndex);
    expect(stateIndex).toBeGreaterThan(auditIndex);
    expect(commitIndex).toBeGreaterThan(stateIndex);
  });

  it("persists Prompt creation idempotency, version, audit, and state in one transaction", async () => {
    const { pool, poolQuery, clientQuery } = transactionPool();
    const store = new PostgresPlatformStore(pool);

    const prompt = await store.createPrompt({
      name: "Transactional Prompt",
      kind: "agent",
      description: "Keep Prompt creation retry-safe.",
      owner: "Platform Owner",
      content: "Review {{MEETING_GOAL}}.",
      variables: ["MEETING_GOAL"]
    }, "transactional-prompt-create");

    expect(prompt).toMatchObject({ name: "Transactional Prompt", status: "draft", currentVersion: 1 });
    expect(poolQuery).not.toHaveBeenCalled();
    const idempotencyLookupIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("FROM idempotency_records"));
    const versionIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO prompt_versions"));
    const idempotencyInsertIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO idempotency_records"));
    const auditIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO audit_events"));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    const commitIndex = clientQuery.mock.calls.findIndex(([text]) => text === "COMMIT");
    expect(idempotencyLookupIndex).toBeGreaterThan(-1);
    expect(versionIndex).toBeGreaterThan(idempotencyLookupIndex);
    expect(idempotencyInsertIndex).toBeGreaterThan(versionIndex);
    expect(auditIndex).toBeGreaterThan(idempotencyInsertIndex);
    expect(stateIndex).toBeGreaterThan(auditIndex);
    expect(commitIndex).toBeGreaterThan(stateIndex);
  });

  it.each([
    {
      label: "Agent Team",
      event: "agent_team.created",
      key: "transactional-agent-team-create",
      create: async (store: PostgresPlatformStore, state: ReturnType<typeof createSeedSnapshot>) => store.createAgentTeam({
        name: "Transactional Agent Team",
        description: "Keep Team creation retry-safe.",
        members: [{ agentId: state.agents[0]!.id, roleId: state.roles[0]!.id, isChair: true }]
      }, "transactional-agent-team-create")
    },
    {
      label: "Meeting Preset",
      event: "meeting_preset.created",
      key: "transactional-meeting-preset-create",
      create: async (store: PostgresPlatformStore) => store.createMeetingPreset({
        name: "Transactional Meeting Preset",
        description: "Keep Preset creation retry-safe.",
        teamId: null,
        mode: "chaired",
        automation: "suggest",
        durationMinutes: 30,
        agendaItems: [{ title: "Review", description: "Review one bounded goal." }]
      }, "transactional-meeting-preset-create")
    }
  ])("persists $label idempotency, audit, and state in one transaction", async ({ event, create }) => {
    const state = createSeedSnapshot();
    const connectorId = "d0000000-0000-4000-8000-000000000098";
    state.modelConnectors.push({
      id: connectorId,
      revision: 1,
      name: "PostgreSQL Team-ready model",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "meeting-local",
      enabled: true,
      hasSecret: false,
      secretRevision: 0,
      credentialId: null
    });
    for (const agent of state.agents) agent.modelConnectorId = connectorId;
    const { pool, poolQuery, clientQuery } = transactionPool(undefined, state);
    const store = new PostgresPlatformStore(pool);

    await create(store, state);

    expect(poolQuery).not.toHaveBeenCalled();
    const idempotencyLookupIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("FROM idempotency_records"));
    const idempotencyInsertIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO idempotency_records"));
    const auditIndex = clientQuery.mock.calls.findIndex(([_text, values]) => Array.isArray(values) && values.includes(event));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    const commitIndex = clientQuery.mock.calls.findIndex(([text]) => text === "COMMIT");
    expect(idempotencyLookupIndex).toBeGreaterThan(-1);
    expect(idempotencyInsertIndex).toBeGreaterThan(idempotencyLookupIndex);
    expect(auditIndex).toBeGreaterThan(idempotencyInsertIndex);
    expect(stateIndex).toBeGreaterThan(auditIndex);
    expect(commitIndex).toBeGreaterThan(stateIndex);
  });

  it("persists Agent creation idempotency, revision, audit, and state in one transaction", async () => {
    const { pool, poolQuery, clientQuery } = transactionPool();
    const store = new PostgresPlatformStore(pool);

    const agent = await store.createAgent({
      name: "Transactional Agent",
      description: "Retry-safe Agent draft.",
      modelConnectorId: null,
      goalSummary: "Keep Agent creation atomic.",
      toolsSummary: "No tools.",
      dataSummary: "No data.",
      skillIds: [],
      toolGrants: [],
      toolPackGrants: [],
      runtimeProfileBinding: null,
      promptBinding: null
    }, "transactional-agent-create");

    expect(agent).toMatchObject({ name: "Transactional Agent", draftRevision: 1 });
    expect(poolQuery).not.toHaveBeenCalled();
    const idempotencyLookupIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("FROM idempotency_records"));
    const revisionIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO agent_revisions"));
    const idempotencyInsertIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO idempotency_records"));
    const auditIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO audit_events"));
    const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    const commitIndex = clientQuery.mock.calls.findIndex(([text]) => text === "COMMIT");
    expect(idempotencyLookupIndex).toBeGreaterThan(-1);
    expect(revisionIndex).toBeGreaterThan(idempotencyLookupIndex);
    expect(idempotencyInsertIndex).toBeGreaterThan(revisionIndex);
    expect(auditIndex).toBeGreaterThan(idempotencyInsertIndex);
    expect(stateIndex).toBeGreaterThan(auditIndex);
    expect(commitIndex).toBeGreaterThan(stateIndex);
  });

  it("persists a monotonic Agent resource revision and rolls back stale lifecycle changes", async () => {
    const state = createSeedSnapshot();
    const agent = state.agents[0]!;
    const harness = statefulFailurePool(state, "", "__never__");
    const store = new PostgresPlatformStore(harness.pool);

    const disabled = await store.setAgentStatus(agent.id, { status: "disabled", expectedRevision: 1 });
    expect(disabled).toMatchObject({ lifecycleStatus: "disabled", revision: 2 });
    await expect(store.setAgentStatus(agent.id, { status: "published", expectedRevision: 1 }))
      .rejects.toThrow(/stale/i);
    const reactivated = await store.setAgentStatus(agent.id, {
      status: "published",
      expectedRevision: disabled.revision!
    });

    expect(reactivated).toMatchObject({ lifecycleStatus: "published", revision: 3 });
    const durable = harness.readDurable();
    expect(durable.state.agents.find((item) => item.id === agent.id)).toMatchObject({
      lifecycleStatus: "published",
      revision: 3
    });
    expect(durable.audits.filter((values) => values[1] === "agent.status.changed")).toHaveLength(2);
    expect(harness.clientQuery.mock.calls.filter(([text]) => text === "ROLLBACK")).toHaveLength(1);
  });

  it("fails closed when a legacy idempotency record has no verifiable request fingerprint", async () => {
    const { pool, clientQuery } = transactionPool({
      response: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Legacy" },
      requestFingerprint: null
    });
    const store = new PostgresPlatformStore(pool);

    await expect(store.createGroup({ name: "Legacy" }, "legacy-group-key")).rejects.toThrow(/idempotency key/i);
    expect(clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
  });

  it("normalizes a pre-revision taxonomy idempotency replay without mutating state", async () => {
    const input = { name: "Legacy taxonomy replay" };
    const { pool, clientQuery } = transactionPool({
      response: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: input.name },
      requestFingerprint: requestFingerprint(input)
    });
    const store = new PostgresPlatformStore(pool);

    await expect(store.createGroup(input, "legacy-group-revision-key")).resolves.toEqual({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      revision: 1,
      name: input.name
    });
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
  });

  it("rejects a persisted idempotency key bound to a different payload", async () => {
    const { pool, clientQuery } = transactionPool({
      response: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Original" },
      requestFingerprint: "not-the-current-request"
    });
    const store = new PostgresPlatformStore(pool);

    await expect(store.createGroup({ name: "Different" }, "group-key")).rejects.toThrow(/idempotency key/i);
    expect(clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
  });

  it("persists a failed Tool Run, Meeting pause, and both audits in one transaction", async () => {
    const state = createSeedSnapshot();
    const connectorId = "d0000000-0000-4000-8000-000000000021";
    const registration = {
      toolName: "search",
      displayName: "政策搜尋",
      kind: "mcp_tool" as const,
      version: "1.0.0",
      owner: "Knowledge Team",
      goal: "搜尋政策。"
    };
    state.mcpConnectors.push({
      id: connectorId,
      revision: 1,
      name: "Docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"],
      toolRegistrations: [registration],
      enabled: true,
      hasSecret: false
    });
    state.agents[0]!.toolGrants = [{ connectorId, toolName: "search" }];
    const { pool, clientQuery, readDurable } = statefulFailurePool(state, connectorId, "__never__");
    const store = new PostgresPlatformStore(pool);
    const binding = participantRoleBinding(state, state.meetings[0]!.id, state.agents[0]!.id);

    await expect(store.commitMcpToolRun({
      ...binding,
      jobId: "tool-job-failed-transaction",
      requestFingerprint: "fingerprint-failed-transaction",
      meetingId: state.meetings[0]!.id,
      agentId: state.agents[0]!.id,
      connectorId,
      toolName: "search",
      toolSnapshot: { connectorName: "Docs", ...registration },
      status: "failed",
      content: "Connector unavailable."
    })).resolves.toMatchObject({ status: "created", meetingPaused: true });

    const durable = readDurable();
    expect(durable.state.meetings[0]!.state).toBe("paused");
    expect(durable.state.toolRuns).toEqual([expect.objectContaining({ jobId: "tool-job-failed-transaction", status: "failed" })]);
    expect(durable.audits.map((values) => values[1])).toEqual(["mcp.tool.failed", "meeting.state.changed"]);
    expect(clientQuery.mock.calls.filter(([text]) => text === "BEGIN")).toHaveLength(1);
    expect(clientQuery.mock.calls.filter(([text]) => text === "COMMIT")).toHaveLength(1);
  });

  it("persists an Agent failure receipt, Meeting pause, and both audits in one transaction", async () => {
    const state = createSeedSnapshot();
    const jobId = "agent-failure-transaction";
    state.speakerQueue.push(speakerQueueFixture(state, jobId));
    const { pool, clientQuery, readDurable } = statefulFailurePool(state, "", "__never__");
    const store = new PostgresPlatformStore(pool);

    await expect(store.commitAgentTurnFailure({
      meetingId: state.meetings[0]!.id,
      jobId,
      content: "Model provider unavailable.",
      classification: "provider_or_runtime_failure"
    })).resolves.toMatchObject({ status: "created", meetingPaused: true, utterance: { turnId: jobId } });

    const durable = readDurable();
    expect(durable.state.meetings[0]!.state).toBe("paused");
    expect(durable.state.utterances.filter((item) => item.turnId === jobId)).toEqual([
      expect.objectContaining({ turnId: jobId, kind: "failure", content: "Model provider unavailable." })
    ]);
    expect(durable.audits.map((values) => values[1])).toEqual(["model.run.failed", "meeting.pause"]);
    expect(clientQuery.mock.calls.filter(([text]) => text === "BEGIN")).toHaveLength(1);
    expect(clientQuery.mock.calls.filter(([text]) => text === "COMMIT")).toHaveLength(1);
  });

  it("rolls back an Agent failure receipt and Meeting pause when an audit insert fails", async () => {
    const state = createSeedSnapshot();
    const jobId = "agent-failure-audit-rollback";
    state.speakerQueue.push(speakerQueueFixture(state, jobId));
    const { pool, clientQuery, readDurable } = statefulFailurePool(state, "", "INSERT INTO audit_events");
    const store = new PostgresPlatformStore(pool);

    await expect(store.commitAgentTurnFailure({
      meetingId: state.meetings[0]!.id,
      jobId,
      content: "Model provider unavailable.",
      classification: "provider_or_runtime_failure"
    })).rejects.toThrow(/Injected failure/i);

    expect(clientQuery.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
    expect(clientQuery.mock.calls.some(([text]) => text === "COMMIT")).toBe(false);
    expect(readDurable().state).toEqual(state);
    expect(readDurable().audits).toEqual([]);
  });

  it("persists management lifecycle idempotency before its single audit and state write", async () => {
    const roleState = createSeedSnapshot();
    roleState.meetings[0]!.state = "closed";
    const role = roleState.roles[0]!;
    const skillState = createSeedSnapshot();
    const skill = skillState.skills[0]!;
    const credentialMemory = new InMemoryPlatformStore();
    const credential = await credentialMemory.createCredential({
      name: "PostgreSQL lifecycle Credential",
      provider: "test-provider",
      kind: "api_key",
      location: "cloud"
    });
    const credentialState = await credentialMemory.getSnapshot();
    const credentialInput = { status: "disabled" as const, expectedUpdatedAt: credential.updatedAt };
    const cases = [
      {
        label: "Role deletion",
        operation: "role.delete",
        key: "postgres-role-delete-retry",
        fingerprint: requestFingerprint({ roleId: role.id, expectedCurrentVersion: role.version }),
        auditEvent: "role.deleted",
        state: roleState,
        mutate: (store: PostgresPlatformStore) => store.deleteRole(role.id, role.version, "postgres-role-delete-retry")
      },
      {
        label: "Skill revocation",
        operation: "skill.revoke",
        key: "postgres-skill-revoke-retry",
        fingerprint: requestFingerprint({ skillId: skill.id, reason: "Superseded by a reviewed Skill." }),
        auditEvent: "skill.revoked",
        state: skillState,
        mutate: (store: PostgresPlatformStore) => store.revokeSkill(
          skill.id,
          { reason: "Superseded by a reviewed Skill." },
          "postgres-skill-revoke-retry"
        )
      },
      {
        label: "Credential status",
        operation: "credential.status",
        key: "postgres-credential-status-retry",
        fingerprint: requestFingerprint({ credentialId: credential.id, ...credentialInput }),
        auditEvent: "credential.status.changed",
        state: credentialState,
        mutate: (store: PostgresPlatformStore) => store.setCredentialStatus(
          credential.id,
          credentialInput,
          "postgres-credential-status-retry"
        )
      }
    ];

    for (const lifecycle of cases) {
      const { pool, poolQuery, clientQuery } = transactionPool(undefined, lifecycle.state);
      await lifecycle.mutate(new PostgresPlatformStore(pool));

      expect(poolQuery, lifecycle.label).not.toHaveBeenCalled();
      const lookupIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("FROM idempotency_records"));
      const idempotencyIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("INSERT INTO idempotency_records"));
      const auditIndexes = clientQuery.mock.calls
        .map(([text], index) => String(text).includes("INSERT INTO audit_events") ? index : -1)
        .filter((index) => index >= 0);
      const stateIndex = clientQuery.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
      const commitIndex = clientQuery.mock.calls.findIndex(([text]) => text === "COMMIT");
      const idempotencyCall = clientQuery.mock.calls[idempotencyIndex];
      const auditCall = clientQuery.mock.calls[auditIndexes[0]!];

      expect(lookupIndex, lifecycle.label).toBeGreaterThan(-1);
      expect(idempotencyIndex, lifecycle.label).toBeGreaterThan(lookupIndex);
      expect(auditIndexes, lifecycle.label).toHaveLength(1);
      expect(auditIndexes[0], lifecycle.label).toBeGreaterThan(idempotencyIndex);
      expect(stateIndex, lifecycle.label).toBeGreaterThan(auditIndexes[0]!);
      expect(commitIndex, lifecycle.label).toBeGreaterThan(stateIndex);
      expect(idempotencyCall?.[1]?.slice(0, 3), lifecycle.label).toEqual([
        lifecycle.operation,
        lifecycle.key,
        lifecycle.fingerprint
      ]);
      expect(auditCall?.[1], lifecycle.label).toEqual(expect.arrayContaining([lifecycle.auditEvent]));
    }
  });

  it("replays management lifecycle results from PostgreSQL without another audit or state write", async () => {
    const roleState = createSeedSnapshot();
    const role = roleState.roles[0]!;
    const roleResponse = { id: role.id, historicalMeetingCount: 1 };
    const skillState = createSeedSnapshot();
    const skill = skillState.skills[0]!;
    const skillResponse = { skill: { ...skill, status: "revoked" as const }, revokedAssignmentCount: 3 };
    const credentialMemory = new InMemoryPlatformStore();
    const credential = await credentialMemory.createCredential({
      name: "PostgreSQL replay Credential",
      provider: "test-provider",
      kind: "api_key",
      location: "cloud"
    });
    const credentialInput = { status: "disabled" as const, expectedUpdatedAt: credential.updatedAt };
    const credentialResponse = { ...credential, status: "disabled" as const };
    const replayCases = [
      {
        label: "Role deletion",
        state: roleState,
        response: roleResponse,
        fingerprint: requestFingerprint({ roleId: role.id, expectedCurrentVersion: role.version }),
        replay: (store: PostgresPlatformStore) => store.deleteRole(role.id, role.version, "postgres-role-delete-replay"),
        conflict: (store: PostgresPlatformStore) => store.deleteRole(role.id, role.version + 1, "postgres-role-delete-replay")
      },
      {
        label: "Skill revocation",
        state: skillState,
        response: skillResponse,
        fingerprint: requestFingerprint({ skillId: skill.id, reason: "Superseded." }),
        replay: (store: PostgresPlatformStore) => store.revokeSkill(skill.id, { reason: "Superseded." }, "postgres-skill-revoke-replay"),
        conflict: (store: PostgresPlatformStore) => store.revokeSkill(skill.id, { reason: "Changed intent." }, "postgres-skill-revoke-replay")
      },
      {
        label: "Credential status",
        state: await credentialMemory.getSnapshot(),
        response: credentialResponse,
        fingerprint: requestFingerprint({ credentialId: credential.id, ...credentialInput }),
        replay: (store: PostgresPlatformStore) => store.setCredentialStatus(
          credential.id,
          credentialInput,
          "postgres-credential-status-replay"
        ),
        conflict: (store: PostgresPlatformStore) => store.setCredentialStatus(
          credential.id,
          { status: "revoked", expectedUpdatedAt: credential.updatedAt },
          "postgres-credential-status-replay"
        )
      }
    ];

    for (const lifecycle of replayCases) {
      const { pool, clientQuery } = transactionPool({
        response: lifecycle.response,
        requestFingerprint: lifecycle.fingerprint
      }, lifecycle.state);
      const store = new PostgresPlatformStore(pool);

      await expect(lifecycle.replay(store), lifecycle.label).resolves.toEqual(lifecycle.response);
      await expect(lifecycle.conflict(store), lifecycle.label).rejects.toMatchObject({
        apiCode: "IDEMPOTENCY_KEY_CONFLICT"
      });
      expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO idempotency_records")), lifecycle.label)
        .toBe(false);
      expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO audit_events")), lifecycle.label)
        .toBe(false);
      expect(clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state")), lifecycle.label)
        .toBe(false);
    }
  });

  it("does not let a replaced PostgreSQL reservation commit an old Agent failure", async () => {
    const state = createSeedSnapshot();
    const stableJobId = "agent-failure-replacement";
    state.speakerQueue.push({
      ...speakerQueueFixture(state, stableJobId),
      reservationId: "new-postgres-reservation"
    });
    const { pool, clientQuery, readDurable } = statefulFailurePool(state, "", "__never__");
    const store = new PostgresPlatformStore(pool);

    await expect(store.commitAgentTurnFailure({
      meetingId: state.meetings[0]!.id,
      jobId: stableJobId,
      reservationId: "old-postgres-reservation",
      content: "An old job must not own the replacement reservation.",
      classification: "stale_reservation"
    })).resolves.toMatchObject({
      status: "stale",
      meeting: { state: "active" },
      utterance: null,
      meetingPaused: false
    });
    await expect(store.releaseSpeakerTurn(stableJobId, "worker_cleanup_after_stale", "old-postgres-reservation"))
      .resolves.toBeNull();

    const durable = readDurable();
    expect(durable.state.meetings[0]!.state).toBe("active");
    expect(durable.state.speakerQueue).toEqual([
      expect.objectContaining({ jobId: stableJobId, reservationId: "new-postgres-reservation" })
    ]);
    expect(durable.state.utterances.some((item) => item.turnId === stableJobId)).toBe(false);
    expect(durable.audits).toEqual([]);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("INSERT INTO meeting_utterances"))).toBe(false);
    expect(clientQuery.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
  });
});
