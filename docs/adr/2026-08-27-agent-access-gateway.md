# ADR: Agent Access Gateway

- **Date:** 2026-08-27
- **Status:** Proposed
- **Deciders:** Team (hackathon)

## Context

The Agent-specific problem: in this platform an autonomous actor (Codex)
executes arbitrary shell commands inside a container, and that container is
handed the platform's real model credential. Today the runner launches the
Codex container with `--env ARK_API_KEY` ([container-codex-runner.ts:74-75](../../apps/server/src/container-codex-runner.ts))
on a `--network bridge` container ([container-codex-runner.ts:60](../../apps/server/src/container-codex-runner.ts)).
Because the agent is _designed_ to run commands and reach the network, any task
— including a prompt-injected one — can read `ARK_API_KEY` from the environment
and exfiltrate it. This is not a bug to patch; it is the direct consequence of
the credential living _inside the agent's blast radius_. The existing test
proves the key never reaches **argv**, but it sits one `printenv` away in
**env**.

A second, related Agent-specific gap: the platform has no notion of _who_ an
agent is acting for, or _what_ it is allowed to touch. The repo is a
single-user POC with no `ownerId` on `Agent` ([types.ts:6-17](../../apps/server/src/types.ts)),
no human/agent principal distinction, and no server-side authorization. Access
control, if any, would be UI-only — which the brief explicitly says "scores
nothing and is trivially bypassed."

Constraints that narrowed the options: three days; the baseline (CRUD,
lifecycle, Playground, Codex execution) must keep working; the local container
Runtime is the judged path; the JSON store is single-process; middleware must
execute server-side; no secret may appear in source, logs, traces, or demo
output.

## Decision

We introduce an **Agent Access Gateway**: a platform-owned HTTP chokepoint that
every agent call — to the model _and_ to tools — is routed through. The gateway
authenticates the agent, authorizes the action against its owner's role,
injects the real upstream credential from a server-side vault, and records the
decision. The agent holds **zero** real credentials and knows exactly **one**
endpoint.

The four capabilities this enables — identity, authorization, credential
injection, and audit — are not separate builds. They are consequences of
forcing all agent traffic through one boundary. This is a hackathon-scale slice
of what AWS Bedrock AgentCore productizes as its Gateway and Identity services.

Specifics:

- **Boundary.** The gateway is a set of routes on the existing Fastify server
  (the request boundary seam), not a separate process — it shares the
  single-process store, config, and credential vault. Codex is repointed at it
  by changing one line of generated config: `base_url` in `writeCodexConfig`
  ([config.ts:114-133](../../apps/server/src/config.ts)) moves from Ark to the
  gateway, and `env_key` becomes a per-run JWT instead of `ARK_API_KEY`.
- **Data crossing it.** _In:_ an agent call bearing a per-run JWT
  (`{agentId, ownerId, runId, exp}`), a tool/resource target, and the request
  body. _Out:_ either the forwarded upstream response (model tokens or tool
  result), or a `401/403/402` denial. _Persisted:_ a redacted audit record per
  decision `{ts, humanId, agentId, runId, tool, resource, decision, reason}`.
- **Failure mode.** The gateway **fails closed**. If the JWT is missing,
  invalid, expired, or revoked; if the role lookup fails; or if the vault has no
  credential for the upstream — the call is denied, not forwarded. A gateway
  that fails open would hand back the very credential-exposure and
  unauthorized-access properties it exists to remove, so closed is the only
  defensible default for a security boundary. The consequence — if the gateway
  is down, agents cannot run — is acceptable because the gateway is in-process
  with the control plane that orchestrates runs anyway.

## Consequences

### Positive

- **The Ark key leaves the container entirely.** The strongest possible form of
  invariant #4: not "the key is redacted" but "there is no key to steal." The
  exfiltration task returns nothing.
- **Authorization is enforced at a trusted backend boundary**, exactly as the
  brief requires — tool-level RBAC and resource-level ownership, both
  server-side, both bypass-resistant because the agent can only reach upstreams
  _through_ the gateway.
- **Revocation is real and immediate.** A revoked agent's _next_ gateway call
  fails, mid-session, because the revoked-set is checked per call.
- **Audit and observability come nearly for free.** Every decision crosses one
  point, so recording who-did-what-to-what is a side effect, not a separate
  system. Token metering feeds the same records.
- **Coherent, extensible contract.** Two frozen contracts (the HTTP proxy shape
  and `can(principal, tool, resource?)`) let the capability extend to new
  upstreams, new roles, or per-resource grants without touching callers — the
  "extensible contracts" the 25% category rewards.
- **Parallelizes cleanly** across a 5-person team behind those two contracts.

### Negative / Accepted trade-offs

- **The gateway is a single point of failure and a latency hop.** Every model
  call now traverses an in-process proxy. Accepted: it is in-process with the
  orchestrator, and the POC is single-process anyway.
