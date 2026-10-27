import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { ompBrokerArtifactManifestSchema, type OmpBrokerArtifactManifest } from "@council/contracts";
import type {
  OmpContainerExit,
  OmpContainerHandle,
  OmpContainerRuntime,
  OmpContainerRuntimeHealth,
  OmpContainerStartInput
} from "./omp-runtime-broker.js";
import { OMP_PROVIDER_SESSION_ROOT } from "./omp-runtime-broker.js";

export const OMP_PHASE_ONE_TOOLS = ["read", "grep", "glob", "lsp", "edit", "bash"] as const;
export const OMP_RUNTIME_PROVIDER_ID = "council-local";

const dockerDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const runtimeRunIdSchema = z.string().uuid();
const fixedModelIdSchema = z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9._:/-]+$/);
const commandSchema = z.array(z.string().min(1).max(1_000)).min(1).max(32);
const ROOTLESS_DOCKER_HOST = /^unix:\/\/\/run\/user\/[1-9][0-9]*\/docker\.sock$/;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_RPC_LINE_BYTES = 1_048_576;

const COUNCIL_OMP_SYSTEM_PROMPT = [
  "You are an isolated Council task executor.",
  "Work only on the approved task in /workspace and satisfy its acceptance criteria.",
  "Use only the tools exposed by the host, do not attempt network discovery or external writes,",
  "and leave all reviewable code changes in the workspace for Council to collect as a patch."
].join(" ");

const artifactSourceSchema = z.object({
  changedFiles: z.array(z.object({
    path: z.string().trim().min(1).max(500),
    status: z.enum(["added", "modified", "deleted", "renamed"]),
    digest: dockerDigestSchema.nullable()
  }).strict()).max(2_000),
  tests: z.array(z.object({
    commandDigest: dockerDigestSchema,
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative(),
    outputDigest: dockerDigestSchema
  }).strict()).max(100)
}).strict();

export interface DockerCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DockerCommandOptions {
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface DockerAttachedProcess {
  stdoutLines: AsyncIterable<string | Uint8Array>;
  completion: Promise<OmpContainerExit>;
  writeLine(line: string): Promise<void>;
  terminate(): Promise<void>;
}

export interface RootlessDockerCommandRunner {
  run(args: readonly string[], options?: DockerCommandOptions): Promise<DockerCommandResult>;
  attach(args: readonly string[]): DockerAttachedProcess;
}

export interface RootlessDockerRuntimeConfig {
  dockerHost: string;
  imageReference: string;
  imageDigest: string;
  internalNetwork: string;
  modelGatewayContainer: string;
  approvedModelBaseUrl: string;
  dockerBinary?: string;
  verificationCommand?: string[];
  diskPollMs?: number;
  rootfulSocketExists?: () => boolean;
}

export class RootlessDockerRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RootlessDockerRuntimeError";
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function fileDigest(path: string): Promise<`sha256:${string}`> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

function killProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have exited between the liveness check and signal.
    }
  }
  child.kill(signal);
}

async function* boundedLines(
  stream: NodeJS.ReadableStream,
  maxLineBytes: number
): AsyncIterable<Uint8Array> {
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  for await (const raw of stream as AsyncIterable<Buffer | string>) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let newline = pending.indexOf(0x0a);
    while (newline >= 0) {
      const line = pending.subarray(0, newline);
      if (line.byteLength > maxLineBytes) throw new RootlessDockerRuntimeError("OMP emitted an oversized RPC frame.");
      yield line;
      pending = pending.subarray(newline + 1);
      newline = pending.indexOf(0x0a);
    }
    if (pending.byteLength > maxLineBytes) throw new RootlessDockerRuntimeError("OMP emitted an oversized unterminated RPC frame.");
  }
  if (pending.byteLength > 0) yield pending;
}

export class SpawnRootlessDockerCommandRunner implements RootlessDockerCommandRunner {
  constructor(
    private readonly dockerBinary: string,
    private readonly dockerHost: string
  ) {}

