import type { PublicClient } from "viem";
import { binaryPoolAbi, outcomeId } from "@airspace/protocol";
import { airspacePortfolioAbi, DREAMDEX, erc6909Abi } from "@airspace/sdk";
import { domainRiskUsage as independentDomainRiskUsage, type MarketPosition } from "@airspace/risk";
import type { Address, MarketId } from "@airspace/types";
import {
  isoOf,
  type ReservationBase,
  type StoredEvent,
  type TrackedMarket,
} from "./portfolio-log.js";

/**
 * Live overlays: the parts of a row that must come from the contract, not from
 * event arithmetic.
 *
 * Events say what happened. They cannot say what is true now: `getOrder` reverts
 * identically for a filled order and a cancelled one, so a resting quantity kept
 * by counting fills would drift. Every figure a decision could rest on is
 * therefore re-read here, from the same mappings the contract itself acts on.
 */

/** Runs `fn` over `items` with a bounded number in flight, preserving order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

const LIVE_CONCURRENCY = 8;

export type ReservationState = "RESTING" | "NEEDS_RECONCILIATION" | "FINALIZED";

export interface ReservationRow {
  order_key: string;
  intent_hash: string | null;
  agent_address: string;
  market_id: string;
  pool_address: string;
  market_nonce: number;
  domain_hash: string | null;
  kind: number;
  qty_open: string;
  collateral_reserved: string;
  state: ReservationState;
  /** What a permissionless `releaseOrder` would free right now. */
  releasable: string;
  source_block: number;
  updated_at: string;
}

type OrderRecTuple = readonly [Address, `0x${string}`, Address, bigint, bigint, number, bigint, bigint];

/**
 * The contract's own view of a reservation, and the venue's view of the order,
 * combined the same way `releaseOrder` combines them:
 *
 *   still open = 0            if the pool has recycled to a newer market
 *              = quantityRemaining of the live order otherwise (0 if getOrder reverts)
 *   releasable = qtyOpen - still open
 */
export async function overlayReservation(
  client: PublicClient,
  portfolio: Address,
  base: ReservationBase,
): Promise<ReservationRow> {
  const rec = (await client.readContract({
    address: portfolio,
    abi: airspacePortfolioAbi,
    functionName: "orderRec",
    args: [base.order_key as `0x${string}`],
  })) as unknown as OrderRecTuple;

  const qtyOpen = rec[6];
  const collReserved = rec[7];

  let state: ReservationState = "FINALIZED";
  let releasable = 0n;
  if (qtyOpen > 0n) {
    const pool = base.pool_address as Address;
    const liveNonce = (await client
      .readContract({ address: pool, abi: binaryPoolAbi, functionName: "marketNonce" })
      .catch(() => null)) as bigint | null;

    let stillOpen = 0n;
    if (liveNonce !== null && liveNonce === BigInt(base.market_nonce)) {
      const order = (await client
        .readContract({
          address: pool,
          abi: binaryPoolAbi,
          functionName: "getOrder",
          args: [BigInt(base.order_id)],
        })
        .catch(() => null)) as { quantityRemaining: bigint } | null;
      stillOpen = order?.quantityRemaining ?? 0n;
    }
    releasable = qtyOpen > stillOpen ? qtyOpen - stillOpen : 0n;
    state = releasable > 0n ? "NEEDS_RECONCILIATION" : "RESTING";
  }

  return {
    order_key: base.order_key,
    intent_hash: base.intent_hash,
    agent_address: base.agent_address,
    market_id: base.market_id,
    pool_address: base.pool_address,
    market_nonce: base.market_nonce,
    domain_hash: base.domain_hash,
    kind: base.kind,
    qty_open: qtyOpen.toString(),
    collateral_reserved: collReserved.toString(),
    state,
    releasable: releasable.toString(),
    source_block: base.source_block,
    updated_at: isoOf(base.updated_ts),
  };
}

export interface PositionRow {
  market_id: string;
  domain_hash: string | null;
  yes_balance: string;
  no_balance: string;
  directional_exposure: string;
  settled: boolean;
  redeemed: boolean;
  source_block: number;
  updated_at: string;
}

type MarketStateTuple = readonly [Address, bigint, `0x${string}`, bigint, bigint, bigint, bigint, boolean, boolean];

/**
 * Realized holdings, read from the ERC-6909 outcome token itself — never from
 * `marketState`'s reservation counters, which are a different quantity (open
 * BUY/SELL size, not what is held).
 */
