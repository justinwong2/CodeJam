/**
 * The outcome of one budget question, shaped like an authorization decision so
 * the gateway can treat the two the same way: a `reason` is always populated,
 * because a denial's reason is what the operator reads in the evidence trail.
 */
export interface BudgetDecision {
  allow: boolean;
  reason: string;
}

/** What a human has spent, and what is about to be spent on their behalf. */
export interface BudgetSpend {
  /** Tokens reported by completed Runs. Exact. */
  settled: number;
  /** Tokens estimated for Runs still in flight, including this call's. */
  inFlight: number;
}

/**
 * Bytes of request body per token. A rough constant for prose, lower for code
 * and higher for CJK, and deliberately not tuned: it exists to make an
 * in-flight Run's spend *comparable* to a settled one, not to predict a bill.
 *
 * It is the only estimate in the ceiling. Everything a completed Run reports is
 * the real count parsed from Codex, and the two are labelled differently
 * wherever they are shown.
 */
const BYTES_PER_TOKEN = 4;

/** What a request of this size will plausibly cost, in tokens. */
export function estimateTokens(byteLength: number): number {
  if (!Number.isFinite(byteLength) || byteLength <= 0) return 0;
  return Math.ceil(byteLength / BYTES_PER_TOKEN);
}

/** Renders a token count the way both the audit reason and the console do. */
const tokens = (value: number): string => value.toLocaleString("en-US");

/**
 * Whether a human may spend what this call is about to cost.
 *
 * Pure and synchronous, like `can()` — the limit arrives as a parameter, so
 * where it was configured is invisible here and exhaustively testable without a
 * server, a store, or a clock.
 *
 * The check is made **before** the spend, not after: asking "would this call
 * take us over?" rather than "have we already gone over?" is what keeps the
 * ceiling from being discovered only once it has been breached.
 *
 * `0` is unlimited. That is the safe direction for this particular default: a
 * budget nobody configured must not silently strand every Agent on the
 * platform, and the ceiling is a guard against runaway spend rather than a
 * permission — `can()` has already decided whether the call may happen at all.
 */
export function withinBudget(
  spend: BudgetSpend,
  budget: number,
): BudgetDecision {
  if (!Number.isFinite(budget) || budget <= 0) {
    return { allow: true, reason: "No token budget is set for this owner" };
  }
  const used = Math.max(0, spend.settled) + Math.max(0, spend.inFlight);
  if (used > budget) {
    return {
      allow: false,
      reason: `Owner token budget exhausted: ${tokens(used)} of ${tokens(budget)} tokens`,
    };
  }
  return {
    allow: true,
    reason: `Owner has used ${tokens(used)} of ${tokens(budget)} tokens`,
  };
}
