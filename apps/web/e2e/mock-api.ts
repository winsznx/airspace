import type { Page, Route } from "@playwright/test";

/**
 * Deterministic API fixtures for the browser critical-path suite.
 *
 * Everything the app reads over `/api/*` is intercepted and answered from
 * these fixtures — never from the real Worker or live Shannon. That keeps CI
 * fast and immune to the venue's own state (rolling markets, a moved ceiling,
 * an RPC outage), which is the live dependency called out as a flake risk.
 * `scripts/live-proof.mjs` and friends remain the live E2E check.
 */

export const PORTFOLIO = "0x637b05C8aa242325bCD2Bb91752810cCE7afEf1C";
export const DOMAIN = "0x26cae3367750f143ba311e4fea97e152283edabcb80d500f17ce049ce3332ebc";
export const AGENT_A = "0x551051f987b011329F29E8c069D8cb6ff2C2b084";
export const AGENT_B = "0x78D4bdCbAAb1b9c05c9c3c23C6C39fd34064D4cE";
export const MARKET_ID = "0x000000000000000000000000000000000000000000000000000000000000c124";
export const INTENT_HASH = "0x" + "ab".repeat(32);

export const deploymentVerificationFixture = {
  ok: true,
  network: {
    name: "Somnia Shannon",
    chainId: 50312,
    nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
    explorer: "https://shannon-explorer.somnia.network",
  },
  collateral: {
    address: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
    symbolOnChain: "tUSDC",
    decimalsOnChain: 6,
    description: "DreamDEX's official Shannon test collateral for this venue — not a scarce faucet token AIRSPACE depends on.",
  },
  checks: [
    { key: "chainId", label: "Chain ID", expected: "50312", actual: "50312", pass: true },
    { key: "factoryCollateral", label: "Factory-pinned collateral (all portfolios)", expected: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E", actual: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E", pass: true },
    { key: "collateralDecimals", label: "Collateral decimals()", expected: "6", actual: "6", pass: true },
    { key: "portfolioCollateral", label: "Portfolio 0x637b05C8… collateralToken()", expected: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E", actual: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E", pass: true },
  ],
  recentTransaction: {
    hash: "0x" + "cd".repeat(32),
    blockNumber: "478000000",
    status: "success",
    gasUsed: "210000",
    effectiveGasPriceWei: "12000000000",
    nativeFeePaid: "2520000000000000",
  },
  recentTransactionError: null,
  explorerTxUrl: "https://shannon-explorer.somnia.network/tx/0x" + "cd".repeat(32),
};

export const configFixture = {
  chainId: 50312,
  factory: "0xeD3D4552AFda96EfC5BF47c533E3302C655CB732",
  supabaseUrl: "https://example.supabase.co",
  supabaseAnonKey: "anon-key-not-real",
  explorer: "https://shannon-explorer.somnia.network",
};

export function portfolioSnapshot(over: Partial<{ usage: string; ceiling: string }> = {}) {
  return {
    portfolio: PORTFOLIO,
    chainId: 50312,
    blockNumber: "473600000",
    fetchedAt: Date.now(),
    owner: "0x4Bd0bf9821F23f822eb44B1F095594e2BbBC06Bc",
    collateralToken: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
    capitalBase: "6000000000",
    freeCollateral: "5760000000",
    committedCapital: "240000000",
    reservedCollateral: "240000000",
    globalPolicyHash: "0x" + "11".repeat(32),
    policyEpoch: "1",
    domains: [
      {
        domain: DOMAIN,
        usage: over.usage ?? "420000000",
        ceiling: over.ceiling ?? "500000000",
        committedCeiling: "0",
        liveMarkets: 2,
        marketCount: 2,
        configured: true,
      },
    ],
  };
}

