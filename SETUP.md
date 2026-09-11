# Setup

From a clean clone to a running system. No absolute paths, nothing that only
works on the author's machine.

---

## What you need

| | Version | Why |
| --- | --- | --- |
| Node | ≥ 20 | Workers, scripts, the web app |
| pnpm | 11 | `corepack enable` uses the pinned version |
| Foundry | latest | contracts, tests, deploy |
| git | any | the fork suite locates nothing without it |

```bash
corepack enable
curl -L https://foundry.paradigm.xyz | bash && foundryup
```

Docker is **not** required. `supabase gen types` wants it, so the database row
types are hand-written in `packages/db/src/schema.ts` instead — a note there says
so, and CI does not depend on Docker.

---

## Clone and verify

Everything in this section runs with **no credentials at all**.

```bash
git clone <repo> airspace && cd airspace
pnpm install
git clone --depth 1 --branch v1.16.2 https://github.com/foundry-rs/forge-std lib/forge-std   # pinned; lib/ is untracked

pnpm typecheck               # every workspace
pnpm test                    # 83 unit tests across packages and workers
pnpm contracts:test          # 90 Solidity tests: unit, adversarial, invariants, reference oracles
pnpm contracts:sizes         # AirspacePortfolio must stay under 24,576 bytes
pnpm abi:check               # the committed ABI matches the compiled contracts
pnpm secrets:scan            # nothing publishable contains a secret
```

Or all of it:

```bash
pnpm verify
```

### The fork suite

Ten tests against **live Shannon state**. They need a public RPC and nothing
else — no key, no funds.

```bash
pnpm contracts:test:fork
```

That regenerates `contracts/.env.fork` first. It has to: the suite pins a block
and two markets that share one structural domain, and Shannon's fast cadences
retire markets within hours, so a checked-in pin is stale by the time you read
it. The refresh script finds a live pair by binary-searching the DreamDEX
registry.

If it reports no pair, a creator is mid-roll. Wait a minute, or lower the bar:

```bash
node scripts/refresh-fork-env.mjs --min-remaining 120
```

---

## Run the app locally

Two processes. The API Worker also serves the built web app, and in development
Vite proxies `/api` to it.

```bash
pnpm dev            # api on :8787, web on :5173
```

The API needs no database and no credentials. Every route reads the chain: the
live snapshot, the admission preview, and the agents, activity, receipts,
reservations and positions lists, which the portfolio's Durable Object decodes
from the portfolio's own logs and re-measures against the contract. Supabase
matters only to the lifecycle keeper (below).

---

## Credentials

### What is public

Safe to commit, and already committed:

- Deployed contract addresses (`contracts/deployments/50312.json`)
- RPC endpoints
- The Supabase project URL, a public identifier. The keeper's tables are
  RLS-scoped and the app never reads them
- The WalletConnect project id — it identifies the dApp to the relay and
  authorises nothing

### Wallet connection

The app uses RainbowKit, themed from the same tokens as everything else. It
needs a WalletConnect project id to offer anything beyond browser wallets:

```bash
# free, from https://cloud.reown.com
export VITE_WALLETCONNECT_PROJECT_ID=...
pnpm build
```

Vite reads it at **build** time, so it has to be set before `pnpm build`, not on
the Worker. Without it the app still works and RainbowKit still renders, but the
wallet list drops to the ones that need no relay — an injected provider, Coinbase
and Safe — and the connect screen says so rather than leaving a dead option on
screen. There is no QR flow in that mode, so a phone wallet cannot connect.

### What is secret

Never in the repository. `.gitignore` and `scripts/secret-scan.mjs` both enforce
that, and the scan is a CI gate.

| Variable | Where it belongs |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | indexer and lifecycle only: `workers/*/.dev.vars` locally, `wrangler secret put` in production. The API holds none. |
| `INDEXER_TOKEN` | same |
| `AGENT_PRIVATE_KEY` | one per agent deployment, `wrangler secret put --env <name>` |
| Deployer / owner key | `.wallets.json`, gitignored, chmod 600, throwaway testnet keys |
| `CLOUDFLARE_API_TOKEN` | CI secret only; locally use `wrangler login` |

Copy `.env.example` to `.env.local` and fill it in. Copy each
`workers/*/.dev.vars.example` to `.dev.vars`.

```bash
cp .env.example .env.local && chmod 600 .env.local
for w in indexer lifecycle agent; do
  cp workers/$w/.dev.vars.example workers/$w/.dev.vars 2>/dev/null && chmod 600 workers/$w/.dev.vars
done
```

---

## Your own Supabase (for the lifecycle keeper)

Optional. The app runs without it; the keeper that sends background releases and
prunes needs it. A fresh database starts empty and the indexer rebuilds it from
the chain, reading about 20,000 blocks a minute from the factory's first block.

```bash
supabase link --project-ref <your-ref>
supabase db push          # applies supabase/migrations/
```

Two migrations: the schema, then row-level security. Verify RLS actually took —
`anon` must read projections, and must not read `chain_events` or write anything:

```bash
curl "$SUPABASE_URL/rest/v1/portfolios?select=portfolio_address&limit=1" \
  -H "apikey: $SUPABASE_ANON_KEY"        # 200, rows
curl "$SUPABASE_URL/rest/v1/chain_events?select=id&limit=1" \
  -H "apikey: $SUPABASE_ANON_KEY"        # 200 with an empty array, or 401
```

