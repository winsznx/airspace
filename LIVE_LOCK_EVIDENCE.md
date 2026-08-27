# LIVE_LOCK_EVIDENCE.md

The live multi-agent demonstration on Somnia Shannon (chainId 50312), against the
unmodified deployed DreamDEX Event Contracts.

Full structured log: `evidence/airspace-lock/live-run.json`
Explorer: https://shannon-explorer.somnia.network

---

## Actors — four independent keys

```
OWNER     0x4Bd0bf9821F23f822eb44B1F095594e2BbBC06Bc
AGENT_A   0x551051f987b011329F29E8c069D8cb6ff2C2b084
AGENT_B   0x78D4bdCbAAb1b9c05c9c3c23C6C39fd34064D4cE
AGENT_C   0xe9685258CF6dcb54aBDDC1550A0fa23703527C20
```

Agent keys hold STT for gas only. No agent held collateral or outcome tokens at any
point in the run.

## Deployed

```
AirspacePortfolioFactory  0x04435480444159b6f6d1398dc84f560c6fc3bbb6
Portfolio                 0x2F9BE34ae56C7be945211e011CC189ECC5941Ab8
```

## Protocol under test (unmodified, live)

```
BinaryMarketsModule  0x3ecC694Cef705358864a646142ac17A90E29e388
OutcomeToken6909     0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9
tUSDC (collateral)   0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E   (6 decimals)
```

---

## 1. Structural domain, derived on-chain

Two **different markets**, **different pools**, **different generations**:

```
m1  0xb278   pool 0xC3E2b06a7a9e35170785a01595A09e4Aed8a78DF   nonce 91
m2  0xb277   pool 0x31246c0DECA791C051094801aF218D5387dC24a2   nonce 105
```

Both resolve to one domain, computed by the contract from the module registry with
no attestation supplied:

```
domainOf(m1)          = 0xdc493f0f81932a6e471efcad80e75a0a2620166eb9dacf398d99a62fe7a26900
domainOf(m2)          = 0xdc493f0f81932a6e471efcad80e75a0a2620166eb9dacf398d99a62fe7a26900
domainKey(creator, collateral, 14400) = 0xdc493f0f…

creator     0x94D963B6670AB96E78C8d0C46ca35D196d606EFE
collateral  0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E
cadenceSec  14400   (derived: expiry - tradingStart, canonicalised)
```

No indexer, no asset string, no event-log attestation, no relayer.

## 2. Configuration — one domain call, then nothing

```
setDomainPolicy(domain, { maxDomainRiskUsage: 500 contracts, … })   ONE transaction
setAgent(A) · setAgent(B) · setAgent(C)
```

After that the owner sent **zero** transactions while agents traded two different
markets. Recorded in the run as `ownerTxSinceConfig: 0`.

---

## 3. The required sequence

| Step | Tx | Domain risk usage |
|---|---|---|
| **AGENT_A** reserves 180 contracts on m1 | `0xc5541d26fe40a0aca94bbc9c0a087abd57e8feda108134cc2925d3bfd98532d2` | 180 / 500 |
| **AGENT_B** reserves 240 contracts on m2 | `0xa298ed4977f89e793d32b74146493de21b70c9b003c0b0e3839d2569cffb0275` | **420 / 500** |
| **AGENT_C** proposes 150 — **REJECTED** | `DomainRiskExceeded` | 420 (unchanged) |
| Owner cancels A's order | `0x3a86d52898a7c3c591fe42fb3cc4b266acb0ae2f66dba6258f89d8e31cb1c722` | |
| **AGENT_C** calls `releaseOrder` (permissionless) | `0xa60e54b2c8ad098317163116efb040c1fece900aaab83136c7c882d2005e4039` | 320 |
| **AGENT_C** retries the same shape — **ADMITTED** | `0x2ef3df611cfa29ed9fbae24a96b3dfc339566c3460fc5a3b01d15611583eb6e8` | 470 / 500 |

### The rejection, in full

```
arithmetic:            180 (A) + 240 (B) + 150 (C) = 570 > 500 ceiling
error:                 DomainRiskExceeded
agentCommitted[C]:     0 before  ->  0 after      (unchanged)
domainRiskUsage:       420 before -> 420 after     (unchanged)

C's own policy at the time of rejection:
  maxOrderNotional  3,000 tUSDC     (order needed far less)
  maxCommitted      4,000 tUSDC
  maxBuyPrice       990,000         (order price well under)
```

