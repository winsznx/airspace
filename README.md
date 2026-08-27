# AIRSPACE

**One capital pool. Many trading agents. One shared risk envelope.**

Several independently controlled DreamDEX Event Contract agents share one capital
base on Somnia. Every proposed order must pass both its local agent policy and
atomic portfolio-wide admission. An individually legal order is rejected when
reservations or positions created by *other* agents have already consumed portfolio
risk capacity.

Dominant mechanism: **cross-agent portfolio admission + reservation + post-trade
reconciliation.** Not an AI trader.

**Status: product lock reached** (tag `airspace-product-lock`, 11/11 criteria,
76 passing tests, live Shannon evidence). The production build has not started —
`contracts/`, `apps/`, `packages/`, `workers/`, `supabase/`, `scripts/` and `test/`
are intentionally empty pending the PRD/DESIGN pass.

## The result, live on Shannon

```
domain = keccak256(creator, collateral, canonicalCadence)   derived on-chain, no attestation

AGENT_A reserves 180                        ->  180 / 500
AGENT_B reserves 240 on a different market  ->  420 / 500
AGENT_C proposes 150   ->  DomainRiskExceeded
        C's own policy passed. Every market check passed.
        agentCommitted[C] unchanged. Domain state unchanged.
release A  ->  320 / 500      C retries the identical shape  ->  ADMITTED, 470 / 500
```

A's and B's orders were **unfilled** — proof that reservations occupy the envelope
before they fill.

## Repository

```
apps/          frontends                        (empty, pending PRD/DESIGN)
contracts/     production contracts             (empty, pending PRD/DESIGN)
packages/      shared TypeScript packages       (empty, pending PRD/DESIGN)
workers/       off-chain keepers                (empty, pending PRD/DESIGN)
supabase/      schema, migrations, functions    (empty, pending PRD/DESIGN)
scripts/       operational scripts              (empty, pending PRD/DESIGN)
test/          production tests                 (empty, pending PRD/DESIGN)

engineering/   hostile-validation history — three spikes, 76 tests, live evidence
evidence/      what is public, and which artifact backs which claim
```

## Engineering history

Read [`engineering/README.md`](engineering/README.md) first — it is the
reviewer-facing account of how the product got here, including the two REVISE
verdicts and the limitations that survived into LOCK.

| Stage | Candidate | Verdict |
|---|---|---|
| [00-flightpath-feasibility](engineering/00-flightpath-feasibility/) | Single-agent execution assurance | REVISE |
| [01-airspace-portfolio-spike](engineering/01-airspace-portfolio-spike/) | Cross-agent portfolio, owner-attested buckets | REVISE |
| [02-product-lock](engineering/02-product-lock/) | Cross-agent portfolio, structural risk domains | **LOCK — 11/11** |

## Protocol findings that shaped the design

- **`placeBinaryOrderFor` reverts `OnlyApprovedContracts()` for every EOA caller**,
  so there is no session-key path for Event Contracts — custody-by-contract is
  forced, not chosen.
- **`marketId → asset` exists on-chain in creation events but no view exposes it**
  (304 selector probes). Risk domains are therefore *cadence* domains: the contract
  does not know BTC from ETH and never claims to. Sibling series share a domain,
  intentionally.
- **Cadence jitter is real** — two live markets had an 898-second window on a
  900-second series, so raw `expiry - tradingStart` is unsafe as a domain key.
- **`getOrder` reverts identically for filled and cancelled orders**, so a running
  exposure counter cannot stay correct. Positions are measured from ERC-6909.
- **Pools are recycled across markets and underlyings** (one served 52 markets
  across both BTC and ETH), so a pool allowlist binds to a mutable slot.

## Reproducing

```bash
forge install foundry-rs/forge-std     # lib/ is gitignored
forge build
cp .env.example .env.lock              # then fill in the stage's pinned block
```

Per-stage commands are in [`engineering/README.md`](engineering/README.md).

## Security

No secret has ever been committed: this repository's history begins at the
product-lock checkpoint. `.env*`, `.wallets.json`, keystores and credentials are
gitignored. Run the scanner yourself:

```bash
node engineering/02-product-lock/research/onchain-probes/secret-scan.mjs .
```

The testnet wallets used in the spikes are throwaway keys; their addresses are
published, their private keys were never tracked. See
[`evidence/README.md`](evidence/README.md).
