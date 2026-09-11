#!/usr/bin/env node
/**
 * The v1 failure, reproduced live against the replacement deployment.
 *
 * v1 collapsed a market to one netted figure:
 *
 *     (balYES + yesLong − yesShort) − (balNO + noLong − noShort)
 *
 * so a pending BUY_YES and a pending BUY_NO cancelled each other out. Either
 * can fill without the other, so that is the most NETTED reading available, not
 * the most conservative one. On 2026-08-28 a live portfolio reported 80 against
 * a true worst case of 1,170, with a ceiling of 500.
 *
 * This script builds that exact shape on the real venue with real independent
 * agent keys, and checks three things at every step:
 *
 *   1. the replacement reports max(up, down), never the difference
 *   2. what v1 WOULD have reported here, computed alongside, so the gap is a
 *      measured number rather than an argument
 *   3. an admission never leaves the domain over its ceiling — including when
 *      the intent that would breach it is on the OPPOSING side, which is the
 *      route v1 left open
 *
 * It also runs a same-block admission race: two agents chasing the last slice
 * of headroom in one block, where the loser must be refused rather than both
 * being admitted against the same capacity.
 *
 *   node scripts/opposing-live.mjs
 *
 * Writes evidence/production/opposing-live.json.
 */
import { createPublicClient, createWalletClient, http, decodeErrorResult } from "viem";
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
const K = 1_000_000n;

const deployment = JSON.parse(fs.readFileSync(path.join(ROOT, "contracts/deployments/50312.json"), "utf8"));
const campaign = JSON.parse(fs.readFileSync(path.join(ROOT, "evidence/production/campaign.json"), "utf8"));
const abiOf = (n) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, "contracts/out", `${n}.sol`, `${n}.json`), "utf8")).abi;
const PF_ABI = abiOf("AirspacePortfolio");

const wallets = JSON.parse(fs.readFileSync(path.join(ROOT, ".wallets.json"), "utf8"));
const OWNER = privateKeyToAccount(wallets.OWNER.private_key);
const A = privateKeyToAccount(wallets.AGENT_A.private_key);
const B = privateKeyToAccount(wallets.AGENT_B.private_key);
const C = privateKeyToAccount(wallets.AGENT_C.private_key);

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });
const wc = (a) => createWalletClient({ account: a, chain: CHAIN, transport: http(RPC) });
const [wO, wA, wB, wC] = [OWNER, A, B, C].map(wc);

const PF = process.env.AIRSPACE_PORTFOLIO ?? campaign.portfolio;

const J = (o) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
const ev = {
  chainId: 50312,
  startedAt: new Date().toISOString(),
  portfolio: PF,
  deployment: deployment.contracts,
  deploymentVersion: deployment.version,
  actors: { owner: OWNER.address, agentA: A.address, agentB: B.address, agentC: C.address },
  steps: [],
};
const log = (name, data) => {
  console.log(`\n[${name}]`, JSON.stringify(J(data), null, 1));
  ev.steps.push({ name, ...J(data) });
};

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

async function send(w, req, label) {
  const hash = await w.writeContract(req);
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`  ${label}: ${hash} ${r.status}`);
  if (r.status !== "success") throw new Error(`${label} reverted (${hash})`);
  return { hash, status: r.status, blockNumber: r.blockNumber, gasUsed: r.gasUsed };
}

// --- market discovery, straight from the module registry -------------------
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
const erc6909 = [
  {
    type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256" }],
  },
];

const TABLE = [60, 300, 900, 1800, 3600, 14400, 86400];
const cadenceOf = (ts, ex) => {
  for (const c of TABLE) if (c >= ex - ts && ex % c === 0) return c;
  return 0;
};

