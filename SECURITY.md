# Security policy

Volc Agent Launchpad is a hackathon proof of concept. Only the latest revision
on the default branch is supported.

## Report a vulnerability

Send the repository owner or event organizer the affected revision,
reproduction steps, impact, and suggested mitigation. Do not publish
credentials, personal data, or exploit details in an issue.

## Known limitations

- Shared demo token; no real user identity (the acting human is a seeded id the
  browser names) and no tenant isolation. Agent calls _are_ authorized: see the
  gateway entries below.
- No CSRF protection
- No per-Agent container boundary in ECS mode
- Ordinary local containers, not hardened multi-tenant sandboxes
- Broad outbound network access
- Prompt-triggered command and file execution
- Ark key held by the server process only; it is no longer passed into the
  Agent Runtime, so a prompt that asks an Agent to print `ARK_API_KEY` finds
  nothing to print. Codex reaches the model through the Agent Access Gateway
  (`POST /gateway/v1/responses`), which attaches the key on the way upstream.
- The gateway verifies a per-run credential before forwarding anything: a
  missing, forged, expired, or revoked token is answered with `401` and the
  upstream is never called. `/gateway/*` stays outside the `APP_AUTH_TOKEN`
  hook by design — agents authenticate as themselves, not as the browser
  operator. `GATEWAY_JWT_SECRET` signs those credentials, never leaves the
  server process, and is required at startup.
- Every agent call is authorized as well as authenticated — the model included.
  The gateway resolves the acting human from the Agent's current owner in the
  store — permissions are deliberately absent from the run credential — and
  applies `can()` before forwarding, so a role or ownership denial is a `403`
  and nothing downstream is reached. The `suspended` role grants no tools at
  all, so a suspended owner's Agents cannot call a tool or spend model tokens,
  while their run credentials stay signed, unexpired, and unrevoked: the
  credential is identity, never permission. The mock tool service accepts only
  calls carrying `GATEWAY_TOOL_CREDENTIAL`, which never leaves the server
  process, so the check cannot be walked around by calling the tool directly.
- Existence is treated as user data. A document an Agent's owner may not read is
  **invisible**, not merely refused: a direct fetch through the gateway answers
  the same `404 { error: "Document not found" }` — status and bytes — that a
  nonexistent id answers, so an Agent guessing ids cannot tell a wrong guess from
  a forbidden hit and cannot map another human's documents or learn who owns
  what. Search is scoped the same way: rows the caller may not see are absent
  rather than denied, and the tool service refuses a call that arrives without
  the gateway-computed scope header. The audit trail still records the true
  reason (`deny`, naming the owner), so the operator's view and the Agent's view
  deliberately differ — the Agent learns nothing, the operator learns
  everything. Not addressed: response-time uniformity between the two `404`
  paths, which is a timing side channel left out of POC scope.
- Documents uploaded from the browser are stored as-is, in the same JSON store,
  as a few KB of plain text with a visibility fixed at creation. The owner is the
  acting human resolved server-side — never a field of the request body — and
  there is no edit, delete, toggle, or sharing. Content is only ever returned to
  a principal `visibleTo` admits: it appears in no audit record, and in no
  operator view.
- A model call is refused when its owner has no token allowance left: `402`,
  one audit `deny` row, and no upstream request, so a runaway or prompt-injected
  Agent cannot spend without bound. The ceiling is `User.tokenBudget`, set only
  through `PATCH /api/users/:id` — it is on no owner-facing route, so an Agent's
  owner can spend their allowance but cannot raise it. What the ceiling is
  measured against is deliberately two different kinds of number: tokens
  reported by **completed** Runs are exact, while a Run still in flight is
  **estimated** from request size, because reading real per-call usage would
  mean parsing the response stream the gateway forwards untouched. The exact
  half is read per Agent rather than per Run: Codex reports usage cumulatively
  for a resumed thread, so an Agent's latest figure is its total and summing its
  Runs would count the same tokens once per turn. Consequences
  worth knowing: a Run whose usage never parsed counts as zero (fail-open, with
  the in-flight meter as the backstop); the in-flight meter is process memory,
  consistent with the single-process store; and tool calls are not budgeted at
  all, since the ceiling is about model tokens and `payments` amounts are a mock.
