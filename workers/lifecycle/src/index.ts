import type { Address, MarketId } from "@airspace/types";
import { airspacePortfolioAbi } from "@airspace/sdk";
import { binaryMarketAbi, binaryPoolAbi, binaryModuleAbi, DREAMDEX, erc6909Abi } from "@airspace/protocol";
import { createServiceDb, toBigInt } from "@airspace/db";
import { createPublicClient, createWalletClient, http, fallback, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * AIRSPACE lifecycle worker.
 *
 * Keeps the portfolio LIVE. It cannot make it unsafe.
 *
 * Everything this worker calls is permissionless and non-discretionary:
 * `releaseOrder`, `releaseSettled` and `pruneMarket` each read authoritative
 * chain state and can only move the portfolio's books toward it. The caller
 * supplies no quantities. If this worker stops entirely:
 *
 *   - owner funds remain recoverable (owner recovery reads no lifecycle state),
 *   - agents still cannot exceed a ceiling (reservations are retained, which
 *     overstates usage — the safe direction),
 *   - only LIVENESS degrades: a fast-cadence domain eventually reaches its
 *     48-market cap and fails closed until someone prunes.
 *
 * That last point is why this worker exists at all (PRD 17.1).
 */

export interface Env {
  CHAIN_ID: string;
  SHANNON_RPC: string;
  SHANNON_RPC_FALLBACK: string;
  AIRSPACE_FACTORY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  /** Optional. Without it the worker plans work but cannot send transactions. */
  KEEPER_PRIVATE_KEY?: string;
  RECONCILE_QUEUE: Queue<Job>;
}

export interface Job {
  kind: "release-order" | "release-settled" | "prune-market" | "sync-portfolio";
  chainId: number;
  portfolio: Address;
  marketId?: MarketId;
  orderKey?: `0x${string}`;
  reason?: string;
}

const chain = (env: Env) =>
  ({
    id: Number(env.CHAIN_ID ?? 50312),
    name: "Somnia",
    nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
    rpcUrls: { default: { http: [env.SHANNON_RPC] } },
  }) as const;

function pub(env: Env): PublicClient {
  const urls = [env.SHANNON_RPC, env.SHANNON_RPC_FALLBACK].filter(Boolean) as string[];
  return createPublicClient({
    chain: chain(env),
    // Failover is for TRANSPORT failure only. A deterministic revert is an
    // answer and must never be retried elsewhere as though it might succeed.
    transport: fallback(urls.map((u) => http(u, { retryCount: 0, timeout: 10_000 })), { rank: false }),
  }) as PublicClient;
}

function keeper(env: Env) {
  if (!env.KEEPER_PRIVATE_KEY) return null;
  const account = privateKeyToAccount(env.KEEPER_PRIVATE_KEY as `0x${string}`);
  return {
    account,
    wallet: createWalletClient({ account, chain: chain(env), transport: http(env.SHANNON_RPC) }),
  };
}

// ---------------------------------------------------------------------------
// Scheduled scan — plan work, enqueue it, never do it inline
// ---------------------------------------------------------------------------

async function scan(env: Env): Promise<{ portfolios: number; queued: number }> {
  const db = createServiceDb(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const client = pub(env);
  const chainId = Number(env.CHAIN_ID ?? 50312);

  const { data: portfolios } = await db
    .from("portfolios")
    .select("id,portfolio_address")
    .eq("chain_id", chainId)
    .limit(500);

  let queued = 0;
  for (const p of portfolios ?? []) {
    const address = p.portfolio_address as Address;

    // 1. Resting orders whose market has rolled, or that the book no longer
    //    holds. Releasing them returns headroom the portfolio is retaining.
    const { data: open } = await db
      .from("reservations")
      .select("order_key,pool_address,market_nonce,market_id")
      .eq("portfolio_id", p.id)
      .in("state", ["RESTING", "PARTIAL", "NEEDS_RECONCILIATION"])
      .limit(100);

    for (const r of open ?? []) {
      const stillLive = await orderStillLive(
        client,
        r.pool_address as Address,
        BigInt(r.market_nonce),
        r.order_key as `0x${string}`,
        address,
      );
      if (!stillLive) {
        await enqueue(env, db, {
          kind: "release-order",
          chainId,
          portfolio: address,
          orderKey: r.order_key as `0x${string}`,
          reason: "order no longer live on the book",
        });
        queued++;
      }
    }

    // 2. Markets that have gone terminal on-chain: their positions are fixed
    //    claims, not bets, so their exposure should stop occupying the domain.
    const { data: tracked } = await db
      .from("positions")
      .select("market_id,settled")
      .eq("portfolio_id", p.id)
      .eq("settled", false)
      .limit(100);

    for (const t of tracked ?? []) {
      const terminal = await marketTerminal(client, t.market_id as MarketId);
      if (terminal) {
        await enqueue(env, db, {
          kind: "release-settled",
          chainId,
          portfolio: address,
          marketId: t.market_id as MarketId,
          reason: "market resolved or voided",
        });
        queued++;
      }
    }

    // 3. Prune spent generations. Without this a 60-second domain reaches the
    //    48-market cap in about 48 minutes and fails closed.
    const { data: domains } = await db
      .from("domain_policies")
      .select("domain_hash")
      .eq("portfolio_id", p.id)
      .limit(50);

    for (const d of domains ?? []) {
      const ids = (await client.readContract({
        address,
        abi: airspacePortfolioAbi,
        functionName: "domainMarkets",
        args: [d.domain_hash as `0x${string}`],
      })) as MarketId[];

      // Only prune when the set is filling up: pruning is cheap but not free.
      if (ids.length < 24) continue;
      for (const marketId of ids) {
        if (await prunable(client, address, marketId)) {
          await enqueue(env, db, {
            kind: "prune-market",
            chainId,
            portfolio: address,
            marketId,
            reason: `domain set at ${ids.length}/48`,
          });
          queued++;
        }
      }
    }
  }

  return { portfolios: (portfolios ?? []).length, queued };
}

/** Insert the job (deduped by a partial unique index) and publish it. */
async function enqueue(env: Env, db: ReturnType<typeof createServiceDb>, job: Job): Promise<void> {
  const { data: pf } = await db
    .from("portfolios")
    .select("id")
    .eq("portfolio_address", job.portfolio.toLowerCase())
    .maybeSingle();

  const { error } = await db.from("reconciliation_jobs").insert({
    portfolio_id: pf?.id ?? null,
    chain_id: job.chainId,
    kind: job.kind,
    market_id: job.marketId ?? null,
    order_key: job.orderKey ?? null,
    reason: job.reason ?? null,
  });
  // 23505 = already queued. That is success, not an error: the dedupe index is
  // what stops an event burst from flooding the queue.
  if (error && error.code !== "23505") throw new Error(`enqueue failed: ${error.message}`);
  if (!error) await env.RECONCILE_QUEUE.send(job);
}

// ---------------------------------------------------------------------------
// Chain probes
// ---------------------------------------------------------------------------

async function orderStillLive(
  client: PublicClient,
  pool: Address,
  marketNonce: bigint,
  orderKey: `0x${string}`,
  portfolio: Address,
): Promise<boolean> {
  try {
    const nonce = (await client.readContract({
      address: pool,
      abi: binaryPoolAbi,
      functionName: "marketNonce",
    })) as bigint;
    // The pool has been recycled onto a later market: that market is over.
    if (nonce !== marketNonce) return false;

    const rec = (await client.readContract({
      address: portfolio,
      abi: airspacePortfolioAbi,
      functionName: "orderRec",
      args: [orderKey],
    })) as readonly [Address, MarketId, Address, bigint, bigint, number, bigint, bigint];
    const orderId = rec[4];
    const qtyOpen = rec[6];
    if (qtyOpen === 0n) return false;

    // `getOrder` reverts IncorrectOrder() for filled, cancelled and unknown ids
    // alike. We only use it to learn whether anything still rests; we never try
    // to infer WHY it is gone, because the protocol cannot tell us.
    const o = (await client.readContract({
      address: pool,
      abi: binaryPoolAbi,
      functionName: "getOrder",
      args: [orderId],
    })) as { quantityRemaining: bigint };
    return o.quantityRemaining >= qtyOpen;
  } catch {
    // A revert here means "no active order", which is a definite answer.
    return false;
  }
}

async function marketTerminal(client: PublicClient, marketId: MarketId): Promise<boolean> {
  try {
    const rec = (await client.readContract({
      address: DREAMDEX.binaryModule,
      abi: binaryModuleAbi,
      functionName: "markets",
      args: [marketId],
    })) as readonly unknown[];
    const market = rec[8] as Address;
    if (!market || market === "0x0000000000000000000000000000000000000000") return false;
    const [resolved, voided] = await Promise.all([
      client.readContract({ address: market, abi: binaryMarketAbi, functionName: "isResolved" }),
      client.readContract({ address: market, abi: binaryMarketAbi, functionName: "isVoided" }),
    ]);
    return Boolean(resolved) || Boolean(voided);
  } catch {
    return false;
  }
}

/** Mirrors the contract's own prune precondition, so a job is not wasted gas. */
async function prunable(client: PublicClient, portfolio: Address, marketId: MarketId): Promise<boolean> {
  try {
    const m = (await client.readContract({
      address: portfolio,
      abi: airspacePortfolioAbi,
      functionName: "marketState",
      args: [marketId],
    })) as readonly [Address, bigint, `0x${string}`, bigint, bigint, bigint, bigint, boolean, boolean];
    const [pool, nonce, , yesLong, yesShort, noLong, noShort, tracked, settled] = m;
    if (!tracked) return false;
    if (yesLong || yesShort || noLong || noShort) return false;
    if (settled) return true;

    const yesId = (BigInt(pool) << 72n) | (nonce << 8n);
    const [y, n] = await Promise.all([
      client.readContract({ address: DREAMDEX.outcomeToken, abi: erc6909Abi, functionName: "balanceOf", args: [portfolio, yesId] }),
      client.readContract({ address: DREAMDEX.outcomeToken, abi: erc6909Abi, functionName: "balanceOf", args: [portfolio, yesId + 1n] }),
    ]);
    return (y as bigint) === 0n && (n as bigint) === 0n;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Job execution
// ---------------------------------------------------------------------------

/**
 * One keeper key sends every job, so the nonce has to be sequenced here.
 *
 * A queue batch delivers several messages at once. Letting each write derive its
 * own nonce means two jobs in the same batch both read the same pending count
 * and the second is rejected: "Nonce provided for the transaction is lower than
 * the current nonce." Measured in production — the keeper landed some releases
 * and lost the rest of every batch that way.
 *
 * The nonce is read once per batch and handed out in order. It is reset on any
 * send failure so the next batch re-reads it rather than compounding a bad
 * guess.
 */
class NonceSequence {
  private next: bigint | null = null;

  constructor(
    private readonly client: PublicClient,
    private readonly address: `0x${string}`,
  ) {}

  async take(): Promise<number> {
    if (this.next === null) {
      this.next = BigInt(await this.client.getTransactionCount({ address: this.address, blockTag: "pending" }));
    }
    const n = this.next;
    this.next += 1n;
    return Number(n);
  }

  reset(): void {
    this.next = null;
  }
}

async function runJob(
  env: Env,
  job: Job,
  nonces?: NonceSequence,
): Promise<{ done: boolean; note: string; txHash?: string; suspect?: boolean }> {
  const k = keeper(env);
  if (!k) return { done: false, note: "no keeper key configured; job planned but not sent" };

  const client = pub(env);
  const fn =
    job.kind === "release-order"
      ? { name: "releaseOrder" as const, args: [job.orderKey] }
      : job.kind === "release-settled"
        ? { name: "releaseSettled" as const, args: [job.marketId] }
        : job.kind === "prune-market"
          ? { name: "pruneMarket" as const, args: [job.marketId] }
          : null;

  if (!fn) return { done: true, note: "no on-chain action for this job kind" };

  try {
    // Simulate first: these calls revert by design when the precondition is not
    // met (an order still live, a market not yet settled), and that revert is a
    // correct answer, not a failure to retry.
    const { request } = await client.simulateContract({
      address: job.portfolio,
      abi: airspacePortfolioAbi,
      functionName: fn.name,
      args: fn.args as never,
      account: k.account,
    });
    const nonce = nonces ? await nonces.take() : undefined;
    const txHash = await k.wallet.writeContract(nonce === undefined ? request : { ...request, nonce });
    await client.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
    return { done: true, note: `${fn.name} sent`, txHash };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);

    // `NothingToRelease` on an order the projection still shows as open is not
    // a completed release: it means the contract has no record under this key,
    // so the KEY is wrong and the projection is lying about a live reservation.
    //
    // This is not hypothetical. Reservation keys derived from an order id that
    // had been round-tripped through PostgREST's JSON number lost precision, and
    // every release silently reported "nothing to release" while the domain sat
    // pinned at its ceiling. Treating that as success is what made the failure
    // silent, so it is now flagged for reconciliation instead.
    if (job.kind === "release-order" && /NothingToRelease|NotTracked/.test(msg)) {
      return { done: true, note: "no contract record under this order key: projection needs rebuilding", suspect: true };
    }

    // A deterministic revert means the work is not applicable yet or is already
    // done. Both are terminal for this job; retrying would waste gas.
    if (/OrderStillLive|NothingToRelease|MarketNotSettled|MarketStillActive|NotTracked/.test(msg)) {
      return { done: true, note: `precondition not met: ${msg.slice(0, 120)}` };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Worker entrypoints
// ---------------------------------------------------------------------------

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      scan(env)
        .then((r) => console.log(JSON.stringify({ at: "scan", ...r })))
        .catch((e) => console.error(JSON.stringify({ at: "scan", error: String(e) }))),
    );
  },

  async queue(batch: MessageBatch<Job>, env: Env): Promise<void> {
    const db = createServiceDb(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

    /**
     * Address exactly the one job row this message came from.
     *
     * `.eq(col, null)` builds `col=eq.null`, which matches nothing in SQL —
     * NULL is not equal to anything, including NULL. A `release-settled` job has
     * no `order_key` and a `sync-portfolio` job has neither, so every status
     * update for those silently updated ZERO rows and the queue table filled
     * with jobs stuck at PENDING that had already run.
     */
    const addressJob = (q: ReturnType<ReturnType<typeof db.from>["update"]>, job: Job) => {
      let out = q.eq("chain_id", job.chainId).eq("kind", job.kind);
      out = job.orderKey ? out.eq("order_key", job.orderKey) : out.is("order_key", null);
      out = job.marketId ? out.eq("market_id", job.marketId) : out.is("market_id", null);
      return out;
    };
    const k = keeper(env);
    const nonces = k ? new NonceSequence(pub(env), k.account.address) : undefined;

    // Sequential on purpose. These sends share one key, and the chain, not this
    // loop, is the bottleneck.
    for (const msg of batch.messages) {
      const job = msg.body;
      try {
        const result = await runJob(env, job, nonces);
        await addressJob(
          db.from("reconciliation_jobs").update({
            status: result.done ? "DONE" : "PENDING",
            last_error: result.done ? null : result.note,
            updated_at: new Date().toISOString(),
          }),
          job,
        ).in("status", ["PENDING", "RUNNING"]);

        // A suspect release leaves the reservation visibly broken rather than
        // quietly gone, so an operator can see there is a projection to rebuild.
        if (result.suspect && job.orderKey) {
          await db
            .from("reservations")
            .update({ state: "NEEDS_RECONCILIATION", updated_at: new Date().toISOString() })
            .eq("order_key", job.orderKey);
        }

        console.log(JSON.stringify({ at: "job", kind: job.kind, ...result }));
        msg.ack();
      } catch (e) {
        // Transport or unexpected failure: retry with backoff. Cloudflare moves
        // the message to the DLQ once max_retries is exhausted, so a poisoned
        // job cannot spin forever.
        const attempts = msg.attempts;
        // The sequence may now be ahead of the chain, so drop it and let the
        // next job re-read the real pending nonce.
        nonces?.reset();
        console.error(JSON.stringify({ at: "job", kind: job.kind, attempts, error: String(e) }));
        // Scoped to THIS job. The previous version matched on chain and kind
        // alone, so one failure marked every release-order job on the chain as
        // FAILED — 281 rows, from a handful of real failures.
        await addressJob(
          db.from("reconciliation_jobs").update({
            status: "FAILED",
            attempt_count: attempts,
            last_error: String(e).slice(0, 500),
            updated_at: new Date().toISOString(),
          }),
          job,
        );
        msg.retry({ delaySeconds: Math.min(2 ** attempts * 5, 300) });
      }
    }
  },

  /** Manual trigger, for operators and tests. */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/scan") {
      const r = await scan(env);
      return Response.json(r);
    }
    if (url.pathname === "/health") {
      return Response.json({ ok: true, keeper: Boolean(env.KEEPER_PRIVATE_KEY) });
    }
    return new Response("airspace-lifecycle", { status: 200 });
  },
};
