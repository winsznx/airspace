# VERDICT_V3.md

**AIRSPACE** — one capital pool, many trading agents, one shared risk envelope.
Final product-lock validation. Somnia Shannon (chainId 50312), 2026-08-27.

Dominant mechanism: **cross-agent portfolio admission + reservation + post-trade
reconciliation.**

---

## Scorecard

| # | LOCK condition | Result |
|---|---|---|
| 1 | Structural domains require no semantic attestation or per-market owner admission | **PASS** |
| 2 | Rolling markets enter the correct enforcement domain automatically | **PASS** |
| 3 | Several independent agents share one capital base under unbypassable aggregate enforcement | **PASS** |
| 4 | An individually valid order is live-rejected solely due to other agents' state | **PASS** |
| 5 | Concurrent agents cannot race through global headroom | **PASS** |
| 6 | Reservation accounting cannot understate real maximum portfolio commitment | **PASS** |
| 7 | Actual DreamDEX outcome balances safely reconcile filled exposure | **PASS** |
| 8 | Owner recovery is unconditional | **PASS** |
| 9 | The mechanism remains meaningfully distinct from Vane | **PASS** |
| 10 | Scale to 100 portfolios / 1,000 agents / 10,000 intents demonstrated | **PASS** |
| 11 | Concrete DreamDEX user and sponsor value proposition | **PASS** |

Eleven of eleven. 76 tests pass — 37 new, 39 preserved from the earlier spikes.

---

## The two things the REVISE demanded, and what replaced them

**The semantic attestation is gone.** Risk domains are
`keccak256(creator, collateral, canonicalCadence)`, every field read from
`module.markets()` during execution. No indexer, no owner-supplied "BTC" string, no
event-log attestation, no trusted relayer.

Cadence is canonicalised by an exact rule — the smallest canonical `C` with
`C >= (expiry - tradingStart)` and `expiry % C == 0` — because raw windows are not
safe to key on. Scanning 1,200 consecutive live markets found two real **898-second**
markets on a 900-second series. Keyed raw they would have formed their own domain and
escaped the ceiling entirely; the rule absorbs them into the 900-second domain, and
a 60-second market still never escalates. Zero unresolved across the whole sample.

**Per-market admission is gone.** One `setDomainPolicy` call covers every market that
series will ever roll. The live run records `ownerTxSinceConfig: 0` while two agents
traded two different markets, and `test_S4` drives 500 consecutive 60-second
generations through the contract with zero configuration between them.

The contract has a different name because the state model changed, not the policy
surface.

---

## What was proven live

Two markets, two pools, two generations, one derived domain
(`domainOf(0xb278) == domainOf(0xb277) == 0xdc493f0f…`).

```
AGENT_A reserves 180                                  ->  180 / 500
AGENT_B reserves 240 on a different market            ->  420 / 500
AGENT_C proposes 150  ->  DomainRiskExceeded
        C's own policy passed. Every market check passed.
        agentCommitted[C]: 0 before -> 0 after
        domainRiskUsage:   420 before -> 420 after
release A through a real lifecycle path               ->  320 / 500
AGENT_C retries the identical shape                   ->  ADMITTED, 470 / 500
```

A's and B's orders were **unfilled** resting orders, so this is also the proof that
reservations occupy the envelope before they fill.

Eleven hostile refusals against a malicious C, including the two that only exist in a
multi-agent world: switching to the sibling series consumes the same headroom rather
than escaping it, and a rival agent cannot free capacity by claiming someone else's
live order is dead (`OrderStillLive`).

Owner recovered 5,965.44 tUSDC with all three agents revoked, residual zero.

---

## The correctness result that mattered most

`getOrder` reverts **identically** for a filled and a cancelled order. A running
exposure counter therefore cannot stay correct once fills land in transactions the
contract never executes — and with several agents that is the normal case, not an
edge case.

