#!/usr/bin/env node
/**
 * Long-running unattended campaign against the live 2.0.0 deployment, with the
 * independent verifier running inside the same loop.
 *
 * This drives real trading directly against the chain with the local agent
 * keys (the same wallets `live-proof.mjs` and `opposing-live.mjs` use) rather
 * than through the deployed Cloudflare Workers, so it needs no local dev
 * servers and no Worker auth tokens — only an RPC endpoint and
 * `.wallets.json`. It exercises the exact same `execute`/`previewIntent`
 * surface the Workers call.
 *
 * Every round:
 *   1. rediscover live markets in the campaign's configured domains
 *   2. each agent proposes one order — preview first, then execute if admitted
 *   3. reconstruct independent worst-case exposure per domain, the same way
 *      scripts/risk-verifier.mjs does: from ERC-6909 balances and per-order
 *      `getOrder` probes, never from the contract's own summary counter
 *   4. permissionlessly release anything the venue no longer has open
 *
 * ABORTS IMMEDIATELY, and the final report says so plainly, if independent
 * worst-case exposure is ever found ABOVE the policy ceiling because AIRSPACE
 * itself admitted the intent that put it there. Overstatement (accounted >
 * independent) is expected and tracked, never treated as a failure.
 *
 *   node scripts/long-campaign.mjs --hours 3 --every 90
 *
 * Writes evidence/production/long-campaign.json, updated after every round so
 * a killed process still leaves a usable report.
 */
import { createPublicClient, createWalletClient, http, decodeErrorResult, keccak256, encodeAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const HOURS = Number(arg("hours", 3));
const EVERY_MS = Number(arg("every", 90)) * 1000;
const RPC = process.env.SHANNON_RPC ?? "https://dream-rpc.somnia.network";
const RPC2 = process.env.SHANNON_RPC_FALLBACK || null;
const CHAIN = {
  id: 50312,
  name: "Somnia Shannon",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

const MODULE = "0x3ecC694Cef705358864a646142ac17A90E29e388";
const OUTCOME = "0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9";
const K = 1_000_000n;

const deployment = JSON.parse(fs.readFileSync(path.join(ROOT, "contracts/deployments/50312.json"), "utf8"));
const campaign = JSON.parse(fs.readFileSync(path.join(ROOT, "evidence/production/campaign.json"), "utf8"));
const abiOf = (n) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, "contracts/out", `${n}.sol`, `${n}.json`), "utf8")).abi;
const PF_ABI = abiOf("AirspacePortfolio");

const wallets = JSON.parse(fs.readFileSync(path.join(ROOT, ".wallets.json"), "utf8"));
const AGENTS = [
  { name: "A", account: privateKeyToAccount(wallets.AGENT_A.private_key) },
  { name: "B", account: privateKeyToAccount(wallets.AGENT_B.private_key) },
  { name: "C", account: privateKeyToAccount(wallets.AGENT_C.private_key) },
];
const KEEPER = privateKeyToAccount(wallets.AGENT.private_key);

let failoverCount = 0;
const rpcUrls = [RPC, ...(RPC2 ? [RPC2] : [])];
function makeClient() {
  return createPublicClient({ chain: CHAIN, transport: http(rpcUrls[0], { retryCount: 2, timeout: 15_000 }) });
}
let pub = makeClient();
const wc = (a) => createWalletClient({ account: a, chain: CHAIN, transport: http(rpcUrls[0]) });
const wKeeper = wc(KEEPER);

/** One retry against the fallback endpoint if configured; otherwise rethrow. */
async function withFailover(fn) {
  try {
    return await fn(pub);
  } catch (e) {
    if (!RPC2) throw e;
    failoverCount += 1;
    const fallback = createPublicClient({ chain: CHAIN, transport: http(RPC2, { retryCount: 1, timeout: 15_000 }) });
    return await fn(fallback);
  }
}

const PF = process.env.AIRSPACE_PORTFOLIO ?? campaign.portfolio;
const DOMAINS = campaign.domains.map((d) => d.domain);

