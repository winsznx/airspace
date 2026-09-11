import { decodeEventLog, type Log } from "viem";
import { orderKey } from "@airspace/protocol";
import { airspacePortfolioAbi } from "@airspace/sdk";
import type { Address } from "@airspace/types";

/**
 * A portfolio's event history, decoded from its own logs.
 *
 * This is the whole "index" AIRSPACE needs. Every row a page renders — agents,
 * activity, receipts, reservations, positions — is derived from these events
 * plus a live read of the contract, so nothing here can disagree with the chain
 * for longer than one scan, and nothing requires a database to stay up.
 */

/** JSON cannot carry bigint: every bigint is stored as a decimal string. */
export interface StoredEvent {
  block: string;
  logIndex: number;
  tx: `0x${string}`;
  /** Unix seconds of the block that carried the log. */
  ts: number;
  name: string;
  args: Record<string, unknown>;
}

/** A refusal recovered from a reverted transaction (a refusal reverts, so it has no log). */
export interface RefusalRecord {
  intentHash: `0x${string}`;
  agent: Address;
  marketId: `0x${string}`;
  pool: Address;
  marketNonce: string;
  kind: number;
  orderType: number;
  price: string;
  quantity: string;
  agentNonce: string;
  refusal: number;
  tx: `0x${string}`;
  block: string;
  ts: number;
}

export const eventKey = (block: bigint | string, logIndex: number): string =>
  `ev:${block.toString().padStart(12, "0")}:${String(logIndex).padStart(6, "0")}`;

export function jsonSafe(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, jsonSafe(x)]));
  }
  return v;
}

