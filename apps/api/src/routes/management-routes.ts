import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  agentReadinessBatchRequestSchema,
  agentReadinessBatchResponseSchema,
  agentTeamSchema,
  approveToolPackSchema,
  archivePromptSchema,
  createAgentTeamSchema,
  createCredentialSchema,
  createMeetingPresetSchema,
  createPromptSchema,
  createRuntimeProfileSchema,
  createToolPackSchema,
  credentialListResponseSchema,
  credentialSchema,
  effectiveAgentConfigurationSchema,
  meetingPresetSchema,
  publishAgentSchema,
  publishPromptSchema,
  promptPreviewRequestSchema,
  rollbackAgentSchema,
  rollbackPromptSchema,
  rotateCredentialSchema,
  revokeToolPackSchema,
  runtimeProfileSchema,
  setAgentStatusSchema,
  updateAgentTeamSchema,
  updateCredentialSchema,
  updateCredentialStatusSchema,
  updateMeetingPresetSchema,
  updatePromptSchema,
  updateRuntimeProfileSchema,
  updateToolPackSchema,
  validateToolPackSchema,
  toolPackSchema
} from "@council/contracts";
import {
  agentReadinessResponseSchema,
  agentRevisionListResponseSchema,
  agentResponseSchema,
  meetingPresetPreflightSchema,
  promptListResponseSchema,
  promptPreviewResponseSchema,
  promptTemplateResponseSchema,
  promptVersionListResponseSchema,
  runtimeProfileListResponseSchema,
  runtimeProfileRevisionListResponseSchema,
  toolPackListResponseSchema,
  toolPackRevisionListResponseSchema
} from "@council/contracts/api-contracts";
import { buildAgentCapabilitySummary } from "../agent-capability-summary.js";
import { idempotencyKey, parse, parseResponse, sendError, type AppOptionsFor } from "../route-support.js";
import { getPublishedAgentRuntime } from "../published-agent-readiness.js";

const idSchema = z.object({ id: z.string().uuid() });

type ManagementStoreMethods =
  | "approveToolPack"
  | "archivePrompt"
  | "createAgentTeam"
  | "createCredential"
  | "createMeetingPreset"
  | "createPrompt"
  | "createRuntimeProfile"
  | "createToolPack"
  | "getAgentReadiness"
  | "getAgentRevision"
  | "getAgentRevisions"
  | "getCredentials"
  | "getPromptVersion"
  | "getPromptVersions"
  | "getPrompts"
  | "getRuntimeProfiles"
  | "getRuntimeProfileRevisions"
  | "getSnapshot"
  | "getToolPackRevisions"
  | "getToolPacks"
  | "publishAgent"
  | "publishPrompt"
  | "replayCredentialRotation"
  | "revokeToolPack"
  | "rollbackAgent"
  | "rollbackPrompt"
  | "rotateCredential"
  | "setAgentStatus"
  | "setCredentialStatus"
  | "updateAgentTeam"
  | "updateCredential"
  | "updateMeetingPreset"
  | "updatePrompt"
  | "updateRuntimeProfile"
  | "updateToolPack"
  | "validateToolPack";
export type ManagementRouteOptions = AppOptionsFor<ManagementStoreMethods>;

function encryptedSecret(
  secret: string | undefined,
  options: ManagementRouteOptions,
  idempotencyKey?: string
): { ciphertext: string; idempotencyProof?: string } | undefined {
  if (!secret) return undefined;
  if (!options.secretVault) {
    const error = new Error("Secret storage is not configured.") as Error & { statusCode: number };
    error.statusCode = 503;
    throw error;
  }
  return {
    ciphertext: options.secretVault.encrypt(secret),
    ...(idempotencyKey
      ? {
          idempotencyProof: options.secretVault.fingerprint(
            "credential-create-idempotency-v1",
            JSON.stringify([idempotencyKey, secret])
          )
        }
      : {})
  };
}

