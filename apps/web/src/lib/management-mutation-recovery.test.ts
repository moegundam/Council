import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { managementMutationRetryDisposition } from "./management-mutation-recovery";

describe("management mutation retry disposition", () => {
  it("refreshes revision conflicts without automatically resending the mutation", () => {
    expect(managementMutationRetryDisposition(
      new ApiError(409, "Credential changed.", "REVISION_CONFLICT")
    )).toBe("refresh_then_confirm");
  });

  it("retains the same intent key only for uncertain outcomes", () => {
    expect(managementMutationRetryDisposition(new TypeError("response lost"))).toBe("retain");
    expect(managementMutationRetryDisposition(new ApiError(503, "Unavailable."))).toBe("retain");
    expect(managementMutationRetryDisposition(new ApiError(408, "Timed out."))).toBe("retain");
    expect(managementMutationRetryDisposition(new ApiError(429, "Rate limited."))).toBe("retain");
  });

  it("clears ownership only for deterministic settled client errors", () => {
    expect(managementMutationRetryDisposition(new ApiError(400, "Invalid."))).toBe("clear");
    expect(managementMutationRetryDisposition(new ApiError(403, "Forbidden."))).toBe("clear");
    expect(managementMutationRetryDisposition(new ApiError(404, "Missing."))).toBe("clear");
    expect(managementMutationRetryDisposition(new ApiError(422, "Rejected."))).toBe("clear");
    expect(managementMutationRetryDisposition(
      new ApiError(409, "Different request.", "IDEMPOTENCY_KEY_CONFLICT")
    )).toBe("clear");
  });
});
