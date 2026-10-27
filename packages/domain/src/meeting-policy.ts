import type { ChairSuggestion, PlatformSnapshot, RoleTemplateKey } from "@council/contracts";
import { evaluateChairPolicy } from "#chair-policy";
import { remainingMeetingMinutes } from "#meeting-scheduling";

export { permittedAgentIdsForMeeting, remainingMeetingMinutes } from "#meeting-scheduling";

export function evaluateMeetingChairSuggestion(
  snapshot: PlatformSnapshot,
  meetingId: string,
  now = Date.now()
): ChairSuggestion | null {
  const meeting = snapshot.meetings.find((item) => item.id === meetingId);
  if (!meeting || meeting.state !== "active") return null;

  const recentContributions = snapshot.utterances
    .filter((item) => item.meetingId === meetingId && (item.speakerType === "human" || item.speakerType === "agent"))
    .slice(-4);
  const currentAgendaItem = meeting.agenda?.items.find((item) => item.status === "current");
  const suggestion = evaluateChairPolicy({
    agenda: [meeting.goal, currentAgendaItem?.title, currentAgendaItem?.description]
      .filter((value): value is string => Boolean(value)),
    recentMessages: recentContributions.map((item) => item.content),
    remainingMinutes: remainingMeetingMinutes(meeting, now)
  });
  if (!suggestion) return null;

  const chairParticipant = snapshot.participants.find((item) => item.meetingId === meetingId && item.isChair);
  const chair = chairParticipant ? snapshot.agents.find((item) => item.id === chairParticipant.agentId) : undefined;
  const latest = recentContributions.at(-1);
  const latestAgentId = latest?.speakerType === "agent"
    ? latest.agentId ?? snapshot.agents.find((item) => item.name === latest.speakerName)?.id
    : undefined;
  const withChairIntervention = !chair || latestAgentId === chair.id || suggestion.reason === "time_remaining"
    ? suggestion
    : { ...suggestion, suggestedAgentId: chair.id, suggestedAgentName: chair.name };

  const participant = latestAgentId
    ? snapshot.participants.find((item) => item.meetingId === meetingId && item.agentId === latestAgentId)
    : undefined;
  const preferredTemplate: RoleTemplateKey = suggestion.reason === "repetition" ? "evidence_analyst" : "meeting_chair";
  const role = snapshot.roles.find((item) => item.deletedAt === null && item.templateKey === preferredTemplate);
  const agent = participant ? snapshot.agents.find((item) => item.id === participant.agentId) : undefined;
  if (!participant || !agent || !role || participant.roleId === role.id) return withChairIntervention;

  return {
    ...withChairIntervention,
    suggestedParticipantId: participant.id,
    suggestedParticipantAgentId: participant.agentId,
    suggestedParticipantAgentName: agent.name,
    suggestedParticipantRoleRevision: participant.roleRevision,
    suggestedRoleId: role.id,
    suggestedRoleName: role.name,
    suggestedRoleVersion: role.version
  } satisfies ChairSuggestion;
}
