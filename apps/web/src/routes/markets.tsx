import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useAgents, useList, useMarkets } from "../hooks/portfolio";
import type { MarketStatus, MarketSummary, PositionRow, ReservationRow } from "../lib/api";
import { AddressLink, Card, Empty, ErrorState, LoadingCard, Tag } from "../components/ui";
import { contracts, countdown, marketLabel, probability, shortHash } from "../lib/format";

/**
 * Event Contracts — the DreamDEX markets this portfolio's fleet actually touches.
 *
 * Not a generic market explorer: DreamDEX already is one. The question this
 * page answers is AIRSPACE's own — which live Event Contracts is my fleet
 * trading, who is trading them, and what exposure does that leave the
 * portfolio holding. Everything shown is read straight from the module
 * registry and this portfolio's own indexed reservations/positions; nothing
 * here is a label AIRSPACE invented. A market's asset (BTC, ETH, ...) is not
 * exposed by any view on this venue, so it is never guessed at — markets are
 * identified by id, pool and generation, the way the contract identifies them.
 */

const STATUS_TONE: Record<MarketStatus, "pass" | "warn" | "fail" | "neutral"> = {
  live: "pass",
  settled: "neutral",
  voided: "fail",
  closed: "warn",
};
const STATUS_LABEL: Record<MarketStatus, string> = {
  live: "Live",
  settled: "Settled",
  voided: "Voided",
  closed: "Closed, awaiting settlement",
};

interface Family {
  pool: string;
  cadenceSec: number;
  cadenceLabel: string;
  creator: string;
  domain: string | null;
  generations: MarketSummary[];
}

function groupByPool(markets: MarketSummary[]): Family[] {
  const byPool = new Map<string, Family>();
  for (const m of markets) {
    if (!byPool.has(m.pool)) {
      byPool.set(m.pool, { pool: m.pool, cadenceSec: m.cadenceSec, cadenceLabel: m.cadenceLabel, creator: m.creator, domain: m.domain, generations: [] });
    }
    byPool.get(m.pool)!.generations.push(m);
  }
  for (const f of byPool.values()) f.generations.sort((a, b) => Number(BigInt(b.marketNonce) - BigInt(a.marketNonce)));
  return [...byPool.values()].sort((a, b) => Number(BigInt(b.generations[0]!.marketId) - BigInt(a.generations[0]!.marketId)));
}

export function EventContractsPage() {
  const { address = "" } = useParams();
  // Reach back an hour past expiry too, so a family's just-settled generation
  // still renders next to the live one it rolled into.
  const markets = useMarkets(-3600);
  const agents = useAgents(address);
  const reservations = useList<ReservationRow>(address, "reservations", { limit: 200 });
  const positions = useList<PositionRow>(address, "positions", { limit: 200 });
  const [expanded, setExpanded] = useState<string | null>(null);

  const agentName = useMemo(() => {
    const m = new Map((agents.data?.agents ?? []).map((a) => [a.address.toLowerCase(), a.displayName ?? a.strategyId ?? a.address]));
    return (addr: string) => m.get(addr.toLowerCase()) ?? addr;
  }, [agents.data]);

  const touchedByMarket = useMemo(() => {
    const m = new Map<string, { agents: Set<string>; openOrders: number; reservedQty: bigint }>();
    for (const r of reservations.data?.reservations ?? []) {
      if (!["RESERVED", "RESTING", "PARTIAL", "NEEDS_RECONCILIATION"].includes(r.state)) continue;
      const e = m.get(r.market_id) ?? { agents: new Set<string>(), openOrders: 0, reservedQty: 0n };
      e.agents.add(r.agent_address);
      e.openOrders += 1;
      e.reservedQty += BigInt(r.qty_open);
      m.set(r.market_id, e);
    }
    return m;
  }, [reservations.data]);

  const positionByMarket = useMemo(() => {
    const m = new Map<string, PositionRow>();
    for (const p of positions.data?.positions ?? []) m.set(p.market_id, p);
    return m;
  }, [positions.data]);

  const families = useMemo(() => groupByPool(markets.data?.markets ?? []), [markets.data]);
  const touchedFamilies = families.filter((f) => f.generations.some((g) => touchedByMarket.has(g.marketId) || positionByMarket.has(g.marketId)));
  const otherFamilies = families.filter((f) => !touchedFamilies.includes(f));

  if (markets.isLoading) return <LoadingCard rows={6} />;
  if (markets.isError) return <ErrorState error={markets.error} retry={() => void markets.refetch()} />;
  if (families.length === 0) {
    return (
      <Empty title="No active Event Contracts found">
        DreamDEX mints new markets continuously. If none show up here, the registry lookback window may not be
        reaching one — this reads the chain directly, not an indexer, so it will show whatever DreamDEX has live
        right now.
      </Empty>
    );
  }

  return (
    <div className="stack" style={{ gap: 24 }}>
      <div>
        <h2 style={{ fontSize: 20 }}>Event Contracts</h2>
        <p className="muted" style={{ marginTop: 4 }}>
          The DreamDEX markets this fleet is trading, and every rolling generation behind them. AIRSPACE's policy
          reaches a new generation automatically — no owner transaction, because the domain is derived from
          creator, collateral and cadence, not from any single market id.
        </p>
      </div>

      {touchedFamilies.length > 0 ? (
        <section className="stack" style={{ gap: 12 }}>
          <div className="caption" style={{ fontWeight: 500, color: "var(--carbon)" }}>
            Trading now — {touchedFamilies.length} market{touchedFamilies.length === 1 ? "" : "s"} with fleet activity
          </div>
          {touchedFamilies.map((f) => (
            <FamilyCard
              key={f.pool}
              family={f}
              expanded={expanded === f.pool}
              onToggle={() => setExpanded(expanded === f.pool ? null : f.pool)}
              touchedByMarket={touchedByMarket}
              positionByMarket={positionByMarket}
              agentName={agentName}
              highlight
            />
          ))}
        </section>
      ) : (
        <Empty title="No Event Contracts touched yet">
          Register an agent and propose an order to see this fleet's activity mapped onto real DreamDEX markets.
        </Empty>
      )}

      {otherFamilies.length > 0 ? (
        <section className="stack" style={{ gap: 12 }}>
          <div className="caption" style={{ fontWeight: 500 }}>
            Other live Event Contracts in range — not yet traded by this fleet
          </div>
          {otherFamilies.slice(0, 8).map((f) => (
            <FamilyCard
              key={f.pool}
              family={f}
              expanded={expanded === f.pool}
              onToggle={() => setExpanded(expanded === f.pool ? null : f.pool)}
              touchedByMarket={touchedByMarket}
              positionByMarket={positionByMarket}
              agentName={agentName}
            />
          ))}
        </section>
      ) : null}
    </div>
  );
}

