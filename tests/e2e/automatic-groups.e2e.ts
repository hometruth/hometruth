import { expect, test } from "@playwright/test";
import { renderDeviceGroupBuilder, renderSelectedGroupPage } from "../../src/ui/device-group-page";
import { binarySwitchSchema, lightSchema, type AutomaticGroupCriteria } from "../../src/schemas";
import { elementKey } from "../../src/tags/identity";
import type { Tag } from "../../src/tags/model";
import { testPageContext } from "../../src/ui/test-context";

const schemas = [{ id: lightSchema.$id, title: "Light", groupName: "All Lights" }];
const rooms = ["Kitchen", "Office"];
const empty = { members: [], properties: [], actions: [], canSwitch: false, availability: "unknown" };
const matched = { ...empty, availability: "online", members: [{ id: "lamp", name: "Kitchen lamp", availability: "online", properties: { "power.on": false }, page: "/lights/kitchen-lamp" }] };

test("opens a built-in automatic group from Groups", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/device-groups/automatic%3Aswitches", route => route.fulfill({ json: { ...matched, builtIn: true } }));
  await page.goto("/groups");
  await page.getByRole("link", { name: /^All Switches / }).click();
  await expect(page).toHaveURL(/\/groups\/all-switches$/);
  await expect(page.getByRole("heading", { name: "All Switches" })).toBeVisible();
  await expect(page.locator("[data-group-members]")).toContainText("Kitchen lamp");
  await expect(page.getByText("Edit members", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("builds a room and schema group, previews zero and one match, and saves only criteria", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  let saved: Record<string, unknown> | undefined;
  await page.route("**/groups/new?type=automatic", route => route.fulfill({ contentType: "text/html", body: renderDeviceGroupBuilder({ ctx: testPageContext(), devices: [], canCreate: true, rooms, schemas, automatic: true }) }));
  await page.route("**/api/device-groups/preview", route => {
    const selection = route.request().postDataJSON();
    expect(selection.members).toBeUndefined();
    return route.fulfill({ json: selection.criteria.room === "Kitchen" ? matched : empty });
  });
  await page.route("**/api/device-groups", async route => {
    saved = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { id: "kitchen", page: "/groups/kitchen-lights" } });
  });
  await page.route("**/groups/kitchen-lights", route => route.fulfill({ contentType: "text/html", body: renderSelectedGroupPage({ ctx: testPageContext(), group: { id: "kitchen", name: "All Lights in Kitchen", members: ["lamp"], criteria: { room: "Kitchen", schemaId: lightSchema.$id } }, rooms, schemas, canEdit: true }) }));
  await page.route("**/api/device-groups/kitchen", route => route.fulfill({ json: matched }));
  await page.goto("/groups");
  await page.getByRole("link", { name: "Create automatic group", exact: true }).click();
  const save = page.getByRole("button", { name: "Create group", exact: true });
  await expect(save).toBeDisabled();
  await page.getByRole("combobox", { name: "Element type / schema", exact: true }).selectOption(lightSchema.$id);
  await expect(save).toBeEnabled();
  await expect(page.locator("[data-match-count]")).toHaveText("0 matching devices");
  await expect(page.locator("[data-group-members]")).toContainText("No devices match yet.");
  await page.getByRole("combobox", { name: "Room to match", exact: true }).selectOption("Kitchen");
  await expect(page.getByLabel("Group name", { exact: true })).toHaveValue("All Lights in Kitchen");
  await expect(page.locator("[data-match-count]")).toHaveText("1 matching device");
  await expect(page.locator("[data-group-members]")).toContainText("Kitchen lamp");
  await page.screenshot({ path: info.outputPath("automatic-builder-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath("automatic-builder-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await save.click();
  await expect(page).toHaveURL(/\/groups\/kitchen-lights$/);
  expect(saved).toMatchObject({ name: "All Lights in Kitchen", criteria: { room: "Kitchen", schemaId: lightSchema.$id } });
  expect(saved?.members).toBeUndefined();
  await expect(page.getByText("Edit criteria", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("edits and cancels criteria, rejects stale previews, and retains a failed save", async ({ page }) => {
  const group = { id: "kitchen", name: "Kitchen lights", members: ["lamp"], criteria: { room: "Kitchen", schemaId: lightSchema.$id } };
  await page.route("**/groups/kitchen-lights", route => route.fulfill({ contentType: "text/html", body: renderSelectedGroupPage({ ctx: testPageContext(), group, rooms, schemas, canEdit: true }) }));
  await page.route("**/api/device-groups/kitchen", route => route.fulfill({ json: matched }));
  let release: (() => void) | undefined;
  await page.route("**/api/device-groups/preview", async route => {
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ json: empty });
  });
  let saved: unknown;
  await page.route("**/api/device-groups/kitchen/settings", async route => {
    saved = route.request().postDataJSON();
    await route.fulfill({ status: 500, json: { error: { message: "Could not save configuration" } } });
  });
  await page.goto("/groups/kitchen-lights");
  await page.getByText("Edit criteria", { exact: true }).click();
  const editor = page.locator(".group-editor");
  const save = editor.getByRole("button", { name: "Save criteria" });
  await expect(save).toBeDisabled();
  await editor.getByLabel("Room to match").selectOption("Office");
  await expect.poll(() => Boolean(release)).toBe(true);
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  release?.();
  await page.getByText("Edit criteria", { exact: true }).click();
  await expect(editor.getByLabel("Room to match")).toHaveValue("Kitchen");
  await expect(editor.locator("[data-group-preview]")).toBeHidden();
  await expect(save).toBeDisabled();
  await page.unroute("**/api/device-groups/preview");
  await page.route("**/api/device-groups/preview", route => route.fulfill({ json: empty }));
  await editor.getByLabel("Room to match").selectOption("Office");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(editor.locator("[data-group-feedback]")).toHaveText("Could not save configuration");
  expect(saved).toEqual({ criteria: { room: "Office", schemaId: lightSchema.$id } });
  await expect(save).toBeEnabled();
  await expect(editor.getByLabel("Room to match")).toHaveValue("Office");
});

test("builds groups from tags alone or tags plus type, with live previews and UUID criteria", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const suffix = crypto.randomUUID().slice(0, 8);
  const tags: Tag[] = [];
  for (const prefix of ["foo", "bar", "unused"]) {
    const response = await page.request.post("/api/tags", { data: { slug: prefix + suffix, color: "#338877", description: "" } });
    expect(response.status()).toBe(201); tags.push((await response.json()).tag);
  }
  const foo = tags[0]!, bar = tags[1]!, unused = tags[2]!;
  for (const [device, tag] of [["e2e-relay", foo], ["e2e-wyze", foo], ["e2e-relay", bar]] as const) {
    expect((await page.request.post(`/api/elements/${elementKey("device", device)}/tags`, { data: { tagId: tag.id } })).status()).toBe(200);
  }
  let saved: { name: string; criteria: AutomaticGroupCriteria; members?: unknown } | undefined;
  await page.route("**/api/device-groups", async route => {
    saved = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { id: "taggedfixture", page: "/groups/tagged-fixture" } });
  });
  await page.route("**/groups/tagged-fixture", route => route.fulfill({ contentType: "text/html", body: renderSelectedGroupPage({ ctx: testPageContext(), group: { id: "taggedfixture", name: saved!.name, criteria: saved!.criteria, members: ["e2e-relay"] }, tags, canEdit: true, schemas: [{ id: binarySwitchSchema.$id, title: "Binary switch", groupName: "All Switches" }] }) }));
  await page.route("**/api/device-groups/taggedfixture", route => route.fulfill({ json: empty }));
  await page.goto("/groups");
  await page.getByRole("link", { name: "Create automatic group", exact: true }).click();
  const search = page.getByLabel("Find tags", { exact: true });
  const save = page.getByRole("button", { name: "Create group", exact: true });
  await expect(save).toBeDisabled();
  await search.fill("#" + foo.value);
  await page.getByRole("checkbox", { name: "#" + foo.value, exact: true }).check();
  await expect(page.locator("[data-match-count]")).toHaveText("2 matching devices");
  await page.getByRole("combobox", { name: "Element type / schema", exact: true }).selectOption(binarySwitchSchema.$id);
  await expect(page.locator("[data-match-count]")).toHaveText("1 matching device");
  await expect(page.getByLabel("Group name", { exact: true })).toHaveValue("All Switches with #" + foo.value);
  await search.fill(bar.value);
  await expect(page.getByRole("checkbox", { name: "#" + foo.value, exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: "#" + bar.value, exact: true }).check();
  await expect(save).toBeEnabled();
  await search.fill(unused.value);
  await page.getByRole("checkbox", { name: "#" + unused.value, exact: true }).check();
  await expect(page.locator("[data-match-count]")).toHaveText("0 matching devices");
  await page.getByRole("checkbox", { name: "#" + unused.value, exact: true }).uncheck();
  await expect(page.locator("[data-match-count]")).toHaveText("1 matching device");
  await search.clear();
  await page.screenshot({ path: info.outputPath("tag-group-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath("tag-group-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await save.click();
  await expect(page).toHaveURL(/\/groups\/tagged-fixture$/);
  expect(saved!.criteria).toEqual({ tagIds: [foo.id, bar.id].sort(), schemaId: binarySwitchSchema.$id });
  expect(saved!.members).toBeUndefined();
  await page.getByText("Edit criteria", { exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "#" + foo.value, exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "#" + bar.value, exact: true })).toBeChecked();
  expect(errors).toEqual([]);
});

test("editing tag criteria restores canceled selections and saves tag UUIDs", async ({ page }) => {
  const tags = [
    { id: "d91a5ac0-a44b-4b09-bd50-3fa221a4a6e2", name: "", value: "foo", color: "#338877" },
    { id: "840b27cd-5f69-4248-b4c5-c87145157515", name: "", value: "bar", color: "#338877" },
  ];
  let criteria: AutomaticGroupCriteria = { tagIds: [tags[0]!.id] };
  await page.route("**/groups/tag-editor", route => route.fulfill({ contentType: "text/html", body: renderSelectedGroupPage({ ctx: testPageContext(), group: { id: "tageditor", name: "Tag editor", criteria, members: [] }, tags, canEdit: true }) }));
  await page.route("**/api/device-groups/tageditor", route => route.fulfill({ json: empty }));
  await page.route("**/api/device-groups/preview", route => route.fulfill({ json: empty }));
  await page.route("**/api/device-groups/tageditor/settings", async route => {
    criteria = route.request().postDataJSON().criteria;
    await route.fulfill({ json: { id: "tageditor", criteria } });
  });
  await page.goto("/groups/tag-editor");
  await page.getByText("Edit criteria", { exact: true }).click();
  await page.getByRole("checkbox", { name: "#bar", exact: true }).check();
  await page.getByLabel("Find tags", { exact: true }).fill("unmatched");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByText("Edit criteria", { exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "#foo", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "#bar", exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Find tags", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Save criteria", exact: true })).toBeDisabled();
  await page.getByRole("checkbox", { name: "#foo", exact: true }).uncheck();
  await expect(page.getByRole("button", { name: "Save criteria", exact: true })).toBeDisabled();
  await page.getByRole("checkbox", { name: "#bar", exact: true }).check();
  await expect(page.getByRole("button", { name: "Save criteria", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Save criteria", exact: true }).click();
  await expect(page.locator(".group-editor")).not.toHaveAttribute("open", "");
  expect(criteria).toEqual({ tagIds: [tags[1]!.id] });
});
