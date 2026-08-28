import { createPublicClient, http, fallback, type PublicClient } from "viem";
import type { Env } from "./env.js";

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
