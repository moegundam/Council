export type MeetingState = "draft" | "active" | "paused" | "closed";
export type MeetingAction = "start" | "pause" | "resume" | "close";

const transitions: Record<MeetingState, Partial<Record<MeetingAction, MeetingState>>> = {
  draft: { start: "active", close: "closed" },
  active: { pause: "paused", close: "closed" },
  paused: { resume: "active", close: "closed" },
  closed: {}
};

export function transitionMeeting(state: MeetingState, action: MeetingAction): MeetingState {
  const next = transitions[state][action];
  if (!next) {
    throw new Error(`Invalid meeting transition: ${state} -> ${action}`);
  }
  return next;
}
