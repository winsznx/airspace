# evidence/

Index of the public engineering evidence, and the rule for what may live here.

The raw artifacts sit beside the stage that produced them, under
`engineering/*/evidence/`. This file explains what is safe to publish, what is
never published, and which artifact backs which claim.

Production evidence (deployment receipts, audit reports) will land in this
directory once the production build begins. It is otherwise empty by design.

---

## What is public, and safe

All of this is already world-readable on a public testnet. Publishing it reveals
nothing that a block explorer does not.

| Category | Example |
|---|---|
| Contract addresses | `BinaryMarketsModule 0x3ecC694Cef705358864a646142ac17A90E29e388` |
| Deployed prototype addresses | `Portfolio 0x2F9BE34ae56C7be945211e011CC189ECC5941Ab8` |
| Transaction hashes | `0xc5541d26fe40a0aca94bbc9c0a087abd57e8feda108134cc2925d3bfd98532d2` |
| Reverted transaction hashes | `0x6fe4204c783e42e0ae67f776b7c6d7a04badf06f9cc879347f03f4d8b62e6480` |
| Market ids, pool addresses, generations | `0xb278`, pool `0xC3E2b06a…`, nonce 91 |
| Block numbers and pinned fork blocks | `472749135` |
| **Public wallet addresses** | `OWNER 0x4Bd0bf9821F23f822eb44B1F095594e2BbBC06Bc` |
| Domain keys, policy hashes, intent hashes | `0xdc493f0f81932a6e471efcad80e75a0a2620166eb9dacf398d99a62fe7a26900` |
| Test results and gas benchmarks | `29 passed; 0 failed` |
| Sanitized execution receipts | `engineering/*/evidence/live-run.json` |

## What is never included

- private keys
- mnemonics / seed phrases
- keystore files or passwords
- secret environment values
- API keys, service-role keys, bearer tokens

The wallets used in the spikes are **throwaway testnet keys** generated for this
work. Their addresses are published; their private keys live only in a gitignored
`.wallets.json` and were never committed — this repository's history begins at the
product-lock checkpoint and has never contained them.

Verified mechanically by
[`engineering/02-product-lock/research/onchain-probes/secret-scan.mjs`](../engineering/02-product-lock/research/onchain-probes/secret-scan.mjs),
which cross-checks every file against the actual key material and classifies every
`0x`+64-hex string. Latest run: **0 leaks, 0 mnemonics, 0 API tokens**; all 96
key-shaped strings classified as public tx hashes / market ids / policy hashes.

```bash
node engineering/02-product-lock/research/onchain-probes/secret-scan.mjs .
```

---

## Claim → evidence map

### Stage 00 — FLIGHTPATH (verdict REVISE)
`engineering/00-flightpath-feasibility/evidence/`

| Claim | Evidence |
|---|---|
| No session-key path exists for Event Contracts | `README.md` protocol probes — `placeBinaryOrderFor` → `OnlyApprovedContracts()` from every EOA caller, including self |
| A contract can trade; the account holds the position | `live-run.json` step `04-agent-trade` — 192 tUSDC spent, 200,000,000 YES to the account, agent balance 0 |
| The agent cannot move capital | 10 live negative proofs + 2 broadcast reverted transactions |
| Owner recovery is unconditional | `live-run.json` step `07-owner-recovery`, agent revoked to `address(0)` |
| 21 fork proofs | `fork-tests.txt` (pinned block 472700908) |

### Stage 01 — AIRSPACE portfolio spike (verdict REVISE)
`engineering/01-airspace-portfolio-spike/evidence/`

| Claim | Evidence |
|---|---|
| Cross-agent rejection works live | `live-run.json` step `06-agentC-rejected` — 180 + 240 + 150 > 500, `agentCommitted[C]` unchanged |
| Reservations occupy the envelope before filling | steps `04`/`05` — both orders unfilled POST_ONLY at the time C was refused |
| Release then re-admit through a real lifecycle | steps `08`/`09` |
| `marketId → asset` has no on-chain view | `RISK_IDENTITY.md` — 304 selector probes across two MarketCreators and the module implementation |
| 18 fork proofs | `fork-tests.txt` (pinned block 472724061) |

### Stage 02 — Product lock (verdict LOCK, 11/11)
`engineering/02-product-lock/evidence/`

| Claim | Evidence |
|---|---|
| Domains derive on-chain with no attestation | `live-run.json` step `02-structural-domain` — `domainOf(m1) == domainOf(m2) == domainKey(creator, collateral, 14400)` |
| No per-market admission | step `05-agentB` — `ownerTxSinceConfig: 0` across two different markets |
| Individually valid order rejected only by other agents' state | step `06-agentC-rejected` — `DomainRiskExceeded`, C's committed and the domain state both unchanged |
| Sibling switch does not escape the ceiling | step `07-hostile-C`, first entry |
| 11 hostile refusals by a malicious agent | step `07-hostile-C` |
| Concurrency: atomic state picks the winner | step `08-concurrency-race` — B broadcast before A's outcome was known, reverted on-chain |
| Owner recovery with all agents revoked | step `11-owner-recovery` — 5,965.44 tUSDC recovered, residual 0 |
| External fill cannot understate risk | `fork-tests.txt` — `test_R7_externalFillCannotUnderstateRisk` (20 → 40 → 20) |
| Rolling generations stay bounded | `scale-bench.txt` — 500 generations, peak collection size 1 |
| 100 portfolios / 1,000 agents / 10,000 intents | `scale-bench.txt` |
| Shared vs isolated capital efficiency | `sponsor-sim.txt` — **modelled**, schedule stated in the test source |
| 29 fork proofs | `fork-tests.txt` (pinned block 472749135) |

---

## Caveats that travel with the evidence

- **Fork blocks are pinned per stage.** Shannon's 60-second cadence retires markets
  within hours, so a stage's suite only reproduces at its own pinned block with its
  own market ids.
- **`sponsor-sim.txt` is modelled, not measured.** The demand schedule is an
  assumption stated in `AirspaceSponsorImpact.t.sol`; the admitted/rejected counts
  are contract output.
- **`scale-bench.txt` uses mocked DreamDEX counterparties** so that 10,000 intents
  measure contract cost rather than RPC latency. Correctness is proven on the real
  fork.
- **Testnet activity is substantially synthetic.** Behavioural conclusions describe
  a demo environment, not production trader behaviour.
- These are **prototype** deployments from a validation spike: unaudited, with no
  upgrade path, and not intended for real funds.
