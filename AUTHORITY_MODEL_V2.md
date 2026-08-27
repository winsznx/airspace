# AUTHORITY_MODEL_V2.md

Who may move what, across many agents sharing one capital base.

Supersedes `AUTHORITY_MODEL.md` (single-agent FLIGHTPATH), which stays in the
repo for auditability.

---

## 1. Architecture comparison

The test: **can aggregate enforcement be made atomic and impossible to bypass?**

### A. One PortfolioAccount holding all capital, authorising N agent keys — **CHOSEN**

Every agent calls `execute` on the same contract. The aggregate check is a
storage read plus a set of balance reads in the same transaction that moves the
money.

There is no second place capital can live, so there is no path that spends
portfolio capital without passing the check. Not "no path we implemented" -- no
path that exists. An agent holds no funds and has no allowance; the portfolio
approves the pool for the exact escrow of one order and zeroes it immediately
after placement.

Atomicity is free: EVM transactions are serialised, so two agents cannot
interleave a check-then-spend. There is no read-modify-write window to race.

### B. Parent PortfolioController + child FlightAccounts — **REJECTED**

Capital lives in the children. Aggregate enforcement then depends on every child
*volunteering* to consult the parent before spending. A child with a bug, a
different implementation, an upgrade, or simply a second entrypoint spends shared
capital outside the envelope, and the parent's view is stale rather than wrong --
which is worse, because it looks correct.

This is the same failure shape as Sentry's self-policing model (see
`COMPETITOR_DELTA_V2.md`): the gate's authority is the gated contract's
willingness to call it.

### C. Isolated children + shared on-chain RiskCoordinator — **REJECTED**

Identical objection. A coordinator that cannot *hold* the capital cannot
*withhold* it. It can only advise, and advice is bypassable. It also adds a
cross-contract call on the hot path for no safety gain.

**A is the only architecture where the aggregate limit is enforced by custody
rather than by cooperation.**

The cost of A is real and accepted: all agents share one contract, so a
compromised agent can grief the others by consuming portfolio headroom. That is
inherent to a shared capital base -- it is the product -- and it is bounded by
per-agent ceilings. See `THREAT_MODEL_V2.md` R3.

---

## 2. The authority table

| Capability | OWNER | Any AGENT | Anyone |
|---|---|---|---|
| Withdraw collateral | **yes, unconditional** | no (`NotOwner`) | no |
| Withdraw outcome tokens | **yes, unconditional** | no (`NotOwner`) | no |
| Set global / bucket policy | yes | no (`NotOwner`) | no |
| Add, re-scope or revoke an agent | yes | no (`NotOwner`) | no |
| Admit a market to a risk bucket | yes | no (`NotOwner`) | no |
| Declare the capital base | yes | no | no |
| Cancel a resting order | yes | no | no |
| Redeem settled positions | yes | no | no |
| Arbitrary call (`ownerCall`) | yes | no (`NotOwner`) | no |
| Place an order within the envelope | via `ownerCall` | **only via `execute`** | no (`NotAgent`) |
| Place an order outside the envelope | — | **no** | no |
| Release a *dead* reservation | yes | yes | **yes** |
| Release a *live* reservation | no | no | no (`OrderStillLive`) |
| Release settled exposure | yes | yes | **yes** (only once terminal on-chain) |

Two asymmetries carry the model:

- An agent's only power is to **propose**. The portfolio decides whether capital
  moves.
- The permissionless calls (`releaseOrder`, `releaseSettled`) are safe *because
  they are not discretionary*. Each reads authoritative state -- `getOrder`,
  `marketNonce`, `isResolved`/`isVoided` -- and can only move the books toward
  it. The caller supplies no numbers.

### Agent isolation

Agent identity is `msg.sender`. There is no signature-relay path, so one agent
cannot present another's intent: an intent hash commits to
`(portfolio, chainId, agent, intent)`, and the commitment lands on the caller's
own budget regardless of how the payload was constructed. Proven live -- C
executed A's exact intent shape and charged only C's budget.

No agent can modify another agent's policy, release another agent's live
reservation, widen a bucket ceiling, or admit a market. All are `onlyOwner` and
all were attempted live by a hostile C.

### Unconditional recovery

Owner withdrawal reads no policy, no agent state, no market state, no bucket
state and no subscription state. It cannot be blocked by a saturated envelope, an
expired policy, a revoked agent, a hostile agent, or a finalized market. Proven
live with all three agents revoked, and on fork with the BTC bucket at 80% of
its ceiling.

