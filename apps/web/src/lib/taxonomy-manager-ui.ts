import type { Tag } from "@council/contracts";

export type TaxonomyMode = "group" | "category" | "tag";

export interface TaxonomyDraft {
  name: string;
  groupId: string;
  color: Tag["color"];
}

export type TaxonomyConflictField = keyof TaxonomyDraft;

export function emptyTaxonomyDraft(groupId = ""): TaxonomyDraft {
  return { name: "", groupId, color: "green" };
}

function taxonomyRequestPayload(mode: TaxonomyMode, draft: TaxonomyDraft) {
  if (mode === "group") return { name: draft.name };
  if (mode === "category") return { groupId: draft.groupId, name: draft.name };
  return { name: draft.name, color: draft.color };
}

export function taxonomyDraftHasChanges(
  mode: TaxonomyMode,
  baseline: TaxonomyDraft,
  draft: TaxonomyDraft
): boolean {
  return JSON.stringify(taxonomyRequestPayload(mode, baseline)) !== JSON.stringify(taxonomyRequestPayload(mode, draft));
}

export function mergeTaxonomyConflictDraft(
  mode: TaxonomyMode,
  baseline: TaxonomyDraft,
  local: TaxonomyDraft,
  latest: TaxonomyDraft
): { draft: TaxonomyDraft; conflictingFields: TaxonomyConflictField[] } {
  const draft = { ...local };
  const conflictingFields: TaxonomyConflictField[] = [];
  const mergeField = <Field extends TaxonomyConflictField>(field: Field) => {
    const localChanged = local[field] !== baseline[field];
    const remoteChanged = latest[field] !== baseline[field];
    if (!localChanged) draft[field] = latest[field];
    else if (remoteChanged && local[field] !== latest[field]) conflictingFields.push(field);
  };

  mergeField("name");
  if (mode === "category") mergeField("groupId");
  if (mode === "tag") mergeField("color");
  return { draft, conflictingFields };
}

export function taxonomyCreateRequestSignature(mode: TaxonomyMode, draft: TaxonomyDraft): string {
  return JSON.stringify({ method: "POST", mode, payload: taxonomyRequestPayload(mode, draft) });
}
