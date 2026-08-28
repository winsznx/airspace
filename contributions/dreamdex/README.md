# Upstream contribution

One defect, found while building AIRSPACE, reported and fixed in the place that
could actually accept the fix.

## The defect

`@somnia-chain/markets-sdk` exposes fills scoped by **pool address**, and applies
`limit` to that result. DreamDEX recycles a binary pool across successive markets,
so a pool's tape is the concatenation of every market that has ever run on it. The
SDK's own `FillRow.market` documentation says to group by the market id and never
by pool alone — and then provides no way to do that server-side.

The consequence is quiet. A caller asking for a market's tape gets a page that
mixes generations, or is short by an amount that depends on how often the pool has
been reused, with nothing in the response distinguishing a truncated tape from a
short one.

## What is here

| File | What it is |
| --- | --- |
| [`ISSUE.md`](ISSUE.md) | The report, written to be filed as-is against the SDK. |
| [`reproduce-fill-scoping.mjs`](reproduce-fill-scoping.mjs) | Standalone reproduction. No SDK install, no credentials. |
| [`evidence.json`](evidence.json) | The measurement the script last wrote. |
| [`markets-sdk-fills-market-scope.patch`](markets-sdk-fills-market-scope.patch) | The proposed SDK change: one optional field, three `where` clauses. |
| [`botkit-market-scoped-fills.patch`](botkit-market-scoped-fills.patch) | The fix landed on a branch of `dreamdex-bot-kit`. |

Run the reproduction:

```bash
node contributions/dreamdex/reproduce-fill-scoping.mjs            # default limit 50
node contributions/dreamdex/reproduce-fill-scoping.mjs --limit 5  # where truncation bites
```

It queries live testnet data, so the exact pools and counts move between runs. What
does not move is the shape: a pool-scoped page spans several markets, and the page
size needed to see one market whole grows with the pool's reuse.

## Where each part went

The SDK's own repository (`somnia-chain/somnia-markets`) was not publicly readable
at the time of writing — `@somnia-chain/markets-sdk`'s npm metadata points at it,
and the URL returns 404 — so an SDK pull request could not be opened. The report and
patch here are written so the DreamDEX team can apply them directly.

`dreamdex-bot-kit` IS public, and its users hit this today. The fix landed there on
branch `fix/market-scoped-fills`:

- `packages/ec-core/src/fills.ts` — `getMarketFills`, `getMarketUserFills`,
  `getAllMarketFills`, scoping `market_id` server-side against the same indexer.
- `docs/gotchas.md` — gotcha 17, with the measured numbers.

`npm run typecheck` is clean across the workspace, as `CONTRIBUTING.md` requires.

**Neither has been submitted or accepted upstream.** The bot-kit branch exists
locally with a clean commit; opening the pull request needs a GitHub account with
push access, which is the maintainer's or the author's call, not something this
work should presume.

## Deliberately not filed

A `Fill` query combining several markets with `_in` timed out against the same
endpoint during this work. That looks like query planning on the indexer rather
than an SDK defect, and mixing it into the report above would blur a narrow,
provable issue with a vaguer one. It is noted at the end of `ISSUE.md` and left as
its own report.

No other contributions were manufactured.
