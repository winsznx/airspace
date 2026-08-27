# SPIKE_FINDINGS.md

Hostile feasibility spike on FLIGHTPATH, an execution assurance layer for DreamDEX
Event Contract trading agents. Everything below was verified against the live
Somnia Shannon deployment (chainId 50312) or the deployed bytecode. Where a claim
comes from documentation rather than the chain, it is labelled as such.

Date: 2026-08-27. SDK: `@somnia-chain/markets-sdk@0.28.1`.

---

## 0. Summary of what the protocol actually permits

| Question | Answer | How verified |
|---|---|---|
| `BinaryPool.placeBinaryOrder` exists | Yes, selector `0x718c2d4d` | Selector present in pool impl bytecode; called successfully live |
| `BinaryPool.placeBinaryOrderFor` exists | Yes, selector `0x5d97c566` | Present in impl bytecode |
| Can an EOA use `placeBinaryOrderFor`? | **No.** Reverts `OnlyApprovedContracts()` | Live `eth_call`, both third-party and self-for |
| Operator permission registry on binary pools | **Absent.** No `isOperatorAuthorized`, no registry getter | Selector `0xa8cb3794` absent from pool impl bytecode |
| Manual vault mode on binary pools | **Absent** (SpotPool-only) | Selector `0xfc7b1853` absent; SDK source says so explicitly |
| Can a *contract* call `placeBinaryOrder`? | **Yes** | `eth_call` with state-override giving the caller code: identical revert path (reached the collateral pull) |
| Collateral custody | Escrow pulled from `msg.sender` via ERC-20 allowance to the pool | SDK `orders.js`; confirmed live (spend left the account) |
| Outcome-token custody | ERC-6909 on a shared singleton, credited to `msg.sender` | Live: account holds 200,000,000 YES, agent holds 0 |
| Redemption path | `BinaryMarketsModule.redeem(...)` pulls the *caller's* winning tokens | SDK `moduleAbi.js` |
| Market status authority | On-chain only; indexer lags and is provably wrong | See §4 |
| Pools recycled | **Yes, aggressively** — observed `marketNonce` up to 1431 | Indexer + on-chain `marketNonce()` |
| Order tick/lot grid | Read per-pool from `getOrderBookParameters()`; observed `(1000, 1000, 1000)` | Live read |
| EIP-7702 relevance | **None meaningful here** — see §6 |
| Somnia Reactivity | Available; precompile `0x…0100`, no bytecode by design | SDK `/reactivity`; Vane's deployed handler confirms production use |

---

## 1. The decisive finding: there is no session-key path for Event Contracts

DreamDEX ships a well-documented split-key "operator" model — a hot bot key that
places orders on an owner's behalf and can never withdraw, enforced by an on-chain
`OperatorPermissionsRegistry`. On first read this appears to make FLIGHTPATH
redundant.

It does not apply to Event Contracts.

The registry is wired into **SpotPool and PerpPool only**. The SDK says so in its
own source (`tradeAbi.ts`, `operatorAuthorizationReadAbi`): *"BOTH pool families,
deliberately. SpotPool and PerpPool declare this identically…"* — binary pools are
not in that set. Verified against the deployed `binaryPoolImpl`
(`0x82A1FcdaA2daC2fC7D5f9909D43E68021eE966FD`): the selector for
`isOperatorAuthorized(address,address,bytes4)` (`0xa8cb3794`) does not appear in
the bytecode at all, nor do `operatorRegistry()`, `operatorPermissions()`, or
`setManualVaultMode(bool)`.

`placeBinaryOrderFor` does exist on the pool, but it is not user-grantable. Called
live against pool `0xc09e4a5b…` on Shannon:

```
placeBinaryOrderFor(owner=OWNER, …) from AGENT  -> revert 0x3fb0ba2e
placeBinaryOrderFor(owner=AGENT, …) from AGENT  -> revert 0x3fb0ba2e   # self-for
placeBinaryOrder(…)               from OWNER    -> revert 0xfb8f41b2   # ERC20InsufficientAllowance
```

`0x3fb0ba2e` decodes against the SDK's 418-entry generated error table as
**`OnlyApprovedContracts()`**. It is a protocol-level allowlist for periphery
contracts (the CollateralRouter and similar), not a permission a user can grant.
Note the third line: the *self* path reaches the collateral pull, so the difference
is authorization, not argument validity.

**Consequence.** Any FLIGHTPATH design that claims to constrain an agent while user
capital stays in the user's own EOA is dishonest on this venue. There is no
delegation primitive to attach a constraint to. This kills architecture B outright
and is the single most important result of the spike.

---

## 2. Contract callers are not blocked

The mirror question matters just as much: if binary pools rejected contract callers,
architecture A would be dead too and the answer would be KILL.

Tested with an `eth_call` state override that gives the caller bytecode, so the pool
sees `EXTCODESIZE > 0`:

