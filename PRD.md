# AIRSPACE Product Requirements Document

**Version:** 1.0  
**Status:** PRODUCT LOCKED - Canonical production source of truth  
**Date:** 2026-08-27  
**Target:** Somnia x DreamDEX Event Contracts Hackathon  
**Hackathon network:** Somnia Shannon testnet  
**Primary product line:** **One capital pool. Many trading agents. One shared risk envelope.**

---

## 0. Document authority

This document is the canonical product source of truth for the AIRSPACE production build.

The repository's `engineering/` directory is the evidence archive that explains how AIRSPACE reached product lock. Those archived FLIGHTPATH and AIRSPACE hostile-validation reports are evidence, not the production specification.

If production code, UI copy, README claims, demo language, or submission material conflicts with this PRD, this PRD wins unless implementation discovers a correctness flaw and the PRD is intentionally revised.

AIRSPACE has completed product-lock validation. Idea discovery is closed. The dominant mechanism must not be replaced or diluted by unrelated features unless new evidence invalidates a core assumption.

### 0.1 Requirement status labels

Major requirements use three status classes:

- **PROVEN** - validated against live or forked DreamDEX/Somnia behavior, or by deterministic hostile testing in the product-lock engineering archive.
- **PRODUCT DECISION** - a deliberate production architecture, UX, or business choice built on proven facts.
- **OPEN / NON-BLOCKING** - useful unresolved work that does not invalidate the safety or central product claim.

### 0.2 Engineering basis

The repository preserves three validation stages:

1. `engineering/00-flightpath-feasibility/`
   - Proved the Event Contract execution boundary and live contract-owned trading path.
   - Proved the spot/perp session-key model does not extend to DreamDEX BinaryPool Event Contracts.
   - Proved generation binding, authoritative market-state checks, hostile rejection, and unconditional owner recovery.
   - Returned REVISE because Vane already occupied the single-agent vault mechanism.

2. `engineering/01-airspace-portfolio-spike/`
   - Changed the constraint object from one agent's authority to cross-agent portfolio state.
   - Proved live aggregate exposure refusal across independent agents.
   - Proved reservations must occupy portfolio headroom before fills.
   - Returned REVISE because semantic asset buckets required per-market attestation.

3. `engineering/02-product-lock/`
   - Removed semantic asset attestation from the security path.
   - Replaced it with structural risk domains.
   - Proved zero per-market admission, rolling-generation support, aggregate reservation safety, multi-agent refusal, reconciliation, scaling, and competitive distinctness.
   - Final verdict: **LOCK, 11/11 product-lock criteria passed.**

Production requirements should link back to these reports when a reviewer needs the evidence behind a mechanism.

---

# 1. Product definition

## 1.1 Canonical definition

AIRSPACE is a shared-capital execution and portfolio-risk control plane for fleets of independent DreamDEX Event Contract trading agents.

A portfolio owner can register multiple agent keys, fund one capital pool, give each agent a local execution policy, and define portfolio-wide limits. Every agent intent must pass both its local policy and an atomic global admission check before AIRSPACE allows portfolio capital to move.

The core insight is that several agents can each obey their own individual rules while collectively creating a portfolio state the owner never intended.

AIRSPACE prevents that collective failure.

### Canonical statement

> AIRSPACE lets independent DreamDEX trading agents share one capital pool while enforcing one portfolio-wide risk envelope across all of them.

### Short line

> One capital pool. Many trading agents. One shared risk envelope.

### Judge-compressed mechanism

> Every agent can be individually compliant and the portfolio can still be unsafe. AIRSPACE atomically reserves and reconciles shared risk across all agents, so a trade can be rejected solely because of what other agents have already committed.

---

# 2. Problem

Prediction-market and trading-agent systems are usually constrained at the individual agent level.

An owner may run:

- a 60-second momentum agent,
- a 15-minute oracle-following agent,
- a 1-hour mean-reversion agent,
- a daily directional agent,
- a human-controlled manual strategy,
- or third-party bots.

Each strategy may have a valid local limit.

That is insufficient when the strategies share the same owner and economic capital.

Example:

- Agent A has a valid 180-contract order.
- Agent B has a valid 240-contract order.
- Agent C has a valid 150-contract order.
- Every local agent policy passes.
- The owner has a 500-contract structural-domain ceiling.

A and B consume 420 units of capacity.

C's order would take the portfolio to 570.

AIRSPACE must reject C even though C did nothing wrong under its own policy.

Without shared admission, isolated bots can:

- overcommit capital,
- unintentionally concentrate exposure,
- race each other for the same remaining headroom,
- strand excess collateral across isolated vaults,
- create hidden future exposure through resting orders that have not filled yet,
- act on recycled market generations,
- and disagree about what portfolio state is actually live.

AIRSPACE makes the portfolio the primary safety object.

---

# 3. Product thesis

## 3.1 Dominant mechanism

The dominant mechanism is:

**CROSS-AGENT PORTFOLIO ADMISSION + RESERVATION + POST-TRADE RECONCILIATION**

Every order follows:

```text
agent intent
    |
    v
local agent policy
    |
    v
authoritative DreamDEX market validation
    |
    v
structural risk-domain derivation
    |
    v
atomic portfolio reservation
    |
    v
shared domain/global capacity check
    |
    +--> reject without changing committed state
    |
    v
DreamDEX execution
    |
    v
actual balance / reservation reconciliation
    |
    v
capacity remains reserved or is safely released
```

AIRSPACE is valuable because the global decision is based on the combined state created by all agents, not because it has more per-agent configuration toggles.

## 3.2 Sponsor removal test

If DreamDEX Event Contracts disappear, the current AIRSPACE product disappears.

The design depends on:

- DreamDEX BinaryPool execution,
- binary YES/NO outcome economics,
- recycled pool generations,
- DreamDEX market lifecycle,
- Event Contract tick/lot constraints,
- collateral escrow,
- ERC-6909 outcome balances,
- resolution/void/redemption behavior,
- and rapidly rolling Event Contract series.

Sponsor dependence is load-bearing.

---

# 4. Non-goals

AIRSPACE is not:

- an AI trading bot,
- an AI prediction model,
- a signal provider,
- a generic DreamDEX terminal,
- a copy-trading product,
- a market-making strategy,
- a statistical portfolio-risk oracle,
- a guarantee that agents will be profitable,
- a guarantee against all possible market loss,
- an asset-identity oracle,
- a replacement for DreamDEX settlement,
- an offchain firewall that agents may bypass,
- a custodial service that can seize owner capital,
- or a claim that a single contract can infer semantic BTC/ETH identity from every marketId.

AI may be used by sample agents or third-party strategies. AI is not required for AIRSPACE's enforcement mechanism.

---

# 5. Core product invariants

These invariants are binding.

1. Portfolio capital cannot be spent by an agent outside AIRSPACE's admission path.
2. An agent cannot widen its own policy or the portfolio policy.
3. An agent cannot withdraw collateral or outcome tokens.
4. An agent cannot release another agent's reservation.
5. A rejected intent must not consume portfolio capacity.
6. A resting order must consume worst-case portfolio capacity before it can later fill.
7. Concurrent agents cannot collectively reserve more than available shared headroom.
8. AIRSPACE must never understate maximum portfolio commitment because an order's terminal state is ambiguous.
9. Uncertainty must fail safe by retaining capacity, not by creating phantom headroom.
10. Owner asset recovery must remain independent of agent state, portfolio policy state, Reactivity, Cloudflare, Supabase, and market liveness.
11. Pool address alone is never a stable market identifier.
12. Execution must bind the active market generation, not just a recycled pool address.
13. Security-critical enforcement uses authoritative onchain state, not indexer status.
14. Semantic UI labels such as BTC and ETH must never be presented as structurally enforced if the contract only proves a coarser risk domain.
15. All protocol quantities remain integer/bigint values until presentation.
16. Safety cannot depend on Somnia Reactivity firing.
17. Safety cannot depend on a Cloudflare worker being online.
18. Safety cannot depend on Supabase being available.
19. Owner withdrawal cannot be blocked by expired policies, stale keepers, revoked agents, finalized markets, or missing subscriptions.
20. No production claim may exceed the evidence available in the repository.

