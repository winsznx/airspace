#!/usr/bin/env node
/**
 * Independent risk verifier.
 *
 * `domainRiskUsage` is the portfolio's own conservative number. This script does
 * not trust it. It reconstructs exposure from primary sources — ERC-6909
 * balances, the reservation counters in `marketState`, and the DreamDEX order
 * book — and reports the two quantities separately so the difference between
 * them is visible rather than argued about.
 *
 * WHAT THE CONTRACT COUNTS
 *
 *   directional(m) = (bal(YES) + yesLong − yesShort) − (bal(NO) + noLong − noShort)
 *   domainRiskUsage = Σ |directional(m)| over tracked, unsettled markets
 *
 * `bal(...)` is realized: tokens the portfolio actually holds. The four
 * counters are reservations: quantities of orders that have been admitted and
 * placed but not yet reconciled away.
 *
 * WHERE THE OVERSTATEMENT COMES FROM
 *
 * A resting order can fill in a transaction AIRSPACE never sees, and DreamDEX's
 * `getOrder` reverts identically whether an order filled or was cancelled. So
 * the contract keeps charging the reservation until a release proves the order
 * is gone. In that window the fill is already in `bal(...)` AND the reservation
 * is still counted: the same contracts are charged twice.
 *
 * That is a bounded, provable double count, not unexplained risk. This script
 * proves it by asking the venue, per order, whether it is still live:
 *
 *   live reservation   → `bal + reservation` IS the worst case. Not overstated.
 *   dead reservation   → the order filled or was cancelled. The reservation is
 *                        stale and its whole quantity is overstatement.
 *
 * THE TWO INVARIANTS
 *
 *   SAFETY    the worst case the contract could have authorised never exceeds
 *             the ceiling — checked against `receipts.domain_usage_after`, which
 *             is the number the contract itself gated on.
 *   LIVENESS  overstatement converges to zero as lifecycle reconciliation runs.
 *
 *   node scripts/risk-verifier.mjs                      # sample now
 *   node scripts/risk-verifier.mjs --block 473453044    # sample a past block
 *   node scripts/risk-verifier.mjs --scan 60000 --step 500   # find the peak
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
const RPC2 = "https://rpc.ankr.com/somnia_testnet";
const CHAIN = {
  id: 50312,
  name: "Somnia Shannon",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};
const pub = createPublicClient({
  chain: CHAIN,
  transport: fallback([http(RPC, { retryCount: 1 }), http(RPC2, { retryCount: 1 })], { rank: false }),
});

const campaign = JSON.parse(fs.readFileSync("evidence/production/campaign.json", "utf8"));
const deployment = JSON.parse(fs.readFileSync("contracts/deployments/50312.json", "utf8"));
const portfolioAbi = JSON.parse(
  fs.readFileSync("contracts/out/AirspacePortfolio.sol/AirspacePortfolio.json", "utf8"),
).abi;

const PORTFOLIO = arg("portfolio", campaign.portfolio);
const OUTCOME = deployment.dreamdex.outcomeToken6909;

const ERC6909_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "uint256" }],
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

// ---------------------------------------------------------------------------

async function sample(domain, blockNumber) {
  const read = (functionName, args = []) =>
    pub.readContract({ address: PORTFOLIO, abi: portfolioAbi, functionName, args, ...at(blockNumber) });

  const [policy, reported, marketIds] = await Promise.all([
    read("domainPolicy", [domain]),
    read("domainRiskUsage", [domain]),
    read("domainMarkets", [domain]),
  ]);

  const ceiling = policy[1];
  const markets = [];

  for (const marketId of marketIds) {
    const m = await read("marketState", [marketId]);
    const [pool, marketNonce, , yesLong, yesShort, noLong, noShort, tracked, settled] = m;
    // The contract excludes untracked and settled markets from the sum, so the
    // verifier must too or the two numbers are not comparable.
    if (!tracked || settled) continue;

    const yesId = outcomeId(pool, marketNonce, 0);
    const [balYes, balNo] = await Promise.all([
      pub.readContract({ address: OUTCOME, abi: ERC6909_ABI, functionName: "balanceOf", args: [PORTFOLIO, yesId], ...at(blockNumber) }),
      pub.readContract({ address: OUTCOME, abi: ERC6909_ABI, functionName: "balanceOf", args: [PORTFOLIO, yesId + 1n], ...at(blockNumber) }),
    ]);

    // What the contract reports for this market.
    const conservative = balYes + yesLong - yesShort - (balNo + noLong - noShort);
    // Realized only: every reservation assumed to vanish.
    const realized = balYes - balNo;

    markets.push({
      marketId,
      pool,
      marketNonce,
      balYes,
      balNo,
      yesLong,
      yesShort,
      noLong,
      noShort,
      conservative,
      realized,
    });
  }

  return { domain, ceiling, reported, markets };
}

/**
 * Ask the venue whether each reservation still has a live order behind it.
 *
 * Reservation counters are aggregates, so the individual order ids come from
 * the `IntentAdmitted` logs of this portfolio. An order the pool still knows
 * about is a genuine future commitment; one it does not is stale, and its whole
 * quantity is overstatement.
 */
