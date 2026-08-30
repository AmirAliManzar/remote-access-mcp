import { EventEmitter } from 'node:events';

/**
 * Token-bucket rate limiter. One bucket per key (token hash).
 * Zero-dependency, in-process. Good enough for a single-node gateway.
 */
interface Bucket {
  tokens: number;
  last: number;
}

export class RateLimiter extends EventEmitter {
  private buckets = new Map<string, Bucket>();
  private readonly max: number;
  private readonly refillPerSecond: number;
  private lastSweep = Date.now();

  constructor(max = 60, perSecond = 1) {
    super();
    this.max = max;
    this.refillPerSecond = perSecond;
  }

  private sweep(): void {
    const now = Date.now();
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    const staleCut = now - 10 * 60_000; // 10 min idle → forget
    for (const [k, b] of this.buckets) {
      if (b.last < staleCut) this.buckets.delete(k);
    }
  }

  /** Returns true if the request is allowed. */
  allow(key: string, burst = 0): boolean {
    this.sweep();
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.max, last: now };
      this.buckets.set(key, b);
    }
    const elapsed = (now - b.last) / 1000;
    b.tokens = Math.min(this.max, b.tokens + elapsed * this.refillPerSecond);
    b.last = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    if (burst > 0) {
      // Allow small bursts to drain gradually — useful for chat clients
      // that legitimately fire a few rapid requests in one turn.
      b.tokens -= 0; // burst reserved: caller may pass precomputed burst allowance
      return false;
    }
    return false;
  }

  /** Specialized check: allow up to `burst` extra beyond the steady rate. */
  allowBurst(key: string, burst: number): boolean {
    this.sweep();
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.max + burst, last: now };
      this.buckets.set(key, b);
    }
    const elapsed = (now - b.last) / 1000;
    const capacity = this.max + burst;
    b.tokens = Math.min(capacity, b.tokens + elapsed * this.refillPerSecond);
    b.last = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }
}
