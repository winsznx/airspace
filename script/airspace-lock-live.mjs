// AIRSPACE final LOCK demonstration -- Somnia Shannon (chainId 50312).
//
// One capital pool, three independent agent keys, one structural risk domain,
// against the real deployed DreamDEX Event Contracts.
// Writes evidence/airspace-lock/live-run.json.

import { createPublicClient, createWalletClient, http, parseAbi, decodeErrorResult, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "fs";

const RPC = "https://dream-rpc.somnia.network";
const CHAIN = { id: 50312, name: "Somnia Shannon", nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const MODULE = "0x3ecC694Cef705358864a646142ac17A90E29e388";
const OUTCOME = "0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9";
const TUSDC = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E";
const ONE = 1_000_000n;
const K = 1_000_000n; // one contract, raw units

const W = JSON.parse(fs.readFileSync(".wallets.json", "utf8"));
const OWNER = privateKeyToAccount(W.OWNER.private_key);
const A = privateKeyToAccount(W.AGENT_A.private_key);
const B = privateKeyToAccount(W.AGENT_B.private_key);
const Cc = privateKeyToAccount(W.AGENT_C.private_key);

const art = (n) => JSON.parse(fs.readFileSync(`out/${n}.sol/${n}.json`, "utf8"));
const PF_ABI = art("AirspacePortfolio").abi;
const FAC = art("AirspacePortfolioFactory");

const moduleAbi = parseAbi([
  "function markets(bytes32 marketId) view returns (uint256 oracleQuestionId, uint8 outcomeSlotCount, uint8 voidPolicy, address collateral, uint32 originOperatorId, bytes32 originVenueId, address oracleAdapter, address creator, address market, address pool, uint256 yesId, uint256 noId, uint64 tradingStart, uint64 expiry)",
]);
const poolAbi = parseAbi([
  "function getBookLevels(bool isBid, uint64 numLevels) view returns ((uint256 price, uint256 quantity)[])",
  "function marketNonce() view returns (uint64)",
  "function marketExpiryNs() view returns (uint64)",
]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });
const wc = (a) => createWalletClient({ account: a, chain: CHAIN, transport: http(RPC) });
const wO = wc(OWNER), wA = wc(A), wB = wc(B), wC = wc(Cc);

const ev = { chainId: 50312, startedAt: new Date().toISOString(), actors: { owner: OWNER.address, agentA: A.address, agentB: B.address, agentC: Cc.address }, steps: [] };
const J = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
const log = (n, d) => { console.log(`\n[${n}]`, JSON.stringify(J(d), null, 1)); ev.steps.push({ name: n, ...J(d) }); };

async function send(w, req, label) {
  const hash = await w.writeContract(req);
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`  ${label}: ${hash} ${r.status}`);
  if (r.status !== "success") throw new Error(`${label} reverted`);
  return { hash, status: r.status, blockNumber: r.blockNumber, gasUsed: r.gasUsed };
}

function decodeRevert(err) {
  let e = err;
  for (let i = 0; i < 8 && e; i++) { if (e.name === "ContractFunctionRevertedError" && e.data?.errorName) return e.data.errorName; e = e.cause; }
  e = err;
  for (let i = 0; i < 8 && e; i++) {
    const raw = typeof e?.data === "string" ? e.data : e?.data?.data;
    if (typeof raw === "string" && raw.length >= 10) { try { return decodeErrorResult({ abi: PF_ABI, data: raw }).errorName; } catch { return `undecoded(${raw.slice(0, 10)})`; } }
    e = e.cause;
  }
  const m = /Error:\s*([A-Za-z0-9_]+)\(\)/.exec(err?.message ?? "");
  return m ? m[1] : "unknown";
}

async function expectRevert(label, expected, call) {
  try { await pub.simulateContract(call); throw new Error(`${label}: expected ${expected} but it SUCCEEDED`); }
  catch (e) {
    if (e.message?.includes("but it SUCCEEDED")) throw e;
    const got = decodeRevert(e);
    const ok = got === expected;
    console.log(`  ${ok ? "PASS" : "FAIL"} ${label}: ${got}`);
    if (!ok) throw new Error(`${label}: expected ${expected}, got ${got}`);
    return { label, expected, got };
  }
}

