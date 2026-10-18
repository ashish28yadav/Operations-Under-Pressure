# Engineering decisions

## 1. Relational data model and append-only history

**Context.** Work, ownership, membership, comments, and audit events must remain team-scoped and mutually consistent.

**Alternatives considered.** Store flexible item and event documents in a JSON store; use relational tables with application-only checks; or use PostgreSQL relations and database constraints.

**Chosen approach.** PostgreSQL is authoritative. Prisma models users, teams, memberships, work items, activity events, comments, and idempotency records. Composite foreign keys bind creators, assignees, event actors, and comments to the relevant team. Database triggers reject update/delete of activity and comment rows. Item changes, related audit events, and idempotency responses are written in a single transaction.

**Trade-offs and limitations.** Relational constraints make team consistency explicit but require migrations for structural changes. Activity and comments are append-only through normal database operations, though a privileged database owner can still bypass triggers. Detail responses are bounded to 100 events and comments; older history is not cursor-paginated.

**Why this fits the challenge.** The challenge prioritizes accountability and correctness under failure over a flexible but weakly constrained model.

## 2. Concurrency control and idempotency

**Context.** Concurrent claims, stale edits, network retries, and repeated submissions must not silently lose changes or duplicate mutations.

**Alternatives considered.** Client-side optimistic updates, coarse table locks, serializable transactions for every mutation, or conditional writes combined with request idempotency.

**Chosen approach.** Updates include a version and use a conditional write that increments it; stale versions return `409`. Claims require the expected version, `OPEN` status, and no assignee in one guarded update. Each mutation persists an actor/key/request fingerprint and response in the same transaction as its operation and activity changes. The UI preserves drafts after conflicts and requires an explicit safe recovery choice; it does not optimistically overwrite server state.

**Trade-offs and limitations.** Conditional writes keep transactions narrow, but clients must recover from conflicts. Idempotency records currently have no retention policy. A cursor walk may shift if matching items change while paging.

**Why this fits the challenge.** These mechanisms directly address its high-risk behaviors and are covered by PostgreSQL integration tests without introducing a separate coordination service.

## 3. Team authorization and workflow enforcement

**Context.** A user may have different roles in different teams; hiding controls in React alone cannot enforce permissions.

**Alternatives considered.** Trust role claims in a token, enforce authorization in the client, or reload membership and authorize each team-scoped API operation on the server.

**Chosen approach.** Tokens identify only the account. The API reloads the active user and checks team membership and role in services. Viewers read; Members create and claim work and may edit items they created or claimed; Leads and Admins have team-wide edit and assignment powers. Only a Lead of the item’s team may transition an item to `APPROVED`; Admin is intentionally not an approval role. Workflow transitions are checked server-side.

**Trade-offs and limitations.** Membership is queried from PostgreSQL rather than cached in tokens, adding a database read while allowing role changes to take effect without reissuing tokens. This project does not include membership administration.

**Why this fits the challenge.** It keeps the trust boundary at the API and follows the advisory’s Lead-only approval wording while retaining the Admin role for other team operations.

## 4. Server-side filtering, indexing, and cursor pagination

**Context.** The application must keep team results bounded and must not hide matching urgent items beyond the current page.

**Alternatives considered.** Fetch all team records and filter in React; use offset pagination; or apply filters in PostgreSQL and use a keyset cursor.

**Chosen approach.** List requests are team-authorized and apply search, type, one or more priorities, status, assignee, and cursor conditions to the database query before `take`. Ordering is by `(updatedAt, id)`, and the next cursor uses both fields. The frontend Unassigned urgent view sends `assigneeId=unassigned` and `priority=P0,P1` to the API. PostgreSQL trigram and composite indexes support the current filters.

**Trade-offs and limitations.** Keyset pagination is stable while rows remain unchanged, but concurrent edits can move records. Multi-priority filters use a comma-separated query value. Three thousand deterministic sample items exercise pagination; this is not a production-scale benchmark.

**Why this fits the challenge.** It implements the requested server-side filtering and scale-aware pagination without introducing a separate search service.

## 5. Synchronous mutations versus a transactional outbox

**Context.** The advisory suggests a transactional job/outbox worker for reliable asynchronous notifications, but this application has no external notification integration or background-job runtime.

**Alternatives considered.** Add an outbox table, polling worker, retry/backoff policy, and operational lifecycle now; send external effects inside request transactions; or defer asynchronous side effects until there is a real consumer and delivery requirement.

**Chosen approach.** **No outbox or worker is implemented.** Core work-item changes and audit history are committed synchronously in PostgreSQL transactions. This choice is deliberate and is not represented as reliable asynchronous processing.

**Trade-offs and limitations.** The application cannot currently perform retryable asynchronous notifications or other background work. Adding a worker later requires defining the side effect, delivery/idempotency contract, retry limits, failed-job inspection, and process supervision. Synchronous request work remains bounded to database operations.

**Why this fits the challenge.** The core challenge’s correctness requirements are implemented and tested; adding a worker without a real side effect would add operational risk without delivering user value.
