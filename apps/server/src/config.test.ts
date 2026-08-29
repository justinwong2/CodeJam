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

describe("Tool service credential configuration", () => {
  const base = { NODE_ENV: "test", GATEWAY_JWT_SECRET: SECRET };

  it("mints a strong ephemeral credential when none is configured", () => {
    // Both ends of this check live in this process, so there is nothing to
    // agree with an operator about. Starting without one must never mean
    // starting with a tool service that accepts anybody.
    const config = loadConfig({ ...base });
    expect(config.gatewayToolCredential.length).toBeGreaterThanOrEqual(32);
    expect(loadConfig({ ...base }).gatewayToolCredential).not.toBe(
      config.gatewayToolCredential,
    );
  });

  it("refuses a configured credential too weak to guard anything", () => {
    expect(() =>
      loadConfig({ ...base, GATEWAY_TOOL_CREDENTIAL: "short" }),
    ).toThrow(/GATEWAY_TOOL_CREDENTIAL/);
  });

  it("refuses the placeholder shipped in .env.example", () => {
    expect(() =>
      loadConfig({
        ...base,
        GATEWAY_TOOL_CREDENTIAL: "replace-with-a-long-random-tool-credential",
      }),
    ).toThrow(/GATEWAY_TOOL_CREDENTIAL/);
  });

  it("never echoes the rejected credential in the failure it raises", () => {
    const rejected = "short";
    try {
      loadConfig({ ...base, GATEWAY_TOOL_CREDENTIAL: rejected });
      expect.unreachable("loadConfig should have rejected the weak credential");
    } catch (error) {
      expect(String(error)).toContain("GATEWAY_TOOL_CREDENTIAL");
      expect(String(error)).not.toContain(`"${rejected}"`);
    }
  });

  it("keeps a configured credential in the server process only", () => {
    const credential = "tool-service-test-credential";
    const config = loadConfig({
      ...base,
      GATEWAY_TOOL_CREDENTIAL: `  ${credential}  `,
    });
    expect(config.gatewayToolCredential).toBe(credential);
  });
});
