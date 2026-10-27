import { describe, expect, it, vi } from "vitest";
import argon2 from "argon2";
import {
  InMemoryPlatformStore,
  mcpConnectorExecutionFingerprint,
  mcpToolRequestFingerprint,
  requestFingerprint,
  taskExecutionFingerprint,
  taskSyncAdmissionInput,
  taskSyncRequestFingerprint
} from "@council/database";
import { createSeedSnapshot } from "@council/database/seed";
import { createCouncilJobEnvelope, type AgentTurnJobData, type McpToolCallJobData, type TaskAgentRunJobData } from "@council/contracts";
import { decryptMcpToolArguments, GuardedExternalExecutor, SecretVault } from "@council/domain";
import { McpReadOnlyClient, OpenAICompatibleConnector, type TaskAdapterClientConfig } from "@council/runtime";
import { chairAutomationJobId, mcpToolJobId, type AgentTurnQueue } from "./agent-queue.js";
import { createApp } from "./app.js";
import { MeetingEventBus, type MeetingEvent } from "./event-bus.js";

class AuditedStore extends InMemoryPlatformStore {
  readonly events: string[] = [];
  readonly audits: Array<{ event: string; detail: Record<string, unknown> }> = [];

  override async recordAudit(event: string, _entityType: string, _entityId: string, detail: Record<string, unknown> = {}): Promise<void> {
    this.events.push(event);
    this.audits.push({ event, detail });
  }
}

class FailingMeetingTransitionAuditStore extends InMemoryPlatformStore {
  override async recordAudit(event: string): Promise<void> {
    if (event === "meeting.pause") throw new Error("meeting transition audit unavailable");
  }
}

class FailingMcpQueuedAuditStore extends InMemoryPlatformStore {
  override async recordAudit(event: string): Promise<void> {
    if (event === "mcp.tool.queued") throw new Error("queued MCP audit unavailable");
  }
}

class FailingMcpReconciliationAuditStore extends InMemoryPlatformStore {
  override async recordAudit(event: string): Promise<void> {
    if (event === "mcp.tool.reconciliation.required") throw new Error("MCP reconciliation audit unavailable");
  }
}

class FailingTaskAgentReconciliationAuditStore extends InMemoryPlatformStore {
  override async recordAudit(event: string): Promise<void> {
    if (event === "task.agent_run.reconciliation.required") throw new Error("Task Agent reconciliation audit unavailable");
  }
}

async function configurePublishedMeetingAgent(
  store: InMemoryPlatformStore,
  agentId: string,
  modelConnectorId: string
): Promise<void> {
  const prompt = await store.createPrompt({
    name: `Meeting Prompt ${agentId}`,
    kind: "agent",
    description: "Test meeting behavior.",
    owner: "Test Owner",
    content: "Focus on {{MEETING_GOAL}}.",
    variables: ["MEETING_GOAL"]
  });
  await store.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 });
  const agent = await store.updateAgent(agentId, {
    modelConnectorId,
    promptBinding: { promptId: prompt.id, version: 1 }
  });
  await store.publishAgent(agentId, { expectedDraftRevision: agent.draftRevision! });
}

async function currentTaskSyncRequest(
  store: InMemoryPlatformStore,
  taskId: string,
  adapterId: string
) {
  const task = (await store.getSnapshot()).tasks.find((item) => item.id === taskId);
  if (!task) throw new Error("Task sync fixture not found.");
  return taskSyncAdmissionInput(task, adapterId);
}

async function createPublishedTestMeeting(
  store: InMemoryPlatformStore,
  input: {
    connectorId: string;
    title: string;
    mode: "chaired" | "open" | "fixed";
    participants: Array<{ agentId: string; roleId: string; isChair: boolean }>;
  }
) {
  const initial = await store.getSnapshot();
  const thread = initial.threads[0]!;
  for (const meeting of initial.meetings.filter((item) => item.threadId === thread.id && item.state !== "closed")) {
    await store.setMeetingState(meeting.id, "closed");
  }
  for (const agentId of new Set(input.participants.map((participant) => participant.agentId))) {
    await configurePublishedMeetingAgent(store, agentId, input.connectorId);
  }
  const published = await store.getSnapshot();
  const meeting = await store.createMeeting({
    threadId: thread.id,
    title: input.title,
    goal: `${input.title} with immutable Agent revisions.`,
    mode: input.mode,
    durationMinutes: 30,
    agendaItems: [{ title: input.title, description: "" }],
    participants: input.participants.map((participant) => ({
      ...participant,
      agentRevision: published.agents.find((agent) => agent.id === participant.agentId)!.publishedRevision!
    }))
  });
  await store.setMeetingState(meeting.id, "active");
  const current = await store.getSnapshot();
  return {
    meeting: current.meetings.find((item) => item.id === meeting.id)!,
    participants: current.participants.filter((participant) => participant.meetingId === meeting.id)
  };
}

async function createToolGrantedTestMeeting(
  store: InMemoryPlatformStore,
  input: { agentId: string; mcpConnectorId: string; title: string }
) {
  await store.updateAgent(input.agentId, {
    toolGrants: [{ connectorId: input.mcpConnectorId, toolName: "search" }]
  });
  const snapshot = await store.getSnapshot();
  const sourceMeeting = snapshot.meetings.find((meeting) =>
    meeting.state !== "closed"
    && snapshot.participants.some((participant) => participant.meetingId === meeting.id && participant.agentId === input.agentId)
  );
  const agent = snapshot.agents.find((candidate) => candidate.id === input.agentId);
  if (!sourceMeeting || !agent) throw new Error("A runnable source Meeting and Agent are required.");
  const modelConnectorId = agent.modelConnectorId ?? (await store.createModelConnector({
    name: `${input.title} Model`,
    location: "local",
    baseUrl: "http://192.168.50.10:4000/v1",
    model: "test-local"
  })).id;
  const participants = snapshot.participants
    .filter((participant) => participant.meetingId === sourceMeeting.id)
    .map(({ agentId, roleId, isChair }) => ({ agentId, roleId, isChair }));
  const created = await createPublishedTestMeeting(store, {
    connectorId: modelConnectorId,
    title: input.title,
    mode: sourceMeeting.mode,
    participants
  });
  const current = await store.getSnapshot();
  const participant = created.participants.find((candidate) => candidate.agentId === input.agentId);
  if (!participant) throw new Error("The Tool-granted Agent is not assigned to the replacement Meeting.");
  return { ...created, participant, snapshot: current };
}

function inspectedMcpJob(state: string, job: McpToolCallJobData) {
  return { state, data: createCouncilJobEnvelope("mcp-tool-call", job) };
}

function inspectedAgentJob(state: string, job: AgentTurnJobData) {
  return { state, data: createCouncilJobEnvelope("agent-turn", job) };
}

function inspectedTaskAgentJob(state: string, job: TaskAgentRunJobData) {
  return { state, data: createCouncilJobEnvelope("task-agent-run", job) };
}

