export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

/** Seeded, prebuilt roles. Custom-role authoring is deliberately out of scope. */
export type Role = "admin" | "basic" | "suspended";

/** The roles an operator may assign. Assigning is in scope; authoring is not. */
export const ROLE_NAMES = ["admin", "basic", "suspended"] as const;

/** Everything the gateway can be asked to reach on an Agent's behalf. */
export const TOOL_NAMES = ["model", "docs", "search", "payments"] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface User {
  id: string;
  name: string;
  role: Role;
}

/**
 * Role → permitted tools. Server-side only: permissions are resolved from the
 * owner on every call, never carried in a run credential, so a role change or
 * a revocation takes effect on the agent's next call instead of at expiry.
 *
 * `suspended` grants nothing at all — not even the model. It needs no rule of
 * its own: an empty list already denies every tool, with the same legible
 * reason every other role denial carries.
 */
export const ROLE_TOOLS: Record<Role, ToolName[]> = {
  admin: ["model", "docs", "search", "payments"],
  basic: ["model", "docs", "search"],
  suspended: [],
};

/**
 * Who a gateway call is acting as. The human owner is the ownership key: an
 * Agent never has authority of its own, only the authority of the human it
 * runs for.
 */
export interface Principal {
  /** The acting human. */
  humanId: string;
  /** `== humanId`; the key ownership comparisons are made against. */
  ownerId: string;
  agentId: string;
  runId: string;
  /** Resolved server-side from the owner, not read from the credential. */
  role: Role;
}

export interface Agent {
  id: string;
  ownerId: string;
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
 * The owner an Agent falls back to: the acting human when no user was named,
 * and the owner backfilled onto Agents stored before ownership existed.
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

/**
 * A session as the Operator Console is allowed to see it: the claims, and
 * nothing else. The raw credential is not in `RunSession` to begin with — this
 * projection is what keeps it that way when the shape grows, since a field
 * added to the session cannot reach the browser without being named here.
 */
export interface RunSessionClaims {
  /** The credential's `jti` — the identifier, never the credential. */
  jti: string;
  agentId: string;
  ownerId: string;
  runId: string;
  issuedAt: string;
  expiresAt: string;
  revoked: boolean;
}

/**
 * A document as ground truth: it exists, and this human owns it. Deliberately
 * not its content — the console shows the operator what the ownership rule is
 * being applied to, and is not a way around that rule.
 */
export interface MockDocMetadata {
  id: string;
  ownerId: string;
}

/**
 * A document in the mock tool service. Ownership is the whole point of the
 * fixture: it is the resource `can()` compares an Agent's owner against, and
 * the thing an ownership denial protects.
 */
export interface MockDoc {
  id: string;
  ownerId: string;
  content: string;
}

/**
 * One gateway decision, as evidence. It is written before the answer it
 * describes is sent, so a denial the agent saw is a denial the store can prove.
 *
 * What it deliberately does not hold is content: no prompt, no model reply, no
 * tool payload. The record names who asked, what they asked for, and why the
 * answer was yes or no — enough to audit a decision without becoming a second
 * copy of the conversation.
 */
export interface AuditRecord {
  id: string;
  ts: string;
  /** The acting human, resolved server-side — never read from a credential. */
  humanId: string;
  agentId: string;
  runId: string;
  tool: ToolName;
  /** What the call was about, e.g. `docs/doc-b1`; null when it names nothing. */
  resource: string | null;
  decision: "allow" | "deny";
  reason: string;
}

export interface Database {
  version: 2;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  sessions: RunSession[];
  users: User[];
  docs: MockDoc[];
  audit: AuditRecord[];
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

/**
 * Where the gateway files the evidence for a decision. Append-only from the
 * gateway's side: it records what it decided and never reads the trail back.
 */
export interface AuditSink {
  appendAuditRecord(record: AuditRecord): Promise<void>;
}

/**
 * Everything the gateway reads to authorize an agent call, plus the sink it
 * writes the outcome to. Permissions are resolved through here on every call
 * rather than carried in the credential, so revoking a role takes effect at
 * once instead of at token expiry.
 *
 * Every lookup answers with `undefined` rather than throwing: the gateway turns
 * a missing record into a denial, and an exception would turn it into a 500.
 */
export interface GatewayDirectory extends RunSessionDirectory, AuditSink {
  findAgent(id: string): Agent | undefined;
  findUser(id: string): User | undefined;
  findMockDoc(id: string): MockDoc | undefined;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
