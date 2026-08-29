import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  Agent,
  AgentRun,
  Database,
  Message,
  RunSession,
} from "./types.js";

/** Bumped when a stored file must be reshaped, not when it merely grows. */
export const DATABASE_VERSION = 2;

const emptyDatabase = (): Database => ({
  version: DATABASE_VERSION,
  agents: [],
  messages: [],
  runs: [],
  sessions: [],
});

const collection = <T>(value: unknown): T[] =>
  Array.isArray(value) ? (value as T[]) : [];

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
    agents: collection<Agent>(source.agents),
    messages: collection<Message>(source.messages),
    runs: collection<AgentRun>(source.runs),
    sessions: collection<RunSession>(source.sessions),
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
