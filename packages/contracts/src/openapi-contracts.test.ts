import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApiContractCapabilities } from "./openapi-contracts.js";

const requiredCapabilities = [
  "GET /api/health/live",
  "GET /api/health/ready",
  "GET /api/bootstrap",
  "POST /api/groups",
  "PATCH /api/groups/:id",
  "POST /api/categories",
  "PATCH /api/categories/:id",
  "POST /api/tags",
  "PATCH /api/tags/:id",
  "POST /api/threads",
  "PATCH /api/threads/:id",
  "POST /api/agents",
  "PATCH /api/agents/:id",
  "PATCH /api/agents/:id/model",
  "GET /api/agents/:id/readiness",
  "POST /api/agents/readiness:batch",
  "GET /api/agents/:id/revisions",
  "POST /api/agents/:id/publish",
  "POST /api/agents/:id/rollback",
  "PATCH /api/agents/:id/status",
  "POST /api/roles",
  "GET /api/roles/:id/lifecycle",
  "PATCH /api/roles/:id",
  "POST /api/roles/:id/rollback",
  "DELETE /api/roles/:id",
  "POST /api/meetings",
  "PATCH /api/meetings/:id/agenda",
  "POST /api/meetings/:id/agenda/advance",
  "POST /api/meetings/:id/start",
  "POST /api/meetings/:id/pause",
  "POST /api/meetings/:id/resume",
  "POST /api/meetings/:id/close",
  "POST /api/meetings/:id/utterances",
  "PATCH /api/meetings/:id/automation",
  "POST /api/meetings/:id/mode",
  "POST /api/meetings/:id/run",
  "POST /api/decisions",
  "POST /api/decisions/:id/approve",
  "POST /api/decisions/:id/reject",
  "POST /api/tasks",
  "GET /api/tasks/:id",
  "PATCH /api/tasks/:id",
  "POST /api/tasks/:id/approval",
  "POST /api/tasks/:id/run",
  "POST /api/tasks/:id/evidence",
  "PATCH /api/tasks/:id/status",
  "POST /api/tasks/:id/sync",
  "POST /api/model-connectors",
  "PATCH /api/model-connectors/:id",
  "POST /api/model-connectors/:id/health",
  "POST /api/mcp-connectors",
  "PATCH /api/mcp-connectors/:id",
  "POST /api/mcp-connectors/:id/discover",
  "GET /api/credentials",
  "POST /api/credentials",
  "PATCH /api/credentials/:id",
  "POST /api/credentials/:id/rotate",
  "PATCH /api/credentials/:id/status",
  "GET /api/prompts",
  "POST /api/prompts",
  "PATCH /api/prompts/:id",
  "GET /api/prompts/:id/versions",
  "POST /api/prompts/:id/publish",
  "POST /api/prompts/:id/rollback",
  "POST /api/prompts/:id/archive",
  "POST /api/prompts/:id/preview",
  "POST /api/executions/harness"
] as const;

const forbiddenResponseProperties = new Set([
  "apikey",
  "bearertoken",
  "ciphertext",
  "encryptedsecret",
  "password",
  "passwordhash",
  "privatekey",
  "refreshtoken",
  "secret",
  "tokenhash"
]);

function propertyNames(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) propertyNames(item, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "properties" && nested && typeof nested === "object" && !Array.isArray(nested)) {
      for (const property of Object.keys(nested)) result.add(property.toLocaleLowerCase().replace(/[^a-z0-9]/g, ""));
    }
    propertyNames(nested, result);
  }
  return result;
}

