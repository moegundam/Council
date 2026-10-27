import { createHash } from "node:crypto";
import type {
  GoalRun,
  MeetingRecord,
  MeetingRecordNarrativePoint,
  MeetingRecordSourceReference,
  MeetingViewSnapshot
} from "@council/contracts";

function source(kind: MeetingRecordSourceReference["kind"], id: string): MeetingRecordSourceReference[] {
  return [{ kind, id }];
}

function point(
  text: string,
  kind: MeetingRecordSourceReference["kind"],
  id: string
): MeetingRecordNarrativePoint {
  return { text, sourceReferences: source(kind, id) };
}

export function buildDeterministicMeetingRecord(
  view: MeetingViewSnapshot,
  goalRuns: readonly GoalRun[]
): MeetingRecord {
  const { meeting } = view;
  if (meeting.state !== "closed" || !meeting.closedAt) {
    throw new Error("Meeting must have a durable close timestamp before its record can be generated.");
  }
  const closedAt = new Date(meeting.closedAt).toISOString();

  const agenda = [...meeting.agenda.items]
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))
    .map((item) => ({
      agendaItemId: item.id,
      title: item.title,
      status: item.status,
      outcome: item.description.trim() || null,
      sourceReferences: source("agenda", item.id)
    }));
  const decisions = [...view.decisions]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .map((decision) => ({
      decisionId: decision.id,
      title: decision.title,
      description: decision.description,
      status: decision.status,
      sourceReferences: source("decision", decision.id)
    }));
  const tasks = [...view.tasks]
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))
    .map((task) => ({
      taskId: task.id,
      decisionId: task.decisionId,
      title: task.title,
      status: task.status,
      assigneeAgentId: task.assigneeAgentId,
      dueAt: task.dueAt,
      sourceReferences: source("task", task.id)
    }));
  const consensus = decisions
    .filter((decision) => decision.status === "approved")
    .map((decision) => point(decision.title, "decision", decision.decisionId));
  const dissent = decisions
    .filter((decision) => decision.status === "rejected")
    .map((decision) => point(decision.title, "decision", decision.decisionId));
  const openItems: MeetingRecordNarrativePoint[] = [
    ...decisions
      .filter((decision) => decision.status === "proposed")
      .map((decision) => point(decision.title, "decision", decision.decisionId)),
    ...agenda
      .filter((item) => item.status === "pending" || item.status === "current")
      .map((item) => point(item.title, "agenda", item.agendaItemId)),
    ...view.chairSuggestions
      .filter((suggestion) => suggestion.status !== "resolved")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map((suggestion) => point(suggestion.explanation, "chair_suggestion", suggestion.id))
  ];
  const evidenceReferences = [
    ...[...view.tasks]
      .sort((left, right) => left.id.localeCompare(right.id))
      .flatMap((task) => task.evidence.map((evidence) => ({
        evidenceId: evidence.id,
        type: evidence.type,
        label: evidence.label,
        reference: evidence.reference,
        sourceReferences: source("task", task.id)
      }))),
    ...[...view.toolRuns]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map((toolRun) => ({
        evidenceId: `tool-run:${toolRun.id}`,
        type: "note" as const,
        label: `${toolRun.toolName} (${toolRun.status})`,
        reference: toolRun.utteranceId,
        sourceReferences: source("tool_run", toolRun.id)
      }))
  ];
  const linkedGoalIds = goalRuns
    .filter((goalRun) => goalRun.meetingId === meeting.id)
    .map((goalRun) => goalRun.id)
    .sort();
  const approvedCount = consensus.length;
  const outcomeStatus = approvedCount > 0 && openItems.length === 0
    ? "completed" as const
    : decisions.length > 0 || tasks.length > 0 || openItems.length > 0
      ? "partial" as const
      : "inconclusive" as const;
  const summary = approvedCount > 0
    ? `已核准 ${approvedCount} 項決議，建立 ${tasks.length} 項任務；尚有 ${openItems.length} 項待確認。`
    : `本次會議未形成已核准決議；保留 ${openItems.length} 項待確認。`;
  const content: MeetingRecord["content"] = {
    meeting: {
      meetingId: meeting.id,
      threadId: meeting.threadId,
      title: meeting.title,
      goal: meeting.goal,
      state: "closed",
      mode: meeting.mode,
      startedAt: meeting.startedAt,
      closedAt
    },
    outcome: {
      status: outcomeStatus,
      summary,
      narrativePoints: [...consensus, ...dissent, ...openItems].slice(0, 100)
    },
    participants: [...view.participants]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((participant) => ({
        participantId: participant.id,
        agentId: participant.agentId,
        agentRevision: participant.agentRevision ?? null,
        roleId: participant.roleId,
        roleRevision: participant.roleRevision,
        isChair: participant.isChair
      })),
    agenda,
    consensus,
    dissent,
    openItems,
    decisions,
    tasks,
    evidenceReferences,
    linkedGoalIds
  };
  const sourceDigest = createHash("sha256")
    .update(JSON.stringify({ meetingId: meeting.id, closedAt, content }))
    .digest("hex");
  return {
    meetingId: meeting.id,
    revision: 1,
    closedAt,
    generatedAt: closedAt,
    generationMode: "deterministic",
    content,
    sourceDigest,
    createdBy: "system"
  };
}
