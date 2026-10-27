import { describe, expect, it } from "vitest";
import {
  agentRevisionSchema,
  createAgentSchema,
  createToolPackSchema,
  toolPackGrantIsCurrentAndApproved,
  toolPackGrantSchema,
  toolPackSchema
} from "./index.js";

const imageDigest = `sha256:${"a".repeat(64)}`;
const manifestDigest = `sha256:${"b".repeat(64)}`;

function declaredTool(name = "search") {
  return {
    name,
    kind: "command" as const,
    goal: "Search an immutable documentation snapshot.",
    access: "read_only" as const,
    argv: {
      executable: "/usr/bin/rg",
      fixedArguments: ["--json"]
    },
    env: { allowedNames: ["LANG"] },
    stdin: { mode: "none" as const }
  };
}

function createInput() {
  return {
    name: "Documentation search",
    version: "1.0.0",
    description: "Read-only tools for approved documentation snapshots.",
    owner: "Platform Owner",
    sourceReference: `registry.example.com/council/docs@${imageDigest}`,
    imageDigest,
    tools: [declaredTool()]
  };
}

describe("Tool Pack governance contracts", () => {
  it("accepts a digest-pinned, bounded, read-only manifest", () => {
    expect(createToolPackSchema.parse(createInput())).toEqual(createInput());
    expect(toolPackSchema.parse({
      id: "a1000000-0000-4000-8000-000000000001",
      ...createInput(),
      manifestDigest,
      revision: 1,
      status: "draft",
      validation: {
        result: "pending",
        summary: "Not validated.",
        checkedAt: null,
        manifestDigest: null
      },
      approvedAt: null,
      revokedAt: null,
      revocationReason: null,
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z"
    })).toMatchObject({ revision: 1, status: "draft" });
  });

  it("rejects unpinned sources, digest drift, external writes, secret values, and unbounded manifests", () => {
    expect(() => createToolPackSchema.parse({
      ...createInput(),
      sourceReference: "registry.example.com/council/docs:latest"
    })).toThrow();
    expect(() => createToolPackSchema.parse({
      ...createInput(),
      imageDigest: `sha256:${"c".repeat(64)}`
    })).toThrow();
    expect(() => createToolPackSchema.parse({
      ...createInput(),
      version: "latest"
    })).toThrow();
    expect(() => createToolPackSchema.parse({
      ...createInput(),
      sourceReference: `https://registry.example.com/council/docs@${imageDigest}`
    })).toThrow();
    expect(() => createToolPackSchema.parse({
      ...createInput(),
      sourceReference: `user:password@registry.example.com/council/docs@${imageDigest}`
    })).toThrow();
    expect(() => createToolPackSchema.parse({
      ...createInput(),
      tools: [{ ...declaredTool(), access: "external_write" }]
    })).toThrow();
    expect(() => createToolPackSchema.parse({
      ...createInput(),
      tools: [{ ...declaredTool(), env: { allowedNames: ["TOKEN"], values: { TOKEN: "secret" } } }]
    })).toThrow();
    expect(() => createToolPackSchema.parse({
      ...createInput(),
      tools: Array.from({ length: 65 }, (_, index) => declaredTool(`tool-${index}`))
    })).toThrow();
  });

  it("rejects duplicate declared tools, environment names, and exact Agent grants", () => {
    expect(() => createToolPackSchema.parse({
      ...createInput(),
      tools: [declaredTool(), declaredTool()]
    })).toThrow(/once/i);
    expect(() => createToolPackSchema.parse({
      ...createInput(),
      tools: [{ ...declaredTool(), env: { allowedNames: ["LANG", "LANG"] } }]
    })).toThrow(/once/i);
    for (const dangerousName of ["LD_PRELOAD", "NODE_OPTIONS", "PATH", "PYTHONPATH"]) {
      expect(() => createToolPackSchema.parse({
        ...createInput(),
        tools: [{ ...declaredTool(), env: { allowedNames: [dangerousName] } }]
      })).toThrow(/not allowed/i);
    }

    const grant = {
      packId: "a1000000-0000-4000-8000-000000000001",
      revision: 4,
      manifestDigest,
      toolName: "search"
    };
    expect(toolPackGrantSchema.parse(grant)).toEqual(grant);
    expect(() => createAgentSchema.parse({
      name: "Duplicate grant Agent",
      goalSummary: "Review evidence.",
      toolsSummary: "Read-only search.",
      dataSummary: "Meeting context.",
      toolPackGrants: [grant, grant]
    })).toThrow(/once/i);
  });

  it("keeps exact Tool Pack grants in immutable Agent revisions", () => {
    const grant = {
      packId: "a1000000-0000-4000-8000-000000000001",
      revision: 4,
      manifestDigest,
      toolName: "search"
    };
    expect(agentRevisionSchema.parse({
      agentId: "50000000-0000-4000-8000-000000000001",
      revision: 2,
      name: "Evidence Agent",
      description: "",
      modelConnectorId: null,
      goalSummary: "Review evidence.",
      toolsSummary: "Read-only search.",
      dataSummary: "Meeting context.",
      skillIds: [],
      toolGrants: [],
      toolPackGrants: [grant],
      runtimeProfileBinding: null,
      promptBinding: null,
      contentDigest: "c".repeat(64),
      contentDigestVersion: 2,
      source: "updated",
      restoredFromRevision: null,
      createdAt: "2026-08-03T00:00:00.000Z",
      publishedAt: null
    })).toMatchObject({ toolPackGrants: [grant], contentDigestVersion: 2 });
  });

  it("accepts only an exact current approved read-only Tool Pack grant", () => {
    const grant = {
      packId: "a1000000-0000-4000-8000-000000000001",
      revision: 4,
      manifestDigest,
      toolName: "search"
    };
    const pack = toolPackSchema.parse({
      id: grant.packId,
      ...createInput(),
      manifestDigest,
      revision: 4,
      status: "approved",
      validation: {
        result: "passed",
        summary: "Reviewed.",
        checkedAt: "2026-08-03T00:00:00.000Z",
        manifestDigest
      },
      approvedAt: "2026-08-03T00:00:00.000Z",
      revokedAt: null,
      revocationReason: null,
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z"
    });

    expect(toolPackGrantIsCurrentAndApproved(grant, [pack])).toBe(true);
    expect(toolPackGrantIsCurrentAndApproved({ ...grant, revision: 3 }, [pack])).toBe(false);
    expect(toolPackGrantIsCurrentAndApproved({ ...grant, manifestDigest: `sha256:${"d".repeat(64)}` }, [pack])).toBe(false);
    expect(toolPackGrantIsCurrentAndApproved({ ...grant, toolName: "missing" }, [pack])).toBe(false);
    expect(toolPackGrantIsCurrentAndApproved(grant, [{ ...pack, status: "revoked", revokedAt: pack.updatedAt, revocationReason: "Revoked." }])).toBe(false);
  });
});
