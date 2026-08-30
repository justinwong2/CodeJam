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
- Operator actions are not audited. `PATCH /api/users/:id` (assign a role) and
  `POST /api/agents/:id/revoke` leave no `AuditRecord`, because a record belongs
  to a Run and an operator action has none. Their effect is visible in the very
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
  nowhere. Its document table is metadata only: ids and owners, never content,
  so it is not a way around the ownership rule the gateway enforces.
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
