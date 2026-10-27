import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SecretVault } from "./secret-vault.js";

describe("secret vault", () => {
  it("encrypts and decrypts connector credentials", () => {
    const vault = new SecretVault(randomBytes(32));
    const encrypted = vault.encrypt("provider-secret");
    expect(encrypted).not.toContain("provider-secret");
    expect(vault.decrypt(encrypted)).toBe("provider-secret");
  });

  it("does not decrypt with another key", () => {
    const encrypted = new SecretVault(randomBytes(32)).encrypt("provider-secret");
    expect(() => new SecretVault(randomBytes(32)).decrypt(encrypted)).toThrow();
  });

  it("creates stable domain-separated fingerprints without exposing low-entropy input", () => {
    const key = Buffer.alloc(32, 7);
    const vault = new SecretVault(key);
    const first = vault.fingerprint("mcp-tool-request-v1", "status=active");

    expect(first).toMatch(/^hmac-sha256:v1:[a-f0-9]{64}$/);
    expect(first).not.toContain("status=active");
    expect(vault.fingerprint("mcp-tool-request-v1", "status=active")).toBe(first);
    expect(vault.fingerprint("another-context", "status=active")).not.toBe(first);
    expect(vault.fingerprint("mcp-tool-request-v1", "status=inactive")).not.toBe(first);
    expect(new SecretVault(Buffer.alloc(32, 8)).fingerprint("mcp-tool-request-v1", "status=active"))
      .not.toBe(first);
  });
});