---

# 6. Actors and roles

## 6.1 Portfolio Owner

The owner controls:

- portfolio creation,
- portfolio funding,
- global policy,
- structural-domain ceilings,
- agent registration,
- agent revocation,
- local agent-policy configuration,
- cancellation/recovery actions,
- redemption,
- and unconditional asset withdrawal.

The owner may always recover assets.

Owner compromise is outside AIRSPACE's guarantee. AIRSPACE constrains agents, not the owner.

## 6.2 Agent

An agent is an independent EVM key authorized by the owner.

An agent may:

- submit an intent through AIRSPACE,
- trade only when its local policy passes,
- consume capacity only when the shared portfolio also passes,
- and receive a deterministic execution result.

An agent may not:

- withdraw,
- transfer portfolio collateral,
- transfer portfolio outcome tokens,
- modify global policy,
- modify another agent,
- release another agent's reservations,
- call arbitrary contracts using portfolio authority,
- or bypass portfolio admission while spending portfolio capital.

Assume every agent key is fully compromised.

This is the threat model.

## 6.3 Viewer

A viewer may observe public portfolio state, receipts, evidence, or shared links.

A viewer has no authority.

## 6.4 Lifecycle operator

Cloudflare workers, Reactivity handlers, or permissionless keepers may perform explicitly safe lifecycle work.

They must not receive discretionary authority to weaken policies or move owner assets to arbitrary recipients.

Liveness operators are untrusted for safety.

---

# 7. Authority and custody model

**Status: PROVEN**

AIRSPACE uses contract-owned execution.

Portfolio capital lives in an AIRSPACE portfolio contract.

The portfolio contract is the trader of record when calling DreamDEX `placeBinaryOrder`.

The agent key itself holds no portfolio collateral and no portfolio outcome tokens.

This architecture is required because the hostile feasibility spike established that DreamDEX Event Contract BinaryPools do not expose the same user-grantable split-key operator model used by spot/perp pools.

A valid agent therefore proposes an action to the portfolio contract. The portfolio contract decides whether capital may move.

### Authority summary

| Capability | Owner | Registered agent | Anyone |
|---|---:|---:|---:|
| Deposit collateral | Yes | Yes if harmless | Yes if harmless |
| Withdraw collateral | Yes | No | No |
| Withdraw outcomes | Yes | No | No |
| Register/revoke agents | Yes | No | No |
| Set global policy | Yes | No | No |
| Set local agent policy | Yes | No | No |
| Submit in-policy intent | Optional | Yes | No |
| Release another agent's live reservation | Owner or safe lifecycle path | No | No |
| Redeem settled position | Owner or explicitly safe lifecycle function | No discretionary recipient | No arbitrary recipient |

A production escape hatch may exist for the owner because the owner already owns all portfolio assets. It must be unreachable by agents.

---

# 8. DreamDEX market identity

## 8.1 Stable identity

**Status: PROVEN**

`marketId` is the stable market identity used by AIRSPACE application state.

Pool addresses are time-varying bindings and are recycled across successive markets.

Production state must never key a market solely by `pool`.

## 8.2 Generation identity

**Status: PROVEN**

Outcome-token identity depends on the active pool generation.

The validated prototype derives the generation relationship from:

- pool address,
- current `marketNonce`,
- module registry outcome IDs,
- and the active market record.

AIRSPACE must reject a stale or substituted generation.

Production code must port the validated generation-binding logic from the product-lock prototype rather than re-inventing it from memory.

## 8.3 Authoritative Trading state

**Status: PROVEN**

Indexer state is not authoritative.

Before execution, AIRSPACE must compose live market validity from onchain state.

The validated implementation checks the equivalent of:

- pool not finalized,
- market not resolved,
- market not voided,
- current time at or after `tradingStart`,
- current time before `expiry`,
- and required generation/pool identity consistency.

Indexer data may shortlist markets for UX and discovery.

It cannot authorize execution.

---

# 9. Structural risk domains

## 9.1 Why structural domains exist

AIRSPACE originally attempted semantic asset buckets such as BTC and ETH.

The hostile spike established that semantic `marketId -> asset` identity can be reconstructed from creation history but is not directly available to an executing smart contract through a safe view path for every rolling market.

Product lock removed semantic attestation from the security path.

AIRSPACE therefore enforces structural risk domains made only from execution-time onchain facts.

## 9.2 Domain key

**Status: PROVEN**

The product-lock implementation uses a domain equivalent to:

```text
riskDomain = keccak256(
    creator,
    collateral,
    canonicalCadence
)
```

Every field must be derived from authoritative onchain market state.

No security-critical domain input may come from:

- indexer labels,
- user-supplied BTC or ETH strings,
- trusted relayers,
- offchain databases,
- manual per-market admission,
- or event-log attestations.

## 9.3 Canonical cadence

**Status: PROVEN**

Raw `expiry - tradingStart` is not sufficient.

The lock investigation scanned 1,200 consecutive live markets and observed real 898-second markets belonging to a 900-second series.

Production must port the validated canonicalization rule from the product-lock prototype.

The proven rule is:

> Choose the smallest supported canonical cadence `C` such that `C >= observedWindow` and `expiry % C == 0`.

The supported canonical cadence set and ordering must come from the validated prototype and current DreamDEX series behavior. Do not guess or silently change it during production porting.

A 60-second market must not be promoted into a 900-second domain merely because 900 is divisible by 60.

Tests must cover observed edge cases including the validated 898-to-900 normalization.

## 9.4 Semantic labels

The web application may display:

- BTC,
- ETH,
- 60s,
- 15m,
- 1h,
- 4h,
- daily,
- and human market descriptions.

Those labels are informational.

Where the security layer only proves a structural domain, the product must make that clear.

Example:

```text
Market label: BTC / 15m
Enforced domain: 15-minute tUSDC Event Contract domain
```

Never claim that the contract enforces BTC exposure when sibling BTC/ETH series intentionally share a structural domain.

## 9.5 Rolling markets

**Status: PROVEN**

A new rolling market must enter the correct domain automatically.

Requirements:

- zero per-market owner admission transactions,
- zero manual migration between generations,
- zero stable pool-address assumptions,
- automatic enforcement across rolling generations.

The product-lock run validated 500 consecutive 60-second generations with zero configuration between them.

---

# 10. Economic vocabulary

These terms must not be used interchangeably.

## 10.1 `freeCollateral`

Collateral currently held by the portfolio and not required to satisfy known reservations or protocol escrow.

UI may show an immediately spendable estimate, but execution must use contract state and live balances.

## 10.2 `reservedCollateral`

Worst-case collateral or risk capacity retained for admitted orders that may still fill or remain economically live.

A reservation is charged before external value movement.

## 10.3 `committedCapital`

Capital currently committed to active DreamDEX positions, escrow, or conservative reservation accounting.

