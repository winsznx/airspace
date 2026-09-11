import { test, expect } from "@playwright/test";
import { mockApi, PORTFOLIO, reconciliationPending, reconciliationClear, portfolioSnapshot } from "./mock-api";

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

test.describe("recovers after capacity releases", () => {
  test("Reconcile now queues the job and the panel updates to nothing pending", async ({ page }) => {
    let served = 0;
    await mockApi(page, [
      {
        match: (u) => u.pathname === `/api/portfolios/${PORTFOLIO}/reconciliation`,
        respond: (r) => {
          served += 1;
          const body = served === 1 ? reconciliationPending : reconciliationClear;
          return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
        },
      },
      {
        match: (u) => u.pathname === "/api/reconcile/request",
        respond: (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ queued: true, deduplicated: false, kind: "release-order" }) }),
      },
    ]);
    await page.goto(`/app/${PORTFOLIO}`);

    await expect(page.getByText(/^\d+ pending releases?$/)).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Reconcile now" }).click();

    await expect(page.getByText(/queued for the next lifecycle pass|already queued/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Nothing pending release")).toBeVisible({ timeout: 10_000 });
  });
});
