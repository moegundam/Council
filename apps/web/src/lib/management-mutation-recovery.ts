import { ApiError, isRevisionConflictError } from "./api";

export type ManagementMutationRetryDisposition = "retain" | "clear" | "refresh_then_confirm";

const uncertainClientStatuses = new Set([408, 425, 429]);

export function managementMutationRetryDisposition(cause: unknown): ManagementMutationRetryDisposition {
  if (isRevisionConflictError(cause)) return "refresh_then_confirm";
  if (!(cause instanceof ApiError)) return "retain";
  if (cause.status >= 500 || uncertainClientStatuses.has(cause.status)) return "retain";
  return "clear";
}
