import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { ZodError } from "zod";
import { loginSchema } from "@council/contracts";
import { platformSnapshotSchema } from "@council/contracts/api-contracts";
import { StoreConflictError, type SessionRecord } from "@council/database";
import {
  errorStatusCode,
  parse,
  parseResponse,
  ResponseContractError,
  sendError,
  type AppOptions
} from "./route-support.js";
import { registerAdminRoutes } from "./routes/admin-routes.js";
import { registerActionAdapterRoutes } from "./routes/action-adapter-routes.js";
import { registerMeetingRoutes } from "./routes/meeting-routes.js";
import { registerGoalRoutes } from "./routes/goal-routes.js";
import { registerRuntimeRunRoutes } from "./routes/runtime-run-routes.js";
import { registerManagementRoutes } from "./routes/management-routes.js";
import { registerTaxonomyRoutes } from "./routes/taxonomy-routes.js";
import { registerViewRoutes } from "./routes/view-routes.js";
import { rewriteVersionedApiUrl } from "./api-routing.js";
import { assertApiAuthorityCoverage, createApiAuthorityMap } from "./authority-map.js";
import { ApiRouteInventory, createOpenApiDocument } from "./openapi.js";

export type { AppOptions } from "./route-support.js";

declare module "fastify" {
  interface FastifyRequest {
    ownerSession: SessionRecord | null;
  }
}