export const marketsFixture = {
  markets: [
    {
      marketId: MARKET_ID,
      pool: "0xf50f7a2D4beaEf6c875F6155a88A1348917c7F9F",
      marketAddress: "0x" + "22".repeat(20),
      marketNonce: "134",
      creator: "0x94D963B6670AB96E78C8d0C46ca35D196d606EFE",
      collateral: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
      tradingStart: "1800000000",
      expiry: "1800003600",
      cadenceSec: 3600,
      cadenceLabel: "1h",
      domain: DOMAIN,
      live: {
        trading: true,
        secondsRemaining: 1800,
        tickSize: "1000",
        lotSize: "1000",
        minQuantity: "1000",
        marketExpiryNs: "1800003600000000000",
      },
    },
  ],
};

export const agentsFixture = {
  agents: [
    {
      address: AGENT_A,
      displayName: "Momentum",
      strategyId: "momentum",
      strategyVersion: "v1",
      enabled: true,
      policy: {
        maxCommitted: "80000000000",
        maxOrderNotional: "50000000000",
        maxBuyPrice: "990000",
        minSellPrice: "10000",
        cooldownSec: "0",
      },
      committed: "180000000",
      nonce: "4",
      registeredTx: "0x" + "aa".repeat(32),
    },
    {
      address: AGENT_B,
      displayName: "Reversion",
      strategyId: "reversion",
      strategyVersion: "v1",
      enabled: true,
      policy: {
        maxCommitted: "80000000000",
        maxOrderNotional: "50000000000",
        maxBuyPrice: "990000",
        minSellPrice: "10000",
        cooldownSec: "0",
      },
      committed: "240000000",
      nonce: "2",
      registeredTx: "0x" + "bb".repeat(32),
    },
  ],
};

export const reconciliationPending = {
  domains: [
    {
      domain: DOMAIN,
      pendingReleaseCount: 2,
      pendingReleaseAmount: "270000000",
      oldestPendingReleaseAgeSec: 340,
      lastReconciledAt: new Date(Date.now() - 6 * 60_000).toISOString(),
      marketsTracked: 45,
      marketsCap: 48,
      independentWorstCase: "420000000",
    },
  ],
};

export const reconciliationClear = {
  domains: [
    {
      domain: DOMAIN,
      pendingReleaseCount: 0,
      pendingReleaseAmount: "0",
      oldestPendingReleaseAgeSec: null,
      lastReconciledAt: new Date(Date.now() - 30_000).toISOString(),
      marketsTracked: 2,
      marketsCap: 48,
      independentWorstCase: "420000000",
    },
  ],
};

const REFUSAL_COPY_DOMAIN = {
  title: "Blocked by the shared risk envelope",
  detail: "This order is valid on its own. Combined with what other agents already hold and have reserved, it would push the domain over its ceiling.",
  action: "Wait for a reservation to release, or ask the owner to raise the domain ceiling.",
};

export function simulateAdmitted() {
  return {
    intent: { marketId: MARKET_ID, kind: 0, price: "550000", quantity: "10000000" },
    decision: { admitted: true, refusal: 0, refusalName: null, copy: null, blockingGate: null },
    gates: [
      { key: "agent", label: "Agent policy", pass: true, blocking: false },
      { key: "market", label: "Market trading", pass: true, blocking: false },
      { key: "generation", label: "Market generation", pass: true, blocking: false },
      { key: "grid", label: "Tick / lot", pass: true, blocking: false },
      { key: "price", label: "Price ceiling", pass: true, blocking: false },
      { key: "headroom", label: "Market headroom", pass: true, blocking: false },
      { key: "portfolio", label: "Portfolio domain", pass: true, blocking: false },
    ],
    arithmetic: { before: "420000000", requested: "10000000", after: "430000000", ceiling: "500000000" },
    raw: {},
    advisory:
      "Advisory preview — rechecked atomically on-chain at submission. Another agent may consume headroom first; a successful preview is not a promise that execution will succeed.",
  };
}

