# Code Review — main @ 70e8a9e (2026-08-31)

Full review of `main` against the ADRs in [docs/adr/](adr/), [CLAUDE.md](../CLAUDE.md)
/[AGENTS.md](../AGENTS.md)'s invariants, and general correctness/cleanup. Not a
diff review — every file below was read against its documented intent, not
against a change set.

Each finding cites the exact file and line on `main` and was verified by
reading the code directly (not inferred from the docs alone). Findings are
ranked most-severe first; correctness bugs are listed ahead of cleanup items.
No finding here is a request to fix anything automatically — this is a punch
list for the team to triage.

## Findings

### 1. Concurrent model calls from the same owner can jointly exceed `tokenBudget`

**File:** `apps/server/src/gateway.ts:262-307`

`withinBudget()` is evaluated (line 266-272) from `directory.sumOwnerTokens()`
and `projectedInFlight()`, but the corresponding write — `chargeRun()` —
doesn't run until line 307, _after_ `await audit.record(...)` at line 300.
That await is a real event-loop yield (it goes through the store's write
queue and an `appendFile`). Two `/gateway/v1/responses` calls from Agents the
same human owns, arriving close together, can each read the same pre-charge
in-flight total, each pass `withinBudget()`, and each proceed to charge and
forward — so the owner's real spend can exceed the configured ceiling by
roughly one extra call's worth per overlapping pair, repeatedly if both Runs
keep looping. This is exactly the invariant #14 story ("a spent-out owner's
model call is refused before it is made... in-flight spend counts, or a Run
that is looping right now could never be stopped") failing under concurrency
the single-Run case doesn't exercise.

**Suggested direction:** charge (reserve) the estimated cost synchronously,
before the `await audit.record(...)` yield, so the read-then-write is atomic
with respect to other calls; release/adjust the reservation once the real
outcome is known.

### 2. A failed upstream fetch still charges the owner's budget, permanently

**File:** `apps/server/src/gateway.ts:307-320`

`chargeRun()` (line 307) debits the owner's in-flight meter for the
_estimated_ cost before `fetch()` to Ark is even attempted. If that fetch
throws (line 316-320, e.g. Ark is briefly unreachable), the handler returns
`502` immediately but never reverses the charge. Tokens that were never
actually spent still count against the owner's ceiling until the Run
completes and settles, or the meter ages out via `SESSION_TTL_MS`. A burst of
`502`s during an outage can push an owner over budget with zero real spend
behind it, and their next legitimate call gets `402` for phantom reasons.

