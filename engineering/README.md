# AIRSPACE — engineering history

Three sequential hostile feasibility spikes against the **live** DreamDEX Event
Contract deployment on Somnia Shannon (chainId 50312), run 2026-08-27. Each spike
was set up to *kill* its own candidate before approving it. Two returned REVISE.
The third returned LOCK.

Nothing here is mocked except where a document says so explicitly. Every protocol
claim was verified against deployed bytecode or a live call, and the reports are
preserved unedited — including the parts that record what did not work.

| Stage | Candidate | Verdict |
|---|---|---|
| [00-flightpath-feasibility](00-flightpath-feasibility/) | Single-agent execution assurance | **REVISE** |
| [01-airspace-portfolio-spike](01-airspace-portfolio-spike/) | Cross-agent portfolio, owner-attested asset buckets | **REVISE** |
| [02-product-lock](02-product-lock/) | Cross-agent portfolio, structural risk domains | **LOCK — 11/11** |

**76 tests pass** across the three stages: 21 + 18 + 37.

---

## 00 — FLIGHTPATH: why it was investigated

The question was whether a user could let a third-party trading bot operate their
capital on DreamDEX Event Contracts without handing over the ability to steal it.
DreamDEX documents a split-key "operator" model for exactly this, so the first job
was to check whether that model already solved the problem.

### Live protocol facts it discovered

These shaped everything that followed, and they are why the product has the shape
it has.

- **There is no session-key path for Event Contracts.** `placeBinaryOrderFor` on a
  `BinaryPool` reverts `OnlyApprovedContracts()` for *every* EOA caller, including
  a caller acting for itself. The `OperatorPermissionsRegistry` that backs
  spot/perp session keys is not wired into `BinaryPool` at all — the
  `isOperatorAuthorized` selector is absent from the deployed implementation. So
  custody-by-contract is not a design preference here; it is the only structural
  option the venue permits.
- **Contract callers are first-class.** A state-override `eth_call` showed a
  contract caller reaching the same collateral-pull revert as an EOA, which is what
  makes a vault viable at all.
- **Outcome-token identity is `(pool, marketNonce)`, not `marketId`.** The
  ERC-6909 id encoding is `(pool << 72) | (nonce << 8) | idx`, and pools are
  recycled aggressively — generation 1431 was observed live. Keying anything by
  pool address binds to a mutable slot.
- **The indexer's market status is unreliable.** It served `Trading` for markets
  that had expired five weeks earlier. Every enforcement gate reads the chain.

### Live proof

An agent key submitted an intent; the account crossed the real resting ask on the
real book. 192 tUSDC spent, 200,000,000 YES credited **to the account**, agent
balance zero. Ten live negative proofs plus two broadcast on-chain rejections, and
the owner recovered everything with the agent revoked to `address(0)`.

### Why it returned REVISE

Not because the architecture failed — it held under every attack. Because
`Risingtell/vane`, verified from **deployed bytecode** on Shannon, was already the
same mechanism on the same venue: a per-owner vault with on-chain policy checked
before the order, and unconditional owner withdrawal. FLIGHTPATH's real advantages
(generation binding instead of a pool allowlist, a max execution price, a
deterministic receipt) were increments on a shared dominant mechanism, not a
different one.

→ [VERDICT.md](00-flightpath-feasibility/VERDICT.md) ·
[SPIKE_FINDINGS.md](00-flightpath-feasibility/SPIKE_FINDINGS.md) ·
[COMPETITOR_DELTA.md](00-flightpath-feasibility/COMPETITOR_DELTA.md)

---

## 01 — AIRSPACE: changing the constraint object

The revision changed *what is constrained*. FLIGHTPATH constrained **one agent's
authority**. AIRSPACE constrains **portfolio state shared across many agents**: an
order that satisfies its own agent's policy in full is rejected because
reservations or positions created by *other* agents have already consumed capacity.

That is a different constraint object, and it forced a different state model rather
than a wider policy struct:

