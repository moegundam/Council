import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("selfhost:create-owner wrapper", () => {
  it("accepts pnpm's argument separator before the owner email", () => {
    const script = readFileSync(join(process.cwd(), "scripts/selfhost-create-owner.sh"), "utf8");

    expect(script).toContain('if [[ "${1:-}" == "--" ]]');
    expect(script.indexOf("shift")).toBeLessThan(script.indexOf('EMAIL="${1:-}"'));
  });
});
