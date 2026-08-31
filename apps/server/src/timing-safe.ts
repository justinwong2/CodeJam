import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison of two secret strings. `timingSafeEqual` throws on
 * buffers of different lengths, so the length is checked first and a mismatch
 * answers false — the length of a credential is not what any of these checks
 * protects. One shared helper rather than a copy per call site, because a
 * hand-rolled comparison is exactly the kind of code that quietly regresses to
 * `===` in a refactor.
 */
export function credentialMatches(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}