describe("machine-readable API contract capabilities", () => {
  it("covers the golden path and high-value management operations with stable unique operation IDs", () => {
    const capabilities = createApiContractCapabilities();
    const keys = new Set(capabilities.map(({ method, path }) => `${method} ${path}`));

    expect([...keys]).toEqual(expect.arrayContaining([...requiredCapabilities]));
    expect(keys.size).toBe(capabilities.length);
    expect(new Set(capabilities.map(({ operationId }) => operationId)).size).toBe(capabilities.length);
    expect(capabilities.every(({ operationId }) => /^[a-z][A-Za-z0-9]+$/.test(operationId))).toBe(true);
    expect(capabilities.every(({ responses }) => responses.length > 0)).toBe(true);
  });

  it.each([
    ["POST", "/api/groups"],
    ["POST", "/api/categories"],
    ["POST", "/api/tags"],
    ["POST", "/api/threads"],
    ["POST", "/api/decisions"],
    ["POST", "/api/tasks"],
    ["POST", "/api/agents"],
    ["POST", "/api/roles"],
    ["POST", "/api/skills"],
    ["POST", "/api/tool-packs"],
    ["POST", "/api/runtime-profiles"],
    ["POST", "/api/agent-teams"],
    ["POST", "/api/meeting-presets"],
    ["POST", "/api/credentials/:id/rotate"],
    ["DELETE", "/api/roles/:id"],
    ["POST", "/api/skills/:id/revoke"],
    ["PATCH", "/api/credentials/:id/status"],
    ["POST", "/api/model-connectors"],
    ["POST", "/api/mcp-connectors"],
    ["POST", "/api/task-adapter-connectors"],
    ["POST", "/api/meetings"],
    ["POST", "/api/meetings/:id/utterances"],
    ["POST", "/api/meetings/:id/run"],
    ["POST", "/api/tasks/:id/evidence"],
    ["POST", "/api/executions/harness"]
  ] as const)("declares a required Idempotency-Key header for %s %s", (method, path) => {
    const capability = createApiContractCapabilities().find((candidate) => (
      candidate.method === method && candidate.path === path
    ));

    expect(capability).toBeDefined();
    expect(capability?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "Idempotency-Key",
        in: "header",
        required: true
      })
    ]));
  });

  it("publishes the bounded Agent readiness batch as a session capability", () => {
    const capability = createApiContractCapabilities().find(({ operationId }) => (
      operationId === "getPublishedAgentReadinessBatch"
    ));

    expect(capability).toMatchObject({
      method: "POST",
      path: "/api/agents/readiness:batch",
      security: "session",
      requestBody: { componentName: "AgentReadinessBatchRequest", required: true },
      responses: [{ status: "200", componentName: "AgentReadinessBatchResponse" }]
    });
    const requestSchema = z.toJSONSchema(capability!.requestBody!.schema, {
      target: "draft-2020-12",
      io: "input",
      unrepresentable: "any"
    }) as Record<string, any>;
    expect(requestSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        agentIds: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: { type: "string", format: "uuid" }
        }
      },
      required: ["agentIds"]
    });
  });

  it("publishes active Agent Team blockers in the Role lifecycle response", () => {
    const capability = createApiContractCapabilities().find(({ operationId }) => operationId === "getRoleLifecycle");
    const response = capability?.responses.find((candidate) => candidate.status === "200");
    if (!response || !("schema" in response)) throw new Error("Role lifecycle response schema is missing.");

    const responseSchema = z.toJSONSchema(response.schema, {
      target: "draft-2020-12",
      io: "output",
      unrepresentable: "any"
    }) as Record<string, any>;

    expect(responseSchema).toMatchObject({
      properties: { activeTeamCount: { type: "integer", minimum: 0 } },
      required: expect.arrayContaining(["activeTeamCount"])
    });
  });

  it("publishes both immediate and pending Meeting summary retry responses", () => {
    const capability = createApiContractCapabilities().find(({ operationId }) => operationId === "retryMeetingSummary");

    expect(capability?.responses.map(({ status }) => status)).toEqual(["200", "202"]);
    expect(capability?.responses.every((candidate) => (
      "componentName" in candidate && candidate.componentName === "MeetingResponse"
    ))).toBe(true);
  });

  it("publishes optimistic concurrency for Agent status, Model, and MCP Connector mutations", () => {
    const capabilities = createApiContractCapabilities();
    const jsonSchema = (schema: z.ZodType, io: "input" | "output") => z.toJSONSchema(schema, {
      target: "draft-2020-12",
      io,
      unrepresentable: "any"
    }) as Record<string, any>;
    const modelUpdate = capabilities.find(({ operationId }) => operationId === "updateModelConnector")!;
    const mcpUpdate = capabilities.find(({ operationId }) => operationId === "updateMcpConnector")!;
    const createModel = capabilities.find(({ operationId }) => operationId === "createModelConnector")!;
    const createMcp = capabilities.find(({ operationId }) => operationId === "createMcpConnector")!;
    const discoverMcp = capabilities.find(({ operationId }) => operationId === "discoverMcpTools")!;
    const agentStatus = capabilities.find(({ operationId }) => operationId === "setAgentStatus")!;
    const successSchema = (capability: typeof modelUpdate) => {
      const response = capability.responses.find(({ status }) => status === "200")
        ?? capability.responses.find(({ status }) => status === "201");
      if (!response || !("schema" in response)) throw new Error(`${capability.operationId} response schema is missing.`);
      return jsonSchema(response.schema as z.ZodType, "output");
    };

    expect(jsonSchema(modelUpdate.requestBody!.schema, "input").required)
      .toContain("expectedRevision");
    expect(jsonSchema(mcpUpdate.requestBody!.schema, "input").required)
      .toContain("expectedRevision");
    expect(jsonSchema(agentStatus.requestBody!.schema, "input").required)
      .toContain("expectedRevision");
    expect(successSchema(createModel).required).toContain("revision");
    expect(successSchema(createMcp).required).toContain("revision");
    expect(successSchema(modelUpdate).required).toContain("revision");
    expect(successSchema(mcpUpdate).properties.connector.required).toContain("revision");
    expect(successSchema(discoverMcp).properties.connector.required).toContain("revision");
  });

  it("converts every request and response from Zod 4 without handwritten JSON Schema", () => {
    for (const capability of createApiContractCapabilities()) {
      if (capability.requestBody) {
        const requestBody = capability.requestBody;
        expect(() => z.toJSONSchema(requestBody.schema, {
          target: "draft-2020-12",
          io: "input",
          unrepresentable: "any"
        })).not.toThrow();
      }
      for (const response of capability.responses) {
        if (!("schema" in response)) continue;
        expect(() => z.toJSONSchema(response.schema, {
          target: "draft-2020-12",
          io: "output",
          unrepresentable: "any"
        })).not.toThrow();
      }
    }
  });

  it("keeps secret-bearing fields out of all success response schemas", () => {
    const capabilities = createApiContractCapabilities();
    for (const capability of capabilities) {
      for (const response of capability.responses) {
        if (!("schema" in response)) continue;
        const schema = z.toJSONSchema(response.schema, {
          target: "draft-2020-12",
          io: "output",
          unrepresentable: "any"
        });
        const leaked = [...propertyNames(schema)].filter((property) => forbiddenResponseProperties.has(property));
        expect(leaked, `${capability.operationId} response exposes a secret-bearing property`).toEqual([]);
      }
    }

    const createCredential = capabilities.find(({ operationId }) => operationId === "createCredential")!;
    const requestSchema = z.toJSONSchema(createCredential.requestBody!.schema, { io: "input" });
    const credentialResponse = createCredential.responses[0]!;
    if (!("schema" in credentialResponse)) throw new Error("Credential response schema is missing.");
    const responseSchema = z.toJSONSchema(credentialResponse.schema, { io: "output" });
    expect(propertyNames(requestSchema)).toContain("secret");
    expect(propertyNames(responseSchema)).not.toContain("secret");
  });
});
