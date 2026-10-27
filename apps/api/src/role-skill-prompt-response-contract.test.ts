import { describe, expect, it } from "vitest";
import type { PromptTemplate, PromptVersion, Role, Skill } from "@council/contracts";
import { InMemoryPlatformStore } from "@council/database";
import { createApp } from "./app.js";

const marker = "must-not-cross-the-management-boundary";

function drift<T extends object>(value: T): T {
  return { ...value, internalMarker: marker } as T;
}

class DriftedManagementResponseStore extends InMemoryPlatformStore {
  override async createRole(...args: Parameters<InMemoryPlatformStore["createRole"]>): Promise<Role> {
    return drift(await super.createRole(...args));
  }

  override async createSkill(...args: Parameters<InMemoryPlatformStore["createSkill"]>): Promise<Skill> {
    return drift(await super.createSkill(...args));
  }

  override async getPrompts(): Promise<PromptTemplate[]> {
    return (await super.getPrompts()).map(drift);
  }

  override async updatePrompt(...args: Parameters<InMemoryPlatformStore["updatePrompt"]>): Promise<PromptTemplate> {
    return drift(await super.updatePrompt(...args));
  }

  override async getPromptVersions(...args: Parameters<InMemoryPlatformStore["getPromptVersions"]>): Promise<PromptVersion[]> {
    return (await super.getPromptVersions(...args)).map(drift);
  }
}

describe("Role, Skill, and Prompt response contracts", () => {
  it("fails closed when management Store responses contain an undeclared field", async () => {
    const store = new DriftedManagementResponseStore();
    const prompt = await store.createPrompt({
      name: "Strict Prompt response",
      kind: "agent",
      description: "Reject undeclared Prompt response fields.",
      owner: "Test Owner",
      content: "Stay within the declared response contract.",
      variables: []
    });
    const app = await createApp({ store, authDisabled: true });

    try {
      const role = await app.inject({
        method: "POST",
        url: "/api/roles",
        headers: { "idempotency-key": "strict-role-response" },
        payload: {
          name: "Strict Role response",
          usageContext: "Bounded review",
          responsibility: "Reject response drift.",
          speakingGuidance: "Report only declared fields.",
          decisionScope: "Response contract decisions.",
          constraints: "No undeclared fields.",
          toolPolicy: "none",
          dataPolicy: "meeting_only"
        }
      });
      const skill = await app.inject({
        method: "POST",
        url: "/api/skills",
        headers: { "idempotency-key": "strict-skill-response" },
        payload: {
          name: "Strict Skill response",
          version: "1.0.0",
          instructions: "Reject every undeclared response field.",
          source: "test",
          owner: "Test Owner"
        }
      });
      const promptList = await app.inject({ method: "GET", url: "/api/prompts" });
      const promptUpdate = await app.inject({
        method: "PATCH",
        url: `/api/prompts/${prompt.id}`,
        payload: { expectedCurrentVersion: 1, content: "Reject response drift after update." }
      });
      const promptVersions = await app.inject({
        method: "GET",
        url: `/api/prompts/${prompt.id}/versions`
      });

      for (const [name, response] of Object.entries({ role, skill, promptList, promptUpdate, promptVersions })) {
        expect(response.statusCode, name).toBe(500);
        expect(response.json(), name).toMatchObject({ error: { code: "RESPONSE_CONTRACT_VIOLATION" } });
        expect(response.body, name).not.toContain(marker);
      }
    } finally {
      await app.close();
    }
  });
});
