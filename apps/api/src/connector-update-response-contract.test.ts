import { describe, expect, it } from "vitest";
import { InMemoryPlatformStore } from "@council/database";
import { createApp } from "./app.js";

describe("connector update response contracts", () => {
  it("fails closed when a Model Connector update returns a secret-bearing field", async () => {
    const store = new InMemoryPlatformStore();
    const connector = await store.createModelConnector({
      name: "Strict update Model",
      location: "cloud",
      baseUrl: "https://1.1.1.1/v1",
      model: "strict-update"
    });
    const updateModelConnector = store.updateModelConnector.bind(store);
    store.updateModelConnector = async (...args) => {
      const result = await updateModelConnector(...args);
      return {
        ...result,
        connector: {
          ...result.connector,
          ciphertext: "must-not-cross-the-model-update-boundary"
        }
      } as never;
    };
    const app = await createApp({ store, authDisabled: true });

    try {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/model-connectors/${connector.id}`,
        payload: { expectedRevision: connector.revision, name: "Strict update Model v2" }
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ error: { code: "RESPONSE_CONTRACT_VIOLATION" } });
      expect(response.body).not.toContain("must-not-cross-the-model-update-boundary");
    } finally {
      await app.close();
    }
  });

  it("fails closed when an MCP Connector update returns a secret-bearing field", async () => {
    const store = new InMemoryPlatformStore();
    const connector = await store.createMcpConnector({
      name: "Strict update MCP",
      location: "cloud",
      baseUrl: "https://1.1.1.1/mcp",
      approvedTools: []
    });
    const updateMcpConnector = store.updateMcpConnector.bind(store);
    store.updateMcpConnector = async (...args) => {
      const result = await updateMcpConnector(...args);
      return {
        ...result,
        bearerToken: "must-not-cross-the-mcp-update-boundary"
      } as never;
    };
    const app = await createApp({ store, authDisabled: true });

    try {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/mcp-connectors/${connector.id}`,
        payload: { expectedRevision: connector.revision, name: "Strict update MCP v2" }
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ error: { code: "RESPONSE_CONTRACT_VIOLATION" } });
      expect(response.body).not.toContain("must-not-cross-the-mcp-update-boundary");
    } finally {
      await app.close();
    }
  });
});
