#!/usr/bin/env node
// One-shot: find the freshest live 5-min market in the configured domain and
// submit an agent's order immediately, no round-trip. Reads the key straight
// out of .env.local so it never has to live in a shell export or in chat.
//
//   node scripts/momentum-order.mjs <momentum|oracle|meanrev> [qty] [price6] [kind]
//
// Defaults: qty=70000000 (70 contracts), price=550000 (0.55), kind=0 (BUY_YES).

import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";

function loadEnvLocal() {
  const out = {};
  let text;
  try { text = readFileSync(new URL("../.env.local", import.meta.url), "utf8"); }
  catch { return out; }
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const RPC = "https://dream-rpc.somnia.network";
const CHAIN = { id: 50312, name: "Somnia Shannon", nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const MODULE = "0x3ecC694Cef705358864a646142ac17A90E29e388";
const PORTFOLIO = "0x088A42b7E1806774e71388A48f59f167d1c1b2D9";
const CREATOR = "0x94d963b6670ab96e78c8d0c46ca35d196d606efe";

const AGENT_NAME = (process.argv[2] ?? "").toUpperCase();
if (!["MOMENTUM", "ORACLE", "MEANREV"].includes(AGENT_NAME)) {
  console.error("usage: node scripts/momentum-order.mjs <momentum|oracle|meanrev> [qty] [price6] [kind]");
  process.exit(1);
}
const QTY = BigInt(process.argv[3] ?? "70000000");
const PRICE = BigInt(process.argv[4] ?? "550000");
const KIND = Number(process.argv[5] ?? "0"); // 0 = BUY_YES

const env = loadEnvLocal();
let pk = env[`${AGENT_NAME}_PRIVATE_KEY`];
if (!pk) { console.error(`Add ${AGENT_NAME}_PRIVATE_KEY to .env.local`); process.exit(1); }
if (!pk.startsWith("0x")) pk = "0x" + pk;

const marketsAbi = [{ type: "function", name: "markets", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [
  { type: "uint256" }, { type: "uint8" }, { type: "uint8" }, { type: "address" }, { type: "uint32" }, { type: "bytes32" },
  { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint64" }, { type: "uint64" },
]}];
const poolAbi = [
  { type: "function", name: "marketNonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "getBookLevels", stateMutability: "view", inputs: [{ type: "bool" }, { type: "uint64" }], outputs: [{ type: "tuple[]", components: [{ type: "uint256", name: "price" }, { type: "uint256", name: "quantity" }] }] },
  { type: "function", name: "getOrderBookParameters", stateMutability: "view", inputs: [], outputs: [{ type: "tuple", components: [{ type: "uint256", name: "tickSize" }, { type: "uint256", name: "minQuantity" }, { type: "uint256", name: "lotSize" }] }] },
];
const pfAbi = [
  { type: "function", name: "agentNonce", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint64" }] },
  { type: "function", name: "execute", stateMutability: "nonpayable", inputs: [{
      type: "tuple", components: [
        { type: "bytes32", name: "marketId" }, { type: "address", name: "pool" }, { type: "uint64", name: "marketNonce" },
        { type: "uint8", name: "kind" }, { type: "uint256", name: "price" }, { type: "uint256", name: "quantity" },
        { type: "uint64", name: "expireTimestampNs" }, { type: "uint8", name: "orderType" }, { type: "uint64", name: "nonce" },
        { type: "bytes32", name: "strategyVersion" },
      ] }], outputs: [{ type: "uint128" }] },
];

const idOf = (n) => "0x" + n.toString(16).padStart(64, "0");

async function highestMarketIndex(pub) {
  const exists = async (n) => {
    const r = await pub.readContract({ address: MODULE, abi: marketsAbi, functionName: "markets", args: [idOf(n)] });
    return r[9] !== "0x0000000000000000000000000000000000000000";
  };
  let lo = 0x1a800n, hi = 0x1a800n;
  while (await exists(hi)) { lo = hi; hi = hi * 2n; if (hi > lo + 200000n) hi = lo + 200000n; }
  while (lo + 1n < hi) {
    const mid = (lo + hi) / 2n;
    if (await exists(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

async function findLiveMarket(pub) {
  const now = Math.floor(Date.now() / 1000);
  const frontier = await highestMarketIndex(pub);
  // scan back from the frontier; live markets are near the tip, expired ones behind it
  let best = null;
  const probes = [];
  for (let i = 0n; i < 400n; i++) probes.push(frontier > i ? frontier - i : 0n);
  for (const n of probes) {
    let r;
    try { r = await pub.readContract({ address: MODULE, abi: marketsAbi, functionName: "markets", args: [idOf(n)] }); }
    catch { continue; }
    const pool = r[9], creator = r[7], expiry = Number(r[13]), start = Number(r[12]);
    if (pool === "0x0000000000000000000000000000000000000000") continue;
    if (creator.toLowerCase() !== CREATOR) continue;
    if (expiry - start !== 300) continue;
    const left = expiry - now;
    if (left > 180 && (best === null || left > best.left)) best = { id: idOf(n), pool, expiry, left };
  }
  return best;
}

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });
const account = privateKeyToAccount(pk);
const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });

console.log("agent:", account.address);
console.log("scanning for a live market...");
const m = await findLiveMarket(pub);
if (!m) { console.error("no live market with enough runway found — try again"); process.exit(1); }
console.log("found:", m.id, m.pool, "secondsLeft:", m.left);

const [nonce, marketNonce, asks, params] = await Promise.all([
  pub.readContract({ address: PORTFOLIO, abi: pfAbi, functionName: "agentNonce", args: [account.address] }),
  pub.readContract({ address: m.pool, abi: poolAbi, functionName: "marketNonce" }),
  pub.readContract({ address: m.pool, abi: poolAbi, functionName: "getBookLevels", args: [false, 5n] }),
  pub.readContract({ address: m.pool, abi: poolAbi, functionName: "getOrderBookParameters" }),
]);
console.log("live asks:", asks);
let price = PRICE;
if (asks.length > 0) {
  const bestAsk = asks[0].price;
  const tick = params.tickSize;
  if (price >= bestAsk) {
    price = bestAsk > tick ? bestAsk - tick : tick;
    console.log(`price ${PRICE} would cross best ask ${bestAsk}, clamped to ${price}`);
  }
}

const intent = {
  marketId: m.id,
  pool: m.pool,
  marketNonce,
  kind: KIND,
  price,
  quantity: QTY,
  expireTimestampNs: BigInt(Math.floor(Date.now() / 1000) + 60) * 1_000_000_000n,
  orderType: 3,
  nonce: nonce + 1n,
  strategyVersion: "0x" + "0".repeat(64),
};

console.log("submitting intent, nonce", intent.nonce.toString(), "market nonce", intent.marketNonce.toString());
const hash = await wallet.writeContract({ address: PORTFOLIO, abi: pfAbi, functionName: "execute", args: [intent] });
console.log("tx sent:", hash);
const receipt = await pub.waitForTransactionReceipt({ hash });
console.log("status:", receipt.status, "block:", receipt.blockNumber.toString());
