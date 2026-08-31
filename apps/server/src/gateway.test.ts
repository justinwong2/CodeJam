import type { FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { clearOwnerMeters, resetRunMeters } from "./gateway.js";
import { signRunJwt, type RunJwtClaims } from "./run-jwt.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AuditRecord,
  Role,
  RunnerRequest,
  RunnerResult,
  RunSession,
  User,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const ARK_KEY = "gateway-test-upstream-key";
const GATEWAY_SECRET = "gateway-test-signing-secret";

function liveSession(overrides: Partial<RunSession> = {}): RunSession {
  return {
    runId: "run-1",
    agentId: "agent-1",
    ownerId: "user-a",
    jwtId: "session-1",
    revoked: false,
    createdAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    ...overrides,
  };
}

/** Everything the gateway filed through the stub service, oldest first. */
const stubAudit: AuditRecord[] = [];

/**
 * What role the stub resolves for an owner. Every gateway route now reads the
 * owner's role per call — the model proxy included — so the stub has to hold
 * one, and a test can change it to make the same credential mean less.
 */
const stubRoles = new Map<string, Role>();
const stubAgentGrants = new Map<string, Agent["toolGrants"]>();

/**
 * The ceiling and the settled spend the store would hold. Both default to the
 * unbounded case so every test that is not about budgets is unaffected by one.
 */
const stubBudgets = new Map<string, number>();
const stubSettledTokens = new Map<string, number>();

/**
 * Runs whose real usage has landed. A Run in this set has been measured, so the
 * gateway's estimate for it must stop counting — otherwise the same tokens are
 * charged twice, once guessed and once exact.
 */
const stubSettledRuns = new Set<string>();

/** The control-plane half of the credential: only these sessions are live. */
function serviceWith(...sessions: RunSession[]): AgentService {
  stubAudit.length = 0;
  stubRoles.clear();
  stubAgentGrants.clear();
  stubBudgets.clear();
  stubSettledTokens.clear();
  stubSettledRuns.clear();
  resetRunMeters();
  return {
    listAgents: () => [],
    systemInfo: async () => ({}),
    findRunSession: (jwtId: string) =>
      sessions.find((session) => session.jwtId === jwtId),
    // The Agent and its owner, as the store would hold them: a principal is
    // assembled from these on every call, never from the credential's claims.
    findAgent: (id: string): Agent | undefined => {
      const session = sessions.find((item) => item.agentId === id);
      return session
        ? ({
            id,
            ownerId: session.ownerId,
            toolGrants: stubAgentGrants.get(id) ?? null,
          } as Agent)
        : undefined;
    },
    findUser: (id: string): User | undefined => ({
      id,
      name: id,
      role: stubRoles.get(id) ?? "admin",
      tokenBudget: stubBudgets.get(id) ?? 0,
      budgetResetAt: null,
    }),
    // Settled spend, as completed Runs would have reported it. Zero unless a
    // test says otherwise, so the ceiling is only ever the subject of the
    // tests that are about it.
    sumOwnerTokens: (ownerId: string): number =>
      stubSettledTokens.get(ownerId) ?? 0,
    hasRunSettled: (runId: string): boolean => stubSettledRuns.has(runId),
    appendAuditRecord: async (record: AuditRecord) => {
      stubAudit.push(record);
    },
  } as unknown as AgentService;
}

/** Like `serviceWith`, but the store refuses every audit write. */
function serviceWithBrokenAudit(...sessions: RunSession[]): AgentService {
  const service = serviceWith(...sessions) as unknown as {
    appendAuditRecord: () => Promise<void>;
  };
  service.appendAuditRecord = async () => {
    throw new Error("the store is not taking records");
  };
  return service as unknown as AgentService;
}

const temporaryDirectories: string[] = [];

/** A real service over a temporary store, for the end-to-end revocation path. */
async function realService(
  arkBaseUrl: string,
  runner: {
    run: (request: RunnerRequest) => Promise<RunnerResult>;
    cancel: () => Promise<boolean>;
    isAvailable: () => Promise<boolean>;
  },
): Promise<{ service: AgentService; config: ReturnType<typeof loadConfig> }> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-gateway-test-"));
  temporaryDirectories.push(root);
  const config = configFor(arkBaseUrl, {
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return { service, config };
}

function credentialFor(
  session: RunSession,
  overrides: Partial<RunJwtClaims> = {},
): string {
  return signRunJwt(GATEWAY_SECRET, {
    jti: session.jwtId,
    agentId: session.agentId,
    ownerId: session.ownerId,
    runId: session.runId,
    exp: Math.floor(Date.parse(session.expiresAt) / 1_000),
    ...overrides,
  });
}

function configFor(
  arkBaseUrl: string,
  extra: Record<string, string> = {},
): ReturnType<typeof loadConfig> {
  return loadConfig({
    NODE_ENV: "test",
    GATEWAY_JWT_SECRET: GATEWAY_SECRET,
    ARK_API_KEY: ARK_KEY,
    ARK_MODEL: "ep-test",
    ARK_BASE_URL: arkBaseUrl,
    ...extra,
  });
}

interface UpstreamCall {
  method: string;
  url: string;
  authorization: string;
  contentType: string;
  body: string;
}

interface Upstream {
  baseUrl: string;
  calls: UpstreamCall[];
}

const openServers: Server[] = [];

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function startUpstream(
  handler: (
    call: UpstreamCall,
    response: Parameters<Parameters<typeof createServer>[0]>[1],
  ) => void | Promise<void>,
): Promise<Upstream> {
  const calls: UpstreamCall[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const call: UpstreamCall = {
        method: request.method ?? "",
        url: request.url ?? "",
        authorization: request.headers.authorization ?? "",
        contentType: request.headers["content-type"] ?? "",
        body: await readBody(request),
      };
      calls.push(call);
      await handler(call, response);
    })();
  });
  openServers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, calls };
}

async function startEchoUpstream(): Promise<Upstream> {
  return startUpstream((_call, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_1", status: "completed" }));
  });
}