export async function overlayPosition(client: PublicClient, portfolio: Address, m: TrackedMarket): Promise<PositionRow> {
  const state = (await client.readContract({
    address: portfolio,
    abi: airspacePortfolioAbi,
    functionName: "marketState",
    args: [m.market_id as MarketId],
  })) as unknown as MarketStateTuple;
  const [pool, marketNonce, , , , , , tracked, settled] = state;

  let yes = 0n;
  let no = 0n;
  if (tracked) {
    const yesId = outcomeId(pool, marketNonce, 0);
    [yes, no] = await Promise.all([
      client.readContract({ address: DREAMDEX.outcomeToken, abi: erc6909Abi, functionName: "balanceOf", args: [portfolio, yesId] }) as Promise<bigint>,
      client.readContract({ address: DREAMDEX.outcomeToken, abi: erc6909Abi, functionName: "balanceOf", args: [portfolio, yesId + 1n] }) as Promise<bigint>,
    ]);
  }

  return {
    market_id: m.market_id,
    domain_hash: m.domain_hash,
    yes_balance: yes.toString(),
    no_balance: no.toString(),
    // Matches the contract's marketDirectionalExposure: realized-only, zero once settled.
    directional_exposure: (settled ? 0n : yes - no).toString(),
    settled,
    redeemed: m.redeemed,
    source_block: m.source_block,
    updated_at: isoOf(m.updated_ts),
  };
}

// ---------------------------------------------------------------------------
// Reconciliation — everything below is measured, none of it queued
// ---------------------------------------------------------------------------

const RESERVATION_FIELD = ["yesLong", "yesShort", "noLong", "noShort"] as const;

export function reconstructDomainWorstCase(
  positions: Array<{ market_id: string; yes_balance: string; no_balance: string; settled: boolean }>,
  reservations: Array<{ market_id: string; kind: number; qty_open: string }>,
): bigint {
  const byMarket = new Map<string, MarketPosition>();
  const get = (marketId: string): MarketPosition => {
    let m = byMarket.get(marketId);
    if (!m) {
      m = { marketId: marketId as MarketId, yesBalance: 0n, noBalance: 0n, yesLong: 0n, yesShort: 0n, noLong: 0n, noShort: 0n, settled: false };
      byMarket.set(marketId, m);
    }
    return m;
  };
  for (const p of positions) {
    const m = get(p.market_id);
    m.yesBalance = BigInt(p.yes_balance);
    m.noBalance = BigInt(p.no_balance);
    m.settled = p.settled;
  }
  for (const r of reservations) {
    const m = get(r.market_id);
    const field = RESERVATION_FIELD[r.kind];
    if (field) m[field] += BigInt(r.qty_open);
  }
  return independentDomainRiskUsage([...byMarket.values()]);
}

export interface ReconciliationSummary {
  domain: string;
  pendingReleaseCount: number;
  pendingReleaseAmount: string;
  oldestPendingReleaseAgeSec: number | null;
  lastReconciledAt: string | null;
  marketsTracked: number;
  marketsCap: number;
  independentWorstCase: string;
}

/**
 * One domain's reconciliation truth, measured live.
 *
 * `independentWorstCase` is rebuilt from the outcome token's own balances and
 * the contract's own `orderRec` reservations, then run through
 * `@airspace/risk` — a separate implementation from the Solidity
 * `domainRiskUsage`. It shares no counter with the contract's summary number.
 */
export async function summariseDomain(
  client: PublicClient,
  portfolio: Address,
  domain: string,
  events: StoredEvent[],
  reservations: ReservationBase[],
  markets: TrackedMarket[],
  cap: number,
): Promise<ReconciliationSummary> {
  const inDomain = markets.filter((m) => m.domain_hash === domain);
  const openBases = reservations.filter((r) => r.domain_hash === domain && r.qty_open > 0n);

  const [rows, positions] = await Promise.all([
    mapLimit(openBases, LIVE_CONCURRENCY, (b) => overlayReservation(client, portfolio, b)),
    mapLimit(inDomain, LIVE_CONCURRENCY, (m) => overlayPosition(client, portfolio, m)),
  ]);

  const open = rows.filter((r) => r.state !== "FINALIZED");
  const pending = open.filter((r) => r.state === "NEEDS_RECONCILIATION");
  const pendingAmount = pending.reduce((a, r) => a + BigInt(r.releasable), 0n);
  const oldestMs = pending.length ? Math.min(...pending.map((r) => new Date(r.updated_at).getTime())) : null;

  let lastReleaseTs: number | null = null;
  const domainKeys = new Set(reservations.filter((r) => r.domain_hash === domain).map((r) => r.order_key));
  for (const e of events) {
    if (e.name === "ReservationReleased" && domainKeys.has(String(e.args.orderKey))) {
      if (lastReleaseTs === null || e.ts > lastReleaseTs) lastReleaseTs = e.ts;
    }
  }

  return {
    domain,
    pendingReleaseCount: pending.length,
    pendingReleaseAmount: pendingAmount.toString(),
    oldestPendingReleaseAgeSec: oldestMs !== null ? Math.max(0, Math.floor((Date.now() - oldestMs) / 1000)) : null,
    lastReconciledAt: lastReleaseTs !== null ? isoOf(lastReleaseTs) : null,
    marketsTracked: inDomain.length,
    marketsCap: cap,
    independentWorstCase: reconstructDomainWorstCase(positions, open).toString(),
  };
}