I built the counter version first and the fork tests broke it. The shipped design
reads realized positions from the ERC-6909 singleton and stores only unfilled
reservations. `test_R7_externalFillCannotUnderstateRisk` proves it adversarially: an
unrelated account mints a complete set and fills the portfolio's resting bid in a
transaction the portfolio never sees.

```
before external fill : 20 contracts
after  external fill : 40 contracts   (reservation + realized, overstated)
after  releaseOrder  : 20 contracts   (converges to truth)
```

Overstated, never understated, and self-correcting.

---

## Distinctness, tested at its strongest

> *If AIRSPACE can be reduced to "Vane + multiple operator addresses + one global
> `uint256`", KILL.*

It cannot, and the reason is the paragraph above: **the global `uint256` is exactly
the construction that does not work.** A counter must know whether a dead order
filled or was cancelled, and the protocol will not tell it. The correct object is an
O(markets) aggregate measured from token balances — a different state model, not a
wider variable.

Vane, re-read from deployed bytecode rather than its README: a singular
`operator()` address slot, `setOperator(address)`, and **no** exposure-aggregation
surface at all (`totalExposure`, `maxExposure`, `reservedCollateral`, `budget` all
absent). Its market selection is a pool allowlist, which cannot express "this series,
forever" — one observed pool served 52 distinct markets across both BTC and ETH.

I will not overstate the gap: **both share the same custody primitive**, and the
existence of contract custody is not a differentiator — the previous REVISE said so.
What differs is the product mechanism. To reach it Vane would have to redesign
operator cardinality, add shared portfolio state, add cross-agent atomic reservation,
add portfolio-wide reconciliation, and replace scalar budgets with risk-domain
accounting. That is a multi-agent portfolio scheduler with a new shared reservation
and reconciliation model. Achievable by a competent team in about a week — but a
rewrite of what the contract tracks, not a feature flag.

---

## Why this is not KILL

Each KILL condition was tested, not waved past:

- *Calling cadence domains BTC/ETH risk* — refused everywhere. The contract computes
  a cadence domain, sibling series share it by design, and the docs say so in the
  same breath as the ceiling. Off-chain labels are marked NON_AUTHORITATIVE.
- *Hiding off-chain trust* — there is none left in the enforcement path. The one
  remaining owner input is a ceiling, which is a risk preference, not an assertion
  about the world, and an agent cannot forge it.
- *Weakening reservation safety* — the opposite. Worst-case capacity is reserved
  before value moves, and every approximation in the system overstates risk.
- *Ordinary multi-user vault logic renamed* — a multi-user vault tracks per-user
  balances and lets each spend their own. AIRSPACE does the inverse: one shared
  budget where one agent's usage denies another. That denial is the product, and it
  was demonstrated live.

---

## What LOCK does not mean

Stated so the verdict is not read as broader than it is.

- Domains are **coarser than assets**. A ceiling covers both sibling series at a
  cadence. Separate BTC and ETH limits are not expressible on this protocol surface,
  and that is a deliberate trade of precision for trustlessness.
- Two mappings (`intentUsed`, `_orders`) grow monotonically. Neither is iterated, so
  gas stays O(1) in history, but storage grows. A per-agent monotonic nonce would
  bound it; recorded, not shipped.
- The same-block race is proven on fork; the live race was concurrent submission with
  an on-chain revert four blocks apart.
- 10,000 intents were benchmarked against mocks. Correctness is proven on the real
  fork; the scale figure isolates AIRSPACE's own bookkeeping.
- At 60-second cadence a keeper is mandatory. Without pruning, a continuously trading
  portfolio reaches the 48-market domain cap in ~48 minutes and fails closed.
- Reactivity is live on Shannon and would improve liveness only. It was not built,
  and the 32 STT subscription floor was not cleared by this spike's wallet.
- Owner-key compromise, oracle failure, stuck resolution and venue insolvency are all
  outside what this bounds.

---

LOCK
