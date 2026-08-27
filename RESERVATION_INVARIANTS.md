# RESERVATION_INVARIANTS.md

The reservation state machine, the invariants that make a shared capital pool safe
across mutually distrusting agents, and the proof for each.

---

## 1. State machine

```
PROPOSED     agent calls execute()
   |
   +-- rejected -> no state change at all (verified: agentCommitted unchanged)
   |
RESERVED     worst-case capacity committed to storage, BEFORE any value moves
   |
PLACED       placeBinaryOrder() returns (success, orderId)
   |
   +--> FILLED       measured: ERC-6909 balance delta == quantity
   +--> PARTIAL      measured: 0 < balance delta < quantity
   +--> RESTING      measured: getOrder().quantityRemaining > 0
   +--> CANCELLED    quantity - filled - resting  (an IOC remainder)
          |
RESTING ---+--> CANCELLED   owner cancelOrder, then permissionless releaseOrder
           +--> EXPIRED     ages off the book; releaseOrder releases it
           +--> FILLED      externally, in a transaction the portfolio never sees
                              |
FINALIZED / VOIDED   market terminal on-chain; releaseSettled
   |
REDEEMED     owner redeems; collateral returns to freeCollateral
```

Every transition out of RESERVED is driven by a value the **chain** supplies
(`balanceOf`, `getOrder`, `marketNonce`, `isResolved`/`isVoided`). No caller ever
supplies a quantity.

---

## 2. The core invariant

> **`reserved(at admission) == filled + resting + cancelled`**

The full quantity is reserved up front, as though the order fills completely. After
placement it partitions into exactly three parts, and `filled + resting` continue to
occupy precisely what was reserved. The ceiling that admitted the order therefore
keeps holding afterwards.

Only `cancelled` releases capacity, because only `cancelled` can never become a
position.

This is what makes several agents' resting orders safe: three agents each holding an
unfilled order that would breach the ceiling **if all filled** cannot exist, because
the ceiling already counted all three at full size the moment they were admitted.

---

## 3. Required proofs

### An admitted order reserves worst-case capacity BEFORE value can move
`_reserve()` writes the reservation and checks every ceiling; `_place()` runs after
it, in the same call. There is no path that places without reserving.

`test_R1_worstCaseReservedBeforeValueMoves` — a POST_ONLY order that cannot fill
still consumes full capacity: domain usage +100 contracts, ERC-6909 balance 0.

### Multiple agents cannot race through the same remaining headroom
Reservation and placement are one call, so admission and the value transfer it
authorises cannot be separated. EVM transactions are serialised: the first to land
reserves, the second reads the updated state and reverts. There is no
read-before-write window and no off-chain mutex.

- `test_X2_twoAgentsRaceOneHeadroom_sameBlock` — cap 200, two agents at 150,
  `block.number` asserted unchanged across both attempts, exactly one reserves.
- `test_X3_threeAgentsRace` — one winner of three.
- `test_X3b_tenAgentsRace` — cap 250, ten agents at 100, exactly two admitted, all
  in one block.
- **Live**: A and B submitted concurrently; B's transaction was broadcast before
  A's outcome was known and **reverted on-chain**
  (`0x6fe4204c…`, status reverted).

### Partial fills do not double-count reservation + position
On reconciliation the reservation is reduced by `gone = quantity - resting`. The
realized part needs no bookkeeping — it is now visible in the token balance — so it
is counted exactly once.

`test_R2_partialOrFullFillDoesNotDoubleCount` — the domain delta never exceeds the
reserved quantity.

### Cancellations release only the amount actually freed
`releaseOrder` releases `qtyOpen - stillOpen`, where `stillOpen` comes from
`getOrder`. Collateral is released pro rata.

`test_R3_cancelReleasesOnlyWhatWasFreed` — A rests 100, B rests 40; cancelling A's
order releases exactly 100 and leaves B's 40 untouched.

### Fills unknown to the initiating transaction cannot understate risk
The adversarial case. `test_R7_externalFillCannotUnderstateRisk`: the portfolio
rests a top-of-book bid; an unrelated account mints a complete set and sells into
it, filling the portfolio in a transaction the portfolio never executes.

```
usage before external fill : 20 contracts   (reservation only)
usage after  external fill : 40 contracts   (stale reservation + realized position)
after releaseOrder         : 20 contracts   (converges to truth)
```

Risk is **overstated, never understated**, and reconciliation converges. This is the
safe direction, and it is the direct consequence of measuring positions from
balances rather than trusting a counter.

### Expired resting orders eventually release safely
On-chain expiry is lazy — an expired maker keeps resting with no event — so an
expired order stays reserved (overstating) until someone calls `releaseOrder`.
`releaseOrder` is permissionless, so any keeper, any agent, or the owner can drive
it. If the pool has been recycled onto a later market (`marketNonce` changed) the
reservation is released in full, because that market is over.

### Resolution / void / redemption never create phantom headroom
- `releaseSettled` succeeds only when `isResolved()` or `isVoided()` is true
  on-chain. It cannot be called early (`MarketNotSettled`).
- It zeroes reservations and marks the market settled, so it contributes 0 to
  directional risk — correct, because a settled position is a fixed claim, not a bet.
- The collateral behind it is still counted in `committedCapital` (measured from
  the token balance) until redemption actually returns it.
- `pruneMarket` refuses unless the market carries no reservations **and** no
  balance, or is settled (`MarketStillActive`).
  `test_R5_pruneRefusedWhileMarketCarriesState`.

---

## 4. Release is permissionless but not discretionary

`releaseOrder` and `releaseSettled` are callable by anyone. That is safe because
neither is a judgement call: each reads authoritative state and can only move the
books toward it. The caller supplies no numbers.

An agent cannot use release to free headroom for itself — the order must actually be
dead first:

- `test_R4_releaseRefusedWhileOrderIsLive` — attacker and a rival agent both refused
  with `OrderStillLive`.
- **Live**: agent C attempted to release agent A's live reservation and was refused
  with `OrderStillLive`.
- `test_H12_agentCannotConsumeHeadroomReleasedInTheSameBlock` — C cannot pre-empt a
  release that has not happened. Once a genuine release lands, whoever calls first
  gets the headroom, which is correct behaviour rather than a vulnerability.

Order keys are `keccak256(pool, marketNonce, orderId)`. Order ids are per-pool and
pools are recycled, so the generation is bound into the key — a stale id cannot
collide with a live order at the same address.

---

## 5. Storage that is tracked, and why it cannot be reconstructed

| Stored | Could it be read from balances instead? |
|---|---|
| open reservations per market and side | **No.** Escrow inside the order book is not attributable to the portfolio per side. |
| order records (agent, generation, escrow) | **No.** `getOrder` gives remaining quantity but not the portfolio's own accounting. |
| pinned pool + generation per market | **No.** After a recycle the registry reports the *current* generation, not the one traded. |
| `agentCommitted` | **No.** The token balance cannot attribute capital to an agent. |
| realized positions | **Yes** — so they are not stored. |
| committed capital | **Yes** — so it is derived, not stored. |

---

## 6. Residual, disclosed

**`reservedCollateral` over-counts after a silent maker fill** until `releaseOrder`
is called. `committedCapital` is unaffected because it is measured. The only
consequence is that the `maxReservedCollateral` ceiling is temporarily stricter
than reality. Conservative in the safe direction, and self-correcting on the next
release call.
