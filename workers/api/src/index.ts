import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { Address, DomainId, MarketId } from "@airspace/types";
import { Refusal, REFUSAL_COPY, REFUSAL_NAME } from "@airspace/types";
import { explainAdmission } from "@airspace/risk";
import { airspacePortfolioAbi, airspacePortfolioFactoryAbi } from "@airspace/sdk";
import {
  canonicalCadence,
  discoverMarkets,
  domainKey,
  intentHash,
  readLiveState,
  readMarket,
  type IntentStruct,
} from "@airspace/protocol";
import { BaseError, ContractFunctionRevertedError, decodeFunctionData, toFunctionSelector } from "viem";
import { createServiceDb, createPublicDb, toBigInt } from "@airspace/db";
import type { Env } from "./env.js";
import { chainId, factoryAddress } from "./env.js";
import { publicClient } from "./rpc.js";

export { PortfolioCoordinator } from "./coordinator.js";

/**
 * AIRSPACE read/API worker.
 *
 * Everything here is READ-ONLY with respect to authority. No endpoint can move
 * portfolio capital, change a policy or register an agent: those require a
 * wallet signature and an on-chain transaction (PRD 27). There is no backend
 * admin key that can act as a portfolio owner.
 */

type Ctx = { Bindings: Env };
const app = new Hono<Ctx>();

app.use("/api/*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"] }));

// --- tiny in-worker rate limit (per colo, best effort) ----------------------
const hits = new Map<string, { n: number; reset: number }>();
app.use("/api/*", async (c, next) => {
  const ip = c.req.header("cf-connecting-ip") ?? "anon";
  const now = Date.now();
  const e = hits.get(ip);
  if (!e || now > e.reset) hits.set(ip, { n: 1, reset: now + 60_000 });
  else if (++e.n > 300) return c.json({ error: "RATE_LIMITED", retryAfterSec: 60 }, 429);
  await next();
});

const bad = (c: Context<Ctx>, msg: string, code: 400 | 404 | 426 = 400) => c.json({ error: msg }, code);

const isAddress = (s: string | undefined): s is Address => !!s && /^0x[0-9a-fA-F]{40}$/.test(s);
const isBytes32 = (s: string | undefined): s is `0x${string}` => !!s && /^0x[0-9a-fA-F]{64}$/.test(s);

/** JSON cannot carry bigint; serialise as decimal strings, never as numbers. */
const S = (v: unknown): unknown =>
  typeof v === "bigint"
    ? v.toString()
    : Array.isArray(v)
      ? v.map(S)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, S(x)]))
        : v;

// ---------------------------------------------------------------------------
// Health and configuration
// ---------------------------------------------------------------------------

app.get("/api/health", async (c) => {
  const out: Record<string, unknown> = {
    ok: true,
    chainId: chainId(c.env),
    factory: c.env.AIRSPACE_FACTORY || null,
    version: "1.0.0",
  };
  try {
    const client = publicClient(c.env);
    out.blockNumber = (await client.getBlockNumber()).toString();
    out.rpc = "ok";
  } catch {
    out.rpc = "unavailable";
    out.ok = false;
  }
  return c.json(out);
});

app.get("/api/config", (c) =>
  c.json({
    chainId: chainId(c.env),
    factory: c.env.AIRSPACE_FACTORY || null,
    supabaseUrl: c.env.SUPABASE_URL,
    supabaseAnonKey: c.env.SUPABASE_ANON_KEY,
    explorer: chainId(c.env) === 5031 ? "https://explorer.somnia.network" : "https://shannon-explorer.somnia.network",
  }),
);

// ---------------------------------------------------------------------------
// Portfolios
// ---------------------------------------------------------------------------

app.get("/api/owners/:owner/portfolios", async (c) => {
  const owner = c.req.param("owner");
  if (!isAddress(owner)) return bad(c, "invalid owner address");
  const client = publicClient(c.env);
  const list = (await client.readContract({
    address: factoryAddress(c.env),
    abi: airspacePortfolioFactoryAbi,
    functionName: "portfoliosOf",
    args: [owner],
  })) as Address[];

  // Display names are the only non-chain field, and are labelled as such.
  const db = createPublicDb(c.env.SUPABASE_URL, c.env.SUPABASE_ANON_KEY);
  const { data } = await db
    .from("portfolios")
    .select("portfolio_address,display_name")
    .in("portfolio_address", list.map((a) => a.toLowerCase()));

  const names = new Map((data ?? []).map((r) => [r.portfolio_address, r.display_name]));
  return c.json({
    portfolios: list.map((address) => ({
      address,
      displayName: names.get(address.toLowerCase()) ?? null,
      displayNameProvenance: "OFFCHAIN_WITNESS",
    })),
  });
});

