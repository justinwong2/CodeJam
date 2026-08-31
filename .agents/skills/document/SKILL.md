---
name: document
description: Analyze and update this repository's documentation layers (README, AGENTS.md, AGENTS.md, docs/, ADRs, specs) following its established patterns and drift-control rules. Use when documenting a middleware capability, adding an endpoint or env var, recording a design decision, or checking which docs a change made stale.
---

# Document (Volc Agent Launchpad)

Repo-scoped documentation skill for the CodeJam Track #5 entry. It knows this
project's actual documentation layers and drift-control rules, so proposals land
in the right files instead of generic ones.

> This skill is committed to the repository and loads automatically for anyone
> who opens it in Codex. It overrides any personal `document` skill while
> working in this repo.

## Usage

```bash
/document                                   # audit docs, report drift
/document feature: per-Agent identity       # propose updates for a capability
/document propose: trace redaction          # show proposals without writing
/document adr: chose AgentRunner boundary   # draft an ADR
/document spec: policy enforcement layer    # draft a design spec
```

## Documentation Layers In This Repo

Canonical index: [docs/README.md](../../../docs/README.md). Read it before
proposing anything — it holds the drift-control rules this skill enforces.

| Layer                 | Files                                                             | Canonical for                                                   |
| --------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------- |
| 1. Root guides        | `README.md`, `AGENTS.md`, `AGENTS.md`                             | Quick start; agent implementation guide; condensed review rules |
| 2. Index              | `docs/README.md`                                                  | What is current, what is archived, drift control                |
| 3. Architecture & ops | `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`, `docs/LOCAL_POC.md` | System shape, deploy paths, container engines                   |
| 4. Decisions          | `docs/adr/YYYY-MM-DD-*.md`                                        | What we chose and why                                           |
| 5. Designs            | `docs/specs/YYYY-MM-DD-*-design.md`                               | How a capability will be built                                  |
| 6. Policy             | `SECURITY.md`, `CONTRIBUTING.md`                                  | Security posture, contribution flow                             |
| 7. Archive            | `docs/archive/`                                                   | Historical only, never source of truth                          |

### Hard rules for this repo

- **Never edit `docs/hackathon-v2-*.xml` or `hackathon-v2-skeleton.xml`.** They
  are the organizers' brief, exported from Feishu, and are read-only reference.
  Prettier already ignores them.
- **Do not create a root `ARCHITECTURE.md`.** `docs/ARCHITECTURE.md` is the only
  architecture doc; a second one guarantees drift.
- **`AGENTS.md` beats `AGENTS.md`.** When they disagree, `AGENTS.md` is the bug.
- **`.env.example` is canonical** for the full variable list. `README.md` and
  `AGENTS.md` carry summary tables that must stay consistent with it.
- **No secrets in any doc**, including examples, screenshots, and demo
  transcripts. This is an explicit hackathon acceptance-checklist item and is
  enforced by gitleaks in CI.

Exclude from discovery: `node_modules/`, `dist/`, `coverage/`, `workspaces/`,
`.data/`, `.local/`, `codex-home/`.

## Workflows

### 1. `/document` — audit and report drift

1. Read [docs/README.md](../../../docs/README.md) for the current index and
   drift rules.
2. Enumerate `.md` files, excluding the paths above.
3. Compare documentation against code reality. Check specifically:
   - Does the API table in `AGENTS.md` match the routes in
     `apps/server/src/app.ts`?
   - Does the config table match `apps/server/src/config.ts` and `.env.example`?
   - Do the commands listed match `package.json` scripts?
   - Do `apps/server/src/types.ts` and `apps/web/src/types.ts` still agree?
   - Are the `docs/adr/` and `docs/specs/` index tables current?
4. Report drift as a table: file, what is stale, what the code actually says.

Report findings; do not silently rewrite. Documentation edits are the author's
call.

### 2. `/document feature: <name>` — propose updates

