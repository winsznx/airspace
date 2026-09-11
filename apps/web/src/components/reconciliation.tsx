import { airspacePortfolioAbi } from "@airspace/sdk";
import { type MarketSummary, type ReconciliationSummary, type ReservationRow } from "../lib/api";
import { useWrite } from "../hooks/tx";
import { useIsWrongNetwork } from "../wallet";
import { TxStatus } from "./tx";
import { Disclosure, Tag } from "./ui";
import { contracts, timeAgo } from "../lib/format";

const OPEN_STATES = new Set(["RESERVED", "RESTING", "PARTIAL", "NEEDS_RECONCILIATION"]);

/**
 * Reconciliation and lifecycle-health panel for one domain.
 *
 * AIRSPACE safely OVERSTATES exposure while a filled or cancelled reservation
 * waits for a permissionless release to prove it gone — `getOrder` reverts
 * identically for both, so the contract cannot tell them apart on its own.
 * This panel is where that overstatement stops being an unexplained number and
 * becomes a legible, bounded, self-clearing thing: how much is pending, how
 * old the oldest pending item is, and when it last cleared.
 *
 * The compact row is always visible. Evidence-grade detail — the independent
 * reconstruction, the raw counts — sits behind a `Disclosure` so the headline
 * story is never buried in numbers only an engineer would want.
 */
