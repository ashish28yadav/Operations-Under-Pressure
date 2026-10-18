-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TeamRole" AS ENUM ('VIEWER', 'MEMBER', 'LEAD', 'ADMIN');

-- CreateEnum
CREATE TYPE "WorkItemType" AS ENUM ('TASK', 'BUG', 'INCIDENT', 'REQUEST');

-- CreateEnum
CREATE TYPE "WorkItemPriority" AS ENUM ('P0', 'P1', 'P2', 'P3');

-- CreateEnum
CREATE TYPE "WorkItemStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'APPROVED', 'DONE');

-- CreateEnum
CREATE TYPE "ActivityKind" AS ENUM ('CREATED', 'STATUS_CHANGED', 'ASSIGNEE_CHANGED', 'PRIORITY_CHANGED', 'ITEM_UPDATED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "userId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "role" "TeamRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("userId","teamId")
);

-- CreateTable
CREATE TABLE "WorkItem" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "type" "WorkItemType" NOT NULL,
    "priority" "WorkItemPriority" NOT NULL DEFAULT 'P2',
    "status" "WorkItemStatus" NOT NULL DEFAULT 'OPEN',
    "assigneeId" TEXT,
    "createdById" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityEvent" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "kind" "ActivityKind" NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "key" VARCHAR(200) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "responseCode" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Team_slug_key" ON "Team"("slug");

-- CreateIndex
CREATE INDEX "Membership_teamId_role_idx" ON "Membership"("teamId", "role");

-- CreateIndex
CREATE INDEX "WorkItem_teamId_updatedAt_id_idx" ON "WorkItem"("teamId", "updatedAt", "id");

-- CreateIndex
CREATE INDEX "WorkItem_teamId_status_updatedAt_id_idx" ON "WorkItem"("teamId", "status", "updatedAt", "id");

-- CreateIndex
CREATE INDEX "WorkItem_teamId_priority_updatedAt_id_idx" ON "WorkItem"("teamId", "priority", "updatedAt", "id");

-- CreateIndex
CREATE INDEX "WorkItem_teamId_assigneeId_updatedAt_id_idx" ON "WorkItem"("teamId", "assigneeId", "updatedAt", "id");

-- CreateIndex
CREATE INDEX "WorkItem_teamId_type_updatedAt_id_idx" ON "WorkItem"("teamId", "type", "updatedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkItem_id_teamId_key" ON "WorkItem"("id", "teamId");

-- CreateIndex
CREATE INDEX "ActivityEvent_workItemId_createdAt_id_idx" ON "ActivityEvent"("workItemId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "ActivityEvent_teamId_createdAt_idx" ON "ActivityEvent"("teamId", "createdAt");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_createdAt_idx" ON "IdempotencyRecord"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_actorId_key_key" ON "IdempotencyRecord"("actorId", "key");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkItem"
    ADD CONSTRAINT "WorkItem_title_not_blank_check" CHECK (length(btrim("title")) > 0),
    ADD CONSTRAINT "WorkItem_version_positive_check" CHECK ("version" > 0),
    ADD CONSTRAINT "WorkItem_creator_membership_fkey"
        FOREIGN KEY ("createdById", "teamId")
        REFERENCES "Membership"("userId", "teamId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "WorkItem_assignee_membership_fkey"
        FOREIGN KEY ("assigneeId", "teamId")
        REFERENCES "Membership"("userId", "teamId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ActivityEvent"
    ADD CONSTRAINT "ActivityEvent_item_team_fkey"
        FOREIGN KEY ("workItemId", "teamId")
        REFERENCES "WorkItem"("id", "teamId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "ActivityEvent_actor_membership_fkey"
        FOREIGN KEY ("actorId", "teamId")
        REFERENCES "Membership"("userId", "teamId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "WorkItem_title_trgm_idx" ON "WorkItem" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "WorkItem_description_trgm_idx" ON "WorkItem" USING GIN ("description" gin_trgm_ops);

CREATE FUNCTION "prevent_activity_event_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Activity events are append-only'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "ActivityEvent_append_only"
    BEFORE UPDATE OR DELETE ON "ActivityEvent"
    FOR EACH ROW EXECUTE FUNCTION "prevent_activity_event_mutation"();
