import { test, expect } from "@playwright/test";
import { mockApi, DOMAIN, PORTFOLIO, reconciliationPending, reconciliationClear, portfolioSnapshot } from "./mock-api";

test.describe("reconciliation-pending state", () => {
  test("pending releases and the over-ceiling explanation are shown, never a bare number", async ({ page }) => {
    await mockApi(page, [
      {
        match: (u) => u.pathname === `/api/portfolios/${PORTFOLIO}` && u.search.includes("domains"),
        respond: (r) =>
          r.fulfill({
            status: 200,
            contentType: "application/json",
            // 570 usage over a 500 ceiling — the over-ceiling explanation must appear.
            body: JSON.stringify(portfolioSnapshot({ usage: "570000000", ceiling: "500000000" })),
          }),
      },
      {
        match: (u) => u.pathname === `/api/portfolios/${PORTFOLIO}/reconciliation`,
        respond: (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(reconciliationPending) }),
      },
    ]);
    await page.goto(`/app/${PORTFOLIO}`);

    await expect(page.getByText("Usage reads over its ceiling")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/temporarily reserve more capacity/).first()).toBeVisible();
    await expect(page.getByText(/^\d+ pending releases?$/)).toBeVisible();

    await page.getByText("Reconciliation evidence").click();
    await expect(page.getByText("Independent worst-case exposure")).toBeVisible();
    await expect(page.getByText("Amount awaiting safe release")).toBeVisible();
  });
});

test.describe("lifecycle-health warning", () => {
  test("a domain near its market cap shows the approaching-capacity warning", async ({ page }) => {
    await mockApi(page, [
      {
        // marketCount comes from the PORTFOLIO SNAPSHOT's domain entry, not
        // the reconciliation summary — the panel is fed both.
        match: (u) => u.pathname === `/api/portfolios/${PORTFOLIO}` && !u.pathname.includes("reconciliation"),
        respond: (r) =>
          r.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              ...portfolioSnapshot(),
              domains: [{ ...portfolioSnapshot().domains[0], marketCount: 45, liveMarkets: 45 }],
            }),
          }),
      },
      {
        match: (u) => u.pathname === `/api/portfolios/${PORTFOLIO}/reconciliation`,
        respond: (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(reconciliationPending) }),
      },
    ]);
    await page.goto(`/app/${PORTFOLIO}`);

    await expect(page.getByText("Approaching capacity")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("45 of 48 markets tracked")).toBeVisible();
  });
});

test.describe("reconcile controls", () => {
  const releasable = {
    order_key: `0x${"aa".repeat(32)}`,
    intent_hash: `0x${"bb".repeat(32)}`,
    agent_address: "0x7273de585311a5139ef83f0f6dbb29f3e57b3389",
    market_id: `0x${"00".repeat(31)}01`,
    pool_address: "0xc09e4a5bdee2899962727125fb5eaeb896798e46",
    market_nonce: 119,
    domain_hash: DOMAIN,
    kind: 0,
    qty_open: "70000000",
    collateral_reserved: "20650000",
    state: "NEEDS_RECONCILIATION",
    releasable: "70000000",
    source_block: 473_500_000,
    updated_at: new Date(Date.now() - 600_000).toISOString(),
  };

  test("Reconcile now is enabled when the contract could release a reservation, and no keeper queue is offered", async ({ page }) => {
    await mockApi(page, [
      {
        match: (u) => u.pathname === `/api/portfolios/${PORTFOLIO}/reconciliation`,
        respond: (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(reconciliationPending) }),
      },
      {
        match: (u) => u.pathname === `/api/portfolios/${PORTFOLIO}/reservations`,
        respond: (r) =>
          r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ reservations: [releasable], total: 1, limit: 100, offset: 0 }) }),
      },
    ]);
    await page.goto(`/app/${PORTFOLIO}`);

    await expect(page.getByText(/^\d+ pending releases?$/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Reconcile now" })).toBeEnabled();
    await expect(page.getByRole("button", { name: /Queue background sweep/ })).toHaveCount(0);
  });

  test("Reconcile now stays disabled when nothing is releasable", async ({ page }) => {
    await mockApi(page, [
      {
        match: (u) => u.pathname === `/api/portfolios/${PORTFOLIO}/reconciliation`,
        respond: (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(reconciliationClear) }),
      },
    ]);
    await page.goto(`/app/${PORTFOLIO}`);

    await expect(page.getByText("Nothing pending release")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Reconcile now" })).toBeDisabled();
  });
});
