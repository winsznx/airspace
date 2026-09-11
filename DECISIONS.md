# Decisions

Every entry here is a choice that could reasonably have gone the other way, with
the measurement that settled it. Decisions that were never in doubt are not here.

---

## 1. The risk domain is a cadence, not an asset

**Decision.** A domain is `keccak256(creator, collateral, canonicalCadence)`,
derived on-chain from the DreamDEX registry during execution. It is never an
asset, a ticker or a name.

**Why.** The obvious design is "one ceiling per underlying" — a BTC limit and an
ETH limit. It cannot be built honestly on this venue. `marketId → asset` exists in
the market-creation events, but no view function exposes it: 304 selector probes
across both MarketCreator contracts found nothing that returns it. The only
alternative is an off-chain attestation, and an attestation is a lie waiting to
happen — the contract would enforce a limit against a label it cannot verify.

A cadence domain is derived entirely from data the contract reads itself, in the
same call that uses it. Nothing is asserted that cannot be checked.

**What it costs.** BTC and ETH 15-minute series from the same creator share one
ceiling. That is a real limitation and it is stated everywhere the domain appears,
including in the product UI. It fails in the safe direction: an agent cannot
escape a limit by switching between sibling series, which is exactly the evasion a
naive per-asset design would permit.

---

## 2. Exposure is measured, never accumulated

**Decision.** Realized exposure is read from ERC-6909 balances at evaluation time.
Only *unfilled* reservations are stored. There is no running exposure counter.

**Why.** The first implementation kept counters and updated them on every event.
Fork tests against live Shannon broke it: `getOrder` reverts with
`IncorrectOrder()` **identically** for a filled order and a cancelled one. A
counter-based design has to distinguish those to stay correct, and it cannot. It
drifts, and the drift is unbounded and silent.

Reading balances costs gas on every evaluation. It cannot drift.

**The invariant this protects.** Uncertainty may OVERSTATE portfolio usage; it may
never UNDERSTATE maximum commitment. A portfolio that overstates refuses a trade
it could have allowed. A portfolio that understates allows a trade that breaches
the limit the owner set. Only one of those is survivable.

---

## 3. Canonical cadence, not the raw trading window

**Decision.** Cadence is the smallest `C` in `[60, 300, 900, 1800, 3600, 14400,
86400]` where `C >= (expiry − tradingStart)` **and** `expiry % C == 0`. No match
means no domain, and no domain means the intent is refused.

**Why.** `expiry − tradingStart` is not the cadence. Observed live: markets in a
900-second series with an 898-second window, because the creator's roll ran two
seconds late. Keying on the raw window would put two markets of the same series in
two different domains, and the ceiling would silently double.

Both conditions are needed. The width test alone would absorb a 300s market into
the 900s domain; the modulus test alone would match a 60s market to the 86400s
bucket. Together they identified the correct series on all 1,200 live markets
sampled, including every late roll.

**What it costs.** A market whose window matches no canonical cadence has no
domain and cannot be traded. Refusing is the correct answer: an unclassifiable
market has no ceiling to enforce.

---

## 4. One evaluation path, used by both the gate and the display

**Decision.** `_evaluate()` is a single non-reverting internal view.
`execute()` calls it and reverts on its refusal code; `previewIntent()` calls it
and returns the same result. There is no second implementation anywhere — not in
the SDK, not in the API, not in the UI.

**Why.** The usual arrangement has enforcement in the contract and a re-derivation
in the client, so the UI can explain a decision before it is made. They drift.
When they drift, the interface tells the user something the contract will not
honour, and the failure is confusing precisely when the stakes are highest.

The gate display in the web app is a rendering of the contract's own bitmask.
It cannot disagree with enforcement, because there is nothing for it to disagree
with.

---

## 5. Custody by the contract, because the venue leaves no choice

**Decision.** The portfolio holds the collateral and the outcome tokens. Agents
hold keys, not funds.

**Why.** This was not a design preference. `placeBinaryOrderFor` reverts
`OnlyApprovedContracts()` for every EOA caller — measured, not assumed. A design
where agents keep custody and the portfolio only advises is not implementable on
DreamDEX. So the honest options were "contract holds funds" or "no product", and
the documentation says so rather than presenting custody as a feature.

**What it costs.** The contract is a trust boundary and is unaudited. That is
stated on the landing page and in [SECURITY.md](SECURITY.md).

