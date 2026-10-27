import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  request as createHttpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server
} from "node:http";
import { createConnection } from "node:net";
import { pathToFileURL } from "node:url";

export interface SshTunnelConfig {
  sshHost: string;
  sshPort: number;
  sshUser: string;
  targetHost: string;
  targetPort: number;
  localHost: string;
  localPort: number;
  keyPath: string;
  knownHostsPath: string;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: "SSH_HOST" | "SSH_USER"): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when the model tunnel is enabled.`);
  return value;
}

function positivePort(value: string | undefined, fallback: number, name: string): number {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535.`);
  }
  return port;
}

export function modelTunnelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SshTunnelConfig {
  return {
    sshHost: requiredEnv(env, "SSH_HOST"),
    sshPort: positivePort(env.SSH_PORT, 22, "SSH_PORT"),
    sshUser: requiredEnv(env, "SSH_USER"),
    targetHost: env.TARGET_HOST?.trim() || "127.0.0.1",
    targetPort: positivePort(env.TARGET_PORT, 4001, "TARGET_PORT"),
    localHost: env.LOCAL_HOST?.trim() || "127.0.0.1",
    localPort: positivePort(env.LOCAL_PORT, 4001, "LOCAL_PORT"),
    keyPath: env.SSH_KEY_FILE?.trim() || "/run/secrets/model_tunnel_key",
    knownHostsPath: env.KNOWN_HOSTS_FILE?.trim() || "/run/secrets/model_tunnel_known_hosts"
  };
}

