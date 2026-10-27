import type {
  Agent,
  Meeting,
  ParticipantAssignment,
  PublicPlatformSnapshot as PlatformSnapshot,
  PublicSpeakerQueueItem as SpeakerQueueItem
} from "@council/contracts";

export interface EligibleSpeaker {
  agentId: string;
  agentName: string;
  roleName: string;
}

export function meetingSpeakerQueue(
  snapshot: Pick<PlatformSnapshot, "speakerQueue">,
  meetingId: string
): SpeakerQueueItem[] {
  return snapshot.speakerQueue.filter((item) => item.meetingId === meetingId);
}

export function eligibleMeetingSpeakers(
  meeting: Pick<Meeting, "id" | "state">,
  participants: readonly ParticipantAssignment[],
  agents: readonly Agent[],
  permittedAgentIds: readonly string[],
  queuedParticipantIds: ReadonlySet<string>
): EligibleSpeaker[] {
  if (meeting.state !== "active" || queuedParticipantIds.size > 0) return [];
  const permitted = new Set(permittedAgentIds);
  return participants.flatMap((participant) => {
    if (participant.meetingId !== meeting.id || queuedParticipantIds.has(participant.id) || !permitted.has(participant.agentId)) return [];
    const agent = agents.find((candidate) => candidate.id === participant.agentId);
    return agent ? [{ agentId: agent.id, agentName: agent.name, roleName: participant.roleSnapshot.name }] : [];
  });
}

export function speakerQueueStatusLabel(status: SpeakerQueueItem["status"], kind: SpeakerQueueItem["kind"] = "agent_turn"): string {
  if (status === "queued") return "排隊中";
  return kind === "mcp_tool_call" ? "工具執行中" : "發言中";
}