/** Live portfolio state, via the per-portfolio Durable Object. */
app.get("/api/portfolios/:address", async (c) => {
  const address = c.req.param("address");
  if (!isAddress(address)) return bad(c, "invalid portfolio address");
  const domains = c.req.query("domains") ?? "";

  const id = c.env.PORTFOLIO.idFromName(`${chainId(c.env)}:${address.toLowerCase()}`);
  const stub = c.env.PORTFOLIO.get(id);
  const res = await stub.fetch(
    `https://do/snapshot?portfolio=${address}&domains=${encodeURIComponent(domains)}&force=${c.req.query("force") ?? "0"}`,
  );
  if (!res.ok) return c.json({ error: "PORTFOLIO_UNAVAILABLE" }, 503);
  return new Response(res.body, { headers: { "content-type": "application/json" } });
});

/** Live WebSocket stream of portfolio state. */
app.get("/api/portfolios/:address/stream", async (c) => {
  const address = c.req.param("address");
  if (!isAddress(address)) return bad(c, "invalid portfolio address");
  if (c.req.header("Upgrade") !== "websocket") return bad(c, "expected a websocket upgrade", 426);

  const id = c.env.PORTFOLIO.idFromName(`${chainId(c.env)}:${address.toLowerCase()}`);
  const stub = c.env.PORTFOLIO.get(id);
  return stub.fetch(
    `https://do/stream?portfolio=${address}&domains=${encodeURIComponent(c.req.query("domains") ?? "")}`,
    { headers: c.req.raw.headers },
  );
});

app.get("/api/portfolios/:address/agents", async (c) => {
  const address = c.req.param("address");
  if (!isAddress(address)) return bad(c, "invalid portfolio address");
  const db = createPublicDb(c.env.SUPABASE_URL, c.env.SUPABASE_ANON_KEY);

  const { data: portfolio } = await db
    .from("portfolios")
    .select("id")
    .eq("portfolio_address", address.toLowerCase())
    .maybeSingle();
  if (!portfolio) return c.json({ agents: [], note: "portfolio not yet indexed" });

  const { data: agents } = await db
    .from("agents")
    .select("*")
    .eq("portfolio_id", portfolio.id)
    .order("created_at", { ascending: true });

  // Chain state is authoritative for enabled/committed; the row is a projection.
  const client = publicClient(c.env);
  const enriched = await Promise.all(
    (agents ?? []).map(async (a) => {
      const [policy, committed, nonce] = await Promise.all([
        client.readContract({
          address: address as Address,
          abi: airspacePortfolioAbi,
          functionName: "agentPolicy",
          args: [a.agent_address as Address],
        }) as Promise<readonly [boolean, bigint, bigint, bigint, bigint, bigint, string]>,
        client.readContract({
          address: address as Address,
          abi: airspacePortfolioAbi,
          functionName: "agentCommitted",
          args: [a.agent_address as Address],
        }) as Promise<bigint>,
        client.readContract({
          address: address as Address,
          abi: airspacePortfolioAbi,
          functionName: "agentNonce",
          args: [a.agent_address as Address],
        }) as Promise<bigint>,
      ]);
      return S({
        address: a.agent_address,
        displayName: a.display_name,
        strategyId: a.strategy_id,
        strategyVersion: a.strategy_version,
        enabled: policy[0],
        policy: {
          maxCommitted: policy[1],
          maxOrderNotional: policy[2],
          maxBuyPrice: policy[3],
          minSellPrice: policy[4],
          cooldownSec: policy[5],
        },
        committed,
        nonce,
        registeredTx: a.registered_tx,
      });
    }),
  );
  return c.json({ agents: enriched });
});

// ---------------------------------------------------------------------------
// Markets and domains
// ---------------------------------------------------------------------------

/**
 * Live markets, enumerated straight from the DreamDEX module registry.
 * Deliberately independent of the indexer, which has served `Trading` for
 * markets that expired weeks earlier.
 */
