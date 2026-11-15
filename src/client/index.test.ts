import { describe, expect, test } from "bun:test";
import { HomeTruth, type ElementContract, type InventoryElement } from "./index";
import { compilePlayground } from "./source";
import { clientExamples } from "./methods";
import { buildElementApi } from "../element-api/contract";
import { createApp } from "../server/app";
import { Device } from "../models/device";
import { BinarySwitch } from "../models/binary-switch";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";
import { Site } from "../site";
import { StateHub } from "../state/hub";
import { GraphStore } from "../graph/store";
import { TokenStore } from "../auth/store";
import { elementKey } from "../tags/identity";
import type { DeviceConfigWriter } from "../config/device-writer";

class Relay extends BinarySwitch {
  calls: string[] = [];
  value: "on" | "off" = "off";
  async turnOn() { this.calls.push("on"); this.value = "on"; }
  async turnOff() { this.calls.push("off"); this.value = "off"; }
  async toggle() { this.calls.push("toggle"); this.value = this.value === "off" ? "on" : "off"; }
  async getState() { return this.value; }
}
class Switch extends Device<{ host: string }> {
  readonly model = SHELLY_PLUS_1;
  readonly relay = new Relay("switch");
  readonly capabilities = { binarySwitch: this.relay };
  async probe() { return {}; }
}
function fixture(options: { tokens?: TokenStore; store?: GraphStore; fanId?: string; fanName?: string; writer?: DeviceConfigWriter } = {}) {
  const fan = new Switch(options.fanId ?? "lutron-fan", options.fanName ?? "Fan", { host: "10.77.0.2" });
  fan.room = "Kitchen";
  const other = new Switch("other", "Other", { host: "10.77.0.3" });
  other.room = "Bedroom";
  const site = new Site([fan, other]);
  const hub = new StateHub();
  const app = createApp(undefined, site, undefined, undefined, undefined, undefined, undefined, options.writer, undefined, undefined, undefined, undefined, hub, options.tokens, options.store);
  const calls: { url: string; method: string; body?: unknown; authorization: string | null }[] = [];
  const ht = new HomeTruth({ fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}), authorization: new Headers(init?.headers).get("authorization") });
    return app.request(String(input), init);
  }) as typeof fetch });
  return { app, fan, site, hub, ht, calls };
}

