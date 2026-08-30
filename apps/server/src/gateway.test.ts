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
import { signRunJwt, type RunJwtClaims } from "./run-jwt.js";
import { JsonStore } from "./store.js";
import type {
  AuditRecord,
  RunnerRequest,
  RunnerResult,
  RunSession,
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

/** The control-plane half of the credential: only these sessions are live. */
function serviceWith(...sessions: RunSession[]): AgentService {
  stubAudit.length = 0;
  return {
    listAgents: () => [],
    systemInfo: async () => ({}),
    findRunSession: (jwtId: string) =>
      sessions.find((session) => session.jwtId === jwtId),
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
    finish: () => void;
  }[] = [];

  afterEach(async () => {
    while (openFixtures.length > 0) {
      const fixture = openFixtures.pop();
      if (!fixture) continue;
      fixture.finish();
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
    /** Starts a run owned by `userId` and returns its live run credential. */
    runAs: (userId: string) => Promise<string>;
    /** The run ids `runAs` started, in the order it started them. */
    runIds: string[];
    /** What the gateway persisted for a run, read back out of the store. */
    audit: (runId: string) => AuditRecord[];
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
    const runAs = async (userId: string): Promise<string> => {
      const created = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: { "x-launchpad-user": userId },
        payload: { name: `Agent for ${userId}` },
      });
      expect(created.statusCode).toBe(201);
      const agentId = (created.json() as { agent: { id: string } }).agent.id;
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

    openFixtures.push({
      app,
      finish: () => release({ output: "done", threadId: null, usage: null }),
    });
    return { app, service, toolCalls, runAs, runIds, audit };
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
    expect((search.json() as { results: unknown[] }).results.length).toBe(1);

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

  it("denies one owner's Agent another owner's document, leaving it untouched", async () => {
    const fixture = await toolFixture();
    const before = fixture.service.findMockDoc("doc-a1");
    const runJwt = await fixture.runAs("user-b");

    const response = await callTool(fixture.app, runJwt, "docs/doc-a1");

    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: string }).error).toContain(
      "resource owned by user-a",
    );
    expect(fixture.toolCalls).toEqual([]);
    // Neither the content nor the stored record crossed the boundary.
    expect(response.body).not.toContain("quarterly plan");
    expect(fixture.service.findMockDoc("doc-a1")).toEqual(before);
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

    expect(response.statusCode).toBe(403);
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