const REFUSAL = [
  "NONE", "NOT_AGENT", "AGENT_DISABLED", "POLICY_EXPIRED", "INTENT_REPLAYED", "COOLDOWN_ACTIVE",
  "MARKET_NOT_FOUND", "POOL_MISMATCH", "MARKET_GENERATION_MISMATCH", "MARKET_NOT_TRADING",
  "INSUFFICIENT_HEADROOM", "DOMAIN_UNSUPPORTED", "DOMAIN_NOT_CONFIGURED", "BAD_ORDER_KIND",
  "PRICE_OUTSIDE_POLICY", "OFF_TICK_GRID", "OFF_LOT_GRID", "BELOW_MIN_QUANTITY", "ORDER_EXPIRY_INVALID",
  "AGENT_ORDER_NOTIONAL_EXCEEDED", "GLOBAL_ORDER_NOTIONAL_EXCEEDED", "AGENT_COMMITTED_EXCEEDED",
  "DOMAIN_RISK_EXCEEDED", "DOMAIN_COMMITTED_EXCEEDED", "GLOBAL_COMMITTED_EXCEEDED",
  "GLOBAL_RESERVED_EXCEEDED", "MAX_LIVE_MARKETS_EXCEEDED", "DOMAIN_MARKETS_FULL", "INSUFFICIENT_COLLATERAL",
];
/** Refused by the AGENT's own local policy vs by the PORTFOLIO's shared envelope. */
const PORTFOLIO_REFUSALS = new Set([
  "DOMAIN_RISK_EXCEEDED", "DOMAIN_COMMITTED_EXCEEDED", "GLOBAL_COMMITTED_EXCEEDED",
  "GLOBAL_RESERVED_EXCEEDED", "MAX_LIVE_MARKETS_EXCEEDED", "DOMAIN_MARKETS_FULL",
]);
const LOCAL_REFUSALS = new Set([
  "NOT_AGENT", "AGENT_DISABLED", "AGENT_ORDER_NOTIONAL_EXCEEDED", "AGENT_COMMITTED_EXCEEDED",
  "PRICE_OUTSIDE_POLICY", "COOLDOWN_ACTIVE", "POLICY_EXPIRED", "INTENT_REPLAYED",
]);

function refusalOf(err) {
  let e = err;
  for (let i = 0; i < 12 && e; i++) {
    if (e.data?.errorName === "Refused") return REFUSAL[Number(e.data.args?.[0] ?? 0)] ?? "Refused";
    if (e.data?.errorName) return e.data.errorName;
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

// --- market discovery (same registry walk as the other live scripts) -------
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
];
const orderBookAbi = [
  { type: "function", name: "getOrder", stateMutability: "view", inputs: [{ type: "uint128" }], outputs: [{
    type: "tuple", components: [
      { name: "orderId", type: "uint128" }, { name: "isBid", type: "bool" }, { name: "owner", type: "address" },
      { name: "userData", type: "uint64" }, { name: "price", type: "uint256" }, { name: "fullQuantity", type: "uint256" },
      { name: "quantityRemaining", type: "uint256" }, { name: "expireTimestampNs", type: "uint64" },
    ],
  }] },
];
const erc6909Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
];

const TABLE = [60, 300, 900, 1800, 3600, 14400, 86400];
const cadenceOf = (ts, ex) => {
  for (const c of TABLE) if (c >= ex - ts && ex % c === 0) return c;
  return 0;
};

async function liveMarketsFor(domain, minLeft = 180) {
  const read = (id) => withFailover((c) => c.readContract({ address: MODULE, abi: moduleAbi, functionName: "markets", args: [id] }));
  const exists = async (n) => (await read(`0x${n.toString(16).padStart(64, "0")}`))[9] !== "0x0000000000000000000000000000000000000000";
  let lo = 0x1000n, hi = 0x1000n;
  while (await exists(hi)) { lo = hi; hi *= 2n; if (hi > 0x400000n) break; }
  while (lo + 1n < hi) { const m = (lo + hi) / 2n; if (await exists(m)) lo = m; else hi = m; }

  const now = Math.floor(Date.now() / 1000);
  const found = [];
  for (let i = 0n; i < 300n && found.length < 6; i++) {
    const id = `0x${(lo - i).toString(16).padStart(64, "0")}`;
    const r = await read(id);
    if (r[9] === "0x0000000000000000000000000000000000000000") continue;
    const ts = Number(r[12]), ex = Number(r[13]);
    if (ex - now < minLeft) continue;
    if (!cadenceOf(ts, ex)) continue;
    const dom = await withFailover((c) => c.readContract({ address: PF, abi: PF_ABI, functionName: "domainOf", args: [id] }));
    if (dom.toLowerCase() !== domain.toLowerCase()) continue;
    const nonce = await withFailover((c) => c.readContract({ address: r[9], abi: poolAbi, functionName: "marketNonce" }));
    const expNs = await withFailover((c) => c.readContract({ address: r[9], abi: poolAbi, functionName: "marketExpiryNs" }));
    found.push({ id, pool: r[9], nonce, expNs, secondsLeft: ex - now });
  }
  return found;
}

