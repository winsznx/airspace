# AUTHORITY_MODEL.md

Who may move what, and what a receipt can prove without trusting anyone.

---

## 1. Architecture comparison

Three candidates were considered. The rejection test was the one that matters:
**can the "enforcement" be bypassed while still spending user-controlled capital?**

### A. Per-user contract-owned execution vault — **ACCEPTED**

Capital lives in a per-owner contract. The contract is the trader of record: it calls
`BinaryPool.placeBinaryOrder` as `msg.sender`, so escrow leaves the contract, fills
settle to the contract, and ERC-6909 outcome tokens are credited to the contract.
The agent key holds nothing and has exactly one reachable entrypoint, `execute()`,
which enforces the envelope before any value moves.

Bypass analysis: for the agent to spend user capital outside the envelope it would
have to (a) call the pool directly — but it has no funds and no allowance from the
account, or (b) reach a non-enforcing entrypoint on the account — there is none;
every other state-changing function is `onlyOwner`. The boundary is structural.

### B. Smart-account / EIP-7702 constrained execution — **REJECTED**

Fails on two independent grounds, either of which is fatal.

1. **The delegation primitive does not exist.** `placeBinaryOrderFor` reverts
   `OnlyApprovedContracts()` for every EOA caller, including self-for (verified live).
   There is no `OperatorPermissionsRegistry` wiring on `BinaryPool` — the spot/perp
   session-key model does not extend to Event Contracts. So there is nothing to
   attach a constraint to.
2. **The delegation is revocable by the wrong party.** Under 7702 the authority to
   install or drop delegated code belongs to the EOA's own key. If the agent holds
   it, the agent removes the constraint at will and keeps spending the same capital —
   the exact bypass the rejection test forbids. If the owner holds it, the owner is
   co-signing every session and A is strictly better.

### C. Off-chain policy middleware — **REJECTED**

A proxy, signer service, or MCP-layer firewall that inspects and forwards. Enforcement
is application-level: it binds the *code path*, not the *capital*. Any agent that can
reach an RPC endpoint with a funded key routes around it, and the middleware never
learns. This is the category `rampart` and `Lucid-Computing/ai-vault` occupy — legitimate
tools for a different threat model (a developer constraining their own tooling), but
they are not a custody boundary and must not be marketed as one.

**Conclusion: A is the only architecture that survives on this venue.**

---

## 2. The authority table

| Capability | OWNER | AGENT | Anyone |
|---|---|---|---|
| Deposit collateral | yes | yes (harmless) | yes (harmless) |
| Withdraw collateral | **yes, unconditional** | no (`NotOwner`) | no |
| Withdraw ERC-6909 outcome tokens | **yes, unconditional** | no (`NotOwner`) | no |
| Set / replace policy | yes | no (`NotOwner`) | no |
| Set / revoke agent | yes | no (`NotOwner`) | no |
| Cancel a resting order | yes | no | no |
| Redeem settled positions | yes | no | no |
| Arbitrary call (`ownerCall`) | yes | no (`NotOwner`) | no |
| Place an order within policy | yes (via ownerCall) | **yes, only via `execute()`** | no (`NotAgent`) |
| Place an order outside policy | — | **no** | no |

The asymmetry that matters: the agent's only power is to *propose*. The account
decides whether capital moves.

### Unconditional recovery

Owner withdrawal reads no policy state, no agent state, no market state, and no
subscription state. It cannot be blocked by an expired policy, a revoked agent, a
paused strategy, a finalized market, or a hostile agent. Proven live with the agent
set to `address(0)` and the policy lapsed:

```
withdraw collateral  0x8ee6d770…  1,808,000,000 recovered
withdraw outcome     0x46d34316…    200,000,000 recovered
account residual: 0 / 0
```

`ownerCall` is a deliberate escape hatch. It grants the owner no privilege they do not
already have — they own every asset in the account — and it guarantees recovery never
depends on this contract having anticipated a protocol upgrade. It is unreachable by
the agent.

---

## 3. Policy controls and where each is enforced

All eleven required controls are enforced on-chain, in `execute()`, before placement.

