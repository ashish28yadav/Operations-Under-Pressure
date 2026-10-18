import { createHash } from "node:crypto";
import {
  Prisma,
  type ActivityEvent,
  type Membership,
  type WorkItem,
  type WorkItemPriority,
  type WorkItemStatus,
  type WorkItemType,
} from "@prisma/client";
import { prisma } from "./db.js";
import { ApiError, errorBody } from "./errors.js";

type DbTransaction = Prisma.TransactionClient;
type ServiceResult = { status: number; body: Record<string, unknown> };
type MembershipWithRole = Pick<Membership, "userId" | "teamId" | "role">;

const itemRelations = {
  assignee: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.WorkItemInclude;

type ItemWithRelations = Prisma.WorkItemGetPayload<{ include: typeof itemRelations }>;

function serializeItem(item: ItemWithRelations) {
  return {
    id: item.id,
    teamId: item.teamId,
    title: item.title,
    description: item.description,
    type: item.type,
    priority: item.priority,
    status: item.status,
    assigneeId: item.assigneeId,
    assignee: item.assignee,
    createdById: item.createdById,
    createdBy: item.createdBy,
    dueAt: item.dueAt?.toISOString() ?? null,
    version: item.version,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

function serializeActivity(event: ActivityEvent & { actor?: { id: string; name: string } }) {
  return {
    id: event.id,
    teamId: event.teamId,
    workItemId: event.workItemId,
    actorId: event.actorId,
    ...(event.actor ? { actor: event.actor } : {}),
    kind: event.kind,
    fromValue: event.fromValue,
    toValue: event.toValue,
    createdAt: event.createdAt.toISOString(),
  };
}

function serializeComment(comment: {
  id: string;
  teamId: string;
  workItemId: string;
  authorId: string;
  body: string;
  createdAt: Date;
  author: { id: string; name: string };
}) {
  return {
    id: comment.id,
    teamId: comment.teamId,
    workItemId: comment.workItemId,
    authorId: comment.authorId,
    author: comment.author,
    body: comment.body,
    createdAt: comment.createdAt.toISOString(),
  };
}

function parseResponseBody(value: Prisma.JsonValue): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Stored idempotency response must be a JSON object.");
  }
  return value;
}

function encodeJson(value: Record<string, unknown>): Prisma.InputJsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Idempotency response could not be serialized.");
  }
  return JSON.parse(serialized) as Prisma.InputJsonValue;
}

function isKnownPrismaError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError;
}

function isIdempotencyUniqueConflict(error: Prisma.PrismaClientKnownRequestError): boolean {
  if (error.code !== "P2002") return false;

  const target = error.meta?.target;
  const targets = Array.isArray(target)
    ? target.map((entry) => String(entry))
    : typeof target === "string"
      ? [target]
      : [];
  const targetSummary = targets.join(",");
  const message = error.message ?? "";

  return (
    (targetSummary.includes("actorId") && targetSummary.includes("key")) ||
    message.includes("IdempotencyRecord_actorId_key_key") ||
    message.includes("actorId_key")
  );
}

async function replayIdempotency(
  actorId: string,
  key: string,
  requestHash: string,
): Promise<ServiceResult | undefined> {
  const existing = await prisma.idempotencyRecord.findUnique({
    where: { actorId_key: { actorId, key } },
  });
  if (!existing) return undefined;
  if (existing.requestHash !== requestHash) {
    return {
      status: 409,
      body: errorBody("IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used for a different request."),
    };
  }
  return { status: existing.responseCode, body: parseResponseBody(existing.responseBody) };
}

