/**
 * @airspace/types — shared vocabulary.
 *
 * Every protocol quantity is a `bigint`. Floating point is never used for a
 * price, quantity, collateral amount, tick check, lot check, reservation or
 * outcome balance (PRD 11). Formatting to a human string happens once, at the
 * presentation edge, in `@airspace/risk`.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type Address = `0x${string}`;
export type Hex = `0x${string}`;
/** A DreamDEX market id: a stable bytes32. Never key state by pool address. */
export type MarketId = `0x${string}`;
/** keccak256(creator, collateral, canonicalCadence). A cadence domain, not an asset. */
export type DomainId = `0x${string}`;

export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte address")
  .transform((s) => s.toLowerCase() as Address);

export const bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected a 32-byte hex value")
  .transform((s) => s.toLowerCase() as Hex);

/** Accepts a decimal string or bigint; never a float. */
export const bigintSchema = z.union([
  z.bigint(),
  z.string().regex(/^\d+$/, "expected a non-negative integer string").transform((s) => BigInt(s)),
]);

// ---------------------------------------------------------------------------
// Order shape
// ---------------------------------------------------------------------------

/** DreamDEX OrderKind. `price` is ALWAYS the YES-side price. */
export const OrderKind = {
  BUY_YES: 0,
  SELL_YES: 1,
  BUY_NO: 2,
  SELL_NO: 3,
} as const;
export type OrderKind = (typeof OrderKind)[keyof typeof OrderKind];

export const OrderType = {
  LIMIT: 0,
  FILL_OR_KILL: 1,
  IMMEDIATE_OR_CANCEL: 2,
  POST_ONLY: 3,
} as const;
export type OrderType = (typeof OrderType)[keyof typeof OrderType];

export const isBuy = (k: OrderKind): boolean => k === OrderKind.BUY_YES || k === OrderKind.BUY_NO;
export const isYesSide = (k: OrderKind): boolean => k === OrderKind.BUY_YES || k === OrderKind.SELL_YES;

// ---------------------------------------------------------------------------
// Structural risk domains
// ---------------------------------------------------------------------------

/**
 * The canonical series cadences AIRSPACE enforces, in seconds.
 * MUST match `contracts/src/libraries/Cadence.sol` exactly — changing either
 * without the other changes every derived domain id.
 */
export const CANONICAL_CADENCES = [60, 300, 900, 1800, 3600, 14400, 86400] as const;
export type CanonicalCadence = (typeof CANONICAL_CADENCES)[number];

export const CADENCE_LABEL: Record<number, string> = {
  60: "1m",
  300: "5m",
  900: "15m",
  1800: "30m",
  3600: "1h",
  14400: "4h",
  86400: "24h",
};

// ---------------------------------------------------------------------------
// Refusal codes — mirrors contracts/src/interfaces/IAirspace.sol `Refusal`
// ---------------------------------------------------------------------------

export const Refusal = {
  NONE: 0,
  NOT_AGENT: 1,
  AGENT_DISABLED: 2,
  POLICY_EXPIRED: 3,
  INTENT_REPLAYED: 4,
  COOLDOWN_ACTIVE: 5,
  MARKET_NOT_FOUND: 6,
  POOL_MISMATCH: 7,
  MARKET_GENERATION_MISMATCH: 8,
  MARKET_NOT_TRADING: 9,
  INSUFFICIENT_HEADROOM: 10,
  DOMAIN_UNSUPPORTED: 11,
  DOMAIN_NOT_CONFIGURED: 12,
  BAD_ORDER_KIND: 13,
  PRICE_OUTSIDE_POLICY: 14,
  OFF_TICK_GRID: 15,
  OFF_LOT_GRID: 16,
  BELOW_MIN_QUANTITY: 17,
  ORDER_EXPIRY_INVALID: 18,
  AGENT_ORDER_NOTIONAL_EXCEEDED: 19,
  GLOBAL_ORDER_NOTIONAL_EXCEEDED: 20,
  AGENT_COMMITTED_EXCEEDED: 21,
  DOMAIN_RISK_EXCEEDED: 22,
  DOMAIN_COMMITTED_EXCEEDED: 23,
  GLOBAL_COMMITTED_EXCEEDED: 24,
  GLOBAL_RESERVED_EXCEEDED: 25,
  MAX_LIVE_MARKETS_EXCEEDED: 26,
  DOMAIN_MARKETS_FULL: 27,
  INSUFFICIENT_COLLATERAL: 28,
} as const;
export type Refusal = (typeof Refusal)[keyof typeof Refusal];

