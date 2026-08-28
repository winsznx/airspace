import {
  decodeEventLog,
  parseAbiItem,
  type Log,
  type PublicClient,
} from "viem";
import type { Address, MarketId } from "@airspace/types";
import {
  airspacePortfolioAbi,
  airspacePortfolioFactoryAbi,
} from "@airspace/sdk";
import { orderKey, readMarket } from "@airspace/protocol";
import { createServiceDb, type SupabaseClient } from "@airspace/db";
import { chainId, factoryAddress, ingestWindow, type Env } from "./env.js";
import { publicClient } from "./rpc.js";

/**
 * AIRSPACE chain indexer.
 *
 * Reads logs, writes projections. Three properties matter more than throughput:
 *
 *   Idempotent. Every log lands in `chain_events` keyed by
 *   (chain_id, tx_hash, log_index). A replayed block, a retried cron, a
 *   duplicate delivery and a reorg re-scan all converge on the same rows.
 *
 *   Ordered within a transaction. `IntentAdmitted` carries the order id and
 *   `IntentReconciled` carries what actually filled. They are emitted in that
 *   order in the same transaction, so logs are processed in (block, logIndex)
 *   order and never sorted by anything else.
 *
 *   Never authoritative. Nothing written here is read back to make an admission
 *   decision. The contract re-derives everything at execution time; these rows
 *   exist so a human can see history without an archive node.
 */

const FACTORY_EVENT = parseAbiItem(
  "event PortfolioCreated(address indexed portfolio, address indexed owner, bytes32 indexed salt, string version, uint256 index)",
);

/** Logs are fetched by address, not by topic, so a new event needs no change here. */
type Row = Record<string, unknown>;

const lower = (a: string) => a.toLowerCase();

export default {
  async scheduled(
    _c: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      ingest(env).then((r) => console.log("ingest", JSON.stringify(r))),
    );
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        chainId: chainId(env),
        factory: env.AIRSPACE_FACTORY,
      });
    }
    if (url.pathname === "/ingest" && req.method === "POST") {
      // Manual trigger for local development and CI. Without a configured token
      // the route does not exist at all rather than being open.
      if (!env.INDEXER_TOKEN)
        return Response.json({ error: "NOT_ENABLED" }, { status: 404 });
      if (req.headers.get("authorization") !== `Bearer ${env.INDEXER_TOKEN}`) {
        return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
      }
      return Response.json(await ingest(env));
    }
    if (url.pathname === "/rewind" && req.method === "POST") {
      // Operational tool, and the only honest way to test that re-processing
      // already-seen blocks converges instead of duplicating. Same token gate.
      if (!env.INDEXER_TOKEN)
        return Response.json({ error: "NOT_ENABLED" }, { status: 404 });
      if (req.headers.get("authorization") !== `Bearer ${env.INDEXER_TOKEN}`) {
        return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
      }
      const blocks = BigInt(url.searchParams.get("blocks") ?? "1000");
      return Response.json(await rewind(env, blocks));
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
};

export interface IngestReport {
  chainId: number;
  fromBlock: string;
  toBlock: string;
  head: string;
  portfoliosDiscovered: number;
  portfoliosWatched: number;
  logs: number;
  applied: number;
  duplicates: number;
  caughtUp: boolean;
}

/**
 * Both public Somnia RPCs reject an `eth_getLogs` range wider than 1000 blocks,
 * so this is a protocol constraint rather than a tuning choice. INGEST_WINDOW is
 * the per-invocation budget; this is the size of each call inside it.
 */
const MAX_LOG_RANGE = 1000n;

