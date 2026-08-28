#!/usr/bin/env node
/**
 * Stand up the live campaign portfolio.
 *
 * Creates a portfolio from the deployed factory, funds it, sets the global
 * policy, opens the cadence domains that currently have live markets, and
 * registers the three sample agents with DELIBERATELY DIFFERENT limits.
 *
 * Everything it writes is an on-chain transaction signed by the owner key in
 * .wallets.json. Nothing here talks to the AIRSPACE backend, and nothing here
 * is required for the product to work: it is a one-shot operator script.
 *
 *   node scripts/campaign-setup.mjs [--salt airspace-live] [--fund 6000]
 */
import fs from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  keccak256,
  toHex,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.SHANNON_RPC ?? "https://dream-rpc.somnia.network";
const CHAIN = {
  id: 50312,
  name: "Somnia Shannon",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const SALT_LABEL = arg("salt", "airspace-live");
const FUND = arg("fund", "6000");

const deployment = JSON.parse(fs.readFileSync("contracts/deployments/50312.json", "utf8"));
const FACTORY = deployment.contracts.AirspacePortfolioFactory;
const TUSDC = deployment.dreamdex.collateral;
const MODULE = deployment.dreamdex.binaryModule;

const portfolioAbi = JSON.parse(
  fs.readFileSync("contracts/out/AirspacePortfolio.sol/AirspacePortfolio.json", "utf8"),
).abi;
const factoryAbi = JSON.parse(
  fs.readFileSync("contracts/out/AirspacePortfolioFactory.sol/AirspacePortfolioFactory.json", "utf8"),
).abi;

const wallets = JSON.parse(fs.readFileSync(".wallets.json", "utf8"));
const owner = privateKeyToAccount(wallets.OWNER.private_key);

const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });
const wallet = createWalletClient({ account: owner, chain: CHAIN, transport: http(RPC) });

const send = async (label, req) => {
  const hash = await wallet.writeContract(req);
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`  ${label.padEnd(28)} ${r.status.padEnd(8)} ${hash}`);
  if (r.status !== "success") throw new Error(`${label} reverted`);
  return r;
};

// --- domains currently carrying live markets ---------------------------------

