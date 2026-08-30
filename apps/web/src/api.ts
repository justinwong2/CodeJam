import type {
  Agent,
  AgentRun,
  AuditRecord,
  Message,
  MockDocMetadata,
  Role,
  RunSessionClaims,
  SystemInfo,
  User,
} from "./types";
import { DEFAULT_OWNER_ID } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/** Names the human a browser request acts as; the server validates it. */
const ACTING_USER_HEADER = "x-launchpad-user";
const ACTING_USER_STORAGE_KEY = "launchpad.acting-user";

let authToken = "";

/**
 * The selection is read here, at module load, rather than from a component:
 * the very first request the app makes must already carry the user chosen
 * before the last reload, or the server would answer as the default owner.
 */
let actingUserId = readStoredActingUser();

function readStoredActingUser(): string {
  try {
    return (
      window.localStorage.getItem(ACTING_USER_STORAGE_KEY) ?? DEFAULT_OWNER_ID
    );
  } catch {
    // Storage can be unavailable (private mode, blocked cookies). The
    // switcher is a dev convenience; falling back is better than failing.
    return DEFAULT_OWNER_ID;
  }
}

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

export function getActingUserId(): string {
  return actingUserId;
}

/**
 * Change who the browser acts as. This decides nothing: it only names a user
 * on every subsequent request, and the server resolves that user's authority.
 */
export function setActingUserId(id: string): void {
  actingUserId = id;
  try {
    window.localStorage.setItem(ACTING_USER_STORAGE_KEY, id);
  } catch {
    // Selection then lasts for this tab only; requests still carry it.
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    [ACTING_USER_HEADER]: actingUserId,
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  users: () => request<{ users: User[] }>("/api/users"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  sendMessage: (id: string, content: string) =>
    request<{ run: AgentRun; message: Message }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  runAudit: (id: string) =>
    request<{ audit: AuditRecord[] }>("/api/runs/" + id + "/audit"),

  // The Operator Console's reads and its two levers. Both levers are ordinary
  // control-plane calls: the server decides what they mean, and the console is
  // only the thing that asks.
  operatorAudit: () => request<{ audit: AuditRecord[] }>("/api/operator/audit"),
  operatorSessions: () =>
    request<{ sessions: RunSessionClaims[] }>("/api/operator/sessions"),
  operatorDocs: () =>
    request<{ docs: MockDocMetadata[] }>("/api/operator/docs"),
  setUserRole: (id: string, role: Role) =>
    request<{ user: User }>("/api/users/" + id, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),
  revokeAgentSessions: (id: string) =>
    request<{ revokedSessions: number }>("/api/agents/" + id + "/revoke", {
      method: "POST",
    }),
};
