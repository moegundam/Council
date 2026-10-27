export type GoalWorkspaceView = "overview" | "activity" | "canvas";
export type MeetingWorkspaceView = "meeting" | "activity" | "canvas";
export type WorkspaceCanvasLens = "progress" | "collaboration" | "resources";

export interface WorkspaceSourceContext {
  goalId?: string;
  meetingId?: string;
  threadId?: string;
}

const goalViews = new Set<GoalWorkspaceView>(["overview", "activity", "canvas"]);
const meetingViews = new Set<MeetingWorkspaceView>(["meeting", "activity", "canvas"]);
const canvasLenses = new Set<WorkspaceCanvasLens>(["progress", "collaboration", "resources"]);

function identifier(params: Pick<URLSearchParams, "get">, key: string): string | null {
  const value = params.get(key)?.trim();
  return value ? value : null;
}

function route(pathname: string, entries: ReadonlyArray<readonly [string, string | null | undefined]>): string {
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function parseGoalWorkspaceRoute(params: Pick<URLSearchParams, "get">): {
  goalId: string | null;
  view: GoalWorkspaceView;
  lens: WorkspaceCanvasLens;
} {
  const requestedView = params.get("view") as GoalWorkspaceView | null;
  const requestedLens = params.get("lens") as WorkspaceCanvasLens | null;
  return {
    goalId: identifier(params, "goalId"),
    view: requestedView && goalViews.has(requestedView) ? requestedView : "overview",
    lens: requestedLens && canvasLenses.has(requestedLens) ? requestedLens : "progress"
  };
}

export function parseMeetingWorkspaceRoute(params: Pick<URLSearchParams, "get">): {
  threadId: string | null;
  meetingId: string | null;
  fromGoalId: string | null;
  view: MeetingWorkspaceView;
  lens: WorkspaceCanvasLens;
} {
  const requestedView = params.get("view") as MeetingWorkspaceView | null;
  const requestedLens = params.get("lens") as WorkspaceCanvasLens | null;
  return {
    threadId: identifier(params, "threadId"),
    meetingId: identifier(params, "meetingId"),
    fromGoalId: identifier(params, "fromGoalId"),
    view: requestedView && meetingViews.has(requestedView) ? requestedView : "meeting",
    lens: requestedLens && canvasLenses.has(requestedLens) ? requestedLens : "progress"
  };
}

export function parseWorkspaceSourceContext(params: Pick<URLSearchParams, "get">): WorkspaceSourceContext {
  const goalId = identifier(params, "fromGoalId");
  const meetingId = identifier(params, "fromMeetingId");
  const threadId = identifier(params, "fromThreadId");
  return {
    ...(goalId ? { goalId } : {}),
    ...(meetingId ? { meetingId } : {}),
    ...(threadId ? { threadId } : {})
  };
}

export function buildGoalWorkspaceHref(input: {
  goalId?: string | null;
  view?: GoalWorkspaceView;
  lens?: WorkspaceCanvasLens;
}): string {
  const view = input.view ?? "overview";
  return route("/goals", [
    ["goalId", input.goalId],
    ["view", view],
    ["lens", view === "canvas" ? input.lens ?? "progress" : null]
  ]);
}

export function buildMeetingWorkspaceHref(input: {
  meetingId?: string | null | undefined;
  threadId?: string | null | undefined;
  fromGoalId?: string | null | undefined;
  view?: MeetingWorkspaceView;
  lens?: WorkspaceCanvasLens;
}): string {
  const view = input.view ?? "meeting";
  return route("/", [
    ["threadId", input.threadId],
    ["meetingId", input.meetingId],
    ["fromGoalId", input.fromGoalId],
    ["view", view],
    ["lens", view === "canvas" ? input.lens ?? "progress" : null]
  ]);
}

function sourceEntries(source: WorkspaceSourceContext | undefined): ReadonlyArray<readonly [string, string | undefined]> {
  return [
    ["fromMeetingId", source?.meetingId],
    ["fromThreadId", source?.threadId],
    ["fromGoalId", source?.goalId]
  ];
}

export function buildTaskWorkspaceHref(input: { taskId?: string | null; source?: WorkspaceSourceContext }): string {
  return route("/tasks", [["taskId", input.taskId], ...sourceEntries(input.source)]);
}

export function buildAgentWorkspaceHref(input: { agentId?: string | null; source?: WorkspaceSourceContext }): string {
  return route("/agents", [["agentId", input.agentId], ...sourceEntries(input.source)]);
}