This is not automatically equal to directional risk.

## 10.4 `marketDirectionalExposure`

**REALIZED ONLY.** The imbalance between YES and NO outcome quantities the
portfolio actually holds right now, from ERC-6909 balances. No reservation of
any kind is included.

```text
marketDirectionalExposure = balYES - balNO           (0 once settled)
```

A complete YES+NO set has zero directional outcome exposure inside that
market. This quantity is informational — reported for humans and indexers —
and admission must never gate on it directly. It is not the quantity a domain
ceiling is charged against; see 10.4a.

Do not net across unrelated markets merely because they share a domain.

## 10.4a `marketWorstCaseExposure`

**THE QUANTITY ADMISSION GATES ON.** The widest point of the INTERVAL of
directional positions this market can still reach, given that every resting
order resolves independently — it may fill, be cancelled, or expire, and
nothing may assume otherwise.

```text
b  = balYES - balNO
up = b + yesLong + yesShort      -- BUY_YES fills, or SELL_YES's escrow returns
dn = b - noLong  - noShort       -- BUY_NO  fills, or SELL_NO's  escrow returns

marketWorstCaseExposure = max(abs(up), abs(dn))
```

`yesShort`/`noShort` land on the bound that GROWS if the order does NOT fill,
not the one that shrinks if it does — because a SELL escrows its outcome
tokens at placement (verified against the live venue: a pool's outcome-token
balance equals its resting ask depth exactly), so cancelling it returns those
tokens to the realized balance.

**A resting BUY_YES and a resting BUY_NO on the same market must NEVER be
netted against each other**, even though a naive `netYES - netNO` computed
over reservation-inclusive quantities would appear to net them. Either can
fill without the other; assuming they resolve together was the exact defect
in AIRSPACE 1.0.0, which reported a live worst case of 1,170 as 80 under a
ceiling of 500. See `evidence/production/REMEDIATION.md`. The bound above is
the corrected, tight replacement — proven equal to an independent
implementation that enumerates every combination of fills rather than
evaluating a closed form (`contracts/test/reference/ExposureOracle.sol`).

A settled market contributes zero: its position is a fixed claim, not a bet.

## 10.5 `domainRiskUsage`

The GROSS sum of `marketWorstCaseExposure` over every tracked, unsettled
market in the domain — never netted across markets, and never computed from
`marketDirectionalExposure` (10.4), which omits reservations entirely and
would understate.

```text
domainRiskUsage = Σ marketWorstCaseExposure(m)   for m in domain.markets
```

Charged against the owner's ceiling. AIRSPACE cannot admit an order whose
later fill would push the portfolio above the domain ceiling.

Where exact risk cannot be proven — most visibly, a filled or cancelled
reservation the venue has not yet confirmed gone, since `getOrder` reverts
identically for both — overstatement is allowed and preferred to unsafe
understatement. This is bounded and self-clearing: `releaseOrder` is
permissionless, and the overstatement it carries converges to zero the moment
it runs. It is a claim on ADMISSION headroom, never a claim that exposure
cannot move at all: an outside fill or a cancelled sell's returning escrow
both change `domainRiskUsage` with no admission involved, because neither is
preventable by a contract that does not control the venue. What AIRSPACE
guarantees is narrower and load-bearing: it never ADMITS an intent that would
leave a domain over its ceiling.

## 10.6 `globalRiskUsage`

A portfolio-wide aggregate used for global limits.

The exact formula depends on the configured global rule. Do not treat it as marked-to-market VaR, delta, or portfolio variance unless those are separately implemented and proven.

---

# 11. Binary outcome accounting

**Status: PROVEN**

AIRSPACE inherits the exact accounting lessons established by the TAPE validation work.

For one binary market, YES and NO are complementary fixed-payout positions.

Complete YES+NO holdings do not create directional outcome exposure.

Production reconciliation must use exact integer arithmetic.

No floating point arithmetic is allowed for security-critical:

- prices,
- quantities,
- collateral,
- tick checks,
- lot checks,
- reservations,
- or outcome balances.

TAPE as a standalone product was killed because the live venue did not support its market-integrity business thesis strongly enough. Its accounting findings remain valid engineering inputs.

---

# 12. Portfolio policy model

## 12.1 Global policy

A portfolio may configure:

- maximum total committed collateral,
- maximum global risk usage,
- maximum simultaneous live positions or reservations where useful,
- safe lifecycle parameters,
- and owner-defined structural-domain ceilings.

Global policy changes are owner-only.

Production should default to conservative settings.

## 12.2 Structural-domain policy

Each configured domain may define:

- maximum domain risk usage,
- optional maximum outstanding reservation,
- optional maximum active markets in the domain,
- optional minimum headroom,
- and safe cleanup/lifecycle parameters.

The product-lock prototype demonstrated a 500-contract domain ceiling.

Production UI should not assume every user wants the same unit or limit.

## 12.3 Agent-local policy

Each registered agent may have:

- enabled/disabled status,
- local maximum order quantity/notional,
- local maximum committed contribution,
- price ceiling/floor where applicable,
- market headroom requirement,
- cooldown/rate limit,
- strategy identifier/version metadata,
- optional permitted structural domains,
- and replay/nonce state.

An agent passing its own policy does not imply portfolio admission.

## 12.4 Default deny

Unregistered agents fail.

Unknown or malformed market/domain identity fails.

Invalid grid values fail.

Stale market state fails.

Uncertain reservation release fails closed by retaining capacity.

---

# 13. Order-admission algorithm

The production admission path must be deterministic.

Conceptual sequence:

1. Authenticate the caller as a registered, enabled agent.
2. Validate the agent-local policy epoch and nonce.
3. Resolve the exact DreamDEX market from authoritative onchain state.
4. Bind the market generation.
5. Validate Trading state.
6. Validate order side, quantity, tick, lot, and expiry.
7. Compute the structural risk domain.
8. Compute the order's worst-case reservation requirement.
9. Read current agent, domain, and global portfolio state.
10. Check local agent limits.
11. Check domain limits.
12. Check global portfolio limits.
13. Atomically record reservation state before external value movement.
14. Approve only the exact required DreamDEX collateral amount where the protocol requires allowance.
15. Submit the DreamDEX order.
16. Clear unnecessary standing allowance where technically applicable.
17. Use immediately available execution data if reliable.
18. Emit an execution/admission receipt.
19. Leave conservative reservation state until later reconciliation can safely release it.

A failed external DreamDEX call must revert the reservation atomically within the same transaction.

No offchain mutex may be required to prevent two agents racing the same headroom.

---

# 14. Reservation lifecycle

## 14.1 Required lifecycle

```text
PROPOSED
-> RESERVED
-> PLACED
-> PARTIAL / RESTING / FILLED
-> CANCELLED / EXPIRED
-> FINALIZED / VOIDED
-> REDEEMED
```

Not every state must be a stored Solidity enum if a safer derivation exists.

The contract should store only the minimum information required for safe admission and release.

## 14.2 Core reservation rule

An order that may fill later consumes capacity now.

AIRSPACE must never permit several agents to place individually valid resting orders whose combined later fills can exceed the portfolio ceiling.

## 14.3 Partial fill

Partial fills must not be counted twice as both a full reservation and a full resulting position.

Exact reconciliation may reduce a reservation when the contract can prove which capacity has moved from potential commitment to actual outcome balance.

If exact reduction is not provable, retain conservative excess until a safe release path exists.

## 14.4 Ambiguous terminal state

**Status: PROVEN**

