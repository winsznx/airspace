#!/usr/bin/env node
/**
 * AIRSPACE canonical live proof — Somnia Shannon (chainId 50312).
 *
 * One capital pool. Three independent agent keys. One structural risk domain.
 * Against the REAL deployed DreamDEX Event Contracts and the REAL deployed
 * AIRSPACE factory. Nothing is mocked.
 *
 *   domain ceiling 500
 *   A reserves 180        -> 180 / 500
 *   B reserves 240        -> 420 / 500
 *   C proposes 150        -> every local and market gate PASSES
 *                            420 + 150 = 570 > 500  ->  REFUSED
 *   release A             -> 240 / 500
 *   C retries, identical  -> ADMITTED
 *
 * Writes evidence/production/live-proof.json.
 *
 *   node scripts/live-proof.mjs
 */

import { createPublicClient, createWalletClient, http, decodeErrorResult, keccak256, toBytes, encodeAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const RPC = process.env.SHANNON_RPC ?? "https://dream-rpc.somnia.network";
const CHAIN = {
  id: 50312,
  name: "Somnia Shannon",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

const MODULE = "0x3ecC694Cef705358864a646142ac17A90E29e388";
const OUTCOME = "0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9";
const TUSDC = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E";
const ONE = 1_000_000n;
const K = 1_000_000n; // one contract in raw units

const deployment = JSON.parse(fs.readFileSync(path.join(ROOT, "contracts/deployments/50312.json"), "utf8"));
const FACTORY = process.env.AIRSPACE_FACTORY ?? deployment.contracts.AirspacePortfolioFactory;

const abiOf = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, "contracts/out", `${n}.sol`, `${n}.json`), "utf8")).abi;
const PF_ABI = abiOf("AirspacePortfolio");
const FAC_ABI = abiOf("AirspacePortfolioFactory");

const wallets = JSON.parse(fs.readFileSync(path.join(ROOT, ".wallets.json"), "utf8"));
const OWNER = privateKeyToAccount(wallets.OWNER.private_key);
const A = privateKeyToAccount(wallets.AGENT_A.private_key);
const B = privateKeyToAccount(wallets.AGENT_B.private_key);
const C = privateKeyToAccount(wallets.AGENT_C.private_key);

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });
const wc = (a) => createWalletClient({ account: a, chain: CHAIN, transport: http(RPC) });
const [wO, wA, wB, wC] = [OWNER, A, B, C].map(wc);

const ev = {
  chainId: 50312,
  startedAt: new Date().toISOString(),
  factory: FACTORY,
  implementation: deployment.contracts.AirspacePortfolio_implementation,
  actors: { owner: OWNER.address, agentA: A.address, agentB: B.address, agentC: C.address },
  steps: [],
};
const J = (o) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
const log = (name, data) => {
  console.log(`\n[${name}]`, JSON.stringify(J(data), null, 1));
  ev.steps.push({ name, ...J(data) });
};

async function send(w, req, label) {
  const hash = await w.writeContract(req);
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`  ${label}: ${hash} ${r.status}`);
  if (r.status !== "success") throw new Error(`${label} reverted (${hash})`);
  return { hash, status: r.status, blockNumber: r.blockNumber, gasUsed: r.gasUsed };
}

const REFUSAL = [
  "NONE", "NOT_AGENT", "AGENT_DISABLED", "POLICY_EXPIRED", "INTENT_REPLAYED", "COOLDOWN_ACTIVE",
  "MARKET_NOT_FOUND", "POOL_MISMATCH", "MARKET_GENERATION_MISMATCH", "MARKET_NOT_TRADING",
  "INSUFFICIENT_HEADROOM", "DOMAIN_UNSUPPORTED", "DOMAIN_NOT_CONFIGURED", "BAD_ORDER_KIND",
  "PRICE_OUTSIDE_POLICY", "OFF_TICK_GRID", "OFF_LOT_GRID", "BELOW_MIN_QUANTITY", "ORDER_EXPIRY_INVALID",
  "AGENT_ORDER_NOTIONAL_EXCEEDED", "GLOBAL_ORDER_NOTIONAL_EXCEEDED", "AGENT_COMMITTED_EXCEEDED",
  "DOMAIN_RISK_EXCEEDED", "DOMAIN_COMMITTED_EXCEEDED", "GLOBAL_COMMITTED_EXCEEDED",
  "GLOBAL_RESERVED_EXCEEDED", "MAX_LIVE_MARKETS_EXCEEDED", "DOMAIN_MARKETS_FULL", "INSUFFICIENT_COLLATERAL",
];