export function simulateRefused() {
  return {
    intent: { marketId: MARKET_ID, kind: 0, price: "550000", quantity: "150000000" },
    decision: {
      admitted: false,
      refusal: 22,
      refusalName: "DOMAIN_RISK_EXCEEDED",
      copy: REFUSAL_COPY_DOMAIN,
      blockingGate: "portfolio",
    },
    gates: [
      { key: "agent", label: "Agent policy", pass: true, blocking: false },
      { key: "market", label: "Market trading", pass: true, blocking: false },
      { key: "generation", label: "Market generation", pass: true, blocking: false },
      { key: "grid", label: "Tick / lot", pass: true, blocking: false },
      { key: "price", label: "Price ceiling", pass: true, blocking: false },
      { key: "headroom", label: "Market headroom", pass: true, blocking: false },
      { key: "portfolio", label: "Portfolio domain", pass: false, blocking: true },
    ],
    arithmetic: { before: "420000000", requested: "150000000", after: "570000000", ceiling: "500000000" },
    raw: {},
    advisory:
      "Advisory preview — rechecked atomically on-chain at submission. Another agent may consume headroom first; a successful preview is not a promise that execution will succeed.",
  };
}

export function refusedReceipt() {
  return {
    receipt: {
      intent_hash: INTENT_HASH,
      decision: "REFUSED",
      refusal_code: 22,
      agent_address: AGENT_A,
      market_id: MARKET_ID,
      domain_hash: DOMAIN,
      global_policy_hash: "0x" + "11".repeat(32),
      agent_policy_hash: "0x" + "22".repeat(32),
      reserve_required: "150000000",
      filled_qty: null,
      filled_cost: null,
      resting_qty: null,
      directional_before: "420000000",
      directional_after: null,
      domain_usage_before: "420000000",
      domain_usage_after: "570000000",
      committed_after: null,
      tx_hash: null,
      block_number: null,
      provenance: { domain_usage_before: "contract", domain_usage_after: "contract" },
      created_at: new Date().toISOString(),
    },
    copy: REFUSAL_COPY_DOMAIN,
    refusalName: "DOMAIN_RISK_EXCEEDED",
  };
}

/**
 * Register `/api/*` route interception on `page`. Call before navigation.
 * `overrides` maps a path-matching predicate to a JSON body or a full
 * `{status, body}`, checked before the default fixtures.
 */
export async function mockApi(
  page: Page,
  overrides: Array<{
    match: (url: URL) => boolean;
    respond: (route: Route) => Promise<void> | void;
  }> = [],
): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();

    for (const o of overrides) {
      if (o.match(url)) return o.respond(route);
    }

    if (p === "/api/config") return json(route, configFixture);
    if (p === "/api/health") return json(route, { ok: true, chainId: 50312, factory: configFixture.factory, rpc: "ok", blockNumber: "473600000" });
    if (p === "/api/markets") return json(route, marketsFixture);
    if (p.match(/^\/api\/portfolios\/0x[0-9a-fA-F]{40}$/)) return json(route, portfolioSnapshot());
    if (p.endsWith("/agents")) return json(route, agentsFixture);
    if (p.endsWith("/reconciliation")) return json(route, reconciliationClear);
    if (p.includes("/reservations")) return json(route, { reservations: [], total: 0, limit: 25, offset: 0 });
    if (p.includes("/positions")) return json(route, { positions: [], total: 0, limit: 25, offset: 0 });
    if (p.includes("/receipts") || p.includes("/intents")) return json(route, { intents: [], receipts: [], total: 0, limit: 25, offset: 0 });
    if (p === "/api/intents/simulate" && method === "POST") return json(route, simulateAdmitted());
    if (p === "/api/reconcile/request" && method === "POST") return json(route, { queued: true, deduplicated: false, kind: "release-order" });
    if (p === "/api/deployment/verify") return json(route, deploymentVerificationFixture);

    return json(route, { error: "no fixture for this path", path: p }, 404);
  });
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}
