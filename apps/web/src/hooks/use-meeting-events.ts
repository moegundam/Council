"use client";

import { useEffect, useRef } from "react";
import { meetingSseEventEnvelopeSchema } from "@council/contracts/api-contracts";
import type { ClientMeetingEvent } from "../lib/view-model";

const refreshEvents = [
  "utterance.created",
  "chair.suggestion",
  "chair.suggestion.updated",
  "meeting.mode.changed",
  "meeting.automation.changed",
  "chair.automation.applied",
  "chair.automation.failed",
  "meeting.agenda.changed",
  "meeting.participant.role.changed",
  "decision.changed",
  "task.changed",
  "speaker.queue.changed",
  "agent.cancelled",
  "mcp.cancelled",
  "agent.failed",
  "mcp.failed",
  "summary.failed"
];

export interface MeetingEventSource {
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
}
export type MeetingEventSourceFactory = (url: string) => MeetingEventSource;

const defaultEventSourceFactory: MeetingEventSourceFactory = (url) => {
  const source = new EventSource(url);
  return {
    addEventListener: (type, listener) => source.addEventListener(type, listener),
    close: () => source.close()
  };
};

export function subscribeToMeetingEvents(
  meetingId: string,
  refresh: () => Promise<void>,
  onEvent?: (event: ClientMeetingEvent) => void,
  createEventSource: MeetingEventSourceFactory = defaultEventSourceFactory
): () => void {
  const source = createEventSource(`/api/meetings/${meetingId}/events`);
  let active = true;
  let refreshInFlight = false;
  let refreshPending = false;
  const requestRefresh = () => {
    if (!active) return;
    if (refreshInFlight) {
      refreshPending = true;
      return;
    }
    refreshInFlight = true;
    let request: Promise<void>;
    try {
      request = refresh();
    } catch {
      request = Promise.resolve();
    }
    void request.catch(() => undefined).finally(() => {
      refreshInFlight = false;
      if (!active) {
        refreshPending = false;
        return;
      }
      if (!refreshPending) return;
      refreshPending = false;
      requestRefresh();
    });
  };
  const update = (message: Event) => {
    if (!active) return;
    if (message instanceof MessageEvent) {
      try {
        const parsed = meetingSseEventEnvelopeSchema.safeParse(JSON.parse(String(message.data)) as unknown);
        if (parsed.success && parsed.data.meetingId === meetingId) onEvent?.(parsed.data);
      } catch {
        // A malformed event must not stop later meeting updates.
      }
    }
    requestRefresh();
  };
  for (const event of refreshEvents) source.addEventListener(event, update);
  source.addEventListener("ready", update);
  return () => {
    active = false;
    refreshPending = false;
    source.close();
  };
}

export function useMeetingEvents(
  meetingId: string | undefined,
  refresh: () => Promise<void>,
  onEvent?: (event: ClientMeetingEvent) => void
): void {
  const onEventRef = useRef(onEvent);
  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);

  useEffect(() => {
    if (!meetingId) return;
    return subscribeToMeetingEvents(meetingId, refresh, (event) => onEventRef.current?.(event));
  }, [meetingId, refresh]);
}
