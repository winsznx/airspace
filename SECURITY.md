# Security

## Status

**Unaudited. Testnet only. Do not fund with anything you are unwilling to lose.**

The portfolio contract holds collateral and outcome tokens. Version 2.0.0 has 90
tests, including 9 stateful invariants, 16 named adversarial exposure scenarios,
an independent reference implementation of both the exposure and the collateral
model, and 10 live-fork cases against real Shannon state. It has been driven by
independently-keyed agents against the live venue. None of that is an audit.

**Version 1.0.0 is superseded and unsafe.** It understated worst-case
directional exposure by netting opposing pending reservations. It was replaced,
not upgraded — 2.0.0 is a separate deployment at new addresses. Do not fund
`0x342d200aCF529905CC815D4ff9841053ea1c2D61`. The broken implementation, the
failing on-chain state and the full decomposition are preserved unchanged in
[engineering/03-superseded-unsafe-v1/](engineering/03-superseded-unsafe-v1/).

---

## What holds your money

`AirspacePortfolio` is the only trust boundary that matters. Everything else in
this repository can be deleted and your capital is still recoverable.

| Party | Can move capital | How that is bounded |
| --- | --- | --- |
| Owner key | Fully | `withdraw` checks ownership and nothing else |
| Registered agent | Into admitted orders only | its own policy, then the shared envelope |
| API / indexer / lifecycle Workers | No | no owner authority exists off-chain |
| Supabase | No | the lifecycle keeper's work queue; the app reads nothing from it |
| Web app | No | prepares transactions your wallet signs |

There is no admin key, no pause, no upgrade path on a live portfolio, and no
backend credential that can act as an owner. This is a property of the contract,
not a policy: the functions do not exist.

---

## Recovery

Getting out depends on your key and nothing else.

```
withdraw(token, to, amount)
```

Reads no policy, no agent state, no market state, no keeper, no backend. It works
with every agent revoked, the policy expired, the API offline and this repository
gone. Call it from any wallet, block explorer or script.

Fork test `test_F10_ownerRecoveryUnconditional` runs exactly that scenario against
live Shannon state.

Capital sitting behind resting orders is not in the portfolio's ERC-20 balance
until those orders are cancelled or released. `cancelOrder(pool, orderId)` is
owner-callable; `releaseOrder(key)` is permissionless. Outcome tokens come out with
`withdrawOutcome(id, to, amount)`.

---

## The safe-overstatement invariant

> Uncertainty may **overstate** portfolio usage. It may never **understate**
> maximum commitment.

Version 1.0.0 violated this. It computed one netted figure per market —
`(balYES + yesLong − yesShort) − (balNO + noLong − noShort)` — which prices
exactly one future: every resting order filling at once. That is the most
NETTED reading available, not the most conservative one, and it let a pending
BUY_YES cancel a pending BUY_NO even though either can fill without the other.
Measured live: 80 reported against a true worst case of 1,170, under a 500
ceiling.

2.0.0 tracks the reachable INTERVAL instead of a point. Each resting order
resolves independently, so placing one widens exactly one bound:

```
    b  = bal(YES) − bal(NO)                     realized, held right now
    up = b + yesLong + yesShort                 BUY_YES fills / SELL_YES escrow returns
    dn = b − noLong  − noShort                  BUY_NO  fills / SELL_NO  escrow returns

    worst case = max(|up|, |dn|)
```

A SELL's outcome tokens are escrowed at placement — verified live, where each
pool's outcome balance equalled its resting ask depth exactly — so a resting
sell is already out of `bal`, and its exposure is the escrow coming back on
cancel. Realized YES and NO still net, because a held complete set pays one unit
either way and carries no direction. Pending orders never do.

This is checked against a second implementation that shares no code with it and
solves the problem a different way, by enumerating all sixteen combinations of
fills ([`contracts/test/reference/ExposureOracle.sol`](contracts/test/reference/ExposureOracle.sol)).
The property `accounted >= independent` is asserted in 16 named adversarial
scenarios, under stateful invariant fuzzing, and continuously against the live
deployment by [`scripts/risk-verifier.mjs`](scripts/risk-verifier.mjs).

Every ambiguity resolves in that direction:

- A reservation counts from the moment it is admitted, not when it fills.
- A reservation whose fate is unknown stays counted until the venue proves it gone.
- Opposing pending orders in one market are never netted; the larger bound wins.
- Domain exposure is the gross sum across markets, never netted. Two markets
  sharing a cadence domain establish no payoff equivalence, so nothing offsets.
- A market whose cadence matches no canonical window has no domain and is refused.
- A domain with no configured ceiling refuses everything.

The failure mode this produces is a trade refused that could have been allowed.
The failure mode it prevents is a trade allowed that breaches the owner's limit.
Only one of those is survivable, and the whole design is bent toward it.

---

## Known limitations

