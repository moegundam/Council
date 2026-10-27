import { describe, expect, it } from "vitest";
import { idempotencyRetryToken } from "./view-model";
import {
  mergeTaxonomyConflictDraft,
  taxonomyCreateRequestSignature,
  taxonomyDraftHasChanges,
  type TaxonomyDraft
} from "./taxonomy-manager-ui";

const baseline: TaxonomyDraft = {
  name: "Planning",
  groupId: "group-1",
  color: "green"
};

describe("taxonomyDraftHasChanges", () => {
  it("compares only the fields owned by the active taxonomy mode", () => {
    expect(taxonomyDraftHasChanges("group", baseline, { ...baseline, groupId: "group-2", color: "red" })).toBe(false);
    expect(taxonomyDraftHasChanges("group", baseline, { ...baseline, name: "Delivery" })).toBe(true);

    expect(taxonomyDraftHasChanges("category", baseline, { ...baseline, color: "red" })).toBe(false);
    expect(taxonomyDraftHasChanges("category", baseline, { ...baseline, groupId: "group-2" })).toBe(true);
    expect(taxonomyDraftHasChanges("category", baseline, { ...baseline, name: "Delivery" })).toBe(true);

    expect(taxonomyDraftHasChanges("tag", baseline, { ...baseline, groupId: "group-2" })).toBe(false);
    expect(taxonomyDraftHasChanges("tag", baseline, { ...baseline, color: "red" })).toBe(true);
    expect(taxonomyDraftHasChanges("tag", baseline, { ...baseline, name: "Delivery" })).toBe(true);
  });
});

describe("mergeTaxonomyConflictDraft", () => {
  it("keeps local Category edits while adopting a concurrent Group change", () => {
    expect(mergeTaxonomyConflictDraft(
      "category",
      baseline,
      { ...baseline, name: "Local name" },
      { ...baseline, groupId: "group-2" }
    )).toEqual({
      draft: { ...baseline, name: "Local name", groupId: "group-2" },
      conflictingFields: []
    });
  });

  it("keeps local Tag edits while adopting a concurrent color change", () => {
    expect(mergeTaxonomyConflictDraft(
      "tag",
      baseline,
      { ...baseline, name: "Local tag" },
      { ...baseline, color: "red" }
    )).toEqual({
      draft: { ...baseline, name: "Local tag", color: "red" },
      conflictingFields: []
    });
  });

  it("reports a same-field conflict while retaining the local value for explicit retry", () => {
    expect(mergeTaxonomyConflictDraft(
      "group",
      baseline,
      { ...baseline, name: "Local name" },
      { ...baseline, name: "Remote name" }
    )).toEqual({
      draft: { ...baseline, name: "Local name" },
      conflictingFields: ["name"]
    });
  });
});

describe("taxonomyCreateRequestSignature", () => {
  it("owns a retry key by the exact create payload and mode", () => {
    let keySequence = 0;
    const createKey = () => `key-${++keySequence}`;
    const groupSignature = taxonomyCreateRequestSignature("group", baseline);
    const first = idempotencyRetryToken(null, groupSignature, createKey);

    expect(taxonomyCreateRequestSignature("group", { ...baseline, groupId: "ignored", color: "red" })).toBe(groupSignature);
    expect(idempotencyRetryToken(first, groupSignature, createKey)).toBe(first);

    const changedPayload = idempotencyRetryToken(
      first,
      taxonomyCreateRequestSignature("group", { ...baseline, name: "Delivery" }),
      createKey
    );
    expect(changedPayload.idempotencyKey).toBe("key-2");

    const changedMode = idempotencyRetryToken(
      first,
      taxonomyCreateRequestSignature("category", baseline),
      createKey
    );
    expect(changedMode.idempotencyKey).toBe("key-3");
  });

  it("changes when any field sent by Category or Tag creation changes", () => {
    const categorySignature = taxonomyCreateRequestSignature("category", baseline);
    expect(taxonomyCreateRequestSignature("category", { ...baseline, groupId: "group-2" })).not.toBe(categorySignature);
    expect(taxonomyCreateRequestSignature("category", { ...baseline, name: "Delivery" })).not.toBe(categorySignature);
    expect(taxonomyCreateRequestSignature("category", { ...baseline, color: "red" })).toBe(categorySignature);

    const tagSignature = taxonomyCreateRequestSignature("tag", baseline);
    expect(taxonomyCreateRequestSignature("tag", { ...baseline, color: "red" })).not.toBe(tagSignature);
    expect(taxonomyCreateRequestSignature("tag", { ...baseline, name: "Delivery" })).not.toBe(tagSignature);
    expect(taxonomyCreateRequestSignature("tag", { ...baseline, groupId: "group-2" })).toBe(tagSignature);
  });
});
