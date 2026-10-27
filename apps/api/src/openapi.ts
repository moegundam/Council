import { z } from "zod";
import { apiErrorEnvelopeSchema } from "@council/contracts";
import {
  createApiContractCapabilities,
  type ApiContractCapability,
  type ApiContractMethod,
  type ApiContractSchema
} from "@council/contracts/openapi-contracts";
import {
  assertApiAuthorityCoverage,
  createApiAuthorityMap,
  type ApiAuthorityEntry
} from "./authority-map.js";

type RouteMethod = string | readonly string[];

export interface RegisteredApiRoute {
  method: ApiContractMethod;
  path: string;
}

export interface OpenApiCoverageGap {
  method: ApiContractMethod;
  path: string;
  reason: string;
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema";
  info: { title: string; version: string; description: string };
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, unknown>>;
  components: {
    securitySchemes: { cookieAuth: { type: "apiKey"; in: "cookie"; name: "council_session" } };
    schemas: Record<string, unknown>;
  };
  "x-capability-coverage": {
    status: "complete" | "partial";
    typedOperations: number;
    registeredOperations: number;
    schemaGaps: OpenApiCoverageGap[];
  };
  "x-authority-coverage": {
    status: "complete";
    classifiedOperations: number;
    registeredOperations: number;
    agentHttpOperations: number;
  };
}

const documentedMethods = new Set<ApiContractMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const mutatingMethods = new Set<ApiContractMethod>(["POST", "PUT", "PATCH", "DELETE"]);
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

function routeKey(route: RegisteredApiRoute): string {
  return `${route.method} ${route.path}`;
}

function publicPath(path: string): string {
  return `/api/v1${path.slice("/api".length)}`.replace(/\/:([A-Za-z0-9_]+)/g, "/{$1}");
}

function pathParameters(path: string): Array<Record<string, unknown>> {
  return [...path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => ({
    name: match[1]!,
    in: "path",
    required: true,
    schema: match[1] === "view"
      ? { type: "string" }
      : { type: "string", format: "uuid" }
  }));
}

function upsertParameter(
  parameters: Array<Record<string, unknown>>,
  documented: Record<string, unknown>
): void {
  const existingIndex = parameters.findIndex((candidate) => {
    if (candidate.in !== documented.in || typeof candidate.name !== "string" || typeof documented.name !== "string") {
      return false;
    }
    return documented.in === "header"
      ? candidate.name.toLocaleLowerCase() === documented.name.toLocaleLowerCase()
      : candidate.name === documented.name;
  });
  if (existingIndex === -1) parameters.push(documented);
  else parameters[existingIndex] = documented;
}

function addRequiredOriginParameter(
  parameters: Array<Record<string, unknown>>,
  method: ApiContractMethod,
  authority: ApiAuthorityEntry
): void {
  if (authority.caller !== "owner_session" || !mutatingMethods.has(method)) return;
  upsertParameter(parameters, {
    name: "Origin",
    in: "header",
    required: true,
    description: "Exact same-origin value required for CSRF protection.",
    schema: { type: "string", format: "uri" }
  });
}

function routeTag(path: string): string {
  return path.split("/").filter(Boolean)[1] ?? "platform";
}

function removeJsonSchemaDialect(value: unknown): Record<string, unknown> {
  const schema = structuredClone(value) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

function anchorComponentLocalReferences(componentName: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) anchorComponentLocalReferences(componentName, item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "$ref" && typeof nested === "string" && nested.startsWith("#/$defs/")) {
      (value as Record<string, unknown>)[key] = `#/components/schemas/${componentName}/${nested.slice(2)}`;
      continue;
    }
    anchorComponentLocalReferences(componentName, nested);
  }
}

function responsePropertyNames(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) responsePropertyNames(item, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "properties" && nested && typeof nested === "object" && !Array.isArray(nested)) {
      for (const property of Object.keys(nested)) {
        result.add(property.toLocaleLowerCase().replace(/[^a-z0-9]/g, ""));
      }
    }
    responsePropertyNames(nested, result);
  }
  return result;
}

