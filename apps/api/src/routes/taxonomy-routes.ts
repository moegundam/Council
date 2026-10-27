import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createCategorySchema,
  createGroupSchema,
  createTagSchema,
  updateCategorySchema,
  updateGroupSchema,
  updateTagSchema
} from "@council/contracts";
import {
  categoryResponseSchema,
  discussionGroupResponseSchema,
  tagResponseSchema
} from "@council/contracts/api-contracts";
import { idempotencyKey, parse, parseResponse, sendError, type AppOptionsFor } from "../route-support.js";

type TaxonomyStoreMethods =
  | "createCategory"
  | "createGroup"
  | "createTag"
  | "updateCategory"
  | "updateGroup"
  | "updateTag";
export type TaxonomyRouteOptions = AppOptionsFor<TaxonomyStoreMethods>;

export function registerTaxonomyRoutes(app: FastifyInstance, options: TaxonomyRouteOptions): void {
  app.post("/api/groups", async (request, reply) => {
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const group = await options.store.createGroup(parse(createGroupSchema, request.body), requestKey);
    return reply.code(201).send(parseResponse(discussionGroupResponseSchema, group));
  });

  app.post("/api/categories", async (request, reply) => {
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const category = await options.store.createCategory(parse(createCategorySchema, request.body), requestKey);
    return reply.code(201).send(parseResponse(categoryResponseSchema, category));
  });

  app.post("/api/tags", async (request, reply) => {
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const tag = await options.store.createTag(parse(createTagSchema, request.body), requestKey);
    return reply.code(201).send(parseResponse(tagResponseSchema, tag));
  });

  app.patch("/api/groups/:id", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    return reply.send(parseResponse(
      discussionGroupResponseSchema,
      await options.store.updateGroup(id, parse(updateGroupSchema, request.body))
    ));
  });

  app.patch("/api/categories/:id", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    return reply.send(parseResponse(
      categoryResponseSchema,
      await options.store.updateCategory(id, parse(updateCategorySchema, request.body))
    ));
  });

  app.patch("/api/tags/:id", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    return reply.send(parseResponse(
      tagResponseSchema,
      await options.store.updateTag(id, parse(updateTagSchema, request.body))
    ));
  });
}
