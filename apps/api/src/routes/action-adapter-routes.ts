import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  actionAdapterListResponseSchema,
  actionAdapterSchema,
  createActionAdapterSchema
} from "@council/contracts";
import type { PlatformStore } from "@council/database";
import { normalizeActionAdapterEndpoint } from "@council/domain";
import { parse, parseResponse, sendError, type AppOptionsFor } from "../route-support.js";

const actionAdapterRouteStoreMethods = [
  "createActionAdapter",
  "getCredentials",
  "listActionAdapters",
  "recordAudit"
] as const satisfies readonly (keyof PlatformStore)[];

type ActionAdapterRouteStoreMethod = (typeof actionAdapterRouteStoreMethods)[number];
export type ActionAdapterRouteOptions = AppOptionsFor<ActionAdapterRouteStoreMethod>;

function requireOwner(request: FastifyRequest, reply: FastifyReply): string | null {
  const owner = request.ownerSession;
  if (!owner || new Date(owner.expiresAt).getTime() <= Date.now()) {
    sendError(reply, 401, "OWNER_SESSION_REQUIRED", "An attributable Owner session is required for Action Adapter management.");
    return null;
  }
  return owner.userId;
}

export function registerActionAdapterRoutes(app: FastifyInstance, options: ActionAdapterRouteOptions): void {
  app.get("/api/action-adapters", async (request, reply) => {
    if (!requireOwner(request, reply)) return;
    return reply.send(parseResponse(actionAdapterListResponseSchema, {
      actionAdapters: await options.store.listActionAdapters()
    }));
  });

  app.post("/api/action-adapters", async (request, reply) => {
    const ownerId = requireOwner(request, reply);
    if (!ownerId) return;
    const input = parse(createActionAdapterSchema, request.body);
    const approvedEndpoints = new Set(options.harnessActionAdapterEndpointAllowlist ?? []);
    let baseUrl: string;
    try {
      baseUrl = normalizeActionAdapterEndpoint(input.baseUrl);
    } catch {
      return sendError(reply, 400, "ACTION_ADAPTER_ENDPOINT_INVALID", "Harness Action Adapter endpoints must be credential-free HTTP(S) URLs without query or fragment.");
    }
    if (!approvedEndpoints.has(baseUrl)) {
      return sendError(reply, 409, "ACTION_ADAPTER_ENDPOINT_UNAPPROVED", "The Harness endpoint is not in the operator-approved Action Adapter allowlist.");
    }
    const credential = (await options.store.getCredentials()).find((candidate) => candidate.id === input.credentialId);
    if (!credential || credential.status !== "active" || !credential.hasSecret
      || (credential.expiresAt !== null && Date.parse(credential.expiresAt) <= Date.now())) {
      return sendError(reply, 409, "ACTION_CREDENTIAL_UNAVAILABLE", "Action Adapter management requires an active credential with a stored secret.");
    }
    const now = new Date().toISOString();
    const adapter = await options.store.createActionAdapter({
      id: randomUUID(),
      name: input.name,
      kind: "harness_pipeline",
      enabled: true,
      baseUrl,
      credentialId: input.credentialId,
      catalogRevision: 1,
      actions: input.actions,
      createdAt: now,
      updatedAt: now
    });
    await options.store.recordAudit("action_adapter.owner_approved", "action_adapter", adapter.id, {
      ownerId,
      catalogRevision: adapter.catalogRevision,
      credentialId: adapter.credentialId,
      endpoint: adapter.baseUrl
    });
    return reply.code(201).send(parseResponse(actionAdapterSchema, adapter));
  });
}
