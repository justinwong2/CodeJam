import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditFilePath,
  DATABASE_VERSION,
  JsonStore,
  SEED_DOCS,
  SEED_USERS,
} from "./store.js";
import { DEFAULT_OWNER_ID } from "./types.js";
import type { AuditRecord } from "./types.js";

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

const auditRecord = (id: string): AuditRecord => ({
  id,
  ts: "2026-08-02T00:00:00.000Z",
  humanId: "user-a",
  agentId: "agent-1",
  runId: "run-1",
  tool: "docs",
  resource: "docs/doc-a1",
  decision: "allow",
  reason: 'Role "admin" grants the docs tool',
});

const auditLines = async (filePath: string): Promise<string[]> =>
  (await readFile(auditFilePath(filePath), "utf8"))
    .split("\n")
    .filter((line) => line.length > 0);

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
    expect(migrated.agents[0]?.toolGrants).toBeNull();

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
      docs: SEED_DOCS,
      audit: [],
    });
  });

  it("carries stored audit records forward without a version bump", async () => {
    const filePath = await temporaryFile();
    const record = auditRecord("audit-1");
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, agents: [legacyAgent] }),
      "utf8",
    );

    const store = new JsonStore(filePath);
    await store.initialize();
    expect(store.snapshot().audit).toEqual([]);
    await store.appendAudit(record);

    // Evidence outlives the process that wrote it, or it is not evidence.
    const reopened = new JsonStore(filePath);
    await reopened.initialize();
    expect(reopened.snapshot().audit).toEqual([record]);
  });

  it("refuses a corrupt database file with a diagnostic naming it", async () => {
    // The path is whatever the platform resolved for the temp directory, so it
    // is asserted as built rather than hardcoded (see the platform note in
    // CLAUDE.md); a raw SyntaxError would tell the operator neither which file
    // is corrupt nor why the server refused to start.
    const filePath = await temporaryFile();
    const garbage = "{ this is not json";
    await writeFile(filePath, garbage, "utf8");

    const store = new JsonStore(filePath);
    await expect(store.initialize()).rejects.toThrow(filePath);
    await expect(store.initialize()).rejects.toThrow(/not valid JSON/);
    // Refused, never repaired: the contents stay exactly as they were found.
    expect(await readFile(filePath, "utf8")).toBe(garbage);
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
  it("keeps valid Agent grants and fails malformed explicit grants closed", async () => {
    const filePath = await temporaryFile();
    await writeFile(
      filePath,
      JSON.stringify({
        version: DATABASE_VERSION,
        agents: [
          {
            ...legacyAgent,
            id: "valid",
            toolGrants: ["model", "docs", "model"],
          },
          { ...legacyAgent, id: "unknown", toolGrants: ["model", "shell"] },
          { ...legacyAgent, id: "wrong-shape", toolGrants: "model" },
        ],
      }),
      "utf8",
    );

    const store = new JsonStore(filePath);
    await store.initialize();
    expect(
      store.snapshot().agents.map((agent) => [agent.id, agent.toolGrants]),
    ).toEqual([
      ["valid", ["model", "docs"]],
      ["unknown", []],
      ["wrong-shape", []],
    ]);

    const reopened = new JsonStore(filePath);
    await reopened.initialize();
    expect(reopened.snapshot().agents[0]?.toolGrants).toEqual([
      "model",
      "docs",
    ]);
  });

  /**
   * `[]` and `null` are different policies, and the difference must survive a
   * restart. An Agent deliberately granted nothing that reloads as `null`
   * silently inherits everything its owner's role allows — the one direction
   * this loader is never permitted to fail in.
   */
  it("keeps an empty grant empty across a reload rather than collapsing it to inherit", async () => {
    const filePath = await temporaryFile();
    await writeFile(
      filePath,
      JSON.stringify({
        version: DATABASE_VERSION,
        agents: [
          { ...legacyAgent, id: "granted-nothing", toolGrants: [] },
          { ...legacyAgent, id: "inherits", toolGrants: null },
        ],
      }),
      "utf8",
    );

    const store = new JsonStore(filePath);
    await store.initialize();
    expect(
      store.snapshot().agents.map((agent) => [agent.id, agent.toolGrants]),
    ).toEqual([
      ["granted-nothing", []],
      ["inherits", null],
    ]);

    // The distinction is durable, not just an artifact of the first parse.
    const reopened = new JsonStore(filePath);
    await reopened.initialize();
    expect(
      reopened.snapshot().agents.map((agent) => [agent.id, agent.toolGrants]),
    ).toEqual([
      ["granted-nothing", []],
      ["inherits", null],
    ]);
  });

  it("seeds the demo users once, not once per start", async () => {
    const filePath = await temporaryFile();
    const store = new JsonStore(filePath);
    await store.initialize();
    expect(store.snapshot().users).toEqual([
      {
        id: "user-a",
        name: "User A",
        role: "admin",
        tokenBudget: 5_000_000,
        budgetResetAt: null,
      },
      {
        id: "user-b",
        name: "User B",
        role: "basic",
        tokenBudget: 5_000_000,
        budgetResetAt: null,
      },
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

    // The missing seed is added; the stored one is left exactly as it was —
    // except for the budget it predates, which loads as unlimited. That is the
    // safe direction here: a ceiling nobody set must not strand an existing
    // demo's Agents, and `can()` has already decided whether a call may happen.
    expect(store.snapshot().users).toEqual([
      {
        id: "user-b",
        name: "Renamed B",
        role: "basic",
        tokenBudget: 0,
        budgetResetAt: null,
      },
      {
        id: "user-a",
        name: "User A",
        role: "admin",
        tokenBudget: 5_000_000,
        budgetResetAt: null,
      },
    ]);
  });

  it("seeds the mock documents across both owners, once", async () => {
    const filePath = await temporaryFile();
    const store = new JsonStore(filePath);
    await store.initialize();
    // The fixture is only useful if both humans own some of it: an ownership
    // denial needs a document the caller demonstrably does not own.
    const owners = new Set(store.snapshot().docs.map((doc) => doc.ownerId));
    expect(owners).toEqual(new Set([DEFAULT_OWNER_ID, "user-b"]));

    const restarted = new JsonStore(filePath);
    await restarted.initialize();
    expect(restarted.snapshot().docs.map((doc) => doc.id)).toEqual(
      SEED_DOCS.map((doc) => doc.id),
    );
  });

  it("seeds private documents beside public ones, each with a title", async () => {
    const filePath = await temporaryFile();
    const store = new JsonStore(filePath);
    await store.initialize();
    const docs = store.snapshot().docs;

    // Both visibilities have to exist for scoping to be demonstrable: the
    // private rows are what a foreign principal never sees, the public rows are
    // what everybody's search returns.
    expect(docs.filter((doc) => doc.visibility === "private")).toHaveLength(3);
    expect(
      docs
        .filter((doc) => doc.visibility === "public")
        .map((doc) => doc.id)
        .sort(),
    ).toEqual(["kb-1", "kb-2", "kb-3"]);
    // A public document is still owned by somebody; visibility is not a way of
    // having no owner.
    for (const doc of docs) {
      expect(doc.ownerId.length).toBeGreaterThan(0);
      expect(doc.title.length).toBeGreaterThan(0);
    }
  });

  it("loads a document stored without a visibility as private, and keeps it", async () => {
    const filePath = await temporaryFile();
    await writeFile(
      filePath,
      JSON.stringify({
        version: DATABASE_VERSION,
        docs: [
          { id: "doc-a1", ownerId: "user-b", content: "reassigned" },
          {
            id: "doc-legacy",
            ownerId: "user-b",
            content: "written before visibility existed",
            visibility: "unknown-to-this-server",
          },
        ],
      }),
      "utf8",
    );

    const store = new JsonStore(filePath);
    await store.initialize();
    const docs = store.snapshot().docs;
    // The stored rows keep their owner and content and gain the safe default —
    // a visibility a loader had to guess is never guessed readable by everyone.
    expect(docs[0]).toEqual({
      id: "doc-a1",
      ownerId: "user-b",
      title: "Untitled document",
      content: "reassigned",
      visibility: "private",
    });
    expect(docs[1]?.visibility).toBe("private");
    expect(docs.map((doc) => doc.id)).toEqual([
      "doc-a1",
      "doc-legacy",
      ...SEED_DOCS.filter((doc) => doc.id !== "doc-a1").map((doc) => doc.id),
    ]);

    // The default is durable: it survives the write-back and a reopen.
    const reopened = new JsonStore(filePath);
    await reopened.initialize();
    expect(
      reopened.snapshot().docs.find((doc) => doc.id === "doc-legacy"),
    ).toEqual({
      id: "doc-legacy",
      ownerId: "user-b",
      title: "Untitled document",
      content: "written before visibility existed",
      visibility: "private",
    });
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

describe("Audit sidecar", () => {
  it("appends a decision without rewriting the database", async () => {
    const filePath = await temporaryFile();
    const store = new JsonStore(filePath);
    await store.initialize();
    await store.mutate((database) => {
      database.messages.push({
        id: "message-1",
        agentId: "agent-1",
        runId: "run-1",
        role: "user",
        content: "anything at all",
        createdAt: "2026-08-02T00:00:00.000Z",
      });
    });
    const before = await readFile(filePath, "utf8");

    await store.appendAudit(auditRecord("audit-1"));
    await store.appendAudit(auditRecord("audit-2"));
    await store.appendAudit(auditRecord("audit-3"));

    // The point of the sidecar: the busiest write in the system costs one
    // append, so the database file is not touched at all.
    expect(await readFile(filePath, "utf8")).toBe(before);
    expect(await auditLines(filePath)).toHaveLength(3);
    expect(Object.keys(JSON.parse(before) as object)).not.toContain("audit");
    expect(store.snapshot().audit.map((record) => record.id)).toEqual([
      "audit-1",
      "audit-2",
      "audit-3",
    ]);
  });

  it("reads appended decisions back, in order, in a new process", async () => {
    const filePath = await temporaryFile();
    const store = new JsonStore(filePath);
    await store.initialize();
    for (const id of ["audit-1", "audit-2", "audit-3"]) {
      await store.appendAudit(auditRecord(id));
    }

    const reopened = new JsonStore(filePath);
    await reopened.initialize();
    expect(reopened.snapshot().audit).toEqual([
      auditRecord("audit-1"),
      auditRecord("audit-2"),
      auditRecord("audit-3"),
    ]);
  });

  it("migrates audit records out of a legacy database into the sidecar", async () => {
    const filePath = await temporaryFile();
    await writeFile(
      filePath,
      JSON.stringify({
        version: DATABASE_VERSION,
        agents: [legacyAgent],
        audit: [auditRecord("audit-1"), auditRecord("audit-2")],
      }),
      "utf8",
    );

    const store = new JsonStore(filePath);
    await store.initialize();
    expect(store.snapshot().audit.map((record) => record.id)).toEqual([
      "audit-1",
      "audit-2",
    ]);

    // The records moved rather than being copied: the rewritten database no
    // longer carries them, and the sidecar does.
    const onDisk = JSON.parse(await readFile(filePath, "utf8")) as object;
    expect(Object.keys(onDisk)).not.toContain("audit");
    expect(await auditLines(filePath)).toHaveLength(2);

    // A second start migrates nothing, so it cannot duplicate anything.
    const reopened = new JsonStore(filePath);
    await reopened.initialize();
    expect(reopened.snapshot().audit.map((record) => record.id)).toEqual([
      "audit-1",
      "audit-2",
    ]);
    expect(await auditLines(filePath)).toHaveLength(2);
  });

  it("skips a torn final line rather than refusing to start", async () => {
    const filePath = await temporaryFile();
    await writeFile(
      auditFilePath(filePath),
      JSON.stringify(auditRecord("audit-1")) +
        "\n" +
        JSON.stringify(auditRecord("audit-2")) +
        "\n" +
        '{"id":"audit-3","ts":"2026-08-02T00:00',
      "utf8",
    );

    const store = new JsonStore(filePath);
    await store.initialize();
    // A crash mid-append must cost the record it was writing and nothing else.
    expect(store.snapshot().audit.map((record) => record.id)).toEqual([
      "audit-1",
      "audit-2",
    ]);
  });

  it("loses nothing when appends and mutations are issued together", async () => {
    const filePath = await temporaryFile();
    const store = new JsonStore(filePath);
    await store.initialize();

    // `mutate` clones the database and swaps the clone in, so an append that
    // ran beside it would vanish. The shared queue is what makes this safe.
    for (let index = 0; index < 10; index += 1) {
      await Promise.all([
        store.appendAudit(auditRecord(`audit-${index}`)),
        store.mutate((database) => {
          database.messages.push({
            id: `message-${index}`,
            agentId: "agent-1",
            runId: "run-1",
            role: "user",
            content: "concurrent",
            createdAt: "2026-08-02T00:00:00.000Z",
          });
        }),
      ]);
    }

    expect(store.snapshot().audit).toHaveLength(10);
    expect(store.snapshot().messages).toHaveLength(10);
    expect(await auditLines(filePath)).toHaveLength(10);

    const reopened = new JsonStore(filePath);
    await reopened.initialize();
    expect(reopened.snapshot().audit).toHaveLength(10);
    expect(reopened.snapshot().messages).toHaveLength(10);
  });
});

describe("Audit retention", () => {
  // Small enough that the file threshold (four times the limit) is reachable in
  // a test, and the shape of the rule is the same at 5 as it is at 1000.
  const LIMIT = 5;

  const ids = (store: JsonStore): string[] =>
    store.snapshot().audit.map((record) => record.id);

  const range = (from: number, to: number): string[] =>
    Array.from(
      { length: to - from + 1 },
      (_, index) => `audit-${from + index}`,
    );

  it("keeps the newest records once the limit is passed", async () => {
    const filePath = await temporaryFile();
    const store = new JsonStore(filePath, LIMIT);
    await store.initialize();

    for (const id of range(1, LIMIT + 3)) {
      await store.appendAudit(auditRecord(id));
    }

    // Retention drops the oldest first: what an operator is asked about is
    // nearly always the decision that just happened.
    expect(ids(store)).toEqual(range(4, 8));
  });

  it("brings a file that outgrew the limit back under it on the next start", async () => {
    const filePath = await temporaryFile();
    const store = new JsonStore(filePath, LIMIT);
    await store.initialize();
    for (const id of range(1, LIMIT + 3)) {
      await store.appendAudit(auditRecord(id));
    }
    // Eviction is in memory, so the appends alone left all eight on disk.
    expect(await auditLines(filePath)).toHaveLength(LIMIT + 3);

    const reopened = new JsonStore(filePath, LIMIT);
    await reopened.initialize();

    expect(ids(reopened)).toEqual(range(4, 8));
    expect(await auditLines(filePath)).toHaveLength(LIMIT);
    expect(reopened.snapshot().audit).toEqual(
      range(4, 8).map((id) => auditRecord(id)),
    );
  });

  it("compacts the sidecar once it grows past the file threshold", async () => {
    const filePath = await temporaryFile();
    const store = new JsonStore(filePath, LIMIT);
    await store.initialize();

    for (const id of range(1, 4 * LIMIT)) {
      await store.appendAudit(auditRecord(id));
    }
    // Still under the threshold: the sidecar's whole point is one append per
    // decision, so it is allowed to carry dead lines up to that bound.
    expect(await auditLines(filePath)).toHaveLength(4 * LIMIT);

    await store.appendAudit(auditRecord("audit-21"));

    // The append that crossed it rewrote the file to exactly what is in memory.
    expect(await auditLines(filePath)).toHaveLength(LIMIT);
    expect(
      (await auditLines(filePath)).map(
        (line) => (JSON.parse(line) as AuditRecord).id,
      ),
    ).toEqual(ids(store));
    expect(ids(store)).toEqual(range(17, 21));

    // The counter reset with the file: the next appends compact no sooner than
    // the threshold allows, rather than on every one.
    await store.appendAudit(auditRecord("audit-22"));
    expect(await auditLines(filePath)).toHaveLength(LIMIT + 1);
  });

  it("trims a hand-written sidecar to the limit at boot", async () => {
    const filePath = await temporaryFile();
    await writeFile(
      auditFilePath(filePath),
      range(1, 12)
        .map((id) => JSON.stringify(auditRecord(id)) + "\n")
        .join(""),
      "utf8",
    );

    const store = new JsonStore(filePath, LIMIT);
    await store.initialize();

    expect(ids(store)).toEqual(range(8, 12));
    expect(await auditLines(filePath)).toHaveLength(LIMIT);
    expect(
      (await auditLines(filePath)).map(
        (line) => (JSON.parse(line) as AuditRecord).id,
      ),
    ).toEqual(range(8, 12));
  });

  it("applies the limit to records migrated out of a legacy database", async () => {
    const filePath = await temporaryFile();
    await writeFile(
      filePath,
      JSON.stringify({
        version: DATABASE_VERSION,
        agents: [legacyAgent],
        audit: range(1, 4).map((id) => auditRecord(id)),
      }),
      "utf8",
    );
    await writeFile(
      auditFilePath(filePath),
      range(5, 8)
        .map((id) => JSON.stringify(auditRecord(id)) + "\n")
        .join(""),
      "utf8",
    );

    const store = new JsonStore(filePath, LIMIT);
    await store.initialize();

    // The legacy records are the older half, so the cap falls across the seam:
    // the surviving five are the last legacy record and the whole sidecar.
    expect(ids(store)).toEqual(range(4, 8));
    expect(
      (await auditLines(filePath)).map(
        (line) => (JSON.parse(line) as AuditRecord).id,
      ),
    ).toEqual(range(4, 8));
    expect(
      Object.keys(JSON.parse(await readFile(filePath, "utf8")) as object),
    ).not.toContain("audit");
  });
});