/** One live market whose domain this portfolio already has a policy for. */
async function findConfiguredMarket(minLeft) {
  const read = (id) => pub.readContract({ address: MODULE, abi: moduleAbi, functionName: "markets", args: [id] });
  const exists = async (n) => (await read(`0x${n.toString(16).padStart(64, "0")}`))[9] !== "0x0000000000000000000000000000000000000000";

  let lo = 0x1000n, hi = 0x1000n;
  while (await exists(hi)) { lo = hi; hi *= 2n; if (hi > 0x400000n) break; }
  while (lo + 1n < hi) { const m = (lo + hi) / 2n; if (await exists(m)) lo = m; else hi = m; }

  const configured = new Set(campaign.domains.map((d) => d.domain.toLowerCase()));
  const now = Math.floor(Date.now() / 1000);

  for (let i = 0n; i < 400n; i++) {
    const id = `0x${(lo - i).toString(16).padStart(64, "0")}`;
    const r = await read(id);
    if (r[9] === "0x0000000000000000000000000000000000000000") continue;
    const ts = Number(r[12]), ex = Number(r[13]);
    if (ex - now < minLeft) continue;
    if (!cadenceOf(ts, ex)) continue;
    const domain = await pub.readContract({ address: PF, abi: PF_ABI, functionName: "domainOf", args: [id] });
    if (!configured.has(domain.toLowerCase())) continue;
    const nonce = await pub.readContract({ address: r[9], abi: poolAbi, functionName: "marketNonce" });
    const expNs = await pub.readContract({ address: r[9], abi: poolAbi, functionName: "marketExpiryNs" });
    return { id, pool: r[9], domain, nonce, expNs, cadence: cadenceOf(ts, ex), secondsLeft: ex - now };
  }
  throw new Error("no live market in a configured domain");
}

// --- the two models, side by side ------------------------------------------

/** What v1 reported. Kept verbatim so the comparison is with the real thing. */
const v1Netted = ({ balYes, balNo, yesLong, yesShort, noLong, noShort }) => {
  const d = balYes + yesLong - yesShort - (balNo + noLong - noShort);
  return d < 0n ? -d : d;
};

/** Independent worst case, by enumerating every combination of fills. */
const independent = ({ balYes, balNo, yesLong, yesShort, noLong, noShort }) => {
  let worst = 0n;
  for (let m = 0; m < 16; m++) {
    let y = balYes, n = balNo;
    if (m & 1) y += yesLong;
    if (m & 4) n += noLong;
    if (!(m & 2)) y += yesShort;
    if (!(m & 8)) n += noShort;
    const d = y - n < 0n ? n - y : y - n;
    if (d > worst) worst = d;
  }
  return worst;
};

// ---------------------------------------------------------------------------

const state = async (marketId, pool) => {
  const m = await pub.readContract({ address: PF, abi: PF_ABI, functionName: "marketState", args: [marketId] });
  const yesId = (BigInt(pool) << 72n) | (BigInt(m[1]) << 8n);
  const [balYes, balNo] = await Promise.all([
    pub.readContract({ address: OUTCOME, abi: erc6909, functionName: "balanceOf", args: [PF, yesId] }),
    pub.readContract({ address: OUTCOME, abi: erc6909, functionName: "balanceOf", args: [PF, yesId + 1n] }),
  ]);
  const s = { balYes, balNo, yesLong: m[3], yesShort: m[4], noLong: m[5], noShort: m[6] };
  const accounted = await pub.readContract({
    address: PF, abi: PF_ABI, functionName: "marketWorstCaseExposure", args: [marketId],
  });
  return { ...s, accounted, independent: independent(s), v1WouldHaveSaid: v1Netted(s) };
};

const usage = (domain) => pub.readContract({ address: PF, abi: PF_ABI, functionName: "domainRiskUsage", args: [domain] });

