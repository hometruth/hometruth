import { describe, expect, test } from "bun:test";
import type { Availability } from "../../../models/capability";
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
    expect((await device.checkHealth()).status).toBe("healthy");
    await expect(device.switch.getState()).rejects.toThrow(/unknown/u);
    off.targetAvailability = "offline";
    expect((await device.checkHealth()).status).toBe("degraded");
    on.targetAvailability = "offline";
    expect((await device.checkHealth()).status).toBe("unhealthy");
    expect(on.presses + off.presses).toBe(0);
  } finally { await device.close(); }
});

describe("OptimisticButtonSwitch", () => {
  test("starts unknown unless configured, then remembers whichever button succeeded last", async () => {
    const on = new MemoryButton("on");
    const off = new MemoryButton("off");
    const states = new MemoryOptimisticSwitchStateStore();
    const device = new OptimisticButtonSwitch("candles", on, off, states);
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
    const device = new OptimisticButtonSwitch("candles", on, off, new MemoryOptimisticSwitchStateStore());
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
    const device = new OptimisticButtonSwitch("candles", on, off, new MemoryOptimisticSwitchStateStore(), "off");
    expect(await device.getState()).toBe("off");
    on.fail = true;
    await expect(device.turnOn()).rejects.toThrow("send failed");
    expect(await device.getState()).toBe("off");
  });

  describe("same Button for on and off (power-button toggle)", () => {
    test("turnOn/turnOff only press when a press is needed, toggle always presses", async () => {
      const power = new MemoryButton("power");
      const device = new OptimisticButtonSwitch("lamp", power, power, new MemoryOptimisticSwitchStateStore(), "off");
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
      const device = new OptimisticButtonSwitch("lamp", power, power, new MemoryOptimisticSwitchStateStore());
      await expect(device.getState()).rejects.toThrow(/unknown/u);
      await device.toggle();
      expect(await device.getState()).toBe("on");
    });
  });

  test("availability is walked from the buttons, not remembered separately from them", async () => {
    const on = new MemoryButton("on");
    const off = new MemoryButton("off");
    const device = new OptimisticButtonSwitch("candles", on, off, new MemoryOptimisticSwitchStateStore());

    on.targetAvailability = "online";
    off.targetAvailability = "online";
    expect((await device.describe()).state).toMatchObject({ availability: "online" });

    off.targetAvailability = "offline";
    expect((await device.describe()).state).toMatchObject({ availability: "degraded" });

    on.targetAvailability = "offline";
    expect((await device.describe()).state).toMatchObject({ availability: "offline" });
  });
});
