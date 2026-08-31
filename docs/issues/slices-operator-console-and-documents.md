# Slices: Operator Console + Documents

**Source spec:** [../specs/2026-08-27-agent-access-gateway-design.md](../specs/2026-08-27-agent-access-gateway-design.md) — the **Amendments (2026-08-30)** section (A1–A6) is the contract for this work
**Source ADR:** [../adr/2026-08-30-invisible-documents.md](../adr/2026-08-30-invisible-documents.md)
**Domain language:** [/CONTEXT.md](../../CONTEXT.md) — Invisible, Visibility, Scope, Suspended, Upload, Operator Console
**Date:** 2026-08-30
**Branch:** feat/gateway-track-a-passthrough (slices 7–8 land here, after slices 1–6)

Two tracer-bullet slices, each vertical (server enforcement + browser surface +
tests, demoable alone). Slice 7 is the smaller build and is deliberately
first: its decision feed and ground-truth table are the observability the
slice-8 work is built and narrated against.

Dependency order: **7 → 8**. The server halves are parallelizable in principle
(disjoint files except the `can()` truth-table tests), but the demo depends on
7's surfaces, so treat the ordering as real unless splitting across people.
Both slices are **AFK**.

Decisions already made (do not re-litigate — they are recorded in CONTEXT.md,
the spec amendments, and the ADR):

- **Invisible over denied (A1, ADR).** An ownership denial on a direct `docs`
  fetch answers the same `404` body as a nonexistent id; the audit row carries
  the true reason. Tool-RBAC denials stay `403`.
- **Model calls are role-checked (A2).** `can(principal, "model")` runs on the
  model proxy; `suspended` means no access to anything, model included.
- **`visibility` is a field, not a workspace (A3/A6).** `"public" | "private"`,
  chosen at creation, immutable, loader-defaulted to `private`. Owned OR
  public is the whole rule; sharing, groups, and toggles are out of scope.
- **The gateway scopes, the tool filters (A5).** Scope travels in
  `x-launchpad-scope` beside the tool credential; the tool applies the shared
  `visibleTo` predicate from `authz.ts` mechanically and refuses a call
  missing the header. The gateway never parses tool response bodies.