// marketIds are a sequential counter -- enumerate straight from the module.
async function liveMarkets() {
  const rec = (id) => pub.readContract({ address: MODULE, abi: moduleAbi, functionName: "markets", args: [`0x${id.toString(16).padStart(64, "0")}`] });
  const alive = async (id) => { try { const r = await rec(id); return r[9] !== "0x0000000000000000000000000000000000000000"; } catch { return false; } };
  let lo = 0xb000n, hi = 0xb000n;
  while (await alive(hi)) { lo = hi; hi *= 2n; if (hi > 0x100000n) break; }
  while (lo + 1n < hi) { const mid = (lo + hi) / 2n; if (await alive(mid)) lo = mid; else hi = mid; }
  const now = Math.floor(Date.now() / 1000);
  const TABLE = [60, 300, 900, 1800, 3600, 14400, 86400];
  const cad = (ts, ex) => { const w = ex - ts; for (const C of TABLE) if (C >= w && ex % C === 0) return C; return 0; };
  const out = [];
  for (let id = lo; id > lo - 200n; id--) {
    const r = await rec(id);
    const pool = r[9];
    if (pool === "0x0000000000000000000000000000000000000000") continue;
    const ts = Number(r[12]), ex = Number(r[13]);
    if (ex < now + 300) continue;
    out.push({ id: `0x${id.toString(16).padStart(64, "0")}`, short: `0x${id.toString(16)}`, creator: r[7], collateral: r[3], pool, ts, ex, cad: cad(ts, ex), left: ex - now });
  }
  return out;
}

