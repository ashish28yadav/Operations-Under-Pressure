import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { scryptSync } from "node:crypto";
import request from "supertest";
import { app } from "../server/app.js";
import { prisma } from "../server/db.js";

const password = "test-password-123";
const passwordSalt = "newtonite-api-test-salt";
const passwordHash = `${passwordSalt}:${scryptSync(password, passwordSalt, 64).toString("hex")}`;

type Fixture = {
  operationsTeamId: string;
  platformTeamId: string;
  leadId: string;
  leadToken: string;
  memberId: string;
  memberToken: string;
  secondMemberId: string;
  secondMemberToken: string;
  viewerToken: string;
  adminId: string;
  adminToken: string;
  platformLeadToken: string;
};

let fixture: Fixture;
let counter = 0;

function newKey(): string {
  counter += 1;
  return `api-test-${Date.now()}-${counter}`;
}

function fixtureId(index: number): string {
  return `c${index.toString(36).padStart(24, "0")}`;
}

async function signedInToken(email: string): Promise<string> {
  const response = await request(app).post("/api/auth/login").send({ email, password });
  expect(response.status).toBe(200);
  return response.body.token as string;
}

async function createItem(
  token = fixture.leadToken,
  input: Record<string, unknown> = {},
  idempotencyKey = newKey(),
) {
  return request(app)
    .post(`/api/teams/${fixture.operationsTeamId}/items`)
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", idempotencyKey)
    .send({ title: `Test work ${newKey()}`, type: "TASK", ...input });
}

