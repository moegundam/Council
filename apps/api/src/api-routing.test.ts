import { describe, expect, it } from "vitest";
import { rewriteVersionedApiUrl } from "./api-routing.js";

describe("versioned API routing", () => {
  it("maps versioned paths to the single internal route implementation", () => {
    expect(rewriteVersionedApiUrl("/api/v1/agents?status=active")).toBe("/api/agents?status=active");
    expect(rewriteVersionedApiUrl("/api/v1")).toBe("/api");
    expect(rewriteVersionedApiUrl("/api/agents")).toBe("/api/agents");
    expect(rewriteVersionedApiUrl("/assets/app.js")).toBe("/assets/app.js");
  });

});
