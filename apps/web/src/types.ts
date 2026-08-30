export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled";

// The types below mirror apps/server/src/types.ts. The server is canonical:
// nothing here is a decision, only a shape the UI needs to render one.

/** Seeded, prebuilt roles. Mirrors the server's `Role`. */
export type Role = "admin" | "basic" | "suspended";

/** The roles the console may assign. Mirrors the server's `ROLE_NAMES`. */
export const ROLE_NAMES: Role[] = ["admin", "basic", "suspended"];

/** Everything the gateway can be asked to reach. Mirrors `ToolName`. */
export type ToolName = "model" | "docs" | "search" | "payments";

export interface User {
  id: string;
  name: string;
  role: Role;
}

/**
 * The user a request acts as when the browser names none — the same fallback
 * the server applies, mirrored so the switcher starts on the user the server
 * would have picked anyway.
 */
export const DEFAULT_OWNER_ID = "user-a";

/**
 * One gateway decision, as the server recorded it. The UI displays these and
 * never derives them: every allow and deny here was already enforced
 * server-side before the Agent was told anything.
 */
export interface AuditRecord {
  id: string;
  ts: string;
  humanId: string;
  agentId: string;
  runId: string;
  tool: ToolName;
  resource: string | null;
  decision: "allow" | "deny";
  reason: string;
}

/**
 * A run session as the console is allowed to see it: claims only. Mirrors the
 * server's `RunSessionClaims` — the raw credential is in no payload, so there
 * is nothing here for the browser to render even by accident.
 */
export interface RunSessionClaims {
  jti: string;
  agentId: string;
  ownerId: string;
  runId: string;
  issuedAt: string;
  expiresAt: string;
  revoked: boolean;
}

/**
 * A document as ground truth — it exists, this human owns it. Mirrors the
 * server's `MockDocMetadata`; content is deliberately not part of the shape.
 */
export interface MockDocMetadata {
  id: string;
  ownerId: string;
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
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
