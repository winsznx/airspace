# STRUCTURAL_DOMAINS.md

How AIRSPACE decides which risk envelope an order belongs to, using only values
available and verifiable from authoritative on-chain state during execution.

This replaces the owner-attested asset buckets of the previous revision. There is
no indexer, no owner-supplied "BTC" string, no event-log attestation, no trusted
relayer, and no per-market admission transaction anywhere in the enforcement path.

---

## 1. The domain key

```solidity
domain = keccak256(abi.encode(creator, collateral, cadenceSec))
```

| Field | Source | Read during execution? |
|---|---|---|
| `creator` | `module.markets(marketId)` field 7 | yes, every call |
| `collateral` | `module.markets(marketId)` field 3 | yes, every call |
| `cadenceSec` | canonicalised from `tradingStart` / `expiry`, fields 12 and 13 | yes, every call |

Nothing else. Every input comes from one registry read of the market being traded.

### Why `venueId` is not in the key

It would be redundant. A `MarketCreator` instance carries a single `venueId()`, so
creator determines venue. Verified empirically over 400 consecutive live markets:

```
creator 0xee3aff92…  ->  1 venue (0x1a1e6821…)
creator 0x94d963b6…  ->  1 venue (0x679795a0…)
```

The brief said to add fields only where they materially prevent collisions. This
one prevents none, so it is out.

### Why not the pool

Pools are recycled across markets *and* across underlyings. The sibling TAPE
study found a single pool that served **52 distinct markets spanning both BTC and
ETH**. A pool address carries no durable identity and cannot express "every future
generation of this series". This is exactly the mistake a pool allowlist makes.

---

## 2. Cadence canonicalisation

Raw `expiry - tradingStart` is **not** safe to use directly. Scanning 1,200
consecutive live markets found real off-cadence windows:

```
   60s : 932
  300s : 186
  900s :  60
 3600s :  16
14400s :   4
  898s :   2   <-- late roll on a 900s series
```

Two markets had an 898-second window on a 900-second series. Keyed raw, they would
have formed their own domain and escaped the 900s ceiling entirely. The SDK
documents this jitter independently (`snapIntervalSec`, tolerance 2s, "899 → 900"),
but a heuristic tolerance is not good enough for an enforcement path.

The rule AIRSPACE uses instead is exact and deterministic:

> **cadence = the smallest canonical value `C` such that `C >= (expiry - tradingStart)`
> and `expiry % C == 0`. If none matches, the market has no domain.**

```solidity
uint32[7] CANONICAL = [60, 300, 900, 1800, 3600, 14400, 86400];
```

Both conditions are load-bearing:

- `C >= window` stops a short market escalating into a longer domain.
- `expiry % C == 0` uses the fact that series expiries are wall-clock aligned, so a
  60-second market never satisfies it for 900 unless its window also fits.
- Taking the **smallest** match is what makes it a function rather than a choice.

Validated against 1,200 consecutive live markets:

```
unresolved markets: 0

cadence=    60s markets= 932 rawWindowsAbsorbed={60}
cadence=   300s markets= 186 rawWindowsAbsorbed={300}
cadence=   900s markets=  62 rawWindowsAbsorbed={898,900}   <-- jitter absorbed
cadence=  3600s markets=  16 rawWindowsAbsorbed={3600}
cadence= 14400s markets=   4 rawWindowsAbsorbed={14400}
```

Zero unresolved, zero cross-contamination, and the 898s markets land where they
belong. Unit-tested in `test_D1_cadenceCanonicalisation`.

A window matching no canonical cadence resolves to domain `0` and reverts
`NoStructuralDomain`. **Fail closed**: an unrecognised market is untradable, never
unlimited.

---

## 3. What this is, and what it is not

**It is a cadence domain.** A ceiling on a domain bounds directional exposure
across every market that this creator issues, in this collateral, at this cadence.

**It is not an asset.** The contract cannot tell BTC from ETH, and nothing in the
product may claim it can. Sibling series of the same cadence from the same creator
resolve to the **same** domain. This is intentional, and it is proven live:

```
domainOf(0xb278)  =  0xdc493f0f…
domainOf(0xb277)  =  0xdc493f0f…      <- identical
domainKey(creator, collateral, 14400) = 0xdc493f0f…
```

Two distinct markets, two distinct pools (`0xC3E2b06a…` and `0x31246c0D…`), two
distinct generations (nonce 91 and 105), one domain.

Two consequences follow directly, and both are features rather than apologies:

1. A ceiling of 500 contracts on the 4-hour domain means 500 contracts of gross
   directional exposure across *both* sibling series combined, not 500 each.
2. An agent cannot escape a saturated ceiling by switching to the sibling market.
   Proven live and on fork (`test_H5_siblingSwitchDoesNotEscapeTheCeiling`).

If an operator genuinely needs separate BTC and ETH limits, this design cannot
give them, and no amount of engineering on the current protocol surface can --
see `../01-airspace-portfolio-spike/RISK_IDENTITY.md` for the exhaustive 304-selector search that established
there is no on-chain `marketId -> asset` view. The honest options are a coarser
but trustless domain (what AIRSPACE ships) or a semantic attestation in the
security path (what AIRSPACE deliberately removed).

### Non-authoritative labels

Off-chain tooling may map a domain to a human label ("4h contracts on venue X")
and may show the indexer's `asset` field alongside a market. Any such label is
**NON_AUTHORITATIVE** and must be marked so wherever it is displayed. It never
enters enforcement, and no contract state depends on it.

---

## 4. No per-market admission

`setDomainPolicy(domain, policy)` is called **once**. It covers every market that
series will ever roll, forever. A market created one second ago is admissible the
moment it exists, with no configuration and no owner transaction.

Proven three ways:

- **Fork** (`test_D5_noPerMarketAdmissionTransaction`): the owner's transaction
  nonce is captured, two different markets in the domain are traded by two
  different agents, and the nonce is asserted unchanged.
- **Live**: the run records `ownerTxSinceConfig: 0` between configuring the domain
  and agent B trading a *different* market from agent A.
- **Rolling generations** (`test_S4_rollingGenerationsStayBounded`): 500
  consecutive 60-second generations, each asserted to resolve to the *same*
  domain, with zero configuration in between.

There is no migration step between generations either. Nothing in the contract
stores a "current market"; each execution re-derives the domain from the registry.

---

## 5. Generation safety

The domain says *which envelope*. It does not weaken any of the per-market
structural checks, which still run on every execution:

- `pool` must equal the module registry's pool for that `marketId`.
- `pool.marketNonce()` must equal the generation in the intent.
- A market already tracked may not change pool, generation or domain underneath
  the portfolio (`GenerationMismatch`).
- Position state is read at the generation the portfolio actually traded, using
  `outcomeId = (pool << 72) | (nonce << 8) | idx`, so a later recycle of the same
  pool address cannot alias an earlier market's holdings.

---

## 6. Trust summary

| Input | Trust |
|---|---|
| `creator`, `collateral`, `tradingStart`, `expiry` | on-chain registry, read per execution |
| canonical cadence table | contract constant, deterministic |
| domain -> policy ceiling | owner, and only the owner's own risk appetite |
| domain -> human label | **NON_AUTHORITATIVE**, outside enforcement |

The owner still chooses *how much* risk to run in a domain. That is a preference,
not an attestation about the world: it cannot be wrong about a fact, and an agent
cannot forge it. The previous revision's bucket assignment was an attestation
about the world -- "this market is BTC" -- and it is gone.
