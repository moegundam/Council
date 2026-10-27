import { describe, expect, it, vi } from "vitest";
import { HttpSandboxBackend, SandboxBackendError } from "./sandbox-backend.js";

const lease = {
  id: "70000000-0000-4000-8000-000000000001",
  scopeId: "task:70000000-0000-4000-8000-000000000002:attempt:1",
  backend: "external" as const,
  instanceId: "sandbox-70000000-0000-4000-8000-000000000001",
  state: "active" as const,
  imageDigest: `sha256:${"a".repeat(64)}`,
  cpuLimit: 1,
  memoryMb: 256,
  diskMb: 512,
  processLimit: 2,
  networkPolicy: "deny_all" as const,
  allowlistedHosts: [] as string[],
  createdAt: "2026-08-03T00:00:00.000Z",
  lastUsedAt: "2026-08-03T00:00:00.000Z",
  expiresAt: "2026-08-03T00:10:00.000Z",
  destroyedAt: null,
  checkpointRef: null
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("HttpSandboxBackend", () => {
  it("requires an exact ready health response before reporting availability", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => json({ ok: true, ready: true }));
    const backend = new HttpSandboxBackend({
      baseUrl: "http://sandbox-broker:8080",
      token: async () => "broker-token",
      fetchImpl
    });

    await expect(backend.health()).resolves.toEqual({ ready: true });
    expect(fetchImpl).toHaveBeenCalledWith("http://sandbox-broker:8080/health", expect.objectContaining({
      method: "GET",
      redirect: "manual"
    }));
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).headers).not.toHaveProperty("authorization");
  });

  it("uses bearer auth, validates lease responses, and never exposes the broker workspace path", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => json({
      created: true,
      lease,
      scopeId: lease.scopeId
    }, 201));
    const backend = new HttpSandboxBackend({
      baseUrl: "http://sandbox-broker:8080/",
      token: async () => "broker-token",
      fetchImpl
    });

    const result = await backend.createLease({
      idempotencyKey: "lease-key",
      scopeId: lease.scopeId,
      workspaceSubpath: "task/attempt-1",
      imageDigest: lease.imageDigest,
      cpuLimit: 1,
      memoryMb: 256,
      diskMb: 512,
      processLimit: 2,
      ttlMs: 60_000,
      networkPolicy: "deny_all",
      allowlistedHosts: []
    });

    expect(result).toEqual({ created: true, lease });
    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).toMatchObject({
      authorization: "Bearer broker-token",
      "content-type": "application/json"
    });
    expect(JSON.parse(String(request.body))).toMatchObject({ imageDigest: lease.imageDigest, networkPolicy: "deny_all" });
  });

  it("accepts only digest-bound execution evidence and maps broker failures without response bodies", async () => {
    const evidence = {
      replayed: false,
      leaseId: lease.id,
      scopeId: lease.scopeId,
      toolPack: {
        id: "repo-inspector",
        version: "1.0.0",
        digest: `sha256:${"b".repeat(64)}`,
        reference: `repo-inspector@sha256:${"c".repeat(64)}`,
        executableDigest: "d".repeat(64)
      },
      tool: { name: "scan", argv: ["read-only"] },
      exit: { code: 0, signal: null, timedOut: false },
      timing: {
        startedAt: "2026-08-03T00:00:00.000Z",
        completedAt: "2026-08-03T00:00:01.000Z",
        durationMs: 1_000
      },
      output: {
        stdoutText: "ok",
        stderrText: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        outputDigest: `sha256:${"e".repeat(64)}`
      }
    };
    const success = new HttpSandboxBackend({
      baseUrl: "https://sandbox.example.test",
      token: async () => "broker-token",
      fetchImpl: vi.fn(async () => json(evidence))
    });
    await expect(success.executeTool({
      leaseId: lease.id,
      idempotencyKey: "run-key",
      toolPackId: "repo-inspector",
      toolName: "scan",
      argv: ["read-only"]
    })).resolves.toEqual(evidence);

    const invalid = new HttpSandboxBackend({
      baseUrl: "https://sandbox.example.test",
      token: async () => "broker-token",
      fetchImpl: vi.fn(async () => json({ ...evidence, toolPack: { ...evidence.toolPack, digest: "latest" } }))
    });
    await expect(invalid.executeTool({
      leaseId: lease.id,
      idempotencyKey: "run-key",
      toolPackId: "repo-inspector",
      toolName: "scan",
      argv: ["read-only"]
    })).rejects.toThrow(/response/i);

    const denied = new HttpSandboxBackend({
      baseUrl: "https://sandbox.example.test",
      token: async () => "broker-token",
      fetchImpl: vi.fn(async () => json({ error: "invalid_request", message: "sensitive detail" }, 400))
    });
    await expect(denied.destroyLease(lease.id)).rejects.toMatchObject({
      name: "SandboxBackendError",
      statusCode: 400,
      message: "Sandbox broker request failed with status 400."
    });
  });

  it("rejects credentialed or path-bearing broker origins", () => {
    expect(() => new HttpSandboxBackend({
      baseUrl: "https://user:secret@sandbox.example.test/path",
      token: async () => "token"
    })).toThrow(SandboxBackendError);
  });
});
