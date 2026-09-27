import { describe, expect, test } from "bun:test";
import { LIGHT_GROUP, LightGroupDevice } from "../devices/composites/light-group";
import { SYNTHETIC_SWITCH, SyntheticSwitchDevice } from "../devices/composites/synthetic-switch";
import { ACTION_BUTTON } from "../devices/composites/action-button";
import { MemoryOptimisticSwitchStateStore, OPTIMISTIC_SWITCH, OptimisticSwitchDevice } from "../devices/composites/optimistic-switch";
import { Light, type LightState } from "../models/light";
import { Device, type CapabilityMethods, type DeviceIdentity, type DeviceInstance, type DeviceModel, type SecretsBag, type SiteServices } from "../models/device";
import { lightSchema } from "../schemas";
import { parseDevicesConfig } from "./devices";
import { provision } from "./provision";

class MemoryLight extends Light {
  private state: LightState = { on: false, brightnessPercent: 100, colorTemperatureKelvin: 4000, color: "#ffffff" };
  override supportsColor() { return true; }
  async turnOn() { this.state = { ...this.state, on: true }; }
  async turnOff() { this.state = { ...this.state, on: false }; }
  async toggle() { this.state = { ...this.state, on: !this.state.on }; }
  async setBrightness(value: number) { this.state = { ...this.state, brightnessPercent: value }; }
  async setColorTemperature(value: number) { this.state = { ...this.state, colorTemperatureKelvin: value }; }
  override async setColor(value: string) { this.state = { ...this.state, color: value }; }
  async getState() { return this.state; }
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface MemoryLightDevice extends CapabilityMethods<{ light: MemoryLight }> {}
class MemoryLightDevice extends Device<Record<string, never>> {
  readonly model = MEMORY_LIGHT;
  readonly capabilities;
  readonly light: MemoryLight;
  constructor(instance: DeviceInstance) {
    super(instance.id, instance.name, {});
    this.light = new MemoryLight(instance.id);
    this.capabilities = this.expose({ light: this.light });
  }
  async probe(): Promise<DeviceIdentity> { return {}; }
}

const MEMORY_LIGHT: DeviceModel<Record<string, never>> = {
  id: "memory-light",
  title: "Memory light",
  manufacturer: "Test",
  product: "Memory light",
  capabilities: ["light"],
  connectionTypes: ["direct-local"],
  configSchema: { $id: "https://hometruth.local/test/memory-light", type: "object", additionalProperties: false },
  objectSchemaId: lightSchema.$id,
  create(instance: DeviceInstance, _config: Record<string, never>, _services: SiteServices, _secrets: SecretsBag) { return new MemoryLightDevice(instance); },
};

const MODELS = [MEMORY_LIGHT, LIGHT_GROUP, SYNTHETIC_SWITCH, ACTION_BUTTON, OPTIMISTIC_SWITCH];

describe("composite provisioning", () => {
  test("resolves forward references, preserves file order, and allows nested compositions", async () => {
    const config = parseDevicesConfig(`
schemaVersion: 2
devices:
  - id: scene
    model: synthetic-switch
    config:
      members:
        - { device: room, on: on, off: off }
        - { device: accent, on: off, off: on }
  - id: room
    model: light-group
    config: { members: [one, two, three] }
  - { id: one, model: memory-light, config: {} }
  - { id: two, model: memory-light, config: {} }
  - { id: three, model: memory-light, config: {} }
  - { id: accent, model: memory-light, config: {} }
`);
    const devices = provision(config, MODELS, {});
    expect(devices.map((device) => device.id)).toEqual(["scene", "room", "one", "two", "three", "accent"]);
    const scene = devices[0] as SyntheticSwitchDevice;
    const room = devices[1] as LightGroupDevice;

    await room.light.setColor("#123456");
    expect(await Promise.all([2, 3, 4].map((index) => (devices[index] as MemoryLightDevice).light.getState())))
      .toEqual(Array.from({ length: 3 }, () => ({ on: false, brightnessPercent: 100, colorTemperatureKelvin: 4000, color: "#123456" })));
    await scene.turnOn();
    expect(await scene.getState()).toBe("on");
    expect((await room.light.getState()).on).toBe(true);
    expect((await (devices[5] as MemoryLightDevice).light.getState()).on).toBe(false);
    expect((await scene.describe()).capabilities.binarySwitch?.state.value).toBe("on");
  });

  test("reports missing references and composition cycles as invalid config", () => {
    const missing = parseDevicesConfig("schemaVersion: 2\ndevices:\n  - { id: room, model: light-group, config: { members: [one, absent] } }\n  - { id: one, model: memory-light, config: {} }\n");
    expect(() => provision(missing, MODELS, {})).toThrow(/Device "room" references "absent"/u);

    const cycle = parseDevicesConfig("schemaVersion: 2\ndevices:\n  - { id: a, model: light-group, config: { members: [b, one] } }\n  - { id: b, model: light-group, config: { members: [a, two] } }\n  - { id: one, model: memory-light, config: {} }\n  - { id: two, model: memory-light, config: {} }\n");
    expect(() => provision(cycle, MODELS, {})).toThrow(/Device composition cycle: a -> b -> a/u);
  });

  test("builds an optimistic switch from two action Buttons and observes direct presses", async () => {
    const config = parseDevicesConfig(`
schemaVersion: 2
devices:
  - id: lamp-switch
    model: optimistic-switch
    config: { onButton: lamp-on, offButton: lamp-off }
  - id: lamp-on
    model: action-button
    config: { device: lamp, control: turnOn }
  - id: lamp-off
    model: action-button
    config: { device: lamp, control: turnOff }
  - { id: lamp, model: memory-light, config: {} }
`);
    const states = new MemoryOptimisticSwitchStateStore();
    const devices = provision(config, MODELS, { optimisticSwitchStates: states });
    const switch_ = devices[0] as OptimisticSwitchDevice;
    await expect(switch_.getState()).rejects.toThrow(/unknown/u);

    await devices[1]!.invokeControl("press");
    expect(await switch_.getState()).toBe("on");
    expect((await (devices[3] as MemoryLightDevice).light.getState()).on).toBe(true);
    await switch_.turnOff();
    expect(await switch_.getState()).toBe("off");
  });
});