Every market validity check passed. C's individual policy passed. C was rejected
**solely** because of reservations created by A and B, and no state changed as a
result of the rejection.

Both A's and B's orders were **unfilled POST_ONLY resting orders** — nothing had
filled when C was refused. That is the proof that reservations occupy the envelope
before they fill.

---

## 4. Hostile AGENT_C — eleven live refusals

Executed as `eth_call` against live state at the live block: real bytecode, real
storage. Each was required to revert with a specific named error.

```
DomainRiskExceeded   sibling-market switch (m2) does not escape the domain
PoolMismatch         alternate pool
GenerationMismatch   recycled / stale generation
PriceOutsidePolicy   price grief
NotOwner             direct collateral withdrawal
NotOwner             outcome-token withdrawal
NotOwner             ownerCall escalation
NotOwner             rewrite another agent's policy
NotOwner             widen the domain ceiling
IntentReplayed       replay a used intent (attempted as A)
OrderStillLive       release another agent's LIVE reservation
```

The first and last are the multi-agent-specific ones: switching to the sibling
series consumes the same headroom rather than escaping it, and a rival agent cannot
free capacity by claiming someone else's live order is dead.

---

## 5. Concurrency race

Ceiling tightened to leave 100 contracts of headroom. A and B each submitted an
80-contract order, broadcast concurrently via `Promise.allSettled` — neither knew
the other's outcome.

```
A  0xa146bc08751da6ae31773201f8728d33d2e2d5f4866eb61e4634af260e0fce42  success   block 472753757
B  0x6fe4204c783e42e0ae67f776b7c6d7a04badf06f9cc879347f03f4d8b62e6480  REVERTED  block 472753761
domainRiskUsage after: 500 / 500
```

B's transaction was **broadcast before A's result was known and reverted on-chain**.
Atomic contract state picked the winner; there was no off-chain mutex.

**Stated honestly:** the two landed in different blocks (four apart), so this is a
concurrent-submission proof, not a same-block one. The same-block property is proven
on fork, where `block.number` is asserted unchanged across both attempts:

- `test_X2_twoAgentsRaceOneHeadroom_sameBlock` — 2 agents, 1 winner
- `test_X3_threeAgentsRace` — 3 agents, 1 winner
- `test_X3b_tenAgentsRace` — 10 agents, cap admits exactly 2, all in one block

---

## 6. Owner recovery

All three agents revoked, resting orders cancelled, then a single sweep:

```
recovered   5,965,440,000 raw  (5,965.44 tUSDC)
residual    0
```

Recovery reads no policy, no agent state, no domain state and no market state.

---

## 7. Live gas

```
execute (first touch of a market)   4,370,629
execute (market already tracked)    4,213,939
execute (domain holds 2 markets)    2,544,622
releaseOrder                           70,034
```

≈ 0.026 STT per intent at Shannon's 6 gwei. The dominant term is the DreamDEX
placement itself — the single-agent FLIGHTPATH spike measured 1.55M gas for a bare
placement through a far simpler contract.

---

## 8. Fork suite

`evidence/airspace-lock/fork-tests.txt` — **29/29** at pinned block 472749135
against markets `0xb278` / `0xb277`.

Includes the adversarial reconciliation test `test_R7_externalFillCannotUnderstateRisk`,
in which an unrelated account mints a complete set and fills the portfolio's resting
bid in a transaction the portfolio never sees:

```
usage before external fill : 20 contracts
usage after  external fill : 40 contracts   (overstated -- the safe direction)
after releaseOrder         : 20 contracts   (converges to truth)
```

## 9. Reproducing

```bash
export SHANNON_RPC=https://dream-rpc.somnia.network
export FORK_BLOCK=472749135
export MKT_1=0x000000000000000000000000000000000000000000000000000000000000b278
export MKT_2=0x000000000000000000000000000000000000000000000000000000000000b277
forge test --match-path test/AirspacePortfolio.fork.t.sol -vv

forge test --match-path test/AirspaceScale.t.sol -vv
forge test --match-path test/AirspaceSponsorImpact.t.sol -vv

node script/airspace-lock-live.mjs     # needs funded keys in .wallets.json (gitignored)
```

The fork block is pinned because Shannon's fast cadences retire markets within
hours. The live driver enumerates markets straight from the module registry
(`marketId` is a sequential counter) and selects a live pair sharing one structural
domain at run time — no indexer, in the driver either.
