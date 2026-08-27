# evidence/

All artifacts from the FLIGHTPATH spike. Chain: Somnia Shannon, chainId **50312**.
Explorer: https://shannon-explorer.somnia.network

## Files

- `live-run.json` — full structured log of the live end-to-end run
- `fork-tests.txt` — 21/21 forge fork tests against pinned live state

## Actors

```
OWNER   0x4Bd0bf9821F23f822eb44B1F095594e2BbBC06Bc
AGENT   0x60536020d9926512dd8F806466431c1e504B29aB
```

Two independent keys. The agent key was funded with STT for gas only and held no
collateral and no outcome tokens at any point in the run.

## Deployed

```
FlightFactory        0x96F5f7aCED65149440dC8807C2CD2f66514fc2a2
Execution account    0x083663A3849b795F423F6d8E9129394A479484Bd
```

## Protocol under test (unmodified, live)

```
BinaryMarketsModule  0x3ecC694Cef705358864a646142ac17A90E29e388
OutcomeToken6909     0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9
tUSDC (collateral)   0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E   (6 decimals)
MarketCreator        0x94D963B6670AB96E78C8d0C46ca35D196d606EFE
```

## Market traded

```
marketId     0x000000000000000000000000000000000000000000000000000000000000b00d
asset        BTC          intervalSec 14400
pool         0x3693799C1F707162acf8777a718B7E20f54a750D
marketNonce  93
```

## Transactions

| Step | Tx | Result |
|---|---|---|
| Fund agent with STT | `0x7cb6fe5edfdcc6806295f0d4df1661ade12b3c467a10ad9dfde00f08e607284c` | success |
| Deploy factory | `0x13e0f9368469e24152167bab4e834080e9f874b1ce7ab582a43db08c53dfc1be` | success |
| Fund account (faucet via `ownerCall`) | `0x9bcef5a5533a5c3b59581e32f21f54f799e4403e774c8df93605ecb5a1b30e6b` | success, 2,000 tUSDC |
| **AGENT trade (real fill)** | **`0xf0198627202a78bd12448fee967be80898e9c34151a46ee3ce9589e72ebc0536`** | **success** |
| Negative: over order notional | `0x8d360c2db6aa15a380871f223e2a2050eae2ceddeb1e484122e0c4d823187904` | **reverted (expected)** |
| Negative: agent withdraw | `0x8c1f3d5c47f0df080c6039a0109738bce4e81ab6f2e76f4c85fdc66775203b65` | **reverted (expected)** |
| Revoke agent → `address(0)` | `0x030ac5e93011bc54b9c2b454e5ff54b69ba90c8ef7aef08422af35ebe8608d97` | success |
| Owner withdraw collateral | `0x8ee6d770d5086fa5dd1e0df6508155a2b379d934b89c7102c45b759ca42b9368` | success, 1,808 tUSDC |
| Owner withdraw outcome tokens | `0x46d343161a9d594b1091eabef1927a0af6acc28b3e97ce280f56be240f65ca50` | success, 200,000,000 YES |

An earlier identical run produced trade
`0x0f150711f72a939f89e8b7621cbffb284df5406674ace73e6108e6da06a54693` on market
`0x…b00d`; `live-run.json` records the second, canonical run.

## Expected state

**After the trade:**

```
account  YES(0x…b00d)  = 200,000,000
account  tUSDC          = 1,808,000,000   (2,000,000,000 - 192,000,000)
agent    YES            = 0
agent    tUSDC          = 0
owner EOA YES           = 0
```

Collateral spent 192,000,000 for 200,000,000 contracts — an average fill of 960,000
against a requested ceiling of 985,000, because a taker is charged the resting price.
This is why the receipt does not assert `actualFill` (see `AUTHORITY_MODEL.md` §4).

**After owner recovery, with the agent revoked:**

```
account  tUSDC = 0        account YES = 0
owner    YES   = 200,000,000
```

## Live negative proofs

Executed as `eth_call` against live state at the live block — real bytecode, real
storage. Each was required to revert with a specific named error; a success would
have failed the run.

```
IntentReplayed        replay of the same intent nonce
MarketNotBound        a different, real marketId
GenerationMismatch    stale recycled-pool generation
PoolMismatch          substituted pool address
PriceOutsidePolicy    price above the policy ceiling
OffTickGrid           price off the venue tick grid
NotOwner              agent withdraw collateral
NotOwner              agent withdraw outcome tokens
NotOwner              agent ownerCall
NotOwner              agent setAgent
```

## Reproducing

```bash
# fork proofs (pinned block)
export SHANNON_RPC=https://dream-rpc.somnia.network
export FORK_BLOCK=472700908
export MARKET_ID=0x00000000000000000000000000000000000000000000000000000000000000a8ce
forge test --match-path test/FlightAccount.fork.t.sol -vv

# live run (needs funded OWNER/AGENT keys in .wallets.json, gitignored)
node script/live.mjs
```

The fork block is pinned because Shannon's 60-second windows mean market `0x…a8ce`
stops being live within hours. `script/live.mjs` selects a live market dynamically
and will pick whatever is trading at run time.

## Protocol probes worth keeping

```
placeBinaryOrderFor from EOA (third-party) -> 0x3fb0ba2e  OnlyApprovedContracts()
placeBinaryOrderFor from EOA (self-for)    -> 0x3fb0ba2e  OnlyApprovedContracts()
placeBinaryOrder    from EOA               -> 0xfb8f41b2  ERC20InsufficientAllowance
placeBinaryOrder    from contract          -> 0xfb8f41b2  ERC20InsufficientAllowance  (state-override)

isOperatorAuthorized(address,address,bytes4)  0xa8cb3794  ABSENT from binaryPoolImpl
setManualVaultMode(bool)                      0xfc7b1853  ABSENT from binaryPoolImpl
```

Competitor verification (deployed bytecode, not README):

```
Vane factory 0xc17da7a28Ea556f6BfA7a774d9Da486C41574b43  — 27,737 bytes, live
  contains 0x718c2d4d placeBinaryOrder
  contains 0x53edf33d onEvent(address,bytes32[],bytes)     (Reactivity handler)
  contains BinaryMarketsModule + tUSDC addresses
```
