export type MeetingMessageDrafts = Readonly<Record<string, string>>;

export interface MeetingMessageSendRequest {
  meetingId: string;
  token: number;
}

export interface MeetingMessageRetryRequest {
  meetingId: string;
  signature: string;
  idempotencyKey: string;
}

export class MeetingMessageRetryOwnership {
  private readonly retryByMeetingId = new Map<string, Map<string, MeetingMessageRetryRequest>>();

  acquire(meetingId: string, signature: string, createKey: () => string): MeetingMessageRetryRequest {
    let meetingRetries = this.retryByMeetingId.get(meetingId);
    const current = meetingRetries?.get(signature);
    if (current) return current;

    const retry = { meetingId, signature, idempotencyKey: createKey() };
    if (!meetingRetries) {
      meetingRetries = new Map();
      this.retryByMeetingId.set(meetingId, meetingRetries);
    }
    meetingRetries.set(signature, retry);
    return retry;
  }

  clear(request: MeetingMessageRetryRequest): void {
    const meetingRetries = this.retryByMeetingId.get(request.meetingId);
    if (meetingRetries?.get(request.signature) !== request) return;
    meetingRetries.delete(request.signature);
    if (meetingRetries.size === 0) this.retryByMeetingId.delete(request.meetingId);
  }
}

export class MeetingMessageDraftOwnership {
  private nextToken = 0;
  private readonly latestTokenByMeetingId = new Map<string, number>();

  beginSend(meetingId: string): MeetingMessageSendRequest {
    const token = ++this.nextToken;
    this.latestTokenByMeetingId.set(meetingId, token);
    return { meetingId, token };
  }

  owns(request: MeetingMessageSendRequest): boolean {
    return this.latestTokenByMeetingId.get(request.meetingId) === request.token;
  }

  restoreAfterFailure(
    drafts: MeetingMessageDrafts,
    request: MeetingMessageSendRequest,
    failedDraft: string
  ): MeetingMessageDrafts {
    if (!this.owns(request)) return drafts;
    return restoreMeetingMessageDraft(drafts, request.meetingId, failedDraft);
  }
}

export function updateMeetingMessageDraft(
  drafts: MeetingMessageDrafts,
  meetingId: string,
  value: string
): MeetingMessageDrafts {
  if ((drafts[meetingId] ?? "") === value) return drafts;
  const next = { ...drafts };
  if (value) next[meetingId] = value;
  else delete next[meetingId];
  return next;
}

export function restoreMeetingMessageDraft(
  drafts: MeetingMessageDrafts,
  meetingId: string,
  failedDraft: string
): MeetingMessageDrafts {
  if (drafts[meetingId]) return drafts;
  return updateMeetingMessageDraft(drafts, meetingId, failedDraft);
}
