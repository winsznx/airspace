# AIRSPACE

**One capital pool. Many trading agents. One shared risk envelope.**

Your agents can each follow the rules and still break your portfolio. AIRSPACE
lets independent DreamDEX Event Contract agents share one capital base on Somnia
while enforcing one portfolio-wide risk envelope across all of them. A trade is
rejected purely because of what the *other* agents already hold.

Dominant mechanism: **cross-agent portfolio admission + atomic reservation +
post-trade reconciliation.** Not an AI trader, not a prediction-market terminal.

---

## The moment

Three independently-keyed agents, one 15-minute tUSDC risk domain, a 500-contract
ceiling. Live on Somnia Shannon.

```
AGENT A  reserves 180  on market bd32                   180 / 500
AGENT B  reserves 240  on market bd31, a different pool  420 / 500
AGENT C  proposes 150

  agent policy      PASS      420 + 150 = 570  >  500
  market trading    PASS
  market generation PASS      refused: DOMAIN_RISK_EXCEEDED
  tick / lot        PASS
  price ceiling     PASS      C's own policy passed.
  market headroom   PASS      Every check C controls passed.
  portfolio domain  FAIL      agentCommitted[C]: 0 -> 0. Nothing moved.

release A                                                240 / 500
C retries the identical intent                ADMITTED,  390 / 500
```

C was not too large, too fast or misconfigured. A and B had used the room.
That refusal is the product.

---

## Live

| | |
| --- | --- |
| Chain | Somnia Shannon (50312) |
| Factory | [`0x342d200aCF529905CC815D4ff9841053ea1c2D61`](https://shannon-explorer.somnia.network/address/0x342d200aCF529905CC815D4ff9841053ea1c2D61) |
| Implementation | [`0x6DE57BC332AA93D3d6323509B3FDA4BCa4808Eb0`](https://shannon-explorer.somnia.network/address/0x6DE57BC332AA93D3d6323509B3FDA4BCa4808Eb0) |
| Campaign portfolio | [`0x2839EA7138c1cB783272041D55Ed6e9e29f2D4Bc`](https://shannon-explorer.somnia.network/address/0x2839EA7138c1cB783272041D55Ed6e9e29f2D4Bc) |
| Venue | DreamDEX Event Contracts, tUSDC |

Evidence in [`evidence/production/`](evidence/production/): the canonical A/B/C
proof, two live agent campaigns, and the hostile campaign.

### What the agents actually did

Three Workers, three keys, three KV namespaces, no shared state and no
coordination. Thirty rounds:

| Outcome | Count |
| --- | --- |
| Admitted and placed | 32 |
| **Refused by the shared envelope** | **21** — `DOMAIN_RISK_EXCEEDED` 14, `DOMAIN_COMMITTED_EXCEEDED` 7 |
| Refused by an agent's own price band | 2 |
| No signal / no live market | 35 |

Every one of those 21 refusals hit an agent that had done nothing wrong. In
rounds 15 and 16 all three were blocked at once, each by the other two.

### The hostile campaign

Thirteen cases, thirteen passes, nothing skipped —
[`evidence/production/adversarial.json`](evidence/production/adversarial.json):

```
non-owner-withdraw           refused
non-owner-set-policy         refused
unregistered-agent           refusal 1  NOT_AGENT
nonce-replay                 refusal 4  INTENT_REPLAYED
stale-generation             refusal 8  on a rolled market
rival-release-live           refused
submit-despite-refusal       refusal 22 DOMAIN_RISK_EXCEEDED, agent committed unchanged
report-a-success-as-refusal  rejected
report-unrelated-tx          rejected
duplicate-ingestion          145 logs re-seen and skipped, row counts unchanged
projection-consistency       78 intents, 78 receipts
rpc-outage                   health ok:false; snapshot served labelled stale
owner-recovery-always        owner can withdraw the full balance with agents live
```

---

## How it decides

A domain is derived on-chain during execution:

```
domain = keccak256(creator, collateral, canonicalCadence)
```

No configuration, no indexer, no attestation. A market minted one second ago
lands in the right domain by itself.

It is a **cadence** domain and never an asset. `marketId → asset` is not exposed
by any view on this venue, so claiming otherwise would mean enforcing a limit
against a label the contract cannot check. Sibling BTC and ETH 15-minute series
from one creator share a ceiling by design — which also means an agent cannot
escape a limit by switching between them. Said plainly in the product UI.

Exposure is **measured, not accumulated**. Realized positions are read from
ERC-6909 balances at evaluation time; only unfilled reservations are stored. The
counter-based version was built first and live fork tests broke it: `getOrder`
reverts identically for a filled order and a cancelled one, so a counter drifts
and cannot be repaired.

Everything resolves toward one invariant:

> Uncertainty may **overstate** portfolio usage. It may never **understate**
> maximum commitment.

**That invariant is currently broken, and the deployed contract has the defect.**
Unfilled reservations on opposing sides of one market cancel in the exposure
formula, so a ceiling did not bound worst-case exposure for a portfolio resting
orders on both sides. It was found by building an independent verifier rather
than by any test. The measurement, the causal chain, why 48 tests missed it, and
the fix are in
[evidence/production/CRITICAL-reservation-netting.md](evidence/production/CRITICAL-reservation-netting.md).

---

## Repository

```
contracts/       AirspacePortfolio + factory, 48 tests incl. invariants and live-fork
packages/        types · protocol · risk · sdk · db      shared, no duplicated logic
workers/
  api/           Hono + one Durable Object per portfolio; serves the web app
  indexer/       cron: chain logs to projections, idempotent by unique key
  lifecycle/     cron + queue: permissionless release and prune
  agent/         three sample agents, one deployment and one key each
apps/web/        React; the ceiling line, the gate stack, the receipt
supabase/        14 tables of projections, RLS
scripts/         deploy, live proof, campaign, adversarial, secret scan
contributions/   the DreamDEX SDK defect: report, reproduction, patch
engineering/     the hostile validation that produced the design. Immutable.
```

`engineering/` is the record of how the design was arrived at, including the
things that were killed. It is not rewritten to look tidier in hindsight.

---

## Run it

```bash
pnpm install
pnpm -C contracts test          # 38 local tests
node scripts/refresh-fork-env.mjs && pnpm -C contracts test:fork   # 10 against live Shannon
pnpm dev                        # api :8787 + web :5173
```

Full setup, including the credentials you need and the ones you do not, in
[SETUP.md](SETUP.md).

---

## Reading order

| | |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | What the layers are and which arrows carry authority |
| [DECISIONS.md](DECISIONS.md) | Fourteen choices that could have gone the other way, and the measurement that settled each |
| [SECURITY.md](SECURITY.md) | Trust boundaries, recovery, known limitations, secret handling |
| [SETUP.md](SETUP.md) | Clean-clone to running |
| [CONTRIBUTIONS.md](CONTRIBUTIONS.md) | The upstream defect we found and fixed |
| [PRD.md](PRD.md) · [DESIGN.md](DESIGN.md) | The canonical product and visual specification |

---

## What this is not

Not an AI trading bot. Not a generic prediction-market terminal. Not a
single-agent mandate vault. Not a portfolio dashboard. AIRSPACE has one job:
stop several independent agents from collectively breaching a limit their owner
set, and show exactly why when it does.

It does not eliminate market risk, and it is **unaudited testnet software**. See
[SECURITY.md](SECURITY.md).
