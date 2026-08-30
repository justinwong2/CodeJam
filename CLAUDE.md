# CLAUDE.md

Implementation guidance for coding agents working in this repository.

> **Read this first for implementation work.** For quick reviews, see
> [AGENTS.md](AGENTS.md). For the documentation index and drift-control rules,
> see [docs/README.md](docs/README.md).

## Project Overview

Volc Agent Launchpad is an Agent platform: users create Agents from a browser,
send them tasks, and the Agent runs Codex CLI against a BytePlus ModelArk
(Ark) Responses-compatible endpoint inside a disposable container.

**This repository is a hackathon entry for CodeJam Track #5 — the Agent
Middleware Challenge.** The platform baseline was provided by the organizers.
Our work is the _middleware layer_ the Starter Kit deliberately omits.

That framing drives every decision here:

- The baseline (Agent CRUD, lifecycle, Playground, persistence, Codex
  execution) **must keep working**. Breaking it costs more than any feature
  gains.
- The Starter Kit earns **zero** innovation points. Only team-designed
  middleware is scored.
- Middleware must execute in a **backend, Runtime, data, or infrastructure
  path**. UI-only behavior does not count.

See [docs/adr/](docs/adr/) for which middleware direction we chose and why.

## Commands

```bash
npm install                 # install workspace dependencies
npm run dev                 # server on :3000, web on :5173 (hot reload)
npm run poc                 # full local POC with container Runtime, on :3000

npm run lint                # ESLint across the monorepo
npm run lint:fix            # ESLint with autofix
npm run format              # Prettier write
npm run format:check        # Prettier verify (what CI runs)
npm run typecheck           # tsc --noEmit, both workspaces
npm run test                # Vitest, server only
npm run build               # web (vite) then server (tsc)

npm run check               # lint + format:check + typecheck + test + build
```

`npm run check` is the **canonical quality gate**. It is the command named in
the hackathon acceptance checklist and the command CI runs. If it passes
locally it passes in CI; keep it that way.

Running the POC requires `ARK_API_KEY` and `ARK_MODEL` in `.env`. `ARK_API_KEY`
must be an **Ark model API key**, not a BytePlus account AK/SK, and `ARK_MODEL`
is normally an endpoint ID starting with `ep-`. A wrong credential surfaces as
`401 Unauthorized` from the Ark Responses API.

## Architecture

```
apps/
  server/        Fastify control plane (@launchpad/server)
    src/
      index.ts                    process entry, starts the server
      app.ts                      route definitions and the request boundary
      agent-service.ts            AgentService: orchestration and Run state
      store.ts                    JSON persistence (single-process)
      workspace.ts                per-Agent workspace paths and archival
      config.ts                   env parsing and validation (zod)
      types.ts                    shared domain types + AgentRunner interface
      errors.ts                   typed error helpers
      runner-factory.ts           selects a runner from RUNTIME_PROVIDER
      codex-runner.ts             AgentRunner: Codex as a host process
      container-codex-runner.ts   AgentRunner: Codex in a disposable container
      gateway.ts                  Agent Access Gateway: agent-facing proxy routes
      run-jwt.ts                  HS256 sign/verify for per-run credentials
      authz.ts                    can(): the pure authorization decision
      audit.ts                    AuditLog: one redacted record per decision
      mock-tools.ts               docs/search/payments the gateway forwards to
  web/           React 19 + Vite UI (@launchpad/web)
    src/
      main.tsx     React root
      App.tsx      the entire UI (~900 lines, single component tree)
      api.ts       typed fetch wrappers for the control plane
      types.ts     UI-side mirrors of server types
deploy/volcengine/   Terraform for optional ECS deployment
docs/                architecture, deployment, and the hackathon brief
scripts/             bash entry points (start-local-poc.sh, deploy, bootstrap)
```

### Core runtime paths

