import { expect, test } from "@playwright/test";

test("reference reproduction: checkout charges one item when quantity is two", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Quantity").fill("2");
  await page.getByRole("button", { name: "Complete checkout" }).click();

  await expect(page.getByRole("status")).toHaveText("Charged total: $12.00");
});
