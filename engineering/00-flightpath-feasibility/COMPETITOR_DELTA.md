# COMPETITOR_DELTA.md

An honest read of the field. The question is not "is FLIGHTPATH good" but
**"does FLIGHTPATH have a distinct dominant mechanism, or is it a rename?"**

---

## 1. The field

| Project | Mechanism | Custody | Venue | Verified how |
|---|---|---|---|---|
| **Vane** (`Risingtell/vane`) | Per-user contract vault, on-chain policy before order, Reactivity-woken | **Yes** | **DreamDEX Event Contracts, Shannon** | **Deployed bytecode inspected** |
| **Sentry** (`Timidan/sentry-somnia`) | Declarative `POLICY.md` compiled to on-chain policy id; agent calls oracle in its own dispatch path | No — "does not hold funds" | Somnia, venue-agnostic | README + docs |
| **Lictor** (`winsznx/lictor`) | Mandate contract custodies `amountIn`; LLM output bounded by immutable mandate params; validator-consensus receipts | Yes | Somnia spot DEX (Algebra) | README |
| **rampart** (`peg/rampart`) | Off-chain firewall for agent tool calls | No | Dev tooling, not a chain | README |
| **Lucid** (`Lucid-Computing/ai-vault`) | Local-first MCP proxy, secrets and tool policy | No | Dev tooling | README |

`rampart` and `Lucid` are **architecture C**. They are good tools for constraining a
developer's own agent tooling, and they are not custody boundaries. They are not
competitors to FLIGHTPATH; they are the thing FLIGHTPATH's rejection test excludes.
Note also that `microsoft/RAMPART` is a pytest safety-testing framework and a
different project entirely from `peg/rampart` — the name is ambiguous in the wild.

---

## 2. Sentry — the closest *conceptual* neighbour, structurally different

Sentry is a policy **registry**, explicitly: *"Sentry does not hold funds, does not
execute, and does not own anything it gates."* The agent contract inherits
`SentryAgentBase`, tags its entrypoints with a `sentryGuarded` modifier, and calls
`SentryOracle.checkIntent()` before dispatching.

This is **self-policing**. The gate runs inside the agent's own dispatch path, so its
authority is exactly the agent contract's willingness to call it. An agent with a
second entrypoint, an upgrade, or simply a build that omits the modifier spends the
same capital with no gate. Under this spike's rejection test — *can the enforcement be
bypassed while still spending user-controlled capital?* — Sentry's model is bypassable
by construction. That is not a criticism of Sentry, which is honest about being a
registry; it is a statement that it solves a different problem.

Sentry's own stated non-goals are, almost exactly, FLIGHTPATH's entire substance:

> "Per-argument constraints (no 'allow `transfer()` only if recipient ∈ X' or 'only if
> `amount < 100 USDC`')… ERC-20 / token-aware spending caps (only native-token wei
> caps)… Rate limits, call-count limits, or minimum interval between calls…
> Caller (`msg.sender`) allow-lists… Off-chain context inputs (prices, balances…)"

Every one of those is a FLIGHTPATH gate. **Delta vs Sentry: real and large.** Sentry
gates *which function* on *which contract*; FLIGHTPATH gates *which market generation,
at what price, at what size, against what aggregate exposure, with what window
headroom* — and holds the capital so the gate cannot be skipped.

---

## 3. Lictor — adjacent, different asset class and different bound

Lictor custodies `amountIn` and bounds an LLM's output with immutable mandate
parameters (`amountIn` ceiling, `minOut` floor, token allowlist, selector whitelist),
with validator-consensus receipts from Somnia's on-chain LLM.

It is a **single-shot mandate on a spot swap**: the user authorises one trade shape,
the agent picks the moment. FLIGHTPATH is a **standing envelope over a stream of
orders** on a venue with per-window market identity, recycled pools, expiry
mechanics and settlement. Different asset class (spot AMM vs binary CLOB), different
temporal shape (one mandate vs a rolling session), different state (no aggregate
exposure across orders in a mandate).

**Delta vs Lictor: real.** Overlap is the shared insight that custody plus immutable
bounds beats prompt-level guardrails — which is the correct insight, and neither
project invented it.

---

## 4. Vane — the problem

