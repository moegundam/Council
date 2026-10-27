import { meetingSseEventEnvelopeSchema } from "@council/contracts/api-contracts";
import type { Task } from "@council/contracts";

export interface MeetingEventRedisTransport {
  publish(channel: string, payload: string): Promise<unknown>;
}

export interface ContractMeetingEventPublisher {
  publish(channel: string, payload: string): Promise<void>;
}

export type WorkerTaskChangeAction =
  | "agent_run_completed"
  | "agent_run_failed"
  | "agent_run_cancelled"
  | "sync_completed"
  | "sync_failed";

export interface PublishTaskChangedEventOptions {
  occurredAt?: string;
  onError?: (error: unknown) => void;
}

export function createContractMeetingEventPublisher(transport: MeetingEventRedisTransport): ContractMeetingEventPublisher {
  return {
    async publish(channel: string, payload: string): Promise<void> {
      const event = meetingSseEventEnvelopeSchema.parse(JSON.parse(payload) as unknown);
      const expectedChannel = `council:meeting:${event.meetingId}`;
      if (channel !== expectedChannel) {
        throw new Error("Meeting event channel does not match the validated event envelope.");
      }
      await transport.publish(expectedChannel, JSON.stringify(event));
    }
  };
}

export async function publishTaskChangedEvent(
  publisher: ContractMeetingEventPublisher,
  task: Pick<Task, "id" | "meetingId" | "status">,
  action: WorkerTaskChangeAction,
  options: PublishTaskChangedEventOptions = {}
): Promise<void> {
  try {
    await publisher.publish(`council:meeting:${task.meetingId}`, JSON.stringify({
      type: "task.changed",
      meetingId: task.meetingId,
      data: { taskId: task.id, status: task.status, action },
      occurredAt: options.occurredAt ?? new Date().toISOString()
    }));
  } catch (error) {
    try {
      options.onError?.(error);
    } catch {
      // Task completion must not depend on best-effort event diagnostics.
    }
  }
}