The engineering spike established that DreamDEX `getOrder` may revert identically for filled and cancelled terminal orders.

AIRSPACE therefore must not maintain safety using a running filled/cancelled counter that assumes the contract can always distinguish terminal reasons.

The validated correction is:

- derive actual live position state from ERC-6909 balances where possible,
- store reservation state for unfilled potential commitment,
- and release conservatively.

## 14.5 Safe overstatement invariant

At every point:

> Recorded domain usage may exceed exact current economic exposure, but it must not fall below the maximum commitment AIRSPACE can still create from live admitted state.

The lock tests proved an adversarial external fill where usage temporarily moved from 20 to 40 even though the final true usage was 20. That overstatement was safe and later converged after release.

Production must preserve this property.

---

# 15. Concurrency

**Status: PROVEN**

Cross-agent admission must be atomic onchain.

Example:

```text
available domain capacity = 200
Agent A proposes 150
Agent B proposes 150
```

At most one may reserve if both would exceed the domain limit.

No Cloudflare lock, database lock, queue serialization, or browser coordination may be required for safety.

Production tests must cover:

- two-agent same-block competition,
- three-agent competition,
- ten-agent competition,
- repeated retry after one winner consumes capacity,
- release followed by subsequent admission.

---

# 16. Reconciliation

## 16.1 Goal

Reconciliation converts conservative reservation state into the safest current view of:

- outstanding reservation,
- actual owned outcome balance,
- committed capital,
- directional exposure,
- finalization state,
- claimable value,
- and releasable capacity.

## 16.2 Sources of truth

Preferred hierarchy:

1. authoritative onchain DreamDEX state,
2. ERC-6909 outcome balances,
3. portfolio contract reservation state,
4. transaction receipts/events,
5. indexer data for convenience and UX,
6. Supabase for application history/cache.

Indexer or database state must never override contradictory chain state.

## 16.3 External fills

A resting order may fill in a transaction the AIRSPACE portfolio did not initiate.

Reconciliation therefore cannot rely only on transactions sent by AIRSPACE infrastructure.

The lifecycle system must detect and reconcile external fills.

## 16.4 Unknown state

When the lifecycle worker cannot prove safe release:

```text
state = NEEDS_RECONCILIATION
capacity = retained
```

Never infer cancellation solely because an indexer row disappears.

## 16.5 Idempotency

Every reconciliation action must be idempotent.

Repeated Cloudflare jobs, duplicate Reactivity callbacks, duplicate event delivery, or worker retries must not:

- double release,
- double redeem,
- duplicate database rows,
- or modify portfolio capacity twice.

---

# 17. Lifecycle pruning

## 17.1 Rapid-cadence requirement

**Status: PROVEN**

At rapid cadence, lifecycle pruning is mandatory.

The product-lock implementation has a bounded domain market set. Without pruning, a 60-second domain can hit the validated cap of 48 markets in roughly 48 minutes and fail closed.

This is acceptable for safety but unacceptable for production liveness.

Production therefore requires a keeper/lifecycle service for rapid series.

## 17.2 Safety rule

If pruning fails:

- new execution may fail closed,
- existing owner funds remain recoverable,
- agents cannot bypass risk limits,
- portfolio state must not be silently deleted.

Keeper failure is a liveness problem, not a safety failure.

---

# 18. Somnia Reactivity

## 18.1 Role

**Status: OPEN / NON-BLOCKING**

Somnia Reactivity can improve lifecycle responsiveness for:

- market expiry,
- finalization,
- stale reservation cleanup,
- redemption readiness,
- and portfolio headroom refresh.

It must not be part of the safety boundary.

## 18.2 Current evidence

The product-lock research observed a live Reactivity subscription through `getSubscriptionInfo(...)`.

The current SDK still exposes a 32 STT/SOMI subscription floor.

The validation wallet did not have enough STT at lock time to determine whether that floor is enforced by the precompile or only by the client path.

This remains explicitly unresolved.

## 18.3 Production rule

Cloudflare reconciliation must be sufficient without Reactivity.

If Reactivity is enabled:

```text
Reactivity event
   -> safe lifecycle callback or offchain wake signal
   -> authoritative re-read
   -> idempotent reconciliation
```

Never trust callback payload alone for asset release.

---

# 19. Contract architecture

## 19.1 Production contracts

Expected production components:

### `AirspacePortfolioFactory`

Responsibilities:

- deterministic portfolio deployment where appropriate,
- owner-to-portfolio discovery,
- version metadata,
- creation events.

### `AirspacePortfolio`

Primary trust boundary.

Responsibilities:

- owner authority,
- multi-agent registry,
- local agent policies,
- global portfolio policies,
- structural-domain policies,
- atomic reservation,
- DreamDEX market validation,
- generation binding,
- order admission,
- exact allowance handling,
- reservation accounting,
- safe release,
- recovery,
- redemption support,
- execution/admission events.

### DreamDEX interfaces

Port only interfaces required by production.

The archived `engineering/shared/interfaces/IDreamDex.sol` is the validated starting point.

Do not blindly copy unused SDK surface.

## 19.2 Upgradeability

**Status: PRODUCT DECISION**

Default preference is a versioned, non-upgradeable portfolio implementation deployed through a factory rather than a proxy with mutable implementation authority.

If upgradeability is introduced, it requires an explicit threat-model revision because upgrade authority can invalidate agent-boundary claims.

Hackathon production should prefer simpler immutable enforcement over upgrade convenience.

## 19.3 Storage growth

The product-lock report identified monotonically growing mappings that are never iterated and therefore preserve O(1) gas behavior.

Production should bound per-agent nonce/history state where practical.

Do not add enumerable global arrays that make execution gas grow linearly with historic agent count or market count.

---

# 20. Contract events and receipts

Every important decision should emit enough information for independent review without leaking secrets.

Required event/receipt concepts:

- portfolio created,
- agent registered,
- agent revoked,
- local policy updated,
- global policy updated,
- domain policy updated,
- intent admitted,
- reservation created,
- reservation changed,
- reservation released,
- order submitted,
- position reconciled,
- market finalized/voided observation,
- redemption,
- owner recovery.

A successful execution receipt should be able to reference:

```text
portfolioId/address
agent
policyHash
globalPolicyHash
intentHash
marketId
pool
marketNonce
riskDomain
reservedBefore
reservedDelta
domainUsageBefore
domainUsageAfter
transactionHash
execution/result state
```

Each displayed field must be classified internally as:

- `ONCHAIN_VERIFIABLE`
- `DERIVED_FROM_ONCHAIN`
- `OFFCHAIN_WITNESS`
- `UNKNOWN`

Do not present offchain witness fields as if the portfolio contract asserted them.

---

# 21. Production web product

The application should feel like a portfolio operations product, not a developer dashboard.

## 21.1 Landing page

Goal: explain AIRSPACE in under 10 seconds.

Primary message:

> Your agents can follow their own rules and still break your portfolio rules.

Visual mechanism:

```text
Momentum Agent      180
Oracle Agent        240
Mean Reversion     +150
                    ---
                    570

Portfolio ceiling   500

Third intent blocked
```

Secondary proof:

> Local policy passed. Market checks passed. Portfolio risk failed.

Design should reach the polish level of a serious financial/control-plane product.

Do not copy Lictor's product layout. Reuse only the standard of visual quality.

## 21.2 Onboarding

Flow:

1. connect wallet,
2. switch to Somnia Shannon if needed,
3. understand the shared-capital model,
4. create/deploy portfolio,
5. fund portfolio,
6. configure first global/domain limit,
7. register first agent,
8. optionally launch sample agent,
9. enter control room.