async function runIdempotent(
  actorId: string,
  key: string,
  request: Record<string, unknown>,
  operation: (transaction: DbTransaction) => Promise<ServiceResult>,
): Promise<ServiceResult> {
  const requestHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (transaction) => {
          const existing = await transaction.idempotencyRecord.findUnique({
            where: { actorId_key: { actorId, key } },
          });
          if (existing) {
            if (existing.requestHash !== requestHash) {
              return {
                status: 409,
                body: errorBody(
                  "IDEMPOTENCY_KEY_REUSED",
                  "This idempotency key was already used for a different request.",
                ),
              };
            }
            return { status: existing.responseCode, body: parseResponseBody(existing.responseBody) };
          }

          const record = await transaction.idempotencyRecord.create({
            data: {
              actorId,
              key,
              requestHash,
              responseCode: 500,
              responseBody: errorBody("REQUEST_IN_PROGRESS", "The request has not completed."),
            },
          });

          let result: ServiceResult;
          try {
            result = await operation(transaction);
          } catch (error) {
            if (!(error instanceof ApiError)) throw error;
            result = { status: error.status, body: errorBody(error.code, error.message, error.details) };
          }

          await transaction.idempotencyRecord.update({
            where: { id: record.id },
            data: { responseCode: result.status, responseBody: encodeJson(result.body) },
          });
          return result;
        },
      );
    } catch (error) {
      if (isKnownPrismaError(error)) {
        if (isIdempotencyUniqueConflict(error) || error.code === "P2034") {
          const replay = await replayIdempotency(actorId, key, requestHash);
          if (replay) return replay;
          if (attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
            continue;
          }
        }
      }
      throw error;
    }
  }

  return {
    status: 409,
    body: errorBody("CONCURRENT_REQUEST", "The request conflicted with another update. Retry with a new idempotency key."),
  };
}

async function requireMembership(
  transaction: DbTransaction,
  actorId: string,
  teamId: string,
): Promise<MembershipWithRole> {
  const membership = await transaction.membership.findUnique({
    where: { userId_teamId: { userId: actorId, teamId } },
    select: { userId: true, teamId: true, role: true },
  });
  if (!membership) throw new ApiError(404, "TEAM_NOT_FOUND", "The requested team was not found.");
  return membership;
}

async function requireReadMembership(actorId: string, teamId: string): Promise<MembershipWithRole> {
  const membership = await prisma.membership.findUnique({
    where: { userId_teamId: { userId: actorId, teamId } },
    select: { userId: true, teamId: true, role: true },
  });
  if (!membership) throw new ApiError(404, "TEAM_NOT_FOUND", "The requested team was not found.");
  return membership;
}

function requireRole(membership: MembershipWithRole, roles: readonly Membership["role"][]): void {
  if (!roles.includes(membership.role)) {
    throw new ApiError(403, "FORBIDDEN", "Your team role does not allow this action.");
  }
}

const editorRoles: readonly Membership["role"][] = ["MEMBER", "LEAD", "ADMIN"];
const leadRoles: readonly Membership["role"][] = ["LEAD", "ADMIN"];
const approvalRoles: readonly Membership["role"][] = ["LEAD"];

async function requireWorkItem(
  transaction: DbTransaction,
  workItemId: string,
  teamId: string,
): Promise<ItemWithRelations> {
  const item = await transaction.workItem.findFirst({
    where: { id: workItemId, teamId },
    include: itemRelations,
  });
  if (!item) throw new ApiError(404, "WORK_ITEM_NOT_FOUND", "The work item was not found.");
  return item;
}

async function requireActiveTeamMember(
  transaction: DbTransaction,
  userId: string,
  teamId: string,
): Promise<void> {
  const membership = await transaction.membership.findFirst({
    where: { userId, teamId, user: { active: true } },
    select: { userId: true },
  });
  if (!membership) {
    throw new ApiError(422, "INVALID_ASSIGNEE", "The assignee must be an active member of this team.");
  }
}

function addActivity(
  transaction: DbTransaction,
  details: {
    teamId: string;
    workItemId: string;
    actorId: string;
    kind: "CREATED" | "STATUS_CHANGED" | "ASSIGNEE_CHANGED" | "PRIORITY_CHANGED" | "ITEM_UPDATED" | "COMMENT_ADDED";
    fromValue?: string | null;
    toValue?: string | null;
  },
) {
  return transaction.activityEvent.create({ data: details });
}

const allowedTransitions: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
  OPEN: ["IN_PROGRESS", "BLOCKED"],
  IN_PROGRESS: ["OPEN", "BLOCKED", "IN_REVIEW"],
  BLOCKED: ["IN_PROGRESS"],
  IN_REVIEW: ["IN_PROGRESS", "APPROVED"],
  APPROVED: ["DONE"],
  DONE: [],
};

