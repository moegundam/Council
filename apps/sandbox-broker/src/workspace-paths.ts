import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, sep } from "node:path";

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export interface WorkspaceLocation {
  path: string;
  relativePath: string;
  rootRealPath: string;
}

export function normalizeWorkspaceSubpath(relativePath: string): string {
  if (relativePath.trim().length === 0) throw new WorkspacePathError("Workspace path is required.");
  if (isAbsolute(relativePath)) throw new WorkspacePathError("Workspace path must be relative.");

  const normalized = normalize(relativePath).replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) throw new WorkspacePathError("Workspace path is required.");
  if (parts.some((part) => part === "." || part === "..")) {
    throw new WorkspacePathError("Workspace path traversal is not allowed.");
  }
  return parts.join("/");
}

function assertBeneath(rootRealPath: string, candidateRealPath: string): void {
  const relativePath = relative(rootRealPath, candidateRealPath);
  if (relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== "..")) return;
  throw new WorkspacePathError("Workspace path escapes the configured root.");
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) throw new WorkspacePathError(`Symlinked directory is not allowed: ${path}`);
  if (!stats.isDirectory()) throw new WorkspacePathError(`Expected a directory at ${path}`);
}

export async function ensureWorkspacePath(rootPath: string, relativePath: string): Promise<WorkspaceLocation> {
  if (!isAbsolute(rootPath)) throw new WorkspacePathError("Workspace root must be absolute.");
  const normalizedSubpath = normalizeWorkspaceSubpath(relativePath);
  const parts = normalizedSubpath.split("/");

  await ensureDirectory(rootPath);
  const rootRealPath = await realpath(rootPath);

  let currentPath = rootPath;
  for (const part of parts) {
    currentPath = join(currentPath, part);
    try {
      const stats = await lstat(currentPath);
      if (stats.isSymbolicLink()) throw new WorkspacePathError(`Symlink traversal is not allowed: ${currentPath}`);
      if (!stats.isDirectory()) throw new WorkspacePathError(`Expected a directory at ${currentPath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(currentPath, { mode: 0o700 }).catch((mkdirError: NodeJS.ErrnoException) => {
        if (mkdirError.code !== "EEXIST") throw mkdirError;
      });
      const createdStats = await lstat(currentPath);
      if (createdStats.isSymbolicLink() || !createdStats.isDirectory()) {
        throw new WorkspacePathError(`Workspace component is not a real directory: ${currentPath}`);
      }
    }
    const currentRealPath = await realpath(currentPath);
    assertBeneath(rootRealPath, currentRealPath);
  }

  return {
    path: currentPath,
    relativePath: normalizedSubpath,
    rootRealPath
  };
}

export async function validateExistingWorkspacePath(rootPath: string, workspacePath: string): Promise<WorkspaceLocation> {
  if (!isAbsolute(rootPath) || !isAbsolute(workspacePath)) {
    throw new WorkspacePathError("Workspace root and path must be absolute.");
  }
  const rootStats = await lstat(rootPath);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new WorkspacePathError("Workspace root must be a real directory.");
  }
  const rootRealPath = await realpath(rootPath);
  const relativeCandidate = relative(rootPath, workspacePath);
  const normalizedSubpath = normalizeWorkspaceSubpath(relativeCandidate);
  const expectedPath = join(rootPath, ...normalizedSubpath.split("/"));
  if (expectedPath !== workspacePath) throw new WorkspacePathError("Workspace path does not match its recorded location.");

  let currentPath = rootPath;
  for (const part of normalizedSubpath.split("/")) {
    currentPath = join(currentPath, part);
    const stats = await lstat(currentPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new WorkspacePathError(`Workspace path is missing: ${currentPath}`);
      throw error;
    });
    if (stats.isSymbolicLink()) throw new WorkspacePathError(`Symlink traversal is not allowed: ${currentPath}`);
    if (!stats.isDirectory()) throw new WorkspacePathError(`Expected a directory at ${currentPath}`);
    assertBeneath(rootRealPath, await realpath(currentPath));
  }

  return { path: currentPath, relativePath: normalizedSubpath, rootRealPath };
}

export async function removeWorkspacePath(rootPath: string, workspacePath: string): Promise<void> {
  const rootRealPath = await realpath(rootPath);
  const stats = await lstat(workspacePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stats === null) return;

  if (stats.isSymbolicLink()) {
    await rm(workspacePath, { force: true });
    return;
  }

  const workspaceRealPath = await realpath(workspacePath);
  assertBeneath(rootRealPath, workspaceRealPath);
  await rm(workspacePath, { recursive: true, force: true });
}
