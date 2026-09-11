# Production evidence

Everything here was produced by a script in `scripts/` against live Somnia
Shannon and the deployed Cloudflare stack. Nothing is hand-written, and nothing
is a mock. All of it now describes **AIRSPACE 2.0.0**, the current deployment.

**Start here if you are checking the safety claim:**
[**`REMEDIATION.md`**](REMEDIATION.md) is the full account — root cause,
corrected model, the independent oracle, the historical regression, the new
deployment, and the live proof that replays the exact failure shape against
2.0.0. [`CRITICAL-reservation-netting.md`](CRITICAL-reservation-netting.md) is
the original finding, left exactly as written, with the resolution appended
rather than rewritten in place.

| File | What produced it | What it shows |
| --- | --- | --- |
| [**`REMEDIATION.md`**](REMEDIATION.md) | this remediation | **The full safety account: root cause → fix → proof. Read this first.** |
| [`CRITICAL-reservation-netting.md`](CRITICAL-reservation-netting.md) | `scripts/risk-verifier.mjs` | The original finding against 1.0.0, with the resolution appended |
| [`opposing-live.json`](opposing-live.json) | `scripts/opposing-live.mjs` | The exact 1.0.0 failure shape, rebuilt live against 2.0.0, with the v1 figure computed alongside for comparison |
| [`risk-verification.json`](risk-verification.json) | `scripts/risk-verifier.mjs` | The independent verifier's live output — every quantity rebuilt from a primary source, never from the contract's own counters |
| [**`long-campaign.json`**](long-campaign.json) | `scripts/long-campaign.mjs` | **3-hour unattended campaign with the verifier running inside the loop. 35 rounds, 177 intents, 43 admitted, 25 refused by the shared envelope, 30 permissionless releases, 0 RPC failovers, 0 worker errors. `criticalFindings: []` for the whole run.** |
| [`live-proof.json`](live-proof.json) | `scripts/live-proof.mjs` | The canonical A/B/C cross-agent refusal, end to end, including the reconciliation step |
| [`campaign.json`](campaign.json) | `scripts/campaign-setup.mjs` | The 2.0.0 portfolio, policies, domains and agents the campaigns ran against |
| [`campaign-1.log`](campaign-1.log) | `scripts/campaign-run.mjs` | 25 rounds. Three on-chain failures that turned out to be gas, not refusals |
| [`campaign-run-2.json`](campaign-run-2.json), [`campaign-2.log`](campaign-2.log) | `scripts/campaign-run.mjs` | 30 rounds after the gas fix. 32 admitted, 21 refused by the shared envelope |
| [`scale.json`](scale.json) | `scripts/scale.mjs` | Read path at 100 portfolios / 1,000 agents / 10,000 intents |
| [`deployment.json`](deployment.json) | recorded at deploy | Every deployed component — 2.0.0 addresses, plus the superseded 1.0.0 ones, labelled |
| [`numeric-precision.json`](numeric-precision.json) | found in production | A projection defect, its blast radius, and the proof the fix is right |
| [`lifecycle-bookkeeping.json`](lifecycle-bookkeeping.json) | found in production | Three queue-bookkeeping defects that only appear under real batched load |

Two files that lived here — `adversarial.json` and `steady-state.json` — were
measured against the **superseded 1.0.0 deployment** and have been removed from
this directory as unlabelled duplicates: the sole copies now live in
[`engineering/03-superseded-unsafe-v1/evidence/`](../../engineering/03-superseded-unsafe-v1/evidence/),
where the whole broken deployment is preserved and clearly marked.

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

`steady-state.json` — now archived at
[`engineering/03-superseded-unsafe-v1/evidence/steady-state.json`](../../engineering/03-superseded-unsafe-v1/evidence/steady-state.json)
— caught the lifecycle self-healing with nobody driving it: usage rose to
1,120,000,000 against a 500,000,000 ceiling on settled positions, all three
agents were refused with no gas spent, the keeper released 172 orders and 7
settled markets with no owner involved, usage fell to 10,000,000, and trading
resumed on its own.

The *usage figure itself* was measured under the 1.0.0 formula and is not cited
as a safety reading — see `CRITICAL-reservation-netting.md` for why a 1.0.0
number cannot be trusted at face value. What the observation demonstrates is
architectural and survives the fix unchanged: `releaseOrder` and
`pruneMarket` are permissionless, the envelope closes without an owner
transaction, and it reopens the same way. A live re-run of the same shape
against 2.0.0 is part of the ongoing long-run verifier
(`risk-verification.json`).

---

## Reproducing

```bash
node scripts/live-proof.mjs                        # canonical A/B/C, needs funded testnet keys
node scripts/opposing-live.mjs                      # the 1.0.0 failure shape, rebuilt against 2.0.0
node scripts/risk-verifier.mjs                       # one independent sample
node scripts/risk-verifier.mjs --watch 60 --for 1800 # continuous, writes SAFE/CRITICAL
node scripts/campaign-setup.mjs --salt my-run
node scripts/campaign-run.mjs --rounds 30 --every 12
node scripts/adversarial.mjs
node scripts/scale.mjs
```

Live data moves. Market ids, blocks and exact counts will differ from the files
here; the shape will not.
