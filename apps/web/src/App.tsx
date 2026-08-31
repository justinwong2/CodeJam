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
  MockDoc,
  MockDocMetadata,
  OwnerSpend,
  Role,
  RunSessionClaims,
  SystemInfo,
  ToolName,
  User,
  Visibility,
} from "./types";
import { ROLE_NAMES, VISIBILITY_NAMES } from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

interface AgentForm {
  name: string;
  description: string;
  instructions: string;
  toolGrants: ToolName[] | null;
}

const emptyForm: AgentForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
  toolGrants: null,
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

function ToolGrantEditor({
  value,
  availableTools,
  onChange,
  disabled = false,
}: {
  value: ToolName[] | null;
  availableTools: ToolName[];
  onChange: (value: ToolName[] | null) => void;
  disabled?: boolean;
}) {
  const inherited = value === null;
  return (
    <fieldset className="tool-grants" disabled={disabled}>
      <legend>Delegated gateway tools</legend>
      <label className="inherit-grants">
        <input
          type="checkbox"
          checked={inherited}
          onChange={(event) =>
            onChange(event.target.checked ? null : [...availableTools])
          }
        />
        Inherit the owner role
      </label>
      <div className="tool-grant-options">
        {availableTools.map((tool) => (
          <label key={tool}>
            <input
              type="checkbox"
              checked={inherited || value.includes(tool)}
              disabled={disabled || inherited}
              onChange={(event) => {
                const current = value ?? [];
                onChange(
                  event.target.checked
                    ? [...current, tool]
                    : current.filter((item) => item !== tool),
                );
              }}
            />
            {tool}
          </label>
        ))}
      </div>
      <small>
        The owner&apos;s current role is always the ceiling. These grants can
        restrict an Agent, never elevate it.
      </small>
    </fieldset>
  );
}

const tokens = (value: number): string => value.toLocaleString("en-US");

/**
 * What one human has spent against their ceiling.
 *
 * The two halves are shown as two things rather than one total, because they
 * are not the same kind of number: settled spend is measured from Runs that
 * finished, while in-flight spend is the gateway's estimate for Runs still
 * going. Summing them into a single figure would present a guess with the same
 * confidence as a measurement.
 */