- Spend can be forgiven, but only by the operator. `PATCH /api/users/:id` with
  `resetSpend: true` marks `User.budgetResetAt` and clears that owner's
  in-flight meters, so their allowance starts over. It is a watermark, never a
  deletion — the Runs, their token usage, and their audit records are untouched,
  and the reset moment is chosen by the server rather than named by the caller.
  It changes what counts against the ceiling and nothing else: not the ceiling,
  not the role.
- Operator actions are not audited. `PATCH /api/users/:id` (assign a role, set a
  token budget, or reset spend) and `POST /api/agents/:id/revoke` leave no `AuditRecord`,
  because a record belongs to a Run and an operator action has none. Their effect is visible in the very
  next gateway decision, and in the Operator Console's session table, but there
  is no "who changed this role, and when". Accepted for POC scope; a real
  deployment needs a separate operator-action log, and neither endpoint is
  protected by anything stronger than the shared `APP_AUTH_TOKEN`.
- The Operator Console is not gated by the `admin` role. Role-gating it under
  mock authentication would be theater — the browser chooses which seeded human
  it claims to be. Everything it shows sits behind `APP_AUTH_TOKEN` like the
  rest of `/api`, and it enforces nothing: it renders decisions the server
  already made and triggers two endpoints the server already guards. Its
  session view is claims only — `jti`, agent, owner, run, issued, expires,
  revoked — and the raw run credential appears in no payload and renders
  nowhere. Its document table is metadata only — id, title, owner, visibility,
  never content — so it is not a way around the visibility rule the gateway
  enforces. The user-facing listing (`GET /api/docs`) has no operator override at
  all: it is scoped by the same predicate, for whoever is acting.
- Every gateway decision is recorded before the answer is sent, and the record
  is a decision rather than a payload. It holds the acting human, Agent, and
  Run, the tool, the `resource` identifier it named (`docs/doc-b1`), the
  allow/deny outcome, and the reason. It does **not** hold prompts, model
  replies, tool request or response bodies, query strings, headers, or the run
  credential. Reason and resource are masked on the way to the store — the Ark
  key, `GATEWAY_JWT_SECRET`, `GATEWAY_TOOL_CREDENTIAL`, bearer headers, and
  token-shaped values — and both fields are length-bounded, so a body cannot be
  smuggled into one. The trail still names humans, Agents, and what they were
  refused, so `GET /api/runs/:id/audit` sits behind `APP_AUTH_TOKEN` with the
  rest of `/api` and is never readable by an Agent.
- Run credentials are bearer tokens carried over plain HTTP between the Runtime
  container and the host gateway. They are per-run, revocable, and expire with
  the turn, but anyone who can read that local traffic during a run can replay
  one until it expires or is revoked. `npm run poc` binds all interfaces (the
  Runtime container cannot reach a loopback-only bind), so keep the POC on a
  trusted network.
- Ark key stored in Terraform POC state

## Safe use

- Use a dedicated development machine or disposable ECS instance.
- Use a scoped, revocable Ark key and a unique `APP_AUTH_TOKEN`.
- Keep local use on a trusted network and restrict ECS Web and SSH CIDRs.
  `npm run poc` must listen beyond loopback for the Runtime to reach the
  gateway; it mints an ephemeral `APP_AUTH_TOKEN` for the run when none is
  set, and prints it once for the browser unlock screen.
- Add HTTPS before sending the shared token over an untrusted network.
- Never mount production data or provide Volcengine account AK/SK to Agents.
- Stop the POC, destroy test resources, and revoke keys after the event.

Codex uses `workspace-write` when Landlock is available. On unsupported kernels,
startup warns and relies on the outer Docker or rootless Podman boundary. This
fallback is not tenant isolation.