export const REFUSAL_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(Refusal).map(([k, v]) => [v, k]),
);

/** Which gate a refusal belongs to, for the product's gate-by-gate view. */
export const REFUSAL_GATE: Record<number, GateKey> = {
  [Refusal.NOT_AGENT]: "agent",
  [Refusal.AGENT_DISABLED]: "agent",
  [Refusal.POLICY_EXPIRED]: "agent",
  [Refusal.INTENT_REPLAYED]: "agent",
  [Refusal.COOLDOWN_ACTIVE]: "agent",
  [Refusal.MARKET_NOT_FOUND]: "market",
  [Refusal.POOL_MISMATCH]: "generation",
  [Refusal.MARKET_GENERATION_MISMATCH]: "generation",
  [Refusal.MARKET_NOT_TRADING]: "market",
  [Refusal.INSUFFICIENT_HEADROOM]: "headroom",
  [Refusal.DOMAIN_UNSUPPORTED]: "domain",
  [Refusal.DOMAIN_NOT_CONFIGURED]: "domain",
  [Refusal.BAD_ORDER_KIND]: "grid",
  [Refusal.PRICE_OUTSIDE_POLICY]: "price",
  [Refusal.OFF_TICK_GRID]: "grid",
  [Refusal.OFF_LOT_GRID]: "grid",
  [Refusal.BELOW_MIN_QUANTITY]: "grid",
  [Refusal.ORDER_EXPIRY_INVALID]: "grid",
  [Refusal.AGENT_ORDER_NOTIONAL_EXCEEDED]: "agent",
  [Refusal.GLOBAL_ORDER_NOTIONAL_EXCEEDED]: "portfolio",
  [Refusal.AGENT_COMMITTED_EXCEEDED]: "agent",
  [Refusal.DOMAIN_RISK_EXCEEDED]: "portfolio",
  [Refusal.DOMAIN_COMMITTED_EXCEEDED]: "portfolio",
  [Refusal.GLOBAL_COMMITTED_EXCEEDED]: "portfolio",
  [Refusal.GLOBAL_RESERVED_EXCEEDED]: "portfolio",
  [Refusal.MAX_LIVE_MARKETS_EXCEEDED]: "portfolio",
  [Refusal.DOMAIN_MARKETS_FULL]: "portfolio",
  [Refusal.INSUFFICIENT_COLLATERAL]: "portfolio",
};

/**
 * Trader-facing explanation of each refusal. Deliberately plain: a refusal must
 * say what happened and what the operator can do, not name a Solidity error.
 */
