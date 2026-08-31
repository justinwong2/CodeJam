# Architecture Diagram

The hackathon deliverable: **the middleware, the data flow, the trust
boundaries, and the enforcement, instrumentation, and recovery points** on one
page.

The Starter Kit's baseline diagram left a single generic **"Team-Designed
Middleware"** node with three dotted `integrate` arrows into the Fastify API,
`AgentService`, and the `AgentRunner` interface. This diagram is that node filled
in. All three seams are genuinely used: the gateway mounts at the Fastify request
boundary, `AgentService` mints the run credential, and the runner's generated
`config.toml` is repointed at the gateway.

The baseline also drew the Agent Runtime calling **Volcengine Ark directly**.
That arrow required the Ark key to live inside the container, which is the
vulnerability this project removes. It appears below in red, struck through.

> **Colour key.** Blue is Starter Kit baseline, unchanged. **Green is
> team-designed middleware — everything new.** Orange is a server-held secret.
> Red is a denial or a removed path.

---

## The diagram

```mermaid
flowchart TB

  HUMAN["Human user"]

  subgraph BROWSER["🟡 SEMI-TRUSTED · Browser"]
    UI["React Web UI<br/>Playground · Operator Console<br/><i>displays · enforces nothing</i>"]
  end

  subgraph SERVER["🟢 TRUSTED · Server process — secrets exist only here"]
    direction TB

    subgraph CP["Control plane · /api/* — ISSUES credentials"]
      direction LR
      API["Fastify API<br/>validation · acting user"]
      SVC["AgentService<br/><b>mints RunSession + RUN_JWT</b>"]
      API --> SVC
    end

    subgraph GWBOX["★ AGENT ACCESS GATEWAY · /gateway/v1/* — VERIFIES ONLY"]
      direction TB
      G1["1 · authenticate<br/>JWT signature + live RunSession<br/><b>fail → 401</b>"]
      G2["2 · resolve principal<br/>owner role ∩ Agent grants<br/><i>read live from the store</i><br/><b>missing record → 403</b>"]
      G3["3 · can()<br/>tool RBAC + ownership<br/><b>RBAC fail → 403<br/>ownership fail → 404 invisible</b>"]
      G4["4 · withinBudget()<br/>owner token ceiling<br/><i>settled store + in-flight memory</i><br/><b>fail → 402</b>"]
      G5["5 · AuditLog<br/><b>written BEFORE the answer</b>"]
      G6["6 · inject ARK_API_KEY<br/>stream the reply through"]
      G1 --> G2 --> G3 --> G4 --> G5 --> G6
    end

    subgraph TOOLSVC["Mock tool service · /internal/tools/*"]
      direction TB
      T1["7 · gateway credential required<br/><b>fail → 401</b>"]
      T2["8 · visibleTo(scope) re-derived<br/><b>missing scope → 400<br/>hidden doc → 404 · search row → filtered</b>"]
      T1 --> T2
    end

    STORE[("JSON store<br/>users · agents · runs<br/>sessions · docs")]
    AUDIT[("Audit sidecar<br/>db.json.audit.jsonl")]
    WS["Per-Agent Workspace"]
    RUNNER{"AgentRunner<br/>interface"}
    VAULT["🔑 ARK_API_KEY<br/>GATEWAY_JWT_SECRET<br/>GATEWAY_TOOL_CREDENTIAL"]
  end

  subgraph RUNTIME["🔴 UNTRUSTED · Runtime container"]
    CODEX["Codex CLI · Docker / Colima / Podman<br/>runs arbitrary shell · writes files<br/><b>holds RUN_JWT only</b><br/>✗ no ARK_API_KEY to steal"]
  end

  ARK["Volcengine Ark<br/>Responses API"]

  HUMAN --> UI
  UI -->|"1 · POST /api/agents/:id/messages"| API
  SVC -->|"2 · write Run + RunSession atomically"| STORE
  SVC --> WS
  SVC --> RUNNER
  RUNNER -->|"3 · RUN_JWT by name, never in argv"| CODEX
  CODEX -->|"4 · EVERY model and tool call<br/>Authorization: Bearer RUN_JWT"| G1
  G2 -.-> STORE
  G4 -.-> STORE
  G5 ==>|"one record per decision"| AUDIT
  VAULT -.-> G6
  G6 -->|"5 · Authorization: Bearer ARK_API_KEY"| ARK
  G6 -->|"6 · + tool credential + x-launchpad-scope"| T1
  T2 -.-> STORE
  AUDIT -.->|"7 · evidence: /runs/:id/audit · /operator/*"| UI
  UI -->|"8 · RECOVERY: revoke · role · budget · reset spend"| API

  G1 -.->|"401"| CODEX
  G3 -.->|"403"| CODEX
  G4 -.->|"402"| CODEX
  T2 -.->|"404"| CODEX

  CODEX -. "✗ BASELINE PATH REMOVED — the Ark key lived in the container" .-> ARK

  classDef baseline fill:#dae8fc,stroke:#6c8ebf,stroke-width:1px,color:#000
  classDef middleware fill:#d5e8d4,stroke:#82b366,stroke-width:2px,color:#000
  classDef secret fill:#ffe6cc,stroke:#d79b00,stroke-width:2px,color:#000
  classDef external fill:#f0f0f0,stroke:#666666,stroke-width:1px,color:#000

  class HUMAN,UI,API,SVC,STORE,WS,RUNNER,CODEX baseline
  class G1,G2,G3,G4,G5,G6,T1,T2,AUDIT middleware
  class VAULT secret
  class ARK external

  style BROWSER fill:#fffdf5,stroke:#d6b656,stroke-width:2px,stroke-dasharray: 8 4
  style SERVER fill:#f7fbf7,stroke:#82b366,stroke-width:2px,stroke-dasharray: 8 4
  style RUNTIME fill:#fff6f6,stroke:#b85450,stroke-width:2px,stroke-dasharray: 8 4
  style GWBOX fill:#eaf5ea,stroke:#82b366,stroke-width:4px
  style TOOLSVC fill:#eaf5ea,stroke:#82b366,stroke-width:2px
  style CP fill:#eef4fc,stroke:#6c8ebf,stroke-width:2px

  linkStyle 23,24,25,26 stroke:#b85450,stroke-width:2px,color:#b85450
  linkStyle 27 stroke:#b85450,stroke-width:4px,color:#b85450
```

