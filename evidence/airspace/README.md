# evidence/airspace/

AIRSPACE multi-agent spike artifacts. Chain: Somnia Shannon, chainId **50312**.
Explorer: https://shannon-explorer.somnia.network

## Files

- `live-run.json` — full structured log of the live multi-agent sequence
- `fork-tests.txt` — 18/18 forge fork tests at a pinned block

## Actors — four independent keys

```
OWNER     0x4Bd0bf9821F23f822eb44B1F095594e2BbBC06Bc
AGENT_A   0x551051f987b011329F29E8c069D8cb6ff2C2b084
AGENT_B   0x78D4bdCbAAb1b9c05c9c3c23C6C39fd34064D4cE
AGENT_C   0xe9685258CF6dcb54aBDDC1550A0fa23703527C20
```

Agent keys were funded with STT for gas only. No agent held collateral or
outcome tokens at any point.

## Deployed

```
AirspaceFactory    0xdcf7b2401ee319e40205845c4908992621c52ce6
Portfolio          0xa0d34Dd309Cd061707300A1aa9be2a3Febd0a577
```

## Protocol under test (unmodified, live)

```
BinaryMarketsModule  0x3ecC694Cef705358864a646142ac17A90E29e388
OutcomeToken6909     0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9
tUSDC (collateral)   0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E   (6 decimals)
```

## Portfolio configuration

```
capital base           6,000 tUSDC
risk bucket            keccak256("BTC")
maxGrossDirectional    500 contracts  (500,000,000 raw)
agents                 A, B, C — identical, deliberately generous policies
                       maxCommitted 3,000 tUSDC · maxOrderNotional 2,000 tUSDC
```

Agent policies are generous on purpose: every order in the sequence passes its
own agent's policy in full, so any rejection can only come from the portfolio.

## Markets — two different cadences, same bucket

```
m1  0x…a8cd  BTC  86400s  pool 0x3ae79C8A2C3197B57Af3715B74BA1E96BCE82607  nonce 87
m2  0x…b1dd  BTC   3600s  pool 0xFF52C100d53365365d655Af84b2Db121fE86f0a3  nonce 136
```

## The headline sequence

| # | Step | Tx | Bucket gross |
|---|---|---|---|
| 4 | **AGENT_A** reserves 180 contracts on m1 | `0xe8d3862394f493dabe19f57de4f7b85fff60f63a21d71f3bd2dae89e3edb7077` | 180 |
| 5 | **AGENT_B** reserves 240 contracts on m2 (different cadence) | `0xead1e374953217bfde6ee5f30124ff1f6f868fb26cab6692add77476c0b69f06` | 420 |
| 6 | **AGENT_C** proposes 150 contracts — **REJECTED** | `BucketDirectionalExceeded` | 420 (unchanged) |
| 8 | Owner cancels A's order; **C** calls `releaseOrder` (permissionless) | `0xc8b3cc5e1d969bc752923f5df7d2722ea532363c62fac971d29014a91fc24e7c` | 240 |
| 9 | **AGENT_C** retries the same shape — **ADMITTED** | `0x54ae5be3e9bbd5fba43c385b4be4124ed04fe0f35d2526198e0b5f785cc0b5b0` | 390 |

Step 6 is the product:

```
180 (A) + 240 (B) + 150 (C) = 570 > 500 ceiling
agentCommitted[C] == 0   — C's own budget was never touched
```

C's order was valid under C's own policy. It was rejected solely because of
exposure that **other agents** had created. That is the mechanism.

Steps 4 and 5 were **unfilled POST_ONLY resting orders**. Nothing had filled when
C was rejected, which is the proof that reservations occupy the envelope before
they fill — several agents cannot build hidden aggregate overexposure by resting
orders that all fill later.

## Live negative proofs — hostile AGENT_C

Executed as `eth_call` against live state at the live block: real bytecode, real
storage. Each was required to revert with a specific named error.

```
PoolMismatch          alternate pool
GenerationMismatch    recycled / stale pool generation
PriceOutsidePolicy    price grief above the ceiling
NotOwner              direct collateral withdrawal
NotOwner              outcome-token withdrawal
NotOwner              ownerCall escalation
NotOwner              rewrite another agent's policy
NotOwner              widen the bucket ceiling
NotOwner              admit a market into another bucket
OrderStillLive        release another agent's LIVE reservation
IntentReplayed        replay a used intent
```

## Owner recovery

All three agents revoked, then:

```
collateral recovered   6,000,000,000 raw (6,000 tUSDC)
residual in portfolio  0
```

Recovery reads no policy, agent, market or bucket state.

## Gas

```
execute (2 markets in bucket)   2.7M – 3.4M
releaseOrder                    70k
```

`bucketGross` is O(markets in bucket), capped at 32.

## Reproducing

```bash
# fork proofs (pinned)
export SHANNON_RPC=https://dream-rpc.somnia.network
export FORK_BLOCK=472724061
export BTC_MARKET_1=0x000000000000000000000000000000000000000000000000000000000000a8cd
export BTC_MARKET_2=0x000000000000000000000000000000000000000000000000000000000000b1dd
forge test --match-path test/Airspace.fork.t.sol -vv

# live multi-agent run (needs funded keys in .wallets.json, gitignored)
node script/airspace-live.mjs
```

The fork block is pinned because Shannon's fast windows retire markets within
hours. `airspace-live.mjs` selects live BTC markets dynamically at run time.

## Protocol probes worth keeping

```
ImmediateOrCancelNoFill()  0xd48c4403   BinaryPool reverts a non-crossing IOC
IncorrectOrder()                        getOrder reverts for filled OR cancelled ids
                                        -- identical, which is why exposure is measured

marketId -> seriesId reverse map: ABSENT
  MarketCreator 0x94D963B6…  27,427 bytes,  81 selectors probed
  MarketCreator 0xee3aff92…   8,570 bytes,  52 selectors probed
  Module impl   0xdf87ac5c…  31,419 bytes, 171 selectors probed

marketId -> asset link EXISTS in creation events (unreadable by contracts):
  tx 0x00d40a68ac552fd41d1c3f72750205b7369e7901097ea3eac058eb064b8859b1
  MarketCreator 0x2aba9c41…  topic1=seriesId  topic2=marketId
  Module        0xb5ec75cd…  topic1=marketId  data carries "BTC" / "ETH"
```
