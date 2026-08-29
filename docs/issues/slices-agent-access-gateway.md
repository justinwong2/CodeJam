# Slices: Agent Access Gateway

**Source spec:** [../specs/2026-08-27-agent-access-gateway-design.md](../specs/2026-08-27-agent-access-gateway-design.md)
**Source ADR:** [../adr/2026-08-27-agent-access-gateway.md](../adr/2026-08-27-agent-access-gateway.md)
**Date:** 2026-08-29
**Branch:** feat/gateway-track-a-passthrough (all slices land here before any merge)

Six tracer-bullet slices. Slice 1 is the critical-path de-risk (Track A): the
passthrough pipe plus the config cutover, atomic. Slices 2–5 bolt verification,
authorization, tools, and audit onto the proven pipe. Slice 6 is the only
frontend slice and is display-only.

Dependency order: **{1, 3} → 2 → {4, 5} → 6** — slice 3 is parallel with 1 and
2; slice 4 additionally needs 3; slice 6 needs 3 and 5. All slices are **AFK**;
slice 1 carries one manual verification step (a real Codex run needs the Ark
key from `.env`).

Decisions already made (do not re-litigate):

- **Atomic cutover, no `GATEWAY_ENABLED` flag.** Slice 1 repoints Codex and
  strips the key in one commit. The interim verify-nothing gateway is accepted
  **on this branch only**: slice 2 (JWT verification) must land before the
  branch merges to `main` or anything demo-facing, so the unauthenticated
  window never exists outside the branch.
- **Per-runner config generation.** The gateway `base_url` differs by vantage
  point (host process vs. inside a container), so the active runner — not
  server startup — is responsible for writing `config.toml` with its own
  gateway origin. Both runners go through the gateway; the gateway is not
  container-only.
