import { describe, expect, it } from "vitest";
import { createApiContractCapabilities } from "@council/contracts/openapi-contracts";
import { InMemoryPlatformStore } from "@council/database";
import { createApp } from "./app.js";
import { ApiRouteInventory, createOpenApiDocument } from "./openapi.js";

function operation(document: Record<string, any>, path: string, method: string): Record<string, any> {
  return document.paths[path][method];
}

function references(value: unknown, result: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) references(item, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "$ref" && typeof nested === "string") result.push(nested);
    references(nested, result);
  }
  return result;
}

function resolvesReference(document: Record<string, any>, reference: string): boolean {
  if (!reference.startsWith("#/")) return true;
  let current: unknown = document;
  for (const token of reference.slice(2).split("/")) {
    if (!current || typeof current !== "object") return false;
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    current = (current as Record<string, unknown>)[key];
  }
  return current !== undefined;
}

const mutatingOpenApiMethods = new Set(["post", "put", "patch", "delete"]);
const requiredOriginParameter = {
  name: "Origin",
  in: "header",
  required: true,
  description: "Exact same-origin value required for CSRF protection.",
  schema: { type: "string", format: "uri" }
};

function originParameters(apiOperation: Record<string, any>): Array<Record<string, any>> {
  return (apiOperation.parameters ?? []).filter((parameter: Record<string, any>) => (
    parameter.in === "header" && parameter.name?.toLocaleLowerCase() === "origin"
  ));
}

const typedManagementOperations = [
  ["/api/v1/tool-packs", "get"],
  ["/api/v1/tool-packs", "post"],
  ["/api/v1/tool-packs/{id}", "patch"],
  ["/api/v1/tool-packs/{id}/revisions", "get"],
  ["/api/v1/tool-packs/{id}/validate", "post"],
  ["/api/v1/tool-packs/{id}/approve", "post"],
  ["/api/v1/tool-packs/{id}/revoke", "post"],
  ["/api/v1/runtime-profiles", "get"],
  ["/api/v1/runtime-profiles", "post"],
  ["/api/v1/runtime-profiles/{id}", "patch"],
  ["/api/v1/runtime-profiles/{id}/revisions", "get"],
  ["/api/v1/agent-teams", "post"],
  ["/api/v1/agent-teams/{id}", "patch"],
  ["/api/v1/meeting-presets", "post"],
  ["/api/v1/meeting-presets/{id}", "patch"],
  ["/api/v1/skills", "post"],
  ["/api/v1/skills/{id}/status", "patch"],
  ["/api/v1/skills/{id}/validation", "post"],
  ["/api/v1/skills/{id}/revoke", "post"],
  ["/api/v1/task-adapter-connectors", "post"],
  ["/api/v1/task-adapter-connectors/{id}/health", "post"],
  ["/api/v1/tools/authorize", "post"],
  ["/api/v1/agents/readiness:batch", "post"],
  ["/api/v1/agents/{id}/effective-configuration", "get"],
  ["/api/v1/meeting-presets/{id}/preflight", "get"],
  ["/api/v1/action-adapters", "get"],
  ["/api/v1/action-adapters", "post"]
] as const;

const intentionalSchemaGaps = [
  "GET /api/v1/openapi.json",
  "POST /api/v1/auth/login",
  "POST /api/v1/auth/logout",
  "POST /api/v1/auth/tailnet-login",
  "POST /api/v1/auth/test-login"
] as const;

