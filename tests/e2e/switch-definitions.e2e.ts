import { expect, test } from "@playwright/test";

test("opens a switch definition from Switches and shows its requests and target on mobile", async ({ page }, info) => {
  await page.goto("/switches");
  const row = page.locator('[data-switch-id="e2e-relay"]');
  await row.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/switches\/e2e-relay\/settings#switch-definition$/);
  const definition = page.locator("[data-switch-definition]");
  await expect(definition.getByRole("heading", { name: "Switch definition" })).toBeVisible();
  await expect(definition.locator("dt")).toHaveText(["On", "Off", "Toggle", "Refresh"]);
  for (const command of ["Switch.Set?id=0&on=true", "Switch.Set?id=0&on=false", "Switch.Toggle?id=0", "Switch.GetStatus?id=0"]) await expect(definition).toContainText(command);
  await expect(definition.locator(".definition-source").getByRole("link")).toHaveAttribute("href", "/switches/e2e-relay");
  await page.screenshot({ path: info.outputPath("switch-definition-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath("switch-definition-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await definition.locator(".definition-source").getByRole("link").click();
  await expect(page).toHaveURL(/\/switches\/e2e-relay$/);
});

test("Groups is a top navigation destination with an empty state and a working builder link", async ({ page }) => {
  await page.goto("/switches");
  await page.getByRole("navigation", { name: "Site", exact: true }).getByRole("link", { name: "Groups", exact: true }).click();
  await expect(page).toHaveURL(/\/groups$/);
  await expect(page.getByRole("heading", { name: "Groups", exact: true })).toBeVisible();
  await expect(page.getByText("No groups yet.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Groups", exact: true })).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: "Create group", exact: true }).click();
  await expect(page).toHaveURL(/\/groups\/new$/);
  await expect(page.getByRole("link", { name: "Groups", exact: true })).toHaveAttribute("aria-current", "page");
});
