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
import type { RunnerRequest, RunnerResult, RunSession } from "./types.js";
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

/** The control-plane half of the credential: only these sessions are live. */
function serviceWith(...sessions: RunSession[]): AgentService {
  return {
    listAgents: () => [],
    systemInfo: async () => ({}),
    findRunSession: (jwtId: string) =>
      sessions.find((session) => session.jwtId === jwtId),
  } as unknown as AgentService;
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