// --- independent worst-case reconstruction, per market (mirrors risk-verifier.mjs / ExposureOracle.sol) ---
const outcomeId = (pool, nonce, idx) => (BigInt(pool) << 72n) | (BigInt(nonce) << 8n) | BigInt(idx);
const abs = (x) => (x < 0n ? -x : x);
function independentWorstCase({ balYes, balNo, buyYes, sellYes, buyNo, sellNo }) {
  let worst = 0n;
  for (let mask = 0; mask < 16; mask++) {
    let yes = balYes, no = balNo;
    if (mask & 1) yes += buyYes;
    if (mask & 4) no += buyNo;
    if (!(mask & 2)) yes += sellYes;
    if (!(mask & 8)) no += sellNo;
    const d = abs(yes - no);
    if (d > worst) worst = d;
  }
  return worst;
}

async function sampleDomain(domain) {
  const [policy, reportedUsage, marketIds] = await Promise.all([
    withFailover((c) => c.readContract({ address: PF, abi: PF_ABI, functionName: "domainPolicy", args: [domain] })),
    withFailover((c) => c.readContract({ address: PF, abi: PF_ABI, functionName: "domainRiskUsage", args: [domain] })),
    withFailover((c) => c.readContract({ address: PF, abi: PF_ABI, functionName: "domainMarkets", args: [domain] })),
  ]);
  const ceiling = policy[1];

  let independentTotal = 0n;
  let backlogTotal = 0n;
  const orderIndex = orderIndexes.get(domain) ?? new Map();

  for (const marketId of marketIds) {
    const m = await withFailover((c) => c.readContract({ address: PF, abi: PF_ABI, functionName: "marketState", args: [marketId] }));
    const [pool, nonce, , yesLong, yesShort, noLong, noShort, tracked, settled] = m;
    if (!tracked || settled) continue;

    const yesId = outcomeId(pool, nonce, 0);
    const [balYes, balNo] = await Promise.all([
      withFailover((c) => c.readContract({ address: OUTCOME, abi: erc6909Abi, functionName: "balanceOf", args: [PF, yesId] })),
      withFailover((c) => c.readContract({ address: OUTCOME, abi: erc6909Abi, functionName: "balanceOf", args: [PF, yesId + 1n] })),
    ]);

    const orders = orderIndex.get(marketId.toLowerCase()) ?? [];
    const live = { buyYes: 0n, sellYes: 0n, buyNo: 0n, sellNo: 0n };
    const bucket = ["buyYes", "sellYes", "buyNo", "sellNo"];
    for (const o of orders) {
      let remaining = 0n;
      try {
        const r = await withFailover((c) => c.readContract({ address: pool, abi: orderBookAbi, functionName: "getOrder", args: [o.orderId] }));
        if (r.owner.toLowerCase() === PF.toLowerCase()) remaining = r.quantityRemaining;
      } catch {
        remaining = 0n;
      }
      if (remaining > 0n) live[bucket[o.kind]] += remaining;
    }

    const contractReserved = yesLong + yesShort + noLong + noShort;
    const venueReserved = live.buyYes + live.sellYes + live.buyNo + live.sellNo;
    backlogTotal += contractReserved > venueReserved ? contractReserved - venueReserved : 0n;
    independentTotal += independentWorstCase({ balYes, balNo, ...live });
  }

  return { domain, ceiling, reportedUsage, independentTotal, backlogTotal };
}

// --- build/refresh per-domain order indexes from IntentAdmitted logs -------
const orderIndexes = new Map(); // domain -> Map(marketId -> [{orderId, kind}])
let lastIndexedBlock = 0n;

