import type { Skill } from "@council/contracts";

type SkillPromptSource = Pick<Skill, "id" | "name" | "version" | "contentDigest" | "instructions">;

export function skillInstructionBudget(skills: readonly Pick<Skill, "id" | "instructions">[]) {
  const instructionCharacters = skills.reduce((total, skill) => total + skill.instructions.length, 0);
  const limit = 20_000;
  return { instructionCharacters, limit, withinLimit: instructionCharacters <= limit };
}

// Callers retain approval and digest validation; this projection only bounds model-visible fields.
export function approvedSkillPromptBlocks(skills: readonly SkillPromptSource[]): string[] {
  return skills.map(({ id, name, version, contentDigest, instructions }) =>
    `<approved_skill_json>\n${JSON.stringify({ id, name, version, contentDigest, instructions })}\n</approved_skill_json>`
  );
}
