# THREAT_MODEL.md

Adversary: **the agent key is fully compromised.** It signs whatever it wants, at any
time, with knowledge of the policy and the protocol. The owner key is honest. The
question for every row is whether user capital can leave the envelope.

---

## 1. Direct custody attacks — closed

| Attack | Outcome | Proof |
|---|---|---|
| Agent calls `withdraw()` | `NotOwner` | live + broadcast `0x8c1f3d5c…` |
| Agent calls `withdrawOutcome()` | `NotOwner` | live |
| Agent calls `ownerCall()` to sweep | `NotOwner` | live |
| Agent calls `setAgent()` to entrench | `NotOwner` | live |
| Agent calls `setPolicy()` to widen limits | `NotOwner` | fork `N3` |
| Agent calls the pool directly | No funds, no allowance. The account approves the pool for the exact escrow of one order and zeroes it immediately after placement, so there is no standing allowance to spend | code + live |
| Agent transfers ERC-6909 out | The account never grants the agent operator status on the outcome singleton | code |
| Third party calls `execute()` | `NotAgent` | live |

## 2. Semantic attacks — the interesting ones

These are the attacks that a naive "agent guardrail" misses, because they involve no
privilege escalation at all: every call is one the agent is *allowed* to make.

| Attack | Defence | Proof |
|---|---|---|
| Trade a **different market** the agent prefers | `MarketNotBound` (EXACT binding) | live |
| Point at a **different pool** for the bound market | `PoolMismatch` — pool must equal the module registry's pool | live |
| Trade a **recycled pool's later generation**. The pool address is still "allowed"; only the generation changed. This is the attack a pool allowlist cannot see | `GenerationMismatch` — `pool.marketNonce()` must match, *and* the registry's `yesId`/`noId` must equal ids derived from `(pool, nonce)` | live |
| **Price grief**: cross the book at a terrible price to bleed the owner | `PriceOutsidePolicy` | live |
| **Size grief**: one enormous order | `OrderNotionalExceeded` | broadcast `0x8d360c2d…` |
| **Death by a thousand cuts**: many in-limit orders | `ExposureExceeded` on aggregate | fork `N6` |
| **Burst spam** to churn fees | `CooldownActive` | fork `N14` |
| **Expiry sniping**: fire seconds before the window locks, when the book is thin and cancellation may not land | `InsufficientHeadroom` | fork `N15` |
| Trade a market that has **resolved or voided** | `MarketNotTrading` — composed from `pool.finalized()`, `market.isResolved()`, `market.isVoided()`, and the time window | fork `N16` |
| Trade the **wrong cadence** series | `CadenceMismatch` — `expiry - tradingStart` from the chain | fork `N8` |
| Trade the **wrong asset** (SERIES mode) | `AssetMismatch` — asset string read from `MarketCreator.seriesById` | fork `N9`; **partial, see §3** |
| **Replay** a signed intent | `IntentReplayed` | live |
| Push an **off-grid price** to trigger `InvalidPrice` and burn gas | `OffTickGrid` / `OffLotGrid` | live |
| Set order expiry **beyond the market** to leave escrow stranded | `OrderExpiryInvalid`, capped at `pool.marketExpiryNs()` | code |

---

## 3. Residual risks — accepted and disclosed

These are real. None of them is hidden in a footnote in the product copy.

**R1. Sibling-asset substitution in `BindMode.SERIES`.** Series 1 (BTC/900s) and 2
(ETH/900s) share creator, collateral, cadence and expiry. Given a `marketId`, on-chain
data cannot say which produced it. An agent in SERIES mode can present the sibling
asset's market and pass every check. *Mitigation:* EXACT is the default and the only
mode advertised as fully structural. SERIES should be labelled "cadence-and-venue
bound, asset best-effort" or dropped.

**R2. `deployedNotional` is a committed-capital counter, not a risk number.** It does
not net, does not mark to market, and does not decrement on sells or redemptions. It
bounds max loss for a single bound market. It is not portfolio risk management and
must not be sold as such.

**R3. Escrow in resting orders is owner-recoverable but not agent-recoverable.**
`cancelOrder` is `onlyOwner` by design — cancellation frees escrow and is part of
capital recovery. Consequence: a compromised agent can strand capital in resting
orders until the owner cancels or the order ages off at market expiry. Capital is
never *lost*, but it can be temporarily immobilised. Making cancel agent-callable
would trade this for a griefing vector (cancel-spam against the owner's fills); the
current choice is deliberate. Permissionless `cancelExpiredOrders` on the pool means
anyone can clean up after expiry.

**R4. ERC-6909 operator grant to the pool is per-pool, not per-market.** A sell
requires `setOperator(pool, true)` on the shared outcome singleton, which lets that
pool move *any* outcome id the account holds. Since pools are recycled, a pool the
account granted for market N can, in principle, act on holdings from other markets it
later serves. This is a protocol-shape constraint, not a FLIGHTPATH choice — the
grant has no per-id form in the ERC-6909 operator model. *Mitigation:* the account
grants lazily, only on the first sell, and only to the pool bound to the policy's
market. A stricter build would use per-id `approve` instead of `setOperator`; that
needs verification that the pool's escrow path accepts allowances rather than
operator status.

**R5. Owner key compromise is total.** `ownerCall` is arbitrary. This is by
construction: the owner already owns every asset. FLIGHTPATH constrains agents, not
owners, and claims nothing about owner-key security.

**R6. Protocol upgrade risk.** Every DreamDEX core address is a proxy that can roll
forward. A change to `markets()` field order, the outcome-id encoding, or the escrow
path would silently break gates that currently hold. The account reads structure
rather than hardcoding where it can (`oneCollateral`, tick/lot grid, `marketExpiryNs`),
but the `markets()` tuple shape and the id encoding are load-bearing assumptions. Any
production deployment needs an upgrade watch on the module and pool implementations.

**R7. The account is the trader of record, so venue-level risk is unmitigated.**
FLIGHTPATH bounds *agent* behaviour. It does nothing about oracle failure, a stuck
resolution, a voided market, or venue insolvency. A user who loses money because BTC
moved is not protected by any of this, and the product must not imply otherwise.

**R8. `strategyVersion` is unverified.** See `AUTHORITY_MODEL.md` §4. It is agent-supplied
metadata with no on-chain attestation.

---

## 4. What would change the verdict

The enforcement boundary itself is not the weak point — it held under every attack
tested, live and on fork. The weak point is competitive positioning
(`COMPETITOR_DELTA.md`), which no amount of contract hardening fixes.