```
placeBinaryOrder from EOA-shaped caller       -> 0xfb8f41b2 ERC20InsufficientAllowance
placeBinaryOrder from contract-shaped caller  -> 0xfb8f41b2 ERC20InsufficientAllowance   (identical)
```

Identical revert, reaching the collateral pull in both cases. Contract callers are
first-class. Confirmed conclusively by the live trade in §7, executed by a contract.

---

## 3. Outcome-token identity is `(pool, marketNonce)`, not `marketId`

The ERC-6909 outcome id encoding, from the SDK's `ids.ts` and mirrored on-chain:

```
id        = (uint160(pool) << 72) | (uint64(nonce) << 8) | idx
marketKey = id >> 8
```

Pools are recycled across windows and `marketNonce` is the reuse generation. Live
sample of finalized 60-second markets shows how aggressive this is:

| pool | marketNonce |
|---|---|
| `0x408c5f8b…` | 1431 |
| `0x56154c18…` | 734 |
| `0x141f15dd…` | 711 |
| `0x25b845e0…` | 571 |

**Consequence for policy design.** A policy that allowlists *pool addresses* — which
is the obvious first instinct, and what at least one competing implementation
appears to do — is binding to a mutable slot. The same address serves a different
market minutes later with different outcome ids. The DreamDEX docs warn about this
directly: *"Key state by `marketId` or symbol, never by pool address — pools are
recycled across windows."*

FLIGHTPATH therefore binds the *generation*: it requires the module registry's
`yesId`/`noId` to equal the ids derived from `(pool, intent.marketNonce)`, and
requires the pool's live `marketNonce()` to match. Proven live as
`GenerationMismatch`.

---

## 4. The indexer's market status is provably unreliable

Querying the indexer for `clobStatus == "Trading"` ordered by expiry ascending
returned 20 markets whose `expiry` was **~5 weeks in the past**
(`1784667600` vs a wall clock of `1787842306`). The indexer had never moved them off
`Trading`.

Separately, the documented testnet `VENUE_ID`
(`0x679795a0…`) is only one of the live venues; markets are also being produced
under `0x1a1e6821…`, which appears in no documentation. The docs do warn that venue
ids move.

**Consequence.** Every gate in FLIGHTPATH reads the chain. The indexer is used only
to *shortlist* candidate markets in the off-chain driver; the account itself never
sees indexer data. Authoritative "Trading" is composed on-chain from:
`!pool.finalized()`, `!market.isResolved()`, `!market.isVoided()`, and
`tradingStart <= block.timestamp < expiry`.

---

## 5. What is *not* on-chain enforceable: the asset gap

This is the most important negative result for the policy model, and it constrains
the product.

The required control "allowed asset/cadence" splits in two:

- **Cadence is on-chain derivable.** `expiry - tradingStart` from the module record
  equals the series `intervalSec`. Verified across daily/4h/1h/15m markets.
- **Asset is not derivable from a marketId.** The module's `MarketRecord` carries no
  asset. `BinaryMarket` exposes no `asset()`, `question()`, or `seriesId()` —
  all revert. `oracleQuestionId` is *not* a series identifier: it increments
  per-market (45510, 45511, 45674, 45675, …), roughly tracking `marketId`.

The only on-chain surface naming an asset is
`MarketCreator.seriesById(uint32)` → `(collateral, asset, numericDecimals,
intervalSec, settlementWindow)`. But there is no reverse map from `marketId` to
`seriesId`, and sibling series are indistinguishable by every other field. Live
enumeration of the production MarketCreator `0x94D963B6…`:

| seriesId | asset | intervalSec | latestExpiry |
|---|---|---|---|
| 1 | BTC | 900 | 1787842800 |
| 2 | ETH | 900 | **1787842800** |
| 3 | BTC | 3600 | 1787842800 |
| 4 | ETH | 3600 | **1787842800** |
| 7 | BTC | 86400 | 1787875200 |
| 8 | ETH | 86400 | **1787875200** |

Series 1 and 2 share creator, collateral, cadence *and* expiry. Given a `marketId`,
on-chain data cannot tell you which of the two produced it.

**Consequence.** `BindMode.EXACT` (owner names the `marketId`) is the only fully
structural mode. `BindMode.SERIES` is structural for creator, collateral, cadence
and the asset *string as read from the chain*, but carries a disclosed residual:
an agent could substitute the sibling-asset market at the same cadence. This is
documented, not hidden, and is why the shipped default is EXACT. See
`AUTHORITY_MODEL.md` for the per-field verifiability table.

---

## 6. EIP-7702 offers nothing here

7702 lets an EOA temporarily execute code. It is sometimes proposed as a way to
"constrain an agent's own wallet." On this venue it fails for a structural reason
that has nothing to do with 7702's mechanics:

