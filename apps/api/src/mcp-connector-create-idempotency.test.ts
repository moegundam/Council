import { describe, expect, it, vi } from "vitest";
import { SecretVault } from "@council/domain";
import { InMemoryPlatformStore, type SecretInput } from "@council/database";
import { createApp } from "./app.js";

const toolRegistration = {
  toolName: "search_docs",
  displayName: "Search docs",
  kind: "mcp_tool" as const,
  version: "1.0.0",
  owner: "Platform Owner",
  goal: "Search approved documentation without writing data."
};

const mcpPayload = {
  name: "Retry-safe MCP",
  location: "cloud" as const,
  baseUrl: "https://1.1.1.1/mcp",
  approvedTools: [toolRegistration.toolName],
  toolRegistrations: [toolRegistration],
  bearerToken: "local-mcp-test-token"
};

class McpCreateEvidenceStore extends InMemoryPlatformStore {
  readonly auditDetails: Record<string, unknown>[] = [];
  mcpCreatedAuditCount = 0;

  override async recordAudit(
    event: string,
    entityType: string,
    entityId: string,
    detail: Record<string, unknown> = {}
  ): Promise<void> {
    if (event === "mcp_connector.created") {
      this.mcpCreatedAuditCount += 1;
      this.auditDetails.push(structuredClone(detail));
    }
    return super.recordAudit(event, entityType, entityId, detail);
  }
}

