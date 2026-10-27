import type { Credential, PromptVersion } from "@council/contracts";

export function credentialExpiryIso(value: FormDataEntryValue | null): string | null {
  const datetimeLocal = String(value ?? "").trim();
  return datetimeLocal ? new Date(datetimeLocal).toISOString() : null;
}

export interface ModelCredentialSubmission {
  credentialId?: string | null;
}

export function modelCredentialSubmission(
  selectedCredentialId: FormDataEntryValue | null,
  existingCredentialId?: string | null
): ModelCredentialSubmission {
  const isEdit = existingCredentialId !== undefined;
  if (isEdit && selectedCredentialId === null) return {};

  const credentialId = String(selectedCredentialId ?? "").trim() || null;
  return isEdit && credentialId === existingCredentialId ? {} : { credentialId };
}

export function selectableModelCredentials(credentials: readonly Credential[]): Credential[] {
  return credentials.filter((credential) => credential.status === "active");
}

export function promptVersionForEdit(
  versions: readonly PromptVersion[],
  currentVersion: number
): PromptVersion {
  const current = versions.find((version) => version.version === currentVersion);
  if (!current) throw new Error(`找不到目前的 Prompt 版本 v${currentVersion}，無法編輯。`);
  return current;
}

export function rebaseConnectorRevision<T extends { id: string; revision: number }>(
  editing: T,
  latest: T
): T {
  if (editing.id !== latest.id || latest.revision <= editing.revision) return editing;
  return { ...editing, revision: latest.revision };
}

function connectorFieldEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if ((Array.isArray(left) && Array.isArray(right))
    || (left !== null && right !== null && typeof left === "object" && typeof right === "object")) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return false;
}

export function changedConnectorFields<T extends object, Key extends keyof T>(
  opened: T,
  draft: T,
  fields: readonly Key[]
): Partial<Pick<T, Key>> {
  const changed: Partial<Pick<T, Key>> = {};
  for (const field of fields) {
    if (!connectorFieldEquals(opened[field], draft[field])) {
      (changed as Pick<T, Key>)[field] = draft[field];
    }
  }
  return changed;
}