- **Server entry point:** `apps/server/src/index.ts`
- **Request boundary:** `apps/server/src/app.ts`
- **Orchestration:** `apps/server/src/agent-service.ts`
- **Persistence:** `apps/server/src/store.ts`
- **Configuration loader:** `apps/server/src/config.ts`
- **Runtime abstraction:** `AgentRunner` in `apps/server/src/types.ts`
- **Frontend entry point:** `apps/web/src/main.tsx` → `apps/web/src/App.tsx`

### Extension seams

These are the four boundaries where middleware belongs. Prefer them over
inventing new ones:

1. **Fastify request boundary** (`app.ts`) — where a principal, policy check,
   or trace root span naturally attaches.
2. **AgentService** (`agent-service.ts`) — where Run lifecycle and state
   transitions are decided.
3. **`AgentRunner` interface** (`types.ts`) — the seam between orchestration
   and execution. Both runners implement it:

   ```ts
   export interface AgentRunner {
     run(request: RunnerRequest): Promise<RunnerResult>;
     cancel(agentId: string): Promise<boolean>;
     isAvailable(): Promise<boolean>;
   }
   ```

   A new runner (policy-wrapping, tracing, budget-enforcing) can decorate an
   existing one without touching callers. `runner-factory.ts` picks the
   implementation from `RUNTIME_PROVIDER`.

4. **Execution data model** (`types.ts` + `store.ts`) — `Agent`, `Message`,
   `AgentRun`, `RunUsage`, `RunSession`, `Database`. New events or evidence
   records extend this. `JsonStore.initialize` migrates older files forward, so
   a new collection is an addition, not a breaking change.

### Web UI

The browser is **not** one of those seams: it shows what the server decided and
enforces nothing. Three pieces of it exist for the gateway, and all are
display-only on purpose — a UI-side check would score nothing and be bypassed by
any client that is not this one.

- **Dev user switcher.** `api.ts` owns which seeded user the browser acts as: it
  reads the selection from `localStorage` at module load, writes it back on
  every change, and attaches it as `x-launchpad-user` to every request. The
  server validates the id and resolves that user's role; the browser never
  sends a role or a permission. `App.tsx` renders the picker and labels each
  Agent with its owner.
- **Run evidence panel.** The Playground reads `GET /api/runs/:id/audit` on each
  polling tick and renders the Run's decisions — tool, resource, decision,
  reason — with denials visually distinct, beside the Run's token usage. It
  never derives a decision, and shows an empty state rather than inventing one.
- **Operator Console.** A second view in `App.tsx`, reached from the sidebar. It
  reads `GET /api/operator/{audit,sessions,docs}` on a three-second tick and
  renders four tables: the decision feed across every Agent and Run (denials
  distinct, newest first), run sessions **as claims** with a Revoke button on
  the live ones, the ground-truth document table (metadata only), and a role
  dropdown per human. Its two levers are the existing
  `POST /api/agents/:id/revoke` and `PATCH /api/users/:id` — it triggers them
  and displays what the store then says. It decides nothing, and it is
  deliberately **not** gated by the `admin` role: mock authentication makes
  role-gating an operator surface theater. Use "operator" for the surface and
  "admin" only for the role.

`apps/web/src/types.ts` mirrors the server's `User`, `Role`, `AuditRecord`,
`RunSessionClaims`, `MockDocMetadata`, and `Agent.ownerId`. The server's
`types.ts` is canonical; keep the two in sync.

## API Endpoints

All under `/api`. Auth is a single optional shared bearer token
(`APP_AUTH_TOKEN`) — it is **not** a user identity system.

