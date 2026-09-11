# Remediation: reservation netting

AIRSPACE 1.0.0 understated worst-case directional exposure. It was replaced by a
new deployment, 2.0.0, at new addresses. The broken one was not upgraded,
patched or relabelled.

---

## Root cause

`AirspacePortfolio._directional` collapsed a market to one netted figure:

```
(bal(YES) + yesLong − yesShort) − (bal(NO) + noLong − noShort)
```

That expression prices exactly one future — every resting order filling at once.
It is the most NETTED reading available, not the most conservative one.

Two resting orders on opposite sides of a market resolve **independently**.
Either can fill without the other, either can be cancelled, either can expire.
Netting them assumed a correlation the venue does not provide, and the error is
unbounded: two opposing orders of size `q` each report zero risk.

The subtlety that made it look right is that opposing *realized* balances really
do net. A held YES and a held NO are a complete set, worth one collateral unit
whichever way the market resolves, so they carry no direction. The formula
applied that correct rule to reservations, where it does not hold.

Measured on the live portfolio at Shannon block 473455000:

| | |
| --- | --- |
| contract reported | 80 |
| true worst case | 1,170 |
| understatement | 1,090 |
| domain ceiling | 500 |

42 of 67 admissions on that domain occurred while the true worst case was
already over the ceiling.

### Why the test suite did not catch it

Two independent reasons, both now fixed.

1. **The invariant checked the number against itself.** It asserted
   `domainRiskUsage <= CEILING`, where `domainRiskUsage` is the contract's own
   figure. An understatement made the assertion pass. The suite could not have
   detected this class of defect at all.
2. **The suite was doubly vacuous.** Its handler hard-coded `kind: 0`, so
   opposing reservations were structurally unreachable no matter how long the
   fuzzer ran. And its fixture set every market's `tradingStart` two days in the
   future, so every intent was refused `MARKET_NOT_TRADING` and **no order was
   ever admitted at all** — in 1.0.0 either.

---

## The corrected model

Worst-case exposure is derived from DreamDEX's four order kinds and its escrow
semantics, and it maximises over independently possible pending fills.

```
b  = bal(YES) − bal(NO)              realized, held right now
up = b + yesLong + yesShort          BUY_YES fills  / SELL_YES escrow returns
dn = b − noLong  − noShort           BUY_NO  fills  / SELL_NO  escrow returns

worstCase = max(|up|, |dn|)
```

`yesShort` sits on the UPPER bound because a SELL escrows its outcome tokens at
**placement**, not at fill. That was not taken from the mock, which had it wrong;
four live Shannon pools were probed, and each pool's outcome-token balance
equalled its resting ask depth exactly. So a resting ask has already left `bal`,
and what it exposes is the escrow coming back if the order is cancelled.

Realized YES and NO still net. Pending orders never do, in either direction.

Domain usage is the **gross sum** of per-market worst cases. Two markets sharing
a cadence domain establish no payoff equivalence between them, so nothing
offsets: being long one series and short another is two positions, not zero.

---

## Two implementations

The model is implemented twice, on purpose, sharing no helper and no code path.

| | |
| --- | --- |
| production | `contracts/src/AirspacePortfolio.sol` — closed-form bound |
| reference | `contracts/test/reference/ExposureOracle.sol` — enumerates all 16 combinations of fills |

The reference takes primitive inputs only and never calls the portfolio. It is
deliberately brute force: there is no algebra in it to share a mistake with.

The same treatment was applied to the capital side rather than assuming it was
fine because this bug was directional:
`contracts/test/reference/CollateralOracle.sol` computes reservations by a
different rounding formulation than the contract's `+ one − 1` idiom.

### The property

```
AIRSPACE_ACCOUNTED_WORST_CASE >= INDEPENDENT_REFERENCE_WORST_CASE
```

Understatement by one raw unit fails. Overstatement is permitted, measured, and
reported.

---

## Tests added

**100 tests, 9 stateful invariants, all passing.** Up from 48.

| file | what it adds |
| --- | --- |
| `test/reference/ExposureOracle.sol` | independent exposure model, by enumeration |
| `test/reference/CollateralOracle.sol` | independent reservation model |
| `test/unit/ReservationNetting.t.sol` | 15 tests. Both formulas verbatim; the historical failure as a regression |
| `test/unit/AdversarialStates.t.sol` | 16 named scenarios covering every required adversarial state |
| `test/unit/CollateralAccounting.t.sol` | 8 tests validating the capital side independently |
| `test/invariant/PortfolioInvariants.t.sol` | handler reaches all four order kinds; 3 new invariants |
| `test/mocks/MockDreamDex.sol` | sells now escrow at placement, matching the live venue |

