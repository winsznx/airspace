import { test, expect } from "@playwright/test";
import { mockApi, PORTFOLIO, simulateAdmitted, simulateRefused } from "./mock-api";

test.describe("advisory preview", () => {
  test("the advisory label is visible before any preview is run", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/app/${PORTFOLIO}`);

    await expect(page.getByText("Would this be admitted?")).toBeVisible();
    await expect(page.getByText("Advisory preview")).toBeVisible();
    await expect(page.getByText(/rechecked atomically on-chain/).first()).toBeVisible();
  });

  test("an admitted preview shows the PASS verdict, still labelled advisory", async ({ page }) => {
    await mockApi(page, [
      {
        match: (u) => u.pathname === "/api/intents/simulate",
        respond: (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(simulateAdmitted()) }),
      },
    ]);
    await page.goto(`/app/${PORTFOLIO}`);

    await page.getByRole("button", { name: "Preview admission" }).click();

    await expect(page.getByText("Admitted", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/rechecked atomically on-chain/).first()).toBeVisible();
  });
});

test.describe("portfolio-level rejection", () => {
  test("a domain refusal reads as a normal blocked result, not an app failure", async ({ page }) => {
    await mockApi(page, [
      {
        match: (u) => u.pathname === "/api/intents/simulate",
        respond: (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(simulateRefused()) }),
      },
    ]);
    await page.goto(`/app/${PORTFOLIO}`);

    await page.getByRole("button", { name: "Preview admission" }).click();

    await expect(page.getByText("Blocked", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Blocked by the shared risk envelope")).toBeVisible();
    // The arithmetic that explains WHY, not just that it failed.
    await expect(page.getByText("570", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("500", { exact: false }).first()).toBeVisible();
    // No generic error chrome — this is a decision, not a crash.
    await expect(page.getByText("Something went wrong.")).toHaveCount(0);
  });
});
