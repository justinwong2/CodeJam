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
  web/           React 19 + Vite UI (@launchpad/web)
    src/
      main.tsx     React root
      App.tsx      the entire UI (~720 lines, single component tree)
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
   `AgentRun`, `RunUsage`, `Database`. New events or evidence records extend
   this.

## API Endpoints

All under `/api`. Auth is a single optional shared bearer token
(`APP_AUTH_TOKEN`) — it is **not** a user identity system.

| Method | Path                       | Purpose                             |
| ------ | -------------------------- | ----------------------------------- |
| GET    | `/api/health`              | Liveness probe                      |
| GET    | `/api/auth`                | Whether a token is required         |
| GET    | `/api/system`              | Runtime/engine diagnostics          |
| GET    | `/api/agents`              | List Agents                         |
| POST   | `/api/agents`              | Create an Agent                     |
| GET    | `/api/agents/:id`          | Get one Agent                       |
| PATCH  | `/api/agents/:id`          | Update an Agent                     |
| DELETE | `/api/agents/:id`          | Delete; archives workspace          |
| POST   | `/api/agents/:id/start`    | Lifecycle: start                    |
| POST   | `/api/agents/:id/stop`     | Lifecycle: stop                     |
| GET    | `/api/agents/:id/messages` | Conversation history                |
| GET    | `/api/agents/:id/runs`     | Run history                         |
| POST   | `/api/agents/:id/messages` | Send a task; creates an async Run   |
| GET    | `/api/runs/:id`            | Poll Run status (the UI polls this) |

When adding an endpoint, update this table **and** the one in
[AGENTS.md](AGENTS.md).

## Data Flow

1. Browser posts to `/api/agents/:id/messages`.
2. `AgentService` persists the user message, creates an `AgentRun` in a pending
   state, and returns immediately — execution is **asynchronous**.
3. The service invokes the configured `AgentRunner`.
4. The runner executes Codex. First turn uses `codex exec`; later turns resume
   the stored Codex thread, which is what makes conversations continuous.
5. Codex calls the Ark Responses API, and may write files and run commands in
   the Agent's workspace.
6. The runner returns a `RunnerResult`; the service persists the assistant
   message and terminal Run state.
7. The UI polls `/api/runs/:id` until the Run reaches a terminal status.

## Configuration

`.env` is gitignored. `.env.example` is the documented template and the README
carries the summary table. Key variables:

| Variable             | Default           | Purpose                                  |
| -------------------- | ----------------- | ---------------------------------------- |
| `ARK_API_KEY`        | required          | Ark model API key                        |
| `ARK_MODEL`          | required          | Responses-capable endpoint ID (`ep-...`) |
| `APP_AUTH_TOKEN`     | empty             | Shared demo token; 24+ chars if remote   |
| `RUNTIME_PROVIDER`   | `local-process`   | `container` for disposable local Runtime |
| `CODEX_SANDBOX_MODE` | `workspace-write` | Codex inner sandbox mode                 |
| `CODEX_TIMEOUT_MS`   | `600000`          | Max duration of one turn                 |

`config.ts` runs every path through `path.resolve`. This is why tests must not
hardcode POSIX paths — see the platform note under Testing.

## Invariants To Preserve

These are load-bearing. Breaking one costs hackathon points directly:

1. **The baseline keeps working.** Agent CRUD, start/stop, Playground chat,
   persistence, and Codex execution must survive every change.
2. **`npm run check` passes.** It is an explicit acceptance-checklist item.
3. **No secret in source, history, logs, traces, screenshots, or demo output.**
   Also an explicit checklist item, enforced by gitleaks in CI.
4. **The Ark API key never reaches the browser and never reaches argv.** It is
   passed via environment to the runner. `container-codex-runner.test.ts`
   asserts this and must keep asserting it.
5. **Runs are asynchronous.** Do not make `POST /api/agents/:id/messages` block
   on completion; the UI depends on polling.
6. **Codex thread continuity.** Resume semantics are what make multi-turn work.
7. **Deleting an Agent archives its workspace** under `workspaces/.deleted/`
   rather than destroying it.
8. **Middleware executes server-side.** UI-only enforcement scores nothing and
   is trivially bypassed.

## Security And Data Handling

- Never commit `.env`, API keys, AK/SK, bearer tokens, or unredacted payloads.
- Redact secrets before writing them to any trace, log, or evidence record.
  If middleware captures inputs/outputs, redaction is part of the feature, not
  a follow-up.
- The optional bearer token protects a remote demo. It is not authorization.
- The JSON store is single-process. Concurrent writers will corrupt it.
- Ordinary containers are not a hardened multi-tenant boundary. The existing
  CPU/memory/PID limits, dropped capabilities, and `no-new-privileges` are
  baseline safeguards, not a new safety capability.

## Testing

```bash
npm run test        # Vitest, server workspace
```

Tests live beside sources as `*.test.ts`. Current suites cover `agent-service`,
`app`, `store`, `codex-runner`, and `container-codex-runner`.

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

The Starter Kit ships Fastify request logging (pino) and nothing else. There is
no trace model, span model, or correlation ID. If the team chose the trace and
audit direction, this section must be rewritten to describe what was built.

## Related Docs

- [AGENTS.md](AGENTS.md) — condensed rules and review checklist
- [docs/README.md](docs/README.md) — documentation index and drift control
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — component and extension boundaries
- [docs/adr/](docs/adr/) — architecture decision records
- [docs/specs/](docs/specs/) — feature design specs
- [docs/HACKATHON_BRIEF.md](docs/HACKATHON_BRIEF.md) — final organizer brief, rubric, checklist
- [SECURITY.md](SECURITY.md) — security policy and known limitations
