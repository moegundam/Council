import { beforeEach, describe, expect, it, vi } from "vitest";

const queue = vi.hoisted(() => ({
  add: vi.fn(),
  getJob: vi.fn(),
  close: vi.fn()
}));

vi.mock("bullmq", () => ({
  Queue: class {
    add = queue.add;
    getJob = queue.getJob;
    close = queue.close;
  }
}));

import { agentTurnJobId, BullAgentTurnQueue, chairAutomationJobId, mcpToolJobId, taskAgentRunJobId } from "./agent-queue.js";

const toolSnapshot = {
  connectorName: "Platform tools",
  toolName: "platform_status",
  displayName: "Platform status",
  kind: "mcp_tool" as const,
  version: "1.0.0",
  owner: "Platform Owner",
  goal: "Read platform status."
};

const roleBinding = {
  participantId: "participant",
  roleRevision: 1,
  roleId: "role",
  roleVersion: 1
};

const runtimeProfileSnapshot = {
  profileId: "76000000-0000-4000-8000-000000000001",
  revision: 1,
  harnessKind: "openai_compatible" as const,
  modelConnectorId: null,
  sandboxProfileId: null,
  policy: "text_only" as const,
  capabilities: ["text" as const],
  timeoutMs: 60_000,
  maxConcurrency: 1
};

const modelConnectorBinding = {
  id: "model",
  location: "local" as const,
  baseUrl: "http://model:4000/v1",
  model: "task",
  secretRevision: 0
};

function runtimeRun(kind: "meeting_turn" | "task_agent") {
  return {
    id: kind === "meeting_turn"
      ? "77000000-0000-4000-8000-000000000001"
      : "77000000-0000-4000-8000-000000000002",
    kind,
    scope: {
      id: kind === "meeting_turn" ? "meeting:meeting:participant:participant" : "task:task:attempt:1",
      kind: kind === "meeting_turn" ? ("meeting_participant" as const) : ("task_attempt" as const),
      subjectId: kind === "meeting_turn"
        ? "77000000-0000-4000-8000-000000000003"
        : "77000000-0000-4000-8000-000000000004",
      parentScopeId: kind === "meeting_turn" ? "meeting:meeting" : null
    },
    runtimeProfile: runtimeProfileSnapshot,
    goalRunId: null,
    taskId: kind === "task_agent" ? "77000000-0000-4000-8000-000000000004" : null,
    agentId: "77000000-0000-4000-8000-000000000005",
    agentRevision: 1,
    roleId: kind === "meeting_turn" ? "77000000-0000-4000-8000-000000000006" : null,
    roleRevision: kind === "meeting_turn" ? 1 : null,
    state: "queued" as const,
    attempt: 1,
    idempotencyKey: `${kind}-request`,
    evidenceIds: [],
    queuedAt: "2026-08-07T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    expiresAt: "2026-08-07T00:05:00.000Z",
    errorCode: null,
    runtimeVersion: null,
    providerSessionId: null,
    leaseId: null,
    revision: 1,
    heartbeatAt: null,
    eventCursor: 0,
    pausedAt: null,
    updatedAt: "2026-08-07T00:00:00.000Z"
  };
}

const agentTurn = (agentId = "agent") => ({
  ...roleBinding,
  meetingId: "meeting",
  agentId,
  agendaRevision: 1,
  agendaCurrentItemId: null,
  requestedBy: "owner" as const,
  modelConnectorBinding: { ...modelConnectorBinding, model: agentId },
  agentRevision: 1,
  promptBinding: null,
  skillDigests: {},
  runtimeProfileBinding: { profileId: runtimeProfileSnapshot.profileId, revision: 1 },
  runtimeProfileSnapshot,
  runtimeRun: runtimeRun("meeting_turn")
});

const taskAgentRun = (executionProfile: "advisor" | "worker" = "advisor") => ({
  taskId: "task",
  agentId: "agent",
  executionProfile,
  executionRevision: executionProfile === "advisor" ? 1 : 2,
  taskFingerprint: "task-fingerprint",
  requestFingerprint: "request-fingerprint",
  modelConnectorBinding,
  agentRevision: 1,
  promptBinding: null,
  skillDigests: {},
  runtimeProfileBinding: { profileId: runtimeProfileSnapshot.profileId, revision: 1 },
  runtimeProfileSnapshot,
  runtimeRun: runtimeRun("task_agent"),
  requestedBy: "owner" as const
});

