# RISK_IDENTITY.md

**The fatal gate.** AIRSPACE claims to cap "aggregate BTC exposure". That claim is
only as honest as the answer to one question: given a `marketId`, can anything
prove which underlying asset it belongs to?

This is a deeper search than the FLIGHTPATH spike ran, and it changed the answer
in one direction and confirmed it in another.

---

## 1. What the previous spike established

- `module.markets(marketId)` returns no asset.
- `BinaryMarket` exposes no `asset()`, `question()`, `strike()` or `seriesId()` --
  all revert.
- `MarketCreator.seriesById(uint32)` **does** return the asset string on-chain.
- `oracleQuestionId` is not a series identifier.
- Sibling series share collateral, cadence and expiry.

The open question was whether a reverse map `marketId -> seriesId` exists anywhere.

---

## 2. New finding: the link is emitted at creation

It does exist, in event logs, and it is unambiguous.

Creation transaction `0x00d40a68ac552fd41d1c3f72750205b7369e7901097ea3eac058eb064b8859b1`
(block 472715820) creates **two markets in one transaction** -- a BTC market and
an ETH market of the same 60-second cadence. Two independent links appear:

**(a) MarketCreator event `0x2aba9c41…`** carries series and market as indexed topics:

```
log 19  emitter 0xee3aff92…(MarketCreator)
  topic0 0x2aba9c4149d9b680f88b57880776a6aa9755ec19e418a1e64831b44c43cb7a1b
  topic1 0x…0003   <- seriesId 3
  topic2 0x…b225   <- marketId 0xb225
  topic3 0xc6d04c86…  questionKey

log 39  same event
  topic1 0x…0004   <- seriesId 4
  topic2 0x…b226   <- marketId 0xb226
```

**(b) The module's creation event `0xb5ec75cd…`** embeds the asset string directly,
with `marketId` as topic1:

```
log 17  topic1 0x…b225        data[17] = 3         data[18] = 0x425443 = "BTC"
log 37  topic1 0x…b226        data[17] = 3         data[18] = 0x455448 = "ETH"
```

So `marketId -> asset` is fully determined by on-chain data, immutably, at
creation. This is where the indexer's `Market.asset` comes from.

---

## 3. But a contract cannot read it

The EVM gives contracts no access to historical logs. `seriesById` is callable,
but there is no on-chain path from a `marketId` to the `seriesId` it needs.

I did not stop at documented getters. Both deployed MarketCreators and the
module implementation were enumerated by extracting every `PUSH4` from their
runtime bytecode and calling each candidate against live state:

| Contract | Bytes | Selectors probed | Reverse map found |
|---|---|---|---|
| MarketCreator `0x94D963B6…` (venue `0x679795a0`) | 27,427 | 81 | none |
| MarketCreator `0xee3aff92…` (venue `0x1a1e6821`) | 8,570 | 52 | none |
| BinaryMarketsModule impl `0xdf87ac5c…` | 31,419 | 171 | none |

Every candidate taking a `bytes32` was called with a real `marketId` and every
candidate taking a small integer with a real `seriesId`. No selector returned a
string, and none returned a series id for a market id.

One false positive is worth recording so nobody repeats it: `0x88ec7934` on
`0x94D963B6…` returns plausible-looking `marketId`s for small integer inputs.
It is not a series map -- the markets it returns belong to a *different*
creator, checked against `module.markets(...).creator`. Selector brute-forcing
produces coincidences; every hit has to be cross-validated.

The two creators are also different implementations with different surfaces
(`0xee3aff92…` does not even have `latestExpiryBySeriesId`), so there is no
single MarketCreator ABI to rely on.

---

## 4. Why the gap cannot be closed structurally

The obvious fallback is to identify a series by what *is* on-chain: creator,
collateral, cadence, expiry. Live enumeration of the production MarketCreator
`0x94D963B6…` shows why that fails:

| seriesId | asset | intervalSec | latestExpiry |
|---|---|---|---|
| 1 | BTC | 900 | 1787842800 |
| 2 | ETH | 900 | **1787842800** |
| 3 | BTC | 3600 | 1787842800 |
| 4 | ETH | 3600 | **1787842800** |
| 7 | BTC | 86400 | 1787875200 |
| 8 | ETH | 86400 | **1787875200** |