const sessionCookie = "council_session";
const mutatingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function withTimeout(action: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      action,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Readiness check timed out.")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  const routeInventory = new ApiRouteInventory();
  const authorityByRoute = new Map(createApiAuthorityMap().map((entry) => [
    `${entry.method} ${entry.path}`,
    entry
  ]));
  let openApiDocument: ReturnType<typeof createOpenApiDocument> | undefined;
  const app = Fastify({
    logger: false,
    bodyLimit: 1_000_000,
    exposeHeadRoutes: false,
    trustProxy: false,
    rewriteUrl: (request) => rewriteVersionedApiUrl(request.url ?? "/")
  });
  const authDisabled = options.authDisabled ?? false;
  const secureCookies = options.secureCookies ?? true;
  const issueOwnerSession = async (owner: { id: string; email: string }, reply: FastifyReply) => {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    await options.store.createSession({ userId: owner.id, tokenHash: tokenHash(token), expiresAt });
    reply.setCookie(sessionCookie, token, {
      httpOnly: true,
      secure: secureCookies,
      sameSite: "strict",
      path: "/",
      expires: new Date(expiresAt)
    });
    return reply.send({ user: { id: owner.id, email: owner.email } });
  };
  app.decorateRequest("ownerSession", null);

  app.addHook("onRoute", (route) => routeInventory.record(route.method, route.url));

  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { max: options.rateLimitMax ?? 120, timeWindow: "1 minute" });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ResponseContractError) {
      return sendError(reply, 500, "RESPONSE_CONTRACT_VIOLATION", "The response could not be serialized safely.");
    }
    if (error instanceof ZodError) {
      return sendError(reply, 400, "VALIDATION_ERROR", error.issues.map((issue) => issue.message).join("; "));
    }
    if (error instanceof StoreConflictError) {
      return sendError(
        reply,
        409,
        error.kind === "revision" ? "REVISION_CONFLICT" : error.apiCode ?? "REQUEST_FAILED",
        error.message
      );
    }
    const statusCode = errorStatusCode(error);
    const safeMessage = statusCode >= 500
      ? "The request could not be completed."
      : error instanceof Error ? error.message : "Request failed.";
    const apiCode = typeof error === "object" && error !== null && "apiCode" in error && typeof error.apiCode === "string"
      ? error.apiCode
      : "REQUEST_FAILED";
    return sendError(reply, statusCode, apiCode, safeMessage);
  });

  app.addHook("preHandler", async (request, reply) => {
    const routePath = request.routeOptions.url;
    if (typeof routePath !== "string" || !routePath.startsWith("/api/")) return;
    const authority = authorityByRoute.get(
      `${request.method} ${routePath.replaceAll("::", ":")}`
    );
    if (!authority) {
      return sendError(reply, 403, "AUTHORITY_UNDEFINED", "API route authority is not defined.");
    }
    if (authority.caller === "public") return;
    if (authDisabled) {
      const token = request.cookies[sessionCookie];
      request.ownerSession = token ? await options.store.findSession(tokenHash(token)) : null;
      if (mutatingMethods.has(request.method)
        && options.allowedOrigin
        && request.headers.origin !== options.allowedOrigin) {
        return sendError(reply, 403, "ORIGIN_REJECTED", "Request origin is not allowed.");
      }
      return;
    }
    const token = request.cookies[sessionCookie];
    const session = token ? await options.store.findSession(tokenHash(token)) : null;
    if (!session) {
      return sendError(reply, 401, "UNAUTHORIZED", "Authentication required.");
    }
    request.ownerSession = session;
    if (mutatingMethods.has(request.method)
      && (!options.allowedOrigin || request.headers.origin !== options.allowedOrigin)) {
      return sendError(reply, 403, "ORIGIN_REJECTED", "Request origin is not allowed.");
    }
  });

  app.get("/api/health/live", async () => ({ status: "ok" }));
  app.get("/api/health/ready", async (_request, reply) => {
    try {
      await withTimeout((async () => {
        await options.store.checkHealth();
        await options.readinessCheck?.();
      })(), options.readinessTimeoutMs ?? 3_000);
      return reply.send({ status: "ready" });
    } catch {
      return sendError(reply, 503, "NOT_READY", "A required dependency is unavailable.");
    }
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: 8, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const input = parse(loginSchema, request.body);
    const owner = await options.store.findOwnerByEmail(input.email);
    const valid = owner ? await argon2.verify(owner.passwordHash, input.password) : false;
    if (!owner || !valid) return sendError(reply, 401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    return issueOwnerSession(owner, reply);
  });

  app.post("/api/auth/test-login", async (_request, reply) => {
    if (!options.testLoginOwnerEmail) {
      return sendError(reply, 404, "NOT_FOUND", "Direct test login is unavailable.");
    }
    const owner = await options.store.findOwnerByEmail(options.testLoginOwnerEmail);
    if (!owner) return sendError(reply, 404, "NOT_FOUND", "Direct test login is unavailable.");
    return issueOwnerSession(owner, reply);
  });

  app.post("/api/auth/tailnet-login", { config: { rateLimit: { max: 8, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const config = options.tailnetQuickLogin;
    if (!config) return sendError(reply, 404, "NOT_FOUND", "Tailnet quick login is unavailable.");

    const identity = request.headers["tailscale-user-login"];
    const allowed = typeof identity === "string"
      && identity.trim().toLowerCase() === config.identity
      && typeof options.allowedOrigin === "string"
      && request.headers.origin === options.allowedOrigin;
    if (!allowed) {
      return sendError(reply, 403, "TAILNET_IDENTITY_REJECTED", "Tailnet quick login is unavailable.");
    }

    const owner = await options.store.findOwnerByEmail(config.ownerEmail);
    if (!owner) {
      return sendError(reply, 403, "TAILNET_IDENTITY_REJECTED", "Tailnet quick login is unavailable.");
    }
    await options.store.recordAudit("auth.tailnet_login.accepted", "owner", owner.id, {
      provider: "tailscale_serve"
    });
    return issueOwnerSession(owner, reply);
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies[sessionCookie];
    if (token) await options.store.deleteSession(tokenHash(token));
    reply.clearCookie(sessionCookie, { path: "/" });
    return reply.code(204).send();
  });

  app.get("/api/bootstrap", async () => {
    const snapshot = await options.store.getSnapshot();
    return parseResponse(platformSnapshotSchema, {
      ...snapshot,
      roles: snapshot.roles.filter((role) => !role.deletedAt)
    });
  });
  registerTaxonomyRoutes(app, options);
  registerMeetingRoutes(app, options);
  registerGoalRoutes(app, options);
  registerRuntimeRunRoutes(app, options);
  registerActionAdapterRoutes(app, options);
  registerAdminRoutes(app, options);
  registerManagementRoutes(app, options);
  registerViewRoutes(app, options);
  app.get("/api/openapi.json", async (_request, reply) => {
    reply.header("cache-control", "private, max-age=60");
    openApiDocument ??= createOpenApiDocument(
      process.env.RELEASE_VERSION ?? "development",
      routeInventory.list()
    );
    return openApiDocument;
  });
  assertApiAuthorityCoverage(routeInventory.list());

  app.addHook("onClose", async () => options.store.close());
  return app;
}
