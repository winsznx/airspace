import { createPublicClient, http, fallback, type Log, type PublicClient } from "viem";
import type { Address } from "@airspace/types";
import { assertCurrentImplementation, SupersededDeploymentError } from "@airspace/sdk";
import type { Env } from "./env.js";
import { chainId, factoryAddress } from "./env.js";

/**
 * Somnia chain access with transport failover.
 *
 * IMPORTANT: failover is for TRANSPORT failure only. A deterministic EVM revert
 * is an answer, not an outage, and must never be retried against another
 * provider as though it might succeed there (PRD 32.1). viem's `fallback`
 * transport only rotates on transport-level errors, which is exactly the
 * behaviour we want; `retryCount: 0` on each leg keeps a revert from being
 * re-sent to the same node.
 */

export const somniaShannon = {
  id: 50312,
  name: "Somnia Shannon",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://dream-rpc.somnia.network"] } },
  blockExplorers: {
    default: { name: "Shannon Explorer", url: "https://shannon-explorer.somnia.network" },
  },
} as const;

export const somniaMainnet = {
  id: 5031,
  name: "Somnia",
  nativeCurrency: { name: "Somnia", symbol: "SOMI", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.infra.mainnet.somnia.network"] } },
  blockExplorers: { default: { name: "Somnia Explorer", url: "https://explorer.somnia.network" } },
} as const;

export function publicClient(env: Env): PublicClient {
  const urls = [env.SHANNON_RPC, env.SHANNON_RPC_FALLBACK].filter(
    (u): u is string => typeof u === "string" && u.length > 0,
  );
  if (urls.length === 0) throw new Error("no RPC endpoint configured");

  const chain = Number(env.CHAIN_ID) === 5031 ? somniaMainnet : somniaShannon;
  return createPublicClient({
    chain,
    transport: fallback(
      urls.map((url) => http(url, { retryCount: 0, timeout: 10_000 })),
      { rank: false },
    ),
    batch: { multicall: false },
  }) as PublicClient;
}

/** True when an error is a transport failure rather than a contract answer. */
export function isTransportError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  if (/execution reverted|revert|Refused|custom error/i.test(msg)) return false;
  return /fetch|network|timeout|ECONN|socket|5\d\d|HTTP request failed/i.test(msg);
}

/**
 * Fail LOUDLY, once per isolate, if this Worker is configured against a
 * superseded and unsafe AIRSPACE implementation.
 *
 * A factory's implementation is immutable — no proxy, no upgrade authority —
 * so a single verified check is valid for the isolate's whole lifetime. The
 * verdict itself is cached forever within the isolate: a confirmed superseded
 * deployment should keep failing every request, cheaply, rather than being
 * re-verified. A TRANSPORT failure during the check is not a verdict and is
 * not cached, so the next request tries again.
 */
const verifiedFactories = new Map<string, Promise<Address>>();

export function verifiedFactory(env: Env): Promise<Address> {
  const factory = factoryAddress(env);
  const cid = chainId(env);
  const key = `${cid}:${factory}`;
  let pending = verifiedFactories.get(key);
  if (!pending) {
    pending = assertCurrentImplementation(publicClient(env), factory, cid).then(() => factory);
    pending.catch((e) => {
      if (!(e instanceof SupersededDeploymentError)) verifiedFactories.delete(key);
    });
    verifiedFactories.set(key, pending);
  }
  return pending;
}

// ---------------------------------------------------------------------------
// Portfolio log scanning — chain, not the indexer
// ---------------------------------------------------------------------------

/**
 * No AIRSPACE portfolio can exist before its factory did. Bounding the
 * deployment-block search here rather than at block 0 turns ~30 sequential
 * `eth_getCode` probes into ~24 — and a wrong (too-early) bound only means a
 * few wasted probes, never a missed portfolio.
 */
const FACTORY_DEPLOYED_AT_BLOCK = 473_593_665n;

const deploymentBlocks = new Map<string, Promise<bigint>>();

/**
 * Binary-search the block a contract's code first appears at.
 *
 * Used instead of trusting any off-chain "created at" record, because that
 * record is exactly what an indexer outage makes unavailable — `eth_getCode`
 * is a plain state read every RPC serves.
 */
export async function findDeploymentBlock(client: PublicClient, address: Address): Promise<bigint> {
  const key = `${client.chain?.id}:${address.toLowerCase()}`;
  let pending = deploymentBlocks.get(key);
  if (pending) return pending;

  pending = (async () => {
    const hasCode = async (block: bigint) => {
      const code = await client.getCode({ address, blockNumber: block });
      return Boolean(code) && code !== "0x";
    };
    const latest = await client.getBlockNumber();
    let lo = FACTORY_DEPLOYED_AT_BLOCK;
    let hi = latest;
    if (!(await hasCode(hi))) throw new Error("portfolio has no code at the latest block");
    while (lo + 1n < hi) {
      const mid = (lo + hi) / 2n;
      if (await hasCode(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  })();
  deploymentBlocks.set(key, pending);
  pending.catch(() => deploymentBlocks.delete(key));
  return pending;
}

export interface LogScan {
  logs: Log[];
  /** The last block of the contiguous range that was scanned successfully. */
  scannedThrough: bigint;
  /** True once `scannedThrough` has reached the chain head this scan saw. */
  complete: boolean;
}

/**
 * How many 1000-block `eth_getLogs` windows one call may cover.
 *
 * A scan from a portfolio's deployment block grows with the chain's height,
 * not with anything about the portfolio: days later that range is millions of
 * blocks. Capping the windows per call keeps every call fast and bounded; the
 * caller persists `scannedThrough` and resumes, so the full history still
 * arrives, spread across a few calls instead of one that times out.
 */
const MAX_CHUNKS_PER_CALL = 320;
const CHUNK = 999n; // Shannon's public RPC caps eth_getLogs ranges at 1000 blocks.
const CONCURRENCY = 32;

/**
 * Every log a portfolio emitted between `fromBlock` and the head, or as far
 * as one bounded call reaches.
 *
 * A window that fails is NEVER skipped over. `scannedThrough` stops at the end
 * of the last window before the first failure, so the next call retries it —
 * silently advancing past a failed window would drop events permanently.
 */
export async function scanPortfolioLogs(
  client: PublicClient,
  portfolio: Address,
  fromBlock: bigint,
): Promise<LogScan> {
  const latest = await client.getBlockNumber();
  if (fromBlock > latest) return { logs: [], scannedThrough: latest, complete: true };

  const ranges: Array<[bigint, bigint]> = [];
  for (let b = fromBlock; b <= latest && ranges.length < MAX_CHUNKS_PER_CALL; b += CHUNK + 1n) {
    ranges.push([b, b + CHUNK > latest ? latest : b + CHUNK]);
  }

  const logs: Log[] = [];
  let scannedThrough = fromBlock - 1n;
  for (let i = 0; i < ranges.length; i += CONCURRENCY) {
    const batch = ranges.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(([from, to]) => client.getLogs({ address: portfolio, fromBlock: from, toBlock: to })),
    );
    let failed = false;
    for (let j = 0; j < settled.length; j++) {
      const r = settled[j]!;
      if (r.status === "rejected") {
        failed = true;
        break;
      }
      logs.push(...r.value);
      scannedThrough = batch[j]![1];
    }
    if (failed) return { logs, scannedThrough, complete: false };
  }
  return { logs, scannedThrough, complete: scannedThrough >= latest };
}
