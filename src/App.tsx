import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  claimWorkItem,
  createWorkItemComment,
  createWorkItem,
  currentUser,
  itemPriorities,
  itemStatuses,
  itemTypes,
  login,
  RequestError,
  teamMembers,
  updateWorkItem,
  workItems,
  workItemDetail,
  type ItemFilters,
  type ItemPriority,
  type ItemStatus,
  type ItemType,
  type WorkItemDetail,
  type TeamMember,
  type TeamMembership,
  type User,
  type WorkItem,
} from "./api";
import { activityDescription, auditEvents, displayStatus, isOverdue } from "./presentation";

const emptyFilters: ItemFilters = { q: "", type: "", priority: "", status: "", assigneeId: "" };

const transitionOptions: Record<ItemStatus, ItemStatus[]> = {
  OPEN: ["IN_PROGRESS", "BLOCKED"],
  IN_PROGRESS: ["OPEN", "BLOCKED", "IN_REVIEW"],
  BLOCKED: ["IN_PROGRESS"],
  IN_REVIEW: ["IN_PROGRESS", "APPROVED"],
  APPROVED: ["DONE"],
  DONE: [],
};

function formatDate(value: string | null): string {
  if (!value) return "No due date";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value));
}

function dateInputValue(value: string | null): string {
  if (!value) return "";
  return new Date(value).toISOString().slice(0, 10);
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function LoginScreen({ onLogin }: { onLogin: (token: string) => void }) {
  const [email, setEmail] = useState("alex.rivera@newtonite.dev");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setPending(true);
    try {
      const result = await login(email, password);
      onLogin(result.token);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Sign in failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="login-layout">
      <section className="login-panel">
        <div className="brand-mark" aria-hidden="true">N</div>
        <p className="eyebrow">NEWTONITE OPERATIONS</p>
        <h1>Make the next call count.</h1>
        <p className="login-copy">A clear view of the work, owners, and decisions that matter right now.</p>
        <form className="login-form" onSubmit={submit}>
          <label>
            Work email
            <input autoComplete="username" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label>
            Password
            <input autoComplete="current-password" type="password" required value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="button button-primary button-wide" disabled={pending} type="submit">
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="login-footnote">Demo accounts are provisioned by the database seed.</p>
      </section>
      <aside className="login-aside">
        <div className="pulse-orb" aria-hidden="true"><span /></div>
        <p className="eyebrow">OPERATIONS UNDER PRESSURE</p>
        <h2>Calm is a system.</h2>
        <p>One shared queue. Clear ownership. Every consequential change accounted for.</p>
        <div className="aside-status"><i /> All systems ready</div>
      </aside>
    </main>
  );
}

function ItemForm({
  item,
  members,
  canAssign,
  canApprove,
  pending,
  blocked = false,
  onDirtyChange,
  onSave,
  onCancel,
}: {
  item: WorkItem | null;
  members: TeamMember[];
  canAssign: boolean;
  canApprove: boolean;
  pending: boolean;
  blocked?: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onSave: (value: {
    title: string;
    description: string;
    type: ItemType;
    priority: ItemPriority;
    status: ItemStatus;
    dueAt: string | null;
    assigneeId?: string | null;
  }) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(item?.title ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [type, setType] = useState<ItemType>(item?.type ?? "TASK");
  const [priority, setPriority] = useState<ItemPriority>(item?.priority ?? "P2");
  const [status, setStatus] = useState<ItemStatus>(item?.status ?? "OPEN");
  const [dueAt, setDueAt] = useState(dateInputValue(item?.dueAt ?? null));
  const [assigneeId, setAssigneeId] = useState(item?.assigneeId ?? "");
  const statusOptions: ItemStatus[] = item
    ? [item.status, ...transitionOptions[item.status]].filter((option) =>
      option !== "APPROVED" || canApprove || option === item.status)
    : ["OPEN"];

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = {
      title: title.trim(),
      description,
      type,
      priority,
      status,
      dueAt: dueAt ? new Date(`${dueAt}T23:59:59.000Z`).toISOString() : null,
      ...(canAssign ? { assigneeId: assigneeId || null } : {}),
    };
    onSave(value);
  }

  return (
    <form className="item-form" onSubmit={submit}>
      <label>
        Title
        <input autoFocus maxLength={200} required value={title} onChange={(event) => { setTitle(event.target.value); onDirtyChange(true); }} />
      </label>
      <label>
        Description
        <textarea maxLength={10_000} rows={4} value={description} onChange={(event) => { setDescription(event.target.value); onDirtyChange(true); }} />
      </label>
      <div className="form-grid">
        <label>
          Type
          <select value={type} onChange={(event) => { setType(event.target.value as ItemType); onDirtyChange(true); }}>
            {itemTypes.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label>
          Priority
          <select value={priority} onChange={(event) => { setPriority(event.target.value as ItemPriority); onDirtyChange(true); }}>
            {itemPriorities.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        {item && (
          <label>
            Status
            <select value={status} onChange={(event) => { setStatus(event.target.value as ItemStatus); onDirtyChange(true); }}>
              {statusOptions.map((option) => <option key={option} value={option}>{displayStatus(option)}</option>)}
            </select>
          </label>
        )}
        <label>
          Due date
          <input type="date" value={dueAt} onChange={(event) => { setDueAt(event.target.value); onDirtyChange(true); }} />
        </label>
        {canAssign && (
          <label className="form-grid-wide">
            Assignee
            <select value={assigneeId} onChange={(event) => { setAssigneeId(event.target.value); onDirtyChange(true); }}>
              <option value="">Unassigned</option>
              {members.map((member) => (
                <option key={member.userId} value={member.userId}>{member.user.name} · {member.role.toLowerCase()}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="form-actions">
        <button className="button button-quiet" type="button" onClick={onCancel}>Cancel</button>
        <button className="button button-primary" disabled={pending || blocked || !title.trim()} type="submit">
          {pending ? "Saving…" : item ? "Save changes" : "Create work item"}
        </button>
      </div>
    </form>
  );
}

function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem("newtonite.token") ?? "");
  const [user, setUser] = useState<User | null>(null);
  const [memberships, setMemberships] = useState<TeamMembership[]>([]);
  const [teamId, setTeamId] = useState("");
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [items, setItems] = useState<WorkItem[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedDetail, setSelectedDetail] = useState<WorkItemDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [commentError, setCommentError] = useState("");
  const [commentText, setCommentText] = useState("");
  const [activeView, setActiveView] = useState<"overview" | "assigned" | "urgent" | "approval" | "all">("overview");
  const [navigationOpen, setNavigationOpen] = useState(true);
  const [filters, setFilters] = useState<ItemFilters>(emptyFilters);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createDirty, setCreateDirty] = useState(false);
  const [editDirty, setEditDirty] = useState(false);
  const [formRevision, setFormRevision] = useState(0);
  const [conflict, setConflict] = useState<{ itemId: string; version: number; kind: "update" | "claim" } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [memberRefresh, setMemberRefresh] = useState(0);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef<HTMLElement>(null);
  const createDirtyRef = useRef(false);

  const selectedTeam = memberships.find((membership) => membership.team.id === teamId);
  const role = selectedTeam?.role ?? "VIEWER";
  const canEdit = role !== "VIEWER";
  const canAssign = role === "LEAD" || role === "ADMIN";
  const canApprove = role === "LEAD";
  const selectedItem = items.find((item) => item.id === selectedId) ??
    (selectedDetail?.id === selectedId ? selectedDetail : null);
  const canComment = role === "LEAD" || role === "ADMIN" ||
    (role === "MEMBER" && selectedItem !== null &&
      (selectedItem.createdById === user?.id || selectedItem.assigneeId === user?.id));
  const visibleItems = items;
  const counts = useMemo(() => ({
    open: visibleItems.filter((item) => item.status === "OPEN").length,
    urgent: visibleItems.filter((item) => item.priority === "P0" || item.priority === "P1").length,
    approval: visibleItems.filter((item) => item.status === "IN_REVIEW").length,
  }), [visibleItems]);

  const clearSession = useCallback(() => {
    sessionStorage.removeItem("newtonite.token");
    setToken("");
    setUser(null);
    setMemberships([]);
    setItems([]);
    setTeamId("");
  }, []);

  const handleLogin = useCallback((nextToken: string) => {
    sessionStorage.setItem("newtonite.token", nextToken);
    setToken(nextToken);
  }, []);

  function closeCreate() {
    if (createDirtyRef.current && !window.confirm("Discard this work item draft?")) return;
    createDirtyRef.current = false;
    setCreateDirty(false);
    setShowCreate(false);
  }

  function markCreateDirty(dirty: boolean) {
    createDirtyRef.current = dirty;
    setCreateDirty(dirty);
  }

  function closeDetails() {
    if (editDirty && !window.confirm("Discard your unsaved changes?")) return;
    setEditDirty(false);
    setConflict(null);
    setSelectedId("");
  }

  function changeTeam(nextTeamId: string) {
    if (editDirty && !window.confirm("Discard your unsaved changes?")) return;
    setEditDirty(false);
    setConflict(null);
    setTeamId(nextTeamId);
    setActiveView("overview");
    setFilters(emptyFilters);
    setSelectedId("");
  }

  function signOut() {
    if ((editDirty || createDirty) && !window.confirm("Sign out and discard your unsaved changes?")) return;
    setEditDirty(false);
    setCreateDirty(false);
    clearSession();
  }

  useEffect(() => {
    if (!showCreate) {
      createButtonRef.current?.focus();
      return;
    }
    const dialog = modalRef.current;
    dialog?.querySelector<HTMLElement>("input, textarea, select, button")?.focus();
    function handleDialogKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeCreate();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleDialogKeyDown);
    return () => document.removeEventListener("keydown", handleDialogKeyDown);
  }, [showCreate]);

  useEffect(() => {
    if (!token) return;
    let active = true;
    currentUser(token).then(({ user: current }) => {
      if (!active) return;
      setUser(current);
      setMemberships(current.memberships);
      setTeamId((currentTeamId) => current.memberships.some((membership) => membership.team.id === currentTeamId)
        ? currentTeamId
        : current.memberships[0]?.team.id ?? "");
    }).catch((requestError: unknown) => {
      if (!active) return;
      if (requestError instanceof RequestError && requestError.status === 401) clearSession();
      else setError(requestError instanceof Error ? requestError.message : "Could not load your account.");
    });
    return () => { active = false; };
  }, [token, clearSession]);

  useEffect(() => {
    if (!token || !teamId) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      workItems(token, teamId, filters, undefined, controller.signal).then((result) => {
        setItems(result.items);
        setNextCursor(result.nextCursor);
        setSelectedId((previous) =>
          result.items.some((item) => item.id === previous) || conflict?.itemId === previous ? previous : "",
        );
      }).catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        setError(requestError instanceof Error ? requestError.message : "Could not load work items.");
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    }, filters.q ? 220 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [token, teamId, filters, refresh, conflict]);

  useEffect(() => {
    if (!token || !teamId) return;
    teamMembers(token, teamId).then(({ members: teamUsers }) => setMembers(teamUsers)).catch((requestError: unknown) => {
      setError(requestError instanceof Error ? requestError.message : "Could not load team members.");
    });
  }, [token, teamId, memberRefresh]);

  useEffect(() => {
    if (!token || !teamId || !selectedId) {
      setSelectedDetail(null);
      setDetailError("");
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError("");
    workItemDetail(token, teamId, selectedId).then(({ item }) => {
      if (!controller.signal.aborted) setSelectedDetail(item);
    }).catch((requestError: unknown) => {
      if (controller.signal.aborted) return;
      setDetailError(requestError instanceof Error ? requestError.message : "Could not load the work item details.");
    }).finally(() => {
      if (!controller.signal.aborted) setDetailLoading(false);
    });
    return () => controller.abort();
  }, [token, teamId, selectedId, refresh]);

  async function loadMore() {
    if (!token || !teamId || !nextCursor) return;
    setLoading(true);
    try {
      const result = await workItems(token, teamId, filters, nextCursor);
      setItems((current) => [...current, ...result.items]);
      setNextCursor(result.nextCursor);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not load more work items.");
    } finally {
      setLoading(false);
    }
  }

  async function createItem(value: Parameters<Parameters<typeof ItemForm>[0]["onSave"]>[0]) {
    if (!token || !teamId) return;
    setPending(true);
    setError("");
    try {
      await createWorkItem(token, teamId, {
        title: value.title,
        description: value.description,
        type: value.type,
        priority: value.priority,
        dueAt: value.dueAt,
        ...(canAssign ? { assigneeId: value.assigneeId } : {}),
      });
      setShowCreate(false);
      createDirtyRef.current = false;
      setCreateDirty(false);
      setNotice("Work item created.");
      setRefresh((count) => count + 1);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not create the work item.");
    } finally {
      setPending(false);
    }
  }

  async function saveItem(value: Parameters<Parameters<typeof ItemForm>[0]["onSave"]>[0]) {
    if (!token || !teamId || !selectedItem) return;
    setPending(true);
    setError("");
    try {
      await updateWorkItem(token, teamId, selectedItem.id, {
        version: selectedItem.version,
        title: value.title,
        description: value.description,
        type: value.type,
        priority: value.priority,
        status: value.status,
        dueAt: value.dueAt,
        ...(canAssign ? { assigneeId: value.assigneeId } : {}),
      });
      setEditDirty(false);
      setConflict(null);
      setNotice("Changes saved.");
      setRefresh((count) => count + 1);
    } catch (requestError) {
      if (requestError instanceof RequestError && requestError.code === "STALE_VERSION") {
        setConflict({ itemId: selectedItem.id, version: selectedItem.version, kind: "update" });
        setError("");
        setRefresh((count) => count + 1);
      } else {
        setError(requestError instanceof Error ? requestError.message : "Could not save the work item.");
      }
    } finally {
      setPending(false);
    }
  }

  async function claim(item: WorkItem) {
    if (!token || !teamId) return;
    setPending(true);
    setError("");
    try {
      await claimWorkItem(token, teamId, item.id, item.version);
      setNotice("Work item claimed.");
      setRefresh((count) => count + 1);
    } catch (requestError) {
      if (requestError instanceof RequestError && requestError.status === 409) {
        setConflict({ itemId: item.id, version: item.version, kind: "claim" });
        setError("");
        setRefresh((count) => count + 1);
      } else {
        setError(requestError instanceof Error ? requestError.message : "Could not claim the work item.");
      }
    } finally {
      setPending(false);
    }
  }

  async function addComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !teamId || !selectedItem || !commentText.trim()) return;
    setPending(true);
    setCommentError("");
    try {
      await createWorkItemComment(token, teamId, selectedItem.id, commentText.trim());
      setCommentText("");
      setNotice("Comment added.");
      setRefresh((count) => count + 1);
    } catch (requestError) {
      setCommentError(requestError instanceof Error ? requestError.message : "Could not add the comment.");
    } finally {
      setPending(false);
    }
  }

  if (!token) return <LoginScreen onLogin={handleLogin} />;
  if (!user && !error) {
    return <main className="session-loading"><span className="loading-dot" /> Restoring your session…</main>;
  }
  if (token && !user && error) {
    return (
      <main className="login-layout">
        <section className="login-panel">
          <div className="brand-mark" aria-hidden="true">N</div>
          <p className="eyebrow">NEWTONITE OPERATIONS</p>
          <h1>We couldn’t connect.</h1>
          <p className="login-copy">{error}</p>
          <button className="button button-primary" onClick={() => { setError(""); clearSession(); }}>Return to sign in</button>
        </section>
      </main>
    );
  }

  const updateFilter = <K extends keyof ItemFilters>(key: K, value: ItemFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setNextCursor(null);
  };

  function selectView(view: typeof activeView) {
    setActiveView(view);
    setNextCursor(null);
    setFilters({
      ...emptyFilters,
      ...(view === "assigned" && user ? { assigneeId: user.id } : {}),
      ...(view === "urgent" ? { assigneeId: "unassigned", priority: ["P0", "P1"] as ItemPriority[] } : {}),
      ...(view === "approval" ? { status: "IN_REVIEW" as ItemStatus } : {}),
    });
  }

  const viewTitles = {
    overview: ["Operations overview", "A clear view of the work that needs attention."],
    assigned: ["Assigned to me", "Work items currently assigned to you."],
    urgent: ["Unassigned urgent", "Unassigned P0 and P1 items in the current results."],
    approval: ["Awaiting approval", "Work items ready for a decision."],
    all: ["All work items", "Browse and filter work across this team."],
  } as const;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-brand">
          <button className="navigation-toggle button button-quiet" aria-expanded={navigationOpen} aria-controls="primary-navigation" onClick={() => setNavigationOpen((open) => !open)}>
            {navigationOpen ? "Hide navigation" : "Show navigation"}
          </button>
          <a className="brand-lockup" href="/" aria-label="Newtonite home">
            <span className="brand-mark small" aria-hidden="true">N</span>
            <span>Newtonite</span>
          </a>
        </div>
        <label className="global-search">
          <span aria-hidden="true">⌕</span>
          <input aria-label="Search work items" placeholder="Search work items" value={filters.q} onChange={(event) => updateFilter("q", event.target.value)} />
          {filters.q && <button type="button" aria-label="Clear search" onClick={() => updateFilter("q", "")}>×</button>}
        </label>
        <div className="topbar-right">
          <label className="team-picker">
            <span>Team</span>
            <select value={teamId} onChange={(event) => changeTeam(event.target.value)}>
              {memberships.map(({ team }) => <option key={team.id} value={team.id}>{team.name}</option>)}
            </select>
          </label>
          <details className="profile-menu">
            <summary className="user-chip"><span className="avatar">{user?.name.slice(0, 1)}</span><span>{user?.name}</span><span aria-hidden="true">⌄</span></summary>
            <div className="profile-popover">
              <strong>{user?.name}</strong>
              <span>{user?.email}</span>
              <button className="button button-quiet" onClick={signOut}>Sign out</button>
            </div>
          </details>
        </div>
      </header>

      <div className={`workspace-shell ${navigationOpen ? "" : "navigation-collapsed"}`}>
        <aside className="sidebar" id="primary-navigation" aria-label="Work views">
          <p className="sidebar-label">WORKSPACE</p>
          <nav>
            <button className={activeView === "overview" ? "nav-item active" : "nav-item"} aria-current={activeView === "overview" ? "page" : undefined} onClick={() => selectView("overview")}><span aria-hidden="true">◫</span>Overview</button>
            <button className={activeView === "assigned" ? "nav-item active" : "nav-item"} aria-current={activeView === "assigned" ? "page" : undefined} onClick={() => selectView("assigned")}><span aria-hidden="true">○</span>Assigned to me</button>
            <button className={activeView === "urgent" ? "nav-item active" : "nav-item"} aria-current={activeView === "urgent" ? "page" : undefined} onClick={() => selectView("urgent")}><span aria-hidden="true">!</span>Unassigned urgent</button>
            {canAssign && <button className={activeView === "approval" ? "nav-item active" : "nav-item"} aria-current={activeView === "approval" ? "page" : undefined} onClick={() => selectView("approval")}><span aria-hidden="true">✓</span>Awaiting approval</button>}
            <button className={activeView === "all" ? "nav-item active" : "nav-item"} aria-current={activeView === "all" ? "page" : undefined} onClick={() => selectView("all")}><span aria-hidden="true">▤</span>All work items</button>
          </nav>
        </aside>

      <main className="page-content">
        <div className="page-heading">
          <div>
            <p className="eyebrow">{selectedTeam?.team.name ?? "Operations"}</p>
            <h1>{viewTitles[activeView][0]}</h1>
            <p className="page-subtitle">{viewTitles[activeView][1]}</p>
          </div>
          {canEdit && <button ref={createButtonRef} className="button button-primary" onClick={() => { markCreateDirty(false); setShowCreate(true); }}>＋ Create work item</button>}
        </div>

        {error && <div className="notice notice-error" role="alert"><span>{error}</span><div className="notice-actions"><button className="button button-quiet" onClick={() => { setError(""); setRefresh((count) => count + 1); setMemberRefresh((count) => count + 1); }}>Retry</button><button onClick={() => setError("")} aria-label="Dismiss error">×</button></div></div>}
        {notice && <div className="notice notice-success" role="status"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss notice">×</button></div>}
        {conflict?.kind === "claim" && (
          <div className="conflict-notice" role="status">
            <div><strong>Claim not completed.</strong> This item changed or was claimed by a teammate. The queue is refreshing with the current server state.</div>
            <button className="button button-quiet" onClick={() => { setConflict(null); setRefresh((count) => count + 1); }}>Refresh queue</button>
          </div>
        )}

        <section className="metrics" aria-label="Work summary">
          <Metric label="Open items" value={counts.open} caption="In loaded results" accent="blue" />
          <Metric label="Urgent items" value={counts.urgent} caption="Priority P0 or P1" accent="red" />
          {canAssign && <Metric label="Awaiting approval" value={counts.approval} caption="In loaded results" accent="purple" />}
        </section>

        <section className="workbench">
          <div className="workbench-heading">
            <div>
              <h2>Work items <span className="result-count">{visibleItems.length}</span></h2>
              <p>Recently updated · summaries reflect loaded results</p>
            </div>
          </div>
          <div className="filters">
            <FilterSelect label="Status" value={filters.status} options={itemStatuses} onChange={(value) => updateFilter("status", value as ItemStatus | "")} />
            <FilterSelect
              label="Priority"
              value={Array.isArray(filters.priority) ? "urgent" : filters.priority}
              options={itemPriorities}
              onChange={(value) => updateFilter("priority", value === "urgent" ? ["P0", "P1"] : value as ItemPriority | "")}
            />
            <FilterSelect label="Type" value={filters.type} options={itemTypes} onChange={(value) => updateFilter("type", value as ItemType | "")} />
            <label className="filter-select">
              <span className="sr-only">Assignee</span>
              <select aria-label="Filter by assignee" value={filters.assigneeId} onChange={(event) => updateFilter("assigneeId", event.target.value)}>
                <option value="">All owners</option>
                <option value="unassigned">Unassigned</option>
                {members.map((member) => <option key={member.userId} value={member.userId}>{member.user.name}</option>)}
              </select>
            </label>
          </div>

          <div className="queue-table" role="table" aria-label="Work items" aria-busy={loading}>
            <div className="queue-columns" role="row">
              <span role="columnheader">Work item</span><span role="columnheader">Team</span><span role="columnheader">Priority</span><span role="columnheader">Status</span><span role="columnheader">Assignee</span><span role="columnheader">Due date</span><span role="columnheader"><span className="sr-only">Actions</span></span>
            </div>
            <div className="queue-list">
            {loading && visibleItems.length === 0 && Array.from({ length: 3 }, (_, index) => (
              <div className="queue-row skeleton-row" role="row" aria-label="Loading work item" key={`loading-${index}`}>
                <span role="cell"><i className="skeleton skeleton-title" /></span>
                <span role="cell"><i className="skeleton skeleton-text" /></span>
                <span role="cell"><i className="skeleton skeleton-short" /></span>
                <span role="cell"><i className="skeleton skeleton-short" /></span>
                <span role="cell"><i className="skeleton skeleton-text" /></span>
                <span role="cell"><i className="skeleton skeleton-text" /></span>
                <span role="cell" />
              </div>
            ))}
            {!loading && visibleItems.length === 0 && (
              <div className="empty-row" role="row"><div className="empty-state" role="cell">
                <span className="empty-icon" aria-hidden="true" />
                <strong>{filters.q || filters.status || filters.priority || filters.type || filters.assigneeId ? "No matching work" : "The queue is clear"}</strong>
                <span>Adjust the filters or add a work item to get started.</span>
              </div></div>
            )}
            {visibleItems.map((item) => (
              <article className={`queue-row ${selectedId === item.id ? "selected" : ""}`} key={item.id} role="row">
                <button role="cell" className="item-summary" aria-expanded={selectedId === item.id} aria-label={`${item.title}, ${displayStatus(item.status)}, ${item.priority}${item.dueAt ? `, due ${formatDate(item.dueAt)}` : ""}`} onClick={() => {
                  if (editDirty && !window.confirm("Discard your unsaved changes?")) return;
                  setEditDirty(false);
                  setConflict(null);
                  setSelectedId(selectedId === item.id ? "" : item.id);
                  setSelectedDetail(null);
                  setCommentText("");
                }}>
                  <span className={`type-mark type-${item.type.toLowerCase()}`}>{item.type.slice(0, 1)}</span>
                  <span className="item-title-group">
                    <strong>{item.title}</strong>
                    <small>{item.description || item.type.toLowerCase()}</small>
                  </span>
                </button>
                <span role="cell" className="team-name" data-label="Team">{selectedTeam?.team.name}</span>
                <span role="cell" className={`priority-label priority-${item.priority.toLowerCase()}`} data-label="Priority"><i />{item.priority}</span>
                <span role="cell" className={`status-pill status-${item.status.toLowerCase()}`} data-label="Status">{displayStatus(item.status)}</span>
                <span role="cell" className="owner-name" data-label="Assignee">{item.assignee?.name ?? <span className="unassigned">Unassigned</span>}</span>
                <span role="cell" className={`due-label ${isOverdue(item) ? "due-overdue" : ""}`} data-label="Due date">
                  {isOverdue(item)
                    ? `Overdue · ${formatDate(item.dueAt)}`
                    : formatDate(item.dueAt)}
                </span>
                {canEdit && item.status === "OPEN" && !item.assigneeId
                  ? <button role="cell" className="button button-claim" disabled={pending} onClick={() => void claim(item)}>Claim</button>
                  : <span role="cell" />}
              </article>
            ))}
            </div>
          </div>
          {nextCursor && <button className="button button-load" disabled={loading} onClick={() => void loadMore()}>{loading ? "Loading…" : "Load more"}</button>}
        </section>

        {selectedItem && (
          <section className="detail-panel" aria-label="Work item details">
            <div className="detail-heading">
              <div><p className="eyebrow">WORK ITEM · {selectedItem.id.slice(-6).toUpperCase()}</p><h2>Update work</h2></div>
              <button className="icon-button" aria-label="Close details" onClick={closeDetails}>×</button>
            </div>
            {conflict?.itemId === selectedItem.id && conflict.kind === "update" && (
              <div className="conflict-notice" role="alert">
                <div>
                  <strong>This item changed on the server.</strong> Your draft is preserved and has not been submitted again.
                  {selectedItem.version <= conflict.version
                    ? " Waiting for the latest server version…"
                    : ` Latest version ${selectedItem.version} is loaded. Choose how to continue.`}
                </div>
                {selectedItem.version > conflict.version && (
                  <div className="conflict-actions">
                    <button className="button button-quiet" onClick={() => setConflict(null)}>Keep my draft and retry</button>
                    <button className="button button-quiet" onClick={() => { setFormRevision((revision) => revision + 1); setEditDirty(false); setConflict(null); }}>Discard draft and load latest</button>
                  </div>
                )}
              </div>
            )}
            {canEdit
              ? <ItemForm key={`${selectedItem.id}:${formRevision}`} item={selectedItem} members={members} canAssign={canAssign} canApprove={canApprove} pending={pending} blocked={conflict?.itemId === selectedItem.id && conflict.kind === "update"} onDirtyChange={setEditDirty} onSave={(value) => void saveItem(value)} onCancel={closeDetails} />
              : <p className="read-only-note">You have read-only access to this team’s work items.</p>}
            <div className="detail-meta"><span>Created by {selectedItem.createdBy.name}</span><span>Version {selectedItem.version}</span><span>Updated {formatDate(selectedItem.updatedAt)}</span></div>
            <section className="detail-section" aria-labelledby="activity-title">
              <div className="section-heading">
                <h3 id="activity-title">Activity</h3>
                {detailLoading && <span className="inline-loading"><span className="loading-dot" /> Loading</span>}
              </div>
              {detailError && <div className="form-error" role="alert">{detailError} <button className="text-button" onClick={() => setRefresh((count) => count + 1)}>Retry details</button></div>}
              {!detailLoading && selectedDetail && auditEvents(selectedDetail.activities).length === 0 && (
                <p className="timeline-empty">No activity has been recorded yet.</p>
              )}
              <ol className="activity-timeline">
                {selectedDetail && auditEvents(selectedDetail.activities).map((event) => (
                  <li className="timeline-entry" key={event.id}>
                    <span className={`timeline-marker marker-${event.kind.toLowerCase()}`} aria-hidden="true" />
                    <div>
                      <p><strong>{event.actor.name}</strong> {activityDescription(event, members)}</p>
                      <time dateTime={event.createdAt}>{formatTimestamp(event.createdAt)}</time>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
            <section className="detail-section comments-section" aria-labelledby="comments-title">
              <div className="section-heading"><h3 id="comments-title">Comments <span className="comment-count">{selectedDetail ? selectedDetail.comments.length : "—"}</span></h3></div>
              {selectedDetail?.comments.length ? (
                <ol className="comment-list">
                  {selectedDetail.comments.map((comment) => (
                    <li className="comment-card" key={comment.id}>
                      <div className="comment-byline"><strong>{comment.author.name}</strong><time dateTime={comment.createdAt}>{formatTimestamp(comment.createdAt)}</time></div>
                      <p>{comment.body}</p>
                    </li>
                  ))}
                </ol>
              ) : !detailLoading ? <p className="timeline-empty">No comments yet.</p> : null}
              {commentError && <p className="form-error" role="alert">{commentError}</p>}
              {canComment && (
                <form className="comment-form" onSubmit={(event) => void addComment(event)}>
                  <label className="sr-only" htmlFor="new-comment">Add a comment</label>
                  <textarea
                    id="new-comment"
                    maxLength={5000}
                    placeholder="Add a comment for your team…"
                    rows={3}
                    value={commentText}
                    onChange={(event) => setCommentText(event.target.value)}
                  />
                  <button className="button button-primary" disabled={pending || !commentText.trim()} type="submit">
                    {pending ? "Posting…" : "Post comment"}
                  </button>
                </form>
              )}
            </section>
          </section>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" role="presentation">
          <section ref={modalRef} className="modal-card" role="dialog" aria-modal="true" aria-labelledby="create-title">
            <div className="detail-heading">
              <div><p className="eyebrow">NEW WORK</p><h2 id="create-title">Create work item</h2></div>
              <button className="icon-button" aria-label="Close dialog" onClick={closeCreate}>×</button>
            </div>
            <ItemForm item={null} members={members} canAssign={canAssign} canApprove={canApprove} pending={pending} onDirtyChange={markCreateDirty} onSave={(value) => void createItem(value)} onCancel={closeCreate} />
          </section>
        </div>
      )}
    </div>
    </div>
  );
}

function Metric({ label, value, caption, accent }: { label: string; value: number; caption: string; accent: string }) {
  return (
    <article className="metric-card">
      <div className={`metric-icon metric-${accent}`} aria-hidden="true">{accent === "mint" ? "↗" : accent === "blue" ? "◷" : "!"}</div>
      <div><span className="metric-label">{label}</span><strong>{value}</strong><span className="metric-caption">{caption}</span></div>
    </article>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  const allLabel = label === "Status" ? "All statuses" : label === "Priority" ? "All priorities" : "All types";
  return (
    <label className="filter-select">
      <span className="sr-only">{label}</span>
      <select aria-label={`Filter by ${label.toLowerCase()}`} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{allLabel}</option>
        {label === "Priority" && <option value="urgent">P0 and P1 (urgent)</option>}
        {options.map((option) => <option value={option} key={option}>{displayStatus(option as ItemStatus)}</option>)}
      </select>
    </label>
  );
}

export default App;
