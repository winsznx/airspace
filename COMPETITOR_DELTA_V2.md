# COMPETITOR_DELTA_V2.md

The FLIGHTPATH spike returned REVISE because its mechanism -- a per-user vault
constraining one agent -- was already occupied by Vane. AIRSPACE claims a
different dominant mechanism. This document tries to break that claim.

All findings are from current repositories and, where possible, deployed
bytecode rather than README language.

---

## 1. The field, re-read

| Project | Mechanism | Custody | Multi-agent | Aggregate cross-agent risk | Venue |
|---|---|---|---|---|---|
| **Vane** (`Risingtell/vane`) | Per-owner vault, on-chain policy pre-order, Reactivity-woken | yes | **no — one operator per contract** | **no** | DreamDEX Event Contracts |
| **Branch** (`nftkingiii/branch`) | Conditional multi-window paths: later legs unlock only if earlier ones settle as predicted | **no** | no | no | DreamDEX Event Contracts |
| **Sentry** (`Timidan/sentry-somnia`) | `POLICY.md` compiled to an on-chain policy id; agent calls the oracle in its own dispatch path | no | n/a | no | Somnia, venue-agnostic |
| **Lictor** (`winsznx/lictor`) | Mandate contract custodies `amountIn`; LLM bounded by immutable mandate params | yes | no | no | Somnia spot (Algebra) |
| **Fief** (`winsznx/fief`) | Sealed-agent signal rental, TEE-signed track records on 0G | **no** | many agents, but no shared capital | no | signal marketplace |
| **Sluice** (`Risingtell/sluice`) | Streaming x402 meter, pay-per-second | no | n/a | no | Casper — not DreamDEX |
| rampart / Lucid ai-vault | Off-chain agent firewalls | no | n/a | no | dev tooling |

Nothing in the field enforces a ceiling that spans several independently
executing agents sharing one capital base. That is the claim AIRSPACE has to
defend, and it survives a direct search.

Two clarifications worth recording:

- **Branch is non-custodial.** It verifies market and pool generation freshly
  on-chain before preview, which is good practice, but wallet signatures stay
  client-side. It is a sequencing product, not an enforcement boundary, and does
  not claim otherwise.
- **Fief has many agents but no shared capital.** Renters execute signals from
  their own wallets. There is nothing to aggregate. The overlap with AIRSPACE is
  zero: Fief proves *what an agent did*, AIRSPACE bounds *what agents may do
  together*. They are complements, not substitutes.

---

## 2. The question that decides it

> **Can Vane reproduce AIRSPACE's dominant mechanism with one small feature patch?**

**No -- but the honest answer is more uncomfortable than a flat no, and it is
worth stating precisely.**

### What Vane would NOT need to change

Vane's capital architecture is already correct for this. One contract per owner
holds the capital; that *is* a shared capital base. Adding a second agent key to
it does not require a different custody model, a coordinator, or child accounts.

So the strongest possible framing against AIRSPACE is available and I will not
duck it: **AIRSPACE and Vane sit on the same custody architecture.** Any claim
that Vane "would need a different capital architecture" is false, and
`AUTHORITY_MODEL_V2.md` §1 rejects architectures B and C precisely because the
single-vault shape is the right one.

### What Vane would need to change

The distance is in the **risk model**, and it is not one patch. Vane's stated
controls are "a per-window budget, a reserve it will never spend, a cooldown, an
allowlist of pools, and a quantity rounded down onto the venue lot grid". Every
one of those is a **scalar counter scoped to one market window and one operator**.
AIRSPACE's constraint object is a **risk surface indexed by a set of markets and
measured from token balances**. Getting from one to the other requires:

1. **Multi-agent identity and per-agent ceilings.** Genuinely a small patch.
2. **A risk-bucket abstraction spanning markets and cadences**, with market
   admission and structural cross-checks. Vane has no concept above a single
   market; its allowlist is of *pools*, which as the FLIGHTPATH spike showed is
   the wrong key entirely (pools are recycled; one observed pool served 52
   markets across both BTC and ETH).
3. **Measured-not-accumulated exposure.** This one is forced, not chosen. With a
   single operator you can keep running totals, because you executed every
   transaction and know what happened. With several agents, maker fills land in
   transactions the contract never sees, and `getOrder` reverts identically for
   a filled and a cancelled order -- so a running total cannot answer "did that
   die by filling or by cancelling?". AIRSPACE reads positions from the ERC-6909
   singleton at check time and tracks only unfilled reservations. That is a
   different state model, and multi-agent is what forces it.
4. **A reservation lifecycle with permissionless, provable release.** With one
   operator you can let that operator release its own reservations. With several,
   no agent can be trusted to release, and the owner cannot be in the loop for
   every expiry. `releaseOrder` reading `getOrder` and only ever moving toward
   what the pool reports exists because of multi-agent, not despite it.

Points 3 and 4 are the substance. They are not features bolted onto a per-agent
vault; they are consequences of changing the constraint object from "an agent's
spend" to "a portfolio's risk surface". A team could absolutely build them -- it
is perhaps a week of careful work, not a commit -- but they would be rebuilding
what the contract tracks, not adding a flag.

### The verdict this supports

The **mechanism** is distinct and absent from the entire field. The
**architecture** is shared with Vane. Whether that clears the bar of
"structurally distinct, not a feature increment" is a judgment call, and
`VERDICT_V2.md` treats it as the weaker of the two remaining objections rather
than pretending it is settled.

---

## 3. Delta against the rest

**vs Sentry** -- unchanged and large. Sentry is explicitly non-custodial:
*"Sentry does not hold funds, does not execute, and does not own anything it
gates."* The gate runs inside the agent's own dispatch path, so its authority is
the agent contract's willingness to call it. Its own stated non-goals include
per-argument constraints, ERC-20 spending caps, rate limits and caller
allowlists -- most of AIRSPACE's surface. It cannot express a cross-agent
ceiling because it has no capital to withhold.

**vs Lictor** -- different asset class (spot AMM), different temporal shape (a
single-shot mandate, not a standing envelope), no aggregation across orders or
agents. The shared insight -- custody plus immutable bounds beats prompt-level
guardrails -- predates both.

**vs Branch** -- interesting because it is the only other project reasoning
across multiple windows on this venue. But its multi-window logic is
*sequential conditionality* (leg 2 unlocks if leg 1 settles as predicted), not
*simultaneous aggregation*. Branch asks "may this leg start yet?"; AIRSPACE asks
"does this order fit alongside everything else already in flight?". And Branch
holds no capital, so it enforces nothing.

**vs Fief** -- orthogonal, as above.

---

## 4. What would collapse the delta

Recorded so this is falsifiable rather than self-serving:

- Vane shipping multi-agent registration **plus** a market-set exposure ceiling
  measured from balances. The first alone would not do it; the second is the
  mechanism.
- Sentry gaining custody. Its policy language is already richer than AIRSPACE's
  in some dimensions, and a custodial Sentry that aggregated across gated agents
  would be a direct competitor.
- Any hackathon entrant shipping a shared-capital multi-agent vault on Event
  Contracts. Nothing public does today, checked 2026-08-27.
