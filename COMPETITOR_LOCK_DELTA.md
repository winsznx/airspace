# COMPETITOR_LOCK_DELTA.md

The final differentiation test. Every claim about Vane here comes from its
**deployed bytecode** on Shannon, not its README.

---

## 1. The reduction test

> **If AIRSPACE can be reduced to "Vane + multiple operator addresses + one global
> `uint256`", KILL.**

It cannot, and the reason is specific rather than rhetorical: **the "one global
`uint256`" is exactly the construction that does not work.** I know because I built
it first and the fork tests broke it.

A single aggregate counter has to be incremented on reservation and decremented on
termination. To decrement correctly you must know whether a terminated order
**filled** or was **cancelled** — a filled order keeps its exposure, a cancelled one
returns it. `IOrderBook.getOrder` reverts `IncorrectOrder()` **identically for
both**. With several agents, and maker fills landing in transactions the contract
never executes, that question is unanswerable after the fact.

The counter version silently understates risk the moment a resting order fills
externally. The correct construction is not a counter at all:

```
domainRiskUsage(d) = Σ over markets m in d of | balanceOf(YES_m) + resYesLong - resYesShort
                                             - balanceOf(NO_m)  - resNoLong  + resNoShort |
```

An O(markets) aggregate, measured from the ERC-6909 singleton at check time, with
only unfilled reservations in storage. That is a different state model, not a wider
variable. `test_R7_externalFillCannotUnderstateRisk` is the proof: an external fill
pushes measured usage 20 → 40 contracts (overstating, the safe direction) and
converges to 20 after reconciliation. A `uint256` counter would have read 20 the
whole way through while the portfolio actually held 20 *and* owed 20.

---

## 2. Vane, re-inspected from bytecode

Factory `0xc17da7a28Ea556f6BfA7a774d9Da486C41574b43`, 13,867 bytes, live on Shannon.

**Confirmed present** — Vane is a real DreamDEX Event Contract vault:

```
0x718c2d4d  placeBinaryOrder(...)                  present
0x53edf33d  onEvent(address,bytes32[],bytes)       present   (Reactivity handler)
0x54657dd2  mintSet(address,address,uint256)       present
0x2e1a7d4d  withdraw(uint256)                      present
0xcd3293de  reserve()                              present   ("the reserve it will never spend")
```

**Operator cardinality — the decisive read:**

```
0x570ca735  operator()          present     <- a SINGULAR address slot
0xb3ab15fb  setOperator(address) present     <- sets THE operator
0x13e7c9d8  operators(address)  ABSENT
0x9870d7fe  addOperator(address) ABSENT
0xac8a584a  removeOperator(address) ABSENT
0x6d70f7ae  isOperator(address) ABSENT
```

(`setOperator(address,bool)` also appears, but that is Vane *calling*
`OutcomeToken6909.setOperator(pool, true)` — a call target in its own code, not an
entrypoint of its own.)

**Portfolio/risk aggregation — absent entirely:**

```
totalExposure()      ABSENT
maxExposure()        ABSENT
reservedCollateral() ABSENT
budget()             ABSENT
windowBudget()       ABSENT
domainRiskUsage()    ABSENT
```

Vane's authority model is one `address` slot. Its risk model is a per-window scalar
budget plus a reserve, scoped to one market at a time, with a **pool allowlist** for
market selection.

---

## 3. Same custody primitive, different product mechanism

I will not overstate the gap. **Both hold capital in an owner-controlled contract
and let a key that holds nothing propose orders.** That custody primitive is shared,
and the existence of contract custody is not a differentiator — the previous spike's
REVISE said exactly that.

The mechanism sitting on top is what differs.

| | Vane | AIRSPACE |
|---|---|---|
| Operator cardinality | one `address` | `mapping(address => AgentPolicy)`, per-agent ceilings and attribution |
| Enforcement subject | this agent's spend | **this portfolio's risk surface, across all agents** |
| Market selection | pool allowlist | structural domain `(creator, collateral, canonical cadence)` derived per execution |
| New generation | needs a new pool in the allowlist | admissible automatically, zero config |
| Exposure state | scalar per-window budget | O(markets) aggregate measured from ERC-6909 |
| Reservation release | one operator can manage its own | permissionless, non-forgeable, `getOrder`-driven |
| Cross-agent rejection | not expressible | the product |

### What Vane would have to redesign

| Area | Change required |
|---|---|
| **Operator cardinality** | `address` → mapping with per-agent policy, committed accounting and identity-bound intent hashing |
| **Shared portfolio state** | new: a domain abstraction spanning many markets and generations, with a bounded, prunable market set |
| **Cross-agent atomic reservation** | new: worst-case reserve-then-place in one call, with the `reserved == filled + resting + cancelled` partition |
| **Portfolio-wide reconciliation** | new: measure fills from balance deltas, resting from `getOrder`, and reconcile the reservation to both |
| **Risk-domain accounting** | pool allowlist → canonical-cadence derivation; scalar budget → measured Σ\|directional\| |

That is a multi-agent portfolio scheduler with a new shared reservation and
reconciliation model. It is not out of reach for a competent team — I estimate a
week of careful work — but it is a rewrite of what the contract *tracks*, not a
feature flag. Vane's pool allowlist in particular is bound to a mutable slot: one
observed pool served **52 distinct markets across both BTC and ETH**, so the
allowlist cannot even express "this series, forever" — the property AIRSPACE's
domain derivation exists to provide.

---

## 4. The rest of the field

| Project | Custody | Multi-agent shared capital | Cross-agent aggregate enforcement |
|---|---|---|---|
| **Vane** | yes | no (one operator) | no |
| **Branch** (`nftkingiii/branch`) | **no** — wallet signatures stay client-side | no | no |
| **Sentry** (`Timidan/sentry-somnia`) | no — "does not hold funds, does not execute" | n/a | no |
| **Lictor** (`winsznx/lictor`) | yes | no — single-shot spot mandate | no |
| **Fief** (`winsznx/fief`) | no — signal rental, renters execute themselves | many agents, no shared capital | no |
| rampart / Lucid ai-vault | no | n/a | no |

Two worth restating: **Sentry** is self-policing — the gate runs inside the agent's
own dispatch path, so its authority is that contract's willingness to call it, and
it holds nothing to withhold. **Branch** is the only other project reasoning across
multiple windows on this venue, but its multi-window logic is *sequential
conditionality* (leg 2 unlocks if leg 1 settles as predicted), not *simultaneous
aggregation*, and it is non-custodial.

Nothing public enforces a ceiling spanning several independently executing agents
over one capital base. Checked 2026-08-27.

---

## 5. Falsifiable

Recorded so this is a claim rather than a posture. The delta collapses if:

- Vane ships per-agent registration **and** a market-set exposure aggregate measured
  from balances. Registration alone is not it; the aggregate is the mechanism.
- Sentry gains custody and aggregates across the agents it gates. Its policy
  language is already richer in some dimensions.
- Any entrant ships a shared-capital multi-agent vault on Event Contracts.