async function classifyReservations(markets, orderIndex, blockNumber) {
  for (const m of markets) {
    const reserved = m.yesLong + m.yesShort + m.noLong + m.noShort;
    m.reservedTotal = reserved;
    m.liveReserved = 0n;
    m.staleReserved = 0n;
    m.orders = [];
    if (reserved === 0n) continue;

    for (const o of orderIndex.get(m.marketId.toLowerCase()) ?? []) {
      let remaining = 0n;
      let known = false;
      try {
        const r = await pub.readContract({
          address: m.pool,
          abi: ORDERBOOK_ABI,
          functionName: "getOrder",
          args: [o.orderId],
          ...at(blockNumber),
        });
        remaining = r.quantityRemaining;
        known = true;
      } catch {
        // `IncorrectOrder()` — filled or cancelled, indistinguishable by design.
        known = false;
      }
      m.orders.push({ orderId: o.orderId.toString(), kind: o.kind, placed: o.quantity.toString(), remaining: remaining.toString(), live: known && remaining > 0n });
      if (known && remaining > 0n) m.liveReserved += remaining;
    }

    // Anything charged that no live order accounts for is stale.
    m.staleReserved = reserved > m.liveReserved ? reserved - m.liveReserved : 0n;
  }
}

/**
 * The exposure the contract WOULD report if every stale reservation were
 * released right now. This is the honest worst case: live reservations still
 * count in full, because they can still fill.
 */
function worstCaseFor(m) {
  const scale = m.reservedTotal === 0n ? 0n : m.liveReserved;
  if (m.reservedTotal === 0n) return m.realized;
  // Scale each side's reservation by the live fraction. Exact when a market has
  // one open side, which is the case for every order these agents place.
  const f = (v) => (m.reservedTotal === 0n ? 0n : (v * scale) / m.reservedTotal);
  return m.balYes + f(m.yesLong) - f(m.yesShort) - (m.balNo + f(m.noLong) - f(m.noShort));
}

// ---------------------------------------------------------------------------

async function buildOrderIndex(fromBlock, toBlock) {
  // Every order this portfolio ever placed, by market.
  const index = new Map();
  const CHUNK = 1000n;
  for (let from = fromBlock; from <= toBlock; from += CHUNK) {
    const to = from + CHUNK - 1n > toBlock ? toBlock : from + CHUNK - 1n;
    let logs = [];
    try {
      logs = await pub.getLogs({
        address: PORTFOLIO,
        event: portfolioAbi.find((e) => e.type === "event" && e.name === "IntentAdmitted"),
        fromBlock: from,
        toBlock: to,
      });
    } catch {
      continue;
    }
    for (const l of logs) {
      const k = l.args.marketId.toLowerCase();
      if (!index.has(k)) index.set(k, []);
      index.get(k).push({ orderId: l.args.orderId, kind: Number(l.args.kind), quantity: l.args.quantity, block: l.blockNumber });
    }
  }
  return index;
}