function refusalOf(err) {
  let e = err;
  for (let i = 0; i < 10 && e; i++) {
    if (e.name === "ContractFunctionRevertedError" && e.data?.errorName === "Refused") {
      return REFUSAL[Number(e.data.args?.[0] ?? 0)] ?? `code(${e.data.args?.[0]})`;
    }
    if (e.name === "ContractFunctionRevertedError" && e.data?.errorName) return e.data.errorName;
    e = e.cause;
  }
  e = err;
  for (let i = 0; i < 10 && e; i++) {
    const raw = typeof e?.data === "string" ? e.data : e?.data?.data;
    if (typeof raw === "string" && raw.length >= 10) {
      try {
        const d = decodeErrorResult({ abi: PF_ABI, data: raw });
        return d.errorName === "Refused" ? (REFUSAL[Number(d.args[0])] ?? "Refused") : d.errorName;
      } catch {
        return `undecoded(${raw.slice(0, 10)})`;
      }
    }
    e = e.cause;
  }
  return "unknown";
}

async function expectRefusal(label, expected, call) {
  try {
    await pub.simulateContract(call);
    throw new Error(`${label}: expected ${expected} but the call SUCCEEDED`);
  } catch (e) {
    if (e.message?.includes("but the call SUCCEEDED")) throw e;
    const got = refusalOf(e);
    const ok = got === expected;
    console.log(`  ${ok ? "PASS" : "FAIL"} ${label}: ${got}`);
    if (!ok) throw new Error(`${label}: expected ${expected}, got ${got}`);
    return { label, expected, got };
  }
}

// --- market discovery straight from the module registry (no indexer) --------
const moduleAbi = [
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
const poolAbi = [
  { type: "function", name: "marketNonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "marketExpiryNs", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  {
    type: "function", name: "getBookLevels", stateMutability: "view",
    inputs: [{ type: "bool" }, { type: "uint64" }],
    outputs: [{ type: "tuple[]", components: [{ name: "price", type: "uint256" }, { name: "quantity", type: "uint256" }] }],
  },
];
const erc20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];

const TABLE = [60, 300, 900, 1800, 3600, 14400, 86400];
const cadenceOf = (ts, ex) => {
  const w = ex - ts;
  for (const c of TABLE) if (c >= w && ex % c === 0) return c;
  return 0;
};

const readMarket = async (id) =>
  pub.readContract({ address: MODULE, abi: moduleAbi, functionName: "markets", args: [id] });

async function findDomainPair() {
  const exists = async (n) => {
    const r = await readMarket(`0x${n.toString(16).padStart(64, "0")}`);
    return r[9] !== "0x0000000000000000000000000000000000000000";
  };
  let lo = 0x1000n, hi = 0x1000n;
  while (await exists(hi)) { lo = hi; hi *= 2n; if (hi > 0x400000n) break; }
  while (lo + 1n < hi) { const m = (lo + hi) / 2n; if (await exists(m)) lo = m; else hi = m; }

  const now = Math.floor(Date.now() / 1000);
  const byDomain = new Map();
  for (let i = 0n; i < 400n; i++) {
    const id = `0x${(lo - i).toString(16).padStart(64, "0")}`;
    const r = await readMarket(id);
    const pool = r[9];
    if (pool === "0x0000000000000000000000000000000000000000") continue;
    const ts = Number(r[12]), ex = Number(r[13]);
    if (ex - now < 420) continue; // enough runway for the whole sequence
    const cad = cadenceOf(ts, ex);
    if (!cad) continue;
    const key = `${r[7]}|${r[3]}|${cad}`;
    const entry = { id, pool, creator: r[7], collateral: r[3], ts, ex, cad, left: ex - now };
    if (!byDomain.has(key)) byDomain.set(key, []);
    byDomain.get(key).push(entry);
    const list = byDomain.get(key);
    if (list.length >= 2) return list.slice(0, 2);
  }
  throw new Error("could not find two live markets sharing one structural domain");
}

// ---------------------------------------------------------------------------

