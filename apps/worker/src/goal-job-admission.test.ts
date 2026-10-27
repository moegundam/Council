import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { GoalRun } from "@council/contracts";
import type { GoalJobAdmission } from "@council/database";
import { InMemoryPlatformStore, requestFingerprint } from "@council/database";
import { createSeedSnapshot } from "@council/database/seed";
import { beginGoalJob } from "./goal-job-admission.js";

const ownerId = "30000000-0000-4000-8000-000000000001";
const createdAt = "2026-08-28T00:00:00.000Z";

async function admissionFixture() {
  const seed = createSeedSnapshot();
  const store = new InMemoryPlatformStore(seed);
  const meeting = seed.meetings[0]!;
  const goalRun: GoalRun = {
    id: randomUUID(),
    title: "Durable queue admission",
    goal: "Accept only work admitted by a trusted producer.",
    threadId: meeting.threadId,
    meetingId: meeting.id,
    state: "planning",
    revision: 1,
    activePlanRevision: 0,
    executionContractId: null,
    limits: {
      discussionRounds: 3,
      maxTasks: 12,
      maxConcurrentTasks: 2,
      maxAttemptsPerTask: 3,
      maxReplans: 2,
      maxDurationMinutes: 120,
      maxModelCalls: 60,
      maxActionCalls: 30
    },
    usage: { discussionRounds: 0, taskAttempts: 0, replans: 0, modelCalls: 0, actionCalls: 0 },
    deadlineAt: "2026-08-28T02:00:00.000Z",
    pausedFromState: null,
    terminalReason: null,
    createdBy: ownerId,
    createdAt,
    updatedAt: createdAt
  };
  await store.createGoalRun(goalRun, {
    type: "goal.created",
    actorType: "owner",
    actorId: ownerId,
    entityType: "goal",
    entityId: goalRun.id,
    summary: "Goal Run created."
  }, `goal:${goalRun.id}`);

  const jobId = `goal-plan-${goalRun.id}`;
  const fingerprint = requestFingerprint({ goalRunId: goalRun.id, requestedBy: "system" });
  const admission: GoalJobAdmission = {
    jobId,
    goalRunId: goalRun.id,
    jobName: "goal-plan",
    entityId: goalRun.id,
    requestFingerprint: fingerprint,
    state: "reserved",
    reservedAt: createdAt,
    admittedAt: null,
    startedAt: null,
    settledAt: null,
    updatedAt: createdAt
  };
  const input = {
    store,
    jobId,
    goalRunId: goalRun.id,
    jobName: "goal-plan" as const,
    entityId: goalRun.id,
    requestFingerprint: fingerprint
  };
  return { store, admission, input };
}

describe("Goal job execution admission", () => {
  it("rejects a queue job without a pre-existing durable admission", async () => {
    const { store, input } = await admissionFixture();

    await expect(beginGoalJob(input)).rejects.toThrow("Goal job admission was not found");
    await expect(store.getGoalJobAdmission(input.jobId)).resolves.toBeNull();
  });

  it("rejects a queue job whose envelope does not match the durable admission", async () => {
    const { store, admission, input } = await admissionFixture();
    await store.reserveGoalJob(admission);

    await expect(beginGoalJob({ ...input, entityId: randomUUID() }))
      .rejects.toThrow("already bound to a different execution request");
    await expect(store.getGoalJobAdmission(input.jobId)).resolves.toMatchObject({ state: "reserved" });
  });

  it("advances a trusted pre-existing admission to running", async () => {
    const { store, admission, input } = await admissionFixture();
    await store.reserveGoalJob(admission);

    await expect(beginGoalJob(input)).resolves.toMatchObject({
      status: "run",
      admission: { jobId: input.jobId, state: "running" }
    });
    await expect(store.getGoalJobAdmission(input.jobId)).resolves.toMatchObject({ state: "running" });
  });

  it("accepts a trusted dispatch lease when the Worker wins the enqueue handoff", async () => {
    const { store, admission, input } = await admissionFixture();
    await store.reserveGoalJob(admission);
    await store.claimGoalJobDispatch(input.jobId, {
      dispatchToken: "trusted-producer-dispatch",
      now: createdAt,
      leaseDurationMs: 30_000
    });

    await expect(beginGoalJob(input)).resolves.toMatchObject({
      status: "run",
      admission: { jobId: input.jobId, state: "running" }
    });
  });

  it("keeps a fenced replay fail-closed", async () => {
    const { store, admission, input } = await admissionFixture();
    await store.reserveGoalJob(admission);
    await beginGoalJob(input);

    await expect(beginGoalJob({ ...input, runningReplay: "fence" })).resolves.toMatchObject({
      status: "outcome_unknown",
      admission: { state: "running" }
    });
  });
});
