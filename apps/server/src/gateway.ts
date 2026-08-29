import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import type { AppConfig } from "./config.js";

// The gateway is the machine-facing half of the control plane: Codex talks to
// it instead of to Ark, so the upstream credential lives here and never inside
// the Agent Runtime. Slice 1 verifies nothing yet -- the per-run JWT check
// lands with the session model.
export const GATEWAY_PREFIX = "/gateway/v1";

// The environment variable Codex reads its gateway credential from. It replaces
// ARK_API_KEY inside the Runtime: the agent holds a run-scoped token, never the
// upstream key.
export const RUN_JWT_ENV_KEY = "RUN_JWT";

// Slice 1 mints no tokens and the gateway verifies none. This constant keeps
// the plumbing honest until the session model replaces it, and is deliberately
// not a secret.
export const RUN_JWT_PLACEHOLDER = "placeholder-until-slice-2";

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

async function proxyResponses(
  config: AppConfig,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
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
        async (request, reply) => proxyResponses(config, request, reply),
      );
    },
    { prefix: GATEWAY_PREFIX },
  );
}
