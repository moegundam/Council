import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  toolPackEnvironmentNameSchema,
  toolPackSemanticVersionSchema,
  toolPackSourceReferenceSchema
} from "@council/contracts";
import { z } from "zod";

export interface RegisteredToolDefinitionInput {
  baseArgs: string[];
  allowedArgvSets: string[][];
  envAllowlist: string[];
  allowStdin: boolean;
}

export interface RegisteredToolPackManifestInput {
  id: string;
  version: string;
  reference: string;
  digest: string;
  executablePath: string;
  executableDigest: string;
  tools: Record<string, RegisteredToolDefinitionInput>;
}

export interface RegisteredToolPackManifest extends RegisteredToolPackManifestInput {
  executableRealPath: string;
}

export interface RegisteredToolDefinition extends RegisteredToolDefinitionInput {
  name: string;
}

export class ToolPackRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolPackRegistryError";
  }
}

const toolDefinitionSchema = z.object({
  baseArgs: z.array(z.string().max(500)).max(32),
  allowedArgvSets: z.array(z.array(z.string().max(500)).max(32)).min(1).max(64),
  envAllowlist: z.array(toolPackEnvironmentNameSchema).max(32),
  allowStdin: z.boolean()
}).strict().superRefine((value, context) => {
  if (new Set(value.envAllowlist).size !== value.envAllowlist.length) {
    context.addIssue({ code: "custom", path: ["envAllowlist"], message: "Environment keys must be unique." });
  }
});

const toolPackManifestSchema = z.object({
  id: z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9._-]*$/i),
  version: toolPackSemanticVersionSchema,
  reference: z.string().trim().min(1).max(500),
  digest: z.string(),
  executablePath: z.string().trim().min(1).max(2_000),
  executableDigest: z.string(),
  tools: z.record(z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9._-]*$/i), toolDefinitionSchema)
}).strict().superRefine((value, context) => {
  const toolCount = Object.keys(value.tools).length;
  if (toolCount < 1 || toolCount > 100) {
    context.addIssue({ code: "custom", path: ["tools"], message: "Tool packs require between 1 and 100 tools." });
  }
});

export class ToolPackRegistry {
  constructor(private readonly manifests: Map<string, RegisteredToolPackManifest>) {}

  getTool(packId: string, toolName: string): { manifest: RegisteredToolPackManifest; tool: RegisteredToolDefinition } {
    const manifest = this.manifests.get(packId);
    if (!manifest) throw new ToolPackRegistryError(`Unknown tool pack: ${packId}`);
    const tool = manifest.tools[toolName];
    if (!tool) throw new ToolPackRegistryError(`Unknown tool: ${toolName}`);
    return {
      manifest,
      tool: { ...tool, name: toolName }
    };
  }

  async resolveTool(packId: string, toolName: string): Promise<{ manifest: RegisteredToolPackManifest; tool: RegisteredToolDefinition }> {
    const resolved = this.getTool(packId, toolName);
    const executableDigest = await sha256FileHex(resolved.manifest.executableRealPath);
    if (executableDigest !== resolved.manifest.executableDigest) {
      throw new ToolPackRegistryError(`Executable digest mismatch for tool pack: ${packId}`);
    }
    return resolved;
  }
}

function isDigestPinnedReference(reference: string): boolean {
  return toolPackSourceReferenceSchema.safeParse(reference).success;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createToolPackManifestDigest(
  manifest: Omit<RegisteredToolPackManifestInput, "digest">
): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalize(manifest)).digest("hex")}`;
}

export async function sha256FileHex(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function createToolPackRegistry(manifests: RegisteredToolPackManifestInput[]): Promise<ToolPackRegistry> {
  const registry = new Map<string, RegisteredToolPackManifest>();

  for (const rawManifest of manifests) {
    const parsed = toolPackManifestSchema.safeParse(rawManifest);
    if (!parsed.success) throw new ToolPackRegistryError(`Tool pack manifest is invalid: ${parsed.error.message}`);
    const manifest = parsed.data;
    if (registry.has(manifest.id)) throw new ToolPackRegistryError(`Duplicate tool pack id: ${manifest.id}`);
    if (!isDigestPinnedReference(manifest.reference)) {
      throw new ToolPackRegistryError(`Tool pack references must be digest-pinned: ${manifest.reference}`);
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(manifest.digest)) {
      throw new ToolPackRegistryError(`Manifest digest is invalid for tool pack: ${manifest.id}`);
    }
    if (!/^[a-f0-9]{64}$/.test(manifest.executableDigest)) {
      throw new ToolPackRegistryError(`Executable digest is invalid for tool pack: ${manifest.id}`);
    }
    if (!isAbsolute(manifest.executablePath)) {
      throw new ToolPackRegistryError(`Executable path must be absolute for tool pack: ${manifest.id}`);
    }
    if (createToolPackManifestDigest({
      id: manifest.id,
      version: manifest.version,
      reference: manifest.reference,
      executablePath: manifest.executablePath,
      executableDigest: manifest.executableDigest,
      tools: manifest.tools
    }) !== manifest.digest) {
      throw new ToolPackRegistryError(`Manifest digest mismatch for tool pack: ${manifest.id}`);
    }

    const executableRealPath = await realpath(manifest.executablePath);
    const executableStats = await lstat(executableRealPath);
    if (!executableStats.isFile()) {
      throw new ToolPackRegistryError(`Executable path must resolve to a file for tool pack: ${manifest.id}`);
    }
    const executableDigest = await sha256FileHex(executableRealPath);
    if (executableDigest !== manifest.executableDigest) {
      throw new ToolPackRegistryError(`Executable digest mismatch for tool pack: ${manifest.id}`);
    }

    registry.set(manifest.id, {
      ...manifest,
      executableRealPath
    });
  }

  return new ToolPackRegistry(registry);
}
