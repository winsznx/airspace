/**
 * @airspace/risk — the accounting engine.
 *
 * Exact integer arithmetic throughout. Floating point never touches a price,
 * quantity, collateral amount, reservation or outcome balance; `format*` is the
 * only place a number becomes a string, and only for display.
 *
 * The six quantities are distinct and are never used interchangeably (PRD 10).
 */

import type { AdmissionView, DomainId, MarketId, Refusal } from "@airspace/types";
import { REFUSAL_COPY, REFUSAL_GATE, GATE_ROWS, hasGate, Refusal as R } from "@airspace/types";

// ---------------------------------------------------------------------------
// Position accounting
// ---------------------------------------------------------------------------

export interface MarketPosition {
  marketId: MarketId;
  /** Realized ERC-6909 balance — what the portfolio holds RIGHT NOW. */
  yesBalance: bigint;
  noBalance: bigint;
  /** Unfilled reservations, by side. Each resolves INDEPENDENTLY. */
  yesLong: bigint;
  yesShort: bigint;
  noLong: bigint;
  noShort: bigint;
  settled: boolean;
}

export const abs = (x: bigint): bigint => (x < 0n ? -x : x);

/**
 * Realized directional position of ONE market: what the portfolio holds RIGHT
 * NOW, with no reservations. Mirrors the contract's `marketDirectionalExposure`
 * exactly — a matched YES+NO pair nets to a complete set, worth one collateral
 * unit at settlement regardless of outcome, so it carries no direction. A
 * settled market returns 0: its position is a fixed claim, not a bet.
 *
 * This is NOT the number admission gates on. See `marketWorstCaseExposure`.
 */
export function marketDirectionalExposure(p: MarketPosition): bigint {
  if (p.settled) return 0n;
  return p.yesBalance - p.noBalance;
}

/**
 * The reachable INTERVAL of a market's directional position, given every
 * resting order can resolve independently.
 *
 * A SELL escrows its outcome tokens at PLACEMENT — verified live on four
 * Shannon pools, each of whose outcome-token balance equalled its resting ask
 * depth exactly — so a resting sell has already left the realized balance, and
 * what it exposes is the escrow returning if it is cancelled. That is why
 * `yesShort` widens the UPPER bound rather than narrowing it.
 */
export function marketExposureBounds(p: MarketPosition): { up: bigint; dn: bigint } {
  if (p.settled) return { up: 0n, dn: 0n };
  const b = p.yesBalance - p.noBalance;
  return { up: b + p.yesLong + p.yesShort, dn: b - p.noLong - p.noShort };
}

/**
 * Worst-case directional exposure of ONE market — the widest point of the
 * reachable interval. Mirrors the contract's `marketWorstCaseExposure` exactly,
 * and is what admission actually gates on.
 *
 * Opposing pending orders are NEVER netted here: a pending BUY_YES and a
 * pending BUY_NO can each fill without the other, and assuming they resolve
 * together is the mistake that made AIRSPACE 1.0.0 unsafe (understated a true
 * worst case of 1,170 as 80). See ARCHITECTURE.md and
 * evidence/production/REMEDIATION.md.
 */
export function marketWorstCaseExposure(p: MarketPosition): bigint {
  const { up, dn } = marketExposureBounds(p);
  const a = abs(up);
  const c = abs(dn);
  return a > c ? a : c;
}

/**
 * Domain risk usage: the sum of per-market WORST-CASE exposure, never netted
 * across markets. Mirrors the contract's `domainRiskUsage` exactly.
 *
 * Two markets in one cadence domain are different questions resolving at
 * different times against different reference prices — the domain does not
 * even establish that they share an underlying. Netting would understate risk;
 * summing worst cases can only overstate, which is the safe direction.
 */
export function domainRiskUsage(positions: readonly MarketPosition[]): bigint {
  let usage = 0n;
  for (const p of positions) usage += marketWorstCaseExposure(p);
  return usage;
}

/**
 * Collateral not currently free, measured as `capitalBase − freeCollateral`.
 *
 * This is NOT "capital tied up in open positions." It is derived, not
 * accumulated, which is exact and self-healing for escrow leaving, a fill
 * spending collateral, a cancel returning escrow and a redemption returning
 * collateral — but it has one honest gap: collateral arriving from a
 * PROFITABLE sale is indistinguishable from collateral that was never spent.
 * A sell whose proceeds exceed its cost raises `freeCollateral` above
 * `capitalBase`, and this floors at zero — reading as "nothing committed"
 * even while orders are still open.
 *
 * That is a real imprecision in the BUDGET this number represents, and the UI
 * must not present it as "capital in positions." It is not a solvency gap:
 * every buy is gated on `freeCollateral()` read from the token itself, so the
 * portfolio can never authorise collateral it does not hold. The owner
 * corrects the base with `setCapitalBase` after realising profit. See
 * evidence/production/REMEDIATION.md and SECURITY.md.
 */
export function committedCapital(capitalBase: bigint, freeCollateral: bigint): bigint {
  return capitalBase > freeCollateral ? capitalBase - freeCollateral : 0n;
}

