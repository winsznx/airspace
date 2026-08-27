# SCALING_REPORT.md

Gas and storage behaviour at 100 portfolios, 1,000 agents, 10,000 intents, and
continuously rolling market generations.

**Method.** Correctness is proven against the real deployment on a forked Shannon
(`test/AirspacePortfolio.fork.t.sol`, 29 tests). The scale numbers here come from
`test/AirspaceScale.t.sol`, which drives the **real `AirspacePortfolio` contract**
against mocked DreamDEX counterparties. The mocks are deliberate: 10,000 intents
over a forked RPC would measure network latency, not contract cost. Every mock
signature mirrors the real contract, and the mock pool **rests every order**, which
is the worst case for reservation storage.

Live gas figures at the end are measured on Shannon, not modelled.

---

## 1. Results

| Benchmark | Result | Test |
|---|---|---|
| 100 portfolios deployed | 11,542,169 gas total, **115,421 per portfolio** | `S1` |
| 1,000 agents registered across 100 portfolios | 78,916,096 gas total, **78,916 per agent** | `S2` |
| 10,000 intents, 10 agents, one portfolio | 3,869,068,056 gas total, **386,906 per intent** | `S3` |
| 500 consecutive 60-second generations | peak domain collection **1**, final **0** | `S4` |
| Full domain read (48 markets) | **244,164 gas** | `S5` |

Per-portfolio and per-agent costs are flat: portfolios are independent minimal-proxy
clones with no shared storage and no global registry, so 100 costs exactly 100× one.

---

## 2. Does any collection grow without bound?

Answered precisely, because the distinction matters more than a yes or no.

**No collection that is ITERATED grows without bound.** Gas per operation is O(1)
with respect to history.

| Collection | Iterated? | Bounded? |
|---|---|---|
| `_domainMarkets[domain]` | **yes**, by `domainRiskUsage` and `liveMarkets` | **yes** — hard cap `MAX_MARKETS_PER_DOMAIN = 48`, and prunable |
| `intentUsed` | no | no — one slot per accepted intent |
| `_orders` | no | no — one record per resting order |
| `_market` | no | no — one record per market ever touched |
| `agentCommitted`, `_agentPolicy` | no | bounded by the number of agents the owner registers |

The three unbounded mappings are pure key-value lookups. They are never enumerated,
so they add storage but not gas per operation. Monotonic storage growth is inherent
to replay protection — any system that remembers "this intent was used" has it.

**Mitigation available and not yet built:** replace the `intentUsed` set with a
monotonic per-agent nonce (`require(intent.nonce > lastNonce[agent])`), which bounds
replay protection to one slot per agent instead of one per intent. It costs ordered
nonce submission per agent. Recorded as an improvement, not shipped.

### The iterated collection is genuinely bounded

`S5` drives a domain to its cap: the 49th market is refused, so the collection
**fails closed** rather than growing. A full 48-market domain reads in 244,164 gas,
which is the worst case bound on the iteration inside `execute`.

`S4` is the rolling-market case that motivated the cap. 500 consecutive 60-second
generations, each traded, cancelled, released and pruned:

```
generations processed:        500
peak domain collection size:    1
final domain collection size:   0
```

Every generation was asserted to resolve to the **same** domain with zero
configuration. The collection never exceeded one entry, because `pruneMarket` is
permissionless and a spent generation qualifies immediately.

**Pruning is not optional at high cadence.** A portfolio trading a 60-second series
continuously and never pruning would hit the 48-market cap in ~48 minutes and stop
admitting new generations. It would fail closed, not overflow — but it would stop.
Production needs a keeper calling `releaseOrder` / `releaseSettled` / `pruneMarket`;
Reactivity is the natural driver (`AIRSPACE_LOCK_REPORT.md` §7).

---

## 3. Live gas, measured on Shannon

| Operation | Gas | Tx |
|---|---|---|
| `execute` (first touch of a market, order rests) | 4,370,629 | `0xc5541d26…` |
| `execute` (market already tracked) | 4,213,939 | `0xa298ed49…` |
| `execute` (third, domain has 2 markets) | 2,544,622 | `0x2ef3df61…` |
| `releaseOrder` | 70,034 | `0xa60e54b2…` |

At Shannon's 6 gwei, 4.4M gas is ≈ 0.026 STT per intent. The dominant term is the
DreamDEX placement itself, not AIRSPACE: the single-agent FLIGHTPATH spike measured
1.55M gas for a bare IOC placement through a much simpler contract.

The gap between the mock's 386,906 and the live 4.37M is the real pool, the real
ERC-6909 singleton and the real order book. The mock number isolates AIRSPACE's own
bookkeeping; the live number is what an operator actually pays.

---

## 4. Sensitivity

The only super-constant term inside `execute` is the domain iteration, which is
O(markets in domain) with a hard bound of 48. Measured at 244,164 gas for a full
domain, so worst-case `execute` is roughly the live figure plus ~0.24M.

Everything else — agent lookup, replay check, market state, order record — is O(1).

Portfolio count does not enter any hot path: portfolios share nothing.

---

## 5. Honest limits of this report

- The 10,000-intent figure is **modelled**, against mocks that rest every order.
  A production mix of IOC and resting orders would write fewer order records and
  cost less.
- `S4`'s 500 generations use mock pools, so pool recycling is simulated by a
  `marketNonce` bump rather than the protocol's real free-pool machinery. The
  generation-binding logic it exercises is the same code the fork tests run against
  real recycled pools.
- No test here measures a portfolio with 48 markets **and** 1,000 agents
  simultaneously; the two dimensions are independent in the code (agents are a
  mapping, markets an array) but that specific combination is untested.
- Shannon block gas limits were not probed. A 4.4M-gas transaction landed
  repeatedly during the live run, so the practical limit is above that, but the
  headroom is unmeasured.
