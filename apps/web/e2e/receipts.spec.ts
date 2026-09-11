import { test, expect } from "@playwright/test";
import { mockApi, PORTFOLIO, INTENT_HASH, refusedReceipt } from "./mock-api";

test.describe("rejected receipt detail", () => {
  test("a refused intent's receipt shows the refusal name and trader-facing copy", async ({ page }) => {
    await mockApi(page, [
      {
        match: (u) => u.pathname === `/api/receipts/${INTENT_HASH}`,
        respond: (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(refusedReceipt()) }),
      },
    ]);
    await page.goto(`/app/${PORTFOLIO}/activity/${INTENT_HASH}`);

    await expect(page.getByText("DOMAIN_RISK_EXCEEDED")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Blocked by the shared risk envelope")).toBeVisible();
    // The domain usage the refusal was measured against, not just a code.
    await expect(page.getByText("570", { exact: false }).first()).toBeVisible();
  });
});
