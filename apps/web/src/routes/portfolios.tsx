import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useAccount, useReadContract } from "wagmi";
import { airspacePortfolioFactoryAbi } from "@airspace/sdk";
import { useConfig } from "../hooks/config";
import { ConnectButton, NetworkGuard, WalletSupportNote } from "../wallet";
import { AddressLink, Card, Empty, ErrorState, LoadingCard, Notice } from "../components/ui";

/**
 * Portfolio index.
 *
 * The list comes from the factory, not the indexer: a portfolio you own is
 * reachable even if the backend has never seen it.
 */
export function Portfolios() {
  const { address, isConnected } = useAccount();
  const config = useConfig();
  const factory = config.data?.factory as `0x${string}` | null | undefined;

  const owned = useReadContract({
    address: factory ?? undefined,
    abi: airspacePortfolioFactoryAbi,
    functionName: "portfoliosOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(factory && address) },
  });

  const list = useMemo(() => (owned.data as readonly `0x${string}`[] | undefined) ?? [], [owned.data]);

  return (
    <div className="page" style={{ paddingBlock: 40 }}>
      <div className="row-between" style={{ marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 32 }}>Your portfolios</h1>
          <p className="muted" style={{ marginTop: 6 }}>
            Each portfolio is one capital pool with one shared risk envelope across its agents.
          </p>
        </div>
        {isConnected ? (
          <Link className="btn btn-primary" to="/app/new">
            New portfolio
          </Link>
        ) : null}
      </div>

      <div className="stack">
        <NetworkGuard />

        {config.isError ? <ErrorState error={config.error} retry={() => void config.refetch()} /> : null}

        {config.data && !factory ? (
          <Notice kind="error" title="No factory configured">
            The service did not return a factory address for chain {config.data.chainId}. Portfolios cannot be
            created or listed until it does.
          </Notice>
        ) : null}

        {!isConnected ? (
          <Empty title="Connect a wallet to continue" action={<ConnectButton />}>
            AIRSPACE reads your portfolios from the factory contract on Somnia Shannon. Nothing is stored
            against your account here.
            <WalletSupportNote />
          </Empty>
        ) : owned.isLoading ? (
          <LoadingCard rows={3} />
        ) : owned.isError ? (
          <ErrorState error={owned.error} retry={() => void owned.refetch()} />
        ) : list.length === 0 ? (
          <Empty
            title="No portfolios yet"
            action={
              <Link className="btn btn-primary" to="/app/new">
                Create your first portfolio
              </Link>
            }
          >
            A portfolio holds the collateral your agents trade with, and enforces the ceilings they all
            share. You stay the owner and can withdraw at any time.
          </Empty>
        ) : (
          <div className="grid grid-2">
            {list.map((p) => (
              <PortfolioCard key={p} address={p} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PortfolioCard({ address }: { address: `0x${string}` }) {
  return (
    <Card>
      <div className="row-between">
        <div className="stack" style={{ gap: 4 }}>
          <div className="stat-label">Portfolio</div>
          <AddressLink address={address} />
        </div>
        <Link className="btn btn-outline btn-sm" to={`/app/${address}`}>
          Open
        </Link>
      </div>
    </Card>
  );
}
