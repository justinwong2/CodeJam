import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { verifyRunJwt } from "./run-jwt.js";
import { JsonStore } from "./store.js";
import { DEFAULT_OWNER_ID } from "./types.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const GATEWAY_SECRET = "gateway-test-signing-secret";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function serviceIn(
  root: string,
  runner: AgentRunner,
  environment: Record<string, string> = {},
): AgentService {
  const config = loadConfig({
    NODE_ENV: "test",
    GATEWAY_JWT_SECRET: GATEWAY_SECRET,
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    ...environment,
  });
  return new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  return root;
}

async function makeService(
  runner: AgentRunner = new FakeRunner(),
  root?: string,
  environment: Record<string, string> = {},
): Promise<AgentService> {
  const service = serviceIn(
    root ?? (await temporaryRoot()),
    runner,
    environment,
  );
  await service.initialize();
  return service;
}

/**
 * Waits for runs to reach a terminal state. `mutate` swaps in the new state
 * only after persisting it, so a terminal status is proof the run's last write
 * is already on disk — which is what makes it safe to delete the directory.
 */
async function settle(
  service: AgentService,
  ...runIds: string[]
): Promise<void> {
  for (const runId of runIds) {
    await expect
      .poll(() => service.getRun(runId).status)
      .not.toMatch(/^(queued|running)$/);
  }
}

/**
 * A runner that reports usage the way Codex actually does: cumulatively for the
 * Agent's thread, so each turn's figure already contains every turn before it.
 * Modelling this is the whole point — a runner reporting per-turn costs would
 * let a sum over Runs look correct when it is not.
 */
function cumulativeRunner(perTurn = 100): AgentRunner {
  const threadTotals = new Map<string, number>();
  return {
    run: async (request) => {
      const next = (threadTotals.get(request.agentId) ?? 0) + perTurn;
      threadTotals.set(request.agentId, next);
      return {
        output: "",
        threadId: "thread-" + request.agentId,
        usage: { inputTokens: next, outputTokens: 0 },
      };
    },
    cancel: async () => false,
    isAvailable: async () => true,
  };
}

/** A runner that never finishes, so a run stays live while a test inspects it. */
function pendingRunner(): {
  runner: AgentRunner;
  requests: RunnerRequest[];
  finish: (result: RunnerResult) => void;
} {
  const requests: RunnerRequest[] = [];
  let finish!: (result: RunnerResult) => void;
  const pending = new Promise<RunnerResult>((resolve) => {
    finish = resolve;
  });
  return {
    requests,
    finish: (result) => finish(result),
    runner: {
      run: (request) => {
        requests.push(request);
        return pending;
      },
      cancel: async () => false,
      isAvailable: async () => true,
    },
  };
}