export async function ingest(env: Env): Promise<IngestReport> {
  const db = createServiceDb(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const client = publicClient(env);
  const cid = chainId(env);
  const factory = factoryAddress(env);

  const head = await client.getBlockNumber();
  const cursor = await readCursor(db, cid, factory, client);
  const start = cursor + 1n;
  const budgetEnd = start + ingestWindow(env) - 1n;
  const end = budgetEnd > head ? head : budgetEnd;

  const report: IngestReport = {
    chainId: cid,
    fromBlock: start.toString(),
    toBlock: (start > end ? cursor : end).toString(),
    head: head.toString(),
    portfoliosDiscovered: 0,
    portfoliosWatched: 0,
    logs: 0,
    applied: 0,
    duplicates: 0,
    caughtUp: start > head,
  };
  if (start > end) return report;

  // Portfolio ids are cached across chunks; a portfolio discovered in chunk 1
  // must be watched from chunk 2 onward without another round trip.
  const byAddress = new Map<string, string>();
  const { data: known } = await db
    .from("portfolios")
    .select("id, portfolio_address")
    .eq("chain_id", cid);
  for (const p of (known ?? []) as Array<{
    id: string;
    portfolio_address: string;
  }>) {
    byAddress.set(lower(p.portfolio_address), p.id);
  }

  for (let from = start; from <= end; from += MAX_LOG_RANGE) {
    const to =
      from + MAX_LOG_RANGE - 1n > end ? end : from + MAX_LOG_RANGE - 1n;

    // New portfolios first, so their own logs in the same chunk are captured.
    const created = await client.getLogs({
      address: factory,
      event: FACTORY_EVENT,
      fromBlock: from,
      toBlock: to,
    });
    for (const log of created) {
      const id = await upsertPortfolio(db, client, cid, factory, log);
      if (id) byAddress.set(id.address, id.id);
    }
    report.portfoliosDiscovered += created.length;

    if (byAddress.size > 0) {
      const logs = await client.getLogs({
        address: [...byAddress.keys()] as Address[],
        fromBlock: from,
        toBlock: to,
      });
      report.logs += logs.length;

      // (block, logIndex) is the only ordering that reflects execution order.
      logs.sort((a, b) =>
        a.blockNumber === b.blockNumber
          ? Number(a.logIndex ?? 0) - Number(b.logIndex ?? 0)
          : Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)),
      );

      const times = new Map<string, number>();

      // `IntentAdmitted` carries the order id and `IntentReconciled` carries what
      // filled, in that order in one transaction. Holding the admitted values
      // here means the reconcile never has to read them back out of Postgres —
      // which matters: PostgREST serialises `numeric` as a JSON number, and an
      // order id of 239807672958224550581 does not survive an IEEE-754 double.
      // Every order key derived that way was wrong.
      const admitted = new Map<
        string,
        { pool: Address; marketNonce: bigint; orderId: bigint }
      >();

      for (const log of logs) {
        const portfolioId = byAddress.get(lower(log.address));
        if (!portfolioId) continue;

        let decoded: { eventName: string; args: Row };
        try {
          decoded = decodeEventLog({
            abi: airspacePortfolioAbi,
            data: log.data,
            topics: log.topics,
          }) as {
            eventName: string;
            args: Row;
          };
        } catch {
          // A log from a contract we watch but an event we do not model. Skipping
          // is correct: inventing a projection from an unknown shape is worse.
          continue;
        }

        const key = (log.blockNumber ?? 0n).toString();
        if (!times.has(key)) {
          const block = await client.getBlock({
            blockNumber: log.blockNumber ?? 0n,
          });
          times.set(key, Number(block.timestamp));
        }

        if (
          !(await recordEvent(
            db,
            cid,
            log,
            decoded.eventName,
            decoded.args,
            times.get(key)!,
          ))
        ) {
          report.duplicates += 1;
          continue;
        }

        if (decoded.eventName === "IntentAdmitted") {
          admitted.set(decoded.args.intentHash as string, {
            pool: decoded.args.pool as Address,
            marketNonce: decoded.args.marketNonce as bigint,
            orderId: decoded.args.orderId as bigint,
          });
        }

        await project(
          db,
          client,
          cid,
          portfolioId,
          log,
          decoded.eventName,
          decoded.args,
          admitted,
        );
        report.applied += 1;
      }
    }

    // The cursor advances per chunk, so a mid-run failure resumes from the last
    // fully processed chunk rather than replaying the whole window.
    await writeCursor(db, cid, to);
    report.toBlock = to.toString();
  }

  report.portfoliosWatched = byAddress.size;
  report.caughtUp = BigInt(report.toBlock) >= head;
  return report;
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

const STREAM = "portfolio-logs";

/**
 * Where to resume.
 *
 * With no cursor the indexer starts at the factory's own deployment block
 * rather than at zero: earlier blocks cannot contain a portfolio log because no
 * portfolio existed.
 */
