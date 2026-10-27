import { describe, expect, it } from "vitest";
import type { CreateToolPackInput, ToolPack, ToolPackGrant } from "@council/contracts";
import { InMemoryPlatformStore } from "./memory-store.js";

const imageDigest = `sha256:${"a".repeat(64)}`;

function packInput(name = "Documentation search"): CreateToolPackInput {
  return {
    name,
    version: "1.0.0",
    description: "Read-only tools for approved documentation snapshots.",
    owner: "Platform Owner",
    sourceReference: `registry.example.com/council/docs@${imageDigest}`,
    imageDigest,
    tools: [{
      name: "search",
      kind: "command",
      goal: "Search an immutable documentation snapshot.",
      access: "read_only",
      argv: { executable: "/usr/bin/rg", fixedArguments: ["--json"] },
      env: { allowedNames: ["LANG"] },
      stdin: { mode: "none" }
    }]
  };
}

class AuditedMemoryStore extends InMemoryPlatformStore {
  readonly audits: Array<{ event: string; entityType: string; entityId: string; detail: Record<string, unknown> }> = [];

  override async recordAudit(
    event: string,
    entityType: string,
    entityId: string,
    detail: Record<string, unknown> = {}
  ): Promise<void> {
    this.audits.push({ event, entityType, entityId, detail });
  }
}

async function approvePack(store: InMemoryPlatformStore): Promise<ToolPack> {
  const created = await store.createToolPack(packInput());
  const validated = await store.validateToolPack(created.id, {
    expectedRevision: created.revision,
    manifestDigest: created.manifestDigest,
    result: "passed",
    summary: "Manifest and read-only behavior reviewed."
  });
  return store.approveToolPack(created.id, {
    expectedRevision: validated.revision,
    manifestDigest: validated.manifestDigest
  });
}

