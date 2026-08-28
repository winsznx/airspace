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
  /** Realized ERC-6909 balance. */
  yesBalance: bigint;
  noBalance: bigint;
  /** Unfilled reservations, by side. */
  yesLong: bigint;
  yesShort: bigint;
  noLong: bigint;
  noShort: bigint;
  settled: boolean;
}

/**
 * Directional exposure of ONE binary market, in contract units.
 *
 * Within a market, YES and NO are complementary fixed-payout claims, so a
 * matched YES+NO pair is a complete set worth exactly one collateral unit at
 * settlement regardless of outcome. It therefore carries zero directional
 * outcome exposure and correctly nets to zero here — the TAPE result,
 * reproduced. A settled market carries none: its position is a fixed claim.
 */
export function marketDirectionalExposure(p: MarketPosition): bigint {
  if (p.settled) return 0n;
  const netYes = p.yesBalance + p.yesLong - p.yesShort;
  const netNo = p.noBalance + p.noLong - p.noShort;
  return netYes - netNo;
}

export const abs = (x: bigint): bigint => (x < 0n ? -x : x);

/**
 * Domain risk usage: the sum of ABSOLUTE directional exposure over a domain's
 * markets.
 *
 * Gross, never netted across markets. Two markets in one cadence domain are
 * different questions resolving at different times against different reference
 * prices — and the domain does not even establish that they share an underlying.
 * Netting would understate risk; summing absolutes can only overstate, which is
 * the safe direction (PRD 10.5).
 */
export function domainRiskUsage(positions: readonly MarketPosition[]): bigint {
  let usage = 0n;
  for (const p of positions) usage += abs(marketDirectionalExposure(p));
  return usage;
}

/** Collateral no longer free: escrowed behind resting orders, or spent on positions. */
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
