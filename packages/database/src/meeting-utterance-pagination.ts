const cursorVersion = 1 as const;

interface MeetingUtteranceCursorPayload {
  v: typeof cursorVersion;
  meetingId: string;
  createdAt: string;
  sequenceNo: string;
}

export class MeetingUtteranceCursorError extends Error {
  readonly statusCode = 400;
  readonly apiCode = "INVALID_CURSOR";

  constructor() {
    super("Meeting transcript cursor is invalid or no longer matches this Meeting.");
    this.name = "MeetingUtteranceCursorError";
  }
}

export function encodeMeetingUtteranceCursor(
  meetingId: string,
  createdAt: string,
  sequenceNo: bigint | number | string
): string {
  return Buffer.from(JSON.stringify({
    v: cursorVersion,
    meetingId,
    createdAt,
    sequenceNo: String(sequenceNo)
  } satisfies MeetingUtteranceCursorPayload)).toString("base64url");
}

export function decodeMeetingUtteranceCursor(
  cursor: string,
  expectedMeetingId: string
): { createdAt: string; sequenceNo: bigint } {
  try {
    if (!/^[A-Za-z0-9_-]{8,2048}$/.test(cursor)) throw new Error("invalid encoding");
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(decoded).toString("base64url") !== cursor) throw new Error("non-canonical encoding");
    const payload = JSON.parse(decoded) as Partial<MeetingUtteranceCursorPayload>;
    if (payload.v !== cursorVersion
      || payload.meetingId !== expectedMeetingId
      || typeof payload.createdAt !== "string"
      || !Number.isFinite(Date.parse(payload.createdAt))
      || typeof payload.sequenceNo !== "string"
      || !/^[1-9][0-9]*$/.test(payload.sequenceNo)) {
      throw new Error("invalid payload");
    }
    return { createdAt: payload.createdAt, sequenceNo: BigInt(payload.sequenceNo) };
  } catch (error) {
    if (error instanceof MeetingUtteranceCursorError) throw error;
    throw new MeetingUtteranceCursorError();
  }
}
