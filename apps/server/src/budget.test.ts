import { describe, expect, it } from "vitest";
import { estimateTokens, withinBudget } from "./budget.js";

describe("estimateTokens", () => {
  it("scales with the size of what is about to be sent", () => {
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(4_000)).toBe(1_000);
    // Rounded up: a partial token still costs a token, and rounding down would
    // let a stream of small calls spend without ever being counted.
    expect(estimateTokens(5)).toBe(2);
  });

  it("treats an empty or nonsensical size as costing nothing", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(-1)).toBe(0);
    expect(estimateTokens(Number.NaN)).toBe(0);
  });
});

describe("withinBudget", () => {
  it("allows a call that fits", () => {
    const decision = withinBudget({ settled: 400, inFlight: 100 }, 1_000);
    expect(decision.allow).toBe(true);
    expect(decision.reason).toContain("500");
    expect(decision.reason).toContain("1,000");
  });

  it("allows a call that lands exactly on the ceiling", () => {
    // The ceiling is what may be spent, not what may not be reached.
    expect(withinBudget({ settled: 900, inFlight: 100 }, 1_000).allow).toBe(
      true,
    );
  });

  it("denies the call that would cross the ceiling, not the one after it", () => {
    // The point of checking before the spend: the budget is never overdrawn,
    // so a denial arrives instead of a breach that is noticed afterwards.
    const decision = withinBudget({ settled: 900, inFlight: 101 }, 1_000);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain("exhausted");
  });

  it("counts settled and in-flight spend against the same ceiling", () => {
    // Neither alone would exceed it; a ceiling that ignored either half would
    // let a Run in flight spend what completed Runs had already used up.
    expect(withinBudget({ settled: 600, inFlight: 0 }, 1_000).allow).toBe(true);
    expect(withinBudget({ settled: 0, inFlight: 600 }, 1_000).allow).toBe(true);
    expect(withinBudget({ settled: 600, inFlight: 600 }, 1_000).allow).toBe(
      false,
    );
  });

  it("treats a budget of zero as unlimited", () => {
    // A ceiling nobody configured must not strand every Agent: `can()` has
    // already decided whether the call may happen, and this only decides
    // whether it can be afforded.
    const decision = withinBudget({ settled: 10_000_000, inFlight: 1 }, 0);
    expect(decision.allow).toBe(true);
    expect(decision.reason).toContain("No token budget");
  });

  it("treats a nonsensical budget as unlimited rather than as zero", () => {
    // Zero-as-a-ceiling would deny everything; the same value already means
    // unlimited, so a value the loader could not make sense of follows it.
    expect(withinBudget({ settled: 1, inFlight: 0 }, -5).allow).toBe(true);
    expect(withinBudget({ settled: 1, inFlight: 0 }, Number.NaN).allow).toBe(
      true,
    );
  });

  it("names the numbers in every reason, allowed or denied", () => {
    // The reason becomes an audit record's reason, and an operator reading the
    // trail needs the figures the decision was made on, not a verdict.
    for (const spend of [
      { settled: 1, inFlight: 1 },
      { settled: 5_000, inFlight: 5_000 },
    ]) {
      expect(withinBudget(spend, 1_000).reason).toMatch(/\d/);
    }
  });
});