1. Locate the implementing code; collect concrete `file:line` references.
2. Determine which layers the change touches, using the drift-control rules in
   `docs/README.md`.
3. Propose specific edits per file — the section, the content, and why.
4. Show proposals for review, then write after approval.

Apply the matching drift-control checklist:

- **New endpoint** → `AGENTS.md` API table, `AGENTS.md` repo map if ownership
  shifts, `docs/ARCHITECTURE.md` if flow changes, plus auth/validation tests.
- **New env var** → `.env.example` (with a comment), `README.md` config table,
  `AGENTS.md` config table, `docs/DEPLOYMENT.md` if operators set it.
- **New middleware capability** → an ADR, a spec if non-trivial, `AGENTS.md`
  invariants + observability, `AGENTS.md` review checklist, `README.md` so a
  reviewer can run it, and tests including the failure case.
- **Schema change** → keep both `types.ts` files in sync, update `AGENTS.md`
  data flow, update store tests.
- **Redaction/data handling** → `SECURITY.md`, `AGENTS.md` security section,
  `AGENTS.md` checklist, redaction tests.

### 3. `/document adr: <decision>` — draft a decision record

Copy [docs/adr/TEMPLATE.md](../../../docs/adr/TEMPLATE.md) to
`docs/adr/YYYY-MM-DD-short-title.md`. Use today's real date.

Push hard on three sections, because they carry the score:

- **Context** must name an _Agent-specific_ problem — something that matters
  because an autonomous actor executes code, not a generic web concern.
- **Decision** must name the boundary (request boundary, `AgentService`,
  `AgentRunner`, or the data model), the data crossing it, and the failure mode
  (fail open or closed, and why).
- **Alternatives Considered** must say why not. Reviewers ask this first.

Then add a row to the index table in `docs/adr/README.md`.

### 4. `/document spec: <feature>` — draft a design spec

Copy [docs/specs/TEMPLATE.md](../../../docs/specs/TEMPLATE.md) to
`docs/specs/YYYY-MM-DD-feature-name-design.md`.

Require a testing plan and an explicit out-of-scope section. If the
files-expected-to-change table is long or heavily touches baseline files, say so
— that is the main three-day failure mode.

Then add a row to the index table in `docs/specs/README.md`.

## Project Context That Shapes Proposals

This is a **three-day judged hackathon entry**, not a long-lived product. Docs
should serve two readers: teammates building fast, and reviewers scoring
against a rubric.

| Category                     | Weight | Documentation's role                     |
| ---------------------------- | ------ | ---------------------------------------- |
| End-to-end middleware        | 40%    | Demo steps a reviewer can reproduce      |
| Technical design/integration | 25%    | The ADR: rationale, boundary, contracts  |
| Verification and robustness  | 20%    | Documented tests and failure cases       |
| Demo and reproducibility     | 15%    | README, one-command startup, limitations |

Consequences for proposals:

- Prefer updating an existing doc over creating a new one. New files are new
  drift surface.
- **Document limitations honestly.** "Known limitations" is an explicit
  deliverable, and reviewers reward acknowledged trade-offs over hidden ones.
- Never document a plan as if it were implemented. If it is not built, its home
  is a spec with `Status: Draft`.
- Keep the baseline story intact: the Starter Kit is a prerequisite, not an
  innovation point, so docs should foreground team-designed middleware.

## Validation Checklist

Before finishing:

- [ ] Every affected layer identified via `docs/README.md` drift control
- [ ] Code references use `file:line`
- [ ] Config defaults match `config.ts` and `.env.example`
- [ ] API table matches `app.ts` routes
- [ ] `docs/adr/` and `docs/specs/` index tables updated
- [ ] No secrets, keys, or unredacted payloads anywhere
- [ ] No edits to `hackathon-v2-*.xml`
- [ ] Unbuilt work is marked Draft, not described as shipped
- [ ] Prettier-clean — `npm run format:check` covers Markdown
