import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import { registerGateway } from "./gateway.js";
import { registerMockTools } from "./mock-tools.js";
import { DEFAULT_OWNER_ID, ROLE_NAMES, VISIBILITY_NAMES } from "./types.js";
import type { User } from "./types.js";
import type { AgentService } from "./agent-service.js";

/**
 * Which human the browser is acting as. Mock authentication by design — the
 * gateway's subject is authorization, not proving who someone is — so the
 * switcher names a seeded user and the server validates that it exists.
 */
const ACTING_USER_HEADER = "x-launchpad-user";
const actingUserHeader = z.string().trim().min(1).optional();

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const userIdParams = z.object({ id: z.string().trim().min(1).max(64) });
/**
 * The whole vocabulary of a role change: one of the seeded roles, and nothing
 * else. Assigning roles is in scope for the operator; authoring them is not, so
 * an unrecognized value is a 400 rather than a role no grant table knows.
 */
const updateUserBody = z.object({ role: z.enum(ROLE_NAMES) });
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const updateAgentBody = createAgentBody
  .partial()
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one field is required",
  );
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});

/** A few KB of prose. A document is a demo fixture, not a file store. */
const MAXIMUM_DOCUMENT_CONTENT = 4_000;

/**
 * Plain text: anything but the control characters that would make a "document"
 * something other than something to read. Newlines and tabs are text.
 */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * An Upload, as a client may express it. `strictObject` is the enforcement of
 * "the owner is never taken from the body": an `ownerId` here is a rejection,
 * not a field that is quietly ignored and might one day be quietly read.
 * Visibility is chosen once, here, and nothing edits it afterwards.
 */
const createDocumentBody = z.strictObject({
  title: z.string().trim().min(1).max(120),
  content: z
    .string()
    .min(1)
    .max(MAXIMUM_DOCUMENT_CONTENT)
    .refine(
      (value) => !CONTROL_CHARACTERS.test(value),
      "A document must be plain text",
    ),
  visibility: z.enum(VISIBILITY_NAMES),
});

/**
 * The human a browser request acts as: the named seeded user, or the default
 * owner when no user is named. A named user who does not exist is a client
 * mistake and is refused — acting as somebody else instead would hand the
 * caller whichever permissions the fallback happens to have.
 */
function actingUser(request: FastifyRequest, service: AgentService): User {
  const named =
    actingUserHeader.parse(request.headers[ACTING_USER_HEADER]) ??
    DEFAULT_OWNER_ID;
  const user = service.findUser(named);
  if (!user) {
    throw new HttpError(400, `Unknown user "${named}"`);
  }
  return user;
}

export async function createApp(
  config: AppConfig,
  service: AgentService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

  setErrorHandler(app);

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (
      !config.authToken ||
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      request.url === "/api/auth"
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  // Resolving the acting human here, rather than only where ownership is
  // stamped, means a browser request naming a user who does not exist is
  // refused everywhere instead of on the one route that happens to read it.
  app.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/api/")) {
      return;
    }
    actingUser(request, service);
  });

  // Agent-facing routes. The onRequest hook above guards /api/* only, so the
  // gateway is deliberately outside APP_AUTH_TOKEN: agents authenticate with
  // their own per-run credential, which the service mints and can revoke.
  await registerGateway(app, config, service);

  // The downstream the gateway forwards authorized tool calls to. Also outside
  // the browser hook, and guarded instead by a credential only the gateway
  // holds — so the authorization check cannot be walked around by calling here.
  await registerMockTools(app, config, service);

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/users", async () => ({ users: service.listUsers() }));

  // The operator's other lever, beside revocation: change what a human may do
  // rather than cutting one run off. It takes effect on that human's Agents'
  // next gateway call, with no token event of any kind, because permissions are
  // read from the store per call and were never in the credential.
  app.patch("/api/users/:id", async (request) => {
    const { id } = userIdParams.parse(request.params);
    const body = updateUserBody.parse(request.body);
    return { user: await service.setUserRole(id, body.role) };
  });

  // The Operator Console's three reads. Behind the shared token like the rest
  // of /api, and read-only: the console displays what the server decided and
  // triggers the two levers that already exist. It enforces nothing.
  app.get("/api/operator/audit", async () => ({
    audit: service.listAuditRecords(),
  }));

  app.get("/api/operator/sessions", async () => ({
    sessions: service.listSessionClaims(),
  }));

  app.get("/api/operator/docs", async () => ({
    docs: service.listDocumentMetadata(),
  }));

  // The human half of the document surface. Scoped by the same `visibleTo` the
  // gateway scopes an Agent's search with — the symmetry is the point, and it
  // is why there is no operator override here: the console's metadata-only
  // table is the all-seeing view, and it carries no content.
  app.get("/api/docs", async (request) => ({
    docs: service.listVisibleDocuments(actingUser(request, service).id),
  }));

  // Upload: create-only. The server generates the id and stamps the acting
  // human as owner; the body may name neither. Visibility is chosen here and
  // never changed, because there is nothing that changes it.
  app.post("/api/docs", async (request, reply) => {
    const body = createDocumentBody.parse(request.body);
    const doc = await service.createDocument(
      body,
      actingUser(request, service).id,
    );
    return reply.code(201).send({ doc });
  });

  app.get("/api/agents", async () => ({ agents: service.listAgents() }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(
      body,
      actingUser(request, service).id,
    );
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(id) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(id) };
  });

  // Under /api, so the browser hook guards it: revocation is an operator
  // action, not something an Agent may perform on itself.
  app.post("/api/agents/:id/revoke", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.revokeAgentSessions(id);
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { messages: service.getMessages(id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { runs: service.getRuns(id) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content);
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(id) };
  });

  // What the gateway decided during this Run, and why. Under /api like every
  // browser route: the evidence is the operator's to read, never the Agent's.
  app.get("/api/runs/:id/audit", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { audit: service.getRunAudit(id) };
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}

/**
 * Installed before any route is registered: an encapsulated plugin captures the
 * error handler in force when it boots, so a handler set afterwards would leave
 * the gateway and tool scopes on Fastify's default — which answers a rejected
 * body with a bare 500 instead of the 400 the caller earned.
 */
function setErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });
}
