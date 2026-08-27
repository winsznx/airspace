# VERDICT.md

**FLIGHTPATH — vendor-neutral execution assurance layer for DreamDEX Event Contracts.**
Hostile feasibility spike, Somnia Shannon (chainId 50312), 2026-08-27.

---

## The scorecard

The LOCK bar has five conditions. Four pass decisively. One fails.

| # | LOCK condition | Result |
|---|---|---|
| 1 | Structurally enforced Event Contract execution boundary | **PASS** |
| 2 | At least one real live successful trade | **PASS** |
| 3 | Multiple live or forked negative proofs | **PASS** |
| 4 | Owner capital recovery remains unconditional | **PASS** |
| 5 | Clearly distinct from the existing field | **FAIL** |

---

## What was proven

**The boundary is structural, not application-level.** Capital lives in a per-owner
contract that is the trader of record on `placeBinaryOrder`. The agent key holds
nothing, has no allowance, and has exactly one reachable entrypoint. Every other
state-changing function is `onlyOwner`. There is no unguarded path from the agent to
user capital — not a convention, a checked invariant.

This shape was forced by the protocol, not chosen for convenience. `placeBinaryOrderFor`
reverts `OnlyApprovedContracts()` for every EOA caller including self-for, and
`BinaryPool` has no `OperatorPermissionsRegistry` wiring at all — the selector is
absent from the deployed bytecode. The spot/perp session-key model does not reach
Event Contracts. Custody-by-account is the only structural option on this venue, which
makes architecture B (7702 / smart-account delegation) not merely weaker but
unbuildable, and architecture C (off-chain middleware) bypassable by definition.

**A real trade landed.** Tx
`0xf0198627202a78bd12448fee967be80898e9c34151a46ee3ce9589e72ebc0536` crossed the live
resting ask on market `0x…b00d` (BTC, 4h, pool `0x3693799C…`, generation 93). 192 tUSDC
spent, 200,000,000 YES credited **to the account**. Agent YES: 0. Agent collateral: 0.
Owner EOA YES: 0.

**Ten live negative proofs plus two broadcast on-chain rejections plus 21/21 fork
tests.** Including three that a generic agent-guardrail cannot express at all:
generation binding against recycled pools (`GenerationMismatch`), authoritative
Trading composed from four on-chain reads rather than the indexer (which was
provably serving five-week-stale `Trading` rows), and venue grid conformance.

**Recovery is unconditional.** With the policy lapsed and the agent revoked to
`address(0)`, the owner withdrew 1,808 tUSDC and the full 200,000,000 position.
Withdrawal reads no policy, agent, market, or subscription state.

The engineering thesis is validated. The architecture is sound and the spike found no
way to break it.

---

## Why it still does not LOCK

**Vane already is this.**

`Risingtell/vane` is a per-user contract vault with on-chain policy enforced before
order placement, owner-only unconditional withdrawal explicitly independent of
strategy/operator/pause/subscription, cooldown, per-window budget, and lot-grid
quantisation — on DreamDEX Event Contracts, on Shannon, in this hackathon. I did not
take the README's word for it. The factory at
`0xc17da7a28Ea556f6BfA7a774d9Da486C41574b43` is live with 27,737 bytes of code
containing the `placeBinaryOrder` selector, an `onEvent` Reactivity handler, and the
BinaryMarketsModule and tUSDC addresses.

FLIGHTPATH's advantages over it are real and I would defend each: generation binding
where Vane allowlists pool addresses (a genuine hazard — observed `marketNonce` 1431,
and the docs say plainly *"never key state by pool address"*), a maximum execution
price bound Vane's control set lacks, and a deterministic receipt with an honest
account of which fields need an offchain witness. Vane in turn has Reactivity-driven
autonomous wake-up, which is the harder integration and the better fit for 60-second
windows.

But these are **increments on a shared dominant mechanism.** "Per-user contract-owned
execution vault with on-chain policy on DreamDEX Event Contracts" is occupied
territory. A judge who has seen Vane reads FLIGHTPATH as *Vane with better
market-identity binding and a receipt*, and that reading is fair.

The vendor-neutral framing does not rescue it. Vane's contract could accept an
external agent key with a one-line change. A differentiator a competitor erases in one
commit is not a differentiator.

Against Sentry and Lictor the delta is large and defensible — Sentry is explicitly
non-custodial self-policing whose stated non-goals are precisely FLIGHTPATH's
substance, and Lictor is a single-shot spot mandate. Against Vane it is thin. One
competitor is enough.

---

## Why this is not KILL

The KILL conditions were specific, and none of them is met:

- *Enforcement only application-level* — no. It is custody-level and proven under a
  fully compromised agent key.
- *Event Contract delegation makes the architecture dishonest* — no, and this is worth
  stating plainly. The spike specifically hunted for the dishonest version, where a
  product claims to constrain an agent while capital sits in a user's EOA. On this
  venue that product is impossible to build, and FLIGHTPATH does not claim it. What
  is built matches what is claimed.
- *Basically Lictor/Vane/Sentry with a new UI* — not quite. There are three real
  mechanism differences, not cosmetics. The problem is that they are increments, not a
  distinct dominant mechanism.

The contracts, the proofs and the protocol findings are keepers. The positioning is
what fails.

---

## What a revision has to do

Not "add features." Find a constraint object the incumbent cannot express.

The strongest candidate the spike surfaced: **cross-agent aggregate exposure.** Every
project in this field constrains one agent's spend. None constrains correlated
exposure across several heterogeneous agents sharing one capital base — a cap on total
BTC-direction exposure across the 60s, 15m, 1h and daily series at once, where three
individually-compliant agents breach a limit none of them violates alone. Vane cannot
express this by construction: one agent, one contract, per-window budget. That is a
different constraint object, not a bigger version of the same one.

It also turns this spike's most awkward finding into the moat. Asset is not derivable
from a `marketId` on-chain (§5 of `SPIKE_FINDINGS.md`) — sibling series share creator,
collateral, cadence and expiry. Netting at the *underlying* level is exactly what the
protocol makes hard, and hard is where defensibility lives.

Before adopting it: `winsznx/fief` (agent rental against signed track records) sits
near the capital-allocation adjacency and needs its own diligence.

Keep: `FlightAccount.sol`, the generation-binding gate, the authoritative-Trading
composition, the receipt, and the whole evidence trail. Rebuild the thesis above them.

---

REVISE
