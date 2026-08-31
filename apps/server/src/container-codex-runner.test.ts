import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import {
  buildContainerRunArgs,
  buildEngineEnvironment,
  containerName,
  ContainerCodexRunner,
} from "./container-codex-runner.js";
import { RUN_JWT_ENV_KEY } from "./gateway.js";

// loadConfig runs CODEX_HOME through path.resolve, so the mounted source path
// is platform-dependent: "/tmp/codex-home" on POSIX, "C:\tmp\codex-home" on
// Windows. Resolve it here too so the expectation matches on every host.
const CODEX_HOME = "/tmp/codex-home";
const RESOLVED_CODEX_HOME = path.resolve(CODEX_HOME);

describe("Container Codex runner", () => {
  it("builds an isolated Docker/Podman-compatible invocation", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      GATEWAY_JWT_SECRET: "gateway-test-signing-secret",
      ARK_API_KEY: "secret-that-must-not-appear-in-argv",
      ARK_MODEL: "ep-test",
      CODEX_HOME,
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "podman",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      CONTAINER_USER: "501:20",
      RUNTIME_INSTANCE_ID: "test-instance",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent/unsafe",
        workspacePath: "/tmp/agent-workspace",
        prompt: "write a small program",
        threadId: null,
        runJwt: "run-jwt-for-this-test",
      },
      config,
    );

    expect(containerName("agent/unsafe", "test-instance")).toBe(
      "launchpad-test-instance-agent-unsafe",
    );
    expect(args).toContain("runtime:test");
    expect(args).toContain("type=bind,src=/tmp/agent-workspace,dst=/workspace");
    expect(args).toContain(
      `type=bind,src=${RESOLVED_CODEX_HOME},dst=/codex-home`,
    );
    expect(args).toContain("501:20");
    expect(args).toContain("workspace-write");
    expect(args).toContain("/workspace");
    expect(args).toContain("io.codejam.instance-id=test-instance");
    expect(args).toContain("keep-id");
    expect(args).not.toContain("secret-that-must-not-appear-in-argv");
  });

  it("resumes a thread inside the mounted Runtime workspace", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      GATEWAY_JWT_SECRET: "gateway-test-signing-secret",
      CODEX_HOME,
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "continue",
        threadId: "thread-123",
        runJwt: "run-jwt-for-this-test",
      },
      config,
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "continue"]);
    expect(args).not.toContain("keep-id");
  });

  it("carries the run credential into the Runtime, never the Ark key", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      GATEWAY_JWT_SECRET: "gateway-test-signing-secret",
      ARK_API_KEY: "secret-that-must-not-appear-in-argv",
      ARK_MODEL: "ep-test",
      CODEX_HOME,
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "docker",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "hello",
        threadId: null,
        runJwt: "run-jwt-for-this-test",
      },
      config,
    );

    expect(args).not.toContain("ARK_API_KEY");
    expect(args).not.toContain("secret-that-must-not-appear-in-argv");
    expect(args).toContain(RUN_JWT_ENV_KEY);
    // Linux Docker only resolves the host alias when the shim is present.
    expect(args).toContain("--add-host");
    expect(args).toContain("host.docker.internal:host-gateway");

    const environment = buildEngineEnvironment("run-jwt-for-this-test");
    expect(environment.ARK_API_KEY).toBeUndefined();
    expect(Object.values(environment)).not.toContain(
      "secret-that-must-not-appear-in-argv",
    );
    // The engine holds the run's own credential, and only for a real run.
    expect(environment[RUN_JWT_ENV_KEY]).toBe("run-jwt-for-this-test");
    expect(buildEngineEnvironment()[RUN_JWT_ENV_KEY]).toBeUndefined();
  });

  it("forwards proxy and CA trust variables to the engine, and still no secret", () => {
    // The host runner has always forwarded these; the engine needs the same
    // ones to pull an image or reach the host behind a corporate proxy or
    // custom CA. The secrets stay out, which is the allowlist's whole point.
    vi.stubEnv("HTTPS_PROXY", "http://proxy.corp.example:8080");
    vi.stubEnv("HTTP_PROXY", "http://proxy.corp.example:8080");
    vi.stubEnv("NO_PROXY", "localhost,127.0.0.1");
    vi.stubEnv("SSL_CERT_FILE", "/etc/ssl/corp-ca.pem");
    vi.stubEnv("SSL_CERT_DIR", "/etc/ssl/certs");
    vi.stubEnv("NODE_EXTRA_CA_CERTS", "/etc/ssl/extra-ca.pem");
    vi.stubEnv("ARK_API_KEY", "secret-that-must-not-reach-the-engine");
    vi.stubEnv("GATEWAY_JWT_SECRET", "secret-that-must-not-reach-the-engine");
    vi.stubEnv(
      "GATEWAY_TOOL_CREDENTIAL",
      "secret-that-must-not-reach-the-engine",
    );
    try {
      const environment = buildEngineEnvironment();
      expect(environment.HTTPS_PROXY).toBe("http://proxy.corp.example:8080");
      expect(environment.HTTP_PROXY).toBe("http://proxy.corp.example:8080");
      expect(environment.NO_PROXY).toBe("localhost,127.0.0.1");
      expect(environment.SSL_CERT_FILE).toBe("/etc/ssl/corp-ca.pem");
      expect(environment.SSL_CERT_DIR).toBe("/etc/ssl/certs");
      expect(environment.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/extra-ca.pem");

      expect(environment.ARK_API_KEY).toBeUndefined();
      expect(environment.GATEWAY_JWT_SECRET).toBeUndefined();
      expect(environment.GATEWAY_TOOL_CREDENTIAL).toBeUndefined();
      expect(Object.values(environment)).not.toContain(
        "secret-that-must-not-reach-the-engine",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("leaves the host-gateway shim off Podman, which supplies its own alias", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      GATEWAY_JWT_SECRET: "gateway-test-signing-secret",
      CODEX_HOME,
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "podman",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "hello",
        threadId: null,
        runJwt: "run-jwt-for-this-test",
      },
      config,
    );
    expect(args).not.toContain("--add-host");
  });
});

describe("Container Codex runner config generation", () => {
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

  it("points Codex at the gateway through the engine's host alias", async () => {
    for (const [engine, alias] of [
      ["docker", "host.docker.internal"],
      ["podman", "host.containers.internal"],
    ] as const) {
      const codexHome = await temporaryCodexHome();
      const config = loadConfig({
        NODE_ENV: "test",
        GATEWAY_JWT_SECRET: "gateway-test-signing-secret",
        ARK_API_KEY: "secret-that-must-not-reach-the-runtime",
        ARK_MODEL: "ep-test",
        CODEX_HOME: codexHome,
        PORT: "4321",
        RUNTIME_PROVIDER: "container",
        CONTAINER_ENGINE: engine,
      });
      const runner = new ContainerCodexRunner(config);
      await runner.ensureCodexConfig();

      const toml = await readFile(path.join(codexHome, "config.toml"), "utf8");
      expect(toml).toContain(`base_url = "http://${alias}:4321/gateway/v1"`);
      expect(toml).toContain('env_key = "RUN_JWT"');
      expect(toml).toContain('model = "ep-test"');
      expect(toml).not.toContain("secret-that-must-not-reach-the-runtime");
      expect(toml).not.toContain("ARK_API_KEY");
      expect(toml).not.toContain("ark.cn-beijing.volces.com");
    }
  });
});
