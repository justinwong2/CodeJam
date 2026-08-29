# AGENTS.md

Guidance for coding agents doing code review or focused feature work.

> **For implementation work, read [CLAUDE.md](CLAUDE.md) first.** This file is
> a condensed summary; `CLAUDE.md` is canonical.

## Project Summary

Volc Agent Launchpad — an Agent platform where users create Agents in a
browser and run tasks through Codex CLI against a BytePlus ModelArk endpoint.

This repo is a **CodeJam Track #5 hackathon entry**. The platform is a provided
Starter Kit; our contribution is the middleware layer it deliberately omits.
The Starter Kit itself scores zero. See [docs/adr/](docs/adr/) for our chosen
direction.

## Deployment Context

Local container Runtime is the judged path (`npm run poc`). ECS is optional and
unscored. Single-user POC: no identity system, single-process JSON store,
ordinary containers rather than hardened isolation.

## Key Invariants

Summary — canonical list is in [CLAUDE.md](CLAUDE.md#invariants-to-preserve).

1. The baseline must keep working: CRUD, lifecycle, Playground, persistence.
2. `npm run check` must pass.
3. No secret in source, Git history, logs, traces, screenshots, or demo output.
4. The Ark API key never reaches the browser, argv, or the Agent Runtime; the
   gateway attaches it only when forwarding upstream.
5. Runs stay asynchronous; the UI polls `/api/runs/:id`.
6. Codex thread continuity powers multi-turn conversations.
7. Agent deletion archives the workspace; it does not destroy it.
8. Middleware enforces server-side, never UI-only.
9. The gateway fails closed: an unverifiable run credential is `401` and the
   upstream is never called.

## Repo Map

| Path                                        | Owns                            |
| ------------------------------------------- | ------------------------------- |
| `apps/server/src/app.ts`                    | Routes, request boundary        |
| `apps/server/src/agent-service.ts`          | Orchestration, Run state        |
| `apps/server/src/store.ts`                  | JSON persistence                |
| `apps/server/src/config.ts`                 | Env parsing and validation      |
| `apps/server/src/types.ts`                  | Domain types, `AgentRunner`     |
| `apps/server/src/codex-runner.ts`           | Codex as host process           |
| `apps/server/src/container-codex-runner.ts` | Codex in disposable container   |
| `apps/server/src/gateway.ts`                | Agent Access Gateway routes     |
| `apps/server/src/run-jwt.ts`                | Per-run credential sign/verify  |
| `apps/web/src/App.tsx`                      | Entire UI                       |
| `docs/`                                     | Architecture, deployment, brief |

Browser-facing routes live under `/api/*` behind the shared demo token,
including the operator's kill switch:

| Method | Path                     | Purpose                                      |
| ------ | ------------------------ | -------------------------------------------- |
| POST   | `/api/agents/:id/revoke` | Revoke the Agent's live run sessions mid-run |

The agent-facing gateway is separate and deliberately outside that hook —
agents authenticate with their own per-run credential, which the control plane
mints and can revoke:

| Method | Path                    | Purpose                                                                               |
| ------ | ----------------------- | ------------------------------------------------------------------------------------- |
| POST   | `/gateway/v1/responses` | Model proxy: verifies the run session, injects the Ark key, streams the reply through |

## Extension Seams

Put middleware at one of these, not somewhere new:

1. Fastify request boundary (`app.ts`) — principals, policy, trace root.
2. `AgentService` — lifecycle and Run state decisions.
3. `AgentRunner` interface — decorate a runner without touching callers.
4. Execution data model (`types.ts` + `store.ts`) — new events and evidence.

## Common Commands

```bash
npm run check     # lint + format:check + typecheck + test + build (CI gate)
npm run lint:fix  # autofix lint
npm run format    # autofix formatting
npm run test      # Vitest, server
npm run poc       # local POC with container Runtime
```

## Code Review Checklist

- **Baseline preserved:** do CRUD, lifecycle, Playground, and persistence still
  work? Any change to `app.ts` or `agent-service.ts` deserves scrutiny here.
- **Enforcement location:** is the check server-side? A UI-only guard is not
  middleware and is trivially bypassed.
- **Secrets:** no keys or tokens in source, logs, traces, fixtures, or test
  output. Are captured payloads redacted before storage?
- **Async contract:** message POST still returns without blocking; Run status
  still reaches a terminal state.
- **Error handling:** what happens when the middleware itself fails? Does it
  fail open or closed, and is that the intended choice?
- **Cleanup:** are containers, temp files, and workspaces released on both the
  success and failure paths?
- **Tests:** does a test cover the _behavior_ — a real denial, a real
  correlation, a real budget stop — rather than only rendering?
- **Platform:** no hardcoded POSIX paths in tests; `config.ts` resolves paths,
  so expectations must resolve too.
- **Docs drift:** new endpoint, env var, or schema change → follow the
  drift-control rules in [docs/README.md](docs/README.md).

## Feature Development Guidance

Depth beats breadth. The rubric rewards one capability that works end to end
over three partial ones:

| Category                     | Weight |
| ---------------------------- | ------ |
| End-to-end middleware        | 40%    |
| Technical design/integration | 25%    |
| Verification and robustness  | 20%    |
| Demo and reproducibility     | 15%    |

Every capability needs a normal case **and** a failure, denial, degraded, or
recovery case. Both must be demonstrable live in under three minutes.

## References

- [CLAUDE.md](CLAUDE.md) — full implementation guide
- [docs/README.md](docs/README.md) — doc index and drift control
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — component boundaries
- [SECURITY.md](SECURITY.md) — security policy
