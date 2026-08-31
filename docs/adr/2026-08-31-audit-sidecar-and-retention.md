# ADR: The Audit Trail Leaves the Database — Append-Only Sidecar and Retention

- **Date:** 2026-08-31
- **Status:** Accepted
- **Deciders:** Team (hackathon)

## Context

The Agent-specific problem: gateway decisions are not logs. They are evidence,
and invariant #11 requires each one to be persisted **before** the agent is
answered — on the allow path, a store that cannot accept the record stops the
call. That contract is what makes the audit trail worth reading: an agent never
learns the outcome of a call the store has not already recorded.

The cost of honoring it landed in the wrong place. `AuditRecord[]` was a
collection inside `Database`, and `JsonStore` persists by cloning the database,
stringifying it whole, and atomically replacing the file. So filing one decision
rewrote every Agent, message, Run, session, user, and document — plus every
audit record already filed. Authorizing a single tool call cost the whole
accumulated history, and it cost it **synchronously, in front of the agent**,
because that is exactly what the invariant demands. Worse, the cost grew with
use: this is the highest-frequency write in the system, one per gateway decision
in a loop an autonomous actor drives, and each record made the next record more
expensive. A demo run that exercises the gateway hard is the run where the
evidence path is slowest.

The same collection was also the only unbounded one in the store. Agents,
messages, and Runs grow with human action; decisions grow with agent action,
which has no comparable brake. Nothing evicted anything, so the file grew until
the disk or the JSON parser objected.

Constraints: three days; the baseline keeps working; local container Runtime is
the judged path; a single-process JSON store, which is the whole persistence
budget; and invariant #11 is frozen — any fix that relaxes
written-before-the-answer is not a fix.

## Decision

Audit records move out of `db.json` into an **append-only JSONL sidecar** beside
it, written one line per decision, and the trail becomes a **rolling window**
bounded by `AUDIT_RETENTION_LIMIT` (default `1000`, floor `10`).

Specifics:

- **Boundary:** the execution data model — `JsonStore`'s persistence seam in
  [store.ts](../../apps/server/src/store.ts), the fourth extension seam. Nothing
  above it moves: `AuditLog` is still the only writer of a record,
  `AgentService.appendAuditRecord` is still what the gateway awaits, and
  `store.snapshot().audit` still answers `GET /api/runs/:id/audit` and
  `GET /api/operator/audit`. What changed is where the bytes go — the seam
  absorbed it, which is the point of having one. The sidecar's path is
  **derived** from the database's (`auditFilePath`), never configured: an
  evidence file that can be pointed away from the database it belongs to is a
  way to lose evidence.
- **Data crossing it:** one redacted `AuditRecord` per decision — the acting
  human, Agent, and Run, the tool, the `resource` identifier, the allow/deny
  outcome, and the reason — serialized as a single JSON line and appended, mode
  `0600`. Redaction is unchanged and still happens in `audit.ts` on the way in;
  no request or response body reaches the sidecar any more than it reached the
  database. Nothing comes back.
- **Failure mode:** fails closed, identically to before. The append runs on the
  store's own write queue (not beside it — `mutate` clones, mutates, and swaps,
  so a push landing between the clone and the swap would vanish without trace,
  the one outcome an evidence trail may never have), happens **before** the
  in-memory push, is awaited before the gateway answers, and rejects on failure.
  An allowed call whose record did not land is still stopped; a denial whose
  record did not land still stands. Compaction is awaited inside the same queued
  operation rather than detached, so no reader catches the file mid-rewrite and
  no failure hides in a floating promise.

Retention is deliberately scoped to _keeping_, not _writing_: every decision is
still recorded before the answer, and the window only decides how far back the
record survives. Eviction is oldest-first, in memory on append and on disk by
compaction once the file outgrows the limit by `AUDIT_COMPACTION_FACTOR` — the
file is append-only, so compacting on every append would trade away the whole
point of the sidecar for tidiness.

## Consequences

### Positive

- **The evidence write is O(1) again.** One `appendFile` of one line, whatever
  the trail already holds. The synchronous cost sitting in front of every agent
  call no longer grows with the number of calls already made, which is what made
  the invariant expensive precisely under the load a demo produces.
- **`db.json` stops churning.** `persist()` names its collections field by field
  and omits `audit` entirely, so the database is rewritten only when Agent,
  message, Run, session, user, or document state actually changes. Naming them
  rather than spreading-minus-audit also means a collection added later is a
  deliberate line, not a silent passenger.
- **Growth is bounded without a new subsystem.** A count-based cap with a floor
  of ten needs no scheduler, no background job, and no second process — the same
  budget a single-process JSON store already had.
- **Old files upgrade themselves.** A `db.json` carrying a legacy `audit` array
  migrates into the sidecar at boot: legacy records first (they predate anything
  the sidecar holds), one atomic rewrite, idempotent across restarts because
  `persist()` then drops the key. Boot is also where a file that outgrew the cap
  in an earlier process is brought back under it.
- **A crash costs at most one record.** A torn final line is skipped at load
  rather than fatal, because refusing to start over a half-written record would
  trade every surviving record for the one that did not survive.

