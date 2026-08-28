import { ConnectButton as RainbowConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useChainId } from "wagmi";
import { shannon, walletConnectEnabled } from "./lib/chain";
import { Notice } from "./components/ui";

/**
 * Wallet connection.
 *
 * RainbowKit owns the hard parts — wallet discovery, the QR flow, deep links,
 * recent-wallet memory, the account modal — and AIRSPACE owns how it looks.
 * `ConnectButton.Custom` gives the state and the modal openers without any of
 * RainbowKit's chrome, so the trigger is the same pill button as every other
 * action in the product and the modal is themed from the same tokens.
 *
 * The states below are the ones a user actually reaches. `mounted` is
 * RainbowKit's hydration guard: before it, connection state is unknown, and
 * rendering "Connect wallet" to someone who is already connected is a flash of
 * a lie. It renders inert instead, holding the layout.
 */
export function ConnectButton() {
  return (
    <RainbowConnectButton.Custom>
      {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
        const ready = mounted;
        const connected = ready && account && chain;

        return (
          <div
            className="row"
            style={{ gap: 8 }}
            {...(!ready && { "aria-hidden": true, style: { opacity: 0, pointerEvents: "none" } })}
          >
            {!connected ? (
              <button className="btn btn-primary btn-sm" onClick={openConnectModal} type="button">
                Connect wallet
              </button>
            ) : chain.unsupported ? (
              <button className="btn btn-danger btn-sm" onClick={openChainModal} type="button">
                Wrong network
              </button>
            ) : (
              <>
                {/* Which chain, always visible. This product is chain-specific
                    and a user on the wrong one loses money to a failed send. */}
                <button className="btn btn-ghost btn-sm chain-pill" onClick={openChainModal} type="button">
                  <span className="chain-dot" aria-hidden />
                  <span className="chain-name">{chain.name}</span>
                </button>
                <button className="btn btn-outline btn-sm" onClick={openAccountModal} type="button">
                  {account.displayName}
                </button>
              </>
            )}
          </div>
        );
      }}
    </RainbowConnectButton.Custom>
  );
}

/**
 * Shown whenever the wallet is on the wrong chain. Blocks writes, not reads.
 *
 * Switching goes through RainbowKit's chain modal rather than a bare
 * `switchChain`, because the wallet may not have Shannon configured at all and
 * that modal handles adding it.
 */
export function NetworkGuard() {
  return (
    <RainbowConnectButton.Custom>
      {({ chain, openChainModal, mounted, account }) => {
        if (!mounted || !account || !chain?.unsupported) return null;
        return (
          <Notice
            kind="warn"
            title="Wrong network"
            action={
              <button className="btn btn-primary btn-sm" onClick={openChainModal} type="button">
                Switch to Shannon
              </button>
            }
          >
            AIRSPACE runs on Somnia Shannon. Switch networks to create a portfolio or change a policy.
          </Notice>
        );
      }}
    </RainbowConnectButton.Custom>
  );
}

/**
 * True when a connected wallet is on a chain this app cannot write to.
 *
 * Deliberately false when disconnected: a disconnected user is not on the wrong
 * network, they have no network, and the buttons that consume this already
 * require a connection.
 */
export function useIsWrongNetwork(): boolean {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  return isConnected && chainId !== shannon.id;
}

/**
 * A one-line note when the build has no WalletConnect project id.
 *
 * Without one there is no QR flow, so a phone wallet simply cannot connect.
 * Saying so is better than letting someone hunt for a wallet that was never
 * going to be listed.
 */
export function WalletSupportNote() {
  if (walletConnectEnabled) return null;
  return (
    <p className="caption" style={{ marginTop: 12 }}>
      This build lists browser wallets only. Mobile wallets need a WalletConnect project id, which is set at
      deploy time.
    </p>
  );
}