function assertResponseSchemaIsSafe(componentName: string, schema: Record<string, unknown>): void {
  const leaked = [...responsePropertyNames(schema)].filter((property) => forbiddenResponseProperties.has(property));
  if (leaked.length > 0) {
    throw new Error(`OpenAPI response component ${componentName} exposes secret-bearing fields: ${leaked.join(", ")}.`);
  }
}

function createSchemaRegistrar(target: Record<string, unknown>): (
  contract: ApiContractSchema,
  direction: "request" | "response"
) => void {
  const sources = new Map<string, { schema: z.ZodType; direction: "request" | "response" }>();
  return (contract, direction) => {
    const previous = sources.get(contract.componentName);
    if (previous) {
      if (previous.schema !== contract.schema || previous.direction !== direction) {
        throw new Error(`OpenAPI component ${contract.componentName} is registered with conflicting Zod schemas.`);
      }
      return;
    }
    const generated = removeJsonSchemaDialect(z.toJSONSchema(contract.schema, {
      target: "draft-2020-12",
      io: direction === "request" ? "input" : "output",
      unrepresentable: "any",
      cycles: "ref",
      reused: "ref"
    }));
    anchorComponentLocalReferences(contract.componentName, generated);
    generated["x-schema-direction"] = direction;
    if (direction === "response") assertResponseSchemaIsSafe(contract.componentName, generated);
    target[contract.componentName] = generated;
    sources.set(contract.componentName, { schema: contract.schema, direction });
  };
}

function typedOperation(
  capability: ApiContractCapability,
  registerSchema: ReturnType<typeof createSchemaRegistrar>,
  authority: ApiAuthorityEntry
): Record<string, unknown> {
  const path = publicPath(capability.path);
  const parameters = pathParameters(path);
  for (const parameter of capability.parameters ?? []) {
    const documented = {
      name: parameter.name,
      in: parameter.in,
      required: parameter.required,
      description: parameter.description,
      schema: removeJsonSchemaDialect(z.toJSONSchema(parameter.schema, {
        target: "draft-2020-12",
        io: "input",
        unrepresentable: "any"
      }))
    };
    upsertParameter(parameters, documented);
  }
  addRequiredOriginParameter(parameters, capability.method, authority);

  const responses: Record<string, unknown> = {};
  for (const response of capability.responses) {
    if ("schema" in response) {
      registerSchema(response, "response");
      responses[response.status] = {
        description: response.description,
        content: {
          [response.contentType ?? "application/json"]: {
            schema: { $ref: `#/components/schemas/${response.componentName}` }
          }
        }
      };
    } else {
      responses[response.status] = { description: response.description };
    }
  }
  responses.default = {
    description: "Error response",
    content: {
      "application/json": { schema: { $ref: "#/components/schemas/ApiErrorResponse" } }
    }
  };

  const operation: Record<string, unknown> = {
    operationId: capability.operationId,
    tags: capability.tags,
    summary: capability.summary,
    security: authority.caller === "public" ? [] : [{ cookieAuth: [] }],
    responses,
    "x-contract-status": "typed",
    "x-authority": {
      caller: authority.caller,
      effect: authority.effect,
      agentHttpAccessible: authority.agentHttpAccessible
    }
  };
  if (parameters.length > 0) operation.parameters = parameters;
  if (capability.requestBody) {
    registerSchema(capability.requestBody, "request");
    operation.requestBody = {
      required: capability.requestBody.required,
      content: {
        "application/json": {
          schema: { $ref: `#/components/schemas/${capability.requestBody.componentName}` }
        }
      }
    };
  }
  return operation;
}

function gapOperation(route: RegisteredApiRoute, authority: ApiAuthorityEntry): Record<string, unknown> {
  const path = publicPath(route.path);
  const operation: Record<string, unknown> = {
    operationId: authority.operationId,
    tags: [routeTag(route.path)],
    summary: "Runtime route without a stable Zod capability contract",
    description: "This route is visible for inventory purposes, but its request or success response schema is not yet formalized. Do not generate typed callers for this operation.",
    security: authority.caller === "public" ? [] : [{ cookieAuth: [] }],
    responses: {
      "2XX": {
        description: "Success response schema is not yet formalized",
        content: { "application/json": { schema: true } }
      },
      default: {
        description: "Error response",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/ApiErrorResponse" } }
        }
      }
    },
    "x-contract-status": "schema-gap",
    "x-authority": {
      caller: authority.caller,
      effect: authority.effect,
      agentHttpAccessible: authority.agentHttpAccessible
    }
  };
  const parameters = pathParameters(path);
  addRequiredOriginParameter(parameters, route.method, authority);
  if (parameters.length > 0) operation.parameters = parameters;
  if (mutatingMethods.has(route.method)) {
    operation.requestBody = {
      required: false,
      content: { "application/json": { schema: true } }
    };
  }
  return operation;
}