async function closeOpenServers(): Promise<void> {
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (!server) continue;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("Model gateway", () => {
  afterEach(closeOpenServers);

  it("swaps the agent token for the upstream key and forwards the body byte-for-byte", async () => {
    const upstream = await startEchoUpstream();
    const session = liveSession();
    const app = await createApp(
      configFor(upstream.baseUrl),
      serviceWith(session),
    );

    // Deliberately awkward payload: unicode, doubled spaces, trailing newline.
    const payload = '{"model":"ep-test","input":"héllo  wörld"}\n';
    const runJwt = credentialFor(session);
    const response = await app.inject({
      method: "POST",
      url: "/gateway/v1/responses",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${runJwt}`,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "resp_1", status: "completed" });
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0];
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe("/responses");
    expect(call?.authorization).toBe(`Bearer ${ARK_KEY}`);
    expect(call?.authorization).not.toContain(runJwt);
    expect(call?.contentType).toBe("application/json");
    expect(call?.body).toBe(payload);
    await app.close();
  });

  it("files exactly one allow record, and files it before it answers", async () => {
    const upstream = await startEchoUpstream();
    const session = liveSession();
    const app = await createApp(
      configFor(upstream.baseUrl),
      serviceWith(session),
    );

    const response = await app.inject({
      method: "POST",
      url: "/gateway/v1/responses",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credentialFor(session)}`,
      },
      payload: '{"model":"ep-test"}',
    });

    expect(response.statusCode).toBe(200);
    // Asserted the instant the reply resolves: evidence written afterwards
    // would leave a window where the agent knows more than the store does.
    expect(stubAudit).toHaveLength(1);
    expect(stubAudit[0]).toMatchObject({
      humanId: "user-a",
      agentId: "agent-1",
      runId: "run-1",
      tool: "model",
      resource: null,
      decision: "allow",
    });
    expect(stubAudit[0]?.reason.length).toBeGreaterThan(0);
    await app.close();
  });

  it("keeps the record free of the prompt and the reply it authorized", async () => {
    const upstream = await startUpstream((_call, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output_text: "the model said this" }));
    });
    const session = liveSession();
    const app = await createApp(
      configFor(upstream.baseUrl),
      serviceWith(session),
    );

    await app.inject({
      method: "POST",
      url: "/gateway/v1/responses",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credentialFor(session)}`,
      },
      payload: JSON.stringify({ input: "the agent asked this" }),
    });

    // A record is evidence about a decision, not a second copy of the turn.
    const persisted = JSON.stringify(stubAudit);
    expect(persisted).not.toContain("the agent asked this");
    expect(persisted).not.toContain("the model said this");
    expect(persisted).not.toContain(ARK_KEY);
    await app.close();
  });

  it("stops an allowed call whose record the store would not take", async () => {
    const upstream = await startEchoUpstream();
    const session = liveSession();
    const app = await createApp(
      configFor(upstream.baseUrl),
      serviceWithBrokenAudit(session),
    );

    const response = await app.inject({
      method: "POST",
      url: "/gateway/v1/responses",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credentialFor(session)}`,
      },
      payload: '{"model":"ep-test"}',
    });

    // An allowed call the store cannot vouch for is worse than a failed one:
    // the forward never happens, so no upstream work goes unrecorded.
    expect(response.statusCode).toBe(500);
    expect(upstream.calls).toHaveLength(0);
    expect(response.body).not.toContain(ARK_KEY);
    await app.close();
  });

  it("lets a denial stand when its record could not be written", async () => {
    const upstream = await startEchoUpstream();
    const session = liveSession({ revoked: true });
    const app = await createApp(
      configFor(upstream.baseUrl),
      serviceWithBrokenAudit(session),
    );

    const response = await app.inject({
      method: "POST",
      url: "/gateway/v1/responses",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credentialFor(session)}`,
      },
      payload: '{"model":"ep-test"}',
    });

    // Evidence trouble must never rescue the caller: the refusal is what it
    // was, and the upstream stays untouched.
    expect(response.statusCode).toBe(401);
    expect(upstream.calls).toHaveLength(0);
    await app.close();
  });

  it("accepts a body far larger than the app-level limit", async () => {
    const upstream = await startEchoUpstream();
    const session = liveSession();
    const app = await createApp(
      configFor(upstream.baseUrl),
      serviceWith(session),
    );

    // The app-level limit is 1 MiB; a real turn's context easily exceeds it.
    const payload = JSON.stringify({ input: "x".repeat(1_500_000) });
    const response = await app.inject({
      method: "POST",
      url: "/gateway/v1/responses",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credentialFor(session)}`,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(upstream.calls[0]?.body.length).toBe(payload.length);
    await app.close();
  });

  it("stays outside the browser token hook, which guards /api only", async () => {
    const upstream = await startEchoUpstream();
    const session = liveSession();
    const app = await createApp(
      configFor(upstream.baseUrl, { APP_AUTH_TOKEN: "a-strong-test-token" }),
      serviceWith(session),
    );

    // The agent is a different principal: it holds a run credential and never
    // the browser's shared token.
    const response = await app.inject({
      method: "POST",
      url: "/gateway/v1/responses",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credentialFor(session)}`,
      },
      payload: "{}",
    });
    expect(response.statusCode).toBe(200);

    const browserRoute = await app.inject({
      method: "GET",
      url: "/api/agents",
    });
    expect(browserRoute.statusCode).toBe(401);
    await app.close();
  });

  it("returns a bare 502 when the upstream is unreachable", async () => {
    // Grab a port the OS just released so the connection is refused.
    const placeholder = createServer();
    await new Promise<void>((resolve) =>
      placeholder.listen(0, "127.0.0.1", () => resolve()),
    );
    const { port } = placeholder.address() as AddressInfo;
    await new Promise<void>((resolve) => placeholder.close(() => resolve()));

    const session = liveSession();
    const app = await createApp(
      configFor(`http://127.0.0.1:${port}`),
      serviceWith(session),
    );

    const response = await app.inject({
      method: "POST",
      url: "/gateway/v1/responses",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credentialFor(session)}`,
      },
      payload: "{}",
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "Upstream model request failed" });
    expect(response.body).not.toContain(ARK_KEY);
    expect(response.body).not.toContain(String(port));
    await app.close();
  });

  it("streams an SSE upstream through unbuffered", async () => {
    let ackFirstChunk = () => {};
    const firstChunkSeen = new Promise<void>((resolve) => {
      ackFirstChunk = resolve;
    });
    let ackedBeforeSecondWrite = false;

    const upstream = await startUpstream(async (_call, response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.write('event: chunk\ndata: {"delta":"one"}\n\n');
      // If the gateway buffered, the client cannot ack and this times out.
      ackedBeforeSecondWrite = await Promise.race([
        firstChunkSeen.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 3_000),
        ),
      ]);
      response.write('event: chunk\ndata: {"delta":"two"}\n\n');
      response.end("event: done\ndata: [DONE]\n\n");
    });

    const session = liveSession();
    const app = await createApp(
      configFor(upstream.baseUrl),
      serviceWith(session),
    );
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;

    const streamed = await fetch(
      `http://127.0.0.1:${address.port}/gateway/v1/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credentialFor(session)}`,
        },
        body: JSON.stringify({ model: "ep-test", stream: true }),
      },
    );

    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("content-type")).toBe("text/event-stream");

    const reader = streamed.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    const received: string[] = [];
    for (;;) {
      const next = await reader!.read();
      if (next.done) break;
      received.push(decoder.decode(next.value));
      ackFirstChunk();
    }

    expect(ackedBeforeSecondWrite).toBe(true);
    expect(received.length).toBeGreaterThan(1);
    const body = received.join("");
    expect(body).toContain('event: chunk\ndata: {"delta":"one"}\n\n');
    expect(body).toContain('event: chunk\ndata: {"delta":"two"}\n\n');
    expect(body).toContain("event: done\ndata: [DONE]\n\n");
    await app.close();
  });
});

