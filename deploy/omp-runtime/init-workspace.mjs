import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const workspace = "/workspace";
const configRoot = "/council-config";
const archive = process.argv[2];
const modelConfigBase64 = process.env.COUNCIL_MODEL_CONFIG_B64;

if (archive !== "/council-config/.council-source.tar" || !modelConfigBase64) {
  throw new Error("Council workspace initializer received an invalid fixed input.");
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? workspace,
    env: {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/tmp"
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let outputBytes = 0;
  const maxBytes = 1024 * 1024;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxBytes) child.kill("SIGKILL");
    });
  }
  const exitCode = await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolvePromise(code ?? 1));
  });
  if (exitCode !== 0 || outputBytes > maxBytes) throw new Error(`Council initializer command failed: ${command}.`);
}

function insideWorkspace(path) {
  const root = resolve(workspace);
  const candidate = resolve(path);
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function rejectEscapingSymlinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      const target = await readlink(path);
      const resolvedTarget = resolve(dirname(path), target);
      if (!insideWorkspace(resolvedTarget)) throw new Error("Source archive contains a symlink escaping /workspace.");
      continue;
    }
    if (metadata.isDirectory()) await rejectEscapingSymlinks(path);
  }
}

await mkdir(workspace, { recursive: true, mode: 0o755 });
for (const entry of await readdir(workspace)) {
  await rm(join(workspace, entry), { recursive: true, force: true });
}
await run("bsdtar", [
  "-xf", archive,
  "-C", workspace,
  "--no-same-owner",
  "--no-same-permissions"
]);
await rejectEscapingSymlinks(workspace);
await rm(archive, { force: true });

for (const path of [
  ".git",
  ".omp",
  ".claude",
  ".codex",
  ".gemini",
  ".agents",
  ".cursor"
]) {
  await rm(join(workspace, path), { recursive: true, force: true });
}
for (const path of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) {
  await rm(join(workspace, path), { force: true });
}

await run("git", ["init", "--initial-branch=council-baseline"]);
await run("git", ["config", "user.name", "Council Runtime"]);
await run("git", ["config", "user.email", "runtime@council.invalid"]);
await run("git", ["add", "-A"]);
await run("git", ["commit", "--allow-empty", "--no-gpg-sign", "-m", "Council approved workspace baseline"]);

await mkdir(configRoot, { recursive: true, mode: 0o755 });
await mkdir(join(configRoot, "sessions"), { recursive: true, mode: 0o700 });
const disabledProviders = ["native", "claude", "codex", "gemini", "github", "opencode", "cursor", "agents-md"];
await writeFile(join(configRoot, "config.yml"), `${JSON.stringify({
  disabledProviders,
  skills: { enabled: false }
}, null, 2)}\n`, { mode: 0o444 });
await writeFile(join(configRoot, "models.yml"), `${Buffer.from(modelConfigBase64, "base64").toString("utf8")}\n`, { mode: 0o444 });
await writeFile(join(configRoot, "mcp.json"), `${JSON.stringify({ mcpServers: {}, disabledServers: [] }, null, 2)}\n`, { mode: 0o444 });

await run("chmod", ["0755", workspace], { cwd: "/" });

const canonicalWorkspace = await realpath(workspace);
if (relative(workspace, canonicalWorkspace) !== "") throw new Error("Council workspace canonical path changed unexpectedly.");