  private spawnDocker(args: readonly string[]) {
    return spawn(this.dockerBinary, [...args], {
      detached: process.platform !== "win32",
      env: {
        PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        HOME: "/tmp/council-docker-client",
        DOCKER_CONFIG: "/tmp/council-docker-client",
        DOCKER_HOST: this.dockerHost
      },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
  }

  async run(args: readonly string[], options: DockerCommandOptions = {}): Promise<DockerCommandResult> {
    const child = this.spawnDocker(args);
    const maxBytes = options.maxOutputBytes ?? MAX_COMMAND_OUTPUT_BYTES;
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let overflow = false;
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      if (current.byteLength >= maxBytes) {
        overflow = true;
        return current;
      }
      const remaining = maxBytes - current.byteLength;
      if (chunk.byteLength > remaining) overflow = true;
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, "SIGTERM");
      setTimeout(() => killProcessGroup(child, "SIGKILL"), 2_000).unref();
    }, options.timeoutMs ?? 60_000);
    timeout.unref();
    const exitCode = await new Promise<number>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolvePromise(code ?? 1));
    }).finally(() => clearTimeout(timeout));
    if (overflow) throw new RootlessDockerRuntimeError("Docker command output exceeded its fixed capture limit.");
    if (timedOut) throw new RootlessDockerRuntimeError("Docker command exceeded its fixed timeout.");
    return { exitCode, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") };
  }

  attach(args: readonly string[]): DockerAttachedProcess {
    const child = this.spawnDocker(args);
    let settled = false;
    const completion = new Promise<OmpContainerExit>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => {
        settled = true;
        resolvePromise({ exitCode, signal });
      });
    });
    let pendingWrite = Promise.resolve();
    return {
      stdoutLines: boundedLines(child.stdout, MAX_RPC_LINE_BYTES),
      completion,
      writeLine: async (line) => {
        if (settled || child.stdin.destroyed) throw new RootlessDockerRuntimeError("OMP container stdin is closed.");
        pendingWrite = pendingWrite.then(() => new Promise<void>((resolvePromise, reject) => {
          child.stdin.write(line, (error) => error ? reject(error) : resolvePromise());
        }));
        await pendingWrite;
      },
      terminate: async () => {
        if (settled) return;
        child.stdin.end();
        killProcessGroup(child, "SIGTERM");
        await Promise.race([
          completion.then(() => undefined),
          new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 2_000))
        ]);
        if (!settled) killProcessGroup(child, "SIGKILL");
      }
    };
  }
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new RootlessDockerRuntimeError(`${label} returned invalid JSON.`);
  }
}

function assertSafeName(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) {
    throw new RootlessDockerRuntimeError(`${label} is not a safe Docker identifier.`);
  }
  return value;
}

function safeArtifactPath(root: string, child: string): string {
  const base = resolve(root);
  const candidate = resolve(base, child);
  if (candidate !== base && !candidate.startsWith(`${base}${sep}`)) {
    throw new RootlessDockerRuntimeError("OMP artifact path escaped its configured root.");
  }
  return candidate;
}

function modelConfiguration(baseUrl: string, modelId: string): string {
  return JSON.stringify({
    providers: {
      [OMP_RUNTIME_PROVIDER_ID]: {
        baseUrl,
        auth: "none",
        api: "openai-completions",
        models: [{
          id: modelId,
          name: modelId,
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 65_536,
          maxTokens: 8_192
        }]
      }
    }
  });
}

export class RootlessDockerOmpRuntime implements OmpContainerRuntime {
  private readonly runner: RootlessDockerCommandRunner;
  private readonly imageDigest: `sha256:${string}`;
  private readonly verificationCommand: string[] | null;
  private readonly rootfulSocketExists: () => boolean;

