import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(600_000),
  // How long a run's gateway credential stays usable. Its own variable rather
  // than a margin bolted onto the turn timeout: the lifetime of a credential is
  // a security decision, and it should be possible to shorten it without
  // shortening what a turn is allowed to take. The default is the value the
  // hardcoded coupling produced (600_000 + 60_000), so naming it changed
  // nothing about how long a session lives.
  SESSION_TTL_MS: z.coerce.number().int().min(1_000).default(660_000),
  // How many gateway decisions the store keeps. Evidence is the busiest write
  // in the system and the only unbounded one, so it gets a cap rather than a
  // disk that fills. The floor is ten: a bound so tight that a single run's
  // decisions cannot fit is a retention policy that erases what it is for.
  AUDIT_RETENTION_LIMIT: z.coerce.number().int().min(10).default(1000),
  CODEX_MAX_OUTPUT_BYTES: z.coerce
    .number()
    .int()
    .min(65_536)
    .default(2_097_152),
  RUNTIME_PROVIDER: z
    .enum(["local-process", "container"])
    .default("local-process"),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  CONTAINER_RUNTIME_IMAGE: z
    .string()
    .min(1)
    .default("volc-agent-runtime:local"),
  CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(2),
  CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("2g"),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  CONTAINER_USER: z.string().optional(),
  RUNTIME_INSTANCE_ID: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("default"),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  // Validated after parsing so a rejection never echoes the value.
  GATEWAY_JWT_SECRET: z.string().default(""),
  GATEWAY_TOOL_CREDENTIAL: z.string().default(""),
  ARK_API_KEY: z.string().optional(),
  ARK_MODEL: z.string().optional(),
  ARK_BASE_URL: z
    .string()
    .url()
    .default("https://ark.cn-beijing.volces.com/api/v3"),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

/** Short enough to type for a demo, long enough to be worth HMAC-signing with. */
const MINIMUM_GATEWAY_JWT_SECRET_LENGTH = 16;

/** The same bar for the tool credential: a guessable one guards nothing. */
const MINIMUM_GATEWAY_TOOL_CREDENTIAL_LENGTH = 16;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (env.NODE_ENV === "production" && !loopbackHosts.has(env.HOST)) {
    if (authToken.length < 24 || authToken.startsWith("replace-")) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 characters for a non-loopback production server",
      );
    }
  }
  // The gateway signs and verifies every per-run credential with this secret.
  // Booting without one would leave the gateway unable to verify anything, so
  // it is a startup error rather than a silent bypass. The message names the
  // variable and never repeats the rejected value.
  const gatewayJwtSecret = env.GATEWAY_JWT_SECRET.trim();
  if (
    gatewayJwtSecret.length < MINIMUM_GATEWAY_JWT_SECRET_LENGTH ||
    gatewayJwtSecret.startsWith("replace-")
  ) {
    throw new Error(
      "GATEWAY_JWT_SECRET must be set to at least " +
        MINIMUM_GATEWAY_JWT_SECRET_LENGTH +
        " random characters. The Agent Access Gateway signs every per-run " +
        "credential with it and refuses to start without one.",
    );
  }
  // The mock tool service accepts nothing that does not carry this, so the
  // gateway is the only way in. Unlike the signing secret it names nothing
  // outside this process — both ends of the check are in it — so an unset value
  // is minted per process rather than refused: a demo gets a strong credential
  // with no manual step, and no placeholder is ever left standing. A value the
  // operator *did* set is held to the same bar as the signing secret, and a
  // rejection names the variable without repeating the value.
  const configuredToolCredential = env.GATEWAY_TOOL_CREDENTIAL.trim();
  if (
    configuredToolCredential.length > 0 &&
    (configuredToolCredential.length < MINIMUM_GATEWAY_TOOL_CREDENTIAL_LENGTH ||
      configuredToolCredential.startsWith("replace-"))
  ) {
    throw new Error(
      "GATEWAY_TOOL_CREDENTIAL must be at least " +
        MINIMUM_GATEWAY_TOOL_CREDENTIAL_LENGTH +
        " random characters when it is set. Leave it unset to have the server " +
        "mint an ephemeral one for the process.",
    );
  }
  const gatewayToolCredential =
    configuredToolCredential || randomBytes(32).toString("base64url");
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory: path.resolve(env.APP_DATA_DIR),
    workspaceRoot: path.resolve(env.AGENT_WORKSPACE_ROOT),
    codexHome: path.resolve(env.CODEX_HOME),
    codexBin: env.CODEX_BIN,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    sessionTtlMs: env.SESSION_TTL_MS,
    auditRetentionLimit: env.AUDIT_RETENTION_LIMIT,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    runtimeProvider: env.RUNTIME_PROVIDER,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    authToken,
    gatewayJwtSecret,
    gatewayToolCredential,
    arkApiKey: env.ARK_API_KEY?.trim() ?? "",
    arkModel: env.ARK_MODEL?.trim() ?? "",
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
    nodeEnv: env.NODE_ENV,
  };
}

export function isArkConfigured(config: AppConfig): boolean {
  return (
    config.arkApiKey.length > 0 &&
    !config.arkApiKey.startsWith("replace-") &&
    config.arkModel.length > 0 &&
    !config.arkModel.includes("replace-")
  );
}

export interface CodexProviderTarget {
  /** Gateway origin + prefix as the Runtime sees it, e.g. from a container. */
  baseUrl: string;
  /** Environment variable Codex reads its bearer credential from. */
  envKey: string;
}

/**
 * Written by the active runner, not at startup: the gateway origin depends on
 * the runner's vantage point (host process vs. inside a container). Only one
 * runner is active per process, so the shared CODEX_HOME has a single writer.
 */
export async function writeCodexConfig(
  config: AppConfig,
  target: CodexProviderTarget,
): Promise<void> {
  await mkdir(config.codexHome, { recursive: true });
  const toml = [
    "# Generated by Volc Agent Launchpad. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.arkModel || "ep-not-configured"),
    'model_provider = "volcengine_ark"',
    "",
    "[model_providers.volcengine_ark]",
    'name = "Volcengine Ark"',
    "base_url = " + JSON.stringify(target.baseUrl),
    "env_key = " + JSON.stringify(target.envKey),
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
  await writeFile(path.join(config.codexHome, "config.toml"), toml, {
    encoding: "utf8",
    mode: 0o600,
  });
}
