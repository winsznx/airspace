import type { Address } from "@airspace/types";

/**
 * Worker bindings and configuration.
 *
 * Every secret arrives as a Worker secret (`wrangler secret put`), never from
 * the repository and never from a client. `SUPABASE_SERVICE_ROLE_KEY` in
 * particular must never reach a browser bundle or an API response body.
 */
export interface Env {
  // --- vars (public) ---
  CHAIN_ID: string;
  SHANNON_RPC: string;
  SHANNON_RPC_FALLBACK: string;
  AIRSPACE_FACTORY: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;

  // --- secrets ---
  SUPABASE_SERVICE_ROLE_KEY: string;

  // --- bindings ---
  PORTFOLIO: DurableObjectNamespace;
  RECONCILE_QUEUE?: Queue<ReconcileJob>;
  ASSETS?: Fetcher;
}

/** A unit of lifecycle work. Every kind must be idempotent. */
export interface ReconcileJob {
  kind: "release-order" | "release-settled" | "prune-market" | "sync-portfolio" | "sync-positions";
  chainId: number;
  portfolio: Address;
  marketId?: `0x${string}`;
  orderKey?: `0x${string}`;
  reason?: string;
  attempt?: number;
}

export const chainId = (env: Env): number => Number(env.CHAIN_ID ?? 50312);

export const factoryAddress = (env: Env): Address => {
  const a = env.AIRSPACE_FACTORY;
  if (!a || !/^0x[0-9a-fA-F]{40}$/.test(a)) {
    throw new Error("AIRSPACE_FACTORY is not configured on this Worker");
  }
  return a.toLowerCase() as Address;
};
