import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAccount, useReadContract } from "wagmi";
import { parseUnits } from "@airspace/risk";
import { OrderType } from "@airspace/types";
import { airspacePortfolioAbi } from "@airspace/sdk";
import { api, type MarketSummary, type ReconciliationSummary, type ReservationRow, type SimulateResult } from "../lib/api";
import {
  useAgents,
  useList,
  useMarkets,
  usePortfolio,
  usePortfolioMath,
  useReconciliation,
} from "../hooks/portfolio";
import { useWrite } from "../hooks/tx";
import { NetworkGuard, useIsWrongNetwork } from "../wallet";
import { AGENT_COLORS, CeilingLine, type Segment } from "../components/ceiling";
import { GateStack, Verdict } from "../components/gates";
import { ReconciliationPanel } from "../components/reconciliation";
import { DeploymentVerificationPanel } from "../components/deployment-verification";
import { TxStatus } from "../components/tx";
import {
  AddressLink,
  Card,
  Empty,
  ErrorState,
  Freshness,
  LoadingCard,
  Notice,
  Stat,
  Tag,
} from "../components/ui";
import { cadenceLabel, collateral, contracts, countdown, marketLabel, pct, probability } from "../lib/format";

const ZERO_BYTES32 = `0x${"00".repeat(32)}` as const;

const ORDER_TYPE_LABEL: Record<number, string> = {
  [OrderType.LIMIT]: "Limit",
  [OrderType.FILL_OR_KILL]: "Fill or kill",
  [OrderType.IMMEDIATE_OR_CANCEL]: "Immediate or cancel",
  [OrderType.POST_ONLY]: "Post-only",
};