- **Exposure had to be measured, not accumulated.** `getOrder` reverts
  `IncorrectOrder()` *identically* for a filled and a cancelled order. A running
  counter must know which happened, and with several agents — and maker fills
  landing in transactions the contract never executes — that question is
  unanswerable. The first implementation used a counter; the fork tests broke it.
  The fix reads realized positions from the ERC-6909 singleton and stores only
  unfilled reservations.
- **Reservation release had to become permissionless but non-forgeable.** With one
  operator you can let it manage its own reservations. With several, release is
  driven by `getOrder` so the pool supplies the number and the caller supplies none.

Proven live with three independent agent keys: A reserved 180, B reserved 240 on a
different cadence, C proposed 150 and was refused with `DomainRiskExceeded` because
180 + 240 + 150 > 500. C's own budget was untouched. Both A's and B's orders were
**unfilled**, which is the proof that reservations occupy the envelope before they
fill.

### Why it still returned REVISE

Two things, both honest rather than fixable by polish:

1. **A semantic attestation sat in the security path.** Risk buckets were
   owner-declared ("this market is BTC"). The spike searched exhaustively for an
   on-chain alternative — 304 selector probes across both MarketCreators and the
   module implementation — and established that `marketId → asset` exists on-chain
   *in creation event logs* but no view exposes it, and contracts cannot read logs.
2. **Per-market admission did not scale.** One `admitMarket` transaction per market
   is fine at daily cadence and impossible at the 60-second cadence that dominates
   Shannon activity.

→ [VERDICT_V2.md](01-airspace-portfolio-spike/VERDICT_V2.md) ·
[RISK_IDENTITY.md](01-airspace-portfolio-spike/RISK_IDENTITY.md) ·
[AIRSPACE_FINDINGS.md](01-airspace-portfolio-spike/AIRSPACE_FINDINGS.md)

---

## 02 — Product lock: structural risk domains

The final revision removed the semantic attestation entirely. A risk domain is now:

```
domain = keccak256(creator, collateral, canonicalCadence)
```

Every field read from `module.markets()` **during execution**. No indexer, no
owner-supplied asset string, no event-log attestation, no trusted relayer, no
per-market admission transaction.

Raw `expiry - tradingStart` turned out not to be safe to key on. Scanning 1,200
consecutive live markets found two real **898-second** markets on a 900-second
series — keyed raw they would have formed their own domain and escaped the ceiling
entirely. The canonicalisation rule is exact:

> the smallest canonical cadence `C` with `C >= (expiry - tradingStart)` and
> `expiry % C == 0`; no match means no domain, and the market is untradable.

Across those 1,200 markets: zero unresolved, the 898s markets absorbed into the
900s domain, and 60-second markets never escalated.

### What the LOCK proved

- One `setDomainPolicy` call covers every market the series will ever roll. The
  live run records `ownerTxSinceConfig: 0` while two agents traded two different
  markets; a benchmark drove 500 consecutive 60-second generations through the
  contract with zero configuration in between.
- The cross-agent rejection, live, with C's committed state and the domain state
  both unchanged by the rejection — then admitted after a real lifecycle release.
- Concurrency: same-block racing proven on fork (2, 3 and 10 agents); live, B's
  transaction was broadcast before A's outcome was known and **reverted on-chain**.
- Adversarial reconciliation: an unrelated account minted a complete set and filled
  the portfolio's resting bid in a transaction the portfolio never saw. Measured
  usage went 20 → 40 contracts (**overstated**, the safe direction) and converged to
  20 after release. It never dips below the truth.
- Owner recovery with all three agents revoked, residual zero.

**Result: 11/11 LOCK criteria passed.**

→ [VERDICT_V3.md](02-product-lock/VERDICT_V3.md) ·
[AIRSPACE_LOCK_REPORT.md](02-product-lock/AIRSPACE_LOCK_REPORT.md) ·
[STRUCTURAL_DOMAINS.md](02-product-lock/STRUCTURAL_DOMAINS.md) ·
[LIVE_LOCK_EVIDENCE.md](02-product-lock/LIVE_LOCK_EVIDENCE.md)

---

## Known limitations, carried forward

LOCK is not a claim that everything is solved. These are stated in the reports and
repeated here so nobody has to dig for them.

