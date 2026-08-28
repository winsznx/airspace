import { createPublicClient, fallback, http, type Chain, type PublicClient } from "viem";
import type { Env } from "./index.js";

export const shannon = {
  id: 50312,
  name: "Somnia Shannon",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://dream-rpc.somnia.network"] } },
  blockExplorers: { default: { name: "Shannon Explorer", url: "https://shannon-explorer.somnia.network" } },
} as const satisfies Chain;

export const somnia = {
  id: 5031,
  name: "Somnia",
  nativeCurrency: { name: "Somnia", symbol: "SOMI", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.infra.mainnet.somnia.network"] } },
  blockExplorers: { default: { name: "Somnia Explorer", url: "https://explorer.somnia.network" } },
} as const satisfies Chain;

export const somniaChain = (env: Env): Chain => (Number(env.CHAIN_ID) === 5031 ? somnia : shannon);

/**
 * Failover is for TRANSPORT failure only. A revert is the contract's answer and
 * must never be retried against another provider as though it might succeed
 * there; `retryCount: 0` keeps a revert from being re-sent to the same node.
 */
export function publicClient(env: Env): PublicClient {
  const urls = [env.SHANNON_RPC, env.SHANNON_RPC_FALLBACK].filter(
    (u): u is string => typeof u === "string" && u.length > 0,
  );
  if (urls.length === 0) throw new Error("no RPC endpoint configured");

  return createPublicClient({
    chain: somniaChain(env),
    transport: fallback(
      urls.map((url) => http(url, { retryCount: 0, timeout: 10_000 })),
      { rank: false },
    ),
    batch: { multicall: false },
  }) as PublicClient;
}