/**
 * Collateral a BUY escrows, matching the pool's own ceil-rounded computation.
 * A SELL escrows outcome tokens; its collateral-equivalent is used only for
 * notional ceilings and never added to committed capital.
 */
export function reserveFor(kind: number, price: bigint, quantity: bigint, oneCollateral: bigint): bigint {
  const unit = kind === 0 || kind === 1 ? price : oneCollateral - price;
  return (unit * quantity + oneCollateral - 1n) / oneCollateral;
}

/** Worst-case loss for a market holding `y` YES and `n` NO acquired for `cost`. */
export function maximumLoss(yes: bigint, no: bigint, cost: bigint): bigint {
  const guaranteed = yes < no ? yes : no; // exactly the complete-set component
  const loss = cost - guaranteed;
  return loss > 0n ? loss : 0n;
}

// ---------------------------------------------------------------------------
// Grid conformance — integer only
// ---------------------------------------------------------------------------

export function onTick(price: bigint, tickSize: bigint): boolean {
  return tickSize === 0n || price % tickSize === 0n;
}

export function onLot(quantity: bigint, lotSize: bigint): boolean {
  return lotSize === 0n || quantity % lotSize === 0n;
}

/** Round DOWN to the venue grid. Never rounds up: that could breach a ceiling. */
export function quantizeDown(value: bigint, step: bigint): bigint {
  if (step <= 1n) return value;
  return (value / step) * step;
}

// ---------------------------------------------------------------------------
// Admission explanation
// ---------------------------------------------------------------------------

export interface GateResult {
  key: string;
  label: string;
  pass: boolean;
  /** True for the single gate that actually blocked this intent. */
  blocking: boolean;
}

/**
 * Turn the contract's decision into the product's gate-by-gate view.
 *
 * The pass/fail values come from the contract's own bitmask, so this is a
 * rendering of the enforced decision rather than a re-implementation of it.
 */
export function explainAdmission(v: AdmissionView): {
  admitted: boolean;
  gates: GateResult[];
  blockingGate: string | null;
  copy: { title: string; detail: string; action: string } | null;
  arithmetic: { before: bigint; requested: bigint; after: bigint; ceiling: bigint } | null;
} {
  const admitted = v.refusal === R.NONE;
  const blockingGate = admitted ? null : (REFUSAL_GATE[v.refusal] ?? null);

  const gates: GateResult[] = GATE_ROWS.map((row) => ({
    key: row.key,
    label: row.label,
    pass: hasGate(v.gates, row.bit),
    blocking: !admitted && row.key === blockingGate,
  }));

  // A refusal short-circuits evaluation, so gates after the blocking one were
  // never reached. Showing them as "failed" would be a lie; they are unknown.
  const blockIdx = gates.findIndex((g) => g.blocking);
  if (blockIdx >= 0) {
    for (let i = 0; i < blockIdx; i++) gates[i]!.pass = true;
  }

  const isDomainRefusal =
    v.refusal === R.DOMAIN_RISK_EXCEEDED ||
    v.refusal === R.DOMAIN_COMMITTED_EXCEEDED ||
    v.refusal === R.NONE;

  return {
    admitted,
    gates,
    blockingGate,
    copy: admitted ? null : (REFUSAL_COPY[v.refusal] ?? null),
    arithmetic: isDomainRefusal
      ? {
          before: v.domainUsageBefore,
          requested: v.domainUsageAfter - v.domainUsageBefore,
          after: v.domainUsageAfter,
          ceiling: v.domainCeiling,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Presentation — the ONLY place integers become strings
// ---------------------------------------------------------------------------

/** Format a raw integer with `decimals` places. Never returns a float. */
export function formatUnits(value: bigint, decimals: number, maxFractionDigits = decimals): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = (v % base).toString().padStart(decimals, "0");
  if (maxFractionDigits < decimals) frac = frac.slice(0, maxFractionDigits);
  frac = frac.replace(/0+$/, "");
  const s = frac.length > 0 ? `${whole}.${frac}` : whole.toString();
  return neg ? `-${s}` : s;
}

export function parseUnits(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^-?\d*(\.\d*)?$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    throw new Error(`not a decimal number: ${value}`);
  }
  const neg = trimmed.startsWith("-");
  const [w = "0", f = ""] = (neg ? trimmed.slice(1) : trimmed).split(".");
  if (f.length > decimals) throw new Error(`more than ${decimals} decimal places: ${value}`);
  const raw = BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((f || "0").padEnd(decimals, "0") || "0");
  return neg ? -raw : raw;
}

/** Contracts are quoted in collateral-scale units; 1e6 == one contract on a 6dp venue. */
export function formatContracts(qty: bigint, oneCollateral: bigint): string {
  return formatUnits(qty, Math.round(Math.log10(Number(oneCollateral))), 2);
}

/** A YES-side price expressed as a probability percentage, for display only. */
export function formatProbability(price: bigint, oneCollateral: bigint): string {
  const bps = (price * 10000n) / oneCollateral;
  return `${formatUnits(bps, 2, 2)}%`;
}

export function percentOf(part: bigint, whole: bigint): number {
  if (whole === 0n) return 0;
  return Number((part * 10000n) / whole) / 100;
}
