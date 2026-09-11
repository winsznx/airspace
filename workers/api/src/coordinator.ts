import type { Address, DomainId } from "@airspace/types";
import { airspacePortfolioAbi } from "@airspace/sdk";
import type { Env, ReconcileJob } from "./env.js";
import { findDeploymentBlock, isTransportError, publicClient, scanPortfolioLogs, verifiedFactory } from "./rpc.js";
import { SupersededDeploymentError } from "@airspace/sdk";
import {
  agentsFromEvents,
  byPosition,
  configuredDomainsFromEvents,
  eventKey,
  intentsFromEvents,
  receiptsFromEvents,
  reservationsFromEvents,
  toStoredEvent,
  trackedMarketsFromEvents,
  type RefusalRecord,
  type StoredEvent,
} from "./portfolio-log.js";
import {
  mapLimit,
  overlayPosition,
  overlayReservation,
  summariseDomain,
} from "./portfolio-live.js";

/**
 * PortfolioCoordinator — one Durable Object per portfolio.
 *
 * Responsibilities: hold a warm snapshot of live portfolio state, fan that
 * state out to connected browsers over WebSocket, and schedule its own refresh
 * via alarms.
 *
 * It is NEVER an authority. Every number it serves is read from the chain, and
 * a browser must not act on cached state: execution decisions are made by the
 * portfolio contract at execution time (PRD 24.2, 26). If this object stops,
 * the product degrades to slower reads and the on-chain envelope is unaffected.
 *
 * Partitioning by portfolio is what keeps the system free of global mutable
 * state: 1 or 1,000 portfolios is the same architecture, just more objects.
 */

const REFRESH_MS = 15_000;
const IDLE_STOP_MS = 5 * 60_000;

export interface PortfolioSnapshot {
  portfolio: Address;
  chainId: number;
  blockNumber: string;
  fetchedAt: number;
  owner: Address;
  collateralToken: Address;
  capitalBase: string;
  freeCollateral: string;
  committedCapital: string;
  reservedCollateral: string;
  globalPolicyHash: string;
  policyEpoch: string;
  domains: Array<{
    domain: DomainId;
    usage: string;
    ceiling: string;
    committedCeiling: string;
    liveMarkets: number;
    marketCount: number;
    configured: boolean;
  }>;
  /** Set when the last refresh failed, so the UI can show a stale badge. */
  stale?: { since: number; reason: string };
}

/** How far the event store has read, persisted so a scan resumes rather than restarts. */
interface ScanState {
  start: string;
  scannedThrough: string;
  complete: boolean;
}

/** Re-read this many blocks behind the checkpoint: puts are idempotent, so overlap only costs a request. */
const SCAN_OVERLAP = 12n;
/** Behind by no more than this and a request catches up inline instead of waiting on the alarm. */
const INLINE_CATCHUP_BLOCKS = 60_000n;
/** Behind by no more than this and history is considered current. */
const CURRENT_WITHIN_BLOCKS = 200n;

