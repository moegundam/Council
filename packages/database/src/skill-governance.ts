import { createHash } from "node:crypto";
import type { Skill } from "@council/contracts";

export function skillContentDigest(skill: Pick<Skill, "name" | "version" | "instructions" | "source" | "owner">): string {
  return createHash("sha256")
    .update([skill.name, skill.version, skill.instructions, skill.source, skill.owner].join("\u001f"))
    .digest("hex");
}

export function skillHasCurrentApprovedValidation(skill: Skill): boolean {
  const currentDigest = skillContentDigest(skill);
  return skill.status === "approved"
    && skill.validation.result === "passed"
    && skill.contentDigest === currentDigest
    && skill.validation.contentDigest === currentDigest;
}
