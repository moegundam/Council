import { describe, expect, it } from "vitest";
import {
  agentTurnFailureDisposition,
  meetingActionFailureAttemptDisposition,
  mcpToolFailureDisposition,
  meetingSummaryFailureDisposition,
  queueOwnsJob,
  taskAgentRunFailureDisposition,
  taskSyncFailureDisposition
} from "./job-lifecycle.js";
import {
  StaleTaskAgentRunError,
  TaskAgentRunNotReadyError,
  TaskAgentRunOutcomeUnknownError
} from "./process-task-agent-run.js";
import {
  StaleTaskSyncError,
  TaskSyncNotReadyError,
  TaskSyncPayloadChangedError
} from "./process-task-sync.js";

describe("worker job lifecycle", () => {
  it("pauses only when the Agent turn itself did not persist", () => {
    expect(agentTurnFailureDisposition(false)).toBe("provider_or_runtime_failure");
    expect(agentTurnFailureDisposition(true)).toBe("event_delivery_failure");
  });

  it("marks a summary failed only when the summary itself did not persist", () => {
    expect(meetingSummaryFailureDisposition(false)).toBe("summary_failure");
    expect(meetingSummaryFailureDisposition(true)).toBe("event_delivery_failure");
  });

  it("does not convert a persisted Tool Run into a provider failure after event delivery fails", () => {
    expect(mcpToolFailureDisposition(false)).toBe("mcp_tool_failure");
    expect(mcpToolFailureDisposition(true)).toBe("event_delivery_failure");
  });

  it.each(["agent-turn", "mcp-tool-call"] as const)(
    "retries %s only after its durable result exists",
    (jobName) => {
      expect(meetingActionFailureAttemptDisposition(jobName, true, 0, 2)).toBe("retry_delivery");
      expect(meetingActionFailureAttemptDisposition(jobName, true, 1, 2)).toBe("terminal_failure");
      expect(meetingActionFailureAttemptDisposition(jobName, false, 0, 2)).toBe("terminal_failure");
    }
  );

  it("preserves ordinary retry attempts for Meeting summaries", () => {
    expect(meetingActionFailureAttemptDisposition("meeting-summary", false, 0, 3)).toBe("retry_delivery");
    expect(meetingActionFailureAttemptDisposition("meeting-summary", true, 1, 3)).toBe("retry_delivery");
    expect(meetingActionFailureAttemptDisposition("meeting-summary", true, 2, 3)).toBe("terminal_failure");
  });

  it("keeps Task Agent admission races out of terminal provider failures", () => {
    expect(taskAgentRunFailureDisposition(new TaskAgentRunNotReadyError())).toBe("retryable");
    expect(taskAgentRunFailureDisposition(new StaleTaskAgentRunError())).toBe("stale");
    expect(taskAgentRunFailureDisposition(new Error("provider failed"))).toBe("provider_or_runtime_failure");
  });

  it("persists a Task Agent provider failure only on the final BullMQ attempt", () => {
    const failure = new Error("temporary provider failure");

    expect(taskAgentRunFailureDisposition(failure, 0, 3)).toBe("retryable");
    expect(taskAgentRunFailureDisposition(failure, 1, 3)).toBe("retryable");
    expect(taskAgentRunFailureDisposition(failure, 2, 3)).toBe("provider_or_runtime_failure");
    expect(taskAgentRunFailureDisposition(failure, 0, undefined)).toBe("provider_or_runtime_failure");
  });

  it("fails closed immediately when a prior attempt crossed the provider boundary", () => {
    expect(taskAgentRunFailureDisposition(new TaskAgentRunOutcomeUnknownError(), 0, 3))
      .toBe("provider_outcome_unknown");
  });

  it("keeps Task sync admission and payload races out of terminal provider failures", () => {
    expect(taskSyncFailureDisposition(new TaskSyncNotReadyError())).toBe("retryable");
    expect(taskSyncFailureDisposition(new TaskSyncPayloadChangedError("changed-fingerprint"))).toBe("payload_churn");
    expect(taskSyncFailureDisposition(new StaleTaskSyncError())).toBe("stale");
    expect(taskSyncFailureDisposition(new Error("adapter failed"))).toBe("provider_or_runtime_failure");
  });

  it.each(["active", "delayed", "prioritized", "waiting", "waiting-children"])(
    "recognizes a BullMQ %s job as queue-owned",
    async (state) => {
      await expect(queueOwnsJob({
        getJob: async () => ({ getState: async () => state })
      }, "owned-job")).resolves.toBe(true);
    }
  );

  it.each(["completed", "failed", "unknown"])(
    "does not recognize a retained BullMQ %s job as queue-owned",
    async (state) => {
      await expect(queueOwnsJob({
        getJob: async () => ({ getState: async () => state })
      }, "terminal-job")).resolves.toBe(false);
    }
  );

  it("does not recognize a missing BullMQ job as queue-owned", async () => {
    await expect(queueOwnsJob({ getJob: async () => undefined }, "missing-job")).resolves.toBe(false);
  });

  it("propagates BullMQ state lookup failures instead of claiming ownership", async () => {
    const error = new Error("Redis unavailable");
    await expect(queueOwnsJob({
      getJob: async () => ({ getState: async () => { throw error; } })
    }, "unknown-job")).rejects.toBe(error);
  });
});
