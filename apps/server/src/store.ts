import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { DEFAULT_OWNER_ID } from "./types.js";
import type {
  Agent,
  AgentRun,
  AuditRecord,
  Database,
  Message,
  MockDoc,
  RunSession,
  User,
} from "./types.js";

/** Bumped when a stored file must be reshaped, not when it merely grows. */
export const DATABASE_VERSION = 2;

/**
 * The demo's humans. Authentication is mocked by design — what the gateway
 * scores is authorization — so the two roles ship as fixtures rather than
 * something an operator creates.
 */
export const SEED_USERS: User[] = [
  { id: DEFAULT_OWNER_ID, name: "User A", role: "admin" },
  { id: "user-b", name: "User B", role: "basic" },
];

/**
 * The mock tool service's documents. They exist to give ownership and
 * visibility something to be about: A's private documents are what B's Agent is
 * refused, so the fixture is split across both owners deliberately, and the
 * three public ones are what a scoped search returns to everybody. A public
 * document still has one owner — visibility never transfers ownership.
 */
export const SEED_DOCS: MockDoc[] = [
  {
    id: "doc-a1",
    ownerId: DEFAULT_OWNER_ID,
    title: "User A quarterly plan",
    content: "User A quarterly plan: migrate the Runtime to the gateway.",
    visibility: "private",
  },
  {
    id: "doc-a2",
    ownerId: DEFAULT_OWNER_ID,
    title: "User A meeting notes",
    content: "User A meeting notes: agree the rollout order with the team.",
    visibility: "private",
  },
  {
    id: "doc-b1",
    ownerId: "user-b",
    title: "User B onboarding notes",
    content: "User B onboarding notes: how to file a Runtime access request.",
    visibility: "private",
  },
  {
    id: "kb-1",
    ownerId: DEFAULT_OWNER_ID,
    title: "Agent Access Gateway",
    content:
      "Agents call the platform gateway, which holds the credentials they do not.",
    visibility: "public",
  },
  {
    id: "kb-2",
    ownerId: DEFAULT_OWNER_ID,
    title: "Run credentials",
    content:
      "Each run is issued a short-lived credential the control plane can revoke.",
    visibility: "public",
  },
  {
    id: "kb-3",
    ownerId: DEFAULT_OWNER_ID,
    title: "Role-based tool access",
    content:
      "A role grants tools; ownership decides which resources those tools may touch.",
    visibility: "public",
  },
];

const emptyDatabase = (): Database => ({
  version: DATABASE_VERSION,
  agents: [],
  messages: [],
  runs: [],
  sessions: [],
  users: structuredClone(SEED_USERS),
  docs: structuredClone(SEED_DOCS),
  audit: [],
});

const collection = <T>(value: unknown): T[] =>
  Array.isArray(value) ? (value as T[]) : [];

/**
 * Adds any seeded row the file does not already carry. Seeding by id rather
 * than by "is the collection empty" is what keeps a restart from stacking a
 * second copy of every fixture beside the first, and leaves a row an operator
 * edited exactly as they left it.
 */
function seeded<T extends { id: string }>(stored: T[], seeds: T[]): T[] {
  const present = new Set(stored.map((row) => row.id));
  return [
    ...stored,
    ...seeds.filter((row) => !present.has(row.id)).map((row) => ({ ...row })),
  ];
}

/**
 * Documents stored before visibility existed are private, and so is anything
 * the file cannot account for. The default is the safe direction on purpose: a
 * document whose visibility a loader had to guess must never be guessed
 * readable by everybody. A missing title costs nothing but a name.
 */
function withVisibility(docs: MockDoc[]): MockDoc[] {
  return docs.map((doc) => ({
    ...doc,
    title: typeof doc.title === "string" ? doc.title : "Untitled document",
    visibility: doc.visibility === "public" ? "public" : "private",
  }));
}

/** Agents stored before ownership existed belong to the default owner. */
function withOwners(agents: Agent[]): Agent[] {
  return agents.map((agent) =>
    typeof agent.ownerId === "string" && agent.ownerId.length > 0
      ? agent
      : { ...agent, ownerId: DEFAULT_OWNER_ID },
  );
}

