import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const SECRET = "gateway-test-signing-secret";

describe("Gateway signing secret configuration", () => {
  it("refuses to start when no signing secret is configured", () => {
    // Fail loudly: a missing secret must never degrade into a gateway that
    // cannot verify — and therefore does not enforce — run credentials.
    expect(() => loadConfig({ NODE_ENV: "test" })).toThrow(
      /GATEWAY_JWT_SECRET/,
    );
  });

  it("refuses the placeholder shipped in .env.example", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        GATEWAY_JWT_SECRET: "replace-with-a-long-random-gateway-jwt-secret",
      }),
    ).toThrow(/GATEWAY_JWT_SECRET/);
  });

  it("refuses a secret too short to be worth signing with", () => {
    expect(() =>
      loadConfig({ NODE_ENV: "test", GATEWAY_JWT_SECRET: "tiny-secret" }),
    ).toThrow(/GATEWAY_JWT_SECRET/);
  });

  it("never echoes the rejected secret in the failure it raises", () => {
    const rejected = "tiny-secret";
    try {
      loadConfig({ NODE_ENV: "test", GATEWAY_JWT_SECRET: rejected });
      expect.unreachable("loadConfig should have rejected the short secret");
    } catch (error) {
      expect(String(error)).toContain("GATEWAY_JWT_SECRET");
      expect(String(error)).not.toContain(rejected);
      expect(JSON.stringify(error)).not.toContain(rejected);
    }
  });

  it("exposes an accepted secret to the server process only", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      GATEWAY_JWT_SECRET: `  ${SECRET}  `,
    });
    expect(config.gatewayJwtSecret).toBe(SECRET);
  });
});
