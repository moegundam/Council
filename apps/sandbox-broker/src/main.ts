import { readFile } from "node:fs/promises";
import { createBrokerServer } from "./server.js";
import { createSandboxBroker, exactSourceAddressAuthorizer } from "./sandbox-broker.js";
import { createToolPackRegistry, type RegisteredToolPackManifestInput } from "./tool-pack-registry.js";
import { readExecutionIsolationAttestation } from "./isolation-attestation.js";
import { createOmpRuntimeBrokerFromEnv } from "./omp-runtime-config.js";

function readRequired(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main(): Promise<void> {
  const host = process.env.SANDBOX_BROKER_BIND_HOST ?? "127.0.0.1";
  const port = Number.parseInt(process.env.SANDBOX_BROKER_PORT ?? "8080", 10);
  const authToken = (await readFile(readRequired("SANDBOX_BROKER_TOKEN_FILE"), "utf8")).trim();
  if (!authToken) throw new Error("SANDBOX_BROKER_TOKEN_FILE must contain a token.");
  const workspaceRoot = readRequired("SANDBOX_BROKER_WORKSPACE_ROOT");
  const allowedSourceAddresses = (process.env.SANDBOX_BROKER_ALLOWED_SOURCE_ADDRESSES ?? "127.0.0.1,::1")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const manifests = JSON.parse(process.env.SANDBOX_BROKER_TOOL_PACKS_JSON ?? "[]") as RegisteredToolPackManifestInput[];
  await readExecutionIsolationAttestation(
    readRequired("SANDBOX_BROKER_EXECUTION_ISOLATION_ATTESTATION_FILE"),
    readRequired("SANDBOX_BROKER_IMAGE_DIGEST")
  );
  const broker = await createSandboxBroker({
    workspaceRoot,
    authToken,
    authorizeSourceAddress: exactSourceAddressAuthorizer(allowedSourceAddresses),
    executionIsolationAttested: true,
    toolPackRegistry: await createToolPackRegistry(manifests)
  });
  const ompRuntime = await createOmpRuntimeBrokerFromEnv(process.env, true);
  const server = createBrokerServer({ broker, authToken, ...(ompRuntime ? { ompRuntime } : {}) });
  await new Promise<void>((resolve, reject) => server.listen(port, host, (error?: Error) => error ? reject(error) : resolve()));
}

void main();