| # | Control | Mechanism | Source of truth |
|---|---|---|---|
| 1 | Exact `marketId` binding | `i.marketId != p.marketId` → `MarketNotBound` | policy |
| 2 | Allowed asset | `keccak(seriesById(seriesId).asset) == p.assetHash` | **chain** (`MarketCreator`) — see caveat §4 |
| 2b | Allowed cadence | `expiry - tradingStart == p.intervalSec` | **chain** (module record) |
| 3 | Max order notional | ceil-rounded collateral value ≤ `p.maxOrderNotional` | chain (`oneCollateral` from pool) |
| 4 | Max aggregate exposure | `deployedNotional + n ≤ p.maxExposure` | account storage, per policy epoch |
| 5 | Max acceptable execution price | buys ≤ `maxBuyPrice`, sells ≥ `minSellPrice` | policy vs intent |
| 6 | Market authoritatively Trading | `!pool.finalized() && !market.isResolved() && !market.isVoided() && tradingStart ≤ now < expiry` | **chain only, never the indexer** |
| 7 | Min window headroom | `expiry - now ≥ p.minHeadroomSec` | chain |
| 8 | Cooldown / rate limit | `now ≥ lastTradeAt + p.cooldownSec` | account storage |
| 9 | Nonce / replay protection | `intentNonceUsed[nonce]` | account storage |
| 10 | Owner-only unconditional withdrawal | `onlyOwner`, no other predicate | account |
| 11 | Agent cannot transfer collateral or outcome tokens | no agent-reachable transfer path; buy approvals are exact-amount and zeroed after placement | account |

Two additional gates fell out of the protocol research and are enforced because
omitting them would leave a real hole:

- **Generation binding.** `pool.marketNonce() == i.marketNonce`, *and* the registry's
  `yesId`/`noId` must equal the ids derived from `(pool, i.marketNonce)`. Without this
  a recycled pool lets an agent trade a different market generation than the one the
  policy admitted.
- **Grid conformance.** `price % tickSize == 0`, `quantity % lotSize == 0`,
  `quantity ≥ minQuantity`, read from `getOrderBookParameters()`. Makes the documented
  float-rounding `InvalidPrice` class unreachable regardless of agent arithmetic.

### Exposure semantics, stated precisely

`deployedNotional` is the cumulative collateral-equivalent committed by *buys* under
the current policy epoch. It is monotonic within an epoch and resets when the owner
installs a new policy. For a single bound market it is a genuine max-loss bound,
because the worst case for a bought outcome token is total loss of the collateral
paid. It is **not** a mark-to-market and **not** a net position. Sells do not decrement
it. This is a deliberately conservative definition; it is documented rather than
dressed up as risk management it does not do.

---

## 4. Receipt: what is independently verifiable

The receipt is emitted as `IntentExecuted` and reconstructible from the transaction
log alone.

| Field | Verifiable from | Trust required |
|---|---|---|
| `policyHash` | `keccak256(abi.encode(policy))`; re-derivable from `account.policy()` and cross-checked against the `PolicySet` log | **none** |
| `marketId` | event topic; cross-checkable against `module.markets(marketId)` | **none** |
| `marketNonce` | event field; equals `pool.marketNonce()` at that block, and is re-derivable from the registry's `yesId` | **none** |
| `intentHash` | `keccak256(abi.encode(account, chainId, intent))`; every input is in the log | **none** |
| `preTradeStateHash` | commitment over account address, policyHash, epoch, `deployedNotional`, collateral balance, YES and NO balances — all readable at `blockNumber - 1` | **none** (archive node) |
| `txHash` | the transaction itself | **none** |
| `resultingExposure` | ERC-6909 `balanceOf(account, yesId/noId)` after the block | **none** |
| `actualFill` | **derived, not asserted** — see below | **none**, but requires log parsing |
| `strategyVersion` | opaque 32 bytes supplied by the agent | **offchain witness** |

Two honest qualifications.

**`actualFill` is not a field the account can assert.** `placeBinaryOrder` returns
`(success, id)`, and an EOA cannot read a transaction's return data. The account
records the order id and the *requested* price and quantity. The realised fill must be
reconstructed from the pool's own fill logs in the same transaction, and a taker is
charged the resting price rather than the price it offered — so requested price is an
upper bound for a buy, not the execution price. In the live run the account requested
985,000 and spent 192,000,000 for 200,000,000 contracts, i.e. an average of 960,000.
Any receipt that printed the requested price as "the fill" would be lying. The
reconstruction is trustless but it is a second step, not a field.

**`strategyVersion` is the only field requiring an offchain witness.** Nothing on-chain
can attest that a given 32-byte tag corresponds to a particular strategy build. It is
provenance metadata, useful only if the agent operator publishes the mapping. It must
never be presented as verified.

**The asset caveat.** In `BindMode.SERIES` the asset string is read from the chain, so
the agent cannot forge it — but because sibling series share creator, collateral,
cadence and expiry (see `SPIKE_FINDINGS.md` §5), an agent can present the sibling
asset's market at the same cadence and satisfy every on-chain check. Asset binding is
therefore fully structural **only** in `BindMode.EXACT`. This is the default, and the
limitation is disclosed rather than papered over.
