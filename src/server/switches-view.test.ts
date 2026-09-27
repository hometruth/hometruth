import { describe, expect, spyOn, test } from "bun:test";
import type { DeviceConfigEntry } from "../config/devices";
import type { DeviceConfigWriter } from "../config/device-writer";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";
import { BroadlinkRm4Pro } from "../devices/blasters/broadlink-rm4-pro";
import { OptimisticSwitchDevice } from "../devices/composites/optimistic-switch";
import { BinarySwitch, type BinarySwitchState } from "../models/binary-switch";
import { Button, type ButtonPressOptions } from "../models/button";
import { Device, type DeviceIdentity, type DeviceModel } from "../models/device";
import { buttonSchema } from "../schemas";
import { Site } from "../site";
import { MemorySignalCodeStore } from "../signal-code-store";
import { createApp } from "./app";

class MemorySwitch extends BinarySwitch {
  constructor(id: string, private state: BinarySwitchState = "off") { super(id); }
  async turnOn() { this.state = "on" as const; }
  async turnOff() { this.state = "off" as const; }
  async toggle() { this.state = this.state === "on" ? "off" : "on"; }
  async getState() { return this.state; }
}

class SwitchDevice extends Device<{ host: string }> {
  readonly model = SHELLY_PLUS_1;
  readonly capabilities;
  constructor(id: string, name: string) {
    super(id, name, { host: "10.77.0.2" });
    this.capabilities = { binarySwitch: new MemorySwitch(id) };
  }
  async probe(): Promise<DeviceIdentity> { return {}; }
}

const BUTTON_MODEL: DeviceModel<Record<string, never>> = {
  id: "test-button",
  title: "Test Button",
  manufacturer: "HomeTruth",
  product: "Test Button",
  capabilities: ["button"],
  connectionTypes: ["direct-local"],
  configSchema: { $id: "https://hometruth.local/test/button-config", type: "object" },
  objectSchemaId: buttonSchema.$id,
  create() { throw new Error("not used"); },
};

class TestButton extends Button {
  protected async performPress(_options: ButtonPressOptions): Promise<void> {}
}

class ButtonDevice extends Device<Record<string, never>> {
  override displayHost() { return "Test button"; }
  readonly model = BUTTON_MODEL;
  readonly capabilities;
  constructor(id: string, name: string) {
    super(id, name, {});
    this.capabilities = { button: new TestButton(id) };
  }
  async probe(): Promise<DeviceIdentity> { return {}; }
}

class RecordingWriter implements DeviceConfigWriter {
  readonly entries: DeviceConfigEntry[] = [];
  readonly rooms: { id: string; room: string | null }[] = [];
  async setRoom(id: string, room: string | null) { this.rooms.push({ id, room }); }
  readonly renames: { id: string; name: string }[] = [];
  readonly enabledChanges: { id: string; enabled: boolean }[] = [];
  async add(entry: DeviceConfigEntry) { this.entries.push(entry); }
  async addAll(entries: readonly DeviceConfigEntry[]) { this.entries.push(...entries); }
  async rename(id: string, name: string) { this.renames.push({ id, name }); }
  async setEnabled(id: string, enabled: boolean) { this.enabledChanges.push({ id, enabled }); }
}

