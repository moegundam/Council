import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CouncilJobData, CouncilJobEnvelope, CouncilJobName } from "@council/contracts";
import { InMemoryPlatformStore } from "@council/database";
import { recoverOrphanedAsyncState } from "./async-state-recovery.js";

const redisUrl = process.env.REDIS_RECOVERY_TEST_URL;
if (process.env.REQUIRE_REDIS_RECOVERY_TEST === "1" && !redisUrl) {
  throw new Error("REDIS_RECOVERY_TEST_URL is required for Redis recovery verification.");
}

const describeWithRedis = redisUrl ? describe : describe.skip;

function redisConnection(value: string) {
  const url = new URL(value);
  const database = url.pathname === "/" ? undefined : Number(url.pathname.slice(1));
  if (database !== undefined && (!Number.isInteger(database) || database < 0)) {
    throw new Error("REDIS_RECOVERY_TEST_URL must use a non-negative integer database path.");
  }
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(database === undefined ? {} : { db: database })
  };
}

describeWithRedis("empty Redis recovery against Redis", () => {
  const queueName = `council-recovery-${process.pid}-${Date.now()}`;
  let redis: Redis;
  let queue: Queue<CouncilJobEnvelope | CouncilJobData, void, CouncilJobName>;

  beforeAll(async () => {
    redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    await redis.flushdb();
    queue = new Queue(queueName, { connection: redisConnection(redisUrl!) });
    await queue.waitUntilReady();
  });

  afterAll(async () => {
    await queue?.close();
    if (redis) {
      await redis.flushdb();
      await redis.quit();
    }
  });

  it("preserves a live BullMQ job, then releases its reservation after Redis is emptied", async () => {
    const source = new InMemoryPlatformStore();
    const seed = await source.getSnapshot();
    const meeting = seed.meetings[0]!;
    const participant = seed.participants[1]!;
    seed.speakerQueue = [{
      id: "redis-recovery-job",
      jobId: "redis-recovery-job",
      requestFingerprint: null,
      meetingId: meeting.id,
      agentId: participant.agentId,
      participantId: participant.id,
      roleRevision: participant.roleRevision,
      roleId: participant.roleId,
      roleVersion: participant.roleSnapshot.version,
      kind: "agent_turn",
      label: "Redis recovery proof",
      toolName: null,
      roleName: participant.roleSnapshot.name,
      agendaRevision: meeting.agenda.revision,
      agendaCurrentItemId: meeting.agenda.items[0]!.id,
      status: "queued",
      requestedAt: "2026-08-09T07:00:00.000Z",
      startedAt: null,
      leaseExpiresAt: "2026-08-09T07:05:00.000Z",
      requestedBy: "owner",
      chairSuggestionId: null,
      automationRevision: null
    }];
    const store = new InMemoryPlatformStore(seed);
    await queue.add("agent-turn", { meetingId: meeting.id } as CouncilJobData, {
      jobId: "redis-recovery-job"
    });

    const live = await recoverOrphanedAsyncState({
      store,
      findJob: async (jobId) => (await queue.getJob(jobId)) ?? null
    });
    expect(live).toMatchObject({ checkedJobs: 1, preservedJobs: 1, releasedSpeakerTurns: 0 });
    expect((await store.getSnapshot()).speakerQueue).toHaveLength(1);

    await redis.flushdb();
    const recovered = await recoverOrphanedAsyncState({
      store,
      findJob: async (jobId) => (await queue.getJob(jobId)) ?? null
    });
    expect(recovered).toMatchObject({ checkedJobs: 1, preservedJobs: 0, releasedSpeakerTurns: 1 });
    expect((await store.getSnapshot()).speakerQueue).toEqual([]);
  });
});
