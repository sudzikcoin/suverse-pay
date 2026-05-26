/**
 * Per-API-key monthly settlement counter for the Coinbase CDP free tier
 * (1,000 settlements / month, $0.001 / settlement after that). The
 * adapter consults the tracker on every `supports()` check to refuse
 * routes that would push us past the configured hard cap.
 *
 * Phase 1 ships an in-memory tracker so unit tests have no Redis
 * dependency. Step 6 (orchestrator) will plug in a Redis-backed
 * implementation that persists across restarts and resets on the
 * first of each UTC month.
 */
export interface UsageTracker {
  /** Returns the current settlement count for the active accounting period. */
  current(): Promise<number>;
  /** Increments the settlement count by one. Called only on settle success. */
  increment(): Promise<void>;
  /** Resets the counter to zero. Called by the monthly cron, not by adapters. */
  reset(): Promise<void>;
}

export class InMemoryUsageTracker implements UsageTracker {
  private count: number;

  constructor(initial = 0) {
    this.count = initial;
  }

  async current(): Promise<number> {
    return this.count;
  }

  async increment(): Promise<void> {
    this.count += 1;
  }

  async reset(): Promise<void> {
    this.count = 0;
  }
}