function fixture(writable = true) {
  const site = new Site([
    new SwitchDevice("gate", "Gate"),
    new ButtonDevice("candles-on", "Candles on"),
    new ButtonDevice("candles-off", "Candles off"),
    new BroadlinkRm4Pro({ id: "blaster", name: "Living room blaster" }, { host: "10.77.0.3" }, {
      transmitter: { async send() {}, async learn() { throw new Error("not used"); }, async probe() {} },
    }),
  ]);
  const writer = new RecordingWriter();
  const signalCodes = new MemorySignalCodeStore();
  const app = createApp(undefined, site, signalCodes, undefined, undefined, undefined, undefined, writable ? writer : undefined);
  const post = (body: unknown) => app.request("/api/switches", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { app, site, writer, signalCodes, post };
}

describe("Switches view", () => {
  test("offers room editing for switches and devices, validates assignments, and supports clearing", async () => {
    const { app, site, writer } = fixture();
    site.get("gate")!.room = "Kitchen";
    const inventory = await (await app.request("/api/devices")).json();
    expect(inventory.devices.find((device: { id: string }) => device.id === "gate").room).toBe("Kitchen");
    expect((await (await app.request("/api/devices/gate")).json()).room).toBe("Kitchen");
    for (const page of ["/switches/gate/settings", "/buttons/candles-on/settings"]) {
      expect(await (await app.request(page)).text()).toContain("data-room-picker");
    }
    expect(await (await app.request("/switches")).text()).toContain("Kitchen");
    expect(await (await app.request("/api/rooms")).json()).toMatchObject({ writable: true });
    const set = (body: unknown, id = "gate") => app.request(`/api/devices/${id}/room`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    for (const room of ["Living Room", "Kitchen", null]) expect((await set({ room })).status).toBe(200);
    expect(writer.rooms).toEqual([{ id: "gate", room: "Living Room" }, { id: "gate", room: "Kitchen" }, { id: "gate", room: null }]);
    for (const body of [{}, { room: "" }, { room: "  " }, { room: 42 }, { room: "x".repeat(101) }, { room: "Kitchen", extra: true }]) {
      expect((await set(body)).status).toBe(400);
    }
    expect((await set({ room: "Office" }, "missing")).status).toBe(404);
    // A room is a tag now, so it is always writable: the tag store is always
    // there, and an instance with no writable YAML still records the room.
    const readOnly = fixture(false).app;
    expect(await (await readOnly.request("/api/rooms")).json()).toMatchObject({ writable: true });
    expect((await readOnly.request("/api/devices/gate/room", {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"room":"Office"}',
    })).status).toBe(200);
  });

  test("reports a button-pair switch as unknown while its buttons report no availability of their own, and remembers the value", async () => {
    const on = new ButtonDevice("candles-on", "Candles on");
    const off = new ButtonDevice("candles-off", "Candles off");
    const candles = new OptimisticSwitchDevice(
      { id: "candles", name: "Fireplace Candles" },
      { onButton: on.id, offButton: off.id },
      {},
      { device: (id) => id === on.id ? on : off },
    );
    const app = createApp(undefined, new Site([on, off, candles]));
    const initial = await app.request("/api/switches/candles");
    expect(initial.status).toBe(200);
    expect((await initial.json()).state).toEqual({ availability: "unknown" });
    for (const [action, value] of [["toggle", "on"], ["turn-off", "off"], ["turn-on", "on"]]) {
      const response = await app.request(`/api/switches/candles/${action}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      expect(response.status).toBe(200);
      expect((await response.json()).state).toMatchObject({ availability: "unknown", value });
      expect((await (await app.request("/api/switches/candles")).json()).state).toMatchObject({ availability: "unknown", value });
    }
  });

  test("shows every Switch, offers Button pairs, and sits beside Devices and Schemas", async () => {
    const { app } = fixture();
    const response = await app.request("/switches");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("Gate");
    expect(html).toContain('data-switch-id="gate"');
    expect(html).toContain('<ht-switch-row node="device/gate">');
    expect(html).toContain('id="ht-state"');
    expect(html).not.toContain("data-switch-action");
    expect(html).toContain('<option value="candles-on">Candles on — Test Button</option>');
    expect(html).toContain('<option value="candles-off">Candles off — Test Button</option>');
    expect(html).toContain('href="/devices"');
    expect(html).toContain('href="/switches" aria-current="page"');
    expect(html).toContain('href="/schemas"');
    expect(html).toContain("/api/switches");
  });

  test("offers saved Broadlink commands as Buttons and materializes them with the Switch", async () => {
    const { app, writer, signalCodes, post } = fixture();
    // Write through the application so its materialized signal index sees the change.
    for (const [name, code] of [["Candles on", "AAEC"], ["Candles off", "AAED"]]) {
      const saved = await app.request("/api/ir-rf-blasters/blaster/codes", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, channel: "radio-frequency", code }),
      });
      expect(saved.status).toBe(200);
    }
    const [on, off] = await signalCodes.list("blaster");
    if (!on || !off) throw new Error("Missing saved test signals");
    const html = await (await app.request("/switches")).text();
    const onReference = `@broadlink:blaster:${on.id}`;
    const offReference = `@broadlink:blaster:${off.id}`;
    expect(html).toContain(`value="${onReference}"`);
    expect(html).toContain("Candles on — Living room blaster · RF Button");

    const response = await post({ id: "candles", name: "Candles", onButton: onReference, offButton: offReference });
    expect(response.status).toBe(201);
    expect(writer.entries).toEqual([
      { id: "blaster-candles-on", name: "Candles on", model: "action-button", config: { device: "blaster", savedCodeId: on.id } },
      { id: "blaster-candles-off", name: "Candles off", model: "action-button", config: { device: "blaster", savedCodeId: off.id } },
      { id: "candles", name: "Candles", model: "optimistic-switch", config: { onButton: "blaster-candles-on", offButton: "blaster-candles-off" } },
    ]);
  });

  test("creates only a validated optimistic switch from two configured Buttons", async () => {
    const { writer, post } = fixture();
    const response = await post({ id: "candles", name: "Candles", onButton: "candles-on", offButton: "candles-off", initialState: "off" });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: "candles", page: "/devices/candles" });
    expect(writer.entries).toEqual([{
      id: "candles",
      name: "Candles",
      model: "optimistic-switch",
      config: { onButton: "candles-on", offButton: "candles-off", initialState: "off" },
    }]);
  });

  test("rejects duplicate ids, non-Button inputs, malformed requests, and read-only instances", async () => {
    const { post } = fixture();
    expect((await post({ id: "gate", name: "Other", onButton: "candles-on", offButton: "candles-off" })).status).toBe(409);
    expect((await post({ id: "bad", name: "Bad", onButton: "gate", offButton: "candles-off" })).status).toBe(400);
    expect((await post({ id: "bad id", name: "Bad", onButton: "candles-on", offButton: "candles-off" })).status).toBe(400);
    expect((await fixture(false).post({ id: "candles", name: "Candles", onButton: "candles-on", offButton: "candles-off" })).status).toBe(409);
  });

  test("allows the same Button for on and off, building a power-button toggle", async () => {
    const { writer, post } = fixture();
    const response = await post({ id: "lamp", name: "Lamp", onButton: "candles-on", offButton: "candles-on", initialState: "off" });
    expect(response.status).toBe(201);
    expect(writer.entries).toEqual([{
      id: "lamp",
      name: "Lamp",
      model: "optimistic-switch",
      config: { onButton: "candles-on", offButton: "candles-on", initialState: "off" },
    }]);
  });

  test("renames a device from its Settings page", async () => {
    const { app, writer } = fixture();
    const page = await app.request("/switches/gate/settings");
    const html = await page.text();
    expect(html).toContain("data-device-rename");
    expect(html).toContain('value="Gate"');
    expect(html).toContain("/api/devices/");

    const response = await app.request("/api/devices/gate/name", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "  Driveway Gate  " }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "gate", name: "Driveway Gate", page: "/switches/gate" });
    expect(writer.renames).toEqual([{ id: "gate", name: "Driveway Gate" }]);
  });

  test("reads enabled as a boolean and changes it through enable and disable without polling hardware", async () => {
    const { app, site, writer } = fixture();
    const read = spyOn((site.get("gate") as SwitchDevice).capabilities.binarySwitch, "getState");
    const html = await (await app.request("/switches/gate/settings")).text();
    expect(html).toContain("data-device-enabled");
    expect(html).toContain("checked");
    expect(html).toContain('(enabled ? "/enable" : "/disable")');
    const initial = await app.request("/api/devices/gate/enabled");
    expect(initial.status).toBe(200);
    expect(initial.headers.get("cache-control")).toBe("no-store");
    expect(await initial.json()).toBe(true);
    for (const enabled of [false, false, true]) {
      const response = await app.request(`/api/devices/gate/${enabled ? "enable" : "disable"}`, {
        method: "POST", headers: { "content-type": "application/json" },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toBe(enabled);
      expect(await (await app.request("/api/devices/gate/enabled")).json()).toBe(enabled);
      expect(site.get("gate")!.enabled).toBe(enabled);
    }
    expect(writer.enabledChanges).toEqual([{ id: "gate", enabled: false }, { id: "gate", enabled: false }, { id: "gate", enabled: true }]);
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  });

  test("enabled remains readable without writable configuration, and the old POST is gone", async () => {
    const { app } = fixture(false);
    expect(await (await app.request("/api/devices/gate/enabled")).json()).toBe(true);
    const post = (id: string, action: string) => app.request(`/api/devices/${id}/${action}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    for (const action of ["enable", "disable"]) {
      expect((await post("gate", action)).status).toBe(409);
      expect((await post("missing", action)).status).toBe(404);
    }
    expect((await app.request("/api/devices/missing/enabled")).status).toBe(404);
    expect((await post("gate", "enabled")).status).toBe(404);
  });

  test("a failed enabled write leaves the current setting unchanged", async () => {
    const { app, site, writer } = fixture();
    writer.setEnabled = async () => { throw new Error("Unable to save configuration"); };
    const response = await app.request("/api/devices/gate/disable", {
      method: "POST", headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(500);
    expect(site.get("gate")!.enabled).toBe(true);
    expect(await (await app.request("/api/devices/gate/enabled")).json()).toBe(true);
  });

  test("reflects a disabled device in the list and detail without probing it", async () => {
    const { app, site } = fixture();
    site.get("gate")!.enabled = false;
    const read = spyOn(site.get("gate")!, "describe");
    const list = await (await app.request("/api/devices")).json();
    expect(list.devices.find((device: { id: string }) => device.id === "gate")).toMatchObject({ enabled: false, availability: "offline", detail: "Disabled" });
    expect(await (await app.request("/api/devices/gate/enabled")).json()).toBe(false);
    const detail = await app.request("/api/devices/gate");
    expect(detail.status).toBe(502);
    expect((await detail.json()).error).toMatchObject({ code: "unreachable" });
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  });
});