- **Domains are coarser than assets.** A ceiling covers both sibling series at a
  cadence. The contract cannot tell BTC from ETH and never claims to — sibling
  series share a domain by design, and an agent cannot escape a saturated ceiling
  by switching between them. Separate per-asset limits are not expressible on the
  current protocol surface.
- **Two mappings grow monotonically** (`intentUsed`, `_orders`). Neither is ever
  iterated, so gas per operation stays O(1) in history; only storage grows. A
  monotonic per-agent nonce would bound it — recorded, not shipped.
- **A keeper is mandatory at 60-second cadence.** Without pruning, a continuously
  trading portfolio reaches the 48-market domain cap in ~48 minutes and fails
  closed.
- **The 10,000-intent benchmark uses mocks.** Correctness is proven on the real
  fork; the scale figure isolates AIRSPACE's own bookkeeping from protocol cost.
- **Reactivity is live on Shannon but was not built.** It would improve liveness
  only, never safety. The SDK's 32 SOMI subscription floor was not cleared by this
  spike's wallet.
- **Owner-key compromise, oracle failure, stuck resolution and venue insolvency**
  are all outside what this bounds.
- **Testnet activity is substantially synthetic**, so behavioural conclusions
  describe a demo environment.

---

## Layout

```
engineering/
  shared/interfaces/IDreamDex.sol     DreamDEX interfaces, used by all three stages
  00-flightpath-feasibility/          reports · contracts · test · scripts · evidence
  01-airspace-portfolio-spike/        reports · contracts · test · scripts · evidence
  02-product-lock/                    reports · contracts · test · scripts · evidence
                                      + research/onchain-probes/
```

`IDreamDex.sol` is shared rather than copied three times; each stage keeps only the
contracts that materially prove that stage's architecture.

## Reproducing

```bash
forge install foundry-rs/forge-std     # lib/ is gitignored
forge build

export SHANNON_RPC=https://dream-rpc.somnia.network

# 00 FLIGHTPATH (21 tests)
FORK_BLOCK=472700908 \
MARKET_ID=0x00000000000000000000000000000000000000000000000000000000000000a8ce \
forge test --match-path 'engineering/00-flightpath-feasibility/test/*'

# 01 AIRSPACE portfolio spike (18 tests)
FORK_BLOCK=472724061 \
BTC_MARKET_1=0x000000000000000000000000000000000000000000000000000000000000a8cd \
BTC_MARKET_2=0x000000000000000000000000000000000000000000000000000000000000b1dd \
forge test --match-path 'engineering/01-airspace-portfolio-spike/test/*'

# 02 PRODUCT LOCK (29 fork + 5 scale + 3 sponsor)
FORK_BLOCK=472749135 \
MKT_1=0x000000000000000000000000000000000000000000000000000000000000b278 \
MKT_2=0x000000000000000000000000000000000000000000000000000000000000b277 \
forge test --match-path 'engineering/02-product-lock/test/AirspacePortfolio.fork.t.sol'
forge test --match-path 'engineering/02-product-lock/test/AirspaceScale.t.sol'
forge test --match-path 'engineering/02-product-lock/test/AirspaceSponsorImpact.t.sol'
```

Fork blocks are pinned per stage because Shannon's fast cadences retire markets
within hours. See `.env.example`.

The live drivers under `engineering/*/scripts/` **broadcast real transactions** and
need funded keys in a gitignored `.wallets.json`. They are preserved as the exact
tools that produced the evidence, not as something to run casually.

### Research inputs (gitignored, reproducible)

```bash
git clone --depth 1 https://github.com/somnia-chain/dreamdex-bot-kit botkit
mkdir sdkprobe && cd sdkprobe && npm init -y && npm i @somnia-chain/markets-sdk viem
# protocol docs quoted in the reports: https://docs.dreamdex.io/llms.txt
```

The on-chain probes that produced the structural-domain and selector-sweep results
are preserved at
[`02-product-lock/research/onchain-probes/`](02-product-lock/research/onchain-probes/)
and read only public RPC.
