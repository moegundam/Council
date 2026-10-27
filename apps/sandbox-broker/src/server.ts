import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BrokerPayloadTooLargeError, type SandboxBroker, createHttpServerForBroker } from "./sandbox-broker.js";
import { createHttpServerForOmpBroker, isOmpBrokerPath } from "./omp-http-server.js";
import type { OmpRuntimeBroker } from "./omp-runtime-broker.js";

async function readJsonBody(request: IncomingMessage, maxBytes = 128 * 1024): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    request.on("data", (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > maxBytes) {
        settled = true;
        reject(new BrokerPayloadTooLargeError("Request body exceeds the configured byte limit."));
        return;
      }
      chunks.push(buffer);
    });
    request.on("error", (error) => {
      if (!settled) reject(error);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

export function createBrokerServer(options: {
  broker: SandboxBroker;
  authToken: string;
  ompRuntime?: OmpRuntimeBroker;
}): Server {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://sandbox-broker.local").pathname;
    if (isOmpBrokerPath(pathname)) {
      void createHttpServerForOmpBroker({
        ompRuntime: options.ompRuntime,
        authToken: options.authToken,
        authorizeSourceAddress: options.broker.authorizeSourceAddress,
        request,
        readBody: readJsonBody,
        writeJson: (statusCode, payload) => writeJson(response, statusCode, payload)
      })();
      return;
    }
    void createHttpServerForBroker({
        broker: options.broker,
        authToken: options.authToken,
        request,
        readBody: readJsonBody,
        writeJson: (statusCode, payload) => writeJson(response, statusCode, payload)
      })();
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return server;
}
