import { describe, expect, it } from "vitest";
import { goalExecutionLimitsSchema } from "@council/contracts";
import type { Pool, PoolClient } from "pg";
import { PostgresGoalRunRepository } from "./goal-run-postgres.js";

describe("Postgres Goal Run detail loading", () => {
  it("never overlaps queries on one checked-out PoolClient", async () => {
    const now = "2026-08-29T00:00:00.000Z";
    const goalRunId = "10000000-0000-4000-8000-000000000001";
    let inFlight = 0;
    let overlapped = false;
    let released = false;
    const query = async (statement: string) => {
      if (inFlight > 0) overlapped = true;
      inFlight += 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      if (/FROM goal_runs WHERE id/.test(statement)) {
        return {
          rows: [{
            id: goalRunId,
            title: "Sequential detail load",
            goal: "Do not overlap PostgreSQL queries on one client.",
            threadId: "10000000-0000-4000-8000-000000000002",
            meetingId: "10000000-0000-4000-8000-000000000003",
            state: "planning",
            revision: 1,
            activePlanRevision: 0,
            executionContractId: null,
            limits: goalExecutionLimitsSchema.parse({}),
            usage: { discussionRounds: 0, taskAttempts: 0, replans: 0, modelCalls: 0, actionCalls: 0 },
            deadlineAt: "2026-08-29T02:00:00.000Z",
            pausedFromState: null,
            terminalReason: null,
            createdBy: "10000000-0000-4000-8000-000000000004",
            createdAt: now,
            updatedAt: now
          }]
        };
      }
      return { rows: [] };
    };
    const client = {
      query,
      release: () => { released = true; }
    } as unknown as PoolClient;
    const pool = {
      connect: async () => client
    } as unknown as Pool;

    const detail = await new PostgresGoalRunRepository(pool).getGoalRunDetail(goalRunId);

    expect(detail?.goalRun.id).toBe(goalRunId);
    expect(overlapped).toBe(false);
    expect(released).toBe(true);
  });
});
