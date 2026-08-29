import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({
        NODE_ENV: "test",
        GATEWAY_JWT_SECRET: "gateway-test-signing-secret",
        APP_AUTH_TOKEN: "a-strong-test-token",
      }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);

    // Revocation is an operator action with real consequences — an anonymous
    // caller must not be able to cut every Agent off. This pins the route to
    // the guarded side of the hook, wherever someone later moves it.
    const revoke = await app.inject({
      method: "POST",
      url: "/api/agents/00000000-0000-4000-8000-000000000000/revoke",
    });
    expect(revoke.statusCode).toBe(401);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(
      loadConfig({
        NODE_ENV: "test",
        GATEWAY_JWT_SECRET: "gateway-test-signing-secret",
      }),
      service,
    );
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });
});
