import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import {
  OmpBrokerConflictError,
  OmpBrokerNotFoundError,
  OmpBrokerValidationError,
  type OmpRuntimeBroker
} from "./omp-runtime-broker.js";
import { BrokerPayloadTooLargeError, requestPathname } from "./sandbox-broker.js";

function bearerTokenMatches(authorization: string, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`, "utf8");
  const received = Buffer.from(authorization, "utf8");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function isOmpBrokerPath(pathname: string): boolean {
  return pathname === "/health/omp-runtime" || pathname.startsWith("/omp/sessions");
}

export function createHttpServerForOmpBroker(options: {
  ompRuntime: OmpRuntimeBroker | undefined;
  authToken: string;
  authorizeSourceAddress: (address: string | undefined, request: { method: string; path: string }) => boolean;
  readBody: (request: IncomingMessage) => Promise<unknown>;
  writeJson: (statusCode: number, payload: unknown) => void;
  request: IncomingMessage;
}) {
  const { ompRuntime, authToken, authorizeSourceAddress, readBody, writeJson, request } = options;
  const pathname = requestPathname(request);

  const requireAuth = (): boolean => {
    if (!bearerTokenMatches(request.headers.authorization ?? "", authToken)) {
      writeJson(401, { error: "unauthorized" });
      return false;
    }
    if (!authorizeSourceAddress(request.socket.remoteAddress, {
      method: request.method ?? "GET",
      path: pathname
    })) {
      writeJson(403, { error: "forbidden_source" });
      return false;
    }
    return true;
  };

  return async () => {
    try {
      if (request.method === "GET" && pathname === "/health/omp-runtime") {
        if (!ompRuntime) {
          writeJson(503, { ok: true, ready: false, reason: "disabled" });
          return;
        }
        const health = await ompRuntime.health();
        writeJson(health.ready ? 200 : 503, health);
        return;
      }
      if (!ompRuntime) {
        writeJson(404, { error: "not_found" });
        return;
      }
      if (!requireAuth()) return;

      if (request.method === "POST" && pathname === "/omp/sessions") {
        const result = await ompRuntime.start(await readBody(request));
        writeJson(result.state === "provisioning" ? 202 : 200, result);
        return;
      }

      const sessionMatch = pathname.match(/^\/omp\/sessions\/([0-9a-f-]{36})$/i);
      if (request.method === "GET" && sessionMatch) {
        const result = await ompRuntime.get(sessionMatch[1]!);
        if (!result) {
          writeJson(404, { error: "not_found" });
          return;
        }
        writeJson(200, result);
        return;
      }

      const eventsMatch = pathname.match(/^\/omp\/sessions\/([0-9a-f-]{36})\/events$/i);
      if (request.method === "GET" && eventsMatch) {
        const url = new URL(request.url ?? "/", "http://sandbox-broker.local");
        const afterSequence = url.searchParams.has("afterSequence")
          ? Number(url.searchParams.get("afterSequence"))
          : 0;
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 100;
        writeJson(200, { events: await ompRuntime.events(eventsMatch[1]!, afterSequence, limit) });
        return;
      }

      const controlMatch = pathname.match(/^\/omp\/sessions\/([0-9a-f-]{36})\/control$/i);
      if (request.method === "POST" && controlMatch) {
        writeJson(200, await ompRuntime.control(controlMatch[1]!, await readBody(request)));
        return;
      }

      writeJson(404, { error: "not_found" });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof OmpBrokerValidationError || error instanceof SyntaxError) {
        writeJson(400, { error: "invalid_request", message: error.message });
        return;
      }
      if (error instanceof BrokerPayloadTooLargeError) {
        writeJson(413, { error: "payload_too_large", message: error.message });
        return;
      }
      if (error instanceof OmpBrokerConflictError) {
        writeJson(409, { error: "conflict", message: error.message });
        return;
      }
      if (error instanceof OmpBrokerNotFoundError) {
        writeJson(404, { error: "not_found", message: error.message });
        return;
      }
      writeJson(500, { error: "internal_error" });
    }
  };
}
