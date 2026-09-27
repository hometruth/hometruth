import { expect, test } from "bun:test";
import { PageDirectory, nameSlug } from "../page-urls";
import { Device } from "../models/device";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";
import { TestRelay, TestLight } from "../kindle/test-fixture";
import { Site, type RegisteredDevice } from "../site";
import { createApp } from "./app";
import { partitionDevicesIntoGroups } from "../ui/home";

const entry = (id: string, name: string, kind: RegisteredDevice["kind"] = "binary-switch", groupLabel?: string): RegisteredDevice => ({ id, name, kind, model: kind, modelTitle: kind, capabilities: [], host: "", page: `/devices/${id}`, schemaId: "test", enabled: true, ...(groupLabel ? { groupLabel } : {}) });

test("URLs use readable names and types, deterministic collision suffixes, and reserved routes", () => {
  const devices = [entry("one", "Café light", "light"), entry("two", "Cafe light", "light"), entry("cam", "Front Door", "camera"), entry("sensor", "Temperature", "sensor"), entry("hub", "Bridge", "hub"), entry("blaster", "IR Remote", "ir-rf-blaster"), entry("speaker", "Office", "speaker"), entry("button", "Door bell", "button")];
  const groups = [{ id: "new", name: "New", members: ["one", "two"] }];
  const pages = new PageDirectory(devices, groups, []);
  expect(nameSlug("  Café—Lights!  ")).toBe("cafe-lights");
  expect(nameSlug("⚡")).toBe("element");
  expect(pages.page("device", "one")).toMatch(/^\/lights\/cafe-light-[a-f0-9]{8}$/);
  expect(pages.page("device", "one")).not.toBe(pages.page("device", "two"));
  for (const [id, path] of [["cam", "/cameras/front-door"], ["sensor", "/sensors/temperature"], ["hub", "/hubs/bridge"], ["blaster", "/blasters/ir-remote"], ["speaker", "/speakers/office"], ["button", "/buttons/door-bell"]]) expect(pages.page("device", id!)).toBe(path!);
  expect(new PageDirectory([...devices].reverse(), groups, []).entries).toEqual(pages.entries);
  expect(pages.page("group", "new")).toMatch(/^\/groups\/new-[a-f0-9]{8}$/);
  expect(pages.resolve("/groups/new")).toBeUndefined();
  expect(pages.resolve("/groups/custom/new")).toBeUndefined();
  expect(pages.resolve("/lights/cafe-light")).toBeUndefined();
  const renamed = new PageDirectory([{ ...devices[0]!, name: "New light name" }], [], []);
  expect(renamed.resolve(pages.page("device", "one")!)).toBeUndefined();
  expect(renamed.resolve("/lights/new-light-name")?.entry.id).toBe("one");
});

test("page URLs use current names without reserving historical IDs", () => {
  const groups = [{ id: "published", name: "Renamed group", members: ["one", "two"] }, { id: "other", name: "Published", members: ["one", "two"] }];
  const pages = new PageDirectory([], groups, [{ id: "events", title: "Recorded events" }, { id: "new", title: "Events" }]);
  expect(pages.resolve("/groups/published")?.entry.id).toBe("other");
  expect(pages.resolve("/groups/renamed-group")?.entry.id).toBe("published");
  expect(pages.page("group", "other")).toBe("/groups/published");
  expect(pages.resolve("/services/events")?.entry.id).toBe("new");
  expect(pages.resolve("/services/recorded-events")?.entry.id).toBe("events");
  expect(pages.page("service", "new")).toBe("/services/events");
  expect(pages.resolve("/services/recorded-events/settings")).toBeUndefined();
});

test("similarly named speaker groups stay separate and do not absorb saved groups", () => {
  const raw = [entry("a", "Left", "speaker", "Office pair"), entry("b", "Right", "speaker", "Office-pair")];
  const groups = [{ id: "saved", name: "Office pair", members: ["a", "b"] }];
  const pages = new PageDirectory(raw, groups, []);
  const devices = raw.map(device => ({ ...device, groupPage: pages.page("speaker-group", device.groupLabel!)! }));
  expect(new Set(pages.entries.filter(entry => entry.page.startsWith("/groups/")).map(entry => entry.page)).size).toBe(3);
  expect(partitionDevicesIntoGroups(devices).groups).toHaveLength(2);
});

