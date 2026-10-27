import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  runtimeRunControlSchema,
  runtimeRunEventSchema,
  runtimeRunSchema,
  runtimeRunSteerSchema,
  type RuntimeControlAction,
  type RuntimeRun
} from "@council/contracts";
import type { PlatformStore } from "@council/database";
import { runtimeControlJobId } from "../agent-queue.js";
import { parse, parseResponse, sendError, type AppOptionsFor } from "../route-support.js";

const runtimeRunRouteStoreMethods = [
  "getRuntimeRun",
  "getRuntimeRunForTask",
  "getRuntimeRunEvents",
  "updateRuntimeRun"
] as const satisfies readonly (keyof PlatformStore)[];

type RuntimeRunRouteStoreMethod = (typeof runtimeRunRouteStoreMethods)[number];
export type RuntimeRunRouteOptions = AppOptionsFor<RuntimeRunRouteStoreMethod>;

const uuidParamsSchema = z.object({ id: z.string().uuid() }).strict();
const taskParamsSchema = z.object({ taskId: z.string().uuid() }).strict();

function requireOwner(request: FastifyRequest, reply: FastifyReply): string | null {
  const owner = request.ownerSession;
  if (!owner || new Date(owner.expiresAt).getTime() <= Date.now()) {
    sendError(reply, 401, "OWNER_SESSION_REQUIRED", "An attributable Owner session is required for Runtime Run control.");
    return null;
  }
  return owner.userId;
}

function phaseFor(run: RuntimeRun): "queued" | "provisioning" | "ready" | "executing" | "paused" | "completed" {
  if (run.state === "queued") return "queued";
  if (run.state === "provisioning") return "provisioning";
  if (run.state === "ready") return "ready";
  if (run.state === "paused") return "paused";
  if (["completed", "failed", "cancelled", "expired"].includes(run.state)) return "completed";
  return "executing";
}

export function registerRuntimeRunRoutes(app: FastifyInstance, options: RuntimeRunRouteOptions): void {
  app.get("/api/runtime-runs/by-task/:taskId", async (request, reply) => {
    if (!requireOwner(request, reply)) return;
    const { taskId } = parse(taskParamsSchema, request.params);
    const run = await options.store.getRuntimeRunForTask(taskId);
    if (!run) return sendError(reply, 404, "NOT_FOUND", "Runtime Run not found for Task.");
    return reply.send(parseResponse(runtimeRunSchema, run));
  });

  app.get("/api/runtime-runs/:id", async (request, reply) => {
    if (!requireOwner(request, reply)) return;
    const { id } = parse(uuidParamsSchema, request.params);
    const run = await options.store.getRuntimeRun(id);
    if (!run) return sendError(reply, 404, "NOT_FOUND", "Runtime Run not found.");
    return reply.send(parseResponse(runtimeRunSchema, run));
  });

  app.get("/api/runtime-runs/:id/events", async (request, reply) => {
    if (!requireOwner(request, reply)) return;
    const { id } = parse(uuidParamsSchema, request.params);
    const query = parse(runtimeRunEventQuerySchema, request.query);
    if (!await options.store.getRuntimeRun(id)) {
      return sendError(reply, 404, "NOT_FOUND", "Runtime Run not found.");
    }
    return reply.send({
      events: (await options.store.getRuntimeRunEvents(id, query.afterSequence, query.limit))
        .map((event) => parseResponse(runtimeRunEventSchema, event))
    });
  });

  app.post("/api/runtime-runs/:id/steer", async (request, reply) => {
    const ownerId = requireOwner(request, reply);
    if (!ownerId) return;
    const input = parse(runtimeRunSteerSchema, request.body);
    return controlRun(request, reply, options, ownerId, "steer", input.expectedRevision, input.message);
  });

  for (const action of ["pause", "resume", "cancel"] as const) {
    app.post(`/api/runtime-runs/:id/${action}`, async (request, reply) => {
      const ownerId = requireOwner(request, reply);
      if (!ownerId) return;
      const input = parse(runtimeRunControlSchema, request.body);
      return controlRun(request, reply, options, ownerId, action, input.expectedRevision);
    });
  }
}

const runtimeRunEventQuerySchema = z.object({
  afterSequence: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100)
}).strict();

async function controlRun(
  request: FastifyRequest,
  reply: FastifyReply,
  options: RuntimeRunRouteOptions,
  ownerId: string,
  action: RuntimeControlAction,
  expectedRevision: number,
  message?: string
) {
  if (options.ompRuntimeEnabled !== true) {
    return sendError(reply, 404, "FEATURE_DISABLED", "OMP Runtime control is not enabled.");
  }
  const queue = options.agentQueue;
  if (!queue?.enqueueRuntimeControl) {
    return sendError(reply, 503, "RUNTIME_QUEUE_UNAVAILABLE", "Runtime control queue is not configured.");
  }
  const { id } = parse(uuidParamsSchema, request.params);
  const current = await options.store.getRuntimeRun(id);
  if (!current) return sendError(reply, 404, "NOT_FOUND", "Runtime Run not found.");
  if (current.revision !== expectedRevision) {
    return sendError(reply, 409, "REVISION_CONFLICT", "Runtime Run revision changed.");
  }
  if (current.runtimeProfile.harnessKind !== "pi") {
    return sendError(reply, 409, "RUNTIME_CONTROL_UNSUPPORTED", "Only OMP Runtime Runs support long-task controls.");
  }
  if (action === "steer" && current.state !== "running") {
    return sendError(reply, 409, "RUNTIME_NOT_RUNNING", "Only a running OMP Runtime may be guided.");
  }
  if (action === "pause" && !["provisioning", "ready", "running", "awaiting_approval"].includes(current.state)) {
    return sendError(reply, 409, "RUNTIME_NOT_PAUSABLE", "Runtime Run is not in a pausable state.");
  }
  if (action === "resume" && current.state !== "paused") {
    return sendError(reply, 409, "RUNTIME_NOT_PAUSED", "Only a paused Runtime Run may resume.");
  }
  if (action === "cancel" && ["completed", "failed", "cancelled", "expired"].includes(current.state)) {
    return sendError(reply, 409, "RUNTIME_TERMINAL", "A terminal Runtime Run cannot be cancelled again.");
  }

  const commandRevision = expectedRevision + 1;
  const jobId = runtimeControlJobId(id, action, commandRevision);
  await queue.enqueueRuntimeControl({
    runtimeRunId: id,
    action,
    commandRevision,
    ...(message === undefined ? {} : { message }),
    requestedBy: "owner"
  }, jobId);
  const now = new Date().toISOString();
  const targetState = action === "pause"
    ? "paused" as const
    : action === "resume"
      ? "provisioning" as const
      : action === "cancel"
        ? "cancelled" as const
        : current.state;
  const updated = await options.store.updateRuntimeRun(id, {
    expectedRevision,
    state: targetState,
    at: now,
    errorCode: action === "resume" ? null : current.errorCode,
    event: {
      type: action === "steer" ? "owner.action" : "state.changed",
      phase: action === "pause" ? "paused" : action === "resume" ? "provisioning" : action === "cancel" ? "completed" : phaseFor(current),
      summary: action === "steer"
        ? `Owner guidance queued as ${jobId}.`
        : `Owner requested Runtime ${action} as ${jobId}.`,
      toolName: null,
      progressPercent: null,
      usage: null,
      errorCode: null,
      actorType: "owner",
      occurredAt: now
    }
  });
  return reply.send(parseResponse(runtimeRunSchema, updated));
}
