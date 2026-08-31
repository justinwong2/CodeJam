# Slice 9: Token budgets

**Source spec:** [../specs/2026-08-27-agent-access-gateway-design.md](../specs/2026-08-27-agent-access-gateway-design.md) — the **A7** amendment is the contract for this work
**Source ADR:** [../adr/2026-08-27-agent-access-gateway.md](../adr/2026-08-27-agent-access-gateway.md) — its Follow-Up labelled this a deferred extension hook; this is that hook, built
**Domain language:** [/CONTEXT.md](../../CONTEXT.md) — Budget, Settled / in-flight spend
**Date:** 2026-08-31
**Branch:** feat/gateway-budget

One slice, vertical: server enforcement, the operator's lever, and the console
control, demoable alone. It follows slices 1–8 and depends on all of them —
the ceiling is checked at the chokepoint slice 1 built, after the `can()` slice
3 wrote, recorded through the writer slice 5 fixed, and adjusted from the
console slice 7 added.

Decisions already made (do not re-litigate — recorded in CONTEXT.md and the
spec's A7):

- **Tokens, not calls.** A call carrying a full context and one carrying a
  sentence are not the same spend.
- **Per-owner, not per-agent.** An owner-allocated ceiling bounds only an owner
  who chooses to be bound; the ceiling that matters is the one its subject
  cannot raise. `tokenBudget` is on no owner-facing route.
- **Checked before the spend.** "Would this take them over?", never "have they
  already gone over?" — so a refused call is charged nothing.
- **`402`, not `403`.** Contract 1 reserved it. "They cannot afford to" is a
  different fact from "they may not", and the budget check runs _after_ `can()`
  so the coarser failure names itself first.
- **Two ledgers, labelled.** Settled spend is exact, from completed Runs'
  `usage`. In-flight spend is estimated from request size. They are never
  presented as the same number.
- **The two ledgers read differently, and only measurement settled which way**
  (found by running it, not in review). Calls within a Run add up — a ten-call
  Run cost ~50,000 tokens against a largest single call of ~5,000 — so
  in-flight spend sums them. Runs of an Agent do _not_ add up, because
  `RunUsage` is cumulative for the resumed thread, so settled spend takes the
  latest figure. A settled figure supersedes the estimate for its Run, or the
  same tokens are charged twice. Codex
  resumes the thread each turn and reports the conversation's whole total, so
  settled spend is an Agent's _latest_ figure, never a sum over its Runs.
  `cachedInputTokens` is excluded for the same reason: a subset of
  `inputTokens`, not a bucket beside it.
- **The in-flight meter is memory, not store.** Working state, not evidence —
  and the startup sweep already revokes interrupted Runs' sessions, so a meter
  cannot outlive what it counts.
- **`0` is unlimited, and is what a pre-budget user migrates to.** A ceiling
  nobody set must not strand an existing demo's Agents.
- **The count rides in the allow record's reason.** Still one record per
  decision; the running total is a property of the decision, not a second row.
- **Reset is a watermark, and clears both ledgers.** `budgetResetAt` stops
  counting settled Runs; the route clears the owner's in-flight meters beside
  it. Deleting Runs to move a number would destroy history to save arithmetic.

## What was built

**Server**

- `budget.ts` (new) — `withinBudget(spend, budget)` and `estimateTokens(bytes)`,
  pure and synchronous like `can()`, with the bytes-per-token ratio named as an
  assumption in one place.
- `types.ts` — `User.tokenBudget` and `User.budgetResetAt`;
  `GatewayDirectory.sumOwnerTokens(ownerId)`.
- `store.ts` — seeded budgets (5,000,000: high enough that no ordinary demo Run
  meets one), and a loader that defaults a missing or nonsensical value to
  unlimited.
- `agent-service.ts` — `sumOwnerTokens` over the owner's Agents' completed Runs,
  filtered by the watermark; `setUserRole` generalized to
  `updateUser({ role?, tokenBudget?, resetSpend? })`.
- `app.ts` — `updateUserBody` widened to
  `{ role?, tokenBudget?, resetSpend? }`, at least one required; a fractional or
  negative budget is a `400`, and `resetSpend` is the literal `true` only. The
  route clears the owner's in-flight meters after a reset write.
- `gateway.ts` — the in-memory per-Run meter (pruned by session TTL on read),
  the check between `can()` and the allow record, `deny()` given an optional
  status so `402` files one record through the same path, the running total
  appended to the allow reason, and `clearOwnerMeters()` for the reset.

**Web** (display and trigger only)

- `types.ts` mirrors both new fields; `api.ts` gains `setUserTokenBudget` and
  `resetUserSpend`; `App.tsx` puts a number input and a Reset-spend button
  beside the role dropdown. The input commits on blur, because each change is a
  store write the next gateway call reads.

## Acceptance criteria

- [x] A model call is refused `402` when the owner's ceiling is used up, **and
      the upstream is never called**
- [x] A Run spending right now is stopped mid-Run, with settled spend at zero
      throughout — the failure a completed-Runs-only ceiling cannot catch
- [x] A refused call is charged nothing: raising the ceiling by one call's worth
      admits exactly one more
- [x] Exactly one audit `deny` row per refusal, carrying the budget reason; the
      allow rows carry the running total
- [x] A raised or lowered ceiling lands on the next gateway call — no restart,
      no token event
- [x] One owner's spend is not held against another's ceiling
- [x] `0` forwards without limit; a suspended owner is refused by role (`403`),
      not by budget
- [x] `PATCH /api/users/:id` sets a budget, rejects a fractional/negative one,
      `404`s an unknown user, and rejects a body naming neither field
- [x] A user stored before budgets existed loads as unlimited and round-trips
- [x] Docs: spec A7, ADR Follow-Up marked shipped, CONTEXT.md language,
      CLAUDE.md/AGENTS.md tables + invariant 14, SECURITY.md, ARCHITECTURE.md
- [x] Resetting spend forgets settled Runs **and** what a Run in flight had
      spent, for that owner only, without touching the ceiling or the role —
      and the Runs and their usage survive intact
- [x] `resetSpend` accepts only the literal `true`; the server sets the moment
- [x] A thread's total counts once, not once per turn; each Agent's thread is
      counted separately; cached input tokens are not double-counted
- [x] `GET /api/operator/spend` reports settled and in-flight separately, and
      agrees with what the ceiling enforces
- [x] `npm run check` passes — 259 tests

## Demo

1. `npm run poc`; open the Operator Console.
2. Lower User B's token budget to something small (~50,000).
3. Send B's Agent a task needing several turns.
4. The Run is cut off. The evidence panel shows allow rows with the total
   climbing, then the `402` deny row naming the ceiling.
5. Hit **Reset spend** and re-send — the next call is forwarded, with no restart
   and the ceiling unchanged. The same "operator pulls a lever, the next call
   reflects it" beat as roles and revocation.

## Deliberately not built

Cost in currency rather than tokens; per-tool budgets; per-agent allocation;
recurring budget periods (a reset is an operator action, not a schedule); a
dedicated budget view beyond the decision feed; any change to the streaming
passthrough.
