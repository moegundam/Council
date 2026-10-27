import { describe, expect, it } from "vitest";
import type { Skill } from "@council/contracts";
import { approvedSkillPromptBlocks, skillInstructionBudget } from "./skill-context.js";

function skill(instructions: string, id = "skill-1"): Skill {
  return {
    id, name: "Evidence", version: "1", contentDigest: "digest", instructions,
    source: "private-source-marker", owner: "private-owner-marker", status: "approved",
    validation: { result: "passed", summary: "private-validation-marker", checkedAt: null, contentDigest: "digest" },
    approvedAt: null, revokedAt: null, revocationReason: null
  };
}

describe("Skill prompt projection", () => {
  it("keeps only execution fields, complete instructions and input order", () => {
    const skills = [skill("Keep every policy.\nDo not infer permission.", "b"), skill("Second instruction", "a")];
    const blocks = approvedSkillPromptBlocks(skills);
    const projected = blocks.map((block) => JSON.parse(block.split("\n")[1]!));
    expect(projected).toEqual(skills.map(({ id, name, version, contentDigest, instructions }) => ({
      id, name, version, contentDigest, instructions
    })));
    expect(blocks.join("\n")).not.toMatch(/private-|validation|approvedAt|revokedAt/);
    expect(skills[0]!.owner).toBe("private-owner-marker");
  });

  it("preserves the existing Meeting format byte for byte", () => {
    const value = skill("Line 1\nLine 2 \"quoted\"");
    expect(approvedSkillPromptBlocks([value])).toEqual([
      `<approved_skill_json>\n${JSON.stringify({ id: value.id, name: value.name, version: value.version, contentDigest: value.contentDigest, instructions: value.instructions })}\n</approved_skill_json>`
    ]);
  });

  it("does not truncate oversized native Task policies or invent a universal limit", () => {
    const value = skill("x".repeat(20_001));
    expect(JSON.parse(approvedSkillPromptBlocks([value])[0]!.split("\n")[1]!).instructions).toBe(value.instructions);
  });

  it.each([0, 19_999, 20_000, 20_001])("reports the existing Meeting character budget at %s", (length) => {
    expect(skillInstructionBudget([skill("x".repeat(length))])).toEqual({
      instructionCharacters: length, limit: 20_000, withinLimit: length <= 20_000
    });
  });

  it("counts every bound instruction without counting metadata or deduplicating policy", () => {
    expect(skillInstructionBudget([skill("abc"), skill("defg")]).instructionCharacters).toBe(7);
    expect(skillInstructionBudget([])).toEqual({ instructionCharacters: 0, limit: 20_000, withinLimit: true });
    expect(approvedSkillPromptBlocks([])).toEqual([]);
  });
});
