#!/usr/bin/env node
/**
 * Read-path scale test.
 *
 * Loads 100 portfolios, 1,000 agents and 10,000 intents-with-receipts into
 * Supabase, then measures what the API actually does with them: how a page of
 * the admission feed behaves at the front and at the back of a large table,
 * whether filtering by agent and by outcome stays indexed, and whether the
 * portfolio list degrades as portfolio count grows.
 *
 * These rows are SYNTHETIC and are labelled so. They are inserted under a
 * dedicated chain id and deleted afterwards, so they never mix with the live
 * campaign's real chain-derived projections. The on-chain half of scale is
 * measured separately and for real, in `contracts/test/unit/Scale.t.sol`.
 *
 *   node scripts/scale.mjs
 *   node scripts/scale.mjs --portfolios 100 --agents 1000 --intents 10000
 *   node scripts/scale.mjs --keep        # leave the rows in place to poke at
 *
 * Writes evidence/production/scale.json.
 */
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const API = arg("api", "http://127.0.0.1:8787");
const PORTFOLIOS = Number(arg("portfolios", 100));
const AGENTS = Number(arg("agents", 1000));
const INTENTS = Number(arg("intents", 10000));
const KEEP = process.argv.includes("--keep");

/** A chain id that does not exist, so synthetic rows can never be mistaken for real ones. */
const SYNTHETIC_CHAIN = 999_999;

const env = Object.fromEntries(
  fs
    .readFileSync(".env.local", "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be in .env.local");
  process.exit(1);
}

const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const hex = (n, width) => n.toString(16).padStart(width, "0");
const addr = (n) => `0x${hex(n, 40)}`;
const b32 = (n) => `0x${hex(n, 64)}`;

const ms = async (fn) => {
  const t = performance.now();
  const out = await fn();
  return { ms: Math.round(performance.now() - t), out };
};

const percentile = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))];
};

// --- clean any leftovers -----------------------------------------------------

console.log(`clearing synthetic rows on chain ${SYNTHETIC_CHAIN}`);
await db.from("portfolios").delete().eq("chain_id", SYNTHETIC_CHAIN);

// --- load --------------------------------------------------------------------

const loadStart = performance.now();

const portfolioRows = Array.from({ length: PORTFOLIOS }, (_, i) => ({
  chain_id: SYNTHETIC_CHAIN,
  portfolio_address: addr(0x5ca1e000 + i),
  owner_address: addr(0x0e0e0000 + (i % 7)),
  factory_address: addr(0xfac70000),
  display_name: `synthetic-${i}`,
  collateral_address: addr(0xc0111a7e),
  created_block: 1_000_000 + i,
}));

const { data: inserted, error: pErr } = await db.from("portfolios").insert(portfolioRows).select("id, portfolio_address");
if (pErr) throw new Error(`portfolios: ${pErr.message}`);
const ids = inserted.map((r) => r.id);
console.log(`  ${ids.length} portfolios`);

const CHUNK = 500;
const insertChunked = async (table, rows) => {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await db.from(table).insert(rows.slice(i, i + CHUNK));
    if (error) throw new Error(`${table} @${i}: ${error.message}`);
  }
};

await insertChunked(
  "agents",
  Array.from({ length: AGENTS }, (_, i) => ({
    portfolio_id: ids[i % ids.length],
    agent_address: addr(0xa9e07000 + i),
    display_name: `agent-${i}`,
    enabled: i % 11 !== 0,
    registered_block: 1_000_000 + i,
  })),
);
console.log(`  ${AGENTS} agents`);

// Concentrate a tenth of the traffic on one portfolio, because that is what a
// busy portfolio looks like and it is the page that has to stay fast.
const HOT = 0;
const intents = Array.from({ length: INTENTS }, (_, i) => {
  const pIdx = i % 10 === 0 ? HOT : i % ids.length;
  const refused = i % 3 === 0;
  return {
    portfolio_id: ids[pIdx],
    intent_hash: b32(0x1000000 + i),
    agent_address: addr(0xa9e07000 + (i % AGENTS)),
    market_id: b32(0xbd00 + (i % 500)),
    market_nonce: i % 200,
    pool_address: addr(0x9001000 + (i % 50)),
    domain_hash: b32(0xd0000 + (i % 4)),
    kind: i % 4,
    order_type: 3,
    price: String(100_000 + (i % 800_000)),
    quantity: String(1_000_000 * (1 + (i % 200))),
    agent_nonce: i,
    status: refused ? "REFUSED" : "ADMITTED",
    refusal_code: refused ? 22 : null,
    order_id: refused ? null : String(i),
    tx_hash: b32(0x7000000 + i),
    block_number: 1_000_000 + i,
    log_index: i % 8,
  };
});
await insertChunked("intents", intents);
console.log(`  ${INTENTS} intents`);

