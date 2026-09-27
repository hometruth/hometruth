import { expect, test } from "@playwright/test";

test("assigns an existing room, adds a room, and clears an assignment from the switch list", async ({ page }) => {
  let room: string | null = null;
  const rooms = ["Kitchen"];
  const saves: unknown[] = [];
  await page.route("**/api/rooms", (route) => route.fulfill({ json: { rooms, writable: true } }));
  await page.route("**/api/devices/e2e-relay/room", async (route) => {
    const body = route.request().postDataJSON();
    saves.push(body);
    room = body.room;
    if (room && !rooms.includes(room)) rooms.push(room);
    await route.fulfill({ json: { id: "e2e-relay", room } });
  });
  await page.route("**/devices/e2e-relay/settings", async (route) => {
    const response = await route.fetch();
    const html = (await response.text()).replace('data-device-id="e2e-relay" data-room=""', `data-device-id="e2e-relay" data-room="${room ?? ""}"`);
    await route.fulfill({ response, body: html });
  });
  await page.goto("/devices/e2e-relay/settings");
  const picker = page.locator('[data-room-picker][data-device-id="e2e-relay"]');
  const select = picker.getByRole("combobox", { name: "Room", exact: true });
  await expect(select).toBeEnabled();
  await select.selectOption({ label: "Kitchen" });
  await picker.getByRole("button", { name: "Save room" }).click();
  await expect(select).toHaveValue("room:Kitchen");
  await expect(select).toBeEnabled();
  await select.selectOption({ label: "Add room…" });
  await picker.getByLabel("New room").fill("Living Room");
  await picker.getByRole("button", { name: "Save room" }).click();
  await expect(select).toHaveValue("room:Living Room");
  await expect(select).toBeEnabled();
  await select.selectOption({ label: "No room" });
  await picker.getByRole("button", { name: "Save room" }).click();
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue("");
  await expect(select.locator("option")).toHaveText(["No room", "Kitchen", "Living Room", "Add room…"]);
  expect(saves).toEqual([{ room: "Kitchen" }, { room: "Living Room" }, { room: null }]);
});

test("shows save errors and disables room editing on a read-only instance", async ({ page }) => {
  let writable = true;
  await page.route("**/api/rooms", (route) => route.fulfill({ json: { rooms: ["Kitchen"], writable } }));
  await page.route("**/api/devices/e2e-relay/room", (route) => route.fulfill({ status: 409, json: { error: { message: "Could not save configuration" } } }));
  await page.goto("/devices/e2e-relay/settings");
  const picker = page.locator("[data-room-picker]");
  const select = picker.getByRole("combobox", { name: "Room", exact: true });
  await expect(select).toBeEnabled();
  await select.selectOption({ label: "Kitchen" });
  await picker.getByRole("button", { name: "Save room" }).click();
  await expect(picker.getByRole("status")).toHaveText("Could not save configuration");
  await expect(select).toBeEnabled();
  writable = false;
  await page.reload();
  await expect(picker.getByRole("status")).toHaveText("Rooms are read-only on this server");
  await expect(select).toBeDisabled();
  await expect(picker.getByRole("button", { name: "Save room" })).toBeDisabled();
});
