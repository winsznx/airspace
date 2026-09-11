import { test, expect } from "@playwright/test";
import { mockApi, PORTFOLIO } from "./mock-api";

test.describe("Network / Deployment evidence", () => {
  test("shows live-checked chain id, collateral and a recent transaction", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/app/${PORTFOLIO}`);

    await page.getByText("Network / Deployment").click();

    await expect(page.getByText("Verified live")).toBeVisible();
    await expect(page.getByText("Chain ID")).toBeVisible();
    await expect(page.getByText("Factory-pinned collateral (all portfolios)")).toBeVisible();
    await expect(page.getByText("DreamDEX's official Shannon test collateral", { exact: false })).toBeVisible();
    await expect(page.getByText("tUSDC · 6 decimals")).toBeVisible();
    await expect(page.getByText(/paid entirely in native STT/)).toBeVisible();
  });
});