function assertTransition(
  role: Membership["role"],
  currentStatus: WorkItemStatus,
  nextStatus: WorkItemStatus,
): void {
  if (!allowedTransitions[currentStatus].includes(nextStatus)) {
    throw new ApiError(
      409,
      "INVALID_STATE_TRANSITION",
      `A work item cannot transition from ${currentStatus} to ${nextStatus}.`,
    );
  }
  if (nextStatus === "APPROVED" && !approvalRoles.includes(role)) {
    throw new ApiError(403, "APPROVAL_REQUIRES_LEAD", "Only a Lead of this team may approve work items.");
  }
}

function encodeCursor(item: Pick<WorkItem, "id" | "updatedAt">): string {
  return Buffer.from(JSON.stringify({ id: item.id, updatedAt: item.updatedAt.toISOString() })).toString("base64url");
}

function decodeCursor(cursor: string): { id: string; updatedAt: Date } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("id" in parsed) ||
      typeof parsed.id !== "string" ||
      !("updatedAt" in parsed) ||
      typeof parsed.updatedAt !== "string"
    ) {
      throw new Error("Invalid cursor payload");
    }
    const updatedAt = new Date(parsed.updatedAt);
    if (Number.isNaN(updatedAt.getTime())) throw new Error("Invalid cursor timestamp");
    return { id: parsed.id, updatedAt };
  } catch {
    throw new ApiError(400, "INVALID_CURSOR", "The pagination cursor is invalid.");
  }
}

export async function getCurrentUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      memberships: {
        orderBy: { team: { name: "asc" } },
        select: { role: true, team: { select: { id: true, slug: true, name: true } } },
      },
    },
  });
  if (!user) throw new ApiError(401, "INVALID_TOKEN", "The account is no longer active.");
  return user;
}

export async function listWorkItems(
  actorId: string,
  teamId: string,
  filters: {
    q?: string;
    type?: WorkItemType;
    priority?: WorkItemPriority | WorkItemPriority[];
    status?: WorkItemStatus;
    assigneeId?: string;
    cursor?: string;
    limit: number;
  },
) {
  await requireReadMembership(actorId, teamId);
  const andFilters: Prisma.WorkItemWhereInput[] = [];
  if (filters.q) {
    andFilters.push({
      OR: [
        { title: { contains: filters.q, mode: "insensitive" } },
        { description: { contains: filters.q, mode: "insensitive" } },
      ],
    });
  }
  if (filters.cursor) {
    const cursor = decodeCursor(filters.cursor);
    andFilters.push({
      OR: [
        { updatedAt: { lt: cursor.updatedAt } },
        { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
      ],
    });
  }
  const where: Prisma.WorkItemWhereInput = {
    teamId,
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.priority
      ? { priority: Array.isArray(filters.priority) ? { in: filters.priority } : filters.priority }
      : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.assigneeId === "unassigned"
      ? { assigneeId: null }
      : filters.assigneeId
        ? { assigneeId: filters.assigneeId }
        : {}),
    ...(andFilters.length > 0 ? { AND: andFilters } : {}),
  };

  const rows = await prisma.workItem.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: filters.limit + 1,
    include: itemRelations,
  });
  const hasMore = rows.length > filters.limit;
  const items = rows.slice(0, filters.limit);
  return {
    items: items.map(serializeItem),
    nextCursor: hasMore ? encodeCursor(items[items.length - 1]) : null,
  };
}

export async function listTeamMembers(actorId: string, teamId: string) {
  await requireReadMembership(actorId, teamId);
  return prisma.membership.findMany({
    where: { teamId, user: { active: true } },
    orderBy: { user: { name: "asc" } },
    select: { userId: true, role: true, user: { select: { id: true, name: true, email: true } } },
  });
}

export async function getWorkItem(actorId: string, teamId: string, workItemId: string) {
  await requireReadMembership(actorId, teamId);
  const item = await prisma.workItem.findFirst({
    where: { id: workItemId, teamId },
    include: {
      ...itemRelations,
      activities: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 100,
        include: { actor: { select: { id: true, name: true } } },
      },
      comments: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 100,
        include: { author: { select: { id: true, name: true } } },
      },
    },
  });
  if (!item) throw new ApiError(404, "WORK_ITEM_NOT_FOUND", "The work item was not found.");
  return {
    ...serializeItem(item),
    activities: item.activities.map(serializeActivity),
    comments: item.comments.map(serializeComment),
  };
}

