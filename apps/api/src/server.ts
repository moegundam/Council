import argon2 from "argon2";
import { BullAgentTurnQueue } from "./agent-queue.js";
import { createApp } from "./app.js";
import {
  disposableE2eAgentQueueFromEnv,
  disposableE2eOwnerSeedFromEnv,
  disposableE2eTestLoginEnabledFromEnv
} from "./disposable-e2e-queue.js";
import {
  apiBindHostFromEnv,
  authDisabledFromEnv,
  goalRunAutonomyEnabledFromEnv,
  harnessActionAdapterEndpointAllowlistFromEnv,
  harnessActionAdapterRuntimeFromEnv,
  harnessTokenFromEnv,
  mcpArgumentEncryptionWriteEnabledFromEnv,
  mcpKeyedFingerprintWriteEnabledFromEnv,
  mcpLocalHostAllowlistFromEnv,
  ompRuntimeFromEnv,
  publicOriginFromEnv,
  secretVaultFromEnv,
  tailnetQuickLoginFromEnv
} from "./config.js";
import { MeetingEventBus } from "./event-bus.js";
import { registerApiObservability } from "./observability.js";
import { createApiShutdown } from "./server-lifecycle.js";
import {
  createPostgresPoolFromEnv,
  InMemoryPlatformStore,
  PostgresPlatformStore,
  type PlatformStore
} from "@council/database";
import { GuardedExternalExecutor } from "@council/domain";
import { HarnessMcpExecutorBackend } from "@council/runtime";

const production = process.env.NODE_ENV === "production";
const authDisabled = authDisabledFromEnv();
const publicOrigin = publicOriginFromEnv();
const tailnetQuickLogin = tailnetQuickLoginFromEnv();

let store: PlatformStore;
if (process.env.DATABASE_URL || process.env.PGHOST) {
  store = new PostgresPlatformStore(await createPostgresPoolFromEnv());
} else if (!production) {
  store = new InMemoryPlatformStore();
} else {
  throw new Error("Production requires PostgreSQL configuration.");
}

const disposableOwner = disposableE2eOwnerSeedFromEnv();
const disposableTestLoginEnabled = disposableE2eTestLoginEnabledFromEnv();
if (disposableOwner) {
  if (!(store instanceof InMemoryPlatformStore)) {
    throw new Error("Disposable E2E Owner seed requires the in-memory store.");
  }
  await store.createOwner(
    disposableOwner.email,
    await argon2.hash(disposableOwner.password, { type: argon2.argon2id })
  );
}

const eventBus = new MeetingEventBus(process.env.REDIS_URL);
const agentQueue = process.env.REDIS_URL
  ? new BullAgentTurnQueue(process.env.REDIS_URL)
  : disposableE2eAgentQueueFromEnv();
const secretVault = await secretVaultFromEnv();
const harnessEnabled = process.env.HARNESS_EXECUTOR_ENABLED === "true";
const harnessToken = harnessEnabled ? await harnessTokenFromEnv() : undefined;
const harnessBackend = harnessEnabled && harnessToken && process.env.HARNESS_MCP_URL
  ? new HarnessMcpExecutorBackend({ endpoint: process.env.HARNESS_MCP_URL, bearerToken: harnessToken })
  : undefined;
const externalExecutor = harnessEnabled && harnessBackend
  ? new GuardedExternalExecutor({
      enabled: true,
      allowedResourceIds: (process.env.HARNESS_ALLOWED_PIPELINES ?? "").split(",").map((value) => value.trim()).filter(Boolean)
    }, harnessBackend)
  : undefined;
const ompRuntime = ompRuntimeFromEnv();

const app = await createApp({
  store,
  authDisabled,
  ...(disposableOwner ? { rateLimitMax: 10_000 } : {}),
  ...(disposableTestLoginEnabled && disposableOwner ? { testLoginOwnerEmail: disposableOwner.email } : {}),
  ...(tailnetQuickLogin ? { tailnetQuickLogin } : {}),
  goalRunEnabled: goalRunAutonomyEnabledFromEnv(),
  ompRuntimeEnabled: ompRuntime.enabled,
  ompRuntime,
  harnessActionAdapterEndpointAllowlist: harnessActionAdapterEndpointAllowlistFromEnv(),
  actionAdapterRuntime: harnessActionAdapterRuntimeFromEnv(),
  secureCookies: production,
  allowedOrigin: publicOrigin,
  ...(secretVault ? { secretVault } : {}),
  mcpArgumentEncryptionWriteEnabled: mcpArgumentEncryptionWriteEnabledFromEnv(),
  mcpKeyedFingerprintWriteEnabled: mcpKeyedFingerprintWriteEnabledFromEnv(),
  harnessEnabled,
  eventBus,
  ...(agentQueue ? { agentQueue } : {}),
  ...(externalExecutor ? { externalExecutor } : {}),
  mcpLocalHostAllowlist: mcpLocalHostAllowlistFromEnv(),
  readinessCheck: async () => {
    await eventBus.ready();
    await agentQueue?.ready?.();
  }
});
registerApiObservability(app);

const port = Number(process.env.PORT ?? 4000);
await app.listen({ host: apiBindHostFromEnv(), port });

const shutdown = createApiShutdown([
  { name: "http-and-store", close: () => app.close() },
  { name: "event-bus", close: () => eventBus.close() },
  ...(agentQueue ? [{ name: "agent-queue", close: () => agentQueue.close() }] : [])
]);
const requestShutdown = () => {
  void shutdown().catch((error: unknown) => {
    app.log.error(
      error instanceof Error ? error.message : "API shutdown failed with an unknown error."
    );
    process.exit(1);
  });
};

process.once("SIGTERM", requestShutdown);
process.once("SIGINT", requestShutdown);