describe("Council API", () => {
  it("supports a bounded global rate-limit override for disposable E2E servers", async () => {
    const app = await createApp({
      store: new InMemoryPlatformStore(),
      authDisabled: true,
      rateLimitMax: 2
    });

    expect((await app.inject({ method: "GET", url: "/api/health/live" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/health/live" })).statusCode).toBe(200);
    const limited = await app.inject({ method: "GET", url: "/api/health/live" });
    expect(limited.statusCode).toBe(429);
    await app.close();
  });

  it("reports not ready when a required dependency is unavailable", async () => {
    const app = await createApp({
      store: new InMemoryPlatformStore(),
      authDisabled: true,
      readinessCheck: async () => { throw new Error("redis unavailable"); }
    });
    const response = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("NOT_READY");
    await app.close();
  });

  it("bounds dependency readiness checks", async () => {
    const app = await createApp({
      store: new InMemoryPlatformStore(),
      authDisabled: true,
      readinessCheck: () => new Promise(() => undefined),
      readinessTimeoutMs: 5
    });
    const response = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("NOT_READY");
    await app.close();
  });

  it("bounds the database readiness check", async () => {
    const store = new InMemoryPlatformStore();
    Object.assign(store, { checkHealth: vi.fn(() => new Promise(() => undefined)) });
    const app = await createApp({
      store,
      authDisabled: true,
      readinessTimeoutMs: 5
    });
    const response = await app.inject({ method: "GET", url: "/api/health/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("NOT_READY");
    await app.close();
  });

  it("checks Store readiness without materializing the complete platform snapshot", async () => {
    const store = new InMemoryPlatformStore();
    const checkHealth = vi.fn(async () => undefined);
    Object.assign(store, { checkHealth });
    const getSnapshot = vi.spyOn(store, "getSnapshot").mockRejectedValue(new Error("full snapshot must not be read"));
    const app = await createApp({ store, authDisabled: true });

    const response = await app.inject({ method: "GET", url: "/api/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(checkHealth).toHaveBeenCalledOnce();
    expect(getSnapshot).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires authentication when auth is enabled", async () => {
    const app = await createApp({ store: new InMemoryPlatformStore(), authDisabled: false });
    const health = await app.inject({ method: "GET", url: "/api/v1/health/live" });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "missing@example.com", password: "invalid password" }
    });
    const response = await app.inject({ method: "GET", url: "/api/bootstrap" });

    expect(health.statusCode).toBe(200);
    expect(login.statusCode).toBe(401);
    expect(login.json().error.code).toBe("INVALID_CREDENTIALS");
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
    await app.close();
  });

  it("does not expose direct test login unless the disposable server explicitly enables it", async () => {
    const app = await createApp({ store: new InMemoryPlatformStore(), authDisabled: false });

    const response = await app.inject({ method: "POST", url: "/api/v1/auth/test-login" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(response.cookies).toEqual([]);
    await app.close();
  });

  it("issues a normal attributable Owner session for explicitly enabled disposable test login", async () => {
    const store = new InMemoryPlatformStore();
    const owner = await store.createOwner(
      "owner@disposable.test",
      await argon2.hash("disposable-owner-password", { type: argon2.argon2id })
    );
    const app = await createApp({
      store,
      authDisabled: false,
      secureCookies: false,
      testLoginOwnerEmail: owner.email
    });

    const login = await app.inject({ method: "POST", url: "/api/v1/auth/test-login" });
    const sessionCookie = login.cookies.find((entry) => entry.name === "council_session");

    expect(login.statusCode).toBe(200);
    expect(login.json()).toEqual({ user: { id: owner.id, email: owner.email } });
    expect(sessionCookie).toMatchObject({
      httpOnly: true,
      sameSite: "Strict",
      path: "/"
    });
    expect(sessionCookie?.secure).toBeUndefined();
    const bootstrap = await app.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      cookies: { council_session: sessionCookie!.value }
    });
    expect(bootstrap.statusCode).toBe(200);
    await app.close();
  });

  it("does not expose Tailnet quick login unless explicitly enabled", async () => {
    const app = await createApp({ store: new InMemoryPlatformStore(), authDisabled: false });

    const response = await app.inject({ method: "POST", url: "/api/v1/auth/tailnet-login" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(response.cookies).toEqual([]);
    await app.close();
  });

  it("rejects Tailnet quick login without an exact identity and allowed origin", async () => {
    const store = new InMemoryPlatformStore();
    const owner = await store.createOwner(
      "owner@council.example",
      await argon2.hash("tailnet-owner-password", { type: argon2.argon2id })
    );
    const app = await createApp({
      store,
      authDisabled: false,
      secureCookies: false,
      allowedOrigin: "https://council.tailnet.ts.net:8444",
      tailnetQuickLogin: { identity: "owner@tailnet.example", ownerEmail: owner.email }
    });

    for (const headers of [
      { origin: "https://council.tailnet.ts.net:8444" },
      { origin: "https://council.tailnet.ts.net:8444", "tailscale-user-login": "other@tailnet.example" },
      { origin: "https://other.example", "tailscale-user-login": "owner@tailnet.example" }
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/v1/auth/tailnet-login", headers });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "TAILNET_IDENTITY_REJECTED" } });
      expect(response.cookies).toEqual([]);
    }
    await app.close();
  });

  it("issues an audited normal Owner session for an allowed Tailnet identity", async () => {
    const store = new AuditedStore();
    const owner = await store.createOwner(
      "owner@council.example",
      await argon2.hash("tailnet-owner-password", { type: argon2.argon2id })
    );
    const app = await createApp({
      store,
      authDisabled: false,
      secureCookies: false,
      allowedOrigin: "https://council.tailnet.ts.net:8444",
      tailnetQuickLogin: { identity: "owner@tailnet.example", ownerEmail: owner.email }
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/tailnet-login",
      headers: {
        origin: "https://council.tailnet.ts.net:8444",
        "tailscale-user-login": "OWNER@TAILNET.EXAMPLE"
      }
    });
    const sessionCookie = login.cookies.find((entry) => entry.name === "council_session");

    expect(login.statusCode).toBe(200);
    expect(login.json()).toEqual({ user: { id: owner.id, email: owner.email } });
    expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/" });
    expect(store.audits).toContainEqual({
      event: "auth.tailnet_login.accepted",
      detail: { provider: "tailscale_serve" }
    });
    const bootstrap = await app.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      cookies: { council_session: sessionCookie!.value }
    });
    expect(bootstrap.statusCode).toBe(200);
    await app.close();
  });

  it("fails closed when authentication is enabled without an allowed mutation origin", async () => {
    const store = new InMemoryPlatformStore();
    await store.createOwner("origin-owner@example.com", await argon2.hash("correct horse battery staple", { type: argon2.argon2id }));
    const app = await createApp({ store, authDisabled: false, secureCookies: false });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "origin-owner@example.com", password: "correct horse battery staple" }
    });
    const sessionCookie = login.cookies.find((entry) => entry.name === "council_session");

    const response = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: { "idempotency-key": "missing-origin-guard" },
      cookies: { council_session: sessionCookie!.value },
      payload: { name: "Missing origin Role", responsibility: "Must not be created." }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "ORIGIN_REJECTED" } });
    await app.close();
  });

  it("protects percent-encoded API paths with the canonical route authority", async () => {
    const app = await createApp({ store: new InMemoryPlatformStore(), authDisabled: false });

    const response = await app.inject({ method: "GET", url: "/%61pi/bootstrap" });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
    await app.close();
  });

  it("does not expose implicit HEAD routes outside the AuthorityMap", async () => {
    const app = await createApp({ store: new InMemoryPlatformStore(), authDisabled: true });

    expect(app.hasRoute({ method: "HEAD", url: "/api/health/live" })).toBe(false);
    expect(app.hasRoute({ method: "HEAD", url: "/api/bootstrap" })).toBe(false);
    expect((await app.inject({ method: "HEAD", url: "/api/v1/health/live" })).statusCode).toBe(404);
    await app.close();
  });

  it("returns bounded versioned page projections with cache validators", async () => {
    const app = await createApp({ store: new InMemoryPlatformStore(), authDisabled: true });
    const response = await app.inject({ method: "GET", url: "/api/v1/views/tasks" });

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(response.json()).toEqual(expect.objectContaining({
      agents: expect.any(Array),
      decisions: expect.any(Array),
      meetings: expect.any(Array),
      taskAdapterConnectors: expect.any(Array),
      tasks: expect.any(Array),
      utterances: [],
      prompts: [],
      runtimeProfileRevisions: []
    }));

    const notModified = await app.inject({
      method: "GET",
      url: "/api/v1/views/tasks",
      headers: { "if-none-match": response.headers.etag }
    });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.body).toBe("");

    const discussions = await app.inject({ method: "GET", url: "/api/v1/views/discussions" });
    expect(discussions.statusCode).toBe(200);
    expect(discussions.json()).toEqual(expect.objectContaining({
      groups: expect.any(Array),
      categories: expect.any(Array),
      threads: expect.any(Array),
      meetings: expect.any(Array),
      participants: [],
      speakerQueue: [],
      utterances: [],
      toolRuns: [],
      chairSuggestions: [],
      decisions: [],
      tasks: []
    }));
    await app.close();
  });

  it("serves all API handlers through the v1 prefix and publishes their route catalog", async () => {
    const app = await createApp({ store: new InMemoryPlatformStore(), authDisabled: true });

    const bootstrap = await app.inject({ method: "GET", url: "/api/v1/bootstrap" });
    const openapi = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });

    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json()).toEqual(expect.objectContaining({ agents: expect.any(Array), meetings: expect.any(Array) }));
    expect(openapi.statusCode).toBe(200);
    expect(openapi.json()).toEqual(expect.objectContaining({
      openapi: "3.1.0",
      paths: expect.objectContaining({
        "/api/v1/agents": expect.objectContaining({ post: expect.any(Object) }),
        "/api/v1/meetings/{id}/run": expect.objectContaining({ post: expect.any(Object) }),
        "/api/v1/views/{view}": expect.objectContaining({ get: expect.any(Object) })
      })
    }));
    expect(openapi.json().paths).not.toHaveProperty("/api/agents");
    await app.close();
  });

  it("keeps Bootstrap compatible with bounded Task record IDs from legacy migrations", async () => {
    const store = new InMemoryPlatformStore();
    const seed = await store.getSnapshot();
    const decision = await store.createDecision({
      meetingId: seed.meetings[0]!.id,
      title: "Legacy Task compatibility",
      description: "Preserve identifiers created by additive migrations."
    });
    await store.setDecisionStatus(decision.id, "approved");
    await store.createTask({ decisionId: decision.id, title: decision.title, description: decision.description });
    const snapshot = await store.getSnapshot();
    const task = snapshot.tasks[0]!;
    task.evidence[0]!.id = `meeting:${task.id}`;
    task.transitions[0]!.id = `migration014:approval:${task.id}`;
    vi.spyOn(store, "getSnapshot").mockResolvedValue(snapshot);
    const app = await createApp({ store, authDisabled: true });

    const response = await app.inject({ method: "GET", url: "/api/bootstrap" });

    expect(response.statusCode).toBe(200);
    expect(response.json().tasks[0].evidence[0].id).toBe(`meeting:${task.id}`);
    expect(response.json().tasks[0].transitions[0].id).toBe(`migration014:approval:${task.id}`);
    await app.close();
  });

  it("fails closed when a page projection violates its response contract", async () => {
    const store = new InMemoryPlatformStore();
    store.getViewSnapshot = async () => ({ unexpected: [{ apiKey: "must-not-leak" }] }) as never;
    const app = await createApp({ store, authDisabled: true });

    const response = await app.inject({ method: "GET", url: "/api/v1/views/tasks" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "RESPONSE_CONTRACT_VIOLATION", message: "The response could not be serialized safely." }
    });
    expect(response.body).not.toContain("apiKey");
    expect(response.body).not.toContain("must-not-leak");
    await app.close();
  });

  it("does not turn a malformed dependency status into a successful API response", async () => {
    const store = new InMemoryPlatformStore();
    store.getSnapshot = async () => {
      throw Object.assign(new Error("dependency failed"), { statusCode: 200 });
    };
    const app = await createApp({ store, authDisabled: true });

    const response = await app.inject({ method: "GET", url: "/api/bootstrap" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "REQUEST_FAILED", message: "The request could not be completed." }
    });
    expect(response.body).not.toContain("dependency failed");
    await app.close();
  });

  it("returns only one meeting's live state from the versioned meeting view", async () => {
    const store = new InMemoryPlatformStore();
    const meetingId = (await store.getSnapshot()).meetings[0]!.id;
    const app = await createApp({ store, authDisabled: true });

    const response = await app.inject({ method: "GET", url: `/api/v1/meetings/${meetingId}/view` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({
      meeting: expect.objectContaining({ id: meetingId }),
      participants: expect.arrayContaining([expect.objectContaining({ meetingId })]),
      utterances: expect.arrayContaining([expect.objectContaining({ meetingId })]),
      speakerQueue: expect.any(Array),
      toolRuns: expect.any(Array),
      chairSuggestions: expect.any(Array),
      decisions: expect.any(Array),
      tasks: expect.any(Array)
    }));
    for (const collection of ["participants", "utterances", "speakerQueue", "toolRuns", "chairSuggestions", "decisions", "tasks"] as const) {
      expect(response.json()[collection].every((item: { meetingId: string }) => item.meetingId === meetingId)).toBe(true);
    }

    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/meetings/00000000-0000-4000-8000-000000000099/view"
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("MEETING_NOT_FOUND");
    await app.close();
  });

  it("authenticates the owner and rejects a foreign mutation origin", async () => {
    const store = new InMemoryPlatformStore();
    await store.createOwner("owner@example.com", await argon2.hash("correct horse battery staple", { type: argon2.argon2id }));
    const app = await createApp({
      store,
      authDisabled: false,
      secureCookies: false,
      allowedOrigin: "https://council.test"
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "owner@example.com", password: "correct horse battery staple" }
    });
    expect(login.statusCode).toBe(200);
    const sessionCookie = login.cookies.find((entry) => entry.name === "council_session");
    expect(sessionCookie?.httpOnly).toBe(true);
    expect(sessionCookie?.sameSite).toBe("Strict");

    const bootstrap = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      cookies: { council_session: sessionCookie!.value }
    });
    expect(bootstrap.statusCode).toBe(200);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: { origin: "https://evil.example" },
      cookies: { council_session: sessionCookie!.value },
      payload: { name: "Observer", responsibility: "Read only" }
    });
    expect(rejected.statusCode).toBe(403);
    await app.close();
  });

  it("keeps mutation origin checks enabled when authentication is bypassed", async () => {
    const store = new InMemoryPlatformStore();
    const roleCount = (await store.getSnapshot()).roles.length;
    const app = await createApp({
      store,
      authDisabled: true,
      allowedOrigin: "https://council.test"
    });
    const rejected = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: { origin: "https://evil.example" },
      payload: { name: "Observer", responsibility: "Read only" }
    });
    expect(rejected.statusCode).toBe(403);

    const missing = await app.inject({
      method: "POST",
      url: "/api/roles",
      payload: { name: "Observer", responsibility: "Read only" }
    });
    expect(missing.statusCode).toBe(403);
    expect(missing.json().error.code).toBe("ORIGIN_REJECTED");

    const encoded = await app.inject({
      method: "POST",
      url: "/%61pi/roles",
      payload: { name: "Encoded observer", responsibility: "Read only" }
    });
    expect(encoded.statusCode).toBe(403);
    expect(encoded.json().error.code).toBe("ORIGIN_REJECTED");
    expect((await store.getSnapshot()).roles).toHaveLength(roleCount);
    await app.close();
  });

  it("creates and updates role behavior without granting approval authority", async () => {
    const store = new AuditedStore();
    const app = await createApp({ store, authDisabled: true });
    const created = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: { "idempotency-key": "role-behavior-create" },
      payload: {
        name: "研究主持",
        usageContext: "用於需要收斂研究問題與查核證據的會議。",
        responsibility: "收斂研究問題與證據。",
        speakingGuidance: "先引用證據，再提出下一個問題。",
        decisionScope: "可整理候選決議，不可代替擁有者核准。",
        constraints: "不得把推論描述為事實。",
        templateKey: "evidence_analyst",
        toolPolicy: "agent_read_only_grants",
        dataPolicy: "agent_declared_scope"
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      version: 1,
      usageContext: "用於需要收斂研究問題與查核證據的會議。",
      templateKey: "evidence_analyst",
      toolPolicy: "agent_read_only_grants",
      dataPolicy: "agent_declared_scope"
    });

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/roles/${created.json().id}`,
      payload: {
        expectedCurrentVersion: 1,
        usageContext: "用於證據不足且需要釐清研究方向的會議。",
        speakingGuidance: "先指出證據缺口，再提出下一個問題。",
        toolPolicy: "none",
        dataPolicy: "meeting_only"
      }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      responsibility: "收斂研究問題與證據。",
      usageContext: "用於證據不足且需要釐清研究方向的會議。",
      speakingGuidance: "先指出證據缺口，再提出下一個問題。",
      decisionScope: "可整理候選決議，不可代替擁有者核准。",
      constraints: "不得把推論描述為事實。",
      version: 2,
      toolPolicy: "none",
      dataPolicy: "meeting_only"
    });
    expect(store.audits.find((item) => item.event === "role.updated")?.detail).toMatchObject({ previousVersion: 1, version: 2 });
    await app.close();
  });

  it("exposes on-demand Role history, creates a new rollback version, and safely deletes", async () => {
    const store = new AuditedStore();
    const app = await createApp({ store, authDisabled: true });
    const created = await app.inject({
      method: "POST",
      url: "/api/roles",
      headers: { "idempotency-key": "role-lifecycle-create" },
      payload: { name: "觀察者", usageContext: "用於旁聽並記錄會議差異。", responsibility: "記錄會議差異。" }
    });
    const roleId = created.json().id as string;
    await app.inject({
      method: "PATCH",
      url: `/api/roles/${roleId}`,
      payload: { usageContext: "用於旁聽並記錄會議差異與證據缺口。", responsibility: "記錄會議差異與證據缺口。", expectedCurrentVersion: 1 }
    });

    const history = await app.inject({ method: "GET", url: `/api/roles/${roleId}/lifecycle` });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({
      role: { id: roleId, version: 2 },
      canDelete: true,
      unfinishedMeetingCount: 0,
      activeTeamCount: 0,
      historicalMeetingCount: 0,
      versions: [
        expect.objectContaining({ roleId, version: 2, source: "updated" }),
        expect.objectContaining({ roleId, version: 1, source: "created" })
      ]
    });

    const restored = await app.inject({
      method: "POST",
      url: `/api/roles/${roleId}/rollback`,
      payload: { version: 1, expectedCurrentVersion: 2 }
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ version: 3, usageContext: "用於旁聽並記錄會議差異。", responsibility: "記錄會議差異。" });

    const stale = await app.inject({
      method: "POST",
      url: `/api/roles/${roleId}/rollback`,
      payload: { version: 1, expectedCurrentVersion: 2 }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("REVISION_CONFLICT");
    expect(stale.json().error.message).toMatch(/version changed/i);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/roles/${roleId}`,
      headers: { "idempotency-key": "delete-restored-role" },
      payload: { expectedCurrentVersion: 3 }
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ id: roleId, historicalMeetingCount: 0 });
    expect((await store.getRoleVersions(roleId))[0]).toMatchObject({ version: 3, source: "rollback", restoredFromVersion: 1 });
    expect((await store.getSnapshot()).roles.find((role) => role.id === roleId)?.deletedAt).toEqual(expect.any(String));
    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(bootstrap.json().roles.some((role: { id: string }) => role.id === roleId)).toBe(false);
    expect(store.events).toContain("role.rolled_back");
    expect(store.events).toContain("role.deleted");
    await app.close();
  });

  it("rejects deletion of a Role referenced by an unfinished Meeting", async () => {
    const store = new InMemoryPlatformStore();
    const roleId = (await store.getSnapshot()).participants[0]!.roleId;
    const app = await createApp({ store, authDisabled: true });

    const lifecycle = await app.inject({ method: "GET", url: `/api/roles/${roleId}/lifecycle` });
    expect(lifecycle.json()).toMatchObject({ canDelete: false, unfinishedMeetingCount: 1 });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/roles/${roleId}`,
      headers: { "idempotency-key": "reject-referenced-role-deletion" },
      payload: { expectedCurrentVersion: 1 }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/unfinished Meeting/i);
    await app.close();
  });

  it("accepts only human utterance input and keeps evidence fields server-controlled", async () => {
    const store = new InMemoryPlatformStore();
    const meetingId = (await store.getSnapshot()).meetings[0]!.id;
    const app = await createApp({ store, authDisabled: true });

    const forged = await app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/utterances`,
      payload: {
        content: "偽造工具證據",
        speakerType: "tool",
        speakerName: "Trusted Tool",
        kind: "verified",
        evidenceCount: 99
      }
    });
    expect(forged.statusCode).toBe(400);

    const accepted = await app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/utterances`,
      headers: { "idempotency-key": "human-input-contract" },
      payload: { content: "請主席收斂目前議題。" }
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().utterance).toMatchObject({
      speakerType: "human",
      speakerName: "Owner",
      roleName: "決策者",
      kind: "human",
      evidenceCount: 0
    });
    await app.close();
  });

  it("replays one Human utterance and Chair coordination after a lost HTTP acknowledgement", async () => {
    const store = new InMemoryPlatformStore();
    const meetingId = (await store.getSnapshot()).meetings[0]!.id;
    const createSuggestion = vi.spyOn(store, "createChairSuggestion");
    const app = await createApp({ store, authDisabled: true });
    const beforeCount = (await store.getSnapshot()).utterances.length;
    const request = {
      method: "POST" as const,
      url: `/api/meetings/${meetingId}/utterances`,
      headers: { "idempotency-key": "lost-human-ack" },
      payload: { content: "午餐與旅遊安排和目前的 Agent Runtime 議程沒有關係。" }
    };

    const first = await app.inject(request);
    const replay = await app.inject(request);

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect((await store.getSnapshot()).utterances).toHaveLength(beforeCount + 1);
    expect(createSuggestion).toHaveBeenCalledTimes(1);

    const conflict = await app.inject({
      ...request,
      payload: { content: "The same key must not authorize different content." }
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    await app.close();
  });

  it("publishes and coordinates one concurrent identical Human utterance", async () => {
    const store = new InMemoryPlatformStore();
    const meetingId = (await store.getSnapshot()).meetings[0]!.id;
    const originalAddUtterance = store.addUtteranceWithDisposition.bind(store);
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(store, "addUtteranceWithDisposition").mockImplementation(async (targetMeetingId, input) => {
      arrivals += 1;
      if (arrivals === 2) release();
      await gate;
      return originalAddUtterance(targetMeetingId, input);
    });
    const createSuggestion = vi.spyOn(store, "createChairSuggestion");
    const publish = vi.fn(async (_event: MeetingEvent) => undefined);
    const app = await createApp({
      store,
      authDisabled: true,
      eventBus: { publish } as unknown as MeetingEventBus
    });
    const beforeCount = (await store.getSnapshot()).utterances.length;
    const request = () => app.inject({
      method: "POST" as const,
      url: `/api/meetings/${meetingId}/utterances`,
      headers: { "idempotency-key": "concurrent-identical-human" },
      payload: { content: "午餐與旅遊安排和目前的 Agent Runtime 議程沒有關係。" }
    });

    const responses = await Promise.all([request(), request()]);

    expect(responses.map((response) => response.statusCode)).toEqual([201, 201]);
    expect(responses[1]!.json().utterance).toEqual(responses[0]!.json().utterance);
    expect((await store.getSnapshot()).utterances).toHaveLength(beforeCount + 1);
    expect(publish.mock.calls.filter(([event]) => event.type === "utterance.created")).toHaveLength(1);
    expect(createSuggestion).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("rejects concurrent Human utterances that reuse one idempotency key for different content", async () => {
    const store = new InMemoryPlatformStore();
    const meetingId = (await store.getSnapshot()).meetings[0]!.id;
    const originalAddUtterance = store.addUtteranceWithDisposition.bind(store);
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(store, "addUtteranceWithDisposition").mockImplementation(async (targetMeetingId, input) => {
      arrivals += 1;
      if (arrivals === 2) release();
      await gate;
      return originalAddUtterance(targetMeetingId, input);
    });
    const app = await createApp({ store, authDisabled: true });
    const beforeCount = (await store.getSnapshot()).utterances.length;
    const request = (content: string) => app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/utterances`,
      headers: { "idempotency-key": "concurrent-human-conflict" },
      payload: { content }
    });

    const responses = await Promise.all([
      request("The first concurrent Human utterance."),
      request("The second concurrent Human utterance must conflict.")
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const conflict = responses.find((response) => response.statusCode === 409);
    expect(conflict?.json().error.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect((await store.getSnapshot()).utterances).toHaveLength(beforeCount + 1);
    await app.close();
  });

  it("does not append a Human utterance when the Meeting closes during the request", async () => {
    const store = new InMemoryPlatformStore();
    const meetingId = (await store.getSnapshot()).meetings[0]!.id;
    const originalAddUtterance = store.addUtteranceWithDisposition.bind(store);
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    let releaseAdd!: () => void;
    const gate = new Promise<void>((resolve) => { releaseAdd = resolve; });
    vi.spyOn(store, "addUtteranceWithDisposition").mockImplementation(async (targetMeetingId, input) => {
      signalEntered();
      await gate;
      return originalAddUtterance(targetMeetingId, input);
    });
    const app = await createApp({ store, authDisabled: true });
    const beforeCount = (await store.getSnapshot()).utterances.length;

    const pendingResponse = app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/utterances`,
      headers: { "idempotency-key": "utterance-close-race" },
      payload: { content: "This request raced with Meeting closure." }
    });
    await entered;
    await store.setMeetingState(meetingId, "closed");
    releaseAdd();
    const response = await pendingResponse;

    expect(response.statusCode).toBe(409);
    expect((await store.getSnapshot()).utterances).toHaveLength(beforeCount);
    await app.close();
  });

  it("persists a Human-triggered Chair suggestion in bootstrap state", async () => {
    const store = new InMemoryPlatformStore();
    const meetingId = (await store.getSnapshot()).meetings[0]!.id;
    const app = await createApp({ store, authDisabled: true });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/utterances`,
      headers: { "idempotency-key": "chair-suggestion-bootstrap" },
      payload: { content: "午餐與旅遊安排和目前的 Agent Runtime 議程沒有關係。" }
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().chairSuggestion).toMatchObject({
      id: expect.any(String),
      meetingId,
      status: "open",
      sourceUtteranceId: response.json().utterance.id,
      transitions: [expect.objectContaining({ type: "created" })]
    });

    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(bootstrap.json().chairSuggestions).toContainEqual(expect.objectContaining({
      id: response.json().chairSuggestion.id,
      status: "open"
    }));
    await app.close();
  });

  it("changes Chair automation with CAS and publishes an SSE refresh event", async () => {
    const store = new AuditedStore();
    const meeting = (await store.getSnapshot()).meetings[0]!;
    const eventBus = new MeetingEventBus();
    const events: MeetingEvent[] = [];
    const unsubscribe = await eventBus.subscribe(meeting.id, (event) => events.push(event));
    const app = await createApp({ store, authDisabled: true, eventBus });

    const changed = await app.inject({
      method: "PATCH",
      url: `/api/meetings/${meeting.id}/automation`,
      payload: { automation: "auto", expectedAutomation: "suggest", expectedAutomationRevision: 0 }
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ automation: "auto", automationRevision: 1 });
    expect(events).toContainEqual(expect.objectContaining({
      type: "meeting.automation.changed",
      data: expect.objectContaining({ automation: "auto", automationRevision: 1 })
    }));

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/meetings/${meeting.id}/automation`,
      payload: { automation: "manual", expectedAutomation: "suggest", expectedAutomationRevision: 0 }
    });
    expect(stale.statusCode).toBe(409);

    const manual = await app.inject({
      method: "PATCH",
      url: `/api/meetings/${meeting.id}/automation`,
      payload: { automation: "manual", expectedAutomation: "auto", expectedAutomationRevision: 1 }
    });
    expect(manual.statusCode).toBe(200);
    const autoAgain = await app.inject({
      method: "PATCH",
      url: `/api/meetings/${meeting.id}/automation`,
      payload: { automation: "auto", expectedAutomation: "manual", expectedAutomationRevision: 2 }
    });
    expect(autoAgain.statusCode).toBe(200);
    const abaStale = await app.inject({
      method: "PATCH",
      url: `/api/meetings/${meeting.id}/automation`,
      payload: { automation: "manual", expectedAutomation: "auto", expectedAutomationRevision: 1 }
    });
    expect(abaStale.statusCode).toBe(409);
    unsubscribe();
    await eventBus.close();
    await app.close();
  });

  it("keeps a committed Chair automation change successful when SSE delivery fails", async () => {
    const store = new AuditedStore();
    const meeting = (await store.getSnapshot()).meetings[0]!;
    const eventBus = new MeetingEventBus();
    const fallbackEvents: MeetingEvent[] = [];
    const unsubscribe = await eventBus.subscribe(meeting.id, (event) => fallbackEvents.push(event));
    vi.spyOn(eventBus, "publish").mockRejectedValue(new Error("Redis unavailable"));
    const app = await createApp({ store, authDisabled: true, eventBus });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/meetings/${meeting.id}/automation`,
      payload: { automation: "auto", expectedAutomation: "suggest", expectedAutomationRevision: 0 }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ automation: "auto", automationRevision: 1 });
    expect((await store.getSnapshot()).meetings[0]).toMatchObject({ automation: "auto", automationRevision: 1 });
    expect(fallbackEvents).toContainEqual(expect.objectContaining({
      type: "meeting.automation.changed",
      meetingId: meeting.id
    }));
    unsubscribe();
    await app.close();
  });

  it("keeps committed Meeting mutations successful when event delivery fails", async () => {
    const store = new InMemoryPlatformStore();
    const meeting = (await store.getSnapshot()).meetings[0]!;
    const eventBus = new MeetingEventBus();
    vi.spyOn(eventBus, "publish").mockRejectedValue(new Error("Redis unavailable"));
    const app = await createApp({ store, authDisabled: true, eventBus });
    const utteranceCount = (await store.getSnapshot()).utterances.length;

    const utterance = await app.inject({
      method: "POST",
      url: `/api/meetings/${meeting.id}/utterances`,
      headers: { "idempotency-key": "utterance-event-failure" },
      payload: { content: "午餐安排與目前架構決策無關，請主席提醒我回到議題。" }
    });
    expect(utterance.statusCode).toBe(201);
    expect((await store.getSnapshot()).utterances).toHaveLength(utteranceCount + 1);
    const suggestionId = utterance.json().chairSuggestion?.id as string | undefined;
    expect(suggestionId).toEqual(expect.any(String));

    const dismissed = await app.inject({
      method: "POST",
      url: `/api/meetings/${meeting.id}/chair-suggestions/${suggestionId}/dismiss`
    });
    expect(dismissed.statusCode).toBe(200);
    expect((await store.getSnapshot()).chairSuggestions.find((item) => item.id === suggestionId)).toMatchObject({
      status: "resolved",
      resolution: "dismissed"
    });

    const changedMode = await app.inject({
      method: "POST",
      url: `/api/meetings/${meeting.id}/mode`,
      payload: { mode: "chaired", reason: "Owner selected chaired discussion." }
    });
    expect(changedMode.statusCode).toBe(200);
    expect((await store.getSnapshot()).meetings.find((item) => item.id === meeting.id)?.mode).toBe("chaired");
    await app.close();
  });

  it("does not commit a Meeting transition when its required audit fails", async () => {
    const store = new FailingMeetingTransitionAuditStore();
    let meeting = (await store.getSnapshot()).meetings[0]!;
    if (meeting.state !== "active") {
      meeting = await store.setMeetingState(meeting.id, "active", meeting.state);
    }
    const app = await createApp({ store, authDisabled: true });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${meeting.id}/pause`
    });

    expect(response.statusCode).toBe(500);
    expect((await store.getSnapshot()).meetings.find((item) => item.id === meeting.id)?.state).toBe("active");
    await app.close();
  });

  it("keeps a committed utterance successful when Chair coordination fails", async () => {
    const store = new InMemoryPlatformStore();
    const meeting = (await store.getSnapshot()).meetings[0]!;
    vi.spyOn(store, "createChairSuggestion").mockRejectedValue(new Error("Chair persistence unavailable"));
    const app = await createApp({ store, authDisabled: true });
    const utteranceCount = (await store.getSnapshot()).utterances.length;

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${meeting.id}/utterances`,
      headers: { "idempotency-key": "chair-coordination-failure" },
      payload: { content: "午餐安排與目前架構決策無關，請主席提醒我回到議題。" }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ chairSuggestion: null });
    expect((await store.getSnapshot()).utterances).toHaveLength(utteranceCount + 1);
    await app.close();
  });

  it("retries Chair coordination for a committed Human utterance without duplicating stable admission", async () => {
    const store = new InMemoryPlatformStore();
    const meeting = (await store.getSnapshot()).meetings[0]!;
    await store.setMeetingAutomation(meeting.id, {
      automation: "auto",
      expectedAutomation: "suggest",
      expectedAutomationRevision: 0
    });
    const createSuggestion = vi.spyOn(store, "createChairSuggestion");
    const reserveAdmission = vi.spyOn(store, "reserveChairAutomationJobAdmission")
      .mockRejectedValueOnce(new Error("Chair admission temporarily unavailable"));
    const enqueueChairAutomation = vi.fn(async (_job, requestedJobId?: string) => ({ jobId: requestedJobId! }));
    const agentQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary" })),
      enqueueChairAutomation,
      close: vi.fn(async () => undefined)
    } as AgentTurnQueue;
    const app = await createApp({ store, authDisabled: true, agentQueue });
    const utteranceCount = (await store.getSnapshot()).utterances.length;
    const request = {
      method: "POST" as const,
      url: `/api/meetings/${meeting.id}/utterances`,
      headers: { "idempotency-key": "retry-committed-chair-coordination" },
      payload: { content: "午餐安排與目前架構決策無關，請主席提醒我回到議題。" }
    };

    const first = await app.inject(request);
    const retry = await app.inject(request);
    const replay = await app.inject(request);
    const snapshot = await store.getSnapshot();
    const admissions = await store.getChairAutomationJobAdmissions();

    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ chairSuggestion: null });
    expect(retry.statusCode).toBe(201);
    expect(retry.json().chairSuggestion).toMatchObject({ sourceUtteranceId: first.json().utterance.id });
    expect(replay.json()).toEqual(retry.json());
    expect(snapshot.utterances).toHaveLength(utteranceCount + 1);
    expect(snapshot.chairSuggestions.filter((suggestion) => suggestion.sourceUtteranceId === first.json().utterance.id))
      .toHaveLength(1);
    expect(createSuggestion).toHaveBeenCalledTimes(2);
    expect(reserveAdmission).toHaveBeenCalledTimes(2);
    expect(enqueueChairAutomation).toHaveBeenCalledOnce();
    expect(admissions).toEqual([
      expect.objectContaining({
        chairSuggestionId: retry.json().chairSuggestion.id,
        jobId: chairAutomationJobId(meeting.id, retry.json().chairSuggestion.id),
        status: "admitted"
      })
    ]);
    await app.close();
  });

  it("returns a structured 503 before starting SSE when Redis subscription fails", async () => {
    const store = new InMemoryPlatformStore();
    const meeting = (await store.getSnapshot()).meetings[0]!;
    const eventBus = new MeetingEventBus();
    vi.spyOn(eventBus, "subscribe").mockRejectedValue(new Error("Redis unavailable"));
    const app = await createApp({ store, authDisabled: true, eventBus });

    const response = await app.inject({
      method: "GET",
      url: `/api/meetings/${meeting.id}/events`
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "EVENTS_UNAVAILABLE", message: "Event stream is temporarily unavailable." }
    });
    await app.close();
  });

  it("does not analyze or queue a Human utterance in manual Chair mode", async () => {
    const store = new AuditedStore();
    const meeting = (await store.getSnapshot()).meetings[0]!;
    await store.setMeetingAutomation(meeting.id, { automation: "manual", expectedAutomation: "suggest", expectedAutomationRevision: 0 });
    const enqueueChairAutomation = vi.fn(async () => ({ jobId: "unexpected" }));
    const agentQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary" })),
      enqueueChairAutomation,
      close: vi.fn(async () => undefined)
    } as AgentTurnQueue;
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${meeting.id}/utterances`,
      headers: { "idempotency-key": "manual-chair-utterance" },
      payload: { content: "午餐與旅遊安排和目前的 Agent Runtime 議程沒有關係。" }
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ chairSuggestion: null });
    expect(enqueueChairAutomation).not.toHaveBeenCalled();
    expect((await store.getSnapshot()).chairSuggestions).toEqual([]);
    await app.close();
  });

  it("queues one revision-bound automatic Chair action with a stable suggestion job ID", async () => {
    const store = new AuditedStore();
    const meeting = (await store.getSnapshot()).meetings[0]!;
    await store.setMeetingAutomation(meeting.id, { automation: "auto", expectedAutomation: "suggest", expectedAutomationRevision: 0 });
    const enqueueChairAutomation = vi.fn(async (_job, requestedJobId?: string) => ({ jobId: requestedJobId! }));
    const agentQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary" })),
      enqueueChairAutomation,
      close: vi.fn(async () => undefined)
    } as AgentTurnQueue;
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${meeting.id}/utterances`,
      headers: { "idempotency-key": "automatic-chair-utterance" },
      payload: { content: "午餐與旅遊安排和目前的 Agent Runtime 議程沒有關係。" }
    });
    expect(response.statusCode).toBe(201);
    const suggestion = response.json().chairSuggestion;
    const expectedJobId = chairAutomationJobId(meeting.id, suggestion.id);
    expect(enqueueChairAutomation).toHaveBeenCalledTimes(1);
    expect(enqueueChairAutomation).toHaveBeenCalledWith({
      meetingId: meeting.id,
      chairSuggestionId: suggestion.id,
      sourceUtteranceId: response.json().utterance.id,
      automationRevision: 1,
      requestedBy: "system"
    }, expectedJobId);
    await app.close();
  });

  it("keeps an open suggestion when automatic Chair dispatch is unavailable", async () => {
    const store = new AuditedStore();
    const meeting = (await store.getSnapshot()).meetings[0]!;
    await store.setMeetingAutomation(meeting.id, { automation: "auto", expectedAutomation: "suggest", expectedAutomationRevision: 0 });
    const app = await createApp({ store, authDisabled: true });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${meeting.id}/utterances`,
      headers: { "idempotency-key": "unavailable-chair-dispatch" },
      payload: { content: "午餐與旅遊安排和目前的 Agent Runtime 議程沒有關係。" }
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().chairSuggestion).toMatchObject({ status: "open" });
    expect(store.audits).toContainEqual(expect.objectContaining({
      event: "chair.automation.enqueue_failed",
      detail: expect.objectContaining({ classification: "queue_unavailable" })
    }));
    await app.close();
  });

  it("creates a discussion taxonomy before creating its Topic", async () => {
    const store = new AuditedStore();
    const app = await createApp({ store, authDisabled: true });

    const groupResponse = await app.inject({
      method: "POST",
      url: "/api/groups",
      headers: { "idempotency-key": "group-1" },
      payload: { name: "客戶交付" }
    });
    expect(groupResponse.statusCode).toBe(201);
    const group = groupResponse.json();

    const categoryResponse = await app.inject({
      method: "POST",
      url: "/api/categories",
      headers: { "idempotency-key": "category-1" },
      payload: { groupId: group.id, name: "上線評審" }
    });
    expect(categoryResponse.statusCode).toBe(201);
    const category = categoryResponse.json();

    const tagResponse = await app.inject({
      method: "POST",
      url: "/api/tags",
      headers: { "idempotency-key": "tag-1" },
      payload: { name: "待決策", color: "amber" }
    });
    expect(tagResponse.statusCode).toBe(201);
    const tag = tagResponse.json();

    const threadResponse = await app.inject({
      method: "POST",
      url: "/api/threads",
      headers: { "idempotency-key": "thread-taxonomy-1" },
      payload: {
        categoryId: category.id,
        title: "正式上線話題",
        summary: "確認上線條件與負責人",
        tagIds: [tag.id]
      }
    });
    expect(threadResponse.statusCode).toBe(201);

    expect((await app.inject({
      method: "POST",
      url: "/api/groups",
      headers: { "idempotency-key": "group-1" },
      payload: { name: "客戶交付" }
    })).json()).toEqual(group);
    expect((await app.inject({
      method: "POST",
      url: "/api/categories",
      headers: { "idempotency-key": "category-1" },
      payload: { groupId: group.id, name: "上線評審" }
    })).json()).toEqual(category);
    expect((await app.inject({
      method: "POST",
      url: "/api/tags",
      headers: { "idempotency-key": "tag-1" },
      payload: { name: "待決策", color: "amber" }
    })).json()).toEqual(tag);
    expect((await app.inject({
      method: "POST",
      url: "/api/threads",
      headers: { "idempotency-key": "thread-taxonomy-1" },
      payload: {
        categoryId: category.id,
        title: "正式上線話題",
        summary: "確認上線條件與負責人",
        tagIds: [tag.id]
      }
    })).json()).toEqual(threadResponse.json());

    const snapshot = (await app.inject({ method: "GET", url: "/api/bootstrap" })).json();
    expect(snapshot.groups).toContainEqual(group);
    expect(snapshot.categories).toContainEqual(category);
    expect(snapshot.tags).toContainEqual(tag);
    expect(snapshot.threads).toContainEqual(expect.objectContaining({
      id: threadResponse.json().id,
      categoryId: category.id,
      tagIds: [tag.id]
    }));
    expect(store.events).toEqual(["group.created", "category.created", "tag.created", "thread.created"]);
    await app.close();
  });

  it("rejects reusing an idempotency key with a different taxonomy payload", async () => {
    const store = new AuditedStore();
    const app = await createApp({ store, authDisabled: true });

    expect((await app.inject({
      method: "POST",
      url: "/api/groups",
      headers: { "idempotency-key": "group-reused" },
      payload: { name: "第一個群組" }
    })).statusCode).toBe(201);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/groups",
      headers: { "idempotency-key": "group-reused" },
      payload: { name: "不同群組" }
    });

    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error.message).toMatch(/idempotency key/i);
    expect((await store.getSnapshot()).groups.filter((group) => ["第一個群組", "不同群組"].includes(group.name))).toHaveLength(1);
    expect(store.events).toEqual(["group.created"]);
    await app.close();
  });

  it("requires one stable idempotency key for Tag creation and rejects payload drift", async () => {
    const store = new AuditedStore();
    const app = await createApp({ store, authDisabled: true });

    const missingKey = await app.inject({
      method: "POST",
      url: "/api/tags",
      payload: { name: "No retry identity", color: "gray" }
    });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });

    const created = await app.inject({
      method: "POST",
      url: "/api/tags",
      headers: { "idempotency-key": "stable-tag-create" },
      payload: { name: "Stable tag", color: "green" }
    });
    expect(created.statusCode).toBe(201);

    const conflicting = await app.inject({
      method: "POST",
      url: "/api/tags",
      headers: { "idempotency-key": "stable-tag-create" },
      payload: { name: "Changed tag", color: "red" }
    });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json().error.message).toMatch(/idempotency key/i);

    const snapshot = await store.getSnapshot();
    expect(snapshot.tags.filter((tag) => ["No retry identity", "Stable tag", "Changed tag"].includes(tag.name)))
      .toEqual([expect.objectContaining({ id: created.json().id, name: "Stable tag", color: "green" })]);
    await app.close();
  });

  it("updates Group, Category, and Tag taxonomy through PATCH with audit values and existing errors", async () => {
    const store = new AuditedStore();
    const app = await createApp({ store, authDisabled: true });
    const snapshot = await store.getSnapshot();
    const group = snapshot.groups[0]!;
    const category = snapshot.categories[0]!;
    const tag = snapshot.tags[0]!;
    const target = await store.createGroup({ name: "Target group" });

    const groupUpdate = await app.inject({ method: "PATCH", url: `/api/groups/${group.id}`, payload: { expectedRevision: group.revision, name: "Renamed group" } });
    const categoryUpdate = await app.inject({
      method: "PATCH",
      url: `/api/categories/${category.id}`,
      payload: { expectedRevision: category.revision, groupId: target.id, name: "Moved category" }
    });
    const tagUpdate = await app.inject({ method: "PATCH", url: `/api/tags/${tag.id}`, payload: { expectedRevision: tag.revision, name: "Renamed tag", color: "blue" } });

    expect(groupUpdate.statusCode).toBe(200);
    expect(groupUpdate.json()).toMatchObject({ id: group.id, name: "Renamed group" });
    expect(categoryUpdate.statusCode).toBe(200);
    expect(categoryUpdate.json()).toMatchObject({ id: category.id, groupId: target.id, name: "Moved category" });
    expect(tagUpdate.statusCode).toBe(200);
    expect(tagUpdate.json()).toMatchObject({ id: tag.id, name: "Renamed tag", color: "blue" });
    expect(store.audits.slice(-3)).toEqual([
      expect.objectContaining({ event: "group.updated", detail: { fields: ["name"], previousRevision: 1, revision: 2, previous: { name: group.name }, current: { name: "Renamed group" } } }),
      expect.objectContaining({ event: "category.updated", detail: { fields: ["groupId", "name"], previousRevision: 1, revision: 2, previous: { groupId: category.groupId, name: category.name }, current: { groupId: target.id, name: "Moved category" } } }),
      expect.objectContaining({ event: "tag.updated", detail: { fields: ["name", "color"], previousRevision: 1, revision: 2, previous: { name: tag.name, color: tag.color }, current: { name: "Renamed tag", color: "blue" } } })
    ]);

    const missingGroup = await app.inject({
      method: "PATCH",
      url: `/api/categories/${category.id}`,
      payload: { expectedRevision: categoryUpdate.json().revision, groupId: "90000000-0000-4000-8000-000000000099" }
    });
    const missingTag = await app.inject({
      method: "PATCH",
      url: "/api/tags/90000000-0000-4000-8000-000000000099",
      payload: { expectedRevision: 1, color: "red" }
    });
    expect(missingGroup.statusCode).toBe(404);
    expect(missingTag.statusCode).toBe(404);
    await app.close();
  });

  it("returns a revision conflict for a stale taxonomy editor and preserves the winning value", async () => {
    const store = new AuditedStore();
    const app = await createApp({ store, authDisabled: true });
    const group = (await store.getSnapshot()).groups[0]!;

    const winning = await app.inject({
      method: "PATCH",
      url: `/api/groups/${group.id}`,
      payload: { expectedRevision: 1, name: "Winning group" }
    });
    const stale = await app.inject({
      method: "PATCH",
      url: `/api/groups/${group.id}`,
      payload: { expectedRevision: 1, name: "Stale group" }
    });

    expect(winning.statusCode).toBe(200);
    expect(winning.json()).toMatchObject({ revision: 2, name: "Winning group" });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
    expect((await store.getSnapshot()).groups.find((item) => item.id === group.id))
      .toMatchObject({ revision: 2, name: "Winning group" });
    await app.close();
  });

  it("updates a Topic via PATCH and blocks lifecycle violations", async () => {
    const store = new AuditedStore();
    const app = await createApp({ store, authDisabled: true });
    const bootstrap = (await app.inject({ method: "GET", url: "/api/bootstrap" })).json();
    const createThreadResponse = await app.inject({
      method: "POST",
      url: "/api/threads",
      headers: { "idempotency-key": "topic-update-fixture" },
      payload: {
        categoryId: bootstrap.categories[0].id,
        title: "API 更新主題",
        summary: "先建立再驗證更新。",
        tagIds: [bootstrap.tags[0].id]
      }
    });
    const thread = createThreadResponse.json();
    const connector = await store.createModelConnector({
      name: "Local",
      location: "local",
      baseUrl: "http://100.20.30.40/v1",
      model: "test"
    });
    await configurePublishedMeetingAgent(store, bootstrap.agents[0]!.id, connector.id);

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/threads/${thread.id}`,
      payload: {
        expectedRevision: thread.revision,
        title: "更新主題標題",
        summary: "確認主題邊界與優先權重。",
        tagIds: [bootstrap.tags[0].id],
        status: "resolved"
      }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      id: thread.id,
      revision: thread.revision + 1,
      status: "resolved",
      title: "更新主題標題",
      tagIds: [bootstrap.tags[0].id]
    });
    expect(store.events).toContain("thread.updated");

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/threads/${thread.id}`,
      payload: { expectedRevision: thread.revision, summary: "Stale overwrite" }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("REVISION_CONFLICT");
    expect((await store.getSnapshot()).threads.find((item) => item.id === thread.id)?.summary)
      .toBe("確認主題邊界與優先權重。");

    const emptyPayload = await app.inject({ method: "PATCH", url: `/api/threads/${thread.id}`, payload: {} });
    expect(emptyPayload.statusCode).toBe(400);
    expect(emptyPayload.json().error.code).toBe("VALIDATION_ERROR");

    const blockedMeeting = await app.inject({
      method: "POST",
      url: "/api/meetings",
      headers: { "idempotency-key": "blocked-closed-topic-meeting" },
      payload: {
        threadId: thread.id,
        title: "不可建立",
        goal: "非 open Topic 不可建立會議",
        mode: "fixed",
        durationMinutes: 30,
        participants: [{ agentId: bootstrap.agents[0].id, roleId: bootstrap.roles[0].id, isChair: true }],
        agendaItems: [{ title: "確認阻擋條件", description: "" }]
      }
    });
    expect(blockedMeeting.statusCode).toBe(409);
    expect(blockedMeeting.json().error.message).toMatch(/open Topics/i);

    const reopened = await app.inject({
      method: "PATCH",
      url: `/api/threads/${thread.id}`,
      payload: { expectedRevision: updated.json().revision, status: "open" }
    });
    expect(reopened.statusCode).toBe(200);

    const draftMeeting = await app.inject({
      method: "POST",
      url: "/api/meetings",
      headers: { "idempotency-key": "topic-lifecycle-draft-meeting" },
      payload: {
        threadId: thread.id,
        title: "尚未結束的會議",
        goal: "確認 Topic 結案防線",
        mode: "fixed",
        durationMinutes: 30,
        participants: [{ agentId: bootstrap.agents[0].id, roleId: bootstrap.roles[0].id, isChair: true }],
        agendaItems: [{ title: "確認結案防線", description: "" }]
      }
    });
    expect(draftMeeting.statusCode).toBe(201);

    const duplicateMeeting = await app.inject({
      method: "POST",
      url: "/api/meetings",
      headers: { "idempotency-key": "topic-lifecycle-duplicate-meeting" },
      payload: {
        threadId: thread.id,
        title: "重複未結束會議",
        goal: "不得繞過 UI 建立第二場未結束會議",
        mode: "open",
        durationMinutes: 20,
        participants: [{ agentId: bootstrap.agents[0].id, roleId: bootstrap.roles[0].id, isChair: true }],
        agendaItems: [{ title: "確認重複防線", description: "" }]
      }
    });
    expect(duplicateMeeting.statusCode).toBe(409);
    expect(duplicateMeeting.json().error.message).toMatch(/unfinished Meeting/i);

    const blockedArchive = await app.inject({
      method: "PATCH",
      url: `/api/threads/${thread.id}`,
      payload: { expectedRevision: reopened.json().revision, status: "archived" }
    });
    expect(blockedArchive.statusCode).toBe(409);
    expect(blockedArchive.json().error.code).toBe("REQUEST_FAILED");
    expect(blockedArchive.json().error.message).toMatch(/unfinished Meeting/i);
    await app.close();
  });

  it("completes discussion -> meeting -> decision -> task", async () => {
    const store = new InMemoryPlatformStore();
    const seed = await store.getSnapshot();
    const connector = await store.createModelConnector({
      name: "Local",
      location: "local",
      baseUrl: "http://10.20.30.40/v1",
      model: "meeting-local"
    });
    await configurePublishedMeetingAgent(store, seed.agents[0]!.id, connector.id);
    const app = await createApp({ store, authDisabled: true });
    const initial = await app.inject({ method: "GET", url: "/api/bootstrap" });
    const snapshot = initial.json();

    const threadResponse = await app.inject({
      method: "POST",
      url: "/api/threads",
      headers: { "idempotency-key": "thread-1" },
      payload: {
        categoryId: snapshot.categories[0].id,
        title: "地端模型架構評審",
        summary: "確認模型與工具權限",
        tagIds: [snapshot.tags[0].id]
      }
    });
    expect(threadResponse.statusCode).toBe(201);
    const thread = threadResponse.json();

    const meetingRequest = {
      threadId: thread.id,
      title: "地端模型架構評審",
      goal: "確認第一版模型與工具邊界",
      mode: "chaired" as const,
      durationMinutes: 30,
      participants: [{ agentId: snapshot.agents[0].id, roleId: snapshot.roles[0].id, isChair: true }],
      agendaItems: [{ title: "確認模型與工具邊界", description: "" }]
    };
    const missingMeetingKey = await app.inject({
      method: "POST",
      url: "/api/meetings",
      payload: meetingRequest
    });
    expect(missingMeetingKey.statusCode).toBe(400);
    expect(missingMeetingKey.json().error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");

    const meetingResponse = await app.inject({
      method: "POST",
      url: "/api/meetings",
      headers: { "idempotency-key": "meeting-1" },
      payload: meetingRequest
    });
    expect(meetingResponse.statusCode).toBe(201);
    const meeting = meetingResponse.json();

    const meetingReplay = await app.inject({
      method: "POST",
      url: "/api/meetings",
      headers: { "idempotency-key": "meeting-1" },
      payload: meetingRequest
    });
    expect(meetingReplay.statusCode).toBe(201);
    expect(meetingReplay.json()).toEqual(meeting);

    const meetingKeyConflict = await app.inject({
      method: "POST",
      url: "/api/meetings",
      headers: { "idempotency-key": "meeting-1" },
      payload: { ...meetingRequest, goal: "不同的會議目標" }
    });
    expect(meetingKeyConflict.statusCode).toBe(409);
    expect(meetingKeyConflict.json().error.code).toBe("IDEMPOTENCY_KEY_CONFLICT");

    const startResponse = await app.inject({ method: "POST", url: `/api/meetings/${meeting.id}/start` });
    expect(startResponse.json().state).toBe("active");

    const decisionResponse = await app.inject({
      method: "POST",
      url: "/api/decisions",
      headers: { "idempotency-key": "workflow-decision" },
      payload: { meetingId: meeting.id, title: "採用唯讀 MCP", description: "Phase 1 僅允許唯讀工具。" }
    });
    const decision = decisionResponse.json();

    const approveResponse = await app.inject({ method: "POST", url: `/api/decisions/${decision.id}/approve` });
    expect(approveResponse.json().status).toBe("approved");

    const taskResponse = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { "idempotency-key": "workflow-task" },
      payload: { decisionId: decision.id, title: "建立 MCP 白名單", description: "", assignee: null }
    });
    expect(taskResponse.statusCode).toBe(201);
    const task = taskResponse.json();

    const moveResponse = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}/status`,
      payload: {
        status: "in_progress",
        position: 0,
        expectedBoardRevision: task.boardRevision,
        expectedExecutionRevision: task.execution.revision
      }
    });
    expect(moveResponse.statusCode).toBe(200);
    expect(moveResponse.json().status).toBe("in_progress");
    const staleMove = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}/status`,
      payload: {
        status: "review",
        position: 0,
        expectedBoardRevision: task.boardRevision,
        expectedExecutionRevision: task.execution.revision
      }
    });
    expect(staleMove.statusCode).toBe(409);
    await app.close();
  });

  it("persists Task details, Evidence, history, idempotency, and queued synchronization", async () => {
    const store = new AuditedStore();
    const seed = await store.getSnapshot();
    const decision = await store.createDecision({
      meetingId: seed.meetings[0]!.id,
      title: "Task work item",
      description: "Keep the internal Task authoritative."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const adapter = await store.createTaskAdapterConnector({
      name: "Reference",
      location: "local",
      baseUrl: "http://task-adapter-reference:4200"
    });
    let taskIdForSync: string | undefined;
    const syncStatesObservedDuringEnqueue: string[] = [];
    const enqueueTaskSync = vi.fn(async (_job, requestedJobId?: string) => {
      const current = (await store.getSnapshot()).tasks.find((item) => item.id === taskIdForSync);
      syncStatesObservedDuringEnqueue.push(current?.sync.status ?? "missing");
      return { jobId: requestedJobId! };
    });
    const agentQueue: AgentTurnQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      enqueueTaskSync,
      close: vi.fn(async () => undefined)
    };
    const app = await createApp({ store, authDisabled: true, agentQueue });
    const payload = {
      decisionId: decision.id,
      title: decision.title,
      description: decision.description,
      assignee: "Owner",
      dueAt: "2026-08-01T09:00:00.000Z",
      acceptanceCriteria: "External ID survives reload.",
      executionProfile: "worker",
      allowedTools: ["task.upsert"],
      dataScope: "Decision summary only",
      approvalState: "pending"
    };

    const created = await app.inject({ method: "POST", url: "/api/tasks", headers: { "idempotency-key": "task-work-item" }, payload });
    expect(created.statusCode).toBe(201);
    const task = created.json();
    taskIdForSync = task.id;
    const replay = await app.inject({ method: "POST", url: "/api/tasks", headers: { "idempotency-key": "task-work-item" }, payload });
    expect(replay.json().id).toBe(task.id);
    expect((await store.getSnapshot()).tasks).toHaveLength(1);

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      payload: {
        expectedRevision: task.revision,
        expectedExecutionRevision: 0,
        acceptanceCriteria: "External ID and history survive reload."
      }
    });
    expect(updated.statusCode).toBe(200);
    const staleUpdate = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}`,
      payload: {
        expectedRevision: task.revision,
        expectedExecutionRevision: updated.json().execution.revision,
        dueAt: "2026-08-03T09:00:00.000Z"
      }
    });
    expect(staleUpdate.statusCode).toBe(409);
    expect((await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/approval`,
      payload: { expectedExecutionRevision: 1, action: "approve" }
    })).statusCode).toBe(200);
    const evidencePayload = { type: "url", label: "Runbook", reference: "https://docs.example.com/runbook" };
    const missingEvidenceKey = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/evidence`,
      payload: evidencePayload
    });
    expect(missingEvidenceKey.statusCode).toBe(400);
    expect(missingEvidenceKey.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
    const evidence = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/evidence`,
      headers: { "idempotency-key": "task-evidence-retry" },
      payload: evidencePayload
    });
    const evidenceReplay = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/evidence`,
      headers: { "idempotency-key": "task-evidence-retry" },
      payload: evidencePayload
    });
    const evidenceConflict = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/evidence`,
      headers: { "idempotency-key": "task-evidence-retry" },
      payload: { ...evidencePayload, reference: "https://docs.example.com/changed" }
    });
    expect(evidence.statusCode).toBe(201);
    expect(evidenceReplay.statusCode).toBe(201);
    expect(evidenceReplay.json()).toEqual(evidence.json());
    expect(evidenceConflict.statusCode).toBe(409);
    expect((await store.getSnapshot()).tasks.find((item) => item.id === task.id)?.evidence
      .filter((item) => item.label === evidencePayload.label)).toHaveLength(1);
    expect((await app.inject({
      method: "PATCH",
      url: `/api/tasks/${task.id}/status`,
      payload: {
        status: "in_progress",
        position: 0,
        expectedBoardRevision: task.boardRevision,
        expectedExecutionRevision: 2
      }
    })).statusCode).toBe(200);

    const sync = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync`, payload: await currentTaskSyncRequest(store, task.id, adapter.id) });
    expect(sync.statusCode).toBe(202);
    expect(sync.json()).toMatchObject({ task: { id: task.id, sync: { status: "queued", adapterId: adapter.id } } });
    expect(enqueueTaskSync).toHaveBeenCalledWith(
      { taskId: task.id, adapterId: adapter.id, requestedBy: "owner" },
      expect.stringMatching(new RegExp(`^${task.id}-sync-[0-9a-f-]{36}$`))
    );
    expect(syncStatesObservedDuringEnqueue).toEqual(["queued"]);

    const detail = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
    expect(detail.json()).toMatchObject({
      acceptanceCriteria: "External ID and history survive reload.",
      approvalState: "approved",
      status: "in_progress",
      sync: { status: "queued" },
      evidence: expect.arrayContaining([expect.objectContaining({ type: "url", label: "Runbook" })])
    });
    expect(detail.json().transitions.map((item: { type: string }) => item.type)).toEqual([
      "created", "updated", "approval_changed", "evidence_added", "moved", "sync_requested"
    ]);
    await app.close();
  });

  it("replays Decision creation and rejects changing a finalized Decision", async () => {
    const store = new AuditedStore();
    const meetingId = (await store.getSnapshot()).meetings[0]!.id;
    const app = await createApp({ store, authDisabled: true });
    const payload = {
      meetingId,
      title: "Keep final decisions stable",
      description: "A finalized decision requires a separately designed revocation flow."
    };

    const created = await app.inject({
      method: "POST",
      url: "/api/decisions",
      headers: { "idempotency-key": "decision-create-key" },
      payload
    });
    const replay = await app.inject({
      method: "POST",
      url: "/api/decisions",
      headers: { "idempotency-key": "decision-create-key" },
      payload
    });
    const decision = created.json();
    const approved = await app.inject({ method: "POST", url: `/api/decisions/${decision.id}/approve` });
    const approvedReplay = await app.inject({ method: "POST", url: `/api/decisions/${decision.id}/approve` });
    const rejected = await app.inject({ method: "POST", url: `/api/decisions/${decision.id}/reject` });

    expect(created.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(decision.id);
    expect(approved.json().status).toBe("approved");
    expect(approvedReplay.json()).toEqual(approved.json());
    expect(rejected.statusCode).toBe(409);
    expect((await store.getSnapshot()).decisions.filter((item) => item.id === decision.id)).toHaveLength(1);
    expect(store.events.filter((event) => event === "decision.proposed")).toHaveLength(1);
    expect(store.events.filter((event) => event === "decision.approve")).toHaveLength(1);
    await app.close();
  });

  it("queues one idempotent Advisor run with immutable Agent, model, Skill, and Task bindings", async () => {
    const store = new InMemoryPlatformStore();
    const seed = await store.getSnapshot();
    const agent = seed.agents[0]!;
    const connector = await store.createModelConnector({
      name: "Task Agent local",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "task-local"
    });
    await configurePublishedMeetingAgent(store, agent.id, connector.id);
    await store.updateAgent(agent.id, { name: "Unpublished Advisor draft" });
    const decision = await store.createDecision({ meetingId: seed.meetings[0]!.id, title: "Prepare advice", description: "Return evidence only." });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({
      decisionId: decision.id,
      title: decision.title,
      description: decision.description,
      assigneeAgentId: agent.id,
      executionProfile: "advisor"
    });
    const statesDuringEnqueue: string[] = [];
    const enqueueTaskAgentRun = vi.fn(async (job, requestedJobId: string) => {
      statesDuringEnqueue.push((await store.getSnapshot()).tasks.find((item) => item.id === task.id)!.execution.status);
      expect(job).toMatchObject({
        taskId: task.id,
        agentId: agent.id,
        executionProfile: "advisor",
        executionRevision: 1,
        agentRevision: 2,
        taskFingerprint: taskExecutionFingerprint(task),
        modelConnectorBinding: {
          id: connector.id,
          location: connector.location,
          baseUrl: connector.baseUrl,
          model: connector.model,
          secretRevision: connector.secretRevision
        },
        skillDigests: expect.any(Object),
        runtimeProfileBinding: { profileId: expect.any(String), revision: expect.any(Number) },
        runtimeProfileSnapshot: {
          profileId: expect.any(String),
          revision: expect.any(Number),
          harnessKind: "openai_compatible",
          policy: "text_only"
        },
        runtimeRun: {
          kind: "task_agent",
          state: "queued",
          agentId: agent.id,
          agentRevision: 2,
          scope: { kind: "task_attempt", subjectId: task.id },
          expiresAt: expect.any(String)
        },
        requestedBy: "owner"
      });
      return { jobId: requestedJobId };
    });
    const agentQueue: AgentTurnQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      enqueueTaskAgentRun,
      hasJob: vi.fn(async () => true),
      close: vi.fn(async () => undefined)
    };
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const missingKey = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/run`,
      payload: { expectedExecutionRevision: 0 }
    });
    expect(missingKey.statusCode).toBe(400);

    const queued = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/run`,
      headers: { "idempotency-key": "advisor-run-1" },
      payload: { expectedExecutionRevision: 0 }
    });
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toMatchObject({
      replayed: false,
      task: { id: task.id, execution: { revision: 1, status: "queued", agentId: agent.id, profile: "advisor" } },
      jobId: expect.stringMatching(new RegExp(`^${task.id}-task-agent-[a-f0-9]{40}$`))
    });
    expect(statesDuringEnqueue).toEqual(["queued"]);

    const replay = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/run`,
      headers: { "idempotency-key": "advisor-run-1" },
      payload: { expectedExecutionRevision: 0 }
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true, jobId: queued.json().jobId, task: { execution: { status: "queued" } } });
    expect(enqueueTaskAgentRun).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("refuses a same-key Task Agent replay when BullMQ owns a mismatched envelope", async () => {
    const store = new InMemoryPlatformStore();
    const seed = await store.getSnapshot();
    const agent = seed.agents[0]!;
    const connector = await store.createModelConnector({
      name: "Task Agent replay envelope",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "task-agent-replay-envelope"
    });
    await configurePublishedMeetingAgent(store, agent.id, connector.id);
    const decision = await store.createDecision({
      meetingId: seed.meetings[0]!.id,
      title: "Bind Task Agent replay",
      description: "The queue envelope must match durable admission."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({
      decisionId: decision.id,
      title: decision.title,
      assigneeAgentId: agent.id,
      executionProfile: "advisor"
    });
    let queuedJob: TaskAgentRunJobData | null = null;
    const agentQueue: AgentTurnQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      enqueueTaskAgentRun: vi.fn(async (job, requestedJobId) => {
        queuedJob = job;
        return { jobId: requestedJobId };
      }),
      getJobState: vi.fn(async () => "waiting"),
      inspectJob: vi.fn(async () => queuedJob
        ? inspectedTaskAgentJob("waiting", { ...queuedJob, requestFingerprint: "mismatched-envelope" })
        : null),
      close: vi.fn(async () => undefined)
    };
    const app = await createApp({ store, authDisabled: true, agentQueue });
    const request = {
      method: "POST" as const,
      url: `/api/tasks/${task.id}/run`,
      headers: { "idempotency-key": "task-agent-replay-envelope" },
      payload: { expectedExecutionRevision: task.execution.revision }
    };

    const queued = await app.inject(request);
    const replay = await app.inject(request);

    expect(queued.statusCode).toBe(202);
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ error: { code: "TASK_AGENT_RECONCILIATION_REQUIRED" } });
    await app.close();
  });

  it("refuses lost Task Agent enqueue acknowledgement when the owned envelope is mismatched", async () => {
    const store = new InMemoryPlatformStore();
    const seed = await store.getSnapshot();
    const agent = seed.agents[0]!;
    const connector = await store.createModelConnector({
      name: "Task Agent enqueue envelope",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "task-agent-enqueue-envelope"
    });
    await configurePublishedMeetingAgent(store, agent.id, connector.id);
    const decision = await store.createDecision({
      meetingId: seed.meetings[0]!.id,
      title: "Bind Task Agent enqueue",
      description: "A stale queue job cannot acknowledge a new durable reservation."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({
      decisionId: decision.id,
      title: decision.title,
      assigneeAgentId: agent.id,
      executionProfile: "advisor"
    });
    let attemptedJob: TaskAgentRunJobData | null = null;
    const agentQueue: AgentTurnQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      enqueueTaskAgentRun: vi.fn(async (job) => {
        attemptedJob = job;
        throw new Error("enqueue acknowledgement lost");
      }),
      getJobState: vi.fn(async () => "waiting"),
      inspectJob: vi.fn(async () => attemptedJob
        ? inspectedTaskAgentJob("waiting", { ...attemptedJob, executionRevision: attemptedJob.executionRevision + 1 })
        : null),
      close: vi.fn(async () => undefined)
    };
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const response = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/run`,
      headers: { "idempotency-key": "task-agent-enqueue-envelope" },
      payload: { expectedExecutionRevision: task.execution.revision }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "TASK_AGENT_RECONCILIATION_REQUIRED" } });
    await app.close();
  });

  it("returns the durable completed Task when Task Agent enqueue acknowledgement is lost", async () => {
    const store = new InMemoryPlatformStore();
    const seed = await store.getSnapshot();
    const agent = seed.agents[0]!;
    const connector = await store.createModelConnector({
      name: "Completed Task Agent enqueue",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "completed-task-agent"
    });
    await configurePublishedMeetingAgent(store, agent.id, connector.id);
    const decision = await store.createDecision({
      meetingId: seed.meetings[0]!.id,
      title: "Complete despite lost acknowledgement",
      description: "Durable completion remains authoritative."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({
      decisionId: decision.id,
      title: decision.title,
      assigneeAgentId: agent.id,
      acceptanceCriteria: "Return one bounded evidence note.",
      executionProfile: "worker"
    });
    const approved = await store.setTaskApproval(task.id, {
      expectedExecutionRevision: 0,
      action: "approve"
    });
    const agentQueue: AgentTurnQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      enqueueTaskAgentRun: vi.fn(async (job, requestedJobId) => {
        await store.markTaskAgentRunRunning(requestedJobId, job);
        await store.claimTaskAgentProviderAttempt(requestedJobId, job);
        await store.completeTaskAgentRun(
          requestedJobId,
          job,
          "Completed exactly once before the enqueue response was lost."
        );
        throw new Error("enqueue response lost after completed processing");
      }),
      hasJob: vi.fn(async () => false),
      getJobState: vi.fn(async () => "completed"),
      close: vi.fn(async () => undefined)
    };
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const response = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/run`,
      headers: { "idempotency-key": "completed-task-agent-enqueue" },
      payload: { expectedExecutionRevision: approved.execution.revision }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      replayed: false,
      task: {
        id: task.id,
        status: "review",
        execution: { status: "completed", resultEvidenceId: expect.any(String) }
      }
    });
    const durableTask = (await store.getSnapshot()).tasks.find((item) => item.id === task.id)!;
    expect(durableTask.evidence.filter((item) => item.jobId === response.json().jobId)).toHaveLength(1);
    await app.close();
  });

  it("returns the durable completed Task when a same-key replay observes terminal queue state", async () => {
    const store = new InMemoryPlatformStore();
    const seed = await store.getSnapshot();
    const agent = seed.agents[0]!;
    const connector = await store.createModelConnector({
      name: "Completed Task Agent replay",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "completed-task-agent-replay"
    });
    await configurePublishedMeetingAgent(store, agent.id, connector.id);
    const decision = await store.createDecision({
      meetingId: seed.meetings[0]!.id,
      title: "Complete during same-key replay",
      description: "The replay must return the post-queue durable state."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({
      decisionId: decision.id,
      title: decision.title,
      assigneeAgentId: agent.id,
      acceptanceCriteria: "Return one bounded evidence note.",
      executionProfile: "worker"
    });
    const approved = await store.setTaskApproval(task.id, {
      expectedExecutionRevision: 0,
      action: "approve"
    });
    let queuedJob: TaskAgentRunJobData | null = null;
    const agentQueue: AgentTurnQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      enqueueTaskAgentRun: vi.fn(async (job, requestedJobId) => {
        queuedJob = job;
        await store.markTaskAgentRunRunning(requestedJobId, job);
        return { jobId: requestedJobId };
      }),
      hasJob: vi.fn(async (jobId) => {
        if (!queuedJob) throw new Error("Task Agent replay fixture was not queued.");
        await store.claimTaskAgentProviderAttempt(jobId, queuedJob);
        await store.completeTaskAgentRun(
          jobId,
          queuedJob,
          "Completed exactly once while the replay inspected queue ownership."
        );
        return false;
      }),
      close: vi.fn(async () => undefined)
    };
    const app = await createApp({ store, authDisabled: true, agentQueue });
    const request = {
      method: "POST" as const,
      url: `/api/tasks/${task.id}/run`,
      headers: { "idempotency-key": "completed-task-agent-replay" },
      payload: { expectedExecutionRevision: approved.execution.revision }
    };

    const queued = await app.inject(request);
    expect(queued.statusCode).toBe(202);
    expect((await store.getSnapshot()).tasks.find((item) => item.id === task.id))
      .toMatchObject({ execution: { status: "running" } });

    const replay = await app.inject(request);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      replayed: true,
      jobId: queued.json().jobId,
      task: {
        id: task.id,
        status: "review",
        execution: { status: "completed", resultEvidenceId: expect.any(String) }
      }
    });
    const durableTask = (await store.getSnapshot()).tasks.find((item) => item.id === task.id)!;
    expect(durableTask.evidence.filter((item) => item.jobId === queued.json().jobId)).toHaveLength(1);
    await app.close();
  });

  it("preserves an unknown provider outcome when a running Task Agent replay loses queue ownership", async () => {
    const store = new InMemoryPlatformStore();
    const seed = await store.getSnapshot();
    const agent = seed.agents[0]!;
    const connector = await store.createModelConnector({
      name: "Unknown provider outcome replay",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "unknown-provider-outcome"
    });
    await configurePublishedMeetingAgent(store, agent.id, connector.id);
    const decision = await store.createDecision({
      meetingId: seed.meetings[0]!.id,
      title: "Reconcile an unknown provider outcome",
      description: "Do not downgrade a started provider attempt to a missing queue job."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({
      decisionId: decision.id,
      title: decision.title,
      assigneeAgentId: agent.id,
      executionProfile: "advisor"
    });
    let queuedJob: TaskAgentRunJobData | null = null;
    const agentQueue: AgentTurnQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      enqueueTaskAgentRun: vi.fn(async (job, requestedJobId) => {
        queuedJob = job;
        return { jobId: requestedJobId };
      }),
      getJobState: vi.fn(async () => null),
      close: vi.fn(async () => undefined)
    };
    const app = await createApp({ store, authDisabled: true, agentQueue });
    const request = {
      method: "POST" as const,
      url: `/api/tasks/${task.id}/run`,
      headers: { "idempotency-key": "unknown-provider-outcome-replay" },
      payload: { expectedExecutionRevision: task.execution.revision }
    };

    try {
      const queued = await app.inject(request);
      expect(queued.statusCode).toBe(202);
      expect(queuedJob).not.toBeNull();
      await store.markTaskAgentRunRunning(queued.json().jobId, queuedJob!);
      await store.claimTaskAgentProviderAttempt(queued.json().jobId, queuedJob!);

      const replay = await app.inject(request);

      expect(replay.statusCode).toBe(409);
      expect(replay.json()).toMatchObject({ error: { code: "TASK_AGENT_RECONCILIATION_REQUIRED" } });
      expect((await store.getSnapshot()).tasks.find((candidate) => candidate.id === task.id)).toMatchObject({
        execution: {
          status: "failed",
          lastError: "provider_outcome_unknown",
          providerStartedAt: expect.any(String)
        }
      });
    } finally {
      await app.close();
    }
  });

  it("returns 409 for terminal replay when the Task Agent reconciliation audit fails", async () => {
    const store = new FailingTaskAgentReconciliationAuditStore();
    const seed = await store.getSnapshot();
    const agent = seed.agents[0]!;
    const connector = await store.createModelConnector({
      name: "Terminal replay audit failure",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "terminal-replay-audit-failure"
    });
    await configurePublishedMeetingAgent(store, agent.id, connector.id);
    const decision = await store.createDecision({
      meetingId: seed.meetings[0]!.id,
      title: "Reconcile a terminal Task Agent replay",
      description: "The durable reservation remains authoritative when its secondary audit fails."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({
      decisionId: decision.id,
      title: decision.title,
      assigneeAgentId: agent.id,
      executionProfile: "advisor"
    });
    const agentQueue: AgentTurnQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      enqueueTaskAgentRun: vi.fn(async (_job, requestedJobId) => ({ jobId: requestedJobId })),
      getJobState: vi.fn(async () => "completed"),
      close: vi.fn(async () => undefined)
    };
    const app = await createApp({ store, authDisabled: true, agentQueue });
    const request = {
      method: "POST" as const,
      url: `/api/tasks/${task.id}/run`,
      headers: { "idempotency-key": "terminal-replay-audit-failure" },
      payload: { expectedExecutionRevision: task.execution.revision }
    };

    const queued = await app.inject(request);
    const replay = await app.inject(request);

    expect(queued.statusCode).toBe(202);
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe("TASK_AGENT_RECONCILIATION_REQUIRED");
    expect((await store.getSnapshot()).tasks.find((item) => item.id === task.id)).toMatchObject({
      execution: { status: "queued", lastError: null }
    });
    await app.close();
  });

  it("returns 503 for unknown enqueue acceptance when the Task Agent reconciliation audit fails", async () => {
    const store = new FailingTaskAgentReconciliationAuditStore();
    const seed = await store.getSnapshot();
    const agent = seed.agents[0]!;
    const connector = await store.createModelConnector({
      name: "Unknown enqueue audit failure",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "unknown-enqueue-audit-failure"
    });
    await configurePublishedMeetingAgent(store, agent.id, connector.id);
    const decision = await store.createDecision({
      meetingId: seed.meetings[0]!.id,
      title: "Reconcile unknown Task Agent enqueue acceptance",
      description: "The durable reservation remains authoritative when its secondary audit fails."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({
      decisionId: decision.id,
      title: decision.title,
      assigneeAgentId: agent.id,
      executionProfile: "advisor"
    });
    const agentQueue: AgentTurnQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      enqueueTaskAgentRun: vi.fn(async () => { throw new Error("enqueue acknowledgement lost"); }),
      getJobState: vi.fn(async () => { throw new Error("queue inspection unavailable"); }),
      close: vi.fn(async () => undefined)
    };
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const response = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/run`,
      headers: { "idempotency-key": "unknown-enqueue-audit-failure" },
      payload: { expectedExecutionRevision: task.execution.revision }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("TASK_AGENT_QUEUE_UNAVAILABLE");
    expect((await store.getSnapshot()).tasks.find((item) => item.id === task.id)).toMatchObject({
      execution: { status: "queued", lastError: null }
    });
    await app.close();
  });

  it("does not invalidate a Task while its first same-key request is still entering BullMQ", async () => {
    const store = new InMemoryPlatformStore();
    const seed = await store.getSnapshot();
    const agent = seed.agents[0]!;
    const connector = await store.createModelConnector({
      name: "Concurrent Task Agent",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "concurrent-task-local"
    });
    await configurePublishedMeetingAgent(store, agent.id, connector.id);
    const decision = await store.createDecision({
      meetingId: seed.meetings[0]!.id,
      title: "Protect concurrent admission",
      description: "A replay must not invalidate the first enqueue."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({
      decisionId: decision.id,
      title: decision.title,
      assigneeAgentId: agent.id,
      executionProfile: "advisor"
    });
    let releaseEnqueue!: () => void;
    let observeEnqueue!: () => void;
    const enqueueStarted = new Promise<void>((resolve) => { observeEnqueue = resolve; });
    const enqueueGate = new Promise<void>((resolve) => { releaseEnqueue = resolve; });
    const enqueueTaskAgentRun = vi.fn(async (_job, requestedJobId: string) => {
      observeEnqueue();
      await enqueueGate;
      return { jobId: requestedJobId };
    });
    const agentQueue: AgentTurnQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      enqueueTaskAgentRun,
      hasJob: vi.fn(async () => false),
      close: vi.fn(async () => undefined)
    };
    const app = await createApp({ store, authDisabled: true, agentQueue });
    const request = {
      method: "POST" as const,
      url: `/api/tasks/${task.id}/run`,
      headers: { "idempotency-key": "concurrent-admission" },
      payload: { expectedExecutionRevision: 0 }
    };

    const firstPending = app.inject(request);
    await enqueueStarted;
    const replay = await app.inject(request);
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toMatchObject({ replayed: true, task: { execution: { status: "queued" } } });

    releaseEnqueue();
    const first = await firstPending;
    expect(first.statusCode).toBe(202);
    expect(enqueueTaskAgentRun).toHaveBeenCalledTimes(1);
    expect((await store.getSnapshot()).tasks.find((item) => item.id === task.id)).toMatchObject({
      execution: { status: "queued", lastError: null }
    });
    await app.close();
  });

  it("lets only the reservation owner enqueue when two same-key Task Agent requests read idle state", async () => {
    const store = new InMemoryPlatformStore();
    const seed = await store.getSnapshot();
    const agent = seed.agents[0]!;
    const connector = await store.createModelConnector({
      name: "Task Agent reservation owner",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "reservation-owner-local"
    });
    await configurePublishedMeetingAgent(store, agent.id, connector.id);
    const decision = await store.createDecision({
      meetingId: seed.meetings[0]!.id,
      title: "Enqueue only once",
      description: "Concurrent same-key requests share one durable reservation owner."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({
      decisionId: decision.id,
      title: decision.title,
      assigneeAgentId: agent.id,
      executionProfile: "advisor"
    });
    const enqueueTaskAgentRun = vi.fn(async (_job, requestedJobId: string) => ({ jobId: requestedJobId }));
    const app = await createApp({
      store,
      authDisabled: true,
      agentQueue: {
        enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
        enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
        enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
        enqueueTaskAgentRun,
        hasJob: vi.fn(async () => true),
        close: vi.fn(async () => undefined)
      } as AgentTurnQueue
    });
    const originalGetSnapshot = store.getSnapshot.bind(store);
    let initialReads = 0;
    let releaseReads!: () => void;
    let observeBothReads!: () => void;
    const bothReads = new Promise<void>((resolve) => { observeBothReads = resolve; });
    const readGate = new Promise<void>((resolve) => { releaseReads = resolve; });
    const snapshotSpy = vi.spyOn(store, "getSnapshot").mockImplementation(async () => {
      const snapshot = await originalGetSnapshot();
      initialReads += 1;
      if (initialReads <= 2) {
        if (initialReads === 2) observeBothReads();
        await readGate;
      }
      return snapshot;
    });
    const request = {
      method: "POST" as const,
      url: `/api/tasks/${task.id}/run`,
      headers: { "idempotency-key": "same-idle-snapshot" },
      payload: { expectedExecutionRevision: 0 }
    };

    const first = app.inject(request);
    const second = app.inject(request);
    await bothReads;
    releaseReads();
    const responses = await Promise.all([first, second]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 202]);
    expect(responses.map((response) => response.json().replayed).sort()).toEqual([false, true]);
    expect(enqueueTaskAgentRun).toHaveBeenCalledTimes(1);
    expect((await originalGetSnapshot()).tasks.find((item) => item.id === task.id)).toMatchObject({
      execution: { status: "queued", lastError: null }
    });
    snapshotSpy.mockRestore();
    await app.close();
  });

  it("uses canonical published Agent readiness for Task run admission", async () => {
    const store = new InMemoryPlatformStore();
    const seed = await store.getSnapshot();
    const agent = seed.agents[0]!;
    const connector = await store.createModelConnector({
      name: "Canonical readiness Task Agent",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "canonical-readiness-local"
    });
    await configurePublishedMeetingAgent(store, agent.id, connector.id);
    const mcp = await store.createMcpConnector({
      name: "Canonical readiness MCP",
      location: "cloud",
      baseUrl: "https://1.1.1.1/mcp",
      approvedTools: ["search"],
      toolRegistrations: [{
        toolName: "search",
        displayName: "Search",
        kind: "mcp_tool",
        version: "1.0.0",
        owner: "Test Owner",
        goal: "Read bounded evidence."
      }]
    });
    const updatedAgent = await store.updateAgent(agent.id, {
      toolGrants: [{ connectorId: mcp.id, toolName: "search" }]
    });
    await store.publishAgent(agent.id, { expectedDraftRevision: updatedAgent.draftRevision! });
    await store.updateMcpConnector(mcp.id, { expectedRevision: mcp.revision, enabled: false });
    const decision = await store.createDecision({
      meetingId: seed.meetings[0]!.id,
      title: "Reject stale Agent grants",
      description: "Task admission must match published readiness."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({
      decisionId: decision.id,
      title: decision.title,
      assigneeAgentId: agent.id,
      executionProfile: "advisor"
    });
    const enqueueTaskAgentRun = vi.fn(async (_job, requestedJobId: string) => ({ jobId: requestedJobId }));
    const app = await createApp({
      store,
      authDisabled: true,
      agentQueue: {
        enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
        enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
        enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
        enqueueTaskAgentRun,
        close: vi.fn(async () => undefined)
      } as AgentTurnQueue
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/run`,
      headers: { "idempotency-key": "canonical-readiness-task" },
      payload: { expectedExecutionRevision: task.execution.revision }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "TASK_AGENT_NOT_READY",
        message: expect.stringContaining("MCP Connector")
      }
    });
    expect(enqueueTaskAgentRun).not.toHaveBeenCalled();
    await app.close();
  });

  it("preserves the Task runtime admission error for unattested isolated execution", async () => {
    const store = new InMemoryPlatformStore();
    const seed = await store.getSnapshot();
    const agent = seed.agents[0]!;
    const connector = await store.createModelConnector({
      name: "Blocked Task Agent local",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "blocked-task-local"
    });
    await configurePublishedMeetingAgent(store, agent.id, connector.id);
    const decision = await store.createDecision({
      meetingId: seed.meetings[0]!.id,
      title: "Blocked runtime task",
      description: "The queue must remain untouched."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({
      decisionId: decision.id,
      title: decision.title,
      assigneeAgentId: agent.id,
      executionProfile: "advisor"
    });
    const publishedAgent = (await store.getSnapshot()).agents.find((item) => item.id === agent.id)!;
    const publishedRevision = await store.getAgentRevision(agent.id, publishedAgent.publishedRevision!);
    const isolatedState = await store.getSnapshot();
    const isolatedProfile = isolatedState.runtimeProfiles!.find((candidate) => (
      candidate.id === publishedRevision.runtimeProfileBinding!.profileId
    ))!;
    const isolatedRevision = isolatedState.runtimeProfileRevisions!.find((candidate) => (
      candidate.profileId === publishedRevision.runtimeProfileBinding!.profileId
      && candidate.revision === publishedRevision.runtimeProfileBinding!.revision
    ))!;
    for (const runtime of [isolatedProfile, isolatedRevision]) {
      runtime.sandboxProfileId = "70000000-0000-4000-8000-000000000099";
      runtime.policy = "isolated_exec";
      runtime.capabilities = ["text", "abort", "file_read", "file_write", "process"];
    }
    const isolatedStore = new InMemoryPlatformStore(isolatedState, {
      agentRevisions: [publishedRevision]
    });
    const enqueueTaskAgentRun = vi.fn(async () => ({ jobId: "unexpected-task-agent-job" }));
    const app = await createApp({
      store: isolatedStore,
      authDisabled: true,
      agentQueue: {
        enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
        enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
        enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
        enqueueTaskAgentRun,
        close: vi.fn(async () => undefined)
      } as AgentTurnQueue
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/run`,
      headers: { "idempotency-key": "disabled-runtime-task" },
      payload: { expectedExecutionRevision: 0 }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "TASK_RUNTIME_PROFILE_NOT_READY",
        message: "The assigned Agent's Runtime Profile is unavailable or no longer permitted."
      }
    });
    expect(enqueueTaskAgentRun).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects unapproved Worker runs and records a failed durable reservation when queue admission fails", async () => {
    const store = new InMemoryPlatformStore();
    const seed = await store.getSnapshot();
    const agent = seed.agents[2]!;
    const connector = await store.createModelConnector({
      name: "Task Agent cloud",
      location: "cloud",
      baseUrl: "https://models.example.com/v1",
      model: "task-cloud"
    }, { ciphertext: "encrypted-cloud-test-key" });
    await configurePublishedMeetingAgent(store, agent.id, connector.id);
    const decision = await store.createDecision({ meetingId: seed.meetings[0]!.id, title: "Produce review", description: "Owner approval required." });
    await store.setDecisionStatus(decision.id, "approved");
    const incompleteDecision = await store.createDecision({
      meetingId: seed.meetings[0]!.id,
      title: "Missing acceptance criteria",
      description: "This Worker Task must remain blocked."
    });
    await store.setDecisionStatus(incompleteDecision.id, "approved");
    const incompleteTask = await store.createTask({
      decisionId: incompleteDecision.id,
      title: incompleteDecision.title,
      assigneeAgentId: agent.id,
      executionProfile: "worker"
    });
    const task = await store.createTask({
      decisionId: decision.id,
      title: decision.title,
      assigneeAgentId: agent.id,
      acceptanceCriteria: "A bounded text result is ready for Owner review.",
      executionProfile: "worker"
    });
    const unknownAdmissionDecision = await store.createDecision({
      meetingId: seed.meetings[0]!.id,
      title: "Recover unknown queue admission",
      description: "Verify a later retry reconciles missing queue ownership."
    });
    await store.setDecisionStatus(unknownAdmissionDecision.id, "approved");
    const unknownAdmissionTask = await store.createTask({
      decisionId: unknownAdmissionDecision.id,
      title: "Recover unknown queue admission",
      assigneeAgentId: agent.id,
      acceptanceCriteria: "A missing queue job becomes an explicit failed attempt.",
      executionProfile: "worker"
    });
    const hasJob = vi.fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("redis lookup unavailable"))
      .mockResolvedValue(false);
    const agentQueue: AgentTurnQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      enqueueTaskAgentRun: vi.fn(async () => { throw new Error("redis unavailable"); }),
      hasJob,
      close: vi.fn(async () => undefined)
    };
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const missingAcceptance = await app.inject({
      method: "POST",
      url: `/api/tasks/${incompleteTask.id}/run`,
      headers: { "idempotency-key": "worker-run-missing-acceptance" },
      payload: { expectedExecutionRevision: 0 }
    });
    expect(missingAcceptance.statusCode).toBe(409);
    expect(missingAcceptance.json().error.code).toBe("TASK_ACCEPTANCE_REQUIRED");

    const unapproved = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/run`,
      headers: { "idempotency-key": "worker-run-1" },
      payload: { expectedExecutionRevision: 0 }
    });
    expect(unapproved.statusCode).toBe(409);
    expect(unapproved.json().error.code).toBe("TASK_APPROVAL_REQUIRED");

    const approved = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/approval`,
      payload: { expectedExecutionRevision: 0, action: "approve" }
    });
    expect(approved.statusCode).toBe(200);
    const queueFailure = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/run`,
      headers: { "idempotency-key": "worker-run-2" },
      payload: { expectedExecutionRevision: 1 }
    });
    expect(queueFailure.statusCode).toBe(503);
    expect((await store.getSnapshot()).tasks.find((item) => item.id === task.id)).toMatchObject({
      approvalState: "approved",
      execution: {
        revision: 2,
        status: "failed",
        jobId: expect.stringMatching(new RegExp(`^${task.id}-task-agent-[a-f0-9]{40}$`)),
        lastError: "queue_unavailable"
      }
    });

    const unknownApproved = await app.inject({
      method: "POST",
      url: `/api/tasks/${unknownAdmissionTask.id}/approval`,
      payload: { expectedExecutionRevision: 0, action: "approve" }
    });
    expect(unknownApproved.statusCode).toBe(200);
    const unknownFirstAttempt = await app.inject({
      method: "POST",
      url: `/api/tasks/${unknownAdmissionTask.id}/run`,
      headers: { "idempotency-key": "worker-run-unknown" },
      payload: { expectedExecutionRevision: 1 }
    });
    expect(unknownFirstAttempt.statusCode).toBe(503);
    expect((await store.getSnapshot()).tasks.find((item) => item.id === unknownAdmissionTask.id)).toMatchObject({
      execution: { revision: 2, status: "queued", lastError: null }
    });

    const missingReplay = await app.inject({
      method: "POST",
      url: `/api/tasks/${unknownAdmissionTask.id}/run`,
      headers: { "idempotency-key": "worker-run-unknown" },
      payload: { expectedExecutionRevision: 1 }
    });
    expect(missingReplay.statusCode).toBe(202);
    expect(missingReplay.json()).toMatchObject({ replayed: true });
    expect((await store.getSnapshot()).tasks.find((item) => item.id === unknownAdmissionTask.id)).toMatchObject({
      execution: { revision: 2, status: "queued", lastError: null }
    });

    const requestedAt = (await store.getSnapshot()).tasks.find((item) => item.id === unknownAdmissionTask.id)!.execution.requestedAt!;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(Date.parse(requestedAt) + 5 * 60_000 + 1);
    const expiredReplay = await app.inject({
      method: "POST",
      url: `/api/tasks/${unknownAdmissionTask.id}/run`,
      headers: { "idempotency-key": "worker-run-unknown" },
      payload: { expectedExecutionRevision: 1 }
    });
    dateNow.mockRestore();
    expect(expiredReplay.statusCode).toBe(409);
    expect(expiredReplay.json().error.code).toBe("IDEMPOTENCY_REPLAY_EXPIRED");
    expect((await store.getSnapshot()).tasks.find((item) => item.id === unknownAdmissionTask.id)).toMatchObject({
      execution: { revision: 2, status: "failed", lastError: "queue_state_missing" }
    });
    await app.close();
  });

  it("retains the internal Task with a durable failure when synchronization enqueue fails", async () => {
    const store = new InMemoryPlatformStore();
    const seed = await store.getSnapshot();
    const decision = await store.createDecision({ meetingId: seed.meetings[0]!.id, title: "Queue failure", description: "Retain work." });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({ decisionId: decision.id, title: decision.title, description: decision.description, assignee: null });
    const adapter = await store.createTaskAdapterConnector({ name: "Reference", location: "local", baseUrl: "http://task-adapter-reference:4200" });
    const agentQueue: AgentTurnQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      enqueueTaskSync: vi.fn(async () => { throw new Error("redis unavailable"); }),
      getJobState: vi.fn(async () => null),
      close: vi.fn(async () => undefined)
    };
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const response = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync`, payload: await currentTaskSyncRequest(store, task.id, adapter.id) });
    expect(response.statusCode).toBe(503);
    expect((await store.getSnapshot()).tasks[0]).toMatchObject({
      id: task.id,
      status: "todo",
      sync: { status: "failed", adapterId: adapter.id, jobId: expect.any(String), lastError: "queue_unavailable" },
      transitions: [
        expect.objectContaining({ type: "created" }),
        expect.objectContaining({ type: "sync_requested" }),
        expect.objectContaining({ type: "sync_failed", note: "queue_unavailable" })
      ]
    });
    await app.close();
  });

  it("rejects a stale Task synchronization before reserving or enqueueing external work", async () => {
    const store = new InMemoryPlatformStore();
    const seed = await store.getSnapshot();
    const decision = await store.createDecision({ meetingId: seed.meetings[0]!.id, title: "Version-bound sync", description: "Only dispatch reviewed content." });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({ decisionId: decision.id, title: decision.title, description: decision.description });
    const adapter = await store.createTaskAdapterConnector({ name: "Version-bound reference", location: "local", baseUrl: "http://task-adapter-reference:4200" });
    const staleRequest = {
      adapterId: adapter.id,
      expectedRevision: task.revision,
      expectedStatus: task.status,
      expectedApprovalState: task.approvalState,
      expectedSyncAttemptCount: task.sync.attemptCount
    };
    await store.updateTask(task.id, {
      expectedRevision: task.revision,
      expectedExecutionRevision: task.execution.revision,
      description: "A newer authoritative payload."
    });
    const enqueueTaskSync = vi.fn(async () => ({ jobId: "must-not-enqueue" }));
    const app = await createApp({
      store,
      authDisabled: true,
      agentQueue: {
        enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
        enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
        enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
        enqueueTaskSync,
        close: vi.fn(async () => undefined)
      }
    });

    const response = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync`, payload: staleRequest });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("REVISION_CONFLICT");
    expect(enqueueTaskSync).not.toHaveBeenCalled();
    expect((await store.getSnapshot()).tasks.find((item) => item.id === task.id)).toMatchObject({
      description: "A newer authoritative payload.",
      sync: { status: "not_synced", jobId: null }
    });
    await app.close();
  });

  it("returns a sync conflict and records the failed synchronization reservation", async () => {
    const store = new InMemoryPlatformStore();
    const seed = await store.getSnapshot();
    const decision = await store.createDecision({ meetingId: seed.meetings[0]!.id, title: "Queue conflict", description: "Keep the work item authoritative." });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({ decisionId: decision.id, title: decision.title, description: decision.description, assignee: null });
    const adapter = await store.createTaskAdapterConnector({ name: "Reference", location: "local", baseUrl: "http://task-adapter-reference:4200" });
    const agentQueue: AgentTurnQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      enqueueTaskSync: vi.fn(async () => {
        throw Object.assign(new Error("Task already has a queued or active synchronization."), { statusCode: 409 });
      }),
      getJobState: vi.fn(async () => null),
      close: vi.fn(async () => undefined)
    };
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const response = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync`, payload: await currentTaskSyncRequest(store, task.id, adapter.id) });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: "TASK_SYNC_ALREADY_QUEUED" });
    expect((await store.getSnapshot()).tasks[0]).toMatchObject({
      id: task.id,
      sync: { status: "failed", adapterId: adapter.id, jobId: expect.any(String), lastError: "queue_conflict" },
      transitions: [
        expect.objectContaining({ type: "created" }),
        expect.objectContaining({ type: "sync_requested" }),
        expect.objectContaining({ type: "sync_failed", note: "queue_conflict" })
      ]
    });
    await app.close();
  });

  it("preserves a Task sync reservation when BullMQ accepted the job before enqueue threw", async () => {
    const store = new InMemoryPlatformStore();
    const seed = await store.getSnapshot();
    const decision = await store.createDecision({ meetingId: seed.meetings[0]!.id, title: "Ambiguous queue acceptance", description: "Keep the reservation." });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({ decisionId: decision.id, title: decision.title, description: decision.description, assignee: null });
    const adapter = await store.createTaskAdapterConnector({ name: "Reference", location: "local", baseUrl: "http://task-adapter-reference:4200" });
    const agentQueue: AgentTurnQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      enqueueTaskSync: vi.fn(async () => { throw new Error("response lost after queue acceptance"); }),
      getJobState: vi.fn(async () => "waiting"),
      close: vi.fn(async () => undefined)
    };
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const response = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync`, payload: await currentTaskSyncRequest(store, task.id, adapter.id) });

    expect(response.statusCode).toBe(202);
    expect((await store.getSnapshot()).tasks.find((item) => item.id === task.id)).toMatchObject({
      sync: { status: "queued", jobId: expect.any(String), lastError: null }
    });
    await app.close();
  });

  it("returns the durable synchronized Task when enqueue acknowledgement is lost after completion", async () => {
    const store = new InMemoryPlatformStore();
    const seed = await store.getSnapshot();
    const decision = await store.createDecision({ meetingId: seed.meetings[0]!.id, title: "Completed ambiguous enqueue", description: "Return durable truth." });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({ decisionId: decision.id, title: decision.title, description: decision.description, assignee: null });
    const adapter = await store.createTaskAdapterConnector({ name: "Completed reference", location: "local", baseUrl: "http://task-adapter-reference:4200" });
    const agentQueue: AgentTurnQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      enqueueTaskSync: vi.fn(async (_job, requestedJobId) => {
        const queued = (await store.getSnapshot()).tasks.find((item) => item.id === task.id)!;
        await store.completeTaskSync(
          task.id,
          requestedJobId!,
          "EXT-completed",
          taskSyncRequestFingerprint(queued)
        );
        throw new Error("enqueue response lost after completed processing");
      }),
      getJobState: vi.fn(async () => "completed"),
      close: vi.fn(async () => undefined)
    };
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const response = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync`, payload: await currentTaskSyncRequest(store, task.id, adapter.id) });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      jobId: expect.any(String),
      task: { id: task.id, sync: { status: "synced", externalId: "EXT-completed" } }
    });
    await app.close();
  });

  it("replays a synchronized Task without dispatching twice when acknowledgement and queue inspection are both lost", async () => {
    const store = new InMemoryPlatformStore();
    const seed = await store.getSnapshot();
    const decision = await store.createDecision({
      meetingId: seed.meetings[0]!.id,
      title: "Replay completed ambiguous enqueue",
      description: "The original HTTP request must resolve to the first durable synchronization."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({ decisionId: decision.id, title: decision.title, description: decision.description, assignee: null });
    const adapter = await store.createTaskAdapterConnector({
      name: "Replay completed reference",
      location: "local",
      baseUrl: "http://task-adapter-reference:4200"
    });
    const enqueueTaskSync = vi.fn(async (_job, requestedJobId: string | undefined) => {
      const queued = (await store.getSnapshot()).tasks.find((item) => item.id === task.id)!;
      await store.completeTaskSync(
        task.id,
        requestedJobId!,
        "EXT-once",
        taskSyncRequestFingerprint(queued)
      );
      throw new Error("enqueue response lost after completed processing");
    });
    const agentQueue: AgentTurnQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      enqueueTaskSync,
      getJobState: vi.fn(async () => { throw new Error("redis unavailable"); }),
      close: vi.fn(async () => undefined)
    };
    const app = await createApp({ store, authDisabled: true, agentQueue });
    const originalPayload = {
      ...await currentTaskSyncRequest(store, task.id, adapter.id),
      expectedSyncAttemptCount: 0
    };

    const first = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync`, payload: originalPayload });
    const second = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync`, payload: originalPayload });

    expect(first.statusCode).toBe(503);
    expect(first.json().error.code).toBe("TASK_SYNC_ACCEPTANCE_UNKNOWN");
    expect(second.statusCode).toBe(202);
    expect(second.json()).toMatchObject({
      jobId: expect.any(String),
      task: { id: task.id, sync: { status: "synced", externalId: "EXT-once", attemptCount: 1 } }
    });
    expect(second.json().jobId).toBe((await store.getSnapshot()).tasks.find((item) => item.id === task.id)!.sync.jobId);
    expect(enqueueTaskSync).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("returns the durable Task sync failure when enqueue acknowledgement is lost after failure", async () => {
    const store = new InMemoryPlatformStore();
    const seed = await store.getSnapshot();
    const decision = await store.createDecision({ meetingId: seed.meetings[0]!.id, title: "Failed ambiguous enqueue", description: "Return durable failure." });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({ decisionId: decision.id, title: decision.title, description: decision.description, assignee: null });
    const adapter = await store.createTaskAdapterConnector({ name: "Failed reference", location: "local", baseUrl: "http://task-adapter-reference:4200" });
    const agentQueue: AgentTurnQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      enqueueTaskSync: vi.fn(async (_job, requestedJobId) => {
        const queued = (await store.getSnapshot()).tasks.find((item) => item.id === task.id)!;
        await store.failTaskSync({
          taskId: task.id,
          adapterId: adapter.id,
          jobId: requestedJobId!,
          requestFingerprint: queued.sync.requestFingerprint!
        }, "provider_or_runtime_failure");
        throw new Error("enqueue response lost after failed processing");
      }),
      getJobState: vi.fn(async () => "failed"),
      close: vi.fn(async () => undefined)
    };
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const response = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync`, payload: await currentTaskSyncRequest(store, task.id, adapter.id) });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("TASK_SYNC_FAILED");
    expect((await store.getSnapshot()).tasks.find((item) => item.id === task.id)).toMatchObject({
      sync: { status: "failed", lastError: "provider_or_runtime_failure" }
    });
    await app.close();
  });

  it("preserves a Task sync reservation when queue ownership cannot be inspected", async () => {
    const store = new InMemoryPlatformStore();
    const seed = await store.getSnapshot();
    const decision = await store.createDecision({ meetingId: seed.meetings[0]!.id, title: "Unknown queue acceptance", description: "Reconcile after the lease." });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({ decisionId: decision.id, title: decision.title, description: decision.description, assignee: null });
    const adapter = await store.createTaskAdapterConnector({ name: "Reference", location: "local", baseUrl: "http://task-adapter-reference:4200" });
    const agentQueue: AgentTurnQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      enqueueTaskSync: vi.fn(async () => { throw new Error("redis write result unknown"); }),
      getJobState: vi.fn(async () => { throw new Error("redis unavailable"); }),
      close: vi.fn(async () => undefined)
    };
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const response = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync`, payload: await currentTaskSyncRequest(store, task.id, adapter.id) });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("TASK_SYNC_ACCEPTANCE_UNKNOWN");
    expect((await store.getSnapshot()).tasks.find((item) => item.id === task.id)).toMatchObject({
      sync: { status: "queued", jobId: expect.any(String), lastError: null }
    });
    await app.close();
  });

  it("rejects a Task sync queue response that does not honor the durable job ID", async () => {
    const store = new InMemoryPlatformStore();
    const seed = await store.getSnapshot();
    const decision = await store.createDecision({
      meetingId: seed.meetings[0]!.id,
      title: "Mismatched sync job",
      description: "Keep the durable reservation authoritative."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({
      decisionId: decision.id,
      title: decision.title,
      description: decision.description,
      assignee: null
    });
    const adapter = await store.createTaskAdapterConnector({
      name: "Mismatched reference",
      location: "local",
      baseUrl: "http://task-adapter-reference:4200"
    });
    const agentQueue: AgentTurnQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      enqueueTaskSync: vi.fn(async () => ({ jobId: "unexpected-task-sync-job" })),
      getJobState: vi.fn(async () => null),
      close: vi.fn(async () => undefined)
    };
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const response = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/sync`,
      payload: await currentTaskSyncRequest(store, task.id, adapter.id)
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("TASK_SYNC_ALREADY_QUEUED");
    expect((await store.getSnapshot()).tasks.find((item) => item.id === task.id)).toMatchObject({
      sync: {
        status: "failed",
        adapterId: adapter.id,
        jobId: expect.any(String),
        lastError: "queue_conflict"
      }
    });
    await app.close();
  });

  it("does not enqueue Task synchronization when the durable reservation fails", async () => {
    const store = new InMemoryPlatformStore();
    const seed = await store.getSnapshot();
    const decision = await store.createDecision({ meetingId: seed.meetings[0]!.id, title: "Reservation failure", description: "Do not dispatch untracked work." });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({ decisionId: decision.id, title: decision.title, description: decision.description, assignee: null });
    const adapter = await store.createTaskAdapterConnector({ name: "Reference", location: "local", baseUrl: "http://task-adapter-reference:4200" });
    vi.spyOn(store, "markTaskSyncPending").mockRejectedValue(new Error("database unavailable"));
    const enqueueTaskSync = vi.fn(async () => ({ jobId: "unexpected" }));
    const agentQueue: AgentTurnQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      enqueueTaskSync,
      close: vi.fn(async () => undefined)
    };
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const response = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/sync`, payload: await currentTaskSyncRequest(store, task.id, adapter.id) });

    expect(response.statusCode).toBe(500);
    expect(enqueueTaskSync).not.toHaveBeenCalled();
    await app.close();
  });

  it("creates and advances a Meeting Agenda through the API", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const connector = await store.createModelConnector({
      name: "Agenda Local",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "meeting-local"
    });
    await configurePublishedMeetingAgent(store, snapshot.agents[0]!.id, connector.id);
    const eventBus = new MeetingEventBus();
    const events: MeetingEvent[] = [];
    const app = await createApp({ store, authDisabled: true, eventBus });

    const threadResponse = await app.inject({
      method: "POST",
      url: "/api/threads",
      headers: { "idempotency-key": "agenda-api-thread" },
      payload: {
        categoryId: snapshot.categories[0]!.id,
        title: "Agenda API 測試",
        summary: "驗證 Agenda 建立與推進。",
        tagIds: []
      }
    });
    expect(threadResponse.statusCode).toBe(201);
    const thread = threadResponse.json();

    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/meetings",
      headers: { "idempotency-key": "agenda-api-meeting" },
      payload: {
        threadId: thread.id,
        title: "Agenda API 測試會議",
        goal: "確認 Agenda API 邊界",
        mode: "open",
        durationMinutes: 30,
        participants: [{ agentId: snapshot.agents[0]!.id, roleId: snapshot.roles[0]!.id, isChair: true }],
        agendaItems: [
          { title: "確認第一項", description: "第一項描述不應進入事件。" },
          { title: "確認第二項", description: "第二項描述不應進入事件。" }
        ]
      }
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json();
    expect(created.agenda).toMatchObject({ revision: 0, items: [
      expect.objectContaining({ title: "確認第一項", status: "pending", position: 0 }),
      expect.objectContaining({ title: "確認第二項", status: "pending", position: 1 })
    ] });
    const unsubscribe = await eventBus.subscribe(created.id, (event) => events.push(event));
    const draftItems = created.agenda.items.map((item: { id: string; title: string; description: string }) => ({
      id: item.id,
      title: item.title,
      description: item.description
    }));

    const noOp = await app.inject({
      method: "PATCH",
      url: `/api/meetings/${created.id}/agenda`,
      payload: { expectedRevision: 0, items: draftItems }
    });
    expect(noOp.statusCode).toBe(200);
    expect(noOp.json().agenda.revision).toBe(0);
    expect(events).toHaveLength(0);

    const set = await app.inject({
      method: "PATCH",
      url: `/api/meetings/${created.id}/agenda`,
      payload: {
        expectedRevision: 0,
        items: draftItems.map((item: { id: string; title: string; description: string }, index: number) =>
          index === 0 ? { ...item, title: "確認第一項（更新）" } : item)
      }
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().agenda.revision).toBe(1);
    expect(events[0]).toMatchObject({
      type: "meeting.agenda.changed",
      meetingId: created.id,
      data: { revision: 1, action: "set", currentItemId: null },
      occurredAt: expect.any(String)
    });
    expect(events[0]!.data).not.toHaveProperty("items");
    expect(events[0]!.data).not.toHaveProperty("title");

    const stale = await app.inject({
      method: "POST",
      url: `/api/meetings/${created.id}/agenda/advance`,
      payload: { expectedRevision: 0, action: "complete", itemId: created.agenda.items[0].id }
    });
    expect(stale.statusCode).toBe(409);

    const started = await app.inject({ method: "POST", url: `/api/meetings/${created.id}/start` });
    expect(started.statusCode).toBe(200);
    const active = started.json();
    const currentItemId = active.agenda.items.find((item: { status: string }) => item.status === "current")?.id;
    expect(currentItemId).toEqual(created.agenda.items[0].id);
    expect(events[1]).toMatchObject({
      type: "meeting.agenda.changed",
      meetingId: created.id,
      data: { revision: 2, action: "activate", currentItemId }
    });

    const completed = await app.inject({
      method: "POST",
      url: `/api/meetings/${created.id}/agenda/advance`,
      payload: { expectedRevision: 2, action: "complete", itemId: currentItemId }
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().agenda.revision).toBe(3);
    expect(events[2]).toMatchObject({ data: { revision: 3, action: "complete", currentItemId: created.agenda.items[1].id } });

    const skipped = await app.inject({
      method: "POST",
      url: `/api/meetings/${created.id}/agenda/advance`,
      payload: { expectedRevision: 3, action: "skip", itemId: created.agenda.items[1].id }
    });
    expect(skipped.statusCode).toBe(200);
    expect(skipped.json().agenda.revision).toBe(4);
    expect(events[3]).toMatchObject({ data: { revision: 4, action: "skip", currentItemId: null } });

    const malformed = await app.inject({
      method: "PATCH",
      url: "/api/meetings/not-a-uuid/agenda",
      payload: { expectedRevision: 4, items: [] }
    });
    expect(malformed.statusCode).toBe(400);

    const strict = await app.inject({
      method: "POST",
      url: `/api/meetings/${created.id}/agenda/advance`,
      payload: { expectedRevision: 4, action: "activate", unexpected: true }
    });
    expect(strict.statusCode).toBe(400);

    const closed = await app.inject({ method: "POST", url: `/api/meetings/${created.id}/close` });
    expect(closed.statusCode).toBe(200);
    const closedMutation = await app.inject({
      method: "PATCH",
      url: `/api/meetings/${created.id}/agenda`,
      payload: { expectedRevision: 4, items: draftItems }
    });
    expect(closedMutation.statusCode).toBe(409);
    unsubscribe();
    await eventBus.close();
    await app.close();
  });

  it("keeps a committed Agenda mutation successful when event publishing fails", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const thread = await store.createThread({
      categoryId: snapshot.categories[0]!.id,
      title: "Agenda publish failure",
      summary: "Verify post-commit event failure handling.",
      tagIds: []
    });
    const meeting = await store.createMeeting({
      threadId: thread.id,
      title: "Agenda publish failure meeting",
      goal: "Keep committed state when publish fails.",
      mode: "open",
      durationMinutes: 30,
      participants: [{ agentId: snapshot.agents[0]!.id, roleId: snapshot.roles[0]!.id, isChair: true }],
      agendaItems: [{ title: "Publish failure", description: "" }]
    });
    const publish = vi.fn(async () => { throw new Error("event bus unavailable"); });
    const app = await createApp({
      store,
      authDisabled: true,
      eventBus: { publish } as unknown as MeetingEventBus
    });
    const before = meeting.agenda.items[0]!;
    const response = await app.inject({
      method: "PATCH",
      url: `/api/meetings/${meeting.id}/agenda`,
      payload: {
        expectedRevision: meeting.agenda.revision,
        items: [{ id: before.id, title: `${before.title} 更新`, description: before.description }]
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().agenda.revision).toBe(meeting.agenda.revision + 1);
    expect(publish).toHaveBeenCalledOnce();

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/meetings/${meeting.id}/agenda`,
      payload: {
        expectedRevision: meeting.agenda.revision,
        items: [{ id: before.id, title: "stale overwrite", description: before.description }]
      }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("REVISION_CONFLICT");
    await app.close();
  });

  it("publishes bounded metadata for Agenda activation", async () => {
    const source = new InMemoryPlatformStore();
    const snapshot = await source.getSnapshot();
    const meeting = snapshot.meetings[0]!;
    const now = new Date().toISOString();
    const itemId = "d0000000-0000-4000-8000-000000000003";
    meeting.state = "active";
    meeting.startedAt = now;
    meeting.agenda = {
      revision: 0,
      items: [{
        id: itemId,
        title: "待啟用項目",
        description: "不得進入 event data",
        position: 0,
        status: "pending",
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        resolvedAt: null
      }]
    };
    const store = new InMemoryPlatformStore(snapshot);
    const eventBus = new MeetingEventBus();
    const events: MeetingEvent[] = [];
    const unsubscribe = await eventBus.subscribe(meeting.id, (event) => events.push(event));
    const app = await createApp({ store, authDisabled: true, eventBus });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${meeting.id}/agenda/advance`,
      payload: { expectedRevision: 0, action: "activate" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().agenda.revision).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "meeting.agenda.changed",
      data: { revision: 1, action: "activate", currentItemId: itemId },
      occurredAt: expect.any(String)
    });
    expect(events[0]!.data).not.toHaveProperty("description");
    unsubscribe();
    await eventBus.close();
    await app.close();
  });

  it("publishes bounded Agenda activation metadata when a paused Meeting resumes", async () => {
    const source = new InMemoryPlatformStore();
    const snapshot = await source.getSnapshot();
    const meeting = snapshot.meetings[0]!;
    const now = new Date().toISOString();
    const itemId = "d0000000-0000-4000-8000-000000000004";
    meeting.state = "paused";
    meeting.startedAt = now;
    meeting.agenda = {
      revision: 4,
      items: [{
        id: itemId,
        title: "恢復後啟用",
        description: "不得進入 event data",
        position: 0,
        status: "pending",
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        resolvedAt: null
      }]
    };
    const store = new InMemoryPlatformStore(snapshot);
    const eventBus = new MeetingEventBus();
    const events: MeetingEvent[] = [];
    const unsubscribe = await eventBus.subscribe(meeting.id, (event) => events.push(event));
    const app = await createApp({ store, authDisabled: true, eventBus });

    const response = await app.inject({ method: "POST", url: `/api/meetings/${meeting.id}/resume` });
    expect(response.statusCode).toBe(200);
    expect(response.json().agenda.revision).toBe(5);
    expect(events).toEqual([expect.objectContaining({
      type: "meeting.agenda.changed",
      meetingId: meeting.id,
      data: { revision: 5, action: "activate", currentItemId: itemId }
    })]);
    expect(events[0]!.data).not.toHaveProperty("description");
    unsubscribe();
    await eventBus.close();
    await app.close();
  });

  it("rejects Agenda mutations from a foreign Origin", async () => {
    const store = new InMemoryPlatformStore();
    const meeting = (await store.getSnapshot()).meetings[0]!;
    const app = await createApp({ store, authDisabled: true, allowedOrigin: "https://council.test" });
    const response = await app.inject({
      method: "PATCH",
      url: `/api/meetings/${meeting.id}/agenda`,
      headers: { origin: "https://evil.example" },
      payload: { expectedRevision: meeting.agenda.revision, items: [] }
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("rejects meetings that include an Agent without an enabled model", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const app = await createApp({ store, authDisabled: true });

    const response = await app.inject({
      method: "POST",
      url: "/api/meetings",
      headers: { "idempotency-key": "fixed-flow-admission-meeting" },
      payload: {
        threadId: snapshot.threads[0]!.id,
        title: "不可執行會議",
        goal: "避免固定流程死鎖",
        mode: "fixed",
        durationMinutes: 30,
        participants: [{
          agentId: snapshot.agents[0]!.id,
          roleId: snapshot.roles[0]!.id,
          isChair: true
        }],
        agendaItems: [{ title: "確認執行條件", description: "" }]
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("PARTICIPANT_MODEL_UNAVAILABLE");
    await app.close();
  });

  it("rejects write tools and disabled Harness execution", async () => {
    const app = await createApp({ store: new InMemoryPlatformStore(), authDisabled: true });

    const tool = await app.inject({
      method: "POST",
      url: "/api/tools/authorize",
      payload: { connectorId: "docs", toolName: "update", effect: "write" }
    });
    expect(tool.statusCode).toBe(403);

    const harness = await app.inject({
      method: "POST",
      url: "/api/executions/harness",
      payload: { resourceId: "deploy_preview", inputs: {} }
    });
    expect(harness.statusCode).toBe(503);
    await app.close();
  });

  it("records a bounded write-ahead audit before starting an enabled allowlisted Harness execution", async () => {
    const store = new AuditedStore();
    const auditSpy = vi.spyOn(store, "recordAudit");
    const backend = {
      validate: vi.fn(async () => undefined),
      start: vi.fn(async () => ({
        executionId: "harness-execution-42",
        status: "queued" as const
      })),
      status: vi.fn(async () => ({ executionId: "harness-execution-42", status: "running" as const })),
      cancel: vi.fn(async () => ({ executionId: "harness-execution-42", status: "cancelled" as const }))
    };
    const externalExecutor = new GuardedExternalExecutor({
      enabled: true,
      allowedResourceIds: ["deploy_preview"]
    }, backend);
    const app = await createApp({ store, authDisabled: true, harnessEnabled: true, externalExecutor });

    const response = await app.inject({
      method: "POST",
      url: "/api/executions/harness",
      headers: { "idempotency-key": "harness-write-ahead-success" },
      payload: { resourceId: "deploy_preview", inputs: { release: "20260720T072200Z" } }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      executionId: "harness-execution-42",
      status: "queued"
    });
    expect(backend.validate).toHaveBeenCalledWith({
      resourceId: "deploy_preview",
      inputs: { release: "20260720T072200Z" }
    });
    expect(backend.start).toHaveBeenCalledOnce();
    expect(store.audits).toContainEqual({
      event: "external_execution.requested",
      detail: {}
    });
    expect(auditSpy.mock.invocationCallOrder[0]).toBeLessThan(backend.start.mock.invocationCallOrder[0]!);
    expect(JSON.stringify(store.audits)).not.toContain("20260720T072200Z");
    await app.close();
  });

  it("refuses Harness execution when its required write-ahead audit fails", async () => {
    const store = new InMemoryPlatformStore();
    const auditSpy = vi.spyOn(store, "recordAudit").mockRejectedValue(new Error("audit store unavailable"));
    const backend = {
      validate: vi.fn(async () => undefined),
      start: vi.fn(async () => ({ executionId: "harness-execution-43", status: "queued" as const })),
      status: vi.fn(async () => ({ executionId: "harness-execution-43", status: "running" as const })),
      cancel: vi.fn(async () => ({ executionId: "harness-execution-43", status: "cancelled" as const }))
    };
    const externalExecutor = new GuardedExternalExecutor({
      enabled: true,
      allowedResourceIds: ["deploy_preview"]
    }, backend);
    const app = await createApp({ store, authDisabled: true, harnessEnabled: true, externalExecutor });

    const response = await app.inject({
      method: "POST",
      url: "/api/executions/harness",
      headers: { "idempotency-key": "harness-write-ahead-audit-failure" },
      payload: { resourceId: "deploy_preview", inputs: {} }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: {
        code: "EXTERNAL_EXECUTION_ADMISSION_UNAVAILABLE",
        message: "Execution admission could not be confirmed."
      }
    });
    expect(auditSpy).toHaveBeenCalledWith(
      "external_execution.requested",
      "external_execution",
      expect.any(String),
      {}
    );
    expect(backend.validate).toHaveBeenCalledOnce();
    expect(backend.start).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an unsafe cloud connector as a client error", async () => {
    const app = await createApp({ store: new InMemoryPlatformStore(), authDisabled: true });
    const response = await app.inject({
      method: "POST",
      url: "/api/model-connectors",
      headers: { "idempotency-key": "unsafe-cloud-connector" },
      payload: {
        name: "Private cloud bypass",
        location: "cloud",
        baseUrl: "http://10.20.30.40/v1",
        model: "blocked"
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("CONNECTOR_URL_REJECTED");
    await app.close();
  });

  it("rotates a Model Connector Credential through CAS and patches metadata with a secret-safe audit", async () => {
    const store = new AuditedStore();
    const secretVault = new SecretVault(Buffer.alloc(32, 13));
    const app = await createApp({ store, authDisabled: true, secretVault });
    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/model-connectors",
      headers: { "idempotency-key": "model-credential-cas" },
      payload: {
        name: "GB10 primary",
        location: "local",
        baseUrl: "http://10.20.30.40/v1",
        model: "local-meeting",
        apiKey: "old-model-api-key"
      }
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json();
    const previousCiphertext = await store.getConnectorSecret(created.id);

    const rotated = await app.inject({
      method: "POST",
      url: `/api/credentials/${created.credentialId}/rotate`,
      headers: { "idempotency-key": "connector-credential-rotation" },
      payload: {
        credentialId: created.credentialId,
        secret: "rotated-model-api-key",
        expectedSecretRevision: 1
      }
    });
    const rotatedConnector = (await store.getSnapshot()).modelConnectors.find((item) => item.id === created.id)!;

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/model-connectors/${created.id}`,
      payload: {
        expectedRevision: rotatedConnector.revision,
        name: "Cloud fallback",
        location: "cloud",
        baseUrl: "https://1.1.1.1/v1",
        model: "cloud-meeting-v2",
        enabled: false
      }
    });
    const reenabled = await app.inject({
      method: "PATCH",
      url: `/api/model-connectors/${created.id}`,
      payload: { expectedRevision: patched.json().revision, enabled: true }
    });
    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap" });
    const rotatedCiphertext = await store.getConnectorSecret(created.id);
    const updateAudits = store.audits.filter((audit) => audit.event === "model_connector.updated");

    expect.soft(rotated.statusCode).toBe(200);
    expect.soft(rotated.json()).toMatchObject({ id: created.credentialId, secretRevision: 2 });
    expect.soft(patched.statusCode).toBe(200);
    expect.soft(patched.json()).toMatchObject({
      id: created.id,
      name: "Cloud fallback",
      location: "cloud",
      baseUrl: "https://1.1.1.1/v1",
      model: "cloud-meeting-v2",
      enabled: false,
      hasSecret: true
    });
    expect.soft(reenabled.statusCode).toBe(200);
    expect.soft(reenabled.json()).toMatchObject({ id: created.id, enabled: true });
    expect.soft(rotatedCiphertext).not.toBe(previousCiphertext);
    expect.soft(secretVault.decrypt(rotatedCiphertext!)).toBe("rotated-model-api-key");
    expect.soft(bootstrap.json().modelConnectors).toContainEqual(expect.objectContaining({
      id: created.id,
      name: "Cloud fallback",
      location: "cloud",
      baseUrl: "https://1.1.1.1/v1",
      model: "cloud-meeting-v2",
      enabled: true,
      hasSecret: true
    }));
    expect.soft(updateAudits).toHaveLength(2);
    expect.soft(updateAudits[0]).toMatchObject({
      event: "model_connector.updated",
      detail: {
        fields: ["name", "location", "baseUrl", "model", "enabled"],
        secretRotated: false,
        previous: {
          name: "GB10 primary",
          location: "local",
          baseUrl: "http://10.20.30.40/v1",
          model: "local-meeting",
          enabled: true
        },
        current: {
          name: "Cloud fallback",
          location: "cloud",
          baseUrl: "https://1.1.1.1/v1",
          model: "cloud-meeting-v2",
          enabled: false
        }
      }
    });
    expect.soft(updateAudits[1]).toMatchObject({
      event: "model_connector.updated",
      detail: { fields: ["enabled"], secretRotated: false }
    });
    const publicSurfaces = [patched.body, reenabled.body, bootstrap.body, JSON.stringify(updateAudits)].join("\n");
    expect.soft(publicSurfaces).not.toContain("old-model-api-key");
    expect.soft(publicSurfaces).not.toContain("rotated-model-api-key");
    expect.soft(publicSurfaces).not.toContain(previousCiphertext!);
    expect.soft(publicSurfaces).not.toContain(rotatedCiphertext!);
    await app.close();
  });

  it("preserves a Model Connector API key when PATCH omits secret rotation", async () => {
    const store = new AuditedStore();
    const secretVault = new SecretVault(Buffer.alloc(32, 14));
    const app = await createApp({ store, authDisabled: true, secretVault });
    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/model-connectors",
      headers: { "idempotency-key": "model-preserve-secret" },
      payload: {
        name: "Retained local",
        location: "local",
        baseUrl: "http://10.20.30.40/v1",
        model: "local-v1",
        apiKey: "retained-model-api-key"
      }
    });
    const created = createdResponse.json();
    const before = await store.getConnectorSecret(created.id);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/model-connectors/${created.id}`,
      payload: { expectedRevision: created.revision, name: "Retained local renamed", model: "local-v2" }
    });
    const after = await store.getConnectorSecret(created.id);
    const updateAudit = store.audits.find((audit) => audit.event === "model_connector.updated");

    expect.soft(patched.statusCode).toBe(200);
    expect.soft(patched.json()).toMatchObject({
      id: created.id,
      name: "Retained local renamed",
      model: "local-v2",
      hasSecret: true
    });
    expect.soft(after).toBe(before);
    expect.soft(secretVault.decrypt(after!)).toBe("retained-model-api-key");
    expect.soft(updateAudit).toMatchObject({
      event: "model_connector.updated",
      detail: { fields: ["name", "model"], secretRotated: false }
    });
    expect.soft([patched.body, JSON.stringify(updateAudit)].join("\n")).not.toContain("retained-model-api-key");
    await app.close();
  });

  it("rejects a stale Model Connector PATCH without applying any stale fields", async () => {
    const store = new InMemoryPlatformStore();
    const app = await createApp({ store, authDisabled: true });
    const created = (await app.inject({
      method: "POST",
      url: "/api/model-connectors",
      headers: { "idempotency-key": "model-stale-patch" },
      payload: {
        name: "Two-tab model",
        location: "cloud",
        baseUrl: "https://1.1.1.1/v1",
        model: "meeting-v1"
      }
    })).json();

    const current = await app.inject({
      method: "PATCH",
      url: `/api/model-connectors/${created.id}`,
      payload: { expectedRevision: created.revision, model: "meeting-v2" }
    });
    const stale = await app.inject({
      method: "PATCH",
      url: `/api/model-connectors/${created.id}`,
      payload: {
        expectedRevision: created.revision,
        name: "Stale tab name",
        baseUrl: "https://8.8.8.8/v1"
      }
    });

    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ revision: created.revision + 1, model: "meeting-v2" });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
    expect((await store.getSnapshot()).modelConnectors.find((item) => item.id === created.id))
      .toMatchObject({ revision: created.revision + 1, name: "Two-tab model", baseUrl: "https://1.1.1.1/v1", model: "meeting-v2" });
    await app.close();
  });

  it("rejects the legacy Model Connector API key PATCH field", async () => {
    const store = new AuditedStore();
    const secretVault = new SecretVault(Buffer.alloc(32, 15));
    const app = await createApp({ store, authDisabled: true, secretVault });
    const created = (await app.inject({
      method: "POST",
      url: "/api/model-connectors",
      headers: { "idempotency-key": "model-legacy-api-key-patch" },
      payload: {
        name: "Blank-preserved local",
        location: "local",
        baseUrl: "http://10.20.30.40/v1",
        model: "local-v1",
        apiKey: "retained-through-blank"
      }
    })).json();
    const before = await store.getConnectorSecret(created.id);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/model-connectors/${created.id}`,
      payload: { apiKey: "   " }
    });
    const after = await store.getConnectorSecret(created.id);
    expect.soft(patched.statusCode).toBe(400);
    expect.soft(patched.json().error.code).toBe("VALIDATION_ERROR");
    expect.soft(after).toBe(before);
    expect.soft(secretVault.decrypt(after!)).toBe("retained-through-blank");
    expect.soft(store.audits.filter((audit) => audit.event === "model_connector.updated")).toHaveLength(0);
    expect.soft(patched.body).not.toContain("retained-through-blank");
    await app.close();
  });

  it("validates Model Connector PATCH URLs against the effective location and base URL", async () => {
    const store = new InMemoryPlatformStore();
    const app = await createApp({ store, authDisabled: true });
    const local = (await app.inject({
      method: "POST",
      url: "/api/model-connectors",
      headers: { "idempotency-key": "model-effective-url-local" },
      payload: {
        name: "Private local",
        location: "local",
        baseUrl: "http://10.20.30.40/v1",
        model: "local"
      }
    })).json();
    const cloud = (await app.inject({
      method: "POST",
      url: "/api/model-connectors",
      headers: { "idempotency-key": "model-effective-url-cloud" },
      payload: {
        name: "Public cloud",
        location: "cloud",
        baseUrl: "https://1.1.1.1/v1",
        model: "cloud"
      }
    })).json();

    const locationOnly = await app.inject({
      method: "PATCH",
      url: `/api/model-connectors/${local.id}`,
      payload: { expectedRevision: local.revision, location: "cloud" }
    });
    const baseUrlOnly = await app.inject({
      method: "PATCH",
      url: `/api/model-connectors/${cloud.id}`,
      payload: { expectedRevision: cloud.revision, baseUrl: "http://10.20.30.41/v1" }
    });
    const validPair = await app.inject({
      method: "PATCH",
      url: `/api/model-connectors/${cloud.id}`,
      payload: { expectedRevision: cloud.revision, location: "local", baseUrl: "http://10.20.30.41/v1" }
    });

    expect.soft(locationOnly.statusCode).toBe(400);
    expect.soft(locationOnly.json()).toMatchObject({ error: { code: "CONNECTOR_URL_REJECTED" } });
    expect.soft(baseUrlOnly.statusCode).toBe(400);
    expect.soft(baseUrlOnly.json()).toMatchObject({ error: { code: "CONNECTOR_URL_REJECTED" } });
    expect.soft(validPair.statusCode).toBe(200);
    expect.soft(validPair.json()).toMatchObject({
      id: cloud.id,
      location: "local",
      baseUrl: "http://10.20.30.41/v1"
    });
    const updateSpy = vi.spyOn(store, "updateModelConnector");
    const locationOnlyValid = await app.inject({
      method: "PATCH",
      url: `/api/model-connectors/${cloud.id}`,
      payload: { expectedRevision: validPair.json().revision, location: "local" }
    });
    expect.soft(locationOnlyValid.statusCode).toBe(200);
    expect(updateSpy).toHaveBeenLastCalledWith(
      cloud.id,
      expect.objectContaining({ location: "local", baseUrl: "http://10.20.30.41/v1" })
    );
    expect.soft((await store.getSnapshot()).modelConnectors).toContainEqual(expect.objectContaining({
      id: local.id,
      location: "local",
      baseUrl: "http://10.20.30.40/v1"
    }));
    await app.close();
  });

  it("refuses to health-check a disabled Model Connector", async () => {
    const seed = await new InMemoryPlatformStore().getSnapshot();
    const connectorId = "c0000000-0000-4000-8000-000000000099";
    seed.modelConnectors.push({
      id: connectorId,
      revision: 1,
      name: "Disabled model",
      location: "local",
      baseUrl: "http://127.0.0.1/v1",
      model: "disabled",
      enabled: false,
      hasSecret: false,
      secretRevision: 0
    });
    const app = await createApp({ store: new InMemoryPlatformStore(seed), authDisabled: true });

    const response = await app.inject({ method: "POST", url: `/api/model-connectors/${connectorId}/health` });

    expect.soft(response.statusCode).toBe(409);
    expect.soft(response.json()).toMatchObject({ error: { code: "CONNECTOR_DISABLED" } });
    await app.close();
  });

  it("refuses Model Connector health before reading a revoked Credential ciphertext", async () => {
    const store = new InMemoryPlatformStore();
    const secretVault = new SecretVault(Buffer.alloc(32, 19));
    const connector = await store.createModelConnector({
      name: "Revoked credential model",
      location: "cloud",
      baseUrl: "https://1.1.1.1/v1",
      model: "revoked-model"
    }, { ciphertext: secretVault.encrypt("revoked-model-secret") });
    const credential = (await store.getCredentials()).find((item) => item.id === connector.credentialId)!;
    await store.setCredentialStatus(connector.credentialId!, {
      status: "revoked",
      expectedUpdatedAt: credential.updatedAt
    });
    const secretSpy = vi.spyOn(store, "getConnectorSecret");
    const decryptSpy = vi.spyOn(secretVault, "decrypt");
    const healthSpy = vi.spyOn(OpenAICompatibleConnector.prototype, "health").mockResolvedValue(true);
    const app = await createApp({ store, authDisabled: true, secretVault });

    try {
      const response = await app.inject({ method: "POST", url: `/api/model-connectors/${connector.id}/health` });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: "CREDENTIAL_REVOKED", message: "Model connector Credential is revoked." }
      });
      expect(secretSpy).not.toHaveBeenCalled();
      expect(decryptSpy).not.toHaveBeenCalled();
      expect(healthSpy).not.toHaveBeenCalled();
    } finally {
      healthSpy.mockRestore();
      await app.close();
    }
  });

  it("refuses Model Connector health before reading an expired Credential ciphertext", async () => {
    const store = new InMemoryPlatformStore();
    const secretVault = new SecretVault(Buffer.alloc(32, 29));
    const credential = await store.createCredential({
      name: "Expired credential",
      provider: "expired-provider",
      kind: "api_key",
      location: "cloud",
      expiresAt: null
    }, { ciphertext: secretVault.encrypt("expired-model-secret") });
    const connector = await store.createModelConnector({
      name: "Expired credential model",
      location: "cloud",
      baseUrl: "https://1.1.1.1/v1",
      model: "expired-model",
      credentialId: credential.id
    });
    await store.updateCredential(credential.id, {
      expiresAt: "2000-01-01T00:00:00.000Z",
      expectedUpdatedAt: credential.updatedAt
    });
    const secretSpy = vi.spyOn(store, "getConnectorSecret");
    const decryptSpy = vi.spyOn(secretVault, "decrypt");
    const healthSpy = vi.spyOn(OpenAICompatibleConnector.prototype, "health").mockResolvedValue(true);
    const app = await createApp({ store, authDisabled: true, secretVault });

    try {
      const response = await app.inject({ method: "POST", url: `/api/model-connectors/${connector.id}/health` });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: "CREDENTIAL_EXPIRED", message: expect.stringMatching(/expired/i) }
      });
      expect(secretSpy).not.toHaveBeenCalled();
      expect(decryptSpy).not.toHaveBeenCalled();
      expect(healthSpy).not.toHaveBeenCalled();
    } finally {
      healthSpy.mockRestore();
      await app.close();
    }
  });

  it("fails Model Connector health closed when endpoint and secret rotate during binding", async () => {
    const store = new InMemoryPlatformStore();
    const secretVault = new SecretVault(Buffer.alloc(32, 17));
    const connector = await store.createModelConnector({
      name: "Rotating model",
      location: "cloud",
      baseUrl: "https://1.1.1.1/v1",
      model: "rotating-model"
    }, { ciphertext: secretVault.encrypt("old-model-secret") });
    const readSecret = store.getConnectorSecret.bind(store);
    const secretSpy = vi.spyOn(store, "getConnectorSecret").mockImplementationOnce(async (id) => {
      const staleCiphertext = await readSecret(id);
      await store.rotateCredential({
        credentialId: connector.credentialId!,
        expectedSecretRevision: connector.secretRevision
      }, { ciphertext: secretVault.encrypt("new-model-secret") });
      return staleCiphertext;
    });
    const healthSpy = vi.spyOn(OpenAICompatibleConnector.prototype, "health").mockResolvedValue(true);
    const app = await createApp({ store, authDisabled: true, secretVault });

    try {
      const response = await app.inject({ method: "POST", url: `/api/model-connectors/${connector.id}/health` });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("CONNECTOR_CHANGED");
      expect(healthSpy).not.toHaveBeenCalled();
    } finally {
      secretSpy.mockRestore();
      healthSpy.mockRestore();
      await app.close();
    }
  });

  it("fails Model Connector health closed when a same-revision Credential is rebound during binding", async () => {
    const store = new InMemoryPlatformStore();
    const secretVault = new SecretVault(Buffer.alloc(32, 18));
    const firstCredential = await store.createCredential({
      name: "First model credential",
      provider: "provider-a",
      kind: "api_key",
      location: "cloud"
    }, { ciphertext: secretVault.encrypt("first-model-secret") });
    const secondCredential = await store.createCredential({
      name: "Second model credential",
      provider: "provider-b",
      kind: "api_key",
      location: "cloud"
    }, { ciphertext: secretVault.encrypt("second-model-secret") });
    const connector = await store.createModelConnector({
      name: "Rebinding model",
      location: "cloud",
      baseUrl: "https://1.1.1.1/v1",
      model: "rebinding-model",
      credentialId: firstCredential.id
    });
    const readSecret = store.getConnectorSecret.bind(store);
    const secretSpy = vi.spyOn(store, "getConnectorSecret").mockImplementationOnce(async (id) => {
      const staleCiphertext = await readSecret(id);
      await store.updateModelConnector(id, {
        expectedRevision: connector.revision,
        credentialId: secondCredential.id
      });
      return staleCiphertext;
    });
    const healthSpy = vi.spyOn(OpenAICompatibleConnector.prototype, "health").mockResolvedValue(true);
    const app = await createApp({ store, authDisabled: true, secretVault });

    try {
      const response = await app.inject({ method: "POST", url: `/api/model-connectors/${connector.id}/health` });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("CONNECTOR_CHANGED");
      expect(healthSpy).not.toHaveBeenCalled();
    } finally {
      secretSpy.mockRestore();
      healthSpy.mockRestore();
      await app.close();
    }
  });

  it("fails Model Connector health closed when its binding changes while the check is in flight", async () => {
    const store = new InMemoryPlatformStore();
    const connector = await store.createModelConnector({
      name: "In-flight rotating model",
      location: "cloud",
      baseUrl: "https://1.1.1.1/v1",
      model: "in-flight-model"
    });
    let signalHealthStarted!: () => void;
    let releaseHealth!: () => void;
    const healthStarted = new Promise<void>((resolve) => { signalHealthStarted = resolve; });
    const healthGate = new Promise<void>((resolve) => { releaseHealth = resolve; });
    const healthSpy = vi.spyOn(OpenAICompatibleConnector.prototype, "health").mockImplementationOnce(async () => {
      signalHealthStarted();
      await healthGate;
      return true;
    });
    const app = await createApp({ store, authDisabled: true });

    try {
      const responsePromise = app.inject({ method: "POST", url: `/api/model-connectors/${connector.id}/health` });
      await healthStarted;
      await store.updateModelConnector(connector.id, {
        expectedRevision: connector.revision,
        baseUrl: "https://1.0.0.1/v1"
      });
      releaseHealth();
      const response = await responsePromise;

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("CONNECTOR_CHANGED");
      expect(healthSpy).toHaveBeenCalledOnce();
    } finally {
      releaseHealth();
      healthSpy.mockRestore();
      await app.close();
    }
  });

  it("rejects creating a Model Connector with both an existing Credential and a replacement API key", async () => {
    const store = new InMemoryPlatformStore();
    const secretVault = new SecretVault(Buffer.alloc(32, 20));
    const credential = await store.createCredential({
      name: "Shared model credential",
      provider: "shared-provider",
      kind: "api_key",
      location: "cloud"
    }, { ciphertext: secretVault.encrypt("shared-secret") });
    const createSpy = vi.spyOn(store, "createModelConnector");
    const app = await createApp({ store, authDisabled: true, secretVault });

    const response = await app.inject({
      method: "POST",
      url: "/api/model-connectors",
      headers: { "idempotency-key": "model-existing-credential-conflict" },
      payload: {
        name: "Unsafe shared overwrite",
        location: "cloud",
        baseUrl: "https://1.1.1.1/v1",
        model: "shared-model",
        credentialId: credential.id,
        apiKey: "replacement-without-cas"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(createSpy).not.toHaveBeenCalled();
    expect(secretVault.decrypt((await store.getCredentialSecret(credential.id))!)).toBe("shared-secret");
    await app.close();
  });

  it("rejects stale Connector-driven rotation of a shared Credential", async () => {
    const store = new InMemoryPlatformStore();
    const secretVault = new SecretVault(Buffer.alloc(32, 22));
    const credential = await store.createCredential({
      name: "Shared rotation credential",
      provider: "shared-provider",
      kind: "api_key",
      location: "cloud"
    }, { ciphertext: secretVault.encrypt("revision-one") });
    const firstConnector = await store.createModelConnector({
      name: "Shared first connector",
      location: "cloud",
      baseUrl: "https://1.1.1.1/v1",
      model: "shared-first",
      credentialId: credential.id
    });
    const secondConnector = await store.createModelConnector({
      name: "Shared second connector",
      location: "cloud",
      baseUrl: "https://1.0.0.1/v1",
      model: "shared-second",
      credentialId: credential.id
    });
    await store.rotateCredential({
      credentialId: credential.id,
      expectedSecretRevision: 1
    }, { ciphertext: secretVault.encrypt("revision-two") });
    const revisionTwoCiphertext = await store.getCredentialSecret(credential.id);
    const app = await createApp({ store, authDisabled: true, secretVault });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/model-connectors/${firstConnector.id}`,
      payload: { model: "stale-client-model", apiKey: "stale-client-secret" }
    });

    expect(response.statusCode).toBe(400);
    expect(await store.getCredentialSecret(credential.id)).toBe(revisionTwoCiphertext);
    expect((await store.getSnapshot()).modelConnectors.filter((item) => (
      item.id === firstConnector.id || item.id === secondConnector.id
    ))).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstConnector.id, model: "shared-first", secretRevision: 2 }),
      expect.objectContaining({ id: secondConnector.id, model: "shared-second", secretRevision: 2 })
    ]));
    await app.close();
  });

  it("rejects disabled Model Connector assignment and keeps it outside the Agent runtime queue", async () => {
    const seed = await new InMemoryPlatformStore().getSnapshot();
    const connectorId = "c0000000-0000-4000-8000-000000000098";
    const agent = seed.agents[0]!;
    seed.modelConnectors.push({
      id: connectorId,
      revision: 1,
      name: "Disabled assignment",
      location: "local",
      baseUrl: "http://10.20.30.40/v1",
      model: "disabled",
      enabled: false,
      hasSecret: false,
      secretRevision: 0
    });
    const store = new InMemoryPlatformStore(seed);
    const enqueue = vi.fn(async () => ({ jobId: "unexpected-agent-job" }));
    const agentQueue = {
      enqueue,
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      close: vi.fn(async () => undefined)
    } as AgentTurnQueue;
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const assignment = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}/model`,
      payload: { expectedDraftRevision: agent.draftRevision, modelConnectorId: connectorId }
    });
    const run = await app.inject({
      method: "POST",
      url: `/api/meetings/${seed.meetings[0]!.id}/run`,
      headers: { "idempotency-key": "disabled-model-run" },
      payload: { agentId: agent.id }
    });

    expect.soft(assignment.statusCode).toBe(409);
    expect.soft(assignment.json()).toMatchObject({ error: { message: expect.stringMatching(/disabled/i) } });
    expect.soft((await store.getSnapshot()).agents.find((item) => item.id === agent.id)?.modelConnectorId).toBeNull();
    expect.soft(run.statusCode).toBe(409);
    expect.soft(run.json()).toMatchObject({ error: { code: "MODEL_NOT_CONFIGURED" } });
    expect.soft(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it("preserves the meeting runtime admission error when the current Runtime Profile is disabled", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const participant = snapshot.participants[0]!;
    const binding = snapshot.agents.find((agent) => agent.id === participant.agentId)!.runtimeProfileBinding!;
    const profile = snapshot.runtimeProfiles!.find((candidate) => candidate.id === binding.profileId)!;
    await store.updateRuntimeProfile(profile.id, {
      expectedRevision: profile.revision,
      enabled: false
    });
    const enqueue = vi.fn(async () => ({ jobId: "unexpected-agent-job" }));
    const app = await createApp({
      store,
      authDisabled: true,
      agentQueue: {
        enqueue,
        enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
        enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
        close: vi.fn(async () => undefined)
      } as AgentTurnQueue
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${snapshot.meetings[0]!.id}/run`,
      headers: { "idempotency-key": "disabled-runtime-run" },
      payload: { agentId: participant.agentId }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "RUNTIME_PROFILE_NOT_READY",
        message: "The Agent's bound Runtime Profile is unavailable or no longer permitted."
      }
    });
    expect(enqueue).not.toHaveBeenCalled();
    await app.close();
  });

  it("stores one Task Adapter secret outside the snapshot and decrypts it only for health checks", async () => {
    const store = new InMemoryPlatformStore();
    const secretVault = new SecretVault(Buffer.alloc(32, 7));
    let healthConfig: TaskAdapterClientConfig | undefined;
    const app = await createApp({
      store,
      authDisabled: true,
      secretVault,
      taskAdapterClientFactory: (config) => {
        healthConfig = config;
        return { health: async () => true };
      }
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/task-adapter-connectors",
      headers: { "idempotency-key": "task-adapter-secret-fixture" },
      payload: {
        name: "Reference tasks",
        location: "cloud",
        baseUrl: "https://1.1.1.1",
        bearerToken: "adapter-secret"
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: "Reference tasks", enabled: true, hasSecret: true });
    expect(created.body).not.toContain("adapter-secret");

    const connector = created.json();
    const snapshot = await store.getSnapshot();
    expect(snapshot.taskAdapterConnectors).toEqual([connector]);
    expect(JSON.stringify(snapshot)).not.toContain("adapter-secret");
    const ciphertext = await store.getConnectorSecret(connector.id);
    expect(ciphertext).not.toBeNull();
    expect(secretVault.decrypt(ciphertext!)).toBe("adapter-secret");

    const health = await app.inject({ method: "POST", url: `/api/task-adapter-connectors/${connector.id}/health` });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ healthy: true });
    expect(healthConfig).toEqual({
      baseUrl: "https://1.1.1.1",
      bearerToken: "adapter-secret",
      allowPrivate: false
    });

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/task-adapter-connectors",
      headers: { "idempotency-key": "task-adapter-second-enabled" },
      payload: { name: "Second adapter", location: "cloud", baseUrl: "https://1.0.0.1" }
    });
    expect(duplicate.statusCode).toBe(409);
    await app.close();
  });

  it("records Store-owned Agent and Model Connector creation audits exactly once", async () => {
    const store = new AuditedStore();
    const app = await createApp({ store, authDisabled: true });
    const connectorResponse = await app.inject({
      method: "POST",
      url: "/api/model-connectors",
      headers: { "idempotency-key": "model-single-audit" },
      payload: {
        name: "Single-audit model",
        location: "local",
        baseUrl: "http://10.20.30.40/v1",
        model: "single-audit"
      }
    });
    expect(connectorResponse.statusCode).toBe(201);

    const agentResponse = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "idempotency-key": "single-audit-agent" },
      payload: {
        name: "Single-audit Agent",
        description: "",
        modelConnectorId: connectorResponse.json().id,
        goalSummary: "Prove Store-owned audit authority.",
        toolsSummary: "No tools.",
        dataSummary: "No data.",
        skillIds: [],
        toolGrants: [],
        runtimeProfileBinding: null,
        promptBinding: null
      }
    });
    expect(agentResponse.statusCode).toBe(201);
    expect(store.events.filter((event) => event === "model_connector.created")).toHaveLength(1);
    expect(store.events.filter((event) => event === "agent.created")).toHaveLength(1);
    await app.close();
  });

  it("approves a Skill and assigns only approved Agent permissions", async () => {
    const store = new AuditedStore();
    const app = await createApp({ store, authDisabled: true });
    const snapshot = (await app.inject({ method: "GET", url: "/api/bootstrap" })).json();

    const skill = (await app.inject({
      method: "POST",
      url: "/api/skills",
      headers: { "idempotency-key": "approved-agent-skill" },
      payload: { name: "Research", version: "1.0.0", instructions: "Find evidence.", source: "test", owner: "owner" }
    })).json();
    const connector = (await app.inject({
      method: "POST",
      url: "/api/mcp-connectors",
      headers: { "idempotency-key": "approved-agent-mcp-connector" },
      payload: { name: "Docs", baseUrl: "https://1.1.1.1/mcp", approvedTools: ["search"] }
    })).json();

    const beforeApproval = await app.inject({
      method: "PATCH",
      url: `/api/agents/${snapshot.agents[0].id}`,
      payload: { expectedDraftRevision: snapshot.agents[0].draftRevision, skillIds: [skill.id] }
    });
    expect(beforeApproval.statusCode).toBe(409);

    const validation = await app.inject({
      method: "POST",
      url: `/api/skills/${skill.id}/validation`,
      payload: { result: "passed", summary: "Reviewed.", expectedCheckedAt: skill.validation.checkedAt }
    });
    expect(validation.statusCode).toBe(200);

    expect((await app.inject({
      method: "PATCH",
      url: `/api/skills/${skill.id}/status`,
      payload: { status: "approved", expectedCheckedAt: validation.json().validation.checkedAt }
    })).statusCode).toBe(200);

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/agents/${snapshot.agents[0].id}`,
      payload: {
        expectedDraftRevision: snapshot.agents[0].draftRevision,
        skillIds: [skill.id],
        toolGrants: [{ connectorId: connector.id, toolName: "search" }]
      }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      skillIds: [skill.id],
      toolGrants: [{ connectorId: connector.id, toolName: "search" }]
    });
    expect(store.events).toEqual(expect.arrayContaining([
      "skill.created",
      "skill.validated",
      "skill.status.changed",
      "mcp_connector.created",
      "agent.updated"
    ]));
    expect(store.events.filter((event) => event === "mcp_connector.created")).toHaveLength(1);
    expect(store.events.filter((event) => event === "agent.updated")).toHaveLength(1);
    await app.close();
  });

  it("rejects stale Skill validation evidence and preserves the latest review", async () => {
    const store = new InMemoryPlatformStore();
    const app = await createApp({ store, authDisabled: true });
    const skill = (await app.inject({
      method: "POST",
      url: "/api/skills",
      headers: { "idempotency-key": "validation-cas-skill" },
      payload: {
        name: "Validation CAS API Skill",
        version: "1.0.0",
        instructions: "Keep only current human validation evidence.",
        source: "test",
        owner: "owner"
      }
    })).json();

    const current = await app.inject({
      method: "POST",
      url: `/api/skills/${skill.id}/validation`,
      payload: {
        result: "failed",
        summary: "The current reviewer found an unsafe instruction.",
        expectedCheckedAt: skill.validation.checkedAt
      }
    });
    expect(current.statusCode).toBe(200);

    const stale = await app.inject({
      method: "POST",
      url: `/api/skills/${skill.id}/validation`,
      payload: {
        result: "passed",
        summary: "A stale browser tab must not replace the current failure.",
        expectedCheckedAt: skill.validation.checkedAt
      }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
    expect((await store.getSnapshot()).skills.find((item) => item.id === skill.id)?.validation).toEqual(current.json().validation);

    const missingToken = await app.inject({
      method: "POST",
      url: `/api/skills/${skill.id}/validation`,
      payload: { result: "passed", summary: "A validation token is required." }
    });
    expect(missingToken.statusCode).toBe(400);
    await app.close();
  });

  it("binds Skill approval to the validation evidence shown to the owner", async () => {
    const store = new InMemoryPlatformStore();
    const app = await createApp({ store, authDisabled: true });
    const skill = (await app.inject({
      method: "POST",
      url: "/api/skills",
      headers: { "idempotency-key": "approval-cas-skill" },
      payload: {
        name: "Approval CAS API Skill",
        version: "1.0.0",
        instructions: "Approve exactly the validation evidence reviewed by the owner.",
        source: "test",
        owner: "owner"
      }
    })).json();
    const firstReview = await app.inject({
      method: "POST",
      url: `/api/skills/${skill.id}/validation`,
      payload: {
        result: "passed",
        summary: "First passing review.",
        expectedCheckedAt: skill.validation.checkedAt
      }
    });
    const currentReview = await app.inject({
      method: "POST",
      url: `/api/skills/${skill.id}/validation`,
      payload: {
        result: "passed",
        summary: "Newer passing evidence superseded the first review.",
        expectedCheckedAt: firstReview.json().validation.checkedAt
      }
    });
    expect(currentReview.statusCode).toBe(200);

    const staleApproval = await app.inject({
      method: "PATCH",
      url: `/api/skills/${skill.id}/status`,
      payload: { status: "approved", expectedCheckedAt: firstReview.json().validation.checkedAt }
    });
    expect(staleApproval.statusCode).toBe(409);
    expect(staleApproval.json()).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
    expect((await store.getSnapshot()).skills.find((item) => item.id === skill.id)?.status).toBe("draft");

    const missingToken = await app.inject({
      method: "PATCH",
      url: `/api/skills/${skill.id}/status`,
      payload: { status: "approved" }
    });
    expect(missingToken.statusCode).toBe(400);
    await app.close();
  });

  it("revokes an approved Skill through the governance endpoint and prunes Agent assignments", async () => {
    const store = new AuditedStore();
    const app = await createApp({ store, authDisabled: true });
    const snapshot = (await app.inject({ method: "GET", url: "/api/bootstrap" })).json();
    const skill = (await app.inject({
      method: "POST",
      url: "/api/skills",
      headers: { "idempotency-key": "revocable-skill" },
      payload: { name: "Bounded", version: "1.0.0", instructions: "Stay bounded.", source: "test", owner: "owner" }
    })).json();
    const validation = await app.inject({
      method: "POST",
      url: `/api/skills/${skill.id}/validation`,
      payload: { result: "passed", summary: "Reviewed.", expectedCheckedAt: skill.validation.checkedAt }
    });
    const expectedCheckedAt = validation.json().validation.checkedAt;
    expect((await app.inject({
      method: "PATCH",
      url: `/api/skills/${skill.id}/status`,
      payload: { status: "approved", expectedCheckedAt }
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "PATCH",
      url: `/api/skills/${skill.id}/status`,
      payload: { status: "approved", expectedCheckedAt }
    })).statusCode).toBe(200);
    await app.inject({
      method: "PATCH",
      url: `/api/agents/${snapshot.agents[2].id}`,
      payload: { expectedDraftRevision: snapshot.agents[2].draftRevision, skillIds: [skill.id] }
    });

    const revocationRequest = {
      method: "POST" as const,
      url: `/api/skills/${skill.id}/revoke`,
      headers: { "idempotency-key": "skill-lifecycle-revocation" },
      payload: { reason: "Superseded." }
    };
    const revoked = await app.inject(revocationRequest);
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ skill: { status: "revoked", revocationReason: "Superseded." }, revokedAssignmentCount: 1 });
    const retriedRevocation = await app.inject(revocationRequest);
    expect(retriedRevocation.statusCode).toBe(200);
    expect(retriedRevocation.json()).toEqual(revoked.json());
    const conflictingRevocation = await app.inject({
      ...revocationRequest,
      payload: { reason: "Different reason." }
    });
    expect(conflictingRevocation.statusCode).toBe(409);
    expect(conflictingRevocation.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });
    expect((await store.getSnapshot()).agents[2]!.skillIds).toEqual([]);
    expect(store.events.filter((event) => event === "skill.status.changed")).toHaveLength(1);
    expect(store.events.filter((event) => event === "skill.revoked")).toHaveLength(1);
    await app.close();
  });

  it("preserves existing Agent fields when applying a partial permissions update", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const agent = snapshot.agents[0]!;
    const model = await store.createModelConnector({
      name: "Local",
      location: "local",
      baseUrl: "http://10.20.30.40/v1",
      model: "meeting-local"
    });
    const mcp = await store.createMcpConnector({
      name: "Docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"]
    });
    const configuredAgent = await store.setAgentModel(agent.id, { modelConnectorId: model.id });
    const app = await createApp({ store, authDisabled: true });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}`,
      payload: {
        expectedDraftRevision: configuredAgent.draftRevision,
        toolGrants: [{ connectorId: mcp.id, toolName: "search" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      description: agent.description,
      modelConnectorId: model.id,
      skillIds: agent.skillIds,
      toolGrants: [{ connectorId: mcp.id, toolName: "search" }]
    });
    await app.close();
  });

  it("rejects a stale Agent draft update without overwriting the newer revision", async () => {
    const store = new InMemoryPlatformStore();
    const agent = (await store.getSnapshot()).agents[0]!;
    const app = await createApp({ store, authDisabled: true });

    const first = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}`,
      payload: { expectedDraftRevision: agent.draftRevision, name: "Current Agent draft" }
    });
    const stale = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agent.id}`,
      payload: { expectedDraftRevision: agent.draftRevision, description: "Stale overwrite" }
    });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ name: "Current Agent draft", draftRevision: (agent.draftRevision ?? 1) + 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.message).toMatch(/draft revision is stale/i);
    expect((await store.getSnapshot()).agents.find((item) => item.id === agent.id)).toMatchObject({
      name: "Current Agent draft",
      description: agent.description
    });
    await app.close();
  });

  it("switches a Meeting participant Role with optimistic revision and publishes a bounded event", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const participant = snapshot.participants[0]!;
    const targetRole = snapshot.roles.find((role) => role.id !== participant.roleId)!;
    const eventBus = new MeetingEventBus();
    const events: MeetingEvent[] = [];
    const unsubscribe = await eventBus.subscribe(participant.meetingId, (event) => events.push(event));
    const app = await createApp({ store, authDisabled: true, eventBus });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/meetings/${participant.meetingId}/participants/${participant.id}/role`,
      payload: {
        roleId: targetRole.id,
        expectedRoleRevision: participant.roleRevision,
        reason: "改由安全審查觀點檢視目前議程。"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: participant.id,
      roleId: targetRole.id,
      roleRevision: participant.roleRevision + 1,
      roleSnapshot: { roleId: targetRole.id, version: targetRole.version, source: "meeting_role_switched" }
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "meeting.participant.role.changed",
      meetingId: participant.meetingId,
      data: {
        participantId: participant.id,
        agentId: participant.agentId,
        roleId: targetRole.id,
        roleVersion: targetRole.version,
        roleRevision: participant.roleRevision + 1
      }
    }));

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/meetings/${participant.meetingId}/participants/${participant.id}/role`,
      payload: { roleId: participant.roleId, expectedRoleRevision: participant.roleRevision, reason: "使用過期畫面重試。" }
    });
    expect(stale.statusCode).toBe(409);
    unsubscribe();
    await eventBus.close();
    await app.close();
  });

  it("delivers a committed participant Role change locally when Redis publication fails", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const participant = snapshot.participants[0]!;
    const targetRole = snapshot.roles.find((role) => role.id !== participant.roleId)!;
    const eventBus = new MeetingEventBus();
    const events: MeetingEvent[] = [];
    const unsubscribe = await eventBus.subscribe(participant.meetingId, (event) => events.push(event));
    vi.spyOn(eventBus, "publish").mockRejectedValue(new Error("Redis unavailable"));
    const app = await createApp({ store, authDisabled: true, eventBus });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/meetings/${participant.meetingId}/participants/${participant.id}/role`,
      payload: {
        roleId: targetRole.id,
        expectedRoleRevision: participant.roleRevision,
        reason: "Verify the local post-commit delivery fallback."
      }
    });

    expect(response.statusCode).toBe(200);
    expect(events).toContainEqual(expect.objectContaining({
      type: "meeting.participant.role.changed",
      meetingId: participant.meetingId,
      data: expect.objectContaining({ participantId: participant.id, roleId: targetRole.id })
    }));
    unsubscribe();
    await app.close();
  });

  it("reserves a persisted speaker item before enqueue and binds the current participant Role", async () => {
    const store = new InMemoryPlatformStore();
    const initial = await store.getSnapshot();
    const seedParticipant = initial.participants[0]!;
    const connector = await store.createModelConnector({
      name: "Queue local",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "queue-local"
    });
    await configurePublishedMeetingAgent(store, seedParticipant.agentId, connector.id);
    const publishedAgent = (await store.getSnapshot()).agents.find((item) => item.id === seedParticipant.agentId)!;
    const thread = await store.createThread({
      categoryId: initial.categories[0]!.id,
      title: "Published speaker reservation",
      summary: "A mutable draft must not replace the Meeting-pinned runtime.",
      tagIds: []
    });
    const meeting = await store.createMeeting({
      threadId: thread.id,
      title: "Published speaker reservation",
      goal: "Reserve one immutable Agent turn.",
      mode: "open",
      durationMinutes: 20,
      participants: [{
        agentId: seedParticipant.agentId,
        roleId: seedParticipant.roleId,
        isChair: true,
        agentRevision: publishedAgent.publishedRevision!
      }],
      agendaItems: [{ title: "Reserve the pinned turn", description: "" }]
    });
    await store.setMeetingState(meeting.id, "active", "draft");
    const snapshot = await store.getSnapshot();
    const participant = snapshot.participants.find((item) => item.meetingId === meeting.id)!;
    await store.updateAgent(participant.agentId, { modelConnectorId: null });
    let queuedAgentJob: AgentTurnJobData | undefined;
    const enqueue = vi.fn(async (job: Parameters<AgentTurnQueue["enqueue"]>[0], requestedJobId?: string) => {
      queuedAgentJob = job;
      expect(requestedJobId).toMatch(new RegExp(`^${meeting.id}-agent-[0-9a-f]{40}$`));
      expect((await store.getSnapshot()).speakerQueue).toEqual([
        expect.objectContaining({ jobId: requestedJobId, participantId: participant.id, status: "queued" })
      ]);
      expect(job).toMatchObject({
        participantId: participant.id,
        roleRevision: participant.roleRevision,
        roleId: participant.roleId,
        roleVersion: participant.roleSnapshot.version,
        agentRevision: participant.agentRevision,
        runtimeProfileBinding: { profileId: expect.any(String), revision: expect.any(Number) },
        runtimeProfileSnapshot: {
          harnessKind: "openai_compatible",
          policy: "text_only"
        },
        runtimeRun: {
          kind: "meeting_turn",
          state: "queued",
          agentId: participant.agentId,
          scope: { kind: "meeting_participant", subjectId: participant.id },
          expiresAt: expect.any(String)
        }
      });
      return { jobId: requestedJobId! };
    });
    const agentQueue = {
      enqueue,
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      inspectJob: vi.fn(async () => queuedAgentJob ? inspectedAgentJob("waiting", queuedAgentJob) : null),
      close: vi.fn(async () => undefined)
    } as AgentTurnQueue;
    const eventBus = new MeetingEventBus();
    const events: MeetingEvent[] = [];
    const unsubscribe = await eventBus.subscribe(meeting.id, (event) => events.push(event));
    const app = await createApp({ store, authDisabled: true, agentQueue, eventBus });

    const runRequest = {
      method: "POST",
      url: `/api/meetings/${meeting.id}/run`,
      headers: { "idempotency-key": "lost-agent-run-ack" },
      payload: { agentId: participant.agentId }
    } as const;
    const response = await app.inject(runRequest);
    const replay = await app.inject(runRequest);

    expect(response.statusCode, response.body).toBe(202);
    expect(replay.statusCode, replay.body).toBe(202);
    expect(replay.json()).toEqual(response.json());
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(response.json().jobId).toMatch(new RegExp(`^${meeting.id}-agent-[0-9a-f]{40}$`));
    expect(events).toContainEqual(expect.objectContaining({
      type: "speaker.queue.changed",
      data: expect.objectContaining({ participantId: participant.id, status: "queued" })
    }));
    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().speakerQueue).toContainEqual(expect.objectContaining({
      id: response.json().jobId,
      jobId: response.json().jobId,
      status: "queued"
    }));

    const roleConflict = await app.inject({
      method: "PATCH",
      url: `/api/meetings/${meeting.id}/participants/${participant.id}/role`,
      payload: {
        roleId: snapshot.roles.find((role) => role.id !== participant.roleId)!.id,
        expectedRoleRevision: participant.roleRevision,
        reason: "不可在這位 Agent 排隊時切換。"
      }
    });
    expect(roleConflict.statusCode).toBe(409);
    unsubscribe();
    await eventBus.close();
    await app.close();
  });

  it("does not accept an Agent queue job whose immutable envelope belongs to another request", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const seedParticipant = snapshot.participants[0]!;
    const connector = await store.createModelConnector({
      name: "Agent envelope queue",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "agent-envelope"
    });
    const { meeting, participants } = await createPublishedTestMeeting(store, {
      connectorId: connector.id,
      title: "Agent envelope ownership",
      mode: "open",
      participants: [{ agentId: seedParticipant.agentId, roleId: seedParticipant.roleId, isChair: true }]
    });
    const participant = participants[0]!;
    let queuedJob: Parameters<AgentTurnQueue["enqueue"]>[0] | undefined;
    const enqueue = vi.fn(async (job: Parameters<AgentTurnQueue["enqueue"]>[0], requestedJobId?: string) => {
      queuedJob = job;
      return { jobId: requestedJobId! };
    });
    const inspectJob = vi.fn(async () => queuedJob ? {
      state: "waiting",
      data: createCouncilJobEnvelope("agent-turn", {
        ...queuedJob,
        modelConnectorBinding: { ...queuedJob.modelConnectorBinding!, model: "different-model" }
      })
    } : null);
    const app = await createApp({
      store,
      authDisabled: true,
      agentQueue: {
        enqueue,
        enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
        enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
        inspectJob,
        close: vi.fn(async () => undefined)
      }
    });

    const request = {
      method: "POST",
      url: `/api/meetings/${meeting.id}/run`,
      headers: { "idempotency-key": "wrong-agent-envelope" },
      payload: { agentId: participant.agentId }
    } as const;
    const response = await app.inject(request);
    const replay = await app.inject(request);

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("AGENT_TURN_QUEUE_OWNERSHIP_CONFLICT");
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe("AGENT_TURN_QUEUE_OWNERSHIP_CONFLICT");
    expect(inspectJob).toHaveBeenCalledTimes(2);
    expect((await store.getSnapshot()).speakerQueue).toEqual([
      expect.objectContaining({ jobId: expect.any(String), status: "queued" })
    ]);
    await app.close();
  });

  it("releases the persisted speaker reservation when BullMQ enqueue fails", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const seedParticipant = snapshot.participants[0]!;
    const connector = await store.createModelConnector({
      name: "Failing queue local",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "queue-local"
    });
    const { meeting, participants } = await createPublishedTestMeeting(store, {
      connectorId: connector.id,
      title: "Queue compensation",
      mode: "open",
      participants: [{ agentId: seedParticipant.agentId, roleId: seedParticipant.roleId, isChair: true }]
    });
    const participant = participants[0]!;
    const agentQueue = {
      enqueue: vi.fn(async () => { throw Object.assign(new Error("Redis unavailable."), { statusCode: 503 }); }),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      inspectJob: vi.fn(async () => null),
      close: vi.fn(async () => undefined)
    } as AgentTurnQueue;
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${meeting.id}/run`,
      headers: { "idempotency-key": "enqueue-failure-run" },
      payload: { agentId: participant.agentId }
    });

    expect(response.statusCode).toBe(503);
    expect((await store.getSnapshot()).speakerQueue).toEqual([]);
    await app.close();
  });

  it("keeps an accepted reservation when BullMQ enqueue returns an ambiguous error", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const seedParticipant = snapshot.participants[0]!;
    const connector = await store.createModelConnector({
      name: "Ambiguous queue local",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "queue-local"
    });
    const { meeting, participants } = await createPublishedTestMeeting(store, {
      connectorId: connector.id,
      title: "Ambiguous queue recovery",
      mode: "open",
      participants: [{ agentId: seedParticipant.agentId, roleId: seedParticipant.roleId, isChair: true }]
    });
    const participant = participants[0]!;
    let queuedAgentJob: AgentTurnJobData | undefined;
    const inspectJob = vi.fn(async () => queuedAgentJob ? inspectedAgentJob("active", queuedAgentJob) : null);
    const agentQueue = {
      enqueue: vi.fn(async (job: AgentTurnJobData) => {
        queuedAgentJob = job;
        throw Object.assign(new Error("Redis response timed out."), { statusCode: 503 });
      }),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      inspectJob,
      close: vi.fn(async () => undefined)
    } as AgentTurnQueue;
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${meeting.id}/run`,
      headers: { "idempotency-key": "ambiguous-enqueue-run" },
      payload: { agentId: participant.agentId }
    });

    expect(response.statusCode).toBe(202);
    expect(inspectJob).toHaveBeenCalledWith(response.json().jobId);
    expect((await store.getSnapshot()).speakerQueue).toEqual([
      expect.objectContaining({ jobId: response.json().jobId, status: "queued" })
    ]);
    await app.close();
  });

  it("reconciles a retained failed BullMQ job before accepting a same-key Agent turn replay", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const seedParticipant = snapshot.participants[0]!;
    const connector = await store.createModelConnector({
      name: "Retained failed Agent queue",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "retained-failed-agent"
    });
    const { meeting, participants } = await createPublishedTestMeeting(store, {
      connectorId: connector.id,
      title: "Retained failed Agent turn",
      mode: "open",
      participants: [{ agentId: seedParticipant.agentId, roleId: seedParticipant.roleId, isChair: true }]
    });
    const participant = participants[0]!;
    let queueState = "waiting";
    let retainedJob: AgentTurnJobData | undefined;
    const inspectJob = vi.fn(async () => retainedJob ? inspectedAgentJob(queueState, retainedJob) : null);
    const enqueue = vi.fn(async (
      job: Parameters<AgentTurnQueue["enqueue"]>[0],
      requestedJobId?: string
    ) => {
      retainedJob ??= job;
      return { jobId: requestedJobId! };
    });
    const agentQueue = {
      enqueue,
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      inspectJob,
      close: vi.fn(async () => undefined)
    } as AgentTurnQueue;
    const app = await createApp({ store, authDisabled: true, agentQueue });
    const request = {
      method: "POST" as const,
      url: `/api/meetings/${meeting.id}/run`,
      headers: { "idempotency-key": "retained-failed-agent-turn" },
      payload: { agentId: participant.agentId }
    };

    const queued = await app.inject(request);
    expect(queued.statusCode).toBe(202);
    queueState = "failed";

    const retainedReplay = await app.inject(request);
    expect(retainedReplay.statusCode).toBe(409);
    expect(retainedReplay.json().error.code).toBe("AGENT_TURN_RECONCILIATION_REQUIRED");
    expect(inspectJob).toHaveBeenCalledWith(queued.json().jobId);
    expect((await store.getSnapshot()).speakerQueue).toEqual([]);

    const freshReplay = await app.inject(request);
    expect(freshReplay.statusCode).toBe(409);
    expect(freshReplay.json().error.code).toBe("AGENT_TURN_RECONCILIATION_REQUIRED");
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect((await store.getSnapshot()).speakerQueue).toEqual([]);
    await app.close();
  });

  it("accepts a matching durable Agent utterance when enqueue acknowledgement is lost after completion", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const seedParticipant = snapshot.participants[0]!;
    const connector = await store.createModelConnector({
      name: "Completed Agent queue acknowledgement",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "completed-agent-ack"
    });
    const { meeting, participants } = await createPublishedTestMeeting(store, {
      connectorId: connector.id,
      title: "Completed Agent turn acknowledgement",
      mode: "open",
      participants: [{ agentId: seedParticipant.agentId, roleId: seedParticipant.roleId, isChair: true }]
    });
    const participant = participants[0]!;
    const ready = await store.getSnapshot();
    const agent = ready.agents.find((item) => item.id === participant.agentId)!;
    let queuedAgentJob: AgentTurnJobData | undefined;
    const inspectJob = vi.fn(async () => queuedAgentJob ? inspectedAgentJob("completed", queuedAgentJob) : null);
    const enqueue = vi.fn(async (
      job: Parameters<AgentTurnQueue["enqueue"]>[0],
      requestedJobId?: string
    ) => {
      queuedAgentJob = job;
      const committed = await store.commitAgentTurn({
        meetingId: job.meetingId,
        agentId: job.agentId,
        participantId: job.participantId,
        roleRevision: job.roleRevision,
        roleId: job.roleId,
        roleVersion: job.roleVersion,
        turnId: requestedJobId!,
        ...(job.reservationId ? { reservationId: job.reservationId } : {}),
        agendaRevision: job.agendaRevision,
        requestedBy: job.requestedBy,
        speakerName: agent.name,
        roleName: participant.roleSnapshot.name,
        content: "The Agent turn was committed before the enqueue acknowledgement was lost.",
        reservationRequired: true,
        auditDetail: { source: "lost_enqueue_ack_test" }
      });
      expect(committed.status).toBe("created");
      throw new Error("enqueue acknowledgement lost after completed processing");
    });
    const agentQueue = {
      enqueue,
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      inspectJob,
      close: vi.fn(async () => undefined)
    } as AgentTurnQueue;
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${meeting.id}/run`,
      headers: { "idempotency-key": "completed-agent-enqueue" },
      payload: { agentId: participant.agentId }
    });

    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toEqual({ jobId: expect.any(String) });
    expect(inspectJob).toHaveBeenCalledWith(response.json().jobId);
    const durable = await store.getSnapshot();
    expect(durable.utterances.filter((item) => item.turnId === response.json().jobId)).toHaveLength(1);
    expect(durable.speakerQueue).toEqual([]);
    await app.close();
  });

  it("enforces fixed order across participants with pinned published revisions", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const connector = await store.createModelConnector({
      name: "Local",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "meeting-local"
    });
    const { meeting } = await createPublishedTestMeeting(store, {
      connectorId: connector.id,
      title: "固定順序",
      mode: "fixed",
      participants: [
        { agentId: snapshot.agents[0]!.id, roleId: snapshot.roles[0]!.id, isChair: false },
        { agentId: snapshot.agents[1]!.id, roleId: snapshot.roles[1]!.id, isChair: true }
      ]
    });
    await store.addUtterance(meeting.id, {
      agentId: snapshot.agents[0]!.id,
      speakerType: "agent",
      speakerName: snapshot.agents[0]!.name,
      roleName: snapshot.roles[0]!.name,
      content: "第一位完成發言。",
      kind: "inference",
      evidenceCount: 0
    });
    let queuedAgentJob: AgentTurnJobData | undefined;
    const enqueue = vi.fn(async (
      job: Parameters<AgentTurnQueue["enqueue"]>[0],
      requestedJobId?: string
    ) => {
      queuedAgentJob = job;
      return { jobId: requestedJobId! };
    });
    const agentQueue = {
      enqueue,
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      inspectJob: vi.fn(async () => queuedAgentJob ? inspectedAgentJob("waiting", queuedAgentJob) : null),
      close: vi.fn(async () => undefined)
    } as AgentTurnQueue;
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const outOfOrder = await app.inject({
      method: "POST",
      url: `/api/meetings/${meeting.id}/run`,
      headers: { "idempotency-key": "fixed-out-of-order" },
      payload: { agentId: snapshot.agents[0]!.id }
    });
    expect(outOfOrder.statusCode).toBe(409);
    expect(enqueue).not.toHaveBeenCalled();

    const next = await app.inject({
      method: "POST",
      url: `/api/meetings/${meeting.id}/run`,
      headers: { "idempotency-key": "fixed-next-agent" },
      payload: { agentId: snapshot.agents[1]!.id }
    });
    expect(next.statusCode).toBe(202);
    expect(enqueue).toHaveBeenCalledOnce();
    await app.close();
  });

  it("enforces chair moderation while open mode remains unrestricted", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const connector = await store.createModelConnector({
      name: "Local chaired",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "meeting-local"
    });
    const { meeting } = await createPublishedTestMeeting(store, {
      connectorId: connector.id,
      title: "主席主持",
      mode: "chaired",
      participants: [
        { agentId: snapshot.agents[0]!.id, roleId: snapshot.roles[1]!.id, isChair: true },
        { agentId: snapshot.agents[1]!.id, roleId: snapshot.roles[0]!.id, isChair: false }
      ]
    });
    const queuedAgentJobs = new Map<string, AgentTurnJobData>();
    const enqueue = vi.fn(async (
      job: Parameters<AgentTurnQueue["enqueue"]>[0],
      requestedJobId?: string
    ) => {
      queuedAgentJobs.set(requestedJobId!, job);
      return { jobId: requestedJobId! };
    });
    const agentQueue = {
      enqueue,
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      inspectJob: vi.fn(async (jobId: string) => {
        const job = queuedAgentJobs.get(jobId);
        return job ? inspectedAgentJob("waiting", job) : null;
      }),
      close: vi.fn(async () => undefined)
    } as AgentTurnQueue;
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const beforeChair = await app.inject({ method: "POST", url: `/api/meetings/${meeting.id}/run`, headers: { "idempotency-key": "chaired-before-chair" }, payload: { agentId: snapshot.agents[1]!.id } });
    expect(beforeChair.statusCode).toBe(409);
    expect(beforeChair.json().error.code).toBe("CHAIR_ORDER_VIOLATION");

    const chair = await app.inject({ method: "POST", url: `/api/meetings/${meeting.id}/run`, headers: { "idempotency-key": "chaired-chair-turn" }, payload: { agentId: snapshot.agents[0]!.id } });
    expect(chair.statusCode).toBe(202);
    const chairReservation = (await store.getSnapshot()).speakerQueue.find((item) => item.jobId === chair.json().jobId)!;
    await store.releaseSpeakerTurn(chair.json().jobId, "test_completed", chairReservation.reservationId!);
    await store.addUtterance(meeting.id, { agentId: snapshot.agents[0]!.id, speakerType: "agent", speakerName: snapshot.agents[0]!.name, roleName: snapshot.roles[1]!.name, content: "請架構師回應。", kind: "inference", evidenceCount: 0 });

    const invited = await app.inject({ method: "POST", url: `/api/meetings/${meeting.id}/run`, headers: { "idempotency-key": "chaired-invited-turn" }, payload: { agentId: snapshot.agents[1]!.id } });
    expect(invited.statusCode).toBe(202);
    const invitedReservation = (await store.getSnapshot()).speakerQueue.find((item) => item.jobId === invited.json().jobId)!;
    await store.releaseSpeakerTurn(invited.json().jobId, "test_completed", invitedReservation.reservationId!);
    await store.addUtterance(meeting.id, { agentId: snapshot.agents[1]!.id, speakerType: "agent", speakerName: snapshot.agents[1]!.name, roleName: snapshot.roles[0]!.name, content: "提出架構建議。", kind: "inference", evidenceCount: 0 });

    const repeatedDelegate = await app.inject({ method: "POST", url: `/api/meetings/${meeting.id}/run`, headers: { "idempotency-key": "chaired-repeated-delegate" }, payload: { agentId: snapshot.agents[1]!.id } });
    expect(repeatedDelegate.statusCode).toBe(409);

    await store.setMeetingMode(meeting.id, { mode: "open", reason: "驗證自由討論" });
    const open = await app.inject({ method: "POST", url: `/api/meetings/${meeting.id}/run`, headers: { "idempotency-key": "open-delegate-turn" }, payload: { agentId: snapshot.agents[1]!.id } });
    expect(open.statusCode).toBe(202);
    await app.close();
  });

  it("records Chair mode approval and dismissal through persisted actions", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const first = await store.createChairSuggestion(snapshot.meetings[0]!.id, snapshot.utterances.at(-1)!.id, {
      reason: "off_topic",
      suggestedMode: "open",
      explanation: "Allow one open response.",
      score: 0.7
    });
    const app = await createApp({ store, authDisabled: true });

    const approved = await app.inject({
      method: "POST",
      url: `/api/meetings/${snapshot.meetings[0]!.id}/mode`,
      payload: {
        mode: "open",
        reason: "Owner accepted the Chair suggestion.",
        chairSuggestionId: first.suggestion.id
      }
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ mode: "open" });
    expect((await store.getSnapshot()).chairSuggestions).toContainEqual(expect.objectContaining({
      id: first.suggestion.id,
      status: "resolved",
      resolution: "completed",
      transitions: expect.arrayContaining([expect.objectContaining({ type: "mode_accepted" })])
    }));

    const source = await store.addUtterance(snapshot.meetings[0]!.id, {
      speakerType: "human",
      speakerName: "Owner",
      roleName: "決策者",
      content: "Keep the current direction.",
      kind: "human",
      evidenceCount: 0
    });
    const second = await store.createChairSuggestion(snapshot.meetings[0]!.id, source.id, {
      reason: "repetition",
      suggestedMode: "chaired",
      explanation: "Return control to the Chair.",
      score: 0.85
    });
    const dismissed = await app.inject({
      method: "POST",
      url: `/api/meetings/${snapshot.meetings[0]!.id}/chair-suggestions/${second.suggestion.id}/dismiss`
    });
    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json()).toMatchObject({ status: "resolved", resolution: "dismissed" });
    await app.close();
  });

  it("binds a requested Chair intervention to the persisted suggestion and queue job", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const connector = await store.createModelConnector({
      name: "Local Chair",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "meeting-local"
    });
    const chair = snapshot.agents[1]!;
    const { meeting } = await createPublishedTestMeeting(store, {
      connectorId: connector.id,
      title: "Bound Chair intervention",
      mode: "chaired",
      participants: [{ agentId: chair.id, roleId: snapshot.roles[0]!.id, isChair: true }]
    });
    const source = await store.addUtterance(meeting.id, {
      speakerType: "human",
      speakerName: "Owner",
      roleName: "Owner",
      content: "Please restore the agenda.",
      kind: "human",
      evidenceCount: 0
    });
    const suggestion = await store.createChairSuggestion(meeting.id, source.id, {
      reason: "off_topic",
      suggestedMode: "chaired",
      explanation: "Ask the Chair to restore the agenda.",
      score: 0.9,
      suggestedAgentId: chair.id,
      suggestedAgentName: chair.name
    });
    let queuedAgentJob: AgentTurnJobData | undefined;
    const enqueue = vi.fn(async (
      job: Parameters<AgentTurnQueue["enqueue"]>[0],
      requestedJobId?: string
    ) => {
      queuedAgentJob = job;
      return { jobId: requestedJobId! };
    });
    const agentQueue = {
      enqueue,
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      inspectJob: vi.fn(async () => queuedAgentJob ? inspectedAgentJob("waiting", queuedAgentJob) : null),
      close: vi.fn(async () => undefined)
    } as AgentTurnQueue;
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${meeting.id}/run`,
      headers: { "idempotency-key": "bound-chair-intervention" },
      payload: { agentId: chair.id, chairSuggestionId: suggestion.suggestion.id }
    });
    expect(response.statusCode).toBe(202);
    const chairJobId = response.json().jobId as string;
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      agentId: chair.id,
      agendaRevision: meeting.agenda.revision,
      agendaCurrentItemId: meeting.agenda.items.find((item) => item.status === "current")?.id ?? null,
      chairSuggestionId: suggestion.suggestion.id
    }), chairJobId);
    expect((await store.getSnapshot()).chairSuggestions).toContainEqual(expect.objectContaining({
      id: suggestion.suggestion.id,
      status: "pending",
      requestedAgentJobId: chairJobId,
      transitions: expect.arrayContaining([expect.objectContaining({ type: "agent_requested", jobId: chairJobId })])
    }));
    await app.close();
  });

  it("rejects mode changes after a Meeting is closed", async () => {
    const store = new InMemoryPlatformStore();
    const meetingId = (await store.getSnapshot()).meetings[0]!.id;
    await store.setMeetingState(meetingId, "closed");
    const app = await createApp({ store, authDisabled: true });

    const response = await app.inject({ method: "POST", url: `/api/meetings/${meetingId}/mode`, payload: { mode: "open", reason: "too late" } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("MEETING_CLOSED");
    await app.close();
  });

  it("returns a conflict when BullMQ deduplicates a meeting action", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const connector = await store.createModelConnector({
      name: "Local",
      location: "local",
      baseUrl: "http://10.20.30.40/v1",
      model: "meeting-local"
    });
    const { meeting } = await createPublishedTestMeeting(store, {
      connectorId: connector.id,
      title: "Queue deduplication",
      mode: "open",
      participants: [{ agentId: snapshot.agents[0]!.id, roleId: snapshot.roles[0]!.id, isChair: true }]
    });
    const meetingId = meeting.id;
    const agentQueue = {
      enqueue: vi.fn(async () => {
        throw Object.assign(new Error("Meeting already has a queued or active action."), { statusCode: 409 });
      }),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      inspectJob: vi.fn(async () => null),
      close: vi.fn(async () => undefined)
    } as AgentTurnQueue;
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/run`,
      headers: { "idempotency-key": "deduplicated-meeting-action" },
      payload: { agentId: snapshot.agents[0]!.id }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: "REQUEST_FAILED" });
    await app.close();
  });

  it("rejects a hasJob-only MCP queue before durable admission", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const connector = await store.createMcpConnector({
      name: "hasJob-only MCP",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"]
    });
    const { meeting } = await createToolGrantedTestMeeting(store, {
      agentId: snapshot.agents[0]!.id,
      mcpConnectorId: connector.id,
      title: "hasJob-only reconciliation"
    });
    const enqueueToolCall = vi.fn(async (
      _job: Parameters<AgentTurnQueue["enqueueToolCall"]>[0],
      requestedJobId?: string
    ) => ({ jobId: requestedJobId! }));
    const app = await createApp({
      store,
      authDisabled: true,
      agentQueue: {
        enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
        enqueueToolCall,
        enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
        hasJob: vi.fn(async () => true),
        close: vi.fn(async () => undefined)
      } as AgentTurnQueue
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${meeting.id}/tools/run`,
      headers: { "idempotency-key": "has-job-only-race" },
      payload: {
        agentId: snapshot.agents[0]!.id,
        connectorId: connector.id,
        toolName: "search",
        arguments: { query: "policy" }
      }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("MCP_QUEUE_INSPECTION_UNAVAILABLE");
    expect(enqueueToolCall).not.toHaveBeenCalled();
    expect((await store.getSnapshot()).speakerQueue).toEqual([]);
    await app.close();
  });

  it("rejects an MCP queue without exact envelope inspection before durable admission", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const connector = await store.createMcpConnector({
      name: "State-only MCP",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"]
    });
    const { meeting } = await createToolGrantedTestMeeting(store, {
      agentId: snapshot.agents[0]!.id,
      mcpConnectorId: connector.id,
      title: "State-only queue rejection"
    });
    const enqueueToolCall = vi.fn(async (
      _job: Parameters<AgentTurnQueue["enqueueToolCall"]>[0],
      requestedJobId?: string
    ) => ({ jobId: requestedJobId! }));
    const app = await createApp({
      store,
      authDisabled: true,
      agentQueue: {
        enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
        enqueueToolCall,
        enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
        getJobState: vi.fn(async () => null),
        close: vi.fn(async () => undefined)
      } as AgentTurnQueue
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${meeting.id}/tools/run`,
      headers: { "idempotency-key": "state-only-queue" },
      payload: {
        agentId: snapshot.agents[0]!.id,
        connectorId: connector.id,
        toolName: "search",
        arguments: { query: "policy" }
      }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("MCP_QUEUE_INSPECTION_UNAVAILABLE");
    expect(enqueueToolCall).not.toHaveBeenCalled();
    expect((await store.getSnapshot()).speakerQueue).toEqual([]);
    await app.close();
  });

  it("fails closed when exact MCP queue inspection does not return before its deadline", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const connector = await store.createMcpConnector({
      name: "Stalled inspection MCP",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"]
    });
    const { meeting } = await createToolGrantedTestMeeting(store, {
      agentId: snapshot.agents[0]!.id,
      mcpConnectorId: connector.id,
      title: "Stalled queue inspection"
    });
    const getConnectorSecret = vi.spyOn(store, "getConnectorSecret");
    const enqueueToolCall = vi.fn(async (
      _job: Parameters<AgentTurnQueue["enqueueToolCall"]>[0],
      requestedJobId?: string
    ) => ({ jobId: requestedJobId! }));
    const inspectJob = vi.fn(() => new Promise<never>(() => undefined));
    const app = await createApp({
      store,
      authDisabled: true,
      mcpQueueInspectionTimeoutMs: 5,
      agentQueue: {
        enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
        enqueueToolCall,
        enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
        inspectJob,
        close: vi.fn(async () => undefined)
      } as AgentTurnQueue
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${meeting.id}/tools/run`,
      headers: { "idempotency-key": "stalled-queue-inspection" },
      payload: {
        agentId: snapshot.agents[0]!.id,
        connectorId: connector.id,
        toolName: "search",
        arguments: { query: "policy" }
      }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("QUEUE_STATE_UNAVAILABLE");
    expect(inspectJob).toHaveBeenCalledOnce();
    expect(getConnectorSecret).not.toHaveBeenCalled();
    expect(enqueueToolCall).not.toHaveBeenCalled();
    expect((await store.getSnapshot()).speakerQueue).toEqual([]);
    await app.close();
  });

  it("does not return 202 when post-admission inspection finds a different MCP envelope", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const connector = await store.createMcpConnector({
      name: "MCP envelope race",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"]
    });
    const { meeting } = await createToolGrantedTestMeeting(store, {
      agentId: snapshot.agents[0]!.id,
      mcpConnectorId: connector.id,
      title: "MCP envelope race"
    });
    let queuedJob: Parameters<AgentTurnQueue["enqueueToolCall"]>[0] | undefined;
    let inspectionCount = 0;
    const enqueueToolCall = vi.fn(async (
      job: Parameters<AgentTurnQueue["enqueueToolCall"]>[0],
      requestedJobId?: string
    ) => {
      queuedJob = job;
      return { jobId: requestedJobId! };
    });
    const inspectJob = vi.fn(async () => {
      inspectionCount += 1;
      if (inspectionCount === 1) return null;
      return {
        state: "waiting",
        data: {
          contractVersion: 1,
          name: "mcp-tool-call",
          data: { ...queuedJob, requestedBy: "system" }
        }
      };
    });
    const app = await createApp({
      store,
      authDisabled: true,
      agentQueue: {
        enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
        enqueueToolCall,
        enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
        inspectJob,
        close: vi.fn(async () => undefined)
      } as AgentTurnQueue
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${meeting.id}/tools/run`,
      headers: { "idempotency-key": "mcp-envelope-race" },
      payload: {
        agentId: snapshot.agents[0]!.id,
        connectorId: connector.id,
        toolName: "search",
        arguments: { query: "policy" }
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("MCP_RECONCILIATION_REQUIRED");
    expect(enqueueToolCall).toHaveBeenCalledOnce();
    expect((await store.getSnapshot()).speakerQueue).toContainEqual(expect.objectContaining({
      jobId: expect.any(String),
      kind: "mcp_tool_call",
      status: "queued"
    }));
    await app.close();
  });

  it("queues an approved MCP call and a summary background job", async () => {
    const store = new InMemoryPlatformStore();
    const secretVault = new SecretVault(Buffer.alloc(32, 18));
    const snapshot = await store.getSnapshot();
    const connector = await store.createMcpConnector({
      name: "Docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"]
    });
    const { meeting } = await createToolGrantedTestMeeting(store, {
      agentId: snapshot.agents[0]!.id,
      mcpConnectorId: connector.id,
      title: "Approved MCP queue Meeting"
    });
    const meetingId = meeting.id;
    const queueJobs = new Map<string, { state: string; job: McpToolCallJobData }>();
    const enqueueToolCall = vi.fn(async (
      job: Parameters<AgentTurnQueue["enqueueToolCall"]>[0],
      requestedJobId?: string
    ) => {
      expect((await store.getSnapshot()).speakerQueue).toEqual([
        expect.objectContaining({
          jobId: requestedJobId,
          participantId: job.participantId,
          agentId: job.agentId,
          requestFingerprint: expect.stringMatching(/^hmac-sha256:v1:[a-f0-9]{64}$/),
          status: "queued"
        })
      ]);
      expect(job.arguments).toBeUndefined();
      expect(job.argumentEncoding).toBe("vault_v1");
      expect(job.argumentsCiphertext).toEqual(expect.any(String));
      expect(JSON.stringify(job)).not.toContain("policy");
      expect(decryptMcpToolArguments(secretVault, requestedJobId!, job.argumentsCiphertext!)).toEqual({ query: "policy" });
      queueJobs.set(requestedJobId!, { state: "waiting", job });
      return { jobId: requestedJobId ?? "unexpected-tool-job" };
    });
    const enqueueMeetingSummary = vi.fn(async (
      _job: Parameters<AgentTurnQueue["enqueueMeetingSummary"]>[0],
      requestedJobId?: string
    ) => ({ jobId: requestedJobId! }));
    const agentQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall,
      enqueueMeetingSummary,
      inspectJob: vi.fn(async (jobId: string) => {
        const queued = queueJobs.get(jobId);
        return queued ? inspectedMcpJob(queued.state, queued.job) : null;
      }),
      close: vi.fn(async () => undefined)
    } as AgentTurnQueue;
    const app = await createApp({
      store,
      authDisabled: true,
      agentQueue,
      secretVault,
      mcpArgumentEncryptionWriteEnabled: true,
      mcpKeyedFingerprintWriteEnabled: true
    });

    const missingKey = await app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/tools/run`,
      payload: {
        agentId: snapshot.agents[0]!.id,
        connectorId: connector.id,
        toolName: "search",
        arguments: { query: "policy" }
      }
    });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json().error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(enqueueToolCall).not.toHaveBeenCalled();

    const oversizedArguments = await app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/tools/run`,
      headers: { "idempotency-key": "tool-oversized-arguments" },
      payload: {
        agentId: snapshot.agents[0]!.id,
        connectorId: connector.id,
        toolName: "search",
        arguments: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`field_${index}`, index]))
      }
    });
    expect(oversizedArguments.statusCode).toBe(400);
    expect(oversizedArguments.json().error.code).toBe("VALIDATION_ERROR");
    expect(enqueueToolCall).not.toHaveBeenCalled();

    const tool = await app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/tools/run`,
      headers: { "idempotency-key": "tool-submit-1" },
      payload: {
        agentId: snapshot.agents[0]!.id,
        connectorId: connector.id,
        toolName: "search",
        arguments: { query: "policy" }
      }
    });
    expect(tool.statusCode).toBe(202);
    const retry = await app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/tools/run`,
      headers: { "idempotency-key": "tool-submit-1" },
      payload: {
        agentId: snapshot.agents[0]!.id,
        connectorId: connector.id,
        toolName: "search",
        arguments: { query: "policy" }
      }
    });
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toEqual(tool.json());
    expect(enqueueToolCall).toHaveBeenCalledOnce();
    expect(enqueueToolCall.mock.calls[0]?.[0]).toMatchObject({
      toolSnapshot: { connectorName: "Docs", toolName: "search", displayName: "search" }
    });
    expect(enqueueToolCall.mock.calls[0]?.[1]).toMatch(/-tool-[a-f0-9]{40}$/);

    queueJobs.get(tool.json().jobId)!.state = "failed";
    const failedRetry = await app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/tools/run`,
      headers: { "idempotency-key": "tool-submit-1" },
      payload: {
        agentId: snapshot.agents[0]!.id,
        connectorId: connector.id,
        toolName: "search",
        arguments: { query: "policy" }
      }
    });
    expect(failedRetry.statusCode).toBe(409);
    expect(failedRetry.json().error.code).toBe("MCP_RECONCILIATION_REQUIRED");
    expect(enqueueToolCall).toHaveBeenCalledOnce();

    const changedPendingRequest = await app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/tools/run`,
      headers: { "idempotency-key": "tool-submit-1" },
      payload: {
        agentId: snapshot.agents[0]!.id,
        connectorId: connector.id,
        toolName: "search",
        arguments: { query: "different policy" }
      }
    });
    expect(changedPendingRequest.statusCode).toBe(409);
    expect(changedPendingRequest.json().error.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(enqueueToolCall).toHaveBeenCalledOnce();

    const close = await app.inject({ method: "POST", url: `/api/meetings/${meetingId}/close` });
    expect(close.statusCode).toBe(200);
    expect(enqueueMeetingSummary).toHaveBeenCalledWith(
      { meetingId, requestedBy: "system" },
      expect.stringMatching(new RegExp(`^${meetingId}-summary-`))
    );
    await app.close();
  });

  it("keeps an accepted MCP call successful when its post-enqueue audit fails", async () => {
    const store = new FailingMcpQueuedAuditStore();
    const snapshot = await store.getSnapshot();
    const connector = await store.createMcpConnector({
      name: "Audit failure docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"]
    });
    const { meeting } = await createToolGrantedTestMeeting(store, {
      agentId: snapshot.agents[0]!.id,
      mcpConnectorId: connector.id,
      title: "Accepted MCP audit failure"
    });
    let queuedJob: McpToolCallJobData | undefined;
    const enqueueToolCall = vi.fn(async (
      job: Parameters<AgentTurnQueue["enqueueToolCall"]>[0],
      requestedJobId?: string
    ) => {
      queuedJob = job;
      return { jobId: requestedJobId! };
    });
    const app = await createApp({
      store,
      authDisabled: true,
      agentQueue: {
        enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
        enqueueToolCall,
        enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
        inspectJob: vi.fn(async () => queuedJob ? inspectedMcpJob("waiting", queuedJob) : null),
        close: vi.fn(async () => undefined)
      }
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${meeting.id}/tools/run`,
      headers: { "idempotency-key": "accepted-mcp-audit-failure" },
      payload: {
        agentId: snapshot.agents[0]!.id,
        connectorId: connector.id,
        toolName: "search",
        arguments: { query: "audit contract" }
      }
    });

    expect(response.statusCode).toBe(202);
    expect(enqueueToolCall).toHaveBeenCalledOnce();
    expect((await store.getSnapshot()).speakerQueue).toContainEqual(expect.objectContaining({
      jobId: response.json().jobId,
      kind: "mcp_tool_call",
      status: "queued"
    }));
    await app.close();
  });

  it("returns a persisted Tool Run on an uncertain retry and rejects key reuse with changed arguments", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const connector = await store.createMcpConnector({
      name: "Retry Docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"]
    });
    const agentId = snapshot.agents[0]!.id;
    const { meeting, participant } = await createToolGrantedTestMeeting(store, {
      agentId,
      mcpConnectorId: connector.id,
      title: "Persisted MCP retry Meeting"
    });
    const meetingId = meeting.id;
    const idempotencyKey = "uncertain-tool-submit";
    const jobId = mcpToolJobId(meetingId, idempotencyKey);
    const action = {
      meetingId,
      agentId,
      participantId: participant.id,
      roleRevision: participant.roleRevision,
      roleId: participant.roleId,
      roleVersion: participant.roleSnapshot.version,
      connectorId: connector.id,
      toolName: "search",
      arguments: { query: "policy" }
    };
    await store.commitMcpToolRun({
      jobId,
      requestFingerprint: requestFingerprint(action),
      ...action,
      toolSnapshot: { connectorName: connector.name, ...connector.toolRegistrations[0]! },
      status: "succeeded",
      content: "{\"documents\":1}"
    });
    const enqueueToolCall = vi.fn(async () => ({ jobId: "unexpected-tool-job" }));
    const agentQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall,
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      close: vi.fn(async () => undefined)
    } as AgentTurnQueue;
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const replay = await app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/tools/run`,
      headers: { "idempotency-key": idempotencyKey },
      payload: { agentId: action.agentId, connectorId: action.connectorId, toolName: action.toolName, arguments: action.arguments }
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ jobId, replayed: true, status: "succeeded" });

    const conflict = await app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/tools/run`,
      headers: { "idempotency-key": idempotencyKey },
      payload: { agentId: action.agentId, connectorId: action.connectorId, toolName: action.toolName, arguments: { query: "changed" } }
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(enqueueToolCall).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects tool authorization and a new MCP call for a disabled Agent before admission or enqueue", async () => {
    const seed = createSeedSnapshot();
    const connectorId = "d0000000-0000-4000-8000-000000000031";
    seed.mcpConnectors.push({
      id: connectorId,
      revision: 1,
      name: "Disabled Agent Docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"],
      toolRegistrations: [{ toolName: "search", displayName: "搜尋", kind: "mcp_tool", version: "1.0.0", owner: "Platform Owner", goal: "搜尋政策。" }],
      enabled: true,
      hasSecret: false
    });
    seed.agents[0]!.toolGrants = [{ connectorId, toolName: "search" }];
    const store = new InMemoryPlatformStore(seed);
    const agentId = seed.agents[0]!.id;
    await store.setAgentStatus(agentId, { status: "disabled", expectedRevision: 1 });
    const enqueueToolCall = vi.fn(async () => ({ jobId: "unexpected-tool-job" }));
    const app = await createApp({
      store,
      authDisabled: true,
      agentQueue: {
        enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
        enqueueToolCall,
        enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
        inspectJob: vi.fn(async () => null),
        close: vi.fn(async () => undefined)
      }
    });

    const authorization = await app.inject({
      method: "POST",
      url: "/api/tools/authorize",
      payload: { agentId, connectorId, toolName: "search", effect: "read" }
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${seed.meetings[0]!.id}/tools/run`,
      headers: { "idempotency-key": "disabled-agent-tool-call" },
      payload: { agentId, connectorId, toolName: "search", arguments: { query: "policy" } }
    });

    expect(authorization.statusCode).toBe(403);
    expect(authorization.json().error.code).toBe("TOOL_DENIED");
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("AGENT_DISABLED");
    expect(enqueueToolCall).not.toHaveBeenCalled();
    expect((await store.getSnapshot()).speakerQueue).toEqual([]);
    await app.close();
  });

  it("does not let an unpublished Agent draft grant authorize a tool or an existing Meeting", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const connector = await store.createMcpConnector({
      name: "Unpublished Grant Docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"]
    });
    const agentId = snapshot.agents[0]!.id;
    await store.updateAgent(agentId, { toolGrants: [{ connectorId: connector.id, toolName: "search" }] });
    const enqueueToolCall = vi.fn(async () => ({ jobId: "unexpected-tool-job" }));
    const app = await createApp({
      store,
      authDisabled: true,
      agentQueue: {
        enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
        enqueueToolCall,
        enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
        inspectJob: vi.fn(async () => null),
        close: vi.fn(async () => undefined)
      }
    });

    const authorization = await app.inject({
      method: "POST",
      url: "/api/tools/authorize",
      payload: { agentId, connectorId: connector.id, toolName: "search", effect: "read" }
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${snapshot.meetings[0]!.id}/tools/run`,
      headers: { "idempotency-key": "unpublished-grant-tool-call" },
      payload: { agentId, connectorId: connector.id, toolName: "search", arguments: { query: "policy" } }
    });

    expect(authorization.statusCode).toBe(403);
    expect(authorization.json().error.code).toBe("TOOL_DENIED");
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("TOOL_DENIED");
    expect(enqueueToolCall).not.toHaveBeenCalled();
    expect((await store.getSnapshot()).speakerQueue).toEqual([]);
    await app.close();
  });

  it("atomically returns a Tool Run committed after the route snapshot without creating a second reservation", async () => {
    const store = new InMemoryPlatformStore();
    const initial = await store.getSnapshot();
    const connector = await store.createMcpConnector({
      name: "Atomic Docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"]
    });
    const agentId = initial.agents[0]!.id;
    const { meeting, participant } = await createToolGrantedTestMeeting(store, {
      agentId,
      mcpConnectorId: connector.id,
      title: "Atomic MCP commit Meeting"
    });
    const meetingId = meeting.id;
    const idempotencyKey = "atomic-commit-race";
    const jobId = mcpToolJobId(meetingId, idempotencyKey);
    const action = {
      meetingId,
      agentId,
      participantId: participant.id,
      roleRevision: participant.roleRevision,
      roleId: participant.roleId,
      roleVersion: participant.roleSnapshot.version,
      connectorId: connector.id,
      toolName: "search",
      arguments: { query: "policy" }
    };
    const readSecret = vi.spyOn(store, "getConnectorSecret").mockImplementationOnce(async () => {
      await store.commitMcpToolRun({
        ...action,
        jobId,
        requestFingerprint: requestFingerprint(action),
        toolSnapshot: { connectorName: connector.name, ...connector.toolRegistrations[0]! },
        status: "succeeded",
        content: "{\"documents\":1}"
      });
      return null;
    });
    const enqueueToolCall = vi.fn(async () => ({ jobId }));
    const inspectJob = vi.fn(async () => null);
    const app = await createApp({
      store,
      authDisabled: true,
      agentQueue: {
        enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
        enqueueToolCall,
        enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
        inspectJob,
        close: vi.fn(async () => undefined)
      }
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/tools/run`,
      headers: { "idempotency-key": idempotencyKey },
      payload: { agentId, connectorId: connector.id, toolName: "search", arguments: action.arguments }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ jobId, replayed: true, status: "succeeded" });
    expect(enqueueToolCall).not.toHaveBeenCalled();
    expect((await store.getSnapshot()).speakerQueue).toEqual([]);
    readSecret.mockRestore();
    await app.close();
  });

  it("replays a Tool Run committed after a stale snapshot observed its reservation", async () => {
    const store = new InMemoryPlatformStore();
    const initial = await store.getSnapshot();
    const connector = await store.createMcpConnector({
      name: "Reservation Completion Race Docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"]
    });
    const agentId = initial.agents[0]!.id;
    const { meeting, participant } = await createToolGrantedTestMeeting(store, {
      agentId,
      mcpConnectorId: connector.id,
      title: "Reservation completion race Meeting"
    });
    const meetingId = meeting.id;
    const idempotencyKey = "reservation-completion-race";
    const jobId = mcpToolJobId(meetingId, idempotencyKey);
    const action = {
      meetingId,
      agentId,
      participantId: participant.id,
      roleRevision: participant.roleRevision,
      roleId: participant.roleId,
      roleVersion: participant.roleSnapshot.version,
      connectorId: connector.id,
      toolName: "search",
      arguments: { query: "policy" }
    };
    const toolSnapshot = { connectorName: connector.name, ...connector.toolRegistrations[0]! };
    const connectorFingerprint = mcpConnectorExecutionFingerprint(connector, null);
    const fingerprint = requestFingerprint(action);
    await store.reserveMcpToolCall(jobId, {
      ...action,
      toolSnapshot,
      connectorFingerprint,
      requestFingerprint: fingerprint
    });
    const inspectJob = vi.fn(async () => {
      await store.commitMcpToolRun({
        ...action,
        jobId,
        requestFingerprint: fingerprint,
        toolSnapshot,
        connectorFingerprint,
        status: "succeeded",
        content: "{\"documents\":1}",
        reservationRequired: true
      });
      return null;
    });
    const enqueueToolCall = vi.fn(async () => ({ jobId }));
    const app = await createApp({
      store,
      authDisabled: true,
      agentQueue: {
        enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
        enqueueToolCall,
        enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
        inspectJob,
        close: vi.fn(async () => undefined)
      }
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/tools/run`,
      headers: { "idempotency-key": idempotencyKey },
      payload: { agentId, connectorId: connector.id, toolName: "search", arguments: action.arguments }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ jobId, replayed: true, status: "succeeded" });
    expect(enqueueToolCall).not.toHaveBeenCalled();
    expect((await store.getSnapshot()).speakerQueue).toEqual([]);
    await app.close();
  });

  it("lets atomic admission resolve a queue-state race for two identical MCP requests", async () => {
    const store = new InMemoryPlatformStore();
    const initial = await store.getSnapshot();
    const connector = await store.createMcpConnector({
      name: "Concurrent Atomic Docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"]
    });
    const agentId = initial.agents[0]!.id;
    const { meeting } = await createToolGrantedTestMeeting(store, {
      agentId,
      mcpConnectorId: connector.id,
      title: "Concurrent MCP admission Meeting"
    });
    let releaseStaleRequest!: () => void;
    let staleRequestReady!: () => void;
    const staleRequestGate = new Promise<void>((resolve) => { releaseStaleRequest = resolve; });
    const staleRequestAtSecret = new Promise<void>((resolve) => { staleRequestReady = resolve; });
    vi.spyOn(store, "getConnectorSecret")
      .mockImplementationOnce(async () => {
        staleRequestReady();
        await staleRequestGate;
        return null;
      })
      .mockResolvedValue(null);
    const queueJobs = new Map<string, { state: string; job: McpToolCallJobData }>();
    const enqueueToolCall = vi.fn(async (
      job: Parameters<AgentTurnQueue["enqueueToolCall"]>[0],
      requestedJobId?: string
    ) => {
      queueJobs.set(requestedJobId!, { state: "waiting", job });
      return { jobId: requestedJobId! };
    });
    const app = await createApp({
      store,
      authDisabled: true,
      agentQueue: {
        enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
        enqueueToolCall,
        enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
        inspectJob: vi.fn(async (jobId: string) => {
          const queued = queueJobs.get(jobId);
          return queued ? inspectedMcpJob(queued.state, queued.job) : null;
        }),
        close: vi.fn(async () => undefined)
      }
    });
    const request = {
      method: "POST" as const,
      url: `/api/meetings/${meeting.id}/tools/run`,
      headers: { "idempotency-key": "concurrent-atomic-tool" },
      payload: { agentId, connectorId: connector.id, toolName: "search", arguments: { query: "policy" } }
    };

    const staleRequest = app.inject(request);
    await staleRequestAtSecret;
    const winner = await app.inject(request);
    expect(winner.statusCode).toBe(202);
    releaseStaleRequest();
    const replay = await staleRequest;

    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(winner.json());
    expect(enqueueToolCall).toHaveBeenCalledOnce();
    expect((await store.getSnapshot()).speakerQueue).toHaveLength(1);
    await app.close();
  });

  it("returns a fast durable MCP result when BullMQ removes the completed job before inspection", async () => {
    const store = new InMemoryPlatformStore();
    const initial = await store.getSnapshot();
    const connector = await store.createMcpConnector({
      name: "Fast completion MCP",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"]
    });
    const agentId = initial.agents[0]!.id;
    const { meeting } = await createToolGrantedTestMeeting(store, {
      agentId,
      mcpConnectorId: connector.id,
      title: "Fast MCP completion"
    });
    const idempotencyKey = "fast-completed-tool-run";
    const jobId = mcpToolJobId(meeting.id, idempotencyKey);
    const inspectJob = vi.fn(async () => null);
    const enqueueToolCall = vi.fn(async (
      job: Parameters<AgentTurnQueue["enqueueToolCall"]>[0],
      requestedJobId?: string
    ) => {
      if (requestedJobId !== jobId) throw new Error("The MCP test fixture requires its canonical job ID.");
      const reservation = (await store.getSnapshot()).speakerQueue.find((item) => item.jobId === requestedJobId);
      if (!reservation?.requestFingerprint) throw new Error("The MCP test fixture requires a durable request fingerprint.");
      await store.commitMcpToolRun({
        jobId: requestedJobId,
        requestFingerprint: reservation.requestFingerprint,
        meetingId: job.meetingId,
        agentId: job.agentId,
        participantId: job.participantId,
        roleRevision: job.roleRevision,
        roleId: job.roleId,
        roleVersion: job.roleVersion,
        connectorId: job.connectorId,
        toolName: job.toolName,
        toolSnapshot: job.toolSnapshot,
        connectorFingerprint: job.connectorFingerprint,
        status: "succeeded",
        content: "{\"documents\":1}",
        reservationRequired: true
      });
      return { jobId: requestedJobId };
    });
    const app = await createApp({
      store,
      authDisabled: true,
      agentQueue: {
        enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
        enqueueToolCall,
        enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
        inspectJob,
        close: vi.fn(async () => undefined)
      }
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${meeting.id}/tools/run`,
      headers: { "idempotency-key": idempotencyKey },
      payload: { agentId, connectorId: connector.id, toolName: "search", arguments: { query: "policy" } }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ jobId, replayed: true, status: "succeeded" });
    expect(enqueueToolCall).toHaveBeenCalledOnce();
    expect(inspectJob).toHaveBeenCalledTimes(2);
    expect((await store.getSnapshot()).speakerQueue).toEqual([]);
    await app.close();
  });

  it.each(["succeeded", "failed"] as const)(
    "returns a matching durable %s Tool Run when enqueue acknowledgement is lost in a terminal queue state",
    async (status) => {
      const store = new InMemoryPlatformStore();
      const initial = await store.getSnapshot();
      const connector = await store.createMcpConnector({
        name: `Terminal ${status} Tool Run Docs`,
        location: "local",
        baseUrl: "http://10.20.30.40/mcp",
        approvedTools: ["search"]
      });
      const agentId = initial.agents[0]!.id;
      const { meeting } = await createToolGrantedTestMeeting(store, {
        agentId,
        mcpConnectorId: connector.id,
        title: `Terminal ${status} Tool Run Meeting`
      });
      const idempotencyKey = `terminal-${status}-tool-run`;
      const jobId = mcpToolJobId(meeting.id, idempotencyKey);
      let queuedJob: McpToolCallJobData | undefined;
      const inspectJob = vi.fn(async () => queuedJob
        ? inspectedMcpJob(status === "succeeded" ? "completed" : "failed", queuedJob)
        : null);
      const enqueueToolCall = vi.fn(async (
        job: Parameters<AgentTurnQueue["enqueueToolCall"]>[0],
        requestedJobId?: string
      ) => {
        if (!requestedJobId) throw new Error("The MCP test fixture requires a canonical job ID.");
        queuedJob = job;
        const reservation = (await store.getSnapshot()).speakerQueue.find((item) => item.jobId === requestedJobId);
        if (!reservation?.requestFingerprint) throw new Error("The MCP test fixture requires a durable request fingerprint.");
        const committed = await store.commitMcpToolRun({
          jobId: requestedJobId,
          requestFingerprint: reservation.requestFingerprint,
          meetingId: job.meetingId,
          agentId: job.agentId,
          participantId: job.participantId,
          roleRevision: job.roleRevision,
          roleId: job.roleId,
          roleVersion: job.roleVersion,
          connectorId: job.connectorId,
          toolName: job.toolName,
          toolSnapshot: job.toolSnapshot,
          connectorFingerprint: job.connectorFingerprint,
          status,
          content: status === "succeeded" ? "{\"documents\":1}" : "Tool execution failed.",
          reservationRequired: true
        });
        expect(committed.status).toBe("created");
        throw new Error("enqueue acknowledgement lost after terminal Tool Run commit");
      });
      const app = await createApp({
        store,
        authDisabled: true,
        agentQueue: {
          enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
          enqueueToolCall,
          enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
          inspectJob,
          close: vi.fn(async () => undefined)
        }
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/meetings/${meeting.id}/tools/run`,
        headers: { "idempotency-key": idempotencyKey },
        payload: { agentId, connectorId: connector.id, toolName: "search", arguments: { query: "policy" } }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ jobId, replayed: true, status });
      expect(enqueueToolCall).toHaveBeenCalledOnce();
      expect(inspectJob).toHaveBeenCalledTimes(2);
      expect((await store.getSnapshot()).speakerQueue).toEqual([]);
      await app.close();
    }
  );

  it("keeps reconciliation required for a matching nonterminal Tool Run with terminal queue state", async () => {
    const store = new InMemoryPlatformStore();
    const initial = await store.getSnapshot();
    const connector = await store.createMcpConnector({
      name: "Nonterminal Tool Run Docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"]
    });
    const agentId = initial.agents[0]!.id;
    const { meeting } = await createToolGrantedTestMeeting(store, {
      agentId,
      mcpConnectorId: connector.id,
      title: "Nonterminal Tool Run Meeting"
    });
    const idempotencyKey = "nonterminal-tool-run";
    const jobId = mcpToolJobId(meeting.id, idempotencyKey);
    const originalGetSnapshot = store.getSnapshot.bind(store);
    let exposeNonterminalRun = false;
    const snapshotSpy = vi.spyOn(store, "getSnapshot").mockImplementation(async () => {
      const current = await originalGetSnapshot();
      if (exposeNonterminalRun) {
        const run = current.toolRuns.find((item) => item.jobId === jobId);
        if (run) (run as unknown as { status: string }).status = "running";
      }
      return current;
    });
    let queuedJob: McpToolCallJobData | undefined;
    const inspectJob = vi.fn(async () => queuedJob
      ? inspectedMcpJob("completed", queuedJob)
      : null);
    const enqueueToolCall = vi.fn(async (
      job: Parameters<AgentTurnQueue["enqueueToolCall"]>[0],
      requestedJobId?: string
    ) => {
      if (!requestedJobId) throw new Error("The MCP test fixture requires a canonical job ID.");
      queuedJob = job;
      const reservation = (await originalGetSnapshot()).speakerQueue.find((item) => item.jobId === requestedJobId);
      if (!reservation?.requestFingerprint) throw new Error("The MCP test fixture requires a durable request fingerprint.");
      const committed = await store.commitMcpToolRun({
        jobId: requestedJobId,
        requestFingerprint: reservation.requestFingerprint,
        meetingId: job.meetingId,
        agentId: job.agentId,
        participantId: job.participantId,
        roleRevision: job.roleRevision,
        roleId: job.roleId,
        roleVersion: job.roleVersion,
        connectorId: job.connectorId,
        toolName: job.toolName,
        toolSnapshot: job.toolSnapshot,
        connectorFingerprint: job.connectorFingerprint,
        status: "succeeded",
        content: "{\"documents\":1}",
        reservationRequired: true
      });
      expect(committed.status).toBe("created");
      exposeNonterminalRun = true;
      throw new Error("enqueue acknowledgement lost after Tool Run commit");
    });
    const app = await createApp({
      store,
      authDisabled: true,
      agentQueue: {
        enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
        enqueueToolCall,
        enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
        inspectJob,
        close: vi.fn(async () => undefined)
      }
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${meeting.id}/tools/run`,
      headers: { "idempotency-key": idempotencyKey },
      payload: { agentId, connectorId: connector.id, toolName: "search", arguments: { query: "policy" } }
    });
    exposeNonterminalRun = false;
    snapshotSpy.mockRestore();

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("MCP_RECONCILIATION_REQUIRED");
    expect(enqueueToolCall).toHaveBeenCalledOnce();
    expect(inspectJob).toHaveBeenCalledTimes(2);
    expect((await store.getSnapshot()).toolRuns).toEqual([
      expect.objectContaining({ jobId, status: "succeeded" })
    ]);
    await app.close();
  });

  it("preserves the durable replay fence for a terminal BullMQ job after an ambiguous MCP enqueue error", async () => {
    const store = new FailingMcpReconciliationAuditStore();
    const initial = await store.getSnapshot();
    const connector = await store.createMcpConnector({
      name: "Terminal Queue Docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"]
    });
    const agentId = initial.agents[0]!.id;
    const { meeting } = await createToolGrantedTestMeeting(store, {
      agentId,
      mcpConnectorId: connector.id,
      title: "Terminal MCP queue Meeting"
    });
    let queuedJob: McpToolCallJobData | undefined;
    const inspectJob = vi.fn(async () => queuedJob ? inspectedMcpJob("failed", queuedJob) : null);
    const enqueueToolCall = vi.fn(async (job: McpToolCallJobData) => {
      queuedJob = job;
      throw new Error("Redis acknowledgement timed out.");
    });
    const app = await createApp({
      store,
      authDisabled: true,
      agentQueue: {
        enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
        enqueueToolCall,
        enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
        inspectJob,
        close: vi.fn(async () => undefined)
      }
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${meeting.id}/tools/run`,
      headers: { "idempotency-key": "terminal-enqueue-state" },
      payload: { agentId, connectorId: connector.id, toolName: "search", arguments: {} }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("MCP_RECONCILIATION_REQUIRED");
    expect(enqueueToolCall).toHaveBeenCalledOnce();
    expect(inspectJob).toHaveBeenCalledTimes(2);
    expect((await store.getSnapshot()).speakerQueue).toEqual([
      expect.objectContaining({ kind: "mcp_tool_call", status: "queued" })
    ]);
    await app.close();
  });

  it("keeps the legacy fingerprint writer until its independent rollout gate is enabled", async () => {
    const store = new InMemoryPlatformStore();
    const initial = await store.getSnapshot();
    const connector = await store.createMcpConnector({
      name: "Legacy Fingerprint Docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"]
    });
    const agentId = initial.agents[0]!.id;
    const { meeting } = await createToolGrantedTestMeeting(store, {
      agentId,
      mcpConnectorId: connector.id,
      title: "Legacy MCP fingerprint Meeting"
    });
    let queuedJob: McpToolCallJobData | undefined;
    const enqueueToolCall = vi.fn(async (
      job: Parameters<AgentTurnQueue["enqueueToolCall"]>[0],
      requestedJobId?: string
    ) => {
      queuedJob = job;
      return { jobId: requestedJobId! };
    });
    const app = await createApp({
      store,
      authDisabled: true,
      secretVault: new SecretVault(Buffer.alloc(32, 24)),
      agentQueue: {
        enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
        enqueueToolCall,
        enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
        inspectJob: vi.fn(async () => queuedJob ? inspectedMcpJob("waiting", queuedJob) : null),
        close: vi.fn(async () => undefined)
      }
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${meeting.id}/tools/run`,
      headers: { "idempotency-key": "legacy-fingerprint-stage" },
      payload: { agentId, connectorId: connector.id, toolName: "search", arguments: {} }
    });

    expect(response.statusCode).toBe(202);
    expect((await store.getSnapshot()).speakerQueue[0]?.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect((await store.getSnapshot()).speakerQueue[0]?.requestFingerprint).not.toContain("hmac-sha256");
    await app.close();
  });

  it("replays a legacy MCP reservation after the keyed fingerprint writer is enabled", async () => {
    const store = new InMemoryPlatformStore();
    const initial = await store.getSnapshot();
    const connector = await store.createMcpConnector({
      name: "Legacy replay MCP",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"]
    });
    const agentId = initial.agents[0]!.id;
    const { meeting, participant } = await createToolGrantedTestMeeting(store, {
      agentId,
      mcpConnectorId: connector.id,
      title: "Legacy reservation replay"
    });
    const requestKey = "legacy-reservation-keyed-replay";
    const argumentsValue = { query: "policy" };
    const jobId = mcpToolJobId(meeting.id, requestKey);
    const fingerprintInput = {
      meetingId: meeting.id,
      agentId,
      participantId: participant.id,
      roleRevision: participant.roleRevision,
      roleId: participant.roleId,
      roleVersion: participant.roleSnapshot.version,
      connectorId: connector.id,
      toolName: "search",
      arguments: argumentsValue
    };
    const legacyFingerprint = mcpToolRequestFingerprint(fingerprintInput);
    const toolRegistration = connector.toolRegistrations.find((item) => item.toolName === "search")!;
    const toolSnapshot = { connectorName: connector.name, ...toolRegistration };
    const connectorFingerprint = mcpConnectorExecutionFingerprint(
      connector,
      await store.getConnectorSecret(connector.id)
    );
    const queuedJob: McpToolCallJobData = {
      meetingId: meeting.id,
      agentId,
      participantId: participant.id,
      roleRevision: participant.roleRevision,
      roleId: participant.roleId,
      roleVersion: participant.roleSnapshot.version,
      requestFingerprint: legacyFingerprint,
      connectorId: connector.id,
      toolName: "search",
      toolSnapshot,
      connectorFingerprint,
      arguments: argumentsValue,
      requestedBy: "owner"
    };
    await store.reserveMcpToolCall(jobId, { ...queuedJob, requestFingerprint: legacyFingerprint });
    const enqueueToolCall = vi.fn(async () => ({ jobId }));
    const app = await createApp({
      store,
      authDisabled: true,
      secretVault: new SecretVault(Buffer.alloc(32, 25)),
      mcpKeyedFingerprintWriteEnabled: true,
      agentQueue: {
        enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
        enqueueToolCall,
        enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
        inspectJob: vi.fn(async () => inspectedMcpJob("waiting", queuedJob)),
        close: vi.fn(async () => undefined)
      } as AgentTurnQueue
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${meeting.id}/tools/run`,
      headers: { "idempotency-key": requestKey },
      payload: { agentId, connectorId: connector.id, toolName: "search", arguments: argumentsValue }
    });

    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toEqual({ jobId });
    expect(enqueueToolCall).not.toHaveBeenCalled();
    expect((await store.getSnapshot()).speakerQueue[0]?.requestFingerprint).toBe(legacyFingerprint);
    await app.close();
  });

  it.each([
    { toolPolicy: "none" as const, dataPolicy: "agent_declared_scope" as const },
    { toolPolicy: "agent_read_only_grants" as const, dataPolicy: "meeting_only" as const }
  ])("rejects a direct MCP queue attempt outside the snapshotted Role policy", async ({ toolPolicy, dataPolicy }) => {
    const seed = await new InMemoryPlatformStore().getSnapshot();
    const connectorId = "d0000000-0000-4000-8000-000000000090";
    seed.mcpConnectors.push({ id: connectorId, revision: 1, name: "Docs", location: "local", baseUrl: "http://10.20.30.40/mcp", approvedTools: ["search"], toolRegistrations: [{ toolName: "search", displayName: "search", kind: "mcp_tool", version: "unversioned", owner: "Platform Owner", goal: "以唯讀方式執行 search。" }], enabled: true, hasSecret: false });
    seed.agents[0]!.toolGrants = [{ connectorId, toolName: "search" }];
    const assignment = seed.participants.find((item) => item.agentId === seed.agents[0]!.id)!;
    assignment.roleSnapshot = { ...assignment.roleSnapshot, toolPolicy, dataPolicy };
    assignment.roleHistory[assignment.roleHistory.length - 1]!.roleSnapshot = structuredClone(assignment.roleSnapshot);
    const store = new InMemoryPlatformStore(seed);
    const enqueueToolCall = vi.fn(async () => ({ jobId: "unexpected-tool-job" }));
    const agentQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall,
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      close: vi.fn(async () => undefined)
    } as AgentTurnQueue;
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${seed.meetings[0]!.id}/tools/run`,
      headers: { "idempotency-key": "role-denied-tool" },
      payload: { agentId: seed.agents[0]!.id, connectorId, toolName: "search", arguments: {} }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("ROLE_TOOL_DENIED");
    expect(enqueueToolCall).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps a Meeting closed when summary enqueue fails during creation of the next session", async () => {
    const store = new AuditedStore();
    const initial = await store.getSnapshot();
    const meetingId = initial.meetings[0]!.id;
    await store.setMeetingState(meetingId, "active");
    const suggestion = await store.createChairSuggestion(meetingId, initial.utterances.at(-1)!.id, {
      reason: "off_topic",
      suggestedMode: "chaired",
      explanation: "Return to the Meeting goal.",
      score: 0.9
    });
    let rejectSummary!: (error: Error) => void;
    let summaryAttempt = 0;
    const enqueueMeetingSummary = vi.fn(async (
      _job: Parameters<AgentTurnQueue["enqueueMeetingSummary"]>[0],
      requestedJobId?: string
    ) => {
      summaryAttempt += 1;
      if (summaryAttempt === 1) {
        return await new Promise<{ jobId: string }>((_resolve, reject) => { rejectSummary = reject; });
      }
      return { jobId: requestedJobId! };
    });
    const agentQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary,
      close: vi.fn(async () => undefined)
    } as AgentTurnQueue;
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const closing = app.inject({ method: "POST", url: `/api/meetings/${meetingId}/close` });
    await vi.waitFor(() => expect(enqueueMeetingSummary).toHaveBeenCalledOnce());
    expect((await store.getSnapshot()).meetings.find((meeting) => meeting.id === meetingId)?.state).toBe("closed");

    const nextMeeting = await store.createMeeting({
      threadId: initial.meetings[0]!.threadId,
      title: "下一場",
      goal: "確認摘要佇列失敗不會回復舊場次",
      mode: "open",
      durationMinutes: 20,
      participants: [{ agentId: initial.agents[0]!.id, roleId: initial.roles[0]!.id, isChair: true }],
      agendaItems: [{ title: "確認摘要佇列", description: "" }]
    });
    rejectSummary(new Error("redis unavailable"));

    const closed = await closing;
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ state: "closed", summaryState: "failed", summaryJobId: null });
    const afterFailure = await store.getSnapshot();
    expect(afterFailure.meetings.find((meeting) => meeting.id === meetingId)?.state).toBe("closed");
    expect(afterFailure.meetings.find((meeting) => meeting.id === meetingId)?.summaryState).toBe("failed");
    expect(afterFailure.meetings.find((meeting) => meeting.id === nextMeeting.id)?.state).toBe("draft");
    expect(afterFailure.chairSuggestions).toContainEqual(expect.objectContaining({
      id: suggestion.suggestion.id,
      status: "resolved",
      resolution: "meeting_closed"
    }));
    expect(store.audits).toContainEqual(expect.objectContaining({
      event: "meeting.summary.enqueue_failed",
      detail: { classification: "queue_unavailable" }
    }));

    const retried = await app.inject({ method: "POST", url: `/api/meetings/${meetingId}/summary/retry` });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ state: "closed", summaryState: "queued", summaryJobId: expect.any(String) });
    expect(enqueueMeetingSummary).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("treats concurrent Meeting closes as successful terminal replays", async () => {
    const store = new AuditedStore();
    const initial = await store.getSnapshot();
    const meetingId = initial.meetings[0]!.id;
    if (initial.meetings[0]!.state !== "active") await store.setMeetingState(meetingId, "active");
    const enqueueMeetingSummary = vi.fn(async (
      _job: Parameters<AgentTurnQueue["enqueueMeetingSummary"]>[0],
      requestedJobId?: string
    ) => ({ jobId: requestedJobId! }));
    const agentQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary,
      close: vi.fn(async () => undefined)
    } as AgentTurnQueue;
    const app = await createApp({ store, authDisabled: true, agentQueue });
    const readSnapshot = store.getSnapshot.bind(store);
    let reads = 0;
    let releaseBoth!: () => void;
    const bothRead = new Promise<void>((resolve) => { releaseBoth = resolve; });
    vi.spyOn(store, "getSnapshot").mockImplementation(async () => {
      const snapshot = await readSnapshot();
      reads += 1;
      if (reads <= 2) {
        if (reads === 2) releaseBoth();
        await bothRead;
      }
      return snapshot;
    });

    const close = () => app.inject({ method: "POST", url: `/api/meetings/${meetingId}/close` });
    const responses = await Promise.all([close(), close()]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 200]);
    expect(responses.map((response) => response.json().state)).toEqual(["closed", "closed"]);
    expect(new Set(responses.map((response) => response.json().summaryJobId)).size).toBe(1);
    expect(store.events.filter((event) => event === "meeting.close")).toHaveLength(1);
    await app.close();
  });

  it("returns the committed closed Meeting when its summary reservation cannot be written", async () => {
    const store = new AuditedStore();
    const meetingId = (await store.getSnapshot()).meetings[0]!.id;
    await store.setMeetingState(meetingId, "active");
    const setMeetingSummaryState = store.setMeetingSummaryState.bind(store);
    let rejectReservation = true;
    vi.spyOn(store, "setMeetingSummaryState").mockImplementation(async (id, state, jobId) => {
      if (state === "pending" && rejectReservation) {
        rejectReservation = false;
        throw new Error("summary reservation write unavailable");
      }
      return setMeetingSummaryState(id, state, jobId);
    });
    const enqueueMeetingSummary = vi.fn(async (
      _job: Parameters<AgentTurnQueue["enqueueMeetingSummary"]>[0],
      requestedJobId?: string
    ) => ({ jobId: requestedJobId! }));
    const app = await createApp({
      store,
      authDisabled: true,
      agentQueue: {
        enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
        enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
        enqueueMeetingSummary,
        close: vi.fn(async () => undefined)
      }
    });

    const response = await app.inject({ method: "POST", url: `/api/meetings/${meetingId}/close` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: meetingId, state: "closed", summaryState: "failed" });
    expect(enqueueMeetingSummary).not.toHaveBeenCalled();
    expect(store.audits).toContainEqual(expect.objectContaining({
      event: "meeting.summary.enqueue_failed",
      detail: expect.objectContaining({ classification: "reservation_write_failed" })
    }));
    await app.close();
  });

  it("reuses the reserved summary job after queue acceptance outlives a queued-state write failure", async () => {
    const store = new AuditedStore();
    const meetingId = (await store.getSnapshot()).meetings[0]!.id;
    await store.setMeetingState(meetingId, "active");
    await store.setMeetingState(meetingId, "closed");
    const setSummaryState = store.setMeetingSummaryState.bind(store);
    let rejectFirstQueuedWrite = true;
    vi.spyOn(store, "setMeetingSummaryState").mockImplementation(async (id, state, jobId) => {
      if (state === "queued" && rejectFirstQueuedWrite) {
        rejectFirstQueuedWrite = false;
        throw new Error("database unavailable after queue acceptance");
      }
      return setSummaryState(id, state, jobId);
    });
    let generatedJobs = 0;
    const enqueueMeetingSummary = vi.fn(async (
      _job: Parameters<AgentTurnQueue["enqueueMeetingSummary"]>[0],
      requestedJobId?: string
    ) => ({ jobId: requestedJobId ?? `generated-summary-${++generatedJobs}` }));
    const agentQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary,
      close: vi.fn(async () => undefined)
    } as AgentTurnQueue;
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const first = await app.inject({ method: "POST", url: `/api/meetings/${meetingId}/summary/retry` });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ summaryState: "pending", summaryJobId: expect.any(String) });
    const reservedJobId = first.json().summaryJobId as string;

    const second = await app.inject({ method: "POST", url: `/api/meetings/${meetingId}/summary/retry` });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ summaryState: "queued", summaryJobId: reservedJobId });
    expect(enqueueMeetingSummary.mock.calls.map((call) => call[1])).toEqual([reservedJobId, reservedJobId]);
    expect(generatedJobs).toBe(0);
    await app.close();
  });

  it("uses one canonical summary job ID across concurrent retry reservations", async () => {
    const store = new AuditedStore();
    const meetingId = (await store.getSnapshot()).meetings[0]!.id;
    await store.setMeetingState(meetingId, "active");
    await store.setMeetingState(meetingId, "closed");
    const setSummaryState = store.setMeetingSummaryState.bind(store);
    let pendingReservationCalls = 0;
    let releaseFirstReservation!: () => void;
    let releaseSecondReservation!: () => void;
    const secondReservationCommitted = new Promise<void>((resolve) => { releaseFirstReservation = resolve; });
    const firstReservationCanonicalized = new Promise<void>((resolve) => { releaseSecondReservation = resolve; });
    vi.spyOn(store, "setMeetingSummaryState").mockImplementation(async (id, state, jobId) => {
      if (state !== "pending") return setSummaryState(id, state, jobId);
      pendingReservationCalls += 1;
      if (pendingReservationCalls === 1) {
        await secondReservationCommitted;
        const meeting = await setSummaryState(id, state, jobId);
        releaseSecondReservation();
        return meeting;
      }
      const meeting = await setSummaryState(id, state, jobId);
      releaseFirstReservation();
      await firstReservationCanonicalized;
      return meeting;
    });
    const enqueueMeetingSummary = vi.fn(async (
      _job: Parameters<AgentTurnQueue["enqueueMeetingSummary"]>[0],
      requestedJobId?: string
    ) => ({ jobId: requestedJobId! }));
    const agentQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary,
      close: vi.fn(async () => undefined)
    } as AgentTurnQueue;
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const firstRequest = app.inject({ method: "POST", url: `/api/meetings/${meetingId}/summary/retry` });
    await vi.waitFor(() => expect(pendingReservationCalls).toBe(1));
    const secondRequest = app.inject({ method: "POST", url: `/api/meetings/${meetingId}/summary/retry` });
    const [first, second] = await Promise.all([firstRequest, secondRequest]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(enqueueMeetingSummary).toHaveBeenCalledTimes(2);
    const requestedJobIds = enqueueMeetingSummary.mock.calls.map((call) => call[1]);
    expect(new Set(requestedJobIds)).toHaveLength(1);
    expect(first.json().summaryJobId).toBe(requestedJobIds[0]);
    expect(second.json().summaryJobId).toBe(requestedJobIds[0]);
    await app.close();
  });

  it("keeps an accepted summary reservation when a concurrent scheduler temporarily observes no job", async () => {
    const store = new AuditedStore();
    const meetingId = (await store.getSnapshot()).meetings[0]!.id;
    await store.setMeetingState(meetingId, "active");
    await store.setMeetingState(meetingId, "closed");
    const canonicalJobId = "concurrent-summary-admission";
    await store.setMeetingSummaryState(meetingId, "pending", canonicalJobId);

    let enqueueCalls = 0;
    let releaseAcceptedEnqueue!: () => void;
    const acceptedEnqueueGate = new Promise<void>((resolve) => {
      releaseAcceptedEnqueue = resolve;
    });
    let firstEnqueueStarted!: () => void;
    const firstEnqueueStartedGate = new Promise<void>((resolve) => {
      firstEnqueueStarted = resolve;
    });
    let queueInspectionCalls = 0;
    const enqueueMeetingSummary = vi.fn(async (
      _job: Parameters<AgentTurnQueue["enqueueMeetingSummary"]>[0],
      requestedJobId?: string
    ) => {
      enqueueCalls += 1;
      expect(requestedJobId).toBe(canonicalJobId);
      if (enqueueCalls === 1) {
        firstEnqueueStarted();
        await acceptedEnqueueGate;
        return { jobId: canonicalJobId };
      }
      throw new Error("second scheduler enqueue failed before shared admission became visible");
    });
    const agentQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary,
      getJobState: vi.fn(async () => {
        queueInspectionCalls += 1;
        return queueInspectionCalls === 1 ? null : "waiting";
      }),
      close: vi.fn(async () => undefined)
    } as AgentTurnQueue;
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const acceptedScheduler = app.inject({ method: "POST", url: `/api/meetings/${meetingId}/summary/retry` });
    await firstEnqueueStartedGate;
    const uncertainScheduler = app.inject({ method: "POST", url: `/api/meetings/${meetingId}/summary/retry` });
    const uncertainResponse = await uncertainScheduler;
    releaseAcceptedEnqueue();
    const acceptedResponse = await acceptedScheduler;

    expect([acceptedResponse.statusCode, uncertainResponse.statusCode].sort()).toEqual([200, 202]);
    expect(await store.getSnapshot()).toMatchObject({
      meetings: expect.arrayContaining([
        expect.objectContaining({
          id: meetingId,
          summaryState: "queued",
          summaryJobId: canonicalJobId
        })
      ])
    });
    await expect(store.commitMeetingSummary({
      meetingId,
      jobId: canonicalJobId,
      utterance: {
        turnId: `meeting-summary:${meetingId}`,
        speakerType: "system",
        speakerName: "Council",
        roleName: null,
        content: "Concurrent recovery summary.",
        kind: "system",
        evidenceCount: 0
      },
      auditDetail: { decisionCount: 0 }
    })).resolves.toMatchObject({ status: "created" });
    await app.close();
  });

  it("does not report a retained terminal summary job as newly queued", async () => {
    const store = new AuditedStore();
    const meetingId = (await store.getSnapshot()).meetings[0]!.id;
    await store.setMeetingState(meetingId, "active");
    await store.setMeetingState(meetingId, "closed");
    await store.setMeetingSummaryState(meetingId, "pending", "terminal-summary-job");
    const agentQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "terminal-summary-job" })),
      getJobState: vi.fn(async () => "failed"),
      close: vi.fn(async () => undefined)
    } as AgentTurnQueue;
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const response = await app.inject({ method: "POST", url: `/api/meetings/${meetingId}/summary/retry` });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("SUMMARY_QUEUE_UNAVAILABLE");
    expect((await store.getSnapshot()).meetings.find((meeting) => meeting.id === meetingId)).toMatchObject({
      summaryState: "failed",
      summaryJobId: "terminal-summary-job"
    });
    await app.close();
  });

  it("preserves a summary reservation when enqueue acceptance cannot be inspected", async () => {
    const store = new AuditedStore();
    const meetingId = (await store.getSnapshot()).meetings[0]!.id;
    await store.setMeetingState(meetingId, "active");
    await store.setMeetingState(meetingId, "closed");
    const agentQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => { throw new Error("Redis reply was lost"); }),
      getJobState: vi.fn(async () => { throw new Error("Redis inspection unavailable"); }),
      close: vi.fn(async () => undefined)
    } as AgentTurnQueue;
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const response = await app.inject({ method: "POST", url: `/api/meetings/${meetingId}/summary/retry` });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ summaryState: "pending", summaryJobId: expect.any(String) });
    expect((await store.getSnapshot()).meetings.find((meeting) => meeting.id === meetingId)).toMatchObject({
      summaryState: "pending",
      summaryJobId: response.json().summaryJobId
    });
    await app.close();
  });

  it("returns a concurrent durable summary failure instead of stale pending reconciliation", async () => {
    const store = new AuditedStore();
    const meetingId = (await store.getSnapshot()).meetings[0]!.id;
    await store.setMeetingState(meetingId, "active");
    await store.setMeetingState(meetingId, "closed");
    await store.setMeetingSummaryState(meetingId, "pending", "reconciled-summary-job");
    const agentQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "reconciled-summary-job" })),
      getJobState: vi.fn(async () => {
        await store.setMeetingSummaryState(meetingId, "failed", "reconciled-summary-job");
        throw new Error("Redis inspection unavailable during reconciliation");
      }),
      close: vi.fn(async () => undefined)
    } as AgentTurnQueue;
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const response = await app.inject({ method: "POST", url: `/api/meetings/${meetingId}/summary/retry` });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("SUMMARY_QUEUE_UNAVAILABLE");
    expect((await store.getSnapshot()).meetings.find((meeting) => meeting.id === meetingId)).toMatchObject({
      summaryState: "failed",
      summaryJobId: "reconciled-summary-job"
    });
    await app.close();
  });

  it("patches MCP connectors, rotates bearer token, and reports revoked grants", async () => {
    const store = new AuditedStore();
    const secretVault = new SecretVault(Buffer.alloc(32, 11));
    const app = await createApp({ store, authDisabled: true, secretVault, mcpLocalHostAllowlist: ["10.20.30.40"] });
    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/mcp-connectors",
      headers: { "idempotency-key": "mcp-patch-connector" },
      payload: {
        name: "Docs",
        location: "local",
        baseUrl: "http://10.20.30.40/mcp",
        approvedTools: ["search", "read"],
        bearerToken: "old-token"
      }
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json();
    const snapshot = await store.getSnapshot();
    await store.updateAgent(snapshot.agents[0]!.id, {
      toolGrants: [
        { connectorId: created.id, toolName: "search" },
        { connectorId: created.id, toolName: "read" }
      ]
    });

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/mcp-connectors/${created.id}`,
      payload: {
        expectedRevision: created.revision,
        name: "Docs v2",
        baseUrl: "http://10.20.30.40/mcp-updated",
        approvedTools: ["search"],
        enabled: false,
        bearerToken: "new-token"
      }
    });

    expect(patched.statusCode).toBe(200);
    const response = patched.json();
    expect(response).toMatchObject({
      connector: {
        id: created.id,
        name: "Docs v2",
        baseUrl: "http://10.20.30.40/mcp-updated",
        approvedTools: ["search"],
        enabled: false
      },
      revokedGrantCount: 2
    });
    expect(JSON.stringify(response)).not.toMatch(/old-token|new-token/);
    const token = await store.getConnectorSecret(created.id);
    expect(token).not.toBeNull();
    expect(secretVault.decrypt(token!)).toBe("new-token");
    expect(store.events).toContain("mcp_connector.updated");
    await app.close();
  });

  it("separates cloud MCP endpoints from explicitly allowlisted local MCP hosts", async () => {
    const store = new InMemoryPlatformStore();
    const app = await createApp({
      store,
      authDisabled: true,
      mcpLocalHostAllowlist: ["10.20.30.40"]
    });

    const cloudPrivate = await app.inject({
      method: "POST",
      url: "/api/mcp-connectors",
      headers: { "idempotency-key": "mcp-cloud-private-url" },
      payload: {
        name: "Cloud private",
        location: "cloud",
        baseUrl: "http://10.20.30.40/mcp",
        approvedTools: []
      }
    });
    expect(cloudPrivate.statusCode).toBe(400);
    expect(cloudPrivate.json()).toMatchObject({ error: { code: "CONNECTOR_URL_REJECTED" } });

    const localDenied = await app.inject({
      method: "POST",
      url: "/api/mcp-connectors",
      headers: { "idempotency-key": "mcp-local-wrong-private-host" },
      payload: {
        name: "Wrong local host",
        location: "local",
        baseUrl: "http://10.20.30.41/mcp",
        approvedTools: []
      }
    });
    expect(localDenied.statusCode).toBe(400);

    const localPublicDenied = await app.inject({
      method: "POST",
      url: "/api/mcp-connectors",
      headers: { "idempotency-key": "mcp-local-public-host" },
      payload: {
        name: "Wrong public host",
        location: "local",
        baseUrl: "https://8.8.8.8/mcp",
        approvedTools: []
      }
    });
    expect(localPublicDenied.statusCode).toBe(400);
    expect(localPublicDenied.json()).toMatchObject({ error: { code: "CONNECTOR_URL_REJECTED" } });

    const localAllowed = await app.inject({
      method: "POST",
      url: "/api/mcp-connectors",
      headers: { "idempotency-key": "mcp-local-allowlisted-host" },
      payload: {
        name: "Local docs",
        location: "local",
        baseUrl: "http://10.20.30.40/mcp",
        approvedTools: []
      }
    });
    expect(localAllowed.statusCode).toBe(201);
    expect(localAllowed.json()).toMatchObject({ location: "local" });

    const updateSpy = vi.spyOn(store, "updateMcpConnector");
    const locationOnlyUpdate = await app.inject({
      method: "PATCH",
      url: `/api/mcp-connectors/${localAllowed.json().id}`,
      payload: { expectedRevision: localAllowed.json().revision, location: "local" }
    });
    expect(locationOnlyUpdate.statusCode).toBe(200);
    expect(updateSpy).toHaveBeenLastCalledWith(
      localAllowed.json().id,
      expect.objectContaining({ location: "local", baseUrl: "http://10.20.30.40/mcp" }),
      undefined
    );
    await app.close();
  });

  it("preserves an MCP bearer token when an update omits token rotation", async () => {
    const store = new InMemoryPlatformStore();
    const secretVault = new SecretVault(Buffer.alloc(32, 12));
    const app = await createApp({ store, authDisabled: true, secretVault, mcpLocalHostAllowlist: ["10.20.30.40"] });
    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/mcp-connectors",
      headers: { "idempotency-key": "mcp-retained-token" },
      payload: {
        name: "Docs",
        location: "local",
        baseUrl: "http://10.20.30.40/mcp",
        approvedTools: ["search"],
        bearerToken: "retained-token"
      }
    });
    const connector = createdResponse.json();
    const before = await store.getConnectorSecret(connector.id);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/mcp-connectors/${connector.id}`,
      payload: { expectedRevision: connector.revision, name: "Docs renamed" }
    });

    expect(patched.statusCode).toBe(200);
    expect(await store.getConnectorSecret(connector.id)).toBe(before);
    expect(secretVault.decrypt(before!)).toBe("retained-token");
    await app.close();
  });

  it("rejects a stale MCP Connector PATCH without applying stale catalog fields", async () => {
    const store = new InMemoryPlatformStore();
    const app = await createApp({ store, authDisabled: true, mcpLocalHostAllowlist: ["10.20.30.40"] });
    const created = (await app.inject({
      method: "POST",
      url: "/api/mcp-connectors",
      headers: { "idempotency-key": "mcp-stale-patch-fixture" },
      payload: {
        name: "Two-tab Docs",
        location: "local",
        baseUrl: "http://10.20.30.40/mcp",
        approvedTools: ["search", "read"]
      }
    })).json();

    const current = await app.inject({
      method: "PATCH",
      url: `/api/mcp-connectors/${created.id}`,
      payload: { expectedRevision: created.revision, approvedTools: ["search"] }
    });
    const stale = await app.inject({
      method: "PATCH",
      url: `/api/mcp-connectors/${created.id}`,
      payload: {
        expectedRevision: created.revision,
        name: "Stale Docs",
        approvedTools: ["search", "read"]
      }
    });

    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ connector: { revision: created.revision + 1, approvedTools: ["search"] } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
    expect((await store.getSnapshot()).mcpConnectors.find((item) => item.id === created.id))
      .toMatchObject({ revision: created.revision + 1, name: "Two-tab Docs", approvedTools: ["search"] });
    await app.close();
  });

  it("fails MCP discovery closed when its configured secret cannot be loaded", async () => {
    const store = new InMemoryPlatformStore();
    const connector = await store.createMcpConnector({
      name: "Protected Docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"]
    }, { ciphertext: "encrypted-token" });
    vi.spyOn(store, "getConnectorSecret").mockResolvedValue(null);
    const app = await createApp({ store, authDisabled: true });

    const response = await app.inject({ method: "POST", url: `/api/mcp-connectors/${connector.id}/discover` });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("CONNECTOR_SECRET_UNAVAILABLE");
    await app.close();
  });

  it("fails MCP discovery closed when endpoint and secret rotate during binding", async () => {
    const store = new InMemoryPlatformStore();
    const secretVault = new SecretVault(Buffer.alloc(32, 19));
    const connector = await store.createMcpConnector({
      name: "Rotating MCP",
      location: "cloud",
      baseUrl: "https://1.1.1.1/mcp",
      approvedTools: ["search"]
    }, { ciphertext: secretVault.encrypt("old-mcp-secret") });
    const readSecret = store.getConnectorSecret.bind(store);
    const secretSpy = vi.spyOn(store, "getConnectorSecret").mockImplementationOnce(async (id) => {
      await store.updateMcpConnector(id, {
        expectedRevision: connector.revision,
        baseUrl: "https://1.0.0.1/mcp"
      }, { ciphertext: secretVault.encrypt("new-mcp-secret") });
      return readSecret(id);
    });
    const discoverSpy = vi.spyOn(McpReadOnlyClient.prototype, "discover").mockResolvedValue([]);
    const app = await createApp({ store, authDisabled: true, secretVault });

    try {
      const response = await app.inject({ method: "POST", url: `/api/mcp-connectors/${connector.id}/discover` });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("CONNECTOR_CHANGED");
      expect(discoverSpy).not.toHaveBeenCalled();
    } finally {
      secretSpy.mockRestore();
      discoverSpy.mockRestore();
      await app.close();
    }
  });

  it("fails MCP discovery closed when only its bearer token rotates during binding", async () => {
    const store = new InMemoryPlatformStore();
    const secretVault = new SecretVault(Buffer.alloc(32, 20));
    const connector = await store.createMcpConnector({
      name: "Secret-only rotating MCP",
      location: "cloud",
      baseUrl: "https://1.1.1.1/mcp",
      approvedTools: ["search"]
    }, { ciphertext: secretVault.encrypt("old-mcp-secret") });
    const readSecret = store.getConnectorSecret.bind(store);
    const secretSpy = vi.spyOn(store, "getConnectorSecret").mockImplementationOnce(async (id) => {
      const oldCiphertext = await readSecret(id);
      await store.updateMcpConnector(id, {
        expectedRevision: connector.revision
      }, { ciphertext: secretVault.encrypt("new-mcp-secret") });
      return oldCiphertext;
    });
    const discoverSpy = vi.spyOn(McpReadOnlyClient.prototype, "discover").mockResolvedValue([]);
    const app = await createApp({ store, authDisabled: true, secretVault });

    try {
      const response = await app.inject({ method: "POST", url: `/api/mcp-connectors/${connector.id}/discover` });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("CONNECTOR_CHANGED");
      expect(discoverSpy).not.toHaveBeenCalled();
    } finally {
      secretSpy.mockRestore();
      discoverSpy.mockRestore();
      await app.close();
    }
  });

  it("fails MCP discovery closed when its connector changes while discovery is in flight", async () => {
    const store = new InMemoryPlatformStore();
    const connector = await store.createMcpConnector({
      name: "In-flight rotating MCP",
      location: "cloud",
      baseUrl: "https://1.1.1.1/mcp",
      approvedTools: ["search"]
    });
    let signalDiscoveryStarted!: () => void;
    let releaseDiscovery!: () => void;
    const discoveryStarted = new Promise<void>((resolve) => { signalDiscoveryStarted = resolve; });
    const discoveryGate = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
    const discoverSpy = vi.spyOn(McpReadOnlyClient.prototype, "discover").mockImplementationOnce(async () => {
      signalDiscoveryStarted();
      await discoveryGate;
      return [];
    });
    const app = await createApp({ store, authDisabled: true });

    try {
      const responsePromise = app.inject({ method: "POST", url: `/api/mcp-connectors/${connector.id}/discover` });
      await discoveryStarted;
      await store.updateMcpConnector(connector.id, {
        expectedRevision: connector.revision,
        baseUrl: "https://1.0.0.1/mcp"
      });
      releaseDiscovery();
      const response = await responsePromise;

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("CONNECTOR_CHANGED");
      expect(discoverSpy).toHaveBeenCalledOnce();
    } finally {
      releaseDiscovery();
      discoverSpy.mockRestore();
      await app.close();
    }
  });

  it("returns the exact MCP connector metadata validated by a successful discovery", async () => {
    const store = new InMemoryPlatformStore();
    const connector = await store.createMcpConnector({
      name: "Authoritative discovery MCP",
      location: "cloud",
      baseUrl: "https://1.1.1.1/mcp",
      approvedTools: ["search"],
      toolRegistrations: [{
        toolName: "search",
        displayName: "Search",
        kind: "mcp_tool",
        version: "1.0.0",
        owner: "Platform Owner",
        goal: "Search approved documents."
      }]
    });
    const discoverSpy = vi.spyOn(McpReadOnlyClient.prototype, "discover").mockResolvedValue([{
      name: "search",
      description: "Search approved documents.",
      readOnly: true
    }]);
    const app = await createApp({ store, authDisabled: true });

    try {
      const response = await app.inject({ method: "POST", url: `/api/mcp-connectors/${connector.id}/discover` });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        connector,
        approvedTools: ["search"],
        tools: [{ name: "search", readOnly: true }]
      });
    } finally {
      discoverSpy.mockRestore();
      await app.close();
    }
  });

  it("fails MCP discovery closed when a dependency exceeds the published response bounds", async () => {
    const store = new InMemoryPlatformStore();
    const connector = await store.createMcpConnector({
      name: "Bounded discovery MCP",
      location: "cloud",
      baseUrl: "https://1.1.1.1/mcp",
      approvedTools: []
    });
    const discoverSpy = vi.spyOn(McpReadOnlyClient.prototype, "discover").mockResolvedValue(
      Array.from({ length: 1_001 }, (_, index) => ({
        name: `read-${index}`,
        description: "Read one approved resource.",
        readOnly: true
      }))
    );
    const app = await createApp({ store, authDisabled: true });

    try {
      const response = await app.inject({ method: "POST", url: `/api/mcp-connectors/${connector.id}/discover` });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: {
          code: "RESPONSE_CONTRACT_VIOLATION",
          message: "The response could not be serialized safely."
        }
      });
      expect(response.body).not.toContain("read-1000");
    } finally {
      discoverSpy.mockRestore();
      await app.close();
    }
  });

  it("denies an MCP queue request when the Tool Catalog registration is absent", async () => {
    const seed = await new InMemoryPlatformStore().getSnapshot();
    const connectorId = "d0000000-0000-4000-8000-000000000091";
    seed.mcpConnectors.push({
      id: connectorId,
      revision: 1,
      name: "Docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"],
      toolRegistrations: [{ toolName: "search", displayName: "search", kind: "mcp_tool", version: "unversioned", owner: "Platform Owner", goal: "以唯讀方式執行 search。" }],
      enabled: true,
      hasSecret: false
    });
    seed.agents[0]!.toolGrants = [{ connectorId, toolName: "search" }];
    const store = new InMemoryPlatformStore(seed);
    const state = (store as unknown as { state: { mcpConnectors: Array<{ id: string; toolRegistrations: unknown[] }> } }).state;
    state.mcpConnectors.find((item) => item.id === connectorId)!.toolRegistrations = [];
    const enqueueToolCall = vi.fn(async () => ({ jobId: "unexpected-tool-job" }));
    const agentQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall,
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      close: vi.fn(async () => undefined)
    } as AgentTurnQueue;
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${seed.meetings[0]!.id}/tools/run`,
      headers: { "idempotency-key": "catalog-denied-tool" },
      payload: { agentId: seed.agents[0]!.id, connectorId, toolName: "search", arguments: {} }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("TOOL_DENIED");
    expect(enqueueToolCall).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects MCP discovery and authorization after a connector is disabled", async () => {
    const store = new InMemoryPlatformStore();
    const app = await createApp({ store, authDisabled: true });
    const created = await store.createMcpConnector({
      name: "Docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"]
    });
    const snapshot = await store.getSnapshot();
    await store.updateAgent(snapshot.agents[0]!.id, {
      toolGrants: [{ connectorId: created.id, toolName: "search" }]
    });
    const disabledResponse = await app.inject({
      method: "PATCH",
      url: `/api/mcp-connectors/${created.id}`,
      payload: { expectedRevision: created.revision, enabled: false }
    });
    expect(disabledResponse.statusCode).toBe(200);
    expect(disabledResponse.json().connector ?? disabledResponse.json()).toMatchObject({
      id: created.id,
      enabled: false
    });

    const discover = await app.inject({ method: "POST", url: `/api/mcp-connectors/${created.id}/discover` });
    expect(discover.statusCode).not.toBe(200);
    expect(discover.json().error.code).toMatch(/disabled|denied/i);
    const authorize = await app.inject({
      method: "POST",
      url: "/api/tools/authorize",
      payload: {
        connectorId: created.id,
        toolName: "search",
        effect: "read",
        agentId: snapshot.agents[0]!.id
      }
    });
    expect(authorize.statusCode).toBe(403);
    expect(authorize.json().error.code).toMatch(/disabled|denied/i);
    await app.close();
  });

  it("denies stale disabled MCP grants at authorization and meeting queue boundaries", async () => {
    const seed = await new InMemoryPlatformStore().getSnapshot();
    const connectorId = "d0000000-0000-4000-8000-000000000099";
    seed.mcpConnectors.push({
      id: connectorId,
      revision: 1,
      name: "Disabled Docs",
      location: "local",
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: ["search"],
      toolRegistrations: [],
      enabled: false,
      hasSecret: false
    });
    seed.agents[0]!.toolGrants = [{ connectorId, toolName: "search" }];
    seed.meetings[0]!.state = "active";
    const store = new InMemoryPlatformStore(seed);
    const enqueueToolCall = vi.fn(async () => ({ jobId: "unexpected-tool-job" }));
    const agentQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall,
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      close: vi.fn(async () => undefined)
    } as AgentTurnQueue;
    const app = await createApp({ store, authDisabled: true, agentQueue });

    const authorize = await app.inject({
      method: "POST",
      url: "/api/tools/authorize",
      payload: { connectorId, toolName: "search", effect: "read", agentId: seed.agents[0]!.id }
    });
    expect(authorize.statusCode).toBe(403);

    const run = await app.inject({
      method: "POST",
      url: `/api/meetings/${seed.meetings[0]!.id}/tools/run`,
      headers: { "idempotency-key": "disabled-tool" },
      payload: { agentId: seed.agents[0]!.id, connectorId, toolName: "search", arguments: {} }
    });
    expect(run.statusCode).toBe(403);
    expect(run.json().error.code).toBe("TOOL_DENIED");
    expect(enqueueToolCall).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects duplicate MCP connector names on create and update APIs", async () => {
    const store = new InMemoryPlatformStore();
    const app = await createApp({ store, authDisabled: true });
    const primary = await app.inject({
      method: "POST",
      url: "/api/mcp-connectors",
      headers: { "idempotency-key": "mcp-duplicate-primary" },
      payload: { name: "Docs", baseUrl: "https://1.1.1.1/mcp", approvedTools: ["search"] }
    });
    expect(primary.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/mcp-connectors",
      headers: { "idempotency-key": "mcp-duplicate-candidate" },
      payload: { name: "docs", baseUrl: "https://1.0.0.1/mcp", approvedTools: ["search"] }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(typeof duplicate.json().error.code).toBe("string");

    const second = await app.inject({
      method: "POST",
      url: "/api/mcp-connectors",
      headers: { "idempotency-key": "mcp-duplicate-update-fixture" },
      payload: { name: "Archive", baseUrl: "https://8.8.8.8/mcp", approvedTools: ["search"] }
    });
    expect(second.statusCode).toBe(201);
    const secondConnector = second.json();
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/mcp-connectors/${secondConnector.id}`,
      payload: { expectedRevision: secondConnector.revision, name: "DOCS" }
    });
    expect(updated.statusCode).toBe(409);
    expect(typeof updated.json().error.code).toBe("string");
    await app.close();
  });

  it("rejects MCP connector updates with blocked baseUrl hostnames", async () => {
    const store = new InMemoryPlatformStore();
    const app = await createApp({ store, authDisabled: true });
    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/mcp-connectors",
      headers: { "idempotency-key": "mcp-blocked-update-fixture" },
      payload: { name: "Docs", baseUrl: "https://1.1.1.1/mcp", approvedTools: ["search"] }
    });
    expect(createdResponse.statusCode).toBe(201);
    const created = createdResponse.json();
    const update = await app.inject({
      method: "PATCH",
      url: `/api/mcp-connectors/${created.id}`,
      payload: { expectedRevision: created.revision, baseUrl: "http://localhost:4000/mcp" }
    });

    expect(update.statusCode).toBe(400);
    expect(update.json().error.code).toBe("CONNECTOR_URL_REJECTED");
    await app.close();
  });
});
