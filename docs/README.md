# Documentation Index

This index defines which documents are current source of truth and what must be
updated when behavior changes.

## Current Operational Docs

| Doc                                      | Canonical for                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [../README.md](../README.md)             | The middleware problem and rationale, human quick start, demo steps, config summary, known limitations |
| [../CLAUDE.md](../CLAUDE.md)             | Agent implementation guide, invariants, seams                                                          |
| [../AGENTS.md](../AGENTS.md)             | Condensed agent rules and review checklist                                                             |
| [../SECURITY.md](../SECURITY.md)         | Security policy and accepted POC limitations                                                           |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Contribution workflow                                                                                  |

## Architecture And Operations

| Doc                                                | Canonical for                            |
| -------------------------------------------------- | ---------------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md)                 | Component and extension boundaries       |
| [ARCHITECTURE_DIAGRAM.md](ARCHITECTURE_DIAGRAM.md) | The one-page diagram deliverable         |
| [DEPLOYMENT.md](DEPLOYMENT.md)                     | ECS and Terraform deployment             |
| [LOCAL_POC.md](LOCAL_POC.md)                       | Docker, Colima, rootless Podman          |
| [HACKATHON_BRIEF.md](HACKATHON_BRIEF.md)           | Final challenge brief, rubric, checklist |

There is no root `ARCHITECTURE.md`; `docs/ARCHITECTURE.md` is the only
architecture _description_. Do not create a second one.

[ARCHITECTURE_DIAGRAM.md](ARCHITECTURE_DIAGRAM.md) is not a second one. It is
the hackathon's one-page diagram deliverable, canonical for the trust boundaries
and the numbered enforcement points and for nothing else — it describes no
component. `ARCHITECTURE.md` keeps the orientation diagram and the prose; this
page changes only when a boundary or an enforcement point moves.

## Decisions And Designs

| Path               | Purpose                                                                        |
| ------------------ | ------------------------------------------------------------------------------ |
| [adr/](adr/)       | Architecture decision records — what we chose and why                          |
| [specs/](specs/)   | Feature design specs — how a capability will be built                          |
| [issues/](issues/) | Implementation slices — grabbable tracer-bullet work items derived from a spec |

The ADR recording our middleware direction is a **scored artifact**: the rubric
allocates 25% to "clear rationale, coherent architecture, appropriate
boundary," and the deliverables require "the middleware problem and rationale,
design summary."

## Reference Material

[HACKATHON_BRIEF.md](HACKATHON_BRIEF.md) is the **final** organizer brief
(transcribed from Feishu, 2026-08-27) and is canonical for challenge
requirements, rubric, and checklist.

`hackathon-v2-section-*.xml`, `hackathon-v2-skeleton.xml`, and
[HACKATHON_EXTENSION_GUIDE.md](HACKATHON_EXTENSION_GUIDE.md) are **earlier
drafts** of that brief which shipped inside the Starter Kit. They are retained
read-only for historical reference: do not edit or reformat them, and do not
plan against them — notably, they say "choose exactly one middleware track,"
a rule the final brief replaced with "recommended examples, not a prescribed
checklist." Prettier is configured to ignore the XML files.

`assets/` holds the README screenshots and `architecture.pdf`, the rendered
one-page diagram. That PDF is **generated**, never hand-edited: its source is the
Mermaid block in [ARCHITECTURE_DIAGRAM.md](ARCHITECTURE_DIAGRAM.md), and it is
regenerated whenever that block changes.

## Historical / Archived Docs

None yet. When a doc stops being authoritative, move it to `docs/archive/`, add
the archive banner below to the top, and list it in this section.

```markdown
> Status: Archived. Retained for historical context; not the source of truth
> for current implementation. See `CLAUDE.md` and `docs/README.md`.
```

## Drift Control

When behavior changes, update at minimum:

### New or changed API endpoint

- `CLAUDE.md` → API Endpoints table
- `AGENTS.md` → repo map, if ownership shifts
- `docs/ARCHITECTURE.md` → if the endpoint changes system flow
- Tests covering auth, validation, and error shape

### New environment variable

- `.env.example` — with a comment explaining it
- `README.md` → Configuration table
- `CLAUDE.md` → Configuration table
- `docs/DEPLOYMENT.md` — if operators must set it

### New middleware capability

- `docs/adr/` → a dated ADR with the decision and its consequences
- `docs/specs/` → a design spec, if the design is non-trivial
- `docs/ARCHITECTURE_DIAGRAM.md` → if it adds or moves an enforcement point,
  an instrumentation point, or a trust boundary
- `CLAUDE.md` → Invariants, Observability, and Architecture sections
- `AGENTS.md` → review checklist, if reviewers need a new check
- `README.md` → so a reviewer can actually run and see it
- Tests covering the behavior, including the failure or denial case

### Schema or persistence change

- `apps/server/src/types.ts` and `apps/web/src/types.ts` stay in sync
- `CLAUDE.md` → Data Flow section
- Store tests

### Data handling or redaction change

- `SECURITY.md`
- `CLAUDE.md` → Security And Data Handling
- `AGENTS.md` → review checklist
- Redaction tests

### New dependency or tooling change

- `package.json` and `package-lock.json` committed together
- `CLAUDE.md` → Commands, if a new command exists
- `.github/workflows/quality.yml`, if CI must run it

## Source-Of-Truth Rules

- `CLAUDE.md` is canonical for implementation guidance. `AGENTS.md` summarizes
  it; when they disagree, `CLAUDE.md` wins and `AGENTS.md` is the bug.
- `docs/ARCHITECTURE.md` is canonical for system shape.
- `.env.example` is canonical for the full variable list; `README.md` and
  `CLAUDE.md` carry summaries.
- `docs/HACKATHON_BRIEF.md` is canonical for challenge requirements. The
  `hackathon-v2-*.xml` files and `HACKATHON_EXTENSION_GUIDE.md` are superseded
  drafts and are never edited by us.
