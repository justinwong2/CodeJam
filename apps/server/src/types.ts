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
  /**
   * The most this human's Agents may spend on the model, in tokens, across
   * every Run they have ever made. `0` is unlimited.
   *
   * A ceiling rather than an allocation: it is the operator's to set, never the
   * owner's, so an Agent cannot raise the limit it is being held to — the same
   * reason a role is not carried in a run credential.
   */
  tokenBudget: number;
  /**
   * When this human's spend was last reset, or `null` if it never was. Runs
   * that completed before it are not counted against the ceiling.
   *
   * A watermark rather than a stored counter: Run `usage` stays the single
   * source of truth and is never rewritten, so resetting an allowance costs no
   * history — the Runs, their tokens, and their audit records are all still
   * there to read.
   */
  budgetResetAt: string | null;
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
 * Who a gateway call is acting as. The human owner is the ownership key and
 * sets the maximum authority; the Agent's delegated grants may only narrow it.
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
  /** Resolved server-side from the Agent on every call; `null` inherits role. */
  toolGrants: ToolName[] | null;
}

export interface Agent {
  id: string;
  ownerId: string;
  /** `null` inherits the owner's role; an array is an Agent-specific ceiling. */
  toolGrants: ToolName[] | null;
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
 * What one human has spent against their ceiling, assembled for the operator.
 *
 * A view rather than a record: nothing stores this. `settled` and `inFlight`
 * stay separate fields on purpose, because they are not the same kind of
 * number — one is measured, the other estimated — and a single total would
 * hide which half is which.
 */
export interface OwnerSpend {
  userId: string;
  /** The ceiling; `0` is unlimited. */
  budget: number;
  /** Exact: tokens reported by completed Runs since the last reset. */
  settled: number;
  /** Estimated: what Runs still in flight have spent, from request sizes. */
  inFlight: number;
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
 * Who may read a Document besides its Owner. A public Document still has
 * exactly one Owner — visibility never transfers ownership — and the value is
 * chosen at creation and immutable after it. Anything a stored file cannot
 * account for loads as `private`, which is the safe direction.
 */
export type Visibility = "public" | "private";

/** The visibilities an Upload may choose between. */
export const VISIBILITY_NAMES = ["public", "private"] as const;

/**
 * A document as ground truth: it exists, this human owns it, and it is public
 * or private. Deliberately not its content — the console shows the operator
 * what the visibility rule is being applied to, and is not a way around it.
 */
export interface MockDocMetadata {
  id: string;
  title: string;
  ownerId: string;
  visibility: Visibility;
}

/**
 * A document in the mock tool service. Ownership and visibility are the whole
 * point of the fixture: together they are the resource `visibleTo()` decides
 * about, and the thing an ownership denial protects.
 */
export interface MockDoc {
  id: string;
  ownerId: string;
  title: string;
  content: string;
  visibility: Visibility;
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
  toolGrants?: ToolName[] | null | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  toolGrants?: ToolName[] | null | undefined;
}

/**
 * An Upload, as the request boundary hands it over. The Owner is deliberately
 * absent: it is the acting human, resolved server-side, never a field a client
 * can name.
 */
export interface CreateDocumentInput {
  title: string;
  content: string;
  visibility: Visibility;
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
  /**
   * Tokens this human's Agents have already spent, summed from the `usage` of
   * their **completed** Runs. A Run still in flight has not reported usage yet
   * and is counted by the gateway's own meter instead.
   *
   * Answers `0` for a human with no completed Runs, and for one the store does
   * not know — a missing record is never an excuse to skip a ceiling.
   */
  sumOwnerTokens(ownerId: string): number;
  /**
   * Whether this Run has reported its real token usage yet.
   *
   * The moment it has, the gateway's estimate for that Run is superseded and
   * must stop counting — otherwise the same tokens are counted twice, once
   * guessed and once measured. Answers `false` for a Run the store does not
   * know, so an estimate is never dropped on the strength of a missing record.
   */
  hasRunSettled(runId: string): boolean;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
