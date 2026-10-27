import { describe, expect, it, vi } from "vitest";
import { InMemoryPlatformStore } from "@council/database";
import type { AgentTurnQueue } from "./agent-queue.js";
import { createApp } from "./app.js";
import { MeetingEventBus, type MeetingEvent } from "./event-bus.js";

describe("Decision and Task meeting events", () => {
  it("publishes bounded refresh events for committed Decision and Task changes", async () => {
    const store = new InMemoryPlatformStore();
    const meeting = (await store.getSnapshot()).meetings[0]!;
    const eventBus = new MeetingEventBus();
    const events: MeetingEvent[] = [];
    const unsubscribe = await eventBus.subscribe(meeting.id, (event) => events.push(event));
    const app = await createApp({ store, authDisabled: true, eventBus });

    try {
      const decisionResponse = await app.inject({
        method: "POST",
        url: "/api/decisions",
        headers: { "idempotency-key": "cross-client-decision" },
        payload: {
          meetingId: meeting.id,
          title: "Cross-client Decision",
          description: "Every open Meeting client must reconcile."
        }
      });
      const decision = decisionResponse.json();
      const approved = await app.inject({
        method: "POST",
        url: `/api/decisions/${decision.id}/approve`
      });
      const taskResponse = await app.inject({
        method: "POST",
        url: "/api/tasks",
        headers: { "idempotency-key": "cross-client-task" },
        payload: {
          decisionId: decision.id,
          title: "Cross-client Task",
          description: "Refresh every open Task board.",
          assignee: null
        }
      });
      const task = taskResponse.json();
      const updated = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${task.id}`,
        payload: {
          expectedRevision: task.revision,
          expectedExecutionRevision: task.execution.revision,
          description: "Refresh every open Task board after edits."
        }
      });
      const evidence = await app.inject({
        method: "POST",
        url: `/api/tasks/${task.id}/evidence`,
        headers: { "idempotency-key": "cross-client-task-evidence" },
        payload: { type: "note", label: "Event proof", reference: "Bounded refresh event observed." }
      });
      const currentTask = evidence.json();
      const moved = await app.inject({
        method: "PATCH",
        url: `/api/tasks/${task.id}/status`,
        payload: {
          status: "in_progress",
          position: 0,
          expectedBoardRevision: currentTask.boardRevision,
          expectedExecutionRevision: currentTask.execution.revision
        }
      });
      const approvalDecision = await store.createDecision({
        meetingId: meeting.id,
        title: "Approval event Decision",
        description: "Own the approval event Task."
      });
      await store.setDecisionStatus(approvalDecision.id, "approved");
      const workerTaskResponse = await app.inject({
        method: "POST",
        url: "/api/tasks",
        headers: { "idempotency-key": "approval-event-task" },
        payload: {
          decisionId: approvalDecision.id,
          title: "Approval event Task",
          description: "Publish approval state changes.",
          assignee: null,
          acceptanceCriteria: "Approval is visible across clients.",
          executionProfile: "worker",
          allowedTools: ["task.upsert"],
          dataScope: "Decision only",
          approvalState: "pending"
        }
      });
      expect(workerTaskResponse.statusCode).toBe(201);
      const workerTask = workerTaskResponse.json();
      const approval = await app.inject({
        method: "POST",
        url: `/api/tasks/${workerTask.id}/approval`,
        payload: { expectedExecutionRevision: workerTask.execution.revision, action: "approve" }
      });

      expect(decisionResponse.statusCode).toBe(201);
      expect(approved.statusCode).toBe(200);
      expect(taskResponse.statusCode).toBe(201);
      expect(updated.statusCode).toBe(200);
      expect(evidence.statusCode).toBe(201);
      expect(moved.statusCode).toBe(200);
      expect(approval.statusCode).toBe(200);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "decision.changed",
          meetingId: meeting.id,
          data: { decisionId: decision.id, status: "proposed", action: "created" }
        }),
        expect.objectContaining({
          type: "decision.changed",
          meetingId: meeting.id,
          data: { decisionId: decision.id, status: "approved", action: "approved" }
        }),
        expect.objectContaining({
          type: "task.changed",
          meetingId: meeting.id,
          data: { taskId: task.id, status: "todo", action: "created" }
        }),
        expect.objectContaining({
          type: "task.changed",
          meetingId: meeting.id,
          data: { taskId: task.id, status: "todo", action: "updated" }
        }),
        expect.objectContaining({
          type: "task.changed",
          meetingId: meeting.id,
          data: { taskId: task.id, status: "todo", action: "evidence_added" }
        }),
        expect.objectContaining({
          type: "task.changed",
          meetingId: meeting.id,
          data: { taskId: task.id, status: "in_progress", action: "status_changed" }
        }),
        expect.objectContaining({
          type: "task.changed",
          meetingId: meeting.id,
          data: { taskId: workerTask.id, status: "todo", action: "approval_changed" }
        })
      ]));
      for (const event of events.filter((item) => item.type === "decision.changed" || item.type === "task.changed")) {
        expect(event.data).not.toHaveProperty("title");
        expect(event.data).not.toHaveProperty("description");
      }
    } finally {
      unsubscribe();
      await eventBus.close();
      await app.close();
    }
  });

  it("publishes Task reservation and failure invalidations for Agent runs and synchronization", async () => {
    const store = new InMemoryPlatformStore();
    const seed = await store.getSnapshot();
    const meeting = seed.meetings[0]!;
    const agent = seed.agents[0]!;
    const connector = await store.createModelConnector({
      name: "Task event model",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "task-event-model"
    });
    const prompt = await store.createPrompt({
      name: "Task event prompt",
      kind: "agent",
      description: "Exercise Task invalidation events.",
      owner: "Test Owner",
      content: "Return bounded evidence.",
      variables: []
    });
    await store.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 });
    const agentDraft = await store.updateAgent(agent.id, {
      modelConnectorId: connector.id,
      promptBinding: { promptId: prompt.id, version: 1 }
    });
    await store.publishAgent(agent.id, { expectedDraftRevision: agentDraft.draftRevision! });
    const decision = await store.createDecision({
      meetingId: meeting.id,
      title: "Invalidate every Task client",
      description: "Both queue admission and failure are visible."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const agentTask = await store.createTask({
      decisionId: decision.id,
      title: "Run the Agent",
      assigneeAgentId: agent.id,
      executionProfile: "advisor"
    });
    const syncDecision = await store.createDecision({
      meetingId: meeting.id,
      title: "Invalidate Task sync clients",
      description: "Queue admission and failure are visible."
    });
    await store.setDecisionStatus(syncDecision.id, "approved");
    const syncTask = await store.createTask({
      decisionId: syncDecision.id,
      title: "Sync the Task"
    });
    const adapter = await store.createTaskAdapterConnector({
      name: "Task event adapter",
      location: "local",
      baseUrl: "http://task-adapter-reference:4200"
    });
    const agentQueue: AgentTurnQueue = {
      enqueue: vi.fn(async () => ({ jobId: "agent-job" })),
      enqueueToolCall: vi.fn(async () => ({ jobId: "tool-job" })),
      enqueueMeetingSummary: vi.fn(async () => ({ jobId: "summary-job" })),
      enqueueTaskAgentRun: vi.fn(async () => {
        throw new Error("Task Agent queue unavailable");
      }),
      enqueueTaskSync: vi.fn(async () => {
        throw new Error("Task sync queue unavailable");
      }),
      getJobState: vi.fn(async () => null),
      close: vi.fn(async () => undefined)
    };
    const eventBus = new MeetingEventBus();
    const events: MeetingEvent[] = [];
    const unsubscribe = await eventBus.subscribe(meeting.id, (event) => events.push(event));
    const app = await createApp({ store, authDisabled: true, agentQueue, eventBus });

    try {
      const run = await app.inject({
        method: "POST",
        url: `/api/tasks/${agentTask.id}/run`,
        headers: { "idempotency-key": "task-event-run" },
        payload: { expectedExecutionRevision: agentTask.execution.revision }
      });
      const currentSyncTask = (await store.getSnapshot()).tasks.find((task) => task.id === syncTask.id)!;
      const sync = await app.inject({
        method: "POST",
        url: `/api/tasks/${syncTask.id}/sync`,
        payload: {
          adapterId: adapter.id,
          expectedRevision: currentSyncTask.revision,
          expectedStatus: currentSyncTask.status,
          expectedApprovalState: currentSyncTask.approvalState,
          expectedSyncAttemptCount: currentSyncTask.sync.attemptCount
        }
      });

      expect(run.statusCode).toBe(503);
      expect(sync.statusCode).toBe(503);
      expect(events.filter((event) => event.type === "task.changed").map((event) => event.data))
        .toEqual(expect.arrayContaining([
          { taskId: agentTask.id, status: "todo", action: "agent_run_queued" },
          { taskId: agentTask.id, status: "todo", action: "agent_run_failed" },
          { taskId: syncTask.id, status: "todo", action: "sync_queued" },
          { taskId: syncTask.id, status: "todo", action: "sync_failed" }
        ]));
      for (const event of events.filter((item) => item.type === "task.changed")) {
        expect(event.data).not.toHaveProperty("title");
        expect(event.data).not.toHaveProperty("description");
      }
    } finally {
      unsubscribe();
      await eventBus.close();
      await app.close();
    }
  });
});