---

## Enforcement points

Every one is server-side. Every denial is decided **before** anything is
forwarded, so a refused call reaches no upstream and costs nothing.

| #   | Check                                                                   | Where                       | Denies with                    |
| --- | ----------------------------------------------------------------------- | --------------------------- | ------------------------------ |
| 1   | JWT signature, algorithm, expiry, **and** a live unrevoked `RunSession` | `gateway.ts` · `run-jwt.ts` | `401`                          |
| 2   | Principal resolved from the Agent's **current** owner and grants        | `gateway.ts`                | `403` if either record is gone |
| 3   | `can()` — owner role ∩ Agent grants ∩ resource visibility               | `authz.ts`                  | `403`                          |
| 4   | `withinBudget()` — settled + in-flight spend against the owner ceiling  | `budget.ts`                 | `402`                          |
| 7   | Call carries the gateway's tool credential                              | `mock-tools.ts`             | `401`                          |
| 8   | `visibleTo(scope)` re-derived independently downstream                  | `mock-tools.ts`             | `404`                          |

**Instrumentation** is point 5: `AuditLog` is the single writer, one redacted
record per decision, appended to the sidecar and awaited **before** the caller is
answered. No request or response body is ever stored.

**Recovery** is flow 8: revoke a run credential, change a role, cut a budget, or
reset spend. All four land on the Agent's **next gateway call**, because
permissions are read from the store per call and were never in the credential.

---

## Trust boundaries

| Boundary               | What crosses it                                              | What stops there                                                   |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| Browser → Server       | A **user id** (`x-launchpad-user`) and the shared demo token | Roles and permissions — the browser never asserts either           |
| Server → Runtime       | `RUN_JWT` — short-lived, revocable, **permission-free**      | **`ARK_API_KEY`. It never crosses.**                               |
| Runtime → Server       | Every model and tool call, bearing only `RUN_JWT`            | Anything unverifiable, unauthorized, or unaffordable               |
| Gateway → Tool service | The gateway's own credential + the authorized scope          | The agent's credential — nothing downstream can replay a run token |

> **There is no code path anywhere in this system where a client asserts a
> permission.** Clients assert _identity_; the server derives _authority_, from
> stored policy, on every call.

---

## In one paragraph

> The baseline routed the Agent Runtime directly to Ark, which required the API
> key inside a container that runs arbitrary shell commands. We replaced that
> path with the **Agent Access Gateway**: the agent holds only a short-lived,
> revocable, permission-free run credential and knows exactly one endpoint. Every
> model and tool call is authenticated against a live run session, authorized
> against the owner's current role intersected with the Agent's delegated grants
> and the resource's visibility, checked against the owner's token budget, and
> recorded — all before the real credential is attached server-side and the call
> is forwarded. Because permissions live in the store rather than in the token,
> revoking an agent, demoting a human, or cutting a budget takes effect on the
> very next call.

---

## Reproducing this diagram

A rendered copy is committed at [assets/architecture.pdf](assets/architecture.pdf),
one page, for reading away from a Markdown viewer.

The fenced Mermaid block above remains the single source — the PDF is generated
from it and is never edited directly. To regenerate after changing the block,
extract it to `architecture.mmd` and run:

```bash
npx -y @mermaid-js/mermaid-cli \
  -i architecture.mmd -o docs/assets/architecture.pdf --pdfFit -b white
```

`--pdfFit` is what keeps it to one page; `-b white` avoids a transparent
background that prints grey. Pasting the block into <https://mermaid.live>
exports the same thing by hand.
