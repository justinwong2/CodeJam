import { describe, expect, it } from "vitest";
import { AuditLog } from "./audit.js";
import { loadConfig } from "./config.js";
import type { AuditRecord } from "./types.js";

// Values that look like the real thing and are not: the point of the suite is
// that nothing shaped like a credential survives the write path.
const ARK_KEY = "audit-test-upstream-key";
const JWT_SECRET = "audit-test-signing-secret";
const TOOL_CREDENTIAL = "audit-test-tool-credential";

const identity = { humanId: "user-a", agentId: "agent-1", runId: "run-1" };

function auditLog(): { log: AuditLog; written: AuditRecord[] } {
  const written: AuditRecord[] = [];
  const config = loadConfig({
    NODE_ENV: "test",
    GATEWAY_JWT_SECRET: JWT_SECRET,
    GATEWAY_TOOL_CREDENTIAL: TOOL_CREDENTIAL,
    ARK_API_KEY: ARK_KEY,
    ARK_MODEL: "ep-test",
  });
  const log = new AuditLog(config, {
    appendAuditRecord: async (record) => {
      written.push(record);
    },
  });
  return { log, written };
}

describe("Audit records", () => {
  it("stamps an identity, an id, and a timestamp onto one decision", async () => {
    const { log, written } = auditLog();

    const record = await log.record({
      identity,
      tool: "docs",
      resource: "docs/doc-a1",
      decision: "allow",
      reason: 'Role "admin" grants the docs tool',
    });

    expect(written).toEqual([record]);
    expect(record.id.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(record.ts))).toBe(false);
    expect(record).toMatchObject({
      humanId: "user-a",
      agentId: "agent-1",
      runId: "run-1",
      tool: "docs",
      resource: "docs/doc-a1",
      decision: "allow",
      reason: 'Role "admin" grants the docs tool',
    });
  });

  it("masks every server-side secret planted in a reason or a resource", async () => {
    const { log, written } = auditLog();

    await log.record({
      identity,
      tool: "search",
      // A caller-controlled string reaching either field is exactly the leak
      // this guards: the write path redacts, so no later reader has to.
      resource: `search/${TOOL_CREDENTIAL}`,
      decision: "deny",
      reason: `Upstream refused ${ARK_KEY} signed with ${JWT_SECRET}`,
    });

    const persisted = JSON.stringify(written);
    expect(persisted).not.toContain(ARK_KEY);
    expect(persisted).not.toContain(JWT_SECRET);
    expect(persisted).not.toContain(TOOL_CREDENTIAL);
    expect(written[0]?.reason).toContain("[redacted]");
    expect(written[0]?.resource).toContain("[redacted]");
  });

  it("masks a bearer header and a token-shaped value it has never seen", async () => {
    const { log, written } = auditLog();
    // A run credential is a secret the config does not know, so pattern
    // matching — not a list of known values — is what keeps one out.
    const runJwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJqdGkiOiJzZXNzaW9uLTEifQ.c2lnbmF0dXJlLWhlcmU";

    await log.record({
      identity,
      tool: "model",
      resource: null,
      decision: "deny",
      reason: `Rejected Authorization: Bearer ${runJwt}`,
    });

    const persisted = JSON.stringify(written);
    expect(persisted).not.toContain(runJwt);
    expect(persisted).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(written[0]?.reason).toContain("[redacted]");
  });

  it("leaves an ordinary denial reason readable", async () => {
    const { log, written } = auditLog();

    await log.record({
      identity,
      tool: "payments",
      resource: "payments",
      decision: "deny",
      reason: 'Role "basic" may not use the payments tool',
    });

    expect(written[0]?.reason).toBe(
      'Role "basic" may not use the payments tool',
    );
    expect(written[0]?.resource).toBe("payments");
  });

  it("bounds an oversized reason so a body cannot be smuggled into one", async () => {
    const { log, written } = auditLog();

    await log.record({
      identity,
      tool: "docs",
      resource: `docs/${"d".repeat(4_000)}`,
      decision: "deny",
      reason: "x".repeat(20_000),
    });

    expect(written[0]?.reason.length).toBeLessThan(1_000);
    expect((written[0]?.resource ?? "").length).toBeLessThan(1_000);
  });

  it("keeps a null resource null rather than inventing one", async () => {
    const { log, written } = auditLog();

    await log.record({
      identity,
      tool: "model",
      resource: null,
      decision: "allow",
      reason: "Run session is live",
    });

    expect(written[0]?.resource).toBeNull();
  });
});
