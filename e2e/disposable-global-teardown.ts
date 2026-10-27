import { rm } from "node:fs/promises";
import { assertDisposableGatewayConfiguration } from "./disposable-target.js";

export function ownsDisposableWebServer(environment: NodeJS.ProcessEnv): boolean {
  return environment.E2E_REUSE_EXISTING_SERVERS !== "true";
}

export default async function disposableGlobalTeardown(): Promise<void> {
  if (!ownsDisposableWebServer(process.env)) return;
  const disposable = assertDisposableGatewayConfiguration(process.env);
  const stage = `/tmp/council-e2e-standalone-${disposable.appUrl.port}`;
  await rm(stage, { recursive: true, force: true });
}
