import type { Credential, PromptVersion } from "@council/contracts";
import { describe, expect, it } from "vitest";
import {
  changedConnectorFields,
  credentialExpiryIso,
  modelCredentialSubmission,
  promptVersionForEdit,
  rebaseConnectorRevision,
  selectableModelCredentials
} from "./settings-form.js";

function credential(id: string, status: Credential["status"]): Credential {
  return {
    id,
    name: id,
    provider: "openai",
    kind: "api_key",
    location: "cloud",
    status,
    hasSecret: true,
    secretRevision: 1,
    maskedHint: "sk-...test",
    expiresAt: null,
    lastUsedAt: null,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    rotatedAt: "2026-08-10T00:00:00.000Z"
  };
}

function promptVersion(version: number): PromptVersion {
  return {
    promptId: "prompt-a",
    version,
    content: `Prompt content v${version}`,
    variables: ["MEETING_GOAL"],
    contentDigest: `digest-${version}`,
    source: "updated",
    restoredFromVersion: null,
    createdAt: `2026-08-0${version}T00:00:00.000Z`,
    publishedAt: null
  };
}

describe("settings form payload helpers", () => {
  it("converts datetime-local expiry to an ISO timestamp and keeps blank expiry null", () => {
    expect(credentialExpiryIso("2026-08-10T16:45"))
      .toBe(new Date(2026, 7, 10, 16, 45).toISOString());
    expect(credentialExpiryIso("")).toBeNull();
    expect(credentialExpiryIso(null)).toBeNull();
  });

  it("omits an unchanged Credential binding from a Model edit", () => {
    expect(modelCredentialSubmission("disabled-credential", "disabled-credential")).toEqual({});
    expect(modelCredentialSubmission(null, "disabled-credential")).toEqual({});
  });

  it("submits only an explicit Model Credential rebind or clear", () => {
    expect(modelCredentialSubmission("active-credential", "disabled-credential"))
      .toEqual({ credentialId: "active-credential" });
    expect(modelCredentialSubmission("", "disabled-credential"))
      .toEqual({ credentialId: null });
    expect(modelCredentialSubmission("", undefined)).toEqual({ credentialId: null });
  });

  it("offers only active Credentials for a new Model binding or rebind", () => {
    const credentials = [
      credential("active-credential", "active"),
      credential("disabled-credential", "disabled"),
      credential("revoked-credential", "revoked")
    ];

    expect(selectableModelCredentials(credentials).map((item) => item.id))
      .toEqual(["active-credential"]);
  });

  it("rebases only the Connector revision and preserves the user's draft baseline", () => {
    const editing = { id: "connector-a", revision: 2, name: "Original name", enabled: true };
    const latest = { id: "connector-a", revision: 3, name: "Changed elsewhere", enabled: false };

    expect(rebaseConnectorRevision(editing, latest)).toEqual({
      id: "connector-a",
      revision: 3,
      name: "Original name",
      enabled: true
    });
    expect(rebaseConnectorRevision(editing, { ...latest, id: "connector-b" })).toBe(editing);
  });

  it("submits only locally changed Connector fields after a stale revision refresh", () => {
    const opened = {
      name: "Original name",
      location: "local" as const,
      baseUrl: "http://old.example.test/v1",
      model: "local-model",
      enabled: true
    };
    const localDraft = { ...opened, name: "Renamed locally" };

    expect(changedConnectorFields(opened, localDraft, [
      "name",
      "location",
      "baseUrl",
      "model",
      "enabled"
    ])).toEqual({ name: "Renamed locally" });
  });

  it("selects the exact current Prompt version for editing", () => {
    const stale = promptVersion(2);
    const current = promptVersion(3);

    expect(promptVersionForEdit([stale, current], 3)).toBe(current);
  });

  it("fails closed when the current Prompt version is absent", () => {
    expect(() => promptVersionForEdit([promptVersion(1), promptVersion(2)], 3))
      .toThrow("找不到目前的 Prompt 版本 v3");
  });
});
