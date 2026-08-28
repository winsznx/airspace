import { createWalletClient, http, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { airspacePortfolioAbi } from "@airspace/sdk";
import { discoverMarkets, readBook, readLiveState } from "@airspace/protocol";
import { explainAdmission } from "@airspace/risk";
import { REFUSAL_NAME } from "@airspace/types";
import { DEFAULT_OFFSET_TICKS, nextOffset, propose, type StrategyId } from "./strategy.js";
import { publicClient, somniaChain } from "./rpc.js";

/**
 * A sample AIRSPACE trading agent.
 *
 * One deployment per agent, one key per deployment, no shared state and no
 * coordination between them. That independence is the point: the portfolio has
 * to hold its envelope against processes that do not know about each other and
 * cannot be made to cooperate.
 *
 * The agent holds its own key and calls the portfolio directly. AIRSPACE never
 * signs for it, and the portfolio owner cannot make it trade.
 */

export interface Env {
  CHAIN_ID: string;
  SHANNON_RPC: string;
  SHANNON_RPC_FALLBACK: string;
  AIRSPACE_PORTFOLIO: string;
  AGENT_STRATEGY: StrategyId;
  /** Contracts per order, in collateral scale. */
  AGENT_SIZE: string;
  /** Only trade markets in this cadence, in seconds. Blank means any. */
  AGENT_CADENCE?: string;
  /** Base URL of the AIRSPACE API, used only to report refusals. */
  AIRSPACE_API?: string;

  /** SECRET. The agent's own key. Never leaves this Worker. */
  AGENT_PRIVATE_KEY: string;

  /** Last-seen mids, so momentum has something to compare against. */
  AGENT_STATE: KVNamespace;
}

export default {
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      tick(env)
        .then((r) => console.log("tick", JSON.stringify(r)))
        .catch((e) => console.error("tick failed", e instanceof Error ? e.message : String(e))),
    );
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        strategy: env.AGENT_STRATEGY,
        agent: account(env).address,
        portfolio: env.AIRSPACE_PORTFOLIO,
      });
    }
    if (url.pathname === "/tick" && req.method === "POST") {
      return Response.json(await tick(env));
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
};

const account = (env: Env) => privateKeyToAccount(env.AGENT_PRIVATE_KEY as Hex);

/**
 * DreamDEX error selectors, identified by probing the live pool. They are not in
 * any published ABI we have, so they are matched on the wire.
 *   PostOnlyWouldCross() — a post-only order priced where it would take.
 *   InsufficientBalance() — a sell of outcome tokens the portfolio does not hold.
 */
const POST_ONLY_WOULD_CROSS = "0x7cf05fcb";
const INSUFFICIENT_BALANCE = "0xf4d678b8";

/** 100% headroom over the estimate. See the estimate call for why. */
const GAS_HEADROOM_BPS = 20_000n;

/** A receipt that consumed almost its whole limit was starved, not refused. */
const OUT_OF_GAS_RATIO_BPS = 9_500n;

export interface TickReport {
  strategy: StrategyId;
  agent: Address;
  portfolio: Address;
  marketsConsidered: number;
  market?: string;
  proposal?: { kind: number; price: string; quantity: string; rationale: string };
  outcome:
    | "no-market"
    | "no-signal"
    | "refused-preflight"
    | "refused-onchain"
    | "submitted"
    | "venue-rejected"
    | "out-of-gas"
    | "send-failed";
  refusal?: { code: number; name: string; blockingGate: string | null };
  txHash?: string;
  reported?: boolean;
  error?: string | undefined;
}

