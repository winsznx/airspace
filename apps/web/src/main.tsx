import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { airspaceWalletTheme, shannon, wagmiConfig } from "./lib/chain";
import { App } from "./app";
import "./styles.css";

/**
 * Provider order is fixed by RainbowKit: Wagmi, then react-query, then
 * RainbowKit. Its own stylesheet is imported before ours so our tokens win
 * where the two overlap.
 */

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={airspaceWalletTheme}
          initialChain={shannon}
          appInfo={{
            appName: "AIRSPACE",
            learnMoreUrl: "https://shannon-explorer.somnia.network",
          }}
          modalSize="compact"
        >
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);
