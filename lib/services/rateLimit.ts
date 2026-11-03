// Simple per-user fixed-window rate limiter (in memory, per server instance). It is a courtesy
// guard against click storms; the hard limits that protect the sandbox (workspace caps, reminder
// quota) live in the database.

export interface RateRule {
  limit: number;
  windowMs: number;
}

export const RATE_RULES = {
  workspace_create: { limit: 5, windowMs: 60 * 60_000 },
  mutate: { limit: 60, windowMs: 60_000 },
  paypal_write: { limit: 20, windowMs: 60_000 },
  ai: { limit: 12, windowMs: 60_000 },
} satisfies Record<string, RateRule>;

export type RateBucket = keyof typeof RATE_RULES;

export class RateLimiter {
  private readonly hits = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly rules: Record<string, RateRule> = RATE_RULES,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  /** Counts one hit. Returns the ms to wait when the limit is exceeded, else 0. */
  hit(userId: string, bucket: string): number {
    const rule = this.rules[bucket];
    if (!rule) throw new Error(`unknown rate bucket ${bucket}`);
    const key = `${bucket}:${userId}`;
    const t = this.now();
    const cur = this.hits.get(key);
    if (!cur || t - cur.start >= rule.windowMs) {
      if (this.hits.size >= this.maxKeys) this.sweep(t);
      this.hits.set(key, { start: t, count: 1 });
      return 0;
    }
    if (cur.count >= rule.limit) return rule.windowMs - (t - cur.start);
    cur.count++;
    return 0;
  }

  private sweep(t: number): void {
    const maxWindow = Math.max(...Object.values(this.rules).map((r) => r.windowMs));
    for (const [k, v] of this.hits) if (t - v.start >= maxWindow) this.hits.delete(k);
    if (this.hits.size >= this.maxKeys) this.hits.clear();
  }
}

export const sharedRateLimiter = new RateLimiter();
