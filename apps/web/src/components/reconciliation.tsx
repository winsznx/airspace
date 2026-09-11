import { useState } from "react";
import { api, type ReconciliationSummary } from "../lib/api";
import { Disclosure, Tag } from "./ui";
import { contracts, timeAgo } from "../lib/format";

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
  onReconciled,
}: {
  domain: string;
  marketCount: number;
  usage: bigint;
  ceiling: bigint;
  summary: ReconciliationSummary | undefined;
  portfolio: string;
  onReconciled: () => void;
}) {
  const headroom = ceiling > usage ? ceiling - usage : 0n;
  const saturated = usage >= ceiling;
  const [busy, setBusy] = useState<"reconcile" | "prune" | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const cap = summary?.marketsCap ?? 48;
  const nearCap = marketCount / cap >= 0.85;
  const atCap = marketCount >= cap;
  const hasPending = Boolean(summary && summary.pendingReleaseCount > 0);

  const request = async (kind: "release-order" | "prune-market", label: string) => {
    setBusy(kind === "release-order" ? "reconcile" : "prune");
    setResult(null);
    try {
      const res = await api.requestReconcile({ portfolio, domain, kind, reason: "control-room" });
      setResult(res.deduplicated ? `${label} already queued` : `${label} queued for the next lifecycle pass`);
      onReconciled();
    } catch (e) {
      setResult(e instanceof Error ? e.message : "Could not queue that");
    } finally {
      setBusy(null);
    }
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
            disabled={busy !== null || !hasPending}
            onClick={() => void request("release-order", "Reconcile")}
            title="Permissionless: asks the venue what is actually still open and drops any stale reservation to match. Moves nothing that is still live."
          >
            {busy === "reconcile" ? <span className="spinner" /> : null}
            Reconcile now
          </button>
          <button
            className="btn btn-outline btn-sm"
            disabled={busy !== null || !nearCap}
            onClick={() => void request("prune-market", "Prune")}
            title="Permissionless: drops settled markets carrying no reservations and no balance out of this domain's tracked set."
          >
            {busy === "prune" ? <span className="spinner" /> : null}
            Prune now
          </button>
        </div>
      </div>

      {result ? <span className="caption">{result}</span> : null}

      <Disclosure summary="Reconciliation evidence">
        <div className="stack" style={{ gap: 8 }}>
          <p className="caption" style={{ margin: 0 }}>
            AIRSPACE may temporarily reserve more capacity than current positions require while it waits to
            prove an old order can be released. This blocks additional trades rather than understating risk.
            Every figure below is independently reconstructed, not read from the contract's own summary
            counter.
          </p>
          <table className="kv-table">
            <tbody>
              <tr>
                <td>Independent worst-case exposure</td>
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
              <tr>
                <td>Next scheduled reconciliation</td>
                <td className="num">within 60s</td>
              </tr>
            </tbody>
          </table>
          <p className="caption" style={{ margin: 0 }}>
            The lifecycle keeper is permissionless and runs on a public cron roughly every minute, in addition
            to whatever "Reconcile now" or "Prune now" above queues immediately. Automatic lifecycle
            management is the primary path; the buttons only ask for the same work sooner.
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
