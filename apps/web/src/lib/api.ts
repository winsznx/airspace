/**
 * API client for the AIRSPACE worker.
 *
 * Read-only. Nothing here can change portfolio authority: every write is a
 * wallet-signed on-chain transaction sent directly from the browser.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    // A transport failure is not a protocol answer; the UI says so plainly.
    throw new ApiError("Cannot reach the AIRSPACE service.", 0, "NETWORK");
  }
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const b = body as { error?: string } | null;
    throw new ApiError(b?.error ?? `Request failed (${res.status})`, res.status, b?.error);
  }
  return body as T;
}

export interface ApiConfig {
  chainId: number;
  factory: string | null;
  supabaseUrl: string;
  supabaseAnonKey: string;
  explorer: string;
}

export interface DomainSnapshot {
  domain: string;
  usage: string;
  ceiling: string;
  committedCeiling: string;
  liveMarkets: number;
  marketCount: number;
  configured: boolean;
}

export interface PortfolioSnapshot {
  portfolio: string;
  chainId: number;
  blockNumber: string;
  fetchedAt: number;
  owner: string;
  collateralToken: string;
  capitalBase: string;
  freeCollateral: string;
  committedCapital: string;
  reservedCollateral: string;
  globalPolicyHash: string;
  policyEpoch: string;
  domains: DomainSnapshot[];
  stale?: { since: number; reason: string };
}

/** live: currently trading · settled: resolved on-chain · voided: void · closed: expired, not yet settled */
export type MarketStatus = "live" | "settled" | "voided" | "closed";

export interface MarketSummary {
  marketId: string;
  pool: string;
  marketAddress: string;
  marketNonce: string;
  creator: string;
  collateral: string;
  tradingStart: string;
  expiry: string;
  cadenceSec: number;
  cadenceLabel: string;
  domain: string | null;
  status: MarketStatus;
  /** YES-side price, top of book. Not available once a market has no resting orders left. */
  bestBid: string | null;
  bestAsk: string | null;
  live: {
    trading: boolean;
    resolved: boolean;
    voided: boolean;
    finalized: boolean;
    secondsRemaining: number;
    tickSize: string;
    lotSize: string;
    minQuantity: string;
    marketExpiryNs: string;
  };
}

export interface GateResult {
  key: string;
  label: string;
  pass: boolean;
  blocking: boolean;
}

export interface SimulateResult {
  intent: Record<string, string | number>;
  decision: {
    admitted: boolean;
    refusal: number;
    refusalName: string | null;
    copy: { title: string; detail: string; action: string } | null;
    blockingGate: string | null;
  };
  gates: GateResult[];
  arithmetic: { before: string; requested: string; after: string; ceiling: string } | null;
  raw: Record<string, string | number>;
  advisory: string;
}

/** Projections. Every `numeric(78,0)` column arrives as a decimal string. */
export interface AgentSummary {
  address: string;
  displayName: string | null;
  strategyId: string | null;
  strategyVersion: string | null;
  enabled: boolean;
  policy: {
    maxCommitted: string;
    maxOrderNotional: string;
    maxBuyPrice: string;
    minSellPrice: string;
    cooldownSec: string;
  };
  committed: string;
  nonce: string;
  registeredTx: string | null;
}

export interface IntentRow {
  intent_hash: string;
  agent_address: string;
  market_id: string;
  domain_hash: string | null;
  kind: number;
  order_type: number;
  price: string;
  quantity: string;
  status: "ADMITTED" | "REFUSED";
  refusal_code: number | null;
  order_id: string | null;
  tx_hash: string | null;
  block_number: number | null;
  created_at: string;
}

export interface ReservationRow {
  order_key: string;
  intent_hash: string | null;
  agent_address: string;
  market_id: string;
  pool_address: string;
  market_nonce: number;
  domain_hash: string | null;
  kind: number;
  qty_open: string;
  collateral_reserved: string;
  state: string;
  source_block: number;
  updated_at: string;
}

export interface PositionRow {
  market_id: string;
  domain_hash: string | null;
  yes_balance: string;
  no_balance: string;
  directional_exposure: string;
  settled: boolean;
  redeemed: boolean;
  source_block: number;
  updated_at: string;
}

/**
 * Reconciliation and headroom truth for one domain.
 *
 * `independentWorstCase` is computed by the API from indexed positions and
 * reservations, through a separate implementation from the contract's own
 * `domainRiskUsage()` — never by trusting that number back at itself.
 */
export interface ReconciliationSummary {
  domain: string;
  pendingReleaseCount: number;
  pendingReleaseAmount: string;
  oldestPendingReleaseAgeSec: number | null;
  lastReconciledAt: string | null;
  marketsTracked: number;
  marketsCap: number;
  independentWorstCase: string;
}

