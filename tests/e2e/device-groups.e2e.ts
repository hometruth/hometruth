import { expect, test } from "@playwright/test";
import { renderSelectedGroupPage } from "../../src/ui/device-group-page";
import { renderSwitchesPage } from "../../src/ui/switches-page";
import { testPageContext } from "../../src/ui/test-context";
import type { RegisteredDevice } from "../../src/site";

const memberDevices: RegisteredDevice[] = [
  ["e2e-relay", "Left Key Light Air"], ["e2e-wyze", "Right Key Light Air"], ["e2e-camera", "Spare light"],
].map(([id, name]) => ({ id: id!, name: name!, kind: "light", model: "test-light", modelTitle: "Test light", capabilities: ["light"], host: "", page: `/devices/${id}`, schemaId: "test:light", room: "Office", enabled: true }));

function memberSnapshot(ids: string[]) {
  const value = snapshot(true, 70);
  return { ...value, members: ids.map(id => ({ ...value.members[0]!, id, name: memberDevices.find(device => device.id === id)!.name })) };
}

function snapshot(on = false, brightness = 30) {
  return {
    availability: "online",
    canSwitch: true,
    members: [
      { id: "e2e-relay", name: "Left Key Light Air", page: "/switches/e2e-relay", availability: "online", properties: { "power.on": true, "light.brightnessPercent": 70, "light.colorTemperatureKelvin": 4000 } },
      { id: "e2e-wyze", name: "Right Key Light Air", page: "/cameras/e2e-wyze-cam-v3", availability: "online", properties: { "power.on": on, "light.brightnessPercent": brightness, "light.colorTemperatureKelvin": 4000 } },
    ],
    properties: [
      { id: "power.on", status: on ? "shared" : "mixed", ...(on ? { value: true } : {}) },
      { id: "light.brightnessPercent", status: brightness === 70 ? "shared" : "mixed", ...(brightness === 70 ? { value: 70 } : {}) },
      { id: "light.colorTemperatureKelvin", status: "shared", value: 4000 },
    ],
    actions: [
      { id: "power.turnOn", control: "turnOn", input: "none", bounds: {}, confirmation: false },
      { id: "power.turnOff", control: "turnOff", input: "none", bounds: {}, confirmation: false },
      { id: "power.toggle", control: "toggle", input: "none", bounds: {}, confirmation: false },
      { id: "light.setBrightness", control: "setBrightness", input: "number", bounds: { minimumPercent: 0, maximumPercent: 100 }, confirmation: false },
      { id: "light.setColorTemperature", control: "setColorTemperature", input: "number", bounds: { minimumKelvin: 2900, maximumKelvin: 7000 }, confirmation: false },
    ],
  };
}

