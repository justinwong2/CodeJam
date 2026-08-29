import { randomUUID } from "node:crypto";
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
  CreateAgentInput,
  Database,
  Message,
  RunSession,
  RunSessionDirectory,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

/**
 * A session outlives the turn it authorizes by this much. A model call already
 * in flight when `CODEX_TIMEOUT_MS` elapses must not be denied mid-stream while
 * the runner is still tearing the turn down.
 */
const SESSION_EXPIRY_MARGIN_MS = 60_000;

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

export class AgentService implements RunSessionDirectory {
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

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
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
    // the store has not accepted.
    const expiresAtMs =
      Date.now() + this.config.codexTimeoutMs + SESSION_EXPIRY_MARGIN_MS;
    const session: RunSession = {
      runId,
      agentId,
      ownerId: DEFAULT_OWNER_ID,
      jwtId: randomUUID(),
      revoked: false,
      createdAt: timestamp,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    const runJwt = signRunJwt(this.config.gatewayJwtSecret, {
      jti: session.jwtId,
      agentId,
      ownerId: session.ownerId,
      runId,
      exp: Math.floor(expiresAtMs / 1_000),
    });
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
      database.sessions.push(session);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
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