This is where the thesis breaks.

Vane is **the same architecture, on the same venue, in the same hackathon.** Not a
similar idea; the same one. I verified this against deployed bytecode rather than
trusting the README. Factory `0xc17da7a28Ea556f6BfA7a774d9Da486C41574b43` is live on
Shannon (27,737 bytes of code) and contains:

```
0x718c2d4d  placeBinaryOrder(...)                      present
0x53edf33d  onEvent(address,bytes32[],bytes)           present   (Reactivity handler)
0x3ecC694C…  BinaryMarketsModule address                present
0x70a86D88…  tUSDC collateral address                   present
```

Its stated model, point by point against FLIGHTPATH's:

| Property | Vane | FLIGHTPATH |
|---|---|---|
| One contract per owner, no pooling | yes (factory) | yes (factory) |
| Contract is trader of record on `placeBinaryOrder` | yes | yes |
| On-chain policy checked before the order | yes | yes |
| Owner-only unconditional withdrawal | yes, explicitly independent of strategy/operator/pause/subscription | yes |
| Cooldown | yes | yes |
| Per-window budget / spend cap | yes | yes (`maxOrderNotional`, `maxExposure`) |
| Lot-grid quantisation | yes | yes (plus tick grid) |
| Market allowlist | **pool allowlist** | **marketId + generation binding** |
| Redemption, expired-order sweep | yes | owner-side redeem |
| Reactivity-woken execution | yes | no |

FLIGHTPATH holds three genuine technical advantages, and I want to state them
without inflating them:

1. **Generation binding beats a pool allowlist.** Vane allowlists *pools*. Pools are
   recycled — observed `marketNonce` up to 1431 — and the DreamDEX docs say plainly:
   *"Key state by `marketId` or symbol, never by pool address."* A pool allowlist
   admits whatever market that address serves next. FLIGHTPATH pins
   `(pool, marketNonce)` against the registry's outcome ids and rejects a stale
   generation (`GenerationMismatch`, proven live). This is a real correctness edge on
   a real protocol hazard.
2. **A maximum execution price bound.** Not in Vane's stated control set. On a binary
   book where a taker is charged the resting price rather than its own, a price
   ceiling is the difference between "buy up to 0.60" and "buy at any price".
3. **A deterministic receipt** with `policyHash`/`intentHash`/`preTradeStateHash`, and
   an explicit statement of which fields need an offchain witness.

And Vane holds one FLIGHTPATH lacks: **Reactivity-driven autonomous wake-up**, which
is a materially harder integration and a better fit for the venue's 60-second windows.

### The honest conclusion

Those three advantages are **increments on a shared dominant mechanism**, not a
different one. "Per-user contract-owned execution vault with on-chain policy on
DreamDEX Event Contracts" is occupied. A judge who has seen Vane will read FLIGHTPATH
as *Vane with better market-identity binding and a receipt* — which is a fair reading,
and not a winning one.

The "vendor-neutral, any bot plugs in" framing does not rescue it. Vane's contract
could accept an external agent key with a one-line change; nothing structural stops
it. A framing difference that a competitor can erase in one commit is not a moat.

---

## 5. Where a distinct dominant mechanism could actually live

Recorded because `REVISE` needs a direction, not because any of this is validated.

- **Cross-agent portfolio envelope.** Every project in this field constrains *one
  agent's* spend. None constrains **aggregate correlated exposure across several
  heterogeneous agents** sharing one capital base — e.g. a cap on total BTC-direction
  exposure across the 60s, 15m, 1h and daily series simultaneously, where three
  independently-sane agents can breach a limit none of them individually violates.
  Vane cannot express this: one agent, one contract, per-window budget. This is a
  different constraint object (a portfolio), not a bigger version of the same one.
- **The asset gap as the product.** §5 of `SPIKE_FINDINGS.md` shows asset is not
  derivable from a `marketId`. Netting at the *underlying* level rather than the
  market level is exactly the thing the protocol makes hard, which is a defensible
  place to add value.
- **Capital allocation on top of receipts.** Renting capital to third-party strategies
  against verifiable execution history. Note this is partially occupied —
  `winsznx/fief` is "trading agent rental with signed track records" — so it needs its
  own diligence before being adopted as the thesis.
