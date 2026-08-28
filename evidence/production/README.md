# Production evidence

Everything here was produced by a script in `scripts/` against live Somnia
Shannon and the deployed Cloudflare stack. Nothing is hand-written, and nothing
is a mock.

| File | What produced it | What it shows |
| --- | --- | --- |
| [`live-proof.json`](live-proof.json) | `scripts/live-proof.mjs` | The canonical A/B/C cross-agent refusal, end to end on production contracts |
| [`campaign.json`](campaign.json) | `scripts/campaign-setup.mjs` | The portfolio, policies, domains and agents the campaigns ran against |
| [`campaign-1.log`](campaign-1.log) | `scripts/campaign-run.mjs` | 25 rounds. Three on-chain failures that turned out to be gas, not refusals |
| [`campaign-run-2.json`](campaign-run-2.json), [`campaign-2.log`](campaign-2.log) | `scripts/campaign-run.mjs` | 30 rounds after the gas fix. 32 admitted, 21 refused by the shared envelope |
| [`adversarial.json`](adversarial.json) | `scripts/adversarial.mjs` | 13 hostile cases, 13 passes, nothing skipped |
| [`scale.json`](scale.json) | `scripts/scale.mjs` | Read path at 100 portfolios / 1,000 agents / 10,000 intents |
| [`deployment.json`](deployment.json) | recorded at deploy | Every deployed component, its trigger and its secret NAMES |
| [`numeric-precision.json`](numeric-precision.json) | found in production | A projection defect, its blast radius, and the proof the fix is right |
| [`lifecycle-bookkeeping.json`](lifecycle-bookkeeping.json) | found in production | Three queue-bookkeeping defects that only appear under real batched load |
| [`steady-state.json`](steady-state.json) | observed live | The deployed system running unattended, and the full loop closing |
| [**`CRITICAL-reservation-netting.md`**](CRITICAL-reservation-netting.md) | `scripts/risk-verifier.mjs` | **An open safety-invariant failure. Read this before trusting any ceiling number.** |
| [`risk-verification.json`](risk-verification.json) | `scripts/risk-verifier.mjs` | The raw measurements behind it |

---

## The two campaigns are both worth reading

**Campaign 1** found something. Three transactions reverted, the agents reported
them as refusals, and the API **rejected all three**: it replayed each one and
found no `Refused(code)`. They had run out of gas.

`execute` walks the domain's tracked markets, so its cost depends on shared state
the other agents are changing. Two transactions estimated at ~3.68M ran out of gas
at 3.52M used, in consecutive blocks, because another agent tracked a new market
in between. Cost is coupled across agents the same way risk is.

That is also the strongest evidence for the refusal-recovery design: an endpoint
that believed its caller would have written three refusals into the feed that the
contract never made. See
[DECISIONS.md](../../DECISIONS.md#8-agents-pad-the-gas-estimate-because-execute-costs-what-the-other-agents-did).

**Campaign 2** ran after the agents began padding the estimate. Zero
out-of-gas. And the shared envelope bound hard:

| Outcome | Count |
| --- | --- |
| Admitted and placed | 32 |
| `DOMAIN_RISK_EXCEEDED` | 14 |
| `DOMAIN_COMMITTED_EXCEEDED` | 7 |
| `PRICE_OUTSIDE_POLICY` | 2 |
| No signal / no live market | 35 |

In rounds 15 and 16 all three agents were refused at once, each by what the other
two already held.

---

## The second thing production found

`numeric-precision.json` records a defect that only appeared once real data ran
through the whole stack. PostgREST serialises `numeric` as a JSON **number**, and
DreamDEX order ids are 21 digits:

```
on chain          239807672958224550581
as a JSON number  239807672958224560000
```

The indexer read the order id back out of Postgres to derive each reservation's
key, so every key matched nothing. Fifty-three reservations pointed at no
contract record, the lifecycle worker's `releaseOrder` answered "nothing to
release" every time and silently released nothing, and the domain stayed pinned
at its ceiling with all three agents refused.

One boundary, three failures, and every one of them quiet.

What it did **not** touch is the point: the contract never reads a projection, so
admission stayed correct throughout. The repair was to delete the rows, rewind
the cursor and let the indexer rebuild them from chain logs — no state was
reconstructed by hand.

The fix is verified against the contract's own output. `ReservationReleased`
emits the contract's `orderKey`; re-deriving it in TypeScript from the matching
`IntentAdmitted` log reproduces it exactly.

## The third thing production found

Running the keeper against a real queue surfaced three defects at once, all in
bookkeeping rather than in the work itself:

- One key signs every job, and a batch delivers ten. Each write derived its own
  nonce, so the chain rejected the second job in every batch.
- The status update used `.eq(col, null)`, which builds `col=eq.null`. NULL is
  not equal to anything in SQL, so every update for a job without an order key
  matched zero rows — completed work stayed `PENDING`, and the dedupe index then
  refused to re-enqueue it. 330 rows described jobs that had already run.
- The failure path scoped its update to chain and kind alone, so one failure
  marked 281 jobs as `FAILED`.

The release work itself was fine throughout: reserved collateral fell from
1,474,360,000 to 68,380,000 while the bookkeeping was wrong about all of it.
That gap between "the chain is correct" and "our record of it is correct" is the
whole reason the contract never reads a projection.

---

## The loop closing, unattended

`steady-state.json` is a snapshot of the deployed system with nobody driving it.
Over about ten minutes, with no intervention:

```
domain usage reaches 1,120,000,000 against a 500,000,000 ceiling
  — realized positions in markets that had settled

all three agents refused DOMAIN_RISK_EXCEEDED, none of them spending gas

the lifecycle keeper releases 172 orders and 7 settled markets

usage falls to 10,000,000

the agents resume trading on their own; usage climbs back to 240,000,000
```

Nothing in that sequence was triggered by hand. The envelope tightened, refused
everything, was cleared by permissionless releases, and reopened.

---

## Reproducing

```bash
node scripts/live-proof.mjs                       # needs funded testnet keys
node scripts/campaign-setup.mjs --salt my-run
node scripts/campaign-run.mjs --rounds 30 --every 12
node scripts/adversarial.mjs
node scripts/scale.mjs
```

Live data moves. Market ids, blocks and exact counts will differ from the files
here; the shape will not.
