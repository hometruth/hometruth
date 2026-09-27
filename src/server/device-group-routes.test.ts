import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDeviceGroup, FileDeviceConfigWriter, setDeviceGroupSettings, type DeviceConfigWriter } from "../config/device-writer";
import { parseDevicesConfig } from "../config/devices";
import { ElgatoKeyLightAir, ELGATO_KEY_LIGHT_AIR } from "../devices/lights/elgato-key-light-air";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";
import { BinarySwitch } from "../models/binary-switch";
import { Capability, type CapabilityKind } from "../models/capability";
import { Device, type DeviceModel } from "../models/device";
import { isGroupSwitch, SelectedDeviceGroup } from "../models/device-group";
import { Light } from "../models/light";
import { TemperatureSensor } from "../models/sensor";
import { ContactSensor } from "../models/sensors";
import { temperatureSensorSchema, sensorDeviceSchema } from "../schemas";
import { createLiveSite } from "../live-site";
import { lightSchema, binarySwitchSchema, cameraSchema, type DeviceGroupConfig } from "../schemas";
import { Site } from "../site";
import { createApp } from "./app";
import { StateHub } from "../state/hub";
import { groupNode } from "../state/protocol";

class Relay extends BinarySwitch {
  on = false;
  offline = false;
  failWrite = false;
  async turnOn() { if (this.failWrite) throw new Error("Relay write failed"); this.on = true; }
  async turnOff() { this.on = false; }
  async toggle() { this.on = !this.on; }
  async getState() { if (this.offline) throw new Error("Offline"); return this.on ? "on" as const : "off" as const; }
}
class Lamp extends Light {
  on = false;
  brightnessPercent = 25;
  colorTemperatureKelvin = 4000;
  color = false;
  minimumKelvin = 2900;
  maximumKelvin = 7000;
  override supportsColor() { return this.color; }
  override bounds() { return { minimumPercent: 0, maximumPercent: 100, minimumKelvin: this.minimumKelvin, maximumKelvin: this.maximumKelvin }; }
  async turnOn() { this.on = true; }
  async turnOff() { this.on = false; }
  async toggle() { this.on = !this.on; }
  async setBrightness(value: number) { this.brightnessPercent = value; }
  async setColorTemperature(value: number) { this.colorTemperatureKelvin = value; }
  async getState() { return { on: this.on, brightnessPercent: this.brightnessPercent, colorTemperatureKelvin: this.colorTemperatureKelvin }; }
}
class TestDevice extends Device {
  readonly model: DeviceModel;
  readonly capabilities;
  constructor(id: string, cap: Capability<unknown>, base: DeviceModel = cap.kind === "light" ? ELGATO_KEY_LIGHT_AIR : SHELLY_PLUS_1) {
    super(id, id, {});
    this.model = { ...base, capabilities: [cap.kind] };
    this.capabilities = { [cap.kind]: cap };
  }
  async probe() { return {}; }
}
const definition = { id: "desk", name: "Desk lights", members: ["left", "right"] };
const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
function fixture(extra: Device[] = [], hub?: StateHub, references: { from: string; to: string; relation: "uses" | "members" }[] = []) {
  const left = new Lamp("left"), right = new Lamp("right");
  const groups: DeviceGroupConfig[] = [structuredClone(definition)];
  // Built by hand rather than provisioned, so any reference a composite would
  // have recorded while resolving its members is declared here.
  const site = new Site([new TestDevice("left", left), new TestDevice("right", right), ...extra], undefined, undefined, undefined, undefined, undefined, groups, references);
  const saved: unknown[] = [];
  const writer: DeviceConfigWriter = { async add() {}, async addAll() {}, async rename() {}, async addGroup(group) { saved.push(group); groups.push(group); },
    async setGroupSettings(id, settings) {
      const group = groups.find(group => group.id === id)!;
      if (settings.room === null) delete group.room;
      else if (settings.room !== undefined) group.room = settings.room;
      if (settings.asSwitch !== undefined) group.asSwitch = settings.asSwitch;
      if (settings.members !== undefined) group.members = settings.members;
      if (settings.criteria !== undefined) group.criteria = settings.criteria;
    },
  };
  return { left, right, site, saved, app: createApp(undefined, site, undefined, undefined, undefined, undefined, undefined, writer, undefined, undefined, undefined, undefined, hub) };
}

