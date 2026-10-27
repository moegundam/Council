import type { Meeting, PlatformSnapshot } from "@council/contracts";

type MeetingSchedulingSnapshot = Pick<
  PlatformSnapshot,
  "agents" | "meetings" | "modelConnectors" | "participants" | "utterances"
>;

function runnableParticipantIds(snapshot: MeetingSchedulingSnapshot, meetingId: string): string[] {
  return snapshot.participants
    .filter((participant) => participant.meetingId === meetingId)
    .flatMap((participant) => {
      const agent = snapshot.agents.find((item) => item.id === participant.agentId);
      if (!agent || agent.lifecycleStatus === "disabled") return [];
      if (participant.agentRevision !== undefined) return [agent.id];
      const connector = agent?.modelConnectorId
        ? snapshot.modelConnectors.find((item) => item.id === agent.modelConnectorId && item.enabled)
        : undefined;
      return connector ? [agent.id] : [];
    });
}

function agentIdForSpeaker(snapshot: MeetingSchedulingSnapshot, speakerName: string): string | undefined {
  return snapshot.agents.find((agent) => agent.name === speakerName)?.id;
}

export function permittedAgentIdsForMeeting(snapshot: MeetingSchedulingSnapshot, meetingId: string): string[] {
  const meeting = snapshot.meetings.find((item) => item.id === meetingId);
  if (!meeting) return [];

  const runnableIds = runnableParticipantIds(snapshot, meetingId);
  if (meeting.mode === "open") return runnableIds;
  if (runnableIds.length === 0) return [];

  if (meeting.mode === "fixed") {
    const latestAgentUtterance = snapshot.utterances
      .filter((item) => item.meetingId === meetingId && item.speakerType === "agent")
      .at(-1);
    const latestAgentId = latestAgentUtterance
      ? latestAgentUtterance.agentId ?? agentIdForSpeaker(snapshot, latestAgentUtterance.speakerName)
      : undefined;
    const latestIndex = latestAgentId ? runnableIds.indexOf(latestAgentId) : -1;
    return [runnableIds[(latestIndex + 1) % runnableIds.length]!];
  }

  const chairId = snapshot.participants.find((item) => item.meetingId === meetingId && item.isChair)?.agentId;
  if (!chairId || !runnableIds.includes(chairId)) return [];
  const delegates = runnableIds.filter((agentId) => agentId !== chairId);
  if (delegates.length === 0) return [chairId];

  const latestContribution = snapshot.utterances
    .filter((item) => item.meetingId === meetingId && (item.speakerType === "human" || item.speakerType === "agent"))
    .at(-1);
  const latestAgentId = latestContribution?.speakerType === "agent"
    ? latestContribution.agentId ?? agentIdForSpeaker(snapshot, latestContribution.speakerName)
    : undefined;
  return latestAgentId === chairId ? delegates : [chairId];
}

export function remainingMeetingMinutes(meeting: Meeting, now = Date.now()): number {
  if (!meeting.startedAt) return meeting.durationMinutes;
  const elapsedMinutes = Math.floor(Math.max(0, now - new Date(meeting.startedAt).getTime()) / 60_000);
  return Math.max(0, meeting.durationMinutes - elapsedMinutes);
}
