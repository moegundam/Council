export type ModelLocation = "cloud" | "local";

export interface ModelRoute {
  connectorId: string;
  location: ModelLocation;
}

export interface ModelFallbackPolicy {
  primary: ModelRoute;
  fallback?: ModelRoute;
  allowCloudFallback: boolean;
}

export function selectFallback(policy: ModelFallbackPolicy): ModelRoute | null {
  if (!policy.fallback) return null;
  if (policy.fallback.location === "cloud" && !policy.allowCloudFallback) return null;
  return policy.fallback;
}
