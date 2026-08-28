# scripts/

Operational drivers for the production system. Stage-specific research drivers
stayed with their stage under `engineering/*/scripts/`.

Everything here talks to live Somnia Shannon. Nothing mocks a chain.

| Script | What it does | Needs |
| --- | --- | --- |
| [`sync-abi.mjs`](sync-abi.mjs) | Regenerates `packages/sdk/src/abi.ts` from the compiled artifacts. CI fails on a diff. | `forge build` |
| [`secret-scan.mjs`](secret-scan.mjs) | Scans what git would publish, and with `--history` every blob ever committed. | — |
| [`refresh-fork-env.mjs`](refresh-fork-env.mjs) | Re-pins `contracts/.env.fork` to a live block and two markets sharing one domain. | public RPC |
| [`live-proof.mjs`](live-proof.mjs) | The canonical A/B/C cross-agent refusal, end to end. | funded testnet keys |
| [`campaign-setup.mjs`](campaign-setup.mjs) | Creates and funds a portfolio, sets policies, opens live domains, registers three agents. Idempotent. | owner key, tUSDC |
| [`campaign-run.mjs`](campaign-run.mjs) | Ticks all three agents concurrently each round. | agents running |
| [`adversarial.mjs`](adversarial.mjs) | 13 hostile cases against the live system. | API + indexer |
| [`scale.mjs`](scale.mjs) | Read path at 100 portfolios / 1,000 agents / 10,000 intents. Cleans up after itself. | service-role key |

## Why the campaign driver ticks all three at once

Each agent previews independently, all three previews pass, and then their
transactions land one after another against an envelope that has moved. Refusals
produced that way are real races, not staged ones — and the first campaign found
a genuine defect precisely because of it. See
[evidence/production/README.md](../evidence/production/README.md).

## Keys

`live-proof.mjs`, `campaign-setup.mjs` and `adversarial.mjs` read `.wallets.json`,
which is gitignored and holds throwaway testnet keys. They never print key
material, and `secret-scan.mjs` fails the build if any of it reaches a
publishable file.
