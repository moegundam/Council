import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTitle } from "../src/title-tools.mjs";

test("normalizeTitle trims and collapses whitespace", () => {
  assert.equal(normalizeTitle("  Council   OMP  "), "Council OMP");
});
