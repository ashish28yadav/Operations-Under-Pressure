export const itemTypes = ["TASK", "BUG", "INCIDENT", "REQUEST"] as const;
export const itemPriorities = ["P0", "P1", "P2", "P3"] as const;
export const itemStatuses = ["OPEN", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "APPROVED", "DONE"] as const;

export type ItemType = (typeof itemTypes)[number];
export type ItemPriority = (typeof itemPriorities)[number];
export type ItemStatus = (typeof itemStatuses)[number];
export type TeamRole = "VIEWER" | "MEMBER" | "LEAD" | "ADMIN";

export type User = { id: string; name: string; email: string };
export type Team = { id: string; slug: string; name: string };
export type TeamMembership = { role: TeamRole; team: Team };
export type TeamMember = {
  userId: string;
  role: TeamRole;
  user: User;
};

export type WorkItem = {
  id: string;
  teamId: string;
  title: string;
  description: string;
  type: ItemType;
  priority: ItemPriority;
  status: ItemStatus;
  assigneeId: string | null;
  assignee: { id: string; name: string } | null;
  createdById: string;
  createdBy: { id: string; name: string };
  dueAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ActivityEvent = {
  id: string;
  teamId: string;
  workItemId: string;
  actorId: string;
  actor: { id: string; name: string };
  kind: "CREATED" | "STATUS_CHANGED" | "ASSIGNEE_CHANGED" | "PRIORITY_CHANGED" | "ITEM_UPDATED" | "COMMENT_ADDED";
  fromValue: string | null;
  toValue: string | null;
  createdAt: string;
};

export type WorkItemComment = {
  id: string;
  teamId: string;
  workItemId: string;
  authorId: string;
  author: { id: string; name: string };
  body: string;
  createdAt: string;
};

export type WorkItemDetail = WorkItem & {
  activities: ActivityEvent[];
  comments: WorkItemComment[];
};

export type ItemFilters = {
  q: string;
  type: ItemType | "";
  priority: ItemPriority | ItemPriority[] | "";
  status: ItemStatus | "";
  assigneeId: string;
};

type ApiErrorPayload = {
  error?: {
    code?: string;
    message?: string;
  };
};

export class RequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

async function request<T>(
  path: string,
  options: {
    token?: string;
    method?: "GET" | "POST" | "PATCH";
    body?: unknown;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const headers = new Headers({ Accept: "application/json" });
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.method === "POST" || options.method === "PATCH") {
    headers.set("Idempotency-Key", crypto.randomUUID());
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new RequestError("The server could not be reached. Check your connection and retry.", 0, "NETWORK_ERROR");
  }

  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload as ApiErrorPayload;
    throw new RequestError(
      detail.error?.message ?? "The request could not be completed.",
      response.status,
      detail.error?.code ?? "REQUEST_FAILED",
    );
  }
  return payload as T;
}

export async function login(email: string, password: string) {
  return request<{ token: string; user: User }>("/api/auth/login", {
    method: "POST",
    body: { email, password },
  });
}

export async function currentUser(token: string) {
  return request<{ user: User & { memberships: TeamMembership[] } }>("/api/auth/me", { token });
}

export async function teamMembers(token: string, teamId: string) {
  return request<{ members: TeamMember[] }>(`/api/teams/${encodeURIComponent(teamId)}/members`, { token });
}

export async function workItems(
  token: string,
  teamId: string,
  filters: ItemFilters,
  cursor?: string,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.type) params.set("type", filters.type);
  if (filters.priority) params.set("priority", Array.isArray(filters.priority) ? filters.priority.join(",") : filters.priority);
  if (filters.status) params.set("status", filters.status);
  if (filters.assigneeId) params.set("assigneeId", filters.assigneeId);
  if (cursor) params.set("cursor", cursor);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return request<{ items: WorkItem[]; nextCursor: string | null }>(
    `/api/teams/${encodeURIComponent(teamId)}/items${query}`,
    { token, signal },
  );
}

export async function createWorkItem(
  token: string,
  teamId: string,
  input: {
    title: string;
    description: string;
    type: ItemType;
    priority: ItemPriority;
    assigneeId?: string | null;
    dueAt?: string | null;
  },
) {
  return request<{ item: WorkItem }>(`/api/teams/${encodeURIComponent(teamId)}/items`, {
    token,
    method: "POST",
    body: input,
  });
}

export async function claimWorkItem(token: string, teamId: string, itemId: string, version: number) {
  return request<{ item: WorkItem }>(
    `/api/teams/${encodeURIComponent(teamId)}/items/${encodeURIComponent(itemId)}/claim`,
    { token, method: "POST", body: { version } },
  );
}

export async function updateWorkItem(
  token: string,
  teamId: string,
  itemId: string,
  input: {
    version: number;
    title: string;
    description: string;
    type: ItemType;
    priority: ItemPriority;
    status: ItemStatus;
    dueAt: string | null;
    assigneeId?: string | null;
  },
) {
  return request<{ item: WorkItem }>(
    `/api/teams/${encodeURIComponent(teamId)}/items/${encodeURIComponent(itemId)}`,
    { token, method: "PATCH", body: input },
  );
}

export async function workItemDetail(token: string, teamId: string, itemId: string) {
  return request<{ item: WorkItemDetail }>(
    `/api/teams/${encodeURIComponent(teamId)}/items/${encodeURIComponent(itemId)}`,
    { token },
  );
}

export async function createWorkItemComment(token: string, teamId: string, itemId: string, body: string) {
  return request<{ comment: WorkItemComment }>(
    `/api/teams/${encodeURIComponent(teamId)}/items/${encodeURIComponent(itemId)}/comments`,
    { token, method: "POST", body: { body } },
  );
}