function FamilyCard({
  family,
  expanded,
  onToggle,
  touchedByMarket,
  positionByMarket,
  agentName,
  highlight = false,
}: {
  family: Family;
  expanded: boolean;
  onToggle: () => void;
  touchedByMarket: Map<string, { agents: Set<string>; openOrders: number; reservedQty: bigint }>;
  positionByMarket: Map<string, PositionRow>;
  agentName: (a: string) => string;
  highlight?: boolean;
}) {
  const live = family.generations.find((g) => g.status === "live");
  const shown = expanded ? family.generations : family.generations.slice(0, 3);

  return (
    <Card className={highlight ? "" : "muted-card"}>
      <div className="row-between" style={{ flexWrap: "wrap", gap: 12 }}>
        <div className="stack" style={{ gap: 4 }}>
          <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
            <span style={{ fontWeight: 500, fontSize: 16, color: "var(--carbon)" }}>{family.cadenceLabel} Event Contract</span>
            {live ? <Tag tone="pass">Live</Tag> : <Tag tone="neutral">No live generation right now</Tag>}
          </div>
          <span className="caption hash" title={family.pool}>
            pool <AddressLink address={family.pool} /> · creator <AddressLink address={family.creator} />
          </span>
        </div>
        {live ? (
          <div className="row" style={{ gap: 16 }}>
            {live.bestBid ? (
              <span className="caption">
                bid <strong className="num">{probability(live.bestBid)}</strong>
              </span>
            ) : null}
            {live.bestAsk ? (
              <span className="caption">
                ask <strong className="num">{probability(live.bestAsk)}</strong>
              </span>
            ) : null}
            <span className="caption">rolls in {countdown(live.live.secondsRemaining)}</span>
          </div>
        ) : null}
      </div>

      <div className="generation-chain" style={{ marginTop: 16 }}>
        {shown.map((g, i) => {
          const touch = touchedByMarket.get(g.marketId);
          const pos = positionByMarket.get(g.marketId);
          const exposure = pos ? BigInt(pos.directional_exposure) : 0n;
          return (
            <div key={g.marketId}>
              <div className="generation-row">
                <span className="generation-nonce">{marketLabel(g.marketId)}</span>
                <span className="generation-gen">gen {g.marketNonce}</span>
                <Tag tone={STATUS_TONE[g.status]}>{STATUS_LABEL[g.status]}</Tag>
                <span className="caption dim">
                  {new Date(Number(g.tradingStart) * 1000).toLocaleTimeString()} →{" "}
                  {new Date(Number(g.expiry) * 1000).toLocaleTimeString()}
                </span>
                {touch ? (
                  <span className="caption" style={{ color: "var(--carbon)" }}>
                    {touch.agents.size} agent{touch.agents.size === 1 ? "" : "s"} · {touch.openOrders} open order
                    {touch.openOrders === 1 ? "" : "s"} · {contracts(touch.reservedQty)} reserved
                  </span>
                ) : null}
                {exposure !== 0n ? (
                  <span className="caption" style={{ color: "var(--carbon)" }}>
                    exposure {contracts(exposure < 0n ? -exposure : exposure)} {exposure > 0n ? "UP" : "DOWN"}
                  </span>
                ) : null}
                <a
                  className="caption hash"
                  style={{ marginLeft: "auto" }}
                  href={`https://shannon-explorer.somnia.network/address/${g.pool}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {shortHash(g.marketId)}
                </a>
              </div>
              {touch && touch.agents.size > 0 ? (
                <div className="caption dim" style={{ paddingLeft: 8, marginTop: 2 }}>
                  {[...touch.agents].map(agentName).join(", ")}
                </div>
              ) : null}
              {i < shown.length - 1 ? <div className="generation-link" aria-hidden /> : null}
            </div>
          );
        })}
      </div>

      {family.generations.length > 3 ? (
        <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={onToggle}>
          {expanded ? "Show fewer generations" : `Show all ${family.generations.length} generations`}
        </button>
      ) : null}

      <p className="caption" style={{ marginTop: 12, color: "var(--ash)" }}>
        AIRSPACE policy applies to every generation of this pool automatically — the risk domain is derived from
        creator, collateral and cadence, read fresh on every admission, never configured per market.
      </p>
    </Card>
  );
}
