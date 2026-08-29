import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

const ARK_KEY = "gateway-test-upstream-key";
const RUN_JWT = "run-jwt-from-the-agent";

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

describe("Model gateway", () => {
  afterEach(async () => {
    while (openServers.length > 0) {
      const server = openServers.pop();
      if (!server) continue;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("swaps the agent token for the upstream key and forwards the body byte-for-byte", async () => {
    const upstream = await startUpstream((_call, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "resp_1", status: "completed" }));
    });
    const app = await createApp(
      loadConfig({
        NODE_ENV: "test",
        GATEWAY_JWT_SECRET: "gateway-test-signing-secret",
        ARK_API_KEY: ARK_KEY,
        ARK_MODEL: "ep-test",
        ARK_BASE_URL: upstream.baseUrl,
      }),
      service,
    );

    // Deliberately awkward payload: unicode, doubled spaces, trailing newline.
    const payload = '{"model":"ep-test","input":"héllo  wörld"}\n';
    const response = await app.inject({
      method: "POST",
      url: "/gateway/v1/responses",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${RUN_JWT}`,
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
    expect(call?.authorization).not.toContain(RUN_JWT);
    expect(call?.contentType).toBe("application/json");
    expect(call?.body).toBe(payload);
    await app.close();
  });

  it("accepts a body far larger than the app-level limit", async () => {
    const upstream = await startUpstream((_call, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const app = await createApp(
      loadConfig({
        NODE_ENV: "test",
        GATEWAY_JWT_SECRET: "gateway-test-signing-secret",
        ARK_API_KEY: ARK_KEY,
        ARK_MODEL: "ep-test",
        ARK_BASE_URL: upstream.baseUrl,
      }),
      service,
    );

    // The app-level limit is 1 MiB; a real turn's context easily exceeds it.
    const payload = JSON.stringify({ input: "x".repeat(1_500_000) });
    const response = await app.inject({
      method: "POST",
      url: "/gateway/v1/responses",
      headers: { "content-type": "application/json" },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(upstream.calls[0]?.body.length).toBe(payload.length);
    await app.close();
  });

  it("stays outside the browser token hook, which guards /api only", async () => {
    const upstream = await startUpstream((_call, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const app = await createApp(
      loadConfig({
        NODE_ENV: "test",
        GATEWAY_JWT_SECRET: "gateway-test-signing-secret",
        APP_AUTH_TOKEN: "a-strong-test-token",
        ARK_API_KEY: ARK_KEY,
        ARK_MODEL: "ep-test",
        ARK_BASE_URL: upstream.baseUrl,
      }),
      service,
    );

    // The agent is a different principal: it never holds the browser's token.
    const response = await app.inject({
      method: "POST",
      url: "/gateway/v1/responses",
      headers: { "content-type": "application/json" },
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

    const app = await createApp(
      loadConfig({
        NODE_ENV: "test",
        GATEWAY_JWT_SECRET: "gateway-test-signing-secret",
        ARK_API_KEY: ARK_KEY,
        ARK_MODEL: "ep-test",
        ARK_BASE_URL: `http://127.0.0.1:${port}`,
      }),
      service,
    );

    const response = await app.inject({
      method: "POST",
      url: "/gateway/v1/responses",
      headers: { "content-type": "application/json" },
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

    const app = await createApp(
      loadConfig({
        NODE_ENV: "test",
        GATEWAY_JWT_SECRET: "gateway-test-signing-secret",
        ARK_API_KEY: ARK_KEY,
        ARK_MODEL: "ep-test",
        ARK_BASE_URL: upstream.baseUrl,
      }),
      service,
    );
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;

    const streamed = await fetch(
      `http://127.0.0.1:${address.port}/gateway/v1/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${RUN_JWT}`,
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
