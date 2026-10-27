import { readFile } from "node:fs/promises";
import {
  ompBrokerControlRequestSchema,
  ompBrokerEventSchema,
  ompBrokerHealthSchema,
  ompBrokerSessionSchema,
  ompBrokerStartRequestSchema,
  type OmpBrokerControlRequest,
  type OmpBrokerEvent,
  type OmpBrokerHealth,
  type OmpBrokerSession,
  type OmpBrokerStartRequest
} from "@council/contracts";
import { z } from "zod";

const eventsResponseSchema = z.object({ events: z.array(ompBrokerEventSchema).max(500) }).strict();

export class OmpBrokerHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "OmpBrokerHttpError";
  }
}

export interface OmpBrokerClient {
  health(): Promise<OmpBrokerHealth>;
  start(request: OmpBrokerStartRequest): Promise<OmpBrokerSession>;
  get(runtimeRunId: string): Promise<OmpBrokerSession | null>;
  events(runtimeRunId: string, afterSequence: number, limit?: number): Promise<OmpBrokerEvent[]>;
  control(runtimeRunId: string, request: OmpBrokerControlRequest): Promise<OmpBrokerSession>;
}

function endpoint(baseUrl: URL, path: string): URL {
  return new URL(path, baseUrl);
}

export function createOmpBrokerClient(input: {
  baseUrl: string;
  authToken: string;
  timeoutMs?: number;
}): OmpBrokerClient {
  const baseUrl = new URL(input.baseUrl);
  if (!["http:", "https:"].includes(baseUrl.protocol)
    || baseUrl.username
    || baseUrl.password
    || baseUrl.search
    || baseUrl.hash
    || !["", "/"].includes(baseUrl.pathname)) {
    throw new Error("OMP_BROKER_URL must be a credential-free HTTP(S) origin.");
  }
  if (!input.authToken.trim()) throw new Error("OMP Broker token is empty.");
  const timeoutMs = input.timeoutMs ?? 10_000;

  const request = async <T>(url: URL, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        authorization: `Bearer ${input.authToken}`,
        accept: "application/json",
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
        ...init?.headers
      }
    });
    if (response.status === 404 && init?.method === undefined) {
      throw new OmpBrokerHttpError(404, "OMP Broker Session was not found.");
    }
    if (!response.ok) {
      throw new OmpBrokerHttpError(response.status, `OMP Broker request failed with HTTP ${response.status}.`);
    }
    return schema.parse(await response.json());
  };

  return {
    health: () => request(endpoint(baseUrl, "/health/omp-runtime"), ompBrokerHealthSchema),
    start(raw) {
      const body = ompBrokerStartRequestSchema.parse(raw);
      return request(endpoint(baseUrl, "/omp/sessions"), ompBrokerSessionSchema, {
        method: "POST",
        body: JSON.stringify(body)
      });
    },
    async get(runtimeRunId) {
      try {
        return await request(endpoint(baseUrl, `/omp/sessions/${encodeURIComponent(runtimeRunId)}`), ompBrokerSessionSchema);
      } catch (error) {
        if (error instanceof OmpBrokerHttpError && error.status === 404) return null;
        throw error;
      }
    },
    events(runtimeRunId, afterSequence, limit = 100) {
      const url = endpoint(baseUrl, `/omp/sessions/${encodeURIComponent(runtimeRunId)}/events`);
      url.searchParams.set("afterSequence", String(afterSequence));
      url.searchParams.set("limit", String(limit));
      return request(url, eventsResponseSchema).then((result) => result.events);
    },
    control(runtimeRunId, raw) {
      const body = ompBrokerControlRequestSchema.parse(raw);
      return request(endpoint(baseUrl, `/omp/sessions/${encodeURIComponent(runtimeRunId)}/control`), ompBrokerSessionSchema, {
        method: "POST",
        body: JSON.stringify(body)
      });
    }
  };
}

export async function createOmpBrokerClientFromEnv(
  env: NodeJS.ProcessEnv = process.env
): Promise<OmpBrokerClient | undefined> {
  const enabled = z.enum(["true", "false"]).parse(env.OMP_RUNTIME_ENABLED ?? "false") === "true";
  if (!enabled) return undefined;
  if (!env.OMP_BROKER_URL) throw new Error("OMP_BROKER_URL is required when OMP Runtime is enabled.");
  if (!env.OMP_BROKER_TOKEN_FILE) throw new Error("OMP_BROKER_TOKEN_FILE is required when OMP Runtime is enabled.");
  const token = (await readFile(env.OMP_BROKER_TOKEN_FILE, "utf8")).trim();
  return createOmpBrokerClient({ baseUrl: env.OMP_BROKER_URL, authToken: token });
}
