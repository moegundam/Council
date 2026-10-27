import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OmpContainerExit, OmpContainerStartInput } from "./omp-runtime-broker.js";
import {
  OMP_PHASE_ONE_TOOLS,
  RootlessDockerOmpRuntime,
  RootlessDockerRuntimeError,
  type DockerAttachedProcess,
  type DockerCommandOptions,
  type DockerCommandResult,
  type RootlessDockerCommandRunner
} from "./rootless-docker-runtime.js";

const imageDigest = `sha256:${"a".repeat(64)}`;
const runtimeRunId = "70000000-0000-4000-8000-000000000006";

class FakeAttached implements DockerAttachedProcess {
  readonly writes: string[] = [];
  private resolveExit!: (value: OmpContainerExit) => void;
  readonly completion = new Promise<OmpContainerExit>((resolvePromise) => { this.resolveExit = resolvePromise; });
  readonly stdoutLines = (async function* () {})();

  async writeLine(line: string): Promise<void> {
    this.writes.push(line);
  }

  async terminate(): Promise<void> {
    this.resolveExit({ exitCode: 0, signal: null });
  }
}

class FakeRunner implements RootlessDockerCommandRunner {
  readonly runs: string[][] = [];
  readonly attachments: string[][] = [];
  readonly attached = new FakeAttached();
  volumeExists = false;
  artifactDestination: string | null = null;
  sourceTransfer: { source: string; destination: string; mode: number } | null = null;
  readonly info: Record<string, unknown> = {
    SecurityOptions: ["name=seccomp", "name=rootless"],
    CgroupVersion: "2",
    MemoryLimit: true,
    PidsLimit: true,
    CpuCfsPeriod: true,
    CpuCfsQuota: true
  };

  async run(args: readonly string[], _options?: DockerCommandOptions): Promise<DockerCommandResult> {
    const command = [...args];
    this.runs.push(command);
    if (command[0] === "info") return ok(JSON.stringify(this.info));
    if (command[0] === "network") return ok(JSON.stringify({ Internal: true }));
    if (command[0] === "inspect" && command[1] === "model-tunnel") return ok(JSON.stringify({
      State: { Running: true, Health: { Status: "healthy" } },
      NetworkSettings: { Networks: { "council-omp-internal": {} } }
    }));
    if (command[0] === "image") return ok(JSON.stringify({ Id: imageDigest, RepoDigests: [] }));
    if (command[0] === "volume" && command[1] === "inspect") {
      return this.volumeExists ? ok("[]") : { exitCode: 1, stdout: "", stderr: "not found" };
    }
    if (command[0] === "ps" && command.includes("label=com.council.omp.session=true")) return ok("session-a\nsession-b\n");
    if (command[0] === "ps") return ok("transient-a\n");
    if (command[0] === "cp" && command[1]?.includes(":/workspace/.council-artifacts/.")) {
      const destination = command[2]!;
      this.artifactDestination = destination;
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "changes.patch"), "diff --git a/a.ts b/a.ts\n");
      await writeFile(join(destination, "manifest-source.json"), JSON.stringify({
        changedFiles: [{ path: "a.ts", status: "modified", digest: `sha256:${"b".repeat(64)}` }],
        tests: []
      }));
    }
    if (command[0] === "cp" && command[2]?.endsWith(":/council-config/.council-source.tar")) {
      this.sourceTransfer = {
        source: command[1]!,
        destination: command[2],
        mode: (await stat(command[1]!)).mode & 0o777
      };
    }
    return ok("");
  }

  attach(args: readonly string[]): DockerAttachedProcess {
    this.attachments.push([...args]);
    return this.attached;
  }
}

function ok(stdout: string): DockerCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function config(overrides = {}) {
  return {
    dockerHost: "unix:///run/user/1000/docker.sock",
    imageReference: `council-omp@${imageDigest}`,
    imageDigest,
    internalNetwork: "council-omp-internal",
    modelGatewayContainer: "model-tunnel",
    approvedModelBaseUrl: "http://model-tunnel:4001/v1",
    rootfulSocketExists: () => false,
    diskPollMs: 60_000,
    ...overrides
  };
}

