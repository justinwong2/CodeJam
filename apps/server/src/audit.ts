import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import type { AuditRecord, AuditSink, ToolName } from "./types.js";

// The evidence half of the gateway. Every decision the gateway reaches — model
// or tool, allow or deny — is filed here, once, before the caller is answered.
//
// Redaction lives in this module rather than at the call sites, because it is
// only a guarantee if there is no way to persist a record without passing
// through it. A reason is written for a human to read; nothing in it is worth
// leaking a credential for.

/** The mask a redacted value is replaced with. Fixed, so it is greppable. */
const REDACTED = "[redacted]";

/**
 * Below this length a "secret" is too short to redact safely — masking a
 * two-character value would blank out ordinary words along with it. Nothing the
 * server accepts as a credential is anywhere near this short.
 */
const MINIMUM_SECRET_LENGTH = 8;

/** A record is evidence, not storage: neither field may grow into a payload. */
const MAXIMUM_FIELD_LENGTH = 300;

/** `Bearer <token>`, however the header was spelled. */
const BEARER_PATTERN = /bearer\s+[\w.~+/=-]+/gi;

/**
 * Anything shaped like a signed token. The run credential is a secret this
 * process holds no copy of, so the only way to keep one out of a record is to
 * recognize the shape rather than the value.
 */
const TOKEN_PATTERN = /[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g;

/** Who a decision was about. Every field is a fact the store already holds. */
export interface AuditIdentity {
  humanId: string;
  agentId: string;
  runId: string;
}

/** One decision, as the gateway reached it. */
export interface GatewayDecision {
  identity: AuditIdentity;
  tool: ToolName;
  /** What the call was about, or null when it names nothing ownable. */
  resource: string | null;
  decision: "allow" | "deny";
  reason: string;
}

/**
 * Masks the values a record must never carry, then bounds what is left. The
 * order matters: named secrets first, so a credential that also matches a
 * pattern is gone either way, and the length cap last, so truncation can never
 * cut a secret in half and leave the front of it standing.
 */
function redact(value: string, secrets: readonly string[]): string {
  let masked = value;
  for (const secret of secrets) {
    if (secret.length < MINIMUM_SECRET_LENGTH) continue;
    masked = masked.split(secret).join(REDACTED);
  }
  masked = masked
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(TOKEN_PATTERN, REDACTED);
  return masked.length > MAXIMUM_FIELD_LENGTH
    ? masked.slice(0, MAXIMUM_FIELD_LENGTH) + "…"
    : masked;
}

/**
 * The gateway's single writer. One `record()` call per gateway decision — the
 * contract the routes are written against, and the reason a request can never
 * produce two records or none.
 */
export class AuditLog {
  /** The secrets this process holds, kept for comparison and never written. */
  private readonly secrets: string[];

  constructor(
    config: AppConfig,
    private readonly sink: AuditSink,
  ) {
    this.secrets = [
      config.arkApiKey,
      config.gatewayJwtSecret,
      config.gatewayToolCredential,
    ].map((secret) => secret.trim());
  }

  /**
   * Files one decision and answers with the record as persisted. Awaited by the
   * caller before it replies, so the store is never behind what the agent has
   * already been told.
   */
  async record(decision: GatewayDecision): Promise<AuditRecord> {
    const record: AuditRecord = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      humanId: decision.identity.humanId,
      agentId: decision.identity.agentId,
      runId: decision.identity.runId,
      tool: decision.tool,
      resource:
        decision.resource === null
          ? null
          : redact(decision.resource, this.secrets),
      decision: decision.decision,
      reason: redact(decision.reason, this.secrets),
    };
    await this.sink.appendAuditRecord(record);
    return record;
  }
}
