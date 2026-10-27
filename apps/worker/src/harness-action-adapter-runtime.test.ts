import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertHarnessActionAdapterReadiness,
  MAX_HARNESS_READINESS_ADAPTERS,
  harnessActionAdapterHealthStatus,
  harnessActionAdapterRuntimeEnabledFromEnv
} from "./harness-action-adapter-runtime.js";

describe("Harness Action Adapter runtime gate", () => {
  it("is disabled unless the production flag is exactly true", () => {
    expect(harnessActionAdapterRuntimeEnabledFromEnv({})).toBe(false);
    expect(harnessActionAdapterRuntimeEnabledFromEnv({ HARNESS_ACTION_ADAPTER_ENABLED: "false" })).toBe(false);
    expect(harnessActionAdapterRuntimeEnabledFromEnv({ HARNESS_ACTION_ADAPTER_ENABLED: "TRUE" })).toBe(false);
  });

  it("reports readiness only when the Harness runtime is enabled and Worker intake is healthy", () => {
    expect(harnessActionAdapterHealthStatus({ enabled: false, workerReady: true })).toEqual({ status: "disabled" });
    expect(harnessActionAdapterHealthStatus({ enabled: true, workerReady: false })).toEqual({ status: "not_ready" });
    expect(harnessActionAdapterHealthStatus({ enabled: true, workerReady: true })).toEqual({ status: "ready" });
  });

  it("validates bounded persisted metadata without requiring a credentialed Adapter", () => {
    const adapter = {
      id: "adapter-1",
      enabled: true,
      credentialId: "credential-1",
      actions: [{ key: "deploy", targetIds: ["preview"] }]
    };

    expect(() => assertHarnessActionAdapterReadiness([adapter.id], [adapter])).not.toThrow();
    expect(() => assertHarnessActionAdapterReadiness(["missing"], [adapter])).toThrow(/unavailable/i);
    expect(() => assertHarnessActionAdapterReadiness([adapter.id], [{ ...adapter, credentialId: null }])).toThrow(/unavailable/i);
  });

  it("rejects oversized readiness requests before any per-Adapter work", () => {
    const adapterIds = Array.from({ length: MAX_HARNESS_READINESS_ADAPTERS + 1 }, (_, index) => `adapter-${index}`);
    expect(() => assertHarnessActionAdapterReadiness(adapterIds, [])).toThrow(/too large/i);
  });

  it("wires network readiness to metadata validation with no credentialed preview", () => {
    const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    const handler = source.slice(
      source.indexOf("healthServer = createServer"),
      source.indexOf("type ShutdownCompletion")
    );

    expect(handler).toContain("assertHarnessActionAdapterReadiness(adapterIds, adapters);");
    expect(handler).not.toContain(".preview(");
    expect(handler.indexOf("checks.push(store.listActionAdapters()"))
      .toBeLessThan(handler.indexOf("await withWorkerHealthCheckTimeout(Promise.all(checks));"));
  });
});
