# Architecture Decision Records

An ADR records a decision that shapes future work: what we chose, why, and what
we accepted as a consequence. It is not an implementation plan — that belongs in
[../specs/](../specs/).

## Why these matter here

The hackathon rubric allocates **25%** to "a clear rationale, coherent
architecture, appropriate boundary, focused changes, and extensible contracts,"
and the required deliverables include "the middleware problem and rationale,
design summary."

An ADR is the artifact that demonstrates exactly that. Writing one is scored
work, not overhead.

## Naming

```
docs/adr/YYYY-MM-DD-short-decision-title.md
```

Date-prefixed so chronology sorts naturally. Lowercase, hyphenated.

## Rules

- Record the decision and its consequences, not the full implementation plan.
- Include alternatives considered. "Why not X" is often the most valuable part,
  and it is what a reviewer asks first.
- Never delete a superseded ADR. Set its status to `Superseded` and link
  forward to the one that replaced it.
- State consequences honestly, including the bad ones. Accepted trade-offs are
  a sign of engineering judgment; hidden ones read as oversights.

## Template

Copy [TEMPLATE.md](TEMPLATE.md) to start a new record.

## Index

| Date       | Decision | Status |
| ---------- | -------- | ------ |
| _none yet_ |          |        |