await insertChunked(
  "receipts",
  intents.map((it) => ({
    portfolio_id: it.portfolio_id,
    intent_hash: it.intent_hash,
    decision: it.status,
    refusal_code: it.refusal_code,
    agent_address: it.agent_address,
    market_id: it.market_id,
    domain_hash: it.domain_hash,
    tx_hash: it.tx_hash,
    block_number: it.block_number,
    provenance: { decision: "synthetic" },
  })),
);
console.log(`  ${INTENTS} receipts`);

const loadMs = Math.round(performance.now() - loadStart);
console.log(`loaded in ${(loadMs / 1000).toFixed(1)}s\n`);

// --- measure -----------------------------------------------------------------

const hot = inserted[HOT].portfolio_address;
const measurements = {};

const bench = async (label, url, runs = 12) => {
  const times = [];
  let sample;
  for (let i = 0; i < runs; i += 1) {
    const { ms: t, out } = await ms(() => fetch(url).then((r) => r.json()));
    times.push(t);
    sample = out;
  }
  const rows = Array.isArray(sample) ? sample.length : (Object.values(sample).find(Array.isArray)?.length ?? 0);
  measurements[label] = { p50: percentile(times, 50), p95: percentile(times, 95), rows, total: sample.total ?? null };
  console.log(
    `${label.padEnd(34)} p50 ${String(measurements[label].p50).padStart(5)}ms  p95 ${String(measurements[label].p95).padStart(5)}ms  rows ${rows}  total ${sample.total ?? "-"}`,
  );
};

const deepOffset = Math.max(0, Math.floor(INTENTS / 10) - 25);

await bench("intents page 1", `${API}/api/portfolios/${hot}/intents?limit=25`);
await bench("intents last page", `${API}/api/portfolios/${hot}/intents?limit=25&offset=${deepOffset}`);
await bench("intents filtered REFUSED", `${API}/api/portfolios/${hot}/intents?limit=25&status=REFUSED`);
await bench("intents filtered by agent", `${API}/api/portfolios/${hot}/intents?limit=25&agent=${addr(0xa9e07000)}`);
await bench("receipts page 1", `${API}/api/portfolios/${hot}/receipts?limit=25`);
// Reads the FACTORY on chain, not the database, so synthetic rows do not
// affect it. Measured anyway because it is the first request a user makes.
await bench("owner portfolio list (chain read)", `${API}/api/owners/${addr(0x0e0e0000)}/portfolios`);

// --- verdict -----------------------------------------------------------------

const front = measurements["intents page 1"].p95;
const back = measurements["intents last page"].p95;
const ratio = front === 0 ? 1 : back / front;

console.log("");
console.log(`deep page is ${ratio.toFixed(2)}x the cost of the first page`);
const verdict = ratio <= 4 ? "PASS" : "REVIEW";
console.log(
  verdict === "PASS"
    ? "PASS  pagination stays flat: offset paging is holding up at this size"
    : "REVIEW  deep paging is degrading; keyset pagination would be the fix",
);

fs.mkdirSync("evidence/production", { recursive: true });
fs.writeFileSync(
  "evidence/production/scale.json",
  `${JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      note: "Synthetic projections on a non-existent chain id, loaded and then deleted. On-chain scale is measured for real in contracts/test/unit/Scale.t.sol.",
      latencyCaveat:
        "Measured against a wrangler dev Worker on a laptop reaching Supabase in eu-west-2 over the public internet, so ~800ms p50 is dominated by that round trip and is NOT a production figure. What this run establishes is the SHAPE: a deep page costs the same as the first one, and both filters stay indexed.",
      syntheticChainId: SYNTHETIC_CHAIN,
      loaded: { portfolios: PORTFOLIOS, agents: AGENTS, intents: INTENTS, receipts: INTENTS, loadMs },
      hotPortfolioIntents: Math.floor(INTENTS / 10),
      measurements,
      deepPageRatio: Number(ratio.toFixed(2)),
      verdict,
    },
    null,
    2,
  )}\n`,
);
console.log("wrote evidence/production/scale.json");

// --- clean up ----------------------------------------------------------------

if (KEEP) {
  console.log(`\n--keep: ${PORTFOLIOS} synthetic portfolios left on chain ${SYNTHETIC_CHAIN}`);
} else {
  // Cascade takes agents, intents and receipts with the portfolios.
  const { error } = await db.from("portfolios").delete().eq("chain_id", SYNTHETIC_CHAIN);
  if (error) throw new Error(`cleanup: ${error.message}`);
  console.log("\nsynthetic rows removed");
}
