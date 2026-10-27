import type { PlatformSnapshot } from "@council/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryPlatformStore } from "@council/database";
import { createApp } from "./app.js";

class CountingLifecycleAuditStore extends InMemoryPlatformStore {
  readonly lifecycleAuditCount = new Map<string, number>();

  constructor(seed?: PlatformSnapshot) {
    super(seed);
  }

  override async recordAudit(
    event: string,
    entityType: string,
    entityId: string,
    detail: Record<string, unknown> = {}
  ): Promise<void> {
    if (["role.deleted", "skill.revoked", "credential.status.changed"].includes(event)) {
      this.lifecycleAuditCount.set(event, (this.lifecycleAuditCount.get(event) ?? 0) + 1);
    }
    return super.recordAudit(event, entityType, entityId, detail);
  }
}

async function preparedStore() {
  const store = new CountingLifecycleAuditStore();
  const role = await store.createRole({
    name: "Lifecycle retry Role",
    usageContext: "Exercise delete recovery.",
    responsibility: "Remain independently deletable.",
    speakingGuidance: "State the bounded result.",
    decisionScope: "No unrelated decisions.",
    constraints: "No Meeting or Team references.",
    templateKey: null,
    toolPolicy: "none",
    dataPolicy: "meeting_only"
  });
  const skill = await store.createSkill({
    name: "Lifecycle retry Skill",
    version: "1.0.0",
    instructions: "Exercise revocation recovery.",
    source: "internal",
    owner: "Platform Owner"
  });
  const validated = await store.validateSkill(skill.id, {
    result: "passed",
    summary: "Validated for lifecycle retry tests.",
    expectedCheckedAt: null
  });
  const approvedSkill = await store.setSkillStatus(skill.id, {
    status: "approved",
    expectedCheckedAt: validated.validation.checkedAt
  });
  const credential = await store.createCredential({
    name: "Lifecycle retry Credential",
    provider: "test-provider",
    kind: "api_key",
    location: "cloud",
    expiresAt: null
  });
  return { store, role, skill: approvedSkill, credential };
}

describe("management lifecycle mutation idempotency", () => {
  it("requires a caller-owned key before every irreversible lifecycle mutation", async () => {
    const { store, role, skill, credential } = await preparedStore();
    const app = await createApp({ store, authDisabled: true });

    try {
      const roleResponse = await app.inject({
        method: "DELETE",
        url: `/api/roles/${role.id}`,
        payload: { expectedCurrentVersion: role.version }
      });
      const skillResponse = await app.inject({
        method: "POST",
        url: `/api/skills/${skill.id}/revoke`,
        payload: { reason: "Superseded by a reviewed Skill." }
      });
      const credentialResponse = await app.inject({
        method: "PATCH",
        url: `/api/credentials/${credential.id}/status`,
        payload: { status: "disabled", expectedUpdatedAt: credential.updatedAt }
      });

      for (const response of [roleResponse, skillResponse, credentialResponse]) {
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
      }
      const snapshot = await store.getSnapshot();
      expect(snapshot.roles.find((item) => item.id === role.id)?.deletedAt).toBeNull();
      expect(snapshot.skills.find((item) => item.id === skill.id)?.status).toBe("approved");
      expect(snapshot.credentials?.find((item) => item.id === credential.id)?.status).toBe("active");
    } finally {
      await app.close();
    }
  });

  it("replays canonical lifecycle results and conflicts when the caller key changes intent", async () => {
    const { store, role, skill, credential } = await preparedStore();
    const app = await createApp({ store, authDisabled: true });

    try {
      const roleRequest = {
        method: "DELETE" as const,
        url: `/api/roles/${role.id}`,
        headers: { "idempotency-key": "role-delete-retry" },
        payload: { expectedCurrentVersion: role.version }
      };
      const firstRole = await app.inject(roleRequest);
      const replayedRole = await app.inject(roleRequest);
      const changedRole = await app.inject({
        ...roleRequest,
        payload: { expectedCurrentVersion: role.version + 1 }
      });

      expect(firstRole.statusCode).toBe(200);
      expect(replayedRole.json()).toEqual(firstRole.json());
      expect(changedRole.statusCode).toBe(409);
      expect(changedRole.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });

      const skillRequest = {
        method: "POST" as const,
        url: `/api/skills/${skill.id}/revoke`,
        headers: { "idempotency-key": "skill-revoke-retry" },
        payload: { reason: "Superseded by a reviewed Skill." }
      };
      const firstSkill = await app.inject(skillRequest);
      const replayedSkill = await app.inject(skillRequest);
      const changedSkill = await app.inject({
        ...skillRequest,
        payload: { reason: "Changed revocation intent." }
      });

      expect(firstSkill.statusCode).toBe(200);
      expect(replayedSkill.json()).toEqual(firstSkill.json());
      expect(changedSkill.statusCode).toBe(409);
      expect(changedSkill.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });

      const credentialRequest = {
        method: "PATCH" as const,
        url: `/api/credentials/${credential.id}/status`,
        headers: { "idempotency-key": "credential-status-retry" },
        payload: { status: "disabled" as const, expectedUpdatedAt: credential.updatedAt }
      };
      const firstCredential = await app.inject(credentialRequest);
      const replayedCredential = await app.inject(credentialRequest);
      const changedCredential = await app.inject({
        ...credentialRequest,
        payload: { status: "revoked" as const, expectedUpdatedAt: credential.updatedAt }
      });

      expect(firstCredential.statusCode).toBe(200);
      expect(replayedCredential.json()).toEqual(firstCredential.json());
      expect(changedCredential.statusCode).toBe(409);
      expect(changedCredential.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });
      expect(store.lifecycleAuditCount.get("role.deleted")).toBe(1);
      expect(store.lifecycleAuditCount.get("skill.revoked")).toBe(1);
      expect(store.lifecycleAuditCount.get("credential.status.changed")).toBe(1);
    } finally {
      await app.close();
    }
  });
});
