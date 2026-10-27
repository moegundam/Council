import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createSandboxBroker } from "./sandbox-broker.js";
import { createBrokerServer } from "./server.js";
import { createToolPackManifestDigest, createToolPackRegistry } from "./tool-pack-registry.js";
import type { OmpRuntimeBroker } from "./omp-runtime-broker.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-broker-server-"));
  tempDirs.push(directory);
  return directory;
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function createRegistry() {
  const echoScriptPath = fileURLToPath(new URL("./test-fixtures/echo-tool.js", import.meta.url));
  const manifest = {
    id: "node-tools",
    version: "1.0.0",
    reference: `node-tools@sha256:${"7".repeat(64)}`,
    executablePath: process.execPath,
    executableDigest: await sha256File(process.execPath),
    tools: {
      echo_env: {
        baseArgs: [echoScriptPath],
        allowedArgvSets: [["emit"]],
        envAllowlist: ["BROKER_TEST_SECRET"],
        allowStdin: false
      }
    }
  };
  return createToolPackRegistry([{ ...manifest, digest: createToolPackManifestDigest(manifest) }]);
}

describe("createBrokerServer", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("serves health without auth and uses the socket address instead of forwarded headers", async () => {
    let seenAddress: string | undefined;
    const broker = await createSandboxBroker({
      workspaceRoot: await makeTempDir(),
      toolPackRegistry: await createRegistry(),
      authToken: "broker-secret",
      executionIsolationAttested: true,
      authorizeSourceAddress: (address) => {
        seenAddress = address;
        return true;
      }
    });
    const server = createBrokerServer({ broker, authToken: "broker-secret" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected an ephemeral TCP port.");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);

    const unauthorized = await fetch(`${baseUrl}/leases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "lease-http-1",
        scopeId: "scope-http",
        workspaceSubpath: "scope-http/lease-http-1",
        imageDigest: `sha256:${"8".repeat(64)}`,
        cpuLimit: 1,
        memoryMb: 256,
        diskMb: 512,
        processLimit: 1,
        ttlMs: 1_000,
        networkPolicy: "deny_all",
        allowlistedHosts: []
      })
    });
    expect(unauthorized.status).toBe(401);

    const created = await fetch(`${baseUrl}/leases`, {
      method: "POST",
      headers: {
        authorization: "Bearer broker-secret",
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.99"
      },
      body: JSON.stringify({
        idempotencyKey: "lease-http-1",
        scopeId: "scope-http",
        workspaceSubpath: "scope-http/lease-http-1",
        imageDigest: `sha256:${"8".repeat(64)}`,
        cpuLimit: 1,
        memoryMb: 256,
        diskMb: 512,
        processLimit: 1,
        ttlMs: 1_000,
        networkPolicy: "deny_all",
        allowlistedHosts: []
      })
    });
    expect(created.status).toBe(201);
    expect(await created.json()).not.toHaveProperty("workspacePath");
    expect(seenAddress).toBeDefined();
    expect(seenAddress).not.toBe("203.0.113.99");

    const oversized = await fetch(`${baseUrl}/leases`, {
      method: "POST",
      headers: {
        authorization: "Bearer broker-secret",
        "content-type": "application/json"
      },
      body: JSON.stringify({ padding: "x".repeat(140 * 1024) })
    });
    expect(oversized.status).toBe(413);

    expect(server.requestTimeout).toBeLessThanOrEqual(15_000);
    expect(server.headersTimeout).toBeLessThanOrEqual(10_000);

    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("keeps OMP Session operations private and forwards bounded controls", async () => {
    const runtimeRunId = "70000000-0000-4000-8000-000000000006";
    const session = {
      runtimeRunId,
      goalRunId: "70000000-0000-4000-8000-000000000007",
      taskId: "70000000-0000-4000-8000-000000000001",
      idempotencyKey: "omp-start-1",
      requestDigest: `sha256:${"a".repeat(64)}` as const,
      state: "running" as const,
      runtimeVersion: "omp-rpc-v2@18.1.2" as const,
      leaseId: "70000000-0000-4000-8000-000000000008",
      containerId: "rootless-container-1",
      providerSessionId: "omp-session-1",
      providerSessionFile: "/opt/council-omp-config/sessions/session.jsonl",
      eventCursor: 3,
      errorCode: null,
      artifactManifest: null,
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:01:00.000Z",
      expiresAt: "2026-09-02T02:00:00.000Z"
    };
    let control: unknown;
    const ompRuntime: OmpRuntimeBroker = {
      health: async () => ({
        ok: true,
        ready: true,
        runtimeVersion: "omp-rpc-v2@18.1.2",
        rootless: true,
        rootfulSocketAbsent: true,
        isolationAttested: true,
        maxConcurrency: 1
      }),
      start: async () => session,
      get: async (id) => id === runtimeRunId ? session : null,
      events: async () => [{
        sequence: 3,
        kind: "tool.completed",
        summary: "Tool completed.",
        toolName: "grep",
        progressPercent: 65,
        inputTokens: null,
        outputTokens: null,
        toolCalls: null,
        errorCode: null,
        occurredAt: "2026-09-02T00:01:00.000Z"
      }],
      control: async (_id, input) => {
        control = input;
        return session;
      },
      reconcileInterruptedSessions: async () => 0
    };
    const broker = await createSandboxBroker({
      workspaceRoot: await makeTempDir(),
      toolPackRegistry: await createRegistry(),
      authToken: "broker-secret",
      executionIsolationAttested: true,
      authorizeSourceAddress: () => true
    });
    const server = createBrokerServer({ broker, authToken: "broker-secret", ompRuntime });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected an ephemeral TCP port.");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    expect((await fetch(`${baseUrl}/health/omp-runtime`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/omp/sessions/${runtimeRunId}`)).status).toBe(401);
    const headers = { authorization: "Bearer broker-secret", "content-type": "application/json" };
    const fetched = await fetch(`${baseUrl}/omp/sessions/${runtimeRunId}`, { headers });
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toMatchObject({ runtimeRunId, state: "running" });

    const events = await fetch(`${baseUrl}/omp/sessions/${runtimeRunId}/events?afterSequence=2&limit=10`, { headers });
    expect(await events.json()).toMatchObject({ events: [{ sequence: 3, toolName: "grep" }] });
    const controlled = await fetch(`${baseUrl}/omp/sessions/${runtimeRunId}/control`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "pause",
        idempotencyKey: "pause-1",
        expectedEventCursor: 3
      })
    });
    expect(controlled.status).toBe(200);
    expect(control).toEqual({ action: "pause", idempotencyKey: "pause-1", expectedEventCursor: 3 });

    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
});