describe("Model gateway token budget", () => {
  afterEach(closeOpenServers);

  /** A model call of a known size, so a test can spend a predictable amount. */
  const callModel = (app: FastifyInstance, session: RunSession, padding = 0) =>
    app.inject({
      method: "POST",
      url: "/gateway/v1/responses",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${credentialFor(session)}`,
      },
      payload: JSON.stringify({ model: "ep-test", input: "x".repeat(padding) }),
    });

  it("checks the Agent grant before budget and charges a grant denial nothing", async () => {
    const upstream = await startEchoUpstream();
    const session = liveSession();
    const app = await createApp(
      configFor(upstream.baseUrl),
      serviceWith(session),
    );
    stubBudgets.set("user-a", 1_100);
    stubAgentGrants.set("agent-1", ["docs"]);

    const denied = await callModel(app, session, 4_000);
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as { error: string }).error).toContain(
      "not delegated",
    );

    // The refused large call consumed no allowance. Once the model is granted,
    // a small call still fits and is the only request Ark receives.
    stubAgentGrants.set("agent-1", ["model"]);
    expect((await callModel(app, session)).statusCode).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    expect(stubAudit.map((record) => record.decision)).toEqual([
      "deny",
      "allow",
    ]);
    await app.close();
  });

  it("forwards while the owner is under the ceiling, and says how much is left", async () => {
    const upstream = await startEchoUpstream();
    const session = liveSession();
    const app = await createApp(
      configFor(upstream.baseUrl),
      serviceWith(session),
    );
    stubBudgets.set("user-a", 1_000_000);

    const response = await callModel(app, session);

    expect(response.statusCode).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    // The running total rides in the allow record's reason, so the evidence
    // panel shows spend climbing rather than a refusal arriving from nowhere.
    expect(stubAudit).toHaveLength(1);
    expect(stubAudit[0]?.decision).toBe("allow");
    expect(stubAudit[0]?.reason).toContain("1,000,000");
    await app.close();
  });

  it("denies with 402 once settled spend has used the ceiling up, and never calls Ark", async () => {
    const upstream = await startEchoUpstream();
    const session = liveSession();
    const app = await createApp(
      configFor(upstream.baseUrl),
      serviceWith(session),
    );
    stubBudgets.set("user-a", 1_000);
    stubSettledTokens.set("user-a", 1_000);

    const response = await callModel(app, session);

    // 402, not 403: the call was authorized and refused anyway.
    expect(response.statusCode).toBe(402);
    expect((response.json() as { error: string }).error).toContain("exhausted");
    // The half that makes it enforcement rather than metering: the Ark key was
    // never spent, so there is nothing to reconcile afterwards.
    expect(upstream.calls).toEqual([]);
    expect(stubAudit).toHaveLength(1);
    expect(stubAudit[0]).toMatchObject({ tool: "model", decision: "deny" });
    expect(stubAudit[0]?.reason).toContain("exhausted");
    await app.close();
  });

  it("stops a Run that is spending right now, not after it has finished", async () => {
    // The failure the ceiling exists for. Settled spend is zero throughout —
    // a Run reports usage only when it completes — so a ceiling counting only
    // finished Runs would forward every one of these.
    const upstream = await startEchoUpstream();
    const session = liveSession();
    const app = await createApp(
      configFor(upstream.baseUrl),
      serviceWith(session),
    );
    // Padding of 4n bytes is about n estimated tokens.
    stubBudgets.set("user-a", 2_500);

    const first = await callModel(app, session, 4_000);
    const second = await callModel(app, session, 4_000);
    const third = await callModel(app, session, 4_000);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(402);
    expect(upstream.calls).toHaveLength(2);
    expect(stubAudit.map((record) => record.decision)).toEqual([
      "allow",
      "allow",
      "deny",
    ]);
    await app.close();
  });

  it("adds up the calls a Run makes, because each one costs something", async () => {
    // Measured against real usage: a Run making ten calls cost ~50,000 tokens
    // where its largest single call was ~5,000. Ark resumes the thread
    // server-side, so a request carries its own turn rather than the whole
    // conversation — taking a maximum here would under-count tenfold.
    const upstream = await startEchoUpstream();
    const session = liveSession();
    const app = await createApp(
      configFor(upstream.baseUrl),
      serviceWith(session),
    );
    stubBudgets.set("user-a", 10_000);

    // Ten calls at ~1,000 estimated apiece is ~10,000 — the ceiling exactly.
    for (let call = 0; call < 9; call += 1) {
      expect((await callModel(app, session, 4_000)).statusCode).toBe(200);
    }
    expect((await callModel(app, session, 4_000)).statusCode).toBe(402);

    expect(upstream.calls).toHaveLength(9);
    await app.close();
  });

  it("charges only what was forwarded, so a denial does not deepen the debt", async () => {
    const upstream = await startEchoUpstream();
    const session = liveSession();
    const app = await createApp(
      configFor(upstream.baseUrl),
      serviceWith(session),
    );
    stubBudgets.set("user-a", 2_500);

    await callModel(app, session, 4_000);
    await callModel(app, session, 4_000);
    expect((await callModel(app, session, 4_000)).statusCode).toBe(402);
    // A refused call costs nothing, so a ceiling raised by one call's worth
    // admits exactly one more rather than being swallowed by a phantom charge.
    stubBudgets.set("user-a", 3_500);
    expect((await callModel(app, session, 4_000)).statusCode).toBe(200);

    expect(upstream.calls).toHaveLength(3);
    await app.close();
  });

  it("forgets what another Run of the same owner had spent when spend is reset", async () => {
    // A Run that stopped without reporting usage leaves its estimate standing —
    // it is the only account of what it spent. Resetting is what clears it, and
    // the next Run of that owner starts from what it alone is spending.
    const upstream = await startEchoUpstream();
    const earlier = liveSession();
    const current = liveSession({
      runId: "run-2",
      agentId: "agent-1",
      jwtId: "session-2",
    });
    const app = await createApp(
      configFor(upstream.baseUrl),
      serviceWith(earlier, current),
    );
    stubBudgets.set("user-a", 2_500);

    // The earlier Run leaves ~2,000 estimated behind it.
    await callModel(app, earlier, 8_000);
    // Which is enough to refuse the next Run's very first call.
    expect((await callModel(app, current, 4_000)).statusCode).toBe(402);

    clearOwnerMeters("user-a");

    expect((await callModel(app, current, 4_000)).statusCode).toBe(200);
    expect(upstream.calls).toHaveLength(2);
    await app.close();
  });

  it("clears only the owner whose spend was reset", async () => {
    const upstream = await startEchoUpstream();
    const mine = liveSession();
    const theirs = liveSession({
      runId: "run-2",
      agentId: "agent-2",
      ownerId: "user-b",
      jwtId: "session-2",
    });
    const app = await createApp(
      configFor(upstream.baseUrl),
      serviceWith(mine, theirs),
    );
    stubSettledTokens.set("user-a", 1_600);
    stubSettledTokens.set("user-b", 1_600);
    stubBudgets.set("user-a", 2_500);
    stubBudgets.set("user-b", 2_500);

    // Both owners are close enough to their ceiling that a call tips them over.
    expect((await callModel(app, mine, 4_000)).statusCode).toBe(402);
    expect((await callModel(app, theirs, 4_000)).statusCode).toBe(402);

    // Only one of them is forgiven.
    stubSettledTokens.set("user-a", 0);
    clearOwnerMeters("user-a");

    expect((await callModel(app, mine, 4_000)).statusCode).toBe(200);
    expect((await callModel(app, theirs, 4_000)).statusCode).toBe(402);
    await app.close();
  });

  it("lets a raised ceiling take effect on the very next call", async () => {
    // The operator's lever, same shape as a role change: a store write that the
    // next gateway call reads. No restart, and no token event of any kind.
    const upstream = await startEchoUpstream();
    const session = liveSession();
    const app = await createApp(
      configFor(upstream.baseUrl),
      serviceWith(session),
    );
    stubBudgets.set("user-a", 1_000);
    stubSettledTokens.set("user-a", 1_000);

    expect((await callModel(app, session)).statusCode).toBe(402);
    stubBudgets.set("user-a", 100_000);
    expect((await callModel(app, session)).statusCode).toBe(200);

    expect(upstream.calls).toHaveLength(1);
    await app.close();
  });

  it("holds one owner's spending against another owner's ceiling not at all", async () => {
    // The ceiling is the human's, so one owner exhausting theirs must not
    // refuse an Agent belonging to somebody else.
    const upstream = await startEchoUpstream();
    const mine = liveSession();
    const theirs = liveSession({
      runId: "run-2",
      agentId: "agent-2",
      ownerId: "user-b",
      jwtId: "session-2",
    });
    const app = await createApp(
      configFor(upstream.baseUrl),
      serviceWith(mine, theirs),
    );
    stubBudgets.set("user-a", 1_000);
    stubSettledTokens.set("user-a", 1_000);
    stubBudgets.set("user-b", 100_000);

    expect((await callModel(app, mine)).statusCode).toBe(402);
    expect((await callModel(app, theirs)).statusCode).toBe(200);
    await app.close();
  });

  it("forwards without limit when no ceiling is set", async () => {
    // The seeded default for a human the store predates. A budget nobody
    // configured must not strand every Agent on the platform.
    const upstream = await startEchoUpstream();
    const session = liveSession();
    const app = await createApp(
      configFor(upstream.baseUrl),
      serviceWith(session),
    );
    stubBudgets.set("user-a", 0);
    stubSettledTokens.set("user-a", 10_000_000);

    const response = await callModel(app, session, 40_000);

    expect(response.statusCode).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    await app.close();
  });

  it("stops estimating a Run once its real usage has landed", async () => {
    // The double-count this guards: an estimate and a measurement of the same
    // tokens. Nothing tells the gateway a Run ended, so a finished Run's meter
    // would otherwise stand for its whole TTL — while the store already holds
    // what that Run really cost.
    const upstream = await startEchoUpstream();
    const finished = liveSession();
    const next = liveSession({
      runId: "run-2",
      agentId: "agent-1",
      jwtId: "session-2",
    });
    const app = await createApp(
      configFor(upstream.baseUrl),
      serviceWith(finished, next),
    );
    stubBudgets.set("user-a", 2_500);

    // The first Run leaves ~2,000 estimated behind it.
    await callModel(app, finished, 8_000);
    expect((await callModel(app, next, 4_000)).statusCode).toBe(402);

    // It then reports what it actually cost — less than the guess, as an
    // estimate blind to caching tends to be. The measurement supersedes the
    // estimate rather than stacking on top of it.
    stubSettledRuns.add("run-1");
    stubSettledTokens.set("user-a", 400);

    const afterSettling = await callModel(app, next, 4_000);

    // 400 settled + ~1,000 for this call, against 2,500. Had the estimate kept
    // counting, it would be ~3,400 and refused.
    expect(afterSettling.statusCode).toBe(200);
    expect(upstream.calls).toHaveLength(2);
    await app.close();
  });

  it("refuses a suspended owner by role, not by budget", async () => {
    // Ordering: the coarser failure names itself first. "They may not" and
    // "they cannot afford to" are different facts and must not be confused in
    // the trail an operator reads.
    const upstream = await startEchoUpstream();
    const session = liveSession();
    const app = await createApp(
      configFor(upstream.baseUrl),
      serviceWith(session),
    );
    stubRoles.set("user-a", "suspended");
    stubBudgets.set("user-a", 1);
    stubSettledTokens.set("user-a", 1_000_000);

    const response = await callModel(app, session);

    expect(response.statusCode).toBe(403);
    expect(stubAudit[0]?.reason).toContain("may not use the model tool");
    expect(upstream.calls).toEqual([]);
    await app.close();
  });
});

describe("Model gateway authentication", () => {
  afterEach(closeOpenServers);

  /**
   * Every rejection is proven twice: the caller is denied *and* the upstream
   * was never asked. A gateway that forwarded first and denied afterwards
   * would already have spent the Ark key.
   */
  async function expectDenied(
    session: RunSession | null,
    headers: Record<string, string>,
  ): Promise<void> {
    const upstream = await startEchoUpstream();
    const app = await createApp(
      configFor(upstream.baseUrl),
      session ? serviceWith(session) : serviceWith(),
    );
    const response = await app.inject({
      method: "POST",
      url: "/gateway/v1/responses",
      headers: { "content-type": "application/json", ...headers },
      payload: '{"model":"ep-test"}',
    });
    expect(response.statusCode).toBe(401);
    expect(upstream.calls).toHaveLength(0);
    expect(response.body).not.toContain(ARK_KEY);
    expect(response.body).not.toContain(GATEWAY_SECRET);
    // Whatever the gateway could attribute, it never files a rejection twice
    // and never files one as anything but a denial.
    expect(stubAudit.length).toBeLessThanOrEqual(1);
    for (const record of stubAudit) {
      expect(record).toMatchObject({ tool: "model", decision: "deny" });
    }
    expect(JSON.stringify(stubAudit)).not.toContain(GATEWAY_SECRET);
    await app.close();
  }

  it("denies a request carrying no credential at all", async () => {
    await expectDenied(liveSession(), {});
  });

  it("denies a credential that is not a bearer token", async () => {
    const session = liveSession();
    await expectDenied(session, {
      authorization: `Basic ${credentialFor(session)}`,
    });
  });

  it("denies a tampered signature", async () => {
    const session = liveSession();
    const [header, claims] = credentialFor(session).split(".");
    await expectDenied(session, {
      authorization: `Bearer ${header}.${claims}.forged-signature`,
    });
  });

  it("denies a credential signed with another key", async () => {
    const session = liveSession();
    const forged = signRunJwt("a-different-signing-secret", {
      jti: session.jwtId,
      agentId: session.agentId,
      ownerId: session.ownerId,
      runId: session.runId,
      exp: Math.floor(Date.now() / 1_000) + 600,
    });
    await expectDenied(session, { authorization: `Bearer ${forged}` });
  });

  it("denies an expired credential even when its session is still live", async () => {
    const session = liveSession();
    await expectDenied(session, {
      authorization: `Bearer ${credentialFor(session, {
        exp: Math.floor(Date.now() / 1_000) - 5,
      })}`,
    });
  });

  it("denies a credential whose session was never issued", async () => {
    // Correctly signed, unexpired, and unknown: minting is the control plane's
    // job, so a token the store cannot vouch for is worth nothing.
    const orphan = liveSession({ jwtId: "session-that-was-never-stored" });
    await expectDenied(null, {
      authorization: `Bearer ${credentialFor(orphan)}`,
    });
  });

  it("denies a revoked session mid-run", async () => {
    const session = liveSession({ revoked: true });
    await expectDenied(session, {
      authorization: `Bearer ${credentialFor(session)}`,
    });
  });

  it("denies a session that has already expired, whatever the token claims", async () => {
    // Run completion expires the session in place. The token still sitting in
    // the Runtime looks valid, and must stop working anyway.
    const session = liveSession({
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await expectDenied(session, {
      authorization: `Bearer ${credentialFor(session, {
        exp: Math.floor(Date.now() / 1_000) + 600,
      })}`,
    });
  });

  it("denies a credential whose claims disagree with its session", async () => {
    const session = liveSession();
    await expectDenied(session, {
      authorization: `Bearer ${credentialFor(session, {
        agentId: "another-agent",
      })}`,
    });
  });

  it("files the refusal against the run whose session it recognized", async () => {
    const session = liveSession({ revoked: true });
    await expectDenied(session, {
      authorization: `Bearer ${credentialFor(session)}`,
    });

    // The identity comes from the stored session, not from the credential the
    // gateway has just refused to trust.
    expect(stubAudit).toHaveLength(1);
    expect(stubAudit[0]).toMatchObject({
      humanId: "user-a",
      agentId: "agent-1",
      runId: "run-1",
      tool: "model",
      decision: "deny",
      reason: "Run session revoked",
    });
  });

  it("files an expired session's refusal against that run too", async () => {
    const session = liveSession({
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await expectDenied(session, {
      authorization: `Bearer ${credentialFor(session, {
        exp: Math.floor(Date.now() / 1_000) + 600,
      })}`,
    });

    expect(stubAudit).toHaveLength(1);
    expect(stubAudit[0]).toMatchObject({
      runId: "run-1",
      decision: "deny",
      reason: "Run session expired",
    });
  });

  it("attributes a claims-versus-session mismatch to the stored session", async () => {
    const session = liveSession();
    await expectDenied(session, {
      authorization: `Bearer ${credentialFor(session, {
        agentId: "another-agent",
      })}`,
    });

    // The stored session is the identity; the disagreeing claims never are.
    expect(stubAudit).toHaveLength(1);
    expect(stubAudit[0]).toMatchObject({
      agentId: "agent-1",
      runId: "run-1",
      decision: "deny",
      reason: "Run credential does not match",
    });
  });

  it("files nothing for a credential it cannot attribute to any run", async () => {
    const session = liveSession();
    const [header, claims] = credentialFor(session).split(".");
    await expectDenied(session, {
      authorization: `Bearer ${header}.${claims}.forged-signature`,
    });

    // A forged token names a run only if its claims are believed, and they are
    // not. The call is refused and logged; there is no Run to file it under.
    expect(stubAudit).toEqual([]);
  });
});

describe("Tool gateway", () => {
  /**
   * Each fixture holds a run open so its credential stays live, and is released
   * here rather than by every test: a finished run expires its session, which
   * would turn each of these assertions into the 401 slice 2 already covers.
   */
  const openFixtures: {
    app: FastifyInstance;
    finish: () => Promise<void>;
  }[] = [];

  afterEach(async () => {
    while (openFixtures.length > 0) {
      const fixture = openFixtures.pop();
      if (!fixture) continue;
      await fixture.finish();
      await fixture.app.close();
    }
    await closeOpenServers();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  interface ToolFixture {
    app: FastifyInstance;
    service: AgentService;
    /** Every request that reached the tool service, in order. */
    toolCalls: string[];
    /** The stand-in Ark endpoint, so a denied model call can be proven unmade. */
    upstream: Upstream;
    /** Starts a run owned by `userId` and returns its live run credential. */
    runAs: (userId: string) => Promise<string>;
    /** The run ids `runAs` started, in the order it started them. */
    runIds: string[];
    /** The Agent ids `runAs` created, in the same order. */
    agentIds: string[];
    /** What the gateway persisted for a run, read back out of the store. */
    audit: (runId: string) => AuditRecord[];
    /** Rewrites a seeded human's role in the store, as an operator would. */
    setRole: (userId: string, role: Role) => Promise<void>;
    /** Changes the Agent-specific ceiling while its run remains live. */
    setToolGrants: (
      agentId: string,
      toolGrants: Agent["toolGrants"],
    ) => Promise<void>;
  }

  async function toolFixture(): Promise<ToolFixture> {
    const upstream = await startEchoUpstream();
    const runJwts: string[] = [];
    let release!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      release = resolve;
    });
    const { service, config } = await realService(upstream.baseUrl, {
      // The run stays open, so its credential stays live while the test uses it.
      run: (request) => {
        runJwts.push(request.runJwt);
        return pending;
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const app = await createApp(config, service);

    // Instrumentation, not enforcement: it records every request that reaches
    // the tool service so a denial can be proven to have stopped short of it.
    const toolCalls: string[] = [];
    app.addHook("onRequest", async (request) => {
      if (request.url.startsWith("/internal/tools"))
        toolCalls.push(request.url);
    });

    let agents = 0;
    const runIds: string[] = [];
    const agentIds: string[] = [];
    const runAs = async (userId: string): Promise<string> => {
      const created = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: { "x-launchpad-user": userId },
        payload: { name: `Agent for ${userId}` },
      });
      expect(created.statusCode).toBe(201);
      const agentId = (created.json() as { agent: { id: string } }).agent.id;
      agentIds.push(agentId);
      const started = await app.inject({
        method: "POST",
        url: `/api/agents/${agentId}/messages`,
        payload: { content: "use a tool" },
      });
      expect(started.statusCode).toBe(202);
      runIds.push((started.json() as { run: { id: string } }).run.id);
      agents += 1;
      await expect.poll(() => runJwts.length).toBe(agents);
      return runJwts[agents - 1] ?? "";
    };

    // Read straight out of the store rather than through the API, so what is
    // asserted is what was persisted rather than what a route chose to return.
    const store = (service as unknown as { store: JsonStore }).store;
    const audit = (runId: string): AuditRecord[] =>
      store.snapshot().audit.filter((record) => record.runId === runId);

    const setRole = async (userId: string, role: Role): Promise<void> => {
      await store.mutate((database) => {
        for (const user of database.users) {
          if (user.id === userId) user.role = role;
        }
      });
    };

    const setToolGrants = async (
      agentId: string,
      toolGrants: Agent["toolGrants"],
    ): Promise<void> => {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/agents/${agentId}`,
        payload: { toolGrants },
      });
      expect(response.statusCode).toBe(200);
    };

    openFixtures.push({
      app,
      finish: async () => {
        release({ output: "done", threadId: null, usage: null });
        await expect
          .poll(() =>
            runIds.every((runId) =>
              ["completed", "failed", "cancelled"].includes(
                service.getRun(runId).status,
              ),
            ),
          )
          .toBe(true);
      },
    });
    return {
      app,
      service,
      toolCalls,
      upstream,
      runAs,
      runIds,
      agentIds,
      audit,
      setRole,
      setToolGrants,
    };
  }

  const callTool = (app: FastifyInstance, runJwt: string, url: string) =>
    app.inject({
      method: url.startsWith("payments") ? "POST" : "GET",
      url: `/gateway/v1/tools/${url}`,
      headers: {
        authorization: `Bearer ${runJwt}`,
        "content-type": "application/json",
      },
      ...(url.startsWith("payments")
        ? { payload: JSON.stringify({ amount: 25, currency: "usd" }) }
        : {}),
    });

  it("forwards every tool an admin's Agent is granted", async () => {
    const { app, toolCalls, runAs } = await toolFixture();
    const runJwt = await runAs("user-a");

    const doc = await callTool(app, runJwt, "docs/doc-a1");
    expect(doc.statusCode).toBe(200);
    expect((doc.json() as { doc: { id: string } }).doc.id).toBe("doc-a1");

    const search = await callTool(app, runJwt, "search?q=gateway");
    expect(search.statusCode).toBe(200);
    // A's own private plan and the public entry, both of which mention it.
    expect(
      (search.json() as { results: { id: string }[] }).results.map(
        (result) => result.id,
      ),
    ).toEqual(["doc-a1", "kb-1"]);

    const payment = await callTool(app, runJwt, "payments");
    expect(payment.statusCode).toBe(201);
    expect(payment.json()).toMatchObject({ status: "accepted", amount: 25 });

    // Each authorized call reached the tool service exactly once, with the
    // path and query it was made with.
    expect(toolCalls).toEqual([
      "/internal/tools/docs/doc-a1",
      "/internal/tools/search?q=gateway",
      "/internal/tools/payments",
    ]);
  });

  it("denies a basic role the payments tool without calling it", async () => {
    const fixture = await toolFixture();
    const runJwt = await fixture.runAs("user-b");

    const response = await callTool(fixture.app, runJwt, "payments");

    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: string }).error).toContain(
      "may not use the payments tool",
    );
    // The half that makes it enforcement: the tool was never reached, so there
    // is nothing to undo and nothing that briefly happened anyway.
    expect(fixture.toolCalls).toEqual([]);
  });

  it("denies a basic role's Agent by role before it can learn a document exists", async () => {
    // The role check runs first on purpose: an unknown and a forbidden document
    // must not be distinguishable to a caller who may not use the tool at all.
    const fixture = await toolFixture();
    const runJwt = await fixture.runAs("user-b");
    const response = await fixture.app.inject({
      method: "GET",
      url: "/gateway/v1/tools/payments/invoice-a1",
      headers: { authorization: `Bearer ${runJwt}` },
    });
    expect(response.statusCode).toBe(403);
    expect(fixture.toolCalls).toEqual([]);
  });

  it("makes another owner's private document indistinguishable from a nonexistent one", async () => {
    // The ADR's verification, as an assertion: an agent that guesses ids must
    // not be able to tell a wrong guess from a forbidden hit, or it can map
    // other humans' documents without ever reading one.
    const fixture = await toolFixture();
    const before = fixture.service.findMockDoc("doc-a1");
    const runJwt = await fixture.runAs("user-b");

    const denied = await callTool(fixture.app, runJwt, "docs/doc-a1");
    const missing = await callTool(fixture.app, runJwt, "docs/doc-zzz");

    // Byte-identical, not merely equivalent: the same status, the same bytes.
    expect(denied.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(denied.body).toBe(missing.body);
    expect(denied.body).toBe('{"error":"Document not found"}');
    expect(denied.headers["content-type"]).toBe(
      missing.headers["content-type"],
    );

    // Fails closed twice over: nothing was forwarded on either call, and the
    // document the answer denies the existence of is exactly as it was.
    expect(fixture.toolCalls).toEqual([]);
    expect(fixture.service.findMockDoc("doc-a1")).toEqual(before);
    expect(denied.body).not.toContain("quarterly plan");
    expect(denied.body).not.toContain("user-a");
  });

  it("tells the operator the truth it did not tell the agent", async () => {
    const fixture = await toolFixture();
    const runJwt = await fixture.runAs("user-b");

    await callTool(fixture.app, runJwt, "docs/doc-a1");
    await callTool(fixture.app, runJwt, "docs/doc-zzz");

    // Same answer to the agent, different rows in the evidence: the ownership
    // denial names the owner it protected, the wrong guess says what it was.
    const records = fixture.audit(fixture.runIds[0] ?? "");
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      tool: "docs",
      resource: "docs/doc-a1",
      decision: "deny",
    });
    expect(records[0]?.reason).toContain("resource owned by user-a");
    expect(records[1]).toMatchObject({
      tool: "docs",
      resource: "docs/doc-zzz",
      decision: "deny",
      reason: "Document not found",
    });
    // Evidence about a decision, never a copy of what was protected.
    expect(JSON.stringify(records)).not.toContain("quarterly plan");
  });

  it("lets any granted role read a public document it does not own", async () => {
    const fixture = await toolFixture();
    const runJwt = await fixture.runAs("user-b");

    const response = await callTool(fixture.app, runJwt, "docs/kb-1");

    expect(response.statusCode).toBe(200);
    const doc = (response.json() as { doc: { ownerId: string } }).doc;
    // Public widens who may read it and leaves ownership exactly where it was.
    expect(doc.ownerId).toBe("user-a");
    expect(fixture.toolCalls).toEqual(["/internal/tools/docs/kb-1"]);
    expect(fixture.audit(fixture.runIds[0] ?? "")).toMatchObject([
      { tool: "docs", resource: "docs/kb-1", decision: "allow" },
    ]);
  });

  it("lets an owner read their own document", async () => {
    const fixture = await toolFixture();
    const runJwt = await fixture.runAs("user-b");

    const response = await callTool(fixture.app, runJwt, "docs/doc-b1");

    expect(response.statusCode).toBe(200);
    expect((response.json() as { doc: { ownerId: string } }).doc.ownerId).toBe(
      "user-b",
    );
    expect(fixture.toolCalls).toEqual(["/internal/tools/docs/doc-b1"]);
  });

  it("answers 404 for a document nobody owns, without calling the tool", async () => {
    const fixture = await toolFixture();
    const runJwt = await fixture.runAs("user-a");

    const response = await fixture.app.inject({
      method: "GET",
      url: "/gateway/v1/tools/docs/doc-nonexistent",
      headers: { authorization: `Bearer ${runJwt}` },
    });

    expect(response.statusCode).toBe(404);
    expect(fixture.toolCalls).toEqual([]);
  });

  it("scopes a search to what the calling principal may see", async () => {
    // The scope is the gateway's decision, travelling in a header the agent
    // cannot set: a filtered row is invisible in the answer, and the store
    // still holds it — which is why the console's ground-truth table exists.
    const fixture = await toolFixture();
    const runJwt = await fixture.runAs("user-b");

    const response = await callTool(fixture.app, runJwt, "search?q=notes");

    expect(response.statusCode).toBe(200);
    const results = (response.json() as { results: { id: string }[] }).results;
    expect(results.map((result) => result.id)).toEqual(["doc-b1"]);
    // A's private notes match the query and are absent anyway, with nothing in
    // the body hinting they were ever considered.
    expect(response.body).not.toContain("doc-a2");
    expect(response.body).not.toContain("rollout order");
    expect(fixture.service.findMockDoc("doc-a2")).toBeDefined();

    // One record, and it says `search` — filtering is not a denial and leaves
    // no per-row trace, which is exactly why ground truth is displayed beside
    // it rather than inferred from the evidence.
    expect(fixture.audit(fixture.runIds[0] ?? "")).toMatchObject([
      { tool: "search", resource: "search", decision: "allow" },
    ]);
  });

  it("returns an uploaded public document to another human's Agent, and not a private one", async () => {
    // The human listing and the agent's search share one predicate, so what a
    // person uploads is immediately what the other humans' Agents can or cannot
    // find — no second rule, no index to rebuild.
    const fixture = await toolFixture();
    for (const visibility of ["public", "private"] as const) {
      const uploaded = await fixture.app.inject({
        method: "POST",
        url: "/api/docs",
        headers: { "x-launchpad-user": "user-a" },
        payload: {
          title: `A's ${visibility} upload`,
          content: `Uploaded ${visibility} content about kittens.`,
          visibility,
        },
      });
      expect(uploaded.statusCode).toBe(201);
    }
    const runJwt = await fixture.runAs("user-b");

    const response = await callTool(fixture.app, runJwt, "search?q=kittens");

    expect(response.statusCode).toBe(200);
    const results = (response.json() as { results: { title: string }[] })
      .results;
    expect(results.map((result) => result.title)).toEqual([
      "A's public upload",
    ]);
    expect(response.body).not.toContain("Uploaded private content");
  });

  it("gives an agent forging a scope header no say in what it sees", async () => {
    const fixture = await toolFixture();
    const runJwt = await fixture.runAs("user-b");

    const response = await fixture.app.inject({
      method: "GET",
      url: "/gateway/v1/tools/search?q=quarterly",
      headers: {
        authorization: `Bearer ${runJwt}`,
        // The header the tool service reads — set here by the caller, and
        // replaced by the gateway with the scope it decided.
        "x-launchpad-scope": "user-a",
      },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { results: unknown[] }).results).toEqual([]);
    expect(response.body).not.toContain("quarterly plan");
  });

  it("refuses a path that names no tool at all", async () => {
    const fixture = await toolFixture();
    const runJwt = await fixture.runAs("user-a");

    const response = await fixture.app.inject({
      method: "GET",
      url: "/gateway/v1/tools/model/responses",
      headers: { authorization: `Bearer ${runJwt}` },
    });

    expect(response.statusCode).toBe(403);
    expect(fixture.toolCalls).toEqual([]);
  });

  it("files one allow record naming the tool and the resource it reached", async () => {
    const fixture = await toolFixture();
    const runJwt = await fixture.runAs("user-b");

    const response = await callTool(fixture.app, runJwt, "docs/doc-b1");

    expect(response.statusCode).toBe(200);
    // Persisted by the time the agent has its answer, exactly once.
    expect(fixture.audit(fixture.runIds[0] ?? "")).toMatchObject([
      {
        humanId: "user-b",
        tool: "docs",
        resource: "docs/doc-b1",
        decision: "allow",
      },
    ]);
  });

  it("files one deny record carrying the reason can() gave", async () => {
    const fixture = await toolFixture();
    const runJwt = await fixture.runAs("user-b");

    const response = await callTool(fixture.app, runJwt, "payments");

    expect(response.statusCode).toBe(403);
    const records = fixture.audit(fixture.runIds[0] ?? "");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      humanId: "user-b",
      tool: "payments",
      resource: "payments",
      decision: "deny",
    });
    // The record says the same thing the caller was told, in the same words.
    expect(records[0]?.reason).toBe(
      (response.json() as { error: string }).error,
    );
  });

  it("files an ownership denial against the document it protected", async () => {
    const fixture = await toolFixture();
    const runJwt = await fixture.runAs("user-b");

    const response = await callTool(fixture.app, runJwt, "docs/doc-a1");

    // 404 to the agent, `deny` with the real reason to the operator.
    expect(response.statusCode).toBe(404);
    const records = fixture.audit(fixture.runIds[0] ?? "");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      tool: "docs",
      resource: "docs/doc-a1",
      decision: "deny",
    });
    expect(records[0]?.reason).toContain("resource owned by user-a");
    // The record names the document; it never carries what was inside it.
    expect(JSON.stringify(records)).not.toContain("quarterly plan");
  });

  it("files a document that does not exist as a refusal, not as a forward", async () => {
    const fixture = await toolFixture();
    const runJwt = await fixture.runAs("user-a");

    const response = await fixture.app.inject({
      method: "GET",
      url: "/gateway/v1/tools/docs/doc-nonexistent",
      headers: { authorization: `Bearer ${runJwt}` },
    });

    expect(response.statusCode).toBe(404);
    // Nothing was forwarded, so nothing was allowed: one record, and it is a
    // denial. Every answered call leaves exactly one row behind.
    expect(fixture.audit(fixture.runIds[0] ?? "")).toMatchObject([
      { tool: "docs", resource: "docs/doc-nonexistent", decision: "deny" },
    ]);
  });

  it("files a tool it does not proxy under the tool that was named", async () => {
    const fixture = await toolFixture();
    const runJwt = await fixture.runAs("user-a");

    const response = await fixture.app.inject({
      method: "GET",
      url: "/gateway/v1/tools/model/responses",
      headers: { authorization: `Bearer ${runJwt}` },
    });

    expect(response.statusCode).toBe(403);
    expect(fixture.audit(fixture.runIds[0] ?? "")).toMatchObject([
      { tool: "model", decision: "deny" },
    ]);
  });

  it("files nothing for a path that names no tool at all", async () => {
    const fixture = await toolFixture();
    const runJwt = await fixture.runAs("user-a");

    const response = await fixture.app.inject({
      method: "GET",
      url: "/gateway/v1/tools/frobnicate",
      headers: { authorization: `Bearer ${runJwt}` },
    });

    // Still refused, still logged — but a record's `tool` is a tool, and this
    // request named none, so there is nothing truthful to file it under.
    expect(response.statusCode).toBe(403);
    expect(fixture.toolCalls).toEqual([]);
    expect(fixture.audit(fixture.runIds[0] ?? "")).toEqual([]);
  });

  /** The model call an agent makes, through the same credential a tool uses. */
  const callModel = (app: FastifyInstance, runJwt: string) =>
    app.inject({
      method: "POST",
      url: "/gateway/v1/responses",
      headers: {
        authorization: `Bearer ${runJwt}`,
        "content-type": "application/json",
      },
      payload: '{"model":"ep-test"}',
    });

  it("runs the model call through the owner's role like any other tool", async () => {
    const fixture = await toolFixture();
    const runJwt = await fixture.runAs("user-b");

    // A role that grants `model` still forwards, and the record says so.
    const allowed = await callModel(fixture.app, runJwt);
    expect(allowed.statusCode).toBe(200);
    expect(fixture.upstream.calls).toHaveLength(1);
    expect(fixture.audit(fixture.runIds[0] ?? "")).toMatchObject([
      { humanId: "user-b", tool: "model", resource: null, decision: "allow" },
    ]);
  });

  it("denies a suspended owner's model call without spending the Ark key", async () => {
    const fixture = await toolFixture();
    const runJwt = await fixture.runAs("user-b");
    // Suspension is a store write. The credential is untouched: still signed,
    // still unexpired, still unrevoked — and now worth nothing.
    await fixture.setRole("user-b", "suspended");

    const response = await callModel(fixture.app, runJwt);

    // 403, not 401: the caller is who it says it is and may do nothing.
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: string }).error).toContain(
      "may not use the model tool",
    );
    expect(fixture.upstream.calls).toEqual([]);

    const records = fixture.audit(fixture.runIds[0] ?? "");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      humanId: "user-b",
      tool: "model",
      resource: null,
      decision: "deny",
    });
    expect(records[0]?.reason).toBe(
      (response.json() as { error: string }).error,
    );
  });

  it("denies a suspended owner every tool as well as the model", async () => {
    const fixture = await toolFixture();
    const runJwt = await fixture.runAs("user-b");
    await fixture.setRole("user-b", "suspended");

    // The tools a basic role could use a moment ago, including its own document.
    for (const url of ["docs/doc-b1", "search?q=gateway"]) {
      const response = await callTool(fixture.app, runJwt, url);
      expect(response.statusCode).toBe(403);
      expect((response.json() as { error: string }).error).toContain(
        "suspended",
      );
    }
    expect(fixture.toolCalls).toEqual([]);
    expect(fixture.audit(fixture.runIds[0] ?? "")).toMatchObject([
      { tool: "docs", decision: "deny" },
      { tool: "search", decision: "deny" },
    ]);
  });

  it("denies a model call whose Agent's owner is no longer a known user", async () => {
    const fixture = await toolFixture();
    const runJwt = await fixture.runAs("user-a");
    const store = (fixture.service as unknown as { store: JsonStore }).store;
    await store.mutate((database) => {
      for (const agent of database.agents) agent.ownerId = "user-ghost";
    });

    const response = await callModel(fixture.app, runJwt);

    // No role to resolve is no authority to act with, so the model is refused
    // the same way a tool is rather than falling back to a default.
    expect(response.statusCode).toBe(403);
    expect(fixture.upstream.calls).toEqual([]);
    expect(fixture.audit(fixture.runIds[0] ?? "")).toMatchObject([
      { tool: "model", decision: "deny" },
    ]);
  });

  it("follows a role change mid-run, on the same unexpired credential", async () => {
    const fixture = await toolFixture();
    const runJwt = await fixture.runAs("user-b");
    const runId = fixture.runIds[0] ?? "";

    // Basic: the payments tool is refused.
    const denied = await callTool(fixture.app, runJwt, "payments");
    expect(denied.statusCode).toBe(403);
    expect(fixture.toolCalls).toEqual([]);

    // The operator promotes the owner. No token is reissued and the run is
    // never told: the role lives in the store, and the gateway reads it there.
    const promoted = await fixture.app.inject({
      method: "PATCH",
      url: "/api/users/user-b",
      payload: { role: "admin" },
    });
    expect(promoted.statusCode).toBe(200);

    // Same run, same credential, different answer.
    const allowed = await callTool(fixture.app, runJwt, "payments");
    expect(allowed.statusCode).toBe(201);
    expect(fixture.toolCalls).toEqual(["/internal/tools/payments"]);

    // And back again, so the demotion is proven as live as the promotion.
    const demoted = await fixture.app.inject({
      method: "PATCH",
      url: "/api/users/user-b",
      payload: { role: "basic" },
    });
    expect(demoted.statusCode).toBe(200);
    const deniedAgain = await callTool(fixture.app, runJwt, "payments");
    expect(deniedAgain.statusCode).toBe(403);
    expect(fixture.toolCalls).toEqual(["/internal/tools/payments"]);

    // Three decisions, in order, each carrying the reason it was given for.
    const records = fixture.audit(runId);
    expect(records.map((record) => record.decision)).toEqual([
      "deny",
      "allow",
      "deny",
    ]);
    expect(records[0]?.reason).toContain('Role "basic"');
    expect(records[1]?.reason).toContain('Role "admin"');
    expect(records[2]?.reason).toContain('Role "basic"');
    // Every row is filed against the same run and the same human throughout.
    expect(
      records.every(
        (record) => record.runId === runId && record.humanId === "user-b",
      ),
    ).toBe(true);
  });

  it("follows an Agent grant change mid-run on the same credential", async () => {
    const fixture = await toolFixture();
    const runJwt = await fixture.runAs("user-a");
    const runId = fixture.runIds[0] ?? "";
    const agentId = fixture.agentIds[0] ?? "";

    expect((await callTool(fixture.app, runJwt, "payments")).statusCode).toBe(
      201,
    );
    await fixture.setToolGrants(agentId, ["model", "docs", "search"]);

    const denied = await callTool(fixture.app, runJwt, "payments");
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as { error: string }).error).toContain(
      "not delegated",
    );
    expect(fixture.toolCalls).toEqual(["/internal/tools/payments"]);

    await fixture.setToolGrants(agentId, null);
    expect((await callTool(fixture.app, runJwt, "payments")).statusCode).toBe(
      201,
    );
    expect(fixture.toolCalls).toEqual([
      "/internal/tools/payments",
      "/internal/tools/payments",
    ]);
    expect(fixture.audit(runId).map((record) => record.decision)).toEqual([
      "allow",
      "deny",
      "allow",
    ]);
  });

  it("denies an Agent whose owner is no longer a known user", async () => {
    const fixture = await toolFixture();
    const runJwt = await fixture.runAs("user-a");
    // Reassigning the Agent to a human the store does not know leaves no role
    // to resolve. Falling back to a default role here would quietly grant one.
    const store = (fixture.service as unknown as { store: JsonStore }).store;
    await store.mutate((database) => {
      for (const agent of database.agents) agent.ownerId = "user-ghost";
    });

    const response = await callTool(fixture.app, runJwt, "search");

    expect(response.statusCode).toBe(403);
    expect(fixture.toolCalls).toEqual([]);
  });
});

