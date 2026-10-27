import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrokerConflictError,
  BrokerValidationError,
  createSandboxBroker
} from "./sandbox-broker.js";
import { createToolPackManifestDigest, createToolPackRegistry } from "./tool-pack-registry.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-broker-"));
  tempDirs.push(directory);
  return directory;
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function createRegistry() {
  const echoScriptPath = fileURLToPath(new URL("./test-fixtures/echo-tool.js", import.meta.url));
  const sleepScriptPath = fileURLToPath(new URL("./test-fixtures/sleep-tool.js", import.meta.url));
  const countScriptPath = fileURLToPath(new URL("./test-fixtures/count-tool.js", import.meta.url));
  const processTreeScriptPath = fileURLToPath(new URL("./test-fixtures/process-tree-tool.js", import.meta.url));
  const executableDigest = await sha256File(process.execPath);
  const manifest = {
    id: "node-tools",
    version: "1.0.0",
    reference: `node-tools@sha256:${"1".repeat(64)}`,
    executablePath: process.execPath,
    executableDigest,
    tools: {
      echo_env: {
        baseArgs: [echoScriptPath],
        allowedArgvSets: [["emit"]],
        envAllowlist: ["BROKER_TEST_SECRET"],
        allowStdin: false
      },
      sleep: {
        baseArgs: [sleepScriptPath],
        allowedArgvSets: [["wait"]],
        envAllowlist: [],
        allowStdin: false
      },
      count: {
        baseArgs: [countScriptPath],
        allowedArgvSets: [["once"]],
        envAllowlist: [],
        allowStdin: false
      },
      process_tree: {
        baseArgs: [processTreeScriptPath],
        allowedArgvSets: [["start"]],
        envAllowlist: [],
        allowStdin: false
      }
    }
  };
  return createToolPackRegistry([{ ...manifest, digest: createToolPackManifestDigest(manifest) }]);
}