(async () => {
  console.log("=== AIRSPACE final LOCK demonstration ===");

  const mk = await liveMarkets();
  const byDom = {};
  for (const m of mk) { const k = `${m.creator}|${m.collateral}|${m.cad}`; (byDom[k] = byDom[k] || []).push(m); }
  const pair = Object.entries(byDom).filter(([, v]) => v.length >= 2).sort((a, b) => b[1][0].left - a[1][0].left)[0];
  if (!pair) throw new Error("need two live markets sharing one structural domain");
  const [m1, m2] = pair[1];
  for (const m of [m1, m2]) {
    m.nonce = await pub.readContract({ address: m.pool, abi: poolAbi, functionName: "marketNonce" });
    m.expNs = await pub.readContract({ address: m.pool, abi: poolAbi, functionName: "marketExpiryNs" });
    const bids = await pub.readContract({ address: m.pool, abi: poolAbi, functionName: "getBookLevels", args: [true, 1n] });
    m.bestBid = bids.length ? bids[0].price : 0n;
  }
  log("00-markets", {
    domainInputs: { creator: m1.creator, collateral: m1.collateral, cadenceSec: m1.cad },
    m1: { id: m1.short, pool: m1.pool, nonce: m1.nonce, secondsLeft: m1.left },
    m2: { id: m2.short, pool: m2.pool, nonce: m2.nonce, secondsLeft: m2.left },
    note: "two distinct markets, distinct pools, distinct generations, ONE structural domain",
  });

  // deploy + create
  const facHash = await wO.deployContract({ abi: FAC.abi, bytecode: FAC.bytecode.object, args: [MODULE, OUTCOME] });
  const FACTORY = (await pub.waitForTransactionReceipt({ hash: facHash })).contractAddress;
  const salt = keccak256(toBytes(`airspace-lock-${Date.now()}`));
  const { request: cr } = await pub.simulateContract({ account: OWNER, address: FACTORY, abi: FAC.abi, functionName: "createPortfolio", args: [OWNER.address, salt] });
  const crTx = await send(wO, cr, "createPortfolio");
  const PF = await pub.readContract({ address: FACTORY, abi: FAC.abi, functionName: "portfolioFor", args: [OWNER.address, salt] });
  log("01-portfolio", { factory: FACTORY, portfolio: PF, factoryTx: facHash, ...crTx });

  const own = async (fn, args, label) => {
    const { request } = await pub.simulateContract({ account: OWNER, address: PF, abi: PF_ABI, functionName: fn, args });
    return send(wO, request, label);
  };
  const gross = () => pub.readContract({ address: PF, abi: PF_ABI, functionName: "domainRiskUsage", args: [DOM] });
  const exec = async (w, acct, intent, label) => {
    const { request } = await pub.simulateContract({ account: acct, address: PF, abi: PF_ABI, functionName: "execute", args: [intent] });
    return send(w, request, label);
  };

  // The domain is DERIVED on-chain from the market. No attestation is supplied.
  const DOM = await pub.readContract({ address: PF, abi: PF_ABI, functionName: "domainOf", args: [m1.id] });
  const DOM2 = await pub.readContract({ address: PF, abi: PF_ABI, functionName: "domainOf", args: [m2.id] });
  const DOMK = await pub.readContract({ address: PF, abi: PF_ABI, functionName: "domainKey", args: [m1.creator, m1.collateral, m1.cad] });
  log("02-structural-domain", {
    domainOf_m1: DOM, domainOf_m2: DOM2, domainKey_recomputed: DOMK,
    siblingsShareDomain: DOM === DOM2,
    matchesCreatorCollateralCadence: DOM === DOMK,
    note: "derived from module.markets() at call time -- no indexer, no asset string, no attestation",
  });
  if (DOM !== DOM2 || DOM !== DOMK) throw new Error("structural domain derivation failed");

  await own("ownerCall", [TUSDC, 0n, "0x57915897" + (6000n * ONE).toString(16).padStart(64, "0")], "fund 6000 tUSDC");
  await own("syncCapitalBase", [TUSDC], "syncCapitalBase");

  const now = Math.floor(Date.now() / 1000);
  const gp = { maxCommittedCapital: 5000n * ONE, maxReservedCollateral: 5000n * ONE, maxSingleOrderNotional: 3000n * ONE, maxBuyPrice: 990000n, minSellPrice: 10000n, minHeadroomSec: 30n, policyExpiry: BigInt(now + 3600) };
  const dp = { set: true, maxDomainRiskUsage: 500n * K, maxDomainCommitted: 5000n * ONE, maxLiveMarkets: 16 };
  const ap = { enabled: true, maxCommitted: 4000n * ONE, maxOrderNotional: 3000n * ONE, maxBuyPrice: 990000n, minSellPrice: 10000n, cooldownSec: 0n };

  await own("setGlobalPolicy", [gp], "setGlobalPolicy");
  await own("setDomainPolicy", [DOM, dp], "setDomainPolicy (ONE call, covers the whole series forever)");
  for (const [a, n] of [[A.address, "A"], [B.address, "B"], [Cc.address, "C"]]) await own("setAgent", [a, ap], `setAgent ${n}`);
  const ownerNonceAfterConfig = await pub.getTransactionCount({ address: OWNER.address });
  log("03-configured", { domain: DOM, maxDomainRiskUsage: dp.maxDomainRiskUsage, agents: 3, ownerNonce: ownerNonceAfterConfig });

  const rest = (k, qty, nonce) => {
    let px = k.bestBid > 40000n ? k.bestBid - 40000n : 10000n;
    px = (px / 1000n) * 1000n; if (px < 1000n) px = 1000n;
    return { marketId: k.id, pool: k.pool, marketNonce: k.nonce, kind: 0, price: px, quantity: qty, expireTimestampNs: k.expNs, orderType: 3, nonce: BigInt(nonce), strategyVersion: keccak256(toBytes("airspace/lock")) };
  };

  // --- A: 180 -------------------------------------------------------------
  const iA = rest(m1, 180n * K, 1);
  const txA = await exec(wA, A, iA, "AGENT_A 180");
  const gA = await gross();
  log("04-agentA", { market: m1.short, ...txA, domainRiskUsage: gA });

  // --- B: 240 on a DIFFERENT market/generation, same domain ---------------
  const iB = rest(m2, 240n * K, 2);
  const txB = await exec(wB, B, iB, "AGENT_B 240");
  const gB = await gross();
  log("05-agentB", { market: m2.short, ...txB, domainRiskUsage: gB, ownerTxSinceConfig: (await pub.getTransactionCount({ address: OWNER.address })) - ownerNonceAfterConfig });

  // --- C: 150, individually valid, rejected by aggregate state ------------
  const cCommittedBefore = await pub.readContract({ address: PF, abi: PF_ABI, functionName: "agentCommitted", args: [Cc.address] });
  const iC = rest(m1, 150n * K, 3);
  const rej = await expectRevert("C rejected by CROSS-AGENT domain state", "DomainRiskExceeded", { account: Cc, address: PF, abi: PF_ABI, functionName: "execute", args: [iC] });
  const cCommittedAfter = await pub.readContract({ address: PF, abi: PF_ABI, functionName: "agentCommitted", args: [Cc.address] });
  log("06-agentC-rejected", {
    ...rej,
    arithmetic: `${gA} (A) + ${gB - gA} (B) + ${150n * K} (C) = ${gB + 150n * K} > ${dp.maxDomainRiskUsage}`,
    cCommittedBefore, cCommittedAfter, unchanged: cCommittedBefore === cCommittedAfter,
    domainRiskUsageUnchanged: (await gross()) === gB,
    individualValidity: { cMaxOrderNotional: ap.maxOrderNotional, cMaxCommitted: ap.maxCommitted, note: "C's own policy admits this order in full" },
  });

  // --- hostile C ----------------------------------------------------------
  const asC = (fn, args) => ({ account: Cc, address: PF, abi: PF_ABI, functionName: fn, args });
  const negs = [];
  negs.push(await expectRevert("C: sibling-market switch does not escape the domain", "DomainRiskExceeded", asC("execute", [rest(m2, 150n * K, 21)])));
  negs.push(await expectRevert("C: alternate pool", "PoolMismatch", asC("execute", [{ ...rest(m1, 10n * K, 22), pool: "0x000000000000000000000000000000000000dEaD" }])));
  negs.push(await expectRevert("C: recycled generation", "GenerationMismatch", asC("execute", [{ ...rest(m1, 10n * K, 23), marketNonce: m1.nonce - 1n }])));
  negs.push(await expectRevert("C: price grief", "PriceOutsidePolicy", asC("execute", [{ ...rest(m1, 10n * K, 24), price: 995000n }])));
  negs.push(await expectRevert("C: direct withdrawal", "NotOwner", asC("withdraw", [TUSDC, Cc.address, 1n])));
  negs.push(await expectRevert("C: outcome withdrawal", "NotOwner", asC("withdrawOutcome", [0n, Cc.address, 1n])));
  negs.push(await expectRevert("C: ownerCall escalation", "NotOwner", asC("ownerCall", [TUSDC, 0n, "0x"])));
  negs.push(await expectRevert("C: rewrite another agent's policy", "NotOwner", asC("setAgent", [A.address, ap])));
  negs.push(await expectRevert("C: widen the domain ceiling", "NotOwner", asC("setDomainPolicy", [DOM, { ...dp, maxDomainRiskUsage: 10n ** 30n }])));
  negs.push(await expectRevert("A: replay a used intent", "IntentReplayed", { account: A, address: PF, abi: PF_ABI, functionName: "execute", args: [iA] }));

  const orderIdA = await orderIdOf(txA.hash);
  const keyA = await pub.readContract({ address: PF, abi: PF_ABI, functionName: "orderKey", args: [m1.pool, m1.nonce, orderIdA] });
  negs.push(await expectRevert("C: release another agent's LIVE reservation", "OrderStillLive", asC("releaseOrder", [keyA])));
  log("07-hostile-C", { count: negs.length, negs });

  // --- concurrency: two agents, same block, one headroom ------------------
  await own("setDomainPolicy", [DOM, { ...dp, maxDomainRiskUsage: gB + 100n * K }], "tighten ceiling for the race");
  const raceA = rest(m1, 80n * K, 31), raceB = rest(m2, 80n * K, 32);
  const [rA, rB] = await Promise.allSettled([
    (async () => { const { request } = await pub.simulateContract({ account: A, address: PF, abi: PF_ABI, functionName: "execute", args: [raceA] }); return wA.writeContract(request); })(),
    (async () => { const { request } = await pub.simulateContract({ account: B, address: PF, abi: PF_ABI, functionName: "execute", args: [raceB] }); return wB.writeContract(request); })(),
  ]);
  const raceOut = [];
  for (const [who, r] of [["A", rA], ["B", rB]]) {
    if (r.status === "fulfilled") {
      const rc = await pub.waitForTransactionReceipt({ hash: r.value });
      raceOut.push({ who, hash: r.value, status: rc.status, block: rc.blockNumber?.toString() });
    } else raceOut.push({ who, rejectedPreflight: decodeRevert(r.reason) });
  }
  const gRace = await gross();
  log("08-concurrency-race", { ceiling: (gB + 100n * K).toString(), each: (80n * K).toString(), results: raceOut, domainRiskUsageAfter: gRace, note: "both submitted together; atomic contract state admits only what fits" });

  // --- release A through a real lifecycle path, then C's shape fits -------
  await own("cancelOrder", [m1.pool, orderIdA], "owner cancels A's resting order");
  const { request: rel } = await pub.simulateContract({ account: Cc, address: PF, abi: PF_ABI, functionName: "releaseOrder", args: [keyA] });
  const relTx = await send(wC, rel, "releaseOrder (permissionless, called by C)");
  await own("setDomainPolicy", [DOM, dp], "restore ceiling");
  const gRel = await gross();
  log("09-released", { ...relTx, domainRiskUsage: gRel });

  const iC2 = rest(m1, 150n * K, 41);
  const txC = await exec(wC, Cc, iC2, "AGENT_C 150 (now admissible)");
  const gC = await gross();
  log("10-agentC-admitted", { ...txC, domainRiskUsage: gC, arithmetic: `${gRel} + ${150n * K} = ${gC} <= ${dp.maxDomainRiskUsage}` });

  // --- owner recovery -----------------------------------------------------
  const off = { ...ap, enabled: false };
  for (const [a, n] of [[A.address, "A"], [B.address, "B"], [Cc.address, "C"]]) await own("setAgent", [a, off], `revoke ${n}`);
  for (const [k, h] of [[m2, txB.hash], [m1, txC.hash]]) {
    try { await own("cancelOrder", [k.pool, await orderIdOf(h)], "cancel resting order"); } catch (e) { console.log("  cancel skipped:", String(e.message).slice(0, 70)); }
  }
  const idle = await pub.readContract({ address: TUSDC, abi: erc20, functionName: "balanceOf", args: [PF] });
  await own("withdraw", [TUSDC, OWNER.address, idle], "owner withdraw all");
  log("11-owner-recovery", {
    agentsRevoked: 3, recovered: idle,
    residual: await pub.readContract({ address: TUSDC, abi: erc20, functionName: "balanceOf", args: [PF] }),
  });

  ev.finishedAt = new Date().toISOString();
  ev.portfolio = PF; ev.factory = FACTORY; ev.domain = DOM;
  fs.mkdirSync("evidence/airspace-lock", { recursive: true });
  fs.writeFileSync("evidence/airspace-lock/live-run.json", JSON.stringify(ev, null, 2));
  console.log("\n=== wrote evidence/airspace-lock/live-run.json ===");

  async function orderIdOf(hash) {
    const r = await pub.getTransactionReceipt({ hash });
    const topic = keccak256(toBytes("IntentExecuted(bytes32,bytes32,address,bytes32,bytes32,bytes32,address,uint64,uint8,uint256,uint256,uint128,bytes32)"));
    for (const l of r.logs) {
      if (l.topics[0] !== topic) continue;
      return BigInt("0x" + l.data.slice(2).slice(8 * 64, 9 * 64));
    }
    throw new Error("IntentExecuted not found");
  }
})().catch((e) => {
  console.error("\nFATAL:", e.message);
  ev.fatal = e.message;
  fs.mkdirSync("evidence/airspace-lock", { recursive: true });
  fs.writeFileSync("evidence/airspace-lock/live-run.json", JSON.stringify(ev, null, 2));
  process.exit(1);
});
