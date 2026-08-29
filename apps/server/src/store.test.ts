import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DATABASE_VERSION, JsonStore, SEED_USERS } from "./store.js";
import { DEFAULT_OWNER_ID } from "./types.js";

const temporaryDirectories: string[] = [];

async function temporaryFile(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
  temporaryDirectories.push(root);
  return path.join(root, "db.json");
}

const legacyAgent = {
  id: "agent-1",
  name: "Legacy",
  description: "",
  instructions: "",
  status: "ready",
  workspacePath: path.join(tmpdir(), "workspaces", "agent-1"),
  codexThreadId: null,
  lastError: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("JsonStore migration", () => {
  it("upgrades a version 1 file, keeping its rows and adding new collections", async () => {
    const filePath = await temporaryFile();
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        agents: [legacyAgent],
        messages: [],
        runs: [],
      }),
      "utf8",
    );

    const store = new JsonStore(filePath);
    await store.initialize();

    const migrated = store.snapshot();
    expect(migrated.version).toBe(DATABASE_VERSION);
    expect(migrated.sessions).toEqual([]);
    expect(migrated.agents.map((agent) => agent.id)).toEqual(["agent-1"]);

    // The upgrade is durable, not just in memory.
    const onDisk = JSON.parse(await readFile(filePath, "utf8")) as {
      version: number;
      sessions: unknown[];
    };
    expect(onDisk.version).toBe(DATABASE_VERSION);
    expect(onDisk.sessions).toEqual([]);

    // ...and the upgraded file reopens and keeps accepting writes.
    const reopened = new JsonStore(filePath);
    await reopened.initialize();
    await reopened.mutate((database) => {
      database.sessions.push({
        runId: "run-1",
        agentId: "agent-1",
        ownerId: "user-a",
        jwtId: "jwt-1",
        revoked: false,
        createdAt: "2026-08-02T00:00:00.000Z",
        expiresAt: "2026-08-02T00:10:00.000Z",
      });
    });
    const roundTripped = new JsonStore(filePath);
    await roundTripped.initialize();
    expect(roundTripped.snapshot().sessions.map((item) => item.jwtId)).toEqual([
      "jwt-1",
    ]);
    expect(roundTripped.snapshot().agents).toHaveLength(1);
  });

  it("defaults collections a stored file never had", async () => {
    const filePath = await temporaryFile();
    await writeFile(filePath, JSON.stringify({ version: 1 }), "utf8");

    const store = new JsonStore(filePath);
    await store.initialize();

    expect(store.snapshot()).toEqual({
      version: DATABASE_VERSION,
      agents: [],
      messages: [],
      runs: [],
      sessions: [],
      users: SEED_USERS,
    });
  });

  it("refuses a database written by a newer server rather than truncating it", async () => {
    const filePath = await temporaryFile();
    await writeFile(
      filePath,
      JSON.stringify({ version: DATABASE_VERSION + 1, agents: [legacyAgent] }),
      "utf8",
    );

    const store = new JsonStore(filePath);
    await expect(store.initialize()).rejects.toThrow(
      /Unsupported database format/,
    );
  });
});

describe("Seeded users and ownership", () => {
  it("seeds the demo users once, not once per start", async () => {
    const filePath = await temporaryFile();
    const store = new JsonStore(filePath);
    await store.initialize();
    expect(store.snapshot().users).toEqual([
      { id: "user-a", name: "User A", role: "admin" },
      { id: "user-b", name: "User B", role: "basic" },
    ]);

    // A restart reads the seeded rows back rather than seeding beside them.
    const restarted = new JsonStore(filePath);
    await restarted.initialize();
    expect(restarted.snapshot().users.map((user) => user.id)).toEqual([
      "user-a",
      "user-b",
    ]);
  });

  it("keeps an edited seeded user instead of re-seeding over it", async () => {
    const filePath = await temporaryFile();
    await writeFile(
      filePath,
      JSON.stringify({
        version: DATABASE_VERSION,
        users: [{ id: "user-b", name: "Renamed B", role: "basic" }],
      }),
      "utf8",
    );

    const store = new JsonStore(filePath);
    await store.initialize();

    // The missing seed is added; the stored one is left exactly as it was.
    expect(store.snapshot().users).toEqual([
      { id: "user-b", name: "Renamed B", role: "basic" },
      { id: "user-a", name: "User A", role: "admin" },
    ]);
  });

  it("gives an Agent stored before ownership existed the default owner", async () => {
    const filePath = await temporaryFile();
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, agents: [legacyAgent] }),
      "utf8",
    );

    const store = new JsonStore(filePath);
    await store.initialize();
    expect(store.snapshot().agents[0]?.ownerId).toBe(DEFAULT_OWNER_ID);

    // The backfill is durable: it survives the write-back and a reopen.
    const reopened = new JsonStore(filePath);
    await reopened.initialize();
    expect(reopened.snapshot().agents[0]).toMatchObject({
      id: "agent-1",
      name: "Legacy",
      ownerId: DEFAULT_OWNER_ID,
    });
  });

  it("leaves an Agent that already has an owner alone", async () => {
    const filePath = await temporaryFile();
    await writeFile(
      filePath,
      JSON.stringify({
        version: DATABASE_VERSION,
        agents: [{ ...legacyAgent, ownerId: "user-b" }],
      }),
      "utf8",
    );

    const store = new JsonStore(filePath);
    await store.initialize();
    expect(store.snapshot().agents[0]?.ownerId).toBe("user-b");
  });
});

describe("JsonStore", () => {
  it("does not publish a mutation in memory when persistence fails", async () => {
    const originalPath = await temporaryFile();
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(
      path.dirname(originalPath),
      "missing-directory",
      "db.json",
    );
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual(
      ["queue recovered"],
    );
  });
});
