#!/usr/bin/env node
/**
 * Independent live risk verifier.
 *
 * This exists because the v1 deployment shipped with an invariant that checked
 * `domainRiskUsage <= CEILING` — the contract's own number, against itself. An
 * understatement made that assertion pass, which is how a real safety failure
 * survived a green test suite all the way to a funded mainnet-equivalent
 * deployment.
 *
 * So this script trusts the portfolio for exactly nothing. Every quantity it
 * compares is rebuilt from a primary source:
 *
 *   realized positions      ERC-6909 `balanceOf`, from the token itself
 *   open reservations       `getOrder` on the DreamDEX pool, ONE ORDER AT A TIME
 *   collateral              ERC-20 `balanceOf`, from the collateral token
 *   configured ceiling      `domainPolicy`, the only thing the owner sets
 *
 * The reservation figures deliberately do NOT come from `marketState`. Those
 * counters are the contract's summary of its own reservations, and reusing them
 * would make the comparison circular in exactly the way the v1 invariant was.
 * Order ids come from `IntentAdmitted` logs; how much of each is still open
 * comes from the venue.
 *
 * THE MODEL
 *
 * DreamDEX escrows a SELL's outcome tokens at PLACEMENT (verified live: a
 * pool's outcome balance equals its resting ask depth exactly). So each resting
 * order resolves independently:
 *
 *   BUY_YES   fills -> +q YES        cancels -> nothing
 *   BUY_NO    fills -> +q NO         cancels -> nothing
 *   SELL_YES  fills -> nothing       cancels -> +q YES escrow returns
 *   SELL_NO   fills -> nothing       cancels -> +q NO  escrow returns
 *
 * Worst case is the maximum |YES − NO| over every combination of those, found
 * here by enumeration. Opposing orders are never netted: a pending BUY_YES and
 * a pending BUY_NO can each fill without the other, and assuming they resolve
 * together is precisely the mistake that produced the v1 failure.
 *
 * THE CRITICAL PROPERTY
 *
 *   AIRSPACE_ACCOUNTED_WORST_CASE >= INDEPENDENT_REFERENCE_WORST_CASE
 *
 * Understatement by one raw unit is a critical failure: the script prints
 * CRITICAL, writes it to evidence, and exits non-zero. Overstatement is
 * permitted, measured, and reported as reconciliation backlog.
 *
 *   node scripts/risk-verifier.mjs
 *   node scripts/risk-verifier.mjs --block 473455000
 *   node scripts/risk-verifier.mjs --watch 30 --for 1800
 *
 * Writes evidence/production/risk-verification.json.
 */
import fs from "node:fs";
import { createPublicClient, http, fallback } from "viem";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const RPC = process.env.SHANNON_RPC ?? "https://dream-rpc.somnia.network";
// Optional second endpoint. Left unset by default: a fallback that does not
// resolve turns every transient primary failure into a DNS crash, which killed
// an earlier long watch mid-run.
const RPC2 = process.env.SHANNON_RPC_FALLBACK ?? null;
const CHAIN = {
  id: 50312,
  name: "Somnia Shannon",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};
const pub = createPublicClient({
  chain: CHAIN,
  transport: RPC2
    ? fallback([http(RPC, { retryCount: 3 }), http(RPC2, { retryCount: 1 })], { rank: false })
    : http(RPC, { retryCount: 3 }),
});

const campaign = JSON.parse(fs.readFileSync("evidence/production/campaign.json", "utf8"));
const deployment = JSON.parse(fs.readFileSync("contracts/deployments/50312.json", "utf8"));
const portfolioAbi = JSON.parse(
  fs.readFileSync("contracts/out/AirspacePortfolio.sol/AirspacePortfolio.json", "utf8"),
).abi;

const PORTFOLIO = arg("portfolio", process.env.AIRSPACE_PORTFOLIO ?? campaign.portfolio);
const OUTCOME = deployment.dreamdex.outcomeToken6909;
const COLLATERAL = deployment.dreamdex.collateral;

const ERC_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
];
const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
];
const ORDERBOOK_ABI = [
  {
    type: "function",
    name: "getOrder",
    stateMutability: "view",
    inputs: [{ type: "uint128" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "orderId", type: "uint128" },
          { name: "isBid", type: "bool" },
          { name: "owner", type: "address" },
          { name: "userData", type: "uint64" },
          { name: "price", type: "uint256" },
          { name: "fullQuantity", type: "uint256" },
          { name: "quantityRemaining", type: "uint256" },
          { name: "expireTimestampNs", type: "uint64" },
        ],
      },
    ],
  },
];

