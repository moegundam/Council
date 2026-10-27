import { describe, expect, it } from "vitest";
import { createCodexRuntimeHarness } from "./codex-runtime.js";

describe("Codex runtime feature gate", () => {
  it("stays disabled unless the feature flag is exactly true", async () => {
    await expect(createCodexRuntimeHarness({})).resolves.toBeNull();
    await expect(createCodexRuntimeHarness({ CODEX_CLI_HARNESS_ENABLED: "false" })).resolves.toBeNull();
    await expect(createCodexRuntimeHarness({ CODEX_CLI_HARNESS_ENABLED: "TRUE" })).resolves.toBeNull();
  });
});
