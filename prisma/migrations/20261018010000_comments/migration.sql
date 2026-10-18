ALTER TYPE "ActivityKind" ADD VALUE 'COMMENT_ADDED';

CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" VARCHAR(5000) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Comment_body_not_blank_check" CHECK (length(btrim("body")) > 0)
);

CREATE INDEX "Comment_workItemId_createdAt_id_idx" ON "Comment"("workItemId", "createdAt", "id");
CREATE INDEX "Comment_teamId_createdAt_idx" ON "Comment"("teamId", "createdAt");

ALTER TABLE "Comment"
    ADD CONSTRAINT "Comment_teamId_fkey"
        FOREIGN KEY ("teamId") REFERENCES "Team"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "Comment_item_team_fkey"
        FOREIGN KEY ("workItemId", "teamId") REFERENCES "WorkItem"("id", "teamId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "Comment_author_membership_fkey"
        FOREIGN KEY ("authorId", "teamId") REFERENCES "Membership"("userId", "teamId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "prevent_comment_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Comments are append-only'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "Comment_append_only"
    BEFORE UPDATE OR DELETE ON "Comment"
    FOR EACH ROW EXECUTE FUNCTION "prevent_comment_mutation"();
