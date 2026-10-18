import type { ActivityEvent, TeamMember, WorkItem, WorkItemDetail } from "./api";

type AuditEvent = Omit<ActivityEvent, "kind"> & {
  kind: Exclude<ActivityEvent["kind"], "COMMENT_ADDED">;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function displayStatus(status: string): string {
  return status.replaceAll("_", " ").toLowerCase().replace(/(^|\s)\S/g, (part) => part.toUpperCase());
}

export function isOverdue(item: Pick<WorkItem, "dueAt" | "status">, now = Date.now()): boolean {
  return item.dueAt !== null && new Date(item.dueAt).getTime() < now && item.status !== "DONE";
}

export function auditEvents(events: WorkItemDetail["activities"]): AuditEvent[] {
  return events.filter((event): event is AuditEvent => event.kind !== "COMMENT_ADDED");
}

export function activityDescription(
  event: ActivityEvent,
  members: TeamMember[],
): string {
  const memberName = (id: unknown) => {
    if (typeof id !== "string") return "Unassigned";
    return members.find((member) => member.userId === id)?.user.name ?? "a team member";
  };
  switch (event.kind) {
    case "CREATED": {
      try {
        const details: unknown = JSON.parse(event.toValue ?? "");
        if (isRecord(details)) {
          const owner = details.assigneeId ? ` · Owner: ${memberName(details.assigneeId)}` : "";
          return `Created this work item · ${String(details.priority ?? "P2")} · ${displayStatus(String(details.status ?? "OPEN"))}${owner}`;
        }
      } catch {
        return "Created this work item";
      }
      return "Created this work item";
    }
    case "STATUS_CHANGED":
      return `Changed status from ${event.fromValue ? displayStatus(event.fromValue) : "unknown"} to ${event.toValue ? displayStatus(event.toValue) : "unknown"}`;
    case "ASSIGNEE_CHANGED":
      return `Changed owner from ${memberName(event.fromValue)} to ${memberName(event.toValue)}`;
    case "PRIORITY_CHANGED":
      return `Changed priority from ${event.fromValue ?? "—"} to ${event.toValue ?? "—"}`;
    case "ITEM_UPDATED": {
      try {
        const previous: unknown = JSON.parse(event.fromValue ?? "");
        const next: unknown = JSON.parse(event.toValue ?? "");
        if (!isRecord(previous) || !isRecord(next)) return "Updated work item details";
        const changes: string[] = [];
        for (const field of ["title", "type", "dueAt"] as const) {
          if (previous[field] !== next[field]) {
            const label = field === "dueAt" ? "due date" : field;
            const display = (value: unknown) => {
              if (!value) return "none";
              if (field === "dueAt" && typeof value === "string") {
                const date = new Date(value);
                if (!Number.isNaN(date.getTime())) {
                  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(date);
                }
              }
              return String(value);
            };
            changes.push(`${label}: ${display(previous[field])} → ${display(next[field])}`);
          }
        }
        if (previous.description !== next.description) {
          const summary = (value: unknown) => {
            const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
            if (!text) return "empty";
            return `“${text.length > 48 ? `${text.slice(0, 47)}…` : text}”`;
          };
          changes.push(`description: ${summary(previous.description)} → ${summary(next.description)}`);
        }
        return changes.length > 0 ? `Updated ${changes.join("; ")}` : "Updated work item details";
      } catch {
        return "Updated work item details";
      }
    }
    case "COMMENT_ADDED":
      return "Added a comment";
  }
}