export function ReconciliationPanel({
  domain,
  marketCount,
  usage,
  ceiling,
  summary,
  portfolio,
  reservations,
  markets,
  onReconciled,
}: {
  domain: string;
  marketCount: number;
  usage: bigint;
  ceiling: bigint;
  summary: ReconciliationSummary | undefined;
  portfolio: string;
  reservations: ReservationRow[];
  markets: MarketSummary[];
  onReconciled: () => void;
}) {
  const headroom = ceiling > usage ? ceiling - usage : 0n;
  const saturated = usage >= ceiling;
  const reconcileTx = useWrite();
  const settledTx = useWrite();
  const pruneTx = useWrite();
  const wrongNetwork = useIsWrongNetwork();

  const cap = summary?.marketsCap ?? 48;
  const nearCap = marketCount / cap >= 0.85;
  const atCap = marketCount >= cap;
  const hasPending = Boolean(summary && summary.pendingReleaseCount > 0);

  // The oldest reservation the contract could release right now. The rows are
  // measured live (the portfolio's own `orderRec` against the venue's order), so
  // "needs reconciliation" here means `releaseOrder` will free something — it is
  // not a guess carried over from an old projection.
  const oldestReservation = [...reservations]
    .filter((r) => r.state === "NEEDS_RECONCILIATION")
    .sort((a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime())[0];

  // A market is prunable once it is no longer live and nothing in this domain
  // still reserves against it — the same "no reservations, no balance" test
  // pruneMarket enforces on chain, checked here only to pick a target.
  const openMarketIds = new Set(reservations.filter((r) => OPEN_STATES.has(r.state)).map((r) => r.market_id));
  const prunable = markets.find((m) => m.status !== "live" && !openMarketIds.has(m.marketId));
  const settledMarket = markets.find((m) => m.status === "settled" || m.status === "voided");

  const reconcile = async () => {
    if (!oldestReservation) return;
    const h = await reconcileTx.send({
      address: portfolio as `0x${string}`,
      abi: airspacePortfolioAbi,
      functionName: "releaseOrder",
      args: [oldestReservation.order_key as `0x${string}`],
    });
    if (h) onReconciled();
  };

  const releaseSettled = async () => {
    if (!settledMarket) return;
    const h = await settledTx.send({
      address: portfolio as `0x${string}`,
      abi: airspacePortfolioAbi,
      functionName: "releaseSettled",
      args: [settledMarket.marketId as `0x${string}`],
    });
    if (h) onReconciled();
  };

  const prune = async () => {
    if (!prunable) return;
    const h = await pruneTx.send({
      address: portfolio as `0x${string}`,
      abi: airspacePortfolioAbi,
      functionName: "pruneMarket",
      args: [prunable.marketId as `0x${string}`],
    });
    if (h) onReconciled();
  };

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row-between" style={{ flexWrap: "wrap", gap: 8 }}>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <span className="caption">
            {marketCount} of {cap} markets tracked
          </span>
          {atCap ? (
            <Tag tone="fail">At capacity — new markets refused until one prunes</Tag>
          ) : nearCap ? (
            <Tag tone="warn">Approaching capacity</Tag>
          ) : null}
          {hasPending ? (
            <Tag tone="warn">
              {summary!.pendingReleaseCount} pending release{summary!.pendingReleaseCount === 1 ? "" : "s"}
            </Tag>
          ) : (
            <Tag tone="pass">Nothing pending release</Tag>
          )}
          <span className="caption">
            {saturated ? "0 headroom — fail-closed" : `${contracts(headroom)} headroom before fail-closed`}
          </span>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button
            className="btn btn-outline btn-sm"
            disabled={reconcileTx.busy || wrongNetwork || !oldestReservation}
            onClick={() => void reconcile()}
            title="Permissionless: asks the venue what is actually still open on the oldest pending reservation and drops it to match. Moves nothing that is still live."
          >
            {reconcileTx.busy ? <span className="spinner" /> : null}
            Reconcile now
          </button>
          <button
            className="btn btn-outline btn-sm"
            disabled={settledTx.busy || wrongNetwork || !settledMarket}
            onClick={() => void releaseSettled()}
            title="Permissionless: frees the capital a settled market in this domain is still occupying."
          >
            {settledTx.busy ? <span className="spinner" /> : null}
            Release settled
          </button>
          <button
            className="btn btn-outline btn-sm"
            disabled={pruneTx.busy || wrongNetwork || !prunable}
            onClick={() => void prune()}
            title="Permissionless: drops a settled market carrying no reservations and no balance out of this domain's tracked set."
          >
            {pruneTx.busy ? <span className="spinner" /> : null}
            Prune now
          </button>
        </div>
      </div>

      <TxStatus state={reconcileTx} onDismiss={reconcileTx.reset} />
      <TxStatus state={settledTx} onDismiss={settledTx.reset} />
      <TxStatus state={pruneTx} onDismiss={pruneTx.reset} />

      <Disclosure summary="Reconciliation evidence">
        <div className="stack" style={{ gap: 8 }}>
          <p className="caption" style={{ margin: 0 }}>
            AIRSPACE may temporarily reserve more capacity than current positions require while it waits to
            prove an old order can be released. This blocks additional trades rather than understating risk.
            The worst-case figure below is rebuilt from the outcome token's own balances and the contract's
            own reservation records, read live, then run through a separate code path from the contract's
            summary counter — so it shares no number with it. The "Reconcile now" and "Prune now" buttons
            above call the contract directly.
          </p>
          <table className="kv-table">
            <tbody>
              <tr>
                <td>Risk usage the contract enforces (live chain read)</td>
                <td className="num">{contracts(usage)}</td>
              </tr>
              <tr>
                <td>Independent worst-case exposure (rebuilt live from balances and reservations)</td>
                <td className="num">{summary ? contracts(summary.independentWorstCase) : "—"}</td>
              </tr>
              <tr>
                <td>Amount awaiting safe release</td>
                <td className="num">{summary ? contracts(summary.pendingReleaseAmount) : "—"}</td>
              </tr>
              <tr>
                <td>Pending releases</td>
                <td className="num">{summary?.pendingReleaseCount ?? "—"}</td>
              </tr>
              <tr>
                <td>Oldest pending release</td>
                <td className="num">
                  {summary?.oldestPendingReleaseAgeSec != null ? timeAgo(Date.now() - summary.oldestPendingReleaseAgeSec * 1000) : "—"}
                </td>
              </tr>
              <tr>
                <td>Last successful reconciliation</td>
                <td className="num">{summary?.lastReconciledAt ? timeAgo(summary.lastReconciledAt) : "none recorded yet"}</td>
              </tr>
              <tr>
                <td>Markets tracked / domain cap</td>
                <td className="num">
                  {marketCount} / {cap}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="caption" style={{ margin: 0 }}>
            "Reconcile now", "Release settled" and "Prune now" are permissionless: each sends its transaction
            from your own wallet, and anyone can send the same ones. They need nothing from this service to
            work, and a reservation is offered for release only when the contract itself could free it.
          </p>
          <p className="caption" style={{ margin: 0 }}>
            Domain <span className="hash">{domain}</span>. The strongest form of this check runs continuously
            off-chain, probing the venue order by order rather than reading any indexed projection —{" "}
            <span className="hash">scripts/risk-verifier.mjs</span> in the repository.
          </p>
        </div>
      </Disclosure>
    </div>
  );
}