---

## 6. Owner recovery reads nothing

**Decision.** `withdraw(token, to, amount)` checks ownership and nothing else. No
policy, no agent state, no market state, no keeper, no backend.

**Why.** Every other guarantee in this system is conditional on something. If
withdrawal were conditional too, a bug in a condition could strand an owner's
capital. Recovery is the one path that must work when everything else has failed,
so it depends on the one thing that cannot fail: the owner's key.

Fork test `test_F10_ownerRecoveryUnconditional` runs it with every agent revoked,
the policy expired and no keeper — against live Shannon state.

---

## 7. `IntentRefused` is unreachable, and refusals are recovered from failed transactions

**Decision.** Refusals are recorded by verifying the *failed transaction*, not by
reading an event. The API takes only a transaction hash and re-derives everything
from the chain.

**Why.** The deployed contract emits `IntentRefused` on the line before
`revert Refused(code)`:

```solidity
emit IntentRefused(ih, msg.sender, i.marketId, e.refusal);
revert Refused(e.refusal);
```

A revert discards the transaction's logs, so that event can never be observed.
It is dead code in the deployed bytecode. Found while building the indexer, after
the contract was deployed and proven.

Reverting is still right — an agent must not believe it traded. So the refusal
lives where it actually is: in the failed transaction. `POST /api/intents/report`
requires the receipt to be `reverted` and addressed to the portfolio, decodes the
calldata as `execute(Intent)`, and replays that exact call at the transaction's own
block. Only a genuine `Refused(uint8)` is recorded, so the row carries `contract`
provenance truthfully. Somnia's public RPC serves that replay; verified live.

**Proof that the verification does its job:** during the first campaign three
agents reported failed transactions as refusals. The endpoint rejected all three —
they had run out of gas, not been refused. See decision 8.

**Next version.** Drop the unreachable event. The deployed contract is the one
that carries the live proof, so it was not redeployed to remove dead code.

---

## 8. Agents pad the gas estimate, because `execute` costs what the other agents did

**Decision.** Agents estimate gas and then double it.

**Why.** Measured during the first live campaign: two transactions estimated at
~3.68M ran out of gas at 3.52M used, in consecutive blocks. `execute` walks the
domain's tracked markets to aggregate exposure, so its cost depends on shared state
that the *other* agents are changing. An estimate taken before another agent's
transaction lands can be too low by the time it executes.

This is inherent to a shared pool: cost is coupled the same way risk is. An
out-of-gas is worse than a refusal — it burns the whole limit and returns no reason
— so the estimate is padded rather than trusted, and the agent classifies a receipt
that consumed ≥95% of its limit as `out-of-gas` rather than reporting a refusal the
contract never made.

---

## 9. Post-only, and a self-widening quote offset

**Decision.** Sample agents place post-only orders and learn how far off the touch
they must quote, starting at 60 ticks and doubling on rejection.

**Why.** DreamDEX order type 3 is post-only and reverts `PostOnlyWouldCross()`
(selector `0x7cf05fcb`, identified by probing the live pool — it is in no ABI we
have). The geometry of that check is the venue's: measured live with the YES book
at 953000/974000, a buy of YES rested at 900000 but crossed at 950000, while a buy
of NO rested at 950000 and crossed at 900000. Reverse-engineering an exact rule
would encode a guess that a venue upgrade breaks silently.

`previewIntent` cannot catch this and should not try: it is venue microstructure,
not portfolio risk. The agent treats it as an ordinary outcome and quotes further
out next tick.

Sells are not proposed at all. A naked sell of outcome tokens the portfolio does
not hold returns `InsufficientBalance()` (`0xf4d678b8`) — a venue refusal that says
nothing about portfolio risk and would only add noise to the admission feed.

---

## 10. The factory takes a pre-deployed implementation

**Decision.** `AirspacePortfolioFactory`'s constructor accepts an implementation
address instead of deploying one.

**Why.** Somnia rejects a constructor that itself deploys a ~24KB contract. The
original factory burned 29.6M gas against a 30M block limit and reverted, while
`cast run` replayed the identical transaction cleanly at 5.6M. Simulation and
execution disagree on nested CREATE.

Deploying the implementation separately is one extra step in the deploy script and
removes the failure mode entirely. The constructor asserts
`implementation_.code.length != 0` so a mis-wired deployment fails immediately
rather than producing clones of nothing.

