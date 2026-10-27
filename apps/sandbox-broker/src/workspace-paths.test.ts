import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWorkspacePath, WorkspacePathError } from "./workspace-paths.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-broker-paths-"));
  tempDirs.push(directory);
  return directory;
}

describe("ensureWorkspacePath", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("creates a workspace beneath the configured absolute root", async () => {
    const root = await makeTempDir();
    const workspace = await ensureWorkspacePath(root, "scope-a/run-1");

    expect(workspace.path.startsWith(root)).toBe(true);
    expect(workspace.relativePath).toBe("scope-a/run-1");
  });

  it("rejects traversal segments and symlink hops", async () => {
    const root = await makeTempDir();
    await expect(ensureWorkspacePath(root, "../escape")).rejects.toThrow(WorkspacePathError);

    const safe = join(root, "safe");
    const outside = await makeTempDir();
    await mkdir(safe, { recursive: true });
    await symlink(outside, join(safe, "linked-out"));

    await expect(ensureWorkspacePath(root, "safe/linked-out/run-2")).rejects.toThrow(/symlink/i);
  });
});
