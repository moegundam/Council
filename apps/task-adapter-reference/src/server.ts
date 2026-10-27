import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { pathToFileURL } from "node:url";
import {
  taskAdapterUpsertPayloadSchema,
  taskAdapterUpsertResponseSchema
} from "@council/contracts";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4200;
export const MAX_BODY_BYTES = 128 * 1024;
export const MAX_RESPONSE_BYTES = 1024;

const MAX_HEADER_BYTES = 8 * 1024;
const MAX_TOKEN_BYTES = 4_000;

type Environment = Readonly<Record<string, string | undefined>>;

export interface TaskAdapterServerOptions {
  token?: string;
  maxBodyBytes?: number;
}

export interface TaskAdapterServerConfig {
  host: string;
  port: number;
}

class RequestFailure extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function readServerConfig(environment: Environment = process.env): TaskAdapterServerConfig {
  const host = environment.HOST?.trim() ?? DEFAULT_HOST;
  const rawPort = environment.PORT ?? String(DEFAULT_PORT);
  const port = Number(rawPort);

  if (host.length === 0 || host.length > 253) {
    throw new Error("HOST must be a non-empty hostname or address.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  return { host, port };
}

export function readTaskAdapterToken(environment: Environment = process.env): string | undefined {
  if (environment.TASK_ADAPTER_TOKEN !== undefined && environment.TASK_ADAPTER_TOKEN_FILE !== undefined) {
    throw new Error("Set only one of TASK_ADAPTER_TOKEN or TASK_ADAPTER_TOKEN_FILE.");
  }
  const token = environment.TASK_ADAPTER_TOKEN_FILE
    ? readFileSync(environment.TASK_ADAPTER_TOKEN_FILE, "utf8").replace(/\r?\n$/, "")
    : environment.TASK_ADAPTER_TOKEN;
  if (token === undefined) return undefined;
  if (token.length === 0 || token.includes("\n") || token.includes("\r") || Buffer.byteLength(token) > MAX_TOKEN_BYTES) {
    throw new Error("TASK_ADAPTER_TOKEN must be between 1 and 4000 bytes.");
  }
  return token;
}

function authorizationDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function isAuthorized(request: IncomingMessage, expectedDigest: Buffer | undefined): boolean {
  if (expectedDigest === undefined) return true;
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return false;
  return timingSafeEqual(authorizationDigest(authorization), expectedDigest);
}

function externalIdForTask(taskId: string): string {
  const digest = createHash("sha256").update(taskId, "utf8").digest("hex");
  return `task_${digest.slice(0, 32)}`;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  headers: Record<string, string> = {}
): void {
  let body = Buffer.from(JSON.stringify(payload), "utf8");
  let boundedStatusCode = statusCode;

  if (body.byteLength > MAX_RESPONSE_BYTES) {
    boundedStatusCode = 500;
    body = Buffer.from('{"error":{"code":"internal_error","message":"Internal server error."}}', "utf8");
  }

  response.writeHead(boundedStatusCode, {
    "cache-control": "no-store",
    "content-length": String(body.byteLength),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...headers
  });
  response.end(body);
}

function sendFailure(response: ServerResponse, failure: RequestFailure): void {
  sendJson(response, failure.statusCode, {
    error: {
      code: failure.code,
      message: failure.message
    }
  });
}

function discardBody(request: IncomingMessage): void {
  if (!request.complete) request.resume();
}

function hasJsonContentType(request: IncomingMessage): boolean {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string") return false;
  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function readBoundedBody(request: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  const contentLength = request.headers["content-length"];
  if (Array.isArray(contentLength)) {
    discardBody(request);
    throw new RequestFailure(400, "invalid_request", "Request has an invalid Content-Length header.");
  }
  if (contentLength !== undefined) {
    const advertisedBytes = Number(contentLength);
    if (!Number.isSafeInteger(advertisedBytes) || advertisedBytes < 0) {
      discardBody(request);
      throw new RequestFailure(400, "invalid_request", "Request has an invalid Content-Length header.");
    }
    if (advertisedBytes > maxBodyBytes) {
      discardBody(request);
      throw new RequestFailure(413, "request_too_large", "Request body exceeds the size limit.");
    }
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBodyBytes) {
      discardBody(request);
      throw new RequestFailure(413, "request_too_large", "Request body exceeds the size limit.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes);
}

async function handleUpsert(
  request: IncomingMessage,
  response: ServerResponse,
  maxBodyBytes: number
): Promise<void> {
  if (!hasJsonContentType(request)) {
    discardBody(request);
    throw new RequestFailure(415, "unsupported_media_type", "Content-Type must be application/json.");
  }

  const body = await readBoundedBody(request, maxBodyBytes);
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new RequestFailure(400, "invalid_request", "Request body is not valid JSON.");
  }

  const parsed = taskAdapterUpsertPayloadSchema.safeParse(input);
  if (!parsed.success) {
    throw new RequestFailure(400, "invalid_request", "Request body is not a valid Task Adapter payload.");
  }

  const idempotencyKey = request.headers["idempotency-key"];
  const keyPrefix = `${parsed.data.taskId}:`;
  const fingerprint = typeof idempotencyKey === "string" && idempotencyKey.startsWith(keyPrefix)
    ? idempotencyKey.slice(keyPrefix.length)
    : "";
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new RequestFailure(400, "invalid_idempotency_key", "Idempotency-Key must bind payload.taskId to one payload fingerprint.");
  }

  const result = taskAdapterUpsertResponseSchema.parse({
    externalId: externalIdForTask(parsed.data.taskId)
  });
  sendJson(response, 200, result);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  expectedAuthorizationDigest: Buffer | undefined,
  maxBodyBytes: number
): Promise<void> {
  const path = request.url ?? "";
  const isKnownPath = path === "/health" || path === "/v1/tasks/upsert";

  if (!isKnownPath) {
    discardBody(request);
    sendFailure(response, new RequestFailure(404, "not_found", "Route not found."));
    return;
  }

  if (!isAuthorized(request, expectedAuthorizationDigest)) {
    discardBody(request);
    sendJson(response, 401, {
      error: {
        code: "unauthorized",
        message: "Bearer authentication required."
      }
    }, { "www-authenticate": "Bearer" });
    return;
  }

  if (path === "/health") {
    if (request.method !== "GET") {
      discardBody(request);
      sendJson(response, 405, {
        error: { code: "method_not_allowed", message: "Method not allowed." }
      }, { allow: "GET" });
      return;
    }
    sendJson(response, 200, { status: "ready" });
    return;
  }

  if (request.method !== "POST") {
    discardBody(request);
    sendJson(response, 405, {
      error: { code: "method_not_allowed", message: "Method not allowed." }
    }, { allow: "POST" });
    return;
  }

  await handleUpsert(request, response, maxBodyBytes);
}

export function createTaskAdapterServer(options: TaskAdapterServerOptions = {}): Server {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error("maxBodyBytes must be a positive integer.");
  }
  if (options.token !== undefined && (options.token.length === 0 || Buffer.byteLength(options.token) > MAX_TOKEN_BYTES)) {
    throw new Error("token must be between 1 and 4000 bytes.");
  }

  const expectedAuthorizationDigest = options.token === undefined
    ? undefined
    : authorizationDigest(`Bearer ${options.token}`);
  const server = createHttpServer({
    headersTimeout: 5_000,
    keepAliveTimeout: 5_000,
    maxHeaderSize: MAX_HEADER_BYTES,
    requestTimeout: 10_000
  }, (request, response) => {
    void handleRequest(request, response, expectedAuthorizationDigest, maxBodyBytes).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof RequestFailure) {
        sendFailure(response, error);
        return;
      }
      sendJson(response, 500, {
        error: { code: "internal_error", message: "Internal server error." }
      });
    });
  });
  server.maxRequestsPerSocket = 100;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  });
  return server;
}

export function startTaskAdapter(environment: Environment = process.env): Server {
  const config = readServerConfig(environment);
  const token = readTaskAdapterToken(environment);
  const server = createTaskAdapterServer(token === undefined ? {} : { token });

  server.listen(config.port, config.host, () => {
    process.stdout.write(`task adapter ready on http://${config.host}:${config.port}\n`);
  });
  server.once("error", () => {
    process.stderr.write("task adapter failed to start\n");
    process.exitCode = 1;
  });

  const close = () => server.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    startTaskAdapter();
  } catch {
    process.stderr.write("invalid task adapter configuration\n");
    process.exitCode = 1;
  }
}
