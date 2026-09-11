import { http } from "wagmi";
import { defineChain } from "viem";
import { connectorsForWallets, getDefaultConfig, type Theme } from "@rainbow-me/rainbowkit";
import { lightTheme } from "@rainbow-me/rainbowkit";
import { createConfig } from "wagmi";
import {
  coinbaseWallet,
  injectedWallet,
  metaMaskWallet,
  rainbowWallet,
  safeWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";

const RPC = "https://dream-rpc.somnia.network";

/** Somnia Shannon. RainbowKit offers to add it to the wallet on connect. */
export const shannon = defineChain({
  id: 50312,
  name: "Somnia Shannon",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: {
    default: { name: "Shannon Explorer", url: "https://shannon-explorer.somnia.network" },
  },
  testnet: true,
});

const APP_NAME = "AIRSPACE";

/**
 * WalletConnect project id.
 *
 * Public by design — it ships in this bundle and identifies the dApp to
 * WalletConnect's relay, it does not authorise anything. It is still an
 * account-bound value, so it comes from the environment rather than being
 * invented here.
 */
const projectId = (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined)?.trim();

/** True when mobile wallets and the QR flow are actually available. */
export const walletConnectEnabled = Boolean(projectId);

/**
 * Wallet list.
 *
 * With a project id this is the full RainbowKit set, including the QR flow that
 * makes mobile wallets work at all.
 *
 * Without one, WalletConnect-backed wallets would render a button that opens a
 * modal and fails, which is worse than not offering them. So they are dropped
 * and only the wallets that connect without a relay are shown: an injected
 * provider, and Coinbase and Safe, which bring their own transports. The UI says
 * which mode it is in rather than leaving a dead option on screen.
 */
const wallets = projectId
  ? [
      { groupName: "Recommended", wallets: [rainbowWallet, metaMaskWallet, coinbaseWallet] },
      { groupName: "More", wallets: [walletConnectWallet, injectedWallet, safeWallet] },
    ]
  : [{ groupName: "Available in this build", wallets: [injectedWallet, coinbaseWallet, safeWallet] }];

export const wagmiConfig = projectId
  ? getDefaultConfig({
      appName: APP_NAME,
      projectId,
      chains: [shannon],
      wallets,
      transports: { [shannon.id]: http(RPC) },
      ssr: false,
    })
  : createConfig({
      chains: [shannon],
      // `connectorsForWallets` still wants the field. Passing an empty string is
      // safe precisely because no WalletConnect-backed wallet is in this list.
      connectors: connectorsForWallets(wallets, { appName: APP_NAME, projectId: "" }),
      transports: { [shannon.id]: http(RPC) },
    });

/**
 * RainbowKit, wearing AIRSPACE's clothes.
 *
 * The modal is the one surface a user meets before they trust the product with
 * a key, so it should not look like a different application bolted on. Every
 * value here is the token from DESIGN.md that the rest of the app already uses.
 */
const base = lightTheme({
  accentColor: "#918df6",
  accentColorForeground: "#ffffff",
  borderRadius: "large",
  fontStack: "system",
  overlayBlur: "small",
});

export const airspaceWalletTheme: Theme = {
  ...base,
  fonts: {
    body: '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  },
  colors: {
    ...base.colors,
    modalBackground: "#ffffff",
    modalBorder: "#e8e8e8",
    modalText: "#181925",
    modalTextSecondary: "#666666",
    modalTextDim: "#999999",
    actionButtonBorder: "#e8e8e8",
    actionButtonBorderMobile: "#e8e8e8",
    actionButtonSecondaryBackground: "#fafafa",
    closeButton: "#666666",
    closeButtonBackground: "#fafafa",
    generalBorder: "#e8e8e8",
    menuItemBackground: "#fafafa",
    profileAction: "#ffffff",
    profileActionHover: "#fafafa",
    profileForeground: "#fafafa",
    selectedOptionBorder: "#918df6",
    connectButtonBackground: "#ffffff",
    connectButtonInnerBackground: "#fafafa",
    connectButtonText: "#181925",
    error: "#ff3e00",
    connectionIndicator: "#33c758",
  },
  radii: {
    ...base.radii,
    actionButton: "9999px",
    connectButton: "9999px",
    menuButton: "9999px",
    modal: "24px",
    modalMobile: "24px",
  },
  shadows: {
    ...base.shadows,
    dialog: "rgba(0, 0, 0, 0.06) 0 1px 3px 0, rgba(0, 0, 0, 0.06) 0 8px 16px 0, rgba(0, 0, 0, 0.02) 0 0 0 1px",
    profileDetailsAction: "rgba(0, 0, 0, 0.08) 0 1px 1px 1px",
    selectedOption: "rgba(145, 141, 246, 0.35) 0 0 0 2px",
    selectedWallet: "rgba(145, 141, 246, 0.35) 0 0 0 2px",
    walletLogo: "rgba(0, 0, 0, 0.08) 0 1px 2px 0",
  },
};

export const explorerTx = (hash: string) => `${shannon.blockExplorers.default.url}/tx/${hash}`;
export const explorerAddress = (addr: string) => `${shannon.blockExplorers.default.url}/address/${addr}`;
