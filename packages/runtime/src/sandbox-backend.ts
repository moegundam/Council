import { sandboxLeaseSchema, type SandboxLease } from "@council/contracts";
import { z } from "zod";

const sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const executableDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });

const healthSchema = z.object({ ok: z.literal(true), ready: z.boolean() }).strict();
const leaseViewSchema = z.object({
  created: z.boolean(),
  lease: sandboxLeaseSchema,
  scopeId: z.string().trim().min(1).max(500)
}).strict();
const executionEvidenceSchema = z.object({
  replayed: z.boolean(),
  leaseId: z.string().uuid(),
  scopeId: z.string().trim().min(1).max(500),
  toolPack: z.object({
    id: z.string().trim().min(1).max(120),
    version: z.string().trim().min(1).max(100),
    digest: sha256DigestSchema,
    reference: z.string().regex(/^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/i),
    executableDigest: executableDigestSchema
  }).strict(),
  tool: z.object({
    name: z.string().trim().min(1).max(120),
    argv: z.array(z.string().max(500)).max(32)
  }).strict(),
  exit: z.object({
    code: z.number().int().nullable(),
    signal: z.string().trim().min(1).max(40).nullable(),
    timedOut: z.boolean()
  }).strict(),
  timing: z.object({
    startedAt: timestampSchema,
    completedAt: timestampSchema,
    durationMs: z.number().int().nonnegative()
  }).strict(),
  output: z.object({
    stdoutText: z.string().max(65_536),
    stderrText: z.string().max(65_536),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean(),
    outputDigest: sha256DigestSchema
  }).strict()
}).strict();

export interface CreateSandboxLeaseInput {
  idempotencyKey: string;
  scopeId: string;
  workspaceSubpath: string;
  imageDigest: string;
  cpuLimit: number;
  memoryMb: number;
  diskMb: number;
  processLimit: number;
  ttlMs: number;
  networkPolicy: "deny_all";
  allowlistedHosts: [];
}

export interface ExecuteSandboxToolInput {
  leaseId: string;
  idempotencyKey: string;
  toolPackId: string;
  toolName: string;
  argv?: string[];
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export type SandboxExecutionEvidence = z.infer<typeof executionEvidenceSchema>;

export interface SandboxBackend {
  health(): Promise<{ ready: true }>;
  createLease(input: CreateSandboxLeaseInput): Promise<{ created: boolean; lease: SandboxLease }>;
  destroyLease(leaseId: string): Promise<SandboxLease>;
  reconcile(): Promise<{ destroyedLeaseIds: string[] }>;
  executeTool(input: ExecuteSandboxToolInput): Promise<SandboxExecutionEvidence>;
}

export class SandboxBackendError extends Error {
  constructor(message: string, public readonly statusCode: number | null = null) {
    super(message);
    this.name = "SandboxBackendError";
  }
}

export interface HttpSandboxBackendOptions {
  baseUrl: string;
  token: () => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SandboxBackendError("Sandbox broker URL is invalid.");
  }
  if (!["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash) {
    throw new SandboxBackendError("Sandbox broker URL must be an exact credential-free HTTP(S) origin.");
  }
  return url.origin;
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new SandboxBackendError("Sandbox broker response exceeds the configured limit.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new SandboxBackendError("Sandbox broker response exceeds the configured limit.");
  }
  return new TextDecoder().decode(bytes);
}

function parseBrokerResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SandboxBackendError("Sandbox broker returned an invalid response.");
  return parsed.data;
}

export class HttpSandboxBackend implements SandboxBackend {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: HttpSandboxBackendOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 256 * 1024;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 30_000) {
      throw new SandboxBackendError("Sandbox broker timeout must be between 100 and 30000 milliseconds.");
    }
    if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes < 1_024 || this.maxResponseBytes > 1_048_576) {
      throw new SandboxBackendError("Sandbox broker response limit is invalid.");
    }
  }

  private async request(path: string, init: RequestInit, authenticated = true): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        ...(init.body === undefined ? {} : { "content-type": "application/json" })
      };
      if (authenticated) {
        const token = (await this.options.token()).trim();
        if (!token) throw new SandboxBackendError("Sandbox broker token is unavailable.");
        headers.authorization = `Bearer ${token}`;
      }
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        redirect: "manual",
        signal: controller.signal
      });
      if (response.status >= 300 && response.status < 400) {
        throw new SandboxBackendError("Sandbox broker redirects are forbidden.", response.status);
      }
      const text = await boundedResponseText(response, this.maxResponseBytes);
      if (!response.ok) {
        throw new SandboxBackendError(`Sandbox broker request failed with status ${response.status}.`, response.status);
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new SandboxBackendError("Sandbox broker returned an invalid JSON response.", response.status);
      }
    } catch (error) {
      if (error instanceof SandboxBackendError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new SandboxBackendError("Sandbox broker request timed out.");
      }
      throw new SandboxBackendError("Sandbox broker request failed.");
    } finally {
      clearTimeout(timeout);
    }
  }

  async health(): Promise<{ ready: true }> {
    const health = parseBrokerResponse(healthSchema, await this.request("/health", { method: "GET" }, false));
    if (!health.ready) throw new SandboxBackendError("Sandbox broker isolation is not ready.", 503);
    return { ready: true };
  }

  async createLease(input: CreateSandboxLeaseInput): Promise<{ created: boolean; lease: SandboxLease }> {
    const result = parseBrokerResponse(leaseViewSchema, await this.request("/leases", {
      method: "POST",
      body: JSON.stringify(input)
    }));
    if (result.scopeId !== result.lease.scopeId) {
      throw new SandboxBackendError("Sandbox broker returned a mismatched lease scope.");
    }
    return { created: result.created, lease: result.lease };
  }

  async destroyLease(leaseId: string): Promise<SandboxLease> {
    const result = parseBrokerResponse(
      leaseViewSchema,
      await this.request(`/leases/${encodeURIComponent(leaseId)}`, { method: "DELETE" })
    );
    if (result.lease.id !== leaseId || result.lease.state !== "destroyed") {
      throw new SandboxBackendError("Sandbox broker returned a mismatched destroyed lease.");
    }
    return result.lease;
  }

  async reconcile(): Promise<{ destroyedLeaseIds: string[] }> {
    return parseBrokerResponse(
      z.object({ destroyedLeaseIds: z.array(z.string().uuid()).max(10_000) }).strict(),
      await this.request("/leases/reconcile", { method: "POST", body: "{}" })
    );
  }

  async executeTool(input: ExecuteSandboxToolInput): Promise<SandboxExecutionEvidence> {
    const { leaseId, ...body } = input;
    const evidence = parseBrokerResponse(
      executionEvidenceSchema,
      await this.request(`/leases/${encodeURIComponent(leaseId)}/runs`, {
        method: "POST",
        body: JSON.stringify(body)
      })
    );
    if (evidence.leaseId !== leaseId || evidence.toolPack.id !== input.toolPackId || evidence.tool.name !== input.toolName) {
      throw new SandboxBackendError("Sandbox broker returned mismatched execution evidence.");
    }
    return evidence;
  }
}
