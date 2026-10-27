import { createServer as createHttpServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSshArgs,
  createBearerInjectingProxy,
  modelTunnelConfigFromEnv,
  resolveTunnelProbeHost,
  type SshTunnelConfig
} from "./server.js";

const config: SshTunnelConfig = {
  sshHost: "model.example",
  sshPort: 22,
  sshUser: "council",
  targetHost: "127.0.0.1",
  targetPort: 4001,
  localHost: "0.0.0.0",
  localPort: 4001,
  keyPath: "/run/secrets/model_key",
  knownHostsPath: "/run/secrets/known_hosts"
};

const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener.");
  return address.port;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("OpenSSH model tunnel", () => {
  it("requires an explicit SSH endpoint when the optional tunnel is enabled", () => {
    expect(() => modelTunnelConfigFromEnv({})).toThrow(/SSH_HOST/i);
    expect(() => modelTunnelConfigFromEnv({ SSH_HOST: "model.example" })).toThrow(/SSH_USER/i);
    expect(modelTunnelConfigFromEnv({ SSH_HOST: "model.example", SSH_USER: "council" })).toMatchObject({
      sshHost: "model.example",
      sshUser: "council",
      localHost: "127.0.0.1",
      localPort: 4001
    });
  });

  it("builds a non-interactive tunnel with pinned, private-network transport", () => {
    const args = buildSshArgs(config);

    expect(args).toContain("-N");
    expect(args).toContain("-T");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("ExitOnForwardFailure=yes");
    expect(args).toContain("IdentitiesOnly=yes");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("UserKnownHostsFile=/run/secrets/known_hosts");
    expect(args).toContain("ConnectTimeout=10");
    expect(args).toContain("ConnectionAttempts=1");
    expect(args).toContain("TCPKeepAlive=yes");
    expect(args).toContain("GatewayPorts=yes");
    expect(args).toContain("KexAlgorithms=curve25519-sha256");
    expect(args).toContain("IPQoS=none");
    expect(args).not.toContain("ServerAliveInterval=15");
    expect(args).not.toContain("ServerAliveCountMax=3");
  });

  it("allows only the configured local forward and identity", () => {
    const args = buildSshArgs(config);
    const forwardIndex = args.indexOf("-L");
    const identityIndex = args.indexOf("-i");

    expect(args[forwardIndex + 1]).toBe("0.0.0.0:4001:127.0.0.1:4001");
    expect(args[identityIndex + 1]).toBe("/run/secrets/model_key");
    expect(args.at(-1)).toBe("council@model.example");
  });

  it("probes wildcard listeners through loopback", () => {
    expect(resolveTunnelProbeHost("0.0.0.0")).toBe("127.0.0.1");
    expect(resolveTunnelProbeHost("::")).toBe("::1");
    expect(resolveTunnelProbeHost("127.0.0.2")).toBe("127.0.0.2");
  });

  it("injects the local LiteLLM key without forwarding caller credentials", async () => {
    let observedAuthorization = "";
    let observedBody = "";
    const upstreamPort = await listen(createHttpServer((request, response) => {
      observedAuthorization = request.headers.authorization ?? "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { observedBody += chunk; });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
    }));
    const proxyPort = await listen(createBearerInjectingProxy({
      upstreamHost: "127.0.0.1",
      upstreamPort,
      apiKey: "local-agent-key",
      maxRequestBytes: 1024
    }));

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer caller-controlled",
        "content-type": "application/json"
      },
      body: JSON.stringify({ model: "gb10-test", messages: [] })
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(observedAuthorization).toBe("Bearer local-agent-key");
    expect(JSON.parse(observedBody)).toEqual({ model: "gb10-test", messages: [] });
  });

  it("limits the credential-injecting proxy to the OpenAI-compatible API surface", async () => {
    const proxyPort = await listen(createBearerInjectingProxy({
      upstreamHost: "127.0.0.1",
      upstreamPort: 9,
      apiKey: "local-agent-key",
      maxRequestBytes: 8
    }));

    await expect(fetch(`http://127.0.0.1:${proxyPort}/health`)).resolves.toMatchObject({ status: 404 });
    await expect(fetch(`http://127.0.0.1:${proxyPort}/v1/key/generate`, { method: "POST" }))
      .resolves.toMatchObject({ status: 404 });
    await expect(fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      body: "payload-too-large"
    })).resolves.toMatchObject({ status: 413 });
  });
});
