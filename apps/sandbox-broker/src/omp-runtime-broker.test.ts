import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OmpBrokerArtifactManifest, OmpBrokerStartRequest } from "@council/contracts";
import {
  createOmpRuntimeBroker,
  OmpBrokerConflictError,
  type OmpContainerExit,
  type OmpContainerHandle,
  type OmpContainerRuntime,
  type OmpContainerStartInput
} from "./omp-runtime-broker.js";

class AsyncLines implements AsyncIterable<string> {
  private readonly values: string[] = [];
  private readonly waiters: Array<(value: IteratorResult<string>) => void> = [];
  private closed = false;

  push(value: unknown): void {
    const line = JSON.stringify(value);
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: line, done: false });
    else this.values.push(line);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { value, done: false };
        if (this.closed) return { value: undefined, done: true };
        return new Promise<IteratorResult<string>>((resolve) => this.waiters.push(resolve));
      }
    };
  }
}

class FakeOmpRuntime implements OmpContainerRuntime {
  readonly starts: OmpContainerStartInput[] = [];
  readonly writes: Array<Record<string, unknown>> = [];
  readonly lines = new AsyncLines();
  private promptId: string | null = null;
  private resolveExit!: (exit: OmpContainerExit) => void;
  private readonly exit = new Promise<OmpContainerExit>((resolve) => { this.resolveExit = resolve; });

  constructor(private readonly reportedTools: string[] | null = null) {}

  health = async () => ({
    rootless: true,
    rootfulSocketAbsent: true,
    resourceLimitsEnforced: true,
    networkPolicyEnforced: true,
    imagePinned: true,
    modelGatewayReady: true
  });

  async start(input: OmpContainerStartInput): Promise<OmpContainerHandle> {
    this.starts.push(input);
    queueMicrotask(() => this.lines.push({
      type: "ready",
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
      maxFrameBytes: 1_048_576,
      maxReassembledFrameBytes: 67_108_864
    }));
    return {
      containerId: `rootless-container-${this.starts.length}`,
      stdoutLines: this.lines,
      completion: this.exit,
      writeLine: async (line) => {
        const frame = JSON.parse(line.trim()) as Record<string, unknown>;
        this.writes.push(frame);
        const id = frame.id;
        const command = frame.type;
        if (command === "negotiate_protocol") {
          this.lines.push({ id, type: "response", command, success: true, data: { protocolVersion: 2 } });
        } else if (command === "get_state") {
          this.lines.push({
            id,
            type: "response",
            command,
            success: true,
            data: {
              sessionId: "omp-session-1",
              sessionFile: "/opt/council-omp-config/sessions/session-1.jsonl",
              dumpTools: (this.reportedTools ?? input.allowedTools).map((name) => ({ name }))
            }
          });
        } else if (command === "prompt") {
          this.promptId = String(id);
          this.lines.push({ id, type: "response", command, success: true, data: { agentInvoked: true } });
        } else if (command === "steer" || command === "abort") {
          this.lines.push({ id, type: "response", command, success: true });
        }
      },
      terminate: async () => {
        this.lines.close();
        this.resolveExit({ exitCode: 0, signal: null });
      }
    };
  }

  async collectArtifacts(input: { runtimeRunId: string; workspacePath: string; artifactRoot: string }) {
    const manifest: OmpBrokerArtifactManifest = {
      artifactRef: `runtime-run/${input.runtimeRunId}/artifacts/manifest.json`,
      patchDigest: `sha256:${"d".repeat(64)}`,
      manifestDigest: `sha256:${"e".repeat(64)}`,
      changedFiles: [{ path: "src/result.ts", status: "modified", digest: `sha256:${"f".repeat(64)}` }],
      tests: [{ commandDigest: `sha256:${"1".repeat(64)}`, exitCode: 0, durationMs: 25, outputDigest: `sha256:${"2".repeat(64)}` }],
      createdAt: new Date().toISOString()
    };
    return manifest;
  }

