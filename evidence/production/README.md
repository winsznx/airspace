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
