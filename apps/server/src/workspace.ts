import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "./types.js";

export class WorkspaceManager {
  /**
   * `toolsBaseUrl` is the gateway origin as Codex itself reaches it — the same
   * value written into `config.toml` for model calls — so AGENTS.md can name a
   * concrete origin to curl rather than leaving an Agent to guess one. Optional
   * because most tests construct a WorkspaceManager with no runner behind it.
   */
  constructor(
    private readonly root: string,
    private readonly toolsBaseUrl?: string,
  ) {}

  workspacePath(agentId: string): string {
    return path.join(this.root, agentId);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".deleted"), { recursive: true });
  }

  async create(agent: Agent): Promise<void> {
    await mkdir(agent.workspacePath, { recursive: false });
    await this.writeInstructions(agent);
    await writeFile(
      path.join(agent.workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(agent.workspacePath, "README.md"),
      [
        "# " + agent.name + " workspace",
        "",
        "Files created or edited by the Agent live here.",
        "The platform-generated AGENTS.md contains the current Agent instructions.",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  async writeInstructions(agent: Agent): Promise<void> {
    const content = [
      "# Platform-managed Agent instructions",
      "",
      "You are the coding Agent named " + agent.name + ".",
      agent.description ? "Purpose: " + agent.description : "",
      "",
      "## Instructions",
      "",
      agent.instructions ||
        "Help the user complete coding tasks in this workspace. Explain material results concisely.",
      "",
      "## Workspace rules",
      "",
      "- Work only inside this workspace unless the user explicitly requests otherwise.",
      "- Preserve existing user files and avoid destructive operations.",
      "- Build and test changes when practical.",
      "- Never print environment variables or credentials.",
      "",
      ...(this.toolsBaseUrl ? this.toolInstructions(this.toolsBaseUrl) : []),
      "This file is regenerated when the Agent configuration is updated.",
      "",
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n");
    await writeFile(
      path.join(agent.workspacePath, "AGENTS.md"),
      content,
      "utf8",
    );
  }

  /**
   * The gateway tools beyond the model — search, doc reads, payments — reach
   * this Agent only over HTTP, so it has no way to know they exist unless it is
   * told here. `$RUN_JWT` is already the credential this process authenticates
   * its model calls with; the same bearer token authorizes these calls too.
   */
  private toolInstructions(baseUrl: string): string[] {
    return [
      "## Gateway tools",
      "",
      "Beyond the model itself, the Agent Access Gateway proxies three tools " +
        "over HTTP, authorized per call from your current owner's role. " +
        "Authenticate each request with `Authorization: Bearer $RUN_JWT` — " +
        "the same credential already in your environment for model calls.",
      "",
      "- Search documents: `GET " + baseUrl + "/tools/search?q=<query>`",
      "- Read one document: `GET " + baseUrl + "/tools/docs/<docId>`",
      "- Submit a payment: `POST " +
        baseUrl +
        '/tools/payments` with a JSON body `{ "amount": <number>, "currency": "USD", "memo": "..." }`',
      "",
      "Example:",
      "",
      "```",
      'curl -sS -H "Authorization: Bearer $RUN_JWT" "' +
        baseUrl +
        '/tools/search?q=quarterly"',
      "```",
      "",
      "A tool your role does not grant answers `403`. An unknown or " +
        "unreadable document answers `404` either way, so do not treat a " +
        "`404` on `docs` as proof an id does not exist.",
      "",
    ];
  }

  async archive(agent: Agent): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      this.root,
      ".deleted",
      agent.id + "-" + timestamp,
    );
    await rename(agent.workspacePath, destination);
    return destination;
  }
}
