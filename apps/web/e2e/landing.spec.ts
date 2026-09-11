import { test, expect } from "@playwright/test";
import { mockApi } from "./mock-api";
import { installMockWallet } from "./mock-wallet";

test.describe("landing → connect", () => {
  test("renders the hero and the connect affordance without a wallet", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");

    await expect(page.getByRole("heading", { level: 1 })).toContainText("Your agents can each follow the rules");
    await expect(page.getByRole("link", { name: "Open the control room" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
  });

  test("clicking Connect wallet opens the wallet picker", async ({ page }) => {
    await mockApi(page);
    await installMockWallet(page);
    await page.goto("/");

    await page.getByRole("button", { name: "Connect wallet" }).click();
    // RainbowKit's modal renders the injected mock wallet by name.
    await expect(page.getByText("Mock Wallet")).toBeVisible({ timeout: 10_000 });
  });

  test("the eight-section narrative is present and in order", async ({ page }) => {
    await mockApi(page);
    await page.goto("/");

    const headings = await page.getByRole("heading", { level: 2 }).allTextContents();
    expect(headings.join(" | ")).toContain("Three agents. One ceiling.");
    expect(headings.some((h) => h.includes("idle pots of 500"))).toBe(true);
    expect(headings.some((h) => h.includes("Reservations count before they fill"))).toBe(true);
    expect(headings.some((h) => h.includes("Markets roll"))).toBe(true);
    expect(headings.some((h) => h.includes("owner always has an exit"))).toBe(true);
    expect(headings.some((h) => h.includes("From intent to proof"))).toBe(true);
    expect(headings.some((h) => h.includes("does not claim"))).toBe(true);
  });
});
