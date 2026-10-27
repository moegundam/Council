import { describe, expect, it } from "vitest";
import * as contracts from "./index.js";
import {
  agentRevisionSchema,
  agentReadinessSchema,
  agentTeamSchema,
  archivePromptSchema,
  createAgentTeamSchema,
  createCredentialSchema,
  createMeetingPresetSchema,
  createModelConnectorSchema,
  createPromptSchema,
  credentialSchema,
  meetingPresetSchema,
  promptTemplateSchema,
  promptVersionSchema,
  publishAgentSchema,
  publishPromptSchema,
  rollbackAgentSchema,
  rollbackPromptSchema,
  rotateCredentialSchema,
  setAgentStatusSchema,
  updateAgentTeamSchema,
  updateAgentRequestSchema,
  updateAgentSchema,
  updateCredentialSchema,
  updateMeetingPresetSchema,
  updatePromptSchema,
  updateCredentialStatusSchema,
  type AgentTurnJobData
} from "./index.js";

const id = "60000000-0000-4000-8000-000000000001";
const secondId = "60000000-0000-4000-8000-000000000002";
const thirdId = "60000000-0000-4000-8000-000000000003";
const now = "2026-07-20T00:00:00.000Z";

type RuntimeSchema = { parse(value: unknown): unknown };

function promptPreviewRequestContract(): RuntimeSchema {
  const schema = (contracts as unknown as { promptPreviewRequestSchema?: RuntimeSchema }).promptPreviewRequestSchema;
  expect(schema, "promptPreviewRequestSchema must be exported").toBeDefined();
  return schema!;
}

const credential = {
  id,
  name: "GB10 local key",
  provider: "ollama",
  kind: "api_key" as const,
  location: "local" as const,
  status: "active" as const,
  hasSecret: true,
  secretRevision: 2,
  maskedHint: "****1234",
  expiresAt: null,
  lastUsedAt: null,
  createdAt: now,
  updatedAt: now,
  rotatedAt: null
};

const prompt = {
  id,
  name: "Meeting synthesis",
  kind: "meeting" as const,
  description: "Summarize evidence and unresolved risks.",
  owner: "platform",
  status: "published" as const,
  currentVersion: 2,
  publishedVersion: 2,
  createdAt: now,
  updatedAt: now
};

const promptVersion = {
  promptId: id,
  version: 2,
  content: "Use {{EVIDENCE}} and state unknowns.",
  variables: ["EVIDENCE"],
  contentDigest: "sha256:prompt-v2",
  source: "published" as const,
  restoredFromVersion: null,
  createdAt: now,
  publishedAt: now
};