- **The proxy must faithfully pass through the Responses API, including SSE
  streaming.** This is real implementation risk (see Residual risk) and the
  main thing that can eat time.
- **Container-to-host reachability is engine-specific.** `host.docker.internal`
  differs across Docker Desktop, Podman, and Colima/Linux, requiring a small
  compat shim in the runner.
- **Permissions are looked up server-side on every call**, not carried in the
  token. Accepted deliberately: it makes revocation and permission changes
  instant, which matters more at hackathon scale than statelessness.
- **Authentication is mocked** (seeded users + dev switcher). Accepted: the
  brief scores authorization, not authentication, and says a mock identity
  model is acceptable.

### Residual risk

- **SSE / streaming passthrough** is the highest-risk unknown. If Codex streams
  from the Responses API, the gateway must stream chunks through, not
  buffer-and-break. This must be de-risked on day 1 with a trivial passthrough
  gateway before the team forks off.
- **The container is not a hardened boundary.** The gateway removes the
  credential but does not make the container a multi-tenant isolation boundary;
  that remains a documented POC limitation.
- **Budget enforcement is not built** — only metering. A runaway run is not
  hard-stopped at a cap in the core scope (see Follow-Up).

## Alternatives Considered

### Redact / lock down the key in place (keep the direct-to-Ark path)

Keep Codex calling Ark directly but try to prevent exfiltration — e.g. drop the
key from env after start, or restrict the container network. Rejected: as long
as the agent needs the key to call the model, the key must be reachable when the
model is called, so it is reachable to exfiltration. Half-measures ("redact it
from logs") do not change that the live credential is inside the agent's blast
radius. Moving the credential out is the only structural fix.

### UI-only or AgentService-only authorization (no gateway)

Enforce ownership/role checks in the control-plane API or UI without a routing
chokepoint for the agent's own outbound calls. Rejected: it does not solve
credential exposure at all, and it only governs calls the _human_ makes through
the platform — not the calls the _agent_ makes to the model and tools, which is
where the autonomous-actor risk actually lives.

### Token-carried permissions (stateless JWT scopes)

Bake the permission scopes into a signed JWT and let the gateway authorize
without a lookup. Rejected as the permission mechanism: a self-contained token
is valid until expiry, so revocation and permission changes require a
server-side blocklist anyway — which discards the statelessness benefit while
fighting the revocation demo. We keep the JWT for tamper-proof _identity_ claims
and look permissions up server-side.

### Full trace/observability platform (the "Glass Box" direction)

Build a span tree / timeline as the primary capability. Rejected as the spine:
it is a large UI build that competes with enforcement for time and has a weaker
failure-case story (diagnostic, not a denial). We keep a lightweight audit log

- Run evidence panel as the "record" half of the gateway story instead.

## Verification

- **Normal case:** an agent owned by User A (role `admin`) runs a task; the
  gateway forwards its model calls to Ark with an injected key and lets it use
  `docs`, `search`, and `payments`. The Run completes; the evidence panel shows
  the calls and token usage.
- **Failure / denial cases:**
  - _Credential exfiltration:_ a task instructing the agent to print/exfiltrate
    `ARK_API_KEY` returns nothing, because it is not in the container.
  - _Tool-RBAC denial:_ User B (role `basic`) calls `payments` → `403` at the
    gateway; upstream never touched; audit record written.
  - _Ownership denial:_ User A's agent reads User B's document → `403`; B's
    record unchanged.
  - _Revocation:_ an agent is revoked mid-session; its next gateway call → `403`.
- **Automated tests covering the behavior:**
  - Unit: `buildContainerRunArgs` produces no `ARK_API_KEY` env flag and no
    value equal to the configured key (extends the existing argv test).
  - Unit: `can(principal, tool, resource?)` allow/deny truth table for the
    seeded roles and ownership rule.
  - Integration: gateway handler denies an invalid/expired/revoked JWT with no
    upstream call (Ark fetch mocked); denies a disallowed tool; denies a
    non-owned resource.
  - Integration: an audit record is written for each decision and redacts
    sensitive values.

## Follow-Up

- **Budget enforcement (stretch).** Metering is in scope; a hard-stop at a
  token/cost cap is a labeled extension hook, built on day 3 only if the core is
  airtight.
- **Temporary / assumed roles (deferred).** Time-bound elevated roles map to the
  brief's "scoped, time-bound, revocable" language and would be the natural next
  extension; out of scope for the three-day build.
- **Custom-role authoring (deferred).** Prebuilt roles are seeded; a
  custom-role editor is out of scope. The role → permission-set contract is
  designed to accommodate it later.
- **Per-resource grant records (deferred).** The `can()` contract generalizes
  from role-based tool lists to `(principal, tool, resource, scope)` grants
  without changing callers.
