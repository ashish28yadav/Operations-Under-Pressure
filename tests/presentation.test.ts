import { describe, expect, it } from "vitest";
import type { ActivityEvent, TeamMember, WorkItem } from "../src/api";
import { activityDescription, auditEvents, isOverdue } from "../src/presentation";

const members: TeamMember[] = [
  {
    userId: "fabiola-id",
    role: "MEMBER",
    user: { id: "fabiola-id", name: "Fabiola", email: "fabiola@newtonite.dev" },
  },
];

function makeEvent(kind: ActivityEvent["kind"], overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: "event-1",
    teamId: "team-1",
    workItemId: "item-1",
    actorId: "actor-1",
    actor: { id: "actor-1", name: "Alex Rivera" },
    kind,
    fromValue: null,
    toValue: null,
    createdAt: "2026-05-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("work item presentation", () => {
  it("excludes comment events from the system activity timeline", () => {
    const events = [
      makeEvent("COMMENT_ADDED"),
      makeEvent("STATUS_CHANGED", { fromValue: "OPEN", toValue: "IN_PROGRESS" }),
    ];

    expect(auditEvents(events).map((event) => event.kind)).toEqual(["STATUS_CHANGED"]);
  });

  it("describes field changes using the recorded before and after values", () => {
    const event = makeEvent("ITEM_UPDATED", {
      fromValue: JSON.stringify({ title: "Old title", type: "TASK", dueAt: null, description: "Old description" }),
      toValue: JSON.stringify({ title: "New title", type: "BUG", dueAt: null, description: "New description" }),
    });

    expect(activityDescription(event, members)).toBe(
      "Updated title: Old title → New title; type: TASK → BUG; description: “Old description” → “New description”",
    );
  });

  it("shows the resolved member name for an ownership change", () => {
    const event = makeEvent("ASSIGNEE_CHANGED", { fromValue: null, toValue: "fabiola-id" });

    expect(activityDescription(event, members)).toBe("Changed owner from Unassigned to Fabiola");
  });

  it("counts overdue unfinished items but excludes due-today, undated, and done items", () => {
    const now = Date.parse("2026-05-01T12:00:00.000Z");
    const item = (dueAt: string | null, status: WorkItem["status"]): Pick<WorkItem, "dueAt" | "status"> => ({
      dueAt,
      status,
    });

    expect(isOverdue(item("2026-04-30T23:59:59.000Z", "OPEN"), now)).toBe(true);
    expect(isOverdue(item("2026-05-01T12:00:00.000Z", "OPEN"), now)).toBe(false);
    expect(isOverdue(item(null, "OPEN"), now)).toBe(false);
    expect(isOverdue(item("2026-04-30T23:59:59.000Z", "DONE"), now)).toBe(false);
  });
});
