#!/usr/bin/env node
/**
 * Reproduction: `getFills` / `getUserFills` cannot scope by market, so `limit`
 * truncates across market generations on a recycled binary pool.
 *
 * No SDK install and no credentials needed — it queries the same public Hasura
 * endpoint `@somnia-chain/markets-sdk` uses, with the same `where` shape the
 * SDK builds.
 *
 *   node contributions/dreamdex/reproduce-fill-scoping.mjs
 *   node contributions/dreamdex/reproduce-fill-scoping.mjs --indexer <url> --limit 50
 *
 * Writes the measured result to contributions/dreamdex/evidence.json.
 */
import fs from "node:fs";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

// The testnet indexer, as configured in dreamdex-bot-kit packages/ec-core/src/config.ts.
const INDEXER = arg("indexer", "https://dev.smk.somnia.host/v1/graphql");
const LIMIT = Number(arg("limit", 50));
const SCAN = Number(arg("scan", 1000));

const gql = async (query, variables) => {
  const r = await fetch(INDEXER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 400));
  return j.data;
};

const page = (where, limit) =>
  gql(
    `query($where:Fill_bool_exp!,$limit:Int!){
       Fill(where:$where, order_by:{timestamp:desc}, limit:$limit){ id market_id pool timestamp }
     }`,
    { where, limit },
  ).then((d) => d.Fill);

// --- 1. find a recycled pool -------------------------------------------------

const recent = await gql(
  `query($limit:Int!){ Fill(order_by:{timestamp:desc}, limit:$limit){ id pool market_id timestamp } }`,
  { limit: SCAN },
);

const byPool = new Map();
for (const f of recent.Fill) {
  const gens = byPool.get(f.pool) ?? new Map();
  gens.set(f.market_id, (gens.get(f.market_id) ?? 0) + 1);
  byPool.set(f.pool, gens);
}
const recycled = [...byPool.entries()].filter(([, gens]) => gens.size > 1);

console.log(`scanned the last ${recent.Fill.length} fills on ${INDEXER}`);
console.log(`distinct pools: ${byPool.size}`);
console.log(`pools carrying fills from more than one marketId: ${recycled.length}`);

if (recycled.length === 0) {
  console.log("\nno recycled pool inside this window — widen with --scan");
  process.exit(0);
}

// --- 2. the pool-scoped page the SDK returns today ---------------------------

// Pick the pool whose page mixes the most generations: the effect is the same
// on any recycled pool, this just makes it easiest to see.
const poolScopedPages = await Promise.all(
  recycled.map(async ([pool]) => {
    const rows = await page({ pool: { _eq: pool } }, LIMIT);
    const gens = new Map();
    for (const f of rows) gens.set(f.market_id, (gens.get(f.market_id) ?? 0) + 1);
    return { pool, rows, gens };
  }),
);
poolScopedPages.sort((a, b) => b.gens.size - a.gens.size);
const { pool, rows, gens } = poolScopedPages[0];

// The market that owns the newest fill on that pool — what a caller watching
// the pool right now would be asking about.
const target = rows[0].market_id;

console.log(`\ngetFills("${pool}", { limit: ${LIMIT} })`);
console.log(`  rows returned:            ${rows.length}`);
console.log(`  market generations in it: ${gens.size}`);
console.log(`  rows for the newest market ${BigInt(target)}: ${gens.get(target) ?? 0}`);
console.log(
  `  breakdown: ${[...gens.entries()].map(([m, n]) => `${BigInt(m)}:${n}`).join("  ")}`,
);

// --- 3. what a server-side market filter returns -----------------------------

const scoped = await page({ pool: { _eq: pool }, market_id: { _eq: target } }, LIMIT);
console.log(`\ngetFills("${pool}", { limit: ${LIMIT}, market: "${target}" })   <- proposed`);
console.log(`  rows returned: ${scoped.length}`);
console.log(`  all in target market: ${scoped.every((f) => f.market_id === target)}`);

// --- 4. is the caller's client-side filter losing rows? ----------------------

// `Fill_aggregate` is not exposed on the public role, so count with a deep page.
const whole = await page({ pool: { _eq: pool }, market_id: { _eq: target } }, 1000);
const clientSide = gens.get(target) ?? 0;

console.log(`\n  fills that exist in that market:            ${whole.length}`);
console.log(`  a caller filtering the page client-side sees: ${clientSide}`);
console.log(
  whole.length > clientSide
    ? `  TRUNCATED: ${whole.length - clientSide} fills silently missing from the page.`
    : `  Not truncated in this window, but ${gens.size - 1} unrelated generations were fetched to find ${clientSide} rows.`,
);

// --- 5. which generations does the page actually truncate? -------------------

// A caller asking "the last N fills in market M" pages the pool and filters.
// For every generation the page touched, compare what the page yielded against
// what the market really holds.
const perGeneration = [];
for (const [market, inPage] of gens) {
  const all = await page({ pool: { _eq: pool }, market_id: { _eq: market } }, 1000);
  perGeneration.push({ market: String(BigInt(market)), inPage, total: all.length, truncated: all.length > inPage });
}
perGeneration.sort((a, b) => b.total - b.inPage - (a.total - a.inPage));

const truncated = perGeneration.filter((g) => g.truncated);
console.log(`\nper generation, in one ${LIMIT}-row pool page vs what the market holds:`);
for (const g of perGeneration) {
  console.log(
    `  market ${g.market.padStart(6)}  page:${String(g.inPage).padStart(3)}  actual:${String(g.total).padStart(3)}  ${g.truncated ? `MISSING ${g.total - g.inPage}` : "complete"}`,
  );
}
console.log(
  truncated.length > 0
    ? `\n  ${truncated.length} of ${perGeneration.length} generations are silently truncated by this page.`
    : `\n  no generation truncated at limit ${LIMIT}.`,
);

// The page size a caller needs to see a given generation whole is not a property
// of that generation at all: it is however many fills the pool recorded after
// the generation's OLDEST fill. That number keeps growing as the pool is reused,
// so a limit that worked yesterday silently truncates tomorrow.
const deepest = perGeneration.reduce((a, b) => (b.total > a.total ? b : a));
const deepestId = [...gens.keys()].find((m) => String(BigInt(m)) === deepest.market);
const oldest = (await page({ pool: { _eq: pool }, market_id: { _eq: deepestId } }, 1000)).at(-1);
const needed = (
  await page({ pool: { _eq: pool }, timestamp: { _gte: oldest.timestamp } }, 1000)
).length;

console.log(`\n  market ${deepest.market} holds ${deepest.total} fills.`);
console.log(`  to see them all through the pool-scoped API a caller must request limit >= ${needed}.`);
console.log(`  that threshold grows every time the pool is reused, so no fixed limit stays correct.`);

const evidence = {
  measuredAt: new Date().toISOString(),
  perGeneration,
  truncatedGenerations: truncated.length,
  deepestGeneration: { market: deepest.market, fills: deepest.total, limitNeededOnPoolScopedApi: needed },
  indexer: INDEXER,
  limit: LIMIT,
  scanned: recent.Fill.length,
  distinctPools: byPool.size,
  recycledPools: recycled.length,
  pool,
  targetMarketId: target,
  generationsInOnePage: gens.size,
  generationBreakdown: Object.fromEntries([...gens.entries()].map(([m, n]) => [String(BigInt(m)), n])),
  rowsForTargetInPage: clientSide,
  rowsForTargetTotal: whole.length,
  truncated: whole.length > clientSide,
};
const out = new URL("./evidence.json", import.meta.url).pathname;
fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`\nwrote ${out}`);