app.get("/api/markets", async (c) => {
  const client = publicClient(c.env);
  const minRemaining = Number(c.req.query("minRemaining") ?? 120);
  const lookback = Math.min(Number(c.req.query("lookback") ?? 60), 200);

  const markets = await discoverMarkets(client, { lookback, minSecondsRemaining: minRemaining });
  const withState = await Promise.all(
    markets.slice(0, 40).map(async (m) => {
      const live = await readLiveState(client, m);
      return S({
        ...m,
        cadenceLabel: cadenceLabel(m.cadenceSec),
        live: {
          trading: live.trading,
          secondsRemaining: live.secondsRemaining,
          tickSize: live.tickSize,
          lotSize: live.lotSize,
          minQuantity: live.minQuantity,
          marketExpiryNs: live.marketExpiryNs,
        },
      });
    }),
  );
  return c.json({ markets: withState, source: "onchain-registry" });
});

app.get("/api/markets/:marketId", async (c) => {
  const marketId = c.req.param("marketId");
  if (!isBytes32(marketId)) return bad(c, "invalid marketId");
  const client = publicClient(c.env);
  const m = await readMarket(client, marketId as MarketId);
  if (!m) return c.json({ error: "MARKET_NOT_FOUND" }, 404);
  const live = await readLiveState(client, m);
  return c.json(S({ market: { ...m, cadenceLabel: cadenceLabel(m.cadenceSec) }, live }));
});

/** Derive a structural domain without any attestation. */
app.get("/api/domains/derive", async (c) => {
  const creator = c.req.query("creator");
  const collateral = c.req.query("collateral");
  const cadence = Number(c.req.query("cadence") ?? 0);
  if (!isAddress(creator) || !isAddress(collateral) || !cadence) {
    return bad(c, "creator, collateral and cadence are required");
  }
  return c.json({
    domain: domainKey(creator, collateral, cadence),
    creator,
    collateral,
    cadenceSec: cadence,
    cadenceLabel: cadenceLabel(cadence),
    note: "A cadence domain, not an asset. Sibling series of one cadence share it by design.",
  });
});

// ---------------------------------------------------------------------------
// Admission simulation — the product's central moment
// ---------------------------------------------------------------------------

/**
 * Ask the portfolio contract what it would decide.
 *
 * ADVISORY. The contract re-evaluates at execution time, and state can change in
 * between. The decision returned here is the contract's own: this endpoint calls
 * `previewIntent` rather than re-implementing any check.
 */
app.post("/api/intents/simulate", async (c) => {
  const body = await c.req.json<{
    portfolio: string;
    agent: string;
    marketId: string;
    kind: number;
    price: string;
    quantity: string;
    orderType?: number;
    nonce?: string;
  }>();

  if (!isAddress(body.portfolio) || !isAddress(body.agent)) return bad(c, "invalid portfolio or agent address");
  if (!isBytes32(body.marketId)) return bad(c, "invalid marketId");

  const client = publicClient(c.env);
  const m = await readMarket(client, body.marketId as MarketId);
  if (!m) return c.json({ error: "MARKET_NOT_FOUND" }, 404);
  const live = await readLiveState(client, m);

  const nonce = body.nonce
    ? BigInt(body.nonce)
    : ((await client.readContract({
        address: body.portfolio,
        abi: airspacePortfolioAbi,
        functionName: "agentNonce",
        args: [body.agent],
      })) as bigint) + 1n;

  const intent = {
    marketId: m.marketId,
    pool: m.pool,
    marketNonce: m.marketNonce,
    kind: body.kind,
    price: BigInt(body.price),
    quantity: BigInt(body.quantity),
    expireTimestampNs: live.marketExpiryNs,
    orderType: body.orderType ?? 3,
    nonce,
    strategyVersion: `0x${"00".repeat(32)}` as `0x${string}`,
  };

  const view = (await client.readContract({
    address: body.portfolio,
    abi: airspacePortfolioAbi,
    functionName: "previewIntent",
    args: [body.agent, intent],
  })) as never;

  const v = view as {
    refusal: number;
    gates: number;
    domain: DomainId;
    cadenceSec: number;
    domainUsageBefore: bigint;
    domainUsageAfter: bigint;
    domainCeiling: bigint;
    reserveRequired: bigint;
    [k: string]: unknown;
  };

  const explained = explainAdmission(v as never);
  return c.json(
    S({
      intent,
      decision: {
        admitted: explained.admitted,
        refusal: v.refusal,
        refusalName: REFUSAL_NAME[v.refusal] ?? null,
        copy: explained.copy,
        blockingGate: explained.blockingGate,
      },
      gates: explained.gates,
      arithmetic: explained.arithmetic,
      raw: v,
      advisory: "The portfolio contract re-evaluates at execution time; this is a preview, not a guarantee.",
    }),
  );
});