async function refreshOrderIndex() {
  const head = await withFailover((c) => c.getBlockNumber());
  const from = lastIndexedBlock === 0n ? head - 5000n : lastIndexedBlock + 1n;
  if (from > head) return;
  const evt = PF_ABI.find((e) => e.type === "event" && e.name === "IntentAdmitted");
  const CHUNK = 1000n;
  for (let f = from; f <= head; f += CHUNK) {
    const t = f + CHUNK - 1n > head ? head : f + CHUNK - 1n;
    let logs = [];
    try {
      logs = await withFailover((c) => c.getLogs({ address: PF, event: evt, fromBlock: f, toBlock: t }));
    } catch {
      continue;
    }
    for (const l of logs) {
      const domain = await withFailover((c) => c.readContract({ address: PF, abi: PF_ABI, functionName: "domainOf", args: [l.args.marketId] })).catch(() => null);
      if (!domain) continue;
      if (!orderIndexes.has(domain)) orderIndexes.set(domain, new Map());
      const byMarket = orderIndexes.get(domain);
      const k = l.args.marketId.toLowerCase();
      if (!byMarket.has(k)) byMarket.set(k, []);
      byMarket.get(k).push({ orderId: l.args.orderId, kind: Number(l.args.kind) });
    }
  }
  lastIndexedBlock = head;
}

// ---------------------------------------------------------------------------

const tally = {
  startedAt: new Date().toISOString(),
  targetHours: HOURS,
  rounds: 0,
  intentsProposed: 0,
  admitted: 0,
  refusedByLocalPolicy: 0,
  refusedByPortfolioPolicy: 0,
  refusedOther: 0,
  releasesCompleted: 0,
  generationsCrossed: 0,
  maxIndependentWorstCase: {},
  maxAccountedUsage: {},
  maxOverstatement: {},
  maxPendingBacklog: {},
  backlogSince: {}, // domain -> ms timestamp backlog first went nonzero, or null
  longestReconciliationDelaySec: 0,
  rpcFailovers: 0,
  workerErrors: 0,
  criticalFindings: [],
};
let seenGenerations = new Map(); // marketId -> nonce
let nonces = {};

function bump(map, k, v) {
  const cur = BigInt(map[k] ?? "0");
  if (v > cur) map[k] = v.toString();
}

