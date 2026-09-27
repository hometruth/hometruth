import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDeviceGroup, setDeviceGroupSettings, type DeviceConfigWriter } from "../config/device-writer";
import { parseDevicesConfig } from "../config/devices";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";
import { ELGATO_KEY_LIGHT_AIR } from "../devices/lights/elgato-key-light-air";
import { TestLight, TestRelay } from "../kindle/test-fixture";
import { createLiveSite } from "../live-site";
import { Device } from "../models/device";
import { binarySwitchSchema, type DeviceGroupConfig } from "../schemas";
import { Site } from "../site";
import { elementKey } from "../tags/identity";
import { TagStore } from "../tags/store";
import { createApp } from "./app";

const stores: TagStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
class TaggedDevice extends Device {
  readonly model;
  readonly capabilities;
  constructor(id: string, control: TestRelay | TestLight, room: string) {
    super(id, id, {}); this.model = control.kind === "light" ? ELGATO_KEY_LIGHT_AIR : SHELLY_PLUS_1;
    this.capabilities = { [control.kind]: control }; this.room = room;
  }
  async probe() { return {}; }
}
function fixture() {
  const first = new TestRelay("first"), second = new TestRelay("second"), light = new TestLight("lamp");
  const definitions: DeviceGroupConfig[] = [];
  const site = new Site([new TaggedDevice("first", first, "Kitchen"), new TaggedDevice("second", second, "Office"), new TaggedDevice("lamp", light, "Kitchen")], undefined, undefined, undefined, undefined, undefined, definitions);
  const tags = new TagStore(); stores.push(tags);
  const writer: DeviceConfigWriter = { async add() {}, async addAll() {}, async rename() {},
    async addGroup(group) { definitions.push(structuredClone(group)); },
    async setGroupSettings(id, settings) { Object.assign(definitions.find(group => group.id === id)!, settings); },
  };
  const app = createApp(undefined, site, undefined, undefined, undefined, undefined, undefined, writer, undefined, undefined, undefined, tags);
  return { app, site, tags, first, second, light, definitions };
}
const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ids = (snapshot: { members: { id: string }[] }) => snapshot.members.map(member => member.id);

test("tag-only and combined criteria require every tag on the device itself", async () => {
  const { app, tags } = fixture();
  const foo = tags.create({ value: "foo", color: "#112233", description: "" });
  const bar = tags.create({ value: "bar", color: "#223344", description: "" });
  for (const id of ["first", "lamp"]) tags.attach(elementKey("device", id), { tagId: foo.id });
  tags.attach(elementKey("device", "first"), { tagId: bar.id });
  tags.attach(elementKey("control", "second", "binarySwitch", "turnOn"), { tagId: foo.id });
  tags.attach(elementKey("group", "second"), { tagId: foo.id });
  const cases = [
    [{ tagIds: [foo.id] }, ["first", "lamp"]],
    [{ tagIds: [foo.id], schemaId: binarySwitchSchema.$id }, ["first", "lamp"]],
    [{ tagIds: [foo.id, bar.id] }, ["first"]],
    [{ tagIds: [foo.id], room: "Office" }, []],
    [{ tagIds: [foo.id, bar.id], room: "Kitchen", schemaId: binarySwitchSchema.$id }, ["first"]],
  ] as const;
  for (const [criteria, expected] of cases) {
    const response = await post(app, "/api/device-groups/preview", { criteria });
    expect(response.status).toBe(200);
    expect(ids(await response.json())).toEqual([...expected]);
  }
});