| Method | Path                       | Purpose                              |
| ------ | -------------------------- | ------------------------------------ |
| GET    | `/api/health`              | Liveness probe                       |
| GET    | `/api/auth`                | Whether a token is required          |
| GET    | `/api/system`              | Runtime/engine diagnostics           |
| GET    | `/api/users`               | Seeded users for the dev switcher    |
| PATCH  | `/api/users/:id`           | Assign a seeded role: `{ role }`     |
| GET    | `/api/operator/audit`      | Every Run's decisions, by `ts`       |
| GET    | `/api/operator/sessions`   | Run sessions as claims, newest first |
| GET    | `/api/operator/docs`       | Document metadata: id and owner      |
| GET    | `/api/agents`              | List Agents                          |
| POST   | `/api/agents`              | Create an Agent                      |
| GET    | `/api/agents/:id`          | Get one Agent                        |
| PATCH  | `/api/agents/:id`          | Update an Agent                      |
| DELETE | `/api/agents/:id`          | Delete; archives workspace           |
| POST   | `/api/agents/:id/start`    | Lifecycle: start                     |
| POST   | `/api/agents/:id/stop`     | Lifecycle: stop                      |
| GET    | `/api/agents/:id/messages` | Conversation history                 |
| GET    | `/api/agents/:id/runs`     | Run history                          |
| POST   | `/api/agents/:id/messages` | Send a task; creates an async Run    |
| POST   | `/api/agents/:id/revoke`   | Revoke the Agent's live run sessions |
| GET    | `/api/runs/:id`            | Poll Run status (the UI polls this)  |
| GET    | `/api/runs/:id/audit`      | The Run's gateway decisions, by `ts` |

Browser requests name the human they act as with an `x-launchpad-user` header
(a seeded user id; `user-a` when absent, `400` when unknown). This is mock
authentication by design — the middleware being scored is authorization — and
it decides which user a newly created Agent is owned by. The web app's half of
it is the dev user switcher in `api.ts` (see Web UI below).

`PATCH /api/users/:id` accepts exactly `{ role }`, one of `admin`, `basic`, or
`suspended` — assigning roles is in scope, authoring them is not, so any other
value is a `400` and an unknown user is a `404`. It takes effect on that
human's Agents' **next** gateway call, with no token event of any kind, because
permissions are read from the store per call and were never in the credential.
The three `/api/operator/*` reads are the Operator Console's data: the whole
decision timeline, sessions projected to their claims (the raw credential is in
no payload), and document metadata without content.

The Agent Access Gateway adds an **agent-facing** surface under `/gateway`.
It is deliberately outside the `/api/*` auth hook: agents authenticate with
their own run credential (`RUN_JWT`), not the browser's shared demo token.

| Method | Path                        | Purpose                                                                                      |
| ------ | --------------------------- | -------------------------------------------------------------------------------------------- |
| POST   | `/gateway/v1/responses`     | Model proxy: verifies the run session, applies `can()`, injects the Ark key, streams through |
| ALL    | `/gateway/v1/tools/:tool/*` | Tool proxy: verifies the run session, resolves the principal, applies `can()`, then forwards |

`:tool` is `docs`, `search`, or `payments`; anything else is a `403`. The proxy
forwards to the mock tool service at `/internal/tools/*`, which accepts only
calls carrying `GATEWAY_TOOL_CREDENTIAL` — so skipping the gateway is refused
rather than merely undocumented. That surface is not a browser API and is not
listed above. Both routes write one audit record per decision before answering;
the operator reads them back at `GET /api/runs/:id/audit`.

When adding an endpoint, update this table **and** the one in
[AGENTS.md](AGENTS.md).

## Data Flow

1. Browser posts to `/api/agents/:id/messages`.
2. `AgentService` persists the user message, creates an `AgentRun` in a pending
   state, mints the run's HS256 credential and its `RunSession` in the same
   write, and returns immediately — execution is **asynchronous**.
3. The service invokes the configured `AgentRunner`, passing `runJwt`.
4. The runner executes Codex with that credential in `RUN_JWT`. First turn uses
   `codex exec`; later turns resume the stored Codex thread, which is what makes
   conversations continuous.
5. Codex calls `POST /gateway/v1/responses` on this server — not Ark directly.
   The gateway verifies the credential against its `RunSession` (signature,
   expiry, `revoked`), resolves the `Principal` from the Agent's current owner
   and runs `can(principal, "model")`, then swaps the credential for the Ark key
   and streams the upstream reply back unmodified. Anything unverifiable is a
   `401` and any role that does not grant `model` is a `403`, both with no
   upstream call — so a `suspended` owner's Agent cannot spend tokens either.
   Codex may also write files and run commands in the Agent's workspace.
