import type {
  ChairSuggestionRecord,
  Meeting,
  MeetingMode,
  Utterance
} from "@council/contracts";

const AUTO_COOLDOWN_MS = 60_000;
const MAX_AUTO_APPLICATIONS = 6;
const MAX_ACKNOWLEDGEMENT_TOKENS = 5;

export type ChairAutoApplyReason =
  | "allowed"
  | "automation_not_auto"
  | "meeting_not_active"
  | "suggestion_not_open"
  | "mode_would_broaden"
  | "already_auto_applied"
  | "maximum_auto_applications"
  | "time_already_applied"
  | "short_acknowledgement"
  | "repetition_different_speakers"
  | "cooldown"
  | "insufficient_contributions";

export interface ChairAutoApplyContribution {
  id: string;
  createdAt: string;
  speakerType: Utterance["speakerType"];
  speakerName: string;
  speakerId?: string | null;
  isChair?: boolean;
  content: string;
}

export interface ChairAutoApplyInput {
  meeting: Pick<Meeting, "automation" | "mode" | "state" | "startedAt">;
  suggestion: ChairSuggestionRecord;
  history: readonly ChairSuggestionRecord[];
  contributions: readonly ChairAutoApplyContribution[];
  now?: number;
}

export interface ChairAutoApplyDecision {
  allowed: boolean;
  reason: ChairAutoApplyReason;
}

const normalizedTokenPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+/gu;
const acknowledgementPhrases = new Set([
  "好",
  "好的",
  "同意",
  "同意了",
  "收到",
  "了解",
  "了解了",
  "沒問題",
  "可以",
  "是的",
  "ok",
  "okay",
  "yes",
  "agree",
  "sure"
]);

function normalizedTokens(value: string): string[] {
  return value.normalize("NFKC").toLocaleLowerCase().match(normalizedTokenPattern) ?? [];
}

export function normalizedTokenCount(value: string): number {
  return normalizedTokens(value).length;
}

function normalizedPhrase(value: string): string {
  return normalizedTokens(value).join("");
}

function isShortAcknowledgement(value: string): boolean {
  return normalizedTokenCount(value) < MAX_ACKNOWLEDGEMENT_TOKENS
    && acknowledgementPhrases.has(normalizedPhrase(value));
}

function modeRank(mode: MeetingMode): number {
  return { open: 0, chaired: 1, fixed: 2 }[mode];
}

function isSystemModeAcceptance(record: ChairSuggestionRecord): boolean {
  return record.transitions.some((transition) => transition.type === "mode_accepted" && transition.actor === "system");
}

function systemModeAcceptanceTimes(record: ChairSuggestionRecord): number[] {
  return record.transitions
    .filter((transition) => transition.type === "mode_accepted" && transition.actor === "system")
    .map((transition) => Date.parse(transition.at))
    .filter(Number.isFinite);
}

function speakerKey(contribution: ChairAutoApplyContribution): string {
  return contribution.speakerId ?? `${contribution.speakerType}:${contribution.speakerName}`;
}

function isNonChairContribution(contribution: ChairAutoApplyContribution): boolean {
  return (contribution.speakerType === "human" || contribution.speakerType === "agent")
    && contribution.isChair !== true;
}

function isHumanOrAgentContribution(contribution: ChairAutoApplyContribution): boolean {
  return contribution.speakerType === "human" || contribution.speakerType === "agent";
}

function decision(reason: ChairAutoApplyReason): ChairAutoApplyDecision {
  return { allowed: reason === "allowed", reason };
}

export function decideChairAutoApply(input: ChairAutoApplyInput): ChairAutoApplyDecision {
  const { meeting, suggestion } = input;
  if (meeting.state !== "active") return decision("meeting_not_active");
  if (meeting.automation !== "auto") return decision("automation_not_auto");
  if (suggestion.status !== "open") return decision("suggestion_not_open");
  if (modeRank(suggestion.suggestedMode) < modeRank(meeting.mode)) {
    return decision("mode_would_broaden");
  }

  const records = [
    ...input.history.filter((record) => record.meetingId === suggestion.meetingId && record.id !== suggestion.id),
    suggestion
  ];
  if (isSystemModeAcceptance(suggestion)) return decision("already_auto_applied");

  const autoApplications = records.filter(isSystemModeAcceptance);
  if (autoApplications.length >= MAX_AUTO_APPLICATIONS) {
    return decision("maximum_auto_applications");
  }

  if (suggestion.reason === "time_remaining") {
    if (autoApplications.some((record) => record.reason === "time_remaining")) {
      return decision("time_already_applied");
    }
    return decision("allowed");
  }

  const sourceIndex = input.contributions.findIndex((contribution) => contribution.id === suggestion.sourceUtteranceId);
  const source = sourceIndex >= 0 ? input.contributions[sourceIndex] : undefined;
  if (suggestion.reason === "off_topic" && source && isShortAcknowledgement(source.content)) {
    return decision("short_acknowledgement");
  }

  if (suggestion.reason === "repetition" && sourceIndex > 0 && source) {
    const previous = [...input.contributions]
      .slice(0, sourceIndex)
      .reverse()
      .find(isHumanOrAgentContribution);
    if (previous && isHumanOrAgentContribution(source) && speakerKey(previous) !== speakerKey(source)) {
      return decision("repetition_different_speakers");
    }
  }

  const autoTimes = autoApplications.flatMap(systemModeAcceptanceTimes);
  const latestAutoAt = autoTimes.length > 0 ? Math.max(...autoTimes) : Date.parse(meeting.startedAt ?? "");
  const now = input.now ?? Date.now();
  if (!Number.isFinite(latestAutoAt) || now - latestAutoAt < AUTO_COOLDOWN_MS) {
    return decision("cooldown");
  }

  const contributionsSinceLastAuto = input.contributions.filter((contribution) => {
    const createdAt = Date.parse(contribution.createdAt);
    return isNonChairContribution(contribution)
      && Number.isFinite(createdAt)
      && createdAt > latestAutoAt
      && createdAt <= now;
  }).length;
  if (contributionsSinceLastAuto < 2) return decision("insufficient_contributions");

  return decision("allowed");
}
