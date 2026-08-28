/**
 * @airspace/db — typed Supabase access.
 *
 * Supabase is NOT the enforcement authority (PRD 25). Everything here is a
 * projection of chain state that can be rebuilt by replaying events, and no
 * value read from this database may authorise an execution decision.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export * from "./schema.js";

/** A read-only client for the browser. The anon key can only read public projections. */
export function createPublicDb(url: string, anonKey: string): SupabaseClient {
  return createClient(url, anonKey, {
    auth: { persistSession: false },
    global: { headers: { "x-airspace-client": "public" } },
  });
}

/**
 * A service-role client for workers. Bypasses RLS, so it must NEVER reach a
 * browser bundle or a public API response.
 */
export function createServiceDb(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-airspace-client": "service" } },
  });
}

/** Convert a `numeric(78,0)` column to a bigint. Never use `Number()` here. */
export const toBigInt = (v: string | number | null | undefined): bigint =>
  v === null || v === undefined ? 0n : BigInt(typeof v === "number" ? Math.trunc(v) : v);

/** Convert a bigint to the decimal string a `numeric(78,0)` column expects. */
export const fromBigInt = (v: bigint): string => v.toString();