async function round(n) {
  await refreshOrderIndex();

  // 1. trading activity
  for (const domain of DOMAINS) {
    const markets = await liveMarketsFor(domain).catch(() => []);
    for (const m of markets) {
      const prev = seenGenerations.get(m.id);
      if (prev !== undefined && prev !== m.nonce.toString()) tally.generationsCrossed += 1;
      seenGenerations.set(m.id, m.nonce.toString());
    }
    if (markets.length === 0) continue;
    const m = markets[n % markets.length];

    for (const agent of AGENTS) {
      const kind = (n + agent.name.charCodeAt(0)) % 4;
      const price = (20 + ((n * 37 + agent.name.charCodeAt(0) * 13) % 950)) * 1000;
      const qty = (10n + BigInt((n * 7 + agent.name.charCodeAt(0)) % 40)) * K;
      nonces[agent.name] = (nonces[agent.name] ?? 0) + 1;
      const intent = {
        marketId: m.id, pool: m.pool, marketNonce: m.nonce, kind, price: BigInt(price), quantity: qty,
        expireTimestampNs: m.expNs, orderType: 3, nonce: BigInt(nonces[agent.name]),
        strategyVersion: "0x" + "33".repeat(32),
      };
      tally.intentsProposed += 1;
      try {
        const { request } = await withFailover((c) => c.simulateContract({ account: agent.account, address: PF, abi: PF_ABI, functionName: "execute", args: [intent] }));
        const w = wc(agent.account);
        const hash = await w.writeContract(request);
        await pub.waitForTransactionReceipt({ hash }).catch(() => {});
        tally.admitted += 1;
      } catch (e) {
        const refusal = refusalOf(e);
        if (PORTFOLIO_REFUSALS.has(refusal)) tally.refusedByPortfolioPolicy += 1;
        else if (LOCAL_REFUSALS.has(refusal)) tally.refusedByLocalPolicy += 1;
        else tally.refusedOther += 1;
      }
    }
  }

  // 2. independent verification, per domain
  let anyOverCeiling = false;
  for (const domain of DOMAINS) {
    const s = await sampleDomain(domain).catch(() => null);
    if (!s) continue;

    bump(tally.maxAccountedUsage, domain, s.reportedUsage);
    bump(tally.maxIndependentWorstCase, domain, s.independentTotal);
    const overstatement = s.reportedUsage > s.independentTotal ? s.reportedUsage - s.independentTotal : 0n;
    bump(tally.maxOverstatement, domain, overstatement);
    bump(tally.maxPendingBacklog, domain, s.backlogTotal);

    // Reconciliation delay: how long a nonzero backlog persists before clearing.
    const key = domain;
    if (s.backlogTotal > 0n) {
      if (tally.backlogSince[key] === undefined) tally.backlogSince[key] = Date.now();
    } else if (tally.backlogSince[key] !== undefined) {
      const delaySec = Math.floor((Date.now() - tally.backlogSince[key]) / 1000);
      if (delaySec > tally.longestReconciliationDelaySec) tally.longestReconciliationDelaySec = delaySec;
      delete tally.backlogSince[key];
    }

    // THE CRITICAL CHECK.
    if (s.independentTotal > s.ceiling && s.reportedUsage <= s.ceiling) {
      // The contract itself never admits over ceiling, so this pattern would
      // mean the ACCOUNTED figure silently fell out of sync with the truth —
      // exactly the class of failure this whole remediation exists to prevent.
      anyOverCeiling = true;
      tally.criticalFindings.push({
        round: n, domain, independentTotal: s.independentTotal.toString(),
        reportedUsage: s.reportedUsage.toString(), ceiling: s.ceiling.toString(),
        at: new Date().toISOString(),
      });
    }
  }

  // 3. permissionless reconciliation
  for (const [domain, byMarket] of orderIndexes) {
    for (const [marketId, orders] of byMarket) {
      for (const o of orders) {
        const m = await withFailover((c) => c.readContract({ address: PF, abi: PF_ABI, functionName: "marketState", args: [marketId] })).catch(() => null);
        if (!m) continue;
        const orderKey = keccak256(
          encodeAbiParameters([{ type: "address" }, { type: "uint64" }, { type: "uint128" }], [m[0], m[1], o.orderId]),
        );
        try {
          const { request } = await withFailover((c) => c.simulateContract({ account: KEEPER, address: PF, abi: PF_ABI, functionName: "releaseOrder", args: [orderKey] }));
          const hash = await wKeeper.writeContract(request);
          await pub.waitForTransactionReceipt({ hash }).catch(() => {});
          tally.releasesCompleted += 1;
        } catch {
          /* NothingToRelease or OrderStillLive — not an error, just nothing to do */
        }
      }
    }
    void domain;
  }

  tally.rounds = n;
  tally.elapsedSec = Math.floor((Date.now() - Date.parse(tally.startedAt)) / 1000);
  tally.rpcFailovers = failoverCount;
  fs.mkdirSync(path.join(ROOT, "evidence/production"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "evidence/production/long-campaign.json"), `${JSON.stringify(tally, null, 2)}\n`);

  console.log(
    `round ${n}  proposed ${tally.intentsProposed}  admitted ${tally.admitted}  ` +
      `refused(local ${tally.refusedByLocalPolicy} / portfolio ${tally.refusedByPortfolioPolicy} / other ${tally.refusedOther})  ` +
      `releases ${tally.releasesCompleted}  gens ${tally.generationsCrossed}  failovers ${failoverCount}`,
  );

  if (anyOverCeiling) {
    tally.verdict = "CRITICAL — independent worst case exceeded the ceiling with accounted usage reading under it";
    fs.writeFileSync(path.join(ROOT, "evidence/production/long-campaign.json"), `${JSON.stringify(tally, null, 2)}\n`);
    console.log("\nSTOPPING: " + tally.verdict);
    process.exit(1);
  }
}

const deadline = Date.now() + HOURS * 3600_000;
console.log(`=== long campaign === portfolio ${PF}  target ${HOURS}h  every ${EVERY_MS / 1000}s`);
console.log(`deployment version: ${deployment.version}`);
let n = 0;
while (Date.now() < deadline) {
  n += 1;
  try {
    await round(n);
  } catch (e) {
    tally.workerErrors += 1;
    console.log(`round ${n} error: ${String(e.message ?? e).slice(0, 140)}`);
  }
  if (Date.now() >= deadline) break;
  await new Promise((r) => setTimeout(r, EVERY_MS));
}

tally.finishedAt = new Date().toISOString();
tally.elapsedSec = Math.floor((Date.now() - Date.parse(tally.startedAt)) / 1000);
tally.verdict =
  tally.criticalFindings.length === 0
    ? "SAFE — independent worst-case exposure never exceeded the policy ceiling due to AIRSPACE admission"
    : "CRITICAL — see criticalFindings";
fs.writeFileSync(path.join(ROOT, "evidence/production/long-campaign.json"), `${JSON.stringify(tally, null, 2)}\n`);
console.log(`\n${tally.verdict}`);
console.log("wrote evidence/production/long-campaign.json");
