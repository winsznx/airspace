/**
 * Row types for the AIRSPACE schema.
 *
 * Hand-written from `supabase/migrations/` rather than generated, because type
 * generation requires Docker and CI must not depend on it. `pnpm db:verify`
 * checks these against the live schema so drift is caught rather than assumed.
 *
 * NOTE ON NUMBERS: every on-chain quantity is `numeric(78,0)` in Postgres and
 * arrives over PostgREST as a decimal STRING. It is typed as `string` here and
 * converted with `BigInt(...)` at the edge — never `Number(...)`, which would
 * silently lose precision above 2^53.
 */

export type Uuid = string;
/** A `numeric(78,0)` column. Convert with `BigInt(...)`, never `Number(...)`. */
export type Numeric = string;

export type ReservationState =
  | "RESERVED" | "PLACED" | "PARTIAL" | "RESTING" | "FILLED"
  | "CANCELLED" | "EXPIRED" | "FINALIZED" | "VOIDED" | "REDEEMED"
  | "NEEDS_RECONCILIATION";

export type IntentStatus = "ADMITTED" | "REFUSED";
export type JobStatus = "PENDING" | "RUNNING" | "DONE" | "FAILED" | "DEAD";

export interface PortfolioRow {
  id: Uuid;
  chain_id: number;
  portfolio_address: string;
  owner_address: string;
  factory_address: string;
  display_name: string | null;
  implementation_version: string;
  collateral_address: string;
  collateral_symbol: string | null;
  collateral_decimals: number;
  created_tx: string | null;
  created_block: number | null;
  created_at: string;
}

export interface PortfolioPolicyRow {
  id: Uuid;
  portfolio_id: Uuid;
  policy_epoch: number;
  policy_hash: string;
  max_committed_capital: Numeric;
  max_reserved_collateral: Numeric;
  max_single_order_notional: Numeric;
  max_buy_price: Numeric;
  min_sell_price: Numeric;
  min_headroom_sec: number;
  policy_expiry: number;
  source_block: number;
  source_tx: string | null;
  created_at: string;
}

export interface DomainPolicyRow {
  id: Uuid;
  portfolio_id: Uuid;
  domain_hash: string;
  creator_address: string | null;
  collateral_address: string | null;
  canonical_cadence_sec: number | null;
  configured: boolean;
  max_domain_risk_usage: Numeric;
  max_domain_committed: Numeric;
  max_live_markets: number;
  source_block: number;
  source_tx: string | null;
  updated_at: string;
}

export interface AgentRow {
  id: Uuid;
  portfolio_id: Uuid;
  agent_address: string;
  display_name: string | null;
  strategy_id: string | null;
  strategy_version: string | null;
  enabled: boolean;
  registered_tx: string | null;
  registered_block: number | null;
  revoked_tx: string | null;
  revoked_block: number | null;
  created_at: string;
}

export interface AgentPolicyRow {
  id: Uuid;
  portfolio_id: Uuid;
  agent_address: string;
  policy_hash: string;
  enabled: boolean;
  max_committed: Numeric;
  max_order_notional: Numeric;
  max_buy_price: Numeric;
  min_sell_price: Numeric;
  cooldown_sec: number;
  strategy_id: string | null;
  source_block: number;
  source_tx: string | null;
  created_at: string;
}

export interface MarketRow {
  id: Uuid;
  chain_id: number;
  market_id: string;
  pool_address: string;
  market_address: string;
  market_nonce: number;
  creator_address: string;
  collateral_address: string;
  trading_start: number;
  expiry: number;
  canonical_cadence_sec: number;
  domain_hash: string | null;
  yes_token_id: Numeric | null;
  no_token_id: Numeric | null;
  /** NON_AUTHORITATIVE indexer label. Never used for enforcement. */
  asset_label: string | null;
  resolved: boolean;
  voided: boolean;
  source_block: number | null;
  updated_at: string;
}

