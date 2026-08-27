# AIRSPACE_LOCK_REPORT.md

Final product-lock validation.

**AIRSPACE — one capital pool. Many trading agents. One shared risk envelope.**

Several independently controlled DreamDEX Event Contract agents share one capital
base. Every proposed order must pass both its local agent policy and atomic
portfolio-wide admission. An individually legal order is rejected when reservations
or positions created by other agents have already consumed portfolio risk capacity.

The dominant mechanism is **cross-agent portfolio admission + reservation +
post-trade reconciliation**. It is not an AI trader.

Chain: Somnia Shannon, chainId 50312. Date: 2026-08-27.
Prior FLIGHTPATH and AIRSPACE reports are retained unchanged.

---

## 1. What changed since the REVISE

The REVISE had two open items. Both are closed.

**Semantic asset attestation is gone from the security path.** The previous
revision required the owner to declare "this market is BTC" and to admit each
market individually. Risk domains are now `keccak256(creator, collateral,
canonicalCadence)`, derived from the module registry during execution. No indexer,
no owner-supplied asset string, no event-log attestation, no trusted relayer, no
per-market admission transaction. Details and validation: `STRUCTURAL_DOMAINS.md`.

**Rolling markets scale.** One `setDomainPolicy` call covers every market that
series will ever roll. 500 consecutive 60-second generations were driven through the
contract with zero configuration between them, and the iterated collection never
exceeded one entry. Details: `SCALING_REPORT.md`.

The contract has a new name (`AirspacePortfolio`) because the state model changed,
not just the policy surface.

---

## 2. The eleven LOCK conditions

| # | Condition | Result | Evidence |
|---|---|---|---|
| 1 | Structural domains need no semantic attestation or per-market admission | **PASS** | `domainOf` derived on-chain; live `ownerTxSinceConfig: 0`; `test_D5` |
| 2 | Rolling markets enter the correct domain automatically | **PASS** | `test_S4` — 500 generations, same domain, zero config |
| 3 | Independent agents share one capital base under unbypassable aggregate enforcement | **PASS** | live, 3 agents; all capital in one contract |
| 4 | An individually valid order is live-rejected solely due to other agents' state | **PASS** | live `DomainRiskExceeded`, `agentCommitted[C]` unchanged |
| 5 | Concurrent agents cannot race through global headroom | **PASS** | fork same-block `X2`/`X3`/`X3b`; live race, B reverted on-chain |
| 6 | Reservation accounting cannot understate real commitment | **PASS** | `test_R7` — external fill overstates, converges |
| 7 | Real outcome balances safely reconcile filled exposure | **PASS** | positions measured from ERC-6909; `R2`, `R7` |
| 8 | Owner recovery unconditional | **PASS** | live, all agents revoked, residual 0 |
| 9 | Meaningfully distinct from Vane | **PASS** | Vane has a singular `operator()` slot and no aggregation surface |
| 10 | Scale to 100 portfolios / 1,000 agents / 10,000 intents | **PASS** | `S1`/`S2`/`S3` |
| 11 | Concrete DreamDEX user and sponsor value | **PASS** | `I1`/`I2`/`I3`, derived not asserted |

**76 tests pass**: 29 LOCK fork + 5 scale + 3 sponsor (new), plus 39 preserved from
the earlier spikes.

---

## 3. The mechanism, stated precisely

Three properties carry the design.

**One contract holds all capital.** Aggregate admission must be atomic and
unbypassable. If capital sat in per-agent child accounts, each would have to
volunteer to consult a coordinator, and one that did not — a bug, an upgrade, a
different implementation — would spend shared capital outside the envelope. Here
there is no second place capital can live, so the check is a storage read in the
same transaction that moves the money. Reservation and placement are one call, so
there is no read-before-write window.

**Risk domains are structural.** `keccak256(creator, collateral, cadenceSec)`,
where cadence is canonicalised from `expiry - tradingStart` by an exact rule: the
smallest canonical value `C` with `C >= window` and `expiry % C == 0`. Validated
against 1,200 consecutive live markets — zero unresolved, and two real 898-second
late-roll markets correctly absorbed into the 900-second domain rather than forming
an unenforced domain of their own.

