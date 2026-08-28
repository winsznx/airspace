#!/usr/bin/env node
/**
 * Hostile campaign.
 *
 * Each case tries to make AIRSPACE do something it promises it will not, or
 * tries to break a component and checks the system degrades the way the
 * documentation claims. Every case states what would count as a FAILURE before
 * it runs, and a case that cannot be attempted is reported as SKIPPED rather
 * than quietly counted as a pass.
 *
 *   node scripts/adversarial.mjs
 *   node scripts/adversarial.mjs --api http://127.0.0.1:8787 --indexer http://127.0.0.1:8788
 *
 * Writes evidence/production/adversarial.json.
 */
import fs from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  parseUnits,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const RPC = process.env.SHANNON_RPC ?? "https://dream-rpc.somnia.network";
const API = arg("api", "http://127.0.0.1:8787");
const INDEXER = arg("indexer", "http://127.0.0.1:8788");
/** An API instance deliberately pointed at a dead RPC. Optional. */
const DEGRADED = arg("degraded", "http://127.0.0.1:8790");
const INDEXER_TOKEN = process.env.INDEXER_TOKEN ?? "local-dev-token";

const CHAIN = {
  id: 50312,
  name: "Somnia Shannon",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

const campaign = JSON.parse(fs.readFileSync("evidence/production/campaign.json", "utf8"));
const deployment = JSON.parse(fs.readFileSync("contracts/deployments/50312.json", "utf8"));
const wallets = JSON.parse(fs.readFileSync(".wallets.json", "utf8"));
const abi = JSON.parse(fs.readFileSync("contracts/out/AirspacePortfolio.sol/AirspacePortfolio.json", "utf8")).abi;

const PORTFOLIO = campaign.portfolio;
const MODULE = deployment.dreamdex.binaryModule;
const TUSDC = deployment.dreamdex.collateral;

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });
const signer = (k) => createWalletClient({ account: privateKeyToAccount(wallets[k].private_key), chain: CHAIN, transport: http(RPC) });

const results = [];
const record = (r) => {
  results.push(r);
  const mark = r.status === "PASS" ? "PASS" : r.status === "SKIP" ? "SKIP" : "FAIL";
  console.log(`${mark.padEnd(5)} ${r.id.padEnd(28)} ${r.detail}`);
};

const run = async (id, mustNot, fn) => {
  try {
    const r = await fn();
    record({ id, mustNot, ...r });
  } catch (e) {
    record({ id, mustNot, status: "FAIL", detail: `case threw: ${(e.message ?? String(e)).slice(0, 160)}` });
  }
};

const revertOf = (e) => {
  const raw = e.walk?.((x) => x?.data)?.data ?? e.data ?? e.cause?.data;
  if (typeof raw === "string" && raw.length >= 10) {
    if (raw.startsWith("0xbd5adfec")) return { kind: "Refused", code: Number(BigInt(`0x${raw.slice(10)}`)) };
    return { kind: raw.slice(0, 10) };
  }
  const m = /(\w+)\(\)/.exec(e.shortMessage ?? "");
  return { kind: m ? m[1] : "revert" };
};

// --- a live market in a configured domain ------------------------------------

const MODULE_ABI = [
  {
    type: "function", name: "markets", stateMutability: "view", inputs: [{ type: "bytes32" }],
    outputs: [
      { type: "uint256" }, { type: "uint8" }, { type: "uint8" }, { type: "address" }, { type: "uint32" },
      { type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" },
      { type: "uint256" }, { type: "uint256" }, { type: "uint64" }, { type: "uint64" },
    ],
  },
];
const POOL_ABI = [
  { type: "function", name: "marketNonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "marketExpiryNs", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  {
    type: "function", name: "getBookLevels", stateMutability: "view",
    inputs: [{ type: "bool" }, { type: "uint64" }],
    outputs: [{ type: "tuple[]", components: [{ name: "price", type: "uint256" }, { name: "quantity", type: "uint256" }] }],
  },
];
const CANONICAL = [60, 300, 900, 1800, 3600, 14400, 86400];
const idOf = (n) => `0x${n.toString(16).padStart(64, "0")}`;

async function readMarket(id) {
  try {
    const r = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: "markets", args: [id] });
    if (r[9] === "0x0000000000000000000000000000000000000000") return null;
    const cadence = CANONICAL.find((c) => c >= Number(r[13] - r[12]) && Number(r[13]) % c === 0) ?? 0;
    return { id, creator: r[7], collateral: r[3], pool: r[9], expiry: Number(r[13]), cadence };
  } catch {
    return null;
  }
}

