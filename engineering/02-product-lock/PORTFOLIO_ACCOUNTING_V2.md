# PORTFOLIO_ACCOUNTING_V2.md

Exact economic vocabulary. Six named quantities, each with one meaning, one unit
and one source. "Risk", "exposure", "capital" and "notional" are not synonyms here
and are never used interchangeably.

All arithmetic is exact integer arithmetic on raw units. No floats anywhere, in
the contract or the drivers. `oneCollateral` is read from
`getBinaryPoolParams()` per pool and never hardcoded (tUSDC is 6dp on testnet,
USDso is 18dp on mainnet — a hardcoded scale misprices everything on mainnet with
no revert).

---

## 1. The six quantities

### `freeCollateral` — collateral units
Collateral sitting unencumbered in the portfolio.

```solidity
freeCollateral = IERC20(collateralToken).balanceOf(portfolio)
```

Measured. Source: the token.

### `reservedCollateral` — collateral units
Collateral escrowed behind orders the portfolio believes are still resting.

Tracked in storage, incremented when an order is placed and decremented on
reconciliation and release. It is the one quantity that is tracked rather than
measured, because escrow inside the order book is not separately readable. It can
**over**-state (see §5) and never under-states.

### `committedCapital` — collateral units
Collateral that is no longer free: escrowed behind resting orders, or spent
acquiring positions.

```solidity
committedCapital = capitalBase - freeCollateral
```

Derived from a measurement, and self-healing. Escrow leaving the wallet for a
resting order, collateral spent on a fill, a cancel returning escrow and a
redemption returning collateral all move the token balance, so all four are
reflected without any bookkeeping. `capitalBase` is set by the owner via
`syncCapitalBase` and reduced on withdrawal.

### `marketDirectionalExposure` — contract units, signed
Net outcome exposure of **one** market.

```
netYes = balanceOf(YES) + openBuyYes - openSellYes
netNo  = balanceOf(NO)  + openBuyNo  - openSellNo
marketDirectionalExposure = netYes - netNo
```

Realized legs are measured from the ERC-6909 singleton; only unfilled reservations
come from storage.

**The TAPE result, reproduced independently:** within one binary market a matched
YES+NO pair is a complete set, worth exactly one collateral unit at settlement
regardless of outcome. It therefore carries **zero directional outcome exposure**,
and directional state derives from the YES/NO **imbalance**. The subtraction above
is that result; a complete set nets to zero by construction. Confirmed against the
sibling study's reconstruction of 20,000 live fills with zero conservation
failures.

A settled market returns 0: its position is a fixed claim, not a bet.

### `domainRiskUsage` — contract units, unsigned
Risk consumed in one structural domain.

```
domainRiskUsage(d) = Σ over tracked markets m in d of |marketDirectionalExposure(m)|
```

**Absolute values, summed. Never netted across markets.** Two markets in one
cadence domain are different questions resolving at different times against
different reference prices — and the domain does not even establish that they share
an underlying (`STRUCTURAL_DOMAINS.md` §3). Netting them would understate risk.
Summing absolutes can only overstate, which is the safe direction.

The brief's instruction is followed literally: exposure is **not** netted across
unrelated markets merely because they share a structural domain. No netting
relation is claimed beyond the within-market complete-set identity above, which is
exact.

### `globalRiskUsage` — contract units, unsigned
The sum of `domainRiskUsage` over a caller-supplied set of domains.

Reporting only. It is **not** an enforced ceiling, because a single directional
number summed across a 60-second domain and a 24-hour domain has no economic
meaning. Portfolio-wide enforcement is on capital (`maxCommittedCapital`,
`maxReservedCollateral`), which *is* additive and *is* meaningful.

---

## 2. What is deliberately absent

**Gross notional / turnover** is not tracked and is not a ceiling. A portfolio that
buys and sells the same contract a hundred times has large turnover and zero
directional exposure. Using turnover as a risk limit would be a category error, so
the word does not appear in the policy struct.

**Maximum loss** is not enforced as a ceiling, but it is the quantity the enforced
ones approximate, and stating the relation is what keeps them honest. For a market
holding `y` YES and `n` NO acquired for net collateral cost `Ct`:

```
worst-case payout = min(y, n)          (exactly the complete-set component)
maximumLoss       = Ct - min(y, n)
```

For a buy-only strategy this is bounded above by the collateral committed to that
market — which is why `committedCapital` is a safe proxy and
`marketDirectionalExposure` is the sharper one.

---

## 3. Why exposure is measured, not accumulated

This is the correction the previous spike found, preserved and extended.

`getOrder` reverts `IncorrectOrder()` **identically** for a filled and a cancelled
order. A running exposure counter must know which happened — a filled order keeps
its exposure, a cancelled one returns it — and the pool cannot answer after the
fact. With several agents, and maker fills landing in transactions the portfolio
never executes, the ambiguity is unresolvable.

Reading the balance dissolves it. If it filled, `balanceOf` already moved. If it
was cancelled, it did not.

**The split:**

| State | Where it lives | Why |
|---|---|---|
| Realized YES/NO positions | ERC-6909 singleton | cannot drift; it is the asset |
| Unfilled reservations | contract storage | the portfolio created them and knows them unambiguously |
| Structural facts (pool, generation, domain) | contract storage, pinned at first touch | re-verified against the registry every execution |
| Committed capital | derived from the token balance | self-healing |

Nothing that can be read is mirrored. Nothing that is stored can be reconstructed
from balances.

---

## 4. Per-agent attribution

`agentCommitted[agent]` tracks each agent's share of committed collateral, charged
at reservation and refunded by the unspent remainder after placement. Ceilings
ladder **agent → domain → portfolio**, and the tightest binds.

Attribution of **realized positions** to individual agents is deliberately not
attempted and is labelled `UNKNOWN`. Once two agents have bought YES in the same
market the tokens are fungible and the portfolio holds one balance; claiming to
know whose contracts those are would be fiction. Per-agent numbers describe capital
deployed, not position ownership.

---

## 5. Directional bias of every approximation

Every inexactness in this system points the same way: toward overstating risk.
Listed so conservatism is never mistaken for precision.

| Approximation | Direction | Why |
|---|---|---|
| Gross (not netted) domain aggregation | overstates | different resolution times, possibly different underlyings |
| `reservedCollateral` after a silent maker fill | overstates | escrow becomes a position in a transaction the portfolio never sees; the stale reservation stays until `releaseOrder` |
| Worst-case up-front reservation | overstates until reconciliation | the full quantity is reserved as though it fills completely |
| A settled market's position | excluded from directional risk | correct: it is a fixed claim, and the collateral is still counted in `committedCapital` until redeemed |

Proven adversarially in `test_R7_externalFillCannotUnderstateRisk`: an external
party fills the portfolio's resting bid in a transaction the portfolio never sees.
Measured domain usage goes **20 → 40 contracts** (reservation plus realized
position, conservatively double-counted), then converges to the true 20 once
`releaseOrder` is called. It never dips below the truth.
