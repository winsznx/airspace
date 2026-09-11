import { test, expect } from "@playwright/test";
import { mockApi, PORTFOLIO, portfolioSnapshot } from "./mock-api";
import { installMockWallet } from "./mock-wallet";

test.describe("wallet and network errors", () => {
  test("a superseded-deployment config failure fails loud, not silently", async ({ page }) => {
    await mockApi(page, [
      {
        match: (u) => u.pathname === "/api/config",
        respond: (r) =>
          r.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({
              error: "SUPERSEDED_DEPLOYMENT",
              message: "AIRSPACE_FACTORY resolves to a SUPERSEDED, UNSAFE deployment.",
            }),
          }),
      },
    ]);
    await page.goto("/app");

    await expect(page.getByText(/Could not load this|No factory configured/)).toBeVisible({ timeout: 10_000 });
    // Never a bare portfolio list, and never a silent fallback.
    await expect(page.getByRole("link", { name: "New portfolio" })).toHaveCount(0);
  });

  test("an RPC read failure is shown as delayed, not hidden", async ({ page }) => {
    await mockApi(page, [
      {
        match: (u) => u.pathname === `/api/portfolios/${PORTFOLIO}`,
        respond: (r) =>
          r.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              ...portfolioSnapshot(),
              stale: { since: Date.now() - 60_000, reason: "rpc-unavailable" },
            }),
          }),
      },
    ]);
    await page.goto(`/app/${PORTFOLIO}`);

    await expect(page.getByText("Chain reads are delayed")).toBeVisible({ timeout: 10_000 });
  });

  // See the KNOWN GAP note atop portfolio.spec.ts — the mock wallet's connect
  // handshake never settles, so this cannot reach a connected state today.
  test.fixme("connecting on the wrong chain surfaces the network guard, not a blocked write", async ({ page }) => {
    await mockApi(page);
    await installMockWallet(page, { chainIdHex: "0x1" }); // Ethereum mainnet, not Shannon
    await page.goto(`/app/${PORTFOLIO}/settings`);

    await page.getByRole("button", { name: "Connect wallet" }).first().click();
    await page.getByText("Mock Wallet").click();

    await expect(page.getByText("Wrong network")).toBeVisible({ timeout: 25_000 });
    await expect(page.getByRole("button", { name: "Switch to Shannon" })).toBeVisible();
  });
});
