import type { FastifyReply } from "fastify";
import { z } from "zod";
import { apiErrorEnvelopeSchema } from "@council/contracts/api-contracts";
import type { PlatformStore } from "@council/database";
import type { SecretVault, ExternalExecutor } from "@council/domain";
import type { TaskAdapterClient, TaskAdapterClientConfig } from "@council/runtime";
import type { AgentTurnQueue } from "./agent-queue.js";
import type { MeetingEventBus } from "./event-bus.js";

export interface AppOptions {
  store: PlatformStore;
  authDisabled?: boolean;
  rateLimitMax?: number;
  testLoginOwnerEmail?: string;
  tailnetQuickLogin?: { identity: string; ownerEmail: string };
  goalRunEnabled?: boolean;
  ompRuntimeEnabled?: boolean;
  ompRuntime?: {
    enabled: boolean;
    sandboxProfileId?: string;
    sandboxImageDigest?: string;
    workspaceSourceId?: string;
    workspaceArchiveDigest?: string;
    hostToolsEnabled: boolean;
    check(): Promise<void>;
  };
  harnessEnabled?: boolean;
  harnessAllowedResources?: string[];
  harnessActionAdapterEndpointAllowlist?: readonly string[];
  actionAdapterRuntime?: { enabled: boolean; check: (adapterIds: readonly string[]) => Promise<void> };
  secureCookies?: boolean;
  allowedOrigin?: string;
  secretVault?: SecretVault;
  mcpArgumentEncryptionWriteEnabled?: boolean;
  mcpKeyedFingerprintWriteEnabled?: boolean;
  eventBus?: MeetingEventBus;
  agentQueue?: AgentTurnQueue;
  externalExecutor?: ExternalExecutor;
  taskAdapterClientFactory?: (config: TaskAdapterClientConfig) => Pick<TaskAdapterClient, "health">;
  mcpLocalHostAllowlist?: readonly string[];
  readinessCheck?: () => Promise<void>;
  readinessTimeoutMs?: number;
  mcpQueueInspectionTimeoutMs?: number;
}

export type AppOptionsFor<Methods extends keyof PlatformStore> = Omit<AppOptions, "store"> & {
  store: Pick<PlatformStore, Methods>;
};

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

export class ResponseContractError extends Error {
  constructor(cause: z.ZodError) {
    super("API response contract validation failed.", { cause });
    this.name = "ResponseContractError";
  }
}

export function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ResponseContractError(result.error);
  return result.data;
}

export function errorStatusCode(error: unknown): number {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return 500;
  const statusCode = error.statusCode;
  return typeof statusCode === "number"
    && Number.isInteger(statusCode)
    && statusCode >= 400
    && statusCode <= 599
    ? statusCode
    : 500;
}

const idempotencyKeySchema = z.string().trim().min(1).max(200);

export function idempotencyKey(headers: Record<string, string | string[] | undefined>): string | undefined {
  const value = headers["idempotency-key"];
  return value === undefined ? undefined : idempotencyKeySchema.parse(value);
}

export function sendError(reply: FastifyReply, statusCode: number, code: string, message: string) {
  const payload = apiErrorEnvelopeSchema.parse({ error: { code, message } });
  return reply.code(statusCode).send(payload);
}
