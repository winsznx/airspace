import { describe, expect, it } from "vitest";
import { intentHash, orderKey, type IntentStruct } from "./keys.js";

/**
 * The other half of a cross-language check.
 *
 * `contracts/test/unit/KeyMirror.t.sol` asserts the SAME vectors against the
 * exact expressions the contract uses. Neither side can drift without turning
 * one of the two suites red — which matters because a drifted mirror does not
 * throw, it just silently stops finding rows.
 */

const PORTFOLIO = "0x8CBA6655d29c4e72391040A90B15902b4f6fc220" as const;
const AGENT = "0x551051f987b011329F29E8c069D8cb6ff2C2b084" as const;
const POOL = "0x54D90260Fe949940A80602E7fDa8ebD729c5BE00" as const;
const CHAIN_ID = 50312;

const INTENT: IntentStruct = {
  marketId: "0x000000000000000000000000000000000000000000000000000000000000bd32",
  pool: POOL,
  marketNonce: 99n,
  kind: 0,
  price: 550_000n,
  quantity: 180_000_000n,
  expireTimestampNs: 1_787_900_000_000_000_000n,
  orderType: 3,
  nonce: 7n,
  strategyVersion: "0x1111111111111111111111111111111111111111111111111111111111111111",
};

describe("intentHash", () => {
  it("matches the Solidity vector", () => {
    expect(intentHash(PORTFOLIO, CHAIN_ID, AGENT, INTENT)).toBe(
      "0xa38101919795151707438d21645fd5e6ea0112c55da37c028f74c5c728132c15",
    );
  });

  it("binds the portfolio, so an intent cannot be replayed onto another one", () => {
    const other = intentHash("0x0000000000000000000000000000000000000001", CHAIN_ID, AGENT, INTENT);
    expect(other).not.toBe(intentHash(PORTFOLIO, CHAIN_ID, AGENT, INTENT));
  });

  it("binds the chain id", () => {
    expect(intentHash(PORTFOLIO, 5031, AGENT, INTENT)).not.toBe(intentHash(PORTFOLIO, CHAIN_ID, AGENT, INTENT));
  });

  it("binds the agent", () => {
    const other = intentHash(PORTFOLIO, CHAIN_ID, "0x0000000000000000000000000000000000000002", INTENT);
    expect(other).not.toBe(intentHash(PORTFOLIO, CHAIN_ID, AGENT, INTENT));
  });

  it("changes when any intent field changes", () => {
    const base = intentHash(PORTFOLIO, CHAIN_ID, AGENT, INTENT);
    const mutated: Array<Partial<IntentStruct>> = [
      { marketId: "0x000000000000000000000000000000000000000000000000000000000000bd33" },
      { pool: "0x0000000000000000000000000000000000000003" },
      { marketNonce: 100n },
      { kind: 2 },
      { price: 550_001n },
      { quantity: 180_000_001n },
      { expireTimestampNs: 1_787_900_000_000_000_001n },
      { orderType: 0 },
      { nonce: 8n },
      { strategyVersion: `0x${"22".repeat(32)}` },
    ];
    for (const m of mutated) {
      expect(intentHash(PORTFOLIO, CHAIN_ID, AGENT, { ...INTENT, ...m })).not.toBe(base);
    }
  });
});

describe("orderKey", () => {
  it("matches the Solidity vector", () => {
    expect(orderKey(POOL, 99n, 4242n)).toBe("0x47183674f012b0b0ea2c79dd042afad0c0be4705471309b26d2dc24591cde677");
  });

  it("binds the market generation, because DreamDEX recycles pool addresses", () => {
    expect(orderKey(POOL, 99n, 4242n)).not.toBe(orderKey(POOL, 100n, 4242n));
  });

  it("binds the pool", () => {
    expect(orderKey("0x0000000000000000000000000000000000000004", 99n, 4242n)).not.toBe(orderKey(POOL, 99n, 4242n));
  });

  it("binds the order id", () => {
    expect(orderKey(POOL, 99n, 4243n)).not.toBe(orderKey(POOL, 99n, 4242n));
  });
});
