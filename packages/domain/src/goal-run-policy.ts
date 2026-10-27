import { createHash, randomUUID } from "node:crypto";
import type {
  ExecutionContract,
  ExecutionActionBinding,
  ExecutionRuntimeBinding,
  GoalExecutionLimits,
  GoalExecutionUsage,
  GoalPlanTask,
  GoalRunState,
  GoalTaskBinding,
  ReviewerVerdict
} from "@council/contracts";

export type GoalRunAction =
  | "plan"
  | "plan_ready"
  | "approve"
  | "begin_review"
  | "complete"
  | "replan"
  | "pause"
  | "resume"
  | "fail"
  | "cancel";

const transitions: Record<GoalRunState, Partial<Record<GoalRunAction, GoalRunState>>> = {
  draft: { plan: "planning", cancel: "cancelled" },
  planning: { plan_ready: "awaiting_approval", pause: "paused", fail: "failed", cancel: "cancelled" },
  awaiting_approval: { approve: "executing", replan: "replanning", pause: "paused", cancel: "cancelled" },
  executing: { begin_review: "reviewing", replan: "replanning", pause: "paused", fail: "failed", cancel: "cancelled" },
  reviewing: { complete: "completed", replan: "replanning", pause: "paused", fail: "failed", cancel: "cancelled" },
  replanning: { plan_ready: "awaiting_approval", pause: "paused", fail: "failed", cancel: "cancelled" },
  paused: { resume: "executing", replan: "replanning", fail: "failed", cancel: "cancelled" },
  completed: {},
  failed: {},
  cancelled: {}
};

export function transitionGoalRun(state: GoalRunState, action: GoalRunAction): GoalRunState {
  const next = transitions[state][action];
  if (!next) throw new Error(`Invalid Goal Run transition: ${state} -> ${action}`);
  return next;
}

export function resumeGoalRunState(pausedFromState: GoalRunState | null): GoalRunState {
  if (!pausedFromState || !["planning", "awaiting_approval", "executing", "reviewing", "replanning"].includes(pausedFromState)) {
    throw new Error("Goal Run has no resumable prior state.");
  }
  return pausedFromState;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export function goalPlanDigest(tasks: readonly GoalPlanTask[]): string {
  return sha256(tasks);
}

export function actionAdapterEndpointDigest(baseUrl: string): string {
  return sha256({ baseUrl: normalizeActionAdapterEndpoint(baseUrl) });
}

export function normalizeActionAdapterEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username
    || url.password
    || url.hash
    || url.search) {
    throw new Error("Harness Action Adapter endpoints must be credential-free HTTP(S) URLs without query or fragment.");
  }
  return url.toString();
}

export function parseActionAdapterEndpointAllowlist(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(normalizeActionAdapterEndpoint);
}

export function createExecutionContract(input: {
  goalRunId: string;
  planRevision: number;
  tasks: readonly GoalPlanTask[];
  limits: GoalExecutionLimits;
  approvedBy: string;
  approvedAt?: string;
  actionBindings?: readonly ExecutionActionBinding[];
  runtimeBindings?: readonly ExecutionRuntimeBinding[];
}): ExecutionContract {
  const approvedAt = input.approvedAt ?? new Date().toISOString();
  const planSnapshot = structuredClone([...input.tasks]);
  const planDigest = goalPlanDigest(planSnapshot);
  const actionBindings = structuredClone([...(input.actionBindings ?? [])]);
  const runtimeBindings = structuredClone([...(input.runtimeBindings ?? [])]);
  const contractDigest = sha256({
    goalRunId: input.goalRunId,
    planRevision: input.planRevision,
    planDigest,
    limits: input.limits,
    actionBindings,
    runtimeBindings,
    approvedBy: input.approvedBy,
    approvedAt
  });
  return {
    id: randomUUID(),
    goalRunId: input.goalRunId,
    planRevision: input.planRevision,
    planDigest,
    contractDigest,
    approvedBy: input.approvedBy,
    approvedAt,
    limits: structuredClone(input.limits),
    planSnapshot,
    actionBindings,
    runtimeBindings
  };
}

export function goalBudgetFailureReason(input: {
  limits: GoalExecutionLimits;
  usage: GoalExecutionUsage;
  deadlineAt: string;
  now?: number;
}): string | null {
  if ((input.now ?? Date.now()) >= Date.parse(input.deadlineAt)) return "Goal Run duration budget was exhausted.";
  if (input.usage.discussionRounds > input.limits.discussionRounds) return "Discussion round budget was exhausted.";
  if (input.usage.replans > input.limits.maxReplans) return "Replan budget was exhausted.";
  if (input.usage.modelCalls > input.limits.maxModelCalls) return "Model call budget was exceeded.";
  if (input.usage.actionCalls > input.limits.maxActionCalls) return "Action call budget was exceeded.";
  return null;
}

export function goalBudgetReservationFailureReason(input: {
  limits: GoalExecutionLimits;
  usage: GoalExecutionUsage;
  increments: Partial<GoalExecutionUsage>;
  deadlineAt: string;
  now?: number;
}): string | null {
  if ((input.now ?? Date.now()) >= Date.parse(input.deadlineAt)) return "Goal Run duration budget was exhausted.";
  if (input.usage.discussionRounds + (input.increments.discussionRounds ?? 0) > input.limits.discussionRounds) {
    return "Discussion round budget would be exceeded.";
  }
  if (input.usage.replans + (input.increments.replans ?? 0) > input.limits.maxReplans) {
    return "Replan budget would be exceeded.";
  }
  if (input.usage.modelCalls + (input.increments.modelCalls ?? 0) > input.limits.maxModelCalls) {
    return "Model call budget would be exceeded.";
  }
  if (input.usage.actionCalls + (input.increments.actionCalls ?? 0) > input.limits.maxActionCalls) {
    return "Action call budget would be exceeded.";
  }
  return null;
}

export function readyGoalPlanTaskIds(
  tasks: readonly GoalPlanTask[],
  bindings: readonly GoalTaskBinding[]
): string[] {
  const stateByTask = new Map(bindings.map((binding) => [binding.planTaskId, binding.state]));
  return tasks
    .filter((task) => {
      const state = stateByTask.get(task.id);
      if (state !== "waiting" && state !== "ready") return false;
      return task.dependencyIds.every((dependencyId) => stateByTask.get(dependencyId) === "completed");
    })
    .map((task) => task.id);
}

export function assertIndependentReviewQuorum(
  verdicts: readonly ReviewerVerdict[],
  excludedAgentIds: readonly string[]
): void {
  if (verdicts.length !== 2) throw new Error("Exactly two Reviewer verdicts are required.");
  if (verdicts.some((verdict) => verdict.verdict !== "pass")) {
    throw new Error("Both Reviewer verdicts must pass.");
  }
  if (verdicts[0]?.contractDigest !== verdicts[1]?.contractDigest) {
    throw new Error("Reviewer verdicts must cover the same Execution Contract.");
  }
  if (verdicts[0]?.reviewerAgentId === verdicts[1]?.reviewerAgentId) {
    throw new Error("Reviewer Agents must be different.");
  }
  if (verdicts[0]?.modelConnectorId === verdicts[1]?.modelConnectorId) {
    throw new Error("Reviewer Model Connectors must be different.");
  }
  if (verdicts.some((verdict) => excludedAgentIds.includes(verdict.reviewerAgentId))) {
    throw new Error("Task executors and Planners are excluded from review.");
  }
}
