export interface MeetingActionRequestContext {
  meetingId: string;
  workspaceRevision: number;
}

export function meetingActionRequestIsCurrent(
  request: MeetingActionRequestContext,
  current: { meetingId: string | null; workspaceRevision: number }
): boolean {
  return request.meetingId === current.meetingId
    && request.workspaceRevision === current.workspaceRevision;
}