/**
 * Tolerant loader. An older file keeps its rows and gains the collections it
 * predates, so a demo's Agents and conversations survive a schema change.
 * Later slices add their own collections through here without another bump.
 * A file from a *newer* server is refused instead of silently truncated.
 */
export function migrateDatabase(parsed: unknown): Database {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Unsupported database format");
  }
  const source = parsed as Record<string, unknown>;
  if (
    typeof source.version !== "number" ||
    source.version < 1 ||
    source.version > DATABASE_VERSION
  ) {
    throw new Error("Unsupported database format");
  }
  return {
    version: DATABASE_VERSION,
    agents: withOwners(collection<Agent>(source.agents)),
    messages: collection<Message>(source.messages),
    runs: collection<AgentRun>(source.runs),
    sessions: collection<RunSession>(source.sessions),
    users: seeded(collection<User>(source.users), SEED_USERS),
    docs: seeded(withVisibility(collection<MockDoc>(source.docs)), SEED_DOCS),
    audit: collection<AuditRecord>(source.audit),
  };
}

/**
 * Where a store keeps its audit records. They are the highest-frequency write
 * in the system — one per gateway decision, awaited before the agent is
 * answered — so they live in an append-only sidecar rather than in the
 * whole-database rewrite `db.json` costs. The path is derived rather than
 * configured: an evidence file that can drift away from the database it belongs
 * to is a way to lose evidence.
 */
export function auditFilePath(databasePath: string): string {
  return path.extname(databasePath) === ".json"
    ? databasePath.slice(0, -".json".length) + ".audit.jsonl"
    : databasePath + ".audit.jsonl";
}

/**
 * How many audit records a store keeps when nobody says otherwise. It matches
 * the `AUDIT_RETENTION_LIMIT` default in `config.ts`: a store built without a
 * limit must behave like the server's, not like an unbounded one.
 */
export const DEFAULT_AUDIT_RETENTION_LIMIT = 1000;

/**
 * How far past the retention limit the sidecar may grow before it is rewritten.
 * The file is append-only, so eviction alone leaves the evicted lines on disk;
 * compacting on every append would trade the sidecar's whole point — one append
 * per decision — for tidiness. Four times the limit bounds the waste at a
 * factor nobody will notice while making a rewrite rare.
 */
const AUDIT_COMPACTION_FACTOR = 4;

/**
 * Parses the sidecar. A line the parser cannot read is skipped rather than
 * fatal: the only way one gets there is a process that died mid-append, which
 * leaves a torn final line, and refusing to start over a half-written record
 * would trade every surviving record for the one that did not survive.
 */
