import { describe, expect, it, vi } from "vitest";
import { agentReadinessBatchResponseSchema } from "@council/contracts";
import { InMemoryPlatformStore } from "@council/database";
import { createApp } from "./app.js";

describe("published Agent readiness batch route", () => {
  it("returns one ordered canonical result per requested Agent from one store snapshot", async () => {
    const store = new InMemoryPlatformStore();
    const initial = await store.getSnapshot();
    const publishedAgent = initial.agents[0]!;
    const disabledAgent = initial.agents[1]!;
    const app = await createApp({ store, authDisabled: true });

    const draftResponse = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "idempotency-key": "batch-draft-agent" },
      payload: {
        name: "Batch draft Agent",
        goalSummary: "Remain unpublished for bounded readiness validation.",
        toolsSummary: "No tools.",
        dataSummary: "No data."
      }
    });
    expect(draftResponse.statusCode).toBe(201);
    const draftAgentId = draftResponse.json().id as string;

    const missingStatusCas = await app.inject({
      method: "PATCH",
      url: `/api/agents/${disabledAgent.id}/status`,
      payload: { status: "disabled" }
    });
    expect(missingStatusCas.statusCode).toBe(400);

    const disabledResponse = await app.inject({
      method: "PATCH",
      url: `/api/agents/${disabledAgent.id}/status`,
      payload: { status: "disabled", expectedRevision: disabledAgent.draftRevision }
    });
    expect(disabledResponse.statusCode).toBe(200);

    const getSnapshot = vi.spyOn(store, "getSnapshot");
    const unknownAgentId = crypto.randomUUID();
    const agentIds = [unknownAgentId, disabledAgent.id, draftAgentId, publishedAgent.id];
    const response = await app.inject({
      method: "POST",
      url: "/api/agents/readiness:batch",
      payload: { agentIds }
    });

    expect(response.statusCode).toBe(200);
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    const body = agentReadinessBatchResponseSchema.parse(response.json());
    expect(body.results.map(({ agentId }) => agentId)).toEqual(agentIds);
    expect(body.results[0]).toMatchObject({
      agentId: unknownAgentId,
      readiness: {
        status: "blocked",
        checks: [{ code: "lifecycle", status: "blocked", message: "找不到 Agent。" }]
      }
    });
    expect(body.results[1]).toMatchObject({
      agentId: disabledAgent.id,
      readiness: {
        status: "blocked",
        checks: [{ code: "lifecycle", status: "blocked", message: "Agent 已停用。" }]
      }
    });
    expect(body.results[2]).toMatchObject({
      agentId: draftAgentId,
      readiness: {
        status: "blocked",
        checks: [{ code: "lifecycle", status: "blocked", message: "Agent 尚未發布。" }]
      }
    });
    expect(body.results[3]).toMatchObject({
      agentId: publishedAgent.id,
      readiness: { status: expect.stringMatching(/^(ready|warning|blocked)$/) }
    });

    getSnapshot.mockRestore();
    const compatibleGet = await app.inject({
      method: "GET",
      url: `/api/agents/${publishedAgent.id}/readiness`
    });
    expect(compatibleGet.statusCode).toBe(200);
    expect(compatibleGet.json()).toMatchObject({
      status: expect.stringMatching(/^(ready|warning|blocked)$/),
      checks: expect.any(Array)
    });
    await app.close();
  });

  it("rejects malformed, duplicate, empty, oversized, and unknown request fields", async () => {
    const store = new InMemoryPlatformStore();
    const app = await createApp({ store, authDisabled: true });
    const validAgentId = (await store.getSnapshot()).agents[0]!.id;
    const invalidPayloads = [
      { agentIds: [] },
      { agentIds: [validAgentId, validAgentId] },
      { agentIds: ["not-an-agent-id"] },
      { agentIds: Array.from({ length: 51 }, () => crypto.randomUUID()) },
      { agentIds: [validAgentId], unexpected: true }
    ];

    for (const payload of invalidPayloads) {
      const response = await app.inject({
        method: "POST",
        url: "/api/agents/readiness:batch",
        payload
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    }

    for (const url of ["/api/agents/readiness", "/api/agents/readinessx"]) {
      const response = await app.inject({ method: "POST", url, payload: { agentIds: [validAgentId] } });
      expect(response.statusCode, url).toBe(404);
    }
    await app.close();
  });

  it("rejects stale Agent lifecycle requests after the resource revision advances", async () => {
    const store = new InMemoryPlatformStore();
    const agent = (await store.getSnapshot()).agents[0]!;
    const revision = agent.revision ?? agent.draftRevision ?? agent.publishedRevision ?? 1;
    const app = await createApp({ store, authDisabled: true });

    try {
      const disabled = await app.inject({
        method: "PATCH",
        url: `/api/agents/${agent.id}/status`,
        payload: { status: "disabled", expectedRevision: revision }
      });
      expect(disabled.statusCode).toBe(200);
      expect(disabled.json()).toMatchObject({ lifecycleStatus: "disabled", revision: revision + 1 });

      const staleReactivate = await app.inject({
        method: "PATCH",
        url: `/api/agents/${agent.id}/status`,
        payload: { status: "published", expectedRevision: revision }
      });
      expect(staleReactivate.statusCode).toBe(409);

      const reactivated = await app.inject({
        method: "PATCH",
        url: `/api/agents/${agent.id}/status`,
        payload: { status: "published", expectedRevision: disabled.json().revision }
      });
      expect(reactivated.statusCode).toBe(200);
      expect(reactivated.json()).toMatchObject({ lifecycleStatus: "published", revision: revision + 2 });
    } finally {
      await app.close();
    }
  });

  it("requires an authenticated session", async () => {
    const store = new InMemoryPlatformStore();
    const agentId = (await store.getSnapshot()).agents[0]!.id;
    const app = await createApp({ store, authDisabled: false });

    const response = await app.inject({
      method: "POST",
      url: "/api/agents/readiness:batch",
      payload: { agentIds: [agentId] }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    await app.close();
  });

  it("keeps draft publication readiness separate from immutable published runtime readiness", async () => {
    const store = new InMemoryPlatformStore();
    const agent = (await store.getSnapshot()).agents[0]!;
    const connector = await store.createModelConnector({
      name: "Published readiness model",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "published-readiness"
    });
    const prompt = await store.createPrompt({
      name: "Published readiness Prompt",
      kind: "agent",
      description: "Keep the published readiness fixture executable.",
      owner: "Test Owner",
      content: "Review {{MEETING_GOAL}}.",
      variables: ["MEETING_GOAL"]
    });
    await store.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 });
    const configured = await store.updateAgent(agent.id, {
      modelConnectorId: connector.id,
      promptBinding: { promptId: prompt.id, version: 1 }
    });
    await store.publishAgent(agent.id, { expectedDraftRevision: configured.draftRevision! });
    await store.updateAgent(agent.id, { modelConnectorId: null });
    const app = await createApp({ store, authDisabled: true });

    const single = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/readiness`
    });
    const batch = await app.inject({
      method: "POST",
      url: "/api/agents/readiness:batch",
      payload: { agentIds: [agent.id] }
    });

    expect(single.statusCode).toBe(200);
    expect(batch.statusCode).toBe(200);
    const batchReadiness = agentReadinessBatchResponseSchema.parse(batch.json()).results[0]!.readiness;
    expect(single.json()).toMatchObject({
      status: "blocked",
      checks: expect.arrayContaining([expect.objectContaining({ code: "model", status: "blocked" })])
    });
    expect(batchReadiness.status).toBe("ready");
    expect(batchReadiness.checks).toContainEqual(expect.objectContaining({
      code: "model",
      status: "passed"
    }));
    await app.close();
  });
});