**A domain is a cadence, not an asset.** BTC and ETH 15-minute series from the same
creator share one ceiling. `marketId → asset` is not exposed by any view on this
venue (304 selector probes found nothing), and the alternative — an off-chain
attestation the contract cannot verify — would be worse. Stated in the UI wherever
a domain appears. See [DECISIONS.md](DECISIONS.md#1-the-risk-domain-is-a-cadence-not-an-asset).

**AIRSPACE does not eliminate market risk.** It bounds how much exposure your
agents may hold at once. Positions inside that bound can still lose.

**A preview is advisory.** State can move between `previewIntent` and `execute`,
which is the normal case with several agents. The contract re-evaluates and can
refuse an intent the preview admitted — that race is the product working, not a
bug, and it is visible in the live campaign evidence.

**Gas cost is coupled across agents.** `execute` walks the domain's tracked
markets, so its cost depends on what other agents did. An estimate taken before
another agent's transaction lands can be too low; the sample agents double it.
Measured: two transactions estimated at ~3.68M ran out of gas at 3.52M used. See
[DECISIONS.md](DECISIONS.md#8-agents-pad-the-gas-estimate-because-execute-costs-what-the-other-agents-did).

**`MAX_MARKETS_PER_DOMAIN` is 48.** Beyond that a domain refuses new markets until
settled ones are pruned. `pruneMarket` is permissionless.

**A filled order is counted twice until it is reconciled.** DreamDEX's
`getOrder` reverts identically whether an order filled or was cancelled, so when
an outside taker fills a resting order the position arrives in the token balance
while the reservation is still on the books. Both are counted until someone calls
`releaseOrder`. This is the deliberate direction: the alternative is to guess the
order is gone, and a wrong guess understates. It costs admission headroom, never
safety, and reconciliation is permissionless so no privileged party has to be
online. Measured live at 480 against a true 240, converging to 240 on release.

**`committedCapital` is `capitalBase − freeCollateral`.** Collateral arriving
from a profitable sell raises free collateral above the base, so measured
committed capital floors at zero while orders are still open. That understates a
policy BUDGET, and it cannot understate solvency: every buy is gated on
`freeCollateral()` read from the token itself, so the portfolio can never
authorise collateral it does not hold. The owner realigns it with
`setCapitalBase`. Proven in
[`contracts/test/unit/CollateralAccounting.t.sol`](contracts/test/unit/CollateralAccounting.t.sol).

**The ceiling is an admission control, not a hard cap on exposure.** AIRSPACE
guarantees that IT never admits an intent leaving a domain over its ceiling. It
cannot guarantee usage stays under afterwards: an outside counterparty filling a
resting order, or a cancelled sell returning its escrow, both move exposure with
no admission involved, and no on-chain contract can prevent either. While over,
every risk-adding intent is refused until reconciliation restores headroom.

**Venue rules are the venue's.** A post-only order that would cross reverts at
DreamDEX, and `previewIntent` cannot and does not predict it. That is
microstructure, not portfolio risk.

---

## Secrets

Nothing secret is in this repository, and the `.gitignore` is written to keep it
that way: `.env`, `.env.*` (except `.env.example`), `.dev.vars`, `.wallets.json`,
`*.key`, `*.pem`, `*.keystore`, `mnemonic*`, `secrets*`, `service-role*`.

| Secret | Where it lives |
| --- | --- |
| Deployer / owner keys | `.wallets.json`, gitignored, chmod 600, testnet throwaways |
| Agent keys | Cloudflare Worker secrets, one per agent deployment |
| `SUPABASE_SERVICE_ROLE_KEY` | Cloudflare Worker secret on the indexer and lifecycle Workers only; never in a bundle or a response body. The API holds no credentials. |
| `INDEXER_TOKEN` | Cloudflare Worker secret |
| Cloudflare API token | CI secret; local development uses `wrangler login` |

Public by design and safe to commit: the Supabase project URL (an identifier; its
tables are RLS-scoped and the app never reads them), deployed contract addresses,
and RPC endpoints.

`.env.example` documents variable names and never values.

**Run the secret scan before every release checkpoint:**

```bash
node scripts/secret-scan.mjs
```

It fails the build on a match. It is also a CI gate.

### If a secret is exposed

1. Rotate first: new Supabase service-role key, new Worker secrets, new agent keys.
2. Move funds out of any affected address using the owner recovery path above.
3. Purge history only after rotating — a rewrite does not un-leak anything already
   cloned or scraped.
4. Never paste key material into an issue, a report or a commit message, including
   while reporting the exposure.

---

## Reporting a vulnerability

Open an issue describing the impact and how to reproduce it. Please do not include
key material, and please do not exploit against another user's portfolio — these
are testnet contracts, so a reproduction on your own portfolio proves the same
thing.

If a finding lets an agent exceed a portfolio ceiling, lets a non-owner move
capital, or blocks an owner from withdrawing, say so plainly at the top. Those
three are the properties the whole design exists to hold.
