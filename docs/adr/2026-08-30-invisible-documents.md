# ADR: Invisible Documents — Ownership Denials Answer "Not Found"

- **Date:** 2026-08-30
- **Status:** Accepted
- **Deciders:** Team (hackathon)

## Context

The Agent-specific problem: an autonomous actor — possibly acting on a
prompt-injected task — can probe the gateway's `docs` tool with guessed ids.
The seeded ids (`doc-a1`, `doc-b1`) are trivially enumerable, and slice 8 adds
user-uploaded documents with `public`/`private` visibility, which makes
_existence itself_ user data: knowing that `doc-b3` exists and belongs to
User B is a disclosure, even if its content never leaks.

Frozen Contract 1 answers an ownership denial with `403` carrying `can()`'s
reason — which names the resource's owner
([authz.ts:44](../../apps/server/src/authz.ts)). So an agent that can never
_read_ a foreign document can still _map_ the document space: enumerate ids,
collect 403s, and learn which documents exist and who owns each one. A generic
web app might accept that; a platform whose thesis is "the agent sees only what
its owner may see" cannot. The stated product requirement is stronger than
denial: a document the principal may not read must be **invisible** — absent
from search, absent from listings, and indistinguishable from nonexistent on a
direct fetch.

Constraints: three days; the baseline keeps working; Contract 1 is frozen, so
this change must be a recorded amendment, not silent drift; the audit trail
(invariant #11) must keep telling the operator the truth.

## Decision

An ownership denial on a direct document fetch returns the **same `404`
"Document not found"** — status and body byte-identical — that a nonexistent id
returns. The audit record written for that decision carries the **true**
reason (`deny` / ownership). The agent-facing answer and the audit record are
deliberately allowed to diverge: the agent learns nothing, the operator learns
everything.

Specifics:

- **Boundary:** the gateway, and only the gateway. `resolveResource` in
  [gateway.ts](../../apps/server/src/gateway.ts) already owns the
  unknown-id `404`; the ownership-denied case joins that same branch shape.
  Search invisibility rides the gateway-computed scope (spec amendment,
  2026-08-30): the tool service applies the shared `visibleTo` predicate
  mechanically and never learns why a row was excluded.
- **Data crossing it:** _out to the agent:_ `404 { error: "Document not
found" }`, indistinguishable across "never existed" and "exists, not
  yours." _Persisted:_ one audit record with the real ownership reason,
  written before the answer, as ever.
- **Failure mode:** fails closed twice over. The decision still happens
  gateway-side before any forward, so a denied call never reaches the tool;
  and because denied-and-nonexistent share one response shape, a bug in the
  denial path degrades to "document appears not to exist" — an availability
  failure, never a disclosure.

## Consequences

### Positive

- **No existence oracle.** Enumerating ids yields a uniform `404` wall; the
  agent cannot distinguish a wrong guess from a forbidden hit, so it cannot
  map other users' documents or learn owner identities from denial text.
- **"Invisible" is one property everywhere:** search, listings, and direct
  fetch all answer as if the document does not exist for that principal —
  no seam where the answers disagree.
- **The audit trail becomes the demo's legible surface.** The evidence panel
  shows `deny / ownership` with the full reason while the agent's transcript
  shows a bland 404 — which _is_ the story: the agent knows nothing, the
  operator knows everything.

### Negative / Accepted trade-offs

- **The gateway now tells the agent less than the truth.** A 404 for a
  document that exists is deliberate misdirection. Accepted: toward an
  untrusted autonomous caller, non-disclosure is the correct posture, and the
  truth is preserved where trust lives (the store, the audit, the operator).
- **Debugging requires the audit.** "Why is my agent getting 404s?" is no
  longer answerable from the response alone; the operator must read the
  evidence panel. Accepted: that panel exists precisely to be read.
- **A frozen contract is amended.** `403` on ownership denial was Contract 1
  text and is pinned by existing tests. The amendment is recorded in the spec
  (2026-08-30 section) and the tests move with it — the cost of doing it
  loudly, which is the only acceptable way.

### Residual risk

- **Timing side channels are not addressed.** A denied fetch does a store
  lookup and an audit write a nonexistent-id fetch also does; response-time
  uniformity is not engineered beyond that. Out of POC scope.
- **The predicate is the single point of truth.** If `visibleTo` in
  `authz.ts` ever drifts from what the tool applies, search could leak rows
  the direct-fetch path hides. Mitigated by having exactly one implementation
  imported by both callers — never a second copy.

## Alternatives Considered

### Keep the `403` with the ownership reason (status quo)

No contract amendment, and the agent's transcript self-documents the denial.
Rejected: it leaks existence _and_ owner identity to any caller that guesses
an id, which directly contradicts the requirement that unreadable documents be
invisible — and the leak grows with every user-uploaded document.

### `403` with a scrubbed, generic reason

Keep the status, redact the reason. Rejected: the status _is_ the leak — a
`403`/`404` distinction is a one-bit existence oracle, and one bit per guess
is all enumeration needs. Scrubbing the reason fixes the smaller half.

### Filter content but acknowledge existence (metadata-only answers)

Return id + "access restricted" without content. Rejected: this is the
existence oracle with extra steps, and it invents a third response shape the
contract never had.

## Verification

- **Normal case:** the owner fetches their own document → `200` with content;
  a public document fetched by anyone → `200`.
- **Denial case:** User B's agent fetches `doc-a1` (private to A) → response
  status and body identical to fetching `doc-zzz` (nonexistent); the audit
  rows differ — ownership reason vs. "Document not found."
- **Automated tests:** an integration test asserting byte-identical `404`
  responses across the denied and nonexistent cases, with divergent audit
  reasons; the existing no-upstream-call assertion extends to the denied
  fetch; search-scoping tests assert excluded rows leave no trace in the
  response while the ground-truth store still holds them.

## Follow-Up

- Response-time uniformity between the two 404 paths, if this ever leaves POC
  scope.
- A visibility _toggle_ (owner flips public ↔ private live) is deferred;
  uploads fix visibility at creation. If built later, the mid-run flip is a
  strong "permissions are read per call" demo.
- Sharing a document with a named user, groups, and wildcards remain out of
  scope per the slice-8 design discussion.
