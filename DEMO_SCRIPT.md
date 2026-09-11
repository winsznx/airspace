# Demo video script (about 2:45)

One take, one browser, one MetaMask. Every step below is done in the live app.
No terminal, no scripts.

**Live app:** https://airspace-api.timjosh507.workers.dev
**Portfolio:** `0x088A42b7E1806774e71388A48f59f167d1c1b2D9`
**Direct link:** https://airspace-api.timjosh507.workers.dev/app/0x088A42b7E1806774e71388A48f59f167d1c1b2D9

The story in one line: three agents each follow their own rules, and the third is
still refused because of what the first two are holding. Then room is freed and the
identical order goes through.

---

## Before you hit record

### Accounts (MetaMask, network Shannon, all funded with STT for gas)

| Name in MetaMask | Role | Address |
| --- | --- | --- |
| Owner | portfolio owner, cancels the order | `0xF97933dF45EB549a51Ce4c4e76130c61d08F1ab5` |
| Momentum | agent, places 70 | `0x7273dE585311a5139Ef83f0F6Dbb29F3e57b3389` |
| Oracle | agent, places 100 | one of `0x51F19F71e9d073AAB39f6fd003F424984390E5A0` / `0xEfd50EC809f87393b87513f207DaddEb80C0491F` |
| MeanRev | agent, tries 50 | the other one |

Rename the three accounts in MetaMask to match the table so you never have to think
about which is which on camera.

### Name the agents in the app (once, off camera)

1. Connect as **Owner**. Open **Agents**.
2. On each agent card click **Rename**, type `Momentum`, `Oracle` or `MeanRev`,
   press Save, and sign the message (no gas, no transaction).

### The state you want to start from

- **Control room** shows usage **0 of 200** on the 5-minute domain. It should
  already, because every earlier order is released.
- Free collateral is a few hundred tUSDC. This demo needs about 25.
- There is no yellow "reading history" banner. If there is, wait a minute.

### Two rules that keep it smooth

- **Pick the market with the most time left.** The Market dropdown only lists
  markets with at least 2 minutes to go and shows a countdown. Markets roll every
  5 minutes and the contract wants about a minute of runway at execution, so sign
  promptly. If the list is empty, wait for the next market.
- **Price every order at 0.10.** It rests well below the book, so it cannot cross
  (Post-only would refuse a crossing order) and it will not fill, which keeps the
  reservation cancellable.

### Dry run

Run the whole thing once before recording. Then reset: as Owner, cancel and
release anything left on the Positions page until usage is back to 0.

---

## The script

Times are targets. Waiting for a wallet is cut in the edit, so the spoken parts set
the length.

### 0:00 to 0:15. The problem

**On screen:** landing page. Click **Open the control room**, connect as **Owner**, and
open the portfolio (or go straight to the direct link above).

**Say:**
"Three trading agents. Each one follows its own limits perfectly. Together they can
still break a limit nobody set for any one of them. AIRSPACE is the control plane
that stops that: one pool of capital, one risk ceiling, shared by every agent."

### 0:15 to 0:35. The envelope

**On screen:** Control room, connected as **Owner**. Point at, in order:
1. **Capital base** (500).
2. **Shared risk envelope**: the 5-minute domain, **0 of 200**.
3. Click **Agents** for two seconds so the three named agents show, then back to
   **Control room**.

**Say:**
"This portfolio holds 500 in test collateral. Every agent trades the same live
five-minute markets, and together they may hold at most 200 contracts. That ceiling
is enforced by the contract, not by this page."

### 0:35 to 1:00. Momentum takes 70

**On screen:**
1. In MetaMask switch to **Momentum**. The page follows on its own, no refresh.
2. Scroll to **Would this be admitted?**. The **Agent** field fills with Momentum.
3. **Market:** the one with the most time left. **Side:** Buy YES. **Price:** 0.10.
   **Quantity:** 70. **Order type:** Post-only.
4. Click **Preview admission**. Every gate shows PASS.
5. Click **Place order**, confirm in the wallet. Wait for **Confirmed**.
6. The ceiling line moves to **70 of 200**.

