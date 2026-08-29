import { describe, expect, it } from "vitest";
import { signRunJwt, verifyRunJwt, type RunJwtClaims } from "./run-jwt.js";

// Low-entropy and obviously fake: the assertions below prove the signing key
// never reaches the token or a rejection reason, so it must stay greppable.
const SECRET = "gateway-test-signing-secret";
const OTHER_SECRET = "gateway-test-other-secret";

const claims = (overrides: Partial<RunJwtClaims> = {}): RunJwtClaims => ({
  jti: "session-1",
  agentId: "agent-1",
  ownerId: "user-a",
  runId: "run-1",
  exp: Math.floor(Date.now() / 1000) + 600,
  ...overrides,
});

function tamper(token: string, part: 0 | 1 | 2, value: string): string {
  const parts = token.split(".");
  parts[part] = value;
  return parts.join(".");
}

function encode(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

describe("Run JWT", () => {
  it("round-trips the run identity it was signed with", () => {
    const issued = claims();
    const verified = verifyRunJwt(SECRET, signRunJwt(SECRET, issued));
    expect(verified).toEqual({ valid: true, claims: issued });
  });

  it("keeps the signing secret out of the token it produces", () => {
    const token = signRunJwt(SECRET, claims());
    expect(token).not.toContain(SECRET);
    expect(Buffer.from(token, "base64url").toString("utf8")).not.toContain(
      SECRET,
    );
  });

  it("rejects a tampered signature", () => {
    const token = signRunJwt(SECRET, claims());
    const forged = tamper(token, 2, "not-the-real-signature");
    expect(verifyRunJwt(SECRET, forged).valid).toBe(false);

    // A signature of the right shape but the wrong value is no better.
    const swapped = tamper(
      token,
      2,
      signRunJwt(OTHER_SECRET, claims()).split(".")[2] ?? "",
    );
    expect(verifyRunJwt(SECRET, swapped).valid).toBe(false);
  });

  it("rejects claims edited after signing", () => {
    const token = signRunJwt(SECRET, claims({ ownerId: "user-b" }));
    const escalated = tamper(token, 1, encode(claims({ ownerId: "user-a" })));
    expect(verifyRunJwt(SECRET, escalated).valid).toBe(false);
  });

  it("rejects a token signed with a different secret", () => {
    const token = signRunJwt(OTHER_SECRET, claims());
    expect(verifyRunJwt(SECRET, token).valid).toBe(false);
  });

  it("rejects an expired token", () => {
    const token = signRunJwt(SECRET, claims({ exp: 1_000 }));
    const verified = verifyRunJwt(SECRET, token);
    expect(verified.valid).toBe(false);
    expect(verified.valid === false && verified.reason).toMatch(/expired/i);
  });

  it("still accepts a token one second before it expires", () => {
    const nowMs = 1_700_000_000_000;
    const token = signRunJwt(SECRET, claims({ exp: nowMs / 1000 + 1 }));
    expect(verifyRunJwt(SECRET, token, nowMs).valid).toBe(true);
    expect(verifyRunJwt(SECRET, token, nowMs + 2_000).valid).toBe(false);
  });

  it("refuses an unsigned token that claims its own algorithm", () => {
    // The classic downgrade: alg "none" with an empty signature.
    const forged = [
      encode({ alg: "none", typ: "JWT" }),
      encode(claims()),
      "",
    ].join(".");
    expect(verifyRunJwt(SECRET, forged).valid).toBe(false);

    // ...and an algorithm we do not implement, even correctly HMAC-signed.
    const wrongAlgorithm = tamper(
      signRunJwt(SECRET, claims()),
      0,
      encode({ alg: "HS512", typ: "JWT" }),
    );
    expect(verifyRunJwt(SECRET, wrongAlgorithm).valid).toBe(false);
  });

  it("rejects malformed tokens without throwing", () => {
    for (const candidate of [
      "",
      "  ",
      "one-part",
      "two.parts",
      "four.parts.are.wrong",
      "!!!.!!!.!!!",
      [encode({ alg: "HS256", typ: "JWT" }), encode("a string"), "x"].join("."),
      [encode({ alg: "HS256", typ: "JWT" }), encode({ jti: 1 }), "x"].join("."),
    ]) {
      const verified = verifyRunJwt(SECRET, candidate);
      expect(verified.valid).toBe(false);
      expect(
        verified.valid === false && verified.reason.length,
      ).toBeGreaterThan(0);
    }
  });

  it("rejects a correctly signed token whose claims are the wrong shape", () => {
    // A valid signature is not enough: the gateway resolves a session from
    // these claims, so a token missing `jti` must not reach that lookup.
    const signedButIncomplete = signRunJwt(SECRET, {
      agentId: "agent-1",
      ownerId: "user-a",
      runId: "run-1",
      exp: Math.floor(Date.now() / 1000) + 600,
    } as unknown as RunJwtClaims);
    expect(verifyRunJwt(SECRET, signedButIncomplete).valid).toBe(false);
  });

  it("never puts the signing secret in a rejection reason", () => {
    for (const candidate of [
      "",
      "garbage",
      signRunJwt(OTHER_SECRET, claims()),
      signRunJwt(SECRET, claims({ exp: 1_000 })),
    ]) {
      const verified = verifyRunJwt(SECRET, candidate);
      expect(verified.valid).toBe(false);
      expect(verified.valid === false && verified.reason).not.toContain(SECRET);
    }
  });
});
