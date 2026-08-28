import { useAccount, useChainId, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { shannon } from "./lib/chain";
import { shortAddress } from "./lib/format";
import { Notice } from "./components/ui";

/**
 * Wallet connection. Every state a user can actually hit is handled: no wallet
 * installed, rejected connection, wrong network, pending switch.
 */
export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const injected = connectors[0];

  if (isConnected && address) {
    return (
      <button className="btn btn-outline btn-sm" onClick={() => disconnect()} title={address}>
        {shortAddress(address)}
      </button>
    );
  }

  const rejected = error && /rejected|denied|User rejected/i.test(error.message);
  return (
    <div className="row">
      {error ? (
        <span className="caption" style={{ color: rejected ? "var(--graphite)" : "var(--ember)" }}>
          {rejected ? "Connection cancelled" : "Could not connect"}
        </span>
      ) : null}
      <button
        className="btn btn-primary btn-sm"
        disabled={isPending || !injected}
        onClick={() => injected && connect({ connector: injected })}
      >
        {isPending ? (
          <>
            <span className="spinner" /> Connecting
          </>
        ) : (
          "Connect wallet"
        )}
      </button>
    </div>
  );
}

/** Shown whenever the wallet is on the wrong chain. Blocks writes, not reads. */
export function NetworkGuard() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending } = useSwitchChain();

  if (!isConnected || chainId === shannon.id) return null;
  return (
    <Notice
      kind="warn"
      title="Wrong network"
      action={
        <button className="btn btn-primary btn-sm" disabled={isPending} onClick={() => switchChain({ chainId: shannon.id })}>
          {isPending ? "Switching…" : "Switch to Shannon"}
        </button>
      }
    >
      AIRSPACE runs on Somnia Shannon. Switch networks to create a portfolio or change a policy.
    </Notice>
  );
}

export function useIsWrongNetwork(): boolean {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  return isConnected && chainId !== shannon.id;
}