  constructor(
    private readonly config: RootlessDockerRuntimeConfig,
    runner?: RootlessDockerCommandRunner
  ) {
    if (!ROOTLESS_DOCKER_HOST.test(config.dockerHost)) {
      throw new RootlessDockerRuntimeError("OMP requires a dedicated /run/user/<uid>/docker.sock rootless Docker endpoint.");
    }
    this.imageDigest = dockerDigestSchema.parse(config.imageDigest) as `sha256:${string}`;
    if (config.imageReference !== this.imageDigest && !config.imageReference.endsWith(`@${this.imageDigest}`)) {
      throw new RootlessDockerRuntimeError("OMP image reference must be pinned to the approved image digest.");
    }
    assertSafeName(config.internalNetwork, "OMP internal network");
    assertSafeName(config.modelGatewayContainer, "OMP model gateway container");
    const modelUrl = new URL(config.approvedModelBaseUrl);
    if (!(["http:", "https:"] as string[]).includes(modelUrl.protocol)
      || modelUrl.username || modelUrl.password
      || modelUrl.hostname !== config.modelGatewayContainer) {
      throw new RootlessDockerRuntimeError("OMP model URL must target the fixed credential-free rootless gateway container.");
    }
    this.verificationCommand = config.verificationCommand
      ? commandSchema.parse(config.verificationCommand)
      : null;
    this.rootfulSocketExists = config.rootfulSocketExists ?? (() => existsSync("/var/run/docker.sock"));
    this.runner = runner ?? new SpawnRootlessDockerCommandRunner(config.dockerBinary ?? "docker", config.dockerHost);
  }

  private async runChecked(
    args: readonly string[],
    label: string,
    options?: DockerCommandOptions
  ): Promise<DockerCommandResult> {
    const result = await this.runner.run(args, options);
    if (result.exitCode !== 0) throw new RootlessDockerRuntimeError(`${label} failed in the rootless runtime.`);
    return result;
  }

  private volumeName(runtimeRunId: string): string {
    return `council-omp-${runtimeRunId}`;
  }

  private configVolumeName(runtimeRunId: string): string {
    return `council-omp-config-${runtimeRunId}`;
  }

  private sessionContainerName(runtimeRunId: string): string {
    return `council-omp-run-${runtimeRunId}`;
  }

  async health(): Promise<OmpContainerRuntimeHealth> {
    const unavailable = {
      rootless: false,
      rootfulSocketAbsent: !this.rootfulSocketExists(),
      resourceLimitsEnforced: false,
      networkPolicyEnforced: false,
      imagePinned: false,
      modelGatewayReady: false
    };
    try {
      const [infoResult, networkResult, gatewayResult, imageResult] = await Promise.all([
        this.runChecked(["info", "--format", "{{json .}}"], "Docker info"),
        this.runChecked(["network", "inspect", this.config.internalNetwork, "--format", "{{json .}}"], "Docker network inspection"),
        this.runChecked(["inspect", this.config.modelGatewayContainer, "--format", "{{json .}}"], "Model gateway inspection"),
        this.runChecked(["image", "inspect", this.config.imageReference, "--format", "{{json .}}"], "OMP image inspection")
      ]);
      const info = parseJsonObject(infoResult.stdout.trim(), "Docker info");
      const network = parseJsonObject(networkResult.stdout.trim(), "Docker network inspection");
      const gateway = parseJsonObject(gatewayResult.stdout.trim(), "Model gateway inspection");
      const image = parseJsonObject(imageResult.stdout.trim(), "OMP image inspection");
      const securityOptions = Array.isArray(info.SecurityOptions) ? info.SecurityOptions.filter((item): item is string => typeof item === "string") : [];
      const gatewayState = gateway.State && typeof gateway.State === "object" ? gateway.State as Record<string, unknown> : {};
      const gatewayNetworks = gateway.NetworkSettings && typeof gateway.NetworkSettings === "object"
        && (gateway.NetworkSettings as Record<string, unknown>).Networks
        && typeof (gateway.NetworkSettings as Record<string, unknown>).Networks === "object"
        ? (gateway.NetworkSettings as Record<string, unknown>).Networks as Record<string, unknown>
        : {};
      const gatewayHealth = gatewayState.Health && typeof gatewayState.Health === "object"
        ? gatewayState.Health as Record<string, unknown>
        : {};
      const repoDigests = Array.isArray(image.RepoDigests) ? image.RepoDigests.filter((item): item is string => typeof item === "string") : [];
      return {
        rootless: securityOptions.some((item) => item.includes("rootless")),
        rootfulSocketAbsent: !this.rootfulSocketExists(),
        resourceLimitsEnforced: info.CgroupVersion === "2"
          && info.MemoryLimit === true
          && info.PidsLimit === true
          && info.CpuCfsPeriod === true
          && info.CpuCfsQuota === true,
        networkPolicyEnforced: network.Internal === true,
        imagePinned: image.Id === this.imageDigest || repoDigests.some((item) => item.endsWith(`@${this.imageDigest}`)),
        modelGatewayReady: gatewayState.Running === true
          && gatewayHealth.Status === "healthy"
          && Object.hasOwn(gatewayNetworks, this.config.internalNetwork)
      };
    } catch {
      return unavailable;
    }
  }

