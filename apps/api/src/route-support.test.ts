import { describe, expect, it } from "vitest";
import { errorStatusCode, idempotencyKey } from "./route-support.js";

describe("errorStatusCode", () => {
  it("accepts only integer HTTP error status codes", () => {
    expect(errorStatusCode({ statusCode: 409 })).toBe(409);
    expect(errorStatusCode({ statusCode: 503 })).toBe(503);
  });

  it("fails closed for success, malformed, and out-of-range status codes", () => {
    expect(errorStatusCode({ statusCode: 200 })).toBe(500);
    expect(errorStatusCode({ statusCode: 399 })).toBe(500);
    expect(errorStatusCode({ statusCode: 600 })).toBe(500);
    expect(errorStatusCode({ statusCode: 409.5 })).toBe(500);
    expect(errorStatusCode({ statusCode: "409" })).toBe(500);
    expect(errorStatusCode(new Error("dependency failed"))).toBe(500);
  });
});

describe("idempotencyKey", () => {
  it("normalizes a valid header and preserves an omitted optional key", () => {
    expect(idempotencyKey({ "idempotency-key": "  stable-request  " })).toBe("stable-request");
    expect(idempotencyKey({})).toBeUndefined();
  });

  it("rejects blank and oversized headers at runtime", () => {
    expect(() => idempotencyKey({ "idempotency-key": "   " })).toThrow();
    expect(() => idempotencyKey({ "idempotency-key": "x".repeat(201) })).toThrow();
  });
});
