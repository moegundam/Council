import { describe, expect, it } from "vitest";
import {
  apiBindHostFromEnv,
  authDisabledFromEnv,
  goalRunAutonomyEnabledFromEnv,
  harnessActionAdapterEndpointAllowlistFromEnv,
  harnessActionAdapterRuntimeFromEnv,
  mcpArgumentEncryptionWriteEnabledFromEnv,
  mcpKeyedFingerprintWriteEnabledFromEnv,
  mcpLocalHostAllowlistFromEnv,
  ompRuntimeFromEnv,
  publicOriginFromEnv,
  tailnetQuickLoginFromEnv
} from "./config.js";

describe("API network binding", () => {
  it("binds development to loopback unless explicitly configured", () => {
    expect(apiBindHostFromEnv({ NODE_ENV: "development" })).toBe("127.0.0.1");
    expect(apiBindHostFromEnv({ NODE_ENV: "production" })).toBe("127.0.0.1");
    expect(apiBindHostFromEnv({ API_BIND_HOST: "0.0.0.0" })).toBe("0.0.0.0");
  });

  it("rejects whitespace and malformed hosts", () => {
    expect(() => apiBindHostFromEnv({ API_BIND_HOST: "" })).toThrow(/API_BIND_HOST/i);
    expect(() => apiBindHostFromEnv({ API_BIND_HOST: "host name" })).toThrow(/API_BIND_HOST/i);
  });
});

describe("authentication configuration", () => {
  it("allows the ordinary auth switch outside production", () => {
    expect(authDisabledFromEnv({ NODE_ENV: "development", AUTH_DISABLED: "true" })).toBe(true);
  });

  it("requires an explicit production bypass acknowledgement", () => {
    expect(authDisabledFromEnv({ NODE_ENV: "production", AUTH_DISABLED: "true" })).toBe(false);
    expect(authDisabledFromEnv({
      NODE_ENV: "production",
      AUTH_DISABLED: "true",
      ALLOW_PRODUCTION_AUTH_BYPASS: "true"
    })).toBe(true);
  });

  it("does not bypass authentication from the acknowledgement alone", () => {
    expect(authDisabledFromEnv({
      NODE_ENV: "production",
      ALLOW_PRODUCTION_AUTH_BYPASS: "true"
    })).toBe(false);
  });

  it("keeps Tailnet quick login disabled unless explicitly configured", () => {
    expect(tailnetQuickLoginFromEnv({})).toBeUndefined();
    expect(tailnetQuickLoginFromEnv({ TAILNET_QUICK_LOGIN_ENABLED: "false" })).toBeUndefined();
    expect(() => tailnetQuickLoginFromEnv({ TAILNET_QUICK_LOGIN_ENABLED: "yes" })).toThrow(/true or false/i);
  });

  it("requires and normalizes the Tailnet identity and Owner email", () => {
    expect(tailnetQuickLoginFromEnv({
      TAILNET_QUICK_LOGIN_ENABLED: "true",
      TAILNET_QUICK_LOGIN_IDENTITY: " Owner@Tailnet.Example ",
      TAILNET_QUICK_LOGIN_OWNER_EMAIL: " Owner@Council.Example "
    })).toEqual({
      identity: "owner@tailnet.example",
      ownerEmail: "owner@council.example"
    });
    expect(() => tailnetQuickLoginFromEnv({
      TAILNET_QUICK_LOGIN_ENABLED: "true",
      TAILNET_QUICK_LOGIN_OWNER_EMAIL: "owner@council.example"
    })).toThrow(/TAILNET_QUICK_LOGIN_IDENTITY.*required/i);
    expect(() => tailnetQuickLoginFromEnv({
      TAILNET_QUICK_LOGIN_ENABLED: "true",
      TAILNET_QUICK_LOGIN_IDENTITY: "owner@tailnet.example"
    })).toThrow(/TAILNET_QUICK_LOGIN_OWNER_EMAIL.*required/i);
    expect(() => tailnetQuickLoginFromEnv({
      TAILNET_QUICK_LOGIN_ENABLED: "true",
      TAILNET_QUICK_LOGIN_IDENTITY: "owner'@tailnet.example",
      TAILNET_QUICK_LOGIN_OWNER_EMAIL: "owner@council.example"
    })).toThrow(/supported characters/i);
  });
});