**Suggested direction:** revert (or don't apply) the charge on the `catch`
path at line 316-320, since no tokens were actually placed at risk.

### 3. Editing an Agent's tool grants mid-Run can be silently discarded

**File:** `apps/web/src/App.tsx:943-952` (effect), `apps/web/src/App.tsx:1102-1119` (`pollRun`)

```
useEffect(() => {
  if (selected) {
    setForm({ name: selected.name, ..., toolGrants: selected.toolGrants });
  }
}, [selected]);
```

`selected` (line 710-712) is `visibleAgents.find(...)`, and `visibleAgents`
is rebuilt from `agents` state on every `refreshAgents()` call — including
the one `pollRun` fires at line 1112 the moment a Run leaves
`queued`/`running`. That rebuild gives the same Agent a new object identity
even when nothing about it changed, so the effect above fires and
overwrites `form` — including `form.toolGrants` — with whatever the server
had _before_ the edit. CLAUDE.md explicitly documents that "Apply tool
grants remains usable during a Run" as a live-policy demo case; a user who
toggles a checkbox in the `ToolGrantEditor` while a Run is active, without
clicking Apply before the Run finishes, loses that edit with no warning the
instant the Run completes.

**Suggested direction:** key the reset effect off the Agent's own
`updatedAt` (or an explicit "form is dirty" guard) rather than off
`selected`'s object identity.

### 4. Clearing the token-budget input and blurring it silently sets "unlimited"

**File:** `apps/web/src/App.tsx:317-331`

```
onBlur={(event) => {
  const next = Number(event.target.value);
  if (!Number.isInteger(next) || next < 0) return;
  if (next === user.tokenBudget) return;
  onAssignTokenBudget(user.id, next);
}}
```

`Number("")` is `0` in JavaScript, and `Number.isInteger(0)` is `true`, so an
emptied input passes validation and is submitted as `tokenBudget: 0` — which
`withinBudget()` treats as "unlimited." An operator who selects-all to retype
a new ceiling, and blurs the field before typing the replacement, silently
removes that human's spend ceiling instead of being rejected as invalid
input. This is the one owner-facing lever CLAUDE.md calls out as
security-sensitive ("a ceiling its subject can lift is not a ceiling") — the
operator UI itself can accidentally lift it.

**Suggested direction:** treat an empty string as "no change" (bail out)
rather than coercing it to `0`.

### 5. A corrupted `db.json` crashes startup with an uncaught `SyntaxError`

**File:** `apps/server/src/store.ts:332`

```
this.data = migrateDatabase(JSON.parse(raw));
```

The `try/catch` around the file read (lines 321-331) only handles `ENOENT`
from `readFile`; `JSON.parse` itself sits outside any catch. Every other
parser in this codebase treats malformed input as expected and recoverable —
`parseCodexEventLine`, `verifyRunJwt`'s segment decoder, and the audit
sidecar's own "a torn final line is skipped rather than fatal" contract all
degrade gracefully. The primary database file gets no equivalent treatment:
a truncated or corrupted `db.json` (e.g. from a crash mid-write, since it is
still written by whole-file replace) throws a raw `SyntaxError` straight out
of `initialize()` and the server never starts.

**Suggested direction:** wrap the `JSON.parse` and report a clear diagnostic
(or fail over to a recovery path) instead of an unhandled exception.

### 6. Which tools get ownership/visibility treatment is decided by a literal string check, twice, independently

**File:** `apps/server/src/gateway.ts:531` and `apps/server/src/gateway.ts:682`

```
// line 531, resolveResource():
if (tool !== "docs") return { ok: true, suffix };
...
// line 682, proxyTool():
return tool === "docs" ? invisible(...) : deny(...);
```

Nothing declares "`docs` is the one resource-scoped, invisible-on-denial
tool" as a single fact — it's asserted twice, by two functions that
currently happen to agree. `resolveResource` decides whether a resource
(owner + visibility) is looked up **at all**; the ternary at 682 decides
whether an ownership denial gets the ADR-mandated 404-invisibility treatment
or a plain 403. If a future resource-scoped tool (a per-id payments ledger,
a workspace-file tool) is added and only one of the two spots is updated:
forgetting the line-531 gate means the new tool is never ownership-checked
at all (any owner can reach any resource); forgetting the line-682 ternary
means ownership denials for it leak via `403` with `can()`'s real reason —
exactly the existence-oracle [ADR 2026-08-30](adr/2026-08-30-invisible-documents.md)
was written to close. Every existing test only exercises `docs`, so neither
mistake would be caught by the current suite.

**Suggested direction:** express "is a resource-scoped tool" as one
declared set (e.g. a `RESOURCE_SCOPED_TOOLS` constant) both call sites read,
instead of two independent literal comparisons.

### 7. `createAgent` / `createDocument` return live references into the store instead of clones

**File:** `apps/server/src/agent-service.ts:253-269` (`createAgent`), `apps/server/src/agent-service.ts:514-524` (`createDocument`)

```
const agent: Agent = { id, ownerId, ... };
await this.workspaces.create(agent);
await this.store.mutate((database) => database.agents.push(agent));
return agent;                              // <-- same reference now live in the store
```

`store.mutate()` clones `this.data` into `next` and swaps `this.data = next`
(store.ts:392-397), but a value pushed into `next` that was never part of
`this.data` — like this freshly-built `agent` — is never cloned. The object
returned to the caller _is_ the object now sitting in `this.data.agents`.
This is inconsistent with the rest of the file: `updateAgent` (line 307)
deliberately returns `structuredClone(agent)` from inside the same closure
pattern, precisely so a caller can't mutate live store state by mutating the
value it got back. Today no caller mutates the returned `Agent`/`MockDoc` in
place (both routes only serialize it), so this is latent rather than
actively triggering corruption — but it's a real inconsistency with the
store's own clone-swap contract and one bad future edit away from a mutation
that bypasses `persist()` and the write queue entirely.

**Suggested direction:** return `structuredClone(agent)` / `structuredClone(doc)`
from these two methods, matching `updateAgent`'s pattern.

### 8. The SSE pump has no wiring for a downstream disconnect mid-stream

**File:** `apps/server/src/gateway.ts:824-842`

```
async function pump(source, sink) {
  const reader = source.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!next.value) continue;
      if (!sink.write(Buffer.from(next.value))) await once(sink, "drain");
    }
    sink.end();
  } catch (error) {
    sink.destroy(...);
  } finally {
    reader.releaseLock();
  }
}
```

Nothing in this function listens for the client side of `sink` going away.
If the agent's connection to the gateway is severed mid-stream — which is
exactly what happens when `POST /agents/:id/stop` kills the Codex process or
removes its container mid-turn — and Fastify's stream cleanup doesn't
propagate that closure into a `sink.destroy()`, `sink.write()` keeps
returning `false` under backpressure and `await once(sink, "drain")` waits
for an event that will never fire, since nothing is draining a response
nobody is reading anymore. `reader.releaseLock()` in the `finally` is never
reached, and the `fetch()` to Ark is never aborted. Whether this actually
hangs depends on Fastify's internal stream-to-response piping (which may or
may not destroy `sink` on `reply.raw` close) — worth a direct test rather
than trusting the framework default, since the cancel/stop path is a
documented, demoed feature.