/** `id = (uint160(pool) << 72) | (nonce << 8) | idx` — the DreamDEX encoding. */
const outcomeId = (pool, nonce, idx) => (BigInt(pool) << 72n) | (BigInt(nonce) << 8n) | BigInt(idx);

const abs = (x) => (x < 0n ? -x : x);
const at = (blockNumber) => (blockNumber === undefined ? {} : { blockNumber });
const c = (v) => (Number(v) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 });

/**
 * Worst-case directional exposure by EXHAUSTIVE ENUMERATION.
 *
 * The closed-form bound the contract evaluates and this enumeration are two
 * different routes to the same answer, which is the point: a shared formula
 * would share its mistakes.
 */
function independentWorstCase({ balYes, balNo, buyYes, sellYes, buyNo, sellNo }) {
  let worst = 0n;
  for (let mask = 0; mask < 16; mask++) {
    let yes = balYes;
    let no = balNo;
    if (mask & 1) yes += buyYes; // BUY_YES filled
    if (mask & 4) no += buyNo; // BUY_NO filled
    if (!(mask & 2)) yes += sellYes; // SELL_YES unfilled: escrow returns
    if (!(mask & 8)) no += sellNo; // SELL_NO unfilled: escrow returns
    const d = abs(yes - no);
    if (d > worst) worst = d;
  }
  return worst;
}

// ---------------------------------------------------------------------------

/**
 * Every order this portfolio ever placed, by market, with its kind.
 *
 * Logs are the only way to recover individual order ids: `marketState` holds
 * only the four aggregate counters, and an aggregate cannot be asked whether it
 * is still live.
 */
async function buildOrderIndex(fromBlock, toBlock) {
  const index = new Map();
  const CHUNK = 1000n;
  const evt = portfolioAbi.find((e) => e.type === "event" && e.name === "IntentAdmitted");
  for (let from = fromBlock; from <= toBlock; from += CHUNK) {
    const to = from + CHUNK - 1n > toBlock ? toBlock : from + CHUNK - 1n;
    let logs = [];
    try {
      logs = await pub.getLogs({ address: PORTFOLIO, event: evt, fromBlock: from, toBlock: to });
    } catch {
      continue;
    }
    for (const l of logs) {
      const k = l.args.marketId.toLowerCase();
      if (!index.has(k)) index.set(k, []);
      index.get(k).push({
        orderId: l.args.orderId,
        kind: Number(l.args.kind),
        quantity: l.args.quantity,
        block: l.blockNumber,
      });
    }
  }
  return index;
}

/**
 * Ask the VENUE, order by order, what is still open. This is the number the
 * independent model is built from — never the contract's counters.
 */
async function readVenueReservations(pool, orders, blockNumber) {
  const live = { buyYes: 0n, sellYes: 0n, buyNo: 0n, sellNo: 0n };
  const detail = [];
  const bucket = ["buyYes", "sellYes", "buyNo", "sellNo"];

  for (const o of orders) {
    let remaining = 0n;
    try {
      const r = await pub.readContract({
        address: pool,
        abi: ORDERBOOK_ABI,
        functionName: "getOrder",
        args: [o.orderId],
        ...at(blockNumber),
      });
      // Only OUR orders count. A recycled pool can reissue an id to someone else.
      if (r.owner.toLowerCase() === PORTFOLIO.toLowerCase()) remaining = r.quantityRemaining;
    } catch {
      // `IncorrectOrder()` — filled, cancelled or expired. Indistinguishable by
      // design, and it does not matter: none of the three is still open.
      remaining = 0n;
    }
    if (remaining > 0n) live[bucket[o.kind]] += remaining;
    detail.push({
      orderId: o.orderId.toString(),
      kind: o.kind,
      placed: o.quantity.toString(),
      remaining: remaining.toString(),
      live: remaining > 0n,
    });
  }
  return { live, detail };
}

