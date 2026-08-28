#!/usr/bin/env node
/**
 * Drive the live campaign.
 *
 * Ticks the three agents CONCURRENTLY on every round. That concurrency is the
 * point: each agent previews independently, all three previews pass, and then
 * their transactions land one after another against a shared envelope that has
 * moved. Refusals produced this way are real races, not staged ones.
 *
 *   node scripts/campaign-run.mjs [--rounds 20] [--every 20]
 */
import fs from "node:fs";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const ROUNDS = Number(arg("rounds", 20));
const EVERY = Number(arg("every", 20)) * 1000;
const AGENTS = [
  { name: "momentum", url: arg("momentum", "http://127.0.0.1:8801") },
  { name: "reversion", url: arg("reversion", "http://127.0.0.1:8802") },
  { name: "spread", url: arg("spread", "http://127.0.0.1:8803") },
];
const INDEXER = arg("indexer", "http://127.0.0.1:8788");
const INDEXER_TOKEN = process.env.INDEXER_TOKEN ?? "local-dev-token";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tally = {
  rounds: 0,
  byOutcome: {},
  byAgent: {},
  submitted: [],
  refusedOnChain: [],
  refusedPreflight: [],
};

const bump = (o, k) => {
  o[k] = (o[k] ?? 0) + 1;
};

for (let round = 1; round <= ROUNDS; round += 1) {
  const results = await Promise.all(
    AGENTS.map(async (a) => {
      try {
        const res = await fetch(`${a.url}/tick`, { method: "POST" });
        return await res.json();
      } catch (e) {
        return { strategy: a.name, outcome: "driver-error", error: String(e).slice(0, 120) };
      }
    }),
  );

  tally.rounds += 1;
  const line = [];
  for (const r of results) {
    bump(tally.byOutcome, r.outcome);
    tally.byAgent[r.strategy] ??= {};
    bump(tally.byAgent[r.strategy], r.outcome);

    if (r.outcome === "submitted") tally.submitted.push({ strategy: r.strategy, txHash: r.txHash, market: r.market });
    if (r.outcome === "refused-onchain") {
      tally.refusedOnChain.push({ strategy: r.strategy, txHash: r.txHash, market: r.market, reported: r.reported });
    }
    if (r.outcome === "refused-preflight") {
      tally.refusedPreflight.push({ strategy: r.strategy, refusal: r.refusal, market: r.market });
    }

    const detail =
      r.outcome === "refused-preflight"
        ? r.refusal?.name
        : r.outcome === "venue-rejected"
          ? r.error
          : r.outcome === "submitted" || r.outcome === "refused-onchain"
            ? r.txHash?.slice(0, 12)
            : (r.error ?? "").slice(0, 30);
    line.push(`${r.strategy}:${r.outcome}${detail ? `(${detail})` : ""}`);
  }
  console.log(`round ${String(round).padStart(3)}  ${line.join("  ")}`);

  // Keep the projections moving so the web app has something live to show.
  try {
    await fetch(`${INDEXER}/ingest`, { method: "POST", headers: { authorization: `Bearer ${INDEXER_TOKEN}` } });
  } catch {
    /* the indexer is optional to the campaign; agents do not depend on it */
  }

  if (round < ROUNDS) await sleep(EVERY);
}

fs.mkdirSync("evidence/production", { recursive: true });
fs.writeFileSync("evidence/production/campaign-run.json", `${JSON.stringify(tally, null, 2)}\n`);

console.log("\noutcomes:", JSON.stringify(tally.byOutcome));
console.log("submitted:", tally.submitted.length);
console.log("refused on chain:", tally.refusedOnChain.length);
console.log("refused preflight:", tally.refusedPreflight.length);
console.log("wrote evidence/production/campaign-run.json");
