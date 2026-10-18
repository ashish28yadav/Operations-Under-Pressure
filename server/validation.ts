import { z } from "zod";

export const teamRoleSchema = z.enum(["VIEWER", "MEMBER", "LEAD", "ADMIN"]);
export const workItemTypeSchema = z.enum(["TASK", "BUG", "INCIDENT", "REQUEST"]);
export const prioritySchema = z.enum(["P0", "P1", "P2", "P3"]);
export const statusSchema = z.enum([
  "OPEN",
  "IN_PROGRESS",
  "BLOCKED",
  "IN_REVIEW",
  "APPROVED",
  "DONE",
]);

const dueAtSchema = z.iso.datetime({ offset: true });
const idSchema = z.cuid();

export const createWorkItemSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).default(""),
  type: workItemTypeSchema,
  priority: prioritySchema.default("P2"),
  assigneeId: idSchema.nullable().optional(),
  dueAt: dueAtSchema.nullable().optional(),
});

export const updateWorkItemSchema = z
  .object({
    version: z.number().int().positive(),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(10_000).optional(),
    type: workItemTypeSchema.optional(),
    priority: prioritySchema.optional(),
    status: statusSchema.optional(),
    assigneeId: idSchema.nullable().optional(),
    dueAt: dueAtSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== "version"), {
    message: "At least one work item field must be changed.",
  });

export const claimWorkItemSchema = z.object({
  version: z.number().int().positive(),
});

export const createCommentSchema = z.object({
  body: z.string().trim().min(1).max(5000),
});

const itemPriorityValues = ["P0", "P1", "P2", "P3"] as const;

const priorityFilterSchema = z.preprocess(
  (value) => {
    if (typeof value === "string" && value.includes(",")) {
      return value.split(",").map((priority) => priority.trim());
    }
    return value;
  },
  z.union([prioritySchema, z.array(prioritySchema).min(1).max(itemPriorityValues.length)]).optional(),
);

export const listWorkItemsSchema = z.object({
  q: z.string().trim().max(200).optional(),
  type: workItemTypeSchema.optional(),
  priority: priorityFilterSchema,
  status: statusSchema.optional(),
  assigneeId: z.string().max(100).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const itemIdSchema = idSchema;
export const teamIdSchema = idSchema;
export const idempotencyKeySchema = z.string().trim().min(1).max(200);
