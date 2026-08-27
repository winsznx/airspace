# AIRSPACE_FINDINGS.md

Hostile feasibility spike on AIRSPACE: a portfolio-level execution and risk
control plane for several heterogeneous DreamDEX Event Contract agents sharing
one capital base.

Everything here was verified against the live Somnia Shannon deployment
(chainId 50312) on 2026-08-27, or against deployed bytecode. Claims taken from
documentation are labelled.

The FLIGHTPATH spike files are retained unchanged for auditability; where this
document supersedes them it says so.

---

## 1. What carried over, re-verified

| Fact | Status |
|---|---|
| `placeBinaryOrderFor` reverts `OnlyApprovedContracts()` for every EOA caller, including self-for | confirmed |
| `BinaryPool` has no operator registry and no manual vault mode | confirmed (selectors absent from impl bytecode) |
| A contract can call `placeBinaryOrder`; escrow and fills settle to it | confirmed by live execution |
| Outcome identity is `(pool, marketNonce)`, not `marketId` | confirmed |
| Pools are recycled aggressively | confirmed -- the sibling TAPE study found one pool serving **52 distinct markets across both BTC and ETH** |
| Indexer market status is unreliable | confirmed |

Custody-by-account remains the only structural boundary available on this venue.
That part of FLIGHTPATH was right and is reused.

---

## 2. New: `placeBinaryOrder` return data is readable by a contract

The FLIGHTPATH spike noted that an EOA cannot read a transaction's return data.
AIRSPACE is a contract, so it can:

```solidity
(bool ok, uint128 id) = IBinaryPool(pool).placeBinaryOrder(...);
```

The order id is captured and used as the reservation key. The return does **not**
report the fill, so the fill is measured separately (§4).

## 3. New: `getOrder` is the reservation oracle

`IOrderBook.getOrder(uint128)` returns the live order or reverts
`IncorrectOrder()` for any id the pool has no **active** order for -- unknown,
filled, cancelled, or reduced away.

This is what makes reservation release safe and permissionless: the pool supplies
the number, the caller supplies nothing. It is also the reason exposure must be
measured rather than accumulated -- the revert is *identical* for a filled and a
cancelled order, so a running total cannot tell them apart. See §5.

## 4. New: actual fill is exactly derivable, in-transaction

No fabrication and no estimation:

```
filled     = ERC-6909 balance delta across the placement call     (MEASURED)
resting    = getOrder(orderId).quantityRemaining                  (MEASURED)
cancelled  = quantity - filled - resting                          (DERIVED)
collOut    = collateral balance delta                             (MEASURED)
filledCost = collOut - reserveFor(price, resting)                 (DERIVED, exact)
```

`filledCost` is exact because the resting remainder escrows at *our own* limit
price, which we know. This matters: a taker is charged the **resting** price, not
its own limit. In the FLIGHTPATH live run a limit of 985,000 filled at an average
of 960,000. Any receipt printing the limit as "the fill" would be lying.

## 5. New: a non-crossing IOC reverts rather than resting

`BinaryPool` raises `ImmediateOrCancelNoFill()` (selector `0xd48c4403`) when an
IOC crosses nothing, so the whole transaction unwinds. A reservation can never be
stranded by a dead IOC. Found by a failing test, not by reading docs.

## 6. The fatal gate: risk-bucket identity

Full treatment in `RISK_IDENTITY.md`. Summary:

- **The link exists on-chain, in creation events.** A single rollover
  transaction (`0x00d40a68…`, block 472715820) creates a BTC and an ETH market
  together. The MarketCreator event `0x2aba9c41…` carries `seriesId` and
  `marketId` as indexed topics; the module's creation event `0xb5ec75cd…`
  embeds the asset string itself (`0x425443` = "BTC", `0x455448` = "ETH").
- **A contract cannot read it.** The EVM gives no access to historical logs.
- **No view exposes it.** Every `PUSH4` in both deployed MarketCreators (27,427
  and 8,570 bytes) and the module implementation (31,419 bytes) was extracted
  and called against live state -- 304 selector probes. No reverse map exists.
  One plausible-looking hit (`0x88ec7934`) returns markets belonging to a
  *different* creator and is a coincidence.
- **Structural identification fails.** Sibling series share creator, collateral,
  cadence *and* expiry, and are minted in the same transaction. Pool address
  carries no asset information.

**Conclusion:** bucket membership is `OWNER_ATTESTED`, default-deny, with every
structural property (creator, collateral, cadence, pool, generation) pinned at
admission and re-verified at execution. It is never called trustless. The cost
is one admission transaction per market, which is the design's biggest unsolved
operational problem on 60-second series.

