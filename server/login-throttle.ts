/**
 * Slows down password guessing against one username. The first few failures are free; after
 * that each further failure locks the username for twice as long as the last, up to a cap.
 *
 * The lock is keyed on the submitted username whether or not such an account exists, so the
 * "too many attempts" response reveals nothing about which usernames are real.
 */
export interface ThrottleOptions {
  /** Failures allowed before the first lock. */
  freeAttempts?: number;
  baseLockSeconds?: number;
  maxLockSeconds?: number;
  /** A username with no failure for this long starts from zero again. */
  forgetAfterSeconds?: number;
  /** Upper bound on tracked usernames, so made-up usernames cannot exhaust memory. */
  maxTracked?: number;
}

interface Entry {
  failures: number;
  lastFailureAt: number;
  lockedUntil: number;
}

export class LoginThrottle {
  private readonly entries = new Map<string, Entry>();
  private readonly freeAttempts: number;
  private readonly baseLockMs: number;
  private readonly maxLockMs: number;
  private readonly forgetAfterMs: number;
  private readonly maxTracked: number;

  constructor(
    private readonly clock: () => number,
    options: ThrottleOptions = {},
  ) {
    this.freeAttempts = options.freeAttempts ?? 5;
    this.baseLockMs = (options.baseLockSeconds ?? 30) * 1000;
    this.maxLockMs = (options.maxLockSeconds ?? 900) * 1000;
    this.forgetAfterMs = (options.forgetAfterSeconds ?? 900) * 1000;
    this.maxTracked = options.maxTracked ?? 10_000;
  }

  /** Seconds the caller must still wait before trying this username, or 0 if it may try now. */
  retryAfterSeconds(username: string): number {
    const entry = this.current(username);
    if (entry === undefined) return 0;
    const remaining = entry.lockedUntil - this.clock();
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  }

  recordFailure(username: string): void {
    const now = this.clock();
    const entry = this.current(username) ?? { failures: 0, lastFailureAt: now, lockedUntil: 0 };
    entry.failures += 1;
    entry.lastFailureAt = now;

    const overLimit = entry.failures - this.freeAttempts;
    if (overLimit >= 0) {
      // Cap the exponent as well as the result so a long run cannot overflow.
      const lockMs = Math.min(this.baseLockMs * 2 ** Math.min(overLimit, 20), this.maxLockMs);
      entry.lockedUntil = now + lockMs;
    }

    // Re-insert so the map stays ordered by most recent failure; evict the stalest when full.
    this.entries.delete(username);
    this.entries.set(username, entry);
    if (this.entries.size > this.maxTracked) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }

  recordSuccess(username: string): void {
    this.entries.delete(username);
  }

  private current(username: string): Entry | undefined {
    const entry = this.entries.get(username);
    if (entry === undefined) return undefined;
    const now = this.clock();
    if (entry.lockedUntil <= now && now - entry.lastFailureAt > this.forgetAfterMs) {
      this.entries.delete(username);
      return undefined;
    }
    return entry;
  }
}