// ---------------------------------------------------------------------------
// Refusal recovery
// ---------------------------------------------------------------------------

/**
 * Recover a refusal from a failed transaction.
 *
 * A refusal REVERTS, and a reverted transaction's logs are discarded, so the
 * contract's `IntentRefused` event can never be observed. (That event is
 * unreachable in the deployed bytecode; see DECISIONS.md. It is emitted on the
 * line before `revert Refused(code)`.) The refusal is still fully on chain: it
 * is in the failed transaction itself.
 *
 * So this endpoint takes only a transaction hash and derives everything else:
 *
 *   1. the receipt must be `reverted` and addressed to this portfolio;
 *   2. the calldata must decode as `execute(Intent)`;
 *   3. replaying that exact call at the transaction's own block must return
 *      `Refused(code)`.
 *
 * Nothing the caller says is trusted beyond which transaction to look at, so
 * the resulting row carries `contract` provenance honestly. Somnia's public RPC
 * serves this replay; it is verified in the live proof.
 */
app.post("/api/intents/report", async (c) => {
  const body = await c.req.json<{ portfolio: string; txHash: string }>();
  if (!isAddress(body.portfolio)) return bad(c, "invalid portfolio address");
  if (!isBytes32(body.txHash)) return bad(c, "invalid txHash");

  const client = publicClient(c.env);
  const cid = chainId(c.env);
  const portfolio = body.portfolio.toLowerCase() as Address;

  const receipt = await client.getTransactionReceipt({ hash: body.txHash }).catch(() => null);
  if (!receipt) return c.json({ error: "TX_NOT_FOUND" }, 404);
  if (receipt.to?.toLowerCase() !== portfolio) return bad(c, "transaction was not sent to this portfolio");
  if (receipt.status !== "reverted") return bad(c, "transaction did not revert: an admitted intent is indexed from its logs");

  const txn = await client.getTransaction({ hash: body.txHash });

  let intent: IntentStruct;
  try {
    const { functionName, args } = decodeFunctionData({ abi: airspacePortfolioAbi, data: txn.input });
    if (functionName !== "execute") return bad(c, "transaction did not call execute");
    intent = (args as readonly [IntentStruct])[0];
  } catch {
    return bad(c, "calldata did not decode as execute(Intent)");
  }

  // Replay the exact call at the block it failed in. The revert data is the
  // contract's own answer, not a reconstruction of it.
  let refusal: number | null = null;
  try {
    await client.call({
      account: txn.from,
      to: portfolio,
      data: txn.input,
      blockNumber: receipt.blockNumber,
    });
  } catch (err) {
    refusal = decodeRefusal(err);
  }
  if (refusal === null) return bad(c, "transaction did not revert with Refused(code)");

  const hash = intentHash(portfolio, cid, txn.from.toLowerCase() as Address, intent);
  const db = createServiceDb(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY);
  const portfolioId = await ensurePortfolioRow(c.env, db, client, portfolio);
  if (!portfolioId) return c.json({ error: "NOT_AN_AIRSPACE_PORTFOLIO" }, 404);

  const domain = (await client
    .readContract({ address: portfolio, abi: airspacePortfolioAbi, functionName: "domainOf", args: [intent.marketId] })
    .catch(() => null)) as DomainId | null;

  const common = {
    portfolio_id: portfolioId,
    intent_hash: hash,
    agent_address: txn.from.toLowerCase(),
    market_id: intent.marketId,
    tx_hash: body.txHash,
    block_number: Number(receipt.blockNumber),
  };

  await db.from("intents").upsert(
    {
      ...common,
      market_nonce: Number(intent.marketNonce),
      pool_address: intent.pool.toLowerCase(),
      domain_hash: domain,
      kind: Number(intent.kind),
      order_type: Number(intent.orderType),
      price: intent.price.toString(),
      quantity: intent.quantity.toString(),
      agent_nonce: Number(intent.nonce),
      status: "REFUSED",
      refusal_code: refusal,
      strategy_version: intent.strategyVersion,
      log_index: 0,
    },
    { onConflict: "portfolio_id,intent_hash" },
  );

  await db.from("receipts").upsert(
    {
      ...common,
      decision: "REFUSED",
      refusal_code: refusal,
      domain_hash: domain,
      // Every field was decoded from the transaction or returned by replaying
      // it. None was witnessed by a worker and none was supplied by a client.
      provenance: {
        decision: "contract",
        refusal_code: "contract",
        market_id: "contract",
        agent_address: "contract",
      },
    },
    { onConflict: "portfolio_id,intent_hash" },
  );

  return c.json({
    recorded: true,
    intentHash: hash,
    refusal,
    refusalName: REFUSAL_NAME[refusal] ?? null,
    copy: REFUSAL_COPY[refusal] ?? null,
  });
});

