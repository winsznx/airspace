// AIRSPACE live multi-agent driver -- Somnia Shannon (chainId 50312).
//
// One capital base, three independent agent keys, one risk envelope, against the
// real deployed DreamDEX Event Contracts. Writes evidence/airspace/live-run.json.
//
//   node script/airspace-live.mjs

import { createPublicClient, createWalletClient, http, parseAbi, decodeErrorResult, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";

const RPC = "https://dream-rpc.somnia.network";
const CHAIN = { id: 50312, name: "Somnia Shannon", nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const MODULE = "0x3ecC694Cef705358864a646142ac17A90E29e388";
const OUTCOME = "0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9";
const TUSDC = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E";
const INDEXER = "https://dev.smk.somnia.host/v1/graphql";
const ONE = 1_000_000n;
const C = 1_000_000n; // one contract, raw units
const BTC = keccak256(toBytes("BTC"));

const W = JSON.parse(fs.readFileSync(".wallets.json", "utf8"));
const OWNER = privateKeyToAccount(W.OWNER.private_key);
const A = privateKeyToAccount(W.AGENT_A.private_key);
const B = privateKeyToAccount(W.AGENT_B.private_key);
const Cc = privateKeyToAccount(W.AGENT_C.private_key);

const art = (p, n) => JSON.parse(fs.readFileSync(`out/${p}/${n}.json`, "utf8"));
const ACC = art("AirspaceAccount.sol", "AirspaceAccount").abi;
const FAC = art("AirspaceFactory.sol", "AirspaceFactory").abi;

const moduleAbi = parseAbi([
  "function markets(bytes32 marketId) view returns (uint256 oracleQuestionId, uint8 outcomeSlotCount, uint8 voidPolicy, address collateral, uint32 originOperatorId, bytes32 originVenueId, address oracleAdapter, address creator, address market, address pool, uint256 yesId, uint256 noId, uint64 tradingStart, uint64 expiry)",
]);
const poolAbi = parseAbi([
  "function getBookLevels(bool isBid, uint64 numLevels) view returns ((uint256 price, uint256 quantity)[])",
  "function marketNonce() view returns (uint64)",
  "function marketExpiryNs() view returns (uint64)",
  "function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))",
]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const erc6909 = parseAbi(["function balanceOf(address owner, uint256 id) view returns (uint256)"]);

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });
const wc = (acct) => createWalletClient({ account: acct, chain: CHAIN, transport: http(RPC) });
const wOWNER = wc(OWNER), wA = wc(A), wB = wc(B), wC = wc(Cc);

const ev = { chainId: 50312, startedAt: new Date().toISOString(), actors: { owner: OWNER.address, agentA: A.address, agentB: B.address, agentC: Cc.address }, steps: [] };
const J = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
const log = (name, data) => { console.log(`\n[${name}]`, JSON.stringify(J(data), null, 1)); ev.steps.push({ name, ...J(data) }); };

async function send(w, req, label) {
  const hash = await w.writeContract(req);
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`  ${label}: ${hash} ${r.status}`);
  if (r.status !== "success") throw new Error(`${label} reverted`);
  return { hash, status: r.status, blockNumber: r.blockNumber };
}

function decodeRevert(err) {
  let e = err;
  for (let i = 0; i < 8 && e; i++) {
    if (e.name === "ContractFunctionRevertedError" && e.data?.errorName) return e.data.errorName;
    e = e.cause;
  }
  e = err;
  for (let i = 0; i < 8 && e; i++) {
    const raw = typeof e?.data === "string" ? e.data : e?.data?.data;
    if (typeof raw === "string" && raw.length >= 10) {
      try { return decodeErrorResult({ abi: ACC, data: raw }).errorName; } catch { return `undecoded(${raw.slice(0, 10)})`; }
    }
    e = e.cause;
  }
  const m = /Error:\s*([A-Za-z0-9_]+)\(\)/.exec(err?.message ?? "");
  return m ? m[1] : "unknown";
}

async function expectRevert(label, expected, call) {
  try {
    await pub.simulateContract(call);
    throw new Error(`${label}: expected ${expected} but the call SUCCEEDED`);
  } catch (e) {
    if (e.message?.includes("but the call SUCCEEDED")) throw e;
    const got = decodeRevert(e);
    const ok = expected === "*" ? true : got === expected;
    console.log(`  ${ok ? "PASS" : "FAIL"} ${label}: ${got}`);
    if (!ok) throw new Error(`${label}: expected ${expected}, got ${got}`);
    return { label, expected, got };
  }
}

// ---------------------------------------------------------------------------

