import type { LookupFunction } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { assertConnectorUrlAllowed, assertConnectorUrlShapeAllowed, createConnectorConnectionPolicy, parseConnectorHostAllowlist } from "./connector-url-policy.js";

function lookupAddress(lookup: LookupFunction, hostname: string): Promise<{ address: string; family: number }> {
  return new Promise((resolve, reject) => {
    lookup(hostname, { family: 0 }, (error, address, family) => {
      if (error) reject(error);
      else if (typeof address === "string") resolve({ address, family: family ?? 0 });
      else reject(new Error("Expected a single pinned address."));
    });
  });
}

describe("connector URL policy", () => {
  it("allows HTTPS cloud endpoints that resolve only to public addresses", async () => {
    await expect(assertConnectorUrlAllowed(
      "https://api.example.com/v1",
      false,
      async () => ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]
    )).resolves.toBeUndefined();
  });

  it("allows Tailscale model endpoints only for private connectors", async () => {
    await expect(assertConnectorUrlAllowed("http://192.168.50.10:4000/v1", true)).resolves.toBeUndefined();
    await expect(assertConnectorUrlAllowed("http://192.168.50.10:4000/v1", false)).rejects.toThrow(/private/i);
  });

  it("always blocks loopback and metadata endpoints", async () => {
    await expect(assertConnectorUrlAllowed("http://127.0.0.1:9000", true)).rejects.toThrow(/blocked/i);
    await expect(assertConnectorUrlAllowed("http://169.254.169.254/latest", true)).rejects.toThrow(/blocked/i);
    await expect(assertConnectorUrlAllowed("http://[::ffff:7f00:1]:9000", true)).rejects.toThrow(/blocked/i);
  });

  it("rejects embedded credentials before any connector is persisted", () => {
    expect(() => assertConnectorUrlShapeAllowed("https://owner:secret@api.example.com/mcp", true)).toThrow(/credentials/i);
  });

  it("normalizes a bounded connector host allowlist and rejects URLs", () => {
    expect(parseConnectorHostAllowlist(" MCP-READONLY.,10.20.30.40,mcp-readonly ")).toEqual([
      "mcp-readonly",
      "10.20.30.40"
    ]);
    expect(() => parseConnectorHostAllowlist("http://mcp-readonly:4100")).toThrow(/hostnames|IP addresses/i);
  });

  it("recognizes hexadecimal IPv4-mapped private IPv6 addresses", async () => {
    await expect(assertConnectorUrlAllowed("http://[::ffff:a00:1]:9000", false)).rejects.toThrow(/private/i);
    await expect(assertConnectorUrlAllowed("http://[::ffff:a00:1]:9000", true)).resolves.toBeUndefined();
  });

  it("blocks cloud hostnames that resolve to private or loopback addresses", async () => {
    await expect(assertConnectorUrlAllowed(
      "https://models.internal.example/v1",
      false,
      async () => ["10.20.30.40"]
    )).rejects.toThrow(/private/i);
    await expect(assertConnectorUrlAllowed(
      "https://models.example/v1",
      true,
      async () => ["127.0.0.1"]
    )).rejects.toThrow(/blocked/i);
  });

  it("allows private DNS only when the exact local host is allowlisted", async () => {
    const resolver = async () => ["10.20.30.40"];
    await expect(assertConnectorUrlAllowed(
      "http://mcp-readonly:4100/mcp",
      true,
      resolver,
      ["mcp-readonly"]
    )).resolves.toBeUndefined();
    await expect(assertConnectorUrlAllowed(
      "http://postgres:5432/mcp",
      true,
      resolver,
      ["mcp-readonly"]
    )).rejects.toThrow(/allowlist/i);
  });

  it("requires the exact local host allowlist even when DNS resolves publicly", async () => {
    const resolver = async () => ["8.8.8.8"];
    await expect(assertConnectorUrlAllowed(
      "https://local-mcp.example/mcp",
      true,
      resolver,
      ["mcp-readonly"]
    )).rejects.toThrow(/allowlist/i);
    await expect(assertConnectorUrlAllowed(
      "https://local-mcp.example/mcp",
      true,
      resolver,
      ["local-mcp.example"]
    )).resolves.toBeUndefined();
  });

  it("rejects a private execution-time DNS answer for a public-only Connector", async () => {
    await expect(createConnectorConnectionPolicy(
      "https://mcp.example.com/mcp",
      false,
      async () => ["10.20.30.40"],
      []
    )).rejects.toThrow(/private/i);
  });

  it("fails closed when a connector hostname cannot be resolved", async () => {
    await expect(assertConnectorUrlAllowed(
      "https://missing.example/v1",
      false,
      async () => { throw new Error("dns unavailable"); }
    )).rejects.toThrow(/resolve/i);
  });

  it("pins policy-approved DNS answers into the socket lookup", async () => {
    const resolver = vi.fn(async () => ["93.184.216.34"]);
    const policy = await createConnectorConnectionPolicy(
      "https://models.example.com/v1",
      false,
      resolver
    );

    resolver.mockResolvedValue(["127.0.0.1"]);
    await expect(lookupAddress(policy.lookup, "models.example.com")).resolves.toEqual({
      address: "93.184.216.34",
      family: 4
    });
    await expect(lookupAddress(policy.lookup, "redirect.example.com")).rejects.toThrow(/host/i);
    expect(resolver).toHaveBeenCalledOnce();
  });
});
