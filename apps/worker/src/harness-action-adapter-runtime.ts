export interface HarnessActionAdapterHealthInput {
  enabled: boolean;
  workerReady: boolean;
}

export type HarnessActionAdapterHealthStatus = { status: "disabled" | "not_ready" | "ready" };

export const MAX_HARNESS_READINESS_ADAPTERS = 12;

export interface HarnessReadinessAdapterMetadata {
  id: string;
  enabled: boolean;
  credentialId: string | null;
  actions: ReadonlyArray<{ key: string; targetIds: readonly string[] }>;
}

export function harnessActionAdapterRuntimeEnabledFromEnv(env: NodeJS.ProcessEnv): boolean {
  return env.HARNESS_ACTION_ADAPTER_ENABLED === "true";
}

export function harnessActionAdapterHealthStatus(input: HarnessActionAdapterHealthInput): HarnessActionAdapterHealthStatus {
  if (!input.enabled) return { status: "disabled" };
  return input.workerReady ? { status: "ready" } : { status: "not_ready" };
}

export function assertHarnessActionAdapterReadiness(
  adapterIds: readonly string[],
  adapters: readonly HarnessReadinessAdapterMetadata[]
): void {
  const requested = [...new Set(adapterIds)];
  if (requested.length > MAX_HARNESS_READINESS_ADAPTERS) {
    throw new Error("Harness Action Adapter readiness request is too large.");
  }
  for (const adapterId of requested) {
    const adapter = adapters.find((candidate) => candidate.id === adapterId);
    if (!adapter?.enabled
      || !adapter.credentialId
      || !adapter.actions.some((action) => action.key.length > 0 && action.targetIds.length > 0)) {
      throw new Error("Approved Harness Action Adapter metadata is unavailable for runtime readiness.");
    }
  }
}