The constraint must sit between the agent and the *pool*. Under 7702 the delegated
code runs with `msg.sender == the EOA`, so escrow and fills route to that EOA — which
is what you want — but the authority to install, replace, or remove the delegation
belongs to the EOA's own key. If the agent holds that key, it removes the
delegation and trades unconstrained. If the owner holds it, the owner is signing
every session anyway and has simply rebuilt a worse version of the vault with extra
steps and no aggregate-state storage across windows.

7702 also cannot rescue `placeBinaryOrderFor`: the pool's `OnlyApprovedContracts()`
gate is on the *caller*, and a 7702-delegated EOA is still not on the protocol's
approved list.

The bot-kit's own `advanced/batch-7702/` example uses 7702 for **transaction
batching** (`DreamDexVolumeBatch7702.sol`), not for permissioning. That is the
correct use of it here, and it is orthogonal to FLIGHTPATH.

---

## 7. Live proof

Deployed and driven end-to-end on Shannon. Full log: `evidence/live-run.json`.

- Factory: `0x96F5f7aCED65149440dC8807C2CD2f66514fc2a2`
- Execution account: `0x083663A3849b795F423F6d8E9129394A479484Bd`
- OWNER `0x4Bd0bf98…`, AGENT `0x60536020…` (independent keys)
- Market `0x…b00d` (BTC, 14400s), pool `0x3693799C…`, `marketNonce = 93`

**Positive.** The agent submitted an intent; the account crossed the real resting
ask on the real book:

```
tx 0xf0198627202a78bd12448fee967be80898e9c34151a46ee3ce9589e72ebc0536
collateral spent : 192,000,000 (192 tUSDC)
account YES      : 200,000,000
agent YES        : 0
agent tUSDC      : 0
owner EOA YES    : 0
```

The position belongs to the execution account. The agent key never held collateral
or outcome tokens at any point.

**Ten live negative proofs** (executed against live state at the live block):

| Attempt | Result |
|---|---|
| Replay the same intent nonce | `IntentReplayed` |
| Trade a different real market | `MarketNotBound` |
| Claim a stale pool generation | `GenerationMismatch` |
| Substitute a different pool | `PoolMismatch` |
| Price above the policy ceiling | `PriceOutsidePolicy` |
| Off the venue tick grid | `OffTickGrid` |
| Agent withdraws collateral | `NotOwner` |
| Agent withdraws outcome tokens | `NotOwner` |
| Agent calls the owner recovery hatch | `NotOwner` |
| Agent reassigns the agent key | `NotOwner` |

**Two broadcast rejections**, so the refusal is itself on-chain:

```
over-order-notional  0x8d360c2db6aa15a380871f223e2a2050eae2ceddeb1e484122e0c4d823187904  reverted
agent-withdraw       0x8c1f3d5c47f0df080c6039a0109738bce4e81ab6f2e76f4c85fdc66775203b65  reverted
```

**Owner recovery, with the agent revoked to `address(0)`:**

```
setAgent(0)            0x030ac5e93011bc54b9c2b454e5ff54b69ba90c8ef7aef08422af35ebe8608d97
withdraw collateral    0x8ee6d770d5086fa5dd1e0df6508155a2b379d934b89c7102c45b759ca42b9368   1,808,000,000
withdraw outcome       0x46d343161a9d594b1091eabef1927a0af6acc28b3e97ce280f56be240f65ca50     200,000,000
account residual: collateral 0, position 0
```

**21/21 fork tests** against pinned live state (`evidence/fork-tests.txt`), covering
the same gates plus cooldown, headroom, cadence, asset-mismatch, aggregate exposure,
post-expiry, and policy expiry.

---

## 8. Sharp edges worth recording

1. **A reverted SDK write does not throw.** SDK writes skip simulation. FLIGHTPATH
   sidesteps this by being a contract — a failed gate reverts the transaction.
2. **Float prices are a trap on 18-decimal venues.** `(0.05).toFixed(18)` lands three
   wei off the tick grid and the pool rejects `InvalidPrice`. Testnet's 6-decimal
   collateral hides it. The account validates `price % tickSize == 0` on-chain, which
   makes the class of bug unreachable regardless of what the agent computes.
3. **Testnet is 6-decimal tUSDC, mainnet is 18-decimal USDso.** A hardcoded scale
   misprices everything on mainnet with no revert. The account reads `oneCollateral`
   from `getBinaryPoolParams()` rather than assuming.
4. **Order expiry is mandatory** and capped at `pool.marketExpiryNs()`. Enforced.
5. **Winnings are claimed, not received.** Redemption is a live call the owner must
   make; a settled position does not decay into collateral.
6. **`getOwnOpenOrders()` is caller-scoped.** With the account as trader of record,
   open orders belong to the account — an off-chain driver reading the agent key's
   orders sees nothing. Expected, but it surprises people.