function expectLeaseContractShape(lease: Record<string, unknown>): void {
  expect(Object.keys(lease).sort()).toEqual([
    "allowlistedHosts",
    "backend",
    "checkpointRef",
    "cpuLimit",
    "createdAt",
    "destroyedAt",
    "diskMb",
    "expiresAt",
    "id",
    "imageDigest",
    "instanceId",
    "lastUsedAt",
    "memoryMb",
    "networkPolicy",
    "processLimit",
    "scopeId",
    "state"
  ].sort());
  expect(lease.id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(lease.backend).toBe("external");
  expect(lease.state === "active" || lease.state === "idle" || lease.state === "destroyed").toBe(true);
  expect(lease.imageDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(lease.networkPolicy).toBe("deny_all");
  expect(lease.allowlistedHosts).toEqual([]);
  expect(lease.createdAt).toMatch(/Z$/);
  expect(lease.lastUsedAt).toMatch(/Z$/);
  expect(lease.expiresAt).toMatch(/Z$/);
}

describe("createSandboxBroker", () => {
  afterEach(async () => {
    delete process.env.SANDBOX_BROKER_PARENT_SECRET;
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("creates, validates, destroys, reconciles, and never resurrects a lease", async () => {
    const workspaceRoot = await makeTempDir();
    const registry = await createRegistry();
    let now = new Date("2026-08-03T00:00:00.000Z");
    const broker = await createSandboxBroker({
      workspaceRoot,
      toolPackRegistry: registry,
      now: () => now,
      authToken: "broker-secret"
    });

    const created = await broker.createLease({
      idempotencyKey: "lease-1",
      scopeId: "scope-a",
      workspaceSubpath: "scope-a/lease-1",
      imageDigest: `sha256:${"2".repeat(64)}`,
      cpuLimit: 1,
      memoryMb: 256,
      diskMb: 512,
      processLimit: 1,
      ttlMs: 1_000,
      networkPolicy: "deny_all",
      allowlistedHosts: []
    });
    expectLeaseContractShape(created.lease as unknown as Record<string, unknown>);
    expect(created.workspacePath.startsWith(workspaceRoot)).toBe(true);

    const duplicated = await broker.createLease({
      idempotencyKey: "lease-1",
      scopeId: "scope-a",
      workspaceSubpath: "scope-a/lease-1",
      imageDigest: `sha256:${"2".repeat(64)}`,
      cpuLimit: 1,
      memoryMb: 256,
      diskMb: 512,
      processLimit: 1,
      ttlMs: 1_000,
      networkPolicy: "deny_all",
      allowlistedHosts: []
    });
    expect(duplicated.lease.id).toBe(created.lease.id);

    const destroyed = await broker.destroyLease(created.lease.id);
    expect(destroyed.lease.state).toBe("destroyed");

    const repeatedDestroy = await broker.destroyLease(created.lease.id);
    expect(repeatedDestroy.lease.id).toBe(created.lease.id);
    expect(repeatedDestroy.lease.state).toBe("destroyed");

    const noResurrection = await broker.createLease({
      idempotencyKey: "lease-1",
      scopeId: "scope-a",
      workspaceSubpath: "scope-a/lease-1",
      imageDigest: `sha256:${"2".repeat(64)}`,
      cpuLimit: 1,
      memoryMb: 256,
      diskMb: 512,
      processLimit: 1,
      ttlMs: 1_000,
      networkPolicy: "deny_all",
      allowlistedHosts: []
    });
    expect(noResurrection.lease.state).toBe("destroyed");
    expect(noResurrection.lease.id).toBe(created.lease.id);

    const expiring = await broker.createLease({
      idempotencyKey: "lease-2",
      scopeId: "scope-b",
      workspaceSubpath: "scope-b/lease-2",
      imageDigest: `sha256:${"3".repeat(64)}`,
      cpuLimit: 1,
      memoryMb: 256,
      diskMb: 512,
      processLimit: 1,
      ttlMs: 1_000,
      networkPolicy: "deny_all",
      allowlistedHosts: []
    });
    now = new Date("2026-08-03T00:00:02.000Z");

    const reconciled = await broker.reconcileLeases();
    expect(reconciled.destroyedLeaseIds).toContain(expiring.lease.id);
    expect((await broker.getLease(expiring.lease.id))?.lease.state).toBe("destroyed");
  });

  it("rejects allowlist network requests until a real egress enforcer exists", async () => {
    const broker = await createSandboxBroker({
      workspaceRoot: await makeTempDir(),
      toolPackRegistry: await createRegistry(),
      authToken: "broker-secret"
    });

    await expect(broker.createLease({
      idempotencyKey: "lease-egress",
      scopeId: "scope-egress",
      workspaceSubpath: "scope-egress/lease-egress",
      imageDigest: `sha256:${"4".repeat(64)}`,
      cpuLimit: 1,
      memoryMb: 256,
      diskMb: 512,
      processLimit: 1,
      ttlMs: 1_000,
      networkPolicy: "allowlist",
      allowlistedHosts: ["example.com"]
    })).rejects.toThrow(BrokerValidationError);
  });

  it("coalesces concurrent lease and run idempotency without duplicate execution", async () => {
    const broker = await createSandboxBroker({
      workspaceRoot: await makeTempDir(),
      toolPackRegistry: await createRegistry(),
      authToken: "broker-secret",
      executionIsolationAttested: true
    });
    const leaseInput = {
      idempotencyKey: "lease-concurrent",
      scopeId: "scope-concurrent",
      workspaceSubpath: "scope-concurrent/lease-concurrent",
      imageDigest: `sha256:${"9".repeat(64)}`,
      cpuLimit: 1,
      memoryMb: 256,
      diskMb: 512,
      processLimit: 2,
      ttlMs: 10_000,
      networkPolicy: "deny_all" as const,
      allowlistedHosts: []
    };

    const [firstLease, secondLease] = await Promise.all([
      broker.createLease(leaseInput),
      broker.createLease(leaseInput)
    ]);
    expect(secondLease.lease.id).toBe(firstLease.lease.id);

    const runInput = {
      leaseId: firstLease.lease.id,
      idempotencyKey: "run-concurrent",
      toolPackId: "node-tools",
      toolName: "count",
      argv: ["once"]
    };
    const [firstRun, secondRun] = await Promise.all([
      broker.executeTool(runInput),
      broker.executeTool(runInput)
    ]);
    expect([firstRun.replayed, secondRun.replayed].sort()).toEqual([false, true]);
    expect((await readFile(`${firstLease.workspacePath}/counter.log`, "utf8")).trim().split("\n")).toHaveLength(1);
  }, 15_000);

  it("revalidates the workspace before each run and bounds retained lease records", async () => {
    const workspaceRoot = await makeTempDir();
    const broker = await createSandboxBroker({
      workspaceRoot,
      toolPackRegistry: await createRegistry(),
      authToken: "broker-secret",
      executionIsolationAttested: true,
      maxLeaseRecords: 1
    });
    const lease = await broker.createLease({
      idempotencyKey: "lease-workspace-swap",
      scopeId: "scope-workspace-swap",
      workspaceSubpath: "scope-workspace-swap/lease-workspace-swap",
      imageDigest: `sha256:${"a".repeat(64)}`,
      cpuLimit: 1,
      memoryMb: 256,
      diskMb: 512,
      processLimit: 1,
      ttlMs: 10_000,
      networkPolicy: "deny_all",
      allowlistedHosts: []
    });
    await expect(broker.createLease({
      idempotencyKey: "lease-over-cap",
      scopeId: "scope-over-cap",
      workspaceSubpath: "scope-over-cap/lease-over-cap",
      imageDigest: `sha256:${"b".repeat(64)}`,
      cpuLimit: 1,
      memoryMb: 256,
      diskMb: 512,
      processLimit: 1,
      ttlMs: 10_000,
      networkPolicy: "deny_all",
      allowlistedHosts: []
    })).rejects.toThrow(/record limit/i);

    const outside = await makeTempDir();
    await rm(lease.workspacePath, { recursive: true, force: true });
    await symlink(outside, lease.workspacePath);
    await expect(broker.executeTool({
      leaseId: lease.lease.id,
      idempotencyKey: "run-after-swap",
      toolPackId: "node-tools",
      toolName: "echo_env",
      argv: ["emit"],
      env: { BROKER_TEST_SECRET: "redact-me" }
    })).rejects.toThrow(/workspace|symlink/i);
  });

  it("refuses execution until the deployment attests OS-level isolation", async () => {
    const broker = await createSandboxBroker({
      workspaceRoot: await makeTempDir(),
      toolPackRegistry: await createRegistry(),
      authToken: "broker-secret"
    });
    const lease = await broker.createLease({
      idempotencyKey: "lease-no-isolation",
      scopeId: "scope-no-isolation",
      workspaceSubpath: "scope-no-isolation/lease-no-isolation",
      imageDigest: `sha256:${"c".repeat(64)}`,
      cpuLimit: 1,
      memoryMb: 256,
      diskMb: 512,
      processLimit: 1,
      ttlMs: 10_000,
      networkPolicy: "deny_all",
      allowlistedHosts: []
    });

    await expect(broker.executeTool({
      leaseId: lease.lease.id,
      idempotencyKey: "run-no-isolation",
      toolPackId: "node-tools",
      toolName: "echo_env",
      argv: ["emit"],
      env: { BROKER_TEST_SECRET: "redact-me" }
    })).rejects.toThrow(/isolation/i);
  });

  it("executes only registered tools with bounded env and redacted evidence", async () => {
    process.env.SANDBOX_BROKER_PARENT_SECRET = "parent-secret";
    const broker = await createSandboxBroker({
      workspaceRoot: await makeTempDir(),
      toolPackRegistry: await createRegistry(),
      authToken: "broker-secret",
      executionIsolationAttested: true
    });
    const lease = await broker.createLease({
      idempotencyKey: "lease-run",
      scopeId: "scope-run",
      workspaceSubpath: "scope-run/lease-run",
      imageDigest: `sha256:${"5".repeat(64)}`,
      cpuLimit: 1,
      memoryMb: 256,
      diskMb: 512,
      processLimit: 1,
      ttlMs: 10_000,
      networkPolicy: "deny_all",
      allowlistedHosts: []
    });

    const run = await broker.executeTool({
      leaseId: lease.lease.id,
      idempotencyKey: "run-1",
      toolPackId: "node-tools",
      toolName: "echo_env",
      argv: ["emit"],
      env: { BROKER_TEST_SECRET: "topsecret" }
    });

    expect(run.exit.code).toBe(0);
    expect(run.output.stdoutText).toContain("[REDACTED]");
    expect(run.output.stderrText).toContain("[REDACTED]");
    expect(run.output.stdoutText).not.toContain("topsecret");
    expect(run.output.stdoutText).not.toContain("parent-secret");
    expect(run.output.stdoutText).toContain("parent=<missing>");
    expect(run.toolPack.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(run.output.outputDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  }, 15_000);

  it("caps concurrency per lease and cancels active processes with TERM then KILL on destroy", async () => {
    const broker = await createSandboxBroker({
      workspaceRoot: await makeTempDir(),
      toolPackRegistry: await createRegistry(),
      authToken: "broker-secret",
      executionIsolationAttested: true,
      terminationGraceMs: 25
    });
    const lease = await broker.createLease({
      idempotencyKey: "lease-sleep",
      scopeId: "scope-sleep",
      workspaceSubpath: "scope-sleep/lease-sleep",
      imageDigest: `sha256:${"6".repeat(64)}`,
      cpuLimit: 1,
      memoryMb: 256,
      diskMb: 512,
      processLimit: 1,
      ttlMs: 10_000,
      networkPolicy: "deny_all",
      allowlistedHosts: []
    });

    const running = broker.executeTool({
      leaseId: lease.lease.id,
      idempotencyKey: "run-sleep-1",
      toolPackId: "node-tools",
      toolName: "sleep",
      argv: ["wait"]
    });
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (await readFile(`${lease.workspacePath}/sleep.ready`, "utf8").then(() => true).catch(() => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await expect(readFile(`${lease.workspacePath}/sleep.ready`, "utf8")).resolves.toBe("ready");

    await expect(broker.executeTool({
      leaseId: lease.lease.id,
      idempotencyKey: "run-sleep-2",
      toolPackId: "node-tools",
      toolName: "sleep",
      argv: ["wait"]
    })).rejects.toThrow(BrokerConflictError);

    await broker.destroyLease(lease.lease.id);
    const cancelled = await running;
    expect(cancelled.exit.signal).toBe("SIGKILL");
  }, 10_000);

  it("terminates the complete process group when a lease is destroyed", async () => {
    const broker = await createSandboxBroker({
      workspaceRoot: await makeTempDir(),
      toolPackRegistry: await createRegistry(),
      authToken: "broker-secret",
      executionIsolationAttested: true,
      terminationGraceMs: 25
    });
    const lease = await broker.createLease({
      idempotencyKey: "lease-process-tree",
      scopeId: "scope-process-tree",
      workspaceSubpath: "scope-process-tree/lease-process-tree",
      imageDigest: `sha256:${"d".repeat(64)}`,
      cpuLimit: 1,
      memoryMb: 256,
      diskMb: 512,
      processLimit: 2,
      ttlMs: 10_000,
      networkPolicy: "deny_all",
      allowlistedHosts: []
    });
    const running = broker.executeTool({
      leaseId: lease.lease.id,
      idempotencyKey: "run-process-tree",
      toolPackId: "node-tools",
      toolName: "process_tree",
      argv: ["start"]
    });

    let descendantPid = 0;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      descendantPid = Number.parseInt(await readFile(`${lease.workspacePath}/descendant.pid`, "utf8").catch(() => "0"), 10);
      if (descendantPid > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(descendantPid).toBeGreaterThan(0);
    await broker.destroyLease(lease.lease.id);
    await running;

    let alive = true;
    for (let attempt = 0; attempt < 400 && alive; attempt += 1) {
      try {
        process.kill(descendantPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 10));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }, 10_000);
});
