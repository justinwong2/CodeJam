# Security policy

Volc Agent Launchpad is a hackathon proof of concept. Only the latest revision
on the default branch is supported.

## Report a vulnerability

Send the repository owner or event organizer the affected revision,
reproduction steps, impact, and suggested mitigation. Do not publish
credentials, personal data, or exploit details in an issue.

## Known limitations

- Shared demo token; no user identity, authorization, RBAC, or tenant isolation
- No CSRF protection
- No per-Agent container boundary in ECS mode
- Ordinary local containers, not hardened multi-tenant sandboxes
- Broad outbound network access
- Prompt-triggered command and file execution
- Ark key held by the server process only; it is no longer passed into the
  Agent Runtime, so a prompt that asks an Agent to print `ARK_API_KEY` finds
  nothing to print. Codex reaches the model through the Agent Access Gateway
  (`POST /gateway/v1/responses`), which attaches the key on the way upstream.
- **Branch-only exposure:** the gateway does not yet verify the run credential
  it receives, and `/gateway/*` is outside the `APP_AUTH_TOKEN` hook by design.
  Until per-run JWT verification lands, anyone who can reach the server's port
  can spend the Ark key. `npm run poc` binds all interfaces (the Runtime
  container cannot reach a loopback-only bind), so keep the POC on a trusted
  network until that check exists.
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
