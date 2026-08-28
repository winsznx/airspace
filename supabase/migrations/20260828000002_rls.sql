-- Row Level Security for AIRSPACE.
--
-- The split is deliberate and follows what is already public:
--
--   PUBLIC READ  — everything derived from chain state. A portfolio's address,
--                  policies, agents, admissions, refusals, reservations,
--                  positions and receipts are all readable from the chain by
--                  anyone, so hiding them here would add no security and would
--                  break the product requirement that a receipt be a shareable,
--                  independently checkable object (PRD 21.8, 6.3 viewer role).
--
--   NO PUBLIC ACCESS — internal machinery. Raw event log, ingestion cursors,
--                  reconciliation jobs and user profiles carry no chain
--                  guarantee and expose operational detail, so they are
--                  service-role only.
--
--   NO PUBLIC WRITE — anywhere. Every write goes through a Cloudflare worker
--                  holding the service-role key, and every write is a
--                  projection of chain state. Nothing a client sends can change
--                  what the portfolio contract enforces.

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere. A table with RLS on and no policy denies by default,
-- which is the failure mode we want if a policy is ever dropped.
-- ---------------------------------------------------------------------------

alter table users                enable row level security;
alter table portfolios           enable row level security;
alter table portfolio_policies   enable row level security;
alter table domain_policies      enable row level security;
alter table agents               enable row level security;
alter table agent_policies       enable row level security;
alter table markets              enable row level security;
alter table intents              enable row level security;
alter table reservations         enable row level security;
alter table positions            enable row level security;
alter table receipts             enable row level security;
alter table chain_events         enable row level security;
alter table chain_cursors        enable row level security;
alter table reconciliation_jobs  enable row level security;

-- ---------------------------------------------------------------------------
-- Public read on chain-derived projections
-- ---------------------------------------------------------------------------

create policy "public read" on portfolios         for select to anon, authenticated using (true);
create policy "public read" on portfolio_policies for select to anon, authenticated using (true);
create policy "public read" on domain_policies    for select to anon, authenticated using (true);
create policy "public read" on agents             for select to anon, authenticated using (true);
create policy "public read" on agent_policies     for select to anon, authenticated using (true);
create policy "public read" on markets            for select to anon, authenticated using (true);
create policy "public read" on intents            for select to anon, authenticated using (true);
create policy "public read" on reservations       for select to anon, authenticated using (true);
create policy "public read" on positions          for select to anon, authenticated using (true);
create policy "public read" on receipts           for select to anon, authenticated using (true);

-- ---------------------------------------------------------------------------
-- Internal tables: no anon/authenticated policy at all, so RLS denies them.
-- service_role bypasses RLS and is the only writer anywhere.
-- ---------------------------------------------------------------------------

-- (users, chain_events, chain_cursors, reconciliation_jobs intentionally have
--  no permissive policy.)

-- ---------------------------------------------------------------------------
-- Belt and braces: revoke direct table writes from the public roles so a future
-- permissive policy cannot silently grant them.
-- ---------------------------------------------------------------------------

revoke insert, update, delete on all tables in schema public from anon, authenticated;
revoke all on users, chain_events, chain_cursors, reconciliation_jobs from anon, authenticated;