export interface ReceiptRow {
  intent_hash: string;
  decision: "ADMITTED" | "REFUSED";
  refusal_code: number | null;
  agent_address: string;
  market_id: string;
  domain_hash: string | null;
  global_policy_hash: string | null;
  agent_policy_hash: string | null;
  reserve_required: string | null;
  filled_qty: string | null;
  filled_cost: string | null;
  resting_qty: string | null;
  directional_before: string | null;
  directional_after: string | null;
  domain_usage_before: string | null;
  domain_usage_after: string | null;
  committed_after: string | null;
  tx_hash: string | null;
  block_number: number | null;
  provenance: Record<string, string>;
  created_at: string;
}

export interface DeploymentCheck {
  key: string;
  label: string;
  expected: string;
  actual: string | null;
  pass: boolean;
  error?: string;
}

export interface DeploymentVerification {
  ok: boolean;
  network: { name: string; chainId: number; nativeCurrency: { name: string; symbol: string; decimals: number }; explorer: string };
  collateral: { address: string; symbolOnChain: string | null; decimalsOnChain: number | null; description: string };
  checks: DeploymentCheck[];
  recentTransaction: {
    hash: string;
    blockNumber: string;
    status: string;
    gasUsed: string;
    effectiveGasPriceWei: string;
    nativeFeePaid: string;
  } | null;
  recentTransactionError: string | null;
  explorerTxUrl: string | null;
}

export const api = {
  config: () => req<ApiConfig>("/api/config"),
  health: () => req<{ ok: boolean; blockNumber?: string; rpc: string }>("/api/health"),
  deploymentVerification: (portfolio?: string) =>
    req<DeploymentVerification>(`/api/deployment/verify${portfolio ? `?portfolio=${portfolio}` : ""}`),

  portfoliosOf: (owner: string) =>
    req<{ portfolios: Array<{ address: string; displayName: string | null }> }>(
      `/api/owners/${owner}/portfolios`,
    ),

  portfolio: (address: string, domains: string[] = [], force = false) =>
    req<PortfolioSnapshot>(
      `/api/portfolios/${address}?domains=${encodeURIComponent(domains.join(","))}${force ? "&force=1" : ""}`,
    ),

  agents: (address: string) =>
    req<{ agents: AgentSummary[]; note?: string }>(`/api/portfolios/${address}/agents`),

  markets: (minRemaining = 120) => req<{ markets: MarketSummary[] }>(`/api/markets?minRemaining=${minRemaining}`),

  market: (marketId: string) =>
    req<{ market: MarketSummary; live: MarketSummary["live"] }>(`/api/markets/${marketId}`),

  simulate: (body: {
    portfolio: string;
    agent: string;
    marketId: string;
    kind: number;
    price: string;
    quantity: string;
    orderType?: number;
  }) => req<SimulateResult>("/api/intents/simulate", { method: "POST", body: JSON.stringify(body) }),

  list: <T>(address: string, kind: "intents" | "receipts" | "reservations" | "positions", q: Record<string, string> = {}) =>
    req<Record<string, T[]> & { total: number; limit: number; offset: number }>(
      `/api/portfolios/${address}/${kind}?${new URLSearchParams(q).toString()}`,
    ),

  receipt: (intentHash: string) =>
    req<{
      receipt: ReceiptRow;
      order: { kind: number; price: string; quantity: string; orderId: string | null; poolAddress: string } | null;
      copy: { title: string; detail: string; action: string } | null;
      refusalName: string | null;
    }>(`/api/receipts/${intentHash}`),

  /**
   * Recover a refusal from a failed transaction. Only the hash is sent: the
   * service verifies the revert against the chain rather than believing a claim.
   */
  reportRefusal: (body: { portfolio: string; txHash: string }) =>
    req<{
      recorded: boolean;
      intentHash: string;
      refusal: number;
      refusalName: string | null;
      copy: { title: string; detail: string; action: string } | null;
    }>("/api/intents/report", { method: "POST", body: JSON.stringify(body) }),

  reconciliation: (address: string, domains: string[]) =>
    req<{ domains: ReconciliationSummary[]; note?: string }>(
      `/api/portfolios/${address}/reconciliation?domains=${encodeURIComponent(domains.join(","))}`,
    ),

  requestReconcile: (body: {
    portfolio: string;
    marketId?: string;
    orderKey?: string;
    domain?: string;
    kind?: "release-order" | "release-settled" | "prune-market" | "sync-portfolio" | "sync-positions";
    reason?: string;
  }) =>
    req<{ queued: boolean; deduplicated: boolean; kind: string }>("/api/reconcile/request", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