(async () => {
  console.log("=== AIRSPACE canonical live proof ===");
  console.log("factory:", FACTORY);

  const [m1, m2] = await findDomainPair();
  for (const m of [m1, m2]) {
    m.nonce = await pub.readContract({ address: m.pool, abi: poolAbi, functionName: "marketNonce" });
    m.expNs = await pub.readContract({ address: m.pool, abi: poolAbi, functionName: "marketExpiryNs" });
    const bids = await pub.readContract({ address: m.pool, abi: poolAbi, functionName: "getBookLevels", args: [true, 1n] });
    m.bestBid = bids.length ? bids[0].price : 0n;
  }
  log("00-markets", {
    domainInputs: { creator: m1.creator, collateral: m1.collateral, cadenceSec: m1.cad },
    m1: { id: m1.id, pool: m1.pool, generation: m1.nonce, secondsLeft: m1.left },
    m2: { id: m2.id, pool: m2.pool, generation: m2.nonce, secondsLeft: m2.left },
    note: "two markets, two pools, two generations, ONE structural domain",
  });

  // 1. create the portfolio
  const salt = keccak256(toBytes(`airspace-proof-${Date.now()}`));
  const { request: cr } = await pub.simulateContract({
    account: OWNER, address: FACTORY, abi: FAC_ABI, functionName: "createPortfolio", args: [OWNER.address, salt],
  });
  const crTx = await send(wO, cr, "createPortfolio");
  const PF = await pub.readContract({ address: FACTORY, abi: FAC_ABI, functionName: "portfolioFor", args: [OWNER.address, salt] });
  log("01-portfolio", { portfolio: PF, ...crTx });

  const own = async (fn, args, label) => {
    const { request } = await pub.simulateContract({ account: OWNER, address: PF, abi: PF_ABI, functionName: fn, args });
    return send(wO, request, label);
  };
  const exec = async (w, acct, intent, label) => {
    const { request } = await pub.simulateContract({ account: acct, address: PF, abi: PF_ABI, functionName: "execute", args: [intent] });
    return send(w, request, label);
  };
  const usage = (d) => pub.readContract({ address: PF, abi: PF_ABI, functionName: "domainRiskUsage", args: [d] });

  // 2. the domain is DERIVED on-chain; no attestation is supplied anywhere
  const DOM = await pub.readContract({ address: PF, abi: PF_ABI, functionName: "domainOf", args: [m1.id] });
  const DOM2 = await pub.readContract({ address: PF, abi: PF_ABI, functionName: "domainOf", args: [m2.id] });
  const DOMK = await pub.readContract({ address: PF, abi: PF_ABI, functionName: "domainKey", args: [m1.creator, m1.collateral, m1.cad] });
  if (DOM !== DOM2 || DOM !== DOMK) throw new Error("structural domain derivation disagreed");
  log("02-structural-domain", {
    domain: DOM, siblingsShareDomain: DOM === DOM2, matchesCreatorCollateralCadence: DOM === DOMK,
    note: "derived from module.markets() at call time: no indexer, no asset string, no attestation",
  });

  // 3. fund and configure
  await own("ownerCall", [TUSDC, 0n, "0x57915897" + (6000n * ONE).toString(16).padStart(64, "0")], "fund (faucet 6000 tUSDC)");
  const funded = await pub.readContract({ address: TUSDC, abi: erc20, functionName: "balanceOf", args: [PF] });
  await own("setCapitalBase", [funded], "setCapitalBase");

  const now = Math.floor(Date.now() / 1000);
  const gp = {
    maxCommittedCapital: 5000n * ONE, maxReservedCollateral: 5000n * ONE, maxSingleOrderNotional: 3000n * ONE,
    maxBuyPrice: 990000n, minSellPrice: 10000n, minHeadroomSec: 30n, policyExpiry: BigInt(now + 7200),
  };
  const dp = { configured: true, maxDomainRiskUsage: 500n * K, maxDomainCommitted: 0n, maxLiveMarkets: 0 };
  const ap = {
    enabled: true, maxCommitted: 4000n * ONE, maxOrderNotional: 3000n * ONE,
    maxBuyPrice: 990000n, minSellPrice: 10000n, cooldownSec: 0n, strategyVersion: undefined,
    strategyId: keccak256(toBytes("proof")),
  };

  await own("setGlobalPolicy", [gp], "setGlobalPolicy");
  await own("setDomainPolicy", [DOM, dp], "setDomainPolicy (ONE call, covers the series forever)");
  for (const [addr, n] of [[A.address, "A"], [B.address, "B"], [C.address, "C"]]) await own("setAgent", [addr, ap], `setAgent ${n}`);
  const ownerNonceAfterConfig = await pub.getTransactionCount({ address: OWNER.address });
  log("03-configured", { capitalBase: funded, domain: DOM, domainCeiling: dp.maxDomainRiskUsage, agents: 3 });

  const rest = (m, contracts, nonce) => {
    let px = m.bestBid > 40000n ? m.bestBid - 40000n : 10000n;
    px = (px / 1000n) * 1000n;
    if (px < 1000n) px = 1000n;
    return {
      marketId: m.id, pool: m.pool, marketNonce: m.nonce, kind: 0, price: px, quantity: contracts,
      expireTimestampNs: m.expNs, orderType: 3, nonce: BigInt(nonce), strategyVersion: keccak256(toBytes("proof/v1")),
    };
  };

  // 4. A reserves 180
  const iA = rest(m1, 180n * K, 1);
  const txA = await exec(wA, A, iA, "AGENT_A 180");
  log("04-agentA", { market: m1.id, ...txA, domainRiskUsage: await usage(DOM) });

  // 5. B reserves 240 on a DIFFERENT market and generation, same domain
  const iB = rest(m2, 240n * K, 1);
  const txB = await exec(wB, B, iB, "AGENT_B 240");
  const g420 = await usage(DOM);
  log("05-agentB", {
    market: m2.id, ...txB, domainRiskUsage: g420,
    ownerTxSinceConfig: (await pub.getTransactionCount({ address: OWNER.address })) - ownerNonceAfterConfig,
    note: "a second market entered the SAME domain with zero owner transactions",
  });

  // 6. C proposes 150 — individually valid, refused by aggregate state
  const iC = rest(m1, 150n * K, 1);
  const preview = await pub.readContract({ address: PF, abi: PF_ABI, functionName: "previewIntent", args: [C.address, iC] });
  const committedBefore = await pub.readContract({ address: PF, abi: PF_ABI, functionName: "agentCommitted", args: [C.address] });
  const rej = await expectRefusal("C refused by CROSS-AGENT portfolio state", "DOMAIN_RISK_EXCEEDED", {
    account: C, address: PF, abi: PF_ABI, functionName: "execute", args: [iC],
  });
  const committedAfter = await pub.readContract({ address: PF, abi: PF_ABI, functionName: "agentCommitted", args: [C.address] });

  const GATE = { AGENT_POLICY: 1 << 1, MARKET_TRADING: 1 << 3, GENERATION: 1 << 4, GRID: 1 << 5, PRICE: 1 << 6, HEADROOM: 1 << 7, DOMAIN_CAPACITY: 1 << 9 };
  const gates = Number(preview.gates);
  log("06-agentC-REFUSED", {
    ...rej,
    arithmetic: `${g420} (A+B) + ${150n * K} (C) = ${g420 + 150n * K} > ${dp.maxDomainRiskUsage} ceiling`,
    gatesFromContract: {
      agentPolicy: !!(gates & GATE.AGENT_POLICY),
      marketTrading: !!(gates & GATE.MARKET_TRADING),
      marketGeneration: !!(gates & GATE.GENERATION),
      tickLot: !!(gates & GATE.GRID),
      priceCeiling: !!(gates & GATE.PRICE),
      marketHeadroom: !!(gates & GATE.HEADROOM),
      portfolioDomain: !!(gates & GATE.DOMAIN_CAPACITY),
    },
    domainUsageBefore: preview.domainUsageBefore,
    domainUsageAfter: preview.domainUsageAfter,
    domainCeiling: preview.domainCeiling,
    cCommittedBefore: committedBefore,
    cCommittedAfter: committedAfter,
    stateUnchangedByRefusal: committedBefore === committedAfter && (await usage(DOM)) === g420,
  });

  // 7. hostile C
  const asC = (fn, args) => ({ account: C, address: PF, abi: PF_ABI, functionName: fn, args });
  const negs = [];
  negs.push(await expectRefusal("C: sibling-market switch does not escape the ceiling", "DOMAIN_RISK_EXCEEDED", asC("execute", [rest(m2, 150n * K, 2)])));
  negs.push(await expectRefusal("C: alternate pool", "POOL_MISMATCH", asC("execute", [{ ...rest(m1, 10n * K, 3), pool: "0x000000000000000000000000000000000000dEaD" }])));
  negs.push(await expectRefusal("C: recycled generation", "MARKET_GENERATION_MISMATCH", asC("execute", [{ ...rest(m1, 10n * K, 4), marketNonce: m1.nonce - 1n }])));
  negs.push(await expectRefusal("C: price grief", "PRICE_OUTSIDE_POLICY", asC("execute", [{ ...rest(m1, 10n * K, 5), price: 995000n }])));
  negs.push(await expectRefusal("C: off the tick grid", "OFF_TICK_GRID", asC("execute", [{ ...rest(m1, 10n * K, 6), price: rest(m1, 0n, 0).price + 1n }])));
  negs.push(await expectRefusal("C: direct collateral withdrawal", "NotOwner", asC("withdraw", [TUSDC, C.address, 1n])));
  negs.push(await expectRefusal("C: outcome-token withdrawal", "NotOwner", asC("withdrawOutcome", [0n, C.address, 1n])));
  negs.push(await expectRefusal("C: ownerCall escalation", "NotOwner", asC("ownerCall", [TUSDC, 0n, "0x"])));
  negs.push(await expectRefusal("C: rewrite another agent's policy", "NotOwner", asC("setAgent", [A.address, ap])));
  negs.push(await expectRefusal("C: widen the domain ceiling", "NotOwner", asC("setDomainPolicy", [DOM, { ...dp, maxDomainRiskUsage: 10n ** 30n }])));
  negs.push(await expectRefusal("A: replay a used intent", "INTENT_REPLAYED", { account: A, address: PF, abi: PF_ABI, functionName: "execute", args: [iA] }));

  const orderIdA = await orderIdOf(txA.hash);
  const keyA = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint64" }, { type: "uint128" }], [m1.pool, m1.nonce, orderIdA]));
  negs.push(await expectRefusal("C: release a rival's LIVE reservation", "OrderStillLive", asC("releaseOrder", [keyA])));
  log("07-hostile-agent-C", { count: negs.length, results: negs });

  // 8. release A through a real lifecycle path
  await own("cancelOrder", [m1.pool, orderIdA], "owner cancels A's resting order");
  const { request: rel } = await pub.simulateContract({ account: C, address: PF, abi: PF_ABI, functionName: "releaseOrder", args: [keyA] });
  const relTx = await send(wC, rel, "releaseOrder (permissionless, called by agent C)");
  const gRel = await usage(DOM);
  log("08-released", { ...relTx, domainRiskUsage: gRel, note: "release is permissionless but non-discretionary: the pool supplies the number" });

  // 9. the identical C intent is now admitted
  const iC2 = rest(m1, 150n * K, 7);
  const txC = await exec(wC, C, iC2, "AGENT_C 150 (identical shape, now admissible)");
  const gC = await usage(DOM);
  log("09-agentC-ADMITTED", { ...txC, domainRiskUsage: gC, arithmetic: `${gRel} + ${150n * K} = ${gC} <= ${dp.maxDomainRiskUsage}` });

  // 10. owner recovery with every agent revoked
  for (const [addr, n] of [[A.address, "A"], [B.address, "B"], [C.address, "C"]]) await own("revokeAgent", [addr], `revoke ${n}`);
  for (const [m, h] of [[m2, txB.hash], [m1, txC.hash]]) {
    try { await own("cancelOrder", [m.pool, await orderIdOf(h)], "cancel resting order"); } catch (e) { console.log("  cancel skipped:", String(e.message).slice(0, 70)); }
  }
  const idle = await pub.readContract({ address: TUSDC, abi: erc20, functionName: "balanceOf", args: [PF] });
  await own("withdraw", [TUSDC, OWNER.address, idle], "owner withdraw all collateral");
  log("10-owner-recovery", {
    agentsRevoked: 3, recovered: idle,
    residual: await pub.readContract({ address: TUSDC, abi: erc20, functionName: "balanceOf", args: [PF] }),
    note: "recovery reads no policy, agent, domain or market state",
  });

  ev.portfolio = PF;
  ev.domain = DOM;
  ev.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.join(ROOT, "evidence/production"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "evidence/production/live-proof.json"), JSON.stringify(ev, null, 2));
  console.log("\n=== wrote evidence/production/live-proof.json ===");

  async function orderIdOf(hash) {
    const r = await pub.getTransactionReceipt({ hash });
    const topic = keccak256(toBytes("IntentAdmitted(bytes32,bytes32,address,bytes32,address,uint64,uint8,uint256,uint256,uint128,bytes32)"));
    for (const l of r.logs) {
      if (l.topics[0] !== topic) continue;
      const d = l.data.slice(2);
      // non-indexed: domain, pool, marketNonce, kind, price, quantity, orderId, strategyVersion
      return BigInt("0x" + d.slice(6 * 64, 7 * 64));
    }
    throw new Error("IntentAdmitted log not found");
  }
})().catch((e) => {
  console.error("\nFATAL:", e.message);
  ev.fatal = e.message;
  fs.mkdirSync(path.join(ROOT, "evidence/production"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "evidence/production/live-proof.json"), JSON.stringify(ev, null, 2));
  process.exit(1);
});