- **The Operator Console displays and triggers, never decides** (invariant
  #8). It is not gated by the `admin` role — mock auth makes role-gating it
  theater. "Admin" refers only to the role from here on.
- **Claims only, never the token.** The session table renders `jti` + claims;
  the raw JWT string renders nowhere in any browser surface.
- **No user-plane god mode.** The user document listing is strictly
  `visibleTo`-scoped; the console's metadata-only table is the ground truth.
- **Role changes are unaudited** — accepted for demo scope, noted in
  SECURITY.md as a known limitation (an `AuditRecord` needs a run; an
  operator action has none).

Every slice ends with `npm run check` green. No slice may leave the baseline
or the shipped gateway behavior (slices 1–6) broken.

---

## Slice 7 — Operator Console + total suspension

**Type:** AFK
**Blocked by:** None — can start immediately

### What to build

The operator's pane of glass over data that already exists, plus the two
policy levers it pulls — session revocation and role reassignment — and the
role that makes reassignment total.

Server first:

1. **`suspended` role (A4).** `Role` gains `"suspended"`;
   `ROLE_TOOLS.suspended = []`. `can()` itself does not change — an empty
   grant list already denies everything with a legible reason.
2. **Model proxy runs `can(principal, "model")` (A2).** The model route
   resolves the principal exactly as the tool proxy does; a role deny is a
   `403` with one audit `deny` row and **no upstream fetch**. `401` remains
   authentication-only. This makes `ROLE_TOOLS`'s `model` entry real policy.
3. **Role reassignment.** `PATCH /api/users/:id` accepting exactly
   `{ role: Role }` (zod; seeded roles only — no role authoring). Takes
   effect on the target's agents' **next** gateway call with no token event,
   because permissions are read from the store per call.
4. **Operator read endpoints**, behind `APP_AUTH_TOKEN` like all of `/api`:
   - `GET /api/operator/audit` — all audit rows, every agent and run,
     ordered by `ts` (the decision feed's source).
   - `GET /api/operator/sessions` — sessions as claims: `jti`, agent, owner,
     run, issued, expires, revoked. The token string is never in the payload.
   - `GET /api/operator/docs` — document **metadata only**: id, owner (title
     and visibility columns arrive with slice 8). Never content.
5. **`SESSION_TTL_MS`.** New env var for run-session lifetime, replacing the
   incidental `CODEX_TIMEOUT_MS + 60_000` coupling in `agent-service.ts`.
   Default preserves today's effective value.

Then the console (display-and-trigger only):

6. **Operator Console page** in the web app: the decision feed (deny rows
   visually distinct, newest first), the session table with a **Revoke**
   button wiring the existing `POST /api/agents/:id/revoke`, the ground-truth
   document table, and a per-user **role dropdown** (admin / basic /
   suspended) calling the PATCH endpoint. Show each user's current role
   beside the existing dev switcher (demo-ordering discipline: a forgotten
   promotion is visible, not latent).
7. **Web mirrors:** `Role` union and session-claims shape in
   `apps/web/src/types.ts`; fetchers in `api.ts`.

### Acceptance criteria

- [ ] `can()` truth table extends to `suspended` × every tool including `model`: all deny, non-empty reasons
- [ ] Suspended owner's agent: next **model** call → `403`, audit `deny` row, no upstream fetch (mocked Ark); tool calls likewise
- [ ] Role flip mid-run, integration: basic-owned agent's `payments` → `403`; `PATCH` to admin; same run's retry → `201`; two audit rows with the two reasons; flip back to basic → `403` again — same unexpired credential throughout
- [ ] `PATCH /api/users/:id` rejects unknown users (`404`) and non-seeded role values (`400`)
- [ ] Operator endpoints return all-runs audit (ordered by `ts`), claims-only sessions, and metadata-only docs; no JWT string and no document content anywhere in any payload
- [ ] Console: revoke button flips a live session and the agent's next call dies (the previously unclickable demo step is clickable); role dropdown + switcher badge reflect the store after each change
- [ ] `SESSION_TTL_MS` respected by minted sessions; default preserves current behavior; absent/invalid values fail loudly at boot like other config
- [ ] No enforcement in the web app; the console renders and triggers only
- [ ] Docs: CLAUDE.md + AGENTS.md endpoint tables gain the three operator reads and the PATCH; `SESSION_TTL_MS` in `.env.example`, README, CLAUDE.md config tables; SECURITY.md notes the unaudited-role-change limitation; CLAUDE.md Web UI section gains the console (display-only framing)
- [ ] `npm run check` passes

### Blocked by

None — can start immediately

---

## Slice 8 — Documents: visibility, invisibility, scoped search, upload

**Type:** AFK
**Blocked by:** Slice 7 (demo surfaces; code overlap is only the `can()` truth-table tests)

### What to build

The second enforcement point: row-level scoping, not just binary allow/deny —
and the end of guessable-id existence leaks, per the ADR.

Server enforcement:

1. **`MockDoc` gains `visibility: "public" | "private"` and `title`** (A6).
   The tolerant loader defaults missing `visibility` to `private` — the safe
   direction; no version bump for a growing shape. Seeds: the three
   `SEARCH_CORPUS` entries become seeded **public** documents (owned by
   `user-a`; ownership is moot for public), and the corpus constant plus the
   now-false "unscoped search would leak" comment in `mock-tools.ts` are
   deleted (A5). The existing A/B docs stay private.
2. **`visibleTo(doc, ownerId)` in `authz.ts`** — the single home of
   "owned OR public." `can()`'s resource becomes `{ ownerId, visibility }`
   and uses it (A3). Both the gateway and the tool service import this one
   function; there is never a second copy.
3. **Invisible on direct fetch (A1, ADR).** The gateway's ownership deny for
   `docs` returns status and body **byte-identical** to the unknown-id `404`;
   the audit row carries the true ownership reason. Tool-RBAC denials remain
   `403`.
4. **Scoped search (A5).** The gateway forwards the principal's owner id in
   `x-launchpad-scope` beside the tool credential; the search route filters
   the store's documents with `visibleTo` and refuses a call missing the
   header (fail closed — only the gateway can reach it, so absence is a
   gateway bug). Search matches against title + content, as the corpus did.
5. **Browser surfaces** (mock-auth `/api`, gateway untouched):
   - `GET /api/docs` — documents visible to the acting `x-launchpad-user`,
     scoped by the same `visibleTo`. No operator override on this surface.
   - `POST /api/docs` — create-only Upload: `{ title, content, visibility }`,
     zod-validated, plain text, small cap (a few KB). The server generates
     the id and stamps `ownerId` from the acting user — an `ownerId` in the
     body is ignored or rejected, never honored. Visibility is immutable
     after creation; there is no edit, delete, or toggle.

UI:

6. **Documents panel:** list what the acting user can see (own + public,
   owner and visibility labeled) and the upload form with the visibility
   choice. Switching users re-scopes the list — that symmetry (human listing
   and agent search share one predicate) is a demo line, not a coincidence.
7. **Console ground-truth table** gains title and visibility columns,
   completing the "five documents exist; B's search returned three" narration
   that scoping alone cannot provide (filtered rows leave no audit trace).

### Acceptance criteria

- [ ] Loader: a store file whose docs lack `visibility` loads them as `private` and round-trips
- [ ] `visibleTo` unit-tested; `can()` truth table extends to {owned, public, foreign-private} × roles; public never transfers ownership
- [ ] **ADR verification:** B's agent fetches A's private doc → response status and body byte-identical to fetching a nonexistent id; audit reasons differ (ownership vs. not-found); no tool-service call on the denied fetch
- [ ] Own-doc and public-doc direct fetches succeed for any role granting `docs`
- [ ] Search as B: excludes A's private docs, includes B's own + all public; search as A: excludes nothing of A's; missing `x-launchpad-scope` → refused, nothing returned
- [ ] Upload: persisted with server-generated id and acting-user owner; body-supplied `ownerId` never honored; oversize / non-text rejected; a judge reload mid-demo keeps the document (store-persisted)
- [ ] Uploaded public doc appears in every user's search and listing; uploaded private doc appears only in its owner's
- [ ] Audit rows for doc decisions carry identifiers only — no document content in any persisted field (existing redaction path covers the new resource ids)
- [ ] `GET /api/docs` scoped by the same predicate as search (no god mode); console table shows all metadata, never content
- [ ] Docs: endpoint tables gain `GET/POST /api/docs`; CLAUDE.md Data Flow + Observability updated for scoped search and the 404 divergence; SECURITY.md gains the existence-non-disclosure posture; `mock-tools.ts` comment replaced
- [ ] `npm run check` passes

### Blocked by

- Slice 7 (console surfaces used to narrate this slice; truth-table test overlap)

---

## Notes

- **Demo-ordering discipline:** after the role-flip demo, flip the role back
  — every later "basic user denied" step silently depends on it. The
  switcher's role badge (slice 7) exists to make this mistake visible.
- **Search's denial story:** after scoping, search demonstrates _filtering_
  (narrated against the ground-truth table), not a `403`. If a hard search
  denial is wanted on camera, suspension provides it — no extra build.
- **Deferred (do not build):** visibility toggle, document sharing/groups/
  wildcards, operator-action audit log, role authoring, response-time
  uniformity between the two `404` paths, per-resource grant records.
- The ADR's Verification section maps onto slice 8's acceptance criteria
  1:1; keep that mapping when editing scope. Slice 7's role-flip test is the
  "revocation over statelessness" trade from the 2026-08-27 ADR, finally
  demonstrated end-to-end.
