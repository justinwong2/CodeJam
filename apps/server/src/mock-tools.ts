import { randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { MockDoc } from "./types.js";

// The downstream services an agent can be given access to. They stand in for
// the third-party APIs a real platform would front, and they exist so an
// authorization decision has somewhere to point: a denial is only meaningful
// if there was something real on the other side of it.
//
// The service authenticates its caller and nothing more. It does not decide who
// may read what — the gateway does, once, before forwarding — so there is one
// place to read the policy from and one place a change to it lands.

/** Where the mock tool service is mounted. Reachable only with the credential. */
export const MOCK_TOOLS_PREFIX = "/internal/tools";

/** Carries the credential the gateway injects when it forwards a tool call. */
export const TOOL_CREDENTIAL_HEADER = "x-launchpad-tool-credential";

/**
 * The tools the gateway proxies. `model` is deliberately absent: it has its own
 * route and its own upstream, and a path naming anything outside this list
 * names no tool at all.
 */
export const PROXYABLE_TOOLS = ["docs", "search", "payments"] as const;

export type ProxyableTool = (typeof PROXYABLE_TOOLS)[number];

export function isProxyableTool(value: string): value is ProxyableTool {
  return (PROXYABLE_TOOLS as readonly string[]).includes(value);
}

/** The documents the service can serve. The store owns the fixture itself. */
export interface MockToolDirectory {
  findMockDoc(id: string): MockDoc | undefined;
}

/**
 * A small public corpus, unrelated to anybody's documents. `search` is not an
 * ownership-scoped tool, so what it returns must not depend on who is asking —
 * indexing user documents here would leak across owners by another door.
 */
const SEARCH_CORPUS = [
  {
    id: "kb-1",
    title: "Agent Access Gateway",
    snippet:
      "Agents call the platform gateway, which holds the credentials they do not.",
  },
  {
    id: "kb-2",
    title: "Run credentials",
    snippet:
      "Each run is issued a short-lived credential the control plane can revoke.",
  },
  {
    id: "kb-3",
    title: "Role-based tool access",
    snippet:
      "A role grants tools; ownership decides which resources those tools may touch.",
  },
];

const searchQuery = z.object({ q: z.string().trim().max(200).default("") });

const paymentBody = z.object({
  amount: z.number().finite().positive().max(1_000_000),
  currency: z.string().trim().length(3).default("USD"),
  memo: z.string().trim().max(200).optional(),
});

const docParams = z.object({ docId: z.string().trim().min(1).max(80) });

/** Constant-time compare that tolerates a length mismatch without throwing. */
function credentialMatches(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

export async function registerMockTools(
  app: FastifyInstance,
  config: AppConfig,
  directory: MockToolDirectory,
): Promise<void> {
  await app.register(
    async (scope) => {
      // The gateway is the only holder of this credential, so it is the only
      // caller that gets past here. Knowing the path is worth nothing: the
      // enforcement is the check, not the obscurity of the route.
      scope.addHook("onRequest", async (request, reply) => {
        const provided = request.headers[TOOL_CREDENTIAL_HEADER];
        if (
          typeof provided !== "string" ||
          !credentialMatches(provided, config.gatewayToolCredential)
        ) {
          request.log.warn(
            { tool: request.url },
            "Tool service rejected a call that did not come through the gateway",
          );
          return reply
            .code(401)
            .send({ error: "Tool service credential required" });
        }
      });

      scope.get("/docs/:docId", async (request, reply) => {
        const { docId } = docParams.parse(request.params);
        const doc = directory.findMockDoc(docId);
        if (!doc) {
          return reply.code(404).send({ error: "Document not found" });
        }
        return { doc };
      });

      scope.get("/search", async (request) => {
        const { q } = searchQuery.parse(request.query);
        const needle = q.toLowerCase();
        return {
          query: q,
          results: SEARCH_CORPUS.filter(
            (entry) =>
              needle.length === 0 ||
              entry.title.toLowerCase().includes(needle) ||
              entry.snippet.toLowerCase().includes(needle),
          ),
        };
      });

      scope.post("/payments", async (request, reply) => {
        const payment = paymentBody.parse(request.body);
        // Nothing is charged and nothing is persisted: this route exists to be
        // the tool a `basic` role may not reach.
        return reply.code(201).send({
          paymentId: randomUUID(),
          status: "accepted",
          amount: payment.amount,
          currency: payment.currency.toUpperCase(),
          ...(payment.memo === undefined ? {} : { memo: payment.memo }),
        });
      });
    },
    { prefix: MOCK_TOOLS_PREFIX },
  );
}
