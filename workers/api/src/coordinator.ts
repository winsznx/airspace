import type { Address, DomainId } from "@airspace/types";
import { airspacePortfolioAbi } from "@airspace/sdk";
import type { Env, ReconcileJob } from "./env.js";
import { publicClient, isTransportError } from "./rpc.js";

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

export class PortfolioCoordinator implements DurableObject {
  private sockets = new Set<WebSocket>();
  private snapshot: PortfolioSnapshot | null = null;
  private watchedDomains = new Set<DomainId>();
  private lastActivity = Date.now();

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

    switch (url.pathname) {
      case "/snapshot": {
        const portfolio = url.searchParams.get("portfolio") as Address | null;
        const domains = (url.searchParams.get("domains") ?? "")
          .split(",")
          .filter(Boolean) as DomainId[];
        for (const d of domains) this.watchedDomains.add(d);
        if (!portfolio) return json({ error: "portfolio required" }, 400);

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
      default:
        return json({ error: "not found" }, 404);
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
    const p = this.snapshot?.portfolio;
    if (!p) return;

    // Stop refreshing when nothing is watching and nobody has asked recently.
    if (this.sockets.size === 0 && Date.now() - this.lastActivity > IDLE_STOP_MS) return;

    await this.refresh(p, { force: true });
    await this.scheduleAlarm();
  }

  private async scheduleAlarm(): Promise<void> {
    const existing = await this.state.storage.getAlarm();
    if (existing === null) await this.state.storage.setAlarm(Date.now() + REFRESH_MS);
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

  private async read(portfolio: Address): Promise<PortfolioSnapshot> {
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

    const domains = await Promise.all(
      [...this.watchedDomains].map(async (domain) => {
        const [policy, usage, live, markets] = await Promise.all([
          call<readonly [boolean, bigint, bigint, number]>("domainPolicy", [domain]),
          call<bigint>("domainRiskUsage", [domain]),
          call<number>("liveMarkets", [domain]),
          call<bigint>("domainMarketCount", [domain]),
        ]);
        return {
          domain,
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
