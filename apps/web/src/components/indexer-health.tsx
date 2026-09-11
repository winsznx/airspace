import { useHistoryStatus } from "../hooks/portfolio";
import { Notice } from "./ui";
import { collateral } from "../lib/format";

/**
 * Honest status for the activity, reservation and position lists.
 *
 * Those lists are decoded from the portfolio's own logs, which the API reads
 * from the chain and keeps per portfolio. Two things can make them
 * untrustworthy for a moment, and both are checked against the chain rather than
 * against the lists themselves:
 *
 *   - the history is still being read (a portfolio deployed days ago is loading
 *     for a few minutes after its first visit), so a list may be partial;
 *   - the reservations the history describes do not add up to the collateral the
 *     contract itself reports as reserved.
 *
 * Rendering nothing while everything agrees is deliberate: a banner that is
 * always on stops being read.
 */
export function IndexerHealthBanner({ portfolio }: { portfolio: string }) {
  const status = useHistoryStatus(portfolio);

  if (status.isError) {
    return (
      <Notice kind="warn" title="Could not confirm this data is current">
        AIRSPACE could not reach its own service to cross-check these lists against the chain, so treat what
        follows as possibly stale. This is a display problem only: the contract enforces its own accounting,
        and every control on this page sends its transaction straight from your wallet.
      </Notice>
    );
  }

  const data = status.data;
  if (!data || !data.stale) return null;

  if (data.loading) {
    return (
      <Notice kind="info" title="Reading this portfolio's history from the chain">
        {data.reasons.join(" ")} This fills in on its own — there is nothing to refresh. What the contract
        enforces is unaffected, and the controls on this page act on the contract directly.
      </Notice>
    );
  }

  return (
    <Notice kind="warn" title="These lists do not add up to the chain">
      {data.reasons.join(" ")} The contract reports {collateral(data.onChainReservedCollateral)} reserved for
      resting orders; the recorded history accounts for {collateral(data.explainedReservedCollateral ?? "0")}{" "}
      across {data.openReservations ?? 0} open reservation{data.openReservations === 1 ? "" : "s"}. Rows below may be
      missing or out of date. What the contract enforces is unaffected, and the controls on this page act on
      the contract directly.
    </Notice>
  );
}