async function tick(env: Env): Promise<TickReport> {
  const client = publicClient(env);
  const acct = account(env);
  const portfolio = env.AIRSPACE_PORTFOLIO as Address;
  const strategy = env.AGENT_STRATEGY;

  const report: TickReport = {
    strategy,
    agent: acct.address,
    portfolio,
    marketsConsidered: 0,
    outcome: "no-market",
  };

  // Markets come from the DreamDEX registry, not from the AIRSPACE indexer. An
  // agent that cannot trade when our backend is down is not independent.
  const cadence = Number(env.AGENT_CADENCE ?? 0);
  const all = await discoverMarkets(client, { lookback: 40, minSecondsRemaining: 90 });
  const candidates = all.filter((m) => m.domain !== null && (cadence === 0 || m.cadenceSec === cadence));
  report.marketsConsidered = candidates.length;
  if (candidates.length === 0) return report;

  // Deterministic but agent-specific choice: three agents on the same minute
  // spread across markets instead of stacking on one, without any coordination
  // between them.
  const market = candidates[Number(BigInt(acct.address) % BigInt(candidates.length))]!;
  report.market = market.marketId;

  const [live, book] = await Promise.all([readLiveState(client, market), readBook(client, market.pool, 3)]);
  if (!live.trading) return { ...report, outcome: "no-market" };

  const midKey = `mid:${strategy}:${market.marketId}`;
  const offsetKey = `offset:${strategy}`;
  const [previous, storedOffset] = await Promise.all([
    env.AGENT_STATE.get(midKey),
    env.AGENT_STATE.get(offsetKey),
  ]);
  const offsetTicks = storedOffset ? Number(storedOffset) : DEFAULT_OFFSET_TICKS;

  const p = propose(strategy, {
    book,
    grid: { tickSize: live.tickSize, lotSize: live.lotSize, minQuantity: live.minQuantity },
    previousMid: previous ? BigInt(previous) : null,
    baseQuantity: BigInt(env.AGENT_SIZE || "0"),
    offsetTicks,
    secondsRemaining: live.secondsRemaining,
  });

  await rememberMid(env, midKey, book);
  if (!p) return { ...report, outcome: "no-signal" };

  report.proposal = {
    kind: p.kind,
    price: p.price.toString(),
    quantity: p.quantity.toString(),
    rationale: p.rationale,
  };

  const nonce =
    ((await client.readContract({
      address: portfolio,
      abi: airspacePortfolioAbi,
      functionName: "agentNonce",
      args: [acct.address],
    })) as bigint) + 1n;

  const intent = {
    marketId: market.marketId,
    pool: market.pool,
    marketNonce: market.marketNonce,
    kind: p.kind,
    price: p.price,
    quantity: p.quantity,
    expireTimestampNs: live.marketExpiryNs,
    orderType: 3,
    nonce,
    strategyVersion: keccak256(toHex(`${strategy}@1.0.0`)),
  } as const;

  // Preflight, so the agent does not pay gas to be told no. This is advisory:
  // the contract re-evaluates on execution and can reach a different answer if
  // another agent's transaction lands in between. That race is the normal case
  // with several agents on one portfolio, and is handled below.
  const view = (await client.readContract({
    address: portfolio,
    abi: airspacePortfolioAbi,
    functionName: "previewIntent",
    args: [acct.address, intent],
  })) as never;

  const preview = explainAdmission(view);
  if (!preview.admitted) {
    const code = (view as { refusal: number }).refusal;
    return {
      ...report,
      outcome: "refused-preflight",
      refusal: { code, name: REFUSAL_NAME[code] ?? String(code), blockingGate: preview.blockingGate },
    };
  }

  const wallet = createWalletClient({ account: acct, chain: somniaChain(env), transport: http(env.SHANNON_RPC) });

  let txHash: Hex;
  try {
    // Estimate, then pad.
    //
    // `execute` walks the domain's tracked markets, so its gas cost depends on
    // SHARED state that the other agents are changing. Measured live: two
    // transactions estimated at ~3.68M ran out of gas at 3.52M used, in
    // consecutive blocks, because another agent's transaction tracked a new
    // market in between. An out-of-gas is far worse than a refusal — it burns
    // the whole limit and tells the agent nothing — so the estimate is padded
    // rather than trusted.
    const estimate = await client.estimateContractGas({
      address: portfolio,
      abi: airspacePortfolioAbi,
      functionName: "execute",
      args: [intent],
      account: acct.address,
    });

    txHash = await wallet.writeContract({
      address: portfolio,
      abi: airspacePortfolioAbi,
      functionName: "execute",
      args: [intent],
      chain: somniaChain(env),
      gas: (estimate * GAS_HEADROOM_BPS) / 10_000n,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);

    // The venue refused before the transaction was ever sent, because viem
    // simulates first. A post-only order that would cross is an ordinary
    // outcome, not a failure: back off and quote further out next tick.
    if (message.includes(POST_ONLY_WOULD_CROSS)) {
      await env.AGENT_STATE.put(offsetKey, String(nextOffset(offsetTicks, true)));
      return { ...report, outcome: "venue-rejected", error: "PostOnlyWouldCross" };
    }
    if (message.includes(INSUFFICIENT_BALANCE)) {
      return { ...report, outcome: "venue-rejected", error: "InsufficientBalance" };
    }

    // Anything else leaves nothing on chain, so the reason has to be carried
    // out in the tick result or it is lost.
    return { ...report, outcome: "send-failed", error: message.slice(0, 400) };
  }

  const receipt = await client.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
  if (receipt.status === "success") {
    await env.AGENT_STATE.put(offsetKey, String(nextOffset(offsetTicks, false)));
    return { ...report, outcome: "submitted", txHash };
  }

  // A reverted transaction is not automatically a refusal. Running out of gas
  // also reverts, and on a shared portfolio it is a live hazard: `execute` walks
  // the domain's markets, so another agent tracking a new market between the
  // estimate and the send raises the cost. Consuming nearly the whole limit is
  // the signature, and calling that a refusal would put a decision in the feed
  // that the contract never made.
  const tx = await client.getTransaction({ hash: txHash });
  if (receipt.gasUsed * 10_000n >= tx.gas * OUT_OF_GAS_RATIO_BPS) {
    return {
      ...report,
      outcome: "out-of-gas",
      txHash,
      error: `used ${receipt.gasUsed} of ${tx.gas}`,
    };
  }

  // The preview said yes and the contract said no: another agent moved the
  // shared state in between. The refusal is in this failed transaction, and it
  // is the most interesting thing this agent will produce all day, so hand the
  // hash to the API and let it verify the revert against the chain itself. The
  // API re-derives the refusal from the chain and rejects the report if the
  // transaction did not actually revert with `Refused(code)`.
  const reported = await reportRefusal(env, portfolio, txHash);
  return { ...report, outcome: "refused-onchain", txHash, reported };
}

/** Store the mid this agent saw, so its next tick has something to compare to. */
async function rememberMid(env: Env, key: string, book: { bids: readonly { price: bigint }[]; asks: readonly { price: bigint }[] }) {
  const bid = book.bids[0]?.price;
  const ask = book.asks[0]?.price;
  if (bid === undefined || ask === undefined) return;
  // Expire with the market: a stale mid from a rolled series is worse than none.
  await env.AGENT_STATE.put(key, ((bid + ask) / 2n).toString(), { expirationTtl: 3600 });
}

async function reportRefusal(env: Env, portfolio: Address, txHash: Hex): Promise<boolean> {
  if (!env.AIRSPACE_API) return false;
  try {
    const res = await fetch(`${env.AIRSPACE_API}/api/intents/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ portfolio, txHash }),
    });
    return res.ok;
  } catch {
    // Reporting is a convenience. The refusal is on chain either way.
    return false;
  }
}