async function readCursor(
  db: SupabaseClient,
  cid: number,
  factory: Address,
  client: PublicClient,
): Promise<bigint> {
  const { data } = await db
    .from("chain_cursors")
    .select("last_block")
    .eq("chain_id", cid)
    .eq("stream", STREAM)
    .maybeSingle();

  if (data?.last_block) return BigInt(data.last_block as string | number);

  const code = await client.getCode({ address: factory });
  if (!code || code === "0x")
    throw new Error(`no factory deployed at ${factory} on chain ${cid}`);

  const head = await client.getBlockNumber();
  const genesis = await findDeploymentBlock(client, factory, head);
  return genesis > 0n ? genesis - 1n : 0n;
}

/**
 * Binary search for the first block where the factory has code.
 *
 * Somnia has no contract-creation index and no archive guarantee across public
 * RPCs, so this is ~log2(head) `getCode` calls once, then never again.
 */
async function findDeploymentBlock(
  client: PublicClient,
  address: Address,
  head: bigint,
): Promise<bigint> {
  let lo = 0n;
  let hi = head;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    let hasCode = false;
    try {
      const code = await client.getCode({ address, blockNumber: mid });
      hasCode = Boolean(code && code !== "0x");
    } catch {
      // Node pruned this height. Treat as "no code" so the search moves forward
      // and the cursor errs toward re-scanning rather than skipping blocks.
      hasCode = false;
    }
    if (hasCode) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/**
 * Move the cursor back so the next ingest re-processes blocks already seen.
 *
 * Safe by construction: the `chain_events` unique key makes a re-processed log a
 * no-op, and every projection write is an upsert on a natural key. This exists so
 * that property can be TESTED rather than asserted, and so an operator can force
 * a re-scan after fixing a projection bug.
 */
async function rewind(
  env: Env,
  blocks: bigint,
): Promise<{ from: string; to: string }> {
  const db = createServiceDb(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const cid = chainId(env);
  const { data } = await db
    .from("chain_cursors")
    .select("last_block")
    .eq("chain_id", cid)
    .eq("stream", STREAM)
    .maybeSingle();

  const current = BigInt(
    (data?.last_block as string | number | undefined) ?? 0,
  );
  const target = current > blocks ? current - blocks : 0n;
  await writeCursor(db, cid, target);
  return { from: current.toString(), to: target.toString() };
}

async function writeCursor(
  db: SupabaseClient,
  cid: number,
  block: bigint,
): Promise<void> {
  await db
    .from("chain_cursors")
    .upsert(
      {
        chain_id: cid,
        stream: STREAM,
        last_block: block.toString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "chain_id,stream" },
    );
}

// ---------------------------------------------------------------------------
// Raw event ledger
// ---------------------------------------------------------------------------

/**
 * A projection write that fails must not be counted as applied.
 *
 * supabase-js returns errors instead of throwing, so an unchecked `upsert` is a
 * silent no-op. That is exactly how a reservation insert naming a column the
 * table does not have went unnoticed while the domain sat pinned at its ceiling.
 * Throwing here surfaces it in the ingest run and leaves the cursor un-advanced
 * for that chunk, so the work is retried rather than lost.
 */
async function must<
  T extends { error: { message: string; code?: string } | null },
>(what: string, op: PromiseLike<T>): Promise<T> {
  const res = await op;
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res;
}

/** JSON cannot hold a bigint; every protocol quantity is stored as a string. */
const jsonSafe = (v: unknown): unknown =>
  typeof v === "bigint"
    ? v.toString()
    : Array.isArray(v)
      ? v.map(jsonSafe)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v as Row).map(([k, x]) => [k, jsonSafe(x)]),
          )
        : v;