export const REFUSAL_COPY: Record<number, { title: string; detail: string; action: string }> = {
  [Refusal.NOT_AGENT]: {
    title: "Agent not registered",
    detail: "This key is not registered on the portfolio.",
    action: "Register the agent from the Agents page.",
  },
  [Refusal.AGENT_DISABLED]: {
    title: "Agent revoked",
    detail: "The owner has disabled this agent.",
    action: "Re-enable the agent to let it trade again.",
  },
  [Refusal.POLICY_EXPIRED]: {
    title: "Portfolio policy expired",
    detail: "The portfolio's global policy is past its expiry, so no agent can trade.",
    action: "Renew the global policy.",
  },
  [Refusal.INTENT_REPLAYED]: {
    title: "Intent already used",
    detail: "This agent has already submitted an intent with this nonce or a later one.",
    action: "The agent should increment its nonce.",
  },
  [Refusal.COOLDOWN_ACTIVE]: {
    title: "Cooldown active",
    detail: "This agent traded too recently under its own rate limit.",
    action: "Wait for the cooldown, or relax it in the agent policy.",
  },
  [Refusal.MARKET_NOT_FOUND]: {
    title: "Market not found",
    detail: "The DreamDEX registry has no market with this id.",
    action: "Refresh the market list.",
  },
  [Refusal.POOL_MISMATCH]: {
    title: "Wrong pool",
    detail: "The pool supplied is not the pool the registry binds to this market.",
    action: "Rebuild the intent from live market data.",
  },
  [Refusal.MARKET_GENERATION_MISMATCH]: {
    title: "Stale market generation",
    detail: "The pool has rolled to a later market since this intent was built. Pools are recycled, so an address alone is not a market.",
    action: "Rebuild the intent against the current generation.",
  },
  [Refusal.MARKET_NOT_TRADING]: {
    title: "Market not trading",
    detail: "The market is outside its trading window, resolved, voided or finalized.",
    action: "Trade the current market in this series.",
  },
  [Refusal.INSUFFICIENT_HEADROOM]: {
    title: "Too close to expiry",
    detail: "Less time remains than the portfolio's required headroom.",
    action: "Wait for the next generation, or lower the headroom requirement.",
  },
  [Refusal.DOMAIN_UNSUPPORTED]: {
    title: "Unrecognised cadence",
    detail: "This market's window does not match a canonical series cadence, so it has no risk domain.",
    action: "None — AIRSPACE fails closed on markets it cannot classify.",
  },
  [Refusal.DOMAIN_NOT_CONFIGURED]: {
    title: "Risk domain not configured",
    detail: "The owner has set no ceiling for this structural domain, and unconfigured domains are denied by default.",
    action: "Configure a ceiling for this domain.",
  },
  [Refusal.BAD_ORDER_KIND]: {
    title: "Invalid order side",
    detail: "The order kind is not one of BUY_YES, SELL_YES, BUY_NO or SELL_NO.",
    action: "Fix the agent's order construction.",
  },
  [Refusal.PRICE_OUTSIDE_POLICY]: {
    title: "Price outside policy",
    detail: "The price breaches the agent's or the portfolio's price bound.",
    action: "Quote inside the configured bound.",
  },
  [Refusal.OFF_TICK_GRID]: {
    title: "Price off the tick grid",
    detail: "DreamDEX requires prices on an exact tick. Float arithmetic is the usual cause.",
    action: "Round the price to the venue tick using integer maths.",
  },
  [Refusal.OFF_LOT_GRID]: {
    title: "Quantity off the lot grid",
    detail: "DreamDEX requires quantities on an exact lot.",
    action: "Round the quantity down to the venue lot.",
  },
  [Refusal.BELOW_MIN_QUANTITY]: {
    title: "Below minimum size",
    detail: "The order is smaller than the venue's minimum quantity.",
    action: "Increase the order size.",
  },
  [Refusal.ORDER_EXPIRY_INVALID]: {
    title: "Invalid order expiry",
    detail: "Order expiry must be set and cannot exceed the market's own expiry.",
    action: "Set expiry at or before the market expiry.",
  },
  [Refusal.AGENT_ORDER_NOTIONAL_EXCEEDED]: {
    title: "Order too large for this agent",
    detail: "The order exceeds this agent's own per-order ceiling.",
    action: "Reduce the size or raise the agent's ceiling.",
  },
  [Refusal.GLOBAL_ORDER_NOTIONAL_EXCEEDED]: {
    title: "Order too large for the portfolio",
    detail: "The order exceeds the portfolio's per-order ceiling.",
    action: "Reduce the size or raise the portfolio ceiling.",
  },
  [Refusal.AGENT_COMMITTED_EXCEEDED]: {
    title: "Agent budget exhausted",
    detail: "This agent has committed its full share of portfolio capital.",
    action: "Release the agent's capacity or raise its budget.",
  },
  [Refusal.DOMAIN_RISK_EXCEEDED]: {
    title: "Portfolio risk ceiling reached",
    detail: "This order is valid on its own, but combined with what other agents already hold and have reserved it would push this risk domain over its ceiling.",
    action: "Release capacity, or raise the domain ceiling.",
  },
  [Refusal.DOMAIN_COMMITTED_EXCEEDED]: {
    title: "Domain capital ceiling reached",
    detail: "Committed capital in this domain would exceed its configured ceiling.",
    action: "Release capital or raise the ceiling.",
  },
  [Refusal.GLOBAL_COMMITTED_EXCEEDED]: {
    title: "Portfolio capital ceiling reached",
    detail: "Committed capital across the whole portfolio would exceed its ceiling.",
    action: "Release capital or raise the ceiling.",
  },
  [Refusal.GLOBAL_RESERVED_EXCEEDED]: {
    title: "Too much capital in resting orders",
    detail: "Collateral escrowed behind resting orders would exceed the portfolio ceiling.",
    action: "Cancel resting orders, or raise the reservation ceiling.",
  },
  [Refusal.MAX_LIVE_MARKETS_EXCEEDED]: {
    title: "Too many live markets",
    detail: "The domain already holds the maximum number of markets carrying exposure.",
    action: "Let positions settle, or raise the limit.",
  },
  [Refusal.DOMAIN_MARKETS_FULL]: {
    title: "Domain tracking full",
    detail: "This domain is tracking the maximum number of markets. Spent generations need pruning.",
    action: "Run lifecycle cleanup to prune settled markets.",
  },
  [Refusal.INSUFFICIENT_COLLATERAL]: {
    title: "Not enough free collateral",
    detail: "The portfolio does not hold enough free collateral to escrow this order.",
    action: "Fund the portfolio, or free collateral by cancelling resting orders.",
  },
};