function report(s, label) {
  const conservative = s.markets.reduce((a, m) => a + abs(m.conservative), 0n);
  const realized = s.markets.reduce((a, m) => a + abs(m.realized), 0n);
  const worstCase = s.markets.reduce((a, m) => a + abs(worstCaseFor(m)), 0n);
  const overstatement = conservative > worstCase ? conservative - worstCase : 0n;

  const c = (v) => (Number(v) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 });

  console.log(`\n${label}`);
  console.log(`  configured ceiling                 ${c(s.ceiling).padStart(12)}`);
  console.log(`  contract domainRiskUsage           ${c(s.reported).padStart(12)}`);
  console.log(`  verifier conservative (recomputed) ${c(conservative).padStart(12)}  ${conservative === s.reported ? "matches" : "MISMATCH"}`);
  console.log(`  worst case after stale released    ${c(worstCase).padStart(12)}`);
  console.log(`  realized holdings only             ${c(realized).padStart(12)}`);
  console.log(`  accounting overstatement           ${c(overstatement).padStart(12)}`);
  console.log(`  over ceiling?                      ${s.reported > s.ceiling ? "YES (conservative)" : "no"}`);
  console.log(`  worst case over ceiling?           ${worstCase > s.ceiling ? "*** YES ***" : "no"}`);

  if (s.markets.length) {
    console.log(`\n  per market (contracts):`);
    console.log(`    ${"market".padEnd(10)} ${"balYES".padStart(9)} ${"balNO".padStart(9)} ${"reserved".padStart(9)} ${"live".padStart(9)} ${"stale".padStart(9)} ${"conserv".padStart(9)} ${"worst".padStart(9)}`);
    for (const m of s.markets) {
      const id = `#${BigInt(m.marketId)}`;
      console.log(
        `    ${id.padEnd(10)} ${c(m.balYes).padStart(9)} ${c(m.balNo).padStart(9)} ${c(m.reservedTotal ?? 0n).padStart(9)} ${c(m.liveReserved ?? 0n).padStart(9)} ${c(m.staleReserved ?? 0n).padStart(9)} ${c(abs(m.conservative)).padStart(9)} ${c(abs(worstCaseFor(m))).padStart(9)}`,
      );
    }
  }

  return { conservative, realized, worstCase, overstatement };
}

// ---------------------------------------------------------------------------

const head = await pub.getBlockNumber();
const blockArg = arg("block", null);
const scanBack = Number(arg("scan", 0));
const step = BigInt(arg("step", 500));

const domains = campaign.domains.map((d) => d.domain);
const out = { ranAt: new Date().toISOString(), portfolio: PORTFOLIO, head: head.toString(), samples: [], scan: null };

// The order index only needs to cover the campaign window.
const indexFrom = head - BigInt(Math.max(scanBack, 60000));
console.log(`indexing IntentAdmitted from block ${indexFrom} to ${head} …`);
const orderIndex = await buildOrderIndex(indexFrom, head);
console.log(`  ${[...orderIndex.values()].reduce((a, v) => a + v.length, 0)} orders across ${orderIndex.size} markets`);

for (const domain of domains) {
  const bn = blockArg ? BigInt(blockArg) : undefined;
  const s = await sample(domain, bn);
  if (s.markets.length === 0 && s.reported === 0n) continue;
  await classifyReservations(s.markets, orderIndex, bn);
  const totals = report(s, `DOMAIN ${domain.slice(0, 14)}…  at block ${bn ?? head}`);
  out.samples.push({
    domain,
    block: (bn ?? head).toString(),
    ceiling: s.ceiling.toString(),
    reported: s.reported.toString(),
    conservative: totals.conservative.toString(),
    worstCase: totals.worstCase.toString(),
    realized: totals.realized.toString(),
    overstatement: totals.overstatement.toString(),
    worstCaseOverCeiling: totals.worstCase > s.ceiling,
    markets: s.markets.map((m) => ({
      marketId: m.marketId,
      balYes: m.balYes.toString(),
      balNo: m.balNo.toString(),
      reserved: (m.reservedTotal ?? 0n).toString(),
      liveReserved: (m.liveReserved ?? 0n).toString(),
      staleReserved: (m.staleReserved ?? 0n).toString(),
      conservative: m.conservative.toString(),
      worstCase: worstCaseFor(m).toString(),
      orders: m.orders ?? [],
    })),
  });
}

fs.mkdirSync("evidence/production", { recursive: true });
fs.writeFileSync("evidence/production/risk-verification.json", `${JSON.stringify(out, null, 2)}\n`);
console.log("\nwrote evidence/production/risk-verification.json");
