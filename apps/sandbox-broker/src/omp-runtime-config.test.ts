import { describe, expect, it } from "vitest";
import { createOmpRuntimeBrokerFromEnv } from "./omp-runtime-config.js";

describe("OMP Runtime environment configuration", () => {
  it("is default-off and rejects ambiguous feature flag values", async () => {
    await expect(createOmpRuntimeBrokerFromEnv({}, true)).resolves.toBeUndefined();
    await expect(createOmpRuntimeBrokerFromEnv({ OMP_RUNTIME_ENABLED: "false" }, true)).resolves.toBeUndefined();
    await expect(createOmpRuntimeBrokerFromEnv({ OMP_RUNTIME_ENABLED: "yes" }, true)).rejects.toThrow();
  });

  it("fails closed before runtime creation when attestation or required settings are absent", async () => {
    await expect(createOmpRuntimeBrokerFromEnv({ OMP_RUNTIME_ENABLED: "true" }, false))
      .rejects.toThrow(/attestation/i);
    await expect(createOmpRuntimeBrokerFromEnv({ OMP_RUNTIME_ENABLED: "true" }, true))
      .rejects.toThrow(/OMP_ROOTLESS_DOCKER_HOST/);
  });

  it("keeps phase-two host tools and subagents unavailable", async () => {
    await expect(createOmpRuntimeBrokerFromEnv({
      OMP_RUNTIME_ENABLED: "true",
      OMP_HOST_TOOLS_ENABLED: "true"
    }, true)).rejects.toThrow(/phase-one/i);
    await expect(createOmpRuntimeBrokerFromEnv({
      OMP_RUNTIME_ENABLED: "true",
      OMP_SUBAGENTS_ENABLED: "true"
    }, true)).rejects.toThrow(/phase-one/i);
  });
});