6. A tool call goes to `/gateway/v1/tools/:tool/*` instead. The gateway verifies
   the same credential, then resolves the `Principal` from the Agent's **current
   owner** in the store — permissions are never in the token — and runs
   `can(principal, tool, resource?)`. Only on allow does it attach
   `GATEWAY_TOOL_CREDENTIAL` and forward; a denial is a `403` and the tool is
   never called.
7. Whichever way it went, the decision is written to `audit: AuditRecord[]`
   through `AuditLog` **before** the answer is sent, so the store is never
   behind what the agent has been told.
8. The runner returns a `RunnerResult`; the service persists the assistant
   message and terminal Run state, and expires the run's session.
9. The UI polls `/api/runs/:id` until the Run reaches a terminal status, and
   reads `/api/runs/:id/audit` for what the gateway decided along the way.

## Configuration

`.env` is gitignored. `.env.example` is the documented template and the README
carries the summary table. Key variables:

| Variable                  | Default           | Purpose                                   |
| ------------------------- | ----------------- | ----------------------------------------- |
| `ARK_API_KEY`             | required          | Ark model API key                         |
| `ARK_MODEL`               | required          | Responses-capable endpoint ID (`ep-...`)  |
| `APP_AUTH_TOKEN`          | empty             | Shared demo token; 24+ chars if remote    |
| `GATEWAY_JWT_SECRET`      | required          | Signs per-run gateway credentials (16+)   |
| `GATEWAY_TOOL_CREDENTIAL` | per-process       | Gateway → mock tool service; optional     |
| `RUNTIME_PROVIDER`        | `local-process`   | `container` for disposable local Runtime  |
| `CODEX_SANDBOX_MODE`      | `workspace-write` | Codex inner sandbox mode                  |
| `CODEX_TIMEOUT_MS`        | `600000`          | Max duration of one turn                  |
| `SESSION_TTL_MS`          | `660000`          | How long a run's gateway credential lives |

`config.ts` runs every path through `path.resolve`. This is why tests must not
hardcode POSIX paths — see the platform note under Testing.

`SESSION_TTL_MS` is how long a run's gateway credential stays usable, minted
into the `RunSession` and the token's `exp` together. It has its own variable
rather than trailing `CODEX_TIMEOUT_MS` by a margin, because a credential's
lifetime is a security decision and should be shortenable without shortening
what a turn may take. The default (`660000`) is exactly what the old
`CODEX_TIMEOUT_MS + 60_000` coupling produced, so naming it changed nothing;
values under a second, or values that are not numbers, fail at boot.

`GATEWAY_JWT_SECRET` is the gateway's HS256 signing key for per-run
credentials. It is **required**: `loadConfig` throws when it is missing, under
16 characters, or still the `replace-` placeholder, because a gateway that
cannot verify a credential must not start rather than accept unverified agent
calls. It never leaves the server process — not into a token, a log line, an
error body, or a runner environment. `npm run poc` mints an ephemeral secret
for the run when none is configured; `npm run dev` reads the process
environment, so export one there.

`GATEWAY_TOOL_CREDENTIAL` is what the gateway presents to the mock tool
service, and the only reason a tool call cannot skip the authorization check.
It is **not** required: both ends of the check live in this process, so
`loadConfig` mints one per process when it is unset — there is no configuration
a deployment can forget into a weak one. A value that _is_ set is held to the
same bar as the signing secret (16+ characters, no `replace-` placeholder) and,
like it, never leaves the server process.

The gateway also changes who
writes Codex's `config.toml`: the **active runner** writes it when constructed,
not server startup, because the gateway origin depends on the runner's vantage
point — `http://127.0.0.1:<PORT>/gateway/v1` for the host process,
`http://host.docker.internal:<PORT>/gateway/v1` (or `host.containers.internal`
on Podman) from inside a container. `env_key` is `RUN_JWT`, never `ARK_API_KEY`.
Because a container reaches the host on a non-loopback interface,
`npm run poc` now binds `HOST=0.0.0.0` and generates an ephemeral
`APP_AUTH_TOKEN` for the run when none is configured.

