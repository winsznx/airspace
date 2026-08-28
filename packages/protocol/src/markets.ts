import type { PublicClient } from "viem";
import { keccak256, encodeAbiParameters } from "viem";
import type { Address, DomainId, Market, MarketId } from "@airspace/types";
import { binaryModuleAbi, binaryPoolAbi, binaryMarketAbi } from "./abis.js";
import { DREAMDEX } from "./addresses.js";
import { canonicalCadence } from "./cadence.js";

/**
 * Market resolution against authoritative on-chain state.
 *
 * The indexer may shortlist markets for discovery, but it never authorises
 * anything: during hostile validation it served `Trading` for markets that had
 * expired five weeks earlier (PRD 8.3). Everything here reads the chain.
 */

/** `keccak256(creator, collateral, canonicalCadence)` — a cadence domain, not an asset. */
export function domainKey(creator: Address, collateral: Address, cadenceSec: number): DomainId {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint32" }],
      [creator, collateral, cadenceSec],
    ),
  ) as DomainId;
}

export async function readMarket(client: PublicClient, marketId: MarketId): Promise<Market | null> {
  const r = await client.readContract({
    address: DREAMDEX.binaryModule,
    abi: binaryModuleAbi,
    functionName: "markets",
    args: [marketId],
  });
  const [, , , collateral, , , , creator, marketAddress, pool, yesId, noId, tradingStart, expiry] = r;
  if (pool === "0x0000000000000000000000000000000000000000") return null;

  const marketNonce = await client.readContract({
    address: pool,
    abi: binaryPoolAbi,
    functionName: "marketNonce",
  });

  const cadenceSec = canonicalCadence(tradingStart, expiry);
  return {
    marketId,
    pool,
    marketAddress,
    marketNonce,
    creator,
    collateral,
    tradingStart,
    expiry,
    yesId,
    noId,
    cadenceSec,
    domain: cadenceSec === 0 ? null : domainKey(creator, collateral, cadenceSec),
  };
}

export interface LiveState {
  finalized: boolean;
  resolved: boolean;
  voided: boolean;
  /** Composed exactly as the contract composes it. */
  trading: boolean;
  secondsRemaining: number;
  tickSize: bigint;
  lotSize: bigint;
  minQuantity: bigint;
  marketExpiryNs: bigint;
}

/**
 * Authoritative Trading state, composed from four on-chain reads plus the clock.
 * This mirrors the contract's own gate so a UI can show the same answer, but the
 * contract still decides at execution time.
 */
export async function readLiveState(client: PublicClient, m: Market, nowSec?: number): Promise<LiveState> {
  const [finalized, resolved, voided, grid, marketExpiryNs] = await Promise.all([
    client.readContract({ address: m.pool, abi: binaryPoolAbi, functionName: "finalized" }),
    client.readContract({ address: m.marketAddress, abi: binaryMarketAbi, functionName: "isResolved" }),
    client.readContract({ address: m.marketAddress, abi: binaryMarketAbi, functionName: "isVoided" }),
    client.readContract({ address: m.pool, abi: binaryPoolAbi, functionName: "getOrderBookParameters" }),
    client.readContract({ address: m.pool, abi: binaryPoolAbi, functionName: "marketExpiryNs" }),
  ]);
  const now = BigInt(nowSec ?? Math.floor(Date.now() / 1000));
  const trading = !finalized && !resolved && !voided && now >= m.tradingStart && now < m.expiry;
  return {
    finalized,
    resolved,
    voided,
    trading,
    secondsRemaining: Number(m.expiry > now ? m.expiry - now : 0n),
    tickSize: grid.tickSize,
    lotSize: grid.lotSize,
    minQuantity: grid.minQuantity,
    marketExpiryNs,
  };
}

export interface BookLevel {
  price: bigint;
  quantity: bigint;
}

export async function readBook(client: PublicClient, pool: Address, depth = 5) {
  const [bids, asks] = await Promise.all([
    client.readContract({ address: pool, abi: binaryPoolAbi, functionName: "getBookLevels", args: [true, BigInt(depth)] }),
    client.readContract({ address: pool, abi: binaryPoolAbi, functionName: "getBookLevels", args: [false, BigInt(depth)] }),
  ]);
  return { bids: bids as readonly BookLevel[], asks: asks as readonly BookLevel[] };
}

/**
 * Enumerate live markets straight from the module registry.
 *
 * `marketId` is a sequential counter, so the top can be found by binary search
 * and recent markets walked backwards. This deliberately needs NO indexer — the
 * discovery path stays usable when the indexer is stale or down.
 */
export async function discoverMarkets(
  client: PublicClient,
  opts: { lookback?: number; minSecondsRemaining?: number; nowSec?: number } = {},
): Promise<Market[]> {
  const lookback = opts.lookback ?? 200;
  const minRemaining = opts.minSecondsRemaining ?? 0;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);

  const exists = async (id: bigint) => {
    try {
      const r = await client.readContract({
        address: DREAMDEX.binaryModule,
        abi: binaryModuleAbi,
        functionName: "markets",
        args: [`0x${id.toString(16).padStart(64, "0")}` as MarketId],
      });
      return r[9] !== "0x0000000000000000000000000000000000000000";
    } catch {
      return false;
    }
  };

  let lo = 0x1000n;
  let hi = 0x1000n;
  while (await exists(hi)) {
    lo = hi;
    hi *= 2n;
    if (hi > 0x400000n) break;
  }
  while (lo + 1n < hi) {
    const mid = (lo + hi) / 2n;
    if (await exists(mid)) lo = mid;
    else hi = mid;
  }

  const ids: MarketId[] = [];
  for (let i = 0n; i < BigInt(lookback) && lo - i > 0n; i++) {
    ids.push(`0x${(lo - i).toString(16).padStart(64, "0")}` as MarketId);
  }

  const out: Market[] = [];
  const CONC = 20;
  for (let i = 0; i < ids.length; i += CONC) {
    const batch = await Promise.all(ids.slice(i, i + CONC).map((id) => readMarket(client, id).catch(() => null)));
    for (const m of batch) {
      if (!m) continue;
      if (Number(m.expiry) - now < minRemaining) continue;
      out.push(m);
    }
  }
  return out;
}
