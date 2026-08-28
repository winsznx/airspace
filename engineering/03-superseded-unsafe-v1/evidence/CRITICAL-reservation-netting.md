# CRITICAL: opposing reservations net against each other

**Status: open. Not fixed. The contract is deployed with this defect.**

The safe-overstatement invariant does not hold. `domainRiskUsage` can report a
number far **below** the portfolio's true maximum commitment, and the live
campaign admitted 42 intents while it was doing so.

This was found by building an independent verifier
([`scripts/risk-verifier.mjs`](../../scripts/risk-verifier.mjs)) that
reconstructs exposure from ERC-6909 balances and the DreamDEX order book rather
than trusting the contract's own number.

---

## The defect

`AirspacePortfolio._directional`:

```solidity
int256 yes = balanceOf(YES) + m.yesLong - m.yesShort;
int256 no  = balanceOf(NO)  + m.noLong  - m.noShort;
return int128(yes - no);
```

`yesLong` is a resting BUY YES. `noLong` is a resting BUY NO. They land on
opposite sides of `yes - no`, so **they cancel each other**.

They are independent orders on opposite sides of the book. Either can fill
without the other. The formula prices the single outcome where *all* reservations
fill simultaneously — which is the most **netted** assumption available, not the
most conservative one.

Netting realized YES against realized NO is correct: a matched complete set pays
1 whichever way the market resolves, so it carries no directional risk. Applying
that same netting to **unfilled** reservations is not correct, because they are
not held and may never be.

The true worst case is the fill combination that maximises exposure:

```
hi = balYES + yesLong − (balNO − noShort)     every YES buy fills, no NO buy does
lo = balYES − yesShort − (balNO + noLong)     every NO buy fills, no YES buy does
worst = max(|hi|, |lo|)
```

---

## Measured on the live campaign portfolio

`0x2839EA7138c1cB783272041D55Ed6e9e29f2D4Bc`, 15-minute tUSDC domain
`0xecad3411…`, ceiling **500** contracts, unchanged throughout (no
`DomainPolicySet` event in the window).

| block | contract reported | true worst case | realized holdings only |
| --- | --- | --- | --- |
| 473455000 | 820 | **2,480** | **1,000** |
| 473458000 | 1,000 | **2,320** | **1,000** |
| 473461234 | 1,120 | **1,160** | **1,000** |

Peak understatement: **1,660 contracts** — the contract reported 820 where the
worst case was 2,480, against a ceiling of 500.

One market at block 473455000, in isolation:

```
market #48588   balYES 70   balNO 620   yesLong 1090   noLong 620

contract:  (70 + 1090) − (620 + 620)  =   −80   →  reported  80
truth:      70 − (620 + 620)          = −1170   →  worst   1170
```

The contract reported **80** for a market holding **−550 of realized exposure**
before any reservation is considered at all.

### Realized exposure alone breached the ceiling

`realized = |balYES − balNO|` summed over the domain reached **1,000 contracts
against a 500 ceiling**. These are ERC-6909 tokens the portfolio actually held.
That is not a projection, a reservation, or a double count.

---

## The causal chain

```
42 of 67 admissions on this domain occurred while the TRUE worst case
already exceeded the ceiling.

first such admission
  block           473413080
  tx              0x2f4edce9353003c42c89531a049e5de729121c2ac626f0a81e49ae8ec9cfd7f2
  contract saw    530   → admitted, because its own number was near the ceiling
  true worst case 1280
  realized only    620
```

Each admitted order then filled and became realized, so realized exposure
accumulated past the ceiling. The netting is the cause; the realized excess is
the consequence.

---

## This inverts the earlier reading of 1,120 / 500

The reading that looked alarming was the *safe* one. As reservations drained,
the contract's number climbed **toward** the truth:

```
block 473455000   reported   820   worst 2480     masked by 1,660
block 473458000   reported 1,000   worst 2320     masked by 1,320
block 473461234   reported 1,120   worst 1160     masked by    40
```

The dangerous readings were the **low** ones — 80, 300, 530 — which were the
formula netting away real exposure. An observer watching only
`domainRiskUsage` would have been most reassured exactly when the portfolio was
most exposed.

---

## Why 48 tests and five invariant runs missed it

Two blind spots compounding, both in
`contracts/test/invariant/PortfolioInvariants.t.sol`:

**The fuzzer cannot reach the bug.** The handler hard-codes `kind: 0` — every
proposed intent is a BUY YES. `noLong` is therefore always zero, `yesLong` has
nothing to cancel against, and the opposing-reservation case is structurally
unreachable no matter how many calls the fuzzer makes.

**The invariant checks the contract against itself:**

```solidity
assertLe(pf.domainRiskUsage(DOM), CEILING, "domain ceiling breached");
```

`domainRiskUsage` is the number under test. If the accounting understates, this
assertion passes *because* it understates. It cannot detect an understatement by
construction — it needed an independently reconstructed figure to compare
against, which is what the verifier now provides.

The live agents only ever bid, but they bid on **both** sides — `momentum` and
`reversion` buy NO when the mid moves against YES — so production reached in
minutes what the fuzzer could not reach in 8,192 calls.

---

## What is not implicated

- **Owner recovery.** `withdraw` reads no policy and no market state. Unaffected.
- **Agents cannot move capital.** Unaffected by this defect.
- **Reconciliation liveness.** Verified separately and it does converge: stale
  reservations are released and the reported number converges on realized
  holdings. That half of the earlier claim stands.
- **Collateral accounting** (`committedCapital`, `reservedCollateral`,
  `freeCollateral`) is a separate mechanism measured from token balances. It is
  **not** verified by this work either way, and should be checked before it is
  relied on.

## What is implicated

The central product claim. A domain ceiling did not bound worst-case directional
exposure for a portfolio holding resting orders on both sides of a market.

---

## The fix, not yet applied

`_directional` must not net unfilled reservations against each other. Exposure
should be evaluated at the bound that maximises it:

```solidity
int256 hi = int256(balYes) + int256(yesLong) - (int256(balNo) - int256(noShort));
int256 lo = int256(balYes) - int256(yesShort) - (int256(balNo) + int256(noLong));
return _abs(hi) > _abs(lo) ? hi : lo;   // by magnitude
```

Realized YES still nets against realized NO, which is correct. Reservations stop
offsetting one another, which is the defect.

This changes the deployed bytecode and invalidates the live proof addresses, so
it is a redeploy rather than a patch. It is **not** applied here: the finding is
recorded first, with the deployed contract as-is, so the evidence describes what
was actually running.

Two test changes are needed alongside it, or the same gap reopens:

1. The invariant handler must propose all four `kind` values, so opposing
   reservations occur in one market.
2. `invariant_domainUsageNeverExceedsCeiling` must compare against an
   independently computed worst case, not against `domainRiskUsage`.

---

## Reproduce

```bash
node scripts/risk-verifier.mjs --block 473461234 --scan 95000
```

Archive state on the public Shannon RPC reaches roughly 100,000 blocks. Past
that window the reads return `0x` and the reconstruction is no longer possible
from this endpoint.
