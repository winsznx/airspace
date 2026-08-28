# 03 — SUPERSEDED / UNSAFE: AIRSPACE v1.0.0

**This stage is preserved unchanged as the record of a safety failure.**
Nothing here is corrected, and nothing here should be reused.

## What is in here

| | |
| --- | --- |
| `contract/AirspacePortfolio.v1.0.0.UNSAFE.sol` | The deployed implementation, byte-for-byte as it ran |
| `evidence/CRITICAL-reservation-netting.md` | The finding, written before any fix existed |
| `evidence/deployment-v1.json` | The addresses that carried the defect |
| `evidence/*.json` | Every live measurement taken against it, including the ones that looked good |

## The failure, in one line

`_directional` netted **independent unfilled reservations** on opposing sides of
a market against each other, so `domainRiskUsage` could report far below true
maximum commitment, and the portfolio admitted intents it should have refused.

Opposing **realized** YES and NO balances may net: a held complete set has fixed
combined value whichever way the market resolves. Opposing **resting orders** may
not, because either can fill without the other.

## Measured

| block | contract reported | true worst case | realized only | ceiling |
| --- | --- | --- | --- | --- |
| 473455000 | 820 | 2,480 | 1,000 | 500 |
| 473458000 | 1,000 | 2,320 | 1,000 | 500 |
| 473461234 | 1,120 | 1,160 | 1,000 | 500 |

42 of 67 admissions on the affected domain occurred while true worst case was
already over the ceiling. The first was block 473413080, transaction
`0x2f4edce9353003c42c89531a049e5de729121c2ac626f0a81e49ae8ec9cfd7f2` — the
contract saw 530 and admitted; the truth was 1,280.

## Why the deployment is not upgraded

There is no proxy and no upgrade path on a live portfolio, which was a
deliberate choice recorded in DECISIONS. The replacement is a **new deployment
at new addresses**. This one is not relabelled, patched or hidden: it is the
thing that was actually running when the evidence in this folder was collected,
and the evidence only means anything if the contract beside it is unchanged.

Addresses in `evidence/deployment-v1.json` are **SUPERSEDED / UNSAFE**. Do not
fund them. See the repository root for the current deployment.
