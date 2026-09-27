import { expect, test } from "@playwright/test";
import { renderGroupSwitchPage } from "../../src/ui/group-switch-page";
import { testPageContext } from "../../src/ui/test-context";
import type { RegisteredDevice } from "../../src/site";
import type { GroupSwitch, NodeRecord } from "../../src/state/protocol";

test("a group switch reads its node from the state stream, commands its group API, and exposes source, member, and settings links", async ({ page }, info) => {
  const group = { id: "kitchen-lights-a357dc17", name: "Kitchen Lights", members: ["e2e-relay"], asSwitch: true, page: "/groups/kitchen-lights", switchPage: "/switches/kitchen-lights" };
  const node = `group/${group.id}` as const;
  const members: RegisteredDevice[] = [{ id: "e2e-relay", name: "Kitchen circuit", kind: "binary-switch", model: "shelly-plus-1", modelTitle: "Shelly", capabilities: ["binarySwitch"], host: "", page: "/switches/e2e-relay", schemaId: "test:switch", enabled: true }];
  const commands: string[] = [], errors: string[] = [];
  let reads = 0, streams = 0;
  page.on("pageerror", error => errors.push(error.message));

  // The group's document as the graph would publish it: Mixed until the first command, then the commanded value.
  let value: "on" | "off" | undefined;
  const groupDocument = (): GroupSwitch => ({
    id: group.id, name: group.name, status: "online",
    capabilities: { binarySwitch: { id: group.id, state: { availability: "online", ...(value ? { value, observedAt: new Date().toISOString() } : {}) }, actions: { turnOn: {}, turnOff: {}, toggle: {}, getState: {} } } },
    group: { mixed: !value, canSwitch: true, members: [{ id: "e2e-relay", name: "Kitchen circuit", availability: "online", properties: {} }] },
  });
  const record = (): NodeRecord => ({ node, version: commands.length + 1, value: groupDocument(), observedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  // One stream per page, `?node=…&tier=live`; every (re)connect gets hello plus a snapshot. A short retry makes the browser reconnect fast once the body ends.
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  await page.route("**/api/state/stream**", async route => {
    const url = new URL(route.request().url());
    expect(url.searchParams.getAll("node")).toEqual([node]);
    expect(url.searchParams.get("tier")).toBe("live");
    streams++;
    await route.fulfill({ contentType: "text/event-stream", body: `retry: 100\n\n${frame("hello", { generation: "e2e", tier: "live", nodes: [node], keepaliveMs: 20000 })}${frame("state", record())}` });
  });

  const options = { ctx: testPageContext(), group, members, definition: '<section data-switch-definition>Group switch definition</section>' };
  await page.route("**/switches/kitchen-lights", route => route.fulfill({ contentType: "text/html", body: renderGroupSwitchPage(options) }));
  await page.route("**/switches/kitchen-lights/settings", route => route.fulfill({ contentType: "text/html", body: renderGroupSwitchPage({ ...options, settingsView: true }) }));
  await page.route("**/api/device-groups/kitchen-lights-a357dc17/switch**", async route => {
    const action = new URL(route.request().url()).pathname.split("/").pop()!;
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({});
      commands.push(action);
      value = action === "turn-off" ? "off" : "on";
    } else reads++;
    await route.fulfill({ json: { state: groupDocument().capabilities.binarySwitch.state, mixed: !value } });
  });

  await page.goto(group.switchPage);
  const element = page.locator(`ht-switch[node="${node}"]`);
  await expect(element.locator("[part~=value]")).toHaveText("Mixed");
  await expect(page.locator("[data-switch-source]")).toHaveText("Switch based on group: Kitchen Lights");
  await expect(page.locator("[data-switch-source] a")).toHaveAttribute("href", group.page);
  await expect(page.getByRole("link", { name: "Kitchen circuit" })).toHaveAttribute("href", "/switches/e2e-relay");
  expect(commands).toEqual([]);
  expect(reads).toBe(0);
  for (const [label, state] of [["On", "On"], ["Off", "Off"], ["Toggle", "On"]]) {
    await element.getByRole("button", { name: label!, exact: true }).click();
    await expect(element.locator("[part~=value]")).toHaveText(state!);
  }
  // Refresh is the schema's getState: a GET of the group switch route, then the stream carries the reading.
  await element.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => reads).toBe(1);
  expect(commands).toEqual(["turn-on", "turn-off", "toggle"]);
  expect(streams).toBeGreaterThan(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("group-switch-mobile.png"), fullPage: true });
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/switches\/kitchen-lights\/settings$/);
  await expect(page.locator("[data-switch-definition]")).toBeVisible();
  await expect(page.locator("ht-switch")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "On", exact: true })).toHaveCount(0);
  expect(reads).toBe(1);
  await page.getByRole("link", { name: "Kitchen circuit" }).click();
  await expect(page).toHaveURL(/\/switches\/e2e-relay$/);
  expect(errors).toEqual([]);
});
