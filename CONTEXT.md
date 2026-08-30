# Agent Access Gateway

The middleware layer of Volc Agent Launchpad: a server-side chokepoint that
authenticates every agent call, authorizes it against the owner's live role,
injects real credentials, and records one redacted audit record per decision.

## Language

**Gateway**:
The platform-owned HTTP boundary every agent call crosses; the only holder of
real upstream credentials.
_Avoid_: proxy (alone), middleware layer

**Principal**:
The identity a gateway call acts as — always the human owner's authority,
resolved from the store per call, never from token claims.
_Avoid_: user (when the agent's acting identity is meant)

**Owner**:
The human a resource or Agent belongs to; the ownership key `can()` compares.
_Avoid_: creator, author

**Document**:
A small text resource in the mock tool service (`MockDoc`), owned by one user;
the thing an ownership decision protects.
_Avoid_: file, doc entry, corpus entry

**Visibility**:
A Document field — `"public" | "private"` — deciding who besides the Owner may
read it. Public documents still have exactly one Owner; visibility never
transfers ownership. Missing values load as `private`.
_Avoid_: workspace (implies containers and membership, which are out of scope)

**Invisible**:
The required behavior of a Document toward a principal who may not read it:
absent from search and listings, and a direct fetch by id returns the same
"not found" a nonexistent id would. Existence itself is not disclosed.
_Avoid_: hidden, denied (a denial discloses existence; invisibility does not)

**Scope**:
The authorized boundary of a search, decided by the Gateway (the Principal's
owner id) and passed to the tool in a header beside the tool credential. The
tool applies it as a mechanical predicate — `owned by scope OR public` — and
refuses the call if the header is absent. The predicate lives once, in
`authz.ts`, imported by both the gateway and the tool.
_Avoid_: filter (the tool filters; the gateway scopes — the decision is the gateway's)

**Upload**:
Create-only addition of a Document by a human in the browser: small text
content plus a Visibility chosen at creation and immutable after. The Owner is
always the acting `x-launchpad-user`, resolved server-side — never taken from
the request body. No edit, delete, or visibility toggle.

**Operator Console**:
The browser surface for the demo operator: decision feed, ground-truth
document table (metadata only — id, title, owner, visibility, never content),
session table (claims only — `jti`, agent, owner, run, issued, expires,
revoked; the raw JWT string never renders anywhere), revocation and role
controls. Display-and-trigger only; it decides nothing (invariant #8) and sits
outside the role system — it is not gated by the `admin` role.
_Avoid_: admin console, admin page (collides with the `admin` role)

**Suspended**:
The third seeded role, granting no tools at all — including `model`. A
suspended Owner's agents are refused every gateway call on the next lookup,
while their run credential stays valid and unrevoked: the JWT is identity,
never permission, so suspension is a store write, not a token event.
_Avoid_: no-access, disabled, revoked (session revocation is a different lever)

**Denial**:
A gateway decision refusing a call. What the _agent_ is told and what the
_audit_ records are deliberately allowed to differ: the audit always carries
the true reason; the agent-facing response never discloses the existence or
owner of a Document the principal cannot read.

## Relationships

- A **Document** has exactly one **Owner**; **Visibility** never transfers
  ownership
- The **Gateway** resolves a **Principal** per call from the Agent's current
  **Owner** — every tool, the model included
- An ownership **Denial** on a Document is _invisible_ to the agent (404) but a
  true `deny` in the audit
- A **Suspended** Owner's agents keep valid credentials and pass no `can()`
  check — suspension is a store write, revocation is a session write; the
  **Operator Console** triggers both and decides neither

## Example dialogue

> **Dev:** "User B's agent fetched `doc-a1` and got a 403 — should the body say
> it's owned by user-a?"
> **Domain expert:** "No — B shouldn't learn `doc-a1` exists at all. The agent
> gets the same 404 a made-up id would get. The audit row is where the truth
> lives: `deny / ownership`, full reason."

## Flagged ambiguities

- "admin" is overloaded — resolved 2026-08-30: the `admin` **role** is a policy
  fact (which tools an owner's agents may call); the operator surface in the
  browser is the **Operator Console** and is not gated by any role (mock auth
  makes role-gating it theater). Use "operator" for the surface, "admin" only
  for the role.
- "god mode" — resolved 2026-08-30: no all-seeing flag on the user-plane
  document listing (it stays strictly `visibleTo`-scoped). The Operator
  Console's metadata-only document table is the ground-truth view; it exists
  because scoped search leaves no audit trace of filtered-out rows, so proving
  filtering requires showing ground truth beside the scoped result.
- "invisible" vs "denied" — resolved 2026-08-30: documents a principal cannot
  read are **invisible** (404 on direct fetch, absent from search/listings),
  not merely denied. The audit record still says `deny` with the true reason.
  This amends frozen Contract 1 (was: 403 on ownership denial) — spec
  amendment required in `docs/specs/2026-08-27-agent-access-gateway-design.md`.
- "model calls need no tool-RBAC" (Contract 1) — resolved 2026-08-30: no longer
  true. The model proxy resolves the principal and runs `can(principal,
"model")` like every other tool, making `ROLE_TOOLS`'s `model` entry real
  policy instead of dead weight. Without this, a Suspended owner's agent could
  still burn model tokens. Second Contract 1 amendment; record with the first.
- Contract 2 (`can()`) — resolved 2026-08-30: ownership rule becomes "owned OR
  public" via `resource: { ownerId, visibility }`; the shared `visibleTo`
  predicate in `authz.ts` is the single home of that rule for both the gateway
  (direct fetch) and the tool service (search Scope). The now-wrong comment at
  `mock-tools.ts:41-44` must be replaced when `SEARCH_CORPUS` folds into
  seeded public Documents.
