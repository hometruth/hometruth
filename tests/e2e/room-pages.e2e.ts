import { expect, test } from "@playwright/test";

test("Rooms stays separate from Tags through search, creation and rename", async ({ page }) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const room = `Reading ${suffix}`;
  const tag = `reading-${suffix}`;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  expect((await page.request.post("/api/tags", { data: { value: tag, color: "#224488", description: "" } })).ok()).toBe(true);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/tags");
    await page.getByLabel("Find tags", { exact: true }).fill(tag);
    await expect(page.locator("[data-tag-count]")).toHaveText("1 tag");
    await expect(page.locator("[data-tag-rows]")).not.toContainText("room =");
    await page.goto("/rooms");
    await expect(page.getByRole("heading", { name: "Rooms", exact: true })).toBeVisible();
    await page.getByLabel("Find rooms", { exact: true }).fill(tag);
    await expect(page.locator("[data-tag-count]")).toHaveText("0 rooms");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByText("Create room", { exact: true }).first().click();
  await page.getByLabel("Room name", { exact: true }).fill(room);
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/rooms/reading-${suffix}$`));
  await expect(page.getByRole("heading", { name: room, exact: true })).toBeVisible();
  const renamed = `Study ${suffix}`;
  await page.getByLabel("Room name", { exact: true }).fill(renamed);
  await page.getByRole("button", { name: "Save room", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/rooms/study-${suffix}$`));
  expect((await page.request.get(`/rooms/reading-${suffix}`)).status()).toBe(404);
  await page.goto("/rooms");
  await page.getByLabel("Find rooms", { exact: true }).fill(suffix);
  await expect(page.locator("[data-tag-count]")).toHaveText("1 room");
  await expect(page.locator("[data-tag-rows] .row-name")).toHaveText(renamed);
  await page.goto("/tags");
  await page.getByLabel("Find tags", { exact: true }).fill(suffix);
  await expect(page.locator("[data-tag-count]")).toHaveText("1 tag");
  await expect(page.locator("[data-tag-rows]")).not.toContainText(renamed);
  expect(errors).toEqual([]);
});
