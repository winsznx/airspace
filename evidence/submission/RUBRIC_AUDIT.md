# Rubric audit — AIRSPACE for the Somnia × DreamDEX Event Contracts Hackathon

Honest self-scoring against the published rubric. Where something is weak, it
says so rather than reframing it as a strength. Category weights as given:
Technical Implementation 25, Innovation & Originality 20, UX & Design 20,
Business & Ecosystem Impact 20, Presentation & Demo 15.

---

## Innovation & Originality — 20

**The claim:** individually valid agent decisions can still be collectively
unsafe, and AIRSPACE is the layer that catches that before execution rather
than after.

Ten agents, each honoring its own price band, its own order-size limit, its
own cooldown, can still jointly commit a portfolio to more directional
exposure than the owner ever agreed to hold. Nothing about any single agent's
behavior is wrong. The unsafety is a property of the FLEET, not of any agent
in it, and it only exists once capital is shared. A single-agent risk control
— a stop-loss, a position cap, a kill switch — cannot see this, because it has
nothing to compare the agent against.

AIRSPACE's mechanism is cross-agent **portfolio admission**: every order from
every agent is evaluated against the combined state of the whole fleet, atomically,
before it reaches DreamDEX. Distinctly:

- It is not a bot. It holds no market opinion and places no order on its own
  initiative — it is a passive gate an agent's own order must clear.
- It is not per-agent risk management. Each agent's local policy (price band,
  order size, cooldown) is a *separate*, prior check; AIRSPACE's gate is the
  one no single agent's policy can express, because it depends on what
  *other* agents are doing right now.
- It is not a multi-sig or a timelock. The gate runs inside the same
  transaction as the trade, at zero added latency beyond one contract call —
  there is no separate approval step to route around or wait on.

**Where this is genuinely novel for DreamDEX specifically:** DreamDEX event
contracts roll into a new market every cadence window with no owner
transaction required to keep enforcing a limit on the new one — the policy is
derived from `(creator, collateral, canonical cadence)`, not attached to a
market id. A per-market allowlist or manual risk config breaks the moment the
market rolls; this doesn't, and that property is specific to how DreamDEX
mints markets.

**Honest limitation:** the mechanism is a known class in TradFi (netting risk
across a multi-strategy book, cross-margining) — the contribution is not "no
one has ever computed portfolio risk," it is building it as an on-chain,
atomic, pre-trade gate for autonomous agents trading a rolling, structurally-
defined DreamDEX market family with no owner-in-the-loop per generation.

---

## Technical Implementation — 25

| Requirement | Where |
|---|---|
| DreamDEX Event Contracts | `contracts/src/AirspacePortfolio.sol` calls `placeBinaryOrderFor` directly on the live DreamDEX binary pool; every one of the four order kinds (BUY_YES/SELL_YES/BUY_NO/SELL_NO) is supported |
| Actual order execution | `execute()` places a real order on the DreamDEX pool in the same transaction as admission — not a simulation, not a relayer |
| Live Shannon deployment | Factory `0xeD3D4552AFda96EfC5BF47c533E3302C655CB732`, implementation `0xeB39A417eAC32f18a5C548afd9E442D2DEf416C4`, chain 50312 |
| Market generation binding | `marketNonce` is checked on every admission (`MARKET_GENERATION_MISMATCH`); a recycled pool cannot silently reuse stale AIRSPACE state |
| Structural domains | `domain = keccak256(creator, collateral, canonicalCadence)`, derived fresh from the DreamDEX registry every call — no indexer, no owner transaction per market |
| Atomic reservation | Admission and order placement happen in one call; two agents racing the same headroom are serialized by the EVM, not by an off-chain lock |
| ERC-6909 accounting | Realized exposure is read live from ERC-6909 balances, never accumulated in a counter that can drift from what `getOrder` says |
| Reconciliation | `releaseOrder`/`releaseSettled`/`pruneMarket` are permissionless; `scripts/risk-verifier.mjs` proves the reconciliation-lag overstatement is bounded and clears |
| Independent exposure oracle | `contracts/test/reference/ExposureOracle.sol` — enumerates all 16 fill combinations, shares no code with production, used to prove the production formula never understates |
| v1 → v2 remediation | A real safety defect (opposing reservations netted to near-zero) was found live, root-caused, fixed, and independently re-proven; full account in `evidence/production/REMEDIATION.md` |
| Tests | 100 contract tests (9 stateful invariants at 256 runs × 8,192 calls, 16 named adversarial scenarios, 2 independent reference implementations, 10 live-fork tests), 60 workspace unit tests, 14 Playwright browser tests |

**Honest limitation:** the DreamDEX venue itself does not expose an asset
label for a market (`marketId → "BTC"` is not a view this venue provides), so
AIRSPACE enforces at the cadence-domain level, not the asset level — stated
plainly in-product rather than worked around with an off-chain attestation
the contract can't verify.