const MODULE_ABI = [
  {
    type: "function",
    name: "markets",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [
      { type: "uint256" }, { type: "uint8" }, { type: "uint8" }, { type: "address" }, { type: "uint32" },
      { type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" },
      { type: "uint256" }, { type: "uint256" }, { type: "uint64" }, { type: "uint64" },
    ],
  },
];

const CANONICAL = [60, 300, 900, 1800, 3600, 14400, 86400];
const canonicalCadence = (start, expiry) => {
  const span = Number(expiry - start);
  for (const c of CANONICAL) {
    if (c >= span && Number(expiry) % c === 0) return c;
  }
  return 0;
};

const domainKey = (creator, collateral, cadence) =>
  keccak256(
    `0x${creator.slice(2).padStart(64, "0")}${collateral.slice(2).padStart(64, "0")}${cadence
      .toString(16)
      .padStart(64, "0")}`,
  );

const readMarket = async (id) => {
  const r = await pub.readContract({ address: MODULE, abi: MODULE_ABI, functionName: "markets", args: [id] });
  if (r[9] === "0x0000000000000000000000000000000000000000") return null;
  const cadence = canonicalCadence(r[12], r[13]);
  return {
    id,
    creator: r[7],
    collateral: r[3],
    pool: r[9],
    expiry: r[13],
    cadence,
    domain: cadence === 0 ? null : domainKey(r[7], r[3], cadence),
  };
};

async function liveDomains(now) {
  const exists = async (n) => Boolean(await readMarket(`0x${n.toString(16).padStart(64, "0")}`));
  let lo = 0x1000n;
  let hi = 0x1000n;
  while (await exists(hi)) {
    lo = hi;
    hi *= 2n;
    if (hi > 0x400000n) break;
  }
  while (lo + 1n < hi) {
    const mid = (lo + hi) / 2n;
    if (await exists(mid)) lo = mid;
    else hi = mid;
  }

  const found = new Map();
  for (let i = 0n; i < 60n && lo - i > 0n; i++) {
    const m = await readMarket(`0x${(lo - i).toString(16).padStart(64, "0")}`);
    if (!m?.domain) continue;
    if (Number(m.expiry) - now < 120) continue;
    const e = found.get(m.domain) ?? { ...m, count: 0 };
    e.count += 1;
    found.set(m.domain, e);
  }
  return [...found.values()].sort((a, b) => a.cadence - b.cadence);
}

// --- run ---------------------------------------------------------------------

const salt = keccak256(toHex(SALT_LABEL));
const predicted = await pub.readContract({
  address: FACTORY,
  abi: factoryAbi,
  functionName: "portfolioFor",
  args: [owner.address, salt],
});
const already = await pub.readContract({
  address: FACTORY,
  abi: factoryAbi,
  functionName: "isPortfolio",
  args: [predicted],
});

console.log(`owner      ${owner.address}`);
console.log(`factory    ${FACTORY}`);
console.log(`salt       "${SALT_LABEL}"`);
console.log(`portfolio  ${predicted}${already ? "  (exists)" : "  (new)"}\n`);

if (!already) {
  await send("createPortfolio", {
    address: FACTORY,
    abi: factoryAbi,
    functionName: "createPortfolio",
    args: [owner.address, salt],
    chain: CHAIN,
  });
}

const fundAmount = parseUnits(FUND, 6);
const held = await pub.readContract({ address: TUSDC, abi: erc20Abi, functionName: "balanceOf", args: [predicted] });

if (held < fundAmount) {
  const need = fundAmount - held;
  await send("approve", {
    address: TUSDC,
    abi: erc20Abi,
    functionName: "approve",
    args: [predicted, need],
    chain: CHAIN,
  });
  await send("fund", { address: predicted, abi: portfolioAbi, functionName: "fund", args: [need], chain: CHAIN });
}

await send("setCapitalBase", {
  address: predicted,
  abi: portfolioAbi,
  functionName: "setCapitalBase",
  args: [fundAmount],
  chain: CHAIN,
});

const nowSec = Math.floor(Date.now() / 1000);
await send("setGlobalPolicy", {
  address: predicted,
  abi: portfolioAbi,
  functionName: "setGlobalPolicy",
  args: [
    {
      maxCommittedCapital: parseUnits("5000", 6),
      maxReservedCollateral: parseUnits("3000", 6),
      maxSingleOrderNotional: parseUnits("500", 6),
      maxBuyPrice: parseUnits("0.95", 6),
      minSellPrice: parseUnits("0.05", 6),
      minHeadroomSec: 60n,
      policyExpiry: BigInt(nowSec + 30 * 86400),
    },
  ],
  chain: CHAIN,
});

const domains = await liveDomains(nowSec);
console.log(`\n  live domains: ${domains.length}`);
for (const d of domains) {
  console.log(`    ${d.cadence}s  ${d.domain}  (${d.count} markets, creator ${d.creator.slice(0, 10)}…)`);
  await send(`setDomainPolicy ${d.cadence}s`, {
    address: predicted,
    abi: portfolioAbi,
    functionName: "setDomainPolicy",
    args: [
      d.domain,
      {
        configured: true,
        // Deliberately tight. The point of the campaign is to reach the
        // ceiling with three agents, not to avoid it.
        maxDomainRiskUsage: parseUnits("500", 6),
        maxDomainCommitted: parseUnits("1000", 6),
        maxLiveMarkets: 8,
      },
    ],
    chain: CHAIN,
  });
}

// Three agents, three different envelopes. None of them alone can breach the
// domain ceiling; together they can, which is the whole point.
const AGENTS = [
  { key: "AGENT_A", strategy: "momentum", maxCommitted: "1500", maxOrder: "200" },
  { key: "AGENT_B", strategy: "reversion", maxCommitted: "1500", maxOrder: "300" },
  { key: "AGENT_C", strategy: "spread", maxCommitted: "1500", maxOrder: "150" },
];

console.log("");
for (const a of AGENTS) {
  const addr = wallets[a.key].address;
  await send(`setAgent ${a.strategy}`, {
    address: predicted,
    abi: portfolioAbi,
    functionName: "setAgent",
    args: [
      addr,
      {
        enabled: true,
        maxCommitted: parseUnits(a.maxCommitted, 6),
        maxOrderNotional: parseUnits(a.maxOrder, 6),
        maxBuyPrice: parseUnits("0.95", 6),
        minSellPrice: parseUnits("0.05", 6),
        cooldownSec: 0n,
        strategyId: keccak256(toHex(a.strategy)),
      },
    ],
    chain: CHAIN,
  });
}

const [base, free, committed] = await Promise.all([
  pub.readContract({ address: predicted, abi: portfolioAbi, functionName: "capitalBase" }),
  pub.readContract({ address: predicted, abi: portfolioAbi, functionName: "freeCollateral" }),
  pub.readContract({ address: predicted, abi: portfolioAbi, functionName: "committedCapital" }),
]);

const out = {
  chainId: 50312,
  factory: FACTORY,
  portfolio: predicted,
  owner: owner.address,
  saltLabel: SALT_LABEL,
  capitalBase: base.toString(),
  freeCollateral: free.toString(),
  committedCapital: committed.toString(),
  domains: domains.map((d) => ({ domain: d.domain, cadenceSec: d.cadence, creator: d.creator, markets: d.count })),
  agents: AGENTS.map((a) => ({ strategy: a.strategy, address: wallets[a.key].address })),
  configuredAt: new Date().toISOString(),
};

fs.mkdirSync("evidence/production", { recursive: true });
fs.writeFileSync("evidence/production/campaign.json", `${JSON.stringify(out, null, 2)}\n`);

console.log(`\nportfolio ${predicted}`);
console.log(`capitalBase ${base} free ${free} committed ${committed}`);
console.log("wrote evidence/production/campaign.json");
