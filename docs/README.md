# Documentation Index

This index defines which documents are current source of truth and what must be
updated when behavior changes.

## Current Operational Docs

| Doc                                      | Canonical for                                 |
| ---------------------------------------- | --------------------------------------------- |
| [../README.md](../README.md)             | Human quick start, setup SOP, config summary  |
| [../CLAUDE.md](../CLAUDE.md)             | Agent implementation guide, invariants, seams |
| [../AGENTS.md](../AGENTS.md)             | Condensed agent rules and review checklist    |
| [../SECURITY.md](../SECURITY.md)         | Security policy and accepted POC limitations  |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Contribution workflow                         |

## Architecture And Operations

| Doc                                                          | Canonical for                      |
| ------------------------------------------------------------ | ---------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md)                           | Component and extension boundaries |
| [DEPLOYMENT.md](DEPLOYMENT.md)                               | ECS and Terraform deployment       |
| [LOCAL_POC.md](LOCAL_POC.md)                                 | Docker, Colima, rootless Podman    |
| [HACKATHON_EXTENSION_GUIDE.md](HACKATHON_EXTENSION_GUIDE.md) | Organizer extension guidance       |

There is no root `ARCHITECTURE.md`; `docs/ARCHITECTURE.md` is the only
architecture document. Do not create a second one.

## Decisions And Designs

| Path             | Purpose                                               |
| ---------------- | ----------------------------------------------------- |
| [adr/](adr/)     | Architecture decision records — what we chose and why |
| [specs/](specs/) | Feature design specs — how a capability will be built |

The ADR recording our middleware direction is a **scored artifact**: the rubric
allocates 25% to "clear rationale, coherent architecture, appropriate
boundary," and the deliverables require "the middleware problem and rationale,
design summary."

## Reference Material

`hackathon-v2-section-*.xml` and `hackathon-v2-skeleton.xml` are the organizers'
challenge brief, exported from Feishu. They are **read-only reference**: do not
edit or reformat them. Prettier is configured to ignore them.

`assets/` holds README screenshots.

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
- The `hackathon-v2-*.xml` files are canonical for challenge requirements and
  are never edited by us.