export interface IntentRow {
  id: Uuid;
  portfolio_id: Uuid;
  intent_hash: string;
  agent_address: string;
  market_id: string;
  market_nonce: number;
  pool_address: string;
  domain_hash: string | null;
  kind: number;
  order_type: number;
  price: Numeric;
  quantity: Numeric;
  agent_nonce: number;
  status: IntentStatus;
  refusal_code: number | null;
  order_id: Numeric | null;
  strategy_version: string | null;
  tx_hash: string | null;
  block_number: number | null;
  log_index: number | null;
  created_at: string;
}

export interface ReservationRow {
  id: Uuid;
  portfolio_id: Uuid;
  order_key: string;
  intent_hash: string | null;
  agent_address: string;
  market_id: string;
  pool_address: string;
  market_nonce: number;
  domain_hash: string | null;
  kind: number;
  qty_open: Numeric;
  collateral_reserved: Numeric;
  state: ReservationState;
  source_block: number;
  updated_at: string;
}

export interface PositionRow {
  id: Uuid;
  portfolio_id: Uuid;
  market_id: string;
  domain_hash: string | null;
  yes_balance: Numeric;
  no_balance: Numeric;
  directional_exposure: Numeric;
  settled: boolean;
  redeemed: boolean;
  source_block: number;
  updated_at: string;
}

export interface ReceiptRow {
  id: Uuid;
  portfolio_id: Uuid;
  intent_hash: string;
  decision: IntentStatus;
  refusal_code: number | null;
  agent_address: string;
  market_id: string;
  domain_hash: string | null;
  global_policy_hash: string | null;
  agent_policy_hash: string | null;
  reserve_required: Numeric | null;
  filled_qty: Numeric | null;
  filled_cost: Numeric | null;
  resting_qty: Numeric | null;
  directional_before: Numeric | null;
  directional_after: Numeric | null;
  domain_usage_before: Numeric | null;
  domain_usage_after: Numeric | null;
  committed_after: Numeric | null;
  tx_hash: string | null;
  block_number: number | null;
  /** Per-field provenance, so an off-chain witness is never shown as on-chain. */
  provenance: Record<string, string>;
  created_at: string;
}

export interface ChainEventRow {
  id: Uuid;
  chain_id: number;
  tx_hash: string;
  log_index: number;
  block_number: number;
  block_timestamp: number | null;
  contract_address: string;
  event_name: string;
  portfolio_address: string | null;
  payload: Record<string, unknown>;
  processed_at: string | null;
  created_at: string;
}

export interface ChainCursorRow {
  id: Uuid;
  chain_id: number;
  stream: string;
  last_block: number;
  last_log_index: number;
  updated_at: string;
}

export interface ReconciliationJobRow {
  id: Uuid;
  portfolio_id: Uuid | null;
  chain_id: number;
  kind: string;
  market_id: string | null;
  domain_hash: string | null;
  order_key: string | null;
  reason: string | null;
  status: JobStatus;
  attempt_count: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** Table name -> row type, for typed helpers. */
export interface Tables {
  portfolios: PortfolioRow;
  portfolio_policies: PortfolioPolicyRow;
  domain_policies: DomainPolicyRow;
  agents: AgentRow;
  agent_policies: AgentPolicyRow;
  markets: MarketRow;
  intents: IntentRow;
  reservations: ReservationRow;
  positions: PositionRow;
  receipts: ReceiptRow;
  chain_events: ChainEventRow;
  chain_cursors: ChainCursorRow;
  reconciliation_jobs: ReconciliationJobRow;
}

export type TableName = keyof Tables;

/** Tables a public (anon) client may read. Everything else is service-role only. */
export const PUBLIC_TABLES = [
  "portfolios",
  "portfolio_policies",
  "domain_policies",
  "agents",
  "agent_policies",
  "markets",
  "intents",
  "reservations",
  "positions",
  "receipts",
] as const satisfies readonly TableName[];