function parseAuditLines(raw: string): AuditRecord[] {
  const records: AuditRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      records.push(JSON.parse(trimmed) as AuditRecord);
    } catch {
      // Deliberately silent: the store has no logger, and a torn tail is an
      // expected consequence of a crash rather than a condition to report.
    }
  }
  return records;
}

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();
  private readonly auditPath: string;
  /**
   * Lines the sidecar is believed to hold: what `initialize` loaded or wrote,
   * plus every append since. Eviction is an in-memory drop, so without this the
   * file would grow forever behind a bounded `data.audit`.
   */
  private auditLines = 0;

  /**
   * The retention limit defaults rather than being required, so a caller that
   * only wants a store — every test, and any future tool — still gets the same
   * bound the server runs with instead of an unbounded one by omission.
   */
  constructor(
    private readonly filePath: string,
    private readonly auditRetentionLimit = DEFAULT_AUDIT_RETENTION_LIMIT,
  ) {
    this.auditPath = auditFilePath(filePath);
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const sidecar = await this.readAudit();
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      this.data = emptyDatabase();
      await this.adoptAudit(sidecar, false);
      await this.persist();
      return;
    }
    this.data = migrateDatabase(JSON.parse(raw));
    // A database written before the sidecar existed still carries its audit
    // array. Those records are older than anything the sidecar can hold, so
    // they go in front of it and the combined list is rewritten in one atomic
    // pass — appending them instead would both reorder the timeline and, on a
    // second start, file a duplicate of every record already carried over.
    const legacy = this.data.audit;
    await this.adoptAudit([...legacy, ...sidecar], legacy.length > 0);
    // Write the upgraded shape back now, so the file on disk and the schema
    // this process assumes never disagree. `persist` omits the audit key, which
    // is what drops the migrated records from `db.json`.
    await this.persist();
  }

  /**
   * Takes the records a start found and settles what this process holds and
   * what the sidecar says. Over the limit, the newest `limit` survive: retention
   * drops the oldest evidence first, because the decision an operator is asked
   * about is nearly always a recent one. The sidecar is rewritten whenever it
   * would otherwise disagree with memory — after a trim, or after a migration
   * moved records out of `db.json` — so boot is also the moment a file that grew
   * past the cap in an earlier process is brought back under it.
   */
  private async adoptAudit(
    records: AuditRecord[],
    migrated: boolean,
  ): Promise<void> {
    const retained =
      records.length > this.auditRetentionLimit
        ? records.slice(records.length - this.auditRetentionLimit)
        : records;
    this.data.audit = retained;
    if (migrated || retained.length !== records.length) {
      await this.rewriteAudit(retained);
      this.auditLines = retained.length;
      return;
    }
    // Nothing was rewritten, so the file is as it was found. A torn tail the
    // parser skipped is not counted; the count only decides when to compact,
    // and undercounting there costs a slightly later rewrite, nothing more.
    this.auditLines = records.length;
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  /**
   * A cloned projection of the current state. The gateway resolves a session on
   * every agent call and must not pay for a copy of every stored message to do
   * it, which a full `snapshot()` would cost.
   */
  select<T>(selector: (database: Database) => T): T {
    return structuredClone(selector(this.data));
  }

  async mutate<T>(
    mutation: (database: Database) => T | Promise<T>,
  ): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  /**
   * Files one audit record for the cost of one append instead of a rewrite of
   * the whole database. It shares `mutate`'s queue rather than running beside
   * it: `mutate` clones the database, mutates the clone and swaps it in, so a
   * push that landed between the clone and the swap would be dropped without a
   * trace — the one outcome an evidence trail may never have. The append
   * happens before the in-memory push, and a failure rejects, because the
   * gateway relies on an unrecorded decision stopping the call it was about.
   *
   * Retention runs here too, inside the same queued operation: the record is on
   * disk before anything is evicted, and a compaction that crosses the file
   * threshold is awaited rather than detached, so no reader can catch the
   * sidecar mid-rewrite and no failure can be swallowed by a floating promise.
   */
  async appendAudit(record: AuditRecord): Promise<void> {
    const operation = this.queue.then(async () => {
      await appendFile(this.auditPath, JSON.stringify(record) + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      this.auditLines += 1;
      this.data.audit.push(record);
      while (this.data.audit.length > this.auditRetentionLimit) {
        this.data.audit.shift();
      }
      if (
        this.auditLines >
        this.auditRetentionLimit * AUDIT_COMPACTION_FACTOR
      ) {
        await this.rewriteAudit(this.data.audit);
        this.auditLines = this.data.audit.length;
      }
    });
    this.queue = operation.catch(() => undefined);
    await operation;
  }

  private async readAudit(): Promise<AuditRecord[]> {
    try {
      return parseAuditLines(await readFile(this.auditPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      return [];
    }
  }

  /**
   * The one path that rewrites the sidecar wholesale — for the migration, for a
   * boot that trimmed, and for a compaction. It writes to a temporary file and
   * renames, so a reader sees either the old file or the new one.
   */
  private async rewriteAudit(records: AuditRecord[]): Promise<void> {
    const temporaryPath = this.auditPath + ".tmp";
    await writeFile(
      temporaryPath,
      records.map((record) => JSON.stringify(record) + "\n").join(""),
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporaryPath, this.auditPath);
  }

  private async persist(data: Database = this.data): Promise<void> {
    // Named field by field rather than spread-minus-audit, so that a collection
    // added later is a deliberate line here instead of silently riding along
    // and so that the audit records in memory cannot leak back into `db.json`.
    const persisted = {
      version: data.version,
      agents: data.agents,
      messages: data.messages,
      runs: data.runs,
      sessions: data.sessions,
      users: data.users,
      docs: data.docs,
    };
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(persisted, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
