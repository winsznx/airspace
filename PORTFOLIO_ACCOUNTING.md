# PORTFOLIO_ACCOUNTING.md

The economic state AIRSPACE reasons about, and the four quantities that must
never be conflated. All arithmetic is exact integer arithmetic on raw units --
no floats anywhere, in the contract or the drivers.

Units: collateral is raw token units (tUSDC 6dp on testnet, USDso 18dp on
mainnet; `oneCollateral` is read from `getBinaryPoolParams()` and never
hardcoded). Outcome quantities are contract units, where `1e6` is one contract
on a 6-decimal venue.

---

## 1. The four quantities

These are distinct measurements. Calling one of them another is the most common
way risk systems lie.

### COMMITTED CAPITAL
Collateral that is no longer free: escrowed behind resting orders, or spent
acquiring positions.

```
committedCollateral = capitalBase - freeBalance
```

`capitalBase` is declared by the owner via `syncCapitalBase`; `freeBalance` is
`IERC20.balanceOf(portfolio)`. This is exact and self-healing. Escrow leaving
the wallet for a resting order, collateral spent on a fill, a cancel returning
escrow, and a redemption returning collateral are all reflected automatically,
because every one of them moves the token balance.

Unit: collateral. **Not** a risk measure -- it says how much capital is in play,
not how much can be lost.

### DIRECTIONAL RISK
Net outcome exposure of a market, in contract units.

```
netYes = balanceOf(YES) + openBuyYes - openSellYes
netNo  = balanceOf(NO)  + openBuyNo  - openSellNo
directional(market) = netYes - netNo
```

A matched YES+NO pair is a complete set worth exactly one collateral unit at
settlement regardless of outcome, so it carries **zero** outcome risk and
correctly nets to zero here. This is the TAPE rule, reproduced independently and
confirmed against the sibling study's 20,000-fill reconstruction.

Unit: contracts. Signed.

### MAXIMUM LOSS
Worst-case collateral loss if every unresolved position resolves against the
portfolio.

For a market where the portfolio holds `y` YES and `n` NO acquired for net
collateral cost `C`: payout is `y` if YES wins and `n` if NO wins, so the
worst-case payout is `min(y, n)` -- exactly the complete-set component.

```
maxLoss(market) = C - min(y, n)
```

For a buy-only strategy this is bounded above by the collateral committed to
that market, which is why COMMITTED CAPITAL is a safe (conservative) proxy and
DIRECTIONAL RISK is the sharper one.

Unit: collateral.

### GROSS NOTIONAL
Turnover: the sum of `|q| x price` over every fill. Useful for fee and activity
analysis; it says nothing about risk. A portfolio that buys and sells the same
contract a hundred times has large gross notional and zero directional risk.

Unit: collateral. **Never** used as a ceiling in AIRSPACE.

---

## 2. Why exposure is measured, not accumulated

The first implementation kept running totals. It was wrong, and the fork tests
caught it.

When an order dies, `getOrder` reverts `IncorrectOrder()` identically whether it
**filled** or was **cancelled**. A running total has to know which -- a filled
order keeps its exposure, a cancelled one gives it back -- and the pool cannot
tell you after the fact. With several agents trading, and maker fills landing in
transactions AIRSPACE never sees, that ambiguity is unresolvable.

Reading the balance dissolves it. If the order filled, `balanceOf` already moved;
if it was cancelled, it did not. Storage tracks **only unfilled reservations**,
which are unambiguous because AIRSPACE created every one of them itself.

```solidity
function directionalOf(bytes32 marketId) public view returns (int128) {
    int256 yes = int256(balanceOf(this, yesId)) + r.yesLong - r.yesShort;
    int256 no  = int256(balanceOf(this, noId))  + r.noLong  - r.noShort;
    return int128(yes - no);
}
```

The accounting cannot drift away from the chain, because the chain is where it
is read from.

---

## 3. Bucket aggregation is gross, not netted

```
bucketGross(b) = Σ over admitted markets m in b of |directional(m)|
```

Absolute values, summed. Being long BTC in the 15-minute window and short BTC in
the daily window is **not** risk-free: they resolve at different times against
different reference prices. Netting them across markets would understate risk.
Summing absolutes can only ever overstate, which is the correct direction for a
ceiling.

