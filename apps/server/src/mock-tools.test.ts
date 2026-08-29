import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { MOCK_TOOLS_PREFIX, TOOL_CREDENTIAL_HEADER } from "./mock-tools.js";
import { JsonStore, SEED_DOCS } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const GATEWAY_SECRET = "gateway-test-signing-secret";
const TOOL_CREDENTIAL = "tool-service-test-credential";

const temporaryDirectories: string[] = [];

/** The app over a real store, so the seeded documents are the ones served. */
async function toolApp(): Promise<FastifyInstance> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-tools-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    GATEWAY_JWT_SECRET: GATEWAY_SECRET,
    GATEWAY_TOOL_CREDENTIAL: TOOL_CREDENTIAL,
    ARK_API_KEY: "tools-test-upstream-key",
    ARK_MODEL: "ep-test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    {
      run: async () => ({ output: "", threadId: null, usage: null }),
      cancel: async () => false,
      isAvailable: async () => true,
    },
  );
  await service.initialize();
  return createApp(config, service);
}

const withCredential = { [TOOL_CREDENTIAL_HEADER]: TOOL_CREDENTIAL };

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Mock tool service credential", () => {
  /**
   * The bypass attempt. Every tool route is reachable by URL — the enforcement
   * has to be the credential check, not the fact that nobody guessed the path.
   */
  const routes = [
    { method: "GET" as const, url: `${MOCK_TOOLS_PREFIX}/docs/doc-a1` },
    { method: "GET" as const, url: `${MOCK_TOOLS_PREFIX}/search?q=gateway` },
    { method: "POST" as const, url: `${MOCK_TOOLS_PREFIX}/payments` },
  ];

  it.each(routes)("refuses $method $url without a credential", async (route) => {
    const app = await toolApp();
    const response = await app.inject({
      method: route.method,
      url: route.url,
      payload: { amount: 10 },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: "Tool service credential required",
    });
    // Nothing about the fixture leaks out of a refusal.
    expect(response.body).not.toContain("quarterly plan");
    await app.close();
  });

  it("refuses a credential that is merely the right shape", async () => {
    const app = await toolApp();
    const response = await app.inject({
      method: "GET",
      url: `${MOCK_TOOLS_PREFIX}/docs/doc-a1`,
      headers: { [TOOL_CREDENTIAL_HEADER]: "x".repeat(TOOL_CREDENTIAL.length) },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("stays outside the browser token, which guards /api only", async () => {
    // The tool service is not a browser surface: sharing the demo token with it
    // would make every operator's browser a way around the gateway.
    const app = await toolApp();
    const response = await app.inject({
      method: "GET",
      url: `${MOCK_TOOLS_PREFIX}/search`,
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe("Mock tool service routes", () => {
  it("serves a seeded document with its owner attached", async () => {
    const app = await toolApp();
    const response = await app.inject({
      method: "GET",
      url: `${MOCK_TOOLS_PREFIX}/docs/doc-b1`,
      headers: withCredential,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      doc: SEED_DOCS.find((doc) => doc.id === "doc-b1"),
    });
    await app.close();
  });

  it("answers 404 for a document that does not exist", async () => {
    const app = await toolApp();
    const response = await app.inject({
      method: "GET",
      url: `${MOCK_TOOLS_PREFIX}/docs/doc-nonexistent`,
      headers: withCredential,
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("searches a corpus that does not depend on who is asking", async () => {
    const app = await toolApp();
    const response = await app.inject({
      method: "GET",
      url: `${MOCK_TOOLS_PREFIX}/search?q=revoke`,
      headers: withCredential,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      query: string;
      results: { id: string }[];
    };
    expect(body.query).toBe("revoke");
    expect(body.results.map((result) => result.id)).toEqual(["kb-2"]);
    // Nobody's documents are in the index, so search cannot leak across owners.
    expect(response.body).not.toContain("quarterly plan");
    await app.close();
  });

  it("accepts a payment and charges nothing", async () => {
    const app = await toolApp();
    const response = await app.inject({
      method: "POST",
      url: `${MOCK_TOOLS_PREFIX}/payments`,
      headers: withCredential,
      payload: { amount: 42.5, currency: "usd", memo: "demo" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      status: "accepted",
      amount: 42.5,
      currency: "USD",
      memo: "demo",
    });
    await app.close();
  });

  it("rejects a payment body it cannot make sense of", async () => {
    const app = await toolApp();
    const response = await app.inject({
      method: "POST",
      url: `${MOCK_TOOLS_PREFIX}/payments`,
      headers: withCredential,
      payload: { amount: -1 },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