/**
 * The portfolio's row, creating it from chain state if the indexer has not
 * reached it yet.
 *
 * A refusal exists only as a failed transaction, so it is not replayable from
 * logs: if this endpoint rejected the report because the indexer was a minute
 * behind, that refusal would be lost for good. Admission is decided by the
 * factory, not by the caller — `isPortfolio` is the same check the rest of the
 * system uses, and owner and collateral are read from the portfolio itself.
 */
async function ensurePortfolioRow(
  env: Env,
  db: ReturnType<typeof createServiceDb>,
  client: ReturnType<typeof publicClient>,
  portfolio: Address,
): Promise<string | null> {
  const cid = chainId(env);
  const { data: existing } = await db
    .from("portfolios")
    .select("id")
    .eq("chain_id", cid)
    .eq("portfolio_address", portfolio)
    .maybeSingle();
  if (existing) return existing.id as string;

  const factory = factoryAddress(env);
  const isPortfolio = (await client.readContract({
    address: factory,
    abi: airspacePortfolioFactoryAbi,
    functionName: "isPortfolio",
    args: [portfolio],
  })) as boolean;
  if (!isPortfolio) return null;

  const [owner, collateral, version] = await Promise.all([
    client.readContract({ address: portfolio, abi: airspacePortfolioAbi, functionName: "owner" }) as Promise<Address>,
    client.readContract({
      address: portfolio,
      abi: airspacePortfolioAbi,
      functionName: "collateralToken",
    }) as Promise<Address>,
    client.readContract({ address: portfolio, abi: airspacePortfolioAbi, functionName: "VERSION" }) as Promise<string>,
  ]);

  const { data } = await db
    .from("portfolios")
    .upsert(
      {
        chain_id: cid,
        portfolio_address: portfolio,
        owner_address: owner.toLowerCase(),
        factory_address: factory,
        implementation_version: version,
        collateral_address: collateral.toLowerCase(),
      },
      { onConflict: "chain_id,portfolio_address" },
    )
    .select("id")
    .maybeSingle();

  return (data?.id as string) ?? null;
}

const REFUSED_SELECTOR = toFunctionSelector("Refused(uint8)");

/**
 * Pull `Refused(uint8)` out of a viem call error, or null if it is not one.
 *
 * `client.call` is given no ABI, so viem cannot name the error for us. The raw
 * revert data is carried on some link of the error's cause chain; the selector
 * is what identifies it, and the single uint8 argument is the code.
 */
function decodeRefusal(err: unknown): number | null {
  if (err instanceof BaseError) {
    const named = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (named?.data?.errorName === "Refused") return Number(named.data.args?.[0] ?? 0) || null;
  }

  for (let e: unknown = err, depth = 0; e && depth < 8; depth += 1) {
    const raw = (e as { data?: unknown }).data;
    if (typeof raw === "string" && raw.startsWith(REFUSED_SELECTOR) && raw.length === 74) {
      return Number(BigInt(`0x${raw.slice(10)}`)) || null;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Receipts, intents, reservations, positions — paginated projections
// ---------------------------------------------------------------------------

const page = (c: Context<Ctx>) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 25), 1), 100);
  const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);
  return { limit, offset };
};

