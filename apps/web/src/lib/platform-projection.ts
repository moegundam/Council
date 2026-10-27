import type {
  PublicMeetingViewSnapshot as MeetingViewSnapshot,
  PublicPlatformSnapshot as PlatformSnapshot
} from "@council/contracts";

export function platformViewEndpoint(pathname: string): string | null {
  if (pathname === "/docs" || pathname.startsWith("/docs/")) return null;
  if (pathname === "/tasks" || pathname.startsWith("/tasks/")) return "/api/v1/views/tasks";
  if (pathname === "/agents" || pathname.startsWith("/agents/")) return "/api/v1/views/agents";
  if (pathname === "/settings" || pathname.startsWith("/settings/")) return "/api/v1/views/settings";
  return "/api/v1/views/discussions";
}

export function mergeMeetingView(snapshot: PlatformSnapshot, view: MeetingViewSnapshot): PlatformSnapshot {
  const meetingExists = snapshot.meetings.some((meeting) => meeting.id === view.meeting.id);
  return {
    ...snapshot,
    meetings: meetingExists
      ? snapshot.meetings.map((meeting) => meeting.id === view.meeting.id ? view.meeting : meeting)
      : [...snapshot.meetings, view.meeting],
    participants: [...view.participants],
    speakerQueue: [...view.speakerQueue],
    utterances: [...view.utterances],
    toolRuns: [...view.toolRuns],
    chairSuggestions: [...view.chairSuggestions],
    decisions: [...view.decisions],
    tasks: [...view.tasks]
  };
}

export function meetingViewFromSnapshot(snapshot: PlatformSnapshot, meetingId: string): MeetingViewSnapshot | null {
  const meeting = snapshot.meetings.find((item) => item.id === meetingId);
  if (!meeting) return null;
  return {
    meeting,
    participants: snapshot.participants.filter((item) => item.meetingId === meetingId),
    speakerQueue: snapshot.speakerQueue.filter((item) => item.meetingId === meetingId),
    utterances: snapshot.utterances.filter((item) => item.meetingId === meetingId),
    toolRuns: snapshot.toolRuns.filter((item) => item.meetingId === meetingId),
    chairSuggestions: snapshot.chairSuggestions.filter((item) => item.meetingId === meetingId),
    decisions: snapshot.decisions.filter((item) => item.meetingId === meetingId),
    tasks: snapshot.tasks.filter((item) => item.meetingId === meetingId)
  };
}

function refreshTimeLabel(value: string | null): string {
  if (!value) return "尚未成功更新";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "時間未知";
  return new Intl.DateTimeFormat("zh-TW", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function projectionFreshnessLabel(input: {
  stale: boolean;
  refreshing: boolean;
  lastSuccessfulAt: string | null;
}): string {
  if (input.stale) return `資料可能過期 · 上次更新 ${refreshTimeLabel(input.lastSuccessfulAt)}`;
  if (input.refreshing) return "更新中";
  return input.lastSuccessfulAt ? `更新於 ${refreshTimeLabel(input.lastSuccessfulAt)}` : "";
}