let failures = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${msg}`);
  if (!ok) failures += 1;
  return ok;
};

// ---------------------------------------------------------------------------

(async () => {
  console.log("=== opposing-reservation live proof ===");
  console.log("portfolio:", PF);
  console.log("version  :", deployment.version);

  const mkt = await findConfiguredMarket(300);
  log("00-market", { ...mkt, note: "one live market in a domain this portfolio already has a policy for" });

  const dp = await pub.readContract({ address: PF, abi: PF_ABI, functionName: "domainPolicy", args: [mkt.domain] });
  const ceiling = dp[1];

  let nonces = {};
  for (const [k, acct] of [["A", A], ["B", B], ["C", C]]) {
    nonces[k] = await pub.readContract({ address: PF, abi: PF_ABI, functionName: "agentNonce", args: [acct.address] });
  }
  const intent = (kind, price, qty, who) => ({
    marketId: mkt.id,
    pool: mkt.pool,
    marketNonce: mkt.nonce,
    kind,
    price,
    quantity: qty,
    expireTimestampNs: mkt.expNs,
    orderType: 3, // POST_ONLY: it must REST, or there is no reservation to net
    nonce: ++nonces[who],
    strategyVersion: "0x" + "22".repeat(32),
  });

  const exec = async (w, acct, i, label) => {
    const { request } = await pub.simulateContract({ account: acct, address: PF, abi: PF_ABI, functionName: "execute", args: [i] });
    return send(w, request, label);
  };

  // 1. AGENT A: BUY_YES, resting.
  const qA = 120n * K;
  const txA = await exec(wA, A, intent(0, 250_000n, qA, "A"), "AGENT_A BUY_YES 120 @0.25");
  const s1 = await state(mkt.id, mkt.pool);
  log("01-buyYes", { ...s1, domainUsage: await usage(mkt.domain), ceiling });

  // 2. AGENT B: BUY_NO on the SAME market. This is the shape v1 netted away.
  // Priced on the far side of the book. `price` is ALWAYS the YES-side price on
  // DreamDEX, so a BUY_NO at YES-price 0.90 is a NO bid at 0.10, which rests as
  // a YES ask at 0.90 — comfortably above A's 0.25 bid. Quoting it at 0.25 like
  // the buy would make it a NO bid at 0.75, crossing A's own side, and a
  // POST_ONLY that crosses reverts `PostOnlyWouldCross()` before it can rest.
  // Both legs have to REST or there are no opposing reservations to net.
  const qB = 90n * K;
  const txB = await exec(wB, B, intent(2, 900_000n, qB, "B"), "AGENT_B BUY_NO 90 @0.10 (NO side)");
  const s2 = await state(mkt.id, mkt.pool);
  const g2 = await usage(mkt.domain);
  log("02-opposingBuysResting", {
    ...s2,
    domainUsage: g2,
    ceiling,
    v1WouldHaveSaid: s2.v1WouldHaveSaid,
    understatementAvoided: s2.independent - s2.v1WouldHaveSaid,
    note: "two INDEPENDENT agents, opposite sides, one market, both orders resting",
  });

  check(s2.accounted === s2.independent, `accounted ${s2.accounted} equals the independent worst case`);
  check(s2.accounted >= s2.independent, "accounted never understates the independent worst case");
  check(
    s2.v1WouldHaveSaid < s2.independent,
    `v1 would have reported ${s2.v1WouldHaveSaid}, understating by ${s2.independent - s2.v1WouldHaveSaid}`,
  );

  // 3. The ceiling is enforced on the LARGER side, not the difference.
  //
  // Tighten the ceiling to just under the current worst case. v1 saw
  // |120 − 90| = 30 here and had room for almost anything; the replacement sees
  // 120 and is already at its limit.
  const tight = s2.accounted;
  await send(
    wO,
    (await pub.simulateContract({
      account: OWNER, address: PF, abi: PF_ABI, functionName: "setDomainPolicy",
      args: [mkt.domain, { configured: true, maxDomainRiskUsage: tight, maxDomainCommitted: 0n, maxLiveMarkets: 0 }],
    })).request,
    `owner tightens the ceiling to ${tight}`,
  );

  // Another BUY_YES would widen the upper bound past the ceiling: refused.
  let sameSide = "ADMITTED";
  try {
    await pub.simulateContract({ account: C, address: PF, abi: PF_ABI, functionName: "execute", args: [intent(0, 250_000n, 10n * K, "C")] });
  } catch (e) { sameSide = refusalOf(e); }

  // And so would another BUY_NO once it passes the other side — which is the
  // door v1 left open, because netting made an opposing order look free.
  let oppositeSide = "ADMITTED";
  try {
    await pub.simulateContract({ account: C, address: PF, abi: PF_ABI, functionName: "execute", args: [intent(2, 900_000n, 200n * K, "C")] });
  } catch (e) { oppositeSide = refusalOf(e); }

  log("03-ceilingBindsBothSides", {
    ceiling: tight,
    sameSideRefusal: sameSide,
    oppositeSideRefusal: oppositeSide,
    note: "an opposing order is not a way around the envelope: it widens the other bound",
  });
  check(sameSide === "DOMAIN_RISK_EXCEEDED", "a same-side addition over the ceiling is refused");
  check(oppositeSide === "DOMAIN_RISK_EXCEEDED", "an opposing addition over the ceiling is ALSO refused");

  // 4. Same-block admission race.
  //
  // Two agents submit into the same block with only enough headroom for one.
  // No off-chain lock is involved: the EVM serialises them, and the second reads
  // the first's effect.
  const headroom = 40n * K;
  await send(
    wO,
    (await pub.simulateContract({
      account: OWNER, address: PF, abi: PF_ABI, functionName: "setDomainPolicy",
      args: [mkt.domain, { configured: true, maxDomainRiskUsage: tight + headroom, maxDomainCommitted: 0n, maxLiveMarkets: 0 }],
    })).request,
    `owner reopens exactly ${headroom} of headroom`,
  );

  const raceQty = 30n * K; // two of these do not fit; one does
  const rA = await pub.simulateContract({ account: A, address: PF, abi: PF_ABI, functionName: "execute", args: [intent(0, 250_000n, raceQty, "A")] });
  let secondRefusal = null;
  const hA = await wA.writeContract(rA.request);
  try {
    const rC = await pub.simulateContract({ account: C, address: PF, abi: PF_ABI, functionName: "execute", args: [intent(0, 250_000n, raceQty, "C")] });
    const hC = await wC.writeContract(rC.request);
    const recC = await pub.waitForTransactionReceipt({ hash: hC });
    secondRefusal = recC.status === "success" ? "ADMITTED" : "reverted on chain";
  } catch (e) {
    secondRefusal = refusalOf(e);
  }
  await pub.waitForTransactionReceipt({ hash: hA });
  const g4 = await usage(mkt.domain);
  const s4 = await state(mkt.id, mkt.pool);
  log("04-concurrentAdmissionRace", {
    headroomOffered: headroom,
    eachAgentWanted: raceQty,
    firstAdmitted: hA,
    secondOutcome: secondRefusal,
    domainUsageAfter: g4,
    ceiling: tight + headroom,
    ...s4,
  });
  check(g4 <= tight + headroom, "the race never left the domain over its ceiling");
  check(s4.accounted >= s4.independent, "accounted still never understates after the race");

  // 5. Final reading, with both models printed side by side.
  const admitted = PF_ABI.find((e) => e.type === "event" && e.name === "IntentAdmitted");
  const orderIds = [];
  for (const h of [txA.hash, txB.hash, hA]) {
    const rec = await pub.getTransactionReceipt({ hash: h });
    const logs = await pub.getLogs({ address: PF, event: admitted, fromBlock: rec.blockNumber, toBlock: rec.blockNumber });
    for (const l of logs) if (l.transactionHash === h) orderIds.push({ orderId: l.args.orderId.toString(), kind: Number(l.args.kind), qty: l.args.quantity.toString() });
  }
  const s5 = await state(mkt.id, mkt.pool);
  log("05-finalState", {
    domainUsage: await usage(mkt.domain),
    ordersAdmitted: orderIds,
    ...s5,
    note: "final reading; `v1WouldHaveSaid` is what the superseded deployment would have reported for this exact state",
  });
  check(s5.accounted >= s5.independent, "final state does not understate");

  // Restore a workable ceiling so the portfolio is not left wedged.
  await send(
    wO,
    (await pub.simulateContract({
      account: OWNER, address: PF, abi: PF_ABI, functionName: "setDomainPolicy",
      args: [mkt.domain, { configured: true, maxDomainRiskUsage: 500n * K, maxDomainCommitted: 0n, maxLiveMarkets: 0 }],
    })).request,
    "owner restores the 500 ceiling",
  );

  ev.finishedAt = new Date().toISOString();
  ev.failures = failures;
  ev.verdict = failures === 0 ? "PASS" : `FAIL (${failures} checks)`;
  fs.mkdirSync(path.join(ROOT, "evidence/production"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "evidence/production/opposing-live.json"), `${JSON.stringify(J(ev), null, 2)}\n`);
  console.log(`\n${ev.verdict}  — wrote evidence/production/opposing-live.json`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("\nFATAL:", e.message);
  process.exit(1);
});
