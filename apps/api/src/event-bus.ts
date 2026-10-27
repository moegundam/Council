import { Redis } from "ioredis";
import { meetingSseEventEnvelopeSchema, type MeetingSseEventEnvelope } from "@council/contracts/api-contracts";

export type MeetingEvent = Omit<MeetingSseEventEnvelope, "data"> & {
  data: Record<string, unknown>;
};

type Listener = (event: MeetingEvent) => void;

export interface MeetingEventRedisPublisher {
  ping(): Promise<unknown>;
  publish(channel: string, payload: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

export interface MeetingEventRedisSubscriber {
  ping(): Promise<unknown>;
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  quit(): Promise<unknown>;
  on(event: "message", listener: (channel: string, payload: string) => void): unknown;
}

export interface MeetingEventRedisClients {
  publisher: MeetingEventRedisPublisher;
  subscriber: MeetingEventRedisSubscriber;
}

export function parseMeetingEvent(payload: string): MeetingEvent | null {
  try {
    const result = meetingSseEventEnvelopeSchema.safeParse(JSON.parse(payload) as unknown);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export class MeetingEventBus {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly subscriptionPromises = new Map<string, Promise<void>>();
  private readonly subscribedMeetings = new Set<string>();
  private readonly publisher?: MeetingEventRedisPublisher;
  private readonly subscriber?: MeetingEventRedisSubscriber;

  constructor(redisUrl?: string, clients?: MeetingEventRedisClients) {
    if (!redisUrl && !clients) return;
    this.publisher = clients?.publisher ?? new Redis(redisUrl!, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    this.subscriber = clients?.subscriber ?? new Redis(redisUrl!, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    this.subscriber.on("message", (_channel: string, payload: string) => {
      const event = parseMeetingEvent(payload);
      if (event) this.dispatch(event);
    });
  }

  async ready(): Promise<void> {
    if (!this.publisher || !this.subscriber) return;
    await Promise.all([this.publisher.ping(), this.subscriber.ping()]);
  }

  async subscribe(meetingId: string, listener: Listener): Promise<() => void> {
    const existing = this.listeners.get(meetingId) ?? new Set<Listener>();
    existing.add(listener);
    this.listeners.set(meetingId, existing);
    const subscription = this.subscriber
      ? this.enqueueSubscriptionOperation(meetingId, async () => {
        if (!this.listeners.get(meetingId)?.has(listener) || this.subscribedMeetings.has(meetingId)) return;
        await this.subscriber!.subscribe(this.channel(meetingId));
        this.subscribedMeetings.add(meetingId);
      })
      : Promise.resolve();
    try {
      await subscription;
    } catch (error) {
      const current = this.listeners.get(meetingId);
      current?.delete(listener);
      if (!current || current.size === 0) this.listeners.delete(meetingId);
      if (this.subscriptionPromises.get(meetingId) === subscription) {
        this.subscriptionPromises.delete(meetingId);
      }
      throw error;
    }

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const current = this.listeners.get(meetingId);
      current?.delete(listener);
      if (!current || current.size === 0) {
        this.listeners.delete(meetingId);
        if (this.subscriber) {
          const unsubscription = this.enqueueSubscriptionOperation(meetingId, async () => {
            if ((this.listeners.get(meetingId)?.size ?? 0) > 0 || !this.subscribedMeetings.has(meetingId)) return;
            try {
              await this.subscriber!.unsubscribe(this.channel(meetingId));
            } finally {
              this.subscribedMeetings.delete(meetingId);
            }
          });
          void unsubscription.catch(() => undefined);
        }
      }
    };
  }

  async publish(event: MeetingEvent): Promise<void> {
    const validated = meetingSseEventEnvelopeSchema.parse(event);
    if (this.publisher) {
      await this.publisher.publish(this.channel(validated.meetingId), JSON.stringify(validated));
      return;
    }
    this.dispatch(validated);
  }

  publishLocal(event: MeetingEvent): void {
    this.dispatch(meetingSseEventEnvelopeSchema.parse(event));
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.subscriptionPromises.values());
    await Promise.all([this.publisher?.quit(), this.subscriber?.quit()]);
  }

  private dispatch(event: MeetingEvent): void {
    for (const listener of this.listeners.get(event.meetingId) ?? []) listener(event);
  }

  private channel(meetingId: string): string {
    return `council:meeting:${meetingId}`;
  }

  private enqueueSubscriptionOperation(meetingId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.subscriptionPromises.get(meetingId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.subscriptionPromises.set(meetingId, current);
    void current.finally(() => {
      if (this.subscriptionPromises.get(meetingId) === current) this.subscriptionPromises.delete(meetingId);
    }).catch(() => undefined);
    return current;
  }
}
