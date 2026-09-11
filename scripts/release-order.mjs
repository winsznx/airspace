#!/usr/bin/env node
// Permissionless: release a resting reservation down to what the venue still
// shows open, so a filled order stops double-counting against the domain.
//
//   node scripts/release-order.mjs <momentum|oracle|meanrev|owner> <pool> <marketNonce> <orderId>

import { createPublicClient, createWalletClient, http, keccak256, encodeAbiParameters } from "viem";
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
const PORTFOLIO = "0x088A42b7E1806774e71388A48f59f167d1c1b2D9";

const AGENT_NAME = (process.argv[2] ?? "").toUpperCase();
const [pool, nonceArg, orderIdArg] = process.argv.slice(3);
if (!["MOMENTUM", "ORACLE", "MEANREV", "OWNER"].includes(AGENT_NAME) || !pool || !nonceArg || !orderIdArg) {
  console.error("usage: node scripts/release-order.mjs <momentum|oracle|meanrev|owner> <pool> <marketNonce> <orderId>");
  process.exit(1);
}

const env = loadEnvLocal();
let pk = env[`${AGENT_NAME}_PRIVATE_KEY`];
if (!pk) { console.error(`Add ${AGENT_NAME}_PRIVATE_KEY to .env.local — releaseOrder is permissionless, any funded key works`); process.exit(1); }
if (!pk.startsWith("0x")) pk = "0x" + pk;

const key = keccak256(encodeAbiParameters(
  [{ type: "address" }, { type: "uint64" }, { type: "uint128" }],
  [pool, BigInt(nonceArg), BigInt(orderIdArg)],
));
console.log("orderKey:", key);

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });
const account = privateKeyToAccount(pk);
const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });

const abi = [{ type: "function", name: "releaseOrder", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }], outputs: [] }];
const hash = await wallet.writeContract({ address: PORTFOLIO, abi, functionName: "releaseOrder", args: [key] });
console.log("tx:", hash);
const receipt = await pub.waitForTransactionReceipt({ hash });
console.log("status:", receipt.status, "block:", receipt.blockNumber.toString());
