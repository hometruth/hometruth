import { expect, test } from "@playwright/test";
import { elementKey } from "../../src/tags/identity";

const key = elementKey("device", "e2e-relay");
const endpoint = `/api/elements/${key}/tags`;

test("edits Room separately from Tags on controls and settings, and preserves tags when clearing", async ({ page }) => {
  const tag = `reading-${crypto.randomUUID().slice(0, 8)}`;
  expect((await page.request.post(endpoint, { data: { name: "room", value: "Office" } })).ok()).toBe(true);
  expect((await page.request.post(endpoint, { data: { value: tag } })).ok()).toBe(true);
  expect((await page.request.post("/api/tags", { data: { name: "room", value: "Kitchen", color: "#224488", description: "" } })).ok()).toBe(true);
  await page.goto("/switches/e2e-relay");
  const picker = page.locator("[data-room-picker]");
  const select = picker.getByRole("combobox", { name: "Room", exact: true });
  const chips = page.locator("[data-tag-chips]");
  await expect(picker).toHaveCount(1);
  await expect(select).toHaveValue("room:Office");
  await expect(chips.getByRole("link", { name: tag, exact: true })).toBeVisible();
  await expect(chips).not.toContainText("room =");
  const tagInput = page.getByRole("combobox", { name: "Add a tag", exact: true });
  await tagInput.fill("room =");
  await expect(page.getByRole("option", { name: "room = Kitchen", exact: true })).toHaveCount(0);
  await tagInput.press("Escape");

  await select.selectOption({ label: "Kitchen" });
  await picker.getByRole("button", { name: "Save room" }).click();
  await expect(page.locator("[data-room-current]")).toHaveText("Kitchen");
  await page.reload();
  await expect(select).toHaveValue("room:Kitchen");
  await select.selectOption({ label: "Add room…" });
  await picker.getByLabel("New room").fill("Living Room");
  await picker.getByRole("button", { name: "Save room" }).click();
  await expect(select).toHaveValue("room:Living Room");
  await select.selectOption({ label: "No room" });
  await picker.getByRole("button", { name: "Save room" }).click();
  await expect(page.locator("[data-room-current]")).toHaveText("No room");
  await page.goto("/switches/e2e-relay/settings");
  await expect(picker).toHaveCount(1);
  await expect(select).toHaveValue("");
  await expect(chips.getByRole("link", { name: tag, exact: true })).toBeVisible();
  const assigned = await (await page.request.get(endpoint)).json();
  expect(assigned.tags.filter((item: { name: string }) => item.name === "room")).toEqual([]);
  expect((await (await page.request.get("/api/devices/e2e-relay")).json()).room).toBeUndefined();
});

test("a failed room save preserves the assignment and draft for retry", async ({ page }) => {
  expect((await page.request.post(endpoint, { data: { name: "room", value: "Office" } })).ok()).toBe(true);
  await page.goto("/switches/e2e-relay");
  await page.route(`**${endpoint}`, route => route.fulfill({ status: 403, json: { error: { message: "Room editing is not permitted" } } }));
  const picker = page.locator("[data-room-picker]");
  const select = picker.getByRole("combobox", { name: "Room", exact: true });
  await select.selectOption({ label: "Add room…" });
  await picker.getByLabel("New room").fill("Study");
  await picker.getByRole("button", { name: "Save room" }).click();
  await expect(picker.getByRole("status")).toHaveText("Room editing is not permitted");
  await expect(page.locator("[data-room-current]")).toHaveText("Office");
  await expect(select).toBeEnabled();
  await expect(picker.getByLabel("New room")).toHaveValue("Study");
  await expect(picker.getByLabel("New room")).toBeEnabled();
  await expect(picker.getByRole("button", { name: "Save room" })).toBeEnabled();
});
