import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { AuditLog, type AuditIdentity } from "./audit.js";
import { can, type OwnedResource } from "./authz.js";
import { estimateTokens, withinBudget } from "./budget.js";
import type { AppConfig } from "./config.js";
import {
  DOCUMENT_NOT_FOUND,
  MOCK_TOOLS_PREFIX,
  TOOL_CREDENTIAL_HEADER,
  TOOL_SCOPE_HEADER,
  isProxyableTool,
  type ProxyableTool,
} from "./mock-tools.js";
import { verifyRunJwt } from "./run-jwt.js";
import { TOOL_NAMES } from "./types.js";
import type {
  GatewayDirectory,
  Principal,
  RunSession,
  ToolName,
  User,
} from "./types.js";

// The gateway is the machine-facing half of the control plane: Codex talks to
// it instead of to Ark, so the upstream credential lives here and never inside
// the Agent Runtime. Every call is authenticated against the run session that
// issued its credential before anything is forwarded.
export const GATEWAY_PREFIX = "/gateway/v1";

// The environment variable Codex reads its gateway credential from. It replaces
// ARK_API_KEY inside the Runtime: the agent holds a run-scoped token, never the
// upstream key.
export const RUN_JWT_ENV_KEY = "RUN_JWT";

// Where the agent reaches the tool proxy. Codex is handed the gateway as its
// model endpoint through config.toml, which tells it nothing about
// `/gateway/v1/tools/*` — so without this the tool surface exists and is
// enforced but is undiscoverable from inside the Runtime. It is a URL, not a
// credential: unlike RUN_JWT it may safely appear in argv, and it confers
// nothing on its own, since every call it names is still authorized per call.
export const GATEWAY_URL_ENV_KEY = "LAUNCHPAD_GATEWAY_URL";

/** Where an agent on `host` reaches this server's gateway routes. */
export function gatewayBaseUrl(host: string, port: number): string {
  return `http://${host}:${port}${GATEWAY_PREFIX}`;
}

// A model call carries the whole conversation, so the app-level 1 MiB body
// limit is far too small for this scope.
const GATEWAY_BODY_LIMIT = 33_554_432;

// The single declaration of which tools' authority is scoped to a resource.
// Membership means two things that must travel together: the gateway looks the
// named resource up and asks `can()` about its ownership, and an ownership
// denial is answered as absence — the same 404 an unknown id gets — rather
// than as a refusal (docs/adr/2026-08-30-invisible-documents.md). Declared
// once because the pair drifting apart is an existence oracle: a tool that
// gained the lookup without the invisibility would confirm, by the shape of
// its denial, that the thing it denied exists.
const RESOURCE_SCOPED_TOOLS: ReadonlySet<ProxyableTool> = new Set(["docs"]);

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

// An allowlist rather than a denylist, and the same one `forwardToTool`
// applies downstream. This is the request that carries the platform's own Ark
// credential, so only the headers describing *this* payload travel with it:
// anything else the agent set stays with the agent instead of reaching the
// upstream under the platform's identity. `authorization` is absent because it
// is replaced outright, and framing headers because fetch re-frames the body.
const FORWARDED_REQUEST_HEADERS = new Set(["accept", "content-type"]);

/**
 * The gateway's own client identity upstream, set rather than forwarded.
 *
 * Ark inspects `User-Agent` for the case-insensitive substring `codex` and
 * only then tolerates the tool entries Codex CLI actually sends — notably
 * `{"type":"web_search","external_web_access":false}`, which it emits on every
 * turn and no configuration in 0.111.0 removes. Without the match Ark
 * validates strictly and answers `400 InvalidParameter: unknown field
 * "external_web_access"`, so every model call fails before the model is
 * reached.
 *
 * This is an undocumented vendor behaviour found by probing the live endpoint,
 * not a contract: `originator` and `session_id` have no effect, and any UA
 * containing the substring works. It is load-bearing until Codex can be told
 * to stop advertising the tool. Do not remove it as a stray header.
 *
 * It is *set* here rather than added to the allowlist above on purpose. The
 * agent controls the headers on its own gateway call, and this request is the
 * one carrying the platform's Ark credential — so the identity travelling
 * upstream has to be the gateway's, never the agent's.
 */