Do not require terminal use.

## 21.3 Create Portfolio

User configures:

- portfolio name,
- initial collateral funding,
- global committed-capital limit,
- global risk limit if separate,
- structural-domain ceilings,
- local safety defaults,
- owner recovery acknowledgement.

The UI may offer sensible presets, but it must show the exact resulting onchain policy.

## 21.4 Agents

Each agent card shows:

- name,
- address,
- status,
- strategy metadata,
- local policy,
- current reservation contribution,
- current position contribution,
- last action,
- recent receipts,
- revoke control.

Sample agents may be provided for demo and onboarding.

AIRSPACE remains compatible with arbitrary external agents that can submit valid intents.

## 21.5 Control Room

This is the core product surface.

Show:

- total portfolio collateral,
- free collateral,
- reserved capital,
- committed capital,
- global usage,
- each structural-domain usage,
- agent contributions,
- active reservations,
- live positions,
- recent admissions/refusals,
- lifecycle health,
- stale/reconciliation warnings.

The primary screen should make the A/B/C aggregate-refusal mechanism visually obvious.

## 21.6 Incoming intent view

For an intent, show each gate:

```text
Agent registration      PASS
Local policy            PASS
Market generation       PASS
Market Trading state    PASS
Tick / lot              PASS
Price bound             PASS
Headroom                PASS
Portfolio domain        FAIL
```

Then:

```text
Current domain usage: 420
Requested reservation: 150
Resulting usage:       570
Configured ceiling:    500

BLOCKED
```

A failure should state exactly which condition blocked execution.

## 21.7 Positions and reservations

Distinguish visually:

- resting reservation,
- filled position,
- partially filled order,
- needs reconciliation,
- finalized,
- voided,
- claimable,
- redeemed,
- owner-recovery state.

Do not compress all of these into "active."

## 21.8 Receipts

Receipts are first-class product objects.

A receipt page should include:

- decision,
- agent,
- market,
- structural domain,
- local-policy outcome,
- portfolio-policy outcome,
- transaction,
- explorer link,
- hashes,
- reservation change,
- reconciliation status,
- proof classification.

## 21.9 Recovery

Owner recovery must be easy to find.

The app should never hide asset recovery under obscure settings.

Show:

- idle collateral,
- owned outcomes,
- resting orders requiring cancellation,
- settled claims,
- revoked-agent status,
- and withdrawal actions.

---

# 22. Sample agents

**Status: PRODUCT DECISION**

AIRSPACE should ship with several sample agents so judges and users can immediately experience cross-agent behavior.

Suggested samples:

- short-cadence momentum agent,
- oracle-following directional agent,
- mean-reversion agent.

The sample strategies do not need to claim alpha.

Their purpose is to produce heterogeneous, independently controlled intent streams against one portfolio.

Each sample agent must:

- use a distinct key,
- identify its strategy/version,
- submit only through AIRSPACE,
- survive worker restart,
- handle market rollover dynamically,
- avoid hardcoded pool addresses,
- and write structured logs.

Sample agent profitability is not a success criterion.

---

# 23. AIRSPACE SDK

The production repository should expose a small SDK for external bots.

Potential package:

`@airspace/dreamdex`

Minimum concepts:

```ts
createPortfolio(...)
registerAgent(...)
setAgentPolicy(...)
setDomainPolicy(...)
buildIntent(...)
simulateAdmission(...)
submitIntent(...)
getPortfolioState(...)
getDomainState(...)
getAgentState(...)
getReservation(...)
getReceipt(...)
reconcile(...)
```

SDK helpers must not weaken onchain checks.

`simulateAdmission` is advisory.

The actual portfolio contract remains authoritative.

---

# 24. Cloudflare architecture

No Railway.

No Vercel.

## 24.1 Web/API

Use Cloudflare Workers for:

- application delivery,
- public/read APIs,
- authenticated application APIs,
- transaction preparation,
- receipts/evidence endpoints,
- portfolio history,
- indexer abstraction,
- and admin-free lifecycle surfaces.

## 24.2 Durable Objects

Use Durable Objects where per-portfolio coordination materially helps offchain liveness.

Potential responsibilities:

- one live coordinator per portfolio,
- DreamDEX stream connection,
- WebSocket fanout to browsers,
- in-memory dedupe cache,
- alarm scheduling,
- fast reconciliation wakeups.

Durable Objects are never the onchain enforcement authority.

## 24.3 Queues

Use Cloudflare Queues for:

- reconciliation jobs,
- event backfills,
- lifecycle retry,
- settlement scans,
- evidence generation,
- non-blocking analytics.

All consumers must be idempotent.

## 24.4 Cron / alarms

Use Cron Triggers and/or Durable Object alarms for:

- safety sweeps,
- missed-event recovery,
- pruning,
- finalization scans,
- stale portfolio detection.

## 24.5 R2

Use R2 only when beneficial for immutable/public evidence archives or larger raw datasets.

Do not duplicate normal relational application state into R2 without reason.

---

# 25. Supabase architecture

Supabase Postgres is AIRSPACE's durable application database.

It is not the enforcement authority.

Potential tables:

## `users`

- id
- wallet_address
- created_at

## `portfolios`

- id
- chain_id
- portfolio_address
- owner_address
- display_name
- implementation_version
- created_tx
- created_block
- created_at

## `agents`

- id
- portfolio_id
- agent_address
- display_name
- strategy_id
- strategy_version
- status
- registered_tx
- revoked_tx
- created_at

## `agent_policies`

- portfolio_id
- agent_address
- policy_epoch
- policy_hash
- decoded policy snapshot
- source_block

## `domain_policies`

- portfolio_id
- domain_hash
- canonical_cadence
- collateral
- creator
- policy_hash
- decoded policy snapshot
- source_block

## `intents`

- intent_hash
- portfolio_id
- agent_address
- market_id
- market_nonce
- domain_hash
- requested quantity
- requested price
- status
- tx_hash
- created_at

## `reservations`

- reservation_id
- intent_hash
- portfolio_id
- agent_address
- market_id
- domain_hash
- reserved amount
- reconciled amount
- lifecycle status
- source_block
- updated_at

## `positions`

- portfolio_id
- market_id
- yes_balance
- no_balance
- directional_exposure
- finalization status
- source_block
- updated_at

## `receipts`

- intent_hash
- decision
- policy hashes
- pre-state
- post-state
- tx_hash
- verification classes
- evidence object
- created_at

## `chain_events`

- chain_id
- tx_hash
- log_index
- event_type
- portfolio_address
- block_number
- payload
- processed_at

Unique key:

`chain_id + tx_hash + log_index`

This supports idempotent ingestion.

## `reconciliation_jobs`

- id
- portfolio_id
- market_id/domain
- reason
- status
- attempt_count
- next_attempt_at
- last_error

RLS must isolate private application metadata.

Public onchain portfolio state may be safely exposed where intended.

---

# 26. Realtime architecture

Do not make Supabase Realtime the sole fanout system for 1,000 simultaneous users.

Preferred flow:

```text
DreamDEX / Somnia
       |
       v
Cloudflare portfolio coordinator
       |
       +--> browser WebSockets
       |
       +--> Supabase durable history
```

Browser state must display a stale-data indicator if the stream disconnects.

Execution decisions must never rely on browser-cached state.

---

# 27. API model

Representative HTTP APIs:

