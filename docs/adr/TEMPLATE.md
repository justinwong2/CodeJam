# ADR: <Decision Title>

- **Date:** YYYY-MM-DD
- **Status:** Proposed | Accepted | Superseded by [ADR](./YYYY-MM-DD-other.md)
- **Deciders:** <names>

## Context

What problem forced a decision? For middleware work, name the **Agent-specific**
problem — something that only matters because an autonomous actor is executing
code, not a generic web-app concern.

State the constraints that narrowed the options: three days, the baseline must
keep working, local container Runtime is the judged path, single-process JSON
store.

## Decision

What we are doing, stated in one or two sentences.

Then the specifics:

- **Boundary:** which component owns the decision or event?
- **Data crossing it:** what is passed in, what comes back?
- **Failure mode:** what happens when this middleware itself fails — does it
  fail open or closed, and why is that the right choice here?

## Consequences

### Positive

- What this buys us.

### Negative / Accepted trade-offs

- What we gave up. Be honest — an unacknowledged trade-off reads as an
  oversight, an acknowledged one reads as judgment.

### Residual risk

- What remains unsolved and would need addressing beyond a POC.

## Alternatives Considered

### <Alternative A>

Why not. This section is usually the first thing a reviewer asks about.

### <Alternative B>

Why not.

## Verification

How we prove this works:

- Normal case:
- Failure / denial / degraded / recovery case:
- Automated test covering the behavior:

## Follow-Up

- Open questions and deferred work.
