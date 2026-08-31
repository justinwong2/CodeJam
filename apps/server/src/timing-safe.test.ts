import { describe, expect, it } from "vitest";
import { credentialMatches } from "./timing-safe.js";

// Obviously fake values: nothing here is a real credential, and the helper is
// what keeps the real ones out of a variable-time comparison.
describe("credentialMatches", () => {
  it("matches two equal strings", () => {
    expect(
      credentialMatches("tool-credential-1234", "tool-credential-1234"),
    ).toBe(true);
  });

  it("rejects unequal strings of the same length", () => {
    expect(
      credentialMatches("tool-credential-1234", "tool-credential-4321"),
    ).toBe(false);
  });

  it("rejects a length mismatch without throwing", () => {
    // `timingSafeEqual` alone throws here; the helper exists so every caller
    // gets a false instead of an exception a route handler must remember.
    expect(credentialMatches("short", "a-much-longer-expected-value")).toBe(
      false,
    );
    expect(credentialMatches("a-much-longer-provided-value", "short")).toBe(
      false,
    );
  });

  it("treats empty input as a mismatch against a real secret", () => {
    expect(credentialMatches("", "expected-secret")).toBe(false);
    // Two empty strings are equal — the guard against accepting them belongs
    // to configuration validation, not to the comparison.
    expect(credentialMatches("", "")).toBe(true);
  });
});