describe("automatic groups", () => {
  test("matches typed sensors and retains individual sensor readings", async () => {
    class Thermometer extends TemperatureSensor {
      async getState() { return { availability: "online" as const, value: 21.5, observedAt: new Date().toISOString() }; }
    }
    class SensorDevice extends Device {
      readonly model = { ...SHELLY_PLUS_1, capabilities: [], objectSchemaId: sensorDeviceSchema.$id };
      readonly capabilities = {};
      override readonly sensors = [new Thermometer("temperature", "Temperature")];
      async probe() { return {}; }
    }
    const device = new SensorDevice("thermometer", "Kitchen thermometer", {});
    device.room = "Kitchen";
    const site = new Site([device]);
    const app = createApp(undefined, site);
    expect(site.deviceGroups.find(group => group.id === "automatic:sensors")?.members).toEqual([device.id]);
    const response = await post(app, "/api/device-groups/preview", { criteria: { room: "Kitchen", schemaId: temperatureSensorSchema.$id } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ availability: "online", members: [{ id: device.id, properties: { "sensor.temperature.value": 21.5, "sensor.temperature.unit": "°C" } }], actions: [] });
  });

  test("live configuration reloads add and remove matching members without changing criteria", async () => {
    const directory = await mkdtemp(join(tmpdir(), "automatic-group-"));
    const path = join(directory, "devices.yml");
    const group = { id: "kitchen", name: "Kitchen switches", criteria: { room: "Kitchen", schemaId: binarySwitchSchema.$id } };
    const inventory = (ids: string[]) => JSON.stringify({ schemaVersion: 2, deviceGroups: [group], devices: ids.map(id => ({ id, model: "shelly-plus-1", room: "Kitchen", config: { host: "127.0.0.1" } })) });
    const live = createLiveSite({ path, services: {}, secrets: undefined });
    try {
      await writeFile(path, inventory(["one"])); await live.reload();
      expect(live.site.deviceGroups.find(item => item.id === group.id)?.members).toEqual(["one"]);
      await writeFile(path, inventory(["two", "three"])); await live.reload();
      expect(live.site.deviceGroups.find(item => item.id === group.id)?.members).toEqual(["two", "three"]);
      await writeFile(path, inventory([])); await live.reload();
      expect(live.site.deviceGroups.find(item => item.id === group.id)).toMatchObject({ criteria: group.criteria, members: [] });
    } finally { live.close(); await rm(directory, { recursive: true, force: true }); }
  });

  test("provides built-in groups with live membership and the same shared controls", async () => {
    const relay = new Relay("relay");
    const { app, site, left, right } = fixture([new TestDevice("relay", relay)]);
    const groups = (await (await app.request("/api/device-groups")).json()).groups;
    expect(groups.find((group: { id: string }) => group.id === "automatic:lights")).toMatchObject({ name: "All Lights", builtIn: true, members: ["left", "right"], page: "/groups/all-lights" });
    expect(site.deviceGroups.find(group => group.id === "automatic:switches")?.members).toEqual(["left", "right", "relay"]);
    expect((await post(app, "/api/device-groups/automatic:lights/controls/power.turnOn", {})).status).toBe(200);
    expect([left.on, right.on, relay.on]).toEqual([true, true, false]);
    expect((await post(app, "/api/device-groups/automatic:switches/controls/power.toggle", {})).status).toBe(200);
    expect(relay.on).toBe(true);
    expect((await post(app, "/api/device-groups/automatic:lights/settings", { criteria: { room: "Kitchen" } })).status).toBe(409);
    const html = await (await app.request("/groups/all-lights")).text();
    expect(html).toContain("Built-in group.");
    expect(html).not.toContain('data-edit-members="true"');
  });

  test("persists criteria and recomputes room AND schema membership before each control", async () => {
    const relay = new Relay("relay");
    const { app, site, saved, left, right } = fixture([new TestDevice("relay", relay)]);
    site.get("left")!.room = "Kitchen";
    site.get("relay")!.room = "Kitchen";
    site.invalidateConfiguration();
    const group = { id: "kitchen", name: "All Lights in Kitchen", criteria: { room: "Kitchen", schemaId: lightSchema.$id } };
    expect((await post(app, "/api/device-groups", group)).status).toBe(201);
    expect(saved).toEqual([group]);
    expect((await (await app.request("/api/device-groups/kitchen")).json()).members.map((member: { id: string }) => member.id)).toEqual(["left"]);
    await post(app, "/api/device-groups/kitchen/controls/power.turnOn", {});
    expect([left.on, right.on, relay.on]).toEqual([true, false, false]);
    site.get("left")!.room = "Office";
    site.get("right")!.room = "Kitchen";
    site.invalidateConfiguration();
    await post(app, "/api/device-groups/kitchen/controls/power.turnOn", {});
    expect(right.on).toBe(true);
    expect(relay.on).toBe(false);
    expect((await post(app, "/api/device-groups/kitchen/settings", { criteria: { room: "Kitchen", schemaId: binarySwitchSchema.$id } })).status).toBe(200);
    await post(app, "/api/device-groups/kitchen/controls/power.turnOn", {});
    expect(relay.on).toBe(true);
    expect((await post(app, "/api/device-groups/kitchen/settings", { members: ["left", "right"] })).status).toBe(400);
    expect((await post(app, "/api/device-groups/desk/settings", { criteria: { room: "Kitchen" } })).status).toBe(400);
  });

  test("supports empty, single-member, and more than 100 matches without truncation", async () => {
    const { app, site } = fixture();
    const group = { id: "future", name: "Future room", criteria: { room: "Empty room" } };
    expect((await post(app, "/api/device-groups", group)).status).toBe(201);
    expect(await (await app.request("/api/device-groups/future")).json()).toMatchObject({ members: [], properties: [], actions: [], availability: "unknown", canSwitch: false });
    expect((await post(app, "/api/device-groups/future/controls/power.turnOn", {})).status).toBe(409);
    site.get("left")!.room = "Empty room";
    site.invalidateConfiguration();
    expect((await (await app.request("/api/device-groups/future")).json()).members).toHaveLength(1);
    const many = new Site(Array.from({ length: 101 }, (_, i) => new TestDevice(`lamp-${i}`, new Lamp(`lamp-${i}`))));
    expect((await (await createApp(undefined, many).request("/api/device-groups/automatic:lights")).json()).members).toHaveLength(101);
  });

  test("validates criteria, forbids ambiguous membership, and reserves built-in identities", async () => {
    const { app, saved } = fixture();
    for (const selection of [{ criteria: {} }, { criteria: { room: " " } }, { criteria: { unknown: true } }, { criteria: { schemaId: "https://unknown.local/schema" } }, { criteria: { room: "Kitchen" }, members: ["left", "right"] }]) {
      expect((await post(app, "/api/device-groups/preview", selection)).status).toBe(400);
      expect((await post(app, "/api/device-groups", { id: "invalid", name: "Invalid", ...selection })).status).toBe(400);
    }
    expect((await post(app, "/api/device-groups", { id: "automatic:custom", name: "Reserved", criteria: { room: "Kitchen" } })).status).toBe(400);
    expect(saved).toEqual([]);
  });

  test("excludes composite groups and keeps offline devices in schema membership", async () => {
    const composite = new TestDevice("composite", new Lamp("composite"), { ...ELGATO_KEY_LIGHT_AIR, id: "light-group" });
    Object.assign(composite.config as object, { members: ["left", "right"] });
    const relay = new Relay("relay"); relay.offline = true;
    const { app, site } = fixture([composite, new TestDevice("relay", relay)], undefined, [
      { from: "composite", to: "left", relation: "members" },
      { from: "composite", to: "right", relation: "members" },
    ]);
    expect(site.deviceGroups.find(group => group.id === "automatic:lights")?.members).toEqual(["left", "right"]);
    expect((await post(app, "/api/device-groups/automatic:lights/controls/power.toggle", {})).status).toBe(200);
    expect((await (await app.request("/api/device-groups/automatic:switches")).json()).members).toMatchObject([
      { id: "left", availability: "online" }, { id: "right", availability: "online" }, { id: "relay", availability: "offline" },
    ]);
    expect((await post(app, "/api/device-groups/preview", { criteria: { schemaId: cameraSchema.$id } })).status).toBe(200);
  });

  test("round-trips automatic definitions and edited block criteria without storing members", () => {
    const initial = "# Keep inventory\nschemaVersion: 2\nrooms: [Kitchen, Office]\n";
    const group = { id: "kitchen", name: "Kitchen lights", criteria: { room: "Kitchen", schemaId: lightSchema.$id } };
    const appended = appendDeviceGroup(initial, group);
    expect(appended.startsWith(initial)).toBe(true);
    expect(parseDevicesConfig(appended).deviceGroups).toEqual([group]);
    expect(Site.fromConfig(parseDevicesConfig(appended)).deviceGroups.find(item => item.id === group.id)?.members).toEqual([]);
    const block = appended.replace(`criteria: ${JSON.stringify(group.criteria)}`, `criteria: # matching rule\n      room: Kitchen\n      schemaId: ${lightSchema.$id}`);
    const edited = setDeviceGroupSettings(block, group.id, { criteria: { room: "Office" } });
    expect(edited).toContain("# matching rule");
    expect(parseDevicesConfig(edited).deviceGroups).toEqual([{ ...group, criteria: { room: "Office" } }]);
    expect(edited).not.toContain("members:");
    expect(() => parseDevicesConfig(appended.replace("kitchen", "automatic:lights"))).toThrow("reserved");
  });
});

