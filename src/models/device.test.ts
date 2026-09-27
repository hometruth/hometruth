import { describe, expect, test } from "bun:test";
import { BROADLINK_RM4_PRO } from "../devices/blasters/broadlink-rm4-pro";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";
import { BinarySwitch, type BinarySwitchState } from "./binary-switch";
import { InfraredBlaster, RadioFrequencyBlaster, type SignalTransmitter } from "./blaster";
import { Device, DeviceError, type CapabilityMethods, type DeviceIdentity } from "./device";

class MemorySwitch extends BinarySwitch {
  state: BinarySwitchState = "off";
  async turnOn(): Promise<void> { this.state = "on"; }
  async turnOff(): Promise<void> { this.state = "off"; }
  async toggle(): Promise<void> { this.state = this.state === "on" ? "off" : "on"; }
  async getState(): Promise<BinarySwitchState> { return this.state; }
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface SwitchDevice extends CapabilityMethods<{ binarySwitch: MemorySwitch }> {}
class SwitchDevice extends Device<{ host: string }> {
  readonly model = SHELLY_PLUS_1;
  readonly capabilities;
  constructor(readonly relay = new MemorySwitch("relay")) {
    super("relay", "Porch relay", { host: "10.77.0.228" });
    this.capabilities = this.expose({ binarySwitch: relay });
  }
  async probe(): Promise<DeviceIdentity> { return {}; }
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface BlasterDevice extends CapabilityMethods<{ infraredBlaster: InfraredBlaster; radioFrequencyBlaster: RadioFrequencyBlaster }> {}
class BlasterDevice extends Device<{ host: string }> {
  readonly model = BROADLINK_RM4_PRO;
  readonly capabilities;
  readonly sent: string[] = [];
  constructor() {
    super("blaster", "Living room blaster", { host: "10.78.0.30" });
    const transmitter: SignalTransmitter = {
      send: async (channel, code) => { this.sent.push(`${channel}:${code}`); },
      learn: async () => { throw new Error("not in this test"); },
      probe: async () => {},
    };
    this.capabilities = this.expose({ infraredBlaster: new InfraredBlaster("ir", transmitter), radioFrequencyBlaster: new RadioFrequencyBlaster("rf", transmitter) });
  }
  async probe(): Promise<DeviceIdentity> { return {}; }
}

/** A capability that publishes a name the device already owns. */
class PushySwitch extends MemorySwitch {
  override readonly methods = ["turnOn", "probe", "describe"] as unknown as MemorySwitch["methods"];
  async probe(): Promise<string> { return "from the capability"; }
}

describe("device control namespace", () => {
  test("a control owned by one capability is invokable by its bare name or qualified", async () => {
    const device = new SwitchDevice();
    expect(device.controls()).toEqual(["turnOn", "turnOff", "toggle", "getState"]);
    expect(device.resolveControl("toggle")).toEqual({ kind: "binarySwitch", controlId: "toggle" });
    await device.invokeControl("turnOn");
    expect(device.relay.state).toBe("on");
    await device.invokeControl("binarySwitch.toggle");
    expect(device.relay.state).toBe("off");
    expect(await device.invokeControl("getState")).toBe("off");
  });

  test("a control two capabilities share must be qualified, and the list says so", async () => {
    const device = new BlasterDevice();
    expect(device.controls()).toEqual(["infraredBlaster.send", "infraredBlaster.learn", "radioFrequencyBlaster.send", "radioFrequencyBlaster.learn"]);
    await expect(device.invokeControl("send", "JgBS")).rejects.toMatchObject({ code: "ambiguous_control", message: expect.stringContaining("infraredBlaster.send or radioFrequencyBlaster.send") });
    await device.invokeControl("radioFrequencyBlaster.send", "JgBS");
    expect(device.sent).toEqual(["radio-frequency:JgBS"]);
  });

  test("a capability's public methods are forwarded onto the device by their bare names", async () => {
    const device = new SwitchDevice();
    await device.turnOn();
    expect(device.relay.state).toBe("on");
    expect(await device.getState()).toBe("on");
    await device.toggle();
    expect(await device.relay.getState()).toBe("off");
    const state: BinarySwitchState = await device.getState();
    expect(state).toBe("off");
    // @ts-expect-error nothing publishes explode
    expect(device.explode).toBeUndefined();
    // Forwarders are not enumerable, so the device still serialises as its own fields.
    expect(Object.keys(device)).not.toContain("turnOn");
  });

  test("a method two capabilities publish is not forwarded, and a device's own members win", async () => {
    const blaster = new BlasterDevice();
    // @ts-expect-error send is on both blaster capabilities, so it stays on them
    expect(blaster.send).toBeUndefined();
    await blaster.capabilities.infraredBlaster.send("JgBS");
    expect(blaster.sent).toEqual(["infrared:JgBS"]);

    const pushy = new SwitchDevice(new PushySwitch("relay"));
    expect(await pushy.probe()).toEqual({});
    expect((await pushy.describe()).id).toBe("relay");
    await pushy.turnOn();
    expect(pushy.relay.state).toBe("on");
  });

  test("names nothing owns, or a capability the device lacks, are unknown controls", async () => {
    const device = new SwitchDevice();
    for (const reference of ["explode", "light.turnOn", "binarySwitch.explode"]) {
      await expect(device.invokeControl(reference)).rejects.toBeInstanceOf(DeviceError);
      await expect(device.invokeControl(reference)).rejects.toMatchObject({ code: "unknown_control" });
    }
  });
});

describe("combinedAvailability", () => {
  test("ignores capabilities that do not know, unless none knows", async () => {
    const { combinedAvailability } = await import("./capability");
    expect(combinedAvailability(["online", "unknown"])).toBe("online");
    expect(combinedAvailability(["offline", "unknown"])).toBe("offline");
    expect(combinedAvailability(["online", "offline"])).toBe("degraded");
    expect(combinedAvailability(["unknown", "unknown"])).toBe("unknown");
    expect(combinedAvailability([])).toBe("unknown");
  });
});