/** Returns false when this exact log was already ingested. */
async function recordEvent(
  db: SupabaseClient,
  cid: number,
  log: Log,
  eventName: string,
  args: Row,
  blockTimestamp: number,
): Promise<boolean> {
  const { error } = await db.from("chain_events").insert({
    chain_id: cid,
    tx_hash: log.transactionHash,
    log_index: Number(log.logIndex ?? 0),
    block_number: Number(log.blockNumber ?? 0n),
    block_timestamp: blockTimestamp,
    contract_address: lower(log.address),
    event_name: eventName,
    portfolio_address: lower(log.address),
    payload: jsonSafe(args) as Row,
    processed_at: new Date().toISOString(),
  });

  // 23505 is the unique violation on (chain_id, tx_hash, log_index): the log is
  // already ingested and its projection already applied.
  if (error && error.code === "23505") return false;
  if (error) throw new Error(`chain_events insert failed: ${error.message}`);
  return true;
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

async function upsertPortfolio(
  db: SupabaseClient,
  client: PublicClient,
  cid: number,
  factory: Address,
  log: Log,
): Promise<{ address: string; id: string } | null> {
  const { args } = decodeEventLog({
    abi: airspacePortfolioFactoryAbi,
    data: log.data,
    topics: log.topics,
  }) as {
    args: {
      portfolio: Address;
      owner: Address;
      salt: `0x${string}`;
      version: string;
      index: bigint;
    };
  };

  const collateral = (await client.readContract({
    address: args.portfolio,
    abi: airspacePortfolioAbi,
    functionName: "collateralToken",
  })) as Address;

  const { data } = await db
    .from("portfolios")
    .upsert(
      {
        chain_id: cid,
        portfolio_address: lower(args.portfolio),
        owner_address: lower(args.owner),
        factory_address: lower(factory),
        implementation_version: args.version,
        collateral_address: lower(collateral),
        created_tx: log.transactionHash,
        created_block: Number(log.blockNumber ?? 0n),
      },
      { onConflict: "chain_id,portfolio_address" },
    )
    .select("id")
    .maybeSingle();

  return data?.id
    ? { address: lower(args.portfolio), id: data.id as string }
    : null;
}

async function project(
  db: SupabaseClient,
  client: PublicClient,
  cid: number,
  portfolioId: string,
  log: Log,
  event: string,
  a: Row,
  admitted: Map<
    string,
    { pool: Address; marketNonce: bigint; orderId: bigint }
  >,
): Promise<void> {
  const block = Number(log.blockNumber ?? 0n);
  const tx = log.transactionHash;

  switch (event) {
    case "AgentSet": {
      const p = a.policy as { strategyId: `0x${string}` };
      await must(
        "agents upsert",
        db.from("agents").upsert(
          {
            portfolio_id: portfolioId,
            agent_address: lower(a.agent as string),
            strategy_id: p.strategyId,
            enabled: Boolean(a.enabled),
            registered_tx: tx,
            registered_block: block,
          },
          { onConflict: "portfolio_id,agent_address" },
        ),
      );
      return;
    }

    case "AgentRevoked": {
      await must(
        "agents revoke",
        db
          .from("agents")
          .update({ enabled: false, revoked_tx: tx, revoked_block: block })
          .eq("portfolio_id", portfolioId)
          .eq("agent_address", lower(a.agent as string)),
      );
      return;
    }

    case "DomainPolicySet": {
      const p = a.policy as {
        configured: boolean;
        maxDomainRiskUsage: bigint;
        maxDomainCommitted: bigint;
        maxLiveMarkets: number;
      };
      await must(
        "domain_policies upsert",
        db.from("domain_policies").upsert(
          {
            portfolio_id: portfolioId,
            domain_hash: a.domain as string,
            configured: p.configured,
            max_domain_risk_usage: p.maxDomainRiskUsage.toString(),
            max_domain_committed: p.maxDomainCommitted.toString(),
            max_live_markets: Number(p.maxLiveMarkets),
            source_block: block,
            source_tx: tx,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "portfolio_id,domain_hash" },
        ),
      );
      return;
    }

    case "MarketTracked": {
      await upsertMarket(
        db,
        client,
        cid,
        a.marketId as MarketId,
        a.domain as string,
        block,
      );
      return;
    }

    case "IntentAdmitted": {
      await must(
        "intents upsert",
        db.from("intents").upsert(
          {
            portfolio_id: portfolioId,
            intent_hash: a.intentHash as string,
            agent_address: lower(a.agent as string),
            market_id: a.marketId as string,
            market_nonce: Number(a.marketNonce as bigint),
            pool_address: lower(a.pool as string),
            domain_hash: a.domain as string,
            kind: Number(a.kind as number),
            order_type: 3,
            price: (a.price as bigint).toString(),
            quantity: (a.quantity as bigint).toString(),
            agent_nonce: 0,
            status: "ADMITTED",
            order_id: (a.orderId as bigint).toString(),
            strategy_version: a.strategyVersion as string,
            tx_hash: tx,
            block_number: block,
            log_index: Number(log.logIndex ?? 0),
          },
          { onConflict: "portfolio_id,intent_hash" },
        ),
      );
      return;
    }

    case "IntentRefused": {
      await must(
        "intents upsert",
        db.from("intents").upsert(
          {
            portfolio_id: portfolioId,
            intent_hash: a.intentHash as string,
            agent_address: lower(a.agent as string),
            market_id: a.marketId as string,
            market_nonce: 0,
            pool_address: "0x0000000000000000000000000000000000000000",
            kind: 0,
            order_type: 3,
            price: "0",
            quantity: "0",
            agent_nonce: 0,
            status: "REFUSED",
            refusal_code: Number(a.code as number),
            tx_hash: tx,
            block_number: block,
            log_index: Number(log.logIndex ?? 0),
          },
          { onConflict: "portfolio_id,intent_hash" },
        ),
      );

      await must(
        "receipts upsert",
        db.from("receipts").upsert(
          {
            portfolio_id: portfolioId,
            intent_hash: a.intentHash as string,
            decision: "REFUSED",
            refusal_code: Number(a.code as number),
            agent_address: lower(a.agent as string),
            market_id: a.marketId as string,
            tx_hash: tx,
            block_number: block,
            provenance: { decision: "contract", refusal_code: "contract" },
          },
          { onConflict: "portfolio_id,intent_hash" },
        ),
      );
      return;
    }

    case "IntentReconciled": {
      // The admitted row is written by the IntentAdmitted log immediately before
      // this one in the same transaction, so its identifiers are already here.
      const { data: intent } = await db
        .from("intents")
        .select(
          "agent_address, market_id, domain_hash, pool_address, market_nonce, order_id, quantity, kind, price",
        )
        .eq("portfolio_id", portfolioId)
        .eq("intent_hash", a.intentHash as string)
        .maybeSingle();

      await must(
        "receipts upsert",
        db.from("receipts").upsert(
          {
            portfolio_id: portfolioId,
            intent_hash: a.intentHash as string,
            decision: "ADMITTED",
            agent_address:
              intent?.agent_address ??
              "0x0000000000000000000000000000000000000000",
            market_id: intent?.market_id ?? "0x",
            domain_hash: intent?.domain_hash ?? null,
            reserve_required: (a.reserveRequired as bigint).toString(),
            filled_qty: (a.filledQty as bigint).toString(),
            filled_cost: (a.filledCost as bigint).toString(),
            resting_qty: (a.restingQty as bigint).toString(),
            directional_before: (a.directionalBefore as bigint).toString(),
            directional_after: (a.directionalAfter as bigint).toString(),
            domain_usage_before: (a.domainUsageBefore as bigint).toString(),
            domain_usage_after: (a.domainUsageAfter as bigint).toString(),
            committed_after: (a.committedAfter as bigint).toString(),
            tx_hash: tx,
            block_number: block,
            // Every field above came out of one contract event. None was observed.
            provenance: {
              decision: "contract",
              filled_qty: "contract",
              resting_qty: "contract",
              domain_usage_after: "contract",
              committed_after: "contract",
            },
          },
          { onConflict: "portfolio_id,intent_hash" },
        ),
      );

      if (!intent) return;

      // Exact values from the log, never from a round trip through `numeric`.
      const placed = admitted.get(a.intentHash as string);
      if (!placed) return;

      const resting = a.restingQty as bigint;
      const { pool, marketNonce: nonce, orderId } = placed;

      if (resting > 0n && orderId > 0n) {
        await must(
          "reservations upsert",
          db.from("reservations").upsert(
            {
              portfolio_id: portfolioId,
              order_key: orderKey(pool, nonce, orderId),
              intent_hash: a.intentHash as string,
              agent_address: intent.agent_address as string,
              market_id: intent.market_id as string,
              pool_address: pool,
              market_nonce: Number(nonce),
              domain_hash: (intent.domain_hash as string) ?? null,
              kind: Number(intent.kind as number),
              qty_open: resting.toString(),
              collateral_reserved: (a.reserveRequired as bigint).toString(),
              state: "RESTING",
              source_block: block,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "portfolio_id,order_key" },
          ),
        );
      }

      await syncPosition(
        db,
        client,
        portfolioId,
        log.address as Address,
        intent.market_id as MarketId,
        block,
      );
      return;
    }

    case "ReservationReleased": {
      await db
        .from("reservations")
        .update({
          qty_open: "0",
          collateral_reserved: "0",
          state: "FINALIZED",
          source_block: block,
          updated_at: new Date().toISOString(),
        })
        .eq("portfolio_id", portfolioId)
        .eq("order_key", a.orderKey as string);

      await syncPosition(
        db,
        client,
        portfolioId,
        log.address as Address,
        a.marketId as MarketId,
        block,
      );
      return;
    }

    case "SettledExposureReleased": {
      await db
        .from("positions")
        .update({
          settled: true,
          directional_exposure: "0",
          source_block: block,
          updated_at: new Date().toISOString(),
        })
        .eq("portfolio_id", portfolioId)
        .eq("market_id", a.marketId as string);
      return;
    }

    case "Redeemed": {
      await db
        .from("positions")
        .update({
          redeemed: true,
          source_block: block,
          updated_at: new Date().toISOString(),
        })
        .eq("portfolio_id", portfolioId)
        .eq("market_id", a.marketId as string);
      return;
    }

    case "MarketPruned": {
      await db
        .from("positions")
        .delete()
        .eq("portfolio_id", portfolioId)
        .eq("market_id", a.marketId as string);
      return;
    }

    default:
      // Funded, CapitalBaseSet, GlobalPolicySet, Withdrawn, OutcomeWithdrawn,
      // Initialized: recorded in chain_events, read live from the contract by
      // the API. Duplicating them into a projection would add a way to be wrong
      // without adding a way to be useful.
      return;
  }
}

/**
 * Re-read a market's exposure from the contract.
 *
 * Deliberately a read, not an accumulation. `getOrder` reverts identically for a
 * filled and a cancelled order, so a running counter cannot be trusted; the
 * portfolio measures exposure from ERC-6909 balances and this mirrors that
 * measurement rather than re-deriving it from event arithmetic.
 */
async function syncPosition(
  db: SupabaseClient,
  client: PublicClient,
  portfolioId: string,
  portfolio: Address,
  marketId: MarketId,
  block: number,
): Promise<void> {
  const [state, directional] = await Promise.all([
    client.readContract({
      address: portfolio,
      abi: airspacePortfolioAbi,
      functionName: "marketState",
      args: [marketId],
    }) as Promise<
      readonly [
        Address,
        bigint,
        `0x${string}`,
        bigint,
        bigint,
        bigint,
        bigint,
        boolean,
        boolean,
      ]
    >,
    client.readContract({
      address: portfolio,
      abi: airspacePortfolioAbi,
      functionName: "marketDirectionalExposure",
      args: [marketId],
    }) as Promise<bigint>,
  ]);

  const [, , domain, yesLong, yesShort, noLong, noShort, tracked, settled] =
    state;
  if (!tracked) return;

  await must(
    "positions upsert",
    db.from("positions").upsert(
      {
        portfolio_id: portfolioId,
        market_id: marketId,
        domain_hash: domain,
        yes_balance: (yesLong - yesShort).toString(),
        no_balance: (noLong - noShort).toString(),
        directional_exposure: directional.toString(),
        settled,
        source_block: block,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "portfolio_id,market_id" },
    ),
  );
}

/** Market metadata, read from the DreamDEX registry rather than assumed. */
async function upsertMarket(
  db: SupabaseClient,
  client: PublicClient,
  cid: number,
  marketId: MarketId,
  domain: string,
  block: number,
): Promise<void> {
  const m = await readMarket(client, marketId);
  if (!m) return;

  await must(
    "markets upsert",
    db.from("markets").upsert(
      {
        chain_id: cid,
        market_id: marketId,
        pool_address: lower(m.pool),
        market_address: lower(m.marketAddress),
        market_nonce: Number(m.marketNonce),
        creator_address: lower(m.creator),
        collateral_address: lower(m.collateral),
        trading_start: Number(m.tradingStart),
        expiry: Number(m.expiry),
        canonical_cadence_sec: m.cadenceSec,
        domain_hash: domain,
        yes_token_id: m.yesId.toString(),
        no_token_id: m.noId.toString(),
        source_block: block,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "chain_id,market_id" },
    ),
  );
}
