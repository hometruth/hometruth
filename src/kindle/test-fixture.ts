import { BinarySwitch, BinarySwitchError, type BinarySwitchState } from "../models/binary-switch";
import { Button } from "../models/button";
import { Light, type LightState } from "../models/light";
import { Device, type DeviceModel } from "../models/device";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";

export class TestRelay extends BinarySwitch {
  state: BinarySwitchState = "off";
  writes = 0;
  offline = false;
  async turnOn() { this.writes++; this.state = "on"; }
  async turnOff() { this.writes++; this.state = "off"; }
  async toggle() { this.writes++; this.state = this.state === "on" ? "off" : "on"; }
  async getState(): Promise<BinarySwitchState> {
    if (this.offline) throw new BinarySwitchError("offline", "unreachable");
    return this.state;
  }
}
export class TestButton extends Button {
  presses = 0;
  protected async performPress() { this.presses++; }
}
export class TestLight extends Light {
  on = false;
  async turnOn() { this.on = true; }
  async turnOff() { this.on = false; }
  async toggle() { this.on = !this.on; }
  async setBrightness() {}
  async setColorTemperature() {}
  async getState(): Promise<LightState> { return { on: this.on, brightnessPercent: 50 }; }
}
export class CompositeDevice extends Device<{ host: string }> {
  readonly model: DeviceModel<{ host: string }> = { ...SHELLY_PLUS_1, id: "test-composite", title: "Composite model", capabilities: ["binarySwitch", "button", "light"] };
  readonly relay = new TestRelay("relay");
  readonly button = new TestButton("button");
  readonly light = new TestLight("light");
  readonly capabilities = { binarySwitch: this.relay, button: this.button, light: this.light };
  constructor(id = "composite", name = "Composite device") { super(id, name, { host: "" }); }
  async probe() { return {}; }
}

/** Explicit observation before testing the pure presentation layer. No servers or timers. */
export async function observedKindleState(site: import("../site").Site): Promise<import("./presentation").KindleState> {
  const { SelectedDeviceGroup } = await import("../models/device-group");
  const documents = new Map(await Promise.all(site.devices.map(async device => [device.id, await device.describe()] as const)));
  return {
    record: id => documents.has(id) ? { node: `device/${id}`, value: documents.get(id), version: 1, observedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } : undefined,
    group: id => {
      const group = site.deviceGroups.find(group => group.id === id);
      return group ? new SelectedDeviceGroup(group.members.flatMap(id => site.get(id) ?? []), Boolean(group.criteria)).snapshot(documents) : undefined;
    },
  };
}
