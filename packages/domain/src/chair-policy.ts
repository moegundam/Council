import type { ChairSuggestion } from "@council/contracts";

export type { ChairSuggestion, MeetingMode } from "@council/contracts";

export interface ChairPolicyInput {
  agenda: string | readonly string[];
  recentMessages: string[];
  remainingMinutes: number;
}

const tokenPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}]+/gu;
const cjkPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function tokens(value: string): Set<string> {
  const result = new Set<string>();
  for (const segment of value.normalize("NFKC").toLocaleLowerCase().match(tokenPattern) ?? []) {
    if (!cjkPattern.test(segment)) {
      if (segment.length > 1) result.add(segment);
      continue;
    }
    const characters = Array.from(segment);
    if (characters.length === 1) result.add(characters[0]!);
    for (let index = 0; index < characters.length - 1; index += 1) {
      result.add(`${characters[index]}${characters[index + 1]}`);
    }
  }
  return result;
}

function similarity(left: string, right: string): number {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / new Set([...leftTokens, ...rightTokens]).size;
}

export function evaluateChairPolicy(input: ChairPolicyInput): ChairSuggestion | null {
  if (input.remainingMinutes <= 3) {
    return {
      reason: "time_remaining",
      suggestedMode: "fixed",
      explanation: `只剩 ${Math.max(input.remainingMinutes, 0)} 分鐘，建議進入固定收斂流程。`,
      score: 1
    };
  }

  const last = input.recentMessages.at(-1);
  const previous = input.recentMessages.at(-2);
  if (last && previous) {
    const repeated = similarity(last, previous);
    if (repeated >= 0.8) {
      return {
        reason: "repetition",
        suggestedMode: "chaired",
        explanation: "最近兩次發言高度重複，建議由主席指定下一位角色。",
        score: repeated
      };
    }
  }

  if (last) {
    const agendaSections = (typeof input.agenda === "string" ? [input.agenda] : input.agenda)
      .filter((section) => tokens(section).size > 0);
    const relevance = agendaSections.reduce((strongest, section) => Math.max(strongest, similarity(section, last)), 0);
    if (agendaSections.length > 0 && relevance < 0.08) {
      return {
        reason: "off_topic",
        suggestedMode: "chaired",
        explanation: "最新發言與議程關聯偏低，建議由主席重新聚焦。",
        score: 1 - relevance
      };
    }
  }

  return null;
}