**Suggested direction:** listen for `request.raw`/`reply.raw` close and
explicitly `reader.cancel()` / abort the upstream fetch when it fires,
rather than relying on Fastify's default cleanup.

### 9. `search` and `payments` calls with a malformed suffix are audited as `allow` even though they then 404 at the routing layer

**File:** `apps/server/src/gateway.ts:531`, `apps/server/src/mock-tools.ts:147` (`/search`), `apps/server/src/mock-tools.ts:185` (`/payments`)

`resolveResource()` only validates/parses the suffix for `tool === "docs"`
(line 531); for `search` and `payments` it unconditionally returns
`{ ok: true, suffix }` regardless of what the suffix actually is. But
`mock-tools.ts` registers `/search` and `/payments` as exact routes with no
wildcard tail. A call like `/gateway/v1/tools/search/whatever` sails through
authentication, `can()`, and gets a full `allow` audit record filed at
gateway.ts:708-714 — then 404s anonymously inside `forwardToTool` because
Fastify has no matching route for the forwarded path. The audit trail (whose
whole contract, per invariant #11 and the Observability section, is "the
decision is what happened") records a call as authorized and forwarded that
in fact did nothing.

**Suggested direction:** either register wildcard-tolerant routes for
`search`/`payments` that reject a non-empty suffix explicitly, or have
`resolveResource` reject a non-empty suffix for tools that take none, before
the audit `allow` is filed.

### 10. Some auth failures leave zero audit trace, in tension with the documented "every decision" guarantee

**File:** `apps/server/src/gateway.ts:181-195` (`recordDenial`)

```
async function recordDenial(audit, request, identity, tool, resource, reason) {
  if (!identity || !tool) return;
  ...
}
```

A call with no Bearer header, a malformed JWT, a bad signature, or an
unsupported `alg` resolves `identity` to `undefined` (nothing to attribute
the attempt to) and writes **zero** audit rows; a tool-proxy call to a path
segment that isn't a recognized `ToolName` similarly resolves `tool` to
`null` and also writes nothing — even though the session was perfectly
valid and identity _was_ resolved in that second case. This is intentional
and test-covered (`gateway.test.ts` has tests titled for exactly these two
cases), and CLAUDE.md's "Identity is a store fact" bullet gestures at the
reasoning — but the numbered invariant list (#11: "Every gateway decision
leaves exactly one redacted record") and its AGENTS.md summary state the
guarantee with no stated carve-out. A reader relying on the invariant list
alone (as an operator or a future contributor would) could reasonably
conclude every `401`/`403` leaves a trace, which is false for unauthenticated
probing — precisely the class of call an operator would most want visibility
into.

**Suggested direction:** either add the exception explicitly to the
numbered invariant (not just the prose elsewhere), or record a
minimally-attributed row (e.g. keyed by IP/request id rather than identity)
for the unattributable case so probing isn't invisible to the evidence feed.

### 11. Validation errors leak a raw, multi-line JSON blob into the UI's error banner

**File:** `apps/server/src/app.ts:384-406`

```
return reply.code(statusCode).send({
  error: appError.message,
  ...(validationError ? { details: error.issues } : {}),
});
```

For a `ZodError`, `.message` is Zod's default stringified-array-of-issues
text, not a human sentence — unlike every `HttpError` elsewhere in the
codebase, which puts a short human string in `.message`. `apps/web/src/api.ts`
treats `data.error` uniformly as display text and never reads `data.details`.
Since the Create-Agent name field and the document Upload title field are
only `required`-checked in the browser (a single space satisfies `required`
but fails the server's `.trim().min(1)`), a whitespace-only submission passes
client-side validation and surfaces the raw Zod JSON blob in the error
banner instead of a readable message.

**Suggested direction:** map `ZodError` to a short human summary for
`error`, and keep `details` for anything that wants the structured form; or
trim client-side before the `required` check so the common case never
reaches the server's stricter rule.

### 12. The run credential's `exp` and its session's `expiresAt` can disagree by up to 999ms

**File:** `apps/server/src/agent-service.ts:401-441`, `apps/server/src/run-jwt.ts:113`, `apps/server/src/gateway.ts:137`

```
// agent-service.ts:401,411,441
const expiresAtMs = Date.now() + this.config.sessionTtlMs;
...
expiresAt: new Date(expiresAtMs).toISOString(),   // exact millisecond
...
exp: Math.floor(expiresAtMs / 1_000),             // floored to the second
```

`gateway.ts`'s `authenticate()` runs two expiry checks meant to describe one
moment: `verifyRunJwt` checks `claims.exp * 1_000 <= nowMs` first
(run-jwt.ts:113), and only if that passes does it separately check
`Date.parse(session.expiresAt) <= Date.now()` (gateway.ts:137). Because the
JWT's `exp` was floored down from the session's exact millisecond timestamp,
a call arriving in the (up to 999ms) window after the floored `exp` but
before the session's true `expiresAt` is denied by the token check with
reason "Run credential expired" rather than reaching the session-truth
check — so the audit record for that denial carries the token-derived
reason instead of the store-derived one the design otherwise treats as
canonical ("Identity is a store fact"). Fails closed (over-restrictive, not
a hole), but it's a real precondition mismatch between two checks meant to
be one credential lifetime.

**Suggested direction:** round the JWT `exp` up (`Math.ceil`) rather than
down, or derive both from the same floored/rounded millisecond value.

### 13. The container runner drops proxy/CA environment variables the host runner forwards

**File:** `apps/server/src/codex-runner.ts:103-120` (`buildCodexEnvironment`) vs `apps/server/src/container-codex-runner.ts:59-73` (`buildEngineEnvironment`)

The host-process runner's environment allowlist includes `SSL_CERT_FILE`,
`SSL_CERT_DIR`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`,
`NODE_EXTRA_CA_CERTS`, and `TERM`. The container runner's allowlist for the
`docker`/`podman` CLI invocation carries only `PATH`, `HOME`, `TMPDIR`,
`LANG`, `LC_ALL`, and `XDG_RUNTIME_DIR` — none of the proxy/CA variables.
Neither leaks a secret (`ARK_API_KEY`/`GATEWAY_JWT_SECRET`/
`GATEWAY_TOOL_CREDENTIAL` are absent from both), so this isn't a security
issue, but it's a functional asymmetry between the two `AgentRunner`
implementations the docs otherwise treat as interchangeable vantage points.
Behind a corporate TLS-intercepting proxy or a custom CA bundle,
`RUNTIME_PROVIDER=local-process` would work while `RUNTIME_PROVIDER=container`
would fail to reach the container engine or registry, purely because those
variables never reach the `docker run`/`docker version` invocation.

**Suggested direction:** either forward the same proxy/CA allowlist in
`buildEngineEnvironment`, or document the asymmetry as intentional if it
isn't.

### 14. Constant-time secret comparison is implemented independently three times

**File:** `apps/server/src/app.ts:171-177` (`APP_AUTH_TOKEN` check), `apps/server/src/mock-tools.ts:78-84` (`credentialMatches`, for `GATEWAY_TOOL_CREDENTIAL`), `apps/server/src/run-jwt.ts:97-107` (signature check)

All three independently hand-roll "length-check, then `timingSafeEqual`."
`mock-tools.ts` already factors its copy into a named helper
(`credentialMatches`); `app.ts` and `run-jwt.ts` each inline the same
pattern rather than reusing it. A future fix to the pattern (an edge case in
the length guard, an encoding change) has to be applied by hand in three
places, and nothing signals to an editor patching one that the other two
need the same fix — for a routine that guards three of the project's
security-sensitive credential checks (`APP_AUTH_TOKEN`,
`GATEWAY_TOOL_CREDENTIAL`, the run JWT signature).

**Suggested direction:** hoist `credentialMatches` (or equivalent) into a
shared module both `app.ts` and `run-jwt.ts` import.

### 15. The gateway's hot path and the Playground's polled endpoint re-clone the entire database for a single-row read

**File:** `apps/server/src/agent-service.ts:158` (`sumOwnerTokens`), `apps/server/src/agent-service.ts:348` (`getRun`)

`store.select()` (store.ts:384-386) clones only what a selector returns, and
the gateway's own principal-resolution path (`findAgent`, `findUser`,
`findRunSession`) correctly uses it. `sumOwnerTokens` and `getRun`, however,
go through `store.snapshot()` (store.ts:376, a `structuredClone` of the
_entire_ database — every Agent, message, Run, session, user, document, and
up to `AUDIT_RETENTION_LIMIT` audit records) to answer what is, in both
cases, a query over one owner's Runs or one Run by id. `sumOwnerTokens` runs
on _every_ `/gateway/v1/responses` call (gateway.ts:268) — the busiest route
in the system, which the audit-sidecar ADR specifically redesigned to stay
O(1) per decision — and `getRun` backs `GET /api/runs/:id`, which
`apps/web/src/App.tsx`'s `pollRun` calls every 900ms for the duration of
every active Run. Both pay for a full-store deep clone on a path the project
has otherwise gone out of its way to keep cheap.

**Suggested direction:** rewrite both with `store.select(db => ...)` over a
narrow projection, the way `findAgent`/`findRunSession` already do.

## Not flagged, checked and found clean

Worth recording since these were the highest-risk areas by design and the
review specifically targeted them:

- No second implementation of `visibleTo()` — the gateway, `mock-tools.ts`
  (search and the single-document route), and `agent-service.ts`'s
  `listVisibleDocuments` all import the one in `authz.ts`.
- No path reaches Ark or the mock tool service except through
  `proxyResponses`/`proxyTool` — grepped every caller of the upstream base
  URLs and the tool-credential header.
- Neither `ARK_API_KEY` nor `GATEWAY_JWT_SECRET` nor
  `GATEWAY_TOOL_CREDENTIAL` appears in a runner environment, `argv`, a
  generated `config.toml`, or a forwarded header, in either runner.
- `can()`/`withinBudget()` have no inverted conditions; every
  `audit.record`/`recordDenial` call site on the allow path is properly
  awaited before the reply is sent.
- The invisible-document 404 is genuinely byte-identical between the
  ownership-denied and nonexistent-id cases.
- No clear, quotable CLAUDE.md/AGENTS.md rule violation was found in the
  files this review covered.