describe("selected device groups", () => {
  test("reports mixed power and brightness without averaging, and applies common light controls", async () => {
    const { left, right, site } = fixture();
    left.on = true; right.brightnessPercent = 75; right.color = true;
    const group = new SelectedDeviceGroup(site.devices);
    const initial = await group.describe();
    expect(initial.properties).toContainEqual({ id: "power.on", status: "mixed" });
    expect(initial.properties).toContainEqual({ id: "light.brightnessPercent", status: "mixed" });
    expect(initial.properties).toContainEqual({ id: "light.colorTemperatureKelvin", status: "shared", value: 4000 });
    expect(initial.actions.map(action => action.id)).toContain("light.setBrightness");
    expect(initial.actions.map(action => action.id)).not.toContain("light.setColor");
    expect(initial.members.map(member => member.properties["light.brightnessPercent"])).toEqual([25, 75]);
    await group.invoke("power.toggle"); expect([left.on, right.on]).toEqual([true, true]);
    await group.invoke("power.toggle"); expect([left.on, right.on]).toEqual([false, false]);
    await group.invoke("light.setBrightness", 60); expect([left.brightnessPercent, right.brightnessPercent]).toEqual([60, 60]);
    await group.invoke("light.setColorTemperature", 5000); expect([left.colorTemperatureKelvin, right.colorTemperatureKelvin]).toEqual([5000, 5000]);
    await expect(group.invoke("light.setColor", "#ffffff")).rejects.toThrow("not currently shared");
  });

  test("intersects numeric limits and rejects invalid values before any member changes", async () => {
    const { left, right, site } = fixture();
    right.minimumKelvin = 3500; right.maximumKelvin = 6000;
    const group = new SelectedDeviceGroup(site.devices);
    expect((await group.describe()).actions.find(action => action.control === "setColorTemperature")?.bounds).toEqual({ minimumKelvin: 3500, maximumKelvin: 6000 });
    for (const value of [3000, 6500, "5000", null]) await expect(group.invoke("light.setColorTemperature", value)).rejects.toThrow();
    expect([left.colorTemperatureKelvin, right.colorTemperatureKelvin]).toEqual([4000, 4000]);
    left.maximumKelvin = 3200;
    expect((await group.describe()).actions.some(action => action.control === "setColorTemperature")).toBe(false);
  });

  test("lights and switches share power; partial failures and unavailable readings stay per member", async () => {
    const relay = new Relay("relay"), lamp = new Lamp("lamp");
    relay.offline = true; relay.failWrite = true;
    const group = new SelectedDeviceGroup([new TestDevice("relay", relay), new TestDevice("lamp", lamp)]);
    const initial = await group.describe();
    expect(initial.availability).toBe("degraded");
    expect(initial.properties).toEqual([{ id: "power.on", status: "unknown" }]);
    expect(initial.actions.map(action => action.id)).toEqual(["power.turnOn", "power.turnOff", "power.toggle"]);
    const result = await group.invoke("power.turnOn");
    expect(result.ok).toBe(false); expect(lamp.on).toBe(true);
    expect(result.results).toEqual([{ id: "relay", name: "relay", ok: false, error: "Relay write failed" }, { id: "lamp", name: "lamp", ok: true }]);
  });

  test("unrelated devices can be grouped for readings; confirmation applies before dispatch", async () => {
    let calls = 0;
    class Subject extends Capability<unknown> {
      readonly kind = "treatDispenser" as CapabilityKind;
      readonly methods = ["dispense"];
      readonly controlIds = ["dispense"];
      constructor(id: string, readonly confirmation: string) { super(id); }
      async describe() { return { state: { availability: "online", foodLevelPercent: 60 }, actions: { dispense: { minimumPortions: 1, maximumPortions: 4, step: 1, confirmation: this.confirmation } } }; }
      async invoke() { calls++; }
    }
    const one = new TestDevice("one", new Subject("one", "none"));
    const two = new TestDevice("two", new Subject("two", "confirm"));
    const group = new SelectedDeviceGroup([one, two]);
    await expect(group.invoke("treatDispenser.dispense", 2)).rejects.toThrow("Confirm"); expect(calls).toBe(0);
    await group.invoke("treatDispenser.dispense", 2, { confirmed: true }); expect(calls).toBe(2);
    const mixed = await new SelectedDeviceGroup([one, new TestDevice("relay", new Relay("relay"))]).describe();
    expect(mixed.actions).toEqual([]); expect(mixed.properties).toEqual([]); expect(mixed.members).toHaveLength(2);
  });

  test("names the members that keep a group from being a switch and tolerates unread readings", async () => {
    class NoPower extends Capability<unknown> {
      readonly kind = "button" as const; readonly methods = ["press"]; readonly controlIds = ["press"];
      async describe() { return { state: { availability: "online" }, actions: { press: {} } }; }
      async invoke() { throw new Error("Describing must not press a button"); }
    }
    const relay = new Relay("relay"); relay.offline = true;
    const lamp = new Lamp("lamp"), bulb = new Lamp("bulb"), broken = new Lamp("broken");
    const originalDescribe = bulb.describe.bind(bulb);
    bulb.describe = async () => { const doc = await originalDescribe(); delete (doc.actions as Record<string, unknown>).toggle; return doc; };
    broken.describe = async () => { throw new Error("No answer"); };
    const members = [new TestDevice("relay", relay), new TestDevice("lamp", lamp), new TestDevice("bulb", bulb), new TestDevice("button", new NoPower("button")), new TestDevice("broken", broken)];
    const snapshot = await new SelectedDeviceGroup(members).describe();
    expect(isGroupSwitch(snapshot)).toBe(false);
    expect(snapshot.members.map(member => member.missingForSwitch)).toEqual([undefined, undefined, ["power.toggle"], ["power.on", "power.turnOn", "power.turnOff", "power.toggle"], ["power.turnOn", "power.turnOff", "power.toggle"]]);
    expect(snapshot.members[4]).toMatchObject({ availability: "offline", error: "No answer" });
    const shared = await new SelectedDeviceGroup(members.slice(0, 2)).describe();
    expect(isGroupSwitch(shared)).toBe(true);
    expect(shared.members.map(member => member.missingForSwitch)).toEqual([undefined, undefined]);
  });

  test("a group with no power-capable member is not switch-eligible and carries no switch-gap noise", async () => {
    class Thermometer extends TemperatureSensor {
      async getState() { return { availability: "online" as const, value: 21.5, observedAt: new Date().toISOString() }; }
    }
    class SensorDevice extends Device {
      readonly model = { ...SHELLY_PLUS_1, capabilities: [], objectSchemaId: sensorDeviceSchema.$id };
      readonly capabilities = {};
      override readonly sensors;
      constructor(id: string, name: string) { super(id, name, {}); this.sensors = [new Thermometer(id, name)]; }
      async probe() { return {}; }
    }
    const snapshot = await new SelectedDeviceGroup([new SensorDevice("a", "A"), new SensorDevice("b", "B")]).describe();
    expect(snapshot.switchEligible).toBe(false);
    expect(isGroupSwitch(snapshot)).toBe(false);
    expect(snapshot.members.map(member => member.missingForSwitch)).toEqual([undefined, undefined]);
  });

  test("a degraded contact sensor still lets the group share properties it cannot currently read", async () => {
    class Contact extends ContactSensor {
      constructor(id: string, private readonly reading: { open: boolean } | undefined) { super(id); }
      async getState() { return this.reading ? { availability: "online" as const, open: this.reading.open, observedAt: new Date().toISOString() } : { availability: "degraded" as const, detail: "Contact sensor reading unavailable" }; }
    }
    const readable = new TestDevice("readable", new Contact("readable", { open: false }));
    const degraded = new TestDevice("degraded", new Contact("degraded", undefined));
    const snapshot = await new SelectedDeviceGroup([readable, degraded]).describe();
    expect(snapshot.properties).toContainEqual({ id: "contactSensor.open", status: "unknown" });
    expect(snapshot.members.find(member => member.id === "degraded")?.availability).toBe("degraded");
  });

  test("real Key Light Air adapters fan out to both local APIs", async () => {
    const states = [{ on: 1, brightness: 20, temperature: 250 }, { on: 0, brightness: 80, temperature: 250 }];
    const devices = states.map((_, index) => new ElgatoKeyLightAir({ id: `air-${index}`, name: `Air ${index}` }, { host: `10.77.0.${index + 10}` }, {
      fetch: async (_url, init) => {
        if (init?.method === "PUT") states[index] = JSON.parse(String(init.body)).lights[0];
        return Response.json({ numberOfLights: 1, lights: [states[index]] });
      },
    }));
    const group = new SelectedDeviceGroup(devices);
    expect((await group.describe()).properties).toContainEqual({ id: "power.on", status: "mixed" });
    await group.invoke("power.turnOff"); expect(states.map(state => state.on)).toEqual([0, 0]);
    await group.invoke("power.turnOn"); expect(states.map(state => state.on)).toEqual([1, 1]);
    await group.invoke("light.setBrightness", 45); expect(states.map(state => state.brightness)).toEqual([45, 45]);
    await group.invoke("light.setColorTemperature", 5000); expect(states.map(state => state.temperature)).toEqual([200, 200]);
  });
});

