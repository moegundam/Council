import type { Role } from "@council/contracts";

export type RoleCreateRequestPayload = Pick<
  Role,
  | "name"
  | "usageContext"
  | "responsibility"
  | "speakingGuidance"
  | "decisionScope"
  | "constraints"
  | "templateKey"
  | "toolPolicy"
  | "dataPolicy"
>;

export function roleCreateRequestPayload(draft: RoleCreateRequestPayload): RoleCreateRequestPayload {
  return {
    name: draft.name,
    usageContext: draft.usageContext,
    responsibility: draft.responsibility,
    speakingGuidance: draft.speakingGuidance,
    decisionScope: draft.decisionScope,
    constraints: draft.constraints,
    templateKey: draft.templateKey,
    toolPolicy: draft.toolPolicy,
    dataPolicy: draft.dataPolicy
  };
}

export function shouldRetainRoleCreationRetryToken(status: number | null): boolean {
  return status === null || status >= 500;
}

export function mergeRoleDraftAfterConflict<T extends Record<string, unknown>>(
  base: T,
  local: T,
  latest: T
): { draft: T; conflictingFields: Array<keyof T> } {
  const draft = { ...latest };
  const conflictingFields: Array<keyof T> = [];
  for (const field of Object.keys(base) as Array<keyof T>) {
    const localChanged = !Object.is(local[field], base[field]);
    const remoteChanged = !Object.is(latest[field], base[field]);
    if (!localChanged) continue;
    if (!remoteChanged || Object.is(local[field], latest[field])) {
      draft[field] = local[field];
      continue;
    }
    conflictingFields.push(field);
  }
  return { draft, conflictingFields };
}
