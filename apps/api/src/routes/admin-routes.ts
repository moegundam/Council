import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  authorizeToolSchema,
  createAgentSchema,
  createMcpConnectorSchema,
  createModelConnectorSchema,
  createRoleSchema,
  createSkillSchema,
  createTaskAdapterConnectorSchema,
  deleteRoleSchema,
  externalExecutionRequestSchema,
  externalExecutionSchema,
  revokeSkillSchema,
  rollbackRoleSchema,
  setAgentModelRequestSchema,
  setSkillStatusSchema,
  validateSkillSchema,
  updateAgentRequestSchema,
  updateMcpConnectorSchema,
  updateModelConnectorSchema,
  updateRoleRequestSchema
} from "@council/contracts";
import { assertConnectorUrlAllowed, credentialIsExpired, ExternalExecutionPolicyError, ToolPolicy } from "@council/domain";
import { StoreConflictError } from "@council/database";
import {
  agentResponseSchema,
  mcpConnectorUpdateResponseSchema,
  mcpConnectorResponseSchema,
  mcpDiscoveryResponseSchema,
  modelConnectorUpdateResponseSchema,
  modelConnectorResponseSchema,
  roleDeletionResponseSchema,
  roleLifecycleResponseSchema,
  roleResponseSchema,
  skillResponseSchema,
  skillRevocationResponseSchema,
  taskAdapterConnectorResponseSchema
} from "@council/contracts/api-contracts";
import { McpReadOnlyClient, OpenAICompatibleConnector, TaskAdapterClient } from "@council/runtime";
import { idempotencyKey, parse, parseResponse, sendError, type AppOptionsFor } from "../route-support.js";

type AdminStoreMethods =
  | "createAgent"
  | "createMcpConnector"
  | "createModelConnector"
  | "createRole"
  | "createSkill"
  | "createTaskAdapterConnector"
  | "deleteRole"
  | "getAgentRevision"
  | "getConnectorSecret"
  | "getRoleLifecycle"
  | "getSnapshot"
  | "replayModelConnectorCreate"
  | "replayMcpConnectorCreate"
  | "replayTaskAdapterConnectorCreate"
  | "admitExternalExecutionStart"
  | "settleExternalExecutionStart"
  | "revokeSkill"
  | "rollbackRole"
  | "setAgentModel"
  | "setSkillStatus"
  | "updateAgent"
  | "updateMcpConnector"
  | "updateModelConnector"
  | "updateRole"
  | "validateSkill";
export type AdminRouteOptions = AppOptionsFor<AdminStoreMethods>;

interface SecretBoundConnector {
  id: string;
  enabled: boolean;
  location: "cloud" | "local";
  baseUrl: string;
  hasSecret: boolean;
  secretRevision?: number;
  credentialId?: string | null;
}

interface McpDiscoveryConnector extends SecretBoundConnector {
  name: string;
  approvedTools: readonly string[];
  toolRegistrations: ReadonlyArray<{
    toolName: string;
    displayName: string;
    kind: string;
    version: string;
    owner: string;
    goal: string;
  }>;
}

interface CredentialBinding {
  id: string;
  status: string;
  hasSecret: boolean;
  secretRevision: number;
  expiresAt: string | null;
}

function sameSecretBinding(left: SecretBoundConnector, right: SecretBoundConnector): boolean {
  return left.id === right.id
    && left.enabled === right.enabled
    && left.location === right.location
    && left.baseUrl === right.baseUrl
    && left.hasSecret === right.hasSecret
    && left.secretRevision === right.secretRevision
    && (left.credentialId ?? null) === (right.credentialId ?? null);
}

function sameCredentialBinding(left: CredentialBinding, right: CredentialBinding | undefined): boolean {
  return right !== undefined
    && left.id === right.id
    && left.status === right.status
    && left.hasSecret === right.hasSecret
    && left.secretRevision === right.secretRevision
    && left.expiresAt === right.expiresAt;
}

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameMcpDiscoveryConfiguration(left: McpDiscoveryConnector, right: McpDiscoveryConnector): boolean {
  return sameSecretBinding(left, right)
    && left.name === right.name
    && sameOrderedValues(left.approvedTools, right.approvedTools)
    && left.toolRegistrations.length === right.toolRegistrations.length
    && left.toolRegistrations.every((registration, index) => {
      const candidate = right.toolRegistrations[index];
      return candidate !== undefined
        && registration.toolName === candidate.toolName
        && registration.displayName === candidate.displayName
        && registration.kind === candidate.kind
        && registration.version === candidate.version
        && registration.owner === candidate.owner
        && registration.goal === candidate.goal;
    });
}

