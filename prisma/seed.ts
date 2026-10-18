import "dotenv/config";
import { randomBytes, scryptSync } from "node:crypto";
import { PrismaClient, type TeamRole, type WorkItemPriority, type WorkItemStatus, type WorkItemType } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "../server/env.js";

function readSeedPassword(value: string | undefined): string {
  if (!value || value.length < 12) {
    throw new Error("Set SEED_PASSWORD to a value of at least 12 characters before seeding.");
  }
  return value;
}
const seedPassword = readSeedPassword(process.env.SEED_PASSWORD);
if (env.NODE_ENV === "production") {
  throw new Error("Demo seed data is not allowed in production.");
}

function passwordHash(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

function deterministicId(index: number): string {
  return `c${index.toString(36).padStart(24, "0")}`;
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

const teams = [
  { slug: "operations", name: "Operations" },
  { slug: "platform", name: "Platform" },
  { slug: "customer-success", name: "Customer Success" },
  { slug: "finance", name: "Finance" },
] as const;

type TeamSlug = (typeof teams)[number]["slug"];
type SeedUser = {
  email: string;
  name: string;
  memberships: Partial<Record<TeamSlug, TeamRole>>;
};

const users: SeedUser[] = [
  { email: "alex.rivera@newtonite.dev", name: "Alex Rivera", memberships: { operations: "LEAD" } },
  { email: "blake.chen@newtonite.dev", name: "Blake Chen", memberships: { operations: "MEMBER" } },
  { email: "casey.morgan@newtonite.dev", name: "Casey Morgan", memberships: { operations: "VIEWER", "customer-success": "VIEWER", finance: "VIEWER" } },
  { email: "devon.patel@newtonite.dev", name: "Devon Patel", memberships: { operations: "ADMIN", platform: "VIEWER", finance: "ADMIN" } },
  { email: "erin.park@newtonite.dev", name: "Erin Park", memberships: { platform: "LEAD" } },
  { email: "finley.shaw@newtonite.dev", name: "Finley Shaw", memberships: { platform: "MEMBER" } },
  { email: "fabiola@newtonite.dev", name: "Fabiola", memberships: { operations: "MEMBER" } },
  { email: "grace.liu@newtonite.dev", name: "Grace Liu", memberships: { "customer-success": "LEAD" } },
  { email: "harper.stone@newtonite.dev", name: "Harper Stone", memberships: { "customer-success": "MEMBER", finance: "MEMBER" } },
  { email: "jules.martin@newtonite.dev", name: "Jules Martin", memberships: { finance: "LEAD", platform: "ADMIN" } },
];

const itemTitles = [
  "Review overnight reconciliation",
  "Restore delayed dispatch alerts",
  "Validate customer import",
  "Investigate payment settlement",
  "Resolve access provisioning delay",
  "Reconcile inventory snapshot",
  "Review service health alert",
  "Confirm month-end report",
];
const descriptions = [
  "Compare the latest run with its source records and document any discrepancies.",
  "Investigate the operational signal and confirm the owning team has a recovery path.",
  "Check the handoff, validate expected results, and record the next action.",
  "Review the affected workflow and coordinate a safe resolution with the team.",
];
const types: WorkItemType[] = ["TASK", "BUG", "INCIDENT", "REQUEST"];
const priorities: WorkItemPriority[] = ["P0", "P1", "P2", "P3"];
const statuses: WorkItemStatus[] = ["OPEN", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "APPROVED", "DONE"];
const workItemCount = 3000;
const batchSize = 500;
const seedEpoch = Date.UTC(2026, 6, 1);

async function main(): Promise<void> {
  const teamIds = new Map<TeamSlug, string>();
  for (const team of teams) {
    const saved = await prisma.team.upsert({
      where: { slug: team.slug },
      update: { name: team.name },
      create: team,
    });
    teamIds.set(team.slug, saved.id);
  }

  const savedUsers = new Map<string, { id: string; memberships: Partial<Record<TeamSlug, TeamRole>> }>();
  for (const user of users) {
    const saved = await prisma.user.upsert({
      where: { email: user.email },
      update: { name: user.name, passwordHash: passwordHash(seedPassword), active: true },
      create: {
        email: user.email,
        name: user.name,
        passwordHash: passwordHash(seedPassword),
      },
    });
    savedUsers.set(user.email, { id: saved.id, memberships: user.memberships });
    for (const [teamSlug, role] of Object.entries(user.memberships) as [TeamSlug, TeamRole][]) {
      const teamId = teamIds.get(teamSlug);
      if (!teamId) throw new Error(`Seed team ${teamSlug} is missing.`);
      await prisma.membership.upsert({
        where: { userId_teamId: { userId: saved.id, teamId } },
        update: { role },
        create: { userId: saved.id, teamId, role },
      });
    }
  }

  const teamDetails = new Map<TeamSlug, { id: string; leadId: string; assigneeIds: string[] }>();
  for (const team of teams) {
    const teamId = teamIds.get(team.slug);
    const teamUsers = [...savedUsers.values()].filter((user) => user.memberships[team.slug]);
    const lead = teamUsers.find((user) => user.memberships[team.slug] === "LEAD");
    if (!teamId || !lead) throw new Error(`Seed team ${team.slug} needs a Lead membership.`);
    const assigneeIds = teamUsers
      .filter((user) => user.memberships[team.slug] !== "VIEWER")
      .map((user) => user.id);
    teamDetails.set(team.slug, { id: teamId, leadId: lead.id, assigneeIds });
  }

  for (let start = 0; start < workItemCount; start += batchSize) {
    const batch = Array.from({ length: Math.min(batchSize, workItemCount - start) }, (_, offset) => {
      const index = start + offset;
      const team = teams[index % teams.length];
      const { id: teamId, leadId, assigneeIds } = teamDetails.get(team.slug)!;
      const assigned = index % 3 !== 0;
      const createdAt = new Date(seedEpoch + index * 60_000);
      const dueAt = index % 5 === 0 ? null : new Date(seedEpoch + ((index % 120) - 30) * 86_400_000);
      return {
        index,
        item: {
          id: deterministicId(10_000 + index),
          teamId,
          title: `[DEMO-${String(index + 1).padStart(4, "0")}] ${itemTitles[index % itemTitles.length]}`,
          description: descriptions[index % descriptions.length],
          type: types[index % types.length],
          priority: priorities[index % priorities.length],
          status: statuses[index % statuses.length],
          assigneeId: assigned ? assigneeIds[Math.floor(index / 3) % assigneeIds.length] : null,
          createdById: leadId,
          dueAt,
          version: 1,
          createdAt,
          updatedAt: createdAt,
        },
        leadId,
      };
    });

    await prisma.$transaction(async (transaction) => {
      await transaction.workItem.createMany({ data: batch.map(({ item }) => item), skipDuplicates: true });
      await transaction.activityEvent.createMany({
        data: batch.map(({ index, item, leadId }) => ({
          id: deterministicId(50_000 + index),
          teamId: item.teamId,
          workItemId: item.id,
          actorId: leadId,
          kind: "CREATED",
          toValue: JSON.stringify({
            title: item.title,
            type: item.type,
            priority: item.priority,
            status: item.status,
            assigneeId: item.assigneeId,
          }),
          createdAt: item.createdAt,
        })),
        skipDuplicates: true,
      });
    });
  }

  const operationsId = teamIds.get("operations");
  const leadId = savedUsers.get("alex.rivera@newtonite.dev")?.id;
  if (!operationsId || !leadId) throw new Error("The operations demo accounts could not be seeded.");
  const examples = [
    {
      title: "Restore delayed dispatch alerts",
      description: "Investigate and restore the delayed-dispatch notification pipeline.",
      type: "INCIDENT" as const,
      priority: "P1" as const,
      status: "OPEN" as const,
    },
    {
      title: "Reconcile overnight inventory",
      description: "Compare the overnight stock import with the warehouse snapshot.",
      type: "TASK" as const,
      priority: "P2" as const,
      status: "IN_PROGRESS" as const,
      assigneeId: savedUsers.get("blake.chen@newtonite.dev")?.id,
    },
  ];

  for (const example of examples) {
    await prisma.$transaction(async (transaction) => {
      const existing = await transaction.workItem.findFirst({
        where: { teamId: operationsId, title: example.title },
        select: { id: true },
      });
      if (existing) return;
      const item = await transaction.workItem.create({
        data: { ...example, teamId: operationsId, createdById: leadId },
      });
      await transaction.activityEvent.create({
        data: {
          teamId: operationsId,
          workItemId: item.id,
          actorId: leadId,
          kind: "CREATED",
          toValue: JSON.stringify({
            title: item.title,
            type: item.type,
            priority: item.priority,
            status: item.status,
            assigneeId: item.assigneeId,
          }),
        },
      });
    });
  }

  console.info(`Newtonite demo data is ready: ${teams.length} teams, ${users.length} users, ${workItemCount} deterministic work items, and two named examples.`);
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