export function buildSshArgs(config: SshTunnelConfig): string[] {
  return [
    "-N",
    "-T",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${config.knownHostsPath}`,
    "-o", "ConnectTimeout=10",
    "-o", "ConnectionAttempts=1",
    "-o", "TCPKeepAlive=yes",
    "-o", "AddressFamily=inet",
    "-o", "GatewayPorts=yes",
    "-o", "KexAlgorithms=curve25519-sha256",
    "-o", "IPQoS=none",
    "-o", "LogLevel=ERROR",
    "-i", config.keyPath,
    "-p", String(config.sshPort),
    "-L", `${config.localHost}:${config.localPort}:${config.targetHost}:${config.targetPort}`,
    `${config.sshUser}@${config.sshHost}`
  ];
}

export function resolveTunnelProbeHost(localHost: string): string {
  if (localHost === "0.0.0.0") return "127.0.0.1";
  if (localHost === "::") return "::1";
  return localHost;
}

export interface BearerInjectingProxyConfig {
  upstreamHost: string;
  upstreamPort: number;
  apiKey: string;
  maxRequestBytes?: number;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
const MODEL_API_METHODS = new Map<string, ReadonlySet<string>>([
  ["/v1/models", new Set(["GET"])],
  ["/v1/chat/completions", new Set(["POST"])],
  ["/v1/completions", new Set(["POST"])],
  ["/v1/responses", new Set(["POST"])]
]);
const MODEL_REQUEST_HEADERS = new Set(["accept", "content-type", "user-agent"]);

function proxyHeaders(headers: IncomingHttpHeaders, apiKey: string, bodyLength: number): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (!MODEL_REQUEST_HEADERS.has(normalized)) continue;
    result[normalized] = value;
  }
  result.authorization = `Bearer ${apiKey}`;
  result["content-length"] = String(bodyLength);
  return result;
}

function responseHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== "set-cookie") result[name] = value;
  }
  return result;
}

async function readLimitedBody(request: IncomingMessage, limit: number): Promise<Buffer | null> {
  return await new Promise<Buffer | null>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let exceeded = false;
    request.on("data", (raw) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
      bytes += chunk.byteLength;
      if (bytes > limit) {
        exceeded = true;
        chunks.length = 0;
      } else if (!exceeded) {
        chunks.push(chunk);
      }
    });
    request.once("error", reject);
    request.once("end", () => resolve(exceeded ? null : Buffer.concat(chunks)));
  });
}

export function createBearerInjectingProxy(config: BearerInjectingProxyConfig): Server {
  if (!config.apiKey.trim()) throw new Error("The local model gateway key must not be empty.");
  const maxRequestBytes = config.maxRequestBytes ?? 8 * 1024 * 1024;
  return createHttpServer(async (request, response) => {
    try {
      const target = new URL(request.url ?? "/", "http://model-gateway.invalid");
      const allowedMethods = MODEL_API_METHODS.get(target.pathname);
      if (!allowedMethods) {
        response.writeHead(404).end();
        return;
      }
      if (!request.method || !allowedMethods.has(request.method)) {
        response.writeHead(405, { allow: [...allowedMethods].join(", ") }).end();
        return;
      }
      const body = await readLimitedBody(request, maxRequestBytes);
      if (body === null) {
        response.writeHead(413).end();
        return;
      }
      const upstream = createHttpRequest({
        host: config.upstreamHost,
        port: config.upstreamPort,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers: proxyHeaders(request.headers, config.apiKey, body.byteLength)
      }, (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          responseHeaders(upstreamResponse.headers)
        );
        upstreamResponse.pipe(response);
      });
      upstream.setTimeout(120_000, () => upstream.destroy(new Error("Model upstream timed out.")));
      upstream.once("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      upstream.end(body);
    } catch {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    }
  });
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(port, host);
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function listen(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
}

async function start(): Promise<void> {
  const config = modelTunnelConfigFromEnv();
  const healthHost = process.env.HEALTH_HOST ?? "127.0.0.1";
  const healthPort = Number(process.env.HEALTH_PORT ?? "4101");
  const tunnelProbeHost = resolveTunnelProbeHost(config.localHost);
  const upstreamApiKeyFile = process.env.UPSTREAM_API_KEY_FILE?.trim() || null;
  const gatewayHost = process.env.GATEWAY_HOST ?? "0.0.0.0";
  const gatewayPort = Number(process.env.GATEWAY_PORT ?? "4001");
  let gatewayServer: Server | null = null;
  if (upstreamApiKeyFile) {
    if (config.localHost !== "127.0.0.1" && config.localHost !== "::1") {
      throw new Error("Credential injection requires a loopback-only raw SSH tunnel.");
    }
    const apiKey = (await readFile(upstreamApiKeyFile, "utf8")).trim();
    gatewayServer = createBearerInjectingProxy({
      upstreamHost: tunnelProbeHost,
      upstreamPort: config.localPort,
      apiKey
    });
    await listen(gatewayServer, gatewayPort, gatewayHost);
  }
  let ready = false;
  let shuttingDown = false;

  const tunnel = spawn("ssh", buildSshArgs(config), {
    stdio: ["ignore", "ignore", "inherit"]
  });

  const healthServer = createHttpServer(async (request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    const tunnelHealthy = await canConnect(tunnelProbeHost, config.localPort);
    const gatewayHealthy = !gatewayServer || await canConnect(resolveTunnelProbeHost(gatewayHost), gatewayPort);
    const healthy = ready && tunnelHealthy && gatewayHealthy;
    response.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: healthy ? "ready" : "starting" }));
  });
  healthServer.listen(healthPort, healthHost);

  const fail = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    ready = false;
    process.stderr.write("model tunnel unavailable\n");
    healthServer.close();
    gatewayServer?.close();
    setTimeout(() => process.exit(1), 25).unref();
  };
  tunnel.once("error", fail);
  tunnel.once("exit", fail);

  void (async () => {
    const deadline = Date.now() + 15_000;
    while (!shuttingDown && tunnel.exitCode === null && Date.now() < deadline) {
      if (await canConnect(tunnelProbeHost, config.localPort)) {
        ready = true;
        process.stdout.write(`model tunnel ready on ${gatewayServer ? gatewayPort : config.localPort}\n`);
        return;
      }
      await delay(500);
    }
    if (!shuttingDown) {
      tunnel.kill("SIGTERM");
      fail();
    }
  })();

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    ready = false;
    healthServer.close();
    gatewayServer?.close();
    tunnel.kill("SIGTERM");
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void start().catch(() => {
    process.stderr.write("model tunnel failed to start\n");
    process.exit(1);
  });
}