export class ApiRouteInventory {
  private readonly routes = new Map<string, RegisteredApiRoute>();

  record(method: RouteMethod, path: string): void {
    if (!path.startsWith("/api/")) return;
    const candidates = Array.isArray(method) ? method : [method];
    for (const candidate of candidates) {
      const normalized = candidate.toUpperCase() as ApiContractMethod;
      if (!documentedMethods.has(normalized)) {
        throw new Error(`API route uses unsupported API method ${candidate.toUpperCase()}: ${path}.`);
      }
      const route = { method: normalized, path: path.replaceAll("::", ":") };
      this.routes.set(routeKey(route), route);
    }
  }

  list(): RegisteredApiRoute[] {
    return [...this.routes.values()].sort((left, right) => routeKey(left).localeCompare(routeKey(right)));
  }
}

export function createOpenApiDocument(version: string, registeredRoutes: readonly RegisteredApiRoute[]): OpenApiDocument {
  const capabilities = createApiContractCapabilities();
  const authorityMap = createApiAuthorityMap();
  const registeredByKey = new Map(registeredRoutes.map((route) => [routeKey(route), route]));
  const capabilityByKey = new Map(capabilities.map((capability) => [routeKey(capability), capability]));
  const authorityByKey = new Map(authorityMap.map((entry) => [routeKey(entry), entry]));

  for (const capability of capabilities) {
    if (!registeredByKey.has(routeKey(capability))) {
      throw new Error(`OpenAPI contracted route ${routeKey(capability)} is not registered by Fastify.`);
    }
  }
  assertApiAuthorityCoverage(registeredRoutes);

  const componentSchemas: Record<string, unknown> = {};
  const registerSchema = createSchemaRegistrar(componentSchemas);
  registerSchema({ componentName: "ApiErrorResponse", schema: apiErrorEnvelopeSchema }, "response");

  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of registeredRoutes) {
    const path = publicPath(route.path);
    const item = paths[path] ?? {};
    const capability = capabilityByKey.get(routeKey(route));
    const authority = authorityByKey.get(routeKey(route));
    if (!authority) throw new Error(`API AuthorityMap entry is missing for ${routeKey(route)}.`);
    item[route.method.toLocaleLowerCase()] = capability
      ? typedOperation(capability, registerSchema, authority)
      : gapOperation(route, authority);
    paths[path] = item;
  }

  const schemaGaps = registeredRoutes
    .filter((route) => !capabilityByKey.has(routeKey(route)))
    .map((route): OpenApiCoverageGap => ({
      method: route.method,
      path: publicPath(route.path),
      reason: "No stable Zod request/response capability is registered for this runtime route."
    }));

  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: "Agent Meeting Platform API",
      version,
      description: "OpenAPI 3.1 generated from Zod 4 capability contracts and the live Fastify route inventory. Inspect x-capability-coverage before generating clients."
    },
    servers: [{ url: "/" }],
    paths,
    components: {
      securitySchemes: {
        cookieAuth: { type: "apiKey", in: "cookie", name: "council_session" }
      },
      schemas: componentSchemas
    },
    "x-capability-coverage": {
      status: schemaGaps.length === 0 ? "complete" : "partial",
      typedOperations: capabilities.length,
      registeredOperations: registeredRoutes.length,
      schemaGaps
    },
    "x-authority-coverage": {
      status: "complete",
      classifiedOperations: authorityMap.length,
      registeredOperations: registeredRoutes.length,
      agentHttpOperations: authorityMap.filter(({ agentHttpAccessible }) => agentHttpAccessible).length
    }
  };
}