---

## 11. The contract fits in 24,576 bytes by returning less, not by computing less

**Decision.** `previewIntent` returns a slim 16-field `AdmissionView` rather than
the full internal `Evaluation`, and struct getters are the compiler's
auto-generated tuple accessors.

**Why.** The contract was 248 bytes over EIP-170. Optimizer runs of 1, 20, 50 and
100 all made it *worse*; bitmask-packing the policy structs made it worse still
(24,879). What worked was removing returned data and hand-written accessors:

| Change | Bytes |
| --- | --- |
| Auto-generated tuple getters instead of hand-written struct getters | −1,632 |
| `AdmissionView` instead of the full `Evaluation` | −2,858 |
| Dropped `_agentList`, `agentCount`, `agentAt`, `outcomeIdFor`, `orderKey`, `intentHash`, `cadenceOf` | remainder |

Final: 23,689 bytes, 887 to spare. No check was removed, and no evaluation logic
moved off-chain. The dropped externals are all derivable off-chain from data the
contract still exposes; `intentHash` and `orderKey` are mirrored in
`@airspace/protocol` and used only to look up records the contract produced.

---

## 12. Cloudflare and Supabase, no Railway and no Vercel

**Decision.** Workers, Durable Objects, Queues and Cron Triggers on Cloudflare;
Postgres with RLS on Supabase.

**Why.** One Durable Object per portfolio is the natural partition for this
product — portfolio state is exactly the unit that needs a single writer, and
partitioning that way means the system has no global mutable state to contend on
as portfolio count grows. Cron Triggers give the lifecycle and indexer workers a
schedule without a server. Queues with a dead-letter queue make reconciliation
retryable without inventing a job runner.

Supabase holds only projections. Nothing read from it can authorise an execution
decision, which is why RLS can safely expose chain-derived tables to anonymous
readers: publishing a projection of public chain data leaks nothing, and the
service-role key never leaves a Worker.

---

## 13. The indexer chunks at 1,000 blocks because both public RPCs say so

**Decision.** `INGEST_WINDOW` is a per-invocation budget; each `eth_getLogs` call
covers at most 1,000 blocks.

**Why.** Measured on both endpoints: `dream-rpc.somnia.network` answers
"block range exceeds 1000" and `rpc.ankr.com/somnia_testnet` answers "Block range
is too large" for anything wider. Shannon produces ~10 blocks per second, so a
one-minute cron must cover ~600 blocks; a 5,000-block budget gives roughly 8×
headroom to catch up after an outage. The cursor advances per chunk, so a failure
resumes from the last completed chunk rather than replaying the window.

---

## 14. Numbers cross the wire as strings and become `BigInt`, never `Number`

**Decision.** `numeric(78,0)` in Postgres, decimal strings in JSON, `bigint` in
TypeScript. `Number` is used for a protocol quantity in exactly one place: never.

**Why.** A 1e18-scale value exceeds `Number.MAX_SAFE_INTEGER` by nine orders of
magnitude. Formatting happens once, at the presentation edge, in
`apps/web/src/lib/format.ts`. Everything upstream of that file is exact.

**Where this rule was broken, and what it cost.** PostgREST serialises `numeric`
as a JSON **number**, so the rule was violated at a boundary nobody wrote code
for. DreamDEX order ids are ~21 digits:

```
on chain          239807672958224550581
as a JSON number  239807672958224560000
back to BigInt    239807672958224564224
```

The indexer wrote `IntentAdmitted` correctly, then read the order id back out of
Postgres to derive the reservation's key — and every key derived that way was
wrong. Fifty-three reservations pointed at nothing. The contract was right
throughout; only the projection was lost, which is exactly the blast radius the
architecture is supposed to keep it to.

Two fixes, because one would have been a patch rather than a repair:

1. The indexer keeps the admitted values **in memory** for the reconcile that
   follows in the same transaction. Correct values never make the round trip.
2. Every `numeric(78,0)` column is selected `::text`, so nothing large can cross
   as a float again even where a round trip is unavoidable.

The repair itself is the argument for the projection design: the reservation
rows were deleted, the cursor rewound, and the indexer rebuilt them from chain
logs. No state was reconstructed by hand, and nothing authoritative was ever at
risk.

---

## 15. One keeper key, so the lifecycle worker sequences its own nonces

