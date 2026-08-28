# Security

## Status

**Unaudited. Testnet only. Do not fund with anything you are unwilling to lose.**

The portfolio contract holds collateral and outcome tokens. It has 48 tests
including invariants and live-fork adversarial cases, and it has been driven by
independently-keyed agents against live Shannon. None of that is an audit.

---

## What holds your money

`AirspacePortfolio` is the only trust boundary that matters. Everything else in
this repository can be deleted and your capital is still recoverable.

| Party | Can move capital | How that is bounded |
| --- | --- | --- |
| Owner key | Fully | `withdraw` checks ownership and nothing else |
| Registered agent | Into admitted orders only | its own policy, then the shared envelope |
| API / indexer / lifecycle Workers | No | no owner authority exists off-chain |
| Supabase | No | projections; nothing read from it authorises anything |
| Web app | No | prepares transactions your wallet signs |

There is no admin key, no pause, no upgrade path on a live portfolio, and no
backend credential that can act as an owner. This is a property of the contract,
not a policy: the functions do not exist.

---

## Recovery

Getting out depends on your key and nothing else.

```
withdraw(token, to, amount)
```

Reads no policy, no agent state, no market state, no keeper, no backend. It works
with every agent revoked, the policy expired, the API offline and this repository
gone. Call it from any wallet, block explorer or script.

Fork test `test_F10_ownerRecoveryUnconditional` runs exactly that scenario against
live Shannon state.

Capital sitting behind resting orders is not in the portfolio's ERC-20 balance
until those orders are cancelled or released. `cancelOrder(pool, orderId)` is
owner-callable; `releaseOrder(key)` is permissionless. Outcome tokens come out with
`withdrawOutcome(id, to, amount)`.

---

## The safe-overstatement invariant

> Uncertainty may **overstate** portfolio usage. It may never **understate**
> maximum commitment.

Every ambiguity resolves in that direction:

- A reservation counts from the moment it is admitted, not when it fills.
- A reservation whose fate is unknown stays counted until the venue proves it gone.
- Domain exposure is the gross sum across markets, never netted.
- A market whose cadence matches no canonical window has no domain and is refused.
- A domain with no configured ceiling refuses everything.

The failure mode this produces is a trade refused that could have been allowed.
The failure mode it prevents is a trade allowed that breaches the owner's limit.
Only one of those is survivable, and the whole design is bent toward it.

---

## Known limitations

**A domain is a cadence, not an asset.** BTC and ETH 15-minute series from the same
creator share one ceiling. `marketId → asset` is not exposed by any view on this
venue (304 selector probes found nothing), and the alternative — an off-chain
attestation the contract cannot verify — would be worse. Stated in the UI wherever
a domain appears. See [DECISIONS.md](DECISIONS.md#1-the-risk-domain-is-a-cadence-not-an-asset).

**AIRSPACE does not eliminate market risk.** It bounds how much exposure your
agents may hold at once. Positions inside that bound can still lose.

**A preview is advisory.** State can move between `previewIntent` and `execute`,
which is the normal case with several agents. The contract re-evaluates and can
refuse an intent the preview admitted — that race is the product working, not a
bug, and it is visible in the live campaign evidence.

**Gas cost is coupled across agents.** `execute` walks the domain's tracked
markets, so its cost depends on what other agents did. An estimate taken before
another agent's transaction lands can be too low; the sample agents double it.
Measured: two transactions estimated at ~3.68M ran out of gas at 3.52M used. See
[DECISIONS.md](DECISIONS.md#8-agents-pad-the-gas-estimate-because-execute-costs-what-the-other-agents-did).

**`MAX_MARKETS_PER_DOMAIN` is 48.** Beyond that a domain refuses new markets until
settled ones are pruned. `pruneMarket` is permissionless.

**Venue rules are the venue's.** A post-only order that would cross reverts at
DreamDEX, and `previewIntent` cannot and does not predict it. That is
microstructure, not portfolio risk.

---

## Secrets

Nothing secret is in this repository, and the `.gitignore` is written to keep it
that way: `.env`, `.env.*` (except `.env.example`), `.dev.vars`, `.wallets.json`,
`*.key`, `*.pem`, `*.keystore`, `mnemonic*`, `secrets*`, `service-role*`.

| Secret | Where it lives |
| --- | --- |
| Deployer / owner keys | `.wallets.json`, gitignored, chmod 600, testnet throwaways |
| Agent keys | Cloudflare Worker secrets, one per agent deployment |
| `SUPABASE_SERVICE_ROLE_KEY` | Cloudflare Worker secret; never in a bundle or a response body |
| `INDEXER_TOKEN` | Cloudflare Worker secret |
| Cloudflare API token | CI secret; local development uses `wrangler login` |

Public by design and safe to commit: the Supabase project URL and anon/publishable
key (RLS-scoped, read-only on chain-derived projections), deployed contract
addresses, and RPC endpoints.

`.env.example` documents variable names and never values.

**Run the secret scan before every release checkpoint:**

```bash
node scripts/secret-scan.mjs
```

It fails the build on a match. It is also a CI gate.

### If a secret is exposed

1. Rotate first: new Supabase service-role key, new Worker secrets, new agent keys.
2. Move funds out of any affected address using the owner recovery path above.
3. Purge history only after rotating — a rewrite does not un-leak anything already
   cloned or scraped.
4. Never paste key material into an issue, a report or a commit message, including
   while reporting the exposure.

---

## Reporting a vulnerability

Open an issue describing the impact and how to reproduce it. Please do not include
key material, and please do not exploit against another user's portfolio — these
are testnet contracts, so a reproduction on your own portfolio proves the same
thing.

If a finding lets an agent exceed a portfolio ceiling, lets a non-owner move
capital, or blocks an owner from withdrawing, say so plainly at the top. Those
three are the properties the whole design exists to hold.
