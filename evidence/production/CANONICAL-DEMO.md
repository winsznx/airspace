# Canonical demo — the judge path

One command, one fresh portfolio, one deterministic refusal, one deterministic
recovery. `scripts/live-proof.mjs` already **is** this demo; this document is
the 60–90 second narration to run over it and a note on why nothing here
depends on catching a market at the right moment.

## Why it is deterministic

Every run creates a **brand-new portfolio** (step 1) against whatever markets
are currently live in the configured domain (step 2, discovered on chain, not
hardcoded). Nothing in the script waits for an order to fill — every state it
demonstrates (a resting reservation, a refusal, a release) is reachable with
`orderType: 3` (POST_ONLY) intents that either rest or are refused outright,
never with a fill that depends on counterparty timing. Run it once, immediately
before recording, and the numbers below are exactly what will appear.

```bash
set -a && . ./.env.airspace && set +a
node scripts/live-proof.mjs
```

Takes under a minute against live Shannon. If it fails to find two live
markets sharing one domain (`FATAL: could not find two live markets...`),
markets have just rolled — retry in under a minute.

## The 75-second cut

| Time | Beat | What's on screen | Console step |
| --- | --- | --- | --- |
| 0:00–0:10 | Setup | "One capital pool, two agents already trading it." | `01-portfolio`, `04-agentA`, `05-agentB` |
| 0:10–0:20 | The number | "A reserved 180. B reserved 240. The domain reads 420 of 500." | `05-agentB` → `domainRiskUsage: 420000000` |
| 0:20–0:35 | The gate stack | "A third agent proposes 150. Every gate that agent controls passes." Show: Agent policy PASS, Market trading PASS, Market generation PASS, Tick/lot PASS, Market headroom PASS. Land on: **Portfolio domain FAIL.** | `06-agentC-REFUSED` |
| 0:35–0:45 | The arithmetic | "420 + 150 = 570. Over the 500 ceiling. Refused before any state changed — no reservation for C, nothing to undo." | `06-agentC-REFUSED.arithmetic` |
| 0:45–0:55 | The receipt | Refusal receipt on chain — `DOMAIN_RISK_EXCEEDED`, C's committed capital unchanged. Twelve hostile probes, all correctly refused. | `07-hostile-agent-C` |
| 0:55–1:05 | Reconciliation | "A's order releases. The domain drops to 240 — permissionless, no owner transaction." | `08-released`, `08b-reconciled` |
| 1:05–1:15 | The reopen | "The identical trade from C — same shape, same size — is now admitted. 240 + 150 = 390, under 500." | `09-agentC-ADMITTED` |

## What each line proves, if a judge asks

- **No C reservation or state mutation on refusal**: `06-agentC-REFUSED` shows
  `domainUsageBefore` and the projected `domainUsageAfter` from `previewIntent`
  — the transaction reverts, so nothing in `06` was ever written to a block.
  `07-hostile-agent-C` includes a probe confirming C's committed capital is
  unchanged after the attempt.
- **On-chain evidence**: every `hash` in the JSON output is a real Shannon
  transaction hash; check any of them at
  `https://shannon-explorer.somnia.network/tx/<hash>`.
- **The same trade shape becoming admissible**: `09-agentC-ADMITTED` uses the
  identical intent shape as the refused one in `06`, submitted again after
  `08b-reconciled` frees exactly enough room.

## If you want the harder version too

`scripts/opposing-live.mjs` runs the shape that actually broke AIRSPACE
1.0.0 — two agents on **opposite** sides of one market — live against 2.0.0,
with the disproven formula computed alongside for comparison. Not part of the
75-second cut, but the strongest single artifact if a judge wants to see the
remediation itself proven live rather than described. See
`evidence/production/opposing-live.json` for the last recorded run, or
re-run it fresh the same way.
