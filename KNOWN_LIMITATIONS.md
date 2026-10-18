# Known limitations

- **No asynchronous outbox or worker:** Mutations and activity events are transactional and synchronous. There is no background notification delivery, retry, or failed-job tracking. See [ENGINEERING_DECISIONS.md](./ENGINEERING_DECISIONS.md#5-synchronous-mutations-versus-a-transactional-outbox) for the deliberate scope decision.
- **Bounded detail history:** Item detail returns at most 100 activity events and 100 comments; older records are not separately paginated.
- **Seed data is illustrative:** `npm run db:seed` idempotently creates four teams, ten demo accounts, and 3,000 deterministic sample items plus two named examples. It is intended for development/demo use, not load or production-data validation.
- **Seed refresh behavior:** Existing seeded item IDs are skipped rather than overwritten, so repeated seeding does not discard work-item edits. Account names/password hashes and seed memberships are upserted from the configured development seed.
- **No login throttling or recovery:** Login rate limiting, account recovery, invitations, membership administration, and production identity-provider integration are out of scope.
- **Token lifecycle:** HMAC bearer tokens expire after eight hours and are held in browser `sessionStorage`; there is no refresh flow or individual token revocation. The API rechecks account activity on each request.
- **Cursor behavior under concurrent edits:** Pagination is deterministic for an unchanged result set. Updates can move items between pages; refresh when a fully current view is required.
- **Approval policy:** Only a Lead in the item's team may approve it. Admins retain team-wide editing and assignment permissions, but not approval permission.
- **Production hardening:** Production deployment still needs an explicitly configured Content Security Policy and a deliberate CORS/session policy if the UI and API are hosted on separate origins.
