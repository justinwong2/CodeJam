import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createRunner, runnerGatewayBaseUrl } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

// Codex's config.toml is written by the active runner, not here: the gateway
// origin Codex must call differs between a host process and a container.
const config = loadConfig();

const store = new JsonStore(
  path.join(config.dataDirectory, "launchpad.json"),
  config.auditRetentionLimit,
);
const workspaces = new WorkspaceManager(
  config.workspaceRoot,
  runnerGatewayBaseUrl(config),
);
const runner = createRunner(config);
const service = new AgentService(config, store, workspaces, runner);
await service.initialize();

const app = await createApp(config, service);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
