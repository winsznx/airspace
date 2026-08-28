import type { BookLevel } from "@airspace/protocol";
import { onLot, onTick, quantizeDown } from "@airspace/risk";

/**
 * Demonstration strategies.
 *
 * These exist to put THREE INDEPENDENT, UNCOORDINATED processes against one
 * shared risk envelope. They are not trading strategies and make no claim to
 * edge: what AIRSPACE has to prove is that separately-keyed agents with
 * different sizing and timing cannot collectively exceed a limit, and that is
 * what these produce. Any of them can be replaced by a real strategy without
 * touching the portfolio contract.
 *
 * All three place POST-ONLY orders (DreamDEX order type 3). That is deliberate:
 * a resting order is the case AIRSPACE has to get right, because it occupies the
 * shared envelope from the moment it is admitted until it fills or is released.
 */

export type StrategyId = "momentum" | "reversion" | "spread";

/** DreamDEX quotes probability in collateral scale: 1e6 == certainty. */
export const ONE = 1_000_000n;

/**
 * How far off the touch to quote, in ticks.
 *
 * DreamDEX rejects a post-only order that would cross with `PostOnlyWouldCross()`,
 * and the geometry of that check is the venue's, not ours: measured live, a buy
 * of YES rests several percent below the touch while a buy of NO rests several
 * percent above it. Rather than hard-code a reverse-engineered rule that a venue
 * upgrade would silently break, agents start conservative and widen when the
 * venue says they crossed. See `nextOffset`.
 */
export const DEFAULT_OFFSET_TICKS = 60;
export const MAX_OFFSET_TICKS = 400;

/** Widen after a cross, narrow back gradually after a rest. */
export const nextOffset = (current: number, crossed: boolean): number =>
  crossed
    ? Math.min(MAX_OFFSET_TICKS, Math.max(DEFAULT_OFFSET_TICKS, current) * 2)
    : Math.max(DEFAULT_OFFSET_TICKS, Math.floor(current * 0.75));

export interface Grid {
  tickSize: bigint;
  lotSize: bigint;
  minQuantity: bigint;
}

export interface Book {
  bids: readonly BookLevel[];
  asks: readonly BookLevel[];
}

/** 0 buy YES, 1 sell YES, 2 buy NO, 3 sell NO — the contract's ordering. */
export interface Proposal {
  kind: 0 | 2;
  price: bigint;
  quantity: bigint;
  rationale: string;
}

export const bestBid = (b: Book): bigint | null => b.bids[0]?.price ?? null;
export const bestAsk = (b: Book): bigint | null => b.asks[0]?.price ?? null;

/** Mid, or null when one side is empty and there is nothing to be mid of. */
export function mid(b: Book): bigint | null {
  const bid = bestBid(b);
  const ask = bestAsk(b);
  if (bid === null || ask === null) return null;
  return (bid + ask) / 2n;
}

export interface Context {
  book: Book;
  grid: Grid;
  /** The mid this agent last saw in this market, if it has seen one. */
  previousMid: bigint | null;
  /** Size the agent is willing to put on, before any policy clipping. */
  baseQuantity: bigint;
  /** Current back-off, in ticks, from this agent's own KV state. */
  offsetTicks: number;
  secondsRemaining: number;
}

/**
 * Propose one order, or nothing.
 *
 * Returning null is a first-class outcome. An agent with no view should not
 * manufacture one, and an empty book is exactly that case.
 *
 * Only BUY sides are proposed. Selling requires outcome tokens the portfolio may
 * not hold, and DreamDEX answers a naked sell with `InsufficientBalance()` — a
 * venue-side refusal that says nothing about portfolio risk and would only add
 * noise to the admission feed.
 */
export function propose(strategy: StrategyId, c: Context): Proposal | null {
  const m = mid(c.book);
  if (m === null || m <= 0n || m >= ONE) return null;

  const bid = bestBid(c.book)!;
  const ask = bestAsk(c.book)!;
  // A crossed or one-sided book is not a book to quote into.
  if (ask <= bid) return null;

  const offset = c.grid.tickSize * BigInt(Math.max(1, c.offsetTicks));
  const buyYesAt = bid > offset ? bid - offset : 0n;
  const buyNoAt = bid + offset;

  const raw = (() => {
    switch (strategy) {
      case "momentum": {
        // Follow the move. With no previous observation there is no move to
        // follow, so the first tick in a market is always a pass.
        if (c.previousMid === null) return null;
        const drift = m - c.previousMid;
        // A move smaller than one tick is noise, not a signal.
        if (drift > -c.grid.tickSize && drift < c.grid.tickSize) return null;
        return drift > 0n
          ? { kind: 0 as const, price: buyYesAt, rationale: `mid rose ${drift} since last observation` }
          : { kind: 2 as const, price: buyNoAt, rationale: `mid fell ${-drift} since last observation` };
      }

      case "reversion": {
        // Fade the extreme. Bid for whichever side the book has pushed furthest
        // from even money.
        const distance = m > ONE / 2n ? m - ONE / 2n : ONE / 2n - m;
        if (distance < c.grid.tickSize * 5n) return null;
        return m > ONE / 2n
          ? { kind: 2 as const, price: buyNoAt, rationale: `YES at ${m}, fading toward even` }
          : { kind: 0 as const, price: buyYesAt, rationale: `YES at ${m}, fading toward even` };
      }

      case "spread": {
        // Quote the YES side and stay there. This is the branch that exercises
        // the reservation path hardest: the order does not fill, and the capital
        // it will need is held against the shared envelope from the moment it is
        // admitted until it is gone.
        if (c.secondsRemaining < 120) return null;
        return { kind: 0 as const, price: buyYesAt, rationale: `quoting ${c.offsetTicks} ticks under ${bid}` };
      }
    }
  })();

  if (!raw) return null;

  // Snap to the venue's grid before anything else sees the numbers. Rounding
  // DOWN on both axes keeps the order inside every limit it was checked against.
  const price = quantizeDown(raw.price, c.grid.tickSize);
  const quantity = quantizeDown(c.baseQuantity, c.grid.lotSize);

  if (price <= 0n || price >= ONE) return null;
  if (quantity < c.grid.minQuantity) return null;
  if (!onTick(price, c.grid.tickSize) || !onLot(quantity, c.grid.lotSize)) return null;

  return { kind: raw.kind, price, quantity, rationale: raw.rationale };
}
