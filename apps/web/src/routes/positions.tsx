import { useState } from "react";
import { useParams } from "react-router-dom";
import { airspacePortfolioAbi } from "@airspace/sdk";
import { api, type PositionRow, type ReservationRow } from "../lib/api";
import { useAgents, useList } from "../hooks/portfolio";
import { useWrite } from "../hooks/tx";
import { TxStatus } from "../components/tx";
import { useIsWrongNetwork } from "../wallet";
import { Card, Empty, ErrorState, LoadingCard, Notice, Pager, TableWrap, Tag, TableActions } from "../components/ui";
import { collateral, contracts, marketLabel, shortHash, timeAgo } from "../lib/format";

const KIND_LABEL = ["Buy YES", "Sell YES", "Buy NO", "Sell NO"];

const OPEN_STATES = new Set(["RESERVED", "RESTING", "PARTIAL", "NEEDS_RECONCILIATION"]);

/**
 * Positions and reservations.
 *
 * A reservation holds capital for an order that has not filled. Releasing one is
 * permissionless and provable: the contract re-reads the venue and only frees
 * what the venue agrees is gone.
 */
export function PositionsPage() {
  const { address = "" } = useParams();
  const [tab, setTab] = useState<"reservations" | "positions">("reservations");

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div>
        <h1 style={{ fontSize: 24 }}>Exposure</h1>
        <p className="muted" style={{ marginTop: 4 }}>
          What the portfolio holds and what it has set aside. Both count against the shared envelope.
        </p>
      </div>

      <div className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "reservations"}
          className={`tab${tab === "reservations" ? " tab-active" : ""}`}
          onClick={() => setTab("reservations")}
        >
          Reservations
        </button>
        <button
          role="tab"
          aria-selected={tab === "positions"}
          className={`tab${tab === "positions" ? " tab-active" : ""}`}
          onClick={() => setTab("positions")}
        >
          Positions
        </button>
      </div>

      {tab === "reservations" ? <Reservations portfolio={address} /> : <Positions portfolio={address} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Reservations({ portfolio }: { portfolio: string }) {
  const [offset, setOffset] = useState(0);
  const q = useList<ReservationRow>(portfolio, "reservations", { limit: 25, offset });
  const agents = useAgents(portfolio);
  const rows = q.data?.reservations ?? [];

  const nameOf = (a: string) =>
    agents.data?.agents.find((x) => x.address.toLowerCase() === a.toLowerCase())?.displayName ||
    `${a.slice(0, 8)}…`;

  if (q.isLoading) return <LoadingCard rows={6} />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  if (rows.length === 0) {
    return (
      <Empty title="No reservations">
        When an agent's order rests on the book instead of filling immediately, the capital it will need is
        held here and counted against the envelope until the order is gone.
      </Empty>
    );
  }

  const needsWork = rows.filter((r) => r.state === "NEEDS_RECONCILIATION").length;

  return (
    <div className="stack">
      {needsWork > 0 ? (
        <Notice kind="warn" title={`${needsWork} reservation${needsWork === 1 ? "" : "s"} need reconciliation`}>
          The venue and the portfolio disagree about these orders. Until they are reconciled the portfolio
          overstates its usage, which is the safe direction: it can refuse a trade it could have allowed, never
          the reverse.
        </Notice>
      ) : null}

      <TableWrap>
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Agent</th>
              <th>Side</th>
              <th className="num-cell">Open qty</th>
              <th className="num-cell">Reserved</th>
              <th>State</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <ReservationRowView key={r.order_key} row={r} portfolio={portfolio} name={nameOf(r.agent_address)} onDone={() => void q.refetch()} />
            ))}
          </tbody>
        </table>
      </TableWrap>
      <Pager total={q.data?.total ?? 0} limit={25} offset={offset} onChange={setOffset} />
    </div>
  );
}

