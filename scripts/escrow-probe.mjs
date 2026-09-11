#!/usr/bin/env node
/**
 * Empirical probe: does a resting SELL escrow its outcome tokens at
 * placement, or only when it fills?
 *
 * This is not a demo. It is the source of the load-bearing claim behind the
 * whole exposure fix — that a resting SELL's tokens have already left the
 * realized balance, so a cancel returning them widens the exposure interval
 * rather than shrinking it. The claim is cited from several places:
 * `contracts/test/reference/ExposureOracle.sol`, `contracts/test/mocks/MockDreamDex.sol`,
 * ARCHITECTURE.md, SECURITY.md, PRD.md 10.4a, and `evidence/production/REMEDIATION.md`.
 * None of them re-derive it; they all point back here.
 *
 * The mock originally modelled a SELL as burn-on-fill, matching the more
 * common convention (escrow the collateral-equivalent, settle on fill). That
 * would have hidden the entire sell side of the accounting from every test
 * built on it. This script settled the question against the real venue:
 * across four live pools, a pool's outcome-token balance equalled its resting
 * ask depth exactly. The tokens are gone from the seller the moment the ask
 * rests, not when it trades.
 *
 *   node scripts/escrow-probe.mjs
 *
 * Prints its findings; writes nothing. Re-run whenever the venue's ask depth
 * looks wrong, or before trusting this claim on a chain it has not been run
 * against.
 */
import { createPublicClient, http, fallback } from "viem";
import fs from "node:fs";

const RPC = process.env.SHANNON_RPC ?? "https://dream-rpc.somnia.network";
const pub = createPublicClient({
  chain: { id: 50312, name: "Somnia Shannon", nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } },
  transport: fallback([http(RPC, { retryCount: 1 }), http("https://rpc.ankr.com/somnia_testnet", { retryCount: 1 })], { rank: false }),
});

const deployment = JSON.parse(fs.readFileSync("contracts/deployments/50312.json", "utf8"));
const MODULE = deployment.dreamdex.binaryModule;
const OUTCOME = deployment.dreamdex.outcomeToken6909;

const MODULE_ABI = [
  {
    type: "function", name: "markets", stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [
      { type: "uint256" }, { type: "uint8" }, { type: "uint8" }, { type: "address" }, { type: "uint32" },
      { type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" },
      { type: "uint256" }, { type: "uint256" }, { type: "uint64" }, { type: "uint64" },
    ],
  },
];
const POOL_ABI = [
  { type: "function", name: "marketNonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  {
    type: "function", name: "getBookLevels", stateMutability: "view",
    inputs: [{ type: "bool" }, { type: "uint64" }],
    outputs: [{ type: "tuple[]", components: [{ name: "price", type: "uint256" }, { name: "quantity", type: "uint256" }] }],
  },
];
const ERC6909_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
];

const idOf = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const readMarket = async (id) => {
  try {
    const r = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: "markets", args: [id] });
    return r[9] === "0x0000000000000000000000000000000000000000" ? null : { pool: r[9], expiry: Number(r[13]) };
  } catch {
    return null;
  }
};

// Find the top of the registry with a doubling-then-bisecting search.
let lo = 0x1000n, hi = 0x1000n;
const exists = async (n) => Boolean(await readMarket(idOf(n)));
while (await exists(hi)) { lo = hi; hi *= 2n; if (hi > 0x400000n) break; }
while (lo + 1n < hi) { const m = (lo + hi) / 2n; if (await exists(m)) lo = m; else hi = m; }
const now = Math.floor(Date.now() / 1000);

console.log("=== escrow probe: does a resting SELL escrow at placement or at fill? ===\n");
console.log("scanning live pools for a resting ask and checking whether the pool custodies the tokens\n");

let checked = 0;
let allMatch = true;
for (let i = 0n; i < 50n && checked < 4; i++) {
  const m = await readMarket(idOf(lo - i));
  if (!m || m.expiry - now < 60) continue;

  let asks = [], nonce;
  try {
    [asks, nonce] = await Promise.all([
      pub.readContract({ address: m.pool, abi: POOL_ABI, functionName: "getBookLevels", args: [false, 3n] }),
      pub.readContract({ address: m.pool, abi: POOL_ABI, functionName: "marketNonce" }),
    ]);
  } catch {
    continue;
  }
  if (!asks.length) continue;

  const yesId = (BigInt(m.pool) << 72n) | (BigInt(nonce) << 8n);
  const [poolYes, poolNo] = await Promise.all([
    pub.readContract({ address: OUTCOME, abi: ERC6909_ABI, functionName: "balanceOf", args: [m.pool, yesId] }),
    pub.readContract({ address: OUTCOME, abi: ERC6909_ABI, functionName: "balanceOf", args: [m.pool, yesId + 1n] }),
  ]);
  const askQty = asks.reduce((a, l) => a + l.quantity, 0n);
  const custodies = poolYes > 0n || poolNo > 0n;
  const matches = custodies && (poolYes === askQty || poolNo === askQty);

  console.log(`pool ${m.pool.slice(0, 12)}  nonce ${nonce}`);
  console.log(`   resting ASK depth (top 3)      ${(Number(askQty) / 1e6).toFixed(0)}`);
  console.log(`   POOL holds YES                 ${(Number(poolYes) / 1e6).toFixed(0)}`);
  console.log(`   POOL holds NO                  ${(Number(poolNo) / 1e6).toFixed(0)}`);
  console.log(`   -> ${custodies ? "pool CUSTODIES outcome tokens (escrow at placement)" : "pool holds NO outcome tokens"}`);
  console.log(`   -> balance == ask depth?  ${matches ? "YES, exactly" : "no — investigate before trusting this claim"}\n`);

  if (!matches) allMatch = false;
  checked++;
}

console.log(
  checked === 0
    ? "no live pool with a resting ask was found — re-run when the venue has one"
    : allMatch
      ? `CONFIRMED across ${checked} pools: a SELL escrows its outcome tokens at placement.`
      : "MISMATCH found — the escrow-at-placement claim needs re-checking before it is cited anywhere.",
);