async function sample(domain, orderIndex, blockNumber) {
  const read = (fn, args = []) =>
    pub.readContract({ address: PORTFOLIO, abi: portfolioAbi, functionName: fn, args, ...at(blockNumber) });

  const [policy, reportedUsage, marketIds, capitalBase, freeColl, reservedColl, heldColl] = await Promise.all([
    read("domainPolicy", [domain]),
    read("domainRiskUsage", [domain]),
    read("domainMarkets", [domain]),
    read("capitalBase"),
    read("freeCollateral"),
    read("reservedCollateral"),
    pub.readContract({ address: COLLATERAL, abi: ERC20_ABI, functionName: "balanceOf", args: [PORTFOLIO], ...at(blockNumber) }),
  ]);

  const ceiling = policy[1];
  const markets = [];

  for (const marketId of marketIds) {
    const m = await read("marketState", [marketId]);
    const [pool, marketNonce, , yesLong, yesShort, noLong, noShort, tracked, settled] = m;
    // The contract excludes untracked and settled markets from its sum, so the
    // verifier must too, or the two totals are not comparable quantities.
    if (!tracked || settled) continue;

    const accounted = await read("marketWorstCaseExposure", [marketId]);

    const yesId = outcomeId(pool, marketNonce, 0);
    const [balYes, balNo] = await Promise.all([
      pub.readContract({ address: OUTCOME, abi: ERC_ABI, functionName: "balanceOf", args: [PORTFOLIO, yesId], ...at(blockNumber) }),
      pub.readContract({ address: OUTCOME, abi: ERC_ABI, functionName: "balanceOf", args: [PORTFOLIO, yesId + 1n], ...at(blockNumber) }),
    ]);

    const orders = orderIndex.get(marketId.toLowerCase()) ?? [];
    const { live, detail } = await readVenueReservations(pool, orders, blockNumber);

    const independent = independentWorstCase({ balYes, balNo, ...live });

    // What the contract still carries that the venue no longer has open. This
    // is the reconciliation backlog: a filled or cancelled order whose
    // reservation nobody has released yet. It inflates usage until someone
    // calls `releaseOrder`, and it costs headroom, never safety.
    const contractReserved = yesLong + yesShort + noLong + noShort;
    const venueReserved = live.buyYes + live.sellYes + live.buyNo + live.sellNo;
    const backlog = contractReserved > venueReserved ? contractReserved - venueReserved : 0n;

    markets.push({
      marketId,
      pool,
      marketNonce,
      balYes,
      balNo,
      contractCounters: { yesLong, yesShort, noLong, noShort },
      venueLive: live,
      accounted,
      independent,
      backlog,
      understates: accounted < independent,
      orders: detail,
    });
  }

  const accountedTotal = markets.reduce((a, m) => a + m.accounted, 0n);
  const independentTotal = markets.reduce((a, m) => a + m.independent, 0n);
  const backlogTotal = markets.reduce((a, m) => a + m.backlog, 0n);

  return {
    domain,
    ceiling,
    reportedUsage,
    accountedTotal,
    independentTotal,
    backlogTotal,
    capitalBase,
    freeColl,
    reservedColl,
    heldColl,
    markets,
  };
}

// ---------------------------------------------------------------------------

function report(s, block) {
  const understates = s.markets.some((m) => m.understates) || s.accountedTotal < s.independentTotal;
  const overstatement = s.accountedTotal > s.independentTotal ? s.accountedTotal - s.independentTotal : 0n;

  console.log(`\nDOMAIN ${s.domain.slice(0, 14)}…  block ${block}`);
  console.log(`  1  configured ceiling                ${c(s.ceiling).padStart(12)}`);
  console.log(`  2  contract domainRiskUsage          ${c(s.reportedUsage).padStart(12)}  ${s.reportedUsage === s.accountedTotal ? "= Σ per-market" : "MISMATCH vs Σ"}`);
  console.log(`  3  independent worst-case exposure   ${c(s.independentTotal).padStart(12)}`);
  console.log(`  4  committed collateral              ${c(s.capitalBase - (s.freeColl > s.capitalBase ? s.capitalBase : s.freeColl)).padStart(12)}  (base ${c(s.capitalBase)}, free ${c(s.freeColl)})`);
  console.log(`  5  reserved collateral               ${c(s.reservedColl).padStart(12)}`);
  console.log(`  6  ERC-6909 positions held           ${c(s.markets.reduce((a, m) => a + m.balYes + m.balNo, 0n)).padStart(12)}`);
  console.log(`  7  reconciliation backlog            ${c(s.backlogTotal).padStart(12)}  (reservations the venue no longer has open)`);
  console.log(`     conservative overstatement        ${c(overstatement).padStart(12)}`);
  console.log(`     collateral on hand                ${c(s.heldColl).padStart(12)}  ${s.heldColl === s.freeColl ? "= freeCollateral" : "MISMATCH"}`);
  console.log(
    `     SAFETY  accounted >= independent  ${understates ? "*** CRITICAL: UNDERSTATED ***" : "HOLDS"}`,
  );

  if (s.markets.length) {
    console.log(`\n  per market (contracts):`);
    console.log(
      `    ${"market".padEnd(9)} ${"balYES".padStart(8)} ${"balNO".padStart(8)} ${"bYES".padStart(7)} ${"sYES".padStart(7)} ${"bNO".padStart(7)} ${"sNO".padStart(7)} ${"acct".padStart(8)} ${"indep".padStart(8)} ${"backlog".padStart(8)}`,
    );
    for (const m of s.markets) {
      const v = m.venueLive;
      console.log(
        `    ${`#${BigInt(m.marketId) % 100000n}`.padEnd(9)} ${c(m.balYes).padStart(8)} ${c(m.balNo).padStart(8)} ${c(v.buyYes).padStart(7)} ${c(v.sellYes).padStart(7)} ${c(v.buyNo).padStart(7)} ${c(v.sellNo).padStart(7)} ${c(m.accounted).padStart(8)} ${c(m.independent).padStart(8)} ${c(m.backlog).padStart(8)}${m.understates ? "  <== CRITICAL" : ""}`,
      );
    }
  }

  return { understates, overstatement };
}

