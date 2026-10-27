import type { Decision, Meeting, ParticipantAssignment, PublicTask as Task, Utterance } from "@council/contracts";

export type MeetingExperienceTab = "meeting" | "activity" | "canvas";
export type CanvasLens = "progress" | "collaboration" | "resources";
export type ExperienceTone = "neutral" | "positive" | "warning" | "danger" | "info";

export interface ExperienceStatus {
  label: string;
  tone: ExperienceTone;
  icon: "clock" | "check" | "pause" | "alert" | "circle" | "link";
}

export interface ActivityItem {
  id: string;
  createdAt: string;
  title: string;
  detail: string;
  status: ExperienceStatus;
}

export interface CanvasNodeProjection {
  id: string;
  label: string;
  detail: string;
  status: ExperienceStatus;
  kind: "meeting" | "agenda" | "participant" | "message" | "decision" | "task" | "evidence";
}

export interface CanvasEdgeProjection {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface CanvasProjection {
  nodes: CanvasNodeProjection[];
  edges: CanvasEdgeProjection[];
}

export interface MeetingExperienceData {
  meeting: Meeting;
  participants: readonly ParticipantAssignment[];
  messages: readonly Utterance[];
  decisions: readonly Decision[];
  tasks: readonly Task[];
  evidence: readonly { id: string; title: string; subtitle: string; createdAt: string; status: "verified" | "failed" | "linked" }[];
}

export function meetingStatus(meeting: Pick<Meeting, "state">): ExperienceStatus {
  if (meeting.state === "active") return { label: "進行中", tone: "positive", icon: "clock" };
  if (meeting.state === "paused") return { label: "已暫停", tone: "warning", icon: "pause" };
  if (meeting.state === "closed") return { label: "已結束", tone: "neutral", icon: "check" };
  return { label: "尚未開始", tone: "info", icon: "circle" };
}

export function decisionStatus(decision: Pick<Decision, "status">): ExperienceStatus {
  if (decision.status === "approved") return { label: "已核准", tone: "positive", icon: "check" };
  if (decision.status === "rejected") return { label: "已拒絕", tone: "danger", icon: "alert" };
  return { label: "待核准", tone: "warning", icon: "clock" };
}

export function taskStatus(task: Pick<Task, "status">): ExperienceStatus {
  if (task.status === "done") return { label: "已完成", tone: "positive", icon: "check" };
  if (task.status === "review") return { label: "審核中", tone: "info", icon: "clock" };
  if (task.status === "in_progress") return { label: "進行中", tone: "warning", icon: "clock" };
  return { label: "待處理", tone: "neutral", icon: "circle" };
}

function evidenceStatus(status: "verified" | "failed" | "linked"): ExperienceStatus {
  if (status === "verified") return { label: "已驗證", tone: "positive", icon: "check" };
  if (status === "failed") return { label: "驗證失敗", tone: "danger", icon: "alert" };
  return { label: "已連結", tone: "info", icon: "link" };
}

function agendaStatus(status: Meeting["agenda"]["items"][number]["status"]): ExperienceStatus {
  if (status === "completed") return { label: "已完成", tone: "positive", icon: "check" };
  if (status === "current") return { label: "進行中", tone: "warning", icon: "clock" };
  if (status === "skipped") return { label: "已略過", tone: "neutral", icon: "circle" };
  return { label: "待討論", tone: "info", icon: "circle" };
}

function chronological<T extends { createdAt: string; id: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

export function meetingActivity(data: MeetingExperienceData): ActivityItem[] {
  const activity: ActivityItem[] = [
    { id: `meeting:${data.meeting.id}`, createdAt: data.meeting.createdAt, title: "建立會議", detail: data.meeting.title, status: meetingStatus(data.meeting) },
    ...data.messages.map((message) => ({
      id: `message:${message.id}`,
      createdAt: message.createdAt,
      title: message.speakerName,
      detail: message.content,
      status: message.kind === "failure"
        ? { label: "發言失敗", tone: "danger" as const, icon: "alert" as const }
        : { label: message.speakerType === "tool" ? "工具結果" : "會議發言", tone: "info" as const, icon: "circle" as const }
    })),
    ...data.decisions.map((decision) => ({ id: `decision:${decision.id}`, createdAt: decision.createdAt, title: decision.title, detail: decision.description, status: decisionStatus(decision) })),
    ...data.tasks.map((task) => ({ id: `task:${task.id}`, createdAt: task.createdAt, title: task.title, detail: task.assignee ?? "尚未指派", status: taskStatus(task) })),
    ...data.evidence.map((evidence) => ({ id: `evidence:${evidence.id}`, createdAt: evidence.createdAt, title: evidence.title, detail: evidence.subtitle, status: evidenceStatus(evidence.status) }))
  ];
  return chronological(activity);
}

export function meetingCanvasProjection(data: MeetingExperienceData, lens: CanvasLens): CanvasProjection {
  const root: CanvasNodeProjection = {
    id: `meeting:${data.meeting.id}`,
    label: data.meeting.title,
    detail: data.meeting.goal,
    status: meetingStatus(data.meeting),
    kind: "meeting"
  };
  const nodes: CanvasNodeProjection[] = [root];
  const edges: CanvasEdgeProjection[] = [];
  const link = (source: string, target: string, label?: string) => edges.push({
    id: `${source}->${target}`,
    source,
    target,
    ...(label === undefined ? {} : { label })
  });

  if (lens === "progress") {
    for (const item of [...data.meeting.agenda.items].sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))) {
      const id = `agenda:${item.id}`;
      nodes.push({ id, label: item.title, detail: item.description || `議程 ${item.position + 1}`, status: agendaStatus(item.status), kind: "agenda" });
      link(root.id, id, "議程");
    }
    for (const decision of chronological(data.decisions)) {
      const id = `decision:${decision.id}`;
      nodes.push({ id, label: decision.title, detail: decision.description, status: decisionStatus(decision), kind: "decision" });
      link(root.id, id, "決議");
    }
    for (const task of chronological(data.tasks)) {
      const id = `task:${task.id}`;
      nodes.push({ id, label: task.title, detail: task.assignee ?? "尚未指派", status: taskStatus(task), kind: "task" });
      link(`decision:${task.decisionId}`, id, "落實");
    }
  }