class Relay extends Device<{ host: string }> {
  readonly model = SHELLY_PLUS_1;
  readonly relay = new TestRelay("relay");
  readonly capabilities = { binarySwitch: this.relay };
  constructor(id: string, name: string) { super(id, name, { host: "" }); }
  async probe() { return {}; }
}
class Lamp extends Device<{ host: string }> {
  readonly model = { ...SHELLY_PLUS_1, id: "test-lamp", capabilities: ["light"] as const };
  readonly light = new TestLight("light");
  readonly capabilities = { light: this.light };
  constructor(id: string, name: string) { super(id, name, { host: "" }); }
  async probe() { return {}; }
}

test("Kitchen Lights uses only current URLs and links every relationship", async () => {
  const relay = new Relay("lutron-main-lights", "Kitchen Lights"), lamp = new Lamp("hue-one", "Kitchen lamp");
  const group = { id: "kitchen-lights-a357dc17", name: "Kitchen Lights", members: [relay.id, lamp.id], asSwitch: true };
  const site = new Site([relay, lamp], undefined, undefined, undefined, undefined, undefined, [group]);
  const app = createApp(undefined, site);
  const physicalPage = site.view(relay.id)!.page;
  expect(physicalPage).toMatch(/^\/switches\/kitchen-lights-[a-f0-9]{8}$/);
  expect(site.listGroups()[0]).toMatchObject({ page: "/groups/kitchen-lights", switchPage: "/switches/kitchen-lights" });
  const disabled = new PageDirectory(site.list(), [{ ...group, asSwitch: false }], []);
  expect(disabled.page("device", relay.id)).toBe("/switches/kitchen-lights");
  expect(disabled.resolve(physicalPage)).toBeUndefined();
  expect(disabled.resolve("/switches/kitchen-lights")?.entry.id).toBe(relay.id);
  for (const old of ["/devices/lutron-main-lights", "/devices/lutron-main-lights/settings?from=bookmark", "/devices/hue-one/log", "/groups/custom/kitchen-lights-a357dc17", "/groups/kitchen-lights-a357dc17", "/switches/kitchen-lights/"]) {
    const response = await app.request(old);
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
  }
  const groupPage = await (await app.request("/groups/kitchen-lights")).text();
  expect(groupPage).toContain(`href="${physicalPage}"`);
  expect(groupPage).toContain('href="/lights/kitchen-lamp"');
  expect(groupPage).toContain('href="/switches/kitchen-lights"');
  const physical = await (await app.request(physicalPage)).text();
  expect(physical).toContain('Member of: <a href="/groups/kitchen-lights"');
  expect(physical).toContain('Group switch: <a href="/switches/kitchen-lights"');
  const groupSwitch = await (await app.request("/switches/kitchen-lights")).text();
  expect(groupSwitch).toContain('Switch based on group: <a href="/groups/kitchen-lights"');
  expect(groupSwitch).toContain('<ht-switch node="group/kitchen-lights-a357dc17">');
  const settings = await (await app.request("/switches/kitchen-lights/settings")).text();
  expect(settings).toContain("data-switch-definition"); expect(settings).toContain(`href="${physicalPage}"`);
  expect(settings).toContain("binarySwitch.turnOn()"); expect(settings).toContain("light.turnOn()");
  const snapshot = await (await app.request(`/api/device-groups/${group.id}`)).json();
  expect(snapshot.members.map((member: { page: string }) => member.page)).toEqual([physicalPage, "/lights/kitchen-lamp"]);
  const htmls = [groupPage, physical, groupSwitch, settings, await (await app.request("/devices")).text(), await (await app.request("/switches")).text(), await (await app.request("/groups")).text()];
  const links = new Set(htmls.flatMap(html => [...html.matchAll(/href="([^"#]+)(?:#[^"]*)?"/g)].map(match => match[1]!).filter(href => /^\/(switches|lights|groups)\//.test(href))));
  for (const href of links) expect((await app.request(href)).status).toBe(200);
  expect(relay.relay.writes).toBe(0); expect(lamp.light.on).toBe(false);
  const invoke = (url: string) => app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect((await invoke(`/api/switches/${relay.id}/turn-on`)).status).toBe(200);
  expect(lamp.light.on).toBe(false);
  expect((await invoke(`/api/device-groups/${group.id}/switch/turn-on`)).status).toBe(200);
  expect(lamp.light.on).toBe(true);
  for (const path of ["/devices/missing", "/switches/missing", "/groups/custom/missing", "/groups/missing", "/cameras/kitchen-lights", "/api/devices/kitchen-lights"]) expect((await app.request(path)).status).toBe(404);
});