/** Decode one raw log against the portfolio ABI. A log the ABI does not know is dropped. */
export function toStoredEvent(log: Log, ts: number): StoredEvent | null {
  if (log.blockNumber === null || log.logIndex === null || log.transactionHash === null) return null;
  try {
    const decoded = decodeEventLog({
      abi: airspacePortfolioAbi,
      data: log.data,
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      strict: false,
    });
    return {
      block: log.blockNumber.toString(),
      logIndex: log.logIndex,
      tx: log.transactionHash,
      ts,
      name: decoded.eventName as string,
      args: jsonSafe(decoded.args ?? {}) as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

const lower = (s: unknown): string => String(s).toLowerCase();
const iso = (ts: number): string => new Date(ts * 1000).toISOString();
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const byPosition = (a: StoredEvent, b: StoredEvent): number =>
  a.block === b.block ? a.logIndex - b.logIndex : BigInt(a.block) < BigInt(b.block) ? -1 : 1;

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export interface AgentFacts {
  address: Address;
  strategyId: string | null;
  registeredTx: string;
  registeredBlock: string;
}

/** Every address ever passed to `setAgent`, latest registration winning. `enabled` is read live by the caller. */
export function agentsFromEvents(events: StoredEvent[]): AgentFacts[] {
  const byAgent = new Map<string, AgentFacts>();
  for (const e of [...events].sort(byPosition)) {
    if (e.name !== "AgentSet") continue;
    const policy = e.args.policy as { strategyId?: string } | undefined;
    byAgent.set(lower(e.args.agent), {
      address: e.args.agent as Address,
      strategyId: policy?.strategyId ?? null,
      registeredTx: e.tx,
      registeredBlock: e.block,
    });
  }
  return [...byAgent.values()];
}

/** Domains this portfolio has ever configured, so a rolled series never hides an enforced ceiling. */
export function configuredDomainsFromEvents(events: StoredEvent[]): string[] {
  const state = new Map<string, boolean>();
  for (const e of [...events].sort(byPosition)) {
    if (e.name !== "DomainPolicySet") continue;
    const policy = e.args.policy as { configured?: boolean } | undefined;
    state.set(String(e.args.domain), Boolean(policy?.configured));
  }
  return [...state.entries()].filter(([, configured]) => configured).map(([d]) => d);
}

// ---------------------------------------------------------------------------
// Intents and receipts — row shapes match what the web app already consumes
// ---------------------------------------------------------------------------

export interface IntentRow {
  intent_hash: string;
  agent_address: string;
  market_id: string;
  domain_hash: string | null;
  kind: number;
  order_type: number;
  price: string;
  quantity: string;
  status: "ADMITTED" | "REFUSED";
  refusal_code: number | null;
  order_id: string | null;
  pool_address: string;
  market_nonce: number;
  tx_hash: string | null;
  block_number: number | null;
  created_at: string;
}

export interface ReceiptRow {
  intent_hash: string;
  decision: "ADMITTED" | "REFUSED";
  refusal_code: number | null;
  agent_address: string;
  market_id: string;
  domain_hash: string | null;
  global_policy_hash: string | null;
  agent_policy_hash: string | null;
  reserve_required: string | null;
  filled_qty: string | null;
  filled_cost: string | null;
  resting_qty: string | null;
  directional_before: string | null;
  directional_after: string | null;
  domain_usage_before: string | null;
  domain_usage_after: string | null;
  committed_after: string | null;
  tx_hash: string | null;
  block_number: number | null;
  provenance: Record<string, string>;
  created_at: string;
}

const newestFirst = (a: { block_number: number | null; logIndex: number }, b: { block_number: number | null; logIndex: number }) =>
  (b.block_number ?? 0) - (a.block_number ?? 0) || b.logIndex - a.logIndex;

export function intentsFromEvents(events: StoredEvent[], refusals: RefusalRecord[]): Array<IntentRow & { logIndex: number }> {
  const rows: Array<IntentRow & { logIndex: number }> = [];
  for (const e of events) {
    if (e.name !== "IntentAdmitted") continue;
    rows.push({
      intent_hash: String(e.args.intentHash),
      agent_address: lower(e.args.agent),
      market_id: String(e.args.marketId),
      domain_hash: String(e.args.domain),
      kind: Number(e.args.kind),
      // The event does not carry the order type; the indexer has always
      // recorded POST_ONLY here and the UI treats it as informational.
      order_type: 3,
      price: String(e.args.price),
      quantity: String(e.args.quantity),
      status: "ADMITTED",
      refusal_code: null,
      order_id: String(e.args.orderId),
      pool_address: lower(e.args.pool),
      market_nonce: Number(e.args.marketNonce),
      tx_hash: e.tx,
      block_number: Number(e.block),
      created_at: iso(e.ts),
      logIndex: e.logIndex,
    });
  }
  for (const r of refusals) {
    rows.push({
      intent_hash: r.intentHash,
      agent_address: lower(r.agent),
      market_id: r.marketId,
      domain_hash: null,
      kind: r.kind,
      order_type: r.orderType,
      price: r.price,
      quantity: r.quantity,
      status: "REFUSED",
      refusal_code: r.refusal,
      order_id: null,
      pool_address: lower(r.pool),
      market_nonce: Number(r.marketNonce),
      tx_hash: r.tx,
      block_number: Number(r.block),
      created_at: iso(r.ts),
      logIndex: 0,
    });
  }
  return rows.sort(newestFirst);
}

export function receiptsFromEvents(events: StoredEvent[], refusals: RefusalRecord[]): Array<ReceiptRow & { logIndex: number }> {
  const admitted = new Map<string, StoredEvent>();
  for (const e of events) if (e.name === "IntentAdmitted") admitted.set(String(e.args.intentHash), e);

  const rows: Array<ReceiptRow & { logIndex: number }> = [];
  for (const e of events) {
    if (e.name !== "IntentReconciled") continue;
    const a = admitted.get(String(e.args.intentHash));
    rows.push({
      intent_hash: String(e.args.intentHash),
      decision: "ADMITTED",
      refusal_code: null,
      agent_address: a ? lower(a.args.agent) : ZERO_ADDRESS,
      market_id: a ? String(a.args.marketId) : "0x",
      domain_hash: a ? String(a.args.domain) : null,
      global_policy_hash: null,
      agent_policy_hash: null,
      reserve_required: String(e.args.reserveRequired),
      filled_qty: String(e.args.filledQty),
      filled_cost: String(e.args.filledCost),
      resting_qty: String(e.args.restingQty),
      directional_before: String(e.args.directionalBefore),
      directional_after: String(e.args.directionalAfter),
      domain_usage_before: String(e.args.domainUsageBefore),
      domain_usage_after: String(e.args.domainUsageAfter),
      committed_after: String(e.args.committedAfter),
      tx_hash: e.tx,
      block_number: Number(e.block),
      // Every field above came out of one contract event. None was observed.
      provenance: {
        decision: "contract",
        filled_qty: "contract",
        resting_qty: "contract",
        domain_usage_after: "contract",
        committed_after: "contract",
      },
      created_at: iso(e.ts),
      logIndex: e.logIndex,
    });
  }
  for (const r of refusals) {
    rows.push({
      intent_hash: r.intentHash,
      decision: "REFUSED",
      refusal_code: r.refusal,
      agent_address: lower(r.agent),
      market_id: r.marketId,
      domain_hash: null,
      global_policy_hash: null,
      agent_policy_hash: null,
      reserve_required: null,
      filled_qty: null,
      filled_cost: null,
      resting_qty: null,
      directional_before: null,
      directional_after: null,
      domain_usage_before: null,
      domain_usage_after: null,
      committed_after: null,
      tx_hash: r.tx,
      block_number: Number(r.block),
      provenance: { decision: "contract", refusal_code: "contract" },
      created_at: iso(r.ts),
      logIndex: 0,
    });
  }
  return rows.sort(newestFirst);
}

// ---------------------------------------------------------------------------
// Reservations — event-derived base; the live overlay lives in portfolio-live.ts
// ---------------------------------------------------------------------------

export interface ReservationBase {
  order_key: string;
  intent_hash: string;
  agent_address: string;
  market_id: string;
  pool_address: string;
  market_nonce: number;
  order_id: string;
  domain_hash: string | null;
  kind: number;
  /** What the event history says is still open. The live overlay is authoritative. */
  qty_open: bigint;
  collateral_reserved: bigint;
  source_block: number;
  updated_ts: number;
}

/**
 * Reservations the way the contract itself accounts for them: a resting
 * quantity opened by `IntentReconciled`, reduced by every `ReservationReleased`
 * that names its order key.
 */
export function reservationsFromEvents(events: StoredEvent[]): ReservationBase[] {
  const admitted = new Map<string, StoredEvent>();
  for (const e of events) if (e.name === "IntentAdmitted") admitted.set(String(e.args.intentHash), e);

  const byKey = new Map<string, ReservationBase>();
  for (const e of [...events].sort(byPosition)) {
    if (e.name === "IntentReconciled") {
      const a = admitted.get(String(e.args.intentHash));
      if (!a) continue;
      const resting = BigInt(String(e.args.restingQty));
      const orderId = BigInt(String(a.args.orderId));
      if (resting === 0n || orderId === 0n) continue;
      const key = orderKey(a.args.pool as Address, BigInt(String(a.args.marketNonce)), orderId);
      byKey.set(key, {
        order_key: key,
        intent_hash: String(e.args.intentHash),
        agent_address: lower(a.args.agent),
        market_id: String(a.args.marketId),
        pool_address: lower(a.args.pool),
        market_nonce: Number(a.args.marketNonce),
        order_id: orderId.toString(),
        domain_hash: String(a.args.domain),
        kind: Number(a.args.kind),
        qty_open: resting,
        collateral_reserved: BigInt(String(e.args.reserveRequired)),
        source_block: Number(e.block),
        updated_ts: e.ts,
      });
    } else if (e.name === "ReservationReleased") {
      const r = byKey.get(String(e.args.orderKey));
      if (!r) continue;
      const q = BigInt(String(e.args.qtyReleased));
      const c = BigInt(String(e.args.collateralReleased));
      r.qty_open = r.qty_open > q ? r.qty_open - q : 0n;
      r.collateral_reserved = r.collateral_reserved > c ? r.collateral_reserved - c : 0n;
      r.source_block = Number(e.block);
      r.updated_ts = e.ts;
    }
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Positions — which markets the portfolio tracks
// ---------------------------------------------------------------------------

export interface TrackedMarket {
  market_id: string;
  domain_hash: string;
  pool_address: string;
  market_nonce: number;
  redeemed: boolean;
  source_block: number;
  updated_ts: number;
}

/** Markets the portfolio tracks, minus pruned ones. Balances are read live by the caller. */
export function trackedMarketsFromEvents(events: StoredEvent[]): TrackedMarket[] {
  const byId = new Map<string, TrackedMarket>();
  for (const e of [...events].sort(byPosition)) {
    const marketId = e.args.marketId === undefined ? undefined : String(e.args.marketId);
    if (!marketId) continue;
    if (e.name === "MarketTracked") {
      byId.set(marketId, {
        market_id: marketId,
        domain_hash: String(e.args.domain),
        pool_address: lower(e.args.pool),
        market_nonce: Number(e.args.marketNonce),
        redeemed: false,
        source_block: Number(e.block),
        updated_ts: e.ts,
      });
      continue;
    }
    const m = byId.get(marketId);
    if (!m) continue;
    if (e.name === "MarketPruned") byId.delete(marketId);
    else if (e.name === "Redeemed") m.redeemed = true;
    if (["Redeemed", "SettledExposureReleased", "IntentAdmitted", "IntentReconciled", "ReservationReleased"].includes(e.name)) {
      m.source_block = Number(e.block);
      m.updated_ts = e.ts;
    }
  }
  return [...byId.values()].sort((a, b) => b.source_block - a.source_block);
}

export const isoOf = iso;