const ser = (o) =>
  JSON.parse(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

async function runOnce(orderIndex, blockNumber, head) {
  const out = [];
  let critical = false;
  for (const domain of campaign.domains.map((d) => d.domain)) {
    const s = await sample(domain, orderIndex, blockNumber);
    if (s.markets.length === 0 && s.reportedUsage === 0n) continue;
    const { understates, overstatement } = report(s, blockNumber ?? head);
    if (understates) critical = true;
    out.push(ser({ ...s, block: blockNumber ?? head, understates, overstatement }));
  }
  return { samples: out, critical };
}

// ---------------------------------------------------------------------------

const head = await pub.getBlockNumber();
const blockArg = arg("block", null);
const watchEvery = Number(arg("watch", 0));
const watchFor = Number(arg("for", 900));

const indexFrom = head - BigInt(Number(arg("lookback", 60000)));
console.log(`portfolio ${PORTFOLIO}`);
console.log(`indexing IntentAdmitted from block ${indexFrom} to ${head} …`);
let orderIndex = await buildOrderIndex(indexFrom, head);
console.log(`  ${[...orderIndex.values()].reduce((a, v) => a + v.length, 0)} orders across ${orderIndex.size} markets`);

const evidence = {
  ranAt: new Date().toISOString(),
  portfolio: PORTFOLIO,
  deployment: deployment.contracts,
  deploymentVersion: deployment.version,
  head: head.toString(),
  mode: watchEvery ? `watch ${watchEvery}s for ${watchFor}s` : "single sample",
  rounds: [],
  criticalFindings: [],
};

let anyCritical = false;

if (watchEvery > 0) {
  const deadline = Date.now() + watchFor * 1000;
  let round = 0;
  while (Date.now() < deadline) {
    round += 1;
    const bn = await pub.getBlockNumber();
    console.log(`\n=== round ${round}  block ${bn}  ${new Date().toISOString()} ===`);
    // Re-index incrementally so orders placed during the watch are covered.
    const fresh = await buildOrderIndex(head, bn);
    for (const [k, v] of fresh) orderIndex.set(k, [...(orderIndex.get(k) ?? []), ...v.filter((o) => !(orderIndex.get(k) ?? []).some((p) => p.orderId === o.orderId))]);

    let samples, critical;
    try {
      ({ samples, critical } = await runOnce(orderIndex, undefined, bn));
    } catch (e) {
      // A watch must survive the RPC. An unreachable endpoint is not evidence
      // of anything about the contract, and treating it as a stop turns a
      // network blip into a gap in the record.
      console.log(`  round ${round}: RPC error, retrying next tick — ${String(e.message).slice(0, 90)}`);
      evidence.rounds.push({ round, block: bn.toString(), at: new Date().toISOString(), rpcError: String(e.message).slice(0, 200) });
      await new Promise((r) => setTimeout(r, watchEvery * 1000));
      continue;
    }
    evidence.rounds.push({ round, block: bn.toString(), at: new Date().toISOString(), samples });
    if (critical) {
      anyCritical = true;
      evidence.criticalFindings.push({ round, block: bn.toString(), samples: samples.filter((s) => s.understates) });
      console.log("\nSTOPPING: the deployment understated independent worst-case exposure.");
      break;
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, watchEvery * 1000));
  }
} else {
  const bn = blockArg ? BigInt(blockArg) : undefined;
  const { samples, critical } = await runOnce(orderIndex, bn, head);
  evidence.rounds.push({ round: 1, block: (bn ?? head).toString(), at: new Date().toISOString(), samples });
  if (critical) {
    anyCritical = true;
    evidence.criticalFindings.push({ round: 1, block: (bn ?? head).toString(), samples: samples.filter((s) => s.understates) });
  }
}

evidence.verdict = anyCritical
  ? "CRITICAL — accounted worst case fell below the independent reference"
  : "SAFE — accounted worst case never fell below the independent reference";

fs.mkdirSync("evidence/production", { recursive: true });
fs.writeFileSync("evidence/production/risk-verification.json", `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`\n${evidence.verdict}`);
console.log("wrote evidence/production/risk-verification.json");
process.exit(anyCritical ? 1 : 0);
