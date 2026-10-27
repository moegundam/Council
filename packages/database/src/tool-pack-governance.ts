import { createHash } from "node:crypto";
import { createToolPackSchema, type CreateToolPackInput } from "@council/contracts";

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedManifest(input: CreateToolPackInput): CreateToolPackInput {
  const parsed = createToolPackSchema.parse(input);
  return {
    ...parsed,
    tools: [...parsed.tools]
      .map((tool) => ({
        ...tool,
        env: { allowedNames: [...tool.env.allowedNames].sort() }
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  };
}

export function createToolPackManifestDigest(input: CreateToolPackInput): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalize(normalizedManifest(input))).digest("hex")}`;
}

export function toolPackManifestDigestIsValid(
  input: CreateToolPackInput & { manifestDigest: string }
): boolean {
  return input.manifestDigest === createToolPackManifestDigest({
    name: input.name,
    version: input.version,
    description: input.description,
    owner: input.owner,
    sourceReference: input.sourceReference,
    imageDigest: input.imageDigest,
    tools: input.tools
  });
}