## 7. Reactivity, re-verified rather than assumed

`@somnia-chain/reactivity@0.2.1`, read from shipped source today:

- Precompile at `0x…0100`. It has **no bytecode** by design, so `eth_getCode`
  returns `0x` and presence cannot be probed that way.
- Handler interface is `onEvent(address,bytes32[],bytes)`, selector `0x53edf33d`.
- Subscription constraints: `gasLimit` in `(0, 200_000_000]`; a non-zero
  `maxFeePerGas` must sit at least 6 gwei above `priorityFeePerGas`.
- **The 32 SOMI/STT minimum is still present.** The instruction was not to assume
  it, so: it is a live check in v0.2.1 source --
  `if (await this.viem.getBalance() < parseEther("32")) return new Error("Owner
  balance must be at least 32 SOMI to create a subscription")`. It is a
  **client-side** check in the SDK; I could not confirm whether the precompile
  enforces it on-chain, because the spike's OWNER holds 29.17 STT (below the
  floor) and a `subscribe` simulation with a placeholder handler reverts for
  unrelated reasons. Recorded as unresolved rather than guessed.
- Vane's deployed factory contains the `onEvent` selector, which is independent
  evidence the path works in production on Shannon.

**Where it would help AIRSPACE** -- all liveness, never safety:
market expiry and finalization, releasing settled exposure, cleaning stale
reservations, redemption readiness, and refreshing portfolio headroom without an
owner in the loop.

**Deliberately not built, and the design does not depend on it.** Every release
path (`releaseOrder`, `releaseSettled`) is already permissionless and provable,
so anyone -- a keeper, an agent, a cron -- can drive it, and if nothing ever
fires the only consequence is that headroom stays conservatively occupied until
someone calls. Reactivity would automate the caller. It can improve liveness; it
can never be load-bearing for safety.

## 8. Architecture selected

One `AirspaceAccount` holds all capital and authorises N agent keys. Parent /
child and coordinator designs were rejected because a contract that does not
*hold* capital cannot *withhold* it -- enforcement would depend on children
volunteering to consult a coordinator. Full comparison in
`AUTHORITY_MODEL_V2.md` §1.

## 9. Live proof

Full log: `evidence/airspace/live-run.json`.

```
factory     0xdcf7b2401ee319e40205845c4908992621c52ce6
portfolio   0xa0d34Dd309Cd061707300A1aa9be2a3Febd0a577
OWNER       0x4Bd0bf9821F23f822eb44B1F095594e2BbBC06Bc
AGENT_A     0x551051f987b011329F29E8c069D8cb6ff2C2b084
AGENT_B     0x78D4bdCbAAb1b9c05c9c3c23C6C39fd34064D4cE
AGENT_C     0xe9685258CF6dcb54aBDDC1550A0fa23703527C20
```

Bucket `keccak256("BTC")`, ceiling **500 contracts**, across two cadences:
market `0x…a8cd` (86400s) and `0x…b1dd` (3600s).

| Step | Result |
|---|---|
| A reserves 180 | success, bucket gross 180 |
| B reserves 240 on a different cadence | success, bucket gross 420 |
| **C proposes 150 — valid under C's own policy** | **`BucketDirectionalExceeded`**, C committed 0 |
| Owner cancels A's order, C calls `releaseOrder` | bucket gross 240 |
| **C retries the same shape** | **success**, bucket gross 390 |
| Owner recovers with all three agents revoked | 6,000 tUSDC out, residual 0 |

Eleven live negative proofs against a hostile C: alternate pool, stale
generation, price grief, direct withdrawal, outcome withdrawal, `ownerCall`
escalation, rewriting another agent's policy, widening the bucket ceiling,
admitting a market into another bucket, releasing another agent's live
reservation, and replay. All refused.

**18/18 fork tests** at a pinned block (`evidence/airspace/fork-tests.txt`).

Both A and B were **unfilled resting orders**, so the rejection of C is proof
that reservations occupy the envelope before they fill -- the property that stops
several agents from building hidden aggregate overexposure.

## 10. Gas

Measured on the live run: `execute` 2.7-3.4M gas with two admitted markets in the
bucket; `releaseOrder` 70k. At Shannon's 6 gwei that is roughly 0.02 STT per
execution. `bucketGross` is O(markets in bucket), capped at 32, so cost is
bounded but a full bucket will be materially more expensive than measured.
