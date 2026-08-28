-- AIRSPACE application schema.
--
-- IMPORTANT: this database is NOT the enforcement authority. The portfolio
-- contract is. Everything here is a reconstructable projection of chain state
-- plus display metadata, and every row that mirrors the chain carries the block
-- it was derived from so it can be rebuilt by replaying events.
--
-- Designed for many users, many portfolios and many agents from day one: there
-- is no singleton portfolio, owner or agent anywhere in the model.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type reservation_state as enum (
  'RESERVED', 'PLACED', 'PARTIAL', 'RESTING', 'FILLED',
  'CANCELLED', 'EXPIRED', 'FINALIZED', 'VOIDED', 'REDEEMED',
  'NEEDS_RECONCILIATION'
);

create type intent_status as enum ('ADMITTED', 'REFUSED');

create type job_status as enum ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'DEAD');

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

create table users (
  id            uuid primary key default gen_random_uuid(),
  wallet_address text not null unique check (wallet_address ~ '^0x[0-9a-f]{40}$'),
  display_name  text,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Portfolios
-- ---------------------------------------------------------------------------

create table portfolios (
  id                     uuid primary key default gen_random_uuid(),
  chain_id               integer not null,
  portfolio_address      text not null check (portfolio_address ~ '^0x[0-9a-f]{40}$'),
  owner_address          text not null check (owner_address ~ '^0x[0-9a-f]{40}$'),
  factory_address        text not null,
  display_name           text,
  implementation_version text not null default '1.0.0',
  collateral_address     text not null,
  collateral_symbol      text,
  collateral_decimals    smallint not null default 6,
  created_tx             text,
  created_block          bigint,
  created_at             timestamptz not null default now(),
  unique (chain_id, portfolio_address)
);

create index portfolios_owner_idx on portfolios (chain_id, owner_address);

-- Global policy snapshots, one row per epoch, so history is auditable.
create table portfolio_policies (
  id                    uuid primary key default gen_random_uuid(),
  portfolio_id          uuid not null references portfolios (id) on delete cascade,
  policy_epoch          bigint not null,
  policy_hash           text not null,
  max_committed_capital numeric(78, 0) not null,
  max_reserved_collateral numeric(78, 0) not null,
  max_single_order_notional numeric(78, 0) not null,
  max_buy_price         numeric(78, 0) not null,
  min_sell_price        numeric(78, 0) not null,
  min_headroom_sec      bigint not null,
  policy_expiry         bigint not null,
  source_block          bigint not null,
  source_tx             text,
  created_at            timestamptz not null default now(),
  unique (portfolio_id, policy_epoch)
);

-- ---------------------------------------------------------------------------
-- Structural risk domains
--
-- domain_hash = keccak256(creator, collateral, canonical_cadence). A CADENCE
-- domain, never an asset: sibling series of one cadence share a domain by
-- design, and no BTC/ETH string is ever authoritative here.
-- ---------------------------------------------------------------------------

create table domain_policies (
  id                    uuid primary key default gen_random_uuid(),
  portfolio_id          uuid not null references portfolios (id) on delete cascade,
  domain_hash           text not null check (domain_hash ~ '^0x[0-9a-f]{64}$'),
  creator_address       text,
  collateral_address    text,
  canonical_cadence_sec integer,
  configured            boolean not null default true,
  max_domain_risk_usage numeric(78, 0) not null,
  max_domain_committed  numeric(78, 0) not null default 0,
  max_live_markets      integer not null default 0,
  source_block          bigint not null,
  source_tx             text,
  updated_at            timestamptz not null default now(),
  unique (portfolio_id, domain_hash)
);

create index domain_policies_domain_idx on domain_policies (domain_hash);

-- ---------------------------------------------------------------------------
-- Agents
-- ---------------------------------------------------------------------------

create table agents (
  id             uuid primary key default gen_random_uuid(),
  portfolio_id   uuid not null references portfolios (id) on delete cascade,
  agent_address  text not null check (agent_address ~ '^0x[0-9a-f]{40}$'),
  display_name   text,
  strategy_id    text,
  strategy_version text,
  enabled        boolean not null default true,
  registered_tx  text,
  registered_block bigint,
  revoked_tx     text,
  revoked_block  bigint,
  created_at     timestamptz not null default now(),
  unique (portfolio_id, agent_address)
);

create index agents_address_idx on agents (agent_address);

create table agent_policies (
  id                 uuid primary key default gen_random_uuid(),
  portfolio_id       uuid not null references portfolios (id) on delete cascade,
  agent_address      text not null,
  policy_hash        text not null,
  enabled            boolean not null,
  max_committed      numeric(78, 0) not null,
  max_order_notional numeric(78, 0) not null,
  max_buy_price      numeric(78, 0) not null,
  min_sell_price     numeric(78, 0) not null,
  cooldown_sec       bigint not null,
  strategy_id        text,
  source_block       bigint not null,
  source_tx          text,
  created_at         timestamptz not null default now()
);

create index agent_policies_lookup_idx on agent_policies (portfolio_id, agent_address, source_block desc);

-- ---------------------------------------------------------------------------
-- Markets
--
-- Keyed by market_id, NEVER by pool: pools are recycled across markets and
-- across underlyings. `asset_label` is informational only (NON_AUTHORITATIVE).
-- ---------------------------------------------------------------------------

create table markets (
  id                    uuid primary key default gen_random_uuid(),
  chain_id              integer not null,
  market_id             text not null check (market_id ~ '^0x[0-9a-f]{64}$'),
  pool_address          text not null,
  market_address        text not null,
  market_nonce          bigint not null,
  creator_address       text not null,
  collateral_address    text not null,
  trading_start         bigint not null,
  expiry                bigint not null,
  canonical_cadence_sec integer not null,
  domain_hash           text,
  yes_token_id          numeric(78, 0),
  no_token_id           numeric(78, 0),
  -- NON_AUTHORITATIVE: an indexer label for humans. Never used for enforcement.
  asset_label           text,
  resolved              boolean not null default false,
  voided                boolean not null default false,
  source_block          bigint,
  updated_at            timestamptz not null default now(),
  unique (chain_id, market_id)
);

create index markets_domain_idx on markets (domain_hash, expiry desc);
create index markets_expiry_idx on markets (chain_id, expiry desc);

-- ---------------------------------------------------------------------------
-- Intents, reservations, positions, receipts
-- ---------------------------------------------------------------------------

create table intents (
  id             uuid primary key default gen_random_uuid(),
  portfolio_id   uuid not null references portfolios (id) on delete cascade,
  intent_hash    text not null,
  agent_address  text not null,
  market_id      text not null,
  market_nonce   bigint not null,
  pool_address   text not null,
  domain_hash    text,
  kind           smallint not null,
  order_type     smallint not null,
  price          numeric(78, 0) not null,
  quantity       numeric(78, 0) not null,
  agent_nonce    bigint not null,
  status         intent_status not null,
  refusal_code   smallint,
  order_id       numeric(78, 0),
  strategy_version text,
  tx_hash        text,
  block_number   bigint,
  log_index      integer,
  created_at     timestamptz not null default now(),
  unique (portfolio_id, intent_hash)
);

create index intents_portfolio_time_idx on intents (portfolio_id, block_number desc, log_index desc);
create index intents_agent_idx on intents (portfolio_id, agent_address, block_number desc);
create index intents_market_idx on intents (market_id);
create index intents_status_idx on intents (portfolio_id, status);
create index intents_tx_idx on intents (tx_hash);

create table reservations (
  id                 uuid primary key default gen_random_uuid(),
  portfolio_id       uuid not null references portfolios (id) on delete cascade,
  order_key          text not null,
  intent_hash        text,
  agent_address      text not null,
  market_id          text not null,
  pool_address       text not null,
  market_nonce       bigint not null,
  domain_hash        text,
  kind               smallint not null,
  qty_open           numeric(78, 0) not null,
  collateral_reserved numeric(78, 0) not null,
  state              reservation_state not null default 'RESERVED',
  source_block       bigint not null,
  updated_at         timestamptz not null default now(),
  unique (portfolio_id, order_key)
);

create index reservations_open_idx on reservations (portfolio_id, state) where state in ('RESTING', 'PARTIAL', 'NEEDS_RECONCILIATION');
create index reservations_market_idx on reservations (market_id);

create table positions (
  id                    uuid primary key default gen_random_uuid(),
  portfolio_id          uuid not null references portfolios (id) on delete cascade,
  market_id             text not null,
  domain_hash           text,
  yes_balance           numeric(78, 0) not null default 0,
  no_balance            numeric(78, 0) not null default 0,
  directional_exposure  numeric(78, 0) not null default 0,
  settled               boolean not null default false,
  redeemed              boolean not null default false,
  source_block          bigint not null,
  updated_at            timestamptz not null default now(),
  unique (portfolio_id, market_id)
);

create index positions_domain_idx on positions (portfolio_id, domain_hash);

-- A receipt is a first-class product object: the decision plus the evidence
-- needed to re-derive it independently.
create table receipts (
  id                    uuid primary key default gen_random_uuid(),
  portfolio_id          uuid not null references portfolios (id) on delete cascade,
  intent_hash           text not null,
  decision              intent_status not null,
  refusal_code          smallint,
  agent_address         text not null,
  market_id             text not null,
  domain_hash           text,
  global_policy_hash    text,
  agent_policy_hash     text,
  reserve_required      numeric(78, 0),
  filled_qty            numeric(78, 0),
  filled_cost           numeric(78, 0),
  resting_qty           numeric(78, 0),
  directional_before    numeric(78, 0),
  directional_after     numeric(78, 0),
  domain_usage_before   numeric(78, 0),
  domain_usage_after    numeric(78, 0),
  committed_after       numeric(78, 0),
  tx_hash               text,
  block_number          bigint,
  -- Per-field provenance so the UI never presents an off-chain witness as if
  -- the contract asserted it.
  provenance            jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  unique (portfolio_id, intent_hash)
);

create index receipts_portfolio_time_idx on receipts (portfolio_id, block_number desc);
create index receipts_hash_idx on receipts (intent_hash);

-- ---------------------------------------------------------------------------
-- Ingestion and lifecycle
-- ---------------------------------------------------------------------------

-- Idempotent event ingestion. The unique key is what makes duplicate queue
-- delivery, worker retries and reorg replays safe.
create table chain_events (
  id               uuid primary key default gen_random_uuid(),
  chain_id         integer not null,
  tx_hash          text not null,
  log_index        integer not null,
  block_number     bigint not null,
  block_timestamp  bigint,
  contract_address text not null,
  event_name       text not null,
  portfolio_address text,
  payload          jsonb not null,
  processed_at     timestamptz,
  created_at       timestamptz not null default now(),
  unique (chain_id, tx_hash, log_index)
);

create index chain_events_block_idx on chain_events (chain_id, block_number desc);
create index chain_events_unprocessed_idx on chain_events (chain_id, block_number) where processed_at is null;
create index chain_events_portfolio_idx on chain_events (portfolio_address, block_number desc);

-- One cursor per (chain, stream). Backfill resumes from here after a restart.
create table chain_cursors (
  id              uuid primary key default gen_random_uuid(),
  chain_id        integer not null,
  stream          text not null,
  last_block      bigint not null default 0,
  last_log_index  integer not null default 0,
  updated_at      timestamptz not null default now(),
  unique (chain_id, stream)
);

create table reconciliation_jobs (
  id              uuid primary key default gen_random_uuid(),
  portfolio_id    uuid references portfolios (id) on delete cascade,
  chain_id        integer not null,
  kind            text not null,
  market_id       text,
  domain_hash     text,
  order_key       text,
  reason          text,
  status          job_status not null default 'PENDING',
  attempt_count   integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index recon_jobs_due_idx on reconciliation_jobs (status, next_attempt_at) where status in ('PENDING', 'FAILED');
create index recon_jobs_portfolio_idx on reconciliation_jobs (portfolio_id, status);

-- Deduplicate identical pending work so a burst of events cannot flood the queue.
create unique index recon_jobs_dedupe_idx
  on reconciliation_jobs (portfolio_id, kind, coalesce(market_id, ''), coalesce(order_key, ''))
  where status in ('PENDING', 'RUNNING');