export function ControlRoom() {
  const { address = "" } = useParams();
  const { address: wallet } = useAccount();

  const markets = useMarkets(120);
  const domains = useMemo(() => {
    const set = new Set<string>();
    for (const m of markets.data?.markets ?? []) if (m.domain) set.add(m.domain);
    return [...set];
  }, [markets.data]);

  const portfolio = usePortfolio(address, domains);
  const math = usePortfolioMath(portfolio.data);
  const agents = useAgents(address);
  const reservations = useList<ReservationRow>(address, "reservations", { limit: 100 });

  const configuredDomains = useMemo(
    () => (portfolio.data?.domains ?? []).filter((d) => d.configured).map((d) => d.domain),
    [portfolio.data],
  );
  const reconciliation = useReconciliation(address, configuredDomains);
  const reconciliationByDomain = useMemo(() => {
    const map = new Map<string, ReconciliationSummary>();
    for (const d of reconciliation.data?.domains ?? []) map.set(d.domain, d);
    return map;
  }, [reconciliation.data]);

  const isOwner =
    Boolean(wallet) && portfolio.data?.owner?.toLowerCase() === wallet?.toLowerCase();

  if (portfolio.isLoading && !portfolio.data) {
    return (
      <div className="stack">
        <LoadingCard rows={2} />
        <div className="grid grid-4">
          {[0, 1, 2, 3].map((i) => (
            <LoadingCard key={i} rows={2} />
          ))}
        </div>
        <LoadingCard rows={5} />
      </div>
    );
  }

  if (portfolio.isError && !portfolio.data) {
    return <ErrorState error={portfolio.error} retry={() => void portfolio.refetch()} />;
  }

  const snap = portfolio.data!;
  const configured = snap.domains.filter((d) => d.configured);
  const unconfigured = snap.domains.filter((d) => !d.configured);
  const activeAgents = (agents.data?.agents ?? []).filter((a) => a.enabled);

  return (
    <div className="stack" style={{ gap: 24 }}>
      <header className="row-between" style={{ flexWrap: "wrap", gap: 12 }}>
        <div className="stack" style={{ gap: 6 }}>
          <div className="row" style={{ gap: 10 }}>
            <h1 style={{ fontSize: 26 }}>Control room</h1>
            {isOwner ? <Tag tone="accent">Owner</Tag> : <Tag tone="neutral">View only</Tag>}
          </div>
          <div className="row" style={{ gap: 12 }}>
            <AddressLink address={address} />
            <span className="caption">block {snap.blockNumber}</span>
          </div>
        </div>
        <Freshness fetchedAt={snap.fetchedAt} stale={snap.stale} />
      </header>

      {snap.stale ? (
        <Notice kind="warn" title="Chain reads are delayed">
          The RPC endpoint did not answer, so this is the last state AIRSPACE read successfully. Figures may
          have moved. Nothing here is used to make an admission decision, the contract always re-evaluates on
          chain.
        </Notice>
      ) : null}

      <Onboarding
        funded={math ? math.capitalBase > 0n : false}
        policySet={snap.globalPolicyHash !== `0x${"00".repeat(32)}`}
        domainSet={configured.length > 0}
        agentSet={activeAgents.length > 0}
        base={address}
      />

      {/* ------------------------------------------------------------ capital */}
      <div className="grid grid-4">
        <Stat
          label="Capital base"
          value={collateral(snap.capitalBase)}
          sub="The denominator every ceiling is measured against"
        />
        <Stat
          label="Not currently free"
          value={collateral(snap.committedCapital)}
          sub={math ? `${math.utilisation.toFixed(1)}% of base` : undefined}
          tone={math && math.utilisation > 90 ? "ember" : math && math.utilisation > 70 ? "amber" : undefined}
        />
        <Stat label="Reserved for resting orders" value={collateral(snap.reservedCollateral)} sub="Not yet filled" />
        <Stat label="Free collateral" value={collateral(snap.freeCollateral)} sub="Measured, not accumulated" />
      </div>
      <p className="caption" style={{ marginTop: -12 }}>
        "Not currently free" is capital base minus free collateral — a budget reading, not a claim about what is
        in open positions. A profitable sale can pin it at zero while orders are still open; solvency is
        separately gated on free collateral itself, read from the token.
      </p>

      {/* --------------------------------------------------------- the ceilings */}
      <section className="stack" style={{ gap: 12 }}>
        <div className="row-between">
          <div>
            <h2 style={{ fontSize: 20 }}>Shared risk envelope</h2>
            <p className="muted" style={{ marginTop: 4 }}>
              Gross directional exposure per risk domain, summed across every agent. Resting orders count from
              the moment they are admitted.
            </p>
          </div>
          <Link className="btn btn-ghost btn-sm" to={`/app/${address}/settings`}>
            Domain policies
          </Link>
        </div>

        {/*
          Domains are derived from the live market registry, so until that read
          lands the portfolio snapshot has nothing to report a ceiling for.
          Saying "no domain has a ceiling" in that window would be false.
        */}
        {markets.isLoading && configured.length === 0 ? (
          <LoadingCard rows={4} />
        ) : markets.isError && configured.length === 0 ? (
          <ErrorState error={markets.error} retry={() => void markets.refetch()} />
        ) : configured.length === 0 ? (
          <Empty
            title="No domain has a ceiling yet"
            action={
              isOwner ? (
                <Link className="btn btn-primary" to={`/app/${address}/settings`}>
                  Set a domain ceiling
                </Link>
              ) : undefined
            }
          >
            Without a configured ceiling every intent into a domain is refused. This is deliberate: an
            unconfigured domain has no agreed limit, so there is nothing to enforce.
          </Empty>
        ) : (
          configured.map((d) => (
            <DomainCard
              key={d.domain}
              domain={d}
              markets={markets.data?.markets ?? []}
              reservations={reservations.data?.reservations ?? []}
              agentColor={agentColorMap(agents.data?.agents.map((a) => a.address) ?? [])}
              agentName={agentNameMap(agents.data?.agents ?? [])}
              reconciliation={reconciliationByDomain.get(d.domain)}
              portfolio={address}
              onReconciled={() => void reconciliation.refetch()}
            />
          ))
        )}

        {unconfigured.length > 0 ? (
          <Notice kind="info" title={`${unconfigured.length} live domain${unconfigured.length === 1 ? "" : "s"} with no ceiling`}>
            Markets exist in {unconfigured.length === 1 ? "this domain" : "these domains"} but no policy has been
            set, so every intent into {unconfigured.length === 1 ? "it" : "them"} is refused with
            DOMAIN_NOT_CONFIGURED.
          </Notice>
        ) : null}
      </section>

      {/* ---------------------------------------------------- admission preview */}
      <AdmissionPreview
        portfolio={address}
        agents={(agents.data?.agents ?? []).map((a) => ({ address: a.address, name: a.displayName, enabled: a.enabled }))}
        markets={markets.data?.markets ?? []}
        marketsLoading={markets.isLoading}
        configuredDomains={configured.map((d) => d.domain)}
        onExecuted={() => {
          void portfolio.refetch();
          void reservations.refetch();
          void reconciliation.refetch();
        }}
      />

      {/* --------------------------------------------------- technical evidence */}
      <DeploymentVerificationPanel portfolio={address} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function agentColorMap(addresses: string[]): (a: string) => string {
  const map = new Map<string, string>();
  addresses.forEach((a, i) => map.set(a.toLowerCase(), AGENT_COLORS[i % AGENT_COLORS.length]!));
  return (a: string) => map.get(a.toLowerCase()) ?? "#b8b5c9";
}

function agentNameMap(agents: Array<{ address: string; displayName: string | null }>): (a: string) => string {
  const map = new Map<string, string>();
  for (const a of agents) map.set(a.address.toLowerCase(), a.displayName || `${a.address.slice(0, 6)}…`);
  return (a: string) => map.get(a.toLowerCase()) ?? `${a.slice(0, 6)}…`;
}

/**
 * One risk domain.
 *
 * The total is the contract's own `domainRiskUsage`. Reservations are attributed
 * to the agent that placed them; realized positions are pooled ERC-6909 balances
 * and genuinely cannot be attributed to one agent, so they are shown as their
 * own segment rather than guessed at.
 */
function DomainCard({
  domain,
  markets,
  reservations,
  agentColor,
  agentName,
  reconciliation,
  portfolio,
  onReconciled,
}: {
  domain: { domain: string; usage: string; ceiling: string; committedCeiling: string; liveMarkets: number; marketCount: number };
  markets: MarketSummary[];
  reservations: ReservationRow[];
  agentColor: (a: string) => string;
  agentName: (a: string) => string;
  reconciliation: ReconciliationSummary | undefined;
  portfolio: string;
  onReconciled: () => void;
}) {
  const usage = BigInt(domain.usage);
  const ceiling = BigInt(domain.ceiling);

  const inDomain = markets.filter((m) => m.domain === domain.domain);
  const cadence = inDomain[0]?.cadenceSec ?? 0;
  const creator = inDomain[0]?.creator;

  const segments = useMemo<Segment[]>(() => {
    const byAgent = new Map<string, bigint>();
    let reservedTotal = 0n;
    for (const r of reservations) {
      if (r.domain_hash !== domain.domain) continue;
      if (!["RESERVED", "RESTING", "PARTIAL", "NEEDS_RECONCILIATION"].includes(r.state)) continue;
      const q = BigInt(r.qty_open);
      byAgent.set(r.agent_address, (byAgent.get(r.agent_address) ?? 0n) + q);
      reservedTotal += q;
    }
    const segs: Segment[] = [...byAgent.entries()]
      .sort((a, b) => (b[1] > a[1] ? 1 : -1))
      .map(([a, v]) => ({ label: agentName(a), amount: v, color: agentColor(a) }));

    const realized = usage > reservedTotal ? usage - reservedTotal : 0n;
    if (realized > 0n) segs.push({ label: "Filled positions (pooled)", amount: realized, color: "#b8b5c9" });
    return segs;
  }, [reservations, domain.domain, usage, agentColor, agentName]);

  const over = usage > ceiling;
  const soonest = inDomain
    .map((m) => m.live.secondsRemaining)
    .filter((s) => s > 0)
    .sort((a, b) => a - b)[0];

  return (
    <Card lg>
      <div className="row-between" style={{ marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
        <div className="stack" style={{ gap: 4 }}>
          <div className="row" style={{ gap: 8 }}>
            <span style={{ fontWeight: 500, color: "var(--carbon)" }}>
              {cadence ? cadenceLabel(cadence) : "unclassified"} cadence domain
            </span>
            {over ? <Tag tone="fail">Over ceiling</Tag> : null}
          </div>
          <span className="caption hash" title={domain.domain}>
            {domain.domain.slice(0, 18)}…{domain.domain.slice(-6)}
            {creator ? <> · creator {creator.slice(0, 8)}…</> : null}
          </span>
        </div>
        <div className="row" style={{ gap: 16 }}>
          <span className="caption">
            {domain.liveMarkets} live · {domain.marketCount} tracked
          </span>
          {soonest ? <span className="caption">next roll {countdown(soonest)}</span> : null}
        </div>
      </div>

      <CeilingLine segments={segments} ceiling={ceiling} />

      <div className="row" style={{ marginTop: 16, gap: 24, flexWrap: "wrap" }}>
        <span className="caption">
          Risk usage <strong className="num" style={{ color: "var(--carbon)" }}>{contracts(usage)}</strong> of{" "}
          {contracts(ceiling)} ({pct(usage, ceiling).toFixed(0)}%)
        </span>
        <span className="caption">
          Committed ceiling <strong className="num" style={{ color: "var(--carbon)" }}>{collateral(domain.committedCeiling)}</strong>
        </span>
      </div>

      {/*
        A usage figure over its ceiling is never shown bare. It is always one
        of two things: a live reservation genuinely occupying that much room,
        or safe overstatement waiting on a permissionless release — and the
        panel below is what tells the difference.
      */}
      {over ? (
        <div style={{ marginTop: 16 }}>
          <Notice kind="warn" title="Usage reads over its ceiling">
            AIRSPACE may temporarily reserve more capacity than current positions require while it waits to
            prove an old order can be released. This blocks additional trades rather than understating risk.
            See the reconciliation detail below for what is pending and why.
          </Notice>
        </div>
      ) : null}

      <div style={{ marginTop: 16 }}>
        <ReconciliationPanel
          domain={domain.domain}
          marketCount={domain.marketCount}
          usage={usage}
          ceiling={ceiling}
          summary={reconciliation}
          portfolio={portfolio}
          reservations={reservations.filter((r) => r.domain_hash === domain.domain)}
          markets={inDomain}
          onReconciled={onReconciled}
        />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function Onboarding({
  funded,
  policySet,
  domainSet,
  agentSet,
  base,
}: {
  funded: boolean;
  policySet: boolean;
  domainSet: boolean;
  agentSet: boolean;
  base: string;
}) {
  const steps = [
    { done: funded, label: "Fund the portfolio and set its capital base", to: `${base}/settings` },
    { done: policySet, label: "Set the global policy", to: `${base}/settings` },
    { done: domainSet, label: "Set a ceiling on at least one risk domain", to: `${base}/settings` },
    { done: agentSet, label: "Register an agent", to: `${base}/agents` },
  ];
  if (steps.every((s) => s.done)) return null;

  return (
    <Card>
      <div className="stat-label" style={{ marginBottom: 8 }}>
        Finish setting up
      </div>
      <ul className="checklist">
        {steps.map((s) => (
          <li key={s.label}>
            <span className={`tick${s.done ? " tick-done" : ""}`}>{s.done ? "✓" : ""}</span>
            <span style={{ flex: 1, color: s.done ? "var(--ash)" : "var(--graphite)" }}>{s.label}</span>
            {s.done ? null : (
              <Link className="caption" to={`/app/${s.to}`}>
                Go
              </Link>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------------------

/**
 * Admission preview — the central UI moment.
 *
 * The verdict is the contract's own `previewIntent`, never a re-implementation.
 * It is explicitly advisory: state can move between the preview and execution,
 * and the contract re-evaluates either way.
 */
function AdmissionPreview({
  portfolio,
  agents,
  markets,
  marketsLoading,
  configuredDomains,
  onExecuted,
}: {
  portfolio: string;
  agents: Array<{ address: string; name: string | null; enabled: boolean }>;
  markets: MarketSummary[];
  marketsLoading: boolean;
  configuredDomains: string[];
  onExecuted: () => void;
}) {
  const [agent, setAgent] = useState("");
  const [marketId, setMarketId] = useState("");
  const [kind, setKind] = useState(0);
  const [orderType, setOrderType] = useState<number>(OrderType.POST_ONLY);
  const [price, setPrice] = useState("0.55");
  const [quantity, setQuantity] = useState("100");
  const [result, setResult] = useState<SimulateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { address: wallet } = useAccount();
  const wrongNetwork = useIsWrongNetwork();
  const executeTx = useWrite();

  // If the connected wallet is itself a known agent, default to it — someone
  // who switched MetaMask accounts to their agent's key should not have to
  // also re-paste that same address here before they can place an order.
  // A manual pick (`agent`) always wins once the user has made one.
  const walletIsAgent = Boolean(wallet) && agents.some((a) => a.address.toLowerCase() === wallet!.toLowerCase());
  const selectedAgent = agent || (walletIsAgent ? wallet! : agents[0]?.address) || "";
  // Default to a market whose domain has a ceiling. An order into a domain with
  // none is refused (DOMAIN_NOT_CONFIGURED), so opening on one is a trap.
  const hasCeiling = (m: MarketSummary) => Boolean(m.domain) && configuredDomains.includes(m.domain as string);
  const selectedMarket = marketId || (markets.find(hasCeiling) ?? markets[0])?.marketId || "";
  // The market the dropdown is SHOWING, not only one the user has changed it to.
  // Until they touch the select, `marketId` is empty and the first option is
  // displayed; deriving this from `marketId` made "Place order" do nothing.
  const market = markets.find((m) => m.marketId === selectedMarket);

  const valid = /^0x[0-9a-fA-F]{40}$/.test(selectedAgent) && /^0x[0-9a-fA-F]{64}$/.test(selectedMarket);

  const isConnectedAsAgent = Boolean(wallet) && wallet!.toLowerCase() === selectedAgent.toLowerCase();

  const agentNonce = useReadContract({
    address: portfolio as `0x${string}`,
    abi: airspacePortfolioAbi,
    functionName: "agentNonce",
    args: [selectedAgent as `0x${string}`],
    query: { enabled: valid && isConnectedAsAgent },
  });

  const execute = async () => {
    if (!market) return;
    // Re-read the nonce right before signing rather than trusting a value that
    // may be several renders old — another tx from this same agent in between
    // would make a stale nonce collide and revert as INTENT_REPLAYED.
    const fresh = await agentNonce.refetch();
    const current = (fresh.data as bigint | undefined) ?? 0n;
    const hash = await executeTx.send({
      address: portfolio as `0x${string}`,
      abi: airspacePortfolioAbi,
      functionName: "execute",
      args: [
        {
          marketId: selectedMarket as `0x${string}`,
          pool: market.pool as `0x${string}`,
          marketNonce: BigInt(market.marketNonce),
          kind,
          price: parseUnits(price || "0", 6),
          quantity: parseUnits(quantity || "0", 6),
          expireTimestampNs: BigInt(market.live.marketExpiryNs),
          orderType,
          nonce: current + 1n,
          strategyVersion: ZERO_BYTES32,
        },
      ],
    });
    if (hash) onExecuted();
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.simulate({
        portfolio,
        agent: selectedAgent,
        marketId: selectedMarket,
        kind,
        price: parseUnits(price || "0", 6).toString(),
        quantity: parseUnits(quantity || "0", 6).toString(),
      });
      setResult(res);
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : "Simulation failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="stack" style={{ gap: 12 }}>
      <div>
        <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
          <h2 style={{ fontSize: 20 }}>Would this be admitted?</h2>
          <Tag tone="neutral">Advisory preview</Tag>
        </div>
        <p className="muted" style={{ marginTop: 4 }}>
          Ask the portfolio contract what it would decide right now, gate by gate — rechecked atomically
          on-chain at submission. Another agent may consume headroom first; a PASS here is not a promise.
        </p>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.1fr)", gap: 20 }}>
          <Card lg>
            <div className="stack">
              <label className="field">
                <span className="field-label">Agent</span>
                <input
                  className="input"
                  type="text"
                  spellCheck={false}
                  list="admission-preview-agents"
                  placeholder="0x…"
                  value={selectedAgent}
                  onChange={(e) => setAgent(e.target.value.trim())}
                />
                {agents.length > 0 ? (
                  <datalist id="admission-preview-agents">
                    {agents.map((a) => (
                      <option key={a.address} value={a.address}>
                        {(a.name || a.address.slice(0, 10)) + (a.enabled ? "" : " (revoked)")}
                      </option>
                    ))}
                  </datalist>
                ) : null}
                <span className="field-hint">
                  {agents.length > 0
                    ? "Any registered address — pick from the list or paste one."
                    : "Paste the agent's address. previewIntent reads its policy straight from the contract, not from an index."}
                </span>
              </label>

              <label className="field">
                <span className="field-label">Market</span>
                <select
                  className="input"
                  value={selectedMarket}
                  onChange={(e) => setMarketId(e.target.value)}
                  disabled={marketsLoading || markets.length === 0}
                >
                  {markets.length === 0 ? (
                    <option value="">{marketsLoading ? "Loading live markets…" : "No live markets"}</option>
                  ) : (
                    markets.map((m) => (
                      <option key={m.marketId} value={m.marketId}>
                        {m.cadenceLabel} · market {marketLabel(m.marketId)} · {countdown(m.live.secondsRemaining)} left
                        {hasCeiling(m) ? "" : " · no ceiling"}
                      </option>
                    ))
                  )}
                </select>
                <span className="field-hint">
                  Read straight from the DreamDEX module registry, not from an indexer.
                </span>
              </label>

              <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <label className="field">
                  <span className="field-label">Side</span>
                  <select className="input" value={kind} onChange={(e) => setKind(Number(e.target.value))}>
                    <option value={0}>Buy YES</option>
                    <option value={1}>Sell YES</option>
                    <option value={2}>Buy NO</option>
                    <option value={3}>Sell NO</option>
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Price</span>
                  <input
                    className="input"
                    type="text"
                    inputMode="decimal"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                  />
                  <span className="field-hint">
                    {market ? `tick ${contracts(market.live.tickSize)} · ${probability(parseUnits(price || "0", 6))}` : "0 to 1"}
                  </span>
                </label>
              </div>

              <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <label className="field">
                  <span className="field-label">Quantity (contracts)</span>
                  <input
                    className="input"
                    type="text"
                    inputMode="decimal"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                  />
                  {market ? (
                    <span className="field-hint">
                      lot {contracts(market.live.lotSize)} · minimum {contracts(market.live.minQuantity)}
                    </span>
                  ) : null}
                </label>
                <label className="field">
                  <span className="field-label">Order type</span>
                  <select className="input" value={orderType} onChange={(e) => setOrderType(Number(e.target.value))}>
                    {Object.entries(ORDER_TYPE_LABEL).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <span className="field-hint">
                    {orderType === OrderType.POST_ONLY
                      ? "Rests only — rejected if it would take liquidity immediately."
                      : "Can fill immediately against the resting book."}
                  </span>
                </label>
              </div>

              <button className="btn btn-primary" disabled={!valid || busy} onClick={() => void run()}>
                {busy ? (
                  <>
                    <span className="spinner" /> Asking the contract
                  </>
                ) : (
                  "Preview admission"
                )}
              </button>

              {error ? <div className="field-error">{error}</div> : null}
            </div>
          </Card>

          <div className="stack">
            {!result ? (
              <Card lg>
                <Empty title="No preview yet">
                  Choose an agent, a live market and an order, then ask the contract. Every gate it checks is
                  shown in the order it checks them.
                </Empty>
              </Card>
            ) : (
              <Card lg>
                <div className="stack" style={{ gap: 16 }}>
                  {result.arithmetic ? (
                    <CeilingLine
                      segments={[
                        {
                          label: "Domain usage now",
                          amount: BigInt(result.arithmetic.before),
                          color: AGENT_COLORS[0]!,
                        },
                      ]}
                      ceiling={BigInt(result.arithmetic.ceiling)}
                      proposed={{
                        amount: BigInt(result.arithmetic.requested),
                        fits: result.decision.admitted,
                      }}
                      showLegend={false}
                    />
                  ) : null}

                  <Verdict
                    admitted={result.decision.admitted}
                    copy={result.decision.copy}
                    arithmetic={result.arithmetic}
                  />

                  {result.decision.refusalName ? (
                    <span className="caption">
                      Refusal code {result.decision.refusal} · {result.decision.refusalName}
                    </span>
                  ) : null}

                  <GateStack gates={result.gates} />

                  <p className="caption">{result.advisory}</p>

                  <div className="stack" style={{ gap: 8, borderTop: "1px solid var(--fog)", paddingTop: 16 }}>
                    {!wallet ? (
                      <Notice kind="info" title="Connect a wallet to place this order">
                        Executing signs and sends the transaction from the agent's own address — the same
                        address this preview evaluated.
                      </Notice>
                    ) : !isConnectedAsAgent ? (
                      <Notice kind="warn" title="Connected wallet is not this agent">
                        Only {selectedAgent.slice(0, 8)}… can sign this intent. Switch your wallet to that
                        agent's account to place the order, or preview a different agent.
                      </Notice>
                    ) : (
                      <>
                        <NetworkGuard />
                        <button
                          className="btn btn-primary"
                          disabled={executeTx.busy || wrongNetwork}
                          onClick={() => void execute()}
                        >
                          {executeTx.busy ? (
                            <>
                              <span className="spinner" /> Placing order
                            </>
                          ) : result.decision.admitted ? (
                            "Place order"
                          ) : (
                            "Place order anyway"
                          )}
                        </button>
                      </>
                    )}
                    {!result.decision.admitted && isConnectedAsAgent ? (
                      <p className="caption">
                        The preview refused this intent. Submitting will re-check every gate on chain and is
                        expected to revert with the same reason.
                      </p>
                    ) : null}
                    <TxStatus state={executeTx} onDismiss={executeTx.reset} />
                  </div>
                </div>
              </Card>
            )}
          </div>
        </div>
    </section>
  );
}