test("tag assignments and renames update membership, relationships, and switch targets without rewriting criteria", async () => {
  const { app, site, tags, first, second, definitions } = fixture();
  const foo = tags.create({ value: "foo", color: "#112233", description: "" });
  tags.attach(elementKey("device", "first"), { tagId: foo.id });
  const criteria = { tagIds: [foo.id], schemaId: binarySwitchSchema.$id };
  expect((await post(app, "/api/device-groups", { id: "tagged", name: "Tagged switches", criteria, asSwitch: true })).status).toBe(201);
  expect(definitions[0]).toEqual({ id: "tagged", name: "Tagged switches", criteria, asSwitch: true });
  tags.attach(elementKey("device", "second"), { tagId: foo.id });
  expect(ids(await (await app.request("/api/device-groups/tagged")).json())).toEqual(["first", "second"]);
  expect(site.view("second")!.relationships?.some(link => link.id === "tagged" && link.relation === "memberOf")).toBe(true);
  tags.update(foo.id, { value: "renamed", color: "#aabbcc", description: "Renamed" }, foo.revision);
  expect(definitions[0]!.criteria).toEqual(criteria);
  expect(await (await app.request("/groups/tagged-switches")).text()).toContain("#renamed");
  tags.detach(elementKey("device", "first"), foo.id);
  expect((await post(app, "/api/device-groups/tagged/switch/turn-on", {})).status).toBe(200);
  expect([first.state, second.state]).toEqual(["off", "on"]);
  expect([first.writes, second.writes]).toEqual([0, 1]);
  expect(site.deviceGroups.find(group => group.id === "tagged")!.members).toEqual(["second"]);
  tags.detach(elementKey("device", "second"), foo.id);
  expect((await post(app, "/api/device-groups/tagged/controls/power.turnOn", {})).status).toBe(409);
  expect([first.writes, second.writes]).toEqual([0, 1]);
  expect((await post(app, "/api/device-groups/tagged/settings", { criteria: { room: "Kitchen" } })).status).toBe(200);
  expect(site.deviceGroups.find(group => group.id === "tagged")!.members).toEqual(["first", "lamp"]);
});

test("rejects malformed, empty, duplicate, and unknown tag references before saving", async () => {
  const { app, tags, definitions } = fixture();
  const tag = tags.create({ value: "foo", color: "#112233", description: "" });
  await post(app, "/api/device-groups", { id: "saved", name: "Saved", criteria: { tagIds: [tag.id] } });
  const before = structuredClone(definitions);
  for (const tagIds of [[], ["foo"], [tag.id, tag.id], ["00000000-0000-4000-8000-000000000000"]]) {
    const criteria = { tagIds };
    expect((await post(app, "/api/device-groups/preview", { criteria })).status).toBe(400);
    expect((await post(app, "/api/device-groups", { id: "bad", name: "Bad", criteria })).status).toBe(400);
    expect((await post(app, "/api/device-groups/saved/settings", { criteria })).status).toBe(400);
  }
  expect(definitions).toEqual(before);
});

test("UUID criteria round-trip in YAML and keep their tag source across live reloads and restarts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tag-groups-"));
  const path = join(dir, "devices.yml"), dbPath = join(dir, "tags.sqlite");
  let tags = new TagStore(dbPath);
  const live = createLiveSite({ path, services: {}, secrets: undefined });
  try {
    const tag = tags.create({ value: "foo", color: "#112233", description: "" });
    const group = { id: "tagged", name: "Tagged switches", criteria: { tagIds: [tag.id], schemaId: binarySwitchSchema.$id } };
    const config = (deviceIds: string[]) => appendDeviceGroup("schemaVersion: 2\ndevices: " + JSON.stringify(deviceIds.map(id => ({ id, model: "shelly-plus-1", config: { host: "127.0.0.1" } }))) + "\n", group);
    tags.attach(elementKey("device", "one"), { tagId: tag.id });
    await writeFile(path, config(["one"])); await live.reload();
    createApp(undefined, live.site, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, tags);
    expect(live.site.deviceGroups.find(item => item.id === group.id)!.members).toEqual(["one"]);
    tags.attach(elementKey("device", "two"), { tagId: tag.id });
    await writeFile(path, config(["two"])); await live.reload();
    expect(live.site.deviceGroups.find(item => item.id === group.id)!.members).toEqual(["two"]);
    const saved = parseDevicesConfig(config(["two"]));
    expect(saved.deviceGroups).toEqual([group]);
    const edited = parseDevicesConfig(setDeviceGroupSettings(config(["two"]), group.id, { criteria: { tagIds: [tag.id], room: "Kitchen" } }));
    expect(edited.deviceGroups![0]!.criteria).toEqual({ tagIds: [tag.id], room: "Kitchen" });
    tags.close(); tags = new TagStore(dbPath);
    const restarted = Site.fromConfig(saved);
    createApp(undefined, restarted, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, tags);
    expect(restarted.deviceGroups.find(item => item.id === group.id)!.members).toEqual(["two"]);
  } finally { live.close(); tags.close(); await rm(dir, { recursive: true, force: true }); }
});
