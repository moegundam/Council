import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOmpBrokerClient, createOmpBrokerClientFromEnv, OmpBrokerHttpError } from "./omp-broker-client.js";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OMP Broker client", () => {
  it("uses bearer auth, forbids redirects, and validates Broker responses", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify({
      ok: true,
      ready: true,
      runtimeVersion: "omp-rpc-v2@18.1.2",
      rootless: true,
      rootfulSocketAbsent: true,
      isolationAttested: true,
      maxConcurrency: 1
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createOmpBrokerClient({ baseUrl: "http://sandbox-broker:8080", authToken: "secret" });
    await expect(client.health()).resolves.toMatchObject({ ready: true });
    expect(fetchMock).toHaveBeenCalledWith(new URL("http://sandbox-broker:8080/health/omp-runtime"), expect.objectContaining({
      redirect: "error",
      headers: expect.objectContaining({ authorization: "Bearer secret" })
    }));

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, ready: "yes" }), { status: 200 }));
    await expect(client.health()).rejects.toBeInstanceOf(Error);
  });

  it("maps only GET Session 404 to null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const client = createOmpBrokerClient({ baseUrl: "http://sandbox-broker:8080", authToken: "secret" });
    await expect(client.get("70000000-0000-4000-8000-000000000006")).resolves.toBeNull();
    await expect(client.health()).rejects.toBeInstanceOf(OmpBrokerHttpError);
  });

  it("loads the token from a mounted file only when explicitly enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-client-"));
    roots.push(root);
    const tokenFile = join(root, "token");
    await writeFile(tokenFile, "mounted-secret\n", { mode: 0o600 });
    await expect(createOmpBrokerClientFromEnv({ OMP_RUNTIME_ENABLED: "false" })).resolves.toBeUndefined();
    await expect(createOmpBrokerClientFromEnv({ OMP_RUNTIME_ENABLED: "yes" })).rejects.toThrow();
    await expect(createOmpBrokerClientFromEnv({
      OMP_RUNTIME_ENABLED: "true",
      OMP_BROKER_URL: "http://sandbox-broker:8080",
      OMP_BROKER_TOKEN_FILE: tokenFile
    })).resolves.toBeDefined();
    await expect(createOmpBrokerClientFromEnv({
      OMP_RUNTIME_ENABLED: "true",
      OMP_BROKER_URL: "http://user:secret@sandbox-broker:8080",
      OMP_BROKER_TOKEN_FILE: tokenFile
    })).rejects.toThrow(/credential-free/i);
  });
});
