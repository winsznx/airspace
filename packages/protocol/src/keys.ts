import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

/**
 * TypeScript mirrors of the portfolio contract's key derivations.
 *
 * These must stay byte-identical to `AirspacePortfolio._intentHash` and
 * `_orderKey`. They are mirrors, not a second source of truth: anything derived
 * here is only ever used to LOOK UP a record the contract already produced.
 */

export interface IntentStruct {
  marketId: Hex;
  pool: Address;
  marketNonce: bigint;
  kind: number;
  price: bigint;
  quantity: bigint;
  expireTimestampNs: bigint;
  orderType: number;
  nonce: bigint;
  strategyVersion: Hex;
}

const INTENT_TUPLE = {
  type: "tuple",
  components: [
    { name: "marketId", type: "bytes32" },
    { name: "pool", type: "address" },
    { name: "marketNonce", type: "uint64" },
    { name: "kind", type: "uint8" },
    { name: "price", type: "uint256" },
    { name: "quantity", type: "uint256" },
    { name: "expireTimestampNs", type: "uint64" },
    { name: "orderType", type: "uint8" },
    { name: "nonce", type: "uint64" },
    { name: "strategyVersion", type: "bytes32" },
  ],
} as const;

/** `keccak256(abi.encode(portfolio, chainId, agent, intent))`. */
export function intentHash(portfolio: Address, chainId: number | bigint, agent: Address, i: IntentStruct): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "address" }, INTENT_TUPLE],
      [portfolio, BigInt(chainId), agent, i],
    ),
  );
}

/**
 * `keccak256(abi.encode(pool, marketNonce, orderId))`.
 *
 * The generation is part of the key because DreamDEX recycles pool addresses:
 * an order id alone would let a stale order collide with a live one.
 */
export function orderKey(pool: Address, marketNonce: bigint, orderId: bigint): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint64" }, { type: "uint128" }], [pool, marketNonce, orderId]),
  );
}