  async reconcile(): Promise<void> {
    for (const label of ["com.council.omp.session=true", "com.council.omp.transient=true"]) {
      const result = await this.runner.run(["ps", "-aq", "--filter", `label=${label}`], { timeoutMs: 30_000 });
      if (result.exitCode !== 0) throw new RootlessDockerRuntimeError("Could not enumerate interrupted OMP containers.");
      const identifiers = result.stdout.split(/\s+/).filter(Boolean);
      for (const identifier of identifiers) {
        await this.runner.run(["rm", "-f", identifier], { timeoutMs: 30_000 });
      }
    }
  }

  private async initializeWorkspace(input: OmpContainerStartInput, volume: string, configVolume: string): Promise<void> {
    const initName = `council-omp-init-${input.runtimeRunId}`;
    const transferArchivePath = resolve(input.workspacePath, ".council-source-transfer.tar");
    try {
      await copyFile(input.sourceArchivePath, transferArchivePath);
      await chmod(transferArchivePath, 0o444);
      await this.runChecked([
        "create",
        "--name", initName,
        "--label", "com.council.omp.transient=true",
        "--network", "none",
        "--read-only",
        "--security-opt", "no-new-privileges",
        "--cap-drop", "ALL",
        "--pids-limit", "64",
        "--memory", "512m",
        "--memory-swap", "512m",
        "--cpus", "0.5",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m,mode=1777",
        "--mount", `type=volume,src=${volume},dst=/workspace`,
        "--mount", `type=volume,src=${configVolume},dst=/council-config`,
        "--env", `COUNCIL_MODEL_CONFIG_B64=${Buffer.from(modelConfiguration(input.modelBaseUrl, input.modelId)).toString("base64")}`,
        this.config.imageReference,
        "node", "/usr/local/libexec/council/init-workspace.mjs", "/council-config/.council-source.tar"
      ], "OMP workspace initializer creation");
      await this.runChecked(
        ["cp", transferArchivePath, `${initName}:/council-config/.council-source.tar`],
        "OMP source archive transfer",
        { timeoutMs: 120_000 }
      );
      await this.runChecked(["start", "--attach", initName], "OMP workspace initialization", { timeoutMs: 300_000 });
    } finally {
      await this.runner.run(["rm", "-f", initName], { timeoutMs: 30_000 }).catch(() => undefined);
      await rm(transferArchivePath, { force: true }).catch(() => undefined);
    }
  }

