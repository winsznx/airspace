import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Disclosure, Tag } from "./ui";

/**
 * Network / Deployment — every claim here is checked live, on load, against
 * the chain, not read from a config file and asserted. See
 * `workers/api/src/index.ts` (`/api/deployment/verify`) for exactly what each
 * row reads and from where.
 */
export function DeploymentVerificationPanel({ portfolio }: { portfolio?: string }) {
  const q = useQuery({
    queryKey: ["deployment-verification", portfolio],
    queryFn: () => api.deploymentVerification(portfolio),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  const data = q.data;

  return (
    <Disclosure
      summary={
        <span className="row" style={{ gap: 8 }}>
          <span>Network / Deployment</span>
          {data ? (
            <Tag tone={data.ok ? "pass" : "fail"}>{data.ok ? "Verified live" : "Check failed"}</Tag>
          ) : q.isLoading ? (
            <span className="caption dim">checking…</span>
          ) : null}
        </span>
      }
    >
      {q.isLoading ? (
        <p className="caption" style={{ margin: 0 }}>
          Reading chain id, collateral, and a recent transaction receipt live…
        </p>
      ) : q.isError || !data ? (
        <p className="caption" style={{ margin: 0, color: "var(--ember)" }}>
          Could not reach the verification endpoint. This does not affect on-chain safety — it is a read-only
          convenience check.
        </p>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          <p className="caption" style={{ margin: 0 }}>
            {data.network.name} (chain {data.network.chainId}) · gas is paid in {data.network.nativeCurrency.symbol}
            , the chain's native token · collateral is {data.collateral.description}
          </p>

          <table className="kv-table">
            <tbody>
              {data.checks.map((chk) => (
                <tr key={chk.key}>
                  <td>{chk.label}</td>
                  <td style={{ textAlign: "right" }}>
                    <span className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                      <Tag tone={chk.pass ? "pass" : "fail"}>{chk.pass ? "PASS" : "FAIL"}</Tag>
                      <span className="hash">{chk.actual ?? chk.error ?? "—"}</span>
                    </span>
                  </td>
                </tr>
              ))}
              {data.collateral.symbolOnChain ? (
                <tr>
                  <td>Collateral symbol() / decimals() on-chain</td>
                  <td style={{ textAlign: "right" }}>
                    {data.collateral.symbolOnChain} · {data.collateral.decimalsOnChain} decimals
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>

          {data.recentTransaction ? (
            <p className="caption" style={{ margin: 0 }}>
              Last confirmed execution:{" "}
              <a className="hash" href={data.explorerTxUrl ?? undefined} target="_blank" rel="noreferrer">
                {data.recentTransaction.hash.slice(0, 14)}…
              </a>{" "}
              in block {data.recentTransaction.blockNumber}, status {data.recentTransaction.status}, gas used{" "}
              {data.recentTransaction.gasUsed} at {(Number(data.recentTransaction.effectiveGasPriceWei) / 1e9).toFixed(2)} gwei —
              paid entirely in native {data.network.nativeCurrency.symbol}, never in the collateral token.
            </p>
          ) : (
            <p className="caption dim" style={{ margin: 0 }}>
              {data.recentTransactionError ?? "No recent transaction found to sample."}
            </p>
          )}
        </div>
      )}
    </Disclosure>
  );
}
