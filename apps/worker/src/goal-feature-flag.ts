import { DelayedError, type Job } from "bullmq";

export const disabledGoalJobDelayMs = 60_000;

export function goalRunAutonomyEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.GOAL_RUN_AUTONOMY_ENABLED ?? (env.NODE_ENV === "production" ? "false" : "true");
  if (value !== "true" && value !== "false") {
    throw new Error("GOAL_RUN_AUTONOMY_ENABLED must be true or false.");
  }
  return value === "true";
}

export async function deferDisabledGoalJob(
  job: Pick<Job, "moveToDelayed" | "token">,
  now = Date.now()
): Promise<never> {
  await job.moveToDelayed(now + disabledGoalJobDelayMs, job.token);
  throw new DelayedError();
}