export function createComment(
  actorId: string,
  teamId: string,
  workItemId: string,
  idempotencyKey: string,
  body: string,
): Promise<ServiceResult> {
  return runIdempotent(
    actorId,
    idempotencyKey,
    { operation: "comment", teamId, workItemId, body },
    async (transaction) => {
      const membership = await requireMembership(transaction, actorId, teamId);
      requireRole(membership, editorRoles);
      const item = await requireWorkItem(transaction, workItemId, teamId);
      if (
        membership.role === "MEMBER" &&
        item.assigneeId !== actorId &&
        item.createdById !== actorId
      ) {
        throw new ApiError(403, "FORBIDDEN", "Members may comment only on work items they created or claimed.");
      }

      const comment = await transaction.comment.create({
        data: { teamId, workItemId, authorId: actorId, body },
        include: { author: { select: { id: true, name: true } } },
      });
      await addActivity(transaction, {
        teamId,
        workItemId,
        actorId,
        kind: "COMMENT_ADDED",
        toValue: comment.id,
      });
      return { status: 201, body: { comment: serializeComment(comment) } };
    },
  );
}

export function createWorkItem(
  actorId: string,
  teamId: string,
  idempotencyKey: string,
  input: {
    title: string;
    description: string;
    type: WorkItemType;
    priority: WorkItemPriority;
    assigneeId?: string | null;
    dueAt?: string | null;
  },
): Promise<ServiceResult> {
  return runIdempotent(
    actorId,
    idempotencyKey,
    { operation: "create", teamId, input },
    async (transaction) => {
      const membership = await requireMembership(transaction, actorId, teamId);
      requireRole(membership, editorRoles);
      if (input.assigneeId) {
        requireRole(membership, leadRoles);
        await requireActiveTeamMember(transaction, input.assigneeId, teamId);
      }

      const item = await transaction.workItem.create({
        data: {
          teamId,
          title: input.title,
          description: input.description,
          type: input.type,
          priority: input.priority,
          assigneeId: input.assigneeId ?? null,
          createdById: actorId,
          dueAt: input.dueAt ? new Date(input.dueAt) : null,
        },
        include: itemRelations,
      });
      await addActivity(transaction, {
        teamId,
        workItemId: item.id,
        actorId,
        kind: "CREATED",
        toValue: JSON.stringify({
          title: item.title,
          type: item.type,
          priority: item.priority,
          status: item.status,
          assigneeId: item.assigneeId,
        }),
      });
      return { status: 201, body: { item: serializeItem(item) } };
    },
  );
}

export function claimWorkItem(
  actorId: string,
  teamId: string,
  workItemId: string,
  idempotencyKey: string,
  version: number,
): Promise<ServiceResult> {
  return runIdempotent(
    actorId,
    idempotencyKey,
    { operation: "claim", teamId, workItemId, version },
    async (transaction) => {
      const membership = await requireMembership(transaction, actorId, teamId);
      requireRole(membership, editorRoles);
      const item = await requireWorkItem(transaction, workItemId, teamId);
      if (item.version !== version) {
        throw new ApiError(409, "STALE_VERSION", "The work item changed. Refresh it and retry with the latest version.");
      }
      if (item.status !== "OPEN" || item.assigneeId !== null) {
        throw new ApiError(409, "ITEM_NOT_CLAIMABLE", "Only unassigned Open work items can be claimed.");
      }

      const changed = await transaction.workItem.updateMany({
        where: { id: workItemId, teamId, version, status: "OPEN", assigneeId: null },
        data: { assigneeId: actorId, version: { increment: 1 } },
      });
      if (changed.count !== 1) {
        throw new ApiError(409, "ITEM_NOT_CLAIMABLE", "Another teammate claimed this work item first.");
      }
      const updated = await requireWorkItem(transaction, workItemId, teamId);
      await addActivity(transaction, {
        teamId,
        workItemId,
        actorId,
        kind: "ASSIGNEE_CHANGED",
        fromValue: null,
        toValue: actorId,
      });
      return { status: 200, body: { item: serializeItem(updated) } };
    },
  );
}

