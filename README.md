# Somnia × DreamDEX — AIRSPACE

**One capital pool. Many trading agents. One shared risk envelope.**

Several independently controlled DreamDEX Event Contract agents share one capital
base. Every proposed order must pass both its local agent policy and atomic
portfolio-wide admission. An individually legal order is rejected when reservations
or positions created by *other* agents have already consumed portfolio risk capacity.

Dominant mechanism: **cross-agent portfolio admission + reservation + post-trade
reconciliation.** Not an AI trader.

**Verdict: LOCK** — [VERDICT_V3.md](VERDICT_V3.md)

## The result, live on Shannon

```
domain = keccak256(creator, collateral, canonicalCadence)   derived on-chain, no attestation

AGENT_A reserves 180                        ->  180 / 500
AGENT_B reserves 240 on a different market  ->  420 / 500
AGENT_C proposes 150   ->  DomainRiskExceeded
        C's own policy passed. Every market check passed.
        agentCommitted[C] unchanged. Domain state unchanged.
release A  ->  320 / 500      C retries the identical shape  ->  ADMITTED, 470 / 500
```

A's and B's orders were **unfilled** — proof that reservations occupy the envelope
before they fill. 76 tests pass.

## Documents

| File | What it answers |
|---|---|
| [VERDICT_V3.md](VERDICT_V3.md) | The verdict and its limits |
| [AIRSPACE_LOCK_REPORT.md](AIRSPACE_LOCK_REPORT.md) | Full lock report, sponsor impact, Reactivity |
| [STRUCTURAL_DOMAINS.md](STRUCTURAL_DOMAINS.md) | Domain derivation and cadence canonicalisation |
| [PORTFOLIO_ACCOUNTING_V2.md](PORTFOLIO_ACCOUNTING_V2.md) | The six quantities, measured vs tracked |
| [RESERVATION_INVARIANTS.md](RESERVATION_INVARIANTS.md) | State machine and per-invariant proofs |
| [SCALING_REPORT.md](SCALING_REPORT.md) | Gas, storage growth, bounded collections |
| [COMPETITOR_LOCK_DELTA.md](COMPETITOR_LOCK_DELTA.md) | The reduction test; Vane from bytecode |
| [LIVE_LOCK_EVIDENCE.md](LIVE_LOCK_EVIDENCE.md) | Transaction hashes and expected state |

## Code

```
src/airspace/AirspacePortfolio.sol         the portfolio boundary
src/airspace/AirspacePortfolioFactory.sol  deterministic per-owner clones
test/AirspacePortfolio.fork.t.sol          29 proofs against the live deployment
test/AirspaceScale.t.sol                    5 deterministic scale benchmarks
test/AirspaceSponsorImpact.t.sol            3 modelled capital-efficiency sims
script/airspace-lock-live.mjs               live 4-key multi-agent driver
```

## Protocol findings that shaped the design

- **`marketId → asset` exists on-chain in creation events but no view exposes it** —
  304 selector probes across both MarketCreators and the module implementation. So
  domains are *cadence* domains: the contract does not know BTC from ETH and never
  claims to. Sibling series share a domain, intentionally.
- **Cadence jitter is real** — two live markets had an 898-second window on a
  900-second series. Raw `expiry - tradingStart` is unsafe as a domain key.
- **`getOrder` reverts identically for filled and cancelled orders**, so a running
  exposure counter cannot stay correct. Positions are measured from ERC-6909.
- **`placeBinaryOrderFor` reverts `OnlyApprovedContracts()` for every EOA caller**,
  so there is no session-key path for Event Contracts — custody-by-account is forced.
- **Pools are recycled across markets and underlyings** (one served 52 markets across
  both BTC and ETH), so a pool allowlist binds to a mutable slot.

## Reproduce

```bash
forge build
export SHANNON_RPC=https://dream-rpc.somnia.network

export FORK_BLOCK=472749135
export MKT_1=0x000000000000000000000000000000000000000000000000000000000000b278
export MKT_2=0x000000000000000000000000000000000000000000000000000000000000b277
forge test --match-path test/AirspacePortfolio.fork.t.sol -vv

forge test --match-path test/AirspaceScale.t.sol -vv
forge test --match-path test/AirspaceSponsorImpact.t.sol -vv
```

---

## Prior spikes (retained unchanged for auditability)

**AIRSPACE v1** — verdict REVISE. Owner-attested asset buckets; the per-market
admission burden and the attestation are what this revision removed.
[VERDICT_V2.md](VERDICT_V2.md) · [AIRSPACE_FINDINGS.md](AIRSPACE_FINDINGS.md) ·
[PORTFOLIO_ACCOUNTING.md](PORTFOLIO_ACCOUNTING.md) · [RISK_IDENTITY.md](RISK_IDENTITY.md) ·
[AUTHORITY_MODEL_V2.md](AUTHORITY_MODEL_V2.md) · [COMPETITOR_DELTA_V2.md](COMPETITOR_DELTA_V2.md) ·
[THREAT_MODEL_V2.md](THREAT_MODEL_V2.md) · [evidence/airspace/](evidence/airspace/README.md)

**FLIGHTPATH** — verdict REVISE. Single-agent execution assurance; architecture
sound, positioning collided with Vane.
[VERDICT.md](VERDICT.md) · [SPIKE_FINDINGS.md](SPIKE_FINDINGS.md) ·
[AUTHORITY_MODEL.md](AUTHORITY_MODEL.md) · [COMPETITOR_DELTA.md](COMPETITOR_DELTA.md) ·
[THREAT_MODEL.md](THREAT_MODEL.md) · [evidence/](evidence/README.md)