describe("Tool gateway authentication", () => {
  afterEach(closeOpenServers);

  /** The tool proxy answers an unusable credential exactly as the model proxy does. */
  async function expectToolDenied(
    session: RunSession | null,
    headers: Record<string, string>,
  ): Promise<void> {
    const upstream = await startEchoUpstream();
    const app = await createApp(
      configFor(upstream.baseUrl),
      session ? serviceWith(session) : serviceWith(),
    );
    const toolCalls: string[] = [];
    app.addHook("onRequest", async (request) => {
      if (request.url.startsWith("/internal/tools"))
        toolCalls.push(request.url);
    });
    const response = await app.inject({
      method: "GET",
      url: "/gateway/v1/tools/docs/doc-a1",
      headers,
    });
    // 401, not 403: authentication failed, so no authorization work was even
    // attempted — the stub service has no agents to resolve a principal from,
    // and reaching that code would have thrown rather than denied.
    expect(response.statusCode).toBe(401);
    expect(toolCalls).toEqual([]);
    expect(response.body).not.toContain(ARK_KEY);
    expect(response.body).not.toContain(GATEWAY_SECRET);
    await app.close();
  }

  it("denies a tool call carrying no credential", async () => {
    await expectToolDenied(liveSession(), {});
  });

  it("denies a tool call with a tampered signature", async () => {
    const session = liveSession();
    const [header, claims] = credentialFor(session).split(".");
    await expectToolDenied(session, {
      authorization: `Bearer ${header}.${claims}.forged-signature`,
    });
  });

  it("denies a tool call from a revoked session", async () => {
    const session = liveSession({ revoked: true });
    await expectToolDenied(session, {
      authorization: `Bearer ${credentialFor(session)}`,
    });
  });

  it("files a revoked session's tool call against its run, tool and all", async () => {
    const session = liveSession({ revoked: true });
    await expectToolDenied(session, {
      authorization: `Bearer ${credentialFor(session)}`,
    });

    // The tool proxy's refusals leave the same evidence the model proxy's do,
    // named for the tool and resource the call asked about.
    expect(stubAudit).toHaveLength(1);
    expect(stubAudit[0]).toMatchObject({
      humanId: "user-a",
      agentId: "agent-1",
      runId: "run-1",
      tool: "docs",
      resource: "docs/doc-a1",
      decision: "deny",
      reason: "Run session revoked",
    });
  });

  it("files nothing for a tool call it cannot attribute to any run", async () => {
    const session = liveSession();
    const [header, claims] = credentialFor(session).split(".");
    await expectToolDenied(session, {
      authorization: `Bearer ${header}.${claims}.forged-signature`,
    });

    expect(stubAudit).toEqual([]);
  });
});

