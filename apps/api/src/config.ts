import { readFile } from "node:fs/promises";
import { parseActionAdapterEndpointAllowlist, parseConnectorHostAllowlist, SecretVault } from "@council/domain";

export function apiBindHostFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.API_BIND_HOST;
  if (configured === undefined) return "127.0.0.1";
  const host = configured.trim();
  if (!host || !/^(?:[a-z0-9.-]+|\[[0-9a-f:]+\]|[0-9a-f:]+)$/i.test(host)) {
    throw new Error("API_BIND_HOST must be a hostname or IP address.");
  }
  return host;
}

export function authDisabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AUTH_DISABLED !== "true") return false;
  return env.NODE_ENV !== "production" || env.ALLOW_PRODUCTION_AUTH_BYPASS === "true";
}

export interface TailnetQuickLoginConfig {
  identity: string;
  ownerEmail: string;
}

export function tailnetQuickLoginFromEnv(env: NodeJS.ProcessEnv = process.env): TailnetQuickLoginConfig | undefined {
  const enabled = env.TAILNET_QUICK_LOGIN_ENABLED ?? "false";
  if (enabled !== "true" && enabled !== "false") {
    throw new Error("TAILNET_QUICK_LOGIN_ENABLED must be true or false.");
  }
  if (enabled === "false") return undefined;

  const identity = env.TAILNET_QUICK_LOGIN_IDENTITY?.trim().toLowerCase();
  if (!identity) throw new Error("TAILNET_QUICK_LOGIN_IDENTITY is required when Tailnet quick login is enabled.");
  if (identity.length > 254 || !/^[a-z0-9][a-z0-9@._+-]*$/.test(identity)) {
    throw new Error("TAILNET_QUICK_LOGIN_IDENTITY contains unsupported characters.");
  }

  const ownerEmail = env.TAILNET_QUICK_LOGIN_OWNER_EMAIL?.trim().toLowerCase();
  if (!ownerEmail) throw new Error("TAILNET_QUICK_LOGIN_OWNER_EMAIL is required when Tailnet quick login is enabled.");
  if (ownerEmail.length > 254 || !/^[a-z0-9][a-z0-9._+-]*@[a-z0-9.-]+\.[a-z]{2,}$/i.test(ownerEmail)) {
    throw new Error("TAILNET_QUICK_LOGIN_OWNER_EMAIL must be a valid Owner email address.");
  }

  return { identity, ownerEmail };
}

export function goalRunAutonomyEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.GOAL_RUN_AUTONOMY_ENABLED ?? (env.NODE_ENV === "production" ? "false" : "true");
  if (value !== "true" && value !== "false") {
    throw new Error("GOAL_RUN_AUTONOMY_ENABLED must be true or false.");
  }
  return value === "true";
}

export function ompRuntimeEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.OMP_RUNTIME_ENABLED ?? "false";
  if (value !== "true" && value !== "false") {
    throw new Error("OMP_RUNTIME_ENABLED must be true or false.");
  }
  return value === "true";
}

export function ompRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  sandboxProfileId?: string;
  sandboxImageDigest?: string;
  workspaceSourceId?: string;
  workspaceArchiveDigest?: string;
  hostToolsEnabled: boolean;
  check(): Promise<void>;
} {
  const enabled = ompRuntimeEnabledFromEnv(env);
  const hostTools = env.OMP_HOST_TOOLS_ENABLED ?? "false";
  if (hostTools !== "true" && hostTools !== "false") {
    throw new Error("OMP_HOST_TOOLS_ENABLED must be true or false.");
  }
  const subagents = env.OMP_SUBAGENTS_ENABLED ?? "false";
  if (subagents !== "true" && subagents !== "false") {
    throw new Error("OMP_SUBAGENTS_ENABLED must be true or false.");
  }
  if (hostTools === "true") throw new Error("OMP Host Tools are unavailable in the phase-one release.");
  if (subagents === "true") throw new Error("OMP subagents are unavailable in the phase-one release.");
  if (!enabled) {
    return {
      enabled: false,
      hostToolsEnabled: false,
      check: async () => { throw new Error("OMP Runtime is disabled."); }
    };
  }
  const sandboxProfileId = env.OMP_SANDBOX_PROFILE_ID?.trim();
  if (!sandboxProfileId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sandboxProfileId)) {
    throw new Error("OMP_SANDBOX_PROFILE_ID must be a UUID when OMP Runtime is enabled.");
  }
  const sandboxImageDigest = env.OMP_SANDBOX_IMAGE_DIGEST?.trim();
  if (!sandboxImageDigest || !/^sha256:[a-f0-9]{64}$/.test(sandboxImageDigest)) {
    throw new Error("OMP_SANDBOX_IMAGE_DIGEST must be a sha256 digest when OMP Runtime is enabled.");
  }
  const workspaceSourceId = env.OMP_WORKSPACE_SOURCE_ID?.trim();
  if (!workspaceSourceId || !/^[a-z0-9][a-z0-9._-]{0,119}$/.test(workspaceSourceId)) {
    throw new Error("OMP_WORKSPACE_SOURCE_ID must be a safe operator-managed source ID when OMP Runtime is enabled.");
  }
  const workspaceArchiveDigest = env.OMP_WORKSPACE_ARCHIVE_DIGEST?.trim();
  if (!workspaceArchiveDigest || !/^sha256:[a-f0-9]{64}$/.test(workspaceArchiveDigest)) {
    throw new Error("OMP_WORKSPACE_ARCHIVE_DIGEST must be a sha256 digest when OMP Runtime is enabled.");
  }
  return {
    enabled: true,
    sandboxProfileId,
    sandboxImageDigest,
    workspaceSourceId,
    workspaceArchiveDigest,
    hostToolsEnabled: false,
    check: async () => {
      const response = await fetch("http://worker:4102/health/omp-runtime", {
        redirect: "error",
        signal: AbortSignal.timeout(3_000)
      });
      if (!response.ok) throw new Error("OMP Worker and Sandbox Broker readiness check failed.");
    }
  };
}

export function harnessActionAdapterEndpointAllowlistFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    return parseActionAdapterEndpointAllowlist(env.HARNESS_ACTION_ADAPTER_ENDPOINT_ALLOWLIST);
  } catch {
    throw new Error("HARNESS_ACTION_ADAPTER_ENDPOINT_ALLOWLIST entries must be credential-free HTTP(S) URLs without query or fragment.");
  }
}

export function harnessActionAdapterRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; check: (adapterIds: readonly string[]) => Promise<void> } {
  const enabled = env.HARNESS_ACTION_ADAPTER_ENABLED === "true";
  return {
    enabled,
    check: async (adapterIds) => {
      if (!enabled) throw new Error("Harness Action Adapter runtime is disabled.");
      const endpoint = new URL("http://worker:4102/health/harness-action-adapter");
      for (const adapterId of adapterIds) endpoint.searchParams.append("adapterId", adapterId);
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(3_000) });
      if (!response.ok) throw new Error("Harness Action Adapter Worker readiness check failed.");
    }
  };
}

export function publicOriginFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PUBLIC_ORIGIN?.trim();
  if (!configured) {
    if (env.NODE_ENV === "production") {
      throw new Error("PUBLIC_ORIGIN is required in production.");
    }
    return "http://127.0.0.1:3000";
  }

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("PUBLIC_ORIGIN must be an HTTP(S) origin without credentials, path, query, or fragment.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash) {
    throw new Error("PUBLIC_ORIGIN must be an HTTP(S) origin without credentials, path, query, or fragment.");
  }
  return url.origin;
}

export function mcpLocalHostAllowlistFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseConnectorHostAllowlist(env.MCP_LOCAL_HOST_ALLOWLIST);
}

export function mcpArgumentEncryptionWriteEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.MCP_ARGUMENT_ENCRYPTION_WRITE_ENABLED ?? (env.NODE_ENV === "production" ? "true" : "false");
  if (value !== "true" && value !== "false") {
    throw new Error("MCP_ARGUMENT_ENCRYPTION_WRITE_ENABLED must be true or false.");
  }
  return value === "true";
}

export function mcpKeyedFingerprintWriteEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.MCP_KEYED_FINGERPRINT_WRITE_ENABLED ?? (env.NODE_ENV === "production" ? "true" : "false");
  if (value !== "true" && value !== "false") {
    throw new Error("MCP_KEYED_FINGERPRINT_WRITE_ENABLED must be true or false.");
  }
  return value === "true";
}

async function readRequiredSecret(file: string | undefined, label: string): Promise<string> {
  if (!file) throw new Error(`${label} secret file is not configured.`);
  return (await readFile(file, "utf8")).trim();
}

export async function secretVaultFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<SecretVault | undefined> {
  const file = env.APP_MASTER_KEY_FILE;
  if (!file && env.NODE_ENV !== "production") return undefined;
  const encoded = await readRequiredSecret(file, "Application master key");
  const key = Buffer.from(encoded, "base64");
  return new SecretVault(key);
}

export async function harnessTokenFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (!env.HARNESS_TOKEN_FILE) return undefined;
  return readRequiredSecret(env.HARNESS_TOKEN_FILE, "Harness token");
}
