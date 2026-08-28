import { describe, expect, it } from "vitest";
import { canonicalCadence, decodeOutcomeId, outcomeId } from "../src/cadence.js";

describe("canonical cadence (mirror of Cadence.sol)", () => {
  it("resolves exact windows to themselves", () => {
    expect(canonicalCadence(1787842740n, 1787842800n)).toBe(60);
    expect(canonicalCadence(1787841900n, 1787842800n)).toBe(900);
    expect(canonicalCadence(1787832000n, 1787846400n)).toBe(14400);
    expect(canonicalCadence(1787788800n, 1787875200n)).toBe(86400);
  });

  it("absorbs the live 898-second late roll into its 900-second series", () => {
    const ex = 1787842800n;
    expect(canonicalCadence(ex - 898n, ex)).toBe(900);
    expect(canonicalCadence(ex - 899n, ex)).toBe(900);
  });

  it("never promotes a short market into a longer domain", () => {
    const ex = 1787842800n; // divisible by 60, 300, 900, 3600
    expect(canonicalCadence(ex - 60n, ex)).toBe(60);
    expect(canonicalCadence(ex - 300n, ex)).toBe(300);
  });

  it("fails closed on an unrecognised window", () => {
    expect(canonicalCadence(0n, 200_000n)).toBe(0);
    expect(canonicalCadence(200n, 100n)).toBe(0);
  });
});

describe("outcome ids", () => {
  it("encodes (pool, generation, side) and round-trips", () => {
    const pool = "0xc09e4a5bdee2899962727125fb5eaeb896798e46" as const;
    const id = outcomeId(pool, 101n, 0);
    const d = decodeOutcomeId(id);
    expect(d.pool).toBe(pool);
    expect(d.nonce).toBe(101n);
    expect(d.idx).toBe(0);
    // Successive generations on ONE recycled pool get disjoint ids.
    expect(outcomeId(pool, 102n, 0)).not.toBe(id);
    expect(outcomeId(pool, 101n, 1)).toBe(id + 1n);
  });
});