describe("OpenAPI 3.1 document", () => {
  it("is generated from Zod contracts and the actual Fastify route inventory", async () => {
    const app = await createApp({ store: new InMemoryPlatformStore(), authDisabled: true });
    const response = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    const document = response.json<Record<string, any>>();

    expect(response.statusCode).toBe(200);
    expect(document.openapi).toBe("3.1.0");
    expect(document.jsonSchemaDialect).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(operation(document, "/api/v1/bootstrap", "get")).toMatchObject({
      operationId: "getBootstrap",
      "x-contract-status": "typed"
    });
    expect(operation(document, "/api/v1/meetings/{id}/run", "post")).toMatchObject({
      operationId: "runMeetingAgent",
      "x-contract-status": "typed",
      "x-authority": {
        caller: "owner_session",
        effect: "enqueue",
        agentHttpAccessible: false
      }
    });
    expect(operation(document, "/api/v1/health/live", "get")["x-authority"]).toEqual({
      caller: "public",
      effect: "observe",
      agentHttpAccessible: false
    });
    expect(operation(document, "/api/v1/prompts/{id}/publish", "post")["x-authority"]).toEqual({
      caller: "owner_session",
      effect: "govern",
      agentHttpAccessible: false
    });
    expect(operation(document, "/api/v1/auth/login", "post")["x-authority"]).toEqual({
      caller: "public",
      effect: "authenticate",
      agentHttpAccessible: false
    });
    expect(operation(document, "/api/v1/auth/test-login", "post")["x-authority"]).toEqual({
      caller: "public",
      effect: "authenticate",
      agentHttpAccessible: false
    });
    expect(operation(document, "/api/v1/auth/tailnet-login", "post")["x-authority"]).toEqual({
      caller: "public",
      effect: "authenticate",
      agentHttpAccessible: false
    });
    expect(operation(document, "/api/v1/executions/harness", "post")).toMatchObject({
      operationId: "startHarnessExecution",
      "x-contract-status": "typed",
      "x-authority": {
        caller: "owner_session",
        effect: "enqueue",
        agentHttpAccessible: false
      }
    });
    expect(operation(document, "/api/v1/credentials", "post").requestBody.content["application/json"].schema.$ref)
      .toBe("#/components/schemas/CreateCredentialRequest");
    expect(operation(document, "/api/v1/credentials", "post").responses["201"].content["application/json"].schema.$ref)
      .toBe("#/components/schemas/CredentialResponse");
    expect(operation(document, "/api/v1/credentials", "post").responses.default.content["application/json"].schema.$ref)
      .toBe("#/components/schemas/ApiErrorResponse");
    expect(operation(document, "/api/v1/credentials", "post").parameters).toContainEqual(expect.objectContaining({
      name: "Idempotency-Key",
      in: "header",
      required: true
    }));
    expect(operation(document, "/api/v1/tool-packs", "post").parameters).toContainEqual(expect.objectContaining({
      name: "Idempotency-Key",
      in: "header",
      required: true
    }));
    expect(operation(document, "/api/v1/prompts", "post").parameters).toContainEqual(expect.objectContaining({
      name: "Idempotency-Key",
      in: "header",
      required: true
    }));
    for (const path of ["/api/v1/agent-teams", "/api/v1/meeting-presets"]) {
      expect(operation(document, path, "post").parameters).toContainEqual(expect.objectContaining({
        name: "Idempotency-Key",
        in: "header",
        required: true
      }));
    }
    for (const [path, method] of [
      ["/api/v1/roles/{id}", "delete"],
      ["/api/v1/skills/{id}/revoke", "post"],
      ["/api/v1/credentials/{id}/status", "patch"]
    ] as const) {
      expect(operation(document, path, method).parameters).toContainEqual(expect.objectContaining({
        name: "Idempotency-Key",
        in: "header",
        required: true
      }));
    }
    expect(document.components.schemas.UpdateModelConnectorRequest.required).toContain("expectedRevision");
    expect(document.components.schemas.UpdateMcpConnectorRequest.required).toContain("expectedRevision");
    expect(document.components.schemas.ModelConnectorResponse.required).toContain("revision");
    expect(document.components.schemas.McpConnectorResponse.required).toContain("revision");
    expect(document.components.schemas.ModelConnectorUpdateResponse.required).toContain("revision");
    expect(document.components.schemas.McpConnectorUpdateResponse.properties.connector.required)
      .toContain("revision");
    expect(document.components.schemas.McpDiscoveryResponse.properties.connector.required)
      .toContain("revision");
    expect(document.components.schemas.SyncTaskRequest.required).toEqual(expect.arrayContaining([
      "adapterId",
      "expectedRevision",
      "expectedStatus",
      "expectedApprovalState",
      "expectedSyncAttemptCount"
    ]));
    expect(operation(document, "/api/v1/meetings/{id}/summary/retry", "post").responses)
      .toMatchObject({
        "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/MeetingResponse" } } } },
        "202": { content: { "application/json": { schema: { $ref: "#/components/schemas/MeetingResponse" } } } }
      });

    const coverage = document["x-capability-coverage"];
    expect(coverage.status).toBe("partial");
    expect(coverage.typedOperations).toBe(121);
    expect(coverage.registeredOperations).toBe(126);
    expect(coverage.schemaGaps.map((gap: Record<string, string>) => `${gap.method} ${gap.path}`))
      .toEqual(intentionalSchemaGaps);
    expect(document["x-authority-coverage"]).toEqual({
      status: "complete",
      classifiedOperations: 126,
      registeredOperations: 126,
      agentHttpOperations: 0
    });
    for (const [path, method] of typedManagementOperations) {
      expect(operation(document, path, method), `${method.toUpperCase()} ${path}`).toMatchObject({
        "x-contract-status": "typed"
      });
      expect(coverage.schemaGaps).not.toContainEqual(expect.objectContaining({
        method: method.toUpperCase(),
        path
      }));
    }
    expect(operation(document, "/api/v1/goal-runs", "post")).toMatchObject({
      operationId: "createGoalRun",
      "x-contract-status": "typed"
    });
    expect(operation(document, "/api/v1/goal-runs/{id}/events", "get").responses["200"].content)
      .toHaveProperty("text/event-stream");
    expect(operation(document, "/api/v1/goal-runs/{id}/events", "get").parameters)
      .toContainEqual(expect.objectContaining({ name: "Last-Event-ID", in: "header", required: false }));
    expect(operation(document, "/api/v1/goal-runs/{id}/canvas", "get").parameters)
      .toContainEqual(expect.objectContaining({ name: "lens", in: "query", required: false }));
    const platformViewOperation = operation(document, "/api/v1/views/{view}", "get");
    expect(platformViewOperation).toMatchObject({
      operationId: "getPlatformView",
      "x-contract-status": "typed",
      parameters: [expect.objectContaining({
        name: "view",
        in: "path",
        required: true,
        schema: expect.objectContaining({ enum: ["discussions", "tasks", "agents", "settings"] })
      })]
    });
    expect(platformViewOperation.responses["304"]).toEqual({
      description: "The requested projection has not changed."
    });
    const meetingViewOperation = operation(document, "/api/v1/meetings/{id}/view", "get");
    expect(meetingViewOperation.responses["304"]).toEqual({
      description: "The requested Meeting view has not changed."
    });
    expect(operation(document, "/api/v1/agents/readiness:batch", "post")).toMatchObject({
      operationId: "getPublishedAgentReadinessBatch",
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/AgentReadinessBatchRequest" }
          }
        }
      },
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AgentReadinessBatchResponse" }
            }
          }
        }
      },
      "x-contract-status": "typed"
    });
    expect(document.paths).not.toHaveProperty("/api/v1/agents/readiness{batch}");
    const operationIds = Object.values(document.paths).flatMap((item: any) =>
      Object.values(item).map((entry: any) => entry.operationId)
    );
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(Object.values(document.paths).flatMap((item: any) => Object.values(item))
      .every((entry: any) => entry["x-authority"])).toBe(true);
    expect(references(document).filter((reference) => reference.startsWith("#/$defs/"))).toEqual([]);
    expect(references(document).filter((reference) => !resolvesReference(document, reference))).toEqual([]);
    expect(references(document.components.schemas.PlatformSnapshotResponse).some((reference) =>
      /^#\/components\/schemas\/PlatformSnapshotResponse\/\$defs\//.test(reference)
    )).toBe(true);
    await app.close();
  });

  it("requires Origin exactly on owner-session mutating operations", async () => {
    const app = await createApp({ store: new InMemoryPlatformStore(), authDisabled: true });
    const response = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    const document = response.json<Record<string, any>>();

    expect(response.statusCode).toBe(200);
    const documentedOperations = Object.entries(document.paths).flatMap(([path, pathItem]) => (
      Object.entries(pathItem as Record<string, Record<string, any>>).map(([method, apiOperation]) => ({
        path,
        method,
        apiOperation
      }))
    ));
    const expectedOperations = documentedOperations.filter(({ method, apiOperation }) => (
      mutatingOpenApiMethods.has(method) && apiOperation["x-authority"]?.caller === "owner_session"
    ));
    const expectedOperationKeys = new Set(
      expectedOperations.map(({ path, method }) => `${method.toUpperCase()} ${path}`)
    );

    expect(expectedOperations.length).toBeGreaterThan(0);
    for (const { path, method, apiOperation } of documentedOperations) {
      const message = `${method.toUpperCase()} ${path}`;
      if (expectedOperationKeys.has(message)) {
        expect(originParameters(apiOperation), message).toEqual([requiredOriginParameter]);
      } else {
        expect(originParameters(apiOperation), message).toEqual([]);
      }
    }
    await app.close();
  });

  it.each([
    ["typed", "/api/v1/meetings", "post", "createMeeting"],
    ["typed", "/api/v1/executions/harness", "post", "startHarnessExecution"]
  ])("documents Origin on the %s %s operation", async (contractStatus, path, method, operationId) => {
    const app = await createApp({ store: new InMemoryPlatformStore(), authDisabled: true });
    const response = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    const apiOperation = operation(response.json<Record<string, any>>(), path, method);

    expect(apiOperation).toMatchObject({
      operationId,
      "x-contract-status": contractStatus
    });
    expect(originParameters(apiOperation)).toEqual([requiredOriginParameter]);
    await app.close();
  });

  it("documents the required Harness retry key and bounded request/response contracts", async () => {
    const app = await createApp({ store: new InMemoryPlatformStore(), authDisabled: true });
    const response = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    const document = response.json<Record<string, any>>();
    const apiOperation = operation(document, "/api/v1/executions/harness", "post");

    expect(apiOperation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: expect.objectContaining({ minLength: 1, maxLength: 200 })
      })
    ]));
    expect(apiOperation.requestBody.content["application/json"].schema.$ref)
      .toBe("#/components/schemas/StartHarnessExecutionRequest");
    expect(apiOperation.responses["202"].content["application/json"].schema.$ref)
      .toBe("#/components/schemas/ExternalExecutionResponse");
    expect(document.components.schemas.StartHarnessExecutionRequest.properties.resourceId)
      .toMatchObject({ type: "string", minLength: 1, maxLength: 200 });
    expect(document.components.schemas.ExternalExecutionResponse.properties.status.enum)
      .toEqual(["queued", "running", "succeeded", "failed", "cancelled", "unknown"]);
    await app.close();
  });

  it("accepts representative live handler responses with the same Zod success contracts", async () => {
    const store = new InMemoryPlatformStore();
    const initial = await store.getSnapshot();
    const readyModel = await store.createModelConnector({
      name: "Contract-ready local model",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "contract-ready"
    });
    const readyPrompt = await store.createPrompt({
      name: "Contract-ready Agent Prompt",
      kind: "agent",
      description: "Published fixture required by Agent readiness.",
      owner: "Contract Test",
      content: "Review the typed contract.",
      variables: []
    });
    await store.publishPrompt(readyPrompt.id, { expectedCurrentVersion: 1, version: 1 });
    await store.updateAgent(initial.agents[0]!.id, {
      modelConnectorId: readyModel.id,
      promptBinding: { promptId: readyPrompt.id, version: 1 }
    });
    const readyDraft = (await store.getSnapshot()).agents.find((agent) => agent.id === initial.agents[0]!.id)!;
    await store.publishAgent(readyDraft.id, { expectedDraftRevision: readyDraft.draftRevision! });
    const app = await createApp({
      store,
      authDisabled: true,
      taskAdapterClientFactory: () => ({ health: async () => true })
    });
    const capabilities = createApiContractCapabilities();
    const call = async (
      method: "GET" | "POST" | "PATCH",
      routePath: string,
      url: string,
      payload?: Record<string, unknown>
    ): Promise<Record<string, any>> => {
      const capability = capabilities.find((item) => item.method === method && item.path === routePath);
      expect(capability, `${method} ${routePath} has no capability`).toBeDefined();
      const requiresIdempotencyKey = capability?.parameters?.some((parameter) => (
        parameter.name === "Idempotency-Key" && parameter.in === "header" && parameter.required
      ));
      const response = await app.inject({
        method,
        url,
        ...(requiresIdempotencyKey ? { headers: { "idempotency-key": crypto.randomUUID() } } : {}),
        ...(payload ? { payload } : {})
      });
      const contract = capability!.responses.find((item) => item.status === `${response.statusCode}`);
      expect(contract, `${method} ${routePath} has no ${response.statusCode} response`).toBeDefined();
      if (!contract || !("schema" in contract)) {
        throw new Error(`${method} ${routePath} has no content schema for ${response.statusCode}`);
      }
      expect(() => contract.schema.parse(response.json())).not.toThrow();
      return response.json<Record<string, any>>();
    };

    await call("GET", "/api/health/live", "/api/health/live");
    const snapshot = await call("GET", "/api/bootstrap", "/api/bootstrap");
    for (const view of ["discussions", "tasks", "agents", "settings"] as const) {
      await call("GET", "/api/views/:view", `/api/views/${view}`);
    }
    expect((await app.inject({ method: "GET", url: "/api/views/unknown" })).statusCode).toBe(400);
    await call(
      "GET",
      "/api/agents/:id/effective-configuration",
      `/api/agents/${snapshot.agents[0].id}/effective-configuration`
    );
    const group = await call("POST", "/api/groups", "/api/groups", { name: "Contract Group" });
    const category = await call("POST", "/api/categories", "/api/categories", {
      groupId: group.id,
      name: "Contract Category"
    });
    const tag = await call("POST", "/api/tags", "/api/tags", { name: "contract", color: "green" });
    await call("POST", "/api/threads", "/api/threads", {
      categoryId: category.id,
      title: "Contract Topic",
      summary: "Proves the route response still matches the Zod contract.",
      tagIds: [tag.id]
    });
    await call("POST", "/api/agents", "/api/agents", {
      name: "Contract Agent",
      goalSummary: "Validate typed API responses.",
      toolsSummary: "No tools.",
      dataSummary: "Test data only."
    });
    await call("POST", "/api/roles", "/api/roles", {
      name: "Contract Reviewer",
      responsibility: "Review API contracts."
    });
    await call("GET", "/api/tool-packs", "/api/tool-packs");
    const imageDigest = `sha256:${"a".repeat(64)}`;
    const toolPack = await call("POST", "/api/tool-packs", "/api/tool-packs", {
      name: "Contract documentation tools",
      version: "1.0.0",
      description: "Read-only contract fixtures.",
      owner: "Contract Test",
      sourceReference: `registry.example.com/council/contracts@${imageDigest}`,
      imageDigest,
      tools: [{
        name: "search",
        kind: "command",
        goal: "Search an immutable contract fixture.",
        access: "read_only",
        argv: { executable: "/usr/bin/rg", fixedArguments: ["--json"] },
        env: { allowedNames: ["LANG"] },
        stdin: { mode: "none" }
      }]
    });
    const updatedToolPack = await call(
      "PATCH",
      "/api/tool-packs/:id",
      `/api/tool-packs/${toolPack.id}`,
      { expectedRevision: toolPack.revision, description: "Updated read-only contract fixtures." }
    );
    await call("GET", "/api/tool-packs/:id/revisions", `/api/tool-packs/${toolPack.id}/revisions`);
    const validatedToolPack = await call(
      "POST",
      "/api/tool-packs/:id/validate",
      `/api/tool-packs/${toolPack.id}/validate`,
      {
        expectedRevision: updatedToolPack.revision,
        manifestDigest: updatedToolPack.manifestDigest,
        result: "passed",
        summary: "Contract fixture remains read-only."
      }
    );
    const approvedToolPack = await call(
      "POST",
      "/api/tool-packs/:id/approve",
      `/api/tool-packs/${toolPack.id}/approve`,
      { expectedRevision: validatedToolPack.revision, manifestDigest: validatedToolPack.manifestDigest }
    );
    await call(
      "POST",
      "/api/tool-packs/:id/revoke",
      `/api/tool-packs/${toolPack.id}/revoke`,
      { expectedRevision: approvedToolPack.revision, reason: "Contract lifecycle completed." }
    );

    await call("GET", "/api/runtime-profiles", "/api/runtime-profiles");
    const runtimeProfile = await call("POST", "/api/runtime-profiles", "/api/runtime-profiles", {
      name: "Contract text runtime",
      harnessKind: "openai_compatible",
      modelConnectorId: null,
      sandboxProfileId: null,
      policy: "text_only",
      capabilities: ["text", "abort"],
      timeoutMs: 60_000,
      maxConcurrency: 1,
      enabled: true
    });
    await call(
      "PATCH",
      "/api/runtime-profiles/:id",
      `/api/runtime-profiles/${runtimeProfile.id}`,
      { expectedRevision: runtimeProfile.revision, maxConcurrency: 2 }
    );
    await call(
      "GET",
      "/api/runtime-profiles/:id/revisions",
      `/api/runtime-profiles/${runtimeProfile.id}/revisions`
    );

    const team = await call("POST", "/api/agent-teams", "/api/agent-teams", {
      name: "Contract review team",
      description: "One ready Agent for contract validation.",
      members: [{ agentId: snapshot.agents[0].id, roleId: snapshot.roles[0].id, isChair: true }]
    });
    await call(
      "PATCH",
      "/api/agent-teams/:id",
      `/api/agent-teams/${team.id}`,
      { expectedRevision: team.revision, description: "Updated contract validation team." }
    );
    const skill = await call("POST", "/api/skills", "/api/skills", {
      name: "Contract Skill",
      version: "9.9.9",
      instructions: "Validate typed Skill lifecycle responses.",
      source: "contract-test",
      owner: "Contract Test"
    });
    const validatedSkill = await call("POST", "/api/skills/:id/validation", `/api/skills/${skill.id}/validation`, {
      result: "passed",
      summary: "Contract response reviewed.",
      expectedCheckedAt: skill.validation.checkedAt
    });
    await call("PATCH", "/api/skills/:id/status", `/api/skills/${skill.id}/status`, {
      status: "approved",
      expectedCheckedAt: validatedSkill.validation.checkedAt
    });
    await call("POST", "/api/skills/:id/revoke", `/api/skills/${skill.id}/revoke`, {
      reason: "Contract lifecycle completed."
    });
    const preset = await call("POST", "/api/meeting-presets", "/api/meeting-presets", {
      name: "Contract Preset",
      description: "Validate Meeting Preset preflight responses.",
      teamId: null,
      mode: "chaired",
      automation: "suggest",
      durationMinutes: 30,
      agendaItems: [{ title: "Review contracts", description: "Confirm response boundaries." }]
    });
    await call(
      "PATCH",
      "/api/meeting-presets/:id",
      `/api/meeting-presets/${preset.id}`,
      { expectedRevision: preset.revision, teamId: team.id, durationMinutes: 35 }
    );
    await call(
      "GET",
      "/api/meeting-presets/:id/preflight",
      `/api/meeting-presets/${preset.id}/preflight`
    );
    await call("POST", "/api/model-connectors", "/api/model-connectors", {
      name: "Contract Model",
      location: "cloud",
      baseUrl: "https://1.1.1.1/v1",
      model: "contract-model"
    });
    const mcp = await call("POST", "/api/mcp-connectors", "/api/mcp-connectors", {
      name: "Contract MCP",
      location: "cloud",
      baseUrl: "https://1.0.0.1/mcp",
      approvedTools: ["search"],
      toolRegistrations: [{
        toolName: "search",
        displayName: "Contract Search",
        kind: "mcp_tool",
        version: "1.0.0",
        owner: "Contract Test",
        goal: "Search bounded contract evidence."
      }]
    });
    const agentWithToolGrant = await call("PATCH", "/api/agents/:id", `/api/agents/${snapshot.agents[0].id}`, {
      expectedDraftRevision: snapshot.agents[0].draftRevision,
      toolGrants: [{ connectorId: mcp.id, toolName: "search" }]
    });
    await store.publishAgent(agentWithToolGrant.id, { expectedDraftRevision: agentWithToolGrant.draftRevision });
    await call("POST", "/api/tools/authorize", "/api/tools/authorize", {
      connectorId: mcp.id,
      toolName: "search",
      effect: "read",
      agentId: snapshot.agents[0].id
    });
    const taskAdapter = await call("POST", "/api/task-adapter-connectors", "/api/task-adapter-connectors", {
      name: "Contract Task Adapter",
      location: "cloud",
      baseUrl: "https://1.1.1.1"
    });
    await call(
      "POST",
      "/api/task-adapter-connectors/:id/health",
      `/api/task-adapter-connectors/${taskAdapter.id}/health`
    );
    await call("POST", "/api/credentials", "/api/credentials", {
      name: "Contract Credential",
      provider: "test",
      kind: "api_key",
      location: "cloud"
    });
    await call("POST", "/api/prompts", "/api/prompts", {
      name: "Contract Prompt",
      kind: "agent",
      description: "Contract test Prompt.",
      owner: "Contract Test",
      content: "Discuss {{MEETING_GOAL}}.",
      variables: ["MEETING_GOAL"]
    });
    const decision = await call("POST", "/api/decisions", "/api/decisions", {
      meetingId: snapshot.meetings[0].id,
      title: "Keep API contracts typed",
      description: "Use Zod as the source for generated schemas."
    });
    await call("POST", "/api/decisions/:id/approve", `/api/decisions/${decision.id}/approve`);
    await call("POST", "/api/tasks", "/api/tasks", {
      decisionId: decision.id,
      title: "Verify generated OpenAPI"
    });

    await app.close();
  });

  it("marks response components and never publishes secret-bearing response properties", async () => {
    const app = await createApp({ store: new InMemoryPlatformStore(), authDisabled: true });
    const response = await app.inject({ method: "GET", url: "/api/openapi.json" });
    const document = response.json<Record<string, any>>();
    const responseComponents = Object.fromEntries(
      Object.entries(document.components.schemas).filter(([, schema]) => (schema as Record<string, unknown>)["x-schema-direction"] === "response")
    );
    const serialized = JSON.stringify(responseComponents).toLocaleLowerCase();

    expect(serialized).not.toContain('"apikey"');
    expect(serialized).not.toContain('"bearertoken"');
    expect(serialized).not.toContain('"encryptedsecret"');
    expect(serialized).not.toContain('"ciphertext"');
    expect(serialized).not.toContain('"password"');
    expect(document.components.schemas.CreateCredentialRequest.properties).toHaveProperty("secret");
    expect(document.components.schemas.CredentialResponse.properties).not.toHaveProperty("secret");
    await app.close();
  });

  it("fails document generation when a typed contract no longer has a registered route", () => {
    const inventory = new ApiRouteInventory();
    inventory.record("GET", "/api/health/live");

    expect(() => createOpenApiDocument("test", inventory.list())).toThrow(/contracted route.*not registered/i);
  });

  it("rejects API methods that cannot be represented by the AuthorityMap", () => {
    const inventory = new ApiRouteInventory();

    expect(() => inventory.record("HEAD", "/api/health/live")).toThrow(/unsupported API method HEAD/i);
    expect(() => inventory.record("HEAD", "/not-api/health/live")).not.toThrow();
  });
});
