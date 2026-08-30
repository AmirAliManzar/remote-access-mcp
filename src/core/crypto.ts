import crypto from 'node:crypto';

/**
 * Constant-time token comparison.
 * A plain `===` leaks length + first-diff timing; this does not.
 */
export function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Compare against self to keep timing uniform, then fail
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}
