import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import type { AppConfig } from "./config.js";
import { verifyRunJwt } from "./run-jwt.js";
import type { RunSession, RunSessionDirectory } from "./types.js";

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
  sessions: RunSessionDirectory,
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

  const session = sessions.findRunSession(verified.claims.jti);
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
  sessions: RunSessionDirectory,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const authentication = authenticate(config, sessions, request);
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
  sessions: RunSessionDirectory,
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
          proxyResponses(config, sessions, request, reply),
      );
    },
    { prefix: GATEWAY_PREFIX },
  );
}