---

## UX & Design — 20

| Surface | What it does |
|---|---|
| Landing | States the category ("portfolio control plane for autonomous prediction markets") and the mechanism ("one capital pool, many trading agents, one shared risk envelope") before any technical detail |
| Onboarding | Connect → create portfolio → fund → set policy → register agents → Control Room, with plain-language limit explanations rather than raw contract parameter names |
| Control Room | The hero screen: shared capital, the ceiling line (the signature visual — segments per agent against one hard boundary a proposed order visibly crosses), live domains, and the advisory-preview panel that runs a real `previewIntent` call and shows the exact gate that would block |
| Event Contracts (new this pass) | Which DreamDEX markets the fleet is actually touching, grouped into rolling-generation chains by pool, cross-referenced with this portfolio's own reservations and positions — not a generic market explorer |
| Agent fleet cards | Identity, strategy label, local limits, portfolio usage, markets touched, open reservations, admitted/refused counts — one card per agent, not a dense admin table |
| Receipts | Side, quantity, requested price and the resulting DreamDEX order id for an admission; the exact blocking check and the arithmetic (`420 + 150 = 570 > 500`) for a refusal |
| Reconciliation panel | Decomposes an over-ceiling reading into independent worst-case exposure, pending safe release, and time since — instead of showing a bare number a viewer has to take on faith |
| Advisory-preview labeling | Every preview surface visibly says "Advisory preview — rechecked atomically on-chain at submission," so a preview PASS is never mistaken for a guarantee |

**Honest limitation:** mobile has been checked for basic layout correctness
(no horizontal overflow, sticky-header behavior, hero recomposition) in an
earlier pass, but a full pass at all five specified breakpoints (1440/1280/
1024/768/390) against the *new* surfaces added this session (Event Contracts
page, agent fleet cards) has not been done yet — flagged as a remaining task,
not silently skipped.

---

## Business & Ecosystem Impact — 20

**Why shared capital matters:** today, one strategy gets one wallet and one
isolated pool of capital. Adding a second strategy means a second wallet, a
second deposit, and zero visibility into what the two are doing together. A
treasury that wants to run five strategies either funds five silos (capital
sits idle in whichever ones are quiet) or funds one wallet with five keys
(any one strategy can spend the whole balance). AIRSPACE is the third option:
one pool, N independent keys, one enforced ceiling none of them can jointly
exceed.

**External integration path:** an agent needs its own key and a policy
registered by the portfolio owner — nothing else changes about how it trades.
The integration surface for an existing DreamDEX bot is "sign transactions to
the portfolio instead of the pool directly, using the same intent shape
DreamDEX itself expects." `packages/sdk` exports the ABI and the exact intent
struct; `botkit-adapter` (see `contributions/`) is the concrete adapter
example. This is what lets the repo say: *bring your own DreamDEX strategy,
route its intents through AIRSPACE to share portfolio capital safely* — a
claim backed by working code, not aspiration.

**The adoption chain:** more DreamDEX bots integrating → more autonomous
Event Contract volume running safely under one enforced envelope → more
capital willing to be deployed multi-strategy because the collective risk is
bounded and provable, not merely assumed.

**Post-hackathon path:** the portfolio contract and its admission model are
DreamDEX-specific by design right now (the escrow semantics, the order kinds,
the generation binding are all read from this venue's actual contracts) —
multi-venue support is not claimed as shipped, and would be a real, separate
build, not a config flag.

**Honest limitation:** the ecosystem story is currently proven with the
project's own three sample agents (momentum, reversion, spread), not yet with
a genuinely independent third-party bot. The adapter and SDK exist and are
typechecked; an actual outside integration is the strongest possible proof of
this section and has not happened yet.

---

## Presentation & Demo — 15

The canonical demo (`evidence/production/CANONICAL-DEMO.md`) is deterministic
and reproducible on demand: `node scripts/live-proof.mjs` creates a fresh
portfolio, reserves 180 and 240 from two agents, gets a third refused at
420+150=570>500 with the full gate stack, releases capacity, and re-admits
the identical trade at 240+150=390 — all against live Shannon, all in under a
minute, none of it dependent on catching a market fill at the right moment.

Recommended 2-minute path: see the closing section of this report and
`evidence/production/CANONICAL-DEMO.md`'s 75-second cut. The engineering
depth (v1 failure, independent oracle, 100 tests, 3-hour unattended campaign)
belongs in the technical credibility beat near the end, not as the opening —
the product problem and the live refusal are what should open the video.

**Honest limitation:** the actual video has not been recorded (no
screen-recording capability in this environment); what exists is a script and
a live, rehearsable path, not a finished asset.
