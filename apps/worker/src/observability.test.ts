import { describe, expect, it } from "vitest";
import {
  createWorkerObservability,
  type WorkerJobLog,
  type WorkerLogEntry
} from "./observability.js";

describe("Worker observability", () => {
  it("logs bounded job correlation and duration without serializing the payload", async () => {
    const logs: WorkerLogEntry[] = [];
    const clock = [20, 45.25];
    const observability = createWorkerObservability({
      emit: (entry) => logs.push(entry),
      now: () => clock.shift() ?? 45.25,
      timestamp: () => "2026-08-09T00:00:00.000Z"
    });

    await observability.observeJob({
      jobId: "job-42",
      jobName: "mcp-tool-call",
      attempt: 2,
      payload: {
        contractVersion: 1,
        name: "mcp-tool-call",
        data: {
          meetingId: "meeting-7",
          connectorId: "connector-3",
          arguments: { token: "payload-secret" },
          toolSnapshot: { inputSchema: { secret: "schema-secret" } }
        }
      }
    }, async () => undefined);

    expect(logs).toEqual([
      {
        timestamp: "2026-08-09T00:00:00.000Z",
        level: "info",
        service: "worker",
        event: "worker.job.started",
        jobId: "job-42",
        jobName: "mcp-tool-call",
        attempt: 2,
        meetingId: "meeting-7",
        resourceId: "connector-3",
        resourceType: "mcp_connector"
      },
      {
        timestamp: "2026-08-09T00:00:00.000Z",
        level: "info",
        service: "worker",
        event: "worker.job.completed",
        jobId: "job-42",
        jobName: "mcp-tool-call",
        attempt: 2,
        meetingId: "meeting-7",
        resourceId: "connector-3",
        resourceType: "mcp_connector",
        durationMs: 25.25
      }
    ] satisfies WorkerJobLog[]);
    expect(JSON.stringify(logs)).not.toContain("payload-secret");
    expect(JSON.stringify(logs)).not.toContain("schema-secret");
    expect(JSON.stringify(logs)).not.toContain("arguments");
  });

  it("correlates task and runtime IDs and classifies failures without logging error details", async () => {
    const logs: WorkerLogEntry[] = [];
    const clock = [10, 18];
    const observability = createWorkerObservability({
      emit: (entry) => logs.push(entry),
      now: () => clock.shift() ?? 18,
      timestamp: () => "2026-08-09T00:00:00.000Z"
    });
    const failure = Object.assign(new Error("provider token=error-secret"), { code: "ECONNREFUSED" });

    await expect(observability.observeJob({
      jobId: "job-99",
      jobName: "task-agent-run",
      attempt: 1,
      payload: {
        taskId: "task-4",
        runtimeRun: { id: "run-8" },
        modelConnectorBinding: { id: "model-2", apiKey: "binding-secret" }
      }
    }, async () => {
      throw failure;
    })).rejects.toBe(failure);

    expect(logs[1]).toEqual({
      timestamp: "2026-08-09T00:00:00.000Z",
      level: "error",
      service: "worker",
      event: "worker.job.failed",
      jobId: "job-99",
      jobName: "task-agent-run",
      attempt: 1,
      taskId: "task-4",
      runId: "run-8",
      resourceId: "model-2",
      resourceType: "model_connector",
      durationMs: 8,
      errorClassification: "dependency_unavailable",
      errorType: "Error"
    });
    expect(JSON.stringify(logs)).not.toContain("error-secret");
    expect(JSON.stringify(logs)).not.toContain("binding-secret");
  });

  it("keeps logging failures from changing job outcomes", async () => {
    const observability = createWorkerObservability({ emit: () => { throw new Error("sink unavailable"); } });
    await expect(observability.observeJob({
      jobId: "job-1",
      jobName: "meeting-summary",
      attempt: 1,
      payload: { meetingId: "meeting-1" }
    }, async () => "result")).resolves.toBe("result");
  });

  it("logs shadow governance initialization failure without provider details", () => {
    const logs: WorkerLogEntry[] = [];
    const observability = createWorkerObservability({
      emit: (entry) => logs.push(entry),
      timestamp: () => "2026-08-24T00:00:00.000Z"
    });

    observability.logOperationalError(
      "governance.provider.initialization.failed",
      new Error("policy path included secret-provider-detail"),
      { resourceId: "microsoft_acs", resourceType: "governance_provider" }
    );

    expect(logs).toEqual([{
      timestamp: "2026-08-24T00:00:00.000Z",
      level: "error",
      service: "worker",
      event: "governance.provider.initialization.failed",
      resourceId: "microsoft_acs",
      resourceType: "governance_provider",
      errorClassification: "provider_or_runtime_failure",
      errorType: "Error"
    }]);
    expect(JSON.stringify(logs)).not.toContain("secret-provider-detail");
  });

  it("logs bounded startup recovery counts without job payloads", () => {
    const logs: WorkerLogEntry[] = [];
    const observability = createWorkerObservability({
      emit: (entry) => logs.push(entry),
      timestamp: () => "2026-08-09T00:00:00.000Z"
    });

    observability.logAsyncStateRecovery({
      checkedJobs: 4,
      preservedJobs: 1,
      deferredTaskRuns: 1,
      deferredTaskSyncs: 1,
      deferredSpeakerTurns: 0,
      failedTaskRuns: 1,
      failedTaskSyncs: 1,
      failedMeetingSummaries: 1,
      requeuedMeetingSummaries: 1,
      deferredMeetingSummaries: 1,
      releasedSpeakerTurns: 1,
      releasedChairSuggestions: 1,
      requiredChairAutomationReconciliations: 1
    });

    expect(logs).toEqual([{
      timestamp: "2026-08-09T00:00:00.000Z",
      level: "info",
      service: "worker",
      event: "worker.async_state.recovered",
      checkedJobs: 4,
      preservedJobs: 1,
      deferredTaskRuns: 1,
      deferredTaskSyncs: 1,
      deferredSpeakerTurns: 0,
      failedTaskRuns: 1,
      failedTaskSyncs: 1,
      failedMeetingSummaries: 1,
      requeuedMeetingSummaries: 1,
      deferredMeetingSummaries: 1,
      releasedSpeakerTurns: 1,
      releasedChairSuggestions: 1,
      requiredChairAutomationReconciliations: 1
    }]);
  });

  it("logs only bounded Meeting Record backfill counts", () => {
    const logs: WorkerLogEntry[] = [];
    const observability = createWorkerObservability({
      emit: (entry) => logs.push(entry),
      timestamp: () => "2026-08-29T00:00:00.000Z"
    });

    observability.logMeetingRecordBackfill({
      closedMeetings: 15,
      existingRecords: 1,
      createdRecords: 14
    });

    expect(logs).toEqual([{
      timestamp: "2026-08-29T00:00:00.000Z",
      level: "info",
      service: "worker",
      event: "worker.meeting_records.backfilled",
      closedMeetings: 15,
      existingRecords: 1,
      createdRecords: 14
    }]);
  });
});
