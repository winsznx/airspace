# CRITICAL: opposing reservations net against each other

**Status: RESOLVED in AIRSPACE 2.0.0.** The defective deployment was not
upgraded — there is no upgrade authority — so it is preserved unchanged, along
with the state that broke it, in
[`engineering/03-superseded-unsafe-v1/`](../../engineering/03-superseded-unsafe-v1/).
Do not fund `0x342d200aCF529905CC815D4ff9841053ea1c2D61`.

The replacement is a separate deployment: factory
`0xeD3D4552AFda96EfC5BF47c533E3302C655CB732`, implementation
`0xeB39A417eAC32f18a5C548afd9E442D2DEf416C4`, block 473593665.

Everything below is the finding exactly as it was written, before any fix
existed. It is left in the present tense on purpose. The resolution is recorded
at the end.

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


---

## Resolution

### The corrected model

A market is an INTERVAL of reachable positions, not a point. Each resting order
resolves independently, so placing one widens exactly one bound:

```
b  = bal(YES) − bal(NO)              realized, held right now
up = b + yesLong + yesShort          BUY_YES fills / SELL_YES escrow returns
dn = b − noLong  − noShort           BUY_NO  fills / SELL_NO  escrow returns

worstCase = max(|up|, |dn|)
```

A SELL escrows its outcome tokens at PLACEMENT. That was not assumed from the
mock — it was probed on four live Shannon pools, each of whose outcome-token
balance equalled its resting ask depth exactly. So a resting sell has already
left `bal`, and what it exposes is the escrow returning if it is cancelled.
The mock had modelled burn-on-fill, which hid the entire sell side from every
test that used it, and was corrected.

Realized YES and NO still net: a held complete set pays one unit whichever way
the market resolves. Pending orders never net.

Domain usage is the gross sum of per-market worst cases. Two markets sharing a
cadence domain establish no payoff equivalence, so nothing offsets.

### How it is checked

The model is implemented a second time, independently, by a different method:
[`contracts/test/reference/ExposureOracle.sol`](../../contracts/test/reference/ExposureOracle.sol)
enumerates all sixteen combinations of fills rather than evaluating a bound. It
shares no helper and no code path with the production contract. The property

```
AIRSPACE_ACCOUNTED_WORST_CASE >= INDEPENDENT_REFERENCE_WORST_CASE
```

is asserted in 16 named adversarial scenarios, under stateful invariant fuzzing
at 256 runs x 8192 calls, and continuously against the live deployment.

### The regression

The exact state in this document is pinned in
[`contracts/test/unit/ReservationNetting.t.sol`](../../contracts/test/unit/ReservationNetting.t.sol),
which carries both formulas verbatim:

| | reported |
| --- | --- |
| v1 formula | 80 |
| independent worst case | 1,170 |
| understatement | 1,090 |
| v2 formula | 1,170 |

`test_historicalState_v1Understates` asserts all three numbers.
`test_historicalState_v2WouldHaveRefused` asserts that v1 saw room under the 500
ceiling and admitted, and that v2 refuses.

### Why the old suite did not catch it

Two independent reasons, both fixed:

1. The invariant asserted `domainRiskUsage <= CEILING` — the contract's own
   number, against itself. An understatement made the assertion pass. That is
   why the replacement is checked against a separately written implementation.
2. The suite was vacuous in two ways at once. Its handler hard-coded BUY_YES, so
   opposing reservations were structurally unreachable; and its fixture set every
   market's `tradingStart` two days in the future, so every intent was refused
   `MARKET_NOT_TRADING` and no order was ever admitted at all — in v1 either.

### Live confirmation

Rebuilt on the real venue against the replacement, with two independently-keyed
agents resting opposite sides of one market:
[`opposing-live.json`](opposing-live.json).

| | |
| --- | --- |
| resting BUY_YES / BUY_NO | 240 / 90 |
| 2.0.0 reported | 240 |
| independent worst case | 240 |
| v1 formula would have reported | 150 |
| understatement avoided | 90 |

An opposing-side intent over the ceiling was refused `DOMAIN_RISK_EXCEEDED`,
which is the door v1 left open.