async function portfolioRow(env: Env, address: string) {
  const db = createPublicDb(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
  const { data } = await db
    .from("portfolios")
    .select("id")
    .eq("portfolio_address", address.toLowerCase())
    .maybeSingle();
  return { db, id: data?.id as string | undefined };
}

/**
 * Every `numeric(78, 0)` column, per table.
 *
 * PostgREST serialises `numeric` as a JSON NUMBER, so a value above 2^53 arrives
 * at the client already wrong: an order id of 239807672958224550581 comes back
 * as 239807672958224560000. Selecting these `::text` keeps them exact all the
 * way to the browser, where they become BigInt.
 */
const NUMERIC_COLUMNS: Record<string, readonly string[]> = {
  intents: ["price", "quantity", "order_id"],
  receipts: [
    "reserve_required",
    "filled_qty",
    "filled_cost",
    "resting_qty",
    "directional_before",
    "directional_after",
    "domain_usage_before",
    "domain_usage_after",
    "committed_after",
  ],
  reservations: ["qty_open", "collateral_reserved"],
  positions: ["yes_balance", "no_balance", "directional_exposure"],
};

/** `*` plus a text cast for each numeric column, which overrides the `*` copy. */
const selectFor = (table: string): string =>
  ["*", ...(NUMERIC_COLUMNS[table] ?? []).map((col) => `${col}::text`)].join(",");

for (const [route, table, order] of [
  ["intents", "intents", "block_number"],
  ["receipts", "receipts", "block_number"],
  ["reservations", "reservations", "source_block"],
  ["positions", "positions", "source_block"],
] as const) {
  app.get(`/api/portfolios/:address/${route}`, async (c) => {
    const address = c.req.param("address");
    if (!isAddress(address)) return bad(c, "invalid portfolio address");
    const { db, id } = await portfolioRow(c.env, address);
    if (!id) return c.json({ [route]: [], total: 0, note: "portfolio not yet indexed" });

    const { limit, offset } = page(c);
    let q = db.from(table).select(selectFor(table), { count: "exact" }).eq("portfolio_id", id);
    const agent = c.req.query("agent");
    if (agent && isAddress(agent)) q = q.eq("agent_address", agent.toLowerCase());
    const status = c.req.query("status");
    if (status && table === "intents") q = q.eq("status", status);

    const { data, count } = await q.order(order, { ascending: false }).range(offset, offset + limit - 1);
    return c.json({ [route]: data ?? [], total: count ?? 0, limit, offset });
  });
}

app.get("/api/receipts/:intentHash", async (c) => {
  const h = c.req.param("intentHash");
  if (!isBytes32(h)) return bad(c, "invalid intent hash");
  const db = createPublicDb(c.env.SUPABASE_URL, c.env.SUPABASE_ANON_KEY);
  const { data } = await db.from("receipts").select(selectFor("receipts")).eq("intent_hash", h).maybeSingle();
  if (!data) return c.json({ error: "RECEIPT_NOT_FOUND" }, 404);

  // The `::text` casts put the row outside supabase-js's generated row type, so
  // it comes back untyped. The shape is the `receipts` table, minus the numeric
  // columns which are now strings.
  const receipt = data as unknown as Record<string, unknown>;
  const refusal = receipt.refusal_code as number | null;
  return c.json({
    receipt,
    copy: refusal ? (REFUSAL_COPY[refusal] ?? null) : null,
    refusalName: refusal ? (REFUSAL_NAME[refusal] ?? null) : null,
  });
});

// ---------------------------------------------------------------------------
// Reconciliation request — enqueue work, never mutate authority
// ---------------------------------------------------------------------------

app.post("/api/reconcile/request", async (c) => {
  const body = await c.req.json<{ portfolio: string; marketId?: string; orderKey?: string; reason?: string }>();
  if (!isAddress(body.portfolio)) return bad(c, "invalid portfolio address");

  const db = createServiceDb(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: pf } = await db
    .from("portfolios")
    .select("id")
    .eq("portfolio_address", body.portfolio.toLowerCase())
    .maybeSingle();

  // The dedupe index collapses identical pending work, so a client cannot flood
  // the queue by retrying.
  const { error } = await db.from("reconciliation_jobs").insert({
    portfolio_id: pf?.id ?? null,
    chain_id: chainId(c.env),
    kind: body.orderKey ? "release-order" : body.marketId ? "release-settled" : "sync-portfolio",
    market_id: body.marketId ?? null,
    order_key: body.orderKey ?? null,
    reason: body.reason ?? "client-request",
  });

  // A duplicate-key error means the work is already queued: that is success.
  const duplicated = error?.code === "23505";
  return c.json({ queued: !error || duplicated, deduplicated: duplicated });
});

// ---------------------------------------------------------------------------
// Static assets (the web app) — anything not under /api
// ---------------------------------------------------------------------------

app.all("*", async (c) => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.json({ error: "not found" }, 404);
});

function cadenceLabel(sec: number): string {
  const map: Record<number, string> = {
    60: "1m",
    300: "5m",
    900: "15m",
    1800: "30m",
    3600: "1h",
    14400: "4h",
    86400: "24h",
  };
  return map[sec] ?? (sec > 0 ? `${sec}s` : "unclassified");
}

export default app;
