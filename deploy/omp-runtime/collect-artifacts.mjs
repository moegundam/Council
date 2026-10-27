import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

const workspace = "/workspace";
const artifactRoot = "/workspace/.council-artifacts";
const maxOutputBytes = 4 * 1024 * 1024;
const maxChangedFiles = 2_000;

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function fileDigest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

async function run(command, args, options = {}) {
  const startedAt = Date.now();
  const child = spawn(command, args, {
    cwd: workspace,
    env: {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/tmp",
      CI: "true"
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout = [];
  const stderr = [];
  let bytes = 0;
  let timedOut = false;
  const capture = (target, chunk) => {
    bytes += chunk.length;
    if (bytes <= maxOutputBytes) target.push(chunk);
    if (bytes > maxOutputBytes) child.kill("SIGKILL");
  };
  child.stdout.on("data", (chunk) => capture(stdout, chunk));
  child.stderr.on("data", (chunk) => capture(stderr, chunk));
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMs ?? 300_000);
  const exitCode = await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolvePromise(code));
  }).finally(() => clearTimeout(timeout));
  const output = Buffer.concat([
    ...stdout,
    Buffer.from("\n---stderr---\n"),
    ...stderr,
    ...(bytes > maxOutputBytes ? [Buffer.from("\n[TRUNCATED]\n")] : [])
  ]);
  return {
    exitCode: timedOut ? null : exitCode,
    stdout: Buffer.concat(stdout),
    outputDigest: digest(output),
    durationMs: Date.now() - startedAt,
    failedToCapture: bytes > maxOutputBytes
  };
}

function safePath(path) {
  if (!path || path.startsWith("/") || path.includes("\0") || path.split("/").includes("..")) {
    throw new Error("Git reported an unsafe changed path.");
  }
  const root = resolve(workspace);
  const candidate = resolve(root, path);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) throw new Error("Changed path escaped /workspace.");
  return candidate;
}

async function digestChangedPath(path, status) {
  if (status === "deleted") return null;
  const candidate = safePath(path);
  const metadata = await lstat(candidate);
  if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
  const canonical = await realpath(candidate);
  const root = await realpath(workspace);
  if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) throw new Error("Changed file resolved outside /workspace.");
  return fileDigest(candidate);
}

await rm(artifactRoot, { recursive: true, force: true });
await mkdir(artifactRoot, { recursive: true, mode: 0o700 });

const tests = [];
const verificationBase64 = process.env.COUNCIL_VERIFICATION_COMMAND_B64 ?? "";
if (verificationBase64) {
  const command = JSON.parse(Buffer.from(verificationBase64, "base64").toString("utf8"));
  if (!Array.isArray(command) || command.length < 1 || command.length > 32 || command.some((item) => typeof item !== "string" || item.length < 1 || item.length > 1_000)) {
    throw new Error("Council verification command is invalid.");
  }
  const result = await run(command[0], command.slice(1), { timeoutMs: 900_000 });
  tests.push({
    commandDigest: digest(JSON.stringify(command)),
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    outputDigest: result.outputDigest
  });
}

const intent = await run("git", ["add", "-N", "--", "."]);
if (intent.exitCode !== 0) throw new Error("Could not stage intent-to-add entries for artifact collection.");
const statusResult = await run("git", ["diff", "--name-status", "-z", "--no-renames", "HEAD", "--"]);
if (statusResult.exitCode !== 0 || statusResult.failedToCapture) throw new Error("Could not collect bounded changed-file metadata.");
const fields = statusResult.stdout.toString("utf8").split("\0").filter((field) => field.length > 0);
if (fields.length % 2 !== 0) throw new Error("Git changed-file metadata was malformed.");
const changedFiles = [];
for (let index = 0; index < fields.length; index += 2) {
  const rawStatus = fields[index];
  const path = fields[index + 1];
  if (!rawStatus || !path) throw new Error("Git changed-file metadata was incomplete.");
  const status = rawStatus.startsWith("A") ? "added"
    : rawStatus.startsWith("D") ? "deleted"
      : "modified";
  safePath(path);
  changedFiles.push({ path, status, digest: await digestChangedPath(path, status) });
  if (changedFiles.length > maxChangedFiles) throw new Error("OMP changed-file count exceeded the fixed limit.");
}

const patchResult = await run("git", ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--"], { timeoutMs: 300_000 });
if (patchResult.exitCode !== 0 || patchResult.failedToCapture) throw new Error("OMP patch exceeded the fixed collection limit.");
await writeFile(`${artifactRoot}/changes.patch`, patchResult.stdout, { mode: 0o600 });
await writeFile(`${artifactRoot}/manifest-source.json`, `${JSON.stringify({ changedFiles, tests }, null, 2)}\n`, { mode: 0o600 });
