# VERDICT_V2.md

**AIRSPACE** — portfolio-level execution and risk control plane for multiple
heterogeneous DreamDEX Event Contract agents sharing one capital base.
Hostile spike, Somnia Shannon (chainId 50312), 2026-08-27.

*One capital base. Many agents. One risk envelope.*

---

## Scorecard against the LOCK bar

| # | Condition | Result |
|---|---|---|
| 1 | Several independent agents share one capital base without bypassing aggregate enforcement | **PASS** — proven live, 3 agents |
| 2 | One individually-valid trade rejected only because of cross-agent portfolio state | **PASS** — proven live |
| 3 | Resting orders / reservations cannot create hidden aggregate overexposure | **PASS** — proven live on unfilled orders |
| 4 | Risk-bucket identity honest and sufficiently verifiable | **PASS, with disclosure** |
| 5 | Actual post-trade exposure can be reconciled | **PASS** — measured, not asserted |
| 6 | Owner recovery unconditional | **PASS** — proven live |
| 7 | Structurally distinct from Vane, not a feature increment | **PARTIAL** |
| 8 | At least one multi-agent live DreamDEX sequence | **PASS** |
| 9 | Credible path to hundreds of portfolios and thousands of executions | **PARTIAL** |

Seven clear, two partial. LOCK requires all nine.

---

## What was proven

**The mechanism works, live, on the real venue.** Bucket ceiling 500 contracts.
Agent A reserved 180 on a daily BTC market. Agent B reserved 240 on an hourly
BTC market. Agent C then proposed 150 — an order its own policy admitted in full,
with `maxOrderNotional` and `maxCommitted` an order of magnitude above it — and
was refused with `BucketDirectionalExceeded` because 180 + 240 + 150 > 500.
`agentCommitted[C]` was still zero: C's own budget was never touched. Release A's
reservation and the identical order is admitted. That is the product, and nothing
else in the field does it.

**Reservations count before they fill.** A and B were both unfilled POST_ONLY
resting orders. Nothing had filled when C was rejected. The invariant
`reserved == filled + resting + cancelled` means the ceiling that admitted an
order keeps holding after it fills, so several agents' resting orders cannot
collectively breach a limit that admitted them.

**Aggregate enforcement is unbypassable by construction, not by discipline.** All
capital lives in one contract, so the check is a storage read in the same
transaction that moves the money. Parent/child and coordinator designs were
rejected because a contract that cannot *hold* capital cannot *withhold* it.

**Exposure is measured, not accumulated** — and this was forced by a bug the
tests caught, not chosen for elegance. `getOrder` reverts *identically* for a
filled and a cancelled order, so a running total cannot answer which happened —
unanswerable once maker fills land in transactions the contract never sees.
Reading positions from the ERC-6909 singleton dissolves the question. The books
cannot drift from the chain because the chain is where they are read from.

**Fills are derived exactly.** `filled` from the balance delta, `resting` from
`getOrder`, `filledCost` from the collateral delta minus the resting escrow at
our own limit price. Nothing is fabricated. This matters because a taker is
charged the resting price, not its own limit.

**Eleven live attacks by a hostile agent all refused**, including the two that
are specific to multi-agent: releasing another agent's live reservation
(`OrderStillLive`) and admitting a market into a different bucket (`NotOwner`).
**39/39 tests pass** across both suites.

**Owner recovery is unconditional** — 6,000 tUSDC out with all three agents
revoked, residual zero.

---

## Why it does not LOCK

### 9 — the admission burden on rolling markets

Risk-bucket membership requires an owner `admitMarket` transaction per market.
On daily and hourly series that is 1–24 per day and entirely workable, and the
live run used exactly those. On the **60-second series that dominate Shannon
activity** it is 1,440 per series per day, which is not a workflow — it is a
blocker.

