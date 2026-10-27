import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { platformViewNames, type PlatformViewName } from "@council/contracts";
import {
  meetingRecordSchema,
  meetingUtterancePageResponseSchema,
  meetingViewSnapshotSchema,
  platformSnapshotSchema
} from "@council/contracts/api-contracts";
import { parse, parseResponse, sendError, type AppOptions } from "../route-support.js";

const viewParamsSchema = z.object({
  view: z.enum(platformViewNames)
}).strict();
const meetingParamsSchema = z.object({ id: z.string().uuid() }).strict();
const meetingUtteranceQuerySchema = z.object({
  cursor: z.string().trim().min(8).max(2_048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100)
}).strict();

function sendCacheableJson(request: FastifyRequest, reply: FastifyReply, payload: unknown) {
  const etag = `"${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}"`;
  reply.header("etag", etag).header("cache-control", "private, no-cache");
  if (request.headers["if-none-match"] === etag) return reply.code(304).send();
  return reply.send(payload);
}

export function registerViewRoutes(app: FastifyInstance, options: AppOptions): void {
  app.get("/api/views/:view", async (request, reply) => {
    const { view } = parse(viewParamsSchema, request.params) as { view: PlatformViewName };
    const projection = parseResponse(platformSnapshotSchema, await options.store.getViewSnapshot(view));
    return sendCacheableJson(request, reply, projection);
  });

  app.get("/api/meetings/:id/view", async (request, reply) => {
    const { id } = parse(meetingParamsSchema, request.params);
    const projected = await options.store.getMeetingView(id);
    if (!projected) return sendError(reply, 404, "MEETING_NOT_FOUND", "Meeting does not exist.");
    return sendCacheableJson(request, reply, parseResponse(meetingViewSnapshotSchema, projected));
  });

  app.get("/api/meetings/:id/record", async (request, reply) => {
    const { id } = parse(meetingParamsSchema, request.params);
    const record = await options.store.getLatestMeetingRecord(id);
    if (record) return sendCacheableJson(request, reply, parseResponse(meetingRecordSchema, record));
    const meetingIndex = await options.store.getViewSnapshot("discussions");
    if (!meetingIndex.meetings.some((meeting) => meeting.id === id)) {
      return sendError(reply, 404, "MEETING_NOT_FOUND", "Meeting does not exist.");
    }
    return sendError(reply, 404, "MEETING_RECORD_NOT_READY", "Meeting Record has not been generated yet.");
  });

  app.get("/api/meetings/:id/utterances", async (request, reply) => {
    const { id } = parse(meetingParamsSchema, request.params);
    const query = parse(meetingUtteranceQuerySchema, request.query);
    const page = await options.store.listMeetingUtterances(id, {
      cursor: query.cursor ?? null,
      limit: query.limit
    });
    if (!page) return sendError(reply, 404, "MEETING_NOT_FOUND", "Meeting does not exist.");
    return sendCacheableJson(request, reply, parseResponse(meetingUtterancePageResponseSchema, page));
  });
}