```text
GET  /api/portfolios/:address
GET  /api/portfolios/:address/agents
GET  /api/portfolios/:address/domains
GET  /api/portfolios/:address/positions
GET  /api/portfolios/:address/reservations
GET  /api/portfolios/:address/receipts
GET  /api/receipts/:intentHash

POST /api/intents/simulate
POST /api/transactions/prepare
POST /api/reconcile/request
```

Write APIs that alter owner/agent authority must ultimately require wallet signatures and onchain execution.

No backend admin key may silently act as portfolio owner.

---

# 28. Error model

At minimum distinguish:

- `WRONG_NETWORK`
- `NOT_OWNER`
- `NOT_AGENT`
- `AGENT_DISABLED`
- `POLICY_EXPIRED`
- `POLICY_MISMATCH`
- `INTENT_REPLAYED`
- `MARKET_NOT_FOUND`
- `MARKET_NOT_TRADING`
- `MARKET_GENERATION_MISMATCH`
- `POOL_MISMATCH`
- `DOMAIN_UNSUPPORTED`
- `DOMAIN_LIMIT_EXCEEDED`
- `GLOBAL_LIMIT_EXCEEDED`
- `AGENT_LIMIT_EXCEEDED`
- `PRICE_OUTSIDE_POLICY`
- `OFF_TICK_GRID`
- `OFF_LOT_GRID`
- `INSUFFICIENT_HEADROOM`
- `INSUFFICIENT_COLLATERAL`
- `RESERVATION_CONFLICT`
- `RESERVATION_NOT_RELEASABLE`
- `NEEDS_RECONCILIATION`
- `RPC_FAILURE`
- `INDEXER_STALE`
- `TRANSACTION_REVERTED`
- `ORDER_NO_FILL`
- `SETTLEMENT_PENDING`
- `VOIDED`
- `REDEEM_UNAVAILABLE`

User-facing copy should explain what action is possible.

Do not map all protocol errors to "transaction failed."

---

# 29. Security model

Assume:

- every agent key may be malicious,
- agents may collude,
- agents know portfolio limits,
- agents race for capacity,
- RPC providers may fail,
- indexer data may be stale,
- lifecycle workers may stop,
- Reactivity may stop,
- Supabase may be unavailable,
- Cloudflare may retry jobs,
- DreamDEX pools recycle,
- and protocol implementations may upgrade.

## 29.1 Required adversarial tests

- agent direct withdrawal,
- agent outcome withdrawal,
- arbitrary-call attempt,
- agent policy widening,
- global policy widening,
- spoof another agent,
- replay old intent,
- stale market,
- substituted market,
- substituted pool,
- recycled generation,
- sibling-market switching inside same structural domain,
- off-grid price,
- price grief,
- huge order,
- many tiny reservations,
- two agents racing final headroom,
- ten agents racing final headroom,
- release manipulation,
- trying to release a rival's live order,
- external fill not initiated by AIRSPACE worker,
- partial fill,
- cancellation,
- expiry,
- finalization,
- void,
- duplicate reconciliation,
- stale Reactivity callback,
- duplicate queue delivery,
- RPC fallback,
- owner recovery with all agents revoked,
- owner recovery with policy expired,
- owner recovery with lifecycle infrastructure offline.

## 29.2 Exact allowance

Where DreamDEX requires ERC-20 allowance for buy escrow, prefer exact per-order allowance and clear unnecessary approval after placement where the protocol flow supports it.

Avoid unlimited standing allowance by default.

## 29.3 ERC-6909 operator risk

Outcome-token operator permissions must be handled narrowly.

The prior threat model identified that pool-level operator grants may span outcome IDs served by a recycled pool.

Production should verify whether per-id approvals are accepted by the DreamDEX sell escrow path and prefer the narrower model if compatible.

If not, document the residual risk and grant lazily.

---

# 30. Protocol-upgrade risk

DreamDEX core addresses may be proxy-based and change behavior.

Production must:

- dynamically resolve supported addresses where possible,
- pin known contract/API versions in evidence,
- run a lightweight compatibility/doctor check,
- fail closed on unrecognized semantics,
- and avoid silently continuing when ABI/selector behavior changes.

A protocol upgrade that invalidates a security assumption must stop agent execution until compatibility is restored.

---

# 31. Scaling requirements

AIRSPACE must be designed so 1, 10, 100, or 1,000 users can use the deployed testnet product without architectural replacement.

## 31.1 Validated scale baseline

Product-lock validation demonstrated or benchmarked:

- 100 portfolios,
- 1,000 agents,
- 10,000 intents,
- rolling market generations,
- O(1) contract access patterns for core mappings.

Production must preserve or improve these characteristics.

## 31.2 No singleton assumptions

Never assume:

- one owner,
- one portfolio,
- one agent,
- one browser,
- one demo wallet,
- one market,
- one pool,
- one venue,
- or one worker instance.

## 31.3 Backpressure

Queues and reconciliation workers must tolerate bursts.

Use bounded retries and dead-letter/error visibility.

## 31.4 Pagination

All history surfaces require pagination.

No unbounded "load every receipt" browser calls.

## 31.5 Rate limiting

Rate limit public APIs without limiting direct onchain ownership/recovery.

## 31.6 Database indexing

At minimum index common lookups by:

- portfolio address,
- owner address,
- agent address,
- domain hash,
- marketId,
- intentHash,
- txHash,
- block number,
- lifecycle status.

---

# 32. Reliability

## 32.1 RPC

Use a verified primary Somnia RPC plus fallback.

Fallback is for transport failure.

Deterministic EVM reverts must never be retried as if they were RPC failures.

## 32.2 Event backfill

At startup/reconnect:

1. load last finalized processed block,
2. backfill chain events,
3. deduplicate by tx/log index,
4. reconcile current balances,
5. resume live stream.

## 32.3 Browser reconnect

WebSocket clients should reconnect with exponential backoff.

After reconnect, fetch an authoritative application snapshot before replaying incremental events.

## 32.4 Stale state

Every major UI state should show freshness:

- live,
- delayed,
- reconnecting,
- needs reconciliation.

---

# 33. Observability

Production should instrument:

- API latency/error rate,
- RPC failures by provider,
- queue depth,
- reconciliation lag,
- lifecycle prune lag,
- portfolio stale count,
- WebSocket connection count,
- repeated job retries,
- transaction revert classes,
- agent admission/refusal counts,
- domain-limit refusals,
- owner recovery events.

Application observability must not expose secrets or private keys.

---

# 34. Evidence architecture

The repo must make every important claim traceable.

## 34.1 Root evidence principles

`evidence/README.md` maps claims to:

- transaction hashes,
- marketIds,
- block numbers,
- live receipts,
- fork tests,
- benchmarks,
- and reproduction commands.

## 34.2 Engineering archive

Root README should link to:

`engineering/README.md`

Reviewers should be able to see:

- failed earlier thesis,
- hostile findings,
- why the mechanism changed,
- final lock criteria,
- and original evidence.

This is an advantage, not clutter.

## 34.3 Production evidence campaign

Before submission, collect repeated proof across:

- accepted multi-agent intents,
- portfolio-only refusals,
- generation attacks,
- replay attacks,
- price grief,
- concurrent cap racing,
- release/re-admission,
- rolling markets,
- lifecycle cleanup,
- owner recovery,
- and scale tests.

Evidence should span many market generations rather than one favorable market.

---

# 35. Testing requirements

## 35.1 Unit tests

Cover:

- cadence canonicalization,
- domain derivation,
- policy hashing,
- local policy checks,
- global policy checks,
- reservation arithmetic,
- balance/exposure arithmetic,
- nonce/replay logic,
- exact grid math.