export function registerAdminRoutes(app: FastifyInstance, options: AdminRouteOptions): void {
  app.post("/api/agents", async (request, reply) => {
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const agent = await options.store.createAgent(parse(createAgentSchema, request.body), requestKey);
    return reply.code(201).send(parseResponse(agentResponseSchema, agent));
  });
  app.patch("/api/agents/:id", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const { expectedDraftRevision, ...input } = parse(updateAgentRequestSchema, request.body);
    const agent = await options.store.updateAgent(id, input, expectedDraftRevision);
    return reply.send(parseResponse(agentResponseSchema, agent));
  });
  app.patch("/api/agents/:id/model", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const { expectedDraftRevision, ...input } = parse(setAgentModelRequestSchema, request.body);
    const agent = await options.store.setAgentModel(id, input, expectedDraftRevision);
    return reply.send(parseResponse(agentResponseSchema, agent));
  });
  app.post("/api/roles", async (request, reply) => {
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const role = await options.store.createRole(parse(createRoleSchema, request.body), requestKey);
    return reply.code(201).send(parseResponse(roleResponseSchema, role));
  });
  app.get("/api/roles/:id/lifecycle", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    return reply.send(parseResponse(roleLifecycleResponseSchema, await options.store.getRoleLifecycle(id)));
  });
  app.patch("/api/roles/:id", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const { expectedCurrentVersion, ...input } = parse(updateRoleRequestSchema, request.body);
    const role = await options.store.updateRole(id, input, expectedCurrentVersion);
    return reply.send(parseResponse(roleResponseSchema, role));
  });
  app.post("/api/roles/:id/rollback", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const input = parse(rollbackRoleSchema, request.body);
    return reply.send(parseResponse(
      roleResponseSchema,
      await options.store.rollbackRole(id, input.version, input.expectedCurrentVersion)
    ));
  });
  app.delete("/api/roles/:id", async (request, reply) => {
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const input = parse(deleteRoleSchema, request.body);
    return reply.send(parseResponse(
      roleDeletionResponseSchema,
      await options.store.deleteRole(id, input.expectedCurrentVersion, requestKey)
    ));
  });
  app.post("/api/skills", async (request, reply) => {
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const skill = await options.store.createSkill(parse(createSkillSchema, request.body), requestKey);
    return reply.code(201).send(parseResponse(skillResponseSchema, skill));
  });
  app.patch("/api/skills/:id/status", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const input = parse(setSkillStatusSchema, request.body);
    const skill = await options.store.setSkillStatus(id, input);
    return reply.send(parseResponse(skillResponseSchema, skill));
  });
  app.post("/api/skills/:id/validation", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const skill = await options.store.validateSkill(id, parse(validateSkillSchema, request.body));
    return reply.send(parseResponse(skillResponseSchema, skill));
  });
  app.post("/api/skills/:id/revoke", async (request, reply) => {
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const result = await options.store.revokeSkill(id, parse(revokeSkillSchema, request.body), requestKey);
    return reply.send(parseResponse(skillRevocationResponseSchema, result));
  });
  app.post("/api/model-connectors", async (request, reply) => {
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const input = parse(createModelConnectorSchema, request.body);
    const { apiKey, ...safeInput } = input;
    const ciphertext = apiKey && options.secretVault ? options.secretVault.encrypt(apiKey) : undefined;
    if (apiKey && !ciphertext) return sendError(reply, 503, "SECRET_VAULT_UNAVAILABLE", "Secret storage is not configured.");
    const secret = ciphertext && apiKey && options.secretVault
      ? {
          ciphertext,
          idempotencyProof: options.secretVault.fingerprint(
            "model-connector-create-idempotency-v1",
            JSON.stringify([requestKey, apiKey])
          )
        }
      : undefined;
    const replay = await options.store.replayModelConnectorCreate(safeInput, secret, requestKey);
    if (replay) return reply.code(201).send(parseResponse(modelConnectorResponseSchema, replay));
    try {
      await assertConnectorUrlAllowed(input.baseUrl, input.location === "local");
    } catch {
      return sendError(reply, 400, "CONNECTOR_URL_REJECTED", "Connector URL is not allowed for the selected location.");
    }
    const connector = await options.store.createModelConnector(safeInput, secret, requestKey);
    return reply.code(201).send(parseResponse(modelConnectorResponseSchema, connector));
  });

  app.patch("/api/model-connectors/:id", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const input = parse(updateModelConnectorSchema, request.body);
    const current = (await options.store.getSnapshot()).modelConnectors.find((item) => item.id === id);
    if (!current) return sendError(reply, 404, "NOT_FOUND", "Model connector not found.");
    let validatedEndpoint: Pick<typeof current, "location" | "baseUrl"> | undefined;
    if (input.baseUrl !== undefined || input.location !== undefined) {
      const location = input.location ?? current.location;
      const baseUrl = input.baseUrl ?? current.baseUrl;
      try {
        await assertConnectorUrlAllowed(baseUrl, location === "local");
      } catch {
        return sendError(reply, 400, "CONNECTOR_URL_REJECTED", "Connector URL is not allowed for the selected location.");
      }
      validatedEndpoint = { location, baseUrl };
    }
    const safeInput = validatedEndpoint ? { ...input, ...validatedEndpoint } : input;
    const result = await options.store.updateModelConnector(id, safeInput);
    return reply.send(parseResponse(modelConnectorUpdateResponseSchema, {
      ...result.connector,
      assignedAgentCount: result.assignedAgentCount
    }));
  });

  app.post("/api/model-connectors/:id/health", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const snapshot = await options.store.getSnapshot();
    const connector = snapshot.modelConnectors.find((item) => item.id === id);
    if (!connector) return sendError(reply, 404, "NOT_FOUND", "Model connector not found.");
    if (!connector.enabled) return sendError(reply, 409, "CONNECTOR_DISABLED", "Model connector is disabled.");
    const credential = connector.credentialId
      ? snapshot.credentials?.find((item) => item.id === connector.credentialId)
      : undefined;
    if (credential?.status === "revoked") {
      return sendError(reply, 409, "CREDENTIAL_REVOKED", "Model connector Credential is revoked.");
    }
    if (credential && credentialIsExpired(credential.expiresAt)) {
      return sendError(reply, 409, "CREDENTIAL_EXPIRED", "Model connector Credential is expired.");
    }
    if (connector.credentialId && (
      !credential
      || credential.status !== "active"
      || !credential.hasSecret
      || !connector.hasSecret
      || credential.secretRevision !== connector.secretRevision
    )) {
      return sendError(reply, 409, "CREDENTIAL_NOT_READY", "Model connector Credential is not active or its secret binding is unavailable.");
    }
    const ciphertext = connector.hasSecret ? await options.store.getConnectorSecret(id) : null;
    const executionSnapshot = await options.store.getSnapshot();
    const executionConnector = executionSnapshot.modelConnectors.find((item) => item.id === id);
    const executionCredential = connector.credentialId
      ? executionSnapshot.credentials?.find((item) => item.id === connector.credentialId)
      : undefined;
    if (executionCredential?.status === "revoked") {
      return sendError(reply, 409, "CREDENTIAL_REVOKED", "Model connector Credential is revoked.");
    }
    if (executionCredential && credentialIsExpired(executionCredential.expiresAt)) {
      return sendError(reply, 409, "CREDENTIAL_EXPIRED", "Model connector Credential is expired.");
    }
    if (!executionConnector
      || !sameSecretBinding(connector, executionConnector)
      || (credential && !sameCredentialBinding(credential, executionCredential))) {
      return sendError(reply, 409, "CONNECTOR_CHANGED", "Model connector changed while the health check was starting. Retry the request.");
    }
    if (connector.hasSecret && (!ciphertext || !options.secretVault)) {
      return sendError(reply, 503, "CONNECTOR_SECRET_UNAVAILABLE", "Model connector secret cannot be loaded.");
    }
    const apiKey = ciphertext && options.secretVault ? options.secretVault.decrypt(ciphertext) : undefined;
    const healthy = await new OpenAICompatibleConnector().health(connector.baseUrl, apiKey, connector.location === "local");
    const completedSnapshot = await options.store.getSnapshot();
    const completedConnector = completedSnapshot.modelConnectors.find((item) => item.id === id);
    const completedCredential = connector.credentialId
      ? completedSnapshot.credentials?.find((item) => item.id === connector.credentialId)
      : undefined;
    if (completedCredential?.status === "revoked") {
      return sendError(reply, 409, "CREDENTIAL_REVOKED", "Model connector Credential is revoked.");
    }
    if (completedCredential && credentialIsExpired(completedCredential.expiresAt)) {
      return sendError(reply, 409, "CREDENTIAL_EXPIRED", "Model connector Credential is expired.");
    }
    if (!completedConnector
      || !sameSecretBinding(connector, completedConnector)
      || (credential && !sameCredentialBinding(credential, completedCredential))) {
      return sendError(reply, 409, "CONNECTOR_CHANGED", "Model connector changed during the health check. Retry the request.");
    }
    return reply.send({ healthy });
  });

  app.post("/api/mcp-connectors", async (request, reply) => {
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const input = parse(createMcpConnectorSchema, request.body);
    const { bearerToken, ...safeInput } = input;
    const ciphertext = bearerToken && options.secretVault ? options.secretVault.encrypt(bearerToken) : undefined;
    if (bearerToken && !ciphertext) return sendError(reply, 503, "SECRET_VAULT_UNAVAILABLE", "Secret storage is not configured.");
    const secret = ciphertext && bearerToken && options.secretVault
      ? {
          ciphertext,
          idempotencyProof: options.secretVault.fingerprint(
            "mcp-connector-create-idempotency-v1",
            JSON.stringify([requestKey, bearerToken])
          )
        }
      : undefined;
    const replay = await options.store.replayMcpConnectorCreate(safeInput, secret, requestKey);
    if (replay) return reply.code(201).send(parseResponse(mcpConnectorResponseSchema, replay));
    try {
      await assertConnectorUrlAllowed(
        input.baseUrl,
        input.location === "local",
        undefined,
        input.location === "local" ? options.mcpLocalHostAllowlist ?? [] : undefined
      );
    } catch {
      return sendError(reply, 400, "CONNECTOR_URL_REJECTED", "MCP connector URL is not allowed for the selected location.");
    }
    const connector = await options.store.createMcpConnector(safeInput, secret, requestKey);
    return reply.code(201).send(parseResponse(mcpConnectorResponseSchema, connector));
  });

  app.patch("/api/mcp-connectors/:id", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const input = parse(updateMcpConnectorSchema, request.body);
    const current = (await options.store.getSnapshot()).mcpConnectors.find((item) => item.id === id);
    if (!current) return sendError(reply, 404, "NOT_FOUND", "MCP connector not found.");
    let validatedEndpoint: Pick<typeof current, "location" | "baseUrl"> | undefined;
    if (input.baseUrl !== undefined || input.location !== undefined) {
      const location = input.location ?? current.location;
      const baseUrl = input.baseUrl ?? current.baseUrl;
      try {
        await assertConnectorUrlAllowed(
          baseUrl,
          location === "local",
          undefined,
          location === "local" ? options.mcpLocalHostAllowlist ?? [] : undefined
        );
      } catch {
        return sendError(reply, 400, "CONNECTOR_URL_REJECTED", "MCP connector URL is not allowed for the selected location.");
      }
      validatedEndpoint = { location, baseUrl };
    }
    const { bearerToken, ...requestedInput } = input;
    const safeInput = validatedEndpoint ? { ...requestedInput, ...validatedEndpoint } : requestedInput;
    const ciphertext = bearerToken && options.secretVault ? options.secretVault.encrypt(bearerToken) : undefined;
    if (bearerToken && !ciphertext) return sendError(reply, 503, "SECRET_VAULT_UNAVAILABLE", "Secret storage is not configured.");
    const result = await options.store.updateMcpConnector(id, safeInput, ciphertext ? { ciphertext } : undefined);
    return reply.send(parseResponse(mcpConnectorUpdateResponseSchema, result));
  });

  app.post("/api/mcp-connectors/:id/discover", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const connector = (await options.store.getSnapshot()).mcpConnectors.find((item) => item.id === id);
    if (!connector) return sendError(reply, 404, "NOT_FOUND", "MCP connector not found.");
    if (!connector.enabled) return sendError(reply, 409, "CONNECTOR_DISABLED", "MCP connector is disabled.");
    const ciphertext = await options.store.getConnectorSecret(id);
    const executionConnector = (await options.store.getSnapshot()).mcpConnectors.find((item) => item.id === id);
    if (!executionConnector || !sameMcpDiscoveryConfiguration(connector, executionConnector)) {
      return sendError(reply, 409, "CONNECTOR_CHANGED", "MCP connector changed while discovery was starting. Retry the request.");
    }
    if (connector.hasSecret && (!ciphertext || !options.secretVault)) {
      return sendError(reply, 503, "CONNECTOR_SECRET_UNAVAILABLE", "MCP connector secret cannot be loaded.");
    }
    const bearerToken = ciphertext && options.secretVault ? options.secretVault.decrypt(ciphertext) : undefined;
    const tools = await new McpReadOnlyClient({
      connectorId: connector.id,
      baseUrl: connector.baseUrl,
      approvedTools: connector.approvedTools,
      trustedReadOnlyTools: connector.toolRegistrations.map((registration) => registration.toolName),
      ...(bearerToken ? { bearerToken } : {}),
      allowPrivate: connector.location === "local",
      ...(connector.location === "local"
        ? { allowedHosts: options.mcpLocalHostAllowlist ?? [] }
        : {})
    }).discover();
    const completedConnector = (await options.store.getSnapshot()).mcpConnectors.find((item) => item.id === id);
    if (!completedConnector || !sameMcpDiscoveryConfiguration(connector, completedConnector)) {
      return sendError(reply, 409, "CONNECTOR_CHANGED", "MCP connector changed during discovery. Retry the request.");
    }
    return reply.send(parseResponse(mcpDiscoveryResponseSchema, {
      connector: completedConnector,
      tools,
      approvedTools: completedConnector.approvedTools
    }));
  });

  app.post("/api/task-adapter-connectors", async (request, reply) => {
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const input = parse(createTaskAdapterConnectorSchema, request.body);
    const { bearerToken, ...safeInput } = input;
    const ciphertext = bearerToken && options.secretVault ? options.secretVault.encrypt(bearerToken) : undefined;
    if (bearerToken && !ciphertext) return sendError(reply, 503, "SECRET_VAULT_UNAVAILABLE", "Secret storage is not configured.");
    const secret = ciphertext && bearerToken && options.secretVault
      ? {
          ciphertext,
          idempotencyProof: options.secretVault.fingerprint(
            "task-adapter-create-idempotency-v1",
            JSON.stringify([requestKey, bearerToken])
          )
        }
      : undefined;
    const replay = await options.store.replayTaskAdapterConnectorCreate(safeInput, secret, requestKey);
    if (replay) return reply.code(201).send(parseResponse(taskAdapterConnectorResponseSchema, replay));
    try {
      await assertConnectorUrlAllowed(input.baseUrl, input.location === "local");
    } catch {
      return sendError(reply, 400, "CONNECTOR_URL_REJECTED", "Task Adapter URL is not allowed for the selected location.");
    }
    const connector = await options.store.createTaskAdapterConnector(safeInput, secret, requestKey);
    return reply.code(201).send(parseResponse(taskAdapterConnectorResponseSchema, connector));
  });

  app.post("/api/task-adapter-connectors/:id/health", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const connector = (await options.store.getSnapshot()).taskAdapterConnectors.find((item) => item.id === id);
    if (!connector) return sendError(reply, 404, "NOT_FOUND", "Task Adapter connector not found.");
    const ciphertext = await options.store.getConnectorSecret(id);
    if (connector.hasSecret && (!ciphertext || !options.secretVault)) {
      return sendError(reply, 503, "CONNECTOR_SECRET_UNAVAILABLE", "Task Adapter secret cannot be loaded.");
    }
    const bearerToken = ciphertext && options.secretVault ? options.secretVault.decrypt(ciphertext) : undefined;
    const config = {
      baseUrl: connector.baseUrl,
      ...(bearerToken ? { bearerToken } : {}),
      allowPrivate: connector.location === "local"
    };
    const client = options.taskAdapterClientFactory?.(config) ?? new TaskAdapterClient(config);
    return reply.send({ healthy: await client.health() });
  });

  app.post("/api/tools/authorize", async (request, reply) => {
    const input = parse(authorizeToolSchema, request.body);
    if (input.effect !== "read") return sendError(reply, 403, "TOOL_DENIED", "Phase 1 only permits read-only tools.");
    const snapshot = await options.store.getSnapshot();
    const connector = snapshot.mcpConnectors.find((item) =>
      item.enabled
      && (item.id === input.connectorId || item.name.toLocaleLowerCase() === input.connectorId.toLocaleLowerCase())
    );
    const agent = input.agentId ? snapshot.agents.find((item) => item.id === input.agentId) : undefined;
    const publishedAgentRevision = agent
      && agent.lifecycleStatus !== "disabled"
      && agent.publishedRevision !== null
      && agent.publishedRevision !== undefined
      ? await options.store.getAgentRevision(agent.id, agent.publishedRevision)
      : undefined;
    const agentTools = new Set(
      publishedAgentRevision?.toolGrants
        .filter((grant) => grant.connectorId === connector?.id)
        .map((grant) => grant.toolName) ?? []
    );
    const grants = connector?.approvedTools
      .filter((toolName) => connector.toolRegistrations.some((registration) => registration.toolName === toolName))
      .filter((toolName) => agentTools.has(toolName))
      .map((toolName) => ({ connectorId: connector.id, toolName, effect: "read" as const })) ?? [];
    const result = new ToolPolicy(grants).authorize(connector?.id ?? input.connectorId, input.toolName);
    if (!result.allowed) return sendError(reply, 403, "TOOL_DENIED", result.reason ?? "Tool denied.");
    return reply.send(result);
  });

  app.post("/api/executions/harness", async (request, reply) => {
    if (options.harnessEnabled !== true || !options.externalExecutor) {
      return sendError(reply, 503, "EXECUTOR_UNAVAILABLE", "Harness is disabled.");
    }
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const input = parse(externalExecutionRequestSchema, request.body);
    try {
      await options.externalExecutor.validate(input);
    } catch (error) {
      if (error instanceof ExternalExecutionPolicyError) {
        return sendError(reply, 400, "EXTERNAL_EXECUTION_REJECTED", "Execution request was rejected before admission.");
      }
      request.log.error({ err: error, resourceId: input.resourceId }, "External execution validation could not be completed.");
      return sendError(reply, 503, "EXTERNAL_EXECUTION_VALIDATION_UNAVAILABLE", "Execution validation is temporarily unavailable.");
    }
    let admission: Awaited<ReturnType<typeof options.store.admitExternalExecutionStart>>;
    try {
      admission = await options.store.admitExternalExecutionStart(input, requestKey);
    } catch (error) {
      if (error instanceof StoreConflictError) throw error;
      request.log.error({ err: error, resourceId: input.resourceId }, "External execution admission could not be recorded.");
      return sendError(reply, 503, "EXTERNAL_EXECUTION_ADMISSION_UNAVAILABLE", "Execution admission could not be confirmed.");
    }
    if (admission.status === "pending") {
      return sendError(reply, 409, "EXTERNAL_EXECUTION_RECONCILIATION_REQUIRED", "Execution acceptance requires reconciliation before retry.");
    }
    if (admission.status === "settled") {
      return reply.code(202).send(parseResponse(externalExecutionSchema, admission.execution));
    }

    let execution: Awaited<ReturnType<typeof options.externalExecutor.start>>;
    try {
      execution = parse(externalExecutionSchema, await options.externalExecutor.start(input));
    } catch (error) {
      request.log.error({ err: error, resourceId: input.resourceId }, "External execution acceptance is unknown after start failure.");
      return sendError(reply, 503, "EXTERNAL_EXECUTION_ACCEPTANCE_UNKNOWN", "Execution acceptance is unknown and requires reconciliation.");
    }
    try {
      const settled = await options.store.settleExternalExecutionStart(input, requestKey, execution);
      return reply.code(202).send(parseResponse(externalExecutionSchema, settled));
    } catch (error) {
      request.log.error({ err: error, resourceId: input.resourceId }, "External execution acceptance could not be durably confirmed.");
      return sendError(reply, 503, "EXTERNAL_EXECUTION_ACCEPTANCE_UNKNOWN", "Execution acceptance is unknown and requires reconciliation.");
    }
  });
}
