import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCodexArgs,
  buildCodexEnvironment,
  CodexRunner,
  parseCodexEventLine,
} from "./codex-runner.js";
import { loadConfig } from "./config.js";
import { RUN_JWT_ENV_KEY } from "./gateway.js";

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
        runJwt: "run-jwt-for-this-test",
      },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "build a calculator",
    ]);
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
        runJwt: "run-jwt-for-this-test",
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
  });

  it("extracts the session, final message and usage", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
    };
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });
});

describe("Local Codex runner credentials and config", () => {
  const temporaryHomes: string[] = [];

  afterEach(async () => {
    while (temporaryHomes.length > 0) {
      const directory = temporaryHomes.pop();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });

  async function temporaryCodexHome(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "launchpad-codex-"));
    temporaryHomes.push(directory);
    return directory;
  }

  it("keeps the Ark key out of the Codex process environment", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      GATEWAY_JWT_SECRET: "gateway-test-signing-secret",
      ARK_API_KEY: "secret-that-must-not-reach-codex",
      ARK_MODEL: "ep-test",
      CODEX_HOME: await temporaryCodexHome(),
    });
    const environment = buildCodexEnvironment(config, "run-jwt-for-this-test");
    expect(environment.ARK_API_KEY).toBeUndefined();
    expect(Object.values(environment)).not.toContain(
      "secret-that-must-not-reach-codex",
    );
    // Codex holds the run's own credential, and only for a real run.
    expect(environment[RUN_JWT_ENV_KEY]).toBe("run-jwt-for-this-test");
    expect(buildCodexEnvironment(config)[RUN_JWT_ENV_KEY]).toBeUndefined();
  });

  it("points Codex at the loopback gateway", async () => {
    const codexHome = await temporaryCodexHome();
    const config = loadConfig({
      NODE_ENV: "test",
      GATEWAY_JWT_SECRET: "gateway-test-signing-secret",
      ARK_API_KEY: "secret-that-must-not-reach-codex",
      ARK_MODEL: "ep-test",
      CODEX_HOME: codexHome,
      PORT: "4321",
    });
    const runner = new CodexRunner(config);
    await runner.ensureCodexConfig();

    const toml = await readFile(path.join(codexHome, "config.toml"), "utf8");
    expect(toml).toContain('base_url = "http://127.0.0.1:4321/gateway/v1"');
    expect(toml).toContain('env_key = "RUN_JWT"');
    expect(toml).toContain('model = "ep-test"');
    expect(toml).not.toContain("secret-that-must-not-reach-codex");
    expect(toml).not.toContain("ARK_API_KEY");
    expect(toml).not.toContain("ark.cn-beijing.volces.com");
  });
});
