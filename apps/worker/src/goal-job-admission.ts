import type { GoalJobAdmission, GoalJobAdmissionState, PlatformStore } from "@council/database";

export type GoalJobAdmissionStore = Pick<PlatformStore,
  | "claimGoalJobDispatch"
  | "completeGoalJobDispatch"
  | "getGoalJobAdmission"
  | "reserveGoalJob"
  | "setGoalJobState"
>;

export type GoalJobName = GoalJobAdmission["jobName"];

export interface BeginGoalJobInput {
  store: GoalJobAdmissionStore;
  jobId: string;
  goalRunId: string;
  jobName: GoalJobName;
  entityId: string;
  requestFingerprint: string;
  runningReplay?: "resume" | "fence";
}

export type BeginGoalJobResult =
  | { status: "run"; admission: GoalJobAdmission }
  | { status: "settled"; admission: GoalJobAdmission }
  | { status: "outcome_unknown"; admission: GoalJobAdmission };

function assertAdmissionIdentity(admission: GoalJobAdmission, input: BeginGoalJobInput): void {
  if (admission.goalRunId !== input.goalRunId
    || admission.jobName !== input.jobName
    || admission.entityId !== input.entityId
    || admission.requestFingerprint !== input.requestFingerprint) {
    throw new Error("Goal job ID is already bound to a different execution request.");
  }
}

async function advance(
  store: GoalJobAdmissionStore,
  admission: GoalJobAdmission,
  from: GoalJobAdmissionState,
  to: GoalJobAdmissionState
): Promise<GoalJobAdmission> {
  if (admission.state !== from) return admission;
  return store.setGoalJobState(admission.jobId, from, to);
}

/**
 * Durable admission is intentionally separate from BullMQ visibility. A replay
 * may resume non-effecting work, but callers must fence an effecting job whose
 * previous delivery was already marked running.
 */
export async function beginGoalJob(input: BeginGoalJobInput): Promise<BeginGoalJobResult> {
  let admission = await input.store.getGoalJobAdmission(input.jobId);
  if (!admission) throw new Error("Goal job admission was not found.");
  assertAdmissionIdentity(admission, input);
  if (admission.state === "dispatching") {
    if (!admission.dispatchToken) throw new Error("Goal job dispatch lease is missing its ownership token.");
    admission = await input.store.completeGoalJobDispatch(admission.jobId, admission.dispatchToken);
  }
  if (admission.state === "settled") return { status: "settled", admission };
  if (admission.state === "outcome_unknown") return { status: "outcome_unknown", admission };
  if (admission.state === "running" && input.runningReplay === "fence") {
    return { status: "outcome_unknown", admission };
  }
  admission = await advance(input.store, admission, "reserved", "admitted");
  admission = await advance(input.store, admission, "admitted", "running");
  if (admission.state !== "running") {
    if (admission.state === "settled") return { status: "settled", admission };
    return { status: "outcome_unknown", admission };
  }
  return { status: "run", admission };
}

export async function settleGoalJob(store: GoalJobAdmissionStore, admission: GoalJobAdmission): Promise<void> {
  if (admission.state === "running") await store.setGoalJobState(admission.jobId, "running", "settled");
  if (admission.state === "outcome_unknown") await store.setGoalJobState(admission.jobId, "outcome_unknown", "settled");
}

export async function fenceGoalJobOutcome(store: GoalJobAdmissionStore, admission: GoalJobAdmission): Promise<void> {
  if (admission.state === "running") await store.setGoalJobState(admission.jobId, "running", "outcome_unknown");
}