test("selects devices, previews differences, saves, and controls the group", async ({ page }, info) => {
  const saves: Record<string, unknown>[] = [];
  const commands: unknown[] = [];
  let current = snapshot();
  await page.route("**/api/device-groups/preview", async route => {
    expect(route.request().postDataJSON().members).toEqual(["e2e-relay", "e2e-wyze"]);
    await route.fulfill({ json: current });
  });
  await page.route("**/api/device-groups", async route => {
    saves.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: { id: "desk", page: "/groups/desk" } });
  });
  await page.route("**/groups/desk", route => route.fulfill({ contentType: "text/html", body: renderSelectedGroupPage({ ctx: testPageContext(), group: { id: "desk", name: "Desk lights", members: ["e2e-relay", "e2e-wyze"] } }) }));
  await page.route("**/api/device-groups/desk", route => route.fulfill({ json: current }));
  await page.route("**/api/device-groups/desk/controls/*", async route => {
    commands.push({ control: new URL(route.request().url()).pathname.split("/").pop(), ...route.request().postDataJSON() });
    current = snapshot(true, 70);
    await route.fulfill({ json: { ok: true, results: current.members.map(member => ({ id: member.id, ok: true })), group: current } });
  });
  await page.goto("/");
  await page.getByRole("link", { name: "Create group", exact: true }).click();
  await page.getByLabel("Group name", { exact: true }).fill("Desk lights");
  const save = page.getByRole("button", { name: "Create group", exact: true });
  await expect(save).toBeDisabled();
  await page.locator('input[name="members"][value="e2e-relay"]').check();
  await expect(save).toBeDisabled();
  await page.locator('input[name="members"][value="e2e-wyze"]').check();
  await expect(save).toBeEnabled();
  await expect(page.getByRole("heading", { name: "Shared controls" })).toBeVisible();
  await expect(page.getByRole("row", { name: "Power Mixed On Off", exact: true })).toBeVisible();
  await expect(page.getByRole("row", { name: "Brightness (%) Mixed 70 30", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("group-builder.png"), fullPage: true });
  await save.click();
  await expect(page).toHaveURL(/\/groups\/desk$/);
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({ name: "Desk lights", members: ["e2e-relay", "e2e-wyze"] });
  await expect(page.getByRole("button", { name: "On", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("group-desktop.png"), fullPage: true });
  await expect(page.getByRole("heading", { name: "Shared methods" })).toHaveCount(0);
  await page.getByRole("button", { name: "On", exact: true }).click();
  await expect(page.locator("[data-group-feedback]")).toHaveText("Applied to every member");
  await expect(page.getByRole("row", { name: "Power On On On", exact: true })).toBeVisible();
  await page.getByLabel("Set brightness", { exact: true }).fill("70");
  await page.getByRole("button", { name: "Set brightness", exact: true }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands).toEqual([{ control: "power.turnOn" }, { control: "light.setBrightness", value: 70 }]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath("group-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("discards stale previews and keeps create disabled after deselection or a failed preview", async ({ page }) => {
  let release: (() => void) | undefined;
  let started = false;
  await page.route("**/api/device-groups/preview", async route => {
    started = true;
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ json: snapshot() });
  });
  await page.goto("/groups/new");
  const left = page.locator('input[name="members"][value="e2e-relay"]');
  const right = page.locator('input[name="members"][value="e2e-wyze"]');
  const save = page.getByRole("button", { name: "Create group", exact: true });
  await left.check(); await right.check();
  await expect.poll(() => started).toBe(true);
  await right.uncheck(); release?.();
  await expect(page.locator("[data-group-feedback]")).toHaveText("Select at least two devices");
  await expect(save).toBeDisabled();
  await expect(page.locator("[data-group-preview]")).toBeHidden();
  await page.unroute("**/api/device-groups/preview");
  await page.route("**/api/device-groups/preview", route => route.fulfill({ status: 400, json: { error: { message: "Device was removed" } } }));
  await right.check();
  await expect(page.locator("[data-group-feedback]")).toHaveText("Device was removed");
  await expect(save).toBeDisabled();
});