Portfolios themselves scale fine: independent factory clones, no shared state, no
global registry, ~0.02 STT per execution at Shannon gas. The bottleneck is not
throughput, it is the human in the admission loop. AIRSPACE today is a portfolio
system for slow cadences, and the venue's flagship product is fast ones.

### 7 — distinct mechanism, shared architecture

The mechanism is absent from the entire field: Vane is one-operator-per-contract
with no aggregation, Branch is non-custodial and sequential rather than
simultaneous, Sentry holds no funds, Lictor is a single-shot spot mandate, Fief
has no shared capital. Confirmed against deployed bytecode and current
repositories, not README language.

But the honest counterweight, stated plainly: **AIRSPACE and Vane sit on the same
custody architecture.** Vane's per-owner vault already *is* a shared capital
base; it simply authorises one operator. It would not need a different capital
architecture to get here — it would need a different risk model (multi-agent
identity, a bucket abstraction spanning markets, measured-not-accumulated
exposure, and a provable reservation lifecycle). That is roughly a week of
careful work, not one commit, and points three and four are consequences of
multi-agent rather than features bolted on. Whether "different risk model on the
same custody model" clears *structurally distinct* is a genuine judgment call,
and I am not going to resolve it in my own favour by assertion.

Two partials, and the bar says all nine.

---

## Why this is not KILL

None of the KILL conditions is met, and each was tested rather than assumed:

- *Aggregate enforcement bypassable* — no. Proven unbypassable under a fully
  compromised agent key, live and on fork.
- *Asset grouping requires pretending off-chain metadata is trustless* — no. The
  search was exhaustive (304 selector probes across three contracts), the
  negative result is documented, and the bucket is labelled `OWNER_ATTESTED`
  everywhere it appears. Default is deny, every structural property is pinned
  and re-verified, and the attestation is publicly falsifiable against the
  creation events. Nothing is dressed up as trustless.
- *Reservation accounting cannot be made safe* — no. It is safe, and the unsafe
  version was found and removed.
- *Vane can reproduce it with a trivial modification* — no. Not trivial, though
  not architecturally out of reach either.
- *Merely FLIGHTPATH with more agents* — no. The constraint object changed from
  an agent's spend to a portfolio's risk surface, which forced a different state
  model. `agents[]` bolted onto FlightAccount would not have produced any of §4
  or §5 of `PORTFOLIO_ACCOUNTING.md`.

The contracts, the accounting model, the protocol findings and the whole evidence
trail are keepers.

---

## What flips this to LOCK

Both remaining objections have the same fix, and it is small and well specified.

**Build the structural bucket.** Define a bucket by `(creator, collateral,
intervalSec)` — every field readable from the module registry and already
verified at execution. No attestation, no admission transaction, works on
continuously rolling markets by construction. It cannot separate BTC from ETH,
so the bucket becomes "either underlying at this cadence from this creator", and
a ceiling on that is a weaker but entirely genuine and entirely trustless
portfolio control.

This lands both partials at once:

- **9** — the admission loop disappears, so 60-second series work and the path to
  thousands of executions stops depending on a human.
- **7** — a trustless bucket keyed on protocol-derived series identity is a
  further step from Vane's pool allowlist, which the FLIGHTPATH spike already
  showed is bound to a mutable slot (one observed pool served 52 markets across
  both assets).
- **4** — attested buckets become the precise-but-manual option rather than the
  only option, which is a strictly more honest product surface.

The enforcement core is agnostic to how a bucket is defined, so this is an
addition to `admitMarket` and `bucketGross`, not a rewrite. Ship it, re-run the
live cohort on a 60-second series, and the scorecard reads nine for nine.

Two smaller items worth doing alongside: benchmark `execute` with a full
32-market bucket (measured 2.7–3.4M gas at two), and resolve whether the
Reactivity 32 SOMI floor is enforced on-chain or only client-side — neither is
load-bearing, both are currently unknown and labelled as such.

---

REVISE
