import { describe, expect, it } from "vitest";
import type { Agent } from "@council/contracts";
import { InMemoryPlatformStore } from "@council/database";
import { createApp } from "./app.js";

class DriftedAgentResponseStore extends InMemoryPlatformStore {
  private drift(agent: Agent): Agent {
    return { ...agent, ciphertext: "replayed-secret" } as Agent;
  }

  override async createAgent(...args: Parameters<InMemoryPlatformStore["createAgent"]>): Promise<Agent> {
    return this.drift(await super.createAgent(...args));
  }

  override async updateAgent(...args: Parameters<InMemoryPlatformStore["updateAgent"]>): Promise<Agent> {
    return this.drift(await super.updateAgent(...args));
  }

  override async setAgentModel(...args: Parameters<InMemoryPlatformStore["setAgentModel"]>): Promise<Agent> {
    return this.drift(await super.setAgentModel(...args));
  }

  override async publishAgent(...args: Parameters<InMemoryPlatformStore["publishAgent"]>): Promise<Agent> {
    return this.drift(await super.publishAgent(...args));
  }

  override async rollbackAgent(...args: Parameters<InMemoryPlatformStore["rollbackAgent"]>): Promise<Agent> {
    return this.drift(await super.rollbackAgent(...args));
  }

  override async setAgentStatus(...args: Parameters<InMemoryPlatformStore["setAgentStatus"]>): Promise<Agent> {
    return this.drift(await super.setAgentStatus(...args));
  }
}

describe("Agent mutation response contracts", () => {
  it("fails closed when any Agent mutation returns an extra ciphertext field", async () => {
    const store = new DriftedAgentResponseStore();
    const model = await store.createModelConnector({
      name: "Strict response model",
      location: "local",
      baseUrl: "http://192.168.50.11/v1",
      model: "strict-response"
    });
    const prompt = await store.createPrompt({
      name: "Strict response prompt",
      kind: "agent",
      description: "Published prompt for response contract checks.",
      owner: "Test Owner",
      content: "Stay bounded.",
      variables: []
    });
    await store.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 });
    const app = await createApp({ store, authDisabled: true });

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "idempotency-key": "strict-agent-response-create" },
      payload: {
        name: "Strict response Agent",
        description: "Reject drifted mutation responses.",
        modelConnectorId: model.id,
        goalSummary: "Keep Agent mutation responses bounded.",
        toolsSummary: "No tools.",
        dataSummary: "No data.",
        skillIds: [],
        toolGrants: [],
        toolPackGrants: [],
        runtimeProfileBinding: null,
        promptBinding: { promptId: prompt.id, version: 1 }
      }
    });
    expect(created.statusCode).toBe(500);
    expect(created.json()).toMatchObject({ error: { code: "RESPONSE_CONTRACT_VIOLATION" } });

    const createdAgent = (await store.getSnapshot()).agents.find((agent) => agent.name === "Strict response Agent");
    expect(createdAgent).toBeDefined();
    if (!createdAgent) throw new Error("Agent creation fixture did not persist.");

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/agents/${createdAgent.id}`,
      payload: { expectedDraftRevision: createdAgent.draftRevision, name: "Strict response Agent updated" }
    });
    expect(updated.statusCode).toBe(500);
    expect(updated.json()).toMatchObject({ error: { code: "RESPONSE_CONTRACT_VIOLATION" } });

    const updatedAgent = (await store.getSnapshot()).agents.find((agent) => agent.id === createdAgent.id)!;
    const modelUpdated = await app.inject({
      method: "PATCH",
      url: `/api/agents/${createdAgent.id}/model`,
      payload: { expectedDraftRevision: updatedAgent.draftRevision, modelConnectorId: model.id }
    });
    expect(modelUpdated.statusCode).toBe(500);
    expect(modelUpdated.json()).toMatchObject({ error: { code: "RESPONSE_CONTRACT_VIOLATION" } });

    const modelUpdatedAgent = (await store.getSnapshot()).agents.find((agent) => agent.id === createdAgent.id)!;
    const published = await app.inject({
      method: "POST",
      url: `/api/agents/${createdAgent.id}/publish`,
      payload: { expectedDraftRevision: modelUpdatedAgent.draftRevision }
    });
    expect(published.statusCode).toBe(500);
    expect(published.json()).toMatchObject({ error: { code: "RESPONSE_CONTRACT_VIOLATION" } });

    const publishedAgent = (await store.getSnapshot()).agents.find((agent) => agent.id === createdAgent.id)!;
    expect(publishedAgent.lifecycleStatus).toBe("published");
    const rolledBack = await app.inject({
      method: "POST",
      url: `/api/agents/${createdAgent.id}/rollback`,
      payload: {
        expectedPublishedRevision: publishedAgent.publishedRevision,
        expectedDraftRevision: publishedAgent.draftRevision,
        revision: 1
      }
    });
    expect(rolledBack.statusCode).toBe(500);
    expect(rolledBack.json()).toMatchObject({ error: { code: "RESPONSE_CONTRACT_VIOLATION" } });

    const rolledBackAgent = (await store.getSnapshot()).agents.find((agent) => agent.id === createdAgent.id)!;
    const statusUpdated = await app.inject({
      method: "PATCH",
      url: `/api/agents/${createdAgent.id}/status`,
      payload: { status: "disabled", expectedRevision: rolledBackAgent.revision }
    });
    expect(statusUpdated.statusCode).toBe(500);
    expect(statusUpdated.json()).toMatchObject({ error: { code: "RESPONSE_CONTRACT_VIOLATION" } });

    await app.close();
  });
});
