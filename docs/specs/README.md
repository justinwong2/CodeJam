# Feature Design Specs

A spec describes **how** a capability will be built, before it is built. The
decision itself — and why — belongs in an [ADR](../adr/).

## Naming

```
docs/specs/YYYY-MM-DD-feature-name-design.md
```

## Rules

- Write the spec before implementation, not after. A spec written afterward is
  documentation; a spec written before is design.
- Set `Status` and keep it current: `Draft`, `Approved`, `Implemented`, or
  `Archived`.
- List the files expected to change. If that list is long or touches the
  baseline heavily, the design is probably too broad for three days.
- Include the testing plan. The rubric weights verification at 20%, and a
  design without a test plan usually ships without tests.
- Include what is explicitly **out of scope**. Scope creep is the main failure
  mode of a three-day build.

## Template

Copy [TEMPLATE.md](TEMPLATE.md) to start a new spec.

## Index

| Date       | Spec                                                                     | Status |
| ---------- | ------------------------------------------------------------------------ | ------ |
| 2026-08-27 | [Agent Access Gateway Design](2026-08-27-agent-access-gateway-design.md) | Approved |