Then put the URL in the indexer's and lifecycle's `wrangler.toml` `[vars]`, and the
service-role key in a secret on each. The API needs neither.

---

## Your own contracts

Somnia rejects a constructor that itself deploys a ~24KB contract, so the
implementation goes out first and the factory takes its address. The deploy
script does that in the right order —
[DECISIONS.md](DECISIONS.md#10-the-factory-takes-a-pre-deployed-implementation)
has the measurement.

```bash
cd contracts
forge script script/Deploy.s.sol --rpc-url $SHANNON_RPC --broadcast --private-key $DEPLOYER_KEY
```

It writes `contracts/deployments/50312.json`. Put the factory address in each
Worker's `[vars]`.

You need STT for gas. The Shannon faucet is at
<https://testnet.somnia.network>.

---

## Deploy

Order matters: the API Worker serves the web app's built assets, so build first.

```bash
wrangler login

# The wallet list is baked into the bundle, so this belongs on the BUILD, not
# on the Worker. Without it the app ships with browser wallets only.
export VITE_WALLETCONNECT_PROJECT_ID=...
pnpm build

wrangler deploy -c workers/api/wrangler.toml
wrangler deploy -c workers/indexer/wrangler.toml
wrangler deploy -c workers/lifecycle/wrangler.toml

wrangler secret put SUPABASE_SERVICE_ROLE_KEY -c workers/indexer/wrangler.toml
wrangler secret put INDEXER_TOKEN             -c workers/indexer/wrangler.toml
wrangler secret put SUPABASE_SERVICE_ROLE_KEY -c workers/lifecycle/wrangler.toml
```

Queues and Durable Objects need a paid Workers plan. The lifecycle worker
declares a queue consumer and a dead-letter queue; create both first:

```bash
wrangler queues create airspace-reconcile
wrangler queues create airspace-reconcile-dlq
```

### The sample agents

Three deployments, three keys, three KV namespaces. Nothing is shared between
them at runtime, which is the point: they discover markets independently and only
meet at the portfolio contract.

```bash
for env in momentum reversion spread; do
  wrangler kv namespace create AGENT_STATE --env $env -c workers/agent/wrangler.toml
  # put the returned id into workers/agent/wrangler.toml under [[env.$env.kv_namespaces]]
  wrangler deploy --env $env -c workers/agent/wrangler.toml
  wrangler secret put AGENT_PRIVATE_KEY --env $env -c workers/agent/wrangler.toml
done
```

Set `AIRSPACE_PORTFOLIO` and `AIRSPACE_API` in each environment's `[vars]` first.
Each agent address needs STT for gas, and needs registering on the portfolio
before it can trade anything.

---

## Standing up a portfolio

```bash
node scripts/campaign-setup.mjs --salt my-portfolio --fund 6000
```

Creates the portfolio, funds it, sets the global policy, opens every cadence
domain that currently has live markets, and registers the three sample agents
with deliberately different limits. Idempotent — safe to re-run after a failure,
it picks up where it stopped.

Then drive it:

```bash
node scripts/campaign-run.mjs --rounds 30 --every 12
```

It ticks all three agents **concurrently** every round. That concurrency is the
whole experiment: each agent previews independently, all three previews pass, and
their transactions then land against an envelope that has moved.

---

## Proving it works

```bash
node scripts/live-proof.mjs      # the canonical A/B/C refusal, end to end
node scripts/adversarial.mjs     # 13 hostile cases
node scripts/scale.mjs           # read-path behaviour at 100x the campaign
```

`adversarial.mjs` wants the API and indexer running locally. Its RPC-outage case
needs a second API instance with a deliberately dead RPC, and reports SKIP rather
than a false pass if you have not started one:

```bash
wrangler dev -c workers/api/wrangler.toml --port 8790 \
  --var SHANNON_RPC:http://127.0.0.1:9 --var SHANNON_RPC_FALLBACK:http://127.0.0.1:9
```

---

## Troubleshooting

**`pnpm install` complains about ignored build scripts.** `esbuild` and `workerd`
ship prebuilt binaries and need their install scripts; `bufferutil`, `keccak` and
`utf-8-validate` are optional native accelerators with pure-JS fallbacks and are
declined on purpose, so the install works with no C toolchain. All five are
listed explicitly in `pnpm-workspace.yaml`.

**The fork suite fails with `environment variable "SHANNON_RPC" not found`.**
Run `pnpm contracts:test:fork`, not `forge test` — the wrapper sources
`contracts/.env.fork` after regenerating it.

**`eth_getLogs` says the block range is too large.** Both public Somnia RPCs cap
it at 1,000 blocks. The indexer already chunks at that size;
`INGEST_WINDOW` is the per-invocation budget, not the per-call range.

**The indexer never catches up.** Shannon produces ~10 blocks per second, so a
one-minute cron must cover ~600. The default 5,000-block budget gives about 8×
headroom. Raise `INGEST_WINDOW` after a long outage.

**An agent reports `venue-rejected: PostOnlyWouldCross`.** Ordinary. The agent
quoted where DreamDEX would have taken, and widens its offset for the next tick.
It converges on its own.

**Wrangler says the inspector port is in use.** Running several Workers at once
needs distinct `--inspector-port` values as well as distinct `--port` values.