async function findLiveMarket() {
  let lo = 0x1000n;
  let hi = 0x1000n;
  const exists = async (n) => Boolean(await readMarket(idOf(n)));
  while (await exists(hi)) { lo = hi; hi *= 2n; if (hi > 0x400000n) break; }
  while (lo + 1n < hi) { const m = (lo + hi) / 2n; if (await exists(m)) lo = m; else hi = m; }

  const now = Math.floor(Date.now() / 1000);
  for (let i = 0n; i < 80n; i += 1n) {
    const m = await readMarket(idOf(lo - i));
    if (!m?.cadence) continue;
    if (m.expiry - now < 120) continue;

    const domain = keccak256(
      `0x${m.creator.slice(2).padStart(64, "0")}${m.collateral.slice(2).padStart(64, "0")}${m.cadence.toString(16).padStart(64, "0")}`,
    );
    // Ask the PORTFOLIO whether this domain is configured, rather than trusting
    // the setup snapshot: domains come and go as creators roll series.
    const dp = await pub.readContract({ address: PORTFOLIO, abi, functionName: "domainPolicy", args: [domain] });
    if (!dp[0]) continue;

    const [nonce, expiryNs, bids] = await Promise.all([
      pub.readContract({ address: m.pool, abi: POOL_ABI, functionName: "marketNonce" }),
      pub.readContract({ address: m.pool, abi: POOL_ABI, functionName: "marketExpiryNs" }),
      pub.readContract({ address: m.pool, abi: POOL_ABI, functionName: "getBookLevels", args: [true, 3n] }),
    ]);
    // An empty book is fine: every case here either previews (no book needed) or
    // places a deep resting bid. Quote from the touch when there is one, and
    // from the middle of the range when there is not.
    const bid = bids.length > 0 ? bids[0].price : 500_000n;
    return { ...m, domain, nonce, expiryNs, bid, bookDepth: bids.length };
  }
  return null;
}

const market = await findLiveMarket();
console.log(`portfolio ${PORTFOLIO}`);
console.log(market ? `market    ${market.id} (${market.cadence}s, bid ${market.bid}, ${market.bookDepth} bid levels)\n` : "market    none live in a configured domain\n");

/** A price well under the touch, so a post-only bid rests instead of crossing. */
const priceUnder = (bid) => {
  const p = bid > 120_000n ? bid - 60_000n : bid / 2n;
  return (p / 1_000n) * 1_000n;
};

const intentFor = async (agentKey, quantity, price) => {
  const agent = wallets[agentKey].address;
  const nonce = await pub.readContract({ address: PORTFOLIO, abi, functionName: "agentNonce", args: [agent] });
  return {
    marketId: market.id,
    pool: market.pool,
    marketNonce: market.nonce,
    kind: 0,
    price,
    quantity,
    expireTimestampNs: market.expiryNs,
    orderType: 3,
    nonce: nonce + 1n,
    strategyVersion: keccak256(toHex("adversarial")),
  };
};

// =============================================================================

await run(
  "non-owner-withdraw",
  "a non-owner must never move collateral",
  async () => {
    const w = signer("AGENT_A");
    try {
      await pub.simulateContract({
        address: PORTFOLIO, abi, functionName: "withdraw",
        args: [TUSDC, wallets.AGENT_A.address, parseUnits("1", 6)],
        account: w.account.address,
      });
      return { status: "FAIL", detail: "a registered agent was allowed to withdraw" };
    } catch (e) {
      return { status: "PASS", detail: `refused with ${revertOf(e).kind}` };
    }
  },
);

await run(
  "non-owner-set-policy",
  "a non-owner must never change a ceiling",
  async () => {
    const w = signer("AGENT_B");
    try {
      await pub.simulateContract({
        address: PORTFOLIO, abi, functionName: "setDomainPolicy",
        args: [campaign.domains[0].domain, { configured: true, maxDomainRiskUsage: parseUnits("999999", 6), maxDomainCommitted: parseUnits("999999", 6), maxLiveMarkets: 48 }],
        account: w.account.address,
      });
      return { status: "FAIL", detail: "an agent raised its own domain ceiling" };
    } catch (e) {
      return { status: "PASS", detail: `refused with ${revertOf(e).kind}` };
    }
  },
);