### Adversarial states, each asserting the property

BUY_YES + BUY_NO resting together · BUY_YES + SELL_YES · BUY_NO + SELL_NO ·
realized YES + pending BUY_NO · realized NO + pending BUY_YES · complete realized
set + one-sided pending · partial fill of one opposing leg only · external
counterparty fills a resting order · cancellation of one side while the other
stays live · cancelled sell returning escrow · three agents supplying opposing
orders · several markets in one domain · admission at the ceiling from both
sides · same-block concurrent admissions · generation recycling bound both ways ·
partial-fill reconciliation.

### Invariants

```
invariant_neverUnderstatesIndependentWorstCase      256 runs x 8192 calls
invariant_domainSumIsGross
invariant_overCeilingOnlyEverRefusesMore
invariant_reservedCollateralMatchesTheOrderRecords
invariant_reservedCollateralIsBackedByRealCapital
invariant_committedNeverExceedsCapitalBase
invariant_domainCollectionStaysBounded
invariant_portfolioRetainsItsCollateral
invariant_ownerRecoveryAlwaysAvailable
```

The handler's `propose` now bounds `kind` to 0–3 and prices across the band.
Sells clip to what the portfolio actually holds and fall back to a buy on the
same side when it holds nothing: fabricated inventory would fabricate exposure
the contract never admitted, and any conclusion drawn from it would be an
artefact.

`invariant_overCeilingOnlyEverRefusesMore` replaced the unsound global
`domainRiskUsage <= CEILING`. The ceiling is an ADMISSION control: an outside
taker filling a resting order, or a cancelled sell returning escrow, both move
exposure with no admission involved, and no on-chain contract can prevent
either. The admission guarantee is asserted inside the handler at the moment of
every successful `execute`; the global invariant proves the useful consequence,
that while over the ceiling every risk-adding intent is refused.

---

## The historical regression

`test_historicalState_v1Understates` replays the exact failing state through
both formulas:

| | |
| --- | --- |
| 1.0.0 formula | **80** |
| independent worst case | **1,170** |
| understatement | **1,090** |
| 2.0.0 formula | **1,170** |

`test_historicalState_v2WouldHaveRefused` asserts that 1.0.0 saw room under the
500 ceiling and admitted, and that 2.0.0 refuses.
`testFuzz_v1DoesNotHoldTheProperty` proves 1.0.0 fails the property by
construction on any pair of opposing buys.

---

## Collateral accounting verdict

Independently validated, not assumed.

- A BUY escrows **exactly** what admission reserved, checked against the measured
  ERC-20 delta across every buy kind and four price points.
- A SELL escrows no collateral, consumes no reservation, and raises no committed
  capital.
- Reservations round **up**, never down, and never by more than one unit.
- `reservedCollateral` equals the sum of live per-order `collReserved`, checked
  as an invariant under fuzzing rather than only in fixed scenarios.
- Partial release scales the reservation proportionally and never leaves more
  reserved than is still resting.
- No agent path to capital: `withdraw`, `withdrawOutcome`, `setCapitalBase`,
  `setAgent` and `ownerCall` all revert `NotOwner`.

**One imprecision, stated rather than hidden.** `committedCapital` is
`capitalBase − freeCollateral`, so collateral arriving from a profitable sell
raises free collateral above the base and pins measured committed capital at
zero while orders are still open. That understates a policy BUDGET. It cannot
understate solvency: every buy is gated on `freeCollateral()` read from the token
itself, so the portfolio can never authorise collateral it does not hold. The
owner realigns it with `setCapitalBase`. Proven both ways in
`test_sellProceedsUnderstateCommittedCapitalNotSolvency`.

---

## The replacement deployment

| | |
| --- | --- |
| Factory | `0xeD3D4552AFda96EfC5BF47c533E3302C655CB732` |
| Implementation | `0xeB39A417eAC32f18a5C548afd9E442D2DEf416C4` |
| Version | 2.0.0 |
| Block | 473593665 |
| Implementation tx | `0x2dc3ff8770689ca442c9f98e83fe7579c1763046e918eda7d0783e77e8eb0d17` |
| Factory tx | `0x7b8c66c2b018ec6f6c895774110d899c07b36313bd8208652b6abd34d0d8b4b5` |
| Runtime size | 23,918 bytes (658 under EIP-170) |

**Superseded, unsafe, do not fund:** factory
`0x342d200aCF529905CC815D4ff9841053ea1c2D61`, implementation
`0x6DE57BC332AA93D3d6323509B3FDA4BCa4808Eb0`. Preserved unchanged in
`engineering/03-superseded-unsafe-v1/`.

