import { describe, expect, it } from "vitest";
import type { CreateToolPackInput } from "@council/contracts";
import { InMemoryPlatformStore } from "@council/database";
import { createApp } from "./app.js";

const imageDigest = `sha256:${"a".repeat(64)}`;

function payload(): CreateToolPackInput {
  return {
    name: "Documentation search",
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

describe("Tool Pack management routes", () => {
  it("requires a caller-owned key, replays one creation, and rejects changed payload reuse", async () => {
    const store = new InMemoryPlatformStore();
    const app = await createApp({ store, authDisabled: true });

    try {
      const missing = await app.inject({ method: "POST", url: "/api/tool-packs", payload: payload() });
      expect(missing.statusCode).toBe(400);
      expect(missing.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });

      const key = "tool-pack-create-retry";
      const [first, replay] = await Promise.all([
        app.inject({
          method: "POST",
          url: "/api/tool-packs",
          headers: { "idempotency-key": key },
          payload: payload()
        }),
        app.inject({
          method: "POST",
          url: "/api/tool-packs",
          headers: { "idempotency-key": key },
          payload: payload()
        })
      ]);
      const conflict = await app.inject({
        method: "POST",
        url: "/api/tool-packs",
        headers: { "idempotency-key": key },
        payload: { ...payload(), description: "Changed request." }
      });

      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });
      const snapshot = await store.getSnapshot();
      expect(snapshot.toolPacks?.filter((pack) => pack.id === first.json().id)).toHaveLength(1);
      expect(snapshot.toolPackRevisions?.filter((revision) => revision.packId === first.json().id)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("supports the governed lifecycle and returns immutable revisions without secrets", async () => {
    const app = await createApp({ store: new InMemoryPlatformStore(), authDisabled: true });
    const created = await app.inject({
      method: "POST",
      url: "/api/tool-packs",
      headers: { "idempotency-key": crypto.randomUUID() },
      payload: payload()
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      version: "1.0.0",
      manifestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      revision: 1,
      status: "draft"
    });
    const packId = created.json().id as string;
    const manifestDigest = created.json().manifestDigest as string;

    const validated = await app.inject({
      method: "POST",
      url: `/api/tool-packs/${packId}/validate`,
      payload: {
        expectedRevision: 1,
        manifestDigest,
        result: "passed",
        summary: "Manifest and read-only behavior reviewed."
      }
    });
    expect(validated.statusCode).toBe(200);
    expect(validated.json()).toMatchObject({ revision: 2, status: "validated", validation: { result: "passed" } });

    const approved = await app.inject({
      method: "POST",
      url: `/api/tool-packs/${packId}/approve`,
      payload: { expectedRevision: 2, manifestDigest }
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ revision: 3, status: "approved" });

    const listed = await app.inject({ method: "GET", url: "/api/tool-packs" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().toolPacks).toContainEqual(expect.objectContaining({ id: packId, revision: 3 }));
    expect(JSON.stringify(listed.json())).not.toContain("ciphertext");
    expect(JSON.stringify(listed.json())).not.toContain("secretValue");

    const revisions = await app.inject({ method: "GET", url: `/api/tool-packs/${packId}/revisions` });
    expect(revisions.statusCode).toBe(200);
    expect(revisions.json().map((item: { revision: number }) => item.revision)).toEqual([3, 2, 1]);

    const revoked = await app.inject({
      method: "POST",
      url: `/api/tool-packs/${packId}/revoke`,
      payload: { expectedRevision: 3, reason: "Source is no longer trusted." }
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ revision: 4, status: "revoked" });
    await app.close();
  });

  it("rejects stale lifecycle mutations, external_write, and secret-bearing metadata", async () => {
    const app = await createApp({ store: new InMemoryPlatformStore(), authDisabled: true });
    const externalWrite = await app.inject({
      method: "POST",
      url: "/api/tool-packs",
      headers: { "idempotency-key": crypto.randomUUID() },
      payload: {
        ...payload(),
        tools: [{ ...payload().tools[0], access: "external_write" }]
      }
    });
    expect(externalWrite.statusCode).toBe(400);

    const secretBearing = await app.inject({
      method: "POST",
      url: "/api/tool-packs",
      headers: { "idempotency-key": crypto.randomUUID() },
      payload: {
        ...payload(),
        secret: "must-not-be-accepted"
      }
    });
    expect(secretBearing.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: "/api/tool-packs",
      headers: { "idempotency-key": crypto.randomUUID() },
      payload: payload()
    });
    const manifestDigest = created.json().manifestDigest as string;
    const stale = await app.inject({
      method: "POST",
      url: `/api/tool-packs/${created.json().id}/validate`,
      payload: {
        expectedRevision: 9,
        manifestDigest,
        result: "passed",
        summary: "Stale validation."
      }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: "REVISION_CONFLICT" } });

    const callerDigest = await app.inject({
      method: "POST",
      url: "/api/tool-packs",
      headers: { "idempotency-key": crypto.randomUUID() },
      payload: { ...payload(), name: "Caller digest", manifestDigest: `sha256:${"f".repeat(64)}` }
    });
    expect(callerDigest.statusCode).toBe(400);
    await app.close();
  });

  it("blocks Team and Meeting admission when a published Agent Tool Pack is revoked", async () => {
    const store = new InMemoryPlatformStore();
    const app = await createApp({ store, authDisabled: true });
    const initial = await store.getSnapshot();
    const agent = initial.agents[0]!;
    const role = initial.roles[0]!;
    const model = await store.createModelConnector({
      name: "Tool Pack test model",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "tool-pack-test"
    });
    const prompt = await store.createPrompt({
      name: "Tool Pack test prompt",
      kind: "agent",
      description: "Published prompt for admission testing.",
      owner: "Platform Owner",
      content: "Stay within the meeting goal.",
      variables: []
    });
    await store.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 });

    const created = await store.createToolPack(payload());
    const validated = await store.validateToolPack(created.id, {
      expectedRevision: created.revision,
      manifestDigest: created.manifestDigest,
      result: "passed",
      summary: "Manifest reviewed."
    });
    const approved = await store.approveToolPack(created.id, {
      expectedRevision: validated.revision,
      manifestDigest: validated.manifestDigest
    });
    const updatedAgent = await store.updateAgent(agent.id, {
      modelConnectorId: model.id,
      promptBinding: { promptId: prompt.id, version: 1 },
      toolPackGrants: [{
        packId: approved.id,
        revision: approved.revision,
        manifestDigest: approved.manifestDigest,
        toolName: "search"
      }]
    });
    await store.publishAgent(agent.id, { expectedDraftRevision: updatedAgent.draftRevision! });
    await store.revokeToolPack(approved.id, {
      expectedRevision: approved.revision,
      reason: "Validation evidence expired."
    });

    const team = await app.inject({
      method: "POST",
      url: "/api/agent-teams",
      headers: { "idempotency-key": "tool-pack-agent-team" },
      payload: {
        name: "Revoked pack team",
        description: "Must fail closed.",
        members: [{ agentId: agent.id, roleId: role.id, isChair: true }]
      }
    });
    expect(team.statusCode).toBe(409);
    expect(team.json()).toMatchObject({ error: { code: "AGENT_TEAM_MEMBER_NOT_READY" } });

    const thread = await app.inject({
      method: "POST",
      url: "/api/threads",
      headers: { "idempotency-key": crypto.randomUUID() },
      payload: {
        categoryId: initial.categories[0]!.id,
        title: "Revoked Tool Pack admission",
        summary: "The published Agent must no longer enter a Meeting.",
        tagIds: []
      }
    });
    const meeting = await app.inject({
      method: "POST",
      url: "/api/meetings",
      headers: { "idempotency-key": crypto.randomUUID() },
      payload: {
        threadId: thread.json().id,
        title: "Revoked Tool Pack",
        goal: "Verify fail-closed admission.",
        mode: "chaired",
        automation: "suggest",
        durationMinutes: 30,
        participants: [{ agentId: agent.id, roleId: role.id, isChair: true }],
        agendaItems: [{ title: "Admission", description: "Confirm revoked packs are blocked." }]
      }
    });
    expect(meeting.statusCode).toBe(409);
    expect(meeting.json()).toMatchObject({ error: { code: "PARTICIPANT_NOT_READY" } });
    await app.close();
  });
});