describe("device group routes and persistence", () => {
  test("edits group membership in place and sends subsequent controls only to saved members", async () => {
    const third = new Lamp("third");
    const { app, site, left, right } = fixture([new TestDevice("third", third)]);
    await post(app, "/api/device-groups/desk/settings", { room: "Office", asSwitch: true });
    expect((await post(app, "/api/device-groups/desk/settings", { members: ["left", "right", "third"] })).status).toBe(200);
    expect(site.deviceGroups[0]?.members).toEqual(["left", "right", "third"]);
    expect((await post(app, "/api/device-groups/desk/settings", { members: ["left", "third"] })).status).toBe(200);
    expect(site.deviceGroups[0]).toEqual({ ...definition, members: ["left", "third"], room: "Office", asSwitch: true });
    const snapshot = await (await app.request("/api/device-groups/desk")).json();
    expect(snapshot.members.map((member: { id: string }) => member.id)).toEqual(["left", "third"]);
    await post(app, "/api/device-groups/desk/switch/turn-on", {});
    expect([left.on, right.on, third.on]).toEqual([true, false, true]);
    expect(await (await app.request("/groups/desk-lights")).text()).toContain('data-edit-members="true"');
  });

  test("rejects invalid edits and removes incompatible selections from Switches in the same save", async () => {
    class NoPower extends Capability<unknown> {
      readonly kind = "button" as const; readonly methods = ["press"]; readonly controlIds = ["press"];
      async describe() { return { state: { availability: "online" }, actions: { press: {} } }; }
      async invoke() { throw new Error("Preview must not press a button"); }
    }
    const composite = new TestDevice("composite", new Lamp("composite"), { ...ELGATO_KEY_LIGHT_AIR, id: "light-group" });
    Object.assign(composite.config as object, { members: ["left", "right"] });
    const { app, site } = fixture([new TestDevice("button", new NoPower("button")), composite]);
    for (const members of [[], ["left"], ["left", "left"], ["left", "missing"], ["left", "composite"], Array.from({ length: 101 }, (_, index) => `device-${index}`)]) {
      expect((await post(app, "/api/device-groups/desk/settings", { members })).status).toBe(400);
      expect(site.deviceGroups[0]).toEqual(definition);
    }
    expect((await post(createApp(undefined, site), "/api/device-groups/desk/settings", { members: ["left", "button"] })).status).toBe(409);
    await post(app, "/api/device-groups/desk/settings", { asSwitch: true });
    const preview = await (await post(app, "/api/device-groups/preview", { members: ["left", "button"] })).json();
    expect(preview.canSwitch).toBe(false);
    expect(site.deviceGroups[0]?.asSwitch).toBe(true);
    expect((await post(app, "/api/device-groups/desk/settings", { members: ["left", "button"], asSwitch: true })).status).toBe(400);
    const response = await post(app, "/api/device-groups/desk/settings", { members: ["left", "button"] });
    expect(await response.json()).toEqual({ id: "desk", members: ["left", "button"], asSwitch: false });
    expect(site.deviceGroups[0]).toEqual({ ...definition, members: ["left", "button"], asSwitch: false });
    expect((await app.request("/api/device-groups/desk/switch")).status).toBe(404);
  });

  test("provides a Groups navigation destination and highlights it on group pages", async () => {
    const { app } = fixture();
    const response = await app.request("/groups");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('href="/groups" aria-current="page"');
    expect(html).toContain('href="/groups/desk-lights"');
    expect(html).toContain('href="/groups/new"');
    for (const page of ["/groups/new", "/groups/desk-lights"]) expect(await (await app.request(page)).text()).toContain('href="/groups" aria-current="page"');
    expect(await (await createApp().request("/groups")).text()).toContain("All Switches");
  });
  test("assigns group rooms and opts compatible groups into working switches", async () => {
    const { app, left, right } = fixture();
    expect((await (await app.request("/api/device-groups/desk")).json()).canSwitch).toBe(true);
    expect((await app.request("/api/device-groups/desk/switch")).status).toBe(404);
    expect(await (await app.request("/switches")).text()).not.toContain('href="/groups/desk-lights"');
    expect((await post(app, "/api/device-groups/desk/settings", { room: "Office", asSwitch: true })).status).toBe(200);
    expect(await (await app.request("/api/device-groups/desk")).json()).toMatchObject({ room: "Office", asSwitch: true });
    const home = await (await app.request("/devices")).text();
    expect(home).toContain('<section><h2>Office</h2><ul class="rows"><li><a class="row" href="/groups/desk-lights"');
    expect(await (await app.request("/switches")).text()).toContain('<ht-switch-row node="group/desk">');
    left.on = true;
    expect(await (await app.request("/api/device-groups/desk/switch")).json()).toMatchObject({ mixed: true, state: { availability: "online" } });
    for (const [action, state] of [["toggle", "on"], ["toggle", "off"], ["turn-on", "on"], ["turn-off", "off"]]) {
      const response = await post(app, `/api/device-groups/desk/switch/${action}`, {});
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ mixed: false, state: { value: state } });
      expect([left.on, right.on]).toEqual([state === "on", state === "on"]);
    }
    expect((await post(app, "/api/device-groups/desk/settings", { room: null, asSwitch: false })).status).toBe(200);
    expect((await (await app.request("/api/device-groups/desk")).json()).room).toBeUndefined();
    expect((await app.request("/api/device-groups/desk/switch")).status).toBe(404);
  });

  test("validates settings and rejects incompatible switches without issuing commands", async () => {
    const { app, site, left } = fixture();
    for (const settings of [{}, { room: " " }, { room: 42 }, { room: "x".repeat(101) }, { asSwitch: "true" }, { asSwitch: true, extra: true }]) {
      expect((await post(app, "/api/device-groups/desk/settings", settings)).status).toBe(400);
    }
    expect((await post(app, "/api/device-groups/missing/settings", { asSwitch: true })).status).toBe(404);
    expect((await post(createApp(undefined, site), "/api/device-groups/desk/settings", { asSwitch: true })).status).toBe(409);
    const originalDescribe = left.describe.bind(left);
    left.describe = async () => { const doc = await originalDescribe(); delete (doc.actions as Record<string, unknown>).toggle; return doc; };
    expect((await (await app.request("/api/device-groups/desk")).json()).canSwitch).toBe(false);
    expect((await post(app, "/api/device-groups/desk/settings", { asSwitch: true })).status).toBe(400);
    expect((await post(app, "/api/device-groups", { ...definition, id: "incompatible", asSwitch: true })).status).toBe(400);
    expect(left.on).toBe(false);
    expect((await post(app, "/api/device-groups/desk/settings", { room: "Office" })).status).toBe(200);
  });

  test("reading the switch endpoint publishes the group switch document for the pages watching it", async () => {
    const hub = new StateHub();
    const { app } = fixture([], hub);
    expect((await post(app, "/api/device-groups/desk/settings", { asSwitch: true })).status).toBe(200);
    expect(hub.graph.read(groupNode("desk"))).toBeUndefined();
    expect((await app.request("/api/device-groups/desk/switch")).status).toBe(200);
    expect(hub.graph.read(groupNode("desk"))).toMatchObject({ version: 1, value: { id: "desk", capabilities: { binarySwitch: { id: "desk" } }, group: { canSwitch: true } } });
  });

  test("names the members that no longer share switch controls on the switch endpoint and page", async () => {
    const { app, left, right } = fixture();
    expect((await post(app, "/api/device-groups/desk/settings", { asSwitch: true })).status).toBe(200);
    const page = await (await app.request("/switches/desk-lights")).text();
    expect(page).toContain('data-group-member="left"'); expect(page).toContain('data-group-member="right"');
    expect(page).toContain('<ht-switch node="group/desk">');
    expect(page).toContain('"switch.notSharedBy"');
    const originalDescribe = right.describe.bind(right);
    right.describe = async () => { const doc = await originalDescribe(); delete (doc.actions as Record<string, unknown>).toggle; return doc; };
    const state = await app.request("/api/device-groups/desk/switch");
    expect(state.status).toBe(409);
    expect((await state.json()).error).toEqual({ code: "not_supported", message: "This group no longer shares all switch controls", detail: "1 of 2 members lack Toggle: right" });
    expect((await post(app, "/api/device-groups/desk/switch/turn-on", {})).status).toBe(409);
    expect([left.on, right.on]).toEqual([false, false]);
    const snapshot = await (await app.request("/api/device-groups/desk")).json();
    expect(snapshot.canSwitch).toBe(false);
    expect(snapshot.members).toMatchObject([{ id: "left" }, { id: "right", missingForSwitch: ["power.toggle"] }]);
    expect(snapshot.members[0].missingForSwitch).toBeUndefined();
    const settings = await post(app, "/api/device-groups/desk/settings", { asSwitch: true });
    expect(settings.status).toBe(400);
    expect((await settings.json()).error.detail).toBe("1 of 2 members lack Toggle: right");
    const bulbs = Array.from({ length: 40 }, (_, index) => {
      const bulb = new Lamp(`string-light-${String(index + 1).padStart(2, "0")}`);
      const describe = bulb.describe.bind(bulb);
      bulb.describe = async () => { const doc = await describe(); delete (doc.actions as Record<string, unknown>).toggle; return doc; };
      return new TestDevice(bulb.id, bulb);
    });
    const many = createApp(undefined, new Site([new TestDevice("lamp", new Lamp("lamp")), ...bulbs], undefined, undefined, undefined, undefined, undefined,
      [{ id: "string", name: "String", members: ["lamp", ...bulbs.map(bulb => bulb.id)], asSwitch: true }]));
    const detail = (await (await many.request("/api/device-groups/string/switch")).json()).error.detail as string;
    expect(detail.length).toBeLessThanOrEqual(500);
    expect(detail).toMatch(/^40 of 41 members lack Toggle: string-light-01, string-light-02, .*string-light-\d\d and \d+ more$/u);
  });

  test("keeps offline state unknown and reports group-switch member failures", async () => {
    const relay = new Relay("relay"), lamp = new Lamp("lamp");
    relay.offline = true; relay.failWrite = true;
    const site = new Site([new TestDevice("relay", relay), new TestDevice("lamp", lamp)], undefined, undefined, undefined, undefined, undefined,
      [{ id: "mixed", name: "Mixed devices", members: ["relay", "lamp"], asSwitch: true }]);
    const app = createApp(undefined, site);
    expect(await (await app.request("/api/device-groups/mixed/switch")).json()).toEqual({ id: "mixed", state: { availability: "degraded" }, mixed: false });
    const response = await post(app, "/api/device-groups/mixed/switch/turn-on", {});
    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toContain("relay: Relay write failed");
    expect(lamp.on).toBe(true);
  });

  test("previews without writing, saves the exact selection, and exposes live group controls", async () => {
    const { app, left, right, saved } = fixture();
    left.on = true;
    expect(await (await app.request("/devices")).text()).toContain('/groups/new');
    expect(await (await app.request("/groups/new")).text()).toContain('name="members" value="left"');
    const preview = await post(app, "/api/device-groups/preview", { members: ["left", "right"] });
    expect(preview.status).toBe(200); expect((await preview.json()).properties).toContainEqual({ id: "power.on", status: "mixed" });
    expect(saved).toEqual([]); expect(right.on).toBe(false);
    const create = await post(app, "/api/device-groups", { ...definition, id: "new-group" });
    expect(create.status).toBe(201); expect(saved).toEqual([{ ...definition, id: "new-group" }]);
    expect((await app.request((await create.json()).page)).status).toBe(200);
    const control = await post(app, "/api/device-groups/desk/controls/power.turnOn", {});
    expect(control.status).toBe(200); expect((await control.json()).ok).toBe(true);
    expect([left.on, right.on]).toEqual([true, true]);
    expect((await post(app, "/api/device-groups/desk/controls/light.setBrightness", { value: 110 })).status).toBe(400);
  });

  test("validates selection and persistence permissions", async () => {
    const { app, site, saved } = fixture();
    for (const body of [{}, { members: [] }, { members: ["left"] }, { members: ["left", "left"] }, { members: ["left", "missing"] }, { members: ["left", "right"], extra: true }]) {
      expect((await post(app, "/api/device-groups/preview", body)).status).toBe(400);
    }
    expect((await post(app, "/api/device-groups", definition)).status).toBe(409);
    expect((await post(app, "/api/device-groups", { ...definition, id: "bad", name: "  " })).status).toBe(400);
    expect(saved).toEqual([]);
    expect((await post(createApp(undefined, site), "/api/device-groups", { ...definition, id: "new" })).status).toBe(409);
    expect((await app.request("/api/device-groups/missing")).status).toBe(404);
    const crossOrigin = await app.request("/api/device-groups", { method: "POST", headers: { "content-type": "application/json", origin: "https://untrusted.example" }, body: JSON.stringify({ ...definition, id: "new" }) });
    expect(crossOrigin.status).toBe(403);
  });

  test("preserves YAML and file mode, serializes concurrent saves, and provisions groups after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hometruth-groups-"));
    try {
      const path = join(directory, "devices.yml");
      const original = '# Keep this comment\nschemaVersion: 2\ndevices:\n  - id: left\n    model: elgato-key-light-air\n    config: { host: 10.77.0.10 } # left lamp\n  - id: right\n    model: elgato-key-light-air\n    config: { host: 10.77.0.11 }\n';
      await writeFile(path, original, { mode: 0o640 });
      let reloads = 0;
      const writer = new FileDeviceConfigWriter(path, async () => { reloads++; });
      await Promise.all([writer.addGroup(definition), writer.addGroup({ ...definition, id: "second" })]);
      const text = await readFile(path, "utf8");
      expect(text.startsWith(original)).toBe(true);
      expect((await stat(path)).mode & 0o777).toBe(0o640); expect(reloads).toBe(2);
      const config = parseDevicesConfig(text);
      expect(Site.fromConfig(config).configuredGroups).toHaveLength(2);
      await expect(writer.addGroup(definition)).rejects.toThrow("already exists");
      expect(await readFile(path, "utf8")).toBe(text);
      expect(() => appendDeviceGroup(original, { ...definition, members: ["left", "missing"] })).toThrow("missing device");
      expect(() => parseDevicesConfig(text + '  - id: desk\n    name: Duplicate\n    members: [left, right]\n')).toThrow("more than once");
      await Promise.all([writer.setGroupSettings("desk", { room: "Kitchen" }), writer.setGroupSettings("desk", { asSwitch: true })]);
      const edited = await readFile(path, "utf8");
      expect(edited).toContain("# Keep this comment");
      expect(edited).toContain("# left lamp");
      expect((await stat(path)).mode & 0o777).toBe(0o640);
      const restarted = Site.fromConfig(parseDevicesConfig(edited));
      expect(restarted.deviceGroups[0]).toEqual({ ...definition, room: "Kitchen", asSwitch: true });
      expect(restarted.rooms).toContain("Kitchen");
      const moved = setDeviceGroupSettings(edited, "desk", { room: "Office" });
      const cleared = parseDevicesConfig(setDeviceGroupSettings(moved, "desk", { room: null, asSwitch: false }));
      expect(cleared.deviceGroups?.[0]).toEqual({ ...definition, asSwitch: false });
      expect(cleared.rooms).toEqual(["Kitchen", "Office"]);
      expect(() => setDeviceGroupSettings(edited, "desk", { room: " " })).toThrow("invalid");
      const withMemberComments = edited.replace('    members: ["left","right"]', '    members: # group members\n      - left # left member\n      - right # right member');
      const swapped = setDeviceGroupSettings(withMemberComments, "desk", { members: ["right", "left"] });
      expect(parseDevicesConfig(swapped).deviceGroups?.[0]).toEqual({ ...definition, members: ["right", "left"], room: "Kitchen", asSwitch: true });
      for (const comment of ["# group members", "# left member", "# right member"]) expect(swapped).toContain(comment);
      await Promise.all([writer.setGroupSettings("desk", { members: ["right", "left"] }), writer.setGroupSettings("desk", { room: "Office" })]);
      const reloaded = Site.fromConfig(parseDevicesConfig(await readFile(path, "utf8")));
      expect(reloaded.deviceGroups[0]).toEqual({ ...definition, members: ["right", "left"], room: "Office", asSwitch: true });
      expect(reloaded.deviceGroups[1]).toEqual({ ...definition, id: "second" });
      expect((await stat(path)).mode & 0o777).toBe(0o640);
      expect(parseDevicesConfig(appendDeviceGroup(original, { ...definition, room: "Office", asSwitch: true })).deviceGroups?.[0]).toEqual({ ...definition, room: "Office", asSwitch: true });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