describe("MCP Connector creation idempotency API", () => {
  it("requires a key and binds replay equality to the complete catalog plus secret without exposing secret evidence", async () => {
    const store = new McpCreateEvidenceStore();
    const createSpy = vi.spyOn(store, "createMcpConnector");
    const replaySpy = vi.spyOn(store, "replayMcpConnectorCreate");
    const secretVault = new SecretVault(Buffer.alloc(32, 41));
    const encryptSpy = vi.spyOn(secretVault, "encrypt");
    const app = await createApp({ store, authDisabled: true, secretVault });

    try {
      const missing = await app.inject({
        method: "POST",
        url: "/api/mcp-connectors",
        payload: { ...mcpPayload, name: "Missing key MCP" }
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
      expect(createSpy).not.toHaveBeenCalled();
      expect(encryptSpy).not.toHaveBeenCalled();

      const key = "mcp-create-retry";
      const [first, concurrentReplay] = await Promise.all([
        app.inject({
          method: "POST",
          url: "/api/mcp-connectors",
          headers: { "idempotency-key": key },
          payload: mcpPayload
        }),
        app.inject({
          method: "POST",
          url: "/api/mcp-connectors",
          headers: { "idempotency-key": key },
          payload: structuredClone(mcpPayload)
        })
      ]);
      const changedSecret = await app.inject({
        method: "POST",
        url: "/api/mcp-connectors",
        headers: { "idempotency-key": key },
        payload: { ...mcpPayload, bearerToken: "changed-local-mcp-test-token" }
      });
      const changedCatalog = await app.inject({
        method: "POST",
        url: "/api/mcp-connectors",
        headers: { "idempotency-key": key },
        payload: {
          ...mcpPayload,
          toolRegistrations: [{ ...toolRegistration, goal: "Search a changed data scope." }]
        }
      });

      expect(first.statusCode).toBe(201);
      expect(concurrentReplay.statusCode).toBe(201);
      expect(concurrentReplay.json()).toEqual(first.json());
      expect(changedSecret.statusCode).toBe(409);
      expect(changedSecret.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });
      expect(changedCatalog.statusCode).toBe(409);
      expect(changedCatalog.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });

      const replayCalls = replaySpy.mock.calls as unknown as Array<[
        unknown,
        SecretInput | undefined,
        string | undefined
      ]>;
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(replayCalls).toHaveLength(4);
      expect(replayCalls[0]?.[1]?.ciphertext).not.toBe(replayCalls[1]?.[1]?.ciphertext);
      expect(replayCalls[0]?.[1]?.idempotencyProof).toBe(replayCalls[1]?.[1]?.idempotencyProof);
      expect(replayCalls[2]?.[1]?.idempotencyProof).not.toBe(replayCalls[0]?.[1]?.idempotencyProof);
      expect(replayCalls[3]?.[1]?.idempotencyProof).toBe(replayCalls[0]?.[1]?.idempotencyProof);
      expect(replayCalls[0]?.[1]?.idempotencyProof).toMatch(/^hmac-sha256:v1:[a-f0-9]{64}$/);
      expect(replayCalls.map((call) => call[2])).toEqual([key, key, key, key]);

      const snapshot = await store.getSnapshot();
      expect(snapshot.mcpConnectors.filter((connector) => connector.name === mcpPayload.name)).toHaveLength(1);
      expect(store.mcpCreatedAuditCount).toBe(1);
      const persistedCiphertext = await store.getConnectorSecret(first.json().id);
      expect(secretVault.decrypt(persistedCiphertext!)).toBe(mcpPayload.bearerToken);

      const publicEvidence = JSON.stringify({
        first: first.json(),
        concurrentReplay: concurrentReplay.json(),
        snapshot,
        auditDetails: store.auditDetails
      });
      expect(publicEvidence).not.toContain(mcpPayload.bearerToken);
      expect(publicEvidence).not.toContain("ciphertext");
      expect(publicEvidence).not.toContain("idempotencyProof");
      expect(publicEvidence).not.toContain("hmac-sha256");
    } finally {
      await app.close();
    }
  });

  it("replays secret-free MCP creation without a configured vault", async () => {
    const store = new McpCreateEvidenceStore();
    const app = await createApp({ store, authDisabled: true });
    const { bearerToken: _bearerToken, ...payload } = mcpPayload;

    try {
      const [first, replay] = await Promise.all([
        app.inject({
          method: "POST",
          url: "/api/mcp-connectors",
          headers: { "idempotency-key": "secret-free-mcp" },
          payload: { ...payload, name: "Secret-free retry MCP" }
        }),
        app.inject({
          method: "POST",
          url: "/api/mcp-connectors",
          headers: { "idempotency-key": "secret-free-mcp" },
          payload: { ...payload, name: "Secret-free retry MCP" }
        })
      ]);

      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(first.json()).toMatchObject({ hasSecret: false, secretRevision: 0 });
      expect(store.mcpCreatedAuditCount).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("replays a committed local MCP create before re-evaluating mutable URL policy", async () => {
    const store = new McpCreateEvidenceStore();
    const allowlist = ["10.20.30.40"];
    const app = await createApp({ store, authDisabled: true, mcpLocalHostAllowlist: allowlist });
    const payload = {
      name: "Policy-stable replay MCP",
      location: "local" as const,
      baseUrl: "http://10.20.30.40/mcp",
      approvedTools: []
    };

    try {
      const first = await app.inject({
        method: "POST",
        url: "/api/mcp-connectors",
        headers: { "idempotency-key": "mcp-policy-stable-replay" },
        payload
      });
      expect(first.statusCode).toBe(201);

      allowlist.length = 0;
      const replay = await app.inject({
        method: "POST",
        url: "/api/mcp-connectors",
        headers: { "idempotency-key": "mcp-policy-stable-replay" },
        payload
      });

      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(store.mcpCreatedAuditCount).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("fails closed when the store returns an unexpected secret-bearing create response", async () => {
    const store = new InMemoryPlatformStore();
    const createMcpConnector = store.createMcpConnector.bind(store);
    store.createMcpConnector = async (...args) => ({
      ...await createMcpConnector(...args),
      bearerToken: "must-not-cross-the-response-boundary"
    }) as never;
    const app = await createApp({ store, authDisabled: true });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/mcp-connectors",
        headers: { "idempotency-key": "secret-bearing-response" },
        payload: {
          name: "Response boundary MCP",
          location: "cloud",
          baseUrl: "https://1.1.1.1/mcp",
          approvedTools: []
        }
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ error: { code: "RESPONSE_CONTRACT_VIOLATION" } });
      expect(response.body).not.toContain("must-not-cross-the-response-boundary");
    } finally {
      await app.close();
    }
  });
});
