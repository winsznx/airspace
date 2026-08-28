import { CANONICAL_CADENCES } from "@airspace/types";

/**
 * Canonical series cadence — an exact TypeScript mirror of
 * `contracts/src/libraries/Cadence.sol`.
 *
 *   cadence = the SMALLEST canonical C with C >= (expiry - tradingStart)
 *             AND expiry % C == 0;  0 when none matches.
 *
 * Raw `expiry - tradingStart` is NOT safe: scanning 1,200 consecutive live
 * Shannon markets found genuine 898-second markets on a 900-second series.
 * Keyed raw they would form their own unenforced domain.
 *
 * This function is advisory. The portfolio contract derives the domain itself
 * during execution; this mirror exists so the UI can classify markets and the
 * SDK can pre-flight, never to authorise anything.
 */
export function canonicalCadence(tradingStart: bigint, expiry: bigint): number {
  if (expiry <= tradingStart) return 0;
  const window = expiry - tradingStart;
  for (const c of CANONICAL_CADENCES) {
    const C = BigInt(c);
    if (C >= window && expiry % C === 0n) return c;
  }
  return 0;
}

/**
 * ERC-6909 outcome id: `(uint160(pool) << 72) | (nonce << 8) | idx`.
 * Successive markets on one recycled pool occupy disjoint id ranges, which is
 * why a pool address alone is never a market identity.
 */
export function outcomeId(pool: `0x${string}`, marketNonce: bigint, idx: 0 | 1): bigint {
  return (BigInt(pool) << 72n) | (marketNonce << 8n) | BigInt(idx);
}

export function decodeOutcomeId(id: bigint): { pool: `0x${string}`; nonce: bigint; idx: number } {
  return {
    pool: `0x${(id >> 72n).toString(16).padStart(40, "0")}` as `0x${string}`,
    nonce: (id >> 8n) & 0xffffffffffffffffn,
    idx: Number(id & 0xffn),
  };
}
