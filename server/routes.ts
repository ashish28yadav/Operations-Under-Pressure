import { Router, type Request, type Response } from "express";
import { authenticate, login, loginInput } from "./auth.js";
import { ApiError } from "./errors.js";
import {
  claimWorkItem,
  createComment,
  createWorkItem,
  getCurrentUser,
  getWorkItem,
  listTeamMembers,
  listWorkItems,
  updateWorkItem,
} from "./services.js";
import {
  claimWorkItemSchema,
  createCommentSchema,
  createWorkItemSchema,
  idempotencyKeySchema,
  itemIdSchema,
  listWorkItemsSchema,
  teamIdSchema,
  updateWorkItemSchema,
} from "./validation.js";

function parse<T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { flatten(): unknown } } }, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "The request contains invalid fields.", result.error.flatten());
  }
  return result.data;
}

function getActorId(request: Request): string {
  if (!request.authUserId) throw new ApiError(401, "AUTHENTICATION_REQUIRED", "A bearer token is required.");
  return request.authUserId;
}

function getIdempotencyKey(request: Request): string {
  return parse(idempotencyKeySchema, request.header("idempotency-key"));
}

function sendMutation(response: Response, result: { status: number; body: Record<string, unknown> }): void {
  response.status(result.status).json(result.body);
}

export const apiRouter = Router();

apiRouter.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

apiRouter.post("/auth/login", async (request, response) => {
  const input = parse(loginInput, request.body);
  response.json(await login(input.email, input.password));
});

apiRouter.use(authenticate);

apiRouter.get("/auth/me", async (request, response) => {
  response.json({ user: await getCurrentUser(getActorId(request)) });
});

apiRouter.get("/teams/:teamId/members", async (request, response) => {
  const teamId = parse(teamIdSchema, request.params.teamId);
  response.json({ members: await listTeamMembers(getActorId(request), teamId) });
});

apiRouter.get("/teams/:teamId/items", async (request, response) => {
  const teamId = parse(teamIdSchema, request.params.teamId);
  const filters = parse(listWorkItemsSchema, request.query);
  response.json({ ...(await listWorkItems(getActorId(request), teamId, filters)) });
});

apiRouter.post("/teams/:teamId/items", async (request, response) => {
  const teamId = parse(teamIdSchema, request.params.teamId);
  const input = parse(createWorkItemSchema, request.body);
  sendMutation(
    response,
    await createWorkItem(getActorId(request), teamId, getIdempotencyKey(request), input),
  );
});

apiRouter.get("/teams/:teamId/items/:itemId", async (request, response) => {
  const teamId = parse(teamIdSchema, request.params.teamId);
  const itemId = parse(itemIdSchema, request.params.itemId);
  response.json({ item: await getWorkItem(getActorId(request), teamId, itemId) });
});

apiRouter.post("/teams/:teamId/items/:itemId/comments", async (request, response) => {
  const teamId = parse(teamIdSchema, request.params.teamId);
  const itemId = parse(itemIdSchema, request.params.itemId);
  const input = parse(createCommentSchema, request.body);
  sendMutation(
    response,
    await createComment(getActorId(request), teamId, itemId, getIdempotencyKey(request), input.body),
  );
});

apiRouter.patch("/teams/:teamId/items/:itemId", async (request, response) => {
  const teamId = parse(teamIdSchema, request.params.teamId);
  const itemId = parse(itemIdSchema, request.params.itemId);
  const input = parse(updateWorkItemSchema, request.body);
  sendMutation(
    response,
    await updateWorkItem(getActorId(request), teamId, itemId, getIdempotencyKey(request), input),
  );
});

apiRouter.post("/teams/:teamId/items/:itemId/claim", async (request, response) => {
  const teamId = parse(teamIdSchema, request.params.teamId);
  const itemId = parse(itemIdSchema, request.params.itemId);
  const input = parse(claimWorkItemSchema, request.body);
  sendMutation(
    response,
    await claimWorkItem(
      getActorId(request),
      teamId,
      itemId,
      getIdempotencyKey(request),
      input.version,
    ),
  );
});