Somnia under-estimates deployment gas by roughly 11x: the implementation
estimated 6,793,595 and consumed 79,033,439. Two attempts were lost to it before
`--gas-estimate-multiplier 2000`. Recorded in DECISIONS.md #18.

---

## Live proof

### Canonical refusal — `live-proof.json`

Portfolio `0x975Dbb89a2582B53b9C5a21721F0abD3ac6f58A5`.

| step | usage | tx |
| --- | --- | --- |
| A reserves 180 | 180 / 500 | `0xa7962f42a589b500c0250228f0a49da621a8bdb2f904eae9815afd00be949de3` |
| B reserves 240 | 420 / 500 | `0xdaa660ff1ebf0e47c3f02d409cdea872495affc0762f3041f7f8bdd273c46cf9` |
| C proposes 150 | **REFUSED** 570 > 500 | — |
| 12 hostile probes | all refused correctly | — |
| release A | 240 / 500 | `0x0fe8b03c8d38958ad65c9be5210d1b51750dae21037d30a3db183598f1cd9a54` |
| C retries, identical | **ADMITTED** 390 / 500 | `0x924a4a65e7ad22ac5b9c64ba7f86617784e4e3210042f9a915852dcd258afac3` |
| owner recovery | all collateral withdrawn | — |

### The bug shape, rebuilt live — `opposing-live.json`

Portfolio `0x637b05C8aa242325bCD2Bb91752810cCE7afEf1C`. Two independently-keyed
agents resting opposite sides of one market. 8 of 8 checks pass.

| | |
| --- | --- |
| resting BUY_YES / BUY_NO | 240 / 90 |
| 2.0.0 reported | **240** |
| independent worst case | **240** |
| 1.0.0 formula would have reported | **150** |
| understatement avoided | **90** |

- a same-side addition over the ceiling: `DOMAIN_RISK_EXCEEDED`
- an **opposing**-side addition over the ceiling: `DOMAIN_RISK_EXCEEDED` — the
  door 1.0.0 left open
- same-block race, 40 of headroom, two agents each wanting 30: first admitted
  (`0x163ff5b77eae93cc7eeac9e62178d6811516d3c2c4a94fec1dcbd671a908b847`), second
  `DOMAIN_RISK_EXCEEDED`, usage 270 under a 280 ceiling

### Fork tests

10 tests against live Shannon state, including cross-agent refusal on real
markets, a real taker fill, external-fill exposure, and the hostile agent suite.
All pass.

---

## Long-run verifier — `risk-verification.json`

`scripts/risk-verifier.mjs` rebuilds every quantity from a primary source and
never reads the contract's own reservation counters. Order ids come from
`IntentAdmitted` logs; how much of each is still open comes from `getOrder` on
the pool, one order at a time.

**18 rounds over 29 minutes. SAFETY held in every round.**

Rounds 2–18 recorded the deliberate overstatement: an outside taker filled a
resting order, so the position arrived in the token balance while the reservation
was still on the books.

| | |
| --- | --- |
| contract reported | 540 |
| independent worst case | 270 |
| reconciliation backlog | 270 |
| verdict | overstatement — safe direction |

Then reconciliation was run with the permissionless keeper key:

| | |
| --- | --- |
| before | 540 |
| after 3 `releaseOrder` calls | **270** |
| backlog | **0** |
| overstatement | **0** |

`0x3362ab7a12a23778e09db880c6073f51b263a004818ff6e6f5e8a3e35153169d`,
`0xfc374e599e7aadeec6cc71d025d39b325a45ebd0f8c84fc0a48bab556d5de3d8`,
`0xaa7152207ad614cf6f4de95b4776d73ddf678c9ae6c03a2dd925b2818f06623d`.

Converged exactly on the independent figure. That is the liveness half:
overstatement is bounded and it clears, and clearing it requires no privilege.

---

## Remaining conservative overstatement

Two, both deliberate, both documented, neither able to understate.

**1. A filled order is counted twice until reconciled.** DreamDEX's `getOrder`
reverts identically whether an order filled or was cancelled, so when an outside
taker fills a resting order, the position is in the token balance while the
reservation is still charged. Measured live at 540 against a true 270. The
alternative is to guess the order is gone, and a wrong guess understates — the
failure class that superseded 1.0.0. It costs admission headroom, never safety,
and `releaseOrder` is permissionless so no privileged party has to be online.

**2. A cancelled order is charged until released.** Same mechanism, same
direction, same fix.

The closed-form bound itself is **tight**, not merely safe:
`testFuzz_boundIsTightNotMerelySafe` asserts it equals the exhaustive
enumeration exactly on every input, so the model adds no conservatism of its own.
All the overstatement above comes from reconciliation lag, and all of it clears.