function ReservationRowView({
  row,
  portfolio,
  name,
  onDone,
}: {
  row: ReservationRow;
  portfolio: string;
  name: string;
  onDone: () => void;
}) {
  const tx = useWrite();
  const wrongNetwork = useIsWrongNetwork();
  const [queued, setQueued] = useState<string | null>(null);
  const open = OPEN_STATES.has(row.state);

  const tone = row.state === "NEEDS_RECONCILIATION" ? "warn" : open ? "accent" : "neutral";

  return (
    <>
      <tr>
        <td className="hash">{shortHash(row.order_key)}</td>
        <td className="strong">{name}</td>
        <td>{KIND_LABEL[row.kind] ?? `kind ${row.kind}`}</td>
        <td className="num-cell num">{contracts(row.qty_open)}</td>
        <td className="num-cell num">{collateral(row.collateral_reserved)}</td>
        <td>
          <Tag tone={tone}>{row.state.replace(/_/g, " ").toLowerCase()}</Tag>
        </td>
        <td className="caption">{timeAgo(row.updated_at)}</td>
        <td>
          {open ? (
            <TableActions>
              <button
                className="btn btn-outline btn-sm"
                disabled={tx.busy || wrongNetwork}
                title="Ask the contract to re-read the venue and free anything that is gone"
                onClick={async () => {
                  const h = await tx.send({
                    address: portfolio as `0x${string}`,
                    abi: airspacePortfolioAbi,
                    functionName: "releaseOrder",
                    args: [row.order_key as `0x${string}`],
                  });
                  if (h) onDone();
                }}
              >
                {tx.busy ? "…" : "Release"}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                title="Queue a background reconciliation instead of paying gas yourself"
                onClick={async () => {
                  try {
                    const res = await api.requestReconcile({
                      portfolio,
                      orderKey: row.order_key,
                      reason: "user-request",
                    });
                    setQueued(res.deduplicated ? "Already queued" : "Queued");
                  } catch {
                    setQueued("Could not queue");
                  }
                }}
              >
                {queued ?? "Queue"}
              </button>
            </TableActions>
          ) : (
            <span className="dim">—</span>
          )}
        </td>
      </tr>
      {tx.phase !== "idle" ? (
        <tr>
          <td colSpan={8} style={{ paddingTop: 0 }}>
            <TxStatus state={tx} onDismiss={tx.reset} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------

function Positions({ portfolio }: { portfolio: string }) {
  const [offset, setOffset] = useState(0);
  const q = useList<PositionRow>(portfolio, "positions", { limit: 25, offset });
  const rows = q.data?.positions ?? [];

  if (q.isLoading) return <LoadingCard rows={6} />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  if (rows.length === 0) {
    return (
      <Empty title="No positions">
        Filled outcome tokens are held by the portfolio itself, pooled across agents. They appear here once an
        order fills.
      </Empty>
    );
  }

  return (
    <div className="stack">
      <Card>
        <p className="muted">
          Outcome tokens belong to the portfolio, not to the agent that bought them. A matched YES and NO pair
          carries no directional risk, so exposure is the difference between the two sides, never their sum.
        </p>
      </Card>

      <TableWrap>
        <table>
          <thead>
            <tr>
              <th>Market</th>
              <th>Domain</th>
              <th className="num-cell">YES</th>
              <th className="num-cell">NO</th>
              <th className="num-cell">Directional</th>
              <th>State</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <PositionRowView key={p.market_id} row={p} portfolio={portfolio} onDone={() => void q.refetch()} />
            ))}
          </tbody>
        </table>
      </TableWrap>
      <Pager total={q.data?.total ?? 0} limit={25} offset={offset} onChange={setOffset} />
    </div>
  );
}

function PositionRowView({
  row,
  portfolio,
  onDone,
}: {
  row: PositionRow;
  portfolio: string;
  onDone: () => void;
}) {
  const tx = useWrite();
  const wrongNetwork = useIsWrongNetwork();
  const directional = BigInt(row.directional_exposure);

  return (
    <>
      <tr>
        <td className="hash">{marketLabel(row.market_id)}</td>
        <td className="hash">{row.domain_hash ? shortHash(row.domain_hash) : "—"}</td>
        <td className="num-cell num">{contracts(row.yes_balance)}</td>
        <td className="num-cell num">{contracts(row.no_balance)}</td>
        <td className="num-cell num strong">{contracts(directional)}</td>
        <td>
          {row.redeemed ? (
            <Tag tone="neutral">redeemed</Tag>
          ) : row.settled ? (
            <Tag tone="warn">settled</Tag>
          ) : (
            <Tag tone="accent">live</Tag>
          )}
        </td>
        <td className="caption">{timeAgo(row.updated_at)}</td>
        <td>
          {row.settled && !row.redeemed ? (
            <button
              className="btn btn-outline btn-sm"
              disabled={tx.busy || wrongNetwork}
              title="Free the capital this settled market still occupies"
              onClick={async () => {
                const h = await tx.send({
                  address: portfolio as `0x${string}`,
                  abi: airspacePortfolioAbi,
                  functionName: "releaseSettled",
                  args: [row.market_id as `0x${string}`],
                });
                if (h) onDone();
              }}
            >
              {tx.busy ? "…" : "Release settled"}
            </button>
          ) : (
            <span className="dim">—</span>
          )}
        </td>
      </tr>
      {tx.phase !== "idle" ? (
        <tr>
          <td colSpan={8} style={{ paddingTop: 0 }}>
            <TxStatus state={tx} onDismiss={tx.reset} />
          </td>
        </tr>
      ) : null}
    </>
  );
}