export function updateWorkItem(
  actorId: string,
  teamId: string,
  workItemId: string,
  idempotencyKey: string,
  input: {
    version: number;
    title?: string;
    description?: string;
    type?: WorkItemType;
    priority?: WorkItemPriority;
    status?: WorkItemStatus;
    assigneeId?: string | null;
    dueAt?: string | null;
  },
): Promise<ServiceResult> {
  return runIdempotent(
    actorId,
    idempotencyKey,
    { operation: "update", teamId, workItemId, input },
    async (transaction) => {
      const membership = await requireMembership(transaction, actorId, teamId);
      requireRole(membership, editorRoles);
      const item = await requireWorkItem(transaction, workItemId, teamId);
      if (item.version !== input.version) {
        throw new ApiError(409, "STALE_VERSION", "The work item changed. Refresh it and retry with the latest version.");
      }
      if (
        membership.role === "MEMBER" &&
        item.assigneeId !== actorId &&
        item.createdById !== actorId
      ) {
        throw new ApiError(403, "FORBIDDEN", "Members may edit only work items they created or claimed.");
      }
      if (input.assigneeId !== undefined && input.assigneeId !== item.assigneeId) {
        requireRole(membership, leadRoles);
        if (input.assigneeId) await requireActiveTeamMember(transaction, input.assigneeId, teamId);
      }
      if (input.status !== undefined && input.status !== item.status) {
        assertTransition(membership.role, item.status, input.status);
      }

      const patch: Prisma.WorkItemUncheckedUpdateManyInput = {};
      if (input.title !== undefined && input.title !== item.title) patch.title = input.title;
      if (input.description !== undefined && input.description !== item.description) {
        patch.description = input.description;
      }
      if (input.type !== undefined && input.type !== item.type) patch.type = input.type;
      if (input.priority !== undefined && input.priority !== item.priority) patch.priority = input.priority;
      if (input.status !== undefined && input.status !== item.status) patch.status = input.status;
      if (input.assigneeId !== undefined && input.assigneeId !== item.assigneeId) {
        patch.assigneeId = input.assigneeId;
      }
      if (input.dueAt !== undefined) {
        const dueAt = input.dueAt === null ? null : new Date(input.dueAt);
        if (dueAt?.getTime() !== item.dueAt?.getTime()) patch.dueAt = dueAt;
      }
      if (Object.keys(patch).length === 0) {
        return { status: 200, body: { item: serializeItem(item) } };
      }

      const changed = await transaction.workItem.updateMany({
        where: { id: workItemId, teamId, version: input.version },
        data: { ...patch, version: { increment: 1 } },
      });
      if (changed.count !== 1) {
        throw new ApiError(409, "STALE_VERSION", "The work item changed. Refresh it and retry with the latest version.");
      }
      const updated = await requireWorkItem(transaction, workItemId, teamId);

      if (item.status !== updated.status) {
        await addActivity(transaction, {
          teamId,
          workItemId,
          actorId,
          kind: "STATUS_CHANGED",
          fromValue: item.status,
          toValue: updated.status,
        });
      }
      if (item.assigneeId !== updated.assigneeId) {
        await addActivity(transaction, {
          teamId,
          workItemId,
          actorId,
          kind: "ASSIGNEE_CHANGED",
          fromValue: item.assigneeId,
          toValue: updated.assigneeId,
        });
      }
      if (item.priority !== updated.priority) {
        await addActivity(transaction, {
          teamId,
          workItemId,
          actorId,
          kind: "PRIORITY_CHANGED",
          fromValue: item.priority,
          toValue: updated.priority,
        });
      }
      const detailsChanged =
        item.title !== updated.title ||
        item.description !== updated.description ||
        item.type !== updated.type ||
        item.dueAt?.getTime() !== updated.dueAt?.getTime();
      if (detailsChanged) {
        await addActivity(transaction, {
          teamId,
          workItemId,
          actorId,
          kind: "ITEM_UPDATED",
          fromValue: JSON.stringify({
            title: item.title,
            description: item.description,
            type: item.type,
            dueAt: item.dueAt?.toISOString() ?? null,
          }),
          toValue: JSON.stringify({
            title: updated.title,
            description: updated.description,
            type: updated.type,
            dueAt: updated.dueAt?.toISOString() ?? null,
          }),
        });
      }
      return { status: 200, body: { item: serializeItem(updated) } };
    },
  );
}