### Negative / Accepted trade-offs

- **Evidence is now a rolling window.** Past `AUDIT_RETENTION_LIMIT`, the oldest
  decisions are gone, and there is no export or archive to catch them.
  Accepted: the alternative is an unbounded file, and oldest-first is the right
  eviction order because the decision an operator is asked about is nearly
  always a recent one. Recorded in [../../SECURITY.md](../../SECURITY.md).
- **The store is two files where it was one.** They can in principle diverge —
  a sidecar restored from a different backup than its database, say. Accepted
  and mitigated by shape rather than by machinery: audit records reference Runs
  by id and carry no cross-file invariant, so a stale sidecar produces records
  naming Runs the database does not have, which is legible as a mismatch rather
  than a corrupt store. The derived path keeps the two together in the ordinary
  case.
- **Compaction is a rewrite, just a rare one.** Crossing the file threshold
  costs a write of the retained window plus a rename, awaited in front of an
  agent call like any other evidence write. Accepted: it happens once every
  `AUDIT_COMPACTION_FACTOR × limit` appends and is bounded by the limit, not by
  history — the amortized cost is a small fraction of a line per decision, and
  the worst case is bounded where the old design's worst case was not.
- **The in-memory `audit` array is no longer the file.** Reads answer from a
  trimmed window while the sidecar may briefly hold more lines than that.
  Accepted: the window is the contract the API documents, and boot reconciles
  the two.

### Residual risk

- **Nothing signs the sidecar.** Anyone with write access to the data directory
  can edit or truncate it undetected. Out of POC scope; a real deployment needs
  integrity protection the writing process cannot forge.
- **Retention is counted, not timed.** "The last 1000 decisions" is a different
  guarantee from "the last 90 days," and a busy agent can burn the window in
  minutes. A real audit requirement is expressed in time.
- **Still single-process.** Two writers would corrupt the sidecar exactly as
  they would corrupt `db.json`; the append is serialized by one in-process
  queue, not by the filesystem.

## Alternatives Considered

### A retention cap alone, with records left inside `db.json`

The smaller change: keep the collection where it is, evict oldest-first past a
limit. Rejected as a half-fix. It bounds growth, which was the second problem,
and does nothing about the first: every decision would still rewrite the entire
database — agents, messages, Runs, sessions, users, documents, and the whole
retained window — synchronously in front of the agent. It would also cap the
per-decision cost at "the limit" rather than removing it, which reads as tuning
a constant instead of fixing the shape.

### Asynchronous or debounced audit writes

The cheapest latency fix available: return to the agent immediately and flush
records in the background, or batch them on a timer. Dead on arrival. Invariant
#11's write-before-the-answer is load-bearing — it is what lets an operator
trust that the trail is never behind what the agent already knows, and what
makes an unrecorded allow stop the call — and `gateway.test.ts` and
`audit.test.ts` assert it. Buying speed by making the evidence eventually
consistent with what the agent was told would give up the property the audit
trail exists to provide, and would do it invisibly: the failure only shows up
after a crash, in the records that are missing.

### An external log store (SQLite, a log shipper, a hosted sink)

The right answer for a real deployment and the wrong one here. It adds a
dependency, a schema, a failure mode, and an operational surface to a
single-process POC whose entire persistence budget is one JSON file, and the
judged path is `npm run poc` on a laptop. The problem — one hot append-only
stream with a bound — is solved by an append-only file; reaching for a database
to get an append is out of proportion. The seam stays where a real store would
slot in later.

## Verification

- **Normal case:** three decisions appended land as three lines in the sidecar
  while `db.json`'s bytes are unchanged, and a new `JsonStore` over the same
  paths reads them back in order.
- **Migration case:** a database written with an `audit` array boots into a
  store whose records are the legacy ones first, then the sidecar's; the array
  is gone from `db.json` afterwards and a second boot files no duplicates.
- **Recovery case:** a sidecar whose final line was truncated mid-write loads
  every intact record and skips the torn one, rather than refusing to start.
- **Retention case:** past the limit, the newest records survive and the oldest
  are evicted; a file that outgrew the limit in an earlier process is trimmed at
  the next boot; the sidecar compacts once it passes the file threshold; the
  limit applies to migrated records too.
- **Contract preserved:** the gateway still awaits the record before answering
  and a failed append still rejects, so an allowed call whose evidence did not
  land is stopped — the existing `gateway.test.ts` and `audit.test.ts`
  assertions cover this unchanged, which is the point.
- **Automated tests:** the `Audit sidecar` and `Audit retention` suites in
  `apps/server/src/store.test.ts`, including a concurrency case asserting that
  interleaved appends and mutations lose neither, plus the
  `AUDIT_RETENTION_LIMIT` coercion, floor, and default cases in
  `apps/server/src/config.test.ts`.

## Follow-Up

- Time-based retention, or a size budget in bytes, if this ever leaves POC
  scope. Count-based is the cheapest bound, not the right one.
- An export endpoint so an operator can take the window before it rolls; without
  one, retention is also deletion.
- Integrity protection for the sidecar — a chained hash or an append-only medium
  — so a trail that names humans and denials cannot be quietly rewritten.
