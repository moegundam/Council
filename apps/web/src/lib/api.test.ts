import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiRequest, isConflictError, isRevisionConflictError, managementApi } from "./api.js";

describe("web API errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retains the machine-readable API error code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { code: "REVISION_CONFLICT", message: "Topic revision is stale." }
    }), {
      status: 409,
      headers: { "content-type": "application/json" }
    })));

    const error = await apiRequest("/api/threads/topic", { method: "PATCH" }).catch((cause) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "REVISION_CONFLICT", message: "Topic revision is stale." });
    expect(isRevisionConflictError(error)).toBe(true);
  });

  it("does not classify a business-rule 409 as a revision conflict", () => {
    expect(isRevisionConflictError(new ApiError(
      409,
      "A Topic with an unfinished Meeting cannot be resolved or archived.",
      "REQUEST_FAILED"
    ))).toBe(false);
  });

  it("identifies business and revision conflicts that require an authoritative refresh", () => {
    expect(isConflictError(new ApiError(409, "Meeting is open.", "MEETING_ALREADY_OPEN"))).toBe(true);
    expect(isConflictError(new ApiError(409, "Stale.", "REVISION_CONFLICT"))).toBe(true);
    expect(isConflictError(new ApiError(400, "Invalid.", "VALIDATION_ERROR"))).toBe(false);
  });

  it("sends expectedRevision with Agent lifecycle status updates", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await managementApi.updateAgentStatus("agent-1", "disabled", 7);

    const firstCall = fetchMock.mock.calls[0] as [unknown, RequestInit] | undefined;
    const init = firstCall?.[1];
    expect(init).toBeDefined();
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      status: "disabled",
      expectedRevision: 7
    });
  });

  it("sends the caller-owned retry key when creating a Runtime Profile", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "runtime-1" }), {
      status: 201,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await managementApi.createRuntimeProfile({
      name: "Retry-safe Runtime Profile",
      harnessKind: "openai_compatible",
      modelConnectorId: null,
      sandboxProfileId: null,
      policy: "text_only",
      capabilities: ["text", "abort"],
      timeoutMs: 60_000,
      maxConcurrency: 1,
      enabled: true
    }, "runtime-profile-create-retry");

    const firstCall = fetchMock.mock.calls[0] as [unknown, RequestInit] | undefined;
    expect(firstCall?.[0]).toBe("/api/runtime-profiles");
    expect(firstCall?.[1]).toMatchObject({
      method: "POST",
      headers: { "Idempotency-Key": "runtime-profile-create-retry" }
    });
  });

  it("sends the caller-owned retry key when creating a Tool Pack", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "tool-pack-1" }), {
      status: 201,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const digest = `sha256:${"a".repeat(64)}`;

    await managementApi.createToolPack({
      name: "Retry-safe Tool Pack",
      version: "1.0.0",
      description: "Read-only evidence search.",
      owner: "Platform Owner",
      sourceReference: `registry.example.com/council/evidence@${digest}`,
      imageDigest: digest,
      tools: [{
        name: "search",
        kind: "command",
        goal: "Search approved evidence.",
        access: "read_only",
        argv: { executable: "/opt/council/tool-pack/bin/entrypoint", fixedArguments: ["search"] },
        env: { allowedNames: [] },
        stdin: { mode: "none" }
      }]
    }, "tool-pack-create-retry");

    const firstCall = fetchMock.mock.calls[0] as [unknown, RequestInit] | undefined;
    expect(firstCall?.[0]).toBe("/api/tool-packs");
    expect(firstCall?.[1]).toMatchObject({
      method: "POST",
      headers: { "Idempotency-Key": "tool-pack-create-retry" }
    });
  });

  it("sends caller-owned retry keys when creating a Team and Meeting Preset", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "resource-1" }), {
      status: 201,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await managementApi.createAgentTeam({
      name: "Retry-safe Team",
      description: "One Team per caller intent.",
      members: [{ agentId: "agent-1", roleId: "role-1", isChair: true }]
    }, "agent-team-create-retry");
    await managementApi.createMeetingPreset({
      name: "Retry-safe Preset",
      description: "One Preset per caller intent.",
      teamId: null,
      mode: "chaired",
      automation: "suggest",
      durationMinutes: 30,
      agendaItems: [{ title: "Review", description: "Review one bounded goal." }]
    }, "meeting-preset-create-retry");

    const teamCall = fetchMock.mock.calls[0] as [unknown, RequestInit] | undefined;
    const presetCall = fetchMock.mock.calls[1] as [unknown, RequestInit] | undefined;
    expect(teamCall?.[1]).toMatchObject({
      method: "POST",
      headers: { "Idempotency-Key": "agent-team-create-retry" }
    });
    expect(presetCall?.[1]).toMatchObject({
      method: "POST",
      headers: { "Idempotency-Key": "meeting-preset-create-retry" }
    });
  });

  it("sends the caller-owned retry key when creating a Credential", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "credential-1" }), {
      status: 201,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await managementApi.createCredential({
      name: "Retry-safe Credential",
      provider: "test-provider",
      kind: "api_key",
      location: "cloud",
      secret: "local-test-secret"
    }, "credential-create-retry");

    const firstCall = fetchMock.mock.calls[0] as [unknown, RequestInit] | undefined;
    expect(firstCall?.[0]).toBe("/api/credentials");
    expect(firstCall?.[1]).toMatchObject({
      method: "POST",
      headers: { "Idempotency-Key": "credential-create-retry" }
    });
  });

  it("sends the caller-owned retry key when rotating a Credential", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "credential-1" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await managementApi.rotateCredential(
      "credential-1",
      "replacement-local-secret",
      4,
      "credential-rotation-retry"
    );

    const firstCall = fetchMock.mock.calls[0] as [unknown, RequestInit] | undefined;
    expect(firstCall?.[0]).toBe("/api/credentials/credential-1/rotate");
    expect(firstCall?.[1]).toMatchObject({
      method: "POST",
      headers: { "Idempotency-Key": "credential-rotation-retry" }
    });
    expect(JSON.parse(String(firstCall?.[1].body))).toEqual({
      credentialId: "credential-1",
      secret: "replacement-local-secret",
      expectedSecretRevision: 4
    });
  });

  it("sends the caller-owned retry key when changing Credential status", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "credential-1" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await managementApi.updateCredentialStatus(
      "credential-1",
      "disabled",
      "2026-08-18T00:00:00.000Z",
      "credential-status-retry"
    );

    const firstCall = fetchMock.mock.calls[0] as [unknown, RequestInit] | undefined;
    expect(firstCall?.[0]).toBe("/api/credentials/credential-1/status");
    expect(firstCall?.[1]).toMatchObject({
      method: "PATCH",
      headers: { "Idempotency-Key": "credential-status-retry" }
    });
  });

  it("sends the Credential concurrency token with lifecycle status updates", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await managementApi.updateCredentialStatus(
      "credential-1",
      "disabled",
      "2026-08-12T00:00:00.000Z",
      "credential-status-cas"
    );

    const firstCall = fetchMock.mock.calls[0] as [unknown, RequestInit] | undefined;
    expect(JSON.parse(String(firstCall?.[1].body))).toEqual({
      status: "disabled",
      expectedUpdatedAt: "2026-08-12T00:00:00.000Z"
    });
  });

  it("sends the Credential concurrency token with metadata updates", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await managementApi.updateCredential(
      "credential-1",
      "2026-08-12T00:00:00.000Z",
      { provider: "updated-provider" }
    );

    const firstCall = fetchMock.mock.calls[0] as [unknown, RequestInit] | undefined;
    expect(JSON.parse(String(firstCall?.[1].body))).toEqual({
      expectedUpdatedAt: "2026-08-12T00:00:00.000Z",
      provider: "updated-provider"
    });
  });
});