async function pickBtcMarkets(n) {
  const q = `{ Market(where:{marketType:{_eq:"BINARY"},clobStatus:{_eq:"Trading"},finalized:{_eq:false},asset:{_eq:"BTC"}}, order_by:{expiry:desc}, limit:40){ marketId asset intervalSec expiry } }`;
  const res = await fetch(INDEXER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q }) }).then((r) => r.json());
  const now = Math.floor(Date.now() / 1000);
  const out = [];
  for (const m of res.data.Market) {
    if (Number(m.expiry) - now < 600) continue;
    const id = `0x${BigInt(m.marketId).toString(16).padStart(64, "0")}`;
    const rec = await pub.readContract({ address: MODULE, abi: moduleAbi, functionName: "markets", args: [id] });
    if (rec[9] === "0x0000000000000000000000000000000000000000") continue;
    const pool = rec[9];
    const bids = await pub.readContract({ address: pool, abi: poolAbi, functionName: "getBookLevels", args: [true, 1n] });
    out.push({
      id, asset: m.asset, intervalSec: Number(m.intervalSec), pool, expiry: Number(rec[13]),
      nonce: await pub.readContract({ address: pool, abi: poolAbi, functionName: "marketNonce" }),
      expNs: await pub.readContract({ address: pool, abi: poolAbi, functionName: "marketExpiryNs" }),
      yesId: rec[10], noId: rec[11], bestBid: bids.length ? bids[0].price : 0n,
    });
    if (out.length === n) break;
  }
  if (out.length < n) throw new Error(`needed ${n} live BTC markets, found ${out.length}`);
  return out;
}

const restIntent = (k, contracts, nonce) => {
  // Deep below the touch: a POST_ONLY buy here cannot cross, so it rests as a
  // pure reservation -- exactly what proves unfilled orders consume risk.
  let px = k.bestBid > 30000n ? k.bestBid - 30000n : 10000n;
  px = (px / 1000n) * 1000n;
  if (px < 1000n) px = 1000n;
  return { marketId: k.id, pool: k.pool, marketNonce: k.nonce, kind: 0, price: px, quantity: contracts, expireTimestampNs: k.expNs, orderType: 3, nonce: BigInt(nonce), strategyVersion: keccak256(toBytes("airspace/v1")) };
};