export class PortfolioCoordinator implements DurableObject {
  private sockets = new Set<WebSocket>();
  private snapshot: PortfolioSnapshot | null = null;
  private watchedDomains = new Set<DomainId>();
  private lastActivity = Date.now();
  private scan: ScanState | null = null;
  private events: Map<string, StoredEvent> | null = null;
  private refusals: Map<string, RefusalRecord> | null = null;
  private names: Record<string, string> | null = null;
  private scanning: Promise<void> | null = null;
  private lastScanAt = 0;

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.lastActivity = Date.now();

    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocket(url);
    }

    try {
      switch (url.pathname) {
        case "/snapshot": {
          const portfolio = url.searchParams.get("portfolio") as Address | null;
          const domains = (url.searchParams.get("domains") ?? "")
            .split(",")
            .filter(Boolean) as DomainId[];
          for (const d of domains) this.watchedDomains.add(d);
          if (!portfolio) return json({ error: "portfolio required" }, 400);

          await this.state.storage.put("portfolio", portfolio);
          if (!this.scan) await this.scheduleAlarm(100);
          const snap = await this.refresh(portfolio, { force: url.searchParams.get("force") === "1" });
          return json(snap);
        }
        case "/invalidate": {
          // A confirmed transaction touched this portfolio: refresh promptly so
          // connected browsers see the new state without waiting for the alarm.
          const portfolio = url.searchParams.get("portfolio") as Address | null;
          if (portfolio) await this.refresh(portfolio, { force: true });
          return json({ ok: true });
        }
        case "/view":
          return this.handleView(url);
        case "/name": {
          const body = (await request.json()) as { agent: string; name: string };
          await this.loadStore();
          const key = body.agent.toLowerCase();
          const names = { ...(this.names ?? {}) };
          if (body.name) names[key] = body.name;
          else delete names[key];
          this.names = names;
          await this.state.storage.put("names", names);
          return json({ address: key, displayName: body.name || null });
        }
        case "/refusal": {
          const record = (await request.json()) as RefusalRecord;
          await this.loadStore();
          this.refusals!.set(record.intentHash, record);
          await this.state.storage.put(`refusal:${record.intentHash}`, record);
          return json({ ok: true });
        }
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (e) {
      if (e instanceof SupersededDeploymentError) {
        return json({ error: "SUPERSEDED_DEPLOYMENT", message: e.message }, 500);
      }
      throw e;
    }
  }

  private async handleWebSocket(url: URL): Promise<Response> {
    const portfolio = url.searchParams.get("portfolio") as Address | null;
    if (!portfolio) return json({ error: "portfolio required" }, 400);
    for (const d of (url.searchParams.get("domains") ?? "").split(",").filter(Boolean)) {
      this.watchedDomains.add(d as DomainId);
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    this.sockets.add(server);

    server.addEventListener("close", () => this.sockets.delete(server));
    server.addEventListener("error", () => this.sockets.delete(server));
    server.addEventListener("message", (e) => {
      this.lastActivity = Date.now();
      if (typeof e.data === "string" && e.data === "ping") server.send("pong");
    });

    // Send the current snapshot immediately so a reconnecting client has an
    // authoritative baseline before it replays anything incremental.
    const snap = this.snapshot ?? (await this.refresh(portfolio, { force: false }));
    try {
      server.send(JSON.stringify({ type: "snapshot", data: snap }));
    } catch {
      /* the socket closed between accept and first send */
    }

    await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm(): Promise<void> {
    const p = this.snapshot?.portfolio ?? (await this.state.storage.get<Address>("portfolio")) ?? null;
    if (!p) return;

    // Stop refreshing when nothing is watching and nobody has asked recently.
    // A backfill left unfinished resumes on the next request.
    if (this.sockets.size === 0 && Date.now() - this.lastActivity > IDLE_STOP_MS) return;

    // Catch the event store up first. While it is far behind, alarms run
    // back-to-back so a portfolio deployed days ago finishes its history in
    // minutes without anyone holding a request open for it.
    const behind = await this.syncLog(p).then(() => this.blocksBehind()).catch(() => null);
    const snapshotAge = this.snapshot ? Date.now() - this.snapshot.fetchedAt : Infinity;
    if (snapshotAge >= REFRESH_MS) await this.refresh(p, { force: true });
    await this.scheduleAlarm(behind !== null && behind > CURRENT_WITHIN_BLOCKS ? 1_000 : REFRESH_MS);
  }

  private async scheduleAlarm(delayMs: number = REFRESH_MS): Promise<void> {
    const at = Date.now() + delayMs;
    const existing = await this.state.storage.getAlarm();
    if (existing === null || existing > at) await this.state.storage.setAlarm(at);
  }

  private async refresh(
    portfolio: Address,
    opts: { force: boolean },
  ): Promise<PortfolioSnapshot> {
    const fresh = this.snapshot && Date.now() - this.snapshot.fetchedAt < REFRESH_MS / 2;
    if (!opts.force && fresh && this.snapshot) return this.snapshot;

    try {
      const snap = await this.read(portfolio);
      this.snapshot = snap;
      await this.state.storage.put("snapshot", snap);
      this.broadcast({ type: "snapshot", data: snap });
      await this.scheduleAlarm();
      return snap;
    } catch (e) {
      // A superseded implementation is not something a "stale" badge can
      // honestly describe: it isn't old data, it would be WRONG data. Fail the
      // whole request rather than falling back to a cached snapshot, and never
      // cache the superseded verdict as though it were a portfolio reading.
      if (e instanceof SupersededDeploymentError) {
        this.broadcast({ type: "error", data: { code: "SUPERSEDED_DEPLOYMENT", message: e.message } });
        throw e;
      }
      // Serve the last good snapshot, explicitly marked stale. A UI showing an
      // old number honestly is far safer than one showing nothing or guessing.
      const reason = isTransportError(e) ? "rpc-unavailable" : "read-failed";
      const prev =
        this.snapshot ?? ((await this.state.storage.get<PortfolioSnapshot>("snapshot")) ?? null);
      if (prev) {
        const stale: PortfolioSnapshot = {
          ...prev,
          stale: { since: prev.fetchedAt, reason },
        };
        this.snapshot = stale;
        this.broadcast({ type: "stale", data: stale });
        return stale;
      }
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // The event store — a portfolio's own logs, decoded and persisted
  // -------------------------------------------------------------------------

  private async loadStore(): Promise<void> {
    if (this.events) return;
    const [scan, events, refusals, names] = await Promise.all([
      this.state.storage.get<ScanState>("scan"),
      this.state.storage.list<StoredEvent>({ prefix: "ev:" }),
      this.state.storage.list<RefusalRecord>({ prefix: "refusal:" }),
      this.state.storage.get<Record<string, string>>("names"),
    ]);
    this.scan = scan ?? null;
    this.events = events;
    this.refusals = new Map([...refusals.values()].map((r) => [r.intentHash, r]));
    this.names = names ?? {};
  }

  private sortedEvents(): StoredEvent[] {
    return [...(this.events?.values() ?? [])].sort(byPosition);
  }

  private async blocksBehind(): Promise<bigint | null> {
    if (!this.scan) return null;
    const latest = await publicClient(this.env).getBlockNumber();
    const through = BigInt(this.scan.scannedThrough);
    return latest > through ? latest - through : 0n;
  }

  /** One bounded scan step, serialised so concurrent requests share it. */
  private syncLog(portfolio: Address): Promise<void> {
    if (!this.scanning) {
      this.scanning = this.scanOnce(portfolio).finally(() => {
        this.scanning = null;
      });
    }
    return this.scanning;
  }

  private async scanOnce(portfolio: Address): Promise<void> {
    await this.loadStore();
    await this.state.storage.put("portfolio", portfolio);
    const client = publicClient(this.env);

    const start = this.scan ? BigInt(this.scan.start) : await findDeploymentBlock(client, portfolio);
    const resume = this.scan ? BigInt(this.scan.scannedThrough) + 1n - SCAN_OVERLAP : start;
    const from = resume > start ? resume : start;

    const result = await scanPortfolioLogs(client, portfolio, from);

    // One block timestamp per block that actually carries a log.
    const blocks = [...new Set(result.logs.map((l) => l.blockNumber).filter((b): b is bigint => b !== null))];
    const stamps = new Map<string, number>();
    await mapLimit(blocks, 8, async (blockNumber) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const b = await client.getBlock({ blockNumber });
          stamps.set(blockNumber.toString(), Number(b.timestamp));
          return;
        } catch {
          /* retry: an event without a real timestamp would show a false age */
        }
      }
      throw new Error(`could not read block ${blockNumber}`);
    });

    const fresh: Record<string, StoredEvent> = {};
    for (const log of result.logs) {
      const ts = log.blockNumber === null ? 0 : (stamps.get(log.blockNumber.toString()) ?? 0);
      const e = toStoredEvent(log, ts);
      if (e) fresh[eventKey(e.block, e.logIndex)] = e;
    }

    const keys = Object.keys(fresh);
    for (let i = 0; i < keys.length; i += 100) {
      await this.state.storage.put(Object.fromEntries(keys.slice(i, i + 100).map((k) => [k, fresh[k]!])));
    }
    for (const k of keys) this.events!.set(k, fresh[k]!);

    this.scan = {
      start: start.toString(),
      scannedThrough: result.scannedThrough.toString(),
      complete: result.complete,
    };
    await this.state.storage.put("scan", this.scan);
    this.lastScanAt = Date.now();
    if (!result.complete) await this.scheduleAlarm(1_000);
  }

  /**
   * Make the store current enough to answer from.
   *
   * The first call ever does one bounded scan inline. After that a store that is
   * only a little behind is caught up inline; one that is far behind (a portfolio
   * deployed days ago) is left to the alarm, and the response says so instead of
   * holding the request open.
   */
  private async ensureFresh(portfolio: Address): Promise<{ complete: boolean; scannedThrough: string; behind: string }> {
    await this.loadStore();
    if (!this.scan) {
      // A portfolio deployed moments ago is scanned inline — it is a handful of
      // windows. One deployed days ago is millions of blocks: answer at once
      // with "still loading" and let the alarm do the reading, rather than make
      // the first visitor wait on it.
      const client = publicClient(this.env);
      const [start, head] = await Promise.all([findDeploymentBlock(client, portfolio), client.getBlockNumber()]);
      if (head - start <= INLINE_CATCHUP_BLOCKS) {
        await this.syncLog(portfolio);
      } else {
        this.scan = { start: start.toString(), scannedThrough: (start - 1n).toString(), complete: false };
        await this.state.storage.put("scan", this.scan);
        await this.state.storage.put("portfolio", portfolio);
        await this.scheduleAlarm(100);
      }
    } else {
      const behind = (await this.blocksBehind()) ?? 0n;
      if (behind <= INLINE_CATCHUP_BLOCKS) {
        if (Date.now() - this.lastScanAt > 1_500) await this.syncLog(portfolio);
      } else {
        await this.scheduleAlarm(500);
      }
    }
    const behind = (await this.blocksBehind()) ?? 0n;
    return {
      complete: behind <= CURRENT_WITHIN_BLOCKS,
      scannedThrough: this.scan?.scannedThrough ?? "0",
      behind: behind.toString(),
    };
  }

  private async handleView(url: URL): Promise<Response> {
    const portfolio = url.searchParams.get("portfolio") as Address | null;
    if (!portfolio) return json({ error: "portfolio required" }, 400);
    const kind = url.searchParams.get("kind") ?? "";
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 25), 1), 100);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
    const agent = url.searchParams.get("agent")?.toLowerCase() ?? null;
    const status = url.searchParams.get("status");

    const meta = await this.ensureFresh(portfolio);
    const events = this.sortedEvents();
    const refusals = [...(this.refusals?.values() ?? [])];
    const client = publicClient(this.env);
    const page = <T>(rows: T[]) => ({ rows: rows.slice(offset, offset + limit), total: rows.length, limit, offset });

    switch (kind) {
      case "health":
        return json(meta);

      case "domains":
        return json({ domains: configuredDomainsFromEvents(events), ...meta });

      case "integrity": {
        const chainHead = await client.getBlockNumber();
        const reservedOnChain = (await client.readContract({
          address: portfolio,
          abi: airspacePortfolioAbi,
          functionName: "reservedCollateral",
        })) as bigint;

        // The reservations a partial history describes prove nothing, so the
        // comparison is only made once the history is current.
        let explained: bigint | null = null;
        let openCount: number | null = null;
        if (meta.complete) {
          const open = reservationsFromEvents(events).filter((r) => r.qty_open > 0n);
          const rows = await mapLimit(open, 8, (b) => overlayReservation(client, portfolio, b));
          const live = rows.filter((r) => r.state !== "FINALIZED");
          explained = live.reduce((a, r) => a + BigInt(r.collateral_reserved), 0n);
          openCount = live.length;
        }

        const reasons: string[] = [];
        if (!meta.complete) {
          reasons.push(`Reading this portfolio's history from the chain (${meta.behind} blocks to go). Lists may be incomplete until it finishes.`);
        } else if (explained !== reservedOnChain) {
          reasons.push("The reservations recorded in the portfolio's events do not add up to the collateral it reports as reserved.");
        }
        return json({
          stale: reasons.length > 0,
          loading: !meta.complete,
          reasons,
          chainHead: chainHead.toString(),
          scannedThrough: meta.scannedThrough,
          behindBlocks: meta.behind,
          onChainReservedCollateral: reservedOnChain.toString(),
          explainedReservedCollateral: explained === null ? null : explained.toString(),
          openReservations: openCount,
        });
      }

      case "agents":
        return json({ agents: agentsFromEvents(events), names: this.names ?? {}, ...meta });

      case "intents": {
        let rows = intentsFromEvents(events, refusals);
        if (agent) rows = rows.filter((r) => r.agent_address === agent);
        if (status) rows = rows.filter((r) => r.status === status);
        const p = page(rows);
        return json({ intents: p.rows.map(({ logIndex: _l, ...r }) => r), total: p.total, limit, offset, ...meta });
      }

      case "receipts": {
        let rows = receiptsFromEvents(events, refusals);
        if (agent) rows = rows.filter((r) => r.agent_address === agent);
        const p = page(rows);
        return json({ receipts: p.rows.map(({ logIndex: _l, ...r }) => r), total: p.total, limit, offset, ...meta });
      }

      case "receipt": {
        const hash = url.searchParams.get("hash") ?? "";
        const receipt = receiptsFromEvents(events, refusals).find((r) => r.intent_hash === hash);
        if (!receipt) return json({ error: "RECEIPT_NOT_FOUND" }, 404);
        const intent = intentsFromEvents(events, refusals).find((r) => r.intent_hash === hash) ?? null;
        const { logIndex: _r, ...rc } = receipt;
        return json({
          receipt: rc,
          order: intent
            ? { kind: intent.kind, price: intent.price, quantity: intent.quantity, orderId: intent.order_id, poolAddress: intent.pool_address }
            : null,
        });
      }

      case "reservations": {
        let bases = reservationsFromEvents(events).sort((a, b) => b.source_block - a.source_block);
        if (agent) bases = bases.filter((r) => r.agent_address === agent);
        const p = page(bases);
        const rows = await mapLimit(p.rows, 8, (b) => overlayReservation(client, portfolio, b));
        return json({ reservations: rows, total: p.total, limit, offset, ...meta });
      }

      case "positions": {
        const p = page(trackedMarketsFromEvents(events));
        const rows = await mapLimit(p.rows, 8, (m) => overlayPosition(client, portfolio, m));
        return json({ positions: rows, total: p.total, limit, offset, ...meta });
      }

      case "reconciliation": {
        const domains = (url.searchParams.get("domains") ?? "").split(",").filter(Boolean);
        const cap = Number(
          await client
            .readContract({ address: portfolio, abi: airspacePortfolioAbi, functionName: "MAX_MARKETS_PER_DOMAIN" })
            .catch(() => 48n),
        );
        const reservations = reservationsFromEvents(events);
        const markets = trackedMarketsFromEvents(events);
        const out = await Promise.all(
          domains.map(async (domain) => {
            const summary = await summariseDomain(client, portfolio, domain, events, reservations, markets, cap);
            const tracked = (await client
              .readContract({ address: portfolio, abi: airspacePortfolioAbi, functionName: "domainMarketCount", args: [domain as DomainId] })
              .catch(() => null)) as bigint | null;
            return tracked === null ? summary : { ...summary, marketsTracked: Number(tracked) };
          }),
        );
        return json({ domains: out, ...meta });
      }

      default:
        return json({ error: "unknown view" }, 400);
    }
  }

  private async read(portfolio: Address): Promise<PortfolioSnapshot> {
    // Fails loud (SupersededDeploymentError) if AIRSPACE_FACTORY resolves to a
    // deployment this repository has proven unsafe. Memoized per isolate.
    await verifiedFactory(this.env);

    const client = publicClient(this.env);
    const chainId = Number(this.env.CHAIN_ID ?? 50312);

    type ReadFn = Extract<
      (typeof airspacePortfolioAbi)[number],
      { type: "function"; stateMutability: "view" | "pure" }
    >["name"];
    const call = <T>(functionName: ReadFn, args: readonly unknown[] = []) =>
      client.readContract({
        address: portfolio,
        abi: airspacePortfolioAbi,
        functionName,
        args: args as never,
      }) as Promise<T>;

    const [blockNumber, owner, collateralToken, capitalBase, free, committed, reserved, gpHash, epoch] =
      await Promise.all([
        client.getBlockNumber(),
        call<Address>("owner"),
        call<Address>("collateralToken"),
        call<bigint>("capitalBase"),
        call<bigint>("freeCollateral"),
        call<bigint>("committedCapital"),
        call<bigint>("reservedCollateral"),
        call<string>("globalPolicyHash"),
        call<bigint>("policyEpoch"),
      ]);

    // Domains the portfolio has configured come from its own event store, so a
    // series that rolled away never drops an enforced ceiling from the snapshot.
    await this.loadStore();
    const watched = new Set<string>(this.watchedDomains);
    for (const d of configuredDomainsFromEvents(this.sortedEvents())) watched.add(d);

    const domains = await Promise.all(
      [...watched].slice(0, 32).map(async (domain) => {
        const [policy, usage, live, markets] = await Promise.all([
          call<readonly [boolean, bigint, bigint, number]>("domainPolicy", [domain]),
          call<bigint>("domainRiskUsage", [domain]),
          call<number>("liveMarkets", [domain]),
          call<bigint>("domainMarketCount", [domain]),
        ]);
        return {
          domain: domain as DomainId,
          usage: usage.toString(),
          ceiling: policy[1].toString(),
          committedCeiling: policy[2].toString(),
          liveMarkets: Number(live),
          marketCount: Number(markets),
          configured: policy[0],
        };
      }),
    );

    return {
      portfolio,
      chainId,
      blockNumber: blockNumber.toString(),
      fetchedAt: Date.now(),
      owner,
      collateralToken,
      capitalBase: capitalBase.toString(),
      freeCollateral: free.toString(),
      committedCapital: committed.toString(),
      reservedCollateral: reserved.toString(),
      globalPolicyHash: gpHash,
      policyEpoch: epoch.toString(),
      domains,
    };
  }

  private broadcast(msg: unknown): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.sockets) {
      try {
        ws.send(payload);
      } catch {
        this.sockets.delete(ws);
      }
    }
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
