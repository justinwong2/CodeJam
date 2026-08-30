import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { JsonStore, SEED_DOCS, SEED_USERS } from "./store.js";
import type {
  Agent,
  AgentRunner,
  AuditRecord,
  RunnerResult,
  User,
} from "./types.js";
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

/** A runner that keeps every credential it was handed, so a test can hunt for it. */
function recordingRunner(): { runner: AgentRunner; runJwts: string[] } {
  const runJwts: string[] = [];
  return {
    runJwts,
    runner: {
      run: async (request) => {
        runJwts.push(request.runJwt);
        return { output: "", threadId: null, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    },
  };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** An app over a real service, so ownership is asserted where it is stored. */
async function appWithStore(runner: AgentRunner = idleRunner) {
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
    runner,
  );
  await backing.initialize();
  return {
    app: await createApp(config, backing),
    service: backing,
    // So a test can reopen what was written, rather than trusting the copy the
    // process is holding.
    filePath: path.join(root, "data", "db.json"),
  };
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

describe("Operator console reads", () => {
  /** A finished Run owned by `owner`, and the credential it was given. */
  async function runFor(
    app: Awaited<ReturnType<typeof appWithStore>>["app"],
    backing: AgentService,
    owner: string,
    prompt: string,
  ): Promise<string> {
    const created = await createAgentAs(app, owner, "Console " + owner);
    const started = await app.inject({
      method: "POST",
      url: `/api/agents/${created.agent?.id}/messages`,
      headers: { "x-launchpad-user": owner },
      payload: { content: prompt },
    });
    expect(started.statusCode).toBe(202);
    const runId = (started.json() as { run: { id: string } }).run.id;
    await expect.poll(() => backing.getRun(runId).status).toBe("completed");
    return runId;
  }

  const record = (
    runId: string,
    ts: string,
    humanId: string,
    decision: "allow" | "deny",
  ): AuditRecord => ({
    id: randomUUID(),
    ts,
    humanId,
    agentId: "agent-1",
    runId,
    tool: "docs",
    resource: "docs/doc-a1",
    decision,
    reason: "recorded for the console",
  });

  it("shows every Run's decisions in one feed, ordered by ts", async () => {
    const { app, service: backing } = await appWithStore();
    const first = await runFor(app, backing, "user-a", "one");
    const second = await runFor(app, backing, "user-b", "two");

    // Interleaved and written out of order: the console reads a timeline, not
    // a per-Run trail, so ordering is the endpoint's job rather than the UI's.
    await backing.appendAuditRecord(
      record(second, "2026-08-30T10:00:03.000Z", "user-b", "deny"),
    );
    await backing.appendAuditRecord(
      record(first, "2026-08-30T10:00:01.000Z", "user-a", "allow"),
    );
    await backing.appendAuditRecord(
      record(second, "2026-08-30T10:00:02.000Z", "user-b", "allow"),
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/operator/audit",
    });
    expect(response.statusCode).toBe(200);
    const audit = (response.json() as { audit: AuditRecord[] }).audit;
    expect(audit.map((entry) => entry.ts)).toEqual([
      "2026-08-30T10:00:01.000Z",
      "2026-08-30T10:00:02.000Z",
      "2026-08-30T10:00:03.000Z",
    ]);
    // Both Runs and both humans, which is exactly what a per-Run read cannot
    // give the operator.
    expect(new Set(audit.map((entry) => entry.runId))).toEqual(
      new Set([first, second]),
    );
    await app.close();
  });

  it("shows sessions as claims and never the credential itself", async () => {
    const { runner, runJwts } = recordingRunner();
    const { app, service: backing } = await appWithStore(runner);
    const runId = await runFor(app, backing, "user-b", "session please");
    const runJwt = runJwts[0] ?? "";
    expect(runJwt.length).toBeGreaterThan(0);

    const response = await app.inject({
      method: "GET",
      url: "/api/operator/sessions",
    });
    expect(response.statusCode).toBe(200);
    const sessions = (
      response.json() as { sessions: Record<string, unknown>[] }
    ).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual({
      jti: expect.any(String),
      agentId: expect.any(String),
      ownerId: "user-b",
      runId,
      issuedAt: expect.any(String),
      expiresAt: expect.any(String),
      revoked: false,
    });

    // The whole point of a claims view: the token is not in it, in whole or in
    // part. A console that rendered one would hand an onlooker a live agent
    // identity, and the credential's own signature is what makes it one.
    expect(response.body).not.toContain(runJwt);
    for (const part of runJwt.split(".")) {
      expect(response.body).not.toContain(part);
    }
    await app.close();
  });

  it("shows a live session, and shows it revoked once the operator revokes it", async () => {
    // A run that never finishes, so its session is still live to be revoked —
    // which is the state the console's Revoke button exists to act on.
    let finish!: () => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = () => resolve({ output: "", threadId: null, usage: null });
    });
    const { app, service: backing } = await appWithStore({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const created = await createAgentAs(app, "user-a", "Long runner");
    const agentId = created.agent?.id ?? "";
    const started = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/messages`,
      payload: { content: "keep going" },
    });
    expect(started.statusCode).toBe(202);

    const before = await app.inject({
      method: "GET",
      url: "/api/operator/sessions",
    });
    expect(
      (before.json() as { sessions: { revoked: boolean }[] }).sessions,
    ).toMatchObject([{ revoked: false }]);

    const revoked = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/revoke`,
    });
    expect(revoked.json()).toEqual({ revokedSessions: 1 });

    const after = await app.inject({
      method: "GET",
      url: "/api/operator/sessions",
    });
    expect(
      (after.json() as { sessions: { revoked: boolean }[] }).sessions,
    ).toMatchObject([{ revoked: true }]);

    finish();
    await expect
      .poll(() =>
        backing.getRun((started.json() as { run: { id: string } }).run.id),
      )
      .toMatchObject({ status: "completed" });
    await app.close();
  });

  it("shows document metadata and never document content", async () => {
    const { app } = await appWithStore();
    const response = await app.inject({
      method: "GET",
      url: "/api/operator/docs",
    });

    expect(response.statusCode).toBe(200);
    const docs = (response.json() as { docs: Record<string, unknown>[] }).docs;
    // Every document, whoever owns it and whatever its visibility: the console
    // is the ground truth a scoped answer is narrated against, and a filtered
    // row leaves no trace of its own anywhere else.
    expect(docs).toEqual([
      {
        id: "doc-a1",
        title: "User A quarterly plan",
        ownerId: "user-a",
        visibility: "private",
      },
      {
        id: "doc-a2",
        title: "User A meeting notes",
        ownerId: "user-a",
        visibility: "private",
      },
      {
        id: "doc-b1",
        title: "User B onboarding notes",
        ownerId: "user-b",
        visibility: "private",
      },
      {
        id: "kb-1",
        title: "Agent Access Gateway",
        ownerId: "user-a",
        visibility: "public",
      },
      {
        id: "kb-2",
        title: "Run credentials",
        ownerId: "user-a",
        visibility: "public",
      },
      {
        id: "kb-3",
        title: "Role-based tool access",
        ownerId: "user-a",
        visibility: "public",
      },
    ]);
    // Ground truth means "these documents exist, belong to these humans, and
    // are public or private", never "here is what they say" — the console is
    // not a way around the rule the gateway enforces.
    for (const doc of SEED_DOCS) {
      expect(response.body).not.toContain(doc.content);
    }
    await app.close();
  });

  it("keeps the operator reads and the role lever behind the shared token", async () => {
    const app = await createApp(
      loadConfig({
        NODE_ENV: "test",
        GATEWAY_JWT_SECRET: "gateway-test-signing-secret",
        APP_AUTH_TOKEN: "a-strong-test-token",
      }),
      service,
    );
    for (const url of [
      "/api/operator/audit",
      "/api/operator/sessions",
      "/api/operator/docs",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(401);
    }
    // The lever is guarded like the reads: assigning a role — suspension
    // included — is exactly the call an unauthenticated client must not make.
    const patched = await app.inject({
      method: "PATCH",
      url: "/api/users/user-b",
      payload: { role: "suspended" },
    });
    expect(patched.statusCode).toBe(401);
    await app.close();
  });
});

describe("Documents in the browser", () => {
  const upload = (
    app: Awaited<ReturnType<typeof appWithStore>>["app"],
    actingUser: string,
    payload: Record<string, unknown>,
  ) =>
    app.inject({
      method: "POST",
      url: "/api/docs",
      headers: { "x-launchpad-user": actingUser },
      payload,
    });

  const listAs = async (
    app: Awaited<ReturnType<typeof appWithStore>>["app"],
    actingUser: string,
  ) => {
    const response = await app.inject({
      method: "GET",
      url: "/api/docs",
      headers: { "x-launchpad-user": actingUser },
    });
    expect(response.statusCode).toBe(200);
    return response;
  };

  it("lists what the acting human may see, and nothing else", async () => {
    const { app } = await appWithStore();

    const forB = await listAs(app, "user-b");
    const ids = (forB.json() as { docs: { id: string }[] }).docs.map(
      (doc) => doc.id,
    );
    // The same predicate the gateway scopes a search with: own + public. No
    // operator override lives on this surface — there is no god mode.
    expect(new Set(ids)).toEqual(new Set(["doc-b1", "kb-1", "kb-2", "kb-3"]));
    for (const doc of SEED_DOCS) {
      if (doc.ownerId === "user-a" && doc.visibility === "private") {
        expect(forB.body).not.toContain(doc.id);
        expect(forB.body).not.toContain(doc.content);
      }
    }

    // Switching the acting human re-scopes the same endpoint.
    const forA = await listAs(app, "user-a");
    expect(
      new Set(
        (forA.json() as { docs: { id: string }[] }).docs.map((doc) => doc.id),
      ),
    ).toEqual(new Set(["doc-a1", "doc-a2", "kb-1", "kb-2", "kb-3"]));
    await app.close();
  });

  it("stamps an upload with a server id and the acting human as owner", async () => {
    const { app, service: backing, filePath } = await appWithStore();

    const created = await upload(app, "user-b", {
      title: "B's private plan",
      content: "Only user B should ever read this.",
      visibility: "private",
    });

    expect(created.statusCode).toBe(201);
    const doc = (created.json() as { doc: Record<string, unknown> }).doc;
    expect(doc).toMatchObject({
      ownerId: "user-b",
      title: "B's private plan",
      visibility: "private",
    });
    expect(typeof doc.id).toBe("string");
    expect((doc.id as string).length).toBeGreaterThan(0);
    expect(backing.findMockDoc(doc.id as string)?.ownerId).toBe("user-b");

    // Persisted, not merely remembered: a judge reloading mid-demo still has it.
    const reopened = new JsonStore(filePath);
    await reopened.initialize();
    expect(
      reopened.snapshot().docs.find((stored) => stored.id === doc.id),
    ).toMatchObject({ ownerId: "user-b", visibility: "private" });
    await app.close();
  });

  it("never honours an owner the request body names", async () => {
    const { app, service: backing } = await appWithStore();

    const response = await upload(app, "user-b", {
      title: "Claiming to be A's",
      content: "Owner comes from the acting human, never from here.",
      visibility: "private",
      ownerId: "user-a",
    });

    // Rejected rather than quietly ignored: an upload that thinks it chose an
    // owner and one that did not must not look the same to the client.
    expect(response.statusCode).toBe(400);
    expect(
      backing.listDocumentMetadata().some((doc) => doc.ownerId !== "user-a" &&
        doc.title === "Claiming to be A's"),
    ).toBe(false);
    expect(
      backing.listDocumentMetadata().some((doc) => doc.title === "Claiming to be A's"),
    ).toBe(false);
    await app.close();
  });

  it("refuses content that is oversized, empty, or not plain text", async () => {
    const { app, service: backing } = await appWithStore();
    const before = backing.listDocumentMetadata().length;

    const rejected = [
      { title: "Too big", content: "x".repeat(8_000), visibility: "private" },
      { title: "Empty", content: "", visibility: "private" },
      {
        title: "Binary",
        content: "not text: \u0000\u0007",
        visibility: "private",
      },
      { title: "No visibility", content: "text" },
      { title: "Unknown visibility", content: "text", visibility: "shared" },
      { title: "", content: "text", visibility: "public" },
    ];
    for (const payload of rejected) {
      const response = await upload(app, "user-a", payload);
      expect(response.statusCode).toBe(400);
    }
    expect(backing.listDocumentMetadata()).toHaveLength(before);
    await app.close();
  });

  it("shows an uploaded public document to everyone and a private one to its owner", async () => {
    const { app } = await appWithStore();
    const shared = await upload(app, "user-b", {
      title: "B's public note",
      content: "Anyone may read this one.",
      visibility: "public",
    });
    const secret = await upload(app, "user-b", {
      title: "B's private note",
      content: "Nobody else may read this one.",
      visibility: "private",
    });
    expect(shared.statusCode).toBe(201);
    expect(secret.statusCode).toBe(201);
    const sharedId = (shared.json() as { doc: { id: string } }).doc.id;
    const secretId = (secret.json() as { doc: { id: string } }).doc.id;

    const forA = await listAs(app, "user-a");
    const seenByA = (forA.json() as { docs: { id: string }[] }).docs.map(
      (doc) => doc.id,
    );
    expect(seenByA).toContain(sharedId);
    expect(seenByA).not.toContain(secretId);
    expect(forA.body).not.toContain("Nobody else may read this one.");

    const forB = await listAs(app, "user-b");
    const seenByB = (forB.json() as { docs: { id: string }[] }).docs.map(
      (doc) => doc.id,
    );
    expect(seenByB).toContain(sharedId);
    expect(seenByB).toContain(secretId);
    await app.close();
  });

  it("keeps the document surfaces behind the shared token", async () => {
    const app = await createApp(
      loadConfig({
        NODE_ENV: "test",
        GATEWAY_JWT_SECRET: "gateway-test-signing-secret",
        APP_AUTH_TOKEN: "a-strong-test-token",
      }),
      service,
    );
    const listed = await app.inject({ method: "GET", url: "/api/docs" });
    expect(listed.statusCode).toBe(401);
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/docs",
      payload: { title: "t", content: "c", visibility: "public" },
    });
    expect(uploaded.statusCode).toBe(401);
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

  it("reassigns a seeded user's role, and the store keeps it", async () => {
    const { app, service: backing } = await appWithStore();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/users/user-b",
      payload: { role: "suspended" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: { id: "user-b", name: "User B", role: "suspended" },
    });
    // What matters is the stored fact: the gateway reads the role from here on
    // every call, so this is what a suspended owner's agents will be judged by.
    expect(backing.findUser("user-b")?.role).toBe("suspended");

    const listed = await app.inject({ method: "GET", url: "/api/users" });
    expect((listed.json() as { users: User[] }).users).toContainEqual({
      id: "user-b",
      name: "User B",
      role: "suspended",
    });
    await app.close();
  });

  it("refuses to give a role to a user who does not exist", async () => {
    const { app } = await appWithStore();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/users/user-ghost",
      headers: { "x-launchpad-user": "user-a" },
      payload: { role: "admin" },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("refuses a role outside the seeded three", async () => {
    const { app, service: backing } = await appWithStore();
    // Assigning roles is in scope; authoring them is not. An unknown role must
    // be a rejection, never a role nothing in ROLE_TOOLS grants anything to.
    for (const role of ["superuser", "", "ADMIN", null]) {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/users/user-b",
        payload: { role },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(backing.findUser("user-b")?.role).toBe("basic");
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