**Decision.** The queue consumer reads the pending nonce once per batch and hands
it out in order, `max_concurrency = 1`, and the sequence is dropped on any send
failure.

**Why.** A queue batch delivers up to ten jobs at once. Letting each write derive
its own nonce means two jobs in one batch both read the same pending count, and
the chain rejects the second: *"Nonce provided for the transaction is lower than
the current nonce."* Measured in production — the keeper landed some releases and
lost the rest of every batch that way, while reporting them as ordinary failures.

The alternative is a keeper key per queue partition, which buys parallelism this
workload does not need: releases are not latency-sensitive, and the chain is the
bottleneck rather than the loop.

**What this is not.** The keeper has no authority. `releaseOrder`,
`releaseSettled` and `pruneMarket` are permissionless and prove their claim
against the venue, so the key needs gas and nothing else. It cannot move capital,
change a policy or trade.

---

## 16. Worst-case exposure is an interval, and it is computed twice

Version 1.0.0 collapsed each market to one netted figure:

```
(bal(YES) + yesLong − yesShort) − (bal(NO) + noLong − noShort)
```

That prices exactly one future, the one where every resting order fills at once.
It is the most NETTED reading available, not the most conservative one, and it
let a pending BUY_YES cancel a pending BUY_NO. Either can fill without the other.
Live, it reported 80 against a true worst case of 1,170, under a 500 ceiling.

The replacement tracks the reachable interval:

```
b  = bal(YES) − bal(NO)
up = b + yesLong + yesShort
dn = b − noLong  − noShort
worst = max(|up|, |dn|)
```

Two things fall out of that shape and both are deliberate. Realized YES and NO
still net, because a held complete set pays one unit whichever way the market
resolves. Pending orders never net, in either direction.

The `yesShort` term on the UPPER bound looks wrong until you know the venue: a
SELL escrows its outcome tokens at placement, so those tokens are already out of
`bal`, and cancelling the ask brings them back. We did not take that from the
mock — the mock had it wrong. Four live Shannon pools were probed, and each
pool's outcome-token balance equalled its resting ask depth exactly.

### Why it is computed twice

The v1 invariant asserted `domainRiskUsage <= CEILING`: the contract's own number
checked against itself. An understatement made it pass, which is how the defect
reached a funded deployment behind a green suite.

So the model now has a second implementation that shares no helper, no library
and no code path with the production contract, and reaches the answer a different
way — [`ExposureOracle`](contracts/test/reference/ExposureOracle.sol) enumerates
all sixteen combinations of fills instead of evaluating a closed form. The
property `accounted >= independent` is asserted in named scenarios, under
invariant fuzzing, and continuously against the live chain by
[`scripts/risk-verifier.mjs`](scripts/risk-verifier.mjs), which rebuilds
reservations from `getOrder` per order rather than reading the contract's
counters.

The same treatment was applied to the capital side rather than assuming it was
fine because the bug was elsewhere: see
[`CollateralOracle`](contracts/test/reference/CollateralOracle.sol).

---

## 17. The ceiling is an admission control, not a hard cap

AIRSPACE guarantees that it never ADMITS an intent leaving a domain over its
ceiling. It cannot guarantee usage stays under afterwards, and claiming otherwise
would be a lie the tests would eventually have to be bent to support.

Two routes move exposure with no admission involved: an outside counterparty
filling a resting order, and a cancelled sell returning its escrow. Neither is
preventable by an on-chain contract that does not control the venue.

So the guarantee is asserted where it is actually made — inside the invariant
handler, at the moment of every successful `execute`. The global assertion that
replaced the old one proves the useful consequence instead: while over the
ceiling, every risk-adding intent is refused, checked by previewing one against
each tracked market rather than by restating the branch condition.

The old global form passed in v1 only because that suite never admitted an order.

---

## 18. Somnia under-estimates deployment gas by roughly 11x

`forge script --broadcast` sends its own estimate as the gas limit, and on Somnia
that estimate is wrong for large deployments in a way that is not obvious: the
2.0.0 implementation estimated 6,793,595 and actually consumed 79,033,439. The
transaction fails with status 0 having burned the whole limit, which reads like a
revert rather than out-of-gas.

`--gas-limit` does not override it for scripts. `--gas-estimate-multiplier 2000`
does. Recorded here because the first two deployment attempts were lost to it and
the failure gives no useful signal on its own.