function SpendCell({ spend }: { spend: OwnerSpend | undefined }) {
  if (!spend) return <span className="spend-idle">—</span>;
  const used = spend.settled + spend.inFlight;
  const share = spend.budget > 0 ? used / spend.budget : 0;
  return (
    <span className="spend">
      <span className={share >= 1 ? "spend-used spend-over" : "spend-used"}>
        {tokens(used)}
        {spend.budget > 0 ? " / " + tokens(spend.budget) : ""}
      </span>
      {spend.inFlight > 0 ? (
        <span className="spend-detail">
          {tokens(spend.settled)} settled · {tokens(spend.inFlight)} in flight
          (est.)
        </span>
      ) : null}
    </span>
  );
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
  spend,
  users,
  ownerName,
  onAssignRole,
  onAssignTokenBudget,
  onResetSpend,
  onRevoke,
}: {
  audit: AuditRecord[];
  sessions: RunSessionClaims[];
  docs: MockDocMetadata[];
  spend: OwnerSpend[];
  users: User[];
  ownerName: (ownerId: string) => string;
  onAssignRole: (id: string, role: Role) => void;
  onAssignTokenBudget: (id: string, tokenBudget: number) => void;
  onResetSpend: (id: string) => void;
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
              <th>Spend</th>
              <th>Token budget</th>
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
                <td>
                  <SpendCell
                    spend={spend.find((row) => row.userId === user.id)}
                  />
                </td>
                <td>
                  {/*
                    Committed on blur rather than on every keystroke: each
                    change is a server write that the next gateway call reads,
                    and typing "50000" should not spend four intermediate
                    ceilings on its way there.
                  */}
                  <input
                    type="number"
                    min={0}
                    step={1000}
                    className="budget-input"
                    aria-label={"Token budget for " + user.name}
                    defaultValue={user.tokenBudget}
                    key={user.id + ":" + String(user.tokenBudget)}
                    onBlur={(event) => {
                      const next = Number(event.target.value);
                      if (!Number.isInteger(next) || next < 0) return;
                      if (next === user.tokenBudget) return;
                      onAssignTokenBudget(user.id, next);
                    }}
                  />
                  <span className="budget-hint">
                    {user.tokenBudget === 0 ? "unlimited" : "tokens"}
                  </span>
                  {/*
                    Forgets what was spent, not what may be spent. Raising the
                    ceiling would also unblock a spent-out human, but it moves
                    the goalposts; this restores the allowance they were given.
                  */}
                  <button
                    type="button"
                    className="button button-ghost console-button budget-reset"
                    onClick={() => onResetSpend(user.id)}
                  >
                    Reset spend
                  </button>
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
            Ground truth: which documents exist, who owns them, and which are
            public. Read a scoped search against this — a filtered-out row is
            invisible in the answer and leaves no decision behind. Metadata
            only: content belongs to the owner, not to whoever opens this page.
          </span>
        </div>
        <table className="console-table">
          <thead>
            <tr>
              <th>Document</th>
              <th>Title</th>
              <th>Owner</th>
              <th>Visibility</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((doc) => (
              <tr key={doc.id}>
                <td className="mono">{doc.id}</td>
                <td>{doc.title}</td>
                <td>{ownerName(doc.ownerId)}</td>
                <td>
                  <span
                    className={"visibility-chip visibility-" + doc.visibility}
                  >
                    {doc.visibility}
                  </span>
                </td>
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

/**
 * The human half of the document surface: what the acting user may see, and the
 * form that adds one. It displays and it asks — the list is whatever the server
 * answered for this user, scoped by the same predicate that scopes an Agent's
 * search, and the owner of an upload is decided server-side from the acting
 * user, never from anything typed here.
 */
function DocumentsPanel({
  docs,
  actingUserName,
  ownerName,
  form,
  onFormChange,
  onUpload,
  busy,
}: {
  docs: MockDoc[];
  actingUserName: string;
  ownerName: (ownerId: string) => string;
  form: { title: string; content: string; visibility: Visibility };
  onFormChange: (form: {
    title: string;
    content: string;
    visibility: Visibility;
  }) => void;
  onUpload: (event: React.FormEvent) => void;
  busy: boolean;
}) {
  return (
    <section className="console">
      <header className="console-header">
        <div>
          <span className="eyebrow">Documents</span>
          <h1>What {actingUserName} may see</h1>
          <p>
            Their own documents and every public one — the same rule the gateway
            scopes an Agent&apos;s search with, applied server-side to this
            listing. Switch the acting user and the list changes with them.
          </p>
        </div>
        <div className="console-counts">
          <span>
            <strong>{docs.length}</strong> visible
          </span>
          <span>
            <strong>
              {docs.filter((doc) => doc.visibility === "public").length}
            </strong>{" "}
            public
          </span>
        </div>
      </header>

      <div className="console-panel">
        <div className="console-panel-head">
          <h2>Upload a document</h2>
          <span>
            Plain text, a few KB. Visibility is chosen once, here: there is no
            toggle afterwards. The server records{" "}
            <strong>{actingUserName}</strong> as its owner.
          </span>
        </div>
        <form className="doc-form" onSubmit={onUpload}>
          <div className="form-grid">
            <label>
              Title
              <input
                value={form.title}
                onChange={(event) =>
                  onFormChange({ ...form, title: event.target.value })
                }
                placeholder="Q3 rollout notes"
                required
                maxLength={120}
              />
            </label>
            <label>
              Visibility
              <select
                value={form.visibility}
                onChange={(event) =>
                  onFormChange({
                    ...form,
                    visibility: event.target.value as Visibility,
                  })
                }
              >
                {VISIBILITY_NAMES.map((visibility) => (
                  <option key={visibility} value={visibility}>
                    {visibility}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Content
            <textarea
              value={form.content}
              onChange={(event) =>
                onFormChange({ ...form, content: event.target.value })
              }
              rows={4}
              maxLength={4_000}
              placeholder="Anything an Agent might be asked to read."
              required
            />
          </label>
          <div className="panel-footer">
            <span>
              A private document is invisible to everybody else — absent from
              their listing, absent from their Agents&apos; search, and a direct
              fetch by id answers as if it never existed.
            </span>
            <button className="button button-primary" disabled={busy}>
              {busy ? <Spinner /> : "Upload"}
            </button>
          </div>
        </form>
      </div>

      <div className="console-panel">
        <div className="console-panel-head">
          <h2>Visible documents</h2>
          <span>
            Owner and visibility as the store holds them. Nothing here is
            filtered in the browser: this is the server&apos;s answer for this
            user.
          </span>
        </div>
        <table className="console-table">
          <thead>
            <tr>
              <th>Document</th>
              <th>Title</th>
              <th>Owner</th>
              <th>Visibility</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((doc) => (
              <tr key={doc.id}>
                <td className="mono">{doc.id}</td>
                <td>{doc.title}</td>
                <td>{ownerName(doc.ownerId)}</td>
                <td>
                  <span
                    className={"visibility-chip visibility-" + doc.visibility}
                  >
                    {doc.visibility}
                  </span>
                </td>
              </tr>
            ))}
            {docs.length === 0 && (
              <tr>
                <td colSpan={4} className="console-empty">
                  Nothing visible to this user yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
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
  const [delegatableToolsByRole, setDelegatableToolsByRole] = useState<
    Partial<Record<Role, ToolName[]>>
  >({});
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
  // Which surface is on screen. The Playground is one Agent's conversation, the
  // console is every decision, and Documents is what this human may see.
  const [view, setView] = useState<"playground" | "console" | "documents">(
    "playground",
  );
  const [docs, setDocs] = useState<MockDoc[]>([]);
  const [docForm, setDocForm] = useState<{
    title: string;
    content: string;
    visibility: Visibility;
  }>({ title: "", content: "", visibility: "private" });
  const [operatorData, setOperatorData] = useState<{
    audit: AuditRecord[];
    sessions: RunSessionClaims[];
    docs: MockDocMetadata[];
    spend: OwnerSpend[];
  }>({ audit: [], sessions: [], docs: [], spend: [] });
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const actingUserRef = useRef(actingUser);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;
  actingUserRef.current = actingUser;

  // Only the acting human's own Agents belong in the Playground sidebar — an
  // Agent owned by whoever else is seeded is not this human's to select, and
  // showing it invites picking someone else's conversation by accident. The
  // Operator Console is the all-owners view; this one is scoped on purpose.
  const visibleAgents = useMemo(
    () => agents.filter((agent) => agent.ownerId === actingUser),
    [agents, actingUser],
  );

  const selected = useMemo(
    () => visibleAgents.find((agent) => agent.id === selectedId) ?? null,
    [visibleAgents, selectedId],
  );

  // Stable identity on purpose: it composes into `bootstrap`, which the
  // mount effect below depends on. Reading `actingUser` from a ref rather
  // than closing over it keeps that effect from re-running (and re-asking
  // for the shared access token) every time the user switcher changes.
  const refreshAgents = useCallback(
    async (ownerId: string = actingUserRef.current) => {
      const { agents: next } = await api.listAgents();
      setAgents(next);
      setSelectedId((current) => {
        const owned = next.filter((agent) => agent.ownerId === ownerId);
        return current && owned.some((agent) => agent.id === current)
          ? current
          : (owned[0]?.id ?? null);
      });
    },
    [],
  );

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
      api.users().then((result) => {
        setUsers(result.users);
        setDelegatableToolsByRole(result.delegatableToolsByRole);
      }),
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
      await refreshAgents(id);
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
    const [audit, sessions, docs, spend, people] = await Promise.all([
      api.operatorAudit(),
      api.operatorSessions(),
      api.operatorDocs(),
      api.operatorSpend(),
      api.users(),
    ]);
    setOperatorData({
      audit: audit.audit,
      sessions: sessions.sessions,
      docs: docs.docs,
      spend: spend.spend,
    });
    setUsers(people.users);
    setDelegatableToolsByRole(people.delegatableToolsByRole);
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

  /**
   * Sets a human's token ceiling. Like a role, it is written server-side and
   * read on the next gateway call, so lowering it lands on a run already in
   * flight. The browser neither meters nor enforces: it shows what the server
   * decided, in the evidence panel, one decision at a time.
   */
  const assignTokenBudget = async (id: string, tokenBudget: number) => {
    setError(null);
    try {
      await api.setUserTokenBudget(id, tokenBudget);
      await refreshConsole();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  /**
   * Forgets what this human has spent, without touching what they may spend.
   * The server marks the moment and clears the meters for Runs still going, so
   * the next gateway call starts from zero — a clean start rather than a raised
   * ceiling, which is the operator action a spent-out demo actually wants.
   */
  const resetSpend = async (id: string) => {
    setError(null);
    try {
      await api.resetUserSpend(id);
      await refreshConsole();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  /**
   * The documents the server says this human may see. Re-read whenever the
   * acting user changes, because the answer is scoped to whoever asked — the
   * browser never filters a list it was given.
   */
  const refreshDocs = useCallback(async () => {
    const result = await api.docs();
    if (mountedRef.current) setDocs(result.docs);
  }, []);

  /** Uploads a document. The server stamps the owner and fixes the visibility. */
  const uploadDocument = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.uploadDoc({
        title: docForm.title.trim(),
        content: docForm.content,
        visibility: docForm.visibility,
      });
      setDocForm({ title: "", content: "", visibility: "private" });
      await refreshDocs();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
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

  /** Display choices come from the server's live role table, never a UI copy. */
  const availableToolsFor = (ownerId: string): ToolName[] => {
    const role = ownerRole(ownerId);
    return role ? (delegatableToolsByRole[role] ?? []) : [];
  };

  const visibleToolGrants = (
    value: ToolName[] | null,
    ownerId: string,
  ): ToolName[] | null =>
    value === null
      ? null
      : value.filter((tool) => availableToolsFor(ownerId).includes(tool));

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
        toolGrants: selected.toolGrants,
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
    if (view !== "console") return;
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
  }, [view, refreshConsole]);

  /**
   * The document listing is re-read on every user switch as well as on open:
   * the same endpoint answers differently for a different human, which is the
   * whole demonstration.
   */
  useEffect(() => {
    if (view !== "documents") return;
    void refreshDocs().catch((reason) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [view, actingUser, refreshDocs]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent({
        ...form,
        toolGrants: visibleToolGrants(form.toolGrants, actingUser),
      });
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
      await api.updateAgent(selected.id, {
        ...form,
        toolGrants: visibleToolGrants(form.toolGrants, selected.ownerId),
      });
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgentToolGrants = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, {
        toolGrants: visibleToolGrants(form.toolGrants, selected.ownerId),
      });
      await refreshAgents();
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
          onClick={() =>
            setView((current) =>
              current === "console" ? "playground" : "console",
            )
          }
          aria-pressed={view === "console"}
        >
          {view === "console" ? "Back to the Playground" : "Operator Console"}
        </button>

        <button
          className={"button button-ghost console-toggle"}
          onClick={() =>
            setView((current) =>
              current === "documents" ? "playground" : "documents",
            )
          }
          aria-pressed={view === "documents"}
        >
          {view === "documents" ? "Back to the Playground" : "Documents"}
        </button>

        <div className="sidebar-label">
          <span>Agents</span>
          <span>{visibleAgents.length}</span>
        </div>
        <nav className="agent-list">
          {visibleAgents.map((agent) => (
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
                <span className="owner-tag owner-tag-self">
                  Owned by {ownerName(agent.ownerId)}
                </span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {visibleAgents.length === 0 && (
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

        {view === "console" ? (
          <OperatorConsole
            audit={operatorData.audit}
            sessions={operatorData.sessions}
            docs={operatorData.docs}
            spend={operatorData.spend}
            users={users}
            ownerName={ownerName}
            onAssignRole={(id, role) => void assignRole(id, role)}
            onAssignTokenBudget={(id, tokenBudget) =>
              void assignTokenBudget(id, tokenBudget)
            }
            onResetSpend={(id) => void resetSpend(id)}
            onRevoke={(agentId) => void revokeSessions(agentId)}
          />
        ) : view === "documents" ? (
          <DocumentsPanel
            docs={docs}
            actingUserName={ownerName(actingUser)}
            ownerName={ownerName}
            form={docForm}
            onFormChange={setDocForm}
            onUpload={(event) => void uploadDocument(event)}
            busy={busy}
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
                  disabled={busy}
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
                      disabled={selected.status === "busy"}
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
                      disabled={selected.status === "busy"}
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
                    disabled={selected.status === "busy"}
                  />
                </label>
                <ToolGrantEditor
                  value={form.toolGrants}
                  availableTools={availableToolsFor(selected.ownerId)}
                  onChange={(toolGrants) => setForm({ ...form, toolGrants })}
                  disabled={busy}
                />
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <div className="panel-actions">
                    <button
                      type="button"
                      className="button button-ghost"
                      onClick={() => void saveAgentToolGrants()}
                      disabled={busy}
                    >
                      Apply tool grants
                    </button>
                    <button
                      className="button button-primary"
                      disabled={busy || selected.status === "busy"}
                    >
                      {busy ? <Spinner /> : "Save changes"}
                    </button>
                  </div>
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
            <ToolGrantEditor
              value={form.toolGrants}
              availableTools={availableToolsFor(actingUser)}
              onChange={(toolGrants) => setForm({ ...form, toolGrants })}
              disabled={busy}
            />
            <p className="owner-note">
              The server records this Agent as owned by{" "}
              <strong>{ownerName(actingUser)}</strong>
              {ownerRole(actingUser) ? " (" + ownerRole(actingUser) + ")" : ""}.
              Its Runs get at most that owner&apos;s authority; delegated tools
              may narrow it further.
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