describe("Mid-run revocation", () => {
  afterEach(async () => {
    await closeOpenServers();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("stops an Agent's next model call while its run is still going", async () => {
    const upstream = await startEchoUpstream();
    const requests: RunnerRequest[] = [];
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const { service } = await realService(upstream.baseUrl, {
      run: (request) => {
        requests.push(request);
        return pending;
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const app = await createApp(
      loadConfig({
        NODE_ENV: "test",
        GATEWAY_JWT_SECRET: GATEWAY_SECRET,
        ARK_API_KEY: ARK_KEY,
        ARK_MODEL: "ep-test",
        ARK_BASE_URL: upstream.baseUrl,
      }),
      service,
    );

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { name: "Runaway" },
    });
    expect(created.statusCode).toBe(201);
    const agentId = (created.json() as { agent: { id: string } }).agent.id;

    const started = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/messages`,
      payload: { content: "keep calling the model" },
    });
    expect(started.statusCode).toBe(202);
    await expect.poll(() => requests.length).toBe(1);
    const runJwt = requests[0]?.runJwt ?? "";

    // The credential works while the run is supervised.
    const beforeRevocation = await app.inject({
      method: "POST",
      url: "/gateway/v1/responses",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${runJwt}`,
      },
      payload: '{"model":"ep-test"}',
    });
    expect(beforeRevocation.statusCode).toBe(200);
    expect(upstream.calls).toHaveLength(1);

    const revoked = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/revoke`,
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toEqual({ revokedSessions: 1 });

    // Same token, same run, now worthless — and Ark is not called again.
    const afterRevocation = await app.inject({
      method: "POST",
      url: "/gateway/v1/responses",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${runJwt}`,
      },
      payload: '{"model":"ep-test"}',
    });
    expect(afterRevocation.statusCode).toBe(401);
    expect(upstream.calls).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    await expect
      .poll(
        () =>
          service.getRun((started.json() as { run: { id: string } }).run.id)
            .status,
      )
      .toBe("completed");
    await app.close();
  });

  it("answers 404 for an Agent that does not exist", async () => {
    const upstream = await startEchoUpstream();
    const { service } = await realService(upstream.baseUrl, {
      run: async () => ({ output: "done", threadId: null, usage: null }),
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const app = await createApp(configFor(upstream.baseUrl), service);
    const response = await app.inject({
      method: "POST",
      url: "/api/agents/00000000-0000-4000-8000-000000000000/revoke",
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
