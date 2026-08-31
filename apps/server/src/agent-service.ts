import { randomUUID } from "node:crypto";
import { visibleTo } from "./authz.js";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { signRunJwt } from "./run-jwt.js";
import { JsonStore } from "./store.js";
import { DEFAULT_OWNER_ID } from "./types.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  AuditRecord,
  CreateAgentInput,
  CreateDocumentInput,
  Database,
  GatewayDirectory,
  Message,
  MockDoc,
  MockDocMetadata,
  Role,
  RunSession,
  RunSessionClaims,
  RunUsage,
  UpdateAgentInput,
  User,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

/**
 * What a `RunUsage` says a Codex thread has cost in total.
 *
 * `cachedInputTokens` is deliberately absent: it is a *subset* of
 * `inputTokens` — the part that was served from cache — not a bucket beside it.
 * The upstream reports `total = input + output`, so adding cached on top would
 * count most input twice.
 */
function threadTokens(usage: RunUsage | null | undefined): number {
  if (!usage) return 0;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

/** Ends a run's sessions where they stand, without pretending they were revoked. */
function expireRunSessions(
  database: Database,
  runId: string,
  at: string,
): void {
  for (const session of database.sessions) {
    if (session.runId === runId && session.expiresAt > at) {
      session.expiresAt = at;
    }
  }
}

export class AgentService implements GatewayDirectory {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      const interrupted = new Set<string>();
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
          interrupted.add(run.id);
        }
      }
      // Nothing is executing those runs any more, so any credential still in a
      // Runtime container from before the restart is now a credential nobody
      // is supervising. Revoke rather than wait for expiry.
      for (const session of database.sessions) {
        if (interrupted.has(session.runId)) {
          session.revoked = true;
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  /** The seeded humans, in seeded order — the switcher's list. */
  listUsers(): User[] {
    return this.store.select((database) => database.users);
  }

  /**
   * Gives a seeded human a different role. There is no token to reissue and
   * nothing to tell the Runtime: the gateway resolves the owner's role from
   * here on every call, so the change lands on the target's Agents' next
   * gateway call — including the calls of a run that is already in flight.
   *
   * The operator action itself is deliberately not audited: an `AuditRecord`
   * belongs to a Run, and this has none. Noted as a limitation in SECURITY.md
   * rather than papered over with a record that names no run.
   */
  async updateUser(
    id: string,
    changes: {
      role?: Role | undefined;
      tokenBudget?: number | undefined;
      resetSpend?: boolean | undefined;
    },
  ): Promise<User> {
    return this.store.mutate((database) => {
      const user = database.users.find((item) => item.id === id);
      if (!user) {
        throw new HttpError(404, "User not found");
      }
      if (changes.role !== undefined) {
        user.role = changes.role;
      }
      if (changes.tokenBudget !== undefined) {
        user.tokenBudget = changes.tokenBudget;
      }
      if (changes.resetSpend) {
        // A watermark, not a deletion: the Runs and their usage stay exactly as
        // they were, and stop being counted from here. The caller clears this
        // owner's in-flight meters alongside it — the store cannot, because
        // those live in the gateway's memory.
        user.budgetResetAt = new Date().toISOString();
      }
      return structuredClone(user);
    });
  }

  /**
   * What this human's Agents have already spent on the model, in tokens.
   *
   * Read per Agent rather than per Run, because `RunUsage` is **cumulative for
   * the Codex thread**, not the cost of one turn. Codex resumes the thread each
   * turn and reports the conversation's whole total, so a turn's figure already
   * contains every turn before it — summing Runs would be summing a running
   * total, and over-counts by roughly the number of turns.
   *
   * Usage is parsed when a Run finishes, so a Run still in flight contributes
   * nothing here and is metered by the gateway instead. A Run whose usage never
   * parsed reports nothing and is skipped; the in-flight meter is what keeps a
   * single Run bounded regardless.
   */
  sumOwnerTokens(ownerId: string): number {
    return this.store.select((database) => {
      const owner = database.users.find((user) => user.id === ownerId);
      const since = owner?.budgetResetAt
        ? Date.parse(owner.budgetResetAt)
        : null;
      const owned = database.agents.filter(
        (agent) => agent.ownerId === ownerId,
      );

      let total = 0;
      for (const agent of owned) {
        // Every completed Run of this Agent that reported usage, oldest first.
        const reported = database.runs
          .filter((run) => run.agentId === agent.id && run.usage)
          .sort((a, b) =>
            (a.completedAt ?? "").localeCompare(b.completedAt ?? ""),
          );
        if (reported.length === 0) continue;

        // The Agent's whole thread so far. Not a sum: Codex resumes the thread
        // each turn and reports usage for the entire conversation, so the last
        // Run's figure already contains every Run before it. Adding them would
        // be adding up a running total.
        const latest = threadTokens(reported[reported.length - 1]?.usage);

        // Where the ceiling started counting. Everything the thread had spent
        // by the time spend was reset is history, so the baseline is the last
        // figure reported before the watermark.
        let baseline = 0;
        if (since !== null) {
          for (const run of reported) {
            if (run.completedAt && Date.parse(run.completedAt) < since) {
              baseline = threadTokens(run.usage);
            }
          }
        }

        // Clamped, because a thread that restarts reports a smaller total than
        // the baseline taken from the one before it. Under-counting a fresh
        // thread is the harmless direction; a negative would credit an owner
        // for spend they had already made.
        total += Math.max(0, latest - baseline);
      }
      return total;
    });
  }

  /**
   * Whether this Run's real usage has landed, which is what makes the
   * gateway's estimate for it obsolete. A Run that finished without reporting
   * anything is deliberately not "settled": its estimate is the only account
   * of what it spent, so it keeps counting until it ages out.
   */
  hasRunSettled(runId: string): boolean {
    return this.store.select(
      (database) =>
        database.runs.find((run) => run.id === runId)?.usage != null,
    );
  }

  /** The seeded human behind an id, or nothing if no such human exists. */
  findUser(id: string): User | undefined {
    return this.store.select((database) =>
      database.users.find((user) => user.id === id),
    );
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  /**
   * `ownerId` is the acting human, resolved at the request boundary. It
   * defaults so a caller with no user context (a script, a test) still
   * produces an owned Agent rather than an unowned one.
   */
  async createAgent(
    input: CreateAgentInput,
    ownerId: string = DEFAULT_OWNER_ID,
  ): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      ownerId,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(
          409,
          "Stop the active run before editing this Agent",
        );
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined)
        agent.description = input.description.trim();
      if (input.instructions !== undefined)
        agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter(
        (item) => item.agentId !== id,
      );
      database.runs = database.runs.filter((item) => item.agentId !== id);
      database.sessions = database.sessions.filter(
        (item) => item.agentId !== id,
      );
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    // The run's identity, minted before the run is admitted so the session and
    // the run become visible in the same write: a token can never name a run
    // the store has not accepted. It lives for `SESSION_TTL_MS` — long enough
    // that a call still in flight when the turn is torn down is not denied
    // mid-stream, and no longer than the operator asked for.
    const expiresAtMs = Date.now() + this.config.sessionTtlMs;
    const session: RunSession = {
      runId,
      agentId,
      // Filled from the stored Agent inside the write below. Who a run acts for
      // is the store's fact about the Agent, not an assumption made out here.
      ownerId: DEFAULT_OWNER_ID,
      jwtId: randomUUID(),
      revoked: false,
      createdAt: timestamp,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      session.ownerId = storedAgent.ownerId;
      database.sessions.push(session);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    // Signed after the write, so the credential can only ever name an owner and
    // a run the store has already accepted.
    const runJwt = signRunJwt(this.config.gatewayJwtSecret, {
      jti: session.jwtId,
      agentId,
      ownerId: agentAtStart.ownerId,
      runId,
      exp: Math.floor(expiresAtMs / 1_000),
    });
    const execution = this.executeRun(agentAtStart, run, runJwt);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  /**
   * The Agent behind an id, or nothing. `getAgent` throws a 404 because a
   * browser asked for something absent; the gateway asks in order to decide,
   * and turns a missing Agent into a denial rather than a server error.
   */
  findAgent(id: string): Agent | undefined {
    return this.store.select((database) =>
      database.agents.find((agent) => agent.id === id),
    );
  }

  /** A document from the mock tool fixture, for the ownership comparison. */
  findMockDoc(id: string): MockDoc | undefined {
    return this.store.select((database) =>
      database.docs.find((doc) => doc.id === id),
    );
  }

  /**
   * The documents one human may see: their own, plus every public one. The same
   * `visibleTo` the gateway scopes an Agent's search with, so the human listing
   * and the agent's search cannot disagree about what exists for that owner.
   * There is deliberately no operator override here — the console's
   * metadata-only table is the all-seeing view, and it carries no content.
   */
  listVisibleDocuments(ownerId: string): MockDoc[] {
    return this.store
      .select((database) => database.docs)
      .filter((doc) => visibleTo(doc, ownerId));
  }

  /**
   * An Upload: create-only. The id is the server's and the owner is the acting
   * human resolved at the request boundary — never a field the body carried.
   * Visibility is fixed here and there is nothing that changes it afterwards.
   */
  async createDocument(
    input: CreateDocumentInput,
    ownerId: string,
  ): Promise<MockDoc> {
    const doc: MockDoc = {
      id: "doc-" + randomUUID(),
      ownerId,
      title: input.title.trim(),
      content: input.content,
      visibility: input.visibility,
    };
    await this.store.mutate((database) => {
      database.docs.push(doc);
    });
    return doc;
  }

  /**
   * Every stored document, unscoped. The mock tool service narrows this to the
   * Scope the gateway handed it; nothing else reads it, and nothing that reads
   * it may answer without applying a scope.
   */
  listMockDocs(): MockDoc[] {
    return this.store.select((database) => database.docs);
  }

  /**
   * One Run's evidence trail, oldest first. Scoped to the Run because that is
   * how it is read: beside the conversation it explains. A Run nobody started
   * is a 404 rather than an empty trail — an operator asking about the wrong
   * Run should be told so, not shown silence that looks like innocence.
   */
  getRunAudit(runId: string): AuditRecord[] {
    this.getRun(runId);
    return this.store
      .select((database) =>
        database.audit.filter((record) => record.runId === runId),
      )
      .sort((left, right) => left.ts.localeCompare(right.ts));
  }

  /**
   * Every decision the gateway has reached, across every Agent and Run, oldest
   * first. The per-Run trail explains one conversation; this is the timeline
   * the Operator Console reads — a denial is often only legible beside what the
   * same human was allowed a moment earlier.
   */
  listAuditRecords(): AuditRecord[] {
    return this.store
      .select((database) => database.audit)
      .sort((left, right) => left.ts.localeCompare(right.ts));
  }

  /**
   * Every run session, newest first, as claims. The projection is written out
   * field by field on purpose: spreading the stored session would publish
   * whatever it gains next, and a credential must never be among it.
   */
  listSessionClaims(): RunSessionClaims[] {
    return this.store
      .select((database) => database.sessions)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((session) => ({
        jti: session.jwtId,
        agentId: session.agentId,
        ownerId: session.ownerId,
        runId: session.runId,
        issuedAt: session.createdAt,
        expiresAt: session.expiresAt,
        revoked: session.revoked,
      }));
  }

  /**
   * The documents that exist, who owns them, and whether they are public — the
   * ground truth an operator reads a scoped answer against, since a filtered
   * row leaves no audit trace of its own. Metadata only, by the same
   * field-by-field projection: content belongs to the owner, not to whoever
   * opens the console.
   */
  listDocumentMetadata(): MockDocMetadata[] {
    return this.store
      .select((database) => database.docs)
      .map((doc) => ({
        id: doc.id,
        title: doc.title,
        ownerId: doc.ownerId,
        visibility: doc.visibility,
      }));
  }

  /**
   * Files one gateway decision. The gateway awaits this before it answers, so
   * an agent never learns the outcome of a call the store has not recorded.
   */
  async appendAuditRecord(record: AuditRecord): Promise<void> {
    await this.store.mutate((database) => {
      database.audit.push(record);
    });
  }

  /** The live session behind a run credential, looked up by its `jti`. */
  findRunSession(jwtId: string): RunSession | undefined {
    return this.store.select((database) =>
      database.sessions.find((session) => session.jwtId === jwtId),
    );
  }

  /**
   * The mid-run kill: every live credential this Agent holds stops working on
   * its next gateway call. The Run itself is left to finish or fail on its own
   * — revoking access is not the same as stopping the Agent, and the operator
   * can still see what it did.
   */
  async revokeAgentSessions(agentId: string): Promise<{
    revokedSessions: number;
  }> {
    this.getAgent(agentId);
    return this.store.mutate((database) => {
      const at = now();
      let revokedSessions = 0;
      for (const session of database.sessions) {
        if (
          session.agentId === agentId &&
          !session.revoked &&
          session.expiresAt > at
        ) {
          session.revoked = true;
          revokedSessions += 1;
        }
      }
      return { revokedSessions };
    });
  }

  listRunSessions(agentId: string): RunSession[] {
    return this.store.select((database) =>
      database.sessions.filter((session) => session.agentId === agentId),
    );
  }

  private async executeRun(
    agentAtStart: Agent,
    run: AgentRun,
    runJwt: string,
  ): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
        runJwt,
      });
      const completedAt = now();
      await this.store.mutate((database) => {
        expireRunSessions(database, run.id, completedAt);
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find(
          (item) => item.id === agentAtStart.id,
        );
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      await this.store.mutate((database) => {
        expireRunSessions(database, run.id, completedAt);
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find(
          (item) => item.id === agentAtStart.id,
        );
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
    }
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(
          409,
          "Stop the active run before starting this Agent",
        );
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}