## 35.2 Invariant tests

Examples:

- agent can never withdraw,
- rejected intents cannot increase committed state,
- domain usage never exceeds configured limit after successful admission,
- no two reservations can jointly exceed available headroom,
- owner recovery remains callable independent of policy state,
- pool generation substitution always fails,
- uncertainty never releases capacity early.

## 35.3 Fuzz tests

Fuzz:

- quantities,
- prices,
- cadence boundaries,
- expiry offsets,
- marketNonce,
- agent counts,
- reservation sequences,
- partial-fill transitions,
- domain limits,
- nonce ordering.

## 35.4 Fork tests

Pin live Shannon blocks and test against real deployed DreamDEX contracts.

Fork tests must cover protocol behavior that mocks cannot establish.

## 35.5 Live integration

Run live Shannon proof with independent owner and agent keys.

Never claim a live proof from mocks.

## 35.6 Concurrency tests

Simulate or broadcast competing agent transactions.

Same-block fork proof is acceptable for deterministic atomicity.

Live concurrent submission should be recorded where practical.

## 35.7 Frontend E2E

Playwright or equivalent:

- connect,
- create portfolio,
- register agents,
- view policy,
- submit sample intent,
- observe blocked intent,
- observe admitted intent,
- receipt view,
- positions,
- recovery flow,
- responsive states.

## 35.8 Clean-clone reproduction

A fresh clone must be able to:

- install,
- build,
- typecheck,
- test,
- run local mocks,
- run fork tests with documented public RPC/env,
- and understand how to run live Shannon tests with funded throwaway keys.

No absolute paths.

---

# 36. CI gates

Before merge/submission:

- format,
- Solidity compile,
- Solidity tests,
- fuzz/invariant suite,
- TypeScript typecheck,
- lint,
- application build,
- unit tests,
- E2E where stable,
- secret scan,
- dependency/security scan,
- clean-clone setup verification.

Hosted CI differences should be verified once after local green.

---

# 37. Open-source contribution

The engineering process found a concrete DreamDEX bot-kit/SDK gap.

`getFills` / `getUserFills` cannot properly scope server-side by `marketId` before limit application on recycled pools.

This can silently truncate the intended market's tape.

The indexer already exposes `Fill.market_id`.

Production contribution goal:

- prepare a clean reproducible issue,
- implement/test `marketId?: string` filtering where appropriate,
- upstream PR if repository interfaces permit,
- document the measured recycled-pool failure,
- keep the separate `Order` multi-market `_in` timeout as its own report.

Do not manufacture additional contributions for optics.

If AIRSPACE integration discovers a more severe issue, prioritize the more meaningful contribution.

---

# 38. Business thesis

## 38.1 First user

A serious DreamDEX trader or builder running several independent strategies.

Examples:

- multiple proprietary bots,
- human + automated strategies,
- third-party agents,
- different time-horizon strategies,
- strategy experimentation against one capital base.

## 38.2 User value

Without AIRSPACE, a cautious operator may isolate capital:

```text
Agent A -> 500
Agent B -> 500
Agent C -> 500
```

This protects boundaries but strands capital and still provides no owner-level aggregate risk logic across systems.

AIRSPACE allows a shared pool while retaining agent isolation and adding portfolio-wide admission.

Do not publish a capital-efficiency percentage until measured.

## 38.3 DreamDEX value

AIRSPACE can:

- make multi-agent trading safer,
- reduce the operational burden of running several strategies,
- encourage more sophisticated agent participation,
- increase sustainable Event Contract activity,
- provide a reusable control layer for bot builders,
- and make DreamDEX more suitable for serious autonomous trading.

## 38.4 Monetization

Potential post-hackathon models:

- portfolio platform fee,
- usage fee on successful admitted execution,
- professional plan for advanced policies/evidence,
- SDK/API plan,
- white-label agent-fleet control for funds or trading teams.

No production fee is required for the hackathon.

Do not deploy an economically arbitrary fee solely to claim monetization.

---

# 39. Distribution

Initial distribution:

- DreamDEX bot-kit users,
- Somnia developer community,
- Algo Arena / strategy builders,
- autonomous trading-agent teams,
- prediction-market traders operating several bots.

Future distribution:

- AIRSPACE SDK,
- templates for agent frameworks,
- embeddable portfolio control surface,
- integrations with third-party bot builders,
- strategy marketplaces where capital owners want a shared enforcement layer.

---

# 40. Design principles

A separate `DESIGN.md` will define visual implementation.

Product-level principles:

1. Control plane, not trading terminal.
2. Portfolio state first.
3. The aggregate refusal must be understandable immediately.
4. Show why an action passed or failed.
5. Show authoritative versus informational data.
6. Avoid fake AI visuals and meaningless confidence scores.
7. Mobile responsive.
8. Strong empty/loading/error/reconnecting states.
9. Explorer/evidence links are first-class.
10. Use concise technical language and progressive disclosure.

---

# 41. Canonical demo

The core proof scene is frozen.

## Setup

One AIRSPACE portfolio.

Three independent agent keys.

Structural domain ceiling:

```text
500
```

## Sequence

```text
Agent A reserves 180
Domain usage: 180 / 500

Agent B reserves 240
Domain usage: 420 / 500

Agent C proposes 150
C local policy: PASS
Market checks: PASS
Price/headroom/grid: PASS

Portfolio check:
420 + 150 = 570 > 500

BLOCKED
```

C's reservation/committed state must remain unchanged after rejection.

Then safely release enough prior capacity.

The same C trade shape is retried.

```text
Current usage + 150 <= 500

ADMITTED
```

The demo must show that C is rejected only because of other agents' portfolio state.

Do not replace this with a simpler individual-agent limit demo.

---

# 42. Supporting proof scenes

The submission should also surface, quickly:

- recycled-generation attack rejected,
- replay rejected,
- price grief rejected,
- rival cannot release another agent's capacity,
- owner recovery with all agents revoked,
- rolling market enters structural domain without owner configuration,
- lifecycle cleanup/reconciliation,
- explorer receipts.

These support the central scene.

They are not separate product narratives.

---

# 43. Demo video outline

Target 2:30-3:00.

### 0:00-0:20

Problem:

> Several trading agents can each obey their own rules and still collectively overcommit your portfolio.

Show A/B/C agents.

### 0:20-0:50

Show one shared portfolio and configured domain ceiling.

A admitted.

B admitted.

Usage reaches 420/500.

### 0:50-1:25

C submits 150.

Show every local/market gate passing.

Show global domain failure:

`420 + 150 > 500`.

### 1:25-1:45

Show receipt / explorer proof and hostile agent inability to bypass the portfolio.

### 1:45-2:10

Release or reconcile prior capacity safely.

Same C intent becomes admissible.

### 2:10-2:35

Show rolling Event Contract generations entering the domain without owner configuration.

Show control room and lifecycle.

### 2:35-3:00

Show engineering archive / proof depth briefly.

Close:

> One capital pool. Many trading agents. One shared risk envelope.

---

# 44. Submission claims

Allowed claims, once production re-proves them:

- multiple independent agents can share one AIRSPACE portfolio,
- aggregate risk admission is enforced onchain,
- an individually valid trade can be rejected solely due to other agents' state,
- rolling Event Contract generations require no per-market owner admission,
- pool-generation substitution is rejected,
- owner recovery remains unconditional,
- infrastructure failure cannot weaken the onchain envelope,
- the product has deterministic adversarial proof.

Do not claim:

