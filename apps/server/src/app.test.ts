import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { JsonStore, SEED_USERS } from "./store.js";
import type { Agent, AgentRunner, AuditRecord } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const service = {
  listAgents: () => [],
  listUsers: () => SEED_USERS,
  findUser: (id: string) => SEED_USERS.find((user) => user.id === id),
  systemInfo: async () => ({}),
} as unknown as AgentService;

const idleRunner: AgentRunner = {
  run: async () => ({ output: "", threadId: null, usage: null }),
  cancel: async () => false,
  isAvailable: async () => true,
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** An app over a real service, so ownership is asserted where it is stored. */
async function appWithStore() {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-app-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    GATEWAY_JWT_SECRET: "gateway-test-signing-secret",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const backing = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    idleRunner,
  );
  await backing.initialize();
  return { app: await createApp(config, backing), service: backing };
}

async function createAgentAs(
  app: Awaited<ReturnType<typeof appWithStore>>["app"],
  actingUser: string | undefined,
  name: string,
): Promise<{ statusCode: number; agent: Agent | undefined }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/agents",
    ...(actingUser ? { headers: { "x-launchpad-user": actingUser } } : {}),
    payload: { name },
  });
  const body = response.body ? (JSON.parse(response.body) as unknown) : {};
  return {
    statusCode: response.statusCode,
    agent: (body as { agent?: Agent }).agent,
  };
}

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({
        NODE_ENV: "test",
        GATEWAY_JWT_SECRET: "gateway-test-signing-secret",
        APP_AUTH_TOKEN: "a-strong-test-token",
      }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);

    // Revocation is an operator action with real consequences — an anonymous
    // caller must not be able to cut every Agent off. This pins the route to
    // the guarded side of the hook, wherever someone later moves it.
    const revoke = await app.inject({
      method: "POST",
      url: "/api/agents/00000000-0000-4000-8000-000000000000/revoke",
    });
    expect(revoke.statusCode).toBe(401);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(
      loadConfig({
        NODE_ENV: "test",
        GATEWAY_JWT_SECRET: "gateway-test-signing-secret",
      }),
      service,
    );
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });
});

describe("Run audit trail", () => {
  /** A finished Run, so there is something for evidence to hang on. */
  async function runFor(
    app: Awaited<ReturnType<typeof appWithStore>>["app"],
    backing: AgentService,
  ): Promise<string> {
    const created = await createAgentAs(app, "user-a", "Audited");
    const started = await app.inject({
      method: "POST",
      url: `/api/agents/${created.agent?.id}/messages`,
      payload: { content: "do something worth recording" },
    });
    expect(started.statusCode).toBe(202);
    const runId = (started.json() as { run: { id: string } }).run.id;
    await expect.poll(() => backing.getRun(runId).status).toBe("completed");
    return runId;
  }

  const record = (
    runId: string,
    ts: string,
    resource: string,
  ): AuditRecord => ({
    id: randomUUID(),
    ts,
    humanId: "user-a",
    agentId: "agent-1",
    runId,
    tool: "docs",
    resource,
    decision: "allow",
    reason: 'Role "admin" grants the docs tool',
  });

  it("returns one Run's records in the order they happened", async () => {
    const { app, service: backing } = await appWithStore();
    const runId = await runFor(app, backing);
    const otherRunId = randomUUID();

    // Written out of order on purpose: the endpoint orders by `ts`, so a
    // reader never has to reconstruct the sequence themselves.
    await backing.appendAuditRecord(
      record(runId, "2026-08-29T10:00:02.000Z", "docs/doc-a2"),
    );
    await backing.appendAuditRecord(
      record(runId, "2026-08-29T10:00:01.000Z", "docs/doc-a1"),
    );
    await backing.appendAuditRecord(
      record(otherRunId, "2026-08-29T10:00:00.000Z", "docs/doc-b1"),
    );

    const response = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}/audit`,
    });

    expect(response.statusCode).toBe(200);
    const audit = (response.json() as { audit: AuditRecord[] }).audit;
    expect(audit.map((entry) => entry.resource)).toEqual([
      "docs/doc-a1",
      "docs/doc-a2",
    ]);
    // Another Run's evidence belongs to that Run, not to this one.
    expect(audit.every((entry) => entry.runId === runId)).toBe(true);
    await app.close();
  });

  it("answers an empty trail for a Run that decided nothing", async () => {
    const { app, service: backing } = await appWithStore();
    const runId = await runFor(app, backing);

    const response = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}/audit`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ audit: [] });
    await app.close();
  });

  it("answers 404 for a Run nobody ever started", async () => {
    const { app } = await appWithStore();
    const response = await app.inject({
      method: "GET",
      url: `/api/runs/${randomUUID()}/audit`,
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

describe("Acting user", () => {
  it("lists the seeded users for the switcher", async () => {
    const { app } = await appWithStore();
    const response = await app.inject({ method: "GET", url: "/api/users" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      users: [
        { id: "user-a", name: "User A", role: "admin" },
        { id: "user-b", name: "User B", role: "basic" },
      ],
    });
    await app.close();
  });

  it("stamps a created Agent with the acting user's ownership", async () => {
    const { app, service: backing } = await appWithStore();
    const created = await createAgentAs(app, "user-b", "Owned by B");
    expect(created.statusCode).toBe(201);
    expect(created.agent?.ownerId).toBe("user-b");

    // Ownership is what the store holds, not just what the response echoed.
    expect(backing.getAgent(created.agent?.id ?? "").ownerId).toBe("user-b");
    await app.close();
  });

  it("defaults to the seeded owner when no user is named", async () => {
    const { app } = await appWithStore();
    const created = await createAgentAs(app, undefined, "Unattributed");
    expect(created.statusCode).toBe(201);
    expect(created.agent?.ownerId).toBe("user-a");
    await app.close();
  });

  it("rejects an unknown acting user instead of falling back to the default", async () => {
    const { app } = await appWithStore();
    const created = await createAgentAs(app, "user-ghost", "Should not exist");
    expect(created.statusCode).toBe(400);
    expect(created.agent).toBeUndefined();

    // The rejection is at the boundary, so a read route refuses it too.
    const listed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { "x-launchpad-user": "user-ghost" },
    });
    expect(listed.statusCode).toBe(400);

    // ...and nothing was created along the way.
    const agents = await app.inject({ method: "GET", url: "/api/agents" });
    expect(JSON.parse(agents.body)).toEqual({ agents: [] });
    await app.close();
  });

  it("rejects an ambiguous acting user sent twice", async () => {
    const { app } = await appWithStore();
    const response = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { "x-launchpad-user": ["user-a", "user-b"] },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("keeps the audit trail on the guarded side of the token hook", async () => {
    const app = await createApp(
      loadConfig({
        NODE_ENV: "test",
        GATEWAY_JWT_SECRET: "gateway-test-signing-secret",
        APP_AUTH_TOKEN: "a-strong-test-token",
      }),
      service,
    );
    // The evidence names humans, Agents, and what they were refused. It is the
    // operator's to read, and no more anonymous than the rest of /api.
    const response = await app.inject({
      method: "GET",
      url: "/api/runs/00000000-0000-4000-8000-000000000000/audit",
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("leaves the agent-facing gateway free of the browser's user header", async () => {
    // The gateway's principal comes from the run credential, never from a
    // header a caller can set, so an unknown user there is not a 400 here.
    const { app } = await appWithStore();
    const response = await app.inject({
      method: "POST",
      url: "/gateway/v1/responses",
      headers: { "x-launchpad-user": "user-ghost" },
      payload: { model: "ep-test" },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