- Contract 1 (gateway HTTP shape) and Contract 2 (`can()`) in the spec are
  **frozen**. `401` for authentication failures (bad/expired/revoked JWT),
  `403` for authorization denials (tool-RBAC, ownership, revoked-agent policy
  reads follow Contract 1, not the ADR's demo prose, where they differ).

Every slice ends with `npm run check` green — it is the acceptance-checklist
gate and CI. No slice may leave the baseline (CRUD, lifecycle, Playground,
polling, thread continuity) broken.

---

## Slice 1 — Passthrough gateway + per-runner config cutover (ATOMIC)

**Type:** AFK (one manual POC verification)
**Blocked by:** None — can start immediately

### What to build

The spec's Track A: a model proxy that proves SSE streaming and
container-to-host reachability with a real Codex run, plus the credential
cutover. This slice couples two changes that **must land together** —
repointing `config.toml` at a gateway that doesn't exist breaks every run, and
a gateway with no traffic proves nothing.

1. **New `apps/server/src/gateway.ts`:** register `POST /gateway/v1/responses`
   on the existing Fastify app. Verify nothing yet (slice 2 adds JWT checks).
   Replace the incoming `Authorization` header with
   `Bearer ${config.arkApiKey}` and forward the request to
   `${config.arkBaseUrl}/responses`, returning the upstream status and body.
   **Stream the response through unmodified** — if upstream replies
   `text/event-stream`, chunks must reach Codex as they arrive, never
   buffered. Implementation notes that matter:
   - The route must pass the request body through byte-for-byte: add a
     raw-body content-type parser scoped to the gateway routes (no zod, no
     JSON parse/re-serialize).
   - The app-level `bodyLimit` is 1 MiB; Codex model calls carry large
     context. Raise the limit on the gateway scope.
   - The existing `onRequest` auth hook only guards `/api/*`, so `/gateway/*`
     is exempt from `APP_AUTH_TOKEN` by construction — this is intended (the
     agent authenticates with `RUN_JWT` from slice 2, not the demo token).
   - Never log the injected key or forwarded `Authorization` header.
2. **Per-runner config generation:** remove the `writeCodexConfig` call from
   server startup (`index.ts`). Parameterize it by gateway origin and
   `env_key`, and have each runner (or `runner-factory.ts`) write
   `config.toml` into the shared `codexHome` when it is constructed:
   - local-process runner → `base_url = http://127.0.0.1:<PORT>/gateway/v1`
   - container runner → `base_url = http://<host-alias>:<PORT>/gateway/v1`,
     where the host alias is engine-specific: `host.docker.internal` for
     Docker (add `--add-host=host.docker.internal:host-gateway` to
     `buildContainerRunArgs` so Linux Docker resolves it too),
     `host.containers.internal` for Podman.
   - `env_key` becomes `"RUN_JWT"` in both.
   - Only one runner is active per process (`RUNTIME_PROVIDER`), so the
     shared `codexHome` — and Codex thread state living under it — is
     untouched; resume semantics (invariant #6) must keep working.
   - The server must listen on a host containers can reach (bind `0.0.0.0`
     or verify the existing bind works via the host alias).
3. **Credential cutover:** delete `ARK_API_KEY` from both runners' Codex
   environments — the `--env ARK_API_KEY` flag in `buildContainerRunArgs` and
   the `ARK_API_KEY` entry in the local runner's spawn env. Both inject
   `RUN_JWT` instead, with a static placeholder value until slice 2 mints real
   tokens.

### Acceptance criteria

- [ ] `POST /gateway/v1/responses` forwards to Ark with the injected key; integration test with a mocked upstream asserts the incoming bearer is replaced and the body passes through unmodified
- [ ] SSE integration test: mocked upstream emits chunks with delays; the client observes them incrementally with `text/event-stream` framing intact (proves no buffering)
- [ ] `buildContainerRunArgs` contains no `ARK_API_KEY` flag and no value equal to the configured key (extend the existing argv test); local runner spawn env has no `ARK_API_KEY`; both inject `RUN_JWT`
- [ ] Per-runner `config.toml` unit tests: container runner writes the host-alias `base_url` + `--add-host` shim for Docker; local runner writes the loopback `base_url`; both write `env_key = "RUN_JWT"`
- [ ] Manual: `npm run poc` completes a real Playground task through the gateway; a task asking the agent to print `ARK_API_KEY` returns nothing
- [ ] Manual: `npm run dev` (local-process) completes a turn through the gateway
- [ ] Multi-turn resume still works (thread continuity unbroken)
- [ ] Docs: CLAUDE.md + AGENTS.md endpoint tables gain the gateway route; SECURITY.md notes the key no longer enters the container; any new env var lands in `.env.example`, README, CLAUDE.md
- [ ] `npm run check` passes

### Blocked by

None — can start immediately

---

## Slice 2 — Per-run JWT sessions + revocation

**Type:** AFK
**Blocked by:** Slice 1

### What to build

Replace "verify nothing" with real per-run identity, closing the atomic-cutover
exposure window. `AgentService` mints an HS256 JWT
(`{ jti, agentId, ownerId, runId, exp }`, signed with new required env var
`GATEWAY_JWT_SECRET`) when a run starts, persists a matching `RunSession`, and
hands the token to the runner — extend `RunnerRequest` with `runJwt` and
replace slice 1's placeholder. Prefer hand-rolled HMAC-SHA256 via
`node:crypto` over a new dependency (drift-control cost of a dep outweighs it
at this size). Permissions are **not** in the token.

The gateway now verifies before forwarding, fail-closed per the ADR:
signature, expiry, and the session's `revoked` flag (lookup by `jti`) — any
failure → `401`, upstream never called. Missing `GATEWAY_JWT_SECRET` at boot
is a startup error, not a silent bypass.

Store work: bump `Database` to `version: 2` and replace the strict
`version !== 1` rejection in `JsonStore.initialize` with a tolerant migration
that upgrades v1 files and defaults missing collections to `[]` (this loader
is shared groundwork — slices 3–5 add their collections through it without
further bumps). Add `sessions: RunSession[]`. The startup sweep that cancels
stale runs also revokes their sessions. Sessions expire alongside
`CODEX_TIMEOUT_MS` with margin.

Revocation surface: `POST /api/agents/:id/revoke` marks all live sessions for
that agent revoked — the demo's mid-session kill. (Until slice 3 lands,
`ownerId` in the payload uses the seeded default owner; slice 3 makes it
real.)

### Acceptance criteria

- [ ] Valid JWT → forwarded with injected key (mocked Ark); tampered signature, expired `exp`, unknown `jti`, and revoked session each → `401` **and no upstream fetch**
- [ ] Runs mint one session each; `RunSession` persisted; run completion/failure expires it; server restart revokes stale sessions
- [ ] `POST /api/agents/:id/revoke` flips live sessions; the agent's next gateway call → `401` mid-run
- [ ] Store migration test: a v1 database file loads, gains `version: 2` + empty collections, and round-trips
- [ ] `GATEWAY_JWT_SECRET` never appears in logs or error bodies; boot fails loudly without it
- [ ] Docs: revoke endpoint in CLAUDE.md/AGENTS.md tables; `GATEWAY_JWT_SECRET` in `.env.example`, README, CLAUDE.md config tables
- [ ] `npm run check` passes

### Blocked by

- Slice 1 (the gateway route and `RUN_JWT` plumbing must exist)

---

## Slice 3 — Owners, roles, and `can()`

**Type:** AFK
**Blocked by:** None — parallel with slices 1–2

### What to build

The identity and authorization data model from the spec's data contract, plus
the pure decision function — no gateway wiring yet (slice 4 does that).

- `types.ts`: `Role`, `ToolName`, `User`, `ROLE_TOOLS`, `Principal`, and
  `Agent.ownerId` exactly as specified in the spec's Data Contract section.
- Store: seed `users` (`user-a`/admin, `user-b`/basic) on first load; migrate
  existing agents to a default `ownerId` of `user-a`. Coordinate with slice
  2's tolerant loader — whichever lands first introduces it; the collections
  are disjoint.
- New `apps/server/src/authz.ts`: pure, synchronous
  `can(principal, tool, resource?)` per frozen Contract 2 — allow iff the
  role grants the tool AND (when a resource is given)
  `resource.ownerId === principal.ownerId`. Every deny returns a
  human-readable `reason` (it becomes the audit record's `reason` in slice 5).
- Principal resolution: the acting human comes from an `x-launchpad-user`
  header (the dev switcher's server-side half), validated against seeded
  users, defaulting to `user-a`. `POST /api/agents` stamps `ownerId` from it.
  `GET /api/users` lists seeded users for the switcher. This is mock
  authentication by design (ADR: authorization is scored, not
  authentication).

### Acceptance criteria

- [ ] `can()` truth table covers the full matrix: {admin, basic} × {model, docs, search, payments} × {no resource, owned resource, non-owned resource} with correct allow/deny and non-empty reasons
- [ ] Created agents persist `ownerId` from the acting user; existing agents migrate to `user-a`; users seeded exactly once (idempotent across restarts)
- [ ] `GET /api/users` returns the seeded users; unknown `x-launchpad-user` → `400`
- [ ] Docs: new endpoint in CLAUDE.md/AGENTS.md tables
- [ ] `npm run check` passes

### Blocked by

None — parallel with slices 1–2 (touches `types.ts`/`store.ts` alongside
slice 2; fields are disjoint, merges are trivial)

---

## Slice 4 — Tool proxy + mock tools with RBAC and ownership enforcement

**Type:** AFK
**Blocked by:** Slices 2 and 3

### What to build

The `403` half of the story: real denials at the gateway, proven bypassable
by nothing.

- New `apps/server/src/mock-tools.ts`: in-process `docs` / `search` /
  `payments` routes plus the seeded `MockDoc` A/B ownership fixture
  (`docs: MockDoc[]` in the store). The mock service requires its own
  internal credential header (new env var, server-side only) so that calling
  it **without** going through the gateway fails — that credential is what
  the gateway injects.
- Gateway: `ALL /gateway/v1/tools/:tool/*` — verify JWT (slice 2) → resolve
  `Principal` (role looked up server-side from the owner, per the ADR's
  revocation-over-statelessness trade) → `can(principal, tool, resource?)`
  (slice 3) → inject the tool credential → forward to the mock service.
  Ownership-scoped tools (`docs`) resolve the target doc's `ownerId` as the
  resource; `403` on any deny, upstream untouched.

### Acceptance criteria

- [ ] Admin-owned agent: `docs`, `search`, `payments` all forward and succeed
- [ ] Basic-owned agent → `payments` → `403`, **no upstream fetch**
- [ ] Ownership: B's agent reads A's doc → `403`; A's doc unchanged; own-doc read succeeds
- [ ] Bypass test: direct call to the mock-tool routes without the internal credential is rejected — enforcement is server-side, not path-obscurity
- [ ] Invalid JWT on the tool proxy → `401` before any authz work
- [ ] Docs: tool proxy route in CLAUDE.md/AGENTS.md tables; new env var in `.env.example`, README, CLAUDE.md
- [ ] `npm run check` passes

### Blocked by

- Slice 2 (JWT verification) and slice 3 (`can()`, owners, principal
  resolution)

---

## Slice 5 — Audit records: redacted, one per decision, queryable per Run

**Type:** AFK
**Blocked by:** Slice 2 (extends slice 4's denials when both have landed)

### What to build

The "record" half of the gateway story. Add `audit: AuditRecord[]` to the
store and a single audit-writer module the gateway calls on **every** decision
— model proxy and tool proxy, allow and deny — writing exactly one record
(shape per the spec's Data Contract) **before** the response is sent.
Redaction is part of the write path, not a follow-up: no request/response
bodies are persisted, only the `resource` identifier; any occurrence of the
Ark key, JWT secret, tool credential, or a bearer token pattern in `reason`
or `resource` is masked before persist.

Expose `GET /api/runs/:id/audit` returning the run's records (the evidence
panel's data source, and behind `APP_AUTH_TOKEN` like the rest of `/api`).
If slice 4 has landed, wire its denials through the same writer; if not,
slice 4 picks the writer up on merge — the writer's contract
(`record(decision)` called once per gateway decision) is fixed here.

Token metering stays as-is (`RunUsage` parsed from Codex output); parsing
per-call usage out of SSE streams is explicitly out of scope, matching the
ADR's metering-not-enforcement stance.

### Acceptance criteria

- [ ] One `allow` record per successful model call; one `deny` record per `401`/`403`, with the `can()` or verifier reason; never two records for one request
- [ ] Records are persisted before the response is sent (test observes the record immediately after the response resolves, including on denials)
- [ ] Redaction unit test: seeded secrets planted in reason/resource inputs do not appear in any persisted audit field
- [ ] `GET /api/runs/:id/audit` returns only that run's records, ordered by `ts`; unknown run → `404`
- [ ] Docs: endpoint tables updated; CLAUDE.md **Observability** section rewritten to describe the audit model (the section currently says "nothing else" exists — per drift control it must be replaced when this lands); SECURITY.md notes what audit records do and do not contain
- [ ] `npm run check` passes

### Blocked by

- Slice 2 (gateway decisions with run identity must exist)

---

## Slice 6 — Dev user switcher + Run evidence panel

**Type:** AFK
**Blocked by:** Slices 3 and 5

### What to build

The only frontend slice, display-only by design (UI-only enforcement scores
nothing — everything it shows was already enforced server-side).

- `apps/web/src/types.ts` mirrors `User`, `Role`, `AuditRecord`,
  `Agent.ownerId` (drift-control: server and web types stay in sync).
- `api.ts`: `GET /api/users`, `GET /api/runs/:id/audit`, and the
  `x-launchpad-user` header attached to all requests from the selected user.
- `App.tsx`: a dev user switcher (persisted selection); agent list/creation
  reflects the acting user's ownership; a per-Run **evidence panel** in the
  Playground that renders the run's audit rows — tool, resource, decision,
  reason — with deny rows visually distinct, alongside existing token usage.

### Acceptance criteria

- [ ] Switcher lists seeded users; selection survives reload; agents created as User B persist `ownerId: user-b`
- [ ] Evidence panel shows allow rows for a completed run and highlighted deny rows for RBAC/ownership denials; empty state handled
- [ ] Spec demo steps 1–5 are fully clickable end-to-end (admin run + evidence, exfiltration returns nothing, basic → `payments` deny, ownership deny)
- [ ] No enforcement logic in the web app; it renders server decisions only
- [ ] `npm run check` passes (includes web typecheck + build)

### Blocked by

- Slice 3 (users/ownership) and slice 5 (audit endpoint)

---

## Notes

- **Merge gate:** slice 2 is the earliest point this branch may merge anywhere
  demo-facing (see atomic-cutover decision above). Slices 1+2 together are
  the minimum shippable gateway.
- **Store contention:** slices 2 and 3 both touch `types.ts` and `store.ts` in
  parallel. Collections and fields are disjoint; the first to land introduces
  the tolerant v2 loader, the second rebases trivially. Slices 4–5 add their
  collections through the same loader without version bumps.
- **Revocation demo:** the ADR's demo prose says a revoked agent's next call
  → `403`; frozen Contract 1 classifies revoked-JWT as `401`. Contract 1
  wins (recorded above); the demo script wording should be read as "denied."
- **Deferred per spec/ADR (do not build):** budget hard-stop (metering only),
  temporary/assumed roles, custom-role authoring, per-resource grant records,
  container hardening, ECS.
- After slice 5, the exfiltration + denial story is fully automated-testable;
  the ADR's Verification section maps 1:1 onto slices 1 (exfiltration), 2
  (revocation), 4 (RBAC + ownership), 5 (audit) — keep that mapping when
  editing scope.