  async start(input: OmpContainerStartInput): Promise<OmpContainerHandle> {
    runtimeRunIdSchema.parse(input.runtimeRunId);
    fixedModelIdSchema.parse(input.modelId);
    if (input.imageDigest !== this.imageDigest) throw new RootlessDockerRuntimeError("Execution Contract image digest does not match the runtime image.");
    if (input.modelBaseUrl !== this.config.approvedModelBaseUrl) throw new RootlessDockerRuntimeError("Execution Contract model URL drifted from the approved gateway.");
    if (JSON.stringify(input.allowedTools) !== JSON.stringify(OMP_PHASE_ONE_TOOLS)) {
      throw new RootlessDockerRuntimeError("OMP phase-one tool allowlist must match the fixed runtime tool set exactly.");
    }
    if (input.cpuLimit <= 0 || input.cpuLimit > 16
      || input.memoryMb < 512 || input.memoryMb > 65_536
      || input.processLimit < 16 || input.processLimit > 4_096
      || input.diskMb < 128 || input.diskMb > 262_144) {
      throw new RootlessDockerRuntimeError("OMP resource limits are outside the approved bounds.");
    }
    const volume = this.volumeName(input.runtimeRunId);
    const configVolume = this.configVolumeName(input.runtimeRunId);
    const existingVolume = await this.runner.run(["volume", "inspect", volume], { timeoutMs: 30_000 });
    const existingConfigVolume = await this.runner.run(["volume", "inspect", configVolume], { timeoutMs: 30_000 });
    if (input.resumeSessionFile === null) {
      if (existingVolume.exitCode === 0 || existingConfigVolume.exitCode === 0) {
        throw new RootlessDockerRuntimeError("A stale OMP workspace or config volume already exists for this RuntimeRun.");
      }
      for (const name of [volume, configVolume]) {
        await this.runChecked([
          "volume", "create",
          "--label", "com.council.omp.managed=true",
          "--label", `com.council.runtime-run=${input.runtimeRunId}`,
          name
        ], "OMP isolated volume creation");
      }
      try {
        await this.initializeWorkspace(input, volume, configVolume);
      } catch (error) {
        await this.runner.run(["volume", "rm", "-f", volume], { timeoutMs: 30_000 }).catch(() => undefined);
        await this.runner.run(["volume", "rm", "-f", configVolume], { timeoutMs: 30_000 }).catch(() => undefined);
        throw error;
      }
    } else {
      if (existingVolume.exitCode !== 0 || existingConfigVolume.exitCode !== 0) {
        throw new RootlessDockerRuntimeError("The resumable OMP workspace or config volume is missing.");
      }
      if (!input.resumeSessionFile.startsWith(`${OMP_PROVIDER_SESSION_ROOT}/`) || input.resumeSessionFile.includes("..")) {
        throw new RootlessDockerRuntimeError("The resumable OMP Session path is outside its isolated workspace.");
      }
    }

    const containerName = this.sessionContainerName(input.runtimeRunId);
    const ompArguments = [
      "/usr/local/libexec/council/run-omp.sh",
      "--mode", "rpc",
      "--provider", OMP_RUNTIME_PROVIDER_ID,
      "--model", input.modelId,
      "--cwd", "/workspace",
      "--session-dir", OMP_PROVIDER_SESSION_ROOT,
      "--no-rules",
      "--no-skills",
      "--no-extensions",
      "--no-title",
      "--no-pty",
      "--tools", OMP_PHASE_ONE_TOOLS.join(","),
      "--system-prompt", COUNCIL_OMP_SYSTEM_PROMPT,
      ...(input.resumeSessionFile ? ["--session", input.resumeSessionFile] : [])
    ];
    const attached = this.runner.attach([
      "run", "--rm", "--interactive",
      "--name", containerName,
      "--label", "com.council.omp.session=true",
      "--label", `com.council.runtime-run=${input.runtimeRunId}`,
      "--network", this.config.internalNetwork,
      "--read-only",
      "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL",
      "--pids-limit", String(input.processLimit),
      "--memory", `${input.memoryMb}m`,
      "--memory-swap", `${input.memoryMb}m`,
      "--cpus", String(input.cpuLimit),
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m,mode=1777",
      "--tmpfs", "/home/omp:rw,noexec,nosuid,size=64m,mode=700,uid=10001,gid=10001",
      "--user", "10001:10001",
      "--workdir", "/workspace",
      "--mount", `type=volume,src=${volume},dst=/workspace`,
      "--mount", `type=volume,src=${configVolume},dst=/opt/council-omp-config`,
      "--env", "HOME=/home/omp",
      "--env", "PI_CODING_AGENT_DIR=/opt/council-omp-config",
      "--env", "PI_NO_PTY=1",
      "--env", "PI_BASH_NO_LOGIN=1",
      "--env", "CI=true",
      this.config.imageReference,
      ...ompArguments
    ]);

    let stopped = false;
    const terminate = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      await this.runner.run(["stop", "--time", "5", containerName], { timeoutMs: 15_000 }).catch(() => undefined);
      await attached.terminate();
    };
    const ttlTimer = setTimeout(() => { void terminate(); }, input.timeoutMs);
    ttlTimer.unref();
    const diskTimer = setInterval(() => {
      void this.runner.run(["exec", "--user", "0", containerName, "du", "-sb", "/workspace"], { timeoutMs: 30_000 })
        .then((result) => {
          if (result.exitCode !== 0) return;
          const bytes = Number.parseInt(result.stdout.trim().split(/\s+/)[0] ?? "", 10);
          if (Number.isSafeInteger(bytes) && bytes > input.diskMb * 1024 * 1024) void terminate();
        }).catch(() => undefined);
    }, this.config.diskPollMs ?? 10_000);
    diskTimer.unref();
    const completion = attached.completion.finally(() => {
      stopped = true;
      clearTimeout(ttlTimer);
      clearInterval(diskTimer);
    });
    return {
      containerId: containerName,
      stdoutLines: attached.stdoutLines,
      completion,
      writeLine: (line) => attached.writeLine(line),
      terminate
    };
  }

  async collectArtifacts(input: {
    runtimeRunId: string;
    workspacePath: string;
    artifactRoot: string;
  }): Promise<OmpBrokerArtifactManifest> {
    runtimeRunIdSchema.parse(input.runtimeRunId);
    const volume = this.volumeName(input.runtimeRunId);
    const collectorName = `council-omp-collect-${input.runtimeRunId}`;
    await rm(input.artifactRoot, { recursive: true, force: true });
    await mkdir(input.artifactRoot, { recursive: true, mode: 0o700 });
    const verification = this.verificationCommand
      ? Buffer.from(JSON.stringify(this.verificationCommand)).toString("base64")
      : "";
    await this.runChecked([
      "create",
      "--name", collectorName,
      "--label", "com.council.omp.transient=true",
      "--network", "none",
      "--read-only",
      "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL",
      "--pids-limit", "256",
      "--memory", "2048m",
      "--memory-swap", "2048m",
      "--cpus", "2",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m,mode=1777",
      "--user", "10001:10001",
      "--workdir", "/workspace",
      "--mount", `type=volume,src=${volume},dst=/workspace`,
      "--env", `COUNCIL_VERIFICATION_COMMAND_B64=${verification}`,
      this.config.imageReference,
      "node", "/usr/local/libexec/council/collect-artifacts.mjs"
    ], "OMP artifact collector creation");
    try {
      await this.runChecked(["start", "--attach", collectorName], "OMP artifact collection", { timeoutMs: 1_200_000 });
      await this.runChecked(["cp", `${collectorName}:/workspace/.council-artifacts/.`, input.artifactRoot], "OMP artifact transfer", { timeoutMs: 300_000 });
    } finally {
      await this.runner.run(["rm", "-f", collectorName], { timeoutMs: 30_000 }).catch(() => undefined);
    }
    const sourcePath = safeArtifactPath(input.artifactRoot, "manifest-source.json");
    const patchPath = safeArtifactPath(input.artifactRoot, "changes.patch");
    const source = artifactSourceSchema.parse(JSON.parse(await readFile(sourcePath, "utf8")));
    const patchDigest = await fileDigest(patchPath);
    const createdAt = new Date().toISOString();
    const manifestWithoutDigest = {
      artifactRef: `runtime-run/${input.runtimeRunId}/artifacts/manifest.json`,
      patchDigest,
      changedFiles: source.changedFiles,
      tests: source.tests,
      createdAt
    };
    const manifest = ompBrokerArtifactManifestSchema.parse({
      ...manifestWithoutDigest,
      manifestDigest: digest(canonical(manifestWithoutDigest))
    });
    await writeFile(
      safeArtifactPath(input.artifactRoot, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    return manifest;
  }
}
