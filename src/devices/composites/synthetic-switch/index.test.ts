import { describe, expect, test } from "bun:test";
import { BinarySwitch, type BinarySwitchState } from "../../../models/binary-switch";
import { Device, type DeviceIdentity, type DeviceModel } from "../../../models/device";
import { SyntheticSwitchCapability } from ".";

class MemorySwitch extends BinarySwitch {
  constructor(id: string, private state: BinarySwitchState) { super(id); }
  async turnOn() { this.state = "on" as const; }
  async turnOff() { this.state = "off" as const; }
  async toggle() { this.state = this.state === "on" ? "off" : "on"; }
  async getState() { return this.state; }
}

const TEST_MODEL = { id: "test", title: "Test", manufacturer: "Test", product: "Test", capabilities: ["binarySwitch"], configSchema: { $id: "test", type: "object" }, objectSchemaId: "test" } as unknown as DeviceModel;
class SwitchDevice extends Device {
  readonly model = TEST_MODEL;
  readonly capabilities;
  constructor(id: string, readonly switch_: MemorySwitch) { super(id, id, {}); this.capabilities = { binarySwitch: switch_ }; }
  async probe(): Promise<DeviceIdentity> { return {}; }
}

describe("SyntheticSwitchCapability", () => {
  test("applies independently defined on and off scenes and recognizes only the on scene as on", async () => {
    const one = new SwitchDevice("one", new MemorySwitch("one", "off"));
    const two = new SwitchDevice("two", new MemorySwitch("two", "on"));
    const devices = new Map([[one.id, one], [two.id, two]]);
    const synthetic = new SyntheticSwitchCapability("movie", [
      { device: "one", on: "on", off: "off" },
      { device: "two", on: "off", off: "on" },
    ], { device: (id) => devices.get(id)! });

    expect(await synthetic.getState()).toBe("off");
    await synthetic.turnOn();
    expect(await Promise.all([one.switch_.getState(), two.switch_.getState()])).toEqual(["on", "off"]);
    expect(await synthetic.getState()).toBe("on");
    await synthetic.toggle();
    expect(await Promise.all([one.switch_.getState(), two.switch_.getState()])).toEqual(["off", "on"]);
  });

  test("rejects missing, ambiguous, and duplicate switch-like members", () => {
    const one = new SwitchDevice("one", new MemorySwitch("one", "off"));
    const context = { device: (_id: string) => one };
    expect(() => new SyntheticSwitchCapability("bad", [
      { device: "one", on: "on", off: "off" },
      { device: "one", on: "off", off: "on" },
    ], context)).toThrow(/listed more than once/u);
  });
});