// ---------------------------------------------------------------------------
// Admission gates — mirrors the `Gate` bitmask in IAirspace.sol
// ---------------------------------------------------------------------------

export const Gate = {
  AGENT_REGISTERED: 1 << 0,
  AGENT_POLICY: 1 << 1,
  MARKET_RESOLVED: 1 << 2,
  MARKET_TRADING: 1 << 3,
  GENERATION: 1 << 4,
  GRID: 1 << 5,
  PRICE: 1 << 6,
  HEADROOM: 1 << 7,
  DOMAIN_CONFIGURED: 1 << 8,
  DOMAIN_CAPACITY: 1 << 9,
  GLOBAL_CAPACITY: 1 << 10,
} as const;

export type GateKey = "agent" | "market" | "generation" | "grid" | "price" | "headroom" | "domain" | "portfolio";

/** The gate rows the product shows, in the order it shows them. */
export const GATE_ROWS: ReadonlyArray<{ key: GateKey; label: string; bit: number }> = [
  { key: "agent", label: "Agent policy", bit: Gate.AGENT_POLICY },
  { key: "market", label: "Market trading", bit: Gate.MARKET_TRADING },
  { key: "generation", label: "Market generation", bit: Gate.GENERATION },
  { key: "grid", label: "Tick / lot", bit: Gate.GRID },
  { key: "price", label: "Price ceiling", bit: Gate.PRICE },
  { key: "headroom", label: "Market headroom", bit: Gate.HEADROOM },
  { key: "portfolio", label: "Portfolio domain", bit: Gate.DOMAIN_CAPACITY },
];

export const hasGate = (mask: number, bit: number): boolean => (mask & bit) !== 0;

// ---------------------------------------------------------------------------
// Policies and intents
// ---------------------------------------------------------------------------

export interface GlobalPolicy {
  maxCommittedCapital: bigint;
  maxReservedCollateral: bigint;
  maxSingleOrderNotional: bigint;
  maxBuyPrice: bigint;
  minSellPrice: bigint;
  minHeadroomSec: bigint;
  policyExpiry: bigint;
}