describe("Goal Run autonomy rollout", () => {
  it("defaults off in production and on outside production", () => {
    expect(goalRunAutonomyEnabledFromEnv({ NODE_ENV: "production" })).toBe(false);
    expect(goalRunAutonomyEnabledFromEnv({ NODE_ENV: "development" })).toBe(true);
  });

  it("requires a strict explicit boolean", () => {
    expect(goalRunAutonomyEnabledFromEnv({ NODE_ENV: "production", GOAL_RUN_AUTONOMY_ENABLED: "true" })).toBe(true);
    expect(goalRunAutonomyEnabledFromEnv({ NODE_ENV: "development", GOAL_RUN_AUTONOMY_ENABLED: "false" })).toBe(false);
    expect(() => goalRunAutonomyEnabledFromEnv({ GOAL_RUN_AUTONOMY_ENABLED: "yes" })).toThrow(/true or false/i);
  });
});

describe("OMP Runtime rollout", () => {
  const valid = {
    OMP_RUNTIME_ENABLED: "true",
    OMP_SANDBOX_PROFILE_ID: "70000000-0000-4000-8000-000000000001",
    OMP_SANDBOX_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
    OMP_WORKSPACE_SOURCE_ID: "council-canary",
    OMP_WORKSPACE_ARCHIVE_DIGEST: `sha256:${"b".repeat(64)}`
  };

  it("defaults disabled without requiring operator bindings", () => {
    expect(ompRuntimeFromEnv({})).toMatchObject({ enabled: false, hostToolsEnabled: false });
  });

  it("requires immutable Sandbox and workspace source bindings when enabled", () => {
    expect(() => ompRuntimeFromEnv({ OMP_RUNTIME_ENABLED: "true" })).toThrow(/SANDBOX_PROFILE_ID/i);
    expect(() => ompRuntimeFromEnv({ ...valid, OMP_WORKSPACE_ARCHIVE_DIGEST: "latest" })).toThrow(/sha256/i);
    expect(ompRuntimeFromEnv(valid)).toMatchObject({
      enabled: true,
      sandboxProfileId: valid.OMP_SANDBOX_PROFILE_ID,
      sandboxImageDigest: valid.OMP_SANDBOX_IMAGE_DIGEST,
      workspaceSourceId: valid.OMP_WORKSPACE_SOURCE_ID,
      workspaceArchiveDigest: valid.OMP_WORKSPACE_ARCHIVE_DIGEST,
      hostToolsEnabled: false
    });
  });

  it("accepts only strict feature booleans", () => {
    expect(() => ompRuntimeFromEnv({ ...valid, OMP_HOST_TOOLS_ENABLED: "yes" })).toThrow(/true or false/i);
    expect(() => ompRuntimeFromEnv({ ...valid, OMP_SUBAGENTS_ENABLED: "yes" })).toThrow(/true or false/i);
    expect(() => ompRuntimeFromEnv({ ...valid, OMP_HOST_TOOLS_ENABLED: "true" })).toThrow(/phase-one/i);
    expect(() => ompRuntimeFromEnv({ ...valid, OMP_SUBAGENTS_ENABLED: "true" })).toThrow(/phase-one/i);
    expect(() => ompRuntimeFromEnv({ OMP_RUNTIME_ENABLED: "yes" })).toThrow(/true or false/i);
  });
});

describe("Harness Action Adapter rollout", () => {
  it("defaults disabled and keeps the Worker readiness probe fixed", () => {
    expect(harnessActionAdapterRuntimeFromEnv({}).enabled).toBe(false);
    expect(harnessActionAdapterRuntimeFromEnv({ HARNESS_ACTION_ADAPTER_ENABLED: "true" }).enabled).toBe(true);
  });

  it("accepts only explicit credential-free HTTP(S) endpoint allowlist entries", () => {
    expect(harnessActionAdapterEndpointAllowlistFromEnv({
      HARNESS_ACTION_ADAPTER_ENDPOINT_ALLOWLIST: "https://harness.example.test/mcp,http://harness.internal/mcp"
    })).toEqual(["https://harness.example.test/mcp", "http://harness.internal/mcp"]);
    expect(() => harnessActionAdapterEndpointAllowlistFromEnv({
      HARNESS_ACTION_ADAPTER_ENDPOINT_ALLOWLIST: "https://token@example.test/mcp"
    })).toThrow(/credential-free HTTP\(S\)/i);
  });
});