Sibling series are identical on every field a contract can read. Worse, the
sibling markets are minted **in the same transaction**, so even block or
ordering heuristics do not separate them.

Nor does the pool: the sibling TAPE study found one pool that served **52
distinct markets spanning both BTC and ETH**. Pool address carries no asset
information whatsoever.

---

## 5. The options, scored

| | Trust | UX | Latency | Gas | Failure mode | Rolling markets |
|---|---|---|---|---|---|---|
| **A. Direct on-chain derivation** | none | perfect | none | low | — | — |
| **B. Permissionless registry from creation events** | none *in principle* | good | one tx per market | medium | — | yes |
| **C. Owner-approved exact membership** | owner only | poor at speed | one tx per market | low | **deny** | poor below 1h |
| **D. Signed catalogue (delegated attester)** | attester | good | signature | low | mis-bucket | yes |
| **E. Merkle-root catalogue per rollover** | attester | good | one root per roll | low | mis-bucket | yes |
| **F. No trustworthy solution** | — | — | — | — | — | — |

**A is unavailable.** Proven above.

**B is unavailable in practice.** A registry can only be permissionless if the
submission can be *verified*, and verification requires reading the creation log
-- which is exactly what contracts cannot do. Without a log-proof primitive
(receipt proofs, a ZK light client) "permissionless" collapses into "anyone can
assert anything", which is strictly worse than C. Recording this as unavailable
rather than as an option is the honest call.

**C is what AIRSPACE ships.** Reasons below.

**D and E are the scaling answer** and are designed but not built.

---

## 6. Why owner attestation is sound here, and where it is not

The adversary in this threat model is a **compromised agent**, not the owner.
The owner is the party being protected. An owner-attested bucket therefore
introduces no trust the owner does not already place in themselves: an agent
cannot forge it, and an owner who mis-labels a market harms only their own
portfolio.

Three properties keep it honest rather than hand-wavy:

1. **Default deny.** `admitMarket` is the only way a market becomes tradable.
   An unadmitted market reverts `MarketNotAdmitted`. A missing catalogue entry
   blocks trading; it never silently hides risk. The safety failure mode is
   "trade rejected", never "exposure uncounted".
2. **Structural cross-checks.** Admission pins `creator`, `collateral`,
   `intervalSec`, `pool` and `marketNonce` from the module registry, and
   `execute` re-verifies every one of them. A wrong or stale attestation cannot
   redirect capital to a different market -- it can only mis-label a market that
   is otherwise fully verified.
3. **Publicly falsifiable.** Anyone can check an owner's bucket assignment
   against the creation events in §2. The attestation is auditable even though
   it is not machine-verifiable on-chain.

**Where it is not sound:** if AIRSPACE were ever operated as a service where a
*third party* attested buckets on a user's behalf, the attester would become
able to mis-bucket a user's risk. That is a materially different trust model and
must not be shipped under the same claim.

---

## 7. The honest label, and the cost

Throughout the receipt and the docs, risk-bucket membership is labelled
**`OWNER_ATTESTED`**. It is never called trustless, and "aggregate BTC exposure"
is precise only to the extent the owner's catalogue is correct.

The cost of choosing C is operational and it is real: **one admission
transaction per market**. On daily and hourly series that is 1-24 admissions per
day and entirely workable. On the 60-second series that dominate Shannon
activity it is 1,440 per series per day, which is not. This is the single
biggest unsolved problem in the design and it is called out in `VERDICT_V2.md`
rather than buried here.

There is a fully-trustless alternative that trades precision for automation, and
it deserves to be built before D/E: a **structural bucket** keyed on
`(creator, collateral, intervalSec)` -- all on-chain, all verified at execution,
no attestation at all. It cannot separate BTC from ETH, so the bucket becomes
"either underlying at this cadence from this creator". A ceiling on that is a
weaker but still genuine portfolio control, and it needs no admission step, so
it works on rolling markets. AIRSPACE's enforcement core is agnostic to how a
bucket is defined, so this is an addition rather than a rewrite.