describe("Tool Pack governance store", () => {
  it("replays one exact create request and rejects key reuse with changed content", async () => {
    const store = new AuditedMemoryStore();
    const input = packInput("Retry-safe Tool Pack");
    const key = "tool-pack-create-retry";

    const [first, replay] = await Promise.all([
      store.createToolPack(input, key),
      store.createToolPack(input, key)
    ]);

    expect(replay).toEqual(first);
    await expect(store.createToolPack({ ...input, description: "Changed request." }, key))
      .rejects.toMatchObject({ apiCode: "IDEMPOTENCY_KEY_CONFLICT" });
    const snapshot = await store.getSnapshot();
    expect(snapshot.toolPacks?.filter((pack) => pack.id === first.id)).toHaveLength(1);
    expect(snapshot.toolPackRevisions?.filter((revision) => revision.packId === first.id)).toHaveLength(1);
    expect(store.audits.filter((audit) => audit.event === "tool_pack.created")).toHaveLength(1);
  });

  it("keeps every content and lifecycle mutation as an immutable revision", async () => {
    const store = new AuditedMemoryStore();
    const created = await store.createToolPack(packInput());
    expect(created).toMatchObject({
      version: "1.0.0",
      manifestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      revision: 1,
      status: "draft",
      validation: { result: "pending" }
    });

    const updated = await store.updateToolPack(created.id, {
      expectedRevision: 1,
      description: "Updated before validation."
    });
    expect(updated).toMatchObject({ revision: 2, status: "draft", validation: { result: "pending" } });
    expect(updated.manifestDigest).not.toBe(created.manifestDigest);
    await expect(store.updateToolPack(created.id, {
      expectedRevision: 1,
      description: "Stale update."
    })).rejects.toMatchObject({
      kind: "revision",
      message: expect.stringMatching(/stale/i)
    });

    const failed = await store.validateToolPack(created.id, {
      expectedRevision: 2,
      manifestDigest: updated.manifestDigest,
      result: "failed",
      summary: "Validation found an undeclared operation."
    });
    expect(failed).toMatchObject({
      revision: 3,
      status: "validated",
      validation: { result: "failed", manifestDigest: updated.manifestDigest }
    });
    await expect(store.approveToolPack(created.id, {
      expectedRevision: 3,
      manifestDigest: failed.manifestDigest
    })).rejects.toThrow(/passed validation/i);

    const passed = await store.validateToolPack(created.id, {
      expectedRevision: 3,
      manifestDigest: failed.manifestDigest,
      result: "passed",
      summary: "Manifest and read-only behavior reviewed."
    });
    const approved = await store.approveToolPack(created.id, {
      expectedRevision: passed.revision,
      manifestDigest: passed.manifestDigest
    });
    expect(approved).toMatchObject({ revision: 5, status: "approved", approvedAt: expect.any(String) });
    await expect(store.updateToolPack(created.id, {
      expectedRevision: 5,
      description: "Approved packs are immutable."
    })).rejects.toThrow(/approved/i);

    const revoked = await store.revokeToolPack(created.id, {
      expectedRevision: 5,
      reason: "Source is no longer trusted."
    });
    expect(revoked).toMatchObject({ revision: 6, status: "revoked", revokedAt: expect.any(String) });
    await expect(store.validateToolPack(created.id, {
      expectedRevision: 6,
      manifestDigest: revoked.manifestDigest,
      result: "passed",
      summary: "Cannot revive a revoked pack."
    })).rejects.toThrow(/terminal/i);

    const revisions = await store.getToolPackRevisions(created.id);
    expect(revisions.map((item) => [item.revision, item.source])).toEqual([
      [6, "revoked"],
      [5, "approved"],
      [4, "validated"],
      [3, "validated"],
      [2, "updated"],
      [1, "created"]
    ]);
    expect(revisions.find((item) => item.revision === 1)?.description).toBe(packInput().description);
    expect(store.audits.map((item) => item.event)).toEqual([
      "tool_pack.created",
      "tool_pack.updated",
      "tool_pack.validation.failed",
      "tool_pack.validation.passed",
      "tool_pack.approved",
      "tool_pack.revoked"
    ]);
  });

  it("approves only the current passed validation with the immutable manifest digest", async () => {
    const store = new InMemoryPlatformStore();
    const created = await store.createToolPack(packInput());
    await expect(store.validateToolPack(created.id, {
      expectedRevision: 1,
      manifestDigest: `sha256:${"c".repeat(64)}`,
      result: "passed",
      summary: "Wrong digest."
    })).rejects.toThrow(/digest/i);
    await expect(store.approveToolPack(created.id, {
      expectedRevision: 1,
      manifestDigest: created.manifestDigest
    })).rejects.toThrow(/validated/i);
  });

  it("derives the manifest digest from normalized content and never accepts a caller-supplied digest", async () => {
    const store = new InMemoryPlatformStore();
    const created = await store.createToolPack(packInput());
    const sameContent = await new InMemoryPlatformStore().createToolPack(packInput());
    expect(sameContent.manifestDigest).toBe(created.manifestDigest);

    const expanded = await store.updateToolPack(created.id, {
      expectedRevision: created.revision,
      tools: [{
        ...packInput().tools[0]!,
        env: { allowedNames: ["LANG", "LC_ALL"] }
      }]
    });
    const reordered = await store.updateToolPack(created.id, {
      expectedRevision: expanded.revision,
      tools: [{
        ...packInput().tools[0]!,
        env: { allowedNames: ["LC_ALL", "LANG"] }
      }]
    });
    expect(reordered.revision).toBe(expanded.revision);
    expect(reordered.manifestDigest).toBe(expanded.manifestDigest);

    await expect(store.createToolPack({
      ...packInput("Caller digest"),
      manifestDigest: `sha256:${"f".repeat(64)}`
    } as never)).rejects.toThrow();
    await expect(store.updateToolPack(created.id, {
      expectedRevision: created.revision,
      manifestDigest: `sha256:${"f".repeat(64)}`
    } as never)).rejects.toThrow();
  });

  it("rejects digest drift in persisted current and historical Tool Pack content", async () => {
    const store = new InMemoryPlatformStore();
    await approvePack(store);

    const tamperedCurrent = await store.getSnapshot();
    tamperedCurrent.toolPacks![0]!.description = "Tampered after persistence.";
    expect(() => new InMemoryPlatformStore(tamperedCurrent)).toThrow(/manifest digest/i);

    const tamperedHistory = await store.getSnapshot();
    tamperedHistory.toolPackRevisions![0]!.owner = "Untrusted owner";
    expect(() => new InMemoryPlatformStore(tamperedHistory)).toThrow(/manifest digest/i);
  });

  it("binds Agents to one exact current approved Tool Pack tool and fails closed on duplicate or stale grants", async () => {
    const store = new InMemoryPlatformStore();
    const approved = await approvePack(store);
    const grant: ToolPackGrant = {
      packId: approved.id,
      revision: approved.revision,
      manifestDigest: approved.manifestDigest,
      toolName: "search"
    };
    const agent = await store.createAgent({
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
      promptBinding: null
    });
    expect(agent.toolPackGrants).toEqual([grant]);
    await expect(store.getAgentRevision(agent.id, 1)).resolves.toMatchObject({ toolPackGrants: [grant] });

    await expect(store.createAgent({
      name: "Duplicate Tool Pack grants",
      goalSummary: "Review evidence.",
      toolsSummary: "Read-only search.",
      dataSummary: "Meeting context.",
      toolPackGrants: [grant, grant]
    } as never)).rejects.toThrow(/once/i);
    await expect(store.createAgent({
      name: "Stale Tool Pack grant",
      goalSummary: "Review evidence.",
      toolsSummary: "Read-only search.",
      dataSummary: "Meeting context.",
      toolPackGrants: [{ ...grant, revision: approved.revision - 1 }]
    } as never)).rejects.toThrow(/current approved/i);
    await expect(store.createAgent({
      name: "Digest drift Tool Pack grant",
      goalSummary: "Review evidence.",
      toolsSummary: "Read-only search.",
      dataSummary: "Meeting context.",
      toolPackGrants: [{ ...grant, manifestDigest: `sha256:${"d".repeat(64)}` }]
    } as never)).rejects.toThrow(/current approved/i);
    await expect(store.createAgent({
      name: "Unknown Tool Pack tool",
      goalSummary: "Review evidence.",
      toolsSummary: "Read-only search.",
      dataSummary: "Meeting context.",
      toolPackGrants: [{ ...grant, toolName: "missing" }]
    } as never)).rejects.toThrow(/declared read-only tool/i);

    await store.revokeToolPack(approved.id, {
      expectedRevision: approved.revision,
      reason: "Validation evidence expired."
    });
    await expect(store.updateAgent(agent.id, { description: "Must rebind before editing." }))
      .rejects.toThrow(/current approved/i);
    await expect(store.getAgentReadiness(agent.id)).resolves.toMatchObject({
      checks: expect.arrayContaining([expect.objectContaining({ code: "tool", status: "blocked" })])
    });
  });

  it("verifies version 3 Agent revision digests instead of silently replacing them", async () => {
    const store = new InMemoryPlatformStore();
    const agent = await store.createAgent({
      name: "Immutable Agent",
      description: "",
      modelConnectorId: null,
      goalSummary: "Review evidence.",
      toolsSummary: "No tools.",
      dataSummary: "Meeting context.",
      skillIds: [],
      toolGrants: [],
      toolPackGrants: [],
      runtimeProfileBinding: null,
      promptBinding: null
    });
    const revisions = await store.getAgentRevisions(agent.id);
    const snapshot = await store.getSnapshot();
    expect(revisions[0]).toMatchObject({ contentDigestVersion: 3 });
    revisions[0]!.name = "Tampered Agent";

    expect(() => new InMemoryPlatformStore(snapshot, { agentRevisions: revisions }))
      .toThrow(/content digest/i);
  });

  it("rejects duplicate names without leaking secret-shaped input into public state", async () => {
    const store = new InMemoryPlatformStore();
    await store.createToolPack(packInput());
    await expect(store.createToolPack(packInput("Ｄｏｃｕｍｅｎｔａｔｉｏｎ　ｓｅａｒｃｈ"))).rejects.toThrow(/name/i);
    expect(JSON.stringify(await store.getSnapshot())).not.toContain("secret");
  });
});
