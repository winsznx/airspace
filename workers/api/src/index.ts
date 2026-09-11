import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { Address, DomainId, MarketId } from "@airspace/types";
import { Refusal, REFUSAL_COPY, REFUSAL_NAME } from "@airspace/types";
import { explainAdmission } from "@airspace/risk";
import {
  airspacePortfolioAbi,
  airspacePortfolioFactoryAbi,
  assertCurrentImplementation,
  SupersededDeploymentError,
} from "@airspace/sdk";
import {
  canonicalCadence,
  discoverMarkets,
  domainKey,
  intentHash,
  readBook,
  readLiveState,
  readMarket,
  type IntentStruct,
} from "@airspace/protocol";
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeFunctionData,
  recoverMessageAddress,
  toFunctionSelector,
} from "viem";
import type { Env } from "./env.js";
import { chainId, factoryAddress } from "./env.js";
import { publicClient, verifiedFactory } from "./rpc.js";

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

/** The portfolio's own Durable Object: its event store, and every view derived from it. */
const portfolioStub = (env: Env, address: string) =>
  env.PORTFOLIO.get(env.PORTFOLIO.idFromName(`${chainId(env)}:${address.toLowerCase()}`));

async function portfolioView<T>(env: Env, address: string, kind: string, params: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const q = new URLSearchParams({ portfolio: address, kind, ...params });
  const res = await portfolioStub(env, address).fetch(`https://do/view?${q.toString()}`);
  return { status: res.status, body: (await res.json()) as T };
}

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
  };
  try {
    const client = publicClient(c.env);
    out.blockNumber = (await client.getBlockNumber()).toString();
    out.rpc = "ok";
  } catch {
    out.rpc = "unavailable";
    out.ok = false;
  }
  try {
    out.implementation = await assertCurrentImplementation(publicClient(c.env), factoryAddress(c.env), chainId(c.env));
  } catch (e) {
    out.ok = false;
    out.implementation = e instanceof SupersededDeploymentError ? e.implementation : null;
    out.error = e instanceof SupersededDeploymentError ? e.message : "implementation check failed";
  }
  return c.json(out);
});

const ERC20_METADATA_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

