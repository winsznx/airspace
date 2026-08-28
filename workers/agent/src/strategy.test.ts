import { describe, expect, it } from "vitest";
import { DEFAULT_OFFSET_TICKS, MAX_OFFSET_TICKS, ONE, mid, nextOffset, propose, type Context } from "./strategy.js";

const GRID = { tickSize: 1_000n, lotSize: 1_000n, minQuantity: 1_000n };

const ctx = (over: Partial<Context> = {}): Context => ({
  book: {
    bids: [{ price: 500_000n, quantity: 100_000_000n }],
    asks: [{ price: 520_000n, quantity: 100_000_000n }],
  },
  grid: GRID,
  previousMid: null,
  baseQuantity: 40_000_000n,
  offsetTicks: DEFAULT_OFFSET_TICKS,
  secondsRemaining: 600,
  ...over,
});

describe("mid", () => {
  it("is null when a side is empty, because there is nothing to be mid of", () => {
    expect(mid({ bids: [], asks: [{ price: 520_000n, quantity: 1n }] })).toBeNull();
    expect(mid({ bids: [{ price: 500_000n, quantity: 1n }], asks: [] })).toBeNull();
  });

  it("is the midpoint of the touch", () => {
    expect(mid(ctx().book)).toBe(510_000n);
  });
});

describe("propose", () => {
  it("passes on the first observation, because momentum has nothing to compare to", () => {
    expect(propose("momentum", ctx({ previousMid: null }))).toBeNull();
  });

  it("ignores a move smaller than one tick as noise", () => {
    expect(propose("momentum", ctx({ previousMid: 510_000n - 500n }))).toBeNull();
  });

  it("bids YES when the mid rose and NO when it fell", () => {
    const up = propose("momentum", ctx({ previousMid: 400_000n }));
    const down = propose("momentum", ctx({ previousMid: 600_000n }));
    expect(up?.kind).toBe(0);
    expect(down?.kind).toBe(2);
  });

  it("quotes away from the touch on both sides, never through it", () => {
    const offset = BigInt(DEFAULT_OFFSET_TICKS) * GRID.tickSize;
    const bid = 500_000n;
    expect(propose("momentum", ctx({ previousMid: 400_000n }))?.price).toBe(bid - offset);
    expect(propose("momentum", ctx({ previousMid: 600_000n }))?.price).toBe(bid + offset);
  });

  it("still quotes into a one-tick spread, because the offset is what keeps it passive", () => {
    const book = {
      bids: [{ price: 500_000n, quantity: 1n }],
      asks: [{ price: 501_000n, quantity: 1n }],
    };
    const p = propose("spread", ctx({ book }));
    expect(p?.price).toBe(500_000n - BigInt(DEFAULT_OFFSET_TICKS) * GRID.tickSize);
  });

  it("passes on a crossed or one-sided book", () => {
    expect(propose("spread", ctx({ book: { bids: [{ price: 500_000n, quantity: 1n }], asks: [] } }))).toBeNull();
    expect(
      propose("spread", ctx({ book: { bids: [{ price: 520_000n, quantity: 1n }], asks: [{ price: 500_000n, quantity: 1n }] } })),
    ).toBeNull();
  });

  it("fades only a genuine extreme", () => {
    // Five ticks from even money is the threshold; 510_000 is ten thousand away.
    expect(propose("reversion", ctx())?.kind).toBe(2);

    const even = {
      bids: [{ price: 499_000n, quantity: 1n }],
      asks: [{ price: 502_000n, quantity: 1n }],
    };
    expect(propose("reversion", ctx({ book: even }))).toBeNull();
  });

  it("stops quoting the spread near expiry", () => {
    expect(propose("spread", ctx({ secondsRemaining: 119 }))).toBeNull();
    expect(propose("spread", ctx({ secondsRemaining: 121 }))).not.toBeNull();
  });

  it("only ever bids: a naked sell is a venue error, not a risk decision", () => {
    for (const s of ["momentum", "reversion", "spread"] as const) {
      for (const previousMid of [400_000n, 600_000n]) {
        const p = propose(s, ctx({ previousMid }));
        if (p) expect([0, 2]).toContain(p.kind);
      }
    }
  });

  it("snaps price and quantity DOWN onto the venue grid", () => {
    const grid = { tickSize: 7_000n, lotSize: 3_000n, minQuantity: 1_000n };
    const p = propose("spread", ctx({ grid, baseQuantity: 40_000_001n, offsetTicks: 1 }));
    expect(p).not.toBeNull();
    expect(p!.price % grid.tickSize).toBe(0n);
    expect(p!.quantity % grid.lotSize).toBe(0n);
    expect(p!.quantity).toBeLessThanOrEqual(40_000_001n);
  });

  it("refuses to propose below the venue minimum", () => {
    const grid = { ...GRID, minQuantity: 100_000_000n };
    expect(propose("spread", ctx({ grid, baseQuantity: 40_000_000n }))).toBeNull();
  });

  it("never prices at or outside the open interval", () => {
    const nearZero = {
      bids: [{ price: 2_000n, quantity: 1n }],
      asks: [{ price: 900_000n, quantity: 1n }],
    };
    const p = propose("spread", ctx({ book: nearZero }));
    // bid − 60 ticks underflows past zero, so there is no legal passive price.
    expect(p).toBeNull();

    const nearOne = {
      bids: [{ price: ONE - 2_000n, quantity: 1n }],
      asks: [{ price: ONE - 1_000n, quantity: 1n }],
    };
    const q = propose("reversion", ctx({ book: nearOne }));
    if (q) expect(q.price).toBeLessThan(ONE);
  });
});

describe("nextOffset", () => {
  it("widens on a cross and never past the cap", () => {
    expect(nextOffset(DEFAULT_OFFSET_TICKS, true)).toBe(DEFAULT_OFFSET_TICKS * 2);
    expect(nextOffset(MAX_OFFSET_TICKS, true)).toBe(MAX_OFFSET_TICKS);
  });

  it("narrows back after resting but never below the default", () => {
    expect(nextOffset(400, false)).toBe(300);
    expect(nextOffset(DEFAULT_OFFSET_TICKS, false)).toBe(DEFAULT_OFFSET_TICKS);
    expect(nextOffset(1, false)).toBe(DEFAULT_OFFSET_TICKS);
  });

  it("converges rather than oscillating", () => {
    let o = DEFAULT_OFFSET_TICKS;
    for (let i = 0; i < 20; i += 1) o = nextOffset(o, true);
    expect(o).toBe(MAX_OFFSET_TICKS);
    for (let i = 0; i < 20; i += 1) o = nextOffset(o, false);
    expect(o).toBe(DEFAULT_OFFSET_TICKS);
  });
});
