import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ApiError,
  getActingUserId,
  setActingUserId,
  setAuthToken,
} from "./api";
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
import { ROLE_NAMES } from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

/** Seconds matter in the console: decisions arrive several to a minute. */
function formatStamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

/**
 * What a session is right now. Live sessions are the ones revocation acts on;
 * the rest are shown as they are so an operator can see what a Revoke did.
 */
function sessionState(
  session: RunSessionClaims,
): "revoked" | "expired" | "live" {
  if (session.revoked) return "revoked";
  return Date.parse(session.expiresAt) <= Date.now() ? "expired" : "live";
}

function formatUsage(run: AgentRun | null): string {
  const usage = run?.usage;
  const parts = [
    usage?.inputTokens != null ? usage.inputTokens + " in" : null,
    usage?.cachedInputTokens != null
      ? usage.cachedInputTokens + " cached"
      : null,
    usage?.outputTokens != null ? usage.outputTokens + " out" : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0
    ? parts.join(" · ") + " tokens"
    : "No token usage reported yet";
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

/**
 * The Operator Console: the decision feed, the ground truth behind it, and the
 * two levers the platform already has — revoke a run's credentials, change what
 * a human may do. It renders and it triggers. Every decision it shows was made
 * server-side before the Agent was told anything, and nothing here can grant
 * what the server would refuse: the levers are ordinary control-plane calls,
 * and the answers come back from the store.
 */
function OperatorConsole({
  audit,
  sessions,
  docs,
  users,
  ownerName,
  onAssignRole,
  onRevoke,
}: {
  audit: AuditRecord[];
  sessions: RunSessionClaims[];
  docs: MockDocMetadata[];
  users: User[];
  ownerName: (ownerId: string) => string;
  onAssignRole: (id: string, role: Role) => void;
  onRevoke: (agentId: string) => void;
}) {
  // Newest first: an operator watching a demo cares about the decision that
  // just happened, not the one this Run opened with.
  const feed = [...audit].reverse();
  const denials = audit.filter((record) => record.decision === "deny").length;

  return (
    <section className="console">
      <header className="console-header">
        <div>
          <span className="eyebrow">Operator Console</span>
          <h1>Every decision, and the two levers behind them</h1>
          <p>
            Displays and triggers only. The gateway decided each row below
            server-side, before the Agent had an answer — this page enforces
            nothing and can show nothing the store does not hold.
          </p>
        </div>
        <div className="console-counts">
          <span>
            <strong>{audit.length}</strong> decisions
          </span>
          <span className={denials > 0 ? "console-count-deny" : ""}>
            <strong>{denials}</strong> denied
          </span>
          <span>
            <strong>
              {sessions.filter((item) => sessionState(item) === "live").length}
            </strong>{" "}
            live sessions
          </span>
        </div>
      </header>

      <div className="console-panel">
        <div className="console-panel-head">
          <h2>People</h2>
          <span>
            A role change takes effect on that human&apos;s Agents&apos; next
            gateway call — no token is reissued, because permissions were never
            in one.
          </span>
        </div>
        <table className="console-table">
          <thead>
            <tr>
              <th>Human</th>
              <th>Id</th>
              <th>Role</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>{user.name}</td>
                <td className="mono">{user.id}</td>
                <td>
                  <select
                    aria-label={"Role for " + user.name}
                    value={user.role}
                    onChange={(event) =>
                      onAssignRole(user.id, event.target.value as Role)
                    }
                  >
                    {ROLE_NAMES.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="console-panel">
        <div className="console-panel-head">
          <h2>Run sessions</h2>
          <span>
            Claims only — the credential itself is in no payload and renders
            nowhere. Revoking stops that Agent&apos;s next gateway call.
          </span>
        </div>
        <table className="console-table">
          <thead>
            <tr>
              <th>jti</th>
              <th>Owner</th>
              <th>Run</th>
              <th>Issued</th>
              <th>Expires</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => {
              const state = sessionState(session);
              return (
                <tr key={session.jti}>
                  <td className="mono">{session.jti.slice(0, 8)}…</td>
                  <td>{ownerName(session.ownerId)}</td>
                  <td className="mono">{session.runId.slice(0, 8)}…</td>
                  <td>{formatStamp(session.issuedAt)}</td>
                  <td>{formatStamp(session.expiresAt)}</td>
                  <td>
                    <span className={"session-state session-" + state}>
                      {state}
                    </span>
                  </td>
                  <td>
                    <button
                      className="button button-danger console-button"
                      disabled={state !== "live"}
                      onClick={() => onRevoke(session.agentId)}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              );
            })}
            {sessions.length === 0 && (
              <tr>
                <td colSpan={7} className="console-empty">
                  No run has been started yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="console-panel">
        <div className="console-panel-head">
          <h2>Documents</h2>
          <span>
            Ground truth: which documents exist and who owns them. Metadata only
            — content belongs to the owner, not to whoever opens this page.
          </span>
        </div>
        <table className="console-table">
          <thead>
            <tr>
              <th>Document</th>
              <th>Owner</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((doc) => (
              <tr key={doc.id}>
                <td className="mono">{doc.id}</td>
                <td>{ownerName(doc.ownerId)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="console-panel">
        <div className="console-panel-head">
          <h2>Decision feed</h2>
          <span>
            Every Agent, every Run, newest first. Denials are the same rows the
            Agent was answered with.
          </span>
        </div>
        {feed.length === 0 ? (
          <p className="evidence-empty">
            No gateway decisions recorded yet. Send a task, or have an Agent
            reach for a tool it may not use.
          </p>
        ) : (
          <ul className="audit-list console-audit">
            {feed.map((record) => (
              <li
                className={"audit-row audit-" + record.decision}
                key={record.id}
              >
                <span className="audit-decision">{record.decision}</span>
                <span className="audit-tool">{record.tool}</span>
                <span className="audit-human">{ownerName(record.humanId)}</span>
                <span className="audit-resource">{record.resource ?? "—"}</span>
                <span className="audit-reason">{record.reason}</span>
                <span className="audit-ts">{formatStamp(record.ts)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [actingUser, setActingUser] = useState(getActingUserId);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [runEvidence, setRunEvidence] = useState<{
    runId: string;
    records: AuditRecord[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showConsole, setShowConsole] = useState(false);
  const [operatorData, setOperatorData] = useState<{
    audit: AuditRecord[];
    sessions: RunSessionClaims[];
    docs: MockDocMetadata[];
  }>({ audit: [], sessions: [], docs: [] });
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([
      refreshAgents(),
      api.system().then(setSystem),
      api.users().then((result) => setUsers(result.users)),
    ]);
  }, [refreshAgents]);

  /**
   * Switching users changes who the browser claims to be, nothing else. The
   * server resolves that user's role and ownership on every call it receives.
   */
  const switchActingUser = async (id: string) => {
    setActingUserId(id);
    setActingUser(id);
    setError(null);
    try {
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  /**
   * Everything the console shows, read back from the server. It is refreshed
   * after every lever the console pulls, because the store is the truth about
   * what happened and the browser's copy is only a picture of it.
   */
  const refreshConsole = useCallback(async () => {
    const [audit, sessions, docs, people] = await Promise.all([
      api.operatorAudit(),
      api.operatorSessions(),
      api.operatorDocs(),
      api.users(),
    ]);
    setOperatorData({
      audit: audit.audit,
      sessions: sessions.sessions,
      docs: docs.docs,
    });
    setUsers(people.users);
  }, []);

  /**
   * Assigns a role. The browser decides nothing by doing this: it asks the
   * server to write a different role, and every later decision is made against
   * what the store then holds — including for runs already in flight.
   */
  const assignRole = async (id: string, role: Role) => {
    setError(null);
    try {
      await api.setUserRole(id, role);
      await Promise.all([refreshConsole(), refreshAgents()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  /** Revokes an Agent's live run credentials. The server does the revoking. */
  const revokeSessions = async (agentId: string) => {
    setError(null);
    try {
      await api.revokeAgentSessions(agentId);
      await refreshConsole();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const usersById = useMemo(
    () => new Map(users.map((user) => [user.id, user])),
    [users],
  );

  const ownerName = (ownerId: string) =>
    usersById.get(ownerId)?.name ?? ownerId;

  const ownerRole = (ownerId: string) => usersById.get(ownerId)?.role ?? null;

  // Only ever show evidence belonging to the Run on screen, so switching Runs
  // cannot leave one Run's decisions filed under another's name.
  const auditRecords =
    activeRun && runEvidence?.runId === activeRun.id ? runEvidence.records : [];

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  /**
   * The Run's gateway decisions, read back alongside the Run itself: polling
   * replaces `activeRun` on every tick, so decisions appear while the Run is
   * still going rather than only once it finishes. The read is best-effort —
   * evidence trouble must not take the Playground down with it.
   */
  useEffect(() => {
    const runId = activeRun?.id;
    if (!runId) return;
    let current = true;
    void api
      .runAudit(runId)
      .then((result) => {
        if (current && mountedRef.current) {
          setRunEvidence({ runId, records: result.audit });
        }
      })
      .catch(() => {
        // Leave whatever the panel already shows for this Run.
      });
    return () => {
      current = false;
    };
  }, [activeRun]);

  /**
   * The console re-reads while it is open, so a decision made by an Agent that
   * is running right now appears in the feed without anyone reloading. Failures
   * are swallowed: a console that blanks itself on one bad read is worse than
   * one showing the last thing it knew.
   */
  useEffect(() => {
    if (!showConsole) return;
    let current = true;
    const read = () => {
      if (!current) return;
      void refreshConsole().catch(() => undefined);
    };
    read();
    const timer = window.setInterval(read, 3_000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [showConsole, refreshConsole]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (
      !window.confirm(
        "Delete " + selected.name + "? Its workspace will be archived.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshAgents()]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? (
            <div className="error-banner" role="alert">
              {error}
            </div>
          ) : (
            <Spinner />
          )}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button
            className="button button-primary"
            disabled={busy || !authInput.trim()}
          >
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <div className="user-switcher">
          <label htmlFor="acting-user">Acting as</label>
          <select
            id="acting-user"
            value={actingUser}
            onChange={(event) => void switchActingUser(event.target.value)}
          >
            {users.length === 0 && (
              <option value={actingUser}>{actingUser}</option>
            )}
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name} · {user.role}
              </option>
            ))}
          </select>
          <span>
            Dev switcher. The server resolves this user&apos;s role and decides
            what their Agents may do.
          </span>
          {/* Roles as the store holds them right now, so a promotion left over
              from an earlier demo step is visible rather than latent. */}
          <ul className="role-roster">
            {users.map((user) => (
              <li key={user.id}>
                <span>{user.name}</span>
                <span className={"role-chip role-" + user.role}>
                  {user.role}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <button
          className={"button button-ghost console-toggle"}
          onClick={() => setShowConsole((value) => !value)}
          aria-pressed={showConsole}
        >
          {showConsole ? "Back to the Playground" : "Operator Console"}
        </button>

        <div className="sidebar-label">
          <span>Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={
                "agent-card " + (agent.id === selectedId ? "selected" : "")
              }
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">
                {agent.name.slice(0, 1).toUpperCase()}
              </div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
                <span
                  className={
                    "owner-tag " +
                    (agent.ownerId === actingUser ? "owner-tag-self" : "")
                  }
                >
                  {agent.ownerId === actingUser
                    ? "Owned by you"
                    : "Owned by " + ownerName(agent.ownerId)}
                </span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {showConsole ? (
          <OperatorConsole
            audit={operatorData.audit}
            sessions={operatorData.sessions}
            docs={operatorData.docs}
            users={users}
            ownerName={ownerName}
            onAssignRole={(id, role) => void assignRole(id, role)}
            onRevoke={(agentId) => void revokeSessions(agentId)}
          />
        ) : selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                  <span className="owner-pill">
                    {ownerName(selected.ownerId)}
                    {ownerRole(selected.ownerId)
                      ? " · " + ownerRole(selected.ownerId)
                      : ""}
                  </span>
                </div>
                <p>
                  {selected.description ||
                    "A Codex coding Agent in an isolated workspace."}
                </p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>
                    ×
                  </button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) =>
                        setForm({ ...form, name: event.target.value })
                      }
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Build something with your Agent</h2>
                </div>
                <div className="session-info">
                  <span className="pulse" />
                  {selected.codexThreadId ? "Session connected" : "New session"}
                </div>
              </div>

              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and
                      continue the same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article
                      className={"message message-" + message.role}
                      key={message.id}
                    >
                      <div className="message-meta">
                        <strong>
                          {message.role === "user" ? "You" : selected.name}
                        </strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))
                )}
                {activeRun &&
                  ["queued", "running"].includes(activeRun.status) && (
                    <article className="message message-assistant thinking">
                      <div className="message-meta">
                        <strong>{selected.name}</strong>
                        <span>working in the Agent workspace</span>
                      </div>
                      <div className="thinking-row">
                        <Spinner />
                        Codex is reading, editing, or running commands…
                      </div>
                    </article>
                  )}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                  </article>
                )}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    (activeRun != null &&
                      ["queued", "running"].includes(activeRun.status))
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline ·{" "}
                    {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null &&
                        ["queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>

              <section className="evidence" aria-live="polite">
                <div className="evidence-topbar">
                  <div>
                    <span className="eyebrow">Gateway evidence</span>
                    <h3>What this Run was allowed to do</h3>
                  </div>
                  <span className="evidence-usage">
                    {formatUsage(activeRun)}
                  </span>
                </div>

                {auditRecords.length === 0 ? (
                  <p className="evidence-empty">
                    {activeRun
                      ? "No gateway decisions recorded for this Run yet."
                      : "Send a task — the gateway's decisions for that Run appear here."}
                  </p>
                ) : (
                  <ul className="audit-list">
                    {auditRecords.map((record) => (
                      <li
                        className={"audit-row audit-" + record.decision}
                        key={record.id}
                      >
                        <span className="audit-decision">
                          {record.decision}
                        </span>
                        <span className="audit-tool">{record.tool}</span>
                        <span className="audit-resource">
                          {record.resource ?? "—"}
                        </span>
                        <span className="audit-reason">{record.reason}</span>
                        <span className="audit-ts">
                          {formatTime(record.ts)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <p className="evidence-note">
                  Every row was decided and recorded server-side by the gateway
                  before the Agent got an answer. This panel only displays them.
                </p>
              </section>
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>
              Create a workspace, give Codex a job, and continue the
              conversation here.
            </p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <div
          className="modal-backdrop"
          onMouseDown={() => setShowCreate(false)}
        >
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>
                  Each Agent gets a persistent folder and a resumable Codex
                  session.
                </p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>
                ×
              </button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <p className="owner-note">
              The server records this Agent as owned by{" "}
              <strong>{ownerName(actingUser)}</strong>
              {ownerRole(actingUser) ? " (" + ownerRole(actingUser) + ")" : ""}.
              Its Runs get that owner&apos;s authority, and no more.
            </p>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
