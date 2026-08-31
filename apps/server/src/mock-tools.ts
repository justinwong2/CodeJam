import { randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { visibleTo } from "./authz.js";
import type { AppConfig } from "./config.js";
import type { MockDoc } from "./types.js";

// The downstream services an agent can be given access to. They stand in for
// the third-party APIs a real platform would front, and they exist so an
// authorization decision has somewhere to point: a denial is only meaningful
// if there was something real on the other side of it.
//
// The service authenticates its caller and applies the Scope it was handed. It
// decides nothing: the gateway resolves the principal and computes the scope
// once, before forwarding, and this service can only narrow what it returns —
// it never sees a role and cannot widen anything. So there is still one place
// to read the policy from and one place a change to it lands.

/** Where the mock tool service is mounted. Reachable only with the credential. */
export const MOCK_TOOLS_PREFIX = "/internal/tools";

/** Carries the credential the gateway injects when it forwards a tool call. */
export const TOOL_CREDENTIAL_HEADER = "x-launchpad-tool-credential";

/**
 * Carries the authorized Scope — the principal's owner id — beside the
 * credential. The gateway decides it; this service applies it mechanically and
 * can only ever narrow what it returns, because it never learns a role.
 */
export const TOOL_SCOPE_HEADER = "x-launchpad-scope";

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
  listMockDocs(): MockDoc[];
}

/** A result is a pointer to a document, not a copy of one. */
const SNIPPET_LENGTH = 160;

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

      // Search reads the one real document collection, narrowed to the Scope
      // the gateway decided. The predicate is `visibleTo` from authz.ts —
      // imported, never reimplemented — so a row this route hides is a row the
      // direct-fetch path hides too.
      scope.get("/search", async (request, reply) => {
        const authorizedScope = request.headers[TOOL_SCOPE_HEADER];
        if (
          typeof authorizedScope !== "string" ||
          authorizedScope.trim().length === 0
        ) {
          // Fail closed. The gateway is the only caller and always sends a
          // scope, so a missing one is a bug — and a bug must not be answered
          // with every human's documents.
          request.log.warn(
            "Tool service refused a search that carried no authorized scope",
          );
          return reply.code(400).send({ error: "Tool scope required" });
        }
        const { q } = searchQuery.parse(request.query);
        const needle = q.toLowerCase();
        return {
          query: q,
          results: directory
            .listMockDocs()
            .filter((doc) => visibleTo(doc, authorizedScope))
            .filter(
              (doc) =>
                needle.length === 0 ||
                doc.title.toLowerCase().includes(needle) ||
                doc.content.toLowerCase().includes(needle),
            )
            .map((doc) => ({
              id: doc.id,
              title: doc.title,
              snippet:
                doc.content.length > SNIPPET_LENGTH
                  ? doc.content.slice(0, SNIPPET_LENGTH) + "…"
                  : doc.content,
            })),
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
