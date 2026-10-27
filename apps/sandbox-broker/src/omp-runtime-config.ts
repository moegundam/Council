import { z } from "zod";
import { createOmpRuntimeBroker, type OmpRuntimeBroker } from "./omp-runtime-broker.js";
import { RootlessDockerOmpRuntime } from "./rootless-docker-runtime.js";

const enabledSchema = z.enum(["true", "false"]);
const positiveInteger = (max: number) => z.coerce.number().int().positive().max(max);

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required when OMP Runtime is enabled.`);
  return value;
}

export async function createOmpRuntimeBrokerFromEnv(
  env: NodeJS.ProcessEnv,
  isolationAttested: boolean
): Promise<OmpRuntimeBroker | undefined> {
  const enabled = enabledSchema.parse(env.OMP_RUNTIME_ENABLED ?? "false") === "true";
  if (!enabled) return undefined;
  if (enabledSchema.parse(env.OMP_HOST_TOOLS_ENABLED ?? "false") === "true") {
    throw new Error("OMP Host Tools are unavailable in the phase-one release.");
  }
  if (enabledSchema.parse(env.OMP_SUBAGENTS_ENABLED ?? "false") === "true") {
    throw new Error("OMP subagents are unavailable in the phase-one release.");
  }
  if (!isolationAttested) throw new Error("OMP Runtime cannot start without a current isolation attestation.");
  const verificationCommand = env.OMP_VERIFICATION_COMMAND_JSON
    ? z.array(z.string().min(1).max(1_000)).min(1).max(32).parse(JSON.parse(env.OMP_VERIFICATION_COMMAND_JSON))
    : undefined;
  const runtime = new RootlessDockerOmpRuntime({
    dockerHost: required(env, "OMP_ROOTLESS_DOCKER_HOST"),
    imageReference: required(env, "OMP_RUNTIME_IMAGE_REFERENCE"),
    imageDigest: required(env, "OMP_RUNTIME_IMAGE_DIGEST"),
    internalNetwork: required(env, "OMP_INTERNAL_NETWORK"),
    modelGatewayContainer: required(env, "OMP_MODEL_GATEWAY_CONTAINER"),
    approvedModelBaseUrl: required(env, "OMP_MODEL_BASE_URL"),
    ...(verificationCommand ? { verificationCommand } : {})
  });
  const concurrency = z.coerce.number().int().min(1).max(2).parse(env.OMP_MAX_CONCURRENCY ?? "1") as 1 | 2;
  return createOmpRuntimeBroker({
    dataRoot: required(env, "OMP_BROKER_DATA_ROOT"),
    sourceRoot: required(env, "OMP_SOURCE_ROOT"),
    runtime,
    isolationAttested,
    maxConcurrency: concurrency,
    cpuLimit: positiveInteger(16).parse(env.OMP_CPU_LIMIT ?? "2"),
    memoryMb: positiveInteger(65_536).parse(env.OMP_MEMORY_MB ?? "8192"),
    processLimit: positiveInteger(4_096).parse(env.OMP_PROCESS_LIMIT ?? "256"),
    diskMb: positiveInteger(262_144).parse(env.OMP_DISK_MB ?? "8192")
  });
}
