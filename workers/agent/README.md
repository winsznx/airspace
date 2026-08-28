# Sample agents

Three deployments, three keys, three KV namespaces, no shared state and no
coordination. They discover markets from the DreamDEX registry rather than from
the AIRSPACE indexer, so an agent keeps trading when this project's backend is
down.

That independence is the whole point. The portfolio has to hold its envelope
against processes that do not know about each other and cannot be made to
cooperate.

## What they are not

Demonstration policies. They make no claim to edge, and replacing any of them
with a real strategy needs no change to the portfolio contract.

| Strategy | Signal | Size |
| --- | --- | --- |
| `momentum` | mid moved more than a tick since this agent's last observation | 40 contracts |
| `reversion` | mid is more than five ticks from even money | 60 contracts |
| `spread` | any two-sided book with 120s of runway | 30 contracts |

Different sizes and different triggers, so they contend for the shared envelope
at different moments rather than moving as one.

## A tick

```
discover markets from the registry     no indexer dependency
pick one, deterministically by address three agents spread out without talking
read the book and this agent's grid
propose, or pass                       "no signal" is a first-class outcome
previewIntent                          the contract's own answer, no gas spent
estimate gas, then double it           see below
execute
  success        → submitted
  reverted, gas  → out-of-gas
  reverted, code → report the tx hash; the API verifies it against the chain
```

## Three things measured live, not assumed

**Gas is coupled across agents.** `execute` walks the domain's tracked markets,
so its cost depends on shared state the *other* agents are changing. Two
transactions estimated at ~3.68M ran out of gas at 3.52M used, in consecutive
blocks, because another agent tracked a new market in between. The estimate is
doubled, and a receipt that consumed ≥95% of its limit is reported as
`out-of-gas` rather than as a refusal the contract never made.

**Post-only geometry belongs to the venue.** DreamDEX order type 3 is post-only
and reverts `PostOnlyWouldCross()` (`0x7cf05fcb`). With the YES book at
953000/974000, a buy of YES rested at 900000 and crossed at 950000, while a buy
of NO rested at 950000 and crossed at 900000. Rather than encode a
reverse-engineered rule a venue upgrade would break silently, agents start 60
ticks off the touch and double the offset when told they crossed. `previewIntent`
cannot predict this and does not try: it is microstructure, not portfolio risk.

**Naked sells are pointless here.** Selling outcome tokens the portfolio does not
hold returns `InsufficientBalance()` (`0xf4d678b8`), which says nothing about
portfolio risk. Agents only ever bid.

## Routes

| | |
| --- | --- |
| `GET /health` | address, strategy, portfolio |
| `GET /status` | the last scheduled tick's full result, read-only |
| `POST /tick` | runs a tick. Gated behind `AGENT_TOKEN`; without that secret the route does not exist |

`/status` is what tells "no signal" apart from "not running" without a log tail.
It is how the deployed agents were confirmed to be alive and being refused by the
shared envelope, rather than silently broken.

## Deploying

```bash
wrangler kv namespace create AGENT_STATE --env momentum
# put the returned id into wrangler.toml under [[env.momentum.kv_namespaces]]
wrangler deploy --env momentum
wrangler secret put AGENT_PRIVATE_KEY --env momentum
```

Set `AIRSPACE_PORTFOLIO` and `AIRSPACE_API` in the environment's `[vars]` first.
Each agent address needs STT for gas, and must be registered on the portfolio by
its owner before it can trade anything.

The key never leaves the Worker. AIRSPACE does not hold it, and the portfolio
owner cannot make an agent trade — only stop it.
