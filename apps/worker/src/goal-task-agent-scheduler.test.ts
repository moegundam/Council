import { describe, expect, it, vi } from "vitest";
import type { PlatformSnapshot, Task } from "@council/contracts";
import { prepareGoalTaskAgent } from "./goal-task-agent-scheduler.js";

describe("prepareGoalTaskAgent", () => {
  it("passes the current OMP isolation attestation into Agent readiness", async () => {
    const taskId = "70000000-0000-4000-8000-000000000301";
    const agentId = "70000000-0000-4000-8000-000000000302";
    const decisionId = "70000000-0000-4000-8000-000000000303";
    const meetingId = "70000000-0000-4000-8000-000000000304";
    const stopAfterReadiness = new Error("stop after readiness");
    const task = {
      id: taskId,
      decisionId,
      meetingId,
      assigneeAgentId: agentId,
      executionProfile: "worker",
      approvalState: "approved",
      status: "todo",
      execution: {
        status: "idle",
        revision: 0,
        attemptCount: 0,
        jobId: null,
        agentId: null,
        profile: null,
        requestFingerprint: null
      }
    } as unknown as Task;
    const snapshot = {
      tasks: [task],
      decisions: [{ id: decisionId, meetingId, status: "approved" }],
      agents: [{ id: agentId, lifecycleStatus: "published", publishedRevision: 1 }]
    } as unknown as PlatformSnapshot;
    const getAgentReadiness = vi.fn(async (
      _id: string,
      options?: { executionIsolationAttested?: boolean }
    ) => options?.executionIsolationAttested
      ? { status: "ready" as const, checks: [] }
      : {
          status: "blocked" as const,
          checks: [{ code: "runtime" as const, status: "blocked" as const, message: "Isolation unattested." }]
        });
    const store = {
      getSnapshot: vi.fn(async () => snapshot),
      getAgentReadiness,
      getAgentRevision: vi.fn(async () => { throw stopAfterReadiness; }),
      getRuntimeRun: vi.fn(),
      markTaskAgentRunQueued: vi.fn()
    };

    await expect(prepareGoalTaskAgent({
      store,
      taskId,
      jobId: "goal-task-omp-attestation",
      executionIsolationAttested: true
    })).rejects.toBe(stopAfterReadiness);

    expect(getAgentReadiness).toHaveBeenCalledWith(agentId, {
      executionIsolationAttested: true
    });
    expect(store.getAgentRevision).toHaveBeenCalledTimes(1);
  });
});