## Invariants To Preserve

These are load-bearing. Breaking one costs hackathon points directly:

1. **The baseline keeps working.** Agent CRUD, start/stop, Playground chat,
   persistence, and Codex execution must survive every change.
2. **`npm run check` passes.** It is an explicit acceptance-checklist item.
3. **No secret in source, history, logs, traces, screenshots, or demo output.**
   Also an explicit checklist item, enforced by gitleaks in CI.
4. **The Ark API key never reaches the browser, argv, or the Agent Runtime.**
   It stays in the server process and is attached only by the gateway when it
   forwards upstream. Codex receives `RUN_JWT` instead.
   `container-codex-runner.test.ts` and `codex-runner.test.ts` assert this and
   must keep asserting it.
5. **Runs are asynchronous.** Do not make `POST /api/agents/:id/messages` block
   on completion; the UI depends on polling.
6. **Codex thread continuity.** Resume semantics are what make multi-turn work.
7. **Deleting an Agent archives its workspace** under `workspaces/.deleted/`
   rather than destroying it.
8. **Middleware executes server-side.** UI-only enforcement scores nothing and
   is trivially bypassed.
9. **The gateway fails closed.** Every agent call is verified against a live
   `RunSession` before anything is forwarded; a missing, forged, expired, or
   revoked credential is a `401` and the upstream is never called.
   `gateway.test.ts` asserts both halves — the denial _and_ the absent upstream
   request — and must keep asserting both.
10. **Authorization is decided server-side, per call, from stored ownership.**
    Permissions are never in the run credential: the gateway resolves the
    principal from the Agent's current owner and calls `can()` on every call —
    the model included — so a denial is a `403` with nothing forwarded. A role
    change therefore lands on the next call rather than at token expiry, which
    is what makes `suspended` total and the mid-run role flip real. The mock
    tool service is reachable only with `GATEWAY_TOOL_CREDENTIAL`, which is what
    makes skipping the gateway a refusal rather than a shortcut.
11. **Every gateway decision leaves exactly one redacted record, written before
    the answer.** `AuditLog` is the only writer, identity comes from stored
    ownership rather than from a credential's claims, and no request or
    response body is persisted. `audit.test.ts` and `gateway.test.ts` assert
    the redaction and the one-record-per-decision rule and must keep doing so.

## Security And Data Handling

- Never commit `.env`, API keys, AK/SK, bearer tokens, or unredacted payloads.
- Redact secrets before writing them to any trace, log, or evidence record.
  If middleware captures inputs/outputs, redaction is part of the feature, not
  a follow-up.
- The optional bearer token protects a remote demo. It is not authorization.
- `GATEWAY_JWT_SECRET` lives in the server process only. It signs and verifies
  run credentials and must never appear in a token, a log line, an error body,
  a runner environment, or a test fixture that looks like a real secret.
- `GATEWAY_TOOL_CREDENTIAL` lives in the server process only, under the same
  rules. The gateway attaches it when forwarding an authorized tool call and
  nowhere else; it must never reach a runner environment or a response body.
- Audit records carry a decision, not a payload: the tool, the `resource`
  identifier, and the reason. Redaction happens inside `audit.ts` on the way to
  the store, so no call site can persist a record that skipped it. When you add
  a field to `AuditRecord`, run it through the same masking.
- The Ark key lives in the server process only. It is attached by the gateway
  when forwarding upstream and must never be copied into a runner environment,
  argv, a generated `config.toml`, or a log line — including the forwarded
  `Authorization` header.
- The JSON store is single-process. Concurrent writers will corrupt it.
- Ordinary containers are not a hardened multi-tenant boundary. The existing
  CPU/memory/PID limits, dropped capabilities, and `no-new-privileges` are
  baseline safeguards, not a new safety capability.

## Testing

```bash
npm run test        # Vitest, server workspace
```

Tests live beside sources as `*.test.ts`. Current suites cover `agent-service`,
`app`, `audit`, `authz`, `config`, `gateway`, `mock-tools`, `run-jwt`, `store`,
`codex-runner`, `container-codex-runner`, and the runner spawn environments.

