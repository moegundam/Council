import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { FastifyInstance, FastifyRequest } from "fastify";

export interface ApiRequestLog {
  timestamp: string;
  level: "info" | "warn" | "error";
  service: "api";
  event: "http.request.completed";
  outcome: "success" | "client_error" | "server_error";
  requestId: string;
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
}

export interface ApiObservabilityOptions {
  emit?: (entry: ApiRequestLog) => void;
  generateRequestId?: () => string;
  now?: () => number;
  timestamp?: () => string;
}

interface RequestObservation {
  requestId: string;
  startedAt: number;
}

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function defaultEmit(entry: ApiRequestLog): void {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

function safeEmit(emit: (entry: ApiRequestLog) => void, entry: ApiRequestLog): void {
  try {
    emit(entry);
  } catch {
    // Observability must not change request outcomes.
  }
}

function acceptedRequestId(value: string | string[] | undefined): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && requestIdPattern.test(candidate) ? candidate : undefined;
}

function roundedDuration(value: number): number {
  return Math.max(0, Number(value.toFixed(3)));
}

function classifyResponse(statusCode: number): Pick<ApiRequestLog, "level" | "outcome"> {
  if (statusCode >= 500) return { level: "error", outcome: "server_error" };
  if (statusCode >= 400) return { level: "warn", outcome: "client_error" };
  return { level: "info", outcome: "success" };
}

export function registerApiObservability(
  app: FastifyInstance,
  options: ApiObservabilityOptions = {}
): void {
  const observations = new WeakMap<FastifyRequest, RequestObservation>();
  const emit = options.emit ?? defaultEmit;
  const generateRequestId = options.generateRequestId ?? randomUUID;
  const now = options.now ?? (() => performance.now());
  const timestamp = options.timestamp ?? (() => new Date().toISOString());

  app.addHook("onRequest", async (request, reply) => {
    const requestId = acceptedRequestId(request.headers["x-request-id"]) ?? generateRequestId();
    observations.set(request, { requestId, startedAt: now() });
    reply.header("x-request-id", requestId);
  });

  app.addHook("onResponse", async (request, reply) => {
    const observation = observations.get(request);
    if (!observation) return;
    const route = request.routeOptions.url || "unmatched";
    const classification = classifyResponse(reply.statusCode);
    safeEmit(emit, {
      timestamp: timestamp(),
      ...classification,
      service: "api",
      event: "http.request.completed",
      requestId: observation.requestId,
      method: request.method,
      route,
      statusCode: reply.statusCode,
      durationMs: roundedDuration(now() - observation.startedAt)
    });
  });
}
