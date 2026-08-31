# ADR: Agent Tool Delegation Narrows Owner Authority

- **Date:** 2026-08-31
- **Status:** Accepted
- **Deciders:** Team (hackathon)

## Context

The gateway currently treats every Agent owned by one human identically. An
admin-owned research Agent therefore inherits `payments` even when its job only
needs the model, documents, and search. That is excessive authority for an
autonomous actor: a prompt injection against one narrowly intended Agent gains
every tool its owner could use.

The run JWT cannot solve this safely. It identifies a Run and Agent, but putting
permissions in it would make a grant change wait for token expiry. The gateway
already resolves the Agent and owner from the store on every call
(`resolvePrincipal` in [gateway.ts](../../apps/server/src/gateway.ts));
`Agent.toolGrants` in [types.ts](../../apps/server/src/types.ts) can cross that
existing boundary.

Constraints: preserve legacy Agents and the baseline, keep authorization in one
pure `can()` entry point, retain live mid-run policy changes, and add no new
service or credential.

## Decision

Each Agent stores `toolGrants: ToolName[] | null`. `null` means inherit its
owner's role; an array is an explicit Agent-specific ceiling, and `[]` grants
nothing. Effective access is the intersection of the owner's current role and
the Agent's current grants, followed by resource visibility and model budget.

- **Boundary:** `can()` in [authz.ts](../../apps/server/src/authz.ts) decides;
  `gateway.ts` resolves both policy inputs from the store on every model or tool
  call.
- **Data crossing it:** the resolved `Principal` carries owner `role` and Agent
  `toolGrants`. Neither is carried in the run JWT. Existing Agent create/update
  routes accept the field through `createAgent` and `updateAgent` in
  [agent-service.ts](../../apps/server/src/agent-service.ts), and the
  settings UI triggers those routes. The UI obtains its available choices from
  the server's `ROLE_TOOLS` projection on `GET /api/users`; it does not carry a
  second tool list, and therefore never offers a tool the selected owner role
  cannot delegate.
- **Failure mode:** fail closed. Unknown or malformed stored explicit grants
  migrate to `[]`; a tool omitted from the Agent grant returns `403`, produces
  one deny audit row, and is never forwarded. A missing field on a legacy Agent
  becomes `null` to preserve existing behavior.

## Consequences

### Positive

- Least privilege differs per Agent even when Agents share one owner.
- The owner role remains an upper bound, so an Agent grant cannot elevate a
  basic user to `payments` or rescue a suspended user.
- A grant-only update is allowed while a Run is active and affects its next
  gateway call without reissuing its credential.
- Existing Agents inherit their prior role-based behavior.

### Negative / Accepted trade-offs

- `null` and `[]` are intentionally different and must remain distinct in the
  API, persistence, and UI.
- The existing Agent settings endpoint now changes live security policy;
  operator-action audit remains out of POC scope.
- Grants are coarse tool names, not per-resource capabilities.

### Residual risk

- Browser identity is still mocked, so the shared demo token protects the
  settings route rather than a production identity system.
- A running Agent can lose `model` and fail its current Run on its next call;
  this is deliberate enforcement, not graceful draining.

## Alternatives Considered

### Put permissions in the run JWT

Rejected: permissions would become stale until expiry, defeating the existing
per-call role-change and revocation story.

### Replace roles with per-Agent grants

Rejected: it would let an Agent configuration become the sole source of
authority and duplicate the operator-owned role ceiling. Intersection preserves
both controls and cannot elevate.

### Add a separate policy service

Rejected: it adds network and consistency failure modes to a single-process
POC when `can()` and the existing store already provide the right seams.

## Verification

- **Normal case:** an admin-owned Agent delegated `model`, `docs`, and `search`
  uses those tools normally.
- **Denial case:** the same Agent calls `payments` and gets `403`; the tool is
  untouched and one audit denial names the missing delegation.
- **Live case:** add or remove `payments` while its Run is active; the same
  unexpired credential receives the new decision on its next call.
- **Upper-bound case:** a basic owner's Agent explicitly listing `payments` is
  still denied by the owner's role.
- **Automated tests:** authorization truth table, tolerant store migration,
  request validation/round-trip, busy-run grant update, and real gateway
  integration are covered in the server test suite.

## Follow-Up

- Per-resource grants, temporary grants, approval workflows, and custom roles
  remain out of scope.
- A production system needs authenticated control-plane identities and a
  separate audit stream for policy changes.
