import { defineConfig, devices } from "@playwright/test";
import {
  DISPOSABLE_E2E_MARKER,
  assertDisposableGatewayConfiguration
} from "./e2e/disposable-target.js";

const root = __dirname;
const disposable = assertDisposableGatewayConfiguration(process.env);
const reuseExistingServers = process.env.E2E_REUSE_EXISTING_SERVERS === "true";
const directNodeModules = process.env.E2E_DIRECT_NODE_MODULES === "true";
if (directNodeModules && reuseExistingServers) {
  throw new Error("Containerized disposable E2E cannot reuse existing servers.");
}
const disposableEnvironment = {
        E2E_DEPLOYMENT_CLASS: "disposable",
        E2E_DISPOSABLE_MARKER: DISPOSABLE_E2E_MARKER,
        E2E_OWNER_EMAIL: "owner@disposable.test",
        E2E_OWNER_PASSWORD: "disposable-owner-password",
        E2E_WEB_URL: disposable.webUrl.toString(),
  E2E_API_URL: disposable.apiUrl.toString(),
  E2E_APP_UPSTREAM_URL: disposable.appUrl.toString(),
  SMOKE_DEPLOYMENT_CLASS: "disposable"
};

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.pw.ts",
  globalTeardown: "./e2e/disposable-global-teardown.ts",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? "/tmp/council-playwright-results",
  reporter: [["line"]],
  use: {
    baseURL: disposable.webUrl.origin,
    serviceWorkers: "block",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off"
  },
  projects: [{
    name: "chromium-disposable",
    use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }
  }],
  webServer: [
    {
      command: directNodeModules
        ? "NODE_OPTIONS=--conditions=development node node_modules/tsx/dist/cli.mjs apps/api/src/server.ts"
        : "corepack pnpm@11.7.0 --filter @council/api dev",
      cwd: root,
      env: {
        ...disposableEnvironment,
        AUTH_DISABLED: "true",
        TEST_LOGIN_ENABLED: "true",
        GOAL_RUN_AUTONOMY_ENABLED: "true",
        NODE_ENV: "development",
        PUBLIC_ORIGIN: disposable.webUrl.origin,
        PORT: disposable.apiUrl.port
      },
      url: new URL("/api/health/ready", disposable.apiUrl).toString(),
      reuseExistingServer: reuseExistingServers,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe"
    },
    {
      command: "bash e2e/start-disposable-standalone-web.sh",
      cwd: root,
      env: {
        ...disposableEnvironment,
        NODE_ENV: "production",
        HOSTNAME: disposable.appUrl.hostname,
        PORT: disposable.appUrl.port,
        NEXT_TELEMETRY_DISABLED: "1",
        E2E_STANDALONE_ROOT: `/tmp/council-e2e-standalone-${disposable.appUrl.port}`
      },
      url: disposable.appUrl.toString(),
      reuseExistingServer: reuseExistingServers,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe"
    },
    {
      command: directNodeModules
        ? "node node_modules/tsx/dist/cli.mjs e2e/disposable-gateway.ts"
        : "corepack pnpm@11.7.0 exec tsx e2e/disposable-gateway.ts",
      cwd: root,
      env: disposableEnvironment,
      url: new URL("/__e2e_ready", disposable.webUrl).toString(),
      reuseExistingServer: reuseExistingServers,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe"
    }
  ]
});
