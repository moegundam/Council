import { describe, expect, it, vi } from "vitest";
import { DelayedError } from "bullmq";
import { deferDisabledGoalJob, disabledGoalJobDelayMs, goalRunAutonomyEnabledFromEnv } from "./goal-feature-flag.js";

describe("Goal Run autonomy Worker rollout", () => {
  it("defaults off in production and on outside production", () => {
    expect(goalRunAutonomyEnabledFromEnv({ NODE_ENV: "production" })).toBe(false);
    expect(goalRunAutonomyEnabledFromEnv({ NODE_ENV: "test" })).toBe(true);
  });

  it("accepts only an explicit strict boolean override", () => {
    expect(goalRunAutonomyEnabledFromEnv({ NODE_ENV: "production", GOAL_RUN_AUTONOMY_ENABLED: "true" })).toBe(true);
    expect(goalRunAutonomyEnabledFromEnv({ NODE_ENV: "development", GOAL_RUN_AUTONOMY_ENABLED: "false" })).toBe(false);
    expect(() => goalRunAutonomyEnabledFromEnv({ GOAL_RUN_AUTONOMY_ENABLED: "1" })).toThrow(/true or false/i);
  });

  it("keeps a queued Goal job delayed instead of silently completing it while disabled", async () => {
    const moveToDelayed = vi.fn(async () => undefined);
    await expect(deferDisabledGoalJob({ moveToDelayed, token: "worker-token" } as never, 1_000))
      .rejects.toBeInstanceOf(DelayedError);
    expect(moveToDelayed).toHaveBeenCalledWith(1_000 + disabledGoalJobDelayMs, "worker-token");
  });
});
