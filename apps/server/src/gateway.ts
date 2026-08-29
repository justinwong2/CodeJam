import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { can } from "./authz.js";
import type { AppConfig } from "./config.js";
import {
  MOCK_TOOLS_PREFIX,
  TOOL_CREDENTIAL_HEADER,
  isProxyableTool,
  type ProxyableTool,
} from "./mock-tools.js";
import { verifyRunJwt } from "./run-jwt.js";
import type { GatewayDirectory, Principal, RunSession } from "./types.js";

// The gateway is the machine-facing half of the control plane: Codex talks to
// it instead of to Ark, so the upstream credential lives here and never inside
// the Agent Runtime. Every call is authenticated against the run session that
// issued its credential before anything is forwarded.
export const GATEWAY_PREFIX = "/gateway/v1";

// The environment variable Codex reads its gateway credential from. It replaces
// ARK_API_KEY inside the Runtime: the agent holds a run-scoped token, never the
// upstream key.
export const RUN_JWT_ENV_KEY = "RUN_JWT";

/** Where an agent on `host` reaches this server's gateway routes. */
export function gatewayBaseUrl(host: string, port: number): string {
  return `http://${host}:${port}${GATEWAY_PREFIX}`;
}

// A model call carries the whole conversation, so the app-level 1 MiB body
// limit is far too small for this scope.
const GATEWAY_BODY_LIMIT = 33_554_432;

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

// `authorization` is replaced with the injected credential; `host` and the
// framing headers describe this hop only; `accept-encoding` is left to fetch,
// which transparently decodes the upstream body.
const DROPPED_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "accept-encoding",
  "authorization",
  "content-length",
  "host",
]);

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
      DROPPED_REQUEST_HEADERS.has(name.toLowerCase())
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  // The only place the Ark credential is ever attached to a request.
  headers.set("authorization", `Bearer ${apiKey}`);
  return headers;
}

type Authentication =
  | { authenticated: true; session: RunSession }
  | { authenticated: false; reason: string };

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
    return { authenticated: false, reason: "Run session revoked" };
  }
  if (Date.parse(session.expiresAt) <= Date.now()) {
    return { authenticated: false, reason: "Run session expired" };
  }
  // A signed token that names a different run than its session would mean the
  // two halves disagree about who is calling. Nothing legitimate produces it.
  if (
    session.runId !== verified.claims.runId ||
    session.agentId !== verified.claims.agentId
  ) {
    return { authenticated: false, reason: "Run credential does not match" };
  }
  return { authenticated: true, session };
}

async function proxyResponses(
  config: AppConfig,
  directory: GatewayDirectory,
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
    return reply.code(401).send({ error: authentication.reason });
  }

  const body = request.body;
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

type PrincipalResolution =
  | { resolved: true; principal: Principal }
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
    principal: {
      humanId: owner.id,
      ownerId: owner.id,
      agentId: agent.id,
      runId: session.runId,
      role: owner.role,
    },
  };
}

type ResourceResolution =
  | { ok: true; resource?: { ownerId: string } }
  | { ok: false; status: number; error: string };

/**
 * The thing the call is about, for the tools whose authority is scoped to a
 * resource. `docs` names one document; the other tools reach nothing anybody
 * owns, so they have no resource to compare against.
 */
function resolveResource(
  directory: GatewayDirectory,
  tool: ProxyableTool,
  suffix: string,
): ResourceResolution {
  if (tool !== "docs") return { ok: true };
  const docId = suffix.split("/")[0] ?? "";
  if (docId.length === 0) {
    return { ok: false, status: 400, error: "A document id is required" };
  }
  const doc = directory.findMockDoc(docId);
  if (!doc) {
    // Answered before the tool service is called: there is no owner to compare
    // against, so there is no authorization question that could come out well.
    return { ok: false, status: 404, error: "Document not found" };
  }
  return { ok: true, resource: { ownerId: doc.ownerId } };
}

/**
 * The tool half of the gateway. The order is the point: authenticate, resolve
 * who is calling, check the role, only then look the resource up, and forward
 * last. Nothing downstream is touched until every check has passed, so a denial
 * is a denial rather than a rollback — and looking the resource up after the
 * role check keeps a caller who may not use the tool at all from learning which
 * documents exist.
 */
async function proxyTool(
  config: AppConfig,
  directory: GatewayDirectory,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const authentication = authenticate(config, directory, request);
  if (!authentication.authenticated) {
    request.log.warn(
      { reason: authentication.reason },
      "Gateway rejected an agent tool call",
    );
    return reply.code(401).send({ error: authentication.reason });
  }

  const params = request.params as { tool?: string; "*"?: string };
  const tool = params.tool ?? "";
  if (!isProxyableTool(tool)) {
    // A path that names no tool cannot be authorized, so it is refused rather
    // than passed along to see what happens.
    return deny(request, reply, `There is no "${tool}" tool to authorize`);
  }

  const resolution = resolvePrincipal(directory, authentication.session);
  if (!resolution.resolved) {
    return deny(request, reply, resolution.reason);
  }
  const principal = resolution.principal;

  const roleDecision = can(principal, tool);
  if (!roleDecision.allow) {
    return deny(request, reply, roleDecision.reason, tool);
  }

  const resource = resolveResource(directory, tool, params["*"] ?? "");
  if (!resource.ok) {
    return reply.code(resource.status).send({ error: resource.error });
  }
  if (resource.resource) {
    const ownershipDecision = can(principal, tool, resource.resource);
    if (!ownershipDecision.allow) {
      return deny(request, reply, ownershipDecision.reason, tool);
    }
  }

  return forwardToTool(config, request, reply, tool, params["*"] ?? "");
}

/** One shape for every authorization refusal: 403, the reason, nothing else. */
function deny(
  request: FastifyRequest,
  reply: FastifyReply,
  reason: string,
  tool?: ProxyableTool,
): FastifyReply {
  request.log.warn(
    { reason, ...(tool ? { tool } : {}) },
    "Gateway denied a tool call",
  );
  return reply.code(403).send({ error: reason });
}

/**
 * The authorized call, and the only place the tool credential is attached. The
 * agent's own credential is deliberately not passed on: the tool service
 * answers to the gateway, and nothing downstream should be able to replay a run
 * token.
 */
async function forwardToTool(
  config: AppConfig,
  request: FastifyRequest,
  reply: FastifyReply,
  tool: ProxyableTool,
  suffix: string,
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

async function pump(
  source: ReadableStream<Uint8Array>,
  sink: PassThrough,
): Promise<void> {
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
    sink.destroy(error instanceof Error ? error : new Error(String(error)));
  } finally {
    reader.releaseLock();
  }
}

export async function registerGateway(
  app: FastifyInstance,
  config: AppConfig,
  directory: GatewayDirectory,
): Promise<void> {
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
          proxyResponses(config, directory, request, reply),
      );
      // Both shapes, so `/tools/search` and `/tools/docs/doc-a1` reach the same
      // pipeline rather than one of them falling through to a 404.
      for (const route of ["/tools/:tool", "/tools/:tool/*"]) {
        scope.all(
          route,
          { bodyLimit: GATEWAY_BODY_LIMIT },
          async (request, reply) =>
            proxyTool(config, directory, request, reply),
        );
      }
    },
    { prefix: GATEWAY_PREFIX },
  );
}
