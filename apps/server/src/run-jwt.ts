import { createHmac, timingSafeEqual } from "node:crypto";

// A hand-rolled HS256 JWT. One signing algorithm, five claims, and no
// negotiation: a dependency would add drift-control cost far out of proportion
// to ~60 lines, and the narrow surface is easier to audit than a general
// library's option matrix.

/** The claim set the gateway trusts. Permissions are deliberately absent. */
export interface RunJwtClaims {
  /** Session id; the gateway matches it against the stored RunSession. */
  jti: string;
  agentId: string;
  ownerId: string;
  runId: string;
  /** Expiry, in seconds since the epoch. */
  exp: number;
}

export type RunJwtVerification =
  { valid: true; claims: RunJwtClaims } | { valid: false; reason: string };

const ALGORITHM = "HS256";

const encodeSegment = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const signature = (secret: string, signingInput: string): string =>
  createHmac("sha256", secret).update(signingInput).digest("base64url");

export function signRunJwt(secret: string, claims: RunJwtClaims): string {
  const signingInput =
    encodeSegment({ alg: ALGORITHM, typ: "JWT" }) + "." + encodeSegment(claims);
  return signingInput + "." + signature(secret, signingInput);
}

function decodeSegment(segment: string): unknown {
  const json = Buffer.from(segment, "base64url").toString("utf8");
  return JSON.parse(json);
}

function asClaims(value: unknown): RunJwtClaims | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const strings = ["jti", "agentId", "ownerId", "runId"] as const;
  if (strings.some((name) => typeof candidate[name] !== "string")) return null;
  if (typeof candidate.exp !== "number" || !Number.isFinite(candidate.exp)) {
    return null;
  }
  return {
    jti: candidate.jti as string,
    agentId: candidate.agentId as string,
    ownerId: candidate.ownerId as string,
    runId: candidate.runId as string,
    exp: candidate.exp,
  };
}

/**
 * Fail-closed verification: every rejection returns a reason safe to log and
 * to send back, never the secret or the token. `nowMs` is injectable so expiry
 * can be tested without waiting for it.
 */
export function verifyRunJwt(
  secret: string,
  token: string,
  nowMs: number = Date.now(),
): RunJwtVerification {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return { valid: false, reason: "Malformed run credential" };
  }
  const [encodedHeader, encodedClaims, providedSignature] = parts as [
    string,
    string,
    string,
  ];

  let header: unknown;
  let decodedClaims: unknown;
  try {
    header = decodeSegment(encodedHeader);
    decodedClaims = decodeSegment(encodedClaims);
  } catch {
    return { valid: false, reason: "Malformed run credential" };
  }

  // Checked before any signature work: an attacker must not choose the
  // algorithm, least of all "none".
  const algorithm =
    typeof header === "object" && header !== null
      ? (header as Record<string, unknown>).alg
      : undefined;
  if (algorithm !== ALGORITHM) {
    return { valid: false, reason: "Unsupported run credential algorithm" };
  }

  const expected = Buffer.from(
    signature(secret, encodedHeader + "." + encodedClaims),
    "utf8",
  );
  const provided = Buffer.from(providedSignature, "utf8");
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return { valid: false, reason: "Run credential signature is not valid" };
  }

  const claims = asClaims(decodedClaims);
  if (!claims) {
    return { valid: false, reason: "Malformed run credential" };
  }
  if (claims.exp * 1_000 <= nowMs) {
    return { valid: false, reason: "Run credential expired" };
  }
  return { valid: true, claims };
}