describe("Operations Under Pressure API", () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "IdempotencyRecord", "Comment", "ActivityEvent", "WorkItem", "Membership", "User", "Team" RESTART IDENTITY CASCADE',
    );
    const operations = await prisma.team.create({ data: { slug: "ops-test", name: "Operations Test" } });
    const platform = await prisma.team.create({ data: { slug: "platform-test", name: "Platform Test" } });

    const users = await Promise.all([
      prisma.user.create({ data: { email: "lead@test.newtonite.dev", name: "Test Lead", passwordHash } }),
      prisma.user.create({ data: { email: "member@test.newtonite.dev", name: "Test Member", passwordHash } }),
      prisma.user.create({ data: { email: "member-two@test.newtonite.dev", name: "Second Member", passwordHash } }),
      prisma.user.create({ data: { email: "viewer@test.newtonite.dev", name: "Test Viewer", passwordHash } }),
      prisma.user.create({ data: { email: "admin@test.newtonite.dev", name: "Test Admin", passwordHash } }),
      prisma.user.create({ data: { email: "platform-lead@test.newtonite.dev", name: "Platform Lead", passwordHash } }),
    ]);
    const [lead, member, secondMember, viewer, admin, platformLead] = users;
    await prisma.membership.createMany({
      data: [
        { userId: lead.id, teamId: operations.id, role: "LEAD" },
        { userId: member.id, teamId: operations.id, role: "MEMBER" },
        { userId: secondMember.id, teamId: operations.id, role: "MEMBER" },
        { userId: viewer.id, teamId: operations.id, role: "VIEWER" },
        { userId: admin.id, teamId: operations.id, role: "ADMIN" },
        { userId: platformLead.id, teamId: platform.id, role: "LEAD" },
      ],
    });

    fixture = {
      operationsTeamId: operations.id,
      platformTeamId: platform.id,
      leadId: lead.id,
      leadToken: await signedInToken(lead.email),
      memberId: member.id,
      memberToken: await signedInToken(member.email),
      secondMemberId: secondMember.id,
      secondMemberToken: await signedInToken(secondMember.email),
      viewerToken: await signedInToken(viewer.email),
      adminId: admin.id,
      adminToken: await signedInToken(admin.email),
      platformLeadToken: await signedInToken(platformLead.email),
    };
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("allows exactly one concurrent claimant and records the winning owner change", async () => {
    const created = await createItem();
    expect(created.status).toBe(201);
    const itemId = created.body.item.id as string;

    const claims = await Promise.all([
      request(app)
        .post(`/api/teams/${fixture.operationsTeamId}/items/${itemId}/claim`)
        .set("Authorization", `Bearer ${fixture.memberToken}`)
        .set("Idempotency-Key", newKey())
        .send({ version: 1 }),
      request(app)
        .post(`/api/teams/${fixture.operationsTeamId}/items/${itemId}/claim`)
        .set("Authorization", `Bearer ${fixture.secondMemberToken}`)
        .set("Idempotency-Key", newKey())
        .send({ version: 1 }),
    ]);

    expect(claims.map((response) => response.status).sort()).toEqual([200, 409]);
    const saved = await prisma.workItem.findUniqueOrThrow({ where: { id: itemId } });
    expect([fixture.memberId, fixture.secondMemberId]).toContain(saved.assigneeId);
    expect(saved.version).toBe(2);
    expect(await prisma.activityEvent.count({ where: { workItemId: itemId, kind: "ASSIGNEE_CHANGED" } })).toBe(1);
  });

  it("replays duplicate creates and rejects reusing a key for different input", async () => {
    const key = newKey();
    const payload = { title: "One recorded request", type: "BUG", priority: "P1" };
    const [first, retry] = await Promise.all([
      createItem(fixture.leadToken, payload, key),
      createItem(fixture.leadToken, payload, key),
    ]);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(first.status);
    expect(retry.body).toEqual(first.body);
    expect(await prisma.workItem.count({ where: { title: payload.title } })).toBe(1);
    expect(await prisma.activityEvent.count({ where: { workItemId: first.body.item.id } })).toBe(1);

    const changedPayload = await createItem(fixture.leadToken, { title: "Changed payload", type: "TASK" }, key);
    expect(changedPayload.status).toBe(409);
    expect(changedPayload.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("replays duplicate comments and records each comment in the item timeline", async () => {
    const created = await createItem(fixture.memberToken);
    const itemId = created.body.item.id as string;
    const key = newKey();
    const endpoint = `/api/teams/${fixture.operationsTeamId}/items/${itemId}/comments`;
    const sendComment = () => request(app)
      .post(endpoint)
      .set("Authorization", `Bearer ${fixture.memberToken}`)
      .set("Idempotency-Key", key)
      .send({ body: "Investigating the production alert." });

    const [first, retry] = await Promise.all([sendComment(), sendComment()]);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect(await prisma.comment.count({ where: { workItemId: itemId } })).toBe(1);
    expect(await prisma.activityEvent.count({ where: { workItemId: itemId, kind: "COMMENT_ADDED" } })).toBe(1);

    const detail = await request(app)
      .get(`/api/teams/${fixture.operationsTeamId}/items/${itemId}`)
      .set("Authorization", `Bearer ${fixture.memberToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body.item.comments).toHaveLength(1);
    expect(detail.body.item.comments[0].body).toBe("Investigating the production alert.");
    expect(detail.body.item.comments[0].author.name).toBe("Test Member");
    const commentEvent = detail.body.item.activities.find((event: { kind: string; actor: { name: string } }) =>
      event.kind === "COMMENT_ADDED");
    expect(commentEvent).toBeDefined();
    expect(commentEvent?.actor.name).toBe("Test Member");
    const commentId = first.body.comment.id as string;
    await expect(prisma.comment.update({ where: { id: commentId }, data: { body: "Edited" } })).rejects.toThrow();
    await expect(prisma.comment.delete({ where: { id: commentId } })).rejects.toThrow();
    expect(await prisma.comment.count({ where: { id: commentId } })).toBe(1);
  });

  it("rejects cross-team comment access", async () => {
    const created = await createItem();
    const response = await request(app)
      .post(`/api/teams/${fixture.platformTeamId}/items/${created.body.item.id}/comments`)
      .set("Authorization", `Bearer ${fixture.platformLeadToken}`)
      .set("Idempotency-Key", newKey())
      .send({ body: "Should not be visible across teams." });
    expect(response.status).toBe(404);
    expect(await prisma.comment.count()).toBe(0);
  });

  it("rolls back the comment and idempotency record if its activity event fails", async () => {
    const created = await createItem(fixture.memberToken);
    const itemId = created.body.item.id as string;
    const key = newKey();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION "test_reject_comment_activity"() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW."kind" = 'COMMENT_ADDED' THEN
            RAISE EXCEPTION 'injected activity insert failure';
          END IF;
          RETURN NEW;
        END;
        $$
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER "test_reject_comment_activity"
        BEFORE INSERT ON "ActivityEvent"
        FOR EACH ROW EXECUTE FUNCTION "test_reject_comment_activity"()
      `);
      const response = await request(app)
        .post(`/api/teams/${fixture.operationsTeamId}/items/${itemId}/comments`)
        .set("Authorization", `Bearer ${fixture.memberToken}`)
        .set("Idempotency-Key", key)
        .send({ body: "This must roll back." });
      expect(response.status).toBe(500);
      expect(await prisma.comment.count({ where: { workItemId: itemId } })).toBe(0);
      expect(await prisma.idempotencyRecord.count({ where: { actorId: fixture.memberId, key } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS "test_reject_comment_activity" ON "ActivityEvent"');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS "test_reject_comment_activity"()');
      consoleError.mockRestore();
    }
  });

  it("returns 409 when an update uses a stale version", async () => {
    const created = await createItem(fixture.memberToken);
    const itemId = created.body.item.id as string;
    const firstUpdate = await request(app)
      .patch(`/api/teams/${fixture.operationsTeamId}/items/${itemId}`)
      .set("Authorization", `Bearer ${fixture.memberToken}`)
      .set("Idempotency-Key", newKey())
      .send({ version: 1, status: "IN_PROGRESS", priority: "P0" });
    const staleUpdate = await request(app)
      .patch(`/api/teams/${fixture.operationsTeamId}/items/${itemId}`)
      .set("Authorization", `Bearer ${fixture.memberToken}`)
      .set("Idempotency-Key", newKey())
      .send({ version: 1, priority: "P0" });

    expect(firstUpdate.status).toBe(200);
    expect(firstUpdate.body.item.version).toBe(2);
    expect(staleUpdate.status).toBe(409);
    expect(staleUpdate.body.error.code).toBe("STALE_VERSION");
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: itemId } })).priority).toBe("P0");
    expect(await prisma.activityEvent.count({ where: { workItemId: itemId, kind: "PRIORITY_CHANGED" } })).toBe(1);
  });

  it("rejects invalid transitions, restricts approval to a team Lead, and allows Lead approval", async () => {
    const created = await createItem(fixture.memberToken);
    const itemId = created.body.item.id as string;
    const invalid = await request(app)
      .patch(`/api/teams/${fixture.operationsTeamId}/items/${itemId}`)
      .set("Authorization", `Bearer ${fixture.memberToken}`)
      .set("Idempotency-Key", newKey())
      .send({ version: 1, status: "DONE" });
    expect(invalid.status).toBe(409);
    expect(invalid.body.error.code).toBe("INVALID_STATE_TRANSITION");

    const inProgress = await request(app)
      .patch(`/api/teams/${fixture.operationsTeamId}/items/${itemId}`)
      .set("Authorization", `Bearer ${fixture.memberToken}`)
      .set("Idempotency-Key", newKey())
      .send({ version: 1, status: "IN_PROGRESS" });
    const inReview = await request(app)
      .patch(`/api/teams/${fixture.operationsTeamId}/items/${itemId}`)
      .set("Authorization", `Bearer ${fixture.memberToken}`)
      .set("Idempotency-Key", newKey())
      .send({ version: 2, status: "IN_REVIEW" });
    const forbiddenApproval = await request(app)
      .patch(`/api/teams/${fixture.operationsTeamId}/items/${itemId}`)
      .set("Authorization", `Bearer ${fixture.memberToken}`)
      .set("Idempotency-Key", newKey())
      .send({ version: 3, status: "APPROVED" });
    const adminApproval = await request(app)
      .patch(`/api/teams/${fixture.operationsTeamId}/items/${itemId}`)
      .set("Authorization", `Bearer ${fixture.adminToken}`)
      .set("Idempotency-Key", newKey())
      .send({ version: 3, status: "APPROVED" });
    const otherTeamLeadApproval = await request(app)
      .patch(`/api/teams/${fixture.operationsTeamId}/items/${itemId}`)
      .set("Authorization", `Bearer ${fixture.platformLeadToken}`)
      .set("Idempotency-Key", newKey())
      .send({ version: 3, status: "APPROVED" });
    const approved = await request(app)
      .patch(`/api/teams/${fixture.operationsTeamId}/items/${itemId}`)
      .set("Authorization", `Bearer ${fixture.leadToken}`)
      .set("Idempotency-Key", newKey())
      .send({ version: 3, status: "APPROVED" });

    expect(inProgress.status).toBe(200);
    expect(inReview.status).toBe(200);
    expect(forbiddenApproval.status).toBe(403);
    expect(forbiddenApproval.body.error.code).toBe("APPROVAL_REQUIRES_LEAD");
    expect(adminApproval.status).toBe(403);
    expect(adminApproval.body.error.code).toBe("APPROVAL_REQUIRES_LEAD");
    expect(otherTeamLeadApproval.status).toBe(404);
    expect(otherTeamLeadApproval.body.error.code).toBe("TEAM_NOT_FOUND");
    expect(approved.status).toBe(200);
    expect(approved.body.item.status).toBe("APPROVED");
    expect(await prisma.activityEvent.count({ where: { workItemId: itemId, kind: "STATUS_CHANGED" } })).toBe(3);
  });

  it("keeps team reads and item lookups inside the caller's membership scope", async () => {
    const platformItem = await request(app)
      .post(`/api/teams/${fixture.platformTeamId}/items`)
      .set("Authorization", `Bearer ${fixture.platformLeadToken}`)
      .set("Idempotency-Key", newKey())
      .send({ title: "Platform only", type: "TASK" });
    expect(platformItem.status).toBe(201);

    const list = await request(app)
      .get(`/api/teams/${fixture.platformTeamId}/items`)
      .set("Authorization", `Bearer ${fixture.memberToken}`);
    const item = await request(app)
      .get(`/api/teams/${fixture.platformTeamId}/items/${platformItem.body.item.id}`)
      .set("Authorization", `Bearer ${fixture.memberToken}`);
    expect(list.status).toBe(404);
    expect(item.status).toBe(404);
    expect(list.body.error.code).toBe("TEAM_NOT_FOUND");
    expect(item.body.error.code).toBe("TEAM_NOT_FOUND");
  });

  it("applies server-side search, filters, and stable cursor pagination", async () => {
    await createItem(fixture.leadToken, { title: "Dispatch delay alpha", description: "critical alert", priority: "P1" });
    await createItem(fixture.leadToken, { title: "Dispatch delay beta", description: "routine", priority: "P1" });
    await createItem(fixture.leadToken, { title: "Inventory review", description: "critical alert", priority: "P1" });

    const first = await request(app)
      .get(`/api/teams/${fixture.operationsTeamId}/items?q=dispatch&priority=P1&limit=1`)
      .set("Authorization", `Bearer ${fixture.leadToken}`);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.items[0].title).toContain("Dispatch");
    expect(first.body.nextCursor).toBeTruthy();

    const next = await request(app)
      .get(`/api/teams/${fixture.operationsTeamId}/items?q=dispatch&priority=P1&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .set("Authorization", `Bearer ${fixture.leadToken}`);
    expect(next.status).toBe(200);
    expect(next.body.items).toHaveLength(1);
    expect(next.body.items[0].title).toContain("Dispatch");
    expect(next.body.nextCursor).toBeNull();
  });

  it("filters multiple priorities and unassigned urgent items before cursor pagination", async () => {
    const now = Date.parse("2026-10-18T00:00:00.000Z");
    const urgentUnassigned = Array.from({ length: 31 }, (_, index) => ({
      id: fixtureId(1000 + index),
      teamId: fixture.operationsTeamId,
      title: `Pagination urgent ${index.toString().padStart(2, "0")}`,
      description: "urgent pagination fixture",
      type: "INCIDENT" as const,
      priority: index % 2 === 0 ? "P0" as const : "P1" as const,
      status: "OPEN" as const,
      assigneeId: null,
      createdById: fixture.leadId,
      dueAt: new Date(now + index * 1000),
      version: 1,
      createdAt: new Date(now + index * 1000),
      updatedAt: new Date(now + index * 1000),
    }));
    const excluded = [
      ...Array.from({ length: 6 }, (_, index) => ({
        id: fixtureId(2000 + index),
        teamId: fixture.operationsTeamId,
        title: `Pagination urgent nonurgent ${index}`,
        description: "urgent pagination fixture",
        type: "TASK" as const,
        priority: index % 2 === 0 ? "P2" as const : "P3" as const,
        status: "OPEN" as const,
        assigneeId: null,
        createdById: fixture.leadId,
        dueAt: null,
        version: 1,
        createdAt: new Date(now + 40_000 + index * 1000),
        updatedAt: new Date(now + 40_000 + index * 1000),
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        id: fixtureId(3000 + index),
        teamId: fixture.operationsTeamId,
        title: `Pagination urgent assigned ${index}`,
        description: "urgent pagination fixture",
        type: "INCIDENT" as const,
        priority: "P0" as const,
        status: "OPEN" as const,
        assigneeId: fixture.memberId,
        createdById: fixture.leadId,
        dueAt: null,
        version: 1,
        createdAt: new Date(now + 50_000 + index * 1000),
        updatedAt: new Date(now + 50_000 + index * 1000),
      })),
      ...Array.from({ length: 2 }, (_, index) => ({
        id: fixtureId(4000 + index),
        teamId: fixture.platformTeamId,
        title: `Pagination urgent other team ${index}`,
        description: "urgent pagination fixture",
        type: "INCIDENT" as const,
        priority: "P0" as const,
        status: "OPEN" as const,
        assigneeId: null,
        createdById: fixture.leadId,
        dueAt: null,
        version: 1,
        createdAt: new Date(now + 60_000 + index * 1000),
        updatedAt: new Date(now + 60_000 + index * 1000),
      })),
    ];

    await prisma.workItem.createMany({ data: [...urgentUnassigned, ...excluded.slice(0, 11)] });
    const platformTeamLeadId = (await prisma.membership.findFirstOrThrow({
      where: { teamId: fixture.platformTeamId, role: "LEAD" },
      select: { userId: true },
    })).userId;
    await prisma.workItem.createMany({
      data: excluded.slice(11).map((item) => ({ ...item, createdById: platformTeamLeadId })),
    });

    const foundIds: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await request(app)
        .get(`/api/teams/${fixture.operationsTeamId}/items`)
        .query({ q: "urgent pagination fixture", priority: "P0,P1", assigneeId: "unassigned", limit: 7, ...(cursor ? { cursor } : {}) })
        .set("Authorization", `Bearer ${fixture.memberToken}`);
      expect(response.status).toBe(200);
      for (const item of response.body.items) {
        foundIds.push(item.id as string);
        expect(["P0", "P1"]).toContain(item.priority);
        expect(item.assigneeId).toBeNull();
        expect(item.teamId).toBe(fixture.operationsTeamId);
      }
      cursor = response.body.nextCursor as string | null;
    } while (cursor);

    expect(foundIds).toHaveLength(urgentUnassigned.length);
    expect(new Set(foundIds).size).toBe(urgentUnassigned.length);
    expect(new Set(foundIds)).toEqual(new Set(urgentUnassigned.map((item) => item.id)));

    const unauthorized = await request(app)
      .get(`/api/teams/${fixture.platformTeamId}/items`)
      .query({ priority: "P0,P1", assigneeId: "unassigned", q: "urgent pagination fixture" })
      .set("Authorization", `Bearer ${fixture.memberToken}`);
    expect(unauthorized.status).toBe(404);
    expect(unauthorized.body.items).toBeUndefined();
  });

  it("denies write operations to team Viewers", async () => {
    const response = await createItem(fixture.viewerToken);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("does not allow Members to assign work outside the atomic claim workflow", async () => {
    const response = await createItem(fixture.memberToken, {
      title: "Member assignment attempt",
      type: "TASK",
      assigneeId: fixture.secondMemberId,
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(await prisma.workItem.count({ where: { title: "Member assignment attempt" } })).toBe(0);
  });

  it("rejects updates and deletes of activity events in PostgreSQL", async () => {
    const created = await createItem();
    const event = await prisma.activityEvent.findFirstOrThrow({
      where: { workItemId: created.body.item.id as string },
    });

    await expect(
      prisma.activityEvent.update({ where: { id: event.id }, data: { toValue: "tampered" } }),
    ).rejects.toThrow();
    await expect(prisma.activityEvent.delete({ where: { id: event.id } })).rejects.toThrow();
    expect(await prisma.activityEvent.count({ where: { workItemId: event.workItemId } })).toBe(1);
  });
});
