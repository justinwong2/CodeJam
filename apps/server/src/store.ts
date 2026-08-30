import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
      return;
    }
    this.data = migrateDatabase(JSON.parse(raw));
    // Write the upgraded shape back now, so the file on disk and the schema
    // this process assumes never disagree.
    await this.persist();
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

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