describe("BullAgentTurnQueue", () => {
  beforeEach(() => {
    queue.add.mockReset();
    queue.close.mockReset();
    queue.getJob.mockReset();
    queue.add.mockImplementation(async (_name, _data, options) => ({
      id: options.jobId,
      getState: vi.fn(async () => "waiting")
    }));
  });

  it.each(["active", "delayed", "prioritized", "waiting", "waiting-children"])(
    "reports a BullMQ job in the %s state as queue-owned",
    async (state) => {
      const jobs = new BullAgentTurnQueue("redis://redis:6379");
      const getState = vi.fn(async () => state);
      queue.getJob.mockResolvedValueOnce({ id: "known", getState });

      await expect(jobs.hasJob("known")).resolves.toBe(true);
      expect(getState).toHaveBeenCalledOnce();
    }
  );

  it.each(["completed", "failed", "unknown"])(
    "does not report a retained BullMQ job in the %s state as queue-owned",
    async (state) => {
      const jobs = new BullAgentTurnQueue("redis://redis:6379");
      const getState = vi.fn(async () => state);
      queue.getJob.mockResolvedValueOnce({ id: "known", getState });

      await expect(jobs.hasJob("known")).resolves.toBe(false);
      expect(getState).toHaveBeenCalledOnce();
    }
  );

  it("does not report a missing BullMQ job as queue-owned", async () => {
    const jobs = new BullAgentTurnQueue("redis://redis:6379");
    queue.getJob.mockResolvedValueOnce(undefined);

    await expect(jobs.hasJob("missing")).resolves.toBe(false);
  });

  it("propagates BullMQ state lookup failures instead of claiming queue ownership", async () => {
    const jobs = new BullAgentTurnQueue("redis://redis:6379");
    const lookupError = new Error("Redis state lookup failed");
    const getState = vi.fn().mockRejectedValueOnce(lookupError);
    queue.getJob.mockResolvedValueOnce({ id: "known", getState });

    await expect(jobs.hasJob("known")).rejects.toBe(lookupError);
    expect(getState).toHaveBeenCalledOnce();
  });

  it("reports the BullMQ state for an existing job", async () => {
    const jobs = new BullAgentTurnQueue("redis://redis:6379");
    const getState = vi.fn(async () => "waiting");
    queue.getJob.mockResolvedValueOnce({ id: "known", getState }).mockResolvedValueOnce(undefined);

    await expect(jobs.getJobState("known")).resolves.toBe("waiting");
    await expect(jobs.getJobState("missing")).resolves.toBeNull();
    expect(getState).toHaveBeenCalledOnce();
  });

  it("returns the BullMQ state and immutable job envelope for ownership inspection", async () => {
    const jobs = new BullAgentTurnQueue("redis://redis:6379");
    const data = { contractVersion: 1, name: "mcp-tool-call", data: { meetingId: "meeting" } };
    const getState = vi.fn(async () => "waiting");
    queue.getJob.mockResolvedValueOnce({ id: "known", data, getState }).mockResolvedValueOnce(undefined);

    await expect(jobs.inspectJob("known")).resolves.toEqual({ state: "waiting", data });
    await expect(jobs.inspectJob("missing")).resolves.toBeNull();
    expect(getState).toHaveBeenCalledOnce();
  });

  it("uses BullMQ-compatible custom job IDs for every job type", async () => {
    const jobs = new BullAgentTurnQueue("redis://redis:6379");

    await jobs.enqueue(agentTurn());
    await jobs.enqueueToolCall({
      ...roleBinding,
      meetingId: "meeting",
      agentId: "agent",
      connectorId: "connector",
      toolName: "platform_status",
      toolSnapshot,
      connectorFingerprint: "connector-fingerprint",
      arguments: {},
      requestedBy: "owner"
    });
    await jobs.enqueueMeetingSummary({ meetingId: "meeting", requestedBy: "system" });
    await jobs.enqueueChairAutomation({
      meetingId: "meeting",
      chairSuggestionId: "suggestion",
      sourceUtteranceId: "utterance",
      automationRevision: 2,
      requestedBy: "system"
    });
    await jobs.enqueueTaskSync({ taskId: "task", adapterId: "adapter", requestedBy: "owner" });
    await jobs.enqueueTaskAgentRun(taskAgentRun(), taskAgentRunJobId("task", "request-1"));

    const jobIds = queue.add.mock.calls.map((call) => call[2].jobId as string);
    expect(jobIds).toHaveLength(6);
    expect(jobIds.every((jobId) => !jobId.includes(":"))).toBe(true);
    expect(queue.add.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ contractVersion: 1, name: "agent-turn", data: expect.objectContaining({ meetingId: "meeting" }) }),
      expect.objectContaining({ contractVersion: 1, name: "mcp-tool-call", data: expect.objectContaining({ meetingId: "meeting" }) }),
      expect.objectContaining({ contractVersion: 1, name: "meeting-summary", data: expect.objectContaining({ meetingId: "meeting" }) }),
      expect.objectContaining({ contractVersion: 1, name: "chair-automation", data: expect.objectContaining({ meetingId: "meeting" }) }),
      expect.objectContaining({ contractVersion: 1, name: "task-sync", data: expect.objectContaining({ taskId: "task" }) }),
      expect.objectContaining({ contractVersion: 1, name: "task-agent-run", data: expect.objectContaining({ taskId: "task" }) })
    ]);
    expect(queue.add.mock.calls[0]![2].deduplication).toEqual({ id: "meeting-action-meeting" });
    expect(queue.add.mock.calls[1]![2].deduplication).toEqual({ id: "meeting-action-meeting" });
    expect(queue.add.mock.calls[0]![2]).toMatchObject({
      attempts: 2,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: 500,
      removeOnFail: 500
    });
    expect(queue.add.mock.calls[1]![2]).toMatchObject({
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 500 }
    });
    expect(queue.add.mock.calls[1]![2]).not.toHaveProperty("backoff");
    expect(queue.add.mock.calls[2]![2]).toMatchObject({
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      deduplication: { id: "meeting-summary-meeting" }
    });
    expect(queue.add.mock.calls[3]![2]).toMatchObject({
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      deduplication: { id: "chair-automation-suggestion" },
      jobId: chairAutomationJobId("meeting", "suggestion")
    });
    expect(queue.add.mock.calls[4]![2]).toMatchObject({
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      delay: 1_000,
      deduplication: { id: "task-sync-task" }
    });
    expect(queue.add.mock.calls[5]![2]).toMatchObject({
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      delay: 1_000,
      deduplication: { id: "task-agent-run-task" },
      jobId: taskAgentRunJobId("task", "request-1")
    });
  });

  it("derives a stable Task Agent job ID from the Task and Idempotency-Key", async () => {
    const jobs = new BullAgentTurnQueue("redis://redis:6379");
    const requestedJobId = taskAgentRunJobId("task", "owner-run-1");
    const input = taskAgentRun("worker");

    await expect(jobs.enqueueTaskAgentRun(input, requestedJobId)).resolves.toEqual({ jobId: requestedJobId });
    await expect(jobs.enqueueTaskAgentRun(input, requestedJobId)).resolves.toEqual({ jobId: requestedJobId });
    expect(requestedJobId).toMatch(/^task-task-agent-[a-f0-9]{40}$/);
    expect(queue.add.mock.calls.map((call) => call[2].jobId)).toEqual([requestedJobId, requestedJobId]);
  });

  it("reuses one stable job ID for the same Chair suggestion", async () => {
    const jobs = new BullAgentTurnQueue("redis://redis:6379");
    const input = {
      meetingId: "meeting",
      chairSuggestionId: "suggestion",
      sourceUtteranceId: "utterance",
      automationRevision: 4,
      requestedBy: "system" as const
    };
    const expected = chairAutomationJobId("meeting", "suggestion");

    await expect(jobs.enqueueChairAutomation(input)).resolves.toEqual({ jobId: expected });
    await expect(jobs.enqueueChairAutomation(input)).resolves.toEqual({ jobId: expected });
    expect(queue.add.mock.calls.map((call) => call[2].jobId)).toEqual([expected, expected]);
  });

  it("does not report a retained terminal Chair job as newly queued", async () => {
    const jobs = new BullAgentTurnQueue("redis://redis:6379");
    const input = {
      meetingId: "meeting",
      chairSuggestionId: "suggestion",
      sourceUtteranceId: "utterance",
      automationRevision: 4,
      requestedBy: "system" as const
    };
    const expected = chairAutomationJobId("meeting", "suggestion");
    queue.add.mockResolvedValueOnce({
      id: expected,
      getState: vi.fn(async () => "failed")
    });

    await expect(jobs.enqueueChairAutomation(input, expected)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("terminal or unsupported state")
    });
  });

  it("returns the requested job ID when BullMQ creates the job", async () => {
    const jobs = new BullAgentTurnQueue("redis://redis:6379");

    const result = await jobs.enqueue(agentTurn());

    expect(result).toEqual({ jobId: queue.add.mock.calls[0]![2].jobId });
  });

  it("derives one stable tool job ID from the Meeting and Idempotency-Key", async () => {
    const jobs = new BullAgentTurnQueue("redis://redis:6379");
    const requestedJobId = mcpToolJobId("meeting", "owner-submit-1");
    const input = {
      ...roleBinding,
      meetingId: "meeting",
      agentId: "agent",
      connectorId: "connector",
      toolName: "platform_status",
      toolSnapshot,
      connectorFingerprint: "connector-fingerprint",
      arguments: { query: "first" },
      requestedBy: "owner" as const
    };

    const first = await jobs.enqueueToolCall(input, requestedJobId);
    const retry = await jobs.enqueueToolCall(input, requestedJobId);

    expect(first).toEqual({ jobId: requestedJobId });
    expect(retry).toEqual(first);
    expect(requestedJobId).toMatch(/^meeting-tool-[a-f0-9]{40}$/);
    expect(queue.add.mock.calls.map((call) => call[2].jobId)).toEqual([requestedJobId, requestedJobId]);
  });

  it("uses a new job ID when the owner retries the same Chair suggestion", async () => {
    const jobs = new BullAgentTurnQueue("redis://redis:6379");
    const input = {
      ...agentTurn("chair"),
      chairSuggestionId: "suggestion",
    };

    const first = await jobs.enqueue(input);
    const second = await jobs.enqueue(input);

    expect(first.jobId).toMatch(/^meeting-chair-chair-suggestion-[0-9a-f-]{36}$/);
    expect(second.jobId).toMatch(/^meeting-chair-chair-suggestion-[0-9a-f-]{36}$/);
    expect(second.jobId).not.toBe(first.jobId);
    expect(queue.add.mock.calls.map((call) => call[2].jobId)).toEqual([first.jobId, second.jobId]);
  });

  it("uses the caller-reserved Agent turn job ID unchanged", async () => {
    const jobs = new BullAgentTurnQueue("redis://redis:6379");
    const requestedJobId = agentTurnJobId("meeting", "agent", "suggestion");

    await expect(jobs.enqueue(agentTurn(), requestedJobId)).resolves.toEqual({ jobId: requestedJobId });
    expect(queue.add.mock.calls[0]![2].jobId).toBe(requestedJobId);
  });

  it("uses a new job ID when the owner retries Task synchronization", async () => {
    const jobs = new BullAgentTurnQueue("redis://redis:6379");
    const input = { taskId: "task", adapterId: "adapter", requestedBy: "owner" as const };

    const first = await jobs.enqueueTaskSync(input);
    const second = await jobs.enqueueTaskSync(input);

    expect(first.jobId).toMatch(/^task-sync-[0-9a-f-]{36}$/);
    expect(second.jobId).toMatch(/^task-sync-[0-9a-f-]{36}$/);
    expect(second.jobId).not.toBe(first.jobId);
  });

  it("uses a new deduplicated job ID when a Meeting summary is retried", async () => {
    const jobs = new BullAgentTurnQueue("redis://redis:6379");
    const input = { meetingId: "meeting", requestedBy: "system" as const };

    const first = await jobs.enqueueMeetingSummary(input);
    const second = await jobs.enqueueMeetingSummary(input);

    expect(first.jobId).toMatch(/^meeting-summary-[0-9a-f-]{36}$/);
    expect(second.jobId).toMatch(/^meeting-summary-[0-9a-f-]{36}$/);
    expect(second.jobId).not.toBe(first.jobId);
  });

  it("throws a 409 conflict when an agent turn is deduplicated behind a tool call", async () => {
    const jobs = new BullAgentTurnQueue("redis://redis:6379");
    const existing = await jobs.enqueueToolCall({
      ...roleBinding,
      meetingId: "meeting",
      agentId: "agent",
      connectorId: "connector",
      toolName: "platform_status",
      toolSnapshot,
      connectorFingerprint: "connector-fingerprint",
      arguments: {},
      requestedBy: "owner"
    });
    queue.add.mockResolvedValueOnce({ id: existing.jobId });

    const enqueue = jobs.enqueue(agentTurn());

    await expect(enqueue).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("already has a queued or active action")
    });
  });

  it("throws a 409 conflict when a tool call is deduplicated behind an agent turn", async () => {
    const jobs = new BullAgentTurnQueue("redis://redis:6379");
    const existing = await jobs.enqueue(agentTurn());
    queue.add.mockResolvedValueOnce({ id: existing.jobId });

    const enqueue = jobs.enqueueToolCall({
      ...roleBinding,
      meetingId: "meeting",
      agentId: "agent",
      connectorId: "connector",
      toolName: "platform_status",
      toolSnapshot,
      connectorFingerprint: "connector-fingerprint",
      arguments: {},
      requestedBy: "owner"
    });

    await expect(enqueue).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("already has a queued or active action")
    });
  });

  it("rejects malformed execution bindings before writing to Redis", async () => {
    const jobs = new BullAgentTurnQueue("redis://redis:6379");
    const { runtimeRun: _runtimeRun, ...malformed } = agentTurn();

    await expect(jobs.enqueue(malformed)).rejects.toThrow();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
