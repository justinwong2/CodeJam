import type { AppConfig } from "./config.js";
import {
  ContainerCodexRunner,
  containerHostAlias,
} from "./container-codex-runner.js";
import { CodexRunner } from "./codex-runner.js";
import { gatewayBaseUrl } from "./gateway.js";
import type { AgentRunner } from "./types.js";

export function createRunner(config: AppConfig): AgentRunner {
  return config.runtimeProvider === "container"
    ? new ContainerCodexRunner(config)
    : new CodexRunner(config);
}

/**
 * The gateway origin from the active runner's vantage point — the same host
 * each runner writes into Codex's `config.toml` for its model calls. An
 * Agent's tool calls (`/tools/docs`, `/tools/search`, `/tools/payments`) live
 * under this same origin, so this is also what AGENTS.md tells an Agent to
 * curl.
 */
export function runnerGatewayBaseUrl(config: AppConfig): string {
  const host =
    config.runtimeProvider === "container"
      ? containerHostAlias(config.containerEngine)
      : "127.0.0.1";
  return gatewayBaseUrl(host, config.port);
}
