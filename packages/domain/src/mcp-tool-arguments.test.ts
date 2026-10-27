import { describe, expect, it } from "vitest";
import { SecretVault } from "./secret-vault.js";
import { decryptMcpToolArguments, encryptMcpToolArguments } from "./mcp-tool-arguments.js";

describe("encrypted MCP tool arguments", () => {
  it("round-trips a job-bound argument envelope without plaintext disclosure", () => {
    const vault = new SecretVault(Buffer.alloc(32, 12));
    const ciphertext = encryptMcpToolArguments(vault, "meeting-tool-job", {
      query: "confidential search",
      filters: { status: "active" }
    });

    expect(ciphertext).not.toContain("confidential search");
    expect(decryptMcpToolArguments(vault, "meeting-tool-job", ciphertext)).toEqual({
      query: "confidential search",
      filters: { status: "active" }
    });
    expect(() => decryptMcpToolArguments(vault, "another-job", ciphertext)).toThrow(/job binding/i);
  });

  it("rejects tampering and arguments outside the shared bounded JSON contract", () => {
    const vault = new SecretVault(Buffer.alloc(32, 13));
    const ciphertext = encryptMcpToolArguments(vault, "meeting-tool-job", { query: "bounded" });
    expect(() => decryptMcpToolArguments(vault, "meeting-tool-job", `${ciphertext}x`)).toThrow();
    expect(() => encryptMcpToolArguments(vault, "meeting-tool-job", {
      values: Array.from({ length: 101 }, (_, index) => index)
    })).toThrow();
  });
});
