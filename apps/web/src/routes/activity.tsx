import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { REFUSAL_NAME } from "@airspace/types";
import { api, type IntentRow } from "../lib/api";
import { useAgents, useList } from "../hooks/portfolio";
import { IndexerHealthBanner } from "../components/indexer-health";
import {
  AddressLink,
  Card,
  Empty,
  ErrorState,
  LoadingCard,
  Notice,
  Pager,
  TableWrap,
  Tag,
  TxLink,
} from "../components/ui";
import { collateral, contracts, marketLabel, probability, shortHash, timeAgo } from "../lib/format";

const KIND_LABEL = ["Buy YES", "Sell YES", "Buy NO", "Sell NO"];
const STATUSES = ["", "ADMITTED", "REFUSED"] as const;

/**
 * The admission feed.
 *
 * Refused intents are first-class rows, not errors hidden behind a filter: a
 * refusal is the product working. The blocking reason is named on every one.
 */
export function Activity() {
  const { address = "" } = useParams();
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("");
  const [agent, setAgent] = useState("");

  const agents = useAgents(address);
  const q = useList<IntentRow>(address, "intents", {
    limit: 25,
    offset,
    ...(status ? { status } : {}),
    ...(agent ? { agent } : {}),
  });

  const rows = q.data?.intents ?? [];
  const nameOf = (a: string) =>
    agents.data?.agents.find((x) => x.address.toLowerCase() === a.toLowerCase())?.displayName ||
    `${a.slice(0, 8)}…`;

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row-between" style={{ flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 24 }}>Activity</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            Every intent this portfolio evaluated, admitted or refused, with the reason.
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <select
            className="input"
            style={{ width: "auto" }}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as (typeof STATUSES)[number]);
              setOffset(0);
            }}
          >
            <option value="">All outcomes</option>
            <option value="ADMITTED">Admitted</option>
            <option value="REFUSED">Refused</option>
          </select>
          <select
            className="input"
            style={{ width: "auto" }}
            value={agent}
            onChange={(e) => {
              setAgent(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All agents</option>
            {(agents.data?.agents ?? []).map((a) => (
              <option key={a.address} value={a.address}>
                {a.displayName || a.address.slice(0, 10)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <IndexerHealthBanner portfolio={address} />

      {q.isLoading ? (
        <LoadingCard rows={6} />
      ) : q.isError ? (
        <ErrorState error={q.error} retry={() => void q.refetch()} />
      ) : rows.length === 0 ? (
        <Empty title={status || agent ? "Nothing matches this filter" : "No intents yet"}>
          {status || agent
            ? "Clear the filters to see everything this portfolio has evaluated."
            : "As soon as a registered agent calls execute, the decision appears here with the gate that decided it."}
        </Empty>
      ) : (
        <>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Agent</th>
                  <th>Order</th>
                  <th className="num-cell">Price</th>
                  <th className="num-cell">Quantity</th>
                  <th>Outcome</th>
                  <th>Reason</th>
                  <th>Tx</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.intent_hash}>
                    <td>
                      <Link className="hash" to={`/app/${address}/activity/${r.intent_hash}`}>
                        {timeAgo(r.created_at)}
                      </Link>
                    </td>
                    <td className="strong">{nameOf(r.agent_address)}</td>
                    <td>{KIND_LABEL[r.kind] ?? `kind ${r.kind}`}</td>
                    <td className="num-cell num">{probability(r.price)}</td>
                    <td className="num-cell num">{contracts(r.quantity)}</td>
                    <td>
                      {r.status === "ADMITTED" ? <Tag tone="pass">Admitted</Tag> : <Tag tone="fail">Refused</Tag>}
                    </td>
                    <td>
                      {r.refusal_code ? (
                        <span className="caption">{REFUSAL_NAME[r.refusal_code] ?? r.refusal_code}</span>
                      ) : (
                        <span className="dim">—</span>
                      )}
                    </td>
                    <td>
                      <TxLink hash={r.tx_hash} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          <Pager total={q.data?.total ?? 0} limit={25} offset={offset} onChange={setOffset} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Receipt detail.
 *
 * Provenance is shown per field: nothing an off-chain worker witnessed is
 * presented as if the contract asserted it.
 */
export function IntentDetail() {
  const { address = "", intentHash = "" } = useParams();
  const q = useQuery({
    queryKey: ["receipt", address, intentHash],
    queryFn: () => api.receipt(intentHash, address),
    retry: false,
  });

  if (q.isLoading) return <LoadingCard rows={8} />;

  if (q.isError) {
    const notFound = (q.error as { status?: number }).status === 404;
    return notFound ? (
      <Empty
        title="No receipt for this intent"
        action={
          <Link className="btn btn-outline" to={`/app/${address}/activity`}>
            Back to activity
          </Link>
        }
      >
        The intent may still be confirming, or the indexer has not caught up yet. The decision itself is on
        chain either way.
      </Empty>
    ) : (
      <ErrorState error={q.error} retry={() => void q.refetch()} />
    );
  }

  const { receipt: r, order, copy, refusalName } = q.data!;
  const refused = r.decision === "REFUSED";
  const before = r.domain_usage_before;
  const after = r.domain_usage_after;
  const side = order ? (KIND_LABEL[order.kind] ?? `kind ${order.kind}`) : null;

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div>
        <Link className="caption" to={`/app/${address}/activity`}>
          ← Activity
        </Link>
        <div className="row" style={{ gap: 10, marginTop: 10, flexWrap: "wrap" }}>
          <h1 style={{ fontSize: 24 }}>
            {order ? `${side} ${contracts(order.quantity)}` : refused ? "Blocked intent" : "Admitted intent"}
          </h1>
          {refused ? <Tag tone="fail">Refused</Tag> : <Tag tone="pass">Admitted</Tag>}
        </div>
        <div className="caption" style={{ marginTop: 6 }}>
          {marketLabel(r.market_id)}
          {order ? <> · requested {probability(order.price)}</> : null} · {shortHash(r.intent_hash)}
        </div>
      </div>

      {refused && copy ? (
        <div className="verdict verdict-blocked stack">
          <div className="verdict-title">{copy.title}</div>
          {before && after ? (
            <div className="equation">
              <span>{contracts(before)}</span>
              <span className="dim">already committed</span>
              <span>+</span>
              <span>{contracts(BigInt(after) - BigInt(before))}</span>
              <span className="dim">requested</span>
              <span>=</span>
              <strong>{contracts(after)}</strong>
            </div>
          ) : null}
          <p className="muted">{copy.detail}</p>
          <p className="caption" style={{ color: "var(--graphite)" }}>
            What you can do: {copy.action}
          </p>
          <span className="caption">
            Refusal code {r.refusal_code} · {refusalName}
          </span>
        </div>
      ) : null}

      {!refused ? (
        <div className="grid grid-3">
          <Card>
            <div className="stat-label">Filled</div>
            <div className="stat-value num">{contracts(r.filled_qty ?? "0")}</div>
            <div className="stat-sub">cost {collateral(r.filled_cost ?? "0")}</div>
          </Card>
          <Card>
            <div className="stat-label">Left resting</div>
            <div className="stat-value num">{contracts(r.resting_qty ?? "0")}</div>
            <div className="stat-sub">reserved {collateral(r.reserve_required ?? "0")}</div>
          </Card>
          <Card>
            <div className="stat-label">Committed after</div>
            <div className="stat-value num">{collateral(r.committed_after ?? "0")}</div>
            <div className="stat-sub">measured from chain state</div>
          </Card>
        </div>
      ) : null}

      {!refused && order?.orderId ? (
        <Notice kind="info" title="Resulting DreamDEX order">
          Placed on the pool as order <span className="hash">{order.orderId}</span> at{" "}
          <AddressLink address={order.poolAddress} />. This is the same order id AIRSPACE tracks for release and
          reconciliation.
        </Notice>
      ) : null}

      <div className="grid grid-2">
        <Card lg>
          <div className="stat-label" style={{ marginBottom: 10 }}>
            Intent
          </div>
          <div className="kv">
            <span className="kv-k">Agent</span>
            <span className="kv-v">
              <AddressLink address={r.agent_address} />
            </span>
          </div>
          <div className="kv">
            <span className="kv-k">Market</span>
            <span className="kv-v hash">{marketLabel(r.market_id)}</span>
          </div>
          <div className="kv">
            <span className="kv-k">Risk domain</span>
            <span className="kv-v hash">{r.domain_hash ? shortHash(r.domain_hash) : "—"}</span>
          </div>
          <div className="kv">
            <span className="kv-k">Transaction</span>
            <span className="kv-v">
              <TxLink hash={r.tx_hash} />
            </span>
          </div>
          <div className="kv">
            <span className="kv-k">Block</span>
            <span className="kv-v num">{r.block_number ?? "—"}</span>
          </div>
        </Card>

        <Card lg>
          <div className="stat-label" style={{ marginBottom: 10 }}>
            Policy in force at decision time
          </div>
          <div className="kv">
            <span className="kv-k">Global policy hash</span>
            <span className="kv-v hash">{r.global_policy_hash ? shortHash(r.global_policy_hash) : "—"}</span>
          </div>
          <div className="kv">
            <span className="kv-k">Agent policy hash</span>
            <span className="kv-v hash">{r.agent_policy_hash ? shortHash(r.agent_policy_hash) : "—"}</span>
          </div>
          <div className="kv">
            <span className="kv-k">Domain usage before</span>
            <span className="kv-v num">{before ? contracts(before) : "—"}</span>
          </div>
          <div className="kv">
            <span className="kv-k">Domain usage after</span>
            <span className="kv-v num">{after ? contracts(after) : "—"}</span>
          </div>
          <div className="kv">
            <span className="kv-k">Directional exposure</span>
            <span className="kv-v num">
              {r.directional_before ? contracts(r.directional_before) : "—"} →{" "}
              {r.directional_after ? contracts(r.directional_after) : "—"}
            </span>
          </div>
        </Card>
      </div>

      <Provenance provenance={r.provenance} />
    </div>
  );
}

/**
 * Where each field came from.
 *
 * A value the contract emitted and a value a worker observed are not the same
 * kind of claim, so they are never rendered as if they were.
 */
function Provenance({ provenance }: { provenance: Record<string, string> }) {
  const entries = Object.entries(provenance ?? {});
  if (entries.length === 0) {
    return (
      <Notice kind="info" title="No provenance recorded for this receipt">
        Everything above came straight from the contract's own event. Nothing was inferred off chain.
      </Notice>
    );
  }
  return (
    <Card lg>
      <div className="stat-label" style={{ marginBottom: 10 }}>
        Provenance
      </div>
      <p className="muted" style={{ marginBottom: 12 }}>
        Contract-asserted values are enforced. Observed values were read by a worker and are not part of the
        decision.
      </p>
      {entries.map(([field, source]) => (
        <div className="kv" key={field}>
          <span className="kv-k">{field}</span>
          <span className="kv-v">
            <Tag tone={source === "contract" ? "pass" : source === "observed" ? "warn" : "neutral"}>{source}</Tag>
          </span>
        </div>
      ))}
    </Card>
  );
}
