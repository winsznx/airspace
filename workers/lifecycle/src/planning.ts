/**
 * Which lifecycle work is already accounted for.
 *
 * The scan runs every minute and looks at every open reservation. Without this
 * it re-queues the same work on every pass: a job that is pending, or that just
 * finished or failed, must not be inserted again until it has had time to take
 * effect. Loading those keys in one query, instead of inserting and letting a
 * unique index reject the duplicate, is what keeps a stuck job from costing two
 * database round trips per pass, per job, forever.
 */

export interface JobRow {
  kind: string;
  order_key: string | null;
  market_id: string | null;
  status: string;
  updated_at: string;
}

/** A job is one kind of work against one order or market. */
export const jobKey = (kind: string, orderKey?: string | null, marketId?: string | null): string =>
  `${kind}|${orderKey ?? ""}|${marketId ?? ""}`;

export interface Cooldowns {
  /** How long a finished job blocks an identical one. */
  doneMs: number;
  /** How long a failed job blocks an identical one. */
  failedMs: number;
}

/**
 * A job in flight blocks a new one however old it is. A finished or failed one
 * blocks it for its cooldown, long enough for the result to reach the
 * projection. Without a cooldown a job that finished but left its reservation
 * looking open was re-queued every minute, which is how one stuck reservation
 * became hundreds of thousands of job rows.
 */
export function blockedKeys(rows: readonly JobRow[], now: number, cooldowns: Cooldowns): Set<string> {
  const blocked = new Set<string>();
  for (const r of rows) {
    const inFlight = r.status === "PENDING" || r.status === "RUNNING";
    const window = r.status === "DONE" ? cooldowns.doneMs : cooldowns.failedMs;
    if (inFlight || now - new Date(r.updated_at).getTime() < window) {
      blocked.add(jobKey(r.kind, r.order_key, r.market_id));
    }
  }
  return blocked;
}