describe("Run sessions", () => {
  it("hands the runner a credential bound to exactly one live session", async () => {
    const { runner, requests, finish } = pendingRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Signed" });
    const { run } = await service.sendMessage(agent.id, "do the thing");
    await expect.poll(() => requests.length).toBe(1);

    const runJwt = requests[0]?.runJwt ?? "";
    const verified = verifyRunJwt(GATEWAY_SECRET, runJwt);
    expect(verified.valid).toBe(true);
    if (!verified.valid) return;
    expect(verified.claims).toMatchObject({
      agentId: agent.id,
      runId: run.id,
      ownerId: DEFAULT_OWNER_ID,
    });

    // The token is only half of the credential: a matching session must exist.
    const session = service.findRunSession(verified.claims.jti);
    expect(session).toMatchObject({
      runId: run.id,
      agentId: agent.id,
      ownerId: DEFAULT_OWNER_ID,
      jwtId: verified.claims.jti,
      revoked: false,
    });
    expect(Date.parse(session?.expiresAt ?? "")).toBeGreaterThan(Date.now());
    expect(service.listRunSessions(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("credentials a run as the Agent's owner, not the seeded default", async () => {
    const { runner, requests, finish } = pendingRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "B's own" }, "user-b");
    const { run } = await service.sendMessage(agent.id, "do the thing");
    await expect.poll(() => requests.length).toBe(1);

    // The run acts for whoever owns the Agent. Leaving the default here would
    // make every run's evidence trail say `user-a` whoever started it.
    const verified = verifyRunJwt(GATEWAY_SECRET, requests[0]?.runJwt ?? "");
    expect(verified.valid).toBe(true);
    if (!verified.valid) return;
    expect(verified.claims.ownerId).toBe("user-b");
    expect(service.findRunSession(verified.claims.jti)?.ownerId).toBe("user-b");

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("mints a session that lives exactly as long as SESSION_TTL_MS says", async () => {
    const { runner, requests, finish } = pendingRunner();
    const service = await makeService(runner, undefined, {
      SESSION_TTL_MS: "5000",
    });
    const agent = await service.createAgent({ name: "Short-lived" });
    const before = Date.now();
    const { run } = await service.sendMessage(agent.id, "do the thing");
    await expect.poll(() => requests.length).toBe(1);

    const session = service.listRunSessions(agent.id)[0];
    const lifetime = Date.parse(session?.expiresAt ?? "") - before;
    // Bounded on both sides: a lifetime that merely happens to be in the
    // future would pass a one-sided assertion whatever the setting said.
    expect(lifetime).toBeGreaterThan(4_000);
    expect(lifetime).toBeLessThanOrEqual(5_000 + 2_000);

    finish({ output: "done", threadId: "thread", usage: null });
    await settle(service, run.id);
  });

  it("defaults a session's lifetime to the value the coupling used to give it", async () => {
    const { runner, requests, finish } = pendingRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Default" });
    const before = Date.now();
    const { run } = await service.sendMessage(agent.id, "do the thing");
    await expect.poll(() => requests.length).toBe(1);

    // 600_000 + 60_000, as it was before the lifetime had a name of its own.
    const lifetime =
      Date.parse(service.listRunSessions(agent.id)[0]?.expiresAt ?? "") -
      before;
    expect(lifetime).toBeGreaterThan(660_000 - 5_000);
    expect(lifetime).toBeLessThanOrEqual(660_000 + 5_000);

    finish({ output: "done", threadId: "thread", usage: null });
    await settle(service, run.id);
  });

  it("never issues the same session twice", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Repeat" });
    const first = await service.sendMessage(agent.id, "one");
    await expect
      .poll(() => service.getRun(first.run.id).status)
      .toBe("completed");
    const second = await service.sendMessage(agent.id, "two");
    await expect
      .poll(() => service.getRun(second.run.id).status)
      .toBe("completed");

    const sessions = service.listRunSessions(agent.id);
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map((item) => item.jwtId)).size).toBe(2);
    expect(sessions.map((item) => item.runId).sort()).toEqual(
      [first.run.id, second.run.id].sort(),
    );
  });

  it("expires the session when the run completes", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Finished" });
    const { run } = await service.sendMessage(agent.id, "finish");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const session = service.listRunSessions(agent.id)[0];
    expect(session).toBeDefined();
    // The credential outlives nothing: the run is over, so the session is too.
    expect(Date.parse(session?.expiresAt ?? "")).toBeLessThanOrEqual(
      Date.now(),
    );
  });

  it("expires the session when the run fails", async () => {
    const service = await makeService({
      run: async () => {
        throw new Error("runner exploded");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Broken" });
    const { run } = await service.sendMessage(agent.id, "fail");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");

    const session = service.listRunSessions(agent.id)[0];
    expect(Date.parse(session?.expiresAt ?? "")).toBeLessThanOrEqual(
      Date.now(),
    );
  });

  it("revokes sessions a restart left behind", async () => {
    const root = await temporaryRoot();
    const first = pendingRunner();
    const service = await makeService(first.runner, root);
    const agent = await service.createAgent({ name: "Interrupted" });
    const { run } = await service.sendMessage(agent.id, "long task");
    await expect.poll(() => first.requests.length).toBe(1);
    const jwtId = service.listRunSessions(agent.id)[0]?.jwtId ?? "";
    expect(service.findRunSession(jwtId)?.revoked).toBe(false);

    // A second service over the same data directory is a restart.
    const restarted = await makeService(new FakeRunner(), root);
    expect(restarted.getRun(run.id).status).toBe("cancelled");
    expect(restarted.findRunSession(jwtId)?.revoked).toBe(true);

    first.finish({ output: "done", threadId: "thread", usage: null });
    await settle(service, run.id);
  });

  it("revokes every live session for one Agent and leaves others alone", async () => {
    const { runner, requests, finish } = pendingRunner();
    const service = await makeService(runner);
    const target = await service.createAgent({ name: "Revoked" });
    const bystander = await service.createAgent({ name: "Untouched" });
    const targetRun = await service.sendMessage(target.id, "long task");
    const bystanderRun = await service.sendMessage(bystander.id, "also long");
    await expect.poll(() => requests.length).toBe(2);

    expect(await service.revokeAgentSessions(target.id)).toEqual({
      revokedSessions: 1,
    });
    expect(service.listRunSessions(target.id)[0]?.revoked).toBe(true);
    expect(service.listRunSessions(bystander.id)[0]?.revoked).toBe(false);

    // Revocation is idempotent: a second call finds nothing left to revoke.
    expect(await service.revokeAgentSessions(target.id)).toEqual({
      revokedSessions: 0,
    });

    // Both runs must reach a terminal state before the test returns: the write
    // that records it lands in the temp data directory, and an unawaited one
    // races `afterEach` removing that directory.
    finish({ output: "done", threadId: "thread", usage: null });
    await settle(service, targetRun.run.id, bystanderRun.run.id);
  });

  it("refuses to revoke sessions for an Agent that does not exist", async () => {
    const service = await makeService();
    await expect(
      service.revokeAgentSessions("00000000-0000-4000-8000-000000000000"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("drops the sessions of a deleted Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Doomed" });
    const { run } = await service.sendMessage(agent.id, "work");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const jwtId = service.listRunSessions(agent.id)[0]?.jwtId ?? "";

    await service.deleteAgent(agent.id);
    expect(service.findRunSession(jwtId)).toBeUndefined();
  });
});

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect(
      (await service.updateAgent(agent.id, { description: "Builds apps" }))
        .description,
    ).toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("changes only delegated tools while busy and rejects workspace edits", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({
      name: "Delegated",
      toolGrants: ["model", "docs"],
    });
    const { run } = await service.sendMessage(agent.id, "keep running");
    await expect.poll(() => service.getAgent(agent.id).status).toBe("busy");

    const updated = await service.updateAgent(agent.id, {
      toolGrants: ["model"],
    });
    expect(updated.toolGrants).toEqual(["model"]);
    await expect(
      service.updateAgent(agent.id, {
        name: "Cannot rename now",
        toolGrants: null,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  /**
   * Delegation made the workspace write conditional, so both halves of that
   * condition need pinning: a grant is policy the gateway reads from the store
   * and must not rewrite AGENTS.md, while a rename is workspace content and
   * must. Skipping the write for a rename would leave Codex running on stale
   * instructions — a baseline regression no other test would notice.
   */
  it("regenerates workspace instructions for a rename but not for a grant change", async () => {
    const service = await makeService();
    const agent = await service.createAgent({
      name: "Original",
      toolGrants: ["model"],
    });
    const instructions = path.join(agent.workspacePath, "AGENTS.md");
    const before = await readFile(instructions, "utf8");
    expect(before).toContain("Original");

    await service.updateAgent(agent.id, { toolGrants: ["model", "docs"] });
    expect(await readFile(instructions, "utf8")).toBe(before);

    await service.updateAgent(agent.id, { name: "Renamed" });
    const after = await readFile(instructions, "utf8");
    expect(after).toContain("Renamed");
    expect(after).not.toBe(before);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect
        .poll(() => service.getRun(accepted.value.run.id).status)
        .toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject(
      {
        statusCode: 409,
      },
    );

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });
});

describe("Documents", () => {
  it("stamps the owner it was given, never one smuggled inside the input", async () => {
    const service = await makeService();
    // The request boundary already rejects a body naming an owner; this pins
    // the second layer, so a later `...input` spread in createDocument cannot
    // quietly start honouring one if the boundary is ever loosened.
    const smuggled = {
      title: "Claimed",
      content: "Owner must come from the second argument.",
      visibility: "private",
      ownerId: "user-a",
    } as unknown as Parameters<AgentService["createDocument"]>[0];

    const doc = await service.createDocument(smuggled, "user-b");

    expect(doc.ownerId).toBe("user-b");
    expect(service.findMockDoc(doc.id)?.ownerId).toBe("user-b");
  });
});

describe("Owner token spend", () => {
  it("counts nothing for a human with no completed Runs", async () => {
    const service = await makeService();
    expect(service.sumOwnerTokens(DEFAULT_OWNER_ID)).toBe(0);
    // A human the store does not know is zero, not an error: a missing record
    // must never be the reason a ceiling is skipped.
    expect(service.sumOwnerTokens("user-ghost")).toBe(0);
  });

  it("sums every token a completed Run reported", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Spender" });
    const { run } = await service.sendMessage(agent.id, "do something");
    await settle(service, run.id);

    // FakeRunner reports 12 input and 5 output tokens for the turn.
    expect(service.sumOwnerTokens(DEFAULT_OWNER_ID)).toBe(17);
  });

  it("accumulates across an owner's Runs and Agents, and only theirs", async () => {
    const service = await makeService();
    const mine = await service.createAgent({ name: "Mine" }, DEFAULT_OWNER_ID);
    const also = await service.createAgent({ name: "Also" }, DEFAULT_OWNER_ID);
    const theirs = await service.createAgent({ name: "Theirs" }, "user-b");

    const runs = [
      (await service.sendMessage(mine.id, "one")).run,
      (await service.sendMessage(also.id, "two")).run,
      (await service.sendMessage(theirs.id, "three")).run,
    ];
    await settle(service, ...runs.map((run) => run.id));

    // Two Runs of this owner's, across two of their Agents.
    expect(service.sumOwnerTokens(DEFAULT_OWNER_ID)).toBe(34);
    // The third belongs to somebody else and must not be charged here.
    expect(service.sumOwnerTokens("user-b")).toBe(17);
  });

  it("counts a thread's total once, not once per turn", async () => {
    // The bug this guards: `RunUsage` is cumulative for the Codex thread, so
    // three turns of 100 report 100, 200, 300 — and adding those gives 600 for
    // 300 tokens of actual spend. Over-counting grows with the length of the
    // conversation, which is exactly when a ceiling matters most.
    const service = await makeService(cumulativeRunner(100));
    const agent = await service.createAgent({ name: "Chatty" });
    for (const prompt of ["one", "two", "three"]) {
      const { run } = await service.sendMessage(agent.id, prompt);
      await settle(service, run.id);
    }

    expect(service.sumOwnerTokens(DEFAULT_OWNER_ID)).toBe(300);
  });

  it("counts each Agent's thread separately", async () => {
    const service = await makeService(cumulativeRunner(100));
    const first = await service.createAgent({ name: "First" });
    const second = await service.createAgent({ name: "Second" });
    for (const agent of [first, second]) {
      for (const prompt of ["one", "two"]) {
        const { run } = await service.sendMessage(agent.id, prompt);
        await settle(service, run.id);
      }
    }

    // Two threads at 200 each. Threads are per Agent, so one Agent's total is
    // never the other's baseline.
    expect(service.sumOwnerTokens(DEFAULT_OWNER_ID)).toBe(400);
  });

  it("ignores cached input tokens, which are part of the input already", async () => {
    // The upstream reports `total = input + output`, with cached nested inside
    // the input details. Adding it as a third bucket counts most input twice.
    const service = await makeService({
      run: async () => ({
        output: "",
        threadId: "thread-1",
        usage: {
          inputTokens: 1_000,
          cachedInputTokens: 900,
          outputTokens: 50,
        },
      }),
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Cached" });
    const { run } = await service.sendMessage(agent.id, "one");
    await settle(service, run.id);

    expect(service.sumOwnerTokens(DEFAULT_OWNER_ID)).toBe(1_050);
  });

  it("counts a Run still in flight as nothing, because it has reported nothing", async () => {
    // The gap the gateway's own meter exists to cover: usage is parsed when a
    // Run finishes, so a Run spending right now is invisible to this sum.
    const { runner, finish } = pendingRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "keep going");

    expect(service.sumOwnerTokens(DEFAULT_OWNER_ID)).toBe(0);

    finish({ output: "done", threadId: null, usage: { inputTokens: 90 } });
    await settle(service, run.id);
    expect(service.sumOwnerTokens(DEFAULT_OWNER_ID)).toBe(90);
  });
});

describe("Resetting spend", () => {
  it("forgets what was spent before the reset, and keeps the Runs", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Spender" });
    const { run } = await service.sendMessage(agent.id, "one");
    await settle(service, run.id);
    expect(service.sumOwnerTokens(DEFAULT_OWNER_ID)).toBe(17);

    await service.updateUser(DEFAULT_OWNER_ID, { resetSpend: true });

    // The allowance starts over…
    expect(service.sumOwnerTokens(DEFAULT_OWNER_ID)).toBe(0);
    // …but nothing was destroyed to make that true. A watermark forgets what
    // counts, not what happened: the Run and its usage are still on record.
    expect(service.getRun(run.id).usage).toEqual({
      inputTokens: 12,
      outputTokens: 5,
    });
    expect(service.findUser(DEFAULT_OWNER_ID)?.budgetResetAt).not.toBeNull();
  });

  it("counts only what a thread spent after the reset", async () => {
    const service = await makeService(cumulativeRunner(100));
    const agent = await service.createAgent({ name: "Spender" });
    for (const prompt of ["one", "two", "three"]) {
      const { run } = await service.sendMessage(agent.id, prompt);
      await settle(service, run.id);
    }
    expect(service.sumOwnerTokens(DEFAULT_OWNER_ID)).toBe(300);

    await service.updateUser(DEFAULT_OWNER_ID, { resetSpend: true });

    for (const prompt of ["four", "five"]) {
      const { run } = await service.sendMessage(agent.id, prompt);
      await settle(service, run.id);
    }

    // The thread now reports 500 in total, but 300 of it was spent before the
    // reset. Subtracting the figure standing at the watermark is what makes a
    // reset survive the next turn — the thread total never goes back down.
    expect(service.sumOwnerTokens(DEFAULT_OWNER_ID)).toBe(200);
  });

  it("resets one human's spend without touching another's", async () => {
    const service = await makeService();
    const mine = await service.createAgent({ name: "Mine" }, DEFAULT_OWNER_ID);
    const theirs = await service.createAgent({ name: "Theirs" }, "user-b");
    const runs = [
      (await service.sendMessage(mine.id, "one")).run,
      (await service.sendMessage(theirs.id, "two")).run,
    ];
    await settle(service, ...runs.map((run) => run.id));

    await service.updateUser(DEFAULT_OWNER_ID, { resetSpend: true });

    expect(service.sumOwnerTokens(DEFAULT_OWNER_ID)).toBe(0);
    expect(service.sumOwnerTokens("user-b")).toBe(17);
  });

  it("leaves the ceiling alone — a reset forgives spend, not limits", async () => {
    const service = await makeService();
    const before = service.findUser("user-b")?.tokenBudget;
    await service.updateUser("user-b", { resetSpend: true });
    expect(service.findUser("user-b")?.tokenBudget).toBe(before);
    expect(service.findUser("user-b")?.role).toBe("basic");
  });
});