**Say:**
"Momentum wants 70. I ask the contract first. Its own policy passes, the market
passes, and the portfolio has room. It is admitted, and the reservation counts
against the shared ceiling straight away."

### 1:00 to 1:25. Oracle takes 100

**On screen:** switch MetaMask to **Oracle**. Same form, **Quantity: 100**, same price
and order type. **Preview admission** (all PASS, arithmetic reads `70 + 100 = 170`).
**Place order**, confirm. Ceiling line reads **170 of 200**.

**Say:**
"Oracle wants 100. Seventy already used, so this makes 170 of 200. Still inside the
line, so it goes through. Two independent agents, two independent keys, one
envelope."

### 1:25 to 1:55. MeanRev is refused

**On screen:** switch MetaMask to **MeanRev**. **Quantity: 50**, price 0.10. Click
**Preview admission**. Show the gate stack: Agent policy, Market trading, Market
generation, Tick / lot, Price ceiling and Market headroom all PASS, **Portfolio
domain FAIL**. Point at the arithmetic: `170 + 50 = 220 > 200`. Then click **Place
order anyway**. The refusal appears before any wallet popup:
**Portfolio risk ceiling reached**.

**Say:**
"MeanRev wants 50. Every check MeanRev controls passes: its own policy, the market,
the price, the size. One gate fails, the portfolio one. 170 plus 50 is 220, over the
200 ceiling. MeanRev did nothing wrong. Momentum and Oracle used the room. That
refusal is the product."

### 1:55 to 2:25. Free the room

**On screen:**
1. Switch MetaMask to **Owner**. Click **Positions**, then the **Reservations** tab.
2. Find Momentum's row (70). Click **Cancel**, confirm in the wallet.
3. The row's state changes to **needs reconciliation** on its own. Click **Release**,
   confirm.
4. Go back to **Control room**. The ceiling line reads **100 of 200**.

**Say:**
"The owner cancels Momentum's resting order, and anyone can then release the
reservation. Releasing is permissionless and the contract checks it against the
venue before freeing a single unit. Usage drops to 100."

### 2:25 to 2:50. The same order, admitted

**On screen:** switch MetaMask to **MeanRev**. Same form: Quantity 50, price 0.10, a
market with time left. **Preview admission**: every gate PASS, `100 + 50 = 150 ≤ 200`.
**Place order**, confirm. Ceiling line reads **150 of 200**. Click **Activity**, open
the newest row to show the receipt.

**Say:**
"Same agent, same order, different answer, because the room changed. That is what a
shared risk envelope does. Every decision leaves a receipt, and every number on it
came from the contract."

### 2:50 to 3:00. Close

**On screen:** the receipt, or back to the landing page.

**Say:**
"AIRSPACE. One pool, many agents, one envelope, enforced on chain."

---

## If something goes wrong on camera

| You see | What it is | Do this |
| --- | --- | --- |
| `PostOnlyWouldCross` after Place order | your price reaches the book | lower the price to 0.05 and retry |
| **Market not trading** or **Insufficient headroom** | the market has under about a minute left | pick a market with more time, or wait for the next |
| **Connected wallet is not this agent** | MetaMask is on a different account | switch to the agent shown in the Agent field |
| **Reading this portfolio's history from the chain** banner | the lists are still loading | wait a minute, it fills in on its own |
| **Release** is greyed out after Cancel | the row has not refreshed yet | wait a few seconds, or click **Reconcile now** on the Control room |
| An order filled, so **Cancel** does nothing | a seller took it | as Owner use **Reconcile now**, or wait for the market to settle, then reset |

## Cut list for the edit

- Trim every wait on **Confirmed** to a half-second.
- Keep the gate stack and the arithmetic line on screen for at least three
  seconds each. They are the point of the video.
- Keep the Control room ceiling line visible after every admitted order.

## After recording

Reset the portfolio so a judge who opens the app starts clean: as Owner, cancel and
release anything left on **Positions**, and check the Control room reads 0 of 200.