  finish(): void {
    if (!this.promptId) throw new Error("No active prompt.");
    this.lines.push({ type: "agent_end", isTerminal: true, messages: [] });
    this.promptId = null;
  }
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(runtime = new FakeOmpRuntime()) {
  const root = await mkdtemp(join(tmpdir(), "council-omp-broker-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  const sourceRoot = join(root, "sources");
  const sourceBytes = Buffer.from("bounded test archive");
  const sourceDigest = `sha256:${createHash("sha256").update(sourceBytes).digest("hex")}` as const;
  const sourceDir = join(sourceRoot, "council-canary");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, `${sourceDigest.slice("sha256:".length)}.tar`), sourceBytes);
  const taskId = "70000000-0000-4000-8000-000000000001";
  const request: OmpBrokerStartRequest = {
    runtimeRunId: "70000000-0000-4000-8000-000000000006",
    goalRunId: "70000000-0000-4000-8000-000000000007",
    taskId,
    idempotencyKey: "omp-start-1",
    executionBinding: {
      planTaskId: taskId,
      route: "omp_coding",
      runtimeProfileId: "70000000-0000-4000-8000-000000000002",
      runtimeProfileRevision: 1,
      harnessKind: "pi",
      runtimeVersion: "omp-rpc-v2@18.1.2",
      policy: "isolated_exec",
      capabilities: ["text", "file_read", "file_write", "process"],
      agentId: "70000000-0000-4000-8000-000000000003",
      agentRevision: 1,
      modelConnectorId: "70000000-0000-4000-8000-000000000004",
      modelConnectorRevision: 2,
      modelConnectorSecretRevision: 0,
      sandboxProfileId: "70000000-0000-4000-8000-000000000005",
      sandboxImageDigest: `sha256:${"a".repeat(64)}`,
      workspaceSource: { sourceId: "council-canary", archiveDigest: sourceDigest },
      allowedTools: ["read", "grep", "glob", "lsp", "edit", "bash"],
      dataScopeDigest: "c".repeat(64),
      timeoutMs: 2 * 60 * 60_000
    },
    model: {
      id: "70000000-0000-4000-8000-000000000004",
      revision: 2,
      secretRevision: 0,
      location: "local",
      baseUrl: "http://model-tunnel:4001/v1",
      model: "gb10-coder"
    },
    prompt: "Implement only the Owner-approved task and produce reviewable artifacts."
  };
  const broker = await createOmpRuntimeBroker({ dataRoot, sourceRoot, runtime, isolationAttested: true });
  return { broker, dataRoot, sourceRoot, runtime, request };
}

async function waitForState(
  broker: Awaited<ReturnType<typeof createOmpRuntimeBroker>>,
  id: string,
  state: string
) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const session = await broker.get(id);
    if (session?.state === state) return session;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${state}.`);
}

describe("OMP Runtime Broker", () => {
  it("starts one durable rootless Session and returns a digest-only artifact manifest", async () => {
    const { broker, runtime, request } = await fixture();
    const started = await broker.start(request);
    expect(started).toMatchObject({ state: "running", providerSessionId: "omp-session-1", eventCursor: expect.any(Number) });
    expect(runtime.starts).toHaveLength(1);
    expect(runtime.starts[0]).toMatchObject({
      imageDigest: request.executionBinding.sandboxImageDigest,
      allowedTools: request.executionBinding.allowedTools,
      resumeSessionFile: null
    });

    await expect(broker.start(request)).resolves.toMatchObject({ runtimeRunId: request.runtimeRunId });
    expect(runtime.starts).toHaveLength(1);
    await expect(broker.start({ ...request, prompt: "Different request" })).rejects.toBeInstanceOf(OmpBrokerConflictError);

    runtime.finish();
    const completed = await waitForState(broker, request.runtimeRunId, "completed");
    expect(completed.artifactManifest).toMatchObject({
      patchDigest: `sha256:${"d".repeat(64)}`,
      changedFiles: [{ path: "src/result.ts", status: "modified" }]
    });
    const acknowledged = await broker.control(request.runtimeRunId, {
      action: "resume",
      idempotencyKey: "control-acknowledge-completed-1",
      expectedEventCursor: completed.eventCursor - 1
    });
    expect(acknowledged).toEqual(completed);
    expect(runtime.starts).toHaveLength(1);
    expect(JSON.stringify(await broker.events(request.runtimeRunId))).not.toContain("messages");
  });

  it("supports steer, pause, resume, and cancel without persisting Owner guidance", async () => {
    const { broker, runtime, request } = await fixture();
    let session = await broker.start(request);
    const guidance = "Focus on the failing unit test and do not change deployment files.";
    session = await broker.control(request.runtimeRunId, {
      action: "steer",
      idempotencyKey: "control-steer-1",
      expectedEventCursor: session.eventCursor,
      message: guidance
    });
    expect(JSON.stringify(await broker.events(request.runtimeRunId))).not.toContain(guidance);

    session = await broker.control(request.runtimeRunId, {
      action: "pause",
      idempotencyKey: "control-pause-1",
      expectedEventCursor: session.eventCursor
    });
    expect(session).toMatchObject({ state: "paused", errorCode: "owner_paused" });

    session = await broker.control(request.runtimeRunId, {
      action: "resume",
      idempotencyKey: "control-resume-1",
      expectedEventCursor: session.eventCursor
    });
    expect(session.state).toBe("running");
    expect(runtime.starts).toHaveLength(1);

    session = await broker.control(request.runtimeRunId, {
      action: "cancel",
      idempotencyKey: "control-cancel-1",
      expectedEventCursor: session.eventCursor
    });
    expect(session).toMatchObject({ state: "cancelled", errorCode: "owner_cancelled" });
  });

  it("marks interrupted Sessions paused instead of starting a replacement", async () => {
    const { broker, dataRoot, sourceRoot, runtime, request } = await fixture();
    await broker.start(request);
    const replacement = await createOmpRuntimeBroker({ dataRoot, sourceRoot, runtime: new FakeOmpRuntime(), isolationAttested: true });
    expect(await replacement.get(request.runtimeRunId)).toMatchObject({
      state: "paused",
      errorCode: "provider_outcome_unknown"
    });
    expect(runtime.starts).toHaveLength(1);
  });

  it("rejects an OMP Session that reports an incomplete approved tool set", async () => {
    const { broker, request } = await fixture(new FakeOmpRuntime(["read"]));
    await expect(broker.start(request)).rejects.toThrow(/tool allowlist/i);
    await expect(broker.get(request.runtimeRunId)).resolves.toMatchObject({ state: "failed" });
  });
});