await run(
  "unregistered-agent",
  "an unregistered key must never trade the pool",
  async () => {
    if (!market) return { status: "SKIP", detail: "no live market in a configured domain" };
    const stranger = wallets.AGENT.address;
    const nonce = await pub.readContract({ address: PORTFOLIO, abi, functionName: "agentNonce", args: [stranger] });
    const view = await pub.readContract({
      address: PORTFOLIO, abi, functionName: "previewIntent",
      args: [stranger, { ...(await intentFor("AGENT_A", parseUnits("10", 6), priceUnder(market.bid))), nonce: nonce + 1n }],
    });
    return view.refusal === 1
      ? { status: "PASS", detail: "refusal 1 NOT_AGENT" }
      : { status: "FAIL", detail: `expected NOT_AGENT, got refusal ${view.refusal}` };
  },
);

await run(
  "nonce-replay",
  "a used agent nonce must never be reusable",
  async () => {
    if (!market) return { status: "SKIP", detail: "no live market in a configured domain" };
    const agent = wallets.AGENT_A.address;
    const used = await pub.readContract({ address: PORTFOLIO, abi, functionName: "agentNonce", args: [agent] });
    if (used === 0n) return { status: "SKIP", detail: "agent has never executed, no nonce to replay" };
    const intent = { ...(await intentFor("AGENT_A", parseUnits("10", 6), priceUnder(market.bid))), nonce: used };
    const view = await pub.readContract({ address: PORTFOLIO, abi, functionName: "previewIntent", args: [agent, intent] });
    return view.refusal === 4
      ? { status: "PASS", detail: `refusal 4 INTENT_REPLAYED at nonce ${used}` }
      : { status: "FAIL", detail: `expected INTENT_REPLAYED, got refusal ${view.refusal}` };
  },
);

await run(
  "stale-generation",
  "an intent must never execute against a rolled market",
  async () => {
    if (!market) return { status: "SKIP", detail: "no live market in a configured domain" };
    const intent = { ...(await intentFor("AGENT_A", parseUnits("10", 6), priceUnder(market.bid))), marketNonce: market.nonce - 1n };
    const view = await pub.readContract({ address: PORTFOLIO, abi, functionName: "previewIntent", args: [wallets.AGENT_A.address, intent] });
    return view.refusal !== 0
      ? { status: "PASS", detail: `refusal ${view.refusal} on a stale generation` }
      : { status: "FAIL", detail: "a stale generation was admitted" };
  },
);

await run(
  "rival-release-live",
  "a live reservation must never be releasable by anyone",
  async () => {
    const res = await fetch(`${API}/api/portfolios/${PORTFOLIO}/reservations?limit=50`).then((r) => r.json());
    const open = (res.reservations ?? []).find((r) => ["RESERVED", "RESTING", "PARTIAL"].includes(r.state));
    if (!open) return { status: "SKIP", detail: "no open reservation to attack" };
    try {
      await pub.simulateContract({
        address: PORTFOLIO, abi, functionName: "releaseOrder", args: [open.order_key],
        account: wallets.AGENT_C.address,
      });
      return { status: "FAIL", detail: `a rival released live order ${open.order_key.slice(0, 12)}` };
    } catch (e) {
      return { status: "PASS", detail: `refused with ${revertOf(e).kind}` };
    }
  },
);