const UPSTREAM_USER_AGENT = "volc-agent-launchpad-gateway (codex)";

// fetch has already decoded and re-framed the upstream body, so forwarding the
// upstream's own framing headers would describe bytes we are no longer sending.
const DROPPED_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "content-encoding",
  "content-length",
]);

function upstreamHeaders(request: FastifyRequest, apiKey: string): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (
      value === undefined ||
      !FORWARDED_REQUEST_HEADERS.has(name.toLowerCase())
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  // Set last, so neither loop above nor an agent-chosen header can displace
  // the gateway's own identity on the request carrying the platform's key.
  headers.set("user-agent", UPSTREAM_USER_AGENT);
  // The only place the Ark credential is ever attached to a request.
  headers.set("authorization", `Bearer ${apiKey}`);
  return headers;
}

type Authentication =
  | { authenticated: true; session: RunSession }
  /**
   * `session` is present only when the store recognized the credential and
   * refused it anyway — a revoked, expired, or mismatched session. That is the
   * whole difference between a refusal the audit trail can attribute to a run
   * and one it cannot: an unverifiable token's claims are not evidence of
   * anything, so they are never treated as an identity.
   */
  | { authenticated: false; reason: string; session?: RunSession };

/**
 * Fail-closed authentication for an agent call. Both halves of the credential
 * must hold: the token must be ours and unexpired, and the session it names
 * must still be live. Revoking or expiring the session is therefore enough to
 * stop an agent mid-run, without reaching into a running container.
 *
 * Reasons are drawn from this fixed set. They name what failed and never carry
 * the signing secret, the token, or the upstream key.
 */
function authenticate(
  config: AppConfig,
  directory: GatewayDirectory,
  request: FastifyRequest,
): Authentication {
  const header = request.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) {
    return { authenticated: false, reason: "Missing run credential" };
  }
  const verified = verifyRunJwt(
    config.gatewayJwtSecret,
    header.slice(7).trim(),
  );
  if (!verified.valid) {
    return { authenticated: false, reason: verified.reason };
  }

  const session = directory.findRunSession(verified.claims.jti);
  if (!session) {
    return { authenticated: false, reason: "Unknown run session" };
  }
  if (session.revoked) {
    return { authenticated: false, reason: "Run session revoked", session };
  }
  if (Date.parse(session.expiresAt) <= Date.now()) {
    return { authenticated: false, reason: "Run session expired", session };
  }
  // A signed token that names a different run than its session would mean the
  // two halves disagree about who is calling. Nothing legitimate produces it.
  if (
    session.runId !== verified.claims.runId ||
    session.agentId !== verified.claims.agentId
  ) {
    return {
      authenticated: false,
      reason: "Run credential does not match",
      session,
    };
  }
  return { authenticated: true, session };
}

/**
 * Who a decision was about when it was reached before a principal could be
 * resolved. The session is the control plane's own record of who the run acts
 * for, so it is a fact rather than a claim.
 */
function sessionIdentity(session: RunSession): AuditIdentity {
  return {
    humanId: session.ownerId,
    agentId: session.agentId,
    runId: session.runId,
  };
}

function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}

/**
 * Files a refusal, if there is a run and a tool to file it against. A call the
 * gateway cannot attribute — a forged credential naming no session it knows, a
 * path naming nothing that is a tool — is still refused and still logged; it
 * simply has no Run whose evidence trail it belongs in.
 *
 * A failed write must never rescue the caller, so it is logged and the denial
 * stands as it was.
 */
async function recordDenial(
  audit: AuditLog,
  request: FastifyRequest,
  identity: AuditIdentity | undefined,
  tool: ToolName | null,
  resource: string | null,
  reason: string,
): Promise<void> {
  if (!identity || !tool) return;
  try {
    await audit.record({ identity, tool, resource, decision: "deny", reason });
  } catch {
    request.log.error("Gateway could not record a denial it had already made");
  }
}