function startInput(overrides: Partial<OmpContainerStartInput> = {}): OmpContainerStartInput {
  return {
    runtimeRunId,
    imageDigest,
    workspacePath: "/broker/runs/workspace",
    sourceArchivePath: "/broker/sources/source.tar",
    modelBaseUrl: "http://model-tunnel:4001/v1",
    modelId: "gb10-coder",
    allowedTools: [...OMP_PHASE_ONE_TOOLS],
    timeoutMs: 2 * 60 * 60_000,
    cpuLimit: 2,
    memoryMb: 8_192,
    processLimit: 256,
    diskMb: 8_192,
    resumeSessionFile: null,
    ...overrides
  };
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("RootlessDockerOmpRuntime", () => {
  it("rejects rootful and unpinned Docker endpoints before any command runs", () => {
    expect(() => new RootlessDockerOmpRuntime(config({ dockerHost: "unix:///var/run/docker.sock" }), new FakeRunner()))
      .toThrow(/rootless Docker endpoint/i);
    expect(() => new RootlessDockerOmpRuntime(config({ imageReference: "council-omp:latest" }), new FakeRunner()))
      .toThrow(/pinned/i);
  });

  it.each([
    "ftp://model-tunnel:4001/v1",
    "http://user:secret@model-tunnel:4001/v1",
    "http://another-host:4001/v1"
  ])("rejects an unapproved model gateway URL: %s", (approvedModelBaseUrl) => {
    expect(() => new RootlessDockerOmpRuntime(config({ approvedModelBaseUrl }), new FakeRunner()))
      .toThrow(/fixed credential-free rootless gateway/i);
  });

  it("reports ready isolation properties only from live rootless engine evidence", async () => {
    const runtime = new RootlessDockerOmpRuntime(config(), new FakeRunner());
    await expect(runtime.health()).resolves.toEqual({
      rootless: true,
      rootfulSocketAbsent: true,
      resourceLimitsEnforced: true,
      networkPolicyEnforced: true,
      imagePinned: true,
      modelGatewayReady: true
    });
  });

  it("fails closed when the rootless engine cannot enforce CPU quota", async () => {
    const runner = new FakeRunner();
    runner.info.CpuCfsQuota = false;
    const runtime = new RootlessDockerOmpRuntime(config(), runner);
    await expect(runtime.health()).resolves.toMatchObject({ resourceLimitsEnforced: false });
  });

  it("creates isolated workspace/config volumes and an exact locked-down OMP command", async () => {
    const root = await mkdtemp(join(tmpdir(), "council-rootless-omp-start-"));
    roots.push(root);
    const workspacePath = join(root, "run", "workspace");
    const sourceArchivePath = join(root, "source.tar");
    await mkdir(workspacePath, { recursive: true });
    await writeFile(sourceArchivePath, "approved archive", { mode: 0o600 });
    const runner = new FakeRunner();
    const runtime = new RootlessDockerOmpRuntime(config(), runner);
    const handle = await runtime.start(startInput({ workspacePath, sourceArchivePath }));
    const command = runner.attachments[0]!;
    const initializer = runner.runs.find((item) => item[0] === "create" && item.includes("com.council.omp.transient=true"))!;
    expect(command).toContain("--read-only");
    expect(command).toContain("no-new-privileges");
    expect(command).toContain("ALL");
    expect(command).toContain("council-omp-internal");
    expect(command).toContain("type=volume,src=council-omp-70000000-0000-4000-8000-000000000006,dst=/workspace");
    expect(command).toContain("type=volume,src=council-omp-config-70000000-0000-4000-8000-000000000006,dst=/opt/council-omp-config");
    expect(command).not.toContain("type=volume,src=council-omp-config-70000000-0000-4000-8000-000000000006,dst=/opt/council-omp-config,readonly");
    expect(command).toContain("PI_CODING_AGENT_DIR=/opt/council-omp-config");
    expect(command).toContain("/usr/local/libexec/council/run-omp.sh");
    expect(command).toContain("/opt/council-omp-config/sessions");
    expect(command).toContain("/home/omp:rw,noexec,nosuid,size=64m,mode=700,uid=10001,gid=10001");
    expect(command).not.toContain("/var/run/docker.sock");
    expect(command).toContain("--no-rules");
    expect(command).toContain("--no-skills");
    expect(command).toContain("--no-extensions");
    expect(command).toContain(OMP_PHASE_ONE_TOOLS.join(","));
    expect(initializer).toContain("/council-config/.council-source.tar");
    expect(initializer).toContain("type=volume,src=council-omp-70000000-0000-4000-8000-000000000006,dst=/workspace");
    expect(runner.sourceTransfer).toMatchObject({
      destination: "council-omp-init-70000000-0000-4000-8000-000000000006:/council-config/.council-source.tar",
      mode: 0o444
    });
    await expect(stat(runner.sourceTransfer!.source)).rejects.toMatchObject({ code: "ENOENT" });
    expect(runner.runs.filter((item) => item[0] === "volume" && item[1] === "create")).toHaveLength(2);
    await handle.terminate();
  });

  it("rejects model URL or tool drift before creating a container", async () => {
    const runner = new FakeRunner();
    const runtime = new RootlessDockerOmpRuntime(config(), runner);
    await expect(runtime.start(startInput({ modelBaseUrl: "http://another-host:4001/v1" }))).rejects.toBeInstanceOf(RootlessDockerRuntimeError);
    await expect(runtime.start(startInput({ allowedTools: ["read"] }))).rejects.toBeInstanceOf(RootlessDockerRuntimeError);
    expect(runner.attachments).toHaveLength(0);
  });

  it("resumes only from the Task-private OMP state volume", async () => {
    const runner = new FakeRunner();
    runner.volumeExists = true;
    const runtime = new RootlessDockerOmpRuntime(config(), runner);
    await expect(runtime.start(startInput({
      resumeSessionFile: "/workspace/.omp/sessions/untrusted.jsonl"
    }))).rejects.toThrow(/outside its isolated workspace/i);
    expect(runner.attachments).toHaveLength(0);

    const handle = await runtime.start(startInput({
      resumeSessionFile: "/opt/council-omp-config/sessions/approved.jsonl"
    }));
    expect(runner.attachments[0]).toContain("/opt/council-omp-config/sessions/approved.jsonl");
    await handle.terminate();
  });

  it("reconciles only Council-labelled transient and Session containers", async () => {
    const runner = new FakeRunner();
    const runtime = new RootlessDockerOmpRuntime(config(), runner);
    await runtime.reconcile();
    const removed = runner.runs.filter((command) => command[0] === "rm").map((command) => command.at(-1));
    expect(removed).toEqual(["session-a", "session-b", "transient-a"]);
    expect(runner.runs.filter((command) => command[0] === "ps").every((command) => command.includes("--filter"))).toBe(true);
  });

  it("copies collector output and recomputes patch and manifest digests in the Broker", async () => {
    const root = await mkdtemp(join(tmpdir(), "council-rootless-omp-"));
    roots.push(root);
    const runner = new FakeRunner();
    const runtime = new RootlessDockerOmpRuntime(config(), runner);
    const manifest = await runtime.collectArtifacts({
      runtimeRunId,
      workspacePath: join(root, "workspace"),
      artifactRoot: join(root, "artifacts")
    });
    expect(manifest).toMatchObject({
      artifactRef: `runtime-run/${runtimeRunId}/artifacts/manifest.json`,
      patchDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      manifestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      changedFiles: [{ path: "a.ts", status: "modified" }]
    });
    const collectorCreate = runner.runs.find((command) => command[0] === "create");
    expect(collectorCreate).toEqual(expect.arrayContaining([
      "--network", "none",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--user", "10001:10001"
    ]));
    expect(runner.artifactDestination).toBe(join(root, "artifacts"));
  });
});
