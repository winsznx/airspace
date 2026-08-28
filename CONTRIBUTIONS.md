# Contributions

One upstream defect, found while building AIRSPACE, reported and fixed where the
fix could actually land.

## The defect

`@somnia-chain/markets-sdk` exposes fills scoped by **pool address** and applies
`limit` to that result. DreamDEX recycles a binary pool across successive
markets, so a pool's tape is the concatenation of every market that has ever run
on it.

The SDK already knows this. Its own `FillRow.market` documentation says:

> Group and label by this, never by `pool` alone: a binary pool is recycled
> across successive markets.

And then `FillsOptions` provides no market field, so there is no way to act on
that advice before the limit bites.

## Measured

Reproduction: [`contributions/dreamdex/reproduce-fill-scoping.mjs`](contributions/dreamdex/reproduce-fill-scoping.mjs).
No SDK install, no credentials — it posts the same `where` shape the SDK builds
to the same public endpoint.

```
getFills("0xc09e4a5bdee2899962727125fb5eaeb896798e46", { limit: 50 })
  rows returned:            50
  market generations in it: 13
  rows for the newest market: 6
```

Fifty rows fetched to keep six. And rows do go missing — at `limit: 5` on another
recycled pool, a market returned 4 of its 5 fills:

```
market  48468  page:  4  actual:  5  MISSING 1
```

The page size a caller needs is not a property of the market being asked about.
It is however many fills the pool has recorded since that market's oldest fill, a
number that grows every time the pool is reused. No fixed `limit` stays correct,
and nothing in the response distinguishes a truncated tape from a short one.

Anything reading a market's own tape is affected: markout, per-market realized
PnL, fill-rate statistics, a UI trade tape. Results look plausible and are wrong
by an amount that depends on the pool's history.

## The fix

`market_id` is already selected by `FillQueryFields` and accepted by
`Fill_bool_exp`. One optional field and three `where` clauses:

```ts
export type FillsOptions = {
  limit?: number;
  offset?: number;
  since?: number;
  until?: number;
  /** Scope to one market's bytes32 marketId, applied SERVER-SIDE. */
  market?: string;
};
```

Additive — existing calls behave exactly as before. Full diff:
[`markets-sdk-fills-market-scope.patch`](contributions/dreamdex/markets-sdk-fills-market-scope.patch).

## Where it went

The SDK's repository (`somnia-chain/somnia-markets`, named in
`@somnia-chain/markets-sdk`'s npm metadata) returns 404 and is not publicly
readable, so an SDK pull request could not be opened. The report is written to be
filed as-is: [`contributions/dreamdex/ISSUE.md`](contributions/dreamdex/ISSUE.md).

`dreamdex-bot-kit` **is** public, and its users hit this today. The fix landed
there on branch `fix/market-scoped-fills`:

- `packages/ec-core/src/fills.ts` — `getMarketFills`, `getMarketUserFills`,
  `getAllMarketFills`, scoping `market_id` server-side against the same indexer
- `docs/gotchas.md` — gotcha 17, with the measured numbers

`npm run typecheck` is clean across the workspace, as the repository's
`CONTRIBUTING.md` requires. The patch is preserved at
[`botkit-market-scoped-fills.patch`](contributions/dreamdex/botkit-market-scoped-fills.patch).

**Neither has been submitted or accepted upstream.** The bot-kit branch exists
locally with a clean commit. Opening the pull request needs a GitHub account with
push access, which is not something this work should presume.

## Deliberately not filed

A `Fill` query combining several markets with `_in` timed out against the same
endpoint during this work. That looks like query planning on the indexer rather
than an SDK defect, and folding it into the report above would blur a narrow,
provable issue with a vaguer one. It is noted at the end of `ISSUE.md` and left
as its own report.

No other contributions were manufactured for appearance.

---

## Contributing to AIRSPACE

Run `pnpm verify` before opening a pull request. It runs typecheck, unit tests,
the Solidity suite, the ABI freshness check and the secret scan.

If you touch the contract, `pnpm contracts:sizes` must still show
`AirspacePortfolio` under 24,576 bytes, and `pnpm contracts:test:fork` must pass
against live Shannon.

Three properties are the product. A change that weakens any of them needs to say
so explicitly in its description:

1. Several agents cannot collectively exceed a ceiling their owner set.
2. A refusal changes no state.
3. The owner can withdraw with no cooperation from anyone.
