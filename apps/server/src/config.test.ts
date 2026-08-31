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

describe("Run session lifetime configuration", () => {
  const base = { NODE_ENV: "test", GATEWAY_JWT_SECRET: SECRET };

  it("defaults to the lifetime the run session already had", () => {
    // 600_000 turn timeout plus the 60_000 margin that used to be hardcoded:
    // naming the value must not change it.
    expect(loadConfig({ ...base }).sessionTtlMs).toBe(660_000);
  });

  it("takes the configured lifetime, coerced from the environment string", () => {
    expect(loadConfig({ ...base, SESSION_TTL_MS: "90000" }).sessionTtlMs).toBe(
      90_000,
    );
  });

  it("refuses a lifetime too short to be a credential lifetime", () => {
    expect(() => loadConfig({ ...base, SESSION_TTL_MS: "10" })).toThrow(
      /SESSION_TTL_MS/,
    );
  });

  it("refuses a lifetime that is not a number at all", () => {
    // Fail loudly at boot: a silently-defaulted credential lifetime is a
    // security property nobody would notice had been ignored.
    expect(() =>
      loadConfig({ ...base, SESSION_TTL_MS: "ten minutes" }),
    ).toThrow(/SESSION_TTL_MS/);
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

describe("Audit retention configuration", () => {
  const base = { NODE_ENV: "test", GATEWAY_JWT_SECRET: SECRET };

  it("defaults to a limit a demo will never reach", () => {
    expect(loadConfig({ ...base }).auditRetentionLimit).toBe(1000);
  });

  it("takes the configured limit, coerced from the environment string", () => {
    expect(
      loadConfig({ ...base, AUDIT_RETENTION_LIMIT: "50" }).auditRetentionLimit,
    ).toBe(50);
  });

  it("refuses a limit too small to hold a run's decisions", () => {
    expect(() => loadConfig({ ...base, AUDIT_RETENTION_LIMIT: "3" })).toThrow(
      /AUDIT_RETENTION_LIMIT/,
    );
  });

  it("refuses a limit that is not a number at all", () => {
    // Fail loudly at boot: silently defaulting a retention limit is how a
    // deployment discovers months later that it kept nothing it meant to.
    expect(() =>
      loadConfig({ ...base, AUDIT_RETENTION_LIMIT: "a thousand" }),
    ).toThrow(/AUDIT_RETENTION_LIMIT/);
  });
});