test("edits saved members, searches without losing selections, and refreshes the saved group", async ({ page }, info) => {
  const group = { id: "desk", name: "Desk lights", members: ["e2e-relay", "e2e-wyze"], room: "Office", asSwitch: true };
  const saves: unknown[] = [];
  await page.route("**/groups/desk", route => route.fulfill({ contentType: "text/html", body: renderSelectedGroupPage({ ctx: testPageContext(), group, devices: memberDevices, canEdit: true }) }));
  await page.route("**/api/device-groups/desk", route => route.fulfill({ json: memberSnapshot(group.members) }));
  await page.route("**/api/rooms", route => route.fulfill({ json: { rooms: ["Office"], writable: true } }));
  await page.route("**/api/device-groups/preview", route => route.fulfill({ json: memberSnapshot(route.request().postDataJSON().members) }));
  await page.route("**/api/device-groups/desk/settings", async route => {
    const change = route.request().postDataJSON(); saves.push(change); Object.assign(group, change);
    await route.fulfill({ json: { id: group.id, ...change } });
  });
  await page.goto("/groups/desk");
  const editor = page.locator(".group-editor");
  const save = editor.getByRole("button", { name: "Save members" });
  await page.getByText("Edit members", { exact: true }).click();
  await expect(page.locator("[data-live-group]")).toBeHidden();
  await expect(editor.locator('input[name="members"]:checked')).toHaveCount(2);
  await expect(save).toBeDisabled();
  await editor.getByLabel("Find devices").fill("Spare");
  await expect(editor.locator(".group-choice:visible")).toHaveCount(1);
  await editor.locator('input[value="e2e-camera"]').check();
  await expect(editor.locator("[data-member-count]")).toHaveText("3 devices selected");
  await expect(save).toBeEnabled();
  await editor.getByLabel("Find devices").fill("");
  await editor.locator('input[value="e2e-wyze"]').uncheck();
  await expect(save).toBeEnabled();
  await expect(editor.locator("[data-group-properties] tbody")).toContainText("Spare light");
  await expect(editor.locator("[data-group-properties] tbody")).not.toContainText("Right Key Light Air");
  await page.screenshot({ path: info.outputPath("edit-members-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath("edit-members-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await save.click();
  await expect(editor).not.toHaveAttribute("open");
  expect(saves).toEqual([{ members: ["e2e-relay", "e2e-camera"] }]);
  await expect(page.locator("[data-live-group]")).toBeVisible();
  await expect(page.getByLabel("Room", { exact: true })).toHaveValue("room:Office");
  await expect(page.getByRole("checkbox", { name: "Show on Switches" })).toBeChecked();
  await page.getByText("Edit members", { exact: true }).click();
  await expect(editor.locator('input[value="e2e-camera"]')).toBeChecked();
  await expect(editor.locator('input[value="e2e-wyze"]')).not.toBeChecked();
});

test("warns when edited members lose switch support, retains failed saves, and cancels cleanly", async ({ page }) => {
  const group = { id: "desk", name: "Desk lights", members: ["e2e-relay", "e2e-wyze"], asSwitch: true };
  let saves = 0;
  await page.route("**/groups/desk", route => route.fulfill({ contentType: "text/html", body: renderSelectedGroupPage({ ctx: testPageContext(), group, devices: memberDevices, canEdit: true }) }));
  await page.route("**/api/device-groups/desk", route => route.fulfill({ json: snapshot() }));
  await page.route("**/api/device-groups/preview", route => route.fulfill({ json: { ...memberSnapshot(route.request().postDataJSON().members), canSwitch: false } }));
  await page.route("**/api/device-groups/desk/settings", async route => { saves++; await route.fulfill({ status: 500, json: { error: { message: "Could not save configuration" } } }); });
  await page.goto("/groups/desk");
  const editor = page.locator(".group-editor");
  const save = editor.getByRole("button", { name: "Save members" });
  await page.getByText("Edit members", { exact: true }).click();
  await editor.locator('input[value="e2e-camera"]').check();
  await expect(editor.locator("[data-group-feedback]")).toContainText("Saving will remove this group from Switches");
  await save.click();
  await expect(editor.locator("[data-group-feedback]")).toHaveText("Could not save configuration");
  await expect(save).toBeEnabled();
  await expect(editor.locator('input[value="e2e-camera"]')).toBeChecked();
  await editor.getByLabel("Find devices").fill("Spare");
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("[data-live-group]")).toBeVisible();
  await page.getByText("Edit members", { exact: true }).click();
  await expect(editor.getByLabel("Find devices")).toBeEmpty();
  await expect(editor.locator('input[value="e2e-camera"]')).not.toBeChecked();
  await expect(editor.locator('input[name="members"]:checked')).toHaveCount(2);
  await expect(editor.locator("[data-group-preview]")).toBeHidden();
  await expect(save).toBeDisabled();
  await editor.locator('input[value="e2e-wyze"]').uncheck();
  await expect(editor.locator("[data-group-feedback]")).toHaveText("Select at least two devices");
  await expect(save).toBeDisabled();
  expect(saves).toBe(1);
});

test("keeps member editing read-only when configuration is not writable", async ({ page }) => {
  await page.route("**/groups/desk", route => route.fulfill({ contentType: "text/html", body: renderSelectedGroupPage({ ctx: testPageContext(), group: { id: "desk", name: "Desk lights", members: ["e2e-relay", "e2e-wyze"] }, devices: memberDevices, canEdit: false }) }));
  await page.route("**/api/device-groups/desk", route => route.fulfill({ json: snapshot() }));
  await page.goto("/groups/desk");
  await page.getByText("Edit members", { exact: true }).click();
  const editor = page.locator(".group-editor");
  for (const checkbox of await editor.getByRole("checkbox").all()) await expect(checkbox).toBeDisabled();
  await expect(editor.getByRole("button", { name: "Save members" })).toBeDisabled();
});

test("shows each member's command failure while retaining mixed readings", async ({ page }) => {
  await page.route("**/groups/desk", route => route.fulfill({ contentType: "text/html", body: renderSelectedGroupPage({ ctx: testPageContext(), group: { id: "desk", name: "Desk lights", members: ["e2e-relay", "e2e-wyze"] } }) }));
  await page.route("**/api/device-groups/desk", route => route.fulfill({ json: snapshot() }));
  await page.route("**/api/device-groups/desk/controls/*", route => route.fulfill({ json: { ok: false, group: snapshot(), results: [{ id: "e2e-relay", name: "Left Key Light Air", ok: true }, { id: "e2e-wyze", name: "Right Key Light Air", ok: false, error: "Device unreachable" }] } }));
  await page.goto("/groups/desk");
  await page.getByRole("button", { name: "On", exact: true }).click();
  await expect(page.locator("[data-group-feedback]")).toContainText("Left Key Light Air: Succeeded");
  await expect(page.locator("[data-group-feedback]")).toContainText("Right Key Light Air: Device unreachable");
  await expect(page.getByRole("row", { name: "Power Mixed On Off", exact: true })).toBeVisible();
});


test("saves group room and switch settings and links shared-property members on desktop and mobile", async ({ page }, info) => {
  const group = { id: "desk", name: "Desk lights", members: ["e2e-relay", "e2e-wyze"], room: "", asSwitch: false };
  const settings: unknown[] = [];
  await page.route("**/groups/desk", route => route.fulfill({ contentType: "text/html", body: renderSelectedGroupPage({ ctx: testPageContext(), group, canEdit: true }) }));
  await page.route("**/api/rooms", route => route.fulfill({ json: { rooms: ["Office", "Kitchen"], writable: false } }));
  await page.route("**/api/device-groups/desk", route => route.fulfill({ json: { ...group, ...snapshot() } }));
  await page.route("**/api/device-groups/desk/settings", async route => {
    const change = route.request().postDataJSON();
    settings.push(change);
    Object.assign(group, change);
    await route.fulfill({ json: { id: group.id, ...change } });
  });
  await page.goto("/groups/desk");
  const table = page.locator("[data-group-properties]");
  const left = table.getByRole("link", { name: "Left Key Light Air", exact: true });
  await expect(left).toBeVisible();
  await expect(left).toHaveAttribute("href", "/switches/e2e-relay");
  await expect(left).toHaveCSS("text-decoration-line", "none");
  expect(await left.evaluate(node => getComputedStyle(node).color === getComputedStyle(node.parentElement!).color)).toBe(true);
  await expect(page.getByRole("heading", { name: "Shared methods" })).toHaveCount(0);
  await page.getByLabel("Room", { exact: true }).selectOption("room:Office");
  await page.getByRole("button", { name: "Save room", exact: true }).click();
  await expect(page.getByLabel("Room", { exact: true })).toHaveValue("room:Office");
  await page.getByRole("checkbox", { name: "Show on Switches" }).check();
  await page.getByRole("button", { name: "Save switch setting" }).click();
  await expect(page.getByRole("checkbox", { name: "Show on Switches" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Show on Switches" })).toBeEnabled();
  expect(settings).toEqual([{ room: "Office" }, { asSwitch: true }]);
  await page.screenshot({ path: info.outputPath("group-settings-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLeft = table.locator("tbody").getByRole("link", { name: "Left Key Light Air", exact: true }).first();
  await expect(mobileLeft).toBeVisible();
  await expect(mobileLeft).toHaveCSS("text-decoration-line", "none");
  await page.screenshot({ path: info.outputPath("group-settings-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await mobileLeft.click();
  await expect(page).toHaveURL(/\/switches\/e2e-relay$/);
});

test("disables incompatible group switches and keeps failed settings editable", async ({ page }) => {
  await page.route("**/groups/desk", route => route.fulfill({ contentType: "text/html", body: renderSelectedGroupPage({ ctx: testPageContext(), group: { id: "desk", name: "Desk lights", members: ["e2e-relay", "e2e-wyze"] }, canEdit: true }) }));
  let compatible = false;
  await page.route("**/api/device-groups/desk", route => route.fulfill({ json: { ...snapshot(), canSwitch: compatible } }));
  await page.route("**/api/device-groups/desk/settings", route => route.fulfill({ status: 500, json: { error: { message: "Could not save configuration" } } }));
  await page.goto("/groups/desk");
  await expect(page.locator("[data-group-switch-hint]")).toContainText("A group needs shared power state");
  await expect(page.getByRole("checkbox", { name: "Show on Switches" })).toBeDisabled();
  compatible = true;
  await page.getByRole("button", { name: "Refresh states" }).click();
  await page.getByRole("checkbox", { name: "Show on Switches" }).check();
  await page.getByRole("button", { name: "Save switch setting" }).click();
  await expect(page.locator("[data-group-switch-feedback]")).toHaveText("Could not save configuration");
  await expect(page.getByRole("checkbox", { name: "Show on Switches" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Save switch setting" })).toBeEnabled();
});

test("an enabled group can be removed from Switches after losing compatibility", async ({ page }) => {
  await page.route("**/groups/desk", route => route.fulfill({ contentType: "text/html", body: renderSelectedGroupPage({ ctx: testPageContext(), group: { id: "desk", name: "Desk lights", members: ["e2e-relay", "e2e-wyze"], asSwitch: true }, canEdit: true }) }));
  await page.route("**/api/device-groups/desk", route => route.fulfill({ json: { ...snapshot(), canSwitch: false } }));
  let saved: unknown;
  await page.route("**/api/device-groups/desk/settings", async route => { saved = route.request().postDataJSON(); await route.fulfill({ json: saved }); });
  await page.goto("/groups/desk");
  await page.getByRole("checkbox", { name: "Show on Switches" }).uncheck();
  await page.getByRole("button", { name: "Refresh states" }).click();
  await expect(page.getByRole("button", { name: "Save switch setting" })).toBeEnabled();
  await page.getByRole("button", { name: "Save switch setting" }).click();
  await expect.poll(() => saved).toEqual({ asSwitch: false });
});

test("the Switches page shows mixed group power and dispatches its switch controls", async ({ page }) => {
  const group = { id: "desk", name: "Desk lights", members: ["e2e-relay", "e2e-wyze"], room: "Office", asSwitch: true };
  const commands: string[] = [];
  let state = { state: { availability: "online", value: "" }, mixed: true };
  await page.route("**/switches", route => route.fulfill({ contentType: "text/html", body: renderSwitchesPage({ ctx: testPageContext(), switches: [], groups: [group], buttons: [], canCreate: false }) }));
  await page.route("**/api/device-groups/desk/switch", route => route.fulfill({ json: state }));
  await page.route("**/api/device-groups/desk/switch/*", async route => {
    const action = route.request().url().split("/").pop()!;
    commands.push(action);
    state = { state: { availability: "online", value: action === "turn-off" ? "off" : "on" }, mixed: false };
    await route.fulfill({ json: state });
  });
  await page.goto("/switches");
  const row = page.locator('[data-switch-id="desk"]');
  await expect(row.getByRole("link", { name: "Desk lights" })).toHaveAttribute("href", "/switches/desk-lights");
  await expect(row).toContainText("Office");
  await expect(row.locator("ht-switch-row [part~=value]")).toHaveText("Mixed");
  for (const [button, state] of [["Toggle", "On"], ["Off", "Off"], ["On", "On"]] as const) {
    await row.getByRole("button", { name: button, exact: true }).click();
    await expect(row.locator("ht-switch-row [part~=value]")).toHaveText(state);
  }
  expect(commands).toEqual(["toggle", "turn-off", "turn-on"]);
});