async function proxyResponses(
  config: AppConfig,
  directory: GatewayDirectory,
  audit: AuditLog,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const authentication = authenticate(config, directory, request);
  if (!authentication.authenticated) {
    // Logged without the token, and answered before the upstream is touched:
    // a rejected call never spends the Ark key.
    request.log.warn(
      { reason: authentication.reason },
      "Gateway rejected an agent call",
    );
    await recordDenial(
      audit,
      request,
      authentication.session && sessionIdentity(authentication.session),
      "model",
      null,
      authentication.reason,
    );
    return reply.code(401).send({ error: authentication.reason });
  }

  // Until a principal is resolved, the run's own session is who the call is.
  const identity = sessionIdentity(authentication.session);

  // The model is a tool like any other: the role that may not use it is the
  // role that may not spend its tokens. Resolved from the Agent's current
  // owner, exactly as the tool proxy does, so suspending a human stops their
  // agents' model calls on the next one rather than at token expiry.
  const resolution = resolvePrincipal(directory, authentication.session);
  if (!resolution.resolved) {
    return deny(
      audit,
      request,
      reply,
      identity,
      "model",
      null,
      resolution.reason,
    );
  }
  const { principal, owner } = resolution;

  const decision = can(principal, "model");
  if (!decision.allow) {
    return deny(
      audit,
      request,
      reply,
      principal,
      "model",
      null,
      decision.reason,
    );
  }

  // What this call will cost, before it is allowed to cost it. Asking "would
  // this take the owner over?" rather than "have they already gone over?" is
  // what keeps the ceiling from being discovered only once it is breached —
  // and the in-flight meter is why a Run that is looping right now is bounded,
  // rather than counted after it has finished spending.
  const body = request.body;
  const now = Date.now();
  pruneRunMeters(directory, config.sessionTtlMs, now);
  const estimated = estimateTokens(Buffer.isBuffer(body) ? body.byteLength : 0);
  const budget = withinBudget(
    {
      settled: directory.sumOwnerTokens(principal.ownerId),
      inFlight: projectedInFlight(principal.ownerId, estimated),
    },
    owner.tokenBudget,
  );
  if (!budget.allow) {
    // 402, not 403: the call was authorized and refused anyway. Contract 1
    // reserved this status for exactly this, and the distinction is what tells
    // an operator "they may, but they cannot afford to" apart from "they may
    // not."
    return deny(
      audit,
      request,
      reply,
      principal,
      "model",
      null,
      budget.reason,
      402,
    );
  }

  // Charged the moment the check passes, with no await between the two: the
  // check and the charge are one atomic step on the event loop, so a second
  // call from the same owner arriving while this one's record is being written
  // sees this call's estimate already counted. Charging after the write would
  // open a window in which any number of concurrent calls pass the same
  // ceiling together, each certain it was the last one that fit.
  chargeRun(principal.runId, principal.ownerId, estimated, now);

  // Recorded before the call is made, not after it returns. What is being
  // recorded is the gateway's decision to allow it, which is already final —
  // and evidence written afterwards would go missing exactly when the forward
  // did. A store that cannot accept the record stops the call: an allowed
  // request the store cannot vouch for is worse than a failed one.
  //
  // The running total rides along in the reason, so the evidence panel shows
  // spend climbing toward a refusal instead of a refusal arriving from nowhere.
  // It is still one record for one decision: the count is a property of the
  // decision, not a second row about it.
  try {
    await audit.record({
      identity: principal,
      tool: "model",
      resource: null,
      decision: "allow",
      reason: `${decision.reason}; ${budget.reason}`,
    });
  } catch (error) {
    // The stopped call spent nothing, so it must be charged nothing: the
    // estimate comes back off the meter before the failure propagates.
    unchargeRun(principal.runId, estimated);
    throw error;
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${config.arkBaseUrl}/responses`, {
      method: "POST",
      headers: upstreamHeaders(request, config.arkApiKey),
      ...(Buffer.isBuffer(body) && body.byteLength > 0 ? { body } : {}),
    });
  } catch {
    // The failure detail can carry request context; keep it out of the reply.
    request.log.error("Gateway could not reach the upstream model API");
    // Nothing reached the upstream, so nothing was spent. Leaving the estimate
    // counted would let an outage eat the owner's allowance in phantom tokens.
    unchargeRun(principal.runId, estimated);
    return reply.code(502).send({ error: "Upstream model request failed" });
  }

  reply.code(upstream.status);
  for (const [name, value] of upstream.headers) {
    if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) {
      reply.header(name, value);
    }
  }
  if (!upstream.body) return reply.send();

  // Chunks are handed to the client as they arrive. Buffering here would
  // collapse a streamed model response into one late blob and stall Codex.
  const passthrough = new PassThrough();
  void pump(upstream.body, passthrough);
  return reply.send(passthrough);
}

/**
 * What Runs still in flight have spent, so far, as the gateway estimated it.
 *
 * In memory rather than in the store because it is working state, not evidence:
 * it is written on every model call, and a Run that ends — or a process that
 * restarts — has nothing worth keeping. That is safe precisely because the
 * startup sweep revokes the sessions of interrupted Runs, so a meter can never
 * outlive the credential it was counting.
 *
 * Keyed by Run because a Run is what starts and ends; an owner's in-flight
 * total is the sum of their live Runs.
 */
interface RunMeter {
  ownerId: string;
  tokens: number;
  touchedAt: number;
}

const runMeters = new Map<string, RunMeter>();

/**
 * Drops meters for Runs that can no longer be spending: a session outlives its
 * Run by at most its own TTL, so anything untouched for longer has certainly
 * ended. Pruning on read keeps this to the live set without a timer to own.
 */
function pruneRunMeters(
  directory: GatewayDirectory,
  ttlMs: number,
  now: number,
): void {
  for (const [runId, meter] of runMeters) {
    // Superseded: the Run has reported what it really cost, so the estimate is
    // not merely stale but wrong to keep — those tokens are now counted exactly
    // as settled spend, and leaving the guess in place would charge them twice.
    if (directory.hasRunSettled(runId)) {
      runMeters.delete(runId);
      continue;
    }
    // Aged out: a Run that reported nothing and can no longer be spending,
    // since a session outlives its Run by at most its own TTL.
    if (now - meter.touchedAt > ttlMs) runMeters.delete(runId);
  }
}

/** What this owner's in-flight Runs have spent, across all of them. */
function inFlightTokens(ownerId: string): number {
  let total = 0;
  for (const meter of runMeters.values()) {
    if (meter.ownerId === ownerId) total += meter.tokens;
  }
  return total;
}

/**
 * What this owner's in-flight spend would be if this call were forwarded: what
 * their live Runs have spent already, plus what this call is about to cost.
 */
function projectedInFlight(ownerId: string, estimated: number): number {
  return inFlightTokens(ownerId) + estimated;
}

/**
 * Adds a forwarded call's estimated cost to its Run's meter.
 *
 * A sum, because calls within a Run each cost something: Ark's thread is
 * resumed server-side, so a request carries the turn's own content rather than
 * the whole conversation, and a Run making ten calls costs ten calls' worth.
 * Measured against real usage, a ten-call Run cost ~50,000 tokens where its
 * largest single call was ~5,000 — taking a maximum would under-count it
 * tenfold.
 *
 * Note the asymmetry with settled spend, which takes an Agent's *latest*
 * `RunUsage` rather than a sum. The two are not inconsistent: `RunUsage` is
 * cumulative for the thread, so each Run's figure already contains the Runs
 * before it, while a request body contains only its own call.
 */
function chargeRun(
  runId: string,
  ownerId: string,
  estimated: number,
  now: number,
): void {
  const meter = runMeters.get(runId);
  if (meter) {
    meter.tokens += estimated;
    meter.touchedAt = now;
    return;
  }
  runMeters.set(runId, { ownerId, tokens: estimated, touchedAt: now });
}

/**
 * Takes a charge back off its Run's meter, for a call that was charged and
 * then never forwarded — an audit write that stopped it, or an upstream that
 * could not be reached. Only what this call added is subtracted, so the Run's
 * other calls keep counting; a meter drained to nothing is dropped rather than
 * left standing empty, and a meter already pruned has nothing to give back.
 */
function unchargeRun(runId: string, estimated: number): void {
  const meter = runMeters.get(runId);
  if (!meter) return;
  meter.tokens -= estimated;
  if (meter.tokens <= 0) runMeters.delete(runId);
}

/**
 * What this owner's live Runs have spent so far, as the gateway estimated it.
 *
 * A read for the operator's benefit, not part of any decision — the ceiling
 * computes its own total inline. Stale meters are pruned first so a number
 * shown to a human is never inflated by Runs that have long since ended.
 */
export function ownerSpendInFlight(
  directory: GatewayDirectory,
  ownerId: string,
  ttlMs: number,
): number {
  pruneRunMeters(directory, ttlMs, Date.now());
  return inFlightTokens(ownerId);
}

/**
 * Forgets what this owner's live Runs have spent so far.
 *
 * The other half of resetting an allowance: the store's watermark stops
 * counting completed Runs, and this stops counting the ones still going. Both
 * are needed for a reset to mean "clean start" rather than "clean start once
 * whatever is running now has finished".
 */
export function clearOwnerMeters(ownerId: string): void {
  for (const [runId, meter] of runMeters) {
    if (meter.ownerId === ownerId) runMeters.delete(runId);
  }
}

/** Test seam: the meter is process state, and a test must start from zero. */
export function resetRunMeters(): void {
  runMeters.clear();
}

type PrincipalResolution =
  /**
   * `owner` is the same record the principal was assembled from, handed back so
   * a caller that needs a ceiling as well as a role does not look the human up
   * twice — and cannot look up a *different* human than the one authorized.
   */
  | { resolved: true; principal: Principal; owner: User }
  | { resolved: false; reason: string };

/**
 * Who the call is acting as, assembled server-side from the Agent's current
 * owner. The credential names the run, not its permissions: reading the role
 * here is what makes a role change or a re-owned Agent take effect on the very
 * next call instead of whenever the token happens to expire.
 *
 * A record that has gone missing is a denial, never a fallback — acting as
 * whoever the default happens to be would hand the caller that human's
 * authority.
 */
function resolvePrincipal(
  directory: GatewayDirectory,
  session: RunSession,
): PrincipalResolution {
  const agent = directory.findAgent(session.agentId);
  if (!agent) {
    return { resolved: false, reason: "The Agent this run belongs to is gone" };
  }
  const owner = directory.findUser(agent.ownerId);
  if (!owner) {
    return {
      resolved: false,
      reason: "This Agent's owner is not a known user",
    };
  }
  return {
    resolved: true,
    owner,
    principal: {
      humanId: owner.id,
      ownerId: owner.id,
      agentId: agent.id,
      runId: session.runId,
      role: owner.role,
      toolGrants: agent.toolGrants,
    },
  };
}

type ResourceResolution =
  /**
   * `suffix` is the path the decision actually covers, which is not always the
   * path that was asked for: a `docs` call authorizes one document id, so the
   * canonical id is what gets recorded and forwarded.
   */
  | { ok: true; resource?: OwnedResource; suffix: string }
  | { ok: false; status: number; error: string };

/**
 * The thing the call is about, for the tools whose authority is scoped to a
 * resource. `docs` names one document — its owner and its visibility, which is
 * everything `can()` needs and nothing about what it says. The other tools
 * reach nothing anybody owns, so they have no resource to compare against.
 */
function resolveResource(
  directory: GatewayDirectory,
  tool: ProxyableTool,
  suffix: string,
): ResourceResolution {
  const segments = suffix.split("/").filter((segment) => segment.length > 0);
  if (!RESOURCE_SCOPED_TOOLS.has(tool)) {
    // These tools name no resource, so a sub-path names nothing they could be
    // asked about — and the tool service registers them as exact routes, so
    // forwarding one would file an allow for a call the service then refuses.
    // Refused on the shape of the path alone, like the multi-segment case
    // below, so the answer cannot vary with anything that exists.
    if (segments.length > 0) {
      return {
        ok: false,
        status: 400,
        error: `The ${tool} tool takes no sub-path`,
      };
    }
    return { ok: true, suffix };
  }
  if (segments.length === 0) {
    return { ok: false, status: 400, error: "A document id is required" };
  }
  // Refused on the shape of the path alone, before anything is looked up, so
  // the answer cannot vary with whether a document exists or who owns it. The
  // alternative — authorizing the first segment and forwarding the rest — would
  // decide one thing and forward another.
  if (segments.length > 1) {
    return {
      ok: false,
      status: 400,
      error: "A document id is a single path segment",
    };
  }
  const docId = segments[0] as string;
  const doc = directory.findMockDoc(docId);
  if (!doc) {
    // Answered before the tool service is called: there is no owner to compare
    // against, so there is no authorization question that could come out well.
    return { ok: false, status: 404, error: DOCUMENT_NOT_FOUND };
  }
  return {
    ok: true,
    resource: { ownerId: doc.ownerId, visibility: doc.visibility },
    suffix: docId,
  };
}

/**
 * What a record says the call was about: the tool and the path it named. Never
 * the query string and never the body — a search term is content, and content
 * is what these records deliberately do not keep.
 */
function auditResource(tool: string, suffix: string): string {
  const path = suffix.replace(/^\/+|\/+$/g, "");
  return path.length > 0 ? `${tool}/${path}` : tool;
}

/**
 * The tool half of the gateway. The order is the point: authenticate, resolve
 * who is calling, check the role, only then look the resource up, and forward
 * last. Nothing downstream is touched until every check has passed, so a denial
 * is a denial rather than a rollback — and looking the resource up after the
 * role check keeps a caller who may not use the tool at all from learning which
 * documents exist.
 *
 * Every outcome leaves exactly one row in the evidence trail: a forward is an
 * allow, and everything else is a denial, recorded with the reason the caller
 * was given.
 */
async function proxyTool(
  config: AppConfig,
  directory: GatewayDirectory,
  audit: AuditLog,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const params = request.params as { tool?: string; "*"?: string };
  const requested = params.tool ?? "";
  const suffix = params["*"] ?? "";
  // The tool a record can be filed under. `model` is a tool with a route of its
  // own, so a call arriving here for it is named in the trail and refused;
  // a path naming nothing that is a tool has no truthful `tool` to be filed as.
  const named = isToolName(requested) ? requested : null;
  const resource = auditResource(requested, suffix);

  const authentication = authenticate(config, directory, request);
  if (!authentication.authenticated) {
    request.log.warn(
      { reason: authentication.reason },
      "Gateway rejected an agent tool call",
    );
    await recordDenial(
      audit,
      request,
      authentication.session && sessionIdentity(authentication.session),
      named,
      resource,
      authentication.reason,
    );
    return reply.code(401).send({ error: authentication.reason });
  }
  // Until a principal is resolved, the run's own session is who the call is.
  const identity = sessionIdentity(authentication.session);

  if (!isProxyableTool(requested)) {
    // A path that names no proxyable tool cannot be authorized, so it is
    // refused rather than passed along to see what happens.
    return deny(
      audit,
      request,
      reply,
      identity,
      named,
      resource,
      `There is no "${requested}" tool to authorize`,
    );
  }
  const tool = requested;

  const resolution = resolvePrincipal(directory, authentication.session);
  if (!resolution.resolved) {
    return deny(
      audit,
      request,
      reply,
      identity,
      tool,
      resource,
      resolution.reason,
    );
  }
  // The principal is the better identity from here on: it is the Agent's owner
  // as the store holds it now, which is who the decision was actually made for.
  const principal = resolution.principal;

  const roleDecision = can(principal, tool);
  if (!roleDecision.allow) {
    return deny(
      audit,
      request,
      reply,
      principal,
      tool,
      resource,
      roleDecision.reason,
    );
  }
  let allowed = roleDecision.reason;

  const target = resolveResource(directory, tool, suffix);
  if (!target.ok) {
    // Not an authorization denial, but not a forward either: the call was
    // refused, so it leaves the same single row behind, under the status it
    // earned rather than under a 403 it did not.
    await recordDenial(audit, request, principal, tool, resource, target.error);
    return reply.code(target.status).send({ error: target.error });
  }
  // From here the record and the forward both name what was actually resolved
  // rather than the raw path that was asked for, so the evidence trail cannot
  // claim a decision covered more than it did.
  const resolved = auditResource(tool, target.suffix);
  if (target.resource) {
    const ownershipDecision = can(principal, tool, target.resource);
    if (!ownershipDecision.allow) {
      // A resource-scoped tool's ownership denial is *invisible*, not merely
      // refused: the agent gets the same answer a nonexistent id gets, and the
      // record gets the reason. Every other tool's denial names a tool rather
      // than a resource, so it discloses nothing and stays a 403.
      return RESOURCE_SCOPED_TOOLS.has(tool)
        ? invisible(
            audit,
            request,
            reply,
            principal,
            tool,
            resolved,
            ownershipDecision.reason,
          )
        : deny(
            audit,
            request,
            reply,
            principal,
            tool,
            resolved,
            ownershipDecision.reason,
          );
    }
    allowed = ownershipDecision.reason;
  }

  // Recorded before the tool is called, for the same reason the model proxy
  // records before it forwards: the decision is already made, and a store that
  // cannot accept the record stops the call rather than losing it.
  await audit.record({
    identity: principal,
    tool,
    resource: resolved,
    decision: "allow",
    reason: allowed,
  });
  return forwardToTool(
    config,
    request,
    reply,
    tool,
    target.suffix,
    principal.ownerId,
  );
}

/**
 * One shape for every refusal the gateway decides, on either route: the reason
 * the caller is given, and one record carrying that same reason.
 *
 * The status defaults to the authorization answer. `402` is the one deliberate
 * departure — a budget refusal is not a permission failure, and Contract 1
 * reserved that status so "they may, but they cannot afford to" stays
 * distinguishable from "they may not" to whoever reads the trail.
 */
async function deny(
  audit: AuditLog,
  request: FastifyRequest,
  reply: FastifyReply,
  identity: AuditIdentity | undefined,
  tool: ToolName | null,
  resource: string | null,
  reason: string,
  status = 403,
): Promise<FastifyReply> {
  request.log.warn(
    { reason, status, ...(tool ? { tool } : {}) },
    "Gateway denied an agent call",
  );
  await recordDenial(audit, request, identity, tool, resource, reason);
  return reply.code(status).send({ error: reason });
}

/**
 * An ownership denial on a document, answered as absence. The record carries
 * the real reason and the caller carries none of it: same status, same bytes,
 * same content type as the unknown-id branch above, so the pair is not a
 * one-bit existence oracle. The two deliberately diverge — the agent learns
 * nothing, the operator learns everything.
 */
async function invisible(
  audit: AuditLog,
  request: FastifyRequest,
  reply: FastifyReply,
  identity: AuditIdentity,
  tool: ToolName,
  resource: string | null,
  reason: string,
): Promise<FastifyReply> {
  request.log.warn(
    { reason, tool },
    "Gateway denied an agent call and answered as if the document did not exist",
  );
  await recordDenial(audit, request, identity, tool, resource, reason);
  return reply.code(404).send({ error: DOCUMENT_NOT_FOUND });
}

/**
 * The authorized call, and the only place the tool credential and the Scope are
 * attached. The agent's own credential is deliberately not passed on: the tool
 * service answers to the gateway, and nothing downstream should be able to
 * replay a run token.
 *
 * `authorizedScope` is the principal's owner id as the gateway resolved it — a
 * decision, not a claim. The tool applies it and cannot widen it; the response
 * bytes come back unparsed, as ever.
 */
async function forwardToTool(
  config: AppConfig,
  request: FastifyRequest,
  reply: FastifyReply,
  tool: ProxyableTool,
  suffix: string,
  authorizedScope: string,
): Promise<FastifyReply> {
  const queryIndex = request.url.indexOf("?");
  const target =
    MOCK_TOOLS_PREFIX +
    "/" +
    tool +
    (suffix.length > 0 ? "/" + suffix : "") +
    (queryIndex >= 0 ? request.url.slice(queryIndex) : "");
  const contentType = request.headers["content-type"];
  const body = request.body;

  const downstream = await request.server.inject({
    method: request.method as "GET",
    url: target,
    headers: {
      [TOOL_CREDENTIAL_HEADER]: config.gatewayToolCredential,
      [TOOL_SCOPE_HEADER]: authorizedScope,
      ...(request.headers.accept ? { accept: request.headers.accept } : {}),
      ...(contentType ? { "content-type": contentType } : {}),
    },
    ...(Buffer.isBuffer(body) && body.byteLength > 0 ? { payload: body } : {}),
  });

  reply.code(downstream.statusCode);
  const downstreamType = downstream.headers["content-type"];
  if (typeof downstreamType === "string") {
    reply.header("content-type", downstreamType);
  }
  return reply.send(downstream.rawPayload);
}

/**
 * Hands upstream chunks to the client as they arrive, respecting the sink's
 * backpressure. Exported for its tests; the model proxy is its only caller.
 *
 * A client that disconnects mid-stream destroys the sink with no error, which
 * announces itself as `close` — an event neither a parked drain wait nor a
 * pending upstream read hears on its own. The close handler turns it into
 * both: aborting the signal settles the drain wait, and cancelling the reader
 * resolves any pending read as done. Either way the upstream body is released
 * in `finally`, so a vanished listener cannot leave the pump holding the Ark
 * connection open for as long as the model keeps talking.
 */
export async function pump(
  source: ReadableStream<Uint8Array>,
  sink: PassThrough,
): Promise<void> {
  const reader = source.getReader();
  const disconnected = new AbortController();
  const onSinkClose = () => {
    disconnected.abort();
    void reader.cancel().catch(() => {});
  };
  sink.once("close", onSinkClose);
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!next.value) continue;
      // A write to a destroyed sink would raise an error nobody is listening
      // for; a chunk that raced the disconnect is simply dropped instead.
      if (sink.destroyed) break;
      if (!sink.write(Buffer.from(next.value))) {
        try {
          await once(sink, "drain", { signal: disconnected.signal });
        } catch {
          // The client went away while we waited: nothing left to drain to.
          break;
        }
      }
    }
    if (!sink.destroyed) sink.end();
  } catch (error) {
    sink.destroy(error instanceof Error ? error : new Error(String(error)));
  } finally {
    sink.off("close", onSinkClose);
    // Released on every path — done, failed, or abandoned. Cancelling a
    // stream that already ended is a no-op, so the happy path pays nothing.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function registerGateway(
  app: FastifyInstance,
  config: AppConfig,
  directory: GatewayDirectory,
): Promise<void> {
  // One writer for every decision this gateway reaches, so no route can answer
  // an agent without leaving the same evidence behind.
  const audit = new AuditLog(config, directory);
  await app.register(
    async (scope) => {
      // Byte-for-byte passthrough: no zod, no JSON parse/re-serialize. The
      // inherited JSON parser would rewrite the body Codex signed off on.
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser(
        "*",
        { parseAs: "buffer", bodyLimit: GATEWAY_BODY_LIMIT },
        (_request, payload, done) => {
          done(null, payload);
        },
      );
      scope.post(
        "/responses",
        { bodyLimit: GATEWAY_BODY_LIMIT },
        async (request, reply) =>
          proxyResponses(config, directory, audit, request, reply),
      );
      // Both shapes, so `/tools/search` and `/tools/docs/doc-a1` reach the same
      // pipeline rather than one of them falling through to a 404.
      for (const route of ["/tools/:tool", "/tools/:tool/*"]) {
        scope.all(
          route,
          { bodyLimit: GATEWAY_BODY_LIMIT },
          async (request, reply) =>
            proxyTool(config, directory, audit, request, reply),
        );
      }
    },
    { prefix: GATEWAY_PREFIX },
  );
}
