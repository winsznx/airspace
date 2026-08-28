import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAccount, useReadContract } from "wagmi";
import { keccak256, toHex } from "viem";
import { airspacePortfolioFactoryAbi } from "@airspace/sdk";
import { useConfig } from "../hooks/config";
import { useWrite } from "../hooks/tx";
import { TxStatus } from "../components/tx";
import { ConnectButton, NetworkGuard, useIsWrongNetwork } from "../wallet";
import { AddressLink, Card, Empty, Notice } from "../components/ui";

/**
 * Portfolio creation.
 *
 * The address is deterministic in (owner, salt), so it is shown before the
 * transaction is signed. Nothing about the portfolio is stored off-chain: the
 * label below is purely a local convenience.
 */
export function CreatePortfolio() {
  const navigate = useNavigate();
  const { address, isConnected } = useAccount();
  const config = useConfig();
  const wrongNetwork = useIsWrongNetwork();
  const tx = useWrite();

  const [label, setLabel] = useState("");
  const salt = keccak256(toHex(label || "airspace-1"));
  const factory = config.data?.factory as `0x${string}` | null | undefined;

  const predicted = useReadContract({
    address: factory ?? undefined,
    abi: airspacePortfolioFactoryAbi,
    functionName: "portfolioFor",
    args: address ? [address, salt] : undefined,
    query: { enabled: Boolean(factory && address) },
  });

  const taken = useReadContract({
    address: factory ?? undefined,
    abi: airspacePortfolioFactoryAbi,
    functionName: "isPortfolio",
    args: predicted.data ? [predicted.data as `0x${string}`] : undefined,
    query: { enabled: Boolean(factory && predicted.data) },
  });

  const alreadyExists = taken.data === true;

  useEffect(() => {
    if (tx.phase === "confirmed" && predicted.data) {
      navigate(`/app/${predicted.data as string}`, { replace: true });
    }
  }, [tx.phase, predicted.data, navigate]);

  if (!isConnected) {
    return (
      <div className="page" style={{ paddingBlock: 40, maxWidth: 620 }}>
        <Empty title="Connect a wallet to create a portfolio" action={<ConnectButton />}>
          You will be the owner. Ownership cannot be transferred by AIRSPACE, and no backend key can act
          on your behalf.
        </Empty>
      </div>
    );
  }

  return (
    <div className="page" style={{ paddingBlock: 40 }}>
      <div style={{ maxWidth: 620 }} className="stack">
        <div>
          <Link className="caption" to="/app">
            ← Portfolios
          </Link>
          <h1 style={{ fontSize: 32, marginTop: 10 }}>New portfolio</h1>
          <p className="muted" style={{ marginTop: 6 }}>
            One capital pool your agents will share. You fund it, you set the ceilings, and you can
            withdraw without anyone's cooperation.
          </p>
        </div>

        <NetworkGuard />

        <Card lg>
          <div className="stack">
            <label className="field">
              <span className="field-label">Label</span>
              <input
                className="input"
                value={label}
                placeholder="airspace-1"
                maxLength={48}
                onChange={(e) => setLabel(e.target.value)}
              />
              <span className="field-hint">
                Used only to derive the salt, so the same label always produces the same address. It is
                never written on chain.
              </span>
            </label>

            <div className="kv">
              <span className="kv-k">Owner</span>
              <span className="kv-v">
                <AddressLink address={address} />
              </span>
            </div>
            <div className="kv">
              <span className="kv-k">Portfolio address</span>
              <span className="kv-v">
                {predicted.data ? <AddressLink address={predicted.data as string} /> : <span className="dim">—</span>}
              </span>
            </div>

            {alreadyExists ? (
              <Notice
                kind="warn"
                title="That address is already deployed"
                action={
                  <Link className="btn btn-outline btn-sm" to={`/app/${predicted.data as string}`}>
                    Open it
                  </Link>
                }
              >
                Change the label to derive a different address.
              </Notice>
            ) : null}

            <TxStatus state={tx} onDismiss={tx.reset} />

            <div className="row">
              <button
                className="btn btn-primary"
                disabled={!factory || !address || tx.busy || wrongNetwork || alreadyExists}
                onClick={() =>
                  void tx.send({
                    address: factory as `0x${string}`,
                    abi: airspacePortfolioFactoryAbi,
                    functionName: "createPortfolio",
                    args: [address as `0x${string}`, salt],
                  })
                }
              >
                {tx.busy ? (
                  <>
                    <span className="spinner" /> Creating
                  </>
                ) : (
                  "Create portfolio"
                )}
              </button>
              <Link className="btn btn-ghost" to="/app">
                Cancel
              </Link>
            </div>
          </div>
        </Card>

        <Card>
          <div className="stat-label" style={{ marginBottom: 10 }}>
            What happens next
          </div>
          <ol className="steps">
            <li>Fund the portfolio with collateral and set its capital base.</li>
            <li>Set the global policy: capital ceiling, order size, price bounds, expiry headroom.</li>
            <li>Set a ceiling on each risk domain you want your agents to trade.</li>
            <li>Register agents with their own limits. Each holds its own key and calls the portfolio directly.</li>
          </ol>
        </Card>
      </div>
    </div>
  );
}
