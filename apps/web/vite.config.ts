import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
    rollupOptions: {
      output: {
        // The chain stack is by far the largest dependency and changes on a
        // different cadence to the app, so it gets its own long-lived chunk.
        manualChunks: {
          chain: ["viem", "wagmi"],
          react: ["react", "react-dom", "react-router-dom"],
          query: ["@tanstack/react-query"],
          // Wallet UI changes on RainbowKit's release cadence, not ours, so it
          // gets its own long-lived chunk instead of being invalidated by every
          // app edit. Individual wallet SDKs stay lazy — RainbowKit loads them
          // only when someone picks that wallet.
          wallet: ["@rainbow-me/rainbowkit"],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: true, ws: true } },
  },
});
