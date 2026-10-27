import argon2 from "argon2";
import { describe, expect, it, vi } from "vitest";
import { InMemoryPlatformStore } from "@council/database";
import { createApp } from "./app.js";

const origin = "https://council.test";
const password = "correct horse battery staple";

async function ownerSession(app: Awaited<ReturnType<typeof createApp>>, store: InMemoryPlatformStore): Promise<string> {
  await store.createOwner("adapter-owner@example.com", await argon2.hash(password, { type: argon2.argon2id }));
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "adapter-owner@example.com", password }
  });
  expect(login.statusCode).toBe(200);
  return login.cookies.find((entry) => entry.name === "council_session")!.value;
}

describe("Harness Action Adapter management routes", () => {
  it("requires an Owner session and persists only an allowlisted, fixed catalog with audit evidence", async () => {
    const store = new InMemoryPlatformStore();
    const audit = vi.spyOn(store, "recordAudit");
    const credential = await store.createCredential({
      name: "Harness production credential",
      provider: "harness",
      kind: "bearer_token",
      location: "local"
    }, { ciphertext: "vault:v1:harness" });
    const app = await createApp({
      store,
      authDisabled: false,
      secureCookies: false,
      allowedOrigin: origin,
      harnessActionAdapterEndpointAllowlist: ["https://harness.example.test/mcp"]
    });

    const unauthenticated = await app.inject({ method: "GET", url: "/api/v1/action-adapters" });
    expect(unauthenticated.statusCode).toBe(401);

    const session = await ownerSession(app, store);
    const invalidEndpoint = await app.inject({
      method: "POST",
      url: "/api/v1/action-adapters",
      headers: { origin },
      cookies: { council_session: session },
      payload: {
        name: "Credential-bearing endpoint",
        baseUrl: "https://token@harness.example.test/mcp",
        credentialId: credential.id,
        actions: [{
          key: "deploy-preview",
          displayName: "Deploy preview",
          targetIds: ["pipeline-preview"],
          inputKeys: ["branch"],
          riskClass: "ordinary",
          timeoutMs: 10_000,
          supportsCancellation: true,
          supportsCompensation: true
        }]
      }
    });
    expect(invalidEndpoint.statusCode).toBe(400);
    expect(invalidEndpoint.json()).toMatchObject({ error: { code: "ACTION_ADAPTER_ENDPOINT_INVALID" } });

    const rejectedEndpoint = await app.inject({
      method: "POST",
      url: "/api/v1/action-adapters",
      headers: { origin },
      cookies: { council_session: session },
      payload: {
        name: "Unapproved endpoint",
        baseUrl: "https://unapproved.example.test/mcp",
        credentialId: credential.id,
        actions: [{
          key: "deploy-preview",
          displayName: "Deploy preview",
          targetIds: ["pipeline-preview"],
          inputKeys: ["branch"],
          riskClass: "ordinary",
          timeoutMs: 10_000,
          supportsCancellation: true,
          supportsCompensation: true
        }]
      }
    });
    expect(rejectedEndpoint.statusCode).toBe(409);
    expect(rejectedEndpoint.json()).toMatchObject({ error: { code: "ACTION_ADAPTER_ENDPOINT_UNAPPROVED" } });

    const snapshot = vi.spyOn(store, "getSnapshot").mockRejectedValue(new Error("Action Adapter creation must not load the platform snapshot."));
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/action-adapters",
      headers: { origin },
      cookies: { council_session: session },
      payload: {
        name: "Preview deployment",
        baseUrl: "https://harness.example.test/mcp",
        credentialId: credential.id,
        actions: [{
          key: "deploy-preview",
          displayName: "Deploy preview",
          targetIds: ["pipeline-preview"],
          inputKeys: ["branch"],
          riskClass: "ordinary",
          timeoutMs: 10_000,
          supportsCancellation: true,
          supportsCompensation: true
        }]
      }
    });
    expect(created.statusCode).toBe(201);
    expect(snapshot).not.toHaveBeenCalled();
    expect(created.json()).toMatchObject({
      kind: "harness_pipeline",
      enabled: true,
      catalogRevision: 1,
      baseUrl: "https://harness.example.test/mcp",
      credentialId: credential.id
    });
    expect(audit).toHaveBeenCalledWith("action_adapter.created", "action_adapter", expect.any(String), expect.objectContaining({
      catalogRevision: 1,
      actionCount: 1
    }));

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/action-adapters",
      cookies: { council_session: session }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ actionAdapters: [expect.objectContaining({ id: created.json().id })] });
    await app.close();
  });
});