export interface DomainPolicy {
  configured: boolean;
  maxDomainRiskUsage: bigint;
  maxDomainCommitted: bigint;
  maxLiveMarkets: number;
}

export interface AgentPolicy {
  enabled: boolean;
  maxCommitted: bigint;
  maxOrderNotional: bigint;
  maxBuyPrice: bigint;
  minSellPrice: bigint;
  cooldownSec: bigint;
  strategyId: Hex;
}

export interface Intent {
  marketId: MarketId;
  pool: Address;
  marketNonce: bigint;
  kind: OrderKind;
  price: bigint;
  quantity: bigint;
  expireTimestampNs: bigint;
  orderType: OrderType;
  nonce: bigint;
  strategyVersion: Hex;
}

/** The contract's admission decision, exactly as `previewIntent` returns it. */
export interface AdmissionView {
  refusal: Refusal;
  gates: number;
  domain: DomainId;
  cadenceSec: number;
  pool: Address;
  expiry: bigint;
  reserveRequired: bigint;
  marketDirectionalBefore: bigint;
  marketDirectionalAfter: bigint;
  domainUsageBefore: bigint;
  domainUsageAfter: bigint;
  domainCeiling: bigint;
  committedAfter: bigint;
  globalCommittedCeiling: bigint;
  agentCommittedAfter: bigint;
  agentCommittedCeiling: bigint;
}

// ---------------------------------------------------------------------------
// Market identity
// ---------------------------------------------------------------------------

/** A DreamDEX market as AIRSPACE needs it. `pool` is provenance, never a key. */
export interface Market {
  marketId: MarketId;
  pool: Address;
  marketAddress: Address;
  marketNonce: bigint;
  creator: Address;
  collateral: Address;
  tradingStart: bigint;
  expiry: bigint;
  yesId: bigint;
  noId: bigint;
  /** Canonical cadence in seconds; 0 when the market has no structural domain. */
  cadenceSec: number;
  domain: DomainId | null;
  /** NON_AUTHORITATIVE informational label from the indexer, e.g. "BTC". */
  assetLabel?: string;
}

/**
 * How a displayed value is backed. The product must never present an
 * offchain-witness field as though the portfolio contract asserted it.
 */
export type Provenance = "ONCHAIN_VERIFIABLE" | "DERIVED_FROM_ONCHAIN" | "OFFCHAIN_WITNESS" | "UNKNOWN";

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  ONCHAIN_VERIFIABLE: "On-chain",
  DERIVED_FROM_ONCHAIN: "Derived on-chain",
  OFFCHAIN_WITNESS: "Off-chain label",
  UNKNOWN: "Unknown",
};

// ---------------------------------------------------------------------------
// Reservation lifecycle — PRD 14.1
// ---------------------------------------------------------------------------

export const ReservationState = {
  PROPOSED: "PROPOSED",
  RESERVED: "RESERVED",
  PLACED: "PLACED",
  PARTIAL: "PARTIAL",
  RESTING: "RESTING",
  FILLED: "FILLED",
  CANCELLED: "CANCELLED",
  EXPIRED: "EXPIRED",
  FINALIZED: "FINALIZED",
  VOIDED: "VOIDED",
  REDEEMED: "REDEEMED",
  NEEDS_RECONCILIATION: "NEEDS_RECONCILIATION",
} as const;
export type ReservationState = (typeof ReservationState)[keyof typeof ReservationState];

// ---------------------------------------------------------------------------
// Chain
// ---------------------------------------------------------------------------

export const SHANNON_CHAIN_ID = 50312;

export const intentSchema = z.object({
  marketId: bytes32Schema,
  pool: addressSchema,
  marketNonce: bigintSchema,
  kind: z.number().int().min(0).max(3),
  price: bigintSchema,
  quantity: bigintSchema,
  expireTimestampNs: bigintSchema,
  orderType: z.number().int().min(0).max(3),
  nonce: bigintSchema,
  strategyVersion: bytes32Schema,
});
