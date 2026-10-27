import type { RuntimeControlJobData, RuntimeRun } from "@council/contracts";
import type { PlatformStore } from "@council/database";

export interface OmpRuntimeController {
  control(input: {
    runtimeRun: RuntimeRun;
    action: RuntimeControlJobData["action"];
    commandRevision: number;
    idempotencyKey: string;
    message?: string;
  }): Promise<{
    providerSessionId?: string;
    leaseId?: string;
    eventCursor?: number;
  }>;
}

export class RuntimeControlPendingCommitError extends Error {
  constructor() {
    super("Runtime control job is waiting for its API state commit.");
    this.name = "RuntimeControlPendingCommitError";
  }
}

export class StaleRuntimeControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleRuntimeControlError";
  }
}

type RuntimeControlStore = Pick<PlatformStore,
  | "appendRuntimeRunEvent"
  | "getRuntimeRun"
  | "updateRuntimeRun"
>;

export async function processRuntimeControl(input: {
  store: RuntimeControlStore;
  data: RuntimeControlJobData;
  controller: OmpRuntimeController;
}): Promise<"applied" | "replayed"> {
  const run = await input.store.getRuntimeRun(input.data.runtimeRunId);
  if (!run) throw new StaleRuntimeControlError("Runtime Run no longer exists.");
  if (run.runtimeProfile.harnessKind !== "pi") {
    throw new StaleRuntimeControlError("Runtime control is restricted to OMP Runtime Runs.");
  }
  if (run.revision < input.data.commandRevision) throw new RuntimeControlPendingCommitError();
  if (run.revision > input.data.commandRevision) return "replayed";

  const expectedState = input.data.action === "pause"
    ? "paused"
    : input.data.action === "resume"
      ? "provisioning"
      : input.data.action === "cancel"
        ? "cancelled"
        : "running";
  if (run.state !== expectedState) {
    throw new StaleRuntimeControlError(`Runtime control ${input.data.action} no longer matches state ${run.state}.`);
  }

  const result = await input.controller.control({
    runtimeRun: run,
    action: input.data.action,
    commandRevision: input.data.commandRevision,
    idempotencyKey: `runtime-control:${run.id}:${input.data.commandRevision}`,
    ...(input.data.message === undefined ? {} : { message: input.data.message })
  });
  const now = new Date().toISOString();
  if (input.data.action === "resume") {
    await input.store.updateRuntimeRun(run.id, {
      expectedRevision: run.revision,
      state: "ready",
      at: now,
      ...(result.providerSessionId ? { providerSessionId: result.providerSessionId } : {}),
      ...(result.leaseId ? { leaseId: result.leaseId } : {}),
      heartbeatAt: now,
      event: {
        type: "state.changed",
        phase: "ready",
        summary: "OMP Session resumed and is ready to continue.",
        toolName: null,
        progressPercent: null,
        usage: null,
        errorCode: null,
        actorType: "system",
        occurredAt: now
      }
    });
    return "applied";
  }

  await input.store.appendRuntimeRunEvent(run.id, {
    type: "owner.action",
    phase: input.data.action === "cancel" ? "completed" : input.data.action === "pause" ? "paused" : "executing",
    summary: input.data.action === "steer"
      ? "Owner guidance was delivered to the OMP Session."
      : `Owner ${input.data.action} command was acknowledged by the OMP Broker.`,
    toolName: null,
    progressPercent: null,
    usage: null,
    errorCode: null,
    actorType: "system",
    occurredAt: now
  });
  return "applied";
}