(async () => {
  console.log("=== AIRSPACE live multi-agent spike ===");
  const [m1, m2] = await pickBtcMarkets(2);
  log("00-markets", { m1: { id: m1.id, cadence: m1.intervalSec, pool: m1.pool, nonce: m1.nonce, secondsLeft: m1.expiry - Math.floor(Date.now() / 1000) }, m2: { id: m2.id, cadence: m2.intervalSec, pool: m2.pool, nonce: m2.nonce, secondsLeft: m2.expiry - Math.floor(Date.now() / 1000) } });

  // 1. deploy + create portfolio
  const facHash = await wOWNER.deployContract({ abi: FAC, bytecode: art("AirspaceFactory.sol", "AirspaceFactory").bytecode.object, args: [MODULE, OUTCOME] });
  const facR = await pub.waitForTransactionReceipt({ hash: facHash });
  const FACTORY = facR.contractAddress;
  console.log("  factory:", FACTORY);

  const salt = keccak256(toBytes(`airspace-${Date.now()}`));
  const { request: cr } = await pub.simulateContract({ account: OWNER, address: FACTORY, abi: FAC, functionName: "createPortfolio", args: [OWNER.address, salt] });
  const crTx = await send(wOWNER, cr, "createPortfolio");
  const PF = await pub.readContract({ address: FACTORY, abi: FAC, functionName: "portfolioFor", args: [OWNER.address, salt] });
  log("01-portfolio", { factory: FACTORY, portfolio: PF, factoryTx: facHash, ...crTx });

  const own = async (fn, args, label) => {
    const { request } = await pub.simulateContract({ account: OWNER, address: PF, abi: ACC, functionName: fn, args });
    return send(wOWNER, request, label);
  };

  // 2. fund + declare capital base
  await own("ownerCall", [TUSDC, 0n, "0x57915897" + (6000n * ONE).toString(16).padStart(64, "0")], "fund(faucet 6000)");
  await own("syncCapitalBase", [TUSDC], "syncCapitalBase");
  const funded = await pub.readContract({ address: TUSDC, abi: erc20, functionName: "balanceOf", args: [PF] });
  log("02-funded", { tUSDC: funded, capitalBase: await pub.readContract({ address: PF, abi: ACC, functionName: "capitalBase" }) });

  // 3. policies: BTC bucket ceiling 500 contracts
  const now = Math.floor(Date.now() / 1000);
  const gp = { maxCommittedCollateral: 5000n * ONE, maxRestingReservation: 5000n * ONE, maxSingleOrderNotional: 2000n * ONE, maxBuyPrice: 990000n, minSellPrice: 10000n, maxLivePositions: 8, minHeadroomSec: 60n, policyExpiry: BigInt(now + 3600) };
  const bp = { maxGrossDirectional: 500n * C, maxCommitted: 5000n * ONE };
  const ap = { enabled: true, maxCommitted: 3000n * ONE, maxOrderNotional: 2000n * ONE, maxBuyPrice: 990000n, minSellPrice: 10000n, cooldownSec: 0n };

  await own("setGlobalPolicy", [gp], "setGlobalPolicy");
  await own("setBucketPolicy", [BTC, bp], "setBucketPolicy(BTC=500)");
  await own("admitMarket", [m1.id, BTC], "admitMarket m1");
  await own("admitMarket", [m2.id, BTC], "admitMarket m2");
  await own("setAgent", [A.address, ap], "setAgent A");
  await own("setAgent", [B.address, ap], "setAgent B");
  await own("setAgent", [Cc.address, ap], "setAgent C");
  log("03-configured", { globalPolicyHash: await pub.readContract({ address: PF, abi: ACC, functionName: "globalPolicyHash" }), bucket: "BTC", maxGrossDirectional: bp.maxGrossDirectional, agents: [A.address, B.address, Cc.address] });

  const gross = () => pub.readContract({ address: PF, abi: ACC, functionName: "bucketGross", args: [BTC] });
  const agentExec = async (w, acct, intent, label) => {
    const { request } = await pub.simulateContract({ account: acct, address: PF, abi: ACC, functionName: "execute", args: [intent] });
    return send(w, request, label);
  };

  // 4. Agent A: 180 contracts (individually valid)
  const iA = restIntent(m1, 180n * C, 1);
  const txA = await agentExec(wA, A, iA, "AGENT_A execute 180");
  const gA = await gross();
  log("04-agentA", { intent: iA, ...txA, bucketGrossAfter: gA });

  // 5. Agent B: 240 contracts on a DIFFERENT cadence (individually valid)
  const iB = restIntent(m2, 240n * C, 2);
  const txB = await agentExec(wB, B, iB, "AGENT_B execute 240");
  const gB = await gross();
  log("05-agentB", { intent: iB, ...txB, bucketGrossAfter: gB, cadenceA: m1.intervalSec, cadenceB: m2.intervalSec });

  // 6. Agent C: 150 contracts -- valid under C's OWN policy, rejected by the portfolio
  const iC = restIntent(m1, 150n * C, 3);
  const rej = await expectRevert("C rejected by AGGREGATE portfolio exposure", "BucketDirectionalExceeded", { account: Cc, address: PF, abi: ACC, functionName: "execute", args: [iC] });
  log("06-agentC-rejected", {
    intent: iC, ...rej,
    arithmetic: `${gA} (A) + ${gB - gA} (B) + ${150n * C} (C) = ${gB + 150n * C} > ${bp.maxGrossDirectional} ceiling`,
    cCommittedBefore: await pub.readContract({ address: PF, abi: ACC, functionName: "agentCommitted", args: [Cc.address] }),
    proofOfIndividualValidity: { cMaxOrderNotional: ap.maxOrderNotional, cMaxCommitted: ap.maxCommitted, note: "C's own policy admits this order in full" },
  });

  // 7. compromised C
  const negs = [];
  const asC = (fn, args) => ({ account: Cc, address: PF, abi: ACC, functionName: fn, args });
  negs.push(await expectRevert("C: alternate pool", "PoolMismatch", asC("execute", [{ ...restIntent(m1, 10n * C, 11), pool: "0x000000000000000000000000000000000000dEaD" }])));
  negs.push(await expectRevert("C: recycled/stale generation", "GenerationMismatch", asC("execute", [{ ...restIntent(m1, 10n * C, 12), marketNonce: m1.nonce - 1n }])));
  negs.push(await expectRevert("C: price grief", "PriceOutsidePolicy", asC("execute", [{ ...restIntent(m1, 10n * C, 13), price: 995000n }])));
  negs.push(await expectRevert("C: direct withdrawal", "NotOwner", asC("withdraw", [TUSDC, Cc.address, 1n])));
  negs.push(await expectRevert("C: outcome withdrawal", "NotOwner", asC("withdrawOutcome", [m1.yesId, Cc.address, 1n])));
  negs.push(await expectRevert("C: ownerCall escalation", "NotOwner", asC("ownerCall", [TUSDC, 0n, "0x"])));
  negs.push(await expectRevert("C: rewrite another agent's policy", "NotOwner", asC("setAgent", [A.address, ap])));
  negs.push(await expectRevert("C: widen the bucket ceiling", "NotOwner", asC("setBucketPolicy", [BTC, { maxGrossDirectional: 10n ** 30n, maxCommitted: 10n ** 30n }])));
  negs.push(await expectRevert("C: admit a market into another bucket", "NotOwner", asC("admitMarket", [m1.id, keccak256(toBytes("NOT_BTC"))])));

  // reservation-release manipulation: A's order is genuinely live
  const keyA = await pub.readContract({ address: PF, abi: ACC, functionName: "orderKey", args: [m1.pool, m1.nonce, BigInt(await orderIdOf(txA.hash))] });
  negs.push(await expectRevert("C: release another agent's live reservation", "OrderStillLive", asC("releaseOrder", [keyA])));

  // replay
  negs.push(await expectRevert("A: replay a used intent", "IntentReplayed", { account: A, address: PF, abi: ACC, functionName: "execute", args: [iA] }));
  log("07-compromised-C", { count: negs.length, negs, bucketGrossUnchanged: await gross() });

  // 8. owner cancels A's order; permissionless release frees the headroom
  const idA = BigInt(await orderIdOf(txA.hash));
  await own("cancelOrder", [m1.pool, idA], "owner cancels A's resting order");
  const { request: relReq } = await pub.simulateContract({ account: Cc, address: PF, abi: ACC, functionName: "releaseOrder", args: [keyA] });
  const relTx = await send(wC, relReq, "releaseOrder (permissionless, by C)");
  const gRel = await gross();
  log("08-released", { orderKey: keyA, orderId: idA, ...relTx, bucketGrossAfter: gRel, note: "release only ever moves the books toward what the pool reports" });

  // 9. the SAME shape from C now fits
  const iC2 = restIntent(m1, 150n * C, 4);
  const txC = await agentExec(wC, Cc, iC2, "AGENT_C execute 150 (now admissible)");
  const gC = await gross();
  log("09-agentC-admitted", { intent: iC2, ...txC, bucketGrossAfter: gC, arithmetic: `${gRel} + ${150n * C} = ${gC} <= ${bp.maxGrossDirectional}` });

  // 10. owner recovery with every agent revoked
  const off = { ...ap, enabled: false };
  for (const [a, n] of [[A.address, "A"], [B.address, "B"], [Cc.address, "C"]]) await own("setAgent", [a, off], `revoke agent ${n}`);
  for (const [k, id] of [[m2, await orderIdOf(txB.hash)], [m1, await orderIdOf(txC.hash)]]) {
    try { await own("cancelOrder", [k.pool, BigInt(id)], "cancel resting order"); } catch (e) { console.log("  cancel skipped:", String(e.message).slice(0, 80)); }
  }
  const idle = await pub.readContract({ address: TUSDC, abi: erc20, functionName: "balanceOf", args: [PF] });
  await own("withdraw", [TUSDC, OWNER.address, idle], "owner withdraw all collateral");
  log("10-owner-recovery", {
    agentsRevoked: 3, collateralRecovered: idle,
    residualInPortfolio: await pub.readContract({ address: TUSDC, abi: erc20, functionName: "balanceOf", args: [PF] }),
    ownerBalance: await pub.readContract({ address: TUSDC, abi: erc20, functionName: "balanceOf", args: [OWNER.address] }),
  });

  ev.finishedAt = new Date().toISOString();
  ev.portfolio = PF; ev.factory = FACTORY;
  fs.mkdirSync("evidence/airspace", { recursive: true });
  fs.writeFileSync("evidence/airspace/live-run.json", JSON.stringify(ev, null, 2));
  console.log("\n=== wrote evidence/airspace/live-run.json ===");
})().catch((e) => {
  console.error("\nFATAL:", e.message);
  ev.fatal = e.message;
  fs.mkdirSync("evidence/airspace", { recursive: true });
  fs.writeFileSync("evidence/airspace/live-run.json", JSON.stringify(ev, null, 2));
  process.exit(1);
});

/// Read the placed order id out of the IntentExecuted log of a given tx.
async function orderIdOf(hash) {
  const r = await pub.getTransactionReceipt({ hash });
  const topic = keccak256(toBytes("IntentExecuted(bytes32,bytes32,address,bytes32,bytes32,bytes32,address,uint64,uint8,uint256,uint256,uint128,bytes32)"));
  for (const l of r.logs) {
    if (l.topics[0] !== topic) continue;
    const d = l.data.slice(2);
    // non-indexed: bucket, globalPolicyHash, agentPolicyHash, pool, marketNonce,
    // kind, price, quantity, orderId, strategyVersion  -> orderId is word 8
    return BigInt("0x" + d.slice(8 * 64, 9 * 64));
  }
  throw new Error("IntentExecuted not found");
}