- AIRSPACE structurally knows BTC versus ETH when using coarse structural domains,
- all forms of portfolio risk are modeled,
- market risk is eliminated,
- agents cannot lose money,
- Reactivity is required for safety,
- mainnet production readiness unless separately audited/deployed,
- audited contracts unless a real audit occurs.

---

# 45. Known limitations

These should remain visible.

1. Structural domains are coarser than semantic assets. Sibling series may intentionally share a ceiling.
2. Rapid 60-second series require lifecycle pruning for liveness.
3. Some mappings grow monotonically, though core access remains O(1). Production should bound what can be bounded.
4. Same-block concurrency has deterministic fork proof. Live concurrent transactions may still land several blocks apart.
5. The 10,000-intent scale benchmark used mocks for throughput. Protocol-specific correctness remains covered separately by live/fork evidence.
6. Reactivity funding-floor enforcement was unresolved at product lock.
7. Contracts in `engineering/` are hostile-validation prototypes and are not audited production deployments.
8. AIRSPACE constrains agents, not a compromised owner key.
9. DreamDEX proxy upgrades can invalidate assumptions and require compatibility checks.
10. Domain-level risk accounting is intentionally conservative and is not a statistical portfolio-risk model.

---

# 46. Production infrastructure constraints

The production build must use:

- Cloudflare for web/backend/lifecycle infrastructure,
- Supabase Postgres for durable application data,
- Somnia Shannon for hackathon contracts,
- DreamDEX Event Contracts for execution.

Do not use:

- Railway,
- Vercel,
- laptop-only keepers,
- hardcoded local services.

If a required workload cannot fit Cloudflare's execution model, document the exact blocker before introducing another infrastructure provider.

---

# 47. Repository documentation requirements

Root must include:

- `README.md`
- `PRD.md`
- `DESIGN.md`
- `ARCHITECTURE.md`
- `SECURITY.md`
- `CONTRIBUTIONS.md`
- `DECISIONS.md`
- `SETUP.md`

Also:

- `engineering/README.md`
- `evidence/README.md`

README should lead with:

- what AIRSPACE is,
- why it exists,
- the core A/B/C proof,
- deployed URL,
- contract addresses,
- live evidence,
- quick architecture,
- reproduction commands.

Do not lead with test count.

---

# 48. Deployment requirements

## Contracts

- deploy production contracts to Shannon,
- verify exact bytecode/source where explorer support allows,
- record addresses and deployment block,
- create funded real portfolio,
- register independent sample agents,
- execute live accepted and rejected sequences.

## Web

- deploy to Cloudflare,
- custom domain optional,
- no localhost dependencies,
- environment variables documented,
- secrets stored in Cloudflare/Supabase secret systems.

## Database

- migrations committed,
- RLS defined,
- production seed avoids fake claims,
- public chain state can be backfilled.

---

# 49. Definition of production-grade for this hackathon

A production-grade AIRSPACE hackathon build means:

- a new user can open the deployed site,
- connect a wallet,
- understand the mechanism,
- create a portfolio,
- fund it,
- register several agents,
- configure shared limits,
- run sample or external agents,
- observe live admissions/refusals,
- inspect receipts,
- inspect positions/reservations,
- survive page refresh,
- survive worker restart,
- survive stream reconnect,
- reconcile lifecycle state,
- recover owner assets,
- and reproduce core claims from the public repository.

It must not depend on the builder manually running a hidden terminal process for the demo.

---

# 50. Definition of done

AIRSPACE is complete for submission only when all are true.

## Contracts

- production portfolio/factory implemented,
- generation binding preserved,
- structural domains preserved,
- cadence canonicalization preserved,
- multi-agent registry implemented,
- local/global/domain policies implemented,
- atomic reservation implemented,
- reconciliation-safe accounting implemented,
- owner recovery implemented,
- all core invariants green.

## DreamDEX

- live accepted order,
- live aggregate portfolio rejection,
- live or fork generation rejection,
- live/fork replay rejection,
- real ERC-6909 position ownership,
- lifecycle through cancellation/expiry/finalization where available,
- redemption proof where naturally available before submission.

## Backend

- Cloudflare API deployed,
- lifecycle worker deployed,
- queue/retry path deployed,
- reconciliation running,
- stale-state handling working,
- Supabase migrations applied,
- no Railway/Vercel dependency.

## Frontend

- landing complete,
- onboarding complete,
- portfolio creation complete,
- agent registration complete,
- control room complete,
- incoming-intent gate view complete,
- receipt view complete,
- reservations/positions complete,
- recovery complete,
- responsive mobile/tablet/desktop,
- polished loading/error/empty/reconnecting states.

## Scale/reliability

- 100 portfolio deterministic benchmark,
- 1,000 agent deterministic benchmark,
- 10,000 intent deterministic benchmark,
- idempotent event ingestion,
- queue backpressure tests,
- reconnect/backfill test,
- no global singleton application state.

## Security

- unit/fuzz/invariant/fork/live tests green,
- compromised-agent attack suite green,
- owner recovery independent of lifecycle infrastructure,
- secret scan green,
- dependency/security scan green,
- no committed private keys.

## Repo

- README complete,
- ARCHITECTURE complete,
- SECURITY complete,
- CONTRIBUTIONS complete,
- DECISIONS complete,
- SETUP complete,
- evidence linked,
- engineering archive linked,
- clean-clone reproduction verified.

## Submission

- deployed URL works,
- GitHub public,
- repo description/topics/deployed URL set,
- 2-3 minute demo recorded,
- deck optional but recommended,
- feedback report prepared if meaningful,
- submission claims match actual evidence,
- all public surfaces tell the same story.

---

# 51. Build order

Production implementation should follow this order:

1. Port and clean the validated contract boundary.
2. Port structural-domain derivation and cadence canonicalization.
3. Port reservation/reconciliation invariants.
4. Build the full production Solidity test suite.
5. Deploy a production-candidate contract to Shannon.
6. Build DreamDEX adapter and AIRSPACE SDK.
7. Build Cloudflare lifecycle/reconciliation services.
8. Build Supabase schema and event ingestion.
9. Build sample agents.
10. Build the web product against real contract/API state.
11. Add Reactivity only if it materially improves lifecycle and the subscription can be funded.
12. Run repeated live evidence campaign.
13. Run adversarial audit.
14. Complete documentation and clean-clone reproduction.
15. Record demo, deck, and submission.

Do not let frontend implementation redefine contract semantics.

Do not let backend convenience weaken onchain safety.

---

# 52. Change-control rule

AIRSPACE is product locked.

A change to the dominant mechanism requires one of:

- a discovered correctness flaw,
- a new DreamDEX protocol fact invalidating an assumption,
- a direct competitor making the product non-distinct,
- or evidence that a requirement cannot be implemented honestly.

Normal implementation questions do not reopen idea discovery.

Feature additions must pass the removal test:

> If this feature disappears, does AIRSPACE's core product become less correct, less useful, less comprehensible, or materially less competitive?

If no, it is optional and must not delay correctness work.

---

# 53. Final product statement

AIRSPACE is the shared execution boundary between a capital owner and a fleet of independent DreamDEX Event Contract agents.

Each agent may be individually valid.

AIRSPACE decides whether the portfolio can afford them together.

The safety boundary is onchain.

The risk domains are structural.

Reservations happen before value can move.

Actual positions are reconciled against DreamDEX state.

Liveness may use Cloudflare and Somnia Reactivity.

Safety never depends on them.

**One capital pool. Many trading agents. One shared risk envelope.**