function encryptedCredentialRotationSecret(
  input: { credentialId: string; expectedSecretRevision: number; secret: string },
  options: ManagementRouteOptions,
  idempotencyKey: string
): { ciphertext: string; idempotencyProof: string } {
  if (!options.secretVault) {
    const error = new Error("Secret storage is not configured.") as Error & { statusCode: number };
    error.statusCode = 503;
    throw error;
  }
  return {
    ciphertext: options.secretVault.encrypt(input.secret),
    idempotencyProof: options.secretVault.fingerprint(
      "credential-rotate-idempotency-v1",
      JSON.stringify([
        idempotencyKey,
        input.credentialId,
        input.expectedSecretRevision,
        input.secret
      ])
    )
  };
}

function renderPrompt(content: string, variables: string[], values: Record<string, string>): string {
  const missing = variables.filter((variable) => values[variable] === undefined);
  if (missing.length > 0) {
    const error = new Error(`Prompt variables are missing: ${missing.join(", ")}.`) as Error & { statusCode: number };
    error.statusCode = 400;
    throw error;
  }
  return content.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_token, name: string) => values[name] ?? "");
}

function bindOperatorOmpSandbox(
  body: unknown,
  options: ManagementRouteOptions
): { body: unknown } | { status: 409 | 503; code: string; message: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { body };
  const record = body as Record<string, unknown>;
  if (record.harnessKind !== "pi") return { body };
  const approved = options.ompRuntime?.enabled ? options.ompRuntime.sandboxProfileId : undefined;
  if (!approved) {
    return {
      status: 503,
      code: "OMP_RUNTIME_UNAVAILABLE",
      message: "OMP Runtime is not enabled with an operator-approved Sandbox Profile."
    };
  }
  if (record.sandboxProfileId !== null
    && record.sandboxProfileId !== undefined
    && record.sandboxProfileId !== approved) {
    return {
      status: 409,
      code: "OMP_SANDBOX_PROFILE_MISMATCH",
      message: "OMP Runtime Profile does not match the operator-approved Sandbox Profile."
    };
  }
  return { body: { ...record, sandboxProfileId: approved } };
}