**Live position state is read, not accumulated.** `getOrder` reverts identically
for a filled and a cancelled order, so a running counter cannot stay correct once
fills land in transactions the contract never sees. Realized positions come from
the ERC-6909 singleton; storage holds only unfilled reservations, which the
contract created itself.

---

## 4. Terminology discipline

The contract computes a **cadence domain**. It does **not** know BTC from ETH and
nothing in this repository claims it does. Sibling series of the same cadence from
the same creator resolve to the same domain — proven live, `domainOf(0xb278) ==
domainOf(0xb277)` — and that is intentional. An agent cannot escape a saturated
ceiling by switching to the sibling market.

Off-chain labels may exist for humans and are marked **NON_AUTHORITATIVE**. They
never enter enforcement.

`freeCollateral`, `reservedCollateral`, `committedCapital`,
`marketDirectionalExposure`, `domainRiskUsage` and `globalRiskUsage` each have one
meaning, one unit and one source. "Risk", "exposure", "capital" and "notional" are
not used interchangeably. See `PORTFOLIO_ACCOUNTING_V2.md`.

---

## 5. The TAPE result, reproduced

Within one binary market, complete YES+NO holdings carry zero directional outcome
exposure, and directional state derives from the YES/NO imbalance:

```
marketDirectionalExposure = (balYes + openBuyYes - openSellYes)
                          - (balNo  + openBuyNo  - openSellNo)
```

A complete set nets to zero by construction. Exposure is **not** netted across
markets that merely share a structural domain — `domainRiskUsage` sums absolute
values, which can only overstate.

---

## 6. Sponsor and user impact

Deterministic simulation driven by the real contract under its real policy rules,
with an explicitly stated demand schedule (three strategies with staggered peaks).
Nothing is hand-asserted.

```
SHARED    1 pool,  300-contract domain ceiling  ->  6/6 intents admitted, 0 rejected
ISOLATED  3 vaults, same 300 total split 3 ways ->  3 admitted, 3 REJECTED
ISOLATED  3 vaults, each funded to its own peak ->  6/6 admitted, needs 900 contracts

risk budget required: isolated 900 vs shared 300  =  3.0x   (derived from the schedule)
```

**Why a serious DreamDEX algo trader would use this.** Running four strategies today
means four funded vaults and four disjoint risk budgets. Capacity idle in one cannot
serve a peak in another, and nothing stops the four collectively taking a position
larger than the operator would ever authorise as a whole. AIRSPACE gives one funded
pool, one enforced ceiling, and per-agent sub-limits — so strategies can be added,
rented, or swapped without re-funding or re-splitting the budget, and a compromised
or malfunctioning strategy is bounded by portfolio state rather than by its own
honesty.

**Why DreamDEX would want it to exist.** It removes a structural cap on how much
algorithmic capital a single operator will commit to Event Contracts. An operator
who must pre-fund each strategy to its own peak funds the sum of peaks; one who can
share a pool funds the maximum concurrent peak. On the modelled schedule that is 3x
less capital required for the same trading activity — or the same capital supporting
more strategies. It also makes multi-strategy participation legible: the receipt
chain ties every fill to an agent, a policy hash and a portfolio, which is what an
allocator or a venue needs before it will let third-party strategies touch capital.

Labelled MODELLED. The schedule is the assumption; every count is contract output.

---

## 7. Reactivity

Re-checked, not assumed. `@somnia-chain/reactivity` latest is **0.2.1** (npm,
modified 2026-08-04) — no newer release.

**It is live on Shannon.** `getSubscriptionInfo(1)` on the precompile
`0x…0100` returns a real active subscription:

```
handler selector  0x53edf33d   onEvent(address,bytes32[],bytes)
priorityFeePerGas 2 gwei
maxFeePerGas      10 gwei
gasLimit          5,000,000
isGuaranteed      true
```

