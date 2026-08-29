import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexRunner } from "./codex-runner.js";
import { ContainerCodexRunner } from "./container-codex-runner.js";
import { loadConfig } from "./config.js";
import { RUN_JWT_ENV_KEY } from "./gateway.js";
import type { RunnerRequest } from "./types.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

const spawnMock = vi.mocked(spawn);

// These tests guard the spawn call site itself, not the environment-building
// helpers: a runner that rebuilt or widened the env on the way into spawn
// (e.g. by spreading process.env back in) would leak the Ark key while the
// helper unit tests stayed green.
const ARK_KEY = "secret-that-must-never-reach-a-spawned-process";

class FakeCodexProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: string | null = null;
  kill(): boolean {
    return true;
  }
}

const request: RunnerRequest = {
  agentId: "agent",
  workspacePath: os.tmpdir(),
  prompt: "hello",
  threadId: null,
};

function completeRun(child: FakeCodexProcess): void {
  child.stdout.emit(
    "data",
    Buffer.from(
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }) +
        "\n" +
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "done" },
        }) +
        "\n",
    ),
  );
  child.emit("close", 0);
}

function spawnedEnvironment(): NodeJS.ProcessEnv {
  const options = spawnMock.mock.calls[0]?.at(-1) as SpawnOptions;
  expect(options?.env).toBeDefined();
  return options.env as NodeJS.ProcessEnv;
}

describe("Runner spawn environments", () => {
  const temporaryHomes: string[] = [];

  afterEach(async () => {
    spawnMock.mockReset();
    vi.unstubAllEnvs();
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

  it("spawns local Codex without the Ark key even when the server env holds it", async () => {
    // The server process legitimately holds the key; the child must not.
    vi.stubEnv("ARK_API_KEY", ARK_KEY);
    const config = loadConfig({
      NODE_ENV: "test",
      GATEWAY_JWT_SECRET: "gateway-test-signing-secret",
      ARK_API_KEY: ARK_KEY,
      ARK_MODEL: "ep-test",
      CODEX_HOME: await temporaryCodexHome(),
    });
    const child = new FakeCodexProcess();
    spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

    const runner = new CodexRunner(config);
    const runPromise = runner.run(request);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    completeRun(child);
    const result = await runPromise;
    expect(result.output).toBe("done");
    expect(result.threadId).toBe("thread-1");

    const environment = spawnedEnvironment();
    expect(environment.ARK_API_KEY).toBeUndefined();
    expect(Object.values(environment)).not.toContain(ARK_KEY);
    expect(environment[RUN_JWT_ENV_KEY]).toBeTruthy();
  });

  it("spawns the container engine without the Ark key even when the server env holds it", async () => {
    vi.stubEnv("ARK_API_KEY", ARK_KEY);
    const config = loadConfig({
      NODE_ENV: "test",
      GATEWAY_JWT_SECRET: "gateway-test-signing-secret",
      ARK_API_KEY: ARK_KEY,
      ARK_MODEL: "ep-test",
      CODEX_HOME: await temporaryCodexHome(),
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "docker",
    });
    const child = new FakeCodexProcess();
    spawnMock.mockReturnValueOnce(child as unknown as ChildProcess);

    const runner = new ContainerCodexRunner(config);
    const runPromise = runner.run(request);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    completeRun(child);
    const result = await runPromise;
    expect(result.output).toBe("done");

    expect(spawnMock.mock.calls[0]?.[0]).toBe(config.containerEngine);
    const environment = spawnedEnvironment();
    expect(environment.ARK_API_KEY).toBeUndefined();
    expect(Object.values(environment)).not.toContain(ARK_KEY);
    expect(environment[RUN_JWT_ENV_KEY]).toBeTruthy();
  });
});