describe("Management contracts", () => {
  it("requires existing Credential secrets to rotate through the Credential lifecycle", () => {
    const base = {
      name: "Cloud model",
      location: "cloud" as const,
      baseUrl: "https://models.example.com/v1",
      model: "meeting"
    };

    expect(createModelConnectorSchema.parse({ ...base, credentialId: id })).toEqual({ ...base, credentialId: id });
    expect(createModelConnectorSchema.parse({ ...base, apiKey: "new-secret" })).toEqual({ ...base, apiKey: "new-secret" });
    expect(() => createModelConnectorSchema.parse({
      ...base,
      credentialId: id,
      apiKey: "must-use-credential-rotation"
    })).toThrow(/Credential/i);
  });

  it("exports the strict bounded Prompt preview request used by handlers and OpenAPI", () => {
    expect(promptPreviewRequestContract().parse({ version: 2 })).toEqual({ version: 2, variables: {} });
    expect(promptPreviewRequestContract().parse({ version: 2, variables: { GOAL: "Review contracts" } }))
      .toEqual({ version: 2, variables: { GOAL: "Review contracts" } });
    expect(() => promptPreviewRequestContract().parse({ version: 2, variables: {}, unexpected: true })).toThrow();
  });

  it("accepts credential metadata and rejects raw secrets or invalid lifecycle values", () => {
    expect(credentialSchema.parse(credential)).toEqual(credential);
    expect(createCredentialSchema.parse({
      name: "OpenAI cloud",
      provider: "openai",
      kind: "bearer_token",
      location: "cloud",
      secret: "provided-out-of-band"
    })).toMatchObject({ name: "OpenAI cloud", kind: "bearer_token", location: "cloud" });
    expect(() => credentialSchema.parse({ ...credential, secret: "raw" })).toThrow();
    expect(() => credentialSchema.parse({ ...credential, status: "pending" })).toThrow();
    expect(() => updateCredentialSchema.parse({})).toThrow();
    expect(() => updateCredentialSchema.parse({ provider: "updated-provider" })).toThrow();
    expect(() => updateCredentialSchema.parse({ secret: "must-use-rotate" })).toThrow();
    expect(updateCredentialSchema.parse({
      provider: "updated-provider",
      expectedUpdatedAt: now
    })).toEqual({
      provider: "updated-provider",
      expectedUpdatedAt: now
    });
    expect(() => rotateCredentialSchema.parse({ credentialId: id, secret: "" })).toThrow();
    expect(() => rotateCredentialSchema.parse({ credentialId: id, secret: "provided-out-of-band" })).toThrow();
    expect(rotateCredentialSchema.parse({ credentialId: id, secret: "provided-out-of-band", expectedSecretRevision: 0 }).expectedSecretRevision).toBe(0);
    expect(() => updateCredentialStatusSchema.parse({ status: "disabled" })).toThrow();
    expect(updateCredentialStatusSchema.parse({ status: "disabled", expectedUpdatedAt: now })).toEqual({
      status: "disabled",
      expectedUpdatedAt: now
    });
  });

  it("accepts prompt metadata and version history while enforcing safe unique variables", () => {
    expect(promptTemplateSchema.parse(prompt)).toEqual(prompt);
    expect(promptVersionSchema.parse(promptVersion)).toEqual(promptVersion);
    expect(createPromptSchema.parse({
      name: "Agent brief",
      kind: "agent",
      description: "Compose a bounded brief.",
      owner: "platform",
      content: "Use {{GOAL}} and {{DATA}}.",
      variables: ["GOAL", "DATA"]
    })).toMatchObject({ kind: "agent", variables: ["GOAL", "DATA"] });
    expect(() => createPromptSchema.parse({
      name: "Unsafe",
      kind: "agent",
      description: "x",
      owner: "platform",
      content: "x",
      variables: ["goal"]
    })).toThrow();
    expect(() => createPromptSchema.parse({
      name: "Duplicate",
      kind: "agent",
      description: "x",
      owner: "platform",
      content: "x",
      variables: ["GOAL", "GOAL"]
    })).toThrow();
    expect(publishPromptSchema.parse({ expectedCurrentVersion: 2, version: 2 })).toEqual({ expectedCurrentVersion: 2, version: 2 });
    expect(rollbackPromptSchema.parse({ expectedCurrentVersion: 3, version: 1 })).toEqual({ expectedCurrentVersion: 3, version: 1 });
    expect(archivePromptSchema.parse({ expectedCurrentVersion: 2 })).toEqual({ expectedCurrentVersion: 2 });
    expect(() => updatePromptSchema.parse({ expectedCurrentVersion: 2 })).toThrow();
  });

  it("accepts immutable Agent revisions and readiness checks without accepting invalid revisions", () => {
    const revision = {
      agentId: id,
      revision: 3,
      name: "Architect",
      description: "Reviews boundaries.",
      modelConnectorId: secondId,
      goalSummary: "Review architecture.",
      toolsSummary: "Read-only tools.",
      dataSummary: "Meeting evidence.",
      skillIds: [thirdId],
      toolGrants: [{ connectorId: secondId, toolName: "catalog.list" }],
      toolPackGrants: [],
      runtimeProfileBinding: { profileId: thirdId, revision: 1 },
      promptBinding: { promptId: id, version: 2 },
      contentDigest: "sha256:agent-v3",
      contentDigestVersion: 2,
      source: "published" as const,
      restoredFromRevision: null,
      createdAt: now,
      publishedAt: now
    };
    expect(agentRevisionSchema.parse(revision)).toEqual(revision);
    expect(agentReadinessSchema.parse({
      status: "warning",
      checks: [{ code: "credential", status: "warning", message: "Cloud key is not configured." }]
    })).toEqual({
      status: "warning",
      checks: [{ code: "credential", status: "warning", message: "Cloud key is not configured." }]
    });
    expect(() => agentRevisionSchema.parse({ ...revision, revision: 0 })).toThrow();
    expect(() => agentReadinessSchema.parse({ status: "ready", checks: [{ code: "model", status: "passed", message: "ok", extra: true }] })).toThrow();
    expect(() => agentReadinessSchema.parse({ status: "ready", checks: [{ code: "agent", status: "passed", message: "ok" }] })).toThrow();
    expect(publishAgentSchema.parse({ expectedDraftRevision: 3 })).toEqual({ expectedDraftRevision: 3 });
    expect(rollbackAgentSchema.parse({ expectedPublishedRevision: 3, expectedDraftRevision: 3, revision: 1 }))
      .toEqual({ expectedPublishedRevision: 3, expectedDraftRevision: 3, revision: 1 });
    expect(() => rollbackAgentSchema.parse({ expectedPublishedRevision: 3, revision: 1 })).toThrow();
    expect(updateAgentSchema.parse({ promptBinding: { promptId: id, version: 2 } }))
      .toEqual({ promptBinding: { promptId: id, version: 2 } });
    expect(updateAgentRequestSchema.parse({ expectedDraftRevision: 3, description: "Updated draft" }))
      .toEqual({ expectedDraftRevision: 3, description: "Updated draft" });
    expect(() => updateAgentRequestSchema.parse({ description: "Missing revision" })).toThrow();
    expect(setAgentStatusSchema.parse({ status: "disabled", expectedRevision: 3 }))
      .toEqual({ status: "disabled", expectedRevision: 3 });
    expect(() => setAgentStatusSchema.parse({ status: "disabled" })).toThrow();
  });

  it("requires one unique chair for Agent Teams and unique agenda titles for Meeting Presets", () => {
    const teamInput = {
      name: "Architecture Council",
      description: "Architecture review roster.",
      members: [
        { agentId: id, roleId: secondId, isChair: true },
        { agentId: thirdId, roleId: secondId, isChair: false }
      ]
    };
    expect(createAgentTeamSchema.parse(teamInput)).toEqual(teamInput);
    expect(agentTeamSchema.parse({ id, ...teamInput, status: "active", createdAt: now, updatedAt: now }))
      .toMatchObject({ name: teamInput.name, revision: 1 });
    expect(() => createAgentTeamSchema.parse({ ...teamInput, members: [{ ...teamInput.members[0], isChair: true }, { ...teamInput.members[1], isChair: true }] })).toThrow();
    expect(() => createAgentTeamSchema.parse({ ...teamInput, members: [teamInput.members[0], teamInput.members[0]] })).toThrow();
    expect(updateAgentTeamSchema.parse({ expectedRevision: 1, description: "Updated" }))
      .toEqual({ expectedRevision: 1, description: "Updated" });
    expect(() => updateAgentTeamSchema.parse({ description: "Missing revision" })).toThrow();
    expect(() => updateAgentTeamSchema.parse({})).toThrow();

    const presetInput = {
      name: "Architecture review",
      description: "A bounded review.",
      teamId: id,
      mode: "chaired" as const,
      automation: "suggest" as const,
      durationMinutes: 30,
      agendaItems: [
        { title: "Scope", description: "Confirm scope." },
        { title: "Decision", description: "Record decision." }
      ]
    };
    expect(createMeetingPresetSchema.parse(presetInput)).toEqual(presetInput);
    expect(meetingPresetSchema.parse({ id, ...presetInput, status: "active", createdAt: now, updatedAt: now }))
      .toMatchObject({ name: presetInput.name, revision: 1 });
    expect(() => createMeetingPresetSchema.parse({ ...presetInput, agendaItems: [presetInput.agendaItems[0], { ...presetInput.agendaItems[1], title: " scope " }] })).toThrow();
    expect(updateMeetingPresetSchema.parse({ expectedRevision: 1, durationMinutes: 45 }))
      .toEqual({ expectedRevision: 1, durationMinutes: 45 });
    expect(() => updateMeetingPresetSchema.parse({ durationMinutes: 45 })).toThrow();
    expect(() => updateMeetingPresetSchema.parse({})).toThrow();
  });

  it("carries immutable Agent and credential bindings without a secret field", () => {
    const job: AgentTurnJobData = {
      participantId: id,
      roleRevision: 1,
      roleId: secondId,
      roleVersion: 1,
      meetingId: thirdId,
      agentId: id,
      agendaRevision: 1,
      agendaCurrentItemId: null,
      requestedBy: "owner",
      agentRevision: 3,
      promptBinding: { promptId: id, version: 2 },
      credentialBinding: { credentialId: secondId, secretRevision: 4, provider: "openai", location: "cloud" }
    };

    expect(job).toMatchObject({
      agentRevision: 3,
      promptBinding: { promptId: id, version: 2 },
      credentialBinding: { credentialId: secondId, secretRevision: 4 }
    });
    expect("secret" in (job.credentialBinding ?? {})).toBe(false);
  });
});