**Platform note:** `config.ts` calls `path.resolve` on every path, so resolved
paths differ between POSIX and Windows. Tests must resolve expected paths
rather than hardcoding `/tmp/...`. See the `RESOLVED_CODEX_HOME` pattern in
`container-codex-runner.test.ts`.

Middleware work needs tests for the **behavior**, not the rendering — a denial
that is actually denied, a trace that is actually correlated, a budget that
actually stops a Run. The rubric weights verification at 20%.

## Deployment

Local is the default and the judged path:

- `npm run poc` — disposable container per turn (recommended)
- `docker compose up --build` — Compose
- `npm run dev` — host process, hot reload

ECS deployment is optional and does not affect scoring. See
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Observability

Fastify request logging (pino) is the Starter Kit's baseline and is still the
only thing covering ordinary HTTP traffic — there is no trace model, span model,
or correlation ID, and none is planned.

What we added is narrower and durable: an **audit trail of gateway decisions**.
Logs say what happened to a process; these records say what an Agent was allowed
to do, on whose authority, and why.

- **One record per decision.** `AuditLog.record()` in
  `apps/server/src/audit.ts` is the single writer, and every route in
  `gateway.ts` goes through it — model proxy and tool proxy, allow and deny.
  A forward is an `allow`; every refusal that reaches a decision is a `deny`
  carrying the same reason the caller was given (`can()`'s or the verifier's).
  Never two rows for one request, never none.
- **Written before the answer.** The record is persisted before the reply is
  sent and before anything is forwarded, so the store is never behind what the
  agent already knows. On the allow path a store that cannot accept the record
  stops the call; on a deny path a failed write is logged and the denial stands
  — evidence trouble must never rescue a caller.
- **Identity is a store fact.** `humanId` / `agentId` / `runId` come from the
  resolved `Principal`, or from the stored `RunSession` when a call was refused
  before a principal could be resolved. Claims from a credential the gateway
  has just refused to trust are never used as an identity, so a call it cannot
  attribute to a run is denied and logged but files no record — there is no Run
  to file it under. The same applies to a path naming nothing that is a
  `ToolName`.
- **Redacted by construction.** No request or response body is stored, only the
  `resource` identifier (`docs/doc-b1`) and the reason. Both go through the
  masking in `audit.ts`, which removes the Ark key, `GATEWAY_JWT_SECRET`,
  `GATEWAY_TOOL_CREDENTIAL`, anything shaped like a bearer header or a signed
  token, and bounds each field's length.
- **Read per Run, and across all of them.** `GET /api/runs/:id/audit` returns
  that Run's records ordered by `ts`, behind `APP_AUTH_TOKEN` like the rest of
  `/api`. Unknown Run → `404`. It is the evidence panel's data source.
  `GET /api/operator/audit` returns the same records for every Agent and Run in
  one timeline, which is what the Operator Console's decision feed reads: a
  denial is often only legible beside what the same human was allowed a moment
  earlier.
- **What is not audited.** An operator's own actions. `AuditRecord` belongs to a
  Run, and a role change or a revocation has none — so a `PATCH /api/users/:id`
  leaves no record, and the change is visible only in its effect on the next
  decision. Accepted for demo scope and recorded in
  [SECURITY.md](SECURITY.md); a record naming no run would be worse than the
  gap it papers over.

Token metering is separate and unchanged: `RunUsage` is parsed from Codex
output. Per-call usage is deliberately not parsed out of the SSE stream.

## Related Docs

- [AGENTS.md](AGENTS.md) — condensed rules and review checklist
- [docs/README.md](docs/README.md) — documentation index and drift control
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — component and extension boundaries
- [docs/adr/](docs/adr/) — architecture decision records
- [docs/specs/](docs/specs/) — feature design specs
- [docs/HACKATHON_BRIEF.md](docs/HACKATHON_BRIEF.md) — final organizer brief, rubric, checklist
- [SECURITY.md](SECURITY.md) — security policy and known limitations
