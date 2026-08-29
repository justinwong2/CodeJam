export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

/**
 * The owner every Agent and run session is attributed to until real users
 * exist. Slice 3 seeds users and stamps `ownerId` from the acting human; this
 * constant is the single place that assumption lives until then.
 */
export const DEFAULT_OWNER_ID = "user-a";

/**
 * The server-side half of a per-run credential. The JWT handed to the Runtime
 * is only honoured while a matching session is live, so revoking or expiring
 * the session denies the agent's next call without reaching into the Runtime.
 */
export interface RunSession {
  runId: string;
  agentId: string;
  ownerId: string;
  /** The token's `jti`; the gateway looks a session up by it. */
  jwtId: string;
  revoked: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface Database {
  version: 2;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  sessions: RunSession[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  /** The run's gateway credential. It reaches Codex as `RUN_JWT`. */
  runJwt: string;
}

/**
 * What the gateway needs from the control plane to trust a run credential.
 * Narrower than `AgentService` on purpose: the gateway resolves sessions and
 * decides nothing about Run state.
 */
export interface RunSessionDirectory {
  findRunSession(jwtId: string): RunSession | undefined;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