The precompile has no bytecode by design, so `eth_getCode` returns `0x` and presence
cannot be probed that way — this read is the direct evidence.

**Funding prerequisite:** the SDK enforces a **32 SOMI/STT minimum owner balance**
before creating a subscription (`parseEther("32")`, still present in 0.2.1). This
spike's OWNER holds 29.17 STT, below the floor, so a subscription was not created.
Per the brief, the verdict is not blocked on funding. Whether the floor is enforced
by the precompile itself or only client-side remains **unresolved** — a `subscribe`
simulation from a below-floor account reverts for unrelated reasons (placeholder
handler), so the question is recorded rather than guessed.

**Where it earns its place — all liveness, never safety:**

| Use | Trigger |
|---|---|
| Finalization detection | market resolution event → `releaseSettled` |
| Expired reservation cleanup | scheduled wake near expiry → `releaseOrder` |
| Redemption readiness | resolution event → notify owner to `redeem` |
| Portfolio headroom refresh | order-book fill events → `releaseOrder` on stale reservations |

**Safety is independent of it.** Every release path is already permissionless and
provable, so any keeper, agent or cron can drive it, and if Reactivity never fires
the only consequence is that headroom stays conservatively occupied until someone
calls. Nothing in the safety argument depends on a subscription.

**Production integration:** deploy a thin handler implementing
`onEvent(address,bytes32[],bytes)` that dispatches to `releaseOrder` /
`releaseSettled` / `pruneMarket` on the portfolio, subscribe with the portfolio's
pool set as `emitter` filter, and fund the subscribing account with **at least 32
STT** plus callback gas at `gasLimit` × `maxFeePerGas`. Not built in this spike.

At the 60-second cadence a keeper is not optional regardless of mechanism: without
pruning, a continuously trading portfolio reaches the 48-market domain cap in about
48 minutes and fails closed.

---

## 8. Known limits and residual risks

Full treatment in `THREAT_MODEL_V2.md` (still accurate) plus:

- **Domains are coarser than assets.** A ceiling covers both sibling series at a
  cadence. Separate BTC and ETH limits are not expressible on the current protocol
  surface, and `RISK_IDENTITY.md` records the 304-selector search that established
  why. This is a real product limitation, chosen over putting an attestation in the
  security path.
- **Two mappings grow monotonically** (`intentUsed`, `_orders`). Neither is ever
  iterated, so gas per operation is O(1) in history; only storage grows. A monotonic
  per-agent nonce would bound replay protection to one slot per agent — recorded,
  not shipped.
- **`reservedCollateral` over-counts** after a maker fill the portfolio never saw,
  until `releaseOrder` runs. `committedCapital` is unaffected because it is measured.
- **Shared capital means agents can grief each other** for headroom. Inherent to the
  product, bounded by per-agent ceilings, and a liveness rather than solvency issue.
- **Owner key compromise is total.** AIRSPACE constrains agents, not owners.
- **Protocol upgrade risk.** The `markets()` tuple shape and the outcome-id encoding
  are load-bearing assumptions about upgradeable proxies.
- **Venue risk is unmitigated.** Oracle failure, stuck resolution and voided markets
  are outside scope.

---

## 9. Document map

| File | Contents |
|---|---|
| `VERDICT_V3.md` | the verdict |
| `STRUCTURAL_DOMAINS.md` | domain derivation, cadence canonicalisation, validation |
| `PORTFOLIO_ACCOUNTING_V2.md` | the six quantities, measured vs tracked |
| `RESERVATION_INVARIANTS.md` | state machine and per-invariant proofs |
| `SCALING_REPORT.md` | gas, storage growth, bounded-collection analysis |
| `COMPETITOR_LOCK_DELTA.md` | the reduction test, Vane from bytecode |
| `LIVE_LOCK_EVIDENCE.md` | transaction hashes and expected state |
| `evidence/airspace-lock/` | raw artifacts |
