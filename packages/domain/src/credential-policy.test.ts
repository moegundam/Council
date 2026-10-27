import { describe, expect, it } from "vitest";
import { credentialIsExpired } from "./credential-policy.js";

describe("credential expiry policy", () => {
  const now = Date.parse("2026-08-12T00:00:00.000Z");

  it("treats the exact expiry boundary and earlier timestamps as expired", () => {
    expect(credentialIsExpired("2026-08-11T23:59:59.999Z", now)).toBe(true);
    expect(credentialIsExpired("2026-08-12T00:00:00.000Z", now)).toBe(true);
    expect(credentialIsExpired("2026-08-12T00:00:00.001Z", now)).toBe(false);
  });

  it("keeps missing expiry backward-compatible and rejects malformed configured expiry", () => {
    expect(credentialIsExpired(null, now)).toBe(false);
    expect(credentialIsExpired(undefined, now)).toBe(false);
    expect(credentialIsExpired("not-a-timestamp", now)).toBe(true);
  });
});