describe("public origin configuration", () => {
  it("fails closed when production has no explicit public origin", () => {
    expect(() => publicOriginFromEnv({ NODE_ENV: "production" })).toThrow(/PUBLIC_ORIGIN.*required/i);
    expect(() => publicOriginFromEnv({ NODE_ENV: "production", PUBLIC_ORIGIN: "   " })).toThrow(/PUBLIC_ORIGIN.*required/i);
  });

  it("uses a local development origin and normalizes an explicit origin", () => {
    expect(publicOriginFromEnv({ NODE_ENV: "development" })).toBe("http://127.0.0.1:3000");
    expect(publicOriginFromEnv({ PUBLIC_ORIGIN: " https://Council.Example:8444/ " })).toBe("https://council.example:8444");
  });

  it("rejects non-HTTP origins and values with credentials or URL components", () => {
    for (const value of [
      "file:///tmp/council",
      "https://owner:secret@council.example",
      "https://council.example/app",
      "https://council.example?tenant=owner",
      "https://council.example#owner"
    ]) {
      expect(() => publicOriginFromEnv({ PUBLIC_ORIGIN: value })).toThrow(/PUBLIC_ORIGIN.*origin/i);
    }
  });
});

describe("MCP local host configuration", () => {
  it("fails closed without an allowlist and normalizes explicit hosts", () => {
    expect(mcpLocalHostAllowlistFromEnv({})).toEqual([]);
    expect(mcpLocalHostAllowlistFromEnv({
      MCP_LOCAL_HOST_ALLOWLIST: "mcp-readonly,MCP.INTERNAL.,mcp-readonly"
    })).toEqual(["mcp-readonly", "mcp.internal"]);
  });

  it("rejects URL-shaped allowlist entries", () => {
    expect(() => mcpLocalHostAllowlistFromEnv({
      MCP_LOCAL_HOST_ALLOWLIST: "http://mcp-readonly:4100"
    })).toThrow(/hostnames|IP addresses/i);
  });
});

describe("MCP argument encryption rollout", () => {
  it("defaults encryption writes on in production and off in development", () => {
    expect(mcpArgumentEncryptionWriteEnabledFromEnv({ NODE_ENV: "production" })).toBe(true);
    expect(mcpArgumentEncryptionWriteEnabledFromEnv({ NODE_ENV: "development" })).toBe(false);
    expect(mcpArgumentEncryptionWriteEnabledFromEnv({
      NODE_ENV: "production",
      MCP_ARGUMENT_ENCRYPTION_WRITE_ENABLED: "false"
    })).toBe(false);
    expect(mcpArgumentEncryptionWriteEnabledFromEnv({ MCP_ARGUMENT_ENCRYPTION_WRITE_ENABLED: "true" })).toBe(true);
    expect(() => mcpArgumentEncryptionWriteEnabledFromEnv({ MCP_ARGUMENT_ENCRYPTION_WRITE_ENABLED: "yes" })).toThrow(/true or false/i);
  });

  it("defaults keyed fingerprint writes on in production and off in development", () => {
    expect(mcpKeyedFingerprintWriteEnabledFromEnv({ NODE_ENV: "production" })).toBe(true);
    expect(mcpKeyedFingerprintWriteEnabledFromEnv({ NODE_ENV: "development" })).toBe(false);
    expect(mcpKeyedFingerprintWriteEnabledFromEnv({
      NODE_ENV: "production",
      MCP_KEYED_FINGERPRINT_WRITE_ENABLED: "false"
    })).toBe(false);
    expect(mcpKeyedFingerprintWriteEnabledFromEnv({ MCP_KEYED_FINGERPRINT_WRITE_ENABLED: "true" })).toBe(true);
    expect(() => mcpKeyedFingerprintWriteEnabledFromEnv({ MCP_KEYED_FINGERPRINT_WRITE_ENABLED: "yes" })).toThrow(/true or false/i);
  });
});
