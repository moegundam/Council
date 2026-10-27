import { describe, expect, it, vi } from "vitest";
import {
  mergeRoleDraftAfterConflict,
  roleCreateRequestPayload,
  shouldRetainRoleCreationRetryToken
} from "./settings-role-ui.js";
import { idempotencyRetryToken } from "./view-model.js";

const roleDraft = {
  name: "Security reviewer",
  usageContext: "Architecture review",
  responsibility: "Review security boundaries",
  speakingGuidance: "Lead with verified findings",
  decisionScope: "Security acceptance",
  constraints: "Do not infer missing evidence",
  templateKey: "security_reviewer" as const,
  toolPolicy: "agent_read_only_grants" as const,
  dataPolicy: "agent_declared_scope" as const
};

describe("Role settings mutation behavior", () => {
  it("uses every submitted Role create field in the idempotency signature", () => {
    const createKey = vi.fn()
      .mockReturnValueOnce("role-key-1")
      .mockReturnValueOnce("role-key-2");
    const payload = roleCreateRequestPayload(roleDraft);
    const first = idempotencyRetryToken(null, JSON.stringify(payload), createKey);

    expect(payload).toEqual(roleDraft);
    expect(idempotencyRetryToken(first, JSON.stringify(roleCreateRequestPayload(roleDraft)), createKey)).toBe(first);

    const changed = idempotencyRetryToken(
      first,
      JSON.stringify(roleCreateRequestPayload({ ...roleDraft, constraints: "Owner-approved evidence only" })),
      createKey
    );
    expect(changed).toEqual({ signature: JSON.stringify({ ...roleDraft, constraints: "Owner-approved evidence only" }), idempotencyKey: "role-key-2" });
  });

  it("retains a Role create key only for ambiguous network and server failures", () => {
    expect(shouldRetainRoleCreationRetryToken(null)).toBe(true);
    expect(shouldRetainRoleCreationRetryToken(500)).toBe(true);
    expect(shouldRetainRoleCreationRetryToken(503)).toBe(true);
    expect(shouldRetainRoleCreationRetryToken(400)).toBe(false);
    expect(shouldRetainRoleCreationRetryToken(409)).toBe(false);
  });

  it("merges non-overlapping Role edits and keeps the server value for true field conflicts", () => {
    const base = { name: "Reviewer", responsibility: "Review", constraints: "Read only" };
    const local = { ...base, responsibility: "Review architecture" };
    const latest = { ...base, name: "Security reviewer", responsibility: "Review security" };

    expect(mergeRoleDraftAfterConflict(base, local, latest)).toEqual({
      draft: {
        name: "Security reviewer",
        responsibility: "Review security",
        constraints: "Read only"
      },
      conflictingFields: ["responsibility"]
    });

    expect(mergeRoleDraftAfterConflict(base, { ...base, constraints: "No writes" }, latest)).toEqual({
      draft: { ...latest, constraints: "No writes" },
      conflictingFields: []
    });
  });
});