const FACTORY_COLLATERAL_ABI = [
  { type: "function", name: "collateral", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

const PORTFOLIO_COLLATERAL_ABI = [
  { type: "function", name: "collateralToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/** A live-traded production portfolio, used only to confirm the invariant below against a real instance. */
const REFERENCE_PORTFOLIO: Address = "0x637b05C8aa242325bCD2Bb91752810cCE7afEf1C";
/**
 * A real, permanent transaction against `REFERENCE_PORTFOLIO` — a permissionless
 * `releaseOrder` call from the 2026-09-02 reconciliation pass (see
 * `evidence/production/REMEDIATION.md`). Used only as a fallback when nothing
 * more recent turns up in the bounded live scan below; its RECEIPT is still
 * fetched fresh from the chain on every request, never cached or hardcoded.
 */
const FALLBACK_REFERENCE_TX = "0xaa7152207ad614cf6f4de95b4776d73ddf678c9ae6c03a2dd925b2818f06623d" as const;
const EXPECTED_COLLATERAL: Address = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E";
const EXPECTED_CHAIN_ID = 50312;
const EXPECTED_DECIMALS = 6;

/**
 * Deployment-asset verification — every claim below is checked live, on
 * request, against the chain. Nothing here is a hardcoded label asserted as
 * fact; a hardcoded EXPECTED_* constant is only ever the thing being checked
 * against a live read, and the response says exactly which.
 *
 * DreamDEX's Shannon collateral is its own official test asset for this
 * venue — not a scarce faucet token AIRSPACE depends on — verified here by
 * reading the venue's own factory-pinned address, never assumed from a name.
 */
app.get("/api/deployment/verify", async (c) => {
  const client = publicClient(c.env);
  const factory = factoryAddress(c.env);
  const portfolio = (c.req.query("portfolio") as Address | undefined) ?? REFERENCE_PORTFOLIO;
  const checks: Array<{ key: string; label: string; expected: string; actual: string | null; pass: boolean; error?: string }> = [];

  const push = (key: string, label: string, expected: string, actual: string | null, error?: string) =>
    checks.push({ key, label, expected, actual, pass: actual !== null && actual.toLowerCase() === expected.toLowerCase(), ...(error ? { error } : {}) });

  // 1. Chain id, read live rather than trusted from config.
  let liveChainId: number | null = null;
  try {
    liveChainId = await client.getChainId();
  } catch (e) {
    push("chainId", "Chain ID", String(EXPECTED_CHAIN_ID), null, String(e));
  }
  if (liveChainId !== null) push("chainId", "Chain ID", String(EXPECTED_CHAIN_ID), String(liveChainId));

  // 2. DreamDEX's own collateral, read off the FACTORY's immutable pin — this
  //    is the address every portfolio this factory ever creates is initialised
  //    with, so checking it here checks it for all of them, not just one.
  let liveCollateral: Address | null = null;
  try {
    liveCollateral = (await client.readContract({ address: factory, abi: FACTORY_COLLATERAL_ABI, functionName: "collateral" })) as Address;
    push("factoryCollateral", "Factory-pinned collateral (all portfolios)", EXPECTED_COLLATERAL, liveCollateral);
  } catch (e) {
    push("factoryCollateral", "Factory-pinned collateral (all portfolios)", EXPECTED_COLLATERAL, null, String(e));
  }

  // 3. That same address's own decimals() and symbol(), read from the token
  //    itself rather than assumed from documentation.
  let decimals: number | null = null;
  let symbol: string | null = null;
  try {
    [decimals, symbol] = await Promise.all([
      client.readContract({ address: EXPECTED_COLLATERAL, abi: ERC20_METADATA_ABI, functionName: "decimals" }) as Promise<number>,
      client.readContract({ address: EXPECTED_COLLATERAL, abi: ERC20_METADATA_ABI, functionName: "symbol" }) as Promise<string>,
    ]);
    push("collateralDecimals", "Collateral decimals()", String(EXPECTED_DECIMALS), String(decimals));
  } catch (e) {
    push("collateralDecimals", "Collateral decimals()", String(EXPECTED_DECIMALS), null, String(e));
  }

  // 4. A live production portfolio's OWN collateralToken(), confirming the
  //    factory invariant holds for a real, funded instance and not only in
  //    theory.
  let portfolioCollateral: Address | null = null;
  try {
    portfolioCollateral = (await client.readContract({ address: portfolio, abi: PORTFOLIO_COLLATERAL_ABI, functionName: "collateralToken" })) as Address;
    push("portfolioCollateral", `Portfolio ${portfolio.slice(0, 10)}… collateralToken()`, EXPECTED_COLLATERAL, portfolioCollateral);
  } catch (e) {
    push("portfolioCollateral", `Portfolio ${portfolio.slice(0, 10)}… collateralToken()`, EXPECTED_COLLATERAL, null, String(e));
  }

  // 5. A REAL, recent transaction against this portfolio, to show execution
  //    actually happens on Shannon and gas is paid in the chain's native
  //    token — every EVM chain charges gas natively, so a successful receipt
  //    on chain 50312 IS that proof; nothing here is asserted without a
  //    fetched receipt behind it.
  let recentTx: {
    hash: string; blockNumber: string; status: string; gasUsed: string; effectiveGasPriceWei: string; nativeFeePaid: string;
  } | null = null;
  let recentTxError: string | null = null;
  try {
    const admittedEvent = airspacePortfolioAbi.find((e) => e.type === "event" && e.name === "IntentAdmitted")!;
    const head = await client.getBlockNumber();
    // A bounded, fast live scan for something fresher than the fallback —
    // both Shannon RPCs cap a single `eth_getLogs` range, so this walks
    // backward in chunks rather than asking for a huge range at once, and
    // gives up quickly rather than making a request wait on dozens of calls.
    const CHUNK = 1000n;
    const SCAN_CHUNKS = 5;
    let last: { transactionHash: `0x${string}` } | undefined;
    for (let i = 0; i < SCAN_CHUNKS && !last; i++) {
      const to = head - BigInt(i) * CHUNK;
      const from = to - CHUNK + 1n > 0n ? to - CHUNK + 1n : 0n;
      if (to <= 0n) break;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- viem's getLogs event-filter overload does not
      // infer from a runtime-selected ABI entry; only `transactionHash` off the result is used below.
      const logs = (await client.getLogs({ address: portfolio, event: admittedEvent as any, fromBlock: from, toBlock: to })) as Array<{
        transactionHash: `0x${string}`;
      }>;
      last = logs.at(-1);
    }
    const txHash = last?.transactionHash ?? FALLBACK_REFERENCE_TX;
    const receipt = await client.getTransactionReceipt({ hash: txHash });
    const fee = receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
    recentTx = {
      hash: receipt.transactionHash,
      blockNumber: receipt.blockNumber.toString(),
      status: receipt.status,
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPriceWei: (receipt.effectiveGasPrice ?? 0n).toString(),
      nativeFeePaid: fee.toString(),
    };
    if (!last) {
      recentTxError = "no fresher activity in the last 5,000 blocks — showing a known reference transaction against this portfolio instead";
    }
  } catch (e) {
    recentTxError = String(e);
  }

  const allPass = checks.every((x) => x.pass) && recentTx?.status === "success";

  return c.json({
    ok: allPass,
    network: {
      name: "Somnia Shannon",
      chainId: EXPECTED_CHAIN_ID,
      nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
      explorer: "https://shannon-explorer.somnia.network",
    },
    collateral: {
      address: EXPECTED_COLLATERAL,
      symbolOnChain: symbol,
      decimalsOnChain: decimals,
      description: "DreamDEX's official Shannon test collateral for this venue — not a scarce faucet token AIRSPACE depends on.",
    },
    checks,
    recentTransaction: recentTx,
    recentTransactionError: recentTxError,
    explorerTxUrl: recentTx ? `https://shannon-explorer.somnia.network/tx/${recentTx.hash}` : null,
  });
});

/**
 * Configuration for the frontend. FAILS LOUD — not a plain 200 with an
 * `ok: false` flag — if `AIRSPACE_FACTORY` resolves to a deployment this
 * repository has proven unsafe (see `@airspace/sdk`'s `assertCurrentImplementation`).
 * A client that cannot get a config has an obvious, unmissable failure; a
 * client that gets one pointed at the superseded implementation would not.
 */
app.get("/api/config", async (c) => {
  try {
    await verifiedFactory(c.env);
  } catch (e) {
    if (e instanceof SupersededDeploymentError) {
      return c.json({ error: "SUPERSEDED_DEPLOYMENT", message: e.message }, 500);
    }
    throw e;
  }
  return c.json({
    chainId: chainId(c.env),
    factory: c.env.AIRSPACE_FACTORY || null,
    explorer: chainId(c.env) === 5031 ? "https://explorer.somnia.network" : "https://shannon-explorer.somnia.network",
  });
});

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

  return c.json({
    portfolios: list.map((address) => ({
      address,
      // A portfolio has no on-chain name and nothing sets an off-chain one.
      displayName: null,
      displayNameProvenance: "OFFCHAIN_WITNESS",
    })),
  });
});

/** Live portfolio state, via the per-portfolio Durable Object. */
app.get("/api/portfolios/:address", async (c) => {
  const address = c.req.param("address");
  if (!isAddress(address)) return bad(c, "invalid portfolio address");
  // The Durable Object unions these with the domains this portfolio has
  // configured, from its own event store, so a rolled series never hides an
  // enforced ceiling.
  const domains = (c.req.query("domains") ?? "").split(",").filter(isBytes32).join(",");

  const stub = portfolioStub(c.env, address);
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

  const domains = (c.req.query("domains") ?? "").split(",").filter(isBytes32).join(",");
  const stub = portfolioStub(c.env, address);
  return stub.fetch(`https://do/stream?portfolio=${address}&domains=${encodeURIComponent(domains)}`, {
    headers: c.req.raw.headers,
  });
});

app.get("/api/portfolios/:address/agents", async (c) => {
  const address = c.req.param("address");
  if (!isAddress(address)) return bad(c, "invalid portfolio address");
  const client = publicClient(c.env);

  // The address SET is read from the portfolio's own `AgentSet` logs, held in
  // its Durable Object: an address that can sign a valid intent right now shows
  // up here with no database involved. Everything about it that matters —
  // enabled, limits, committed, nonce — is then re-read from the contract.
  const { body } = await portfolioView<{
    agents: Array<{ address: Address; strategyId: string | null; registeredTx: string }>;
    names: Record<string, string>;
    complete: boolean;
  }>(c.env, address, "agents");

  const enriched = await Promise.all(
    body.agents.map(async (a) => {
      const [policy, committed, nonce] = await Promise.all([
        client.readContract({
          address: address as Address,
          abi: airspacePortfolioAbi,
          functionName: "agentPolicy",
          args: [a.address],
        }) as Promise<readonly [boolean, bigint, bigint, bigint, bigint, bigint, string]>,
        client.readContract({
          address: address as Address,
          abi: airspacePortfolioAbi,
          functionName: "agentCommitted",
          args: [a.address],
        }) as Promise<bigint>,
        client.readContract({
          address: address as Address,
          abi: airspacePortfolioAbi,
          functionName: "agentNonce",
          args: [a.address],
        }) as Promise<bigint>,
      ]);
      return S({
        address: a.address,
        displayName: body.names[a.address.toLowerCase()] ?? null,
        strategyId: a.strategyId,
        strategyVersion: null,
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
        registeredTx: a.registeredTx,
      });
    }),
  );
  return c.json({ agents: enriched, complete: body.complete });
});

/**
 * Set an agent's display name — purely cosmetic (`OFFCHAIN_WITNESS`
 * provenance), never read by admission logic, never mirrored on chain: the
 * `AgentSet` event carries no name field at all.
 *
 * There is no session or backend auth in this product — every other write
 * is authorized by a wallet signing a real transaction, so this is gated the
 * same way, minus the gas: the OWNER signs a plain message (not a tx) and
 * the signature is checked against `owner()` read live from the portfolio,
 * never a cached value. The signed message embeds a timestamp so an old
 * signature cannot be replayed to rename an agent again later.
 */
app.put("/api/portfolios/:address/agents/:agent/name", async (c) => {
  const address = c.req.param("address");
  const agentAddress = c.req.param("agent");
  if (!isAddress(address)) return bad(c, "invalid portfolio address");
  if (!isAddress(agentAddress)) return bad(c, "invalid agent address");

  const body = await c.req.json<{ name: string; signature: `0x${string}`; timestamp: number }>();
  const name = (body.name ?? "").trim().slice(0, 40);
  if (typeof body.timestamp !== "number" || Math.abs(Date.now() - body.timestamp) > 5 * 60_000) {
    return bad(c, "signature timestamp is missing or expired — try again");
  }
  if (!body.signature) return bad(c, "missing signature");

  const message = [
    "AIRSPACE",
    "Set agent display name",
    `Portfolio: ${address.toLowerCase()}`,
    `Agent: ${agentAddress.toLowerCase()}`,
    `Name: ${name}`,
    `Timestamp: ${body.timestamp}`,
  ].join("\n");

  const client = publicClient(c.env);
  const [owner, signer] = await Promise.all([
    client.readContract({ address: address as Address, abi: airspacePortfolioAbi, functionName: "owner" }) as Promise<Address>,
    recoverMessageAddress({ message, signature: body.signature }).catch(() => null),
  ]);
  if (!signer || signer.toLowerCase() !== owner.toLowerCase()) {
    return c.json({ error: "signature was not from this portfolio's owner" }, 403);
  }

  const policyHash = (await client
    .readContract({
      address: address as Address,
      abi: airspacePortfolioAbi,
      functionName: "agentPolicyHash",
      args: [agentAddress as Address],
    })
    .catch(() => null)) as `0x${string}` | null;
  if (!policyHash || /^0x0+$/.test(policyHash)) return bad(c, "this address has never been registered as an agent", 404);

  const res = await portfolioStub(c.env, address).fetch("https://do/name", {
    method: "POST",
    body: JSON.stringify({ agent: agentAddress, name }),
  });
  if (!res.ok) return c.json({ error: "failed to save display name" }, 500);

  return c.json({ address: agentAddress.toLowerCase(), displayName: name || null });
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

  // `minRemaining` may be negative on purpose: the Event Contracts surface asks
  // for recent settled generations alongside live ones, and discoverMarkets'
  // filter is `expiry - now >= minRemaining`, so a negative value reaches back
  // past expiry without a second code path.
  const markets = await discoverMarkets(client, { lookback, minSecondsRemaining: minRemaining });
  const withState = await Promise.all(
    markets.slice(0, 40).map(async (m) => {
      const [live, book] = await Promise.all([
        readLiveState(client, m),
        readBook(client, m.pool, 1).catch(() => ({ bids: [], asks: [] })),
      ]);
      return S({
        ...m,
        cadenceLabel: cadenceLabel(m.cadenceSec),
        status: marketStatus(live),
        bestBid: book.bids[0]?.price ?? null,
        bestAsk: book.asks[0]?.price ?? null,
        live: {
          trading: live.trading,
          resolved: live.resolved,
          voided: live.voided,
          finalized: live.finalized,
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
  const [live, book] = await Promise.all([readLiveState(client, m), readBook(client, m.pool, 3).catch(() => ({ bids: [], asks: [] }))]);
  return c.json(
    S({
      market: { ...m, cadenceLabel: cadenceLabel(m.cadenceSec), status: marketStatus(live) },
      live,
      book,
    }),
  );
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
      advisory:
        "Advisory preview — rechecked atomically on-chain at submission. Another agent may consume headroom first; a successful preview is not a promise that execution will succeed.",
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

  // Admission is decided by the factory, not by the caller. Without this an
  // arbitrary reverted transaction to any contract could be filed here.
  const isPortfolio = (await client.readContract({
    address: factoryAddress(c.env),
    abi: airspacePortfolioFactoryAbi,
    functionName: "isPortfolio",
    args: [portfolio],
  })) as boolean;
  if (!isPortfolio) return c.json({ error: "NOT_AN_AIRSPACE_PORTFOLIO" }, 404);

  const block = await client.getBlock({ blockNumber: receipt.blockNumber });

  // Held in the portfolio's own Durable Object, beside the events it explains.
  // Every field was decoded from the transaction or returned by replaying it.
  // None was witnessed by a worker and none was supplied by a client.
  await portfolioStub(c.env, portfolio).fetch("https://do/refusal", {
    method: "POST",
    body: JSON.stringify({
      intentHash: hash,
      agent: txn.from.toLowerCase(),
      marketId: intent.marketId,
      pool: intent.pool.toLowerCase(),
      marketNonce: intent.marketNonce.toString(),
      kind: Number(intent.kind),
      orderType: Number(intent.orderType),
      price: intent.price.toString(),
      quantity: intent.quantity.toString(),
      agentNonce: intent.nonce.toString(),
      refusal,
      tx: body.txHash,
      block: receipt.blockNumber.toString(),
      ts: Number(block.timestamp),
    }),
  });

  return c.json({
    recorded: true,
    intentHash: hash,
    refusal,
    refusalName: REFUSAL_NAME[refusal] ?? null,
    copy: REFUSAL_COPY[refusal] ?? null,
  });
});

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
// Intents, receipts, reservations, positions — derived from the portfolio's own logs
// ---------------------------------------------------------------------------

/**
 * Pass one of the portfolio Durable Object's views straight through.
 *
 * Every row behind these routes is decoded from the portfolio's own events and
 * then re-measured against the contract (reservations against `orderRec` and
 * the venue, positions against the outcome token). No database is consulted,
 * so none can be down, stale, or full.
 */
async function viewResponse(env: Env, address: string, kind: string, params: Record<string, string>): Promise<Response> {
  const q = new URLSearchParams({ portfolio: address, kind, ...params });
  const res = await portfolioStub(env, address).fetch(`https://do/view?${q.toString()}`);
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
}

for (const route of ["intents", "receipts", "reservations", "positions"] as const) {
  app.get(`/api/portfolios/:address/${route}`, async (c) => {
    const address = c.req.param("address");
    if (!isAddress(address)) return bad(c, "invalid portfolio address");

    const params: Record<string, string> = {};
    for (const k of ["limit", "offset"] as const) {
      const v = c.req.query(k);
      if (v && /^\d+$/.test(v)) params[k] = v;
    }
    const agent = c.req.query("agent");
    if (agent && isAddress(agent)) params.agent = agent.toLowerCase();
    const status = c.req.query("status");
    if (status === "ADMITTED" || status === "REFUSED") params.status = status;

    return viewResponse(c.env, address, route, params);
  });
}

// ---------------------------------------------------------------------------
// History status — is the event store caught up, and does it explain the chain?
// ---------------------------------------------------------------------------

/**
 * Whether the activity, reservation and position views can be trusted right now.
 *
 * Two independent checks, both against the chain:
 *
 *   1. Coverage: has the event store read up to the head? A portfolio deployed
 *      days ago is still loading its history for a few minutes after its first
 *      visit, and the views say so rather than presenting a partial list as whole.
 *   2. Integrity: do the open reservations the events describe add up to the
 *      collateral the portfolio itself reports as reserved? A mismatch on a
 *      fully-loaded history is a real discrepancy, not a loading state.
 */
app.get("/api/portfolios/:address/history-status", async (c) => {
  const address = c.req.param("address");
  if (!isAddress(address)) return bad(c, "invalid portfolio address");
  return viewResponse(c.env, address, "integrity", {});
});

// ---------------------------------------------------------------------------
// Reconciliation truth — what the domain is carrying that a permissionless
// release could clear, and how close each domain is to its own limits.
// ---------------------------------------------------------------------------

/**
 * Reconciliation and headroom summary, per requested domain.
 *
 * `independentWorstCase` is NOT read from the contract's `domainRiskUsage()`.
 * It is rebuilt from the outcome token's own balances and the contract's own
 * `orderRec` reservations, run through `@airspace/risk`'s `domainRiskUsage` — a
 * SEPARATE implementation from the Solidity one. `scripts/risk-verifier.mjs` is
 * the stronger check, probing the venue order by order.
 */
app.get("/api/portfolios/:address/reconciliation", async (c) => {
  const address = c.req.param("address");
  if (!isAddress(address)) return bad(c, "invalid portfolio address");
  const domains = (c.req.query("domains") ?? "").split(",").filter(isBytes32);
  if (domains.length === 0) return c.json({ domains: [] });
  return viewResponse(c.env, address, "reconciliation", { domains: domains.slice(0, 32).join(",") });
});

app.get("/api/receipts/:intentHash", async (c) => {
  const h = c.req.param("intentHash");
  if (!isBytes32(h)) return bad(c, "invalid intent hash");
  const portfolio = c.req.query("portfolio");
  if (!isAddress(portfolio)) return bad(c, "portfolio query parameter is required");

  const res = await viewResponse(c.env, portfolio, "receipt", { hash: h });
  if (!res.ok) return res;

  const body = (await res.json()) as { receipt: { refusal_code: number | null }; order: unknown };
  const refusal = body.receipt.refusal_code;
  return c.json({
    receipt: body.receipt,
    order: body.order,
    copy: refusal ? (REFUSAL_COPY[refusal] ?? null) : null,
    refusalName: refusal ? (REFUSAL_NAME[refusal] ?? null) : null,
  });
});

// ---------------------------------------------------------------------------
// Static assets (the web app) — anything not under /api
// ---------------------------------------------------------------------------

app.all("*", async (c) => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.json({ error: "not found" }, 404);
});

/**
 * A single word for the Event Contracts surface. Derived the same way the
 * contract's own `MARKET_NOT_TRADING` gate reads state — trading, resolved,
 * voided, finalized — never guessed from a timestamp alone.
 */
function marketStatus(live: { trading: boolean; resolved: boolean; voided: boolean; finalized: boolean; secondsRemaining: number }): "live" | "settled" | "voided" | "closed" {
  if (live.resolved) return "settled";
  if (live.voided) return "voided";
  if (live.trading) return "live";
  return "closed";
}

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