Within a single market YES and NO *do* net, because there the complete set is a
genuine hedge.

---

## 4. The reservation lifecycle

```
PROPOSED  -> RESERVED -> PLACED -> { FILLED | RESTING | CANCELLED }
                                       |         |
                                       |         +-> RESOLVED/VOIDED -> REDEEMED
                                       +-> RESOLVED/VOIDED -> REDEEMED
```

**The invariant that makes multi-agent resting orders safe:**

```
reserved(before placement) == filled + resting + cancelled
```

The full potential exposure is reserved *before* any capital moves. After
placement the order splits into a filled part and a resting part, and those sum
to exactly what was reserved. So the ceiling that admitted the order continues to
hold afterwards -- and N agents' resting orders that all later fill cannot
collectively exceed a limit that admitted them, because the limit already counted
them at full size.

Only `cancelled` releases headroom, because only `cancelled` can never become a
position.

### How each quantity is obtained

| Quantity | How | Label |
|---|---|---|
| `filled` | `balanceOf` delta across the placement call | **MEASURED** |
| `resting` | `getOrder(orderId).quantityRemaining` | **MEASURED** |
| `cancelled` | `quantity - filled - resting` | DERIVED |
| collateral out | `balanceOf` delta on the collateral token | **MEASURED** |
| `filledCost` | `collateralOut - restingEscrow` | DERIVED, exact |

`filledCost` is exact rather than estimated. The resting remainder escrows at
*our own* limit price, which we know, so subtracting it from the measured
collateral outflow leaves precisely what the fill cost. This matters because a
taker is charged the **resting** price, not its own limit: in the FLIGHTPATH
live run a limit of 985,000 filled at an average of 960,000. Reporting the limit
price as the fill price would have been a lie.

### What `placeBinaryOrder` returns to a contract

An EOA cannot read a transaction's return data, but AIRSPACE is a contract and
can. The signature returns `(bool success, uint128 id)`, and the id is captured
and used as the order key. It does **not** report the fill, which is why the
balance-delta measurement above exists.

### Release

`releaseOrder(key)` is permissionless and cannot be forged. It reads
`getOrder` and can only move the books toward what the pool reports; if the
order is still resting the call reverts `OrderStillLive`. A recycled pool
(`marketNonce` changed) means the market is over, so the reservation is released
in full. Fill-versus-cancel is irrelevant here for exactly the reason in §2.

`releaseSettled(marketId)` is permissionless and provable: it only succeeds once
`isResolved()` or `isVoided()` is true on-chain. Positions become claimable
collateral at that point and stop being directional risk.

---

## 5. Per-agent attribution

`agentCommitted[agent]` tracks each agent's share of committed collateral,
charged at reservation and refunded by the unspent remainder after placement.
It ladders: **agent -> bucket -> portfolio**, and the tightest ceiling binds.

Attribution is intentionally *not* attempted for realized positions. Once two
agents have bought YES in the same market the tokens are fungible and the
portfolio holds one balance; claiming to know whose 30 contracts those are would
be fiction. Per-agent numbers describe capital deployed, not position ownership.

---

## 6. Known conservatism and its direction

Every approximation in this system is deliberately biased toward over-counting
risk. Listed so nobody mistakes conservatism for precision:

- **`totalResting` can over-count.** If a resting order is filled by an incoming
  taker, that happens in a transaction AIRSPACE never executes, so the tracked
  escrow stays until someone calls `releaseOrder`. The escrow is then counted as
  resting when it has actually become a position. `committedCollateral` is
  unaffected (it is measured), so only the `maxRestingReservation` ceiling is
  affected, and only by being too strict.
- **Gross bucket aggregation over-counts** genuinely offsetting positions across
  windows, as designed (§3).
- **`maxLoss` is not enforced as a ceiling** -- only committed capital and
  directional exposure are. `maxLoss` is defined here because it is the quantity
  the others approximate, and stating the relationship is what keeps the other
  two honest.
- **A market with `directional == 0` still counts as live** only if it holds
  reservations or balances; `livePositions` recomputes from measurement each
  call rather than from a counter.
