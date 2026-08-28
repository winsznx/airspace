#!/usr/bin/env node
/**
 * Budget the bundle on the number that matters.
 *
 * The obvious gate — fail any chunk over N kilobytes — measures the wrong
 * thing. Vite emits large chunks on purpose for code that loads lazily: the
 * Safe and Coinbase wallet SDKs are each hundreds of kilobytes and neither is
 * fetched unless someone picks that wallet. Failing on their size would push
 * toward bundling them into the entry, which is strictly worse.
 *
 * What a visitor actually pays for is the entry document's own scripts and
 * styles, compressed. That is what this measures.
 *
 *   node scripts/bundle-budget.mjs
 *   node scripts/bundle-budget.mjs --budget 400
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const DIST = arg("dist", "apps/web/dist");
const BUDGET_KB = Number(arg("budget", 400));

const html = fs.readFileSync(path.join(DIST, "index.html"), "utf8");

// Everything the entry document pulls before the app can render: its module
// scripts, its stylesheets, and anything it asks the browser to preload.
const refs = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
const unique = [...new Set(refs)];

if (unique.length === 0) {
  console.error("no scripts or styles referenced from index.html — did the build run?");
  process.exit(1);
}

const gz = (p) => zlib.gzipSync(fs.readFileSync(p), { level: 9 }).length;

let total = 0;
const rows = [];
for (const ref of unique) {
  const file = path.join(DIST, ref.replace(/^\//, ""));
  if (!fs.existsSync(file)) continue;
  const size = gz(file);
  total += size;
  rows.push({ name: path.basename(ref), kb: size / 1024 });
}

rows.sort((a, b) => b.kb - a.kb);
for (const r of rows) console.log(`  ${r.name.padEnd(34)} ${r.kb.toFixed(1).padStart(7)} kB`);

// Lazy chunks are reported, never gated: they are the reason the entry is small.
const all = fs.readdirSync(path.join(DIST, "assets")).filter((f) => f.endsWith(".js"));
const lazy = all.length - rows.filter((r) => r.name.endsWith(".js")).length;

const totalKb = total / 1024;
console.log(`\n  initial (gzip)  ${totalKb.toFixed(1)} kB of ${BUDGET_KB} kB budget`);
console.log(`  lazy chunks     ${lazy}, fetched only when the code path is taken`);

if (totalKb > BUDGET_KB) {
  console.error(`\nover budget by ${(totalKb - BUDGET_KB).toFixed(1)} kB`);
  process.exit(1);
}
console.log("\nwithin budget");
