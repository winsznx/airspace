# `getFills` / `getUserFills` cannot scope by market, so `limit` truncates across market generations

Repository: `@somnia-chain/markets-sdk` (`somnia-chain/somnia-markets`, `packages/sdk`)
Version measured: `0.28.1`
Network: Somnia Shannon (50312), indexer `https://dev.smk.somnia.host/v1/graphql`

## What happens

`getFills(pool, opts)` and `getUserFills(account, { pool })` scope the query by pool
address, and `limit` is applied to that pool-scoped result. On event contracts a
binary pool is recycled across successive markets, so one pool address carries the
tape of every market that has ever run on it.

The SDK already says this is the wrong key to group by. From `FillRow.market` in
`dist/fills.d.ts`:

> The market's bytes32 marketId — the STABLE identity of the market this fill
> executed in.
>
> **Group and label by this, never by `pool` alone**: a binary pool is recycled
> across successive markets, so fills from a pool's earlier life carry the same
> pool address as the market currently on it.

But `FillsOptions` has no market field:

```ts
export type FillsOptions = {
  limit?: number;
  offset?: number;
  since?: number;
  until?: number;
};
```

so there is no way to push that identity into the query. The caller is told to key
on `market`, given a page keyed on `pool`, and left to filter client-side — after
the limit has already been applied.

## Measured, 2026-08-28

Reproduction script: `reproduce-fill-scoping.mjs` (no SDK install, no credentials —
it posts the same `where` shape the SDK builds to the same public endpoint).

One 50-row page from a single recycled pool:

```
getFills("0xc09e4a5bdee2899962727125fb5eaeb896798e46", { limit: 50 })
  rows returned:            50
  market generations in it: 13
  rows for the newest market 48549: 6
  breakdown: 48549:6  48474:4  48163:12  47854:6  47548:1  43214:7  43062:1
             41863:2  41785:4  41710:3  39894:2  38309:1  38113:1
```

Thirteen markets in one page. A caller asking for the current market's tape fetched
fifty rows to keep six.

And the truncation is real, not theoretical. At `limit: 5` on another recycled pool:

```
per generation, in one 5-row pool page vs what the market holds:
  market  48468  page:  4  actual:  5  MISSING 1
  market  48571  page:  1  actual:  1  complete
```

The page size a caller needs is not a property of the market they are asking about.
It is however many fills the pool has recorded since that market's oldest fill —
a number that grows every time the pool is reused. **No fixed `limit` stays
correct**, and nothing in the response signals that rows were dropped: a truncated
tape and a short tape are the same array.

## Why it matters

Anything that reads a market's own tape is affected — markout and adverse-selection
measurement, per-market realized PnL, fill-rate statistics, a UI trade tape. Each
silently mixes in, or silently loses, fills from earlier markets on the same pool.
The failure is quiet: results look plausible and are wrong by an amount that depends
on how often the pool has been recycled.

## The fix

`market_id` is already a filterable column — `FillQueryFields` selects it as
`market: market_id`, and `Fill_bool_exp` accepts it. Adding one optional field to
`FillsOptions` and one clause to the `where` makes the limit mean what a caller
expects.

```ts
export type FillsOptions = {
  limit?: number;
  offset?: number;
  since?: number;
  until?: number;
  /**
   *  Scope to one market's bytes32 marketId, applied SERVER-SIDE so `limit`
   *  counts rows in this market. Required for a correct per-market tape on a
   *  recycled binary pool; on SPOT/PERP it is equivalent to `pool`.
   */
  market?: string;
};
```

```ts
export async function getFills(pool, opts = {}, indexerUrl) {
  const where = applyFillWindow({ pool: { _eq: pool.toLowerCase() } }, opts);
  if (opts.market != null) where.market_id = { _eq: opts.market };
  ...
}

export async function getUserFills(account, opts = {}, indexerUrl) {
  const where = { _or: participatedAs(account.toLowerCase()) };
  if (opts.pool != null) where.pool = { _eq: opts.pool.toLowerCase() };
  if (opts.market != null) where.market_id = { _eq: opts.market };
  applyFillWindow(where, opts);
  ...
}
```

`countUserFills` takes the same clause, so a history-page total is scoped the same
way as its rows. The change is additive: existing calls behave exactly as before.

A patch in that shape is in `markets-sdk-fills-market-scope.patch`.

Verified against the live endpoint — `where: { pool, market_id }` returns only the
target market's rows and honours `limit`:

```
getFills(pool, { limit: 50, market: "0x…bd5a" })   <- proposed
  rows returned: 4
  all in target market: true
```

## Separate observation, not filed here

A `where` combining several markets with `_in` timed out against the same endpoint
during this work. That looks like a query-planning issue on the indexer rather than
an SDK defect, and it is kept as its own report so this one stays narrow.

## Provenance

Found while building AIRSPACE, a cross-agent portfolio risk layer over DreamDEX
event contracts, which reads per-market tapes on rolling 15-minute series where pool
recycling happens continuously.
