import { describe, expect, test } from "bun:test";
import { BROADLINK_RM4_PRO } from "../../blasters/broadlink-rm4-pro";
import { InfraredBlaster, RadioFrequencyBlaster, type SignalTransmitter } from "../../../models/blaster";
import { Device, type DeviceIdentity } from "../../../models/device";
import { MemorySignalCodeStore } from "../../../signal-code-store";
import { ActionButtonDevice, DeviceActionButton } from ".";

class BlasterDevice extends Device<{ host: string }> {
  readonly model = BROADLINK_RM4_PRO;
  readonly capabilities;
  constructor(readonly sent: string[]) {
    super("blaster", "Living room blaster", { host: "10.77.0.20" });
    const transmitter: SignalTransmitter = {
      send: async (channel, code, options) => { sent.push(`${channel}:${code}:${options?.durationMs ?? 0}`); },
      learn: async () => ({ code: "unused" }),
      probe: async () => {},
    };
    this.capabilities = {
      infraredBlaster: new InfraredBlaster("ir", transmitter),
      radioFrequencyBlaster: new RadioFrequencyBlaster("rf", transmitter),
    };
  }
  async probe(): Promise<DeviceIdentity> { return {}; }
}

describe("DeviceActionButton", () => {
  test("turns a fixed device action into a duration-aware stateless button", async () => {
    const sent: string[] = [];
    const target = new BlasterDevice(sent);
    const button = new DeviceActionButton("candles-on", {
      device: "blaster",
      control: "infraredBlaster.send",
      value: { code: "broadlink-code" },
      durationMaximumMs: 60_000,
    }, target);
    await button.press();
    await button.press({ durationMs: 1_500 });
    expect(sent).toEqual(["infrared:broadlink-code:0", "infrared:broadlink-code:1500"]);
  });

  test("projects a saved Broadlink command and honors its default or per-press hold", async () => {
    const sent: string[] = [];
    const target = new BlasterDevice(sent);
    const store = new MemorySignalCodeStore();
    const saved = await store.add(target.id, { name: "Candles on", channel: "radio-frequency", code: "saved-code", durationMs: 800 });
    const button = new DeviceActionButton("candles-on", { device: target.id, savedCodeId: saved.id }, target, store);
    await button.press();
    await button.press({ durationMs: 1_200 });
    await button.press({ durationMs: 0 });
    expect(sent).toEqual([
      "radio-frequency:saved-code:800",
      "radio-frequency:saved-code:1200",
      "radio-frequency:saved-code:0",
    ]);
  });

  test("provisions as a normal Button device", () => {
    const target = new BlasterDevice([]);
    const device = new ActionButtonDevice({ id: "candles-on", name: "Candles on" }, {
      device: target.id,
      control: "infraredBlaster.send",
      value: { code: "code" },
      durationMaximumMs: 60_000,
    }, {}, { device: () => target });
    expect(device.model.capabilities).toEqual(["button"]);
    expect(device.controls()).toEqual(["press"]);
  });

  test("reports the target device's own reachability, not a status of its own", async () => {
    const reachable = new BlasterDevice([]);
    const online = new DeviceActionButton("candles-on", { device: reachable.id, control: "infraredBlaster.send", value: { code: "code" } }, reachable);
    expect((await online.describe()).state).toEqual({ availability: "online" });

    const unreachableTransmitter: SignalTransmitter = { send: async () => {}, learn: async () => ({ code: "unused" }), probe: async () => { throw new Error("unreachable"); } };
    class UnreachableBlasterDevice extends Device<{ host: string }> {
      readonly model = BROADLINK_RM4_PRO;
      readonly capabilities = { infraredBlaster: new InfraredBlaster("ir", unreachableTransmitter) };
      constructor() { super("blaster-2", "Bedroom blaster", { host: "10.77.0.21" }); }
      async probe(): Promise<DeviceIdentity> { return {}; }
    }
    const unreachable = new UnreachableBlasterDevice();
    const offline = new DeviceActionButton("candles-off", { device: unreachable.id, control: "infraredBlaster.send", value: { code: "code" } }, unreachable);
    expect((await offline.describe()).state).toEqual({ availability: "offline" });
  });
});