  if (lens === "collaboration") {
    for (const participant of [...data.participants].sort((left, right) => left.id.localeCompare(right.id))) {
      const id = `participant:${participant.id}`;
      nodes.push({ id, label: participant.roleSnapshot.name, detail: participant.isChair ? "主席" : participant.roleSnapshot.responsibility, status: { label: participant.isChair ? "主席" : "參與者", tone: "info", icon: "circle" }, kind: "participant" });
      link(root.id, id, "參與");
    }
    for (const message of chronological(data.messages)) {
      const id = `message:${message.id}`;
      nodes.push({ id, label: message.speakerName, detail: message.content, status: message.kind === "failure" ? { label: "失敗", tone: "danger", icon: "alert" } : { label: "發言", tone: "info", icon: "circle" }, kind: "message" });
      const participant = data.participants.find((item) => item.agentId === message.agentId);
      link(participant ? `participant:${participant.id}` : root.id, id, "發言");
    }
  }

  if (lens === "resources") {
    for (const evidence of chronological(data.evidence)) {
      const id = `evidence:${evidence.id}`;
      nodes.push({ id, label: evidence.title, detail: evidence.subtitle, status: evidenceStatus(evidence.status), kind: "evidence" });
      link(root.id, id, "證據");
    }
    for (const task of chronological(data.tasks)) {
      const id = `task:${task.id}`;
      nodes.push({ id, label: task.title, detail: task.acceptanceCriteria || "未設定驗收條件", status: taskStatus(task), kind: "task" });
      link(root.id, id, "任務");
    }
  }

  return { nodes, edges: edges.filter((edge) => nodes.some((node) => node.id === edge.source) && nodes.some((node) => node.id === edge.target)) };
}