export function registerManagementRoutes(app: FastifyInstance, options: ManagementRouteOptions): void {
  app.get("/api/tool-packs", async () => parseResponse(
    toolPackListResponseSchema,
    { toolPacks: await options.store.getToolPacks() }
  ));

  app.post("/api/tool-packs", async (request, reply) => {
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const pack = await options.store.createToolPack(
      parse(createToolPackSchema, request.body),
      requestKey
    );
    return reply.code(201).send(parseResponse(toolPackSchema, pack));
  });

  app.patch("/api/tool-packs/:id", async (request, reply) => {
    const { id } = parse(idSchema, request.params);
    return reply.send(parseResponse(
      toolPackSchema,
      await options.store.updateToolPack(id, parse(updateToolPackSchema, request.body))
    ));
  });

  app.get("/api/tool-packs/:id/revisions", async (request, reply) => {
    const { id } = parse(idSchema, request.params);
    return reply.send(parseResponse(toolPackRevisionListResponseSchema, await options.store.getToolPackRevisions(id)));
  });

  app.post("/api/tool-packs/:id/validate", async (request, reply) => {
    const { id } = parse(idSchema, request.params);
    return reply.send(parseResponse(
      toolPackSchema,
      await options.store.validateToolPack(id, parse(validateToolPackSchema, request.body))
    ));
  });

  app.post("/api/tool-packs/:id/approve", async (request, reply) => {
    const { id } = parse(idSchema, request.params);
    return reply.send(parseResponse(
      toolPackSchema,
      await options.store.approveToolPack(id, parse(approveToolPackSchema, request.body))
    ));
  });

  app.post("/api/tool-packs/:id/revoke", async (request, reply) => {
    const { id } = parse(idSchema, request.params);
    return reply.send(parseResponse(
      toolPackSchema,
      await options.store.revokeToolPack(id, parse(revokeToolPackSchema, request.body))
    ));
  });

  app.get("/api/runtime-profiles", async () => parseResponse(
    runtimeProfileListResponseSchema,
    { runtimeProfiles: await options.store.getRuntimeProfiles() }
  ));

  app.post("/api/runtime-profiles", async (request, reply) => {
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const bound = bindOperatorOmpSandbox(request.body, options);
    if (!("body" in bound)) return sendError(reply, bound.status, bound.code, bound.message);
    const profile = await options.store.createRuntimeProfile(
      parse(createRuntimeProfileSchema, bound.body),
      requestKey
    );
    return reply.code(201).send(parseResponse(runtimeProfileSchema, profile));
  });

  app.patch("/api/runtime-profiles/:id", async (request, reply) => {
    const { id } = parse(idSchema, request.params);
    const bound = bindOperatorOmpSandbox(request.body, options);
    if (!("body" in bound)) return sendError(reply, bound.status, bound.code, bound.message);
    return reply.send(parseResponse(
      runtimeProfileSchema,
      await options.store.updateRuntimeProfile(id, parse(updateRuntimeProfileSchema, bound.body))
    ));
  });

  app.get("/api/runtime-profiles/:id/revisions", async (request, reply) => {
    const { id } = parse(idSchema, request.params);
    return reply.send(parseResponse(
      runtimeProfileRevisionListResponseSchema,
      await options.store.getRuntimeProfileRevisions(id)
    ));
  });

  app.get("/api/credentials", async () => parseResponse(
    credentialListResponseSchema,
    { credentials: await options.store.getCredentials() }
  ));

  app.post("/api/credentials", async (request, reply) => {
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const input = parse(createCredentialSchema, request.body);
    const { secret, ...metadata } = input;
    const credential = await options.store.createCredential(
      metadata,
      encryptedSecret(secret, options, requestKey),
      requestKey
    );
    return reply.code(201).send(parseResponse(credentialSchema, credential));
  });

  app.patch("/api/credentials/:id", async (request, reply) => {
    const { id } = parse(idSchema, request.params);
    const input = parse(updateCredentialSchema, request.body);
    return reply.send(parseResponse(credentialSchema, await options.store.updateCredential(id, input)));
  });

  app.post("/api/credentials/:id/rotate", async (request, reply) => {
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const { id } = parse(idSchema, request.params);
    const input = parse(rotateCredentialSchema, request.body);
    if (input.credentialId !== id) {
      return sendError(reply, 400, "CREDENTIAL_ID_MISMATCH", "Credential identifier does not match the route.");
    }
    const secret = encryptedCredentialRotationSecret(input, options, requestKey);
    const maskedHint = input.secret.length > 4 ? `****${input.secret.slice(-4)}` : "****";
    const metadata = {
      credentialId: id,
      expectedSecretRevision: input.expectedSecretRevision
    };
    const replay = await options.store.replayCredentialRotation(metadata, secret, maskedHint, requestKey);
    if (replay) return reply.send(parseResponse(credentialSchema, replay));
    return reply.send(parseResponse(
      credentialSchema,
      await options.store.rotateCredential(metadata, secret, maskedHint, requestKey)
    ));
  });

  app.patch("/api/credentials/:id/status", async (request, reply) => {
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const { id } = parse(idSchema, request.params);
    return reply.send(parseResponse(
      credentialSchema,
      await options.store.setCredentialStatus(id, parse(updateCredentialStatusSchema, request.body), requestKey)
    ));
  });

  app.get("/api/prompts", async () => parseResponse(
    promptListResponseSchema,
    { prompts: await options.store.getPrompts() }
  ));

  app.post("/api/prompts", async (request, reply) => {
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const prompt = await options.store.createPrompt(parse(createPromptSchema, request.body), requestKey);
    return reply.code(201).send(parseResponse(promptTemplateResponseSchema, prompt));
  });

  app.patch("/api/prompts/:id", async (request, reply) => {
    const { id } = parse(idSchema, request.params);
    return reply.send(parseResponse(
      promptTemplateResponseSchema,
      await options.store.updatePrompt(id, parse(updatePromptSchema, request.body))
    ));
  });

  app.get("/api/prompts/:id/versions", async (request, reply) => {
    const { id } = parse(idSchema, request.params);
    return reply.send(parseResponse(promptVersionListResponseSchema, await options.store.getPromptVersions(id)));
  });

  app.post("/api/prompts/:id/publish", async (request, reply) => {
    const { id } = parse(idSchema, request.params);
    return reply.send(parseResponse(
      promptTemplateResponseSchema,
      await options.store.publishPrompt(id, parse(publishPromptSchema, request.body))
    ));
  });

  app.post("/api/prompts/:id/rollback", async (request, reply) => {
    const { id } = parse(idSchema, request.params);
    return reply.send(parseResponse(
      promptTemplateResponseSchema,
      await options.store.rollbackPrompt(id, parse(rollbackPromptSchema, request.body))
    ));
  });

  app.post("/api/prompts/:id/archive", async (request, reply) => {
    const { id } = parse(idSchema, request.params);
    return reply.send(parseResponse(
      promptTemplateResponseSchema,
      await options.store.archivePrompt(id, parse(archivePromptSchema, request.body))
    ));
  });

  app.post("/api/prompts/:id/preview", async (request, reply) => {
    const { id } = parse(idSchema, request.params);
    const input = parse(promptPreviewRequestSchema, request.body);
    const version = await options.store.getPromptVersion(id, input.version);
    return reply.send(parseResponse(promptPreviewResponseSchema, {
      content: renderPrompt(version.content, version.variables, input.variables),
      version: version.version
    }));
  });

  app.get("/api/agents/:id/readiness", async (request, reply) => {
    const { id } = parse(idSchema, request.params);
    return reply.send(parseResponse(agentReadinessResponseSchema, await options.store.getAgentReadiness(id)));
  });

  // find-my-way uses a double colon to register one literal colon in a route.
  app.post("/api/agents/readiness::batch", async (request, reply) => {
    const { agentIds } = parse(agentReadinessBatchRequestSchema, request.body);
    const snapshot = await options.store.getSnapshot();
    const results = await Promise.all(agentIds.map(async (agentId) => ({
      agentId,
      readiness: (await getPublishedAgentRuntime(options.store, snapshot, agentId)).readiness
    })));
    return reply.send(parseResponse(agentReadinessBatchResponseSchema, { results }));
  });

  app.get("/api/agents/:id/revisions", async (request, reply) => {
    const { id } = parse(idSchema, request.params);
    return reply.send(parseResponse(agentRevisionListResponseSchema, await options.store.getAgentRevisions(id)));
  });

  app.post("/api/agents/:id/publish", async (request, reply) => {
    const { id } = parse(idSchema, request.params);
    return reply.send(parseResponse(agentResponseSchema, await options.store.publishAgent(id, parse(publishAgentSchema, request.body))));
  });

  app.post("/api/agents/:id/rollback", async (request, reply) => {
    const { id } = parse(idSchema, request.params);
    return reply.send(parseResponse(agentResponseSchema, await options.store.rollbackAgent(id, parse(rollbackAgentSchema, request.body))));
  });

  app.patch("/api/agents/:id/status", async (request, reply) => {
    const { id } = parse(idSchema, request.params);
    return reply.send(parseResponse(agentResponseSchema, await options.store.setAgentStatus(id, parse(setAgentStatusSchema, request.body))));
  });

  app.get("/api/agents/:id/effective-configuration", async (request, reply) => {
    const { id } = parse(idSchema, request.params);
    const snapshot = await options.store.getSnapshot();
    const agent = snapshot.agents.find((item) => item.id === id);
    if (!agent) return sendError(reply, 404, "NOT_FOUND", "Agent not found.");
    const summary = await buildAgentCapabilitySummary(options.store, snapshot, agent);
    return reply.send(parseResponse(effectiveAgentConfigurationSchema, summary));
  });

  app.post("/api/agent-teams", async (request, reply) => {
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const input = parse(createAgentTeamSchema, request.body);
    const snapshot = await options.store.getSnapshot();
    for (const member of input.members) {
      const runtime = await getPublishedAgentRuntime(options.store, snapshot, member.agentId);
      if (runtime.readiness.status === "blocked") {
        return sendError(reply, 409, "AGENT_TEAM_MEMBER_NOT_READY", `${runtime.agent?.name ?? "Agent"} has no ready published revision.`);
      }
    }
    const team = await options.store.createAgentTeam(input, requestKey);
    return reply.code(201).send(parseResponse(agentTeamSchema, team));
  });

  app.patch("/api/agent-teams/:id", async (request, reply) => {
    const { id } = parse(idSchema, request.params);
    const input = parse(updateAgentTeamSchema, request.body);
    if (input.members) {
      const snapshot = await options.store.getSnapshot();
      for (const member of input.members) {
        const runtime = await getPublishedAgentRuntime(options.store, snapshot, member.agentId);
        if (runtime.readiness.status === "blocked") {
          return sendError(reply, 409, "AGENT_TEAM_MEMBER_NOT_READY", `${runtime.agent?.name ?? "Agent"} has no ready published revision.`);
        }
      }
    }
    return reply.send(parseResponse(agentTeamSchema, await options.store.updateAgentTeam(id, input)));
  });

  app.post("/api/meeting-presets", async (request, reply) => {
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const preset = await options.store.createMeetingPreset(parse(createMeetingPresetSchema, request.body), requestKey);
    return reply.code(201).send(parseResponse(meetingPresetSchema, preset));
  });

  app.patch("/api/meeting-presets/:id", async (request, reply) => {
    const { id } = parse(idSchema, request.params);
    return reply.send(parseResponse(
      meetingPresetSchema,
      await options.store.updateMeetingPreset(id, parse(updateMeetingPresetSchema, request.body))
    ));
  });

  app.get("/api/meeting-presets/:id/preflight", async (request, reply) => {
    const { id } = parse(idSchema, request.params);
    const snapshot = await options.store.getSnapshot();
    const preset = (snapshot.meetingPresets ?? []).find((item) => item.id === id);
    if (!preset) return sendError(reply, 404, "NOT_FOUND", "Meeting Preset not found.");
    const team = preset.teamId ? (snapshot.agentTeams ?? []).find((item) => item.id === preset.teamId) ?? null : null;
    const activeRoleIds = new Set(snapshot.roles.filter((role) => role.deletedAt === null).map((role) => role.id));
    const invalidRoleIds = [...new Set((team?.members ?? [])
      .filter((member) => !activeRoleIds.has(member.roleId))
      .map((member) => member.roleId))];
    const agents = await Promise.all((team?.members ?? []).map(async (member) => {
      const runtime = await getPublishedAgentRuntime(options.store, snapshot, member.agentId);
      return {
        agentId: member.agentId,
        roleId: member.roleId,
        isChair: member.isChair,
        agentRevision: runtime.revision?.revision ?? null,
        readiness: runtime.readiness
      };
    }));
    const blocked = preset.status !== "active"
      || (preset.teamId !== null && (!team || team.status !== "active"))
      || invalidRoleIds.length > 0
      || agents.some((item) => item.readiness.status === "blocked");
    const warning = preset.teamId === null || agents.some((item) => item.readiness.status === "warning");
    return reply.send(parseResponse(meetingPresetPreflightSchema, {
      presetId: id,
      status: blocked ? "blocked" : warning ? "warning" : "ready",
      team,
      invalidRoleIds,
      agents
    }));
  });
}
