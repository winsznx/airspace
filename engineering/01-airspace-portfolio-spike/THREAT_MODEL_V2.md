# THREAT_MODEL_V2.md

Adversary: **one or more agent keys fully compromised**, signing anything, at any
time, with full knowledge of the policies, the other agents' positions and the
protocol. The owner key is honest. The question for every row: can portfolio
capital leave the envelope, or can the envelope be made to lie?

---

## 1. Direct custody attacks — closed

| Attack | Result | Proof |
|---|---|---|
| Agent withdraws collateral | `NotOwner` | live + fork `C1` |
| Agent withdraws outcome tokens | `NotOwner` | live + fork `C1` |
| Agent calls `ownerCall` | `NotOwner` | live + fork `C1` |
| Agent calls the pool directly | No funds, no standing allowance. Escrow is approved for the exact amount of one order and zeroed immediately after placement | code |
| Agent transfers ERC-6909 out | The portfolio never grants an agent operator status on the outcome singleton | code |
| Unregistered caller executes | `NotAgent` | fork `C4` |
| Disabled agent executes | `AgentDisabled` | fork `C5` |

## 2. Attacks on the envelope itself — the interesting ones

Every call here is one the agent is *permitted* to make. No privilege escalation
is involved; the attack is on the accounting.

| Attack | Defence | Proof |
|---|---|---|
| **Split an oversized position across agents.** Three agents each stay inside their own ceiling; the sum breaches the portfolio's | `BucketDirectionalExceeded` -- ceilings ladder and the bucket total is measured across all agents | **live**: 180 + 240 + 150 > 500 |
| **Hide exposure in unfilled orders.** Rest orders that individually pass, planning for them all to fill later | Full potential exposure is reserved *before* placement; `reserved == filled + resting + cancelled` | **live** (A and B were both unfilled resting orders) + fork `R1` |
| **Free headroom by claiming an order died** | `releaseOrder` reads `getOrder`; a live order reverts `OrderStillLive`. The caller supplies no numbers | **live** (C attacked A's live order) + fork `R4` |
| **Release another agent's reservation** | Same gate. Release is permissionless but non-discretionary | **live** |
| **Widen a ceiling** | `setBucketPolicy` is `onlyOwner` | **live** |
| **Rewrite another agent's policy** | `setAgent` is `onlyOwner` | **live** + fork `C2` |
| **Admit a market into a different bucket** to dodge a saturated one | `admitMarket` is `onlyOwner` | **live** + fork `C2` |
| **Trade an unadmitted market** so exposure is untracked | `MarketNotAdmitted` -- default deny | fork `C6` |
| **Impersonate another agent** to charge their budget | Identity is `msg.sender`; the intent hash binds the caller | fork `C3` |
| **Trade a recycled pool's later generation** | `GenerationMismatch` -- `marketNonce` plus derived outcome ids must match the admission | **live** + fork `C7` |
| **Substitute a different pool** | `PoolMismatch` against the module registry | **live** + fork `C7` |
| **Replay a used intent** | `IntentReplayed` | **live** + fork `C8` |
| **Price grief** | `PriceOutsidePolicy` (agent *and* portfolio ceilings) | **live** + fork `C9` |
| **Off-grid price to burn gas** | `OffTickGrid` / `OffLotGrid` read from the pool | fork (FLIGHTPATH suite) |
| **Expiry snipe** | `InsufficientHeadroom` | code + fork |
| **Burst spam** | `CooldownActive` per agent | code |

## 3. Residual risks — accepted and disclosed

**R1. Risk-bucket membership is owner-attested.** No on-chain view maps a
`marketId` to an asset; see `RISK_IDENTITY.md` for the exhaustive search. An
owner who mis-labels a market mis-buckets their own risk. Agents cannot forge it,
default is deny, and the attestation is publicly falsifiable against creation
events. It is labelled `OFFCHAIN_WITNESS` in every receipt. **This is the single
largest honesty caveat in the system.**

**R2. Shared capital means agents can grief each other.** A compromised agent can
consume portfolio headroom with resting orders, starving honest agents until the
owner cancels and someone calls `releaseOrder`. This is inherent to a shared
capital base -- it is the product, not a bug -- and it is bounded by per-agent
`maxCommitted` and `maxOrderNotional`. It is a **liveness** attack, never a
solvency one: no capital leaves.

**R3. `totalResting` over-counts after a silent maker fill.** When a resting
order is filled by an incoming taker, that happens in a transaction AIRSPACE
never executes, so the tracked escrow stays until `releaseOrder` is called.
Committed capital is unaffected (it is measured from balances), so only the
`maxRestingReservation` ceiling is affected, and only by being too strict.
Conservative in the safe direction.

**R4. Gross bucket aggregation over-counts genuine hedges.** Long BTC in the
15-minute window and short BTC in the daily window sum rather than net, because
they resolve at different times against different prices. Deliberate: netting
would understate.

**R5. Per-agent attribution of realized positions is not attempted.** Once two
agents buy YES in the same market the tokens are fungible. `agentCommitted`
describes capital deployed, not position ownership. Labelled `UNKNOWN`.

**R6. ERC-6909 operator grants are per-pool, not per-id.** A sell requires
`setOperator(pool, true)` on the shared outcome singleton, which lets that pool
move any outcome id the portfolio holds. Pools are recycled, so a pool granted
for market N can in principle act on holdings from markets it later serves. This
is a protocol-shape constraint, not a design choice -- the ERC-6909 operator
model has no per-id form. Mitigated by granting lazily, only on first sell, only
to the pool bound to an admitted market.

**R7. Bucket iteration is bounded but not free.** `bucketGross` loops the
bucket's admitted markets, capped at `MAX_MARKETS_PER_BUCKET = 32`. Measured
`execute` cost with two admitted markets was 2.7-3.4M gas; a full 32-market
bucket will be materially higher. Bounded, so it cannot be griefed into
unbounded cost, but it is not cheap.

**R8. Owner key compromise is total.** `ownerCall` is arbitrary by construction.
AIRSPACE constrains agents, not owners, and claims nothing about owner-key
security.

**R9. Protocol upgrade risk.** Every DreamDEX core address is an upgradeable
proxy. The `markets()` tuple shape and the outcome-id encoding
`(pool << 72) | (nonce << 8) | idx` are load-bearing assumptions. A change to
either would silently break gates that currently hold. Production needs an
upgrade watch on the module and pool implementations.

**R10. Venue risk is unmitigated.** AIRSPACE bounds agent behaviour. It does
nothing about oracle failure, stuck resolution, voided markets or venue
insolvency. A portfolio that loses money because BTC moved is not protected by
any of this.

**R11. Reactivity is liveness-only, and unbuilt.** Nothing in the safety argument
depends on a subscription firing. See `AIRSPACE_FINDINGS.md` §6.

---

## 4. What would change the verdict

The enforcement boundary held under every attack tested, live and on fork. The
weak points are not in the contract: they are the owner-attested bucket identity
(R1) and the per-market admission burden on fast rolling markets, both of which
are addressed in `VERDICT_V2.md`.