describe("shared HomeTruth client", () => {
  test("enabled reads a boolean and enable and disable are parameterless POST methods", async () => {
    const changes: boolean[] = [];
    const { ht, hub, fan, calls } = fixture({ writer: {
      async add() {}, async addAll() {}, async rename() {},
      async setEnabled(_id, enabled) { changes.push(enabled); },
    } });
    try {
      await ht.connect("http://localhost");
      const device = ht.devices["fan"]!;
      const description = await device.describe();
      for (const name of ["enabled", "enable", "disable"]) {
        expect(description.methods.find(method => method.name === name)).toMatchObject({ arguments: [], returns: "DeviceEnabled" });
      }
      expect(description.methods.some(method => method.name === "setEnabled")).toBe(false);
      expect(await device.enabled()).toBe(true);
      expect(calls.at(-1)).toMatchObject({ method: "GET", url: "http://localhost/api/devices/fan/enabled" });
      expect(await device.disable()).toBe(false);
      expect(calls.at(-1)).toMatchObject({ method: "POST", url: "http://localhost/api/devices/fan/disable" });
      expect(calls.at(-1)).not.toHaveProperty("body");
      expect(await device.enabled()).toBe(false);
      expect(await device.enable()).toBe(true);
      expect(calls.at(-1)).toMatchObject({ method: "POST", url: "http://localhost/api/devices/fan/enable" });
      expect(calls.at(-1)).not.toHaveProperty("body");
      expect(await device.enabled()).toBe(true);
      expect(changes).toEqual([false, true]);
      expect(fan.relay.calls).toEqual([]);
    } finally { hub.stop(); }
  });
  test("root always identifies the site, even with a device called root and scoped access", async () => {
    const tokens = new TokenStore();
    const { ht, app, hub, fan } = fixture({ tokens, fanId: "internal-root", fanName: "Root" });
    try {
      const all = tokens.issue({ name: "All", permissions: ["read"], subject: { all: true } }).token;
      await ht.connect("http://localhost", { token: all });
      const entry = ht.inventory.find(element => element.kind === "site")!;
      expect(entry).toMatchObject({ id: "root", key: "root", page: "/" });
      expect(ht.elements.root).toBe(ht.elements[entry.address]);
      expect(ht.elements.root).not.toBe(ht.devices["root-device"]);
      expect(await ht.elements.root!.describe()).toMatchObject({ id: "root", key: "root", kind: "site" });
      expect(await ht.elements.root!.read()).toMatchObject({ element: { key: "root", kind: "site" } });
      expect(await ht.devices["root-device"]!.describe()).toMatchObject({ id: "internal-root", kind: "device" });

      const kitchen = tokens.issue({ name: "Kitchen", permissions: ["read"], subject: { criteria: { room: "Kitchen" } } }).token;
      await ht.connect("http://localhost", { token: kitchen });
      expect(ht.inventory.some(element => element.kind === "site")).toBe(false);
      expect(() => ht.elements.root).toThrow('No element named "root"');
      expect(await ht.devices["root-device"]!.describe()).toMatchObject({ id: "internal-root", kind: "device" });
      const headers = { authorization: `Bearer ${kitchen}` };
      expect((await app.request(`/api/inventory/${entry.address}`, { headers })).status).toBe(404);
      expect((await app.request("/api/elements/root", { headers })).status).toBe(403);
      expect((await app.request("/api/graph/scene?focus=root", { headers })).status).toBe(403);
      expect(fan.relay.calls).toEqual([]);
    } finally { hub.stop(); tokens.close(); }
  });

  test("every element has one current friendly address shared by device and element handles", async () => {
    const { ht, calls, hub, fan } = fixture();
    try {
      expect(() => ht.devices).toThrow("Await ht.connect");
      await ht.connect("http://localhost");
      expect(calls).toHaveLength(1);
      expect(ht.inventory).toHaveLength(hub.data.topology().size);
      expect(new Set(ht.inventory.map(element => element.uuid)).size).toBe(ht.inventory.length);
      const entry = ht.inventory.find(element => element.deviceId === "lutron-fan")!;
      expect(entry.uuid).toMatch(/^[a-f0-9-]{36}$/);
      expect(ht.elements[entry.address]).toBe(ht.devices["fan"]);
      expect(() => ht.devices["lutron-fan"]).toThrow("No device named");
      expect(() => ht.elements["lutron-fan"]).toThrow("No element named");
      expect(() => ht.elements[entry.key]).toThrow("No element named");
      expect(() => ht.elements[entry.uuid]).toThrow("No element named");
      expect(entry.address).toBe("fan");
      expect(new Set(ht.inventory.map(element => element.address)).size).toBe(ht.inventory.length);
      expect(Object.keys(ht.elements)).toHaveLength(ht.inventory.length);
      const [first, second] = await Promise.all([ht.devices["fan"]!.describe(), ht.elements[entry.address]!.describe()]);
      expect(first.uuid).toBe(second.uuid);
      expect(first.methods.map(method => method.name)).toContain("on");
      expect(first.properties.some(property => property.path === "state.value")).toBe(true);
      expect(first.properties.some(property => property.path.startsWith("object."))).toBe(false);
      expect(first.methods.every(method => !("transport" in method))).toBe(true);
      expect(calls).toHaveLength(2);
      expect(fan.relay.calls).toEqual([]);
      const snapshot = await ht.devices["fan"]!.read();
      expect(snapshot).toMatchObject({ state: { availability: "online", value: "off" } });
      expect(snapshot).not.toHaveProperty("object");
      expect(calls.at(-1)?.url).toEndWith("/api/switches/fan");
      const state = await ht.devices["fan"]!.state();
      expect(state).toMatchObject({ availability: "online", value: "off" });
      expect(state).not.toHaveProperty("object");
      expect(calls.at(-1)).toMatchObject({ url: "http://localhost/api/switches/fan/state", method: "GET" });
      expect(calls.at(-1)).not.toHaveProperty("body");
      await ht.devices["fan"]!.on();
      await ht.devices["fan"]!.off();
      await ht.elements[entry.address]!.toggle!();
      expect(fan.relay.calls).toEqual(["on", "off", "toggle"]);
      expect(calls.at(-1)?.url).toEndWith("/api/devices/fan/controls/toggle");
    } finally { hub.stop(); }
  });

  test("nested elements use their own friendly address and scoped contract", async () => {
    const { ht, app, hub, fan, calls } = fixture();
    try {
      await ht.connect("http://localhost");
      const entry = ht.inventory.find(element => element.kind === "control" && element.id.endsWith("/turnOn") && element.context.startsWith("Fan"))!;
      expect(entry.address).toContain("fan");
      expect(entry.commandPage).toBe(`/elements/${entry.address}`);
      const nested = ht.elements[entry.address]!;
      const description = await nested.describe();
      expect(description.methods.some(method => method.name === "on")).toBe(true);
      expect(description.methods.some(method => method.name === "off")).toBe(false);
      await nested.on!();
      expect(calls.at(-1)?.url).toBe("http://localhost/api/devices/fan/controls/turnOn");
      expect(fan.relay.calls).toEqual(["on"]);
      expect((await app.request(`/api/inventory/${entry.uuid}`)).status).toBe(404);
      expect((await app.request(`/api/inventory/${entry.key}`)).status).toBe(404);
    } finally { hub.stop(); }
  });

  test("unknown addresses and methods fail explicitly; reconnect invalidates old handles", async () => {
    const { ht, hub, calls } = fixture();
    try {
      await ht.connect("http://localhost");
      expect(() => ht.devices["missing"]).toThrow("No device named");
      expect(() => ht.elements["missing"]).toThrow("No element named");
      const fan = ht.devices["fan"]!;
      await expect(fan.fly!()).rejects.toThrow("has no method fly");
      expect(calls.every(call => call.method === "GET")).toBe(true);
      await ht.connect("http://localhost");
      await expect(fan.on()).rejects.toThrow("previous connection");
      expect(calls.every(call => call.method === "GET")).toBe(true);
    } finally { hub.stop(); }
  });

  test("tokens scope both the inventory and friendly-address descriptions", async () => {
    const tokens = new TokenStore();
    const { app, ht, hub, calls } = fixture({ tokens });
    try {
      const all = await (await app.request("/api/inventory", { headers: { authorization: `Bearer ${tokens.issue({ name: "All", permissions: ["read"], subject: { all: true } }).token}` } })).json() as { elements: InventoryElement[] };
      const kitchen = tokens.issue({ name: "Kitchen", permissions: ["read"], subject: { criteria: { room: "Kitchen" } } }).token;
      await ht.connect("http://localhost", { token: kitchen });
      expect(Object.keys(ht.devices)).toEqual(["fan"]);
      expect(ht.inventory.some(element => element.id === "other")).toBe(false);
      await ht.devices["fan"]!.describe();
      expect(await ht.devices["fan"]!.state()).toMatchObject({ value: "off" });
      expect(calls.every(call => call.authorization === `Bearer ${kitchen}`)).toBe(true);
      const inaccessible = all.elements.find(element => element.deviceId === "other")!;
      expect((await app.request(`/api/inventory/${inaccessible.address}`, { headers: { authorization: `Bearer ${kitchen}` } })).status).toBe(404);
      await expect(ht.devices["fan"]!.on()).rejects.toThrow("write");
    } finally { hub.stop(); tokens.close(); }
  });

  test("UUIDs come from the persistent graph store and survive a new app", async () => {
    const store = new GraphStore();
    const first = fixture({ store });
    const second = fixture({ store });
    try {
      await first.ht.connect("http://localhost");
      await second.ht.connect("http://localhost");
      const id = first.ht.inventory.find(entry => entry.deviceId === "lutron-fan")!.uuid;
      expect(id).toBe(store.uuidFor(elementKey("device", "lutron-fan"))!);
      expect((await second.ht.elements.fan!.describe()).uuid).toBe(id);
      expect(() => second.ht.elements[id]).toThrow("No element named");
    } finally { first.hub.stop(); second.hub.stop(); store.close(); }
  });

  test("method arguments become scalar values, options and query parameters", async () => {
    const entry: InventoryElement = { address: "lamp", context: "", commandPage: "/elements/lamp", uuid: "uuid", id: "lamp", key: "key", name: "Lamp", kind: "device", side: "instance", page: "/lights/lamp", deviceId: "lamp" };
    const calls: { path: string; body?: unknown }[] = [];
    const contract: ElementContract = { element: entry, properties: [], methods: [
      { name: "brightness", description: "", returns: "DeviceState", positional: "value", arguments: [{ name: "value", type: "number", in: "body", required: true }, { name: "confirmed", type: "boolean", in: "body", required: false }], transport: { method: "POST", path: "/api/devices/lamp/controls/setBrightness", body: "object", media: "application/json" } },
      { name: "events", description: "", returns: "unknown", arguments: [{ name: "limit", type: "number", in: "query", required: false }], transport: { method: "GET", path: "/api/devices/lamp/events", body: "none", media: "application/json" } },
    ] };
    const ht = new HomeTruth({ transport: async (path, init) => {
      calls.push({ path, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (path.endsWith("/api/inventory")) return { elements: [entry] };
      if (path.endsWith("/api/inventory/lamp")) return contract;
      return {};
    } });
    await ht.connect("http://localhost");
    await ht.devices.lamp!.brightness(50, { confirmed: true });
    expect(calls.at(-1)?.body).toEqual({ value: 50, confirmed: true });
    await ht.devices.lamp!.events!({ limit: 5 });
    expect(calls.at(-1)?.path).toBe("http://localhost/api/devices/lamp/events?limit=5");
    const before = calls.length;
    await expect(ht.devices.lamp!.events!({ limti: 5 })).rejects.toThrow("Unknown option");
    await expect(ht.devices.lamp!.brightness(undefined as unknown as number)).rejects.toThrow("requires value");
    expect(calls).toHaveLength(before);
  });

  test("all page examples import the shared library and compile without execution", async () => {
    const { app, site, hub, fan } = fixture();
    try {
      const node = hub.data.topology().node(elementKey("device", "lutron-fan"))!;
      const api = buildElementApi({ site, hub, node, page: "/switches/fan", origin: "http://localhost", routes: app.routes, version: "test" });
      for (const example of clientExamples(api)) {
        expect(example.code).toContain('import ht from "./ht"');
        expect(example.code).toContain('ht.devices["fan"]');
        expect(() => compilePlayground(example.code)).not.toThrow();
      }
      expect(clientExamples(api).find(example => example.name === "tag")!.code).toContain('"tagId":');
      const compiled = compilePlayground('import ht from "./ht"; await ht.connect("http://localhost"); console.log(ht.inventory);');
      expect(compiled).not.toContain('import ht from');
      expect(() => compilePlayground('import fs from "node:fs";')).toThrow();
      expect((await app.request("/switches/fan/playground", { method: "POST" })).status).toBe(404);
      expect(fan.relay.calls).toEqual([]);
    } finally { hub.stop(); }
  });
});

// Compile-time checks for the shared library's native control signatures.
function typedControls(ht: HomeTruth) {
  // @ts-expect-error Brightness takes a number.
  void ht.devices.lamp!.brightness("fifty");
  // @ts-expect-error on takes confirmation options, not a value.
  void ht.devices.lamp!.on(10);
}