`ownerCall` is a deliberate escape hatch granting the owner no privilege they do
not already have -- they own every asset in the portfolio -- so that recovery
never depends on this contract having anticipated a protocol upgrade.

---

## 3. Policy surface

Ceilings ladder **agent -> bucket -> portfolio**, and the tightest binds.

| Control | Scope | Enforced against |
|---|---|---|
| `maxCommittedCollateral` | portfolio | measured `capitalBase - free` |
| `maxRestingReservation` | portfolio | tracked open-order escrow |
| `maxSingleOrderNotional` | portfolio | computed order escrow |
| `maxBuyPrice` / `minSellPrice` | portfolio **and** agent | intent price |
| `maxLivePositions` | portfolio | markets with non-zero exposure |
| `minHeadroomSec` | portfolio | on-chain `expiry - now` |
| `maxGrossDirectional` | **risk bucket** | **Σ\|directional\| across the bucket** |
| `maxCommitted` | risk bucket | measured committed collateral |
| `maxCommitted` | agent | per-agent tracked commitment |
| `maxOrderNotional` | agent | computed order escrow |
| `cooldownSec` | agent | `agentLastTradeAt` |

`maxGrossDirectional` is the one that makes AIRSPACE a different product. Every
other row constrains an agent. That row constrains the **portfolio**, and it is
the only one that can reject an order for reasons that have nothing to do with
the agent proposing it.

### Structural gates inherited and re-verified per execution

Read from the chain every time, never from the admission record alone, never
from the indexer: pool identity against the module registry, generation binding
(`marketNonce` plus the derived outcome ids), creator, collateral, cadence,
`finalized`/`isResolved`/`isVoided`, the trading window, expiry headroom, the
venue tick and lot grid, and the order-expiry cap.

---

## 4. Receipt field verifiability

Emitted across `IntentExecuted` + `IntentReconciled`, reconstructible from logs.

| Field | Source | Label |
|---|---|---|
| `portfolioId` | emitting contract address | `ONCHAIN_VERIFIABLE` |
| `agent` | log topic (`msg.sender`) | `ONCHAIN_VERIFIABLE` |
| `policyHash` (agent) | `keccak256(abi.encode(AgentPolicy))`, cross-checks `AgentSet` | `ONCHAIN_VERIFIABLE` |
| `globalPolicyHash` | cross-checks `GlobalPolicySet` | `ONCHAIN_VERIFIABLE` |
| `intentHash` | every input is in the log | `ONCHAIN_VERIFIABLE` |
| `marketId` | log topic; cross-checks `module.markets` | `ONCHAIN_VERIFIABLE` |
| `pool` | log field; must equal registry pool | `ONCHAIN_VERIFIABLE` |
| `marketNonce` | log field; equals `pool.marketNonce()` at that block | `ONCHAIN_VERIFIABLE` |
| `reservedBefore` / `reservedDelta` | log fields | `ONCHAIN_VERIFIABLE` |
| `directionalExposureBefore` / `After` | log fields; recomputable from balances + reservations at that block | `ONCHAIN_VERIFIABLE` |
| `txHash` | the transaction | `ONCHAIN_VERIFIABLE` |
| `actualFill` (qty) | ERC-6909 balance delta measured in-transaction | `DERIVED_FROM_ONCHAIN` |
| `actualFill` (cost) | collateral delta minus resting escrow | `DERIVED_FROM_ONCHAIN` |
| `restingQty` | `getOrder().quantityRemaining` | `DERIVED_FROM_ONCHAIN` |
| **`riskBucket`** | **owner-attested via `admitMarket`** | **`OFFCHAIN_WITNESS`** |
| `strategyVersion` | agent-supplied 32 bytes | `OFFCHAIN_WITNESS` |
| Which agent owns which realized contract | — | `UNKNOWN` (fungible; see accounting §5) |

Two fields are `OFFCHAIN_WITNESS` and both are labelled that way everywhere.

`riskBucket` is the important one. The bucket *assignment* is an owner
attestation (`RISK_IDENTITY.md`), so "aggregate BTC exposure" is precise only to
the extent the owner's catalogue is correct. Everything the bucket is *used for*
-- the aggregation, the ceiling, the rejection -- is on-chain and exact. The
attestation is publicly falsifiable against the creation events, so it is
auditable even though it is not machine-verifiable in the EVM.

`strategyVersion` has no on-chain attestation and never should be presented as
verified.
