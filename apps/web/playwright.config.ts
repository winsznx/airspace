import { defineConfig, devices } from "@playwright/test";

/**
 * Browser critical-path suite.
 *
 * Every test intercepts `/api/*` with fixtures from `e2e/mock-api.ts` and,
 * where a wallet is needed, injects a fake EIP-1193 provider from
 * `e2e/mock-wallet.ts`. Nothing here talks to live Shannon or a real Worker —
 * that dependency would make CI flaky against rolling markets, a moved
 * ceiling, or an RPC outage. The live counterpart is `scripts/live-proof.mjs`
 * and its neighbours in `scripts/`.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // A mocked wallet connection still round-trips several `eth_accounts` /
  // `wallet_requestPermissions` calls through wagmi's own retry logic before
  // settling — comfortably under 15s alone, but parallel workers contending
  // for CPU can push that past 20s.
  timeout: 40_000,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5183",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm vite --port 5183 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:5183",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
