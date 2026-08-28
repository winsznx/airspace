import type { Address } from "@airspace/types";

/**
 * Indexer bindings.
 *
 * The indexer is the only component holding a service-role key AND writing
 * projections. It never accepts a value from a client: everything it writes is
 * derived from a chain log it read itself.
 */
export interface Env {
  CHAIN_ID: string;
  SHANNON_RPC: string;
  SHANNON_RPC_FALLBACK: string;
  AIRSPACE_FACTORY: string;
  SUPABASE_URL: string;
  /** Blocks scanned per invocation. Bounded so one run cannot exceed CPU time. */
  INGEST_WINDOW?: string;

  SUPABASE_SERVICE_ROLE_KEY: string;
  /** Shared secret for the manual /ingest trigger. Absent disables the route. */
  INDEXER_TOKEN?: string;
}

export const chainId = (env: Env): number => Number(env.CHAIN_ID ?? 50312);

export const factoryAddress = (env: Env): Address => {
  const a = env.AIRSPACE_FACTORY;
  if (!a || !/^0x[0-9a-fA-F]{40}$/.test(a)) {
    throw new Error("AIRSPACE_FACTORY is not configured on this Worker");
  }
  return a.toLowerCase() as Address;
};

export const ingestWindow = (env: Env): bigint => {
  const n = Number(env.INGEST_WINDOW ?? 5000);
  return BigInt(Number.isFinite(n) && n > 0 ? Math.min(n, 20_000) : 5000);
};