await run(
  "submit-despite-refusal",
  "a refused intent must change no state and must be recoverable",
  async () => {
    if (!market) return { status: "SKIP", detail: "no live market in a configured domain" };

    // Breach the DOMAIN ceiling with an order that is legal for the agent —
    // the whole point of the product. Sizing it past the agent's own limit would
    // trip gate 1 instead and prove nothing about sharing.
    const agent = wallets.AGENT_A.address;
    const policy = await pub.readContract({ address: PORTFOLIO, abi, functionName: "agentPolicy", args: [agent] });
    const usage = await pub.readContract({ address: PORTFOLIO, abi, functionName: "domainRiskUsage", args: [market.domain] });
    const dp = await pub.readContract({ address: PORTFOLIO, abi, functionName: "domainPolicy", args: [market.domain] });

    const lot = 1_000n;
    const size = (policy[2] / lot) * lot;                 // largest order this agent may place
    const headroom = dp[1] > usage ? dp[1] - usage : 0n;  // room left in the shared domain

    // If that order still fits, tighten the ceiling so it does not. An owner
    // lowering a limit is an ordinary action, and it makes the refusal about the
    // shared envelope rather than about order size.
    let restored = null;
    if (size <= headroom) {
      const owner = signer("OWNER");
      const h = await owner.writeContract({
        address: PORTFOLIO, abi, functionName: "setDomainPolicy",
        args: [market.domain, { configured: true, maxDomainRiskUsage: usage + size / 2n, maxDomainCommitted: dp[2], maxLiveMarkets: dp[3] }],
        chain: CHAIN,
      });
      await pub.waitForTransactionReceipt({ hash: h });
      restored = { ceiling: dp[1], committed: dp[2], live: dp[3] };
    }

    const restore = async () => {
      if (!restored) return;
      const owner = signer("OWNER");
      const h = await owner.writeContract({
        address: PORTFOLIO, abi, functionName: "setDomainPolicy",
        args: [market.domain, { configured: true, maxDomainRiskUsage: restored.ceiling, maxDomainCommitted: restored.committed, maxLiveMarkets: restored.live }],
        chain: CHAIN,
      });
      await pub.waitForTransactionReceipt({ hash: h });
    };

    const intent = await intentFor("AGENT_A", size, priceUnder(market.bid));

    const view = await pub.readContract({ address: PORTFOLIO, abi, functionName: "previewIntent", args: [agent, intent] });
    if (view.refusal === 0) {
      await restore();
      return { status: "SKIP", detail: "the contract would admit this; nothing to test" };
    }

    const before = await pub.readContract({ address: PORTFOLIO, abi, functionName: "agentCommitted", args: [agent] });

    // Send it anyway, with a fixed gas limit so the send is not blocked by
    // viem's own simulation. This is what a naive agent does.
    const w = signer("AGENT_A");
    const hash = await w.sendTransaction({
      to: PORTFOLIO,
      data: encodeFunctionData({ abi, functionName: "execute", args: [intent] }),
      gas: 1_500_000n,
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    const after = await pub.readContract({ address: PORTFOLIO, abi, functionName: "agentCommitted", args: [agent] });
    await restore();

    if (receipt.status !== "reverted") return { status: "FAIL", detail: `a refused intent succeeded: ${hash}` };
    if (after !== before) return { status: "FAIL", detail: `state changed on refusal: ${before} -> ${after}` };

    const reported = await fetch(`${API}/api/intents/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ portfolio: PORTFOLIO, txHash: hash }),
    }).then((r) => r.json());

    return reported.recorded
      ? { status: "PASS", detail: `refusal ${reported.refusal} ${reported.refusalName}, agent committed ${before} unchanged, tx ${hash.slice(0, 12)}` }
      : { status: "FAIL", detail: `refusal not recovered: ${JSON.stringify(reported).slice(0, 120)}` };
  },
);

await run(
  "report-a-success-as-refusal",
  "the API must never record a refusal that did not happen",
  async () => {
    const rows = await fetch(`${API}/api/portfolios/${PORTFOLIO}/intents?status=ADMITTED&limit=1`).then((r) => r.json());
    const tx = rows.intents?.[0]?.tx_hash;
    if (!tx) return { status: "SKIP", detail: "no admitted intent to misreport" };
    const res = await fetch(`${API}/api/intents/report`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ portfolio: PORTFOLIO, txHash: tx }),
    }).then((r) => r.json());
    return res.error
      ? { status: "PASS", detail: `rejected: ${res.error}` }
      : { status: "FAIL", detail: "a successful transaction was recorded as a refusal" };
  },
);

await run(
  "report-unrelated-tx",
  "the API must never accept a transaction sent elsewhere",
  async () => {
    const block = await pub.getBlock({ blockTag: "latest", includeTransactions: false });
    const foreign = block.transactions.find(Boolean);
    if (!foreign) return { status: "SKIP", detail: "no transaction in the latest block" };
    const res = await fetch(`${API}/api/intents/report`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ portfolio: PORTFOLIO, txHash: foreign }),
    }).then((r) => r.json());
    return res.error
      ? { status: "PASS", detail: `rejected: ${res.error}` }
      : { status: "FAIL", detail: "an unrelated transaction was accepted" };
  },
);

const ingestOnce = () =>
  fetch(`${INDEXER}/ingest`, { method: "POST", headers: { authorization: `Bearer ${INDEXER_TOKEN}` } }).then((r) => r.json());

const counts = async () => {
  const [i, r, v] = await Promise.all([
    fetch(`${API}/api/portfolios/${PORTFOLIO}/intents?limit=1`).then((x) => x.json()),
    fetch(`${API}/api/portfolios/${PORTFOLIO}/receipts?limit=1`).then((x) => x.json()),
    fetch(`${API}/api/portfolios/${PORTFOLIO}/reservations?limit=1`).then((x) => x.json()),
  ]);
  return { intents: i.total, receipts: r.total, reservations: v.total };
};

await run(
  "duplicate-ingestion",
  "re-processing blocks already seen must not duplicate a projection",
  async () => {
    await ingestOnce(); // reach the head first, so the rewind replays real work
    const before = await counts();

    const rw = await fetch(`${INDEXER}/rewind?blocks=20000`, {
      method: "POST",
      headers: { authorization: `Bearer ${INDEXER_TOKEN}` },
    }).then((r) => r.json());
    if (rw.error) return { status: "SKIP", detail: `rewind unavailable: ${rw.error}` };

    // Walk forward over the rewound range. Every log in it is already applied.
    let dup = 0;
    let applied = 0;
    for (let i = 0; i < 8; i += 1) {
      const r = await ingestOnce();
      dup += r.duplicates ?? 0;
      applied += r.applied ?? 0;
      if (r.caughtUp) break;
    }
    const after = await counts();

    if (dup === 0) return { status: "SKIP", detail: "no logs inside the rewound range to replay" };
    if (after.intents !== before.intents || after.receipts !== before.receipts) {
      return { status: "FAIL", detail: `replay changed row counts: ${JSON.stringify(before)} -> ${JSON.stringify(after)}` };
    }
    return {
      status: "PASS",
      detail: `rewound ${rw.from} -> ${rw.to}, ${dup} logs re-seen and skipped, ${applied} newly applied, counts unchanged at ${after.intents}`,
    };
  },
);

await run(
  "projection-consistency",
  "every recorded intent must have exactly one receipt",
  async () => {
    const c = await counts();
    return c.receipts === c.intents
      ? { status: "PASS", detail: `${c.intents} intents, ${c.receipts} receipts, ${c.reservations} reservations` }
      : { status: "FAIL", detail: `receipts ${c.receipts} != intents ${c.intents}` };
  },
);

await run(
  "rpc-outage",
  "an RPC outage must be visible, never silently stale",
  async () => {
    const snap = await fetch(`${API}/api/portfolios/${PORTFOLIO}`).then((r) => r.json());
    if (!("fetchedAt" in snap)) return { status: "FAIL", detail: "snapshot carries no freshness marker" };

    // A second API instance pointed at a dead RPC. Start it with:
    //   wrangler dev --port 8790 --var SHANNON_RPC:http://127.0.0.1:9 \
    //                            --var SHANNON_RPC_FALLBACK:http://127.0.0.1:9
    let degradedHealth;
    try {
      degradedHealth = await fetch(`${DEGRADED}/api/health`, { signal: AbortSignal.timeout(30_000) }).then((r) => r.json());
    } catch {
      return { status: "SKIP", detail: `no degraded instance at ${DEGRADED}; live snapshot is fresh at block ${snap.blockNumber}` };
    }

    if (degradedHealth.rpc !== "unavailable" || degradedHealth.ok !== false) {
      return { status: "FAIL", detail: `an instance with no RPC reported healthy: ${JSON.stringify(degradedHealth)}` };
    }

    const degraded = await fetch(`${DEGRADED}/api/portfolios/${PORTFOLIO}`, {
      signal: AbortSignal.timeout(60_000),
    }).then((r) => r.json());

    if (degraded.error) {
      return { status: "PASS", detail: `with no RPC, health says unavailable and reads fail loudly: ${degraded.error}` };
    }
    if (!degraded.stale) {
      return { status: "FAIL", detail: "a snapshot served without a working RPC was NOT labelled stale" };
    }
    return {
      status: "PASS",
      detail: `health ok:false rpc:unavailable; snapshot served from block ${degraded.blockNumber} labelled stale (${degraded.stale.reason})`,
    };
  },
);

await run(
  "owner-recovery-always",
  "the owner must be able to withdraw with no cooperation",
  async () => {
    const held = await pub.readContract({ address: TUSDC, abi: erc20Abi, functionName: "balanceOf", args: [PORTFOLIO] });
    if (held === 0n) return { status: "SKIP", detail: "portfolio holds no collateral" };
    await pub.simulateContract({
      address: PORTFOLIO, abi, functionName: "withdraw",
      args: [TUSDC, wallets.OWNER.address, held],
      account: wallets.OWNER.address,
    });
    return { status: "PASS", detail: `owner can withdraw the full ${held} balance with agents live` };
  },
);

// =============================================================================

const pass = results.filter((r) => r.status === "PASS").length;
const fail = results.filter((r) => r.status === "FAIL").length;
const skip = results.filter((r) => r.status === "SKIP").length;

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);

fs.mkdirSync("evidence/production", { recursive: true });
fs.writeFileSync(
  "evidence/production/adversarial.json",
  `${JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      chainId: 50312,
      portfolio: PORTFOLIO,
      market: market ? { id: market.id, cadence: market.cadence, domain: market.domain } : null,
      summary: { pass, fail, skip },
      cases: results,
    },
    null,
    2,
  )}\n`,
);
console.log("wrote evidence/production/adversarial.json");

process.exit(fail === 0 ? 0 : 1);
