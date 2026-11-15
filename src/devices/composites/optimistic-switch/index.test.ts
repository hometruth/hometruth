import { describe, expect, test } from "bun:test";
import { combinedAvailability, type Availability } from "../../../models/capability";
import { Button, type ButtonPressOptions } from "../../../models/button";
import { Device } from "../../../models/device";
import { ACTION_BUTTON } from "../action-button";
import { MemoryOptimisticSwitchStateStore, OptimisticButtonSwitch, OptimisticSwitchDevice } from ".";

class MemoryButton extends Button {
  presses = 0;
  fail = false;
  targetAvailability: Availability = "unknown";
  protected async performPress(_options: ButtonPressOptions) {
    if (this.fail) throw new Error("send failed");
    this.presses++;
  }
  protected override async availability() { return this.targetAvailability; }
}

class MemoryButtonDevice extends Device {
  readonly model = ACTION_BUTTON;
  readonly capabilities;
  constructor(id: string, button: MemoryButton) { super(id, id, {}); this.capabilities = { button }; }
  async probe() { return {}; }
}

test("an optimistic switch checks button reachability without needing a remembered value or pressing anything", async () => {
  const on = new MemoryButton("on");
  const off = new MemoryButton("off");
  on.targetAvailability = off.targetAvailability = "online";
  const buttons = { on: new MemoryButtonDevice("on", on), off: new MemoryButtonDevice("off", off) };
  const device = new OptimisticSwitchDevice({ id: "example-lamp", name: "Example lamp" }, { onButton: "on", offButton: "off" }, {}, {
    device: id => buttons[id as keyof typeof buttons],
  });
  try {
    await Promise.all(Object.values(buttons).map(button => button.describe()));
    expect((await device.checkHealth()).status).toBe("healthy");
    await expect(device.switch.getState()).rejects.toThrow(/unknown/u);
    off.targetAvailability = "offline";
    await buttons.off.describe();
    expect((await device.checkHealth()).status).toBe("degraded");
    on.targetAvailability = "offline";
    await buttons.on.describe();
    expect((await device.checkHealth()).status).toBe("unhealthy");
    expect(on.presses + off.presses).toBe(0);
  } finally { await device.close(); }
});

describe("OptimisticButtonSwitch", () => {
  test("keeps command and assumption timestamps truthful when refreshed", async () => {
    const on = new MemoryButton("on"), off = new MemoryButton("off"), store = new MemoryOptimisticSwitchStateStore();
    let now = "2026-09-03T20:00:00.000Z";
    const device = new OptimisticButtonSwitch("lamp", on, off, store, () => "online", "off", () => new Date(now));
    expect((await device.describe()).state).toEqual({ availability: "online", value: "off", stateSource: "assumed", assumedAt: now });
    expect(store.forSwitch("lamp", "on", "off").get()).toBeUndefined();
    now = "2026-09-03T20:01:00.000Z";
    await on.press();
    const commanded = { availability: "online", value: "on", stateSource: "commanded", commandedAt: now } as const;
    expect((await device.describe()).state).toEqual(commanded);
    now = "2026-09-03T20:02:00.000Z";
    expect((await device.describe()).state).toEqual(commanded);
    off.fail = true;
    await expect(device.turnOff()).rejects.toThrow("send failed");
    expect((await device.describe()).state).toEqual(commanded);
    off.fail = false;
    await off.press();
    expect((await device.describe()).state).toEqual({ availability: "online", value: "off", stateSource: "commanded", commandedAt: now });
    device.close();
  });

  test("starts unknown unless configured, then remembers whichever button succeeded last", async () => {
    const on = new MemoryButton("on");
    const off = new MemoryButton("off");
    const states = new MemoryOptimisticSwitchStateStore();
    const device = new OptimisticButtonSwitch("candles", on, off, states, () => "unknown");
    await expect(device.getState()).rejects.toThrow(/unknown/u);
    expect((await device.describe()).state).toEqual({ availability: "unknown" });

    await on.press();
    expect(await device.getState()).toBe("on");
    await device.turnOff();
    expect(await device.getState()).toBe("off");
    expect(on.presses).toBe(1);
    expect(off.presses).toBe(1);
  });

  test("toggle starts an unknown switch on and remembers only successful presses", async () => {
    const on = new MemoryButton("on");
    const off = new MemoryButton("off");
    const device = new OptimisticButtonSwitch("candles", on, off, new MemoryOptimisticSwitchStateStore(), () => "unknown");
    on.fail = true;
    await expect(device.toggle()).rejects.toThrow("send failed");
    expect((await device.describe()).state).toEqual({ availability: "unknown" });
    on.fail = false;
    await device.toggle();
    expect((await device.describe()).state).toMatchObject({ availability: "unknown", value: "on" });
    await device.toggle();
    expect((await device.describe()).state).toMatchObject({ availability: "unknown", value: "off" });
    expect(on.presses).toBe(1);
    expect(off.presses).toBe(1);
  });

  test("uses an optional initial assumption and never changes memory after a failed press", async () => {
    const on = new MemoryButton("on");
    const off = new MemoryButton("off");
    const device = new OptimisticButtonSwitch("candles", on, off, new MemoryOptimisticSwitchStateStore(), () => "unknown", "off");
    expect(await device.getState()).toBe("off");
    on.fail = true;
    await expect(device.turnOn()).rejects.toThrow("send failed");
    expect(await device.getState()).toBe("off");
  });

  describe("same Button for on and off (power-button toggle)", () => {
    test("turnOn/turnOff only press when a press is needed, toggle always presses", async () => {
      const power = new MemoryButton("power");
      const device = new OptimisticButtonSwitch("lamp", power, power, new MemoryOptimisticSwitchStateStore(), () => "unknown", "off");
      await device.turnOn();
      expect(await device.getState()).toBe("on");
      expect(power.presses).toBe(1);
      await device.turnOn();
      expect(power.presses).toBe(1);
      await device.turnOff();
      expect(await device.getState()).toBe("off");
      expect(power.presses).toBe(2);
      await device.toggle();
      expect(await device.getState()).toBe("on");
      await device.toggle();
      expect(await device.getState()).toBe("off");
      expect(power.presses).toBe(4);
    });

    test("with unknown state, any press flips remembered state from unknown", async () => {
      const power = new MemoryButton("power");
      const device = new OptimisticButtonSwitch("lamp", power, power, new MemoryOptimisticSwitchStateStore(), () => "unknown");
      await expect(device.getState()).rejects.toThrow(/unknown/u);
      await device.toggle();
      expect(await device.getState()).toBe("on");
    });
  });

  test("availability comes from its source without describing the buttons", async () => {
    const on = new MemoryButton("on");
    const off = new MemoryButton("off");
    const device = new OptimisticButtonSwitch("candles", on, off, new MemoryOptimisticSwitchStateStore(),
      () => combinedAvailability([on.targetAvailability, off.targetAvailability]));
    on.describe = off.describe = async () => { throw new Error("A derived availability read must not describe its buttons"); };

    on.targetAvailability = "online";
    off.targetAvailability = "online";
    expect((await device.describe()).state).toMatchObject({ availability: "online" });

    off.targetAvailability = "offline";
    expect((await device.describe()).state).toMatchObject({ availability: "degraded" });

    on.targetAvailability = "offline";
    expect((await device.describe()).state).toMatchObject({ availability: "offline" });
  });
});
