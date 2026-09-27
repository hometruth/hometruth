import { describe, expect, test } from "bun:test";
import { Light, type LightState } from "../../../models/light";
import { LightGroupCapability } from ".";

class MemoryLight extends Light {
  readonly calls: string[] = [];
  constructor(id: string, private state: LightState, private readonly color = true) { super(id); }
  override supportsColor(): boolean { return this.color; }
  async turnOn() { this.calls.push("turnOn"); this.state = { ...this.state, on: true }; }
  async turnOff() { this.calls.push("turnOff"); this.state = { ...this.state, on: false }; }
  async toggle() { this.state = { ...this.state, on: !this.state.on }; }
  async setBrightness(value: number) { this.calls.push(`setBrightness:${value}`); this.state = { ...this.state, brightnessPercent: value }; }
  async setColorTemperature(value: number) { this.state = { ...this.state, colorTemperatureKelvin: value }; }
  override async setColor(value: string) { this.calls.push(`setColor:${value}`); this.state = { ...this.state, color: value }; }
  async getState() { return this.state; }
}

const state = (on: boolean, brightnessPercent = 100, color = "#ffffff"): LightState =>
  ({ on, brightnessPercent, colorTemperatureKelvin: 4000, color });

describe("LightGroupCapability", () => {
  test("fans shared power, brightness, and color controls out to every light", async () => {
    const lights = [new MemoryLight("one", state(false)), new MemoryLight("two", state(false)), new MemoryLight("three", state(false))];
    const group = new LightGroupCapability("room", lights);
    expect(group.methods).toContain("setColor");

    await group.turnOn();
    await group.setBrightness(42);
    await group.setColor("#123456");

    for (const light of lights) expect(light.calls).toEqual(["turnOn", "setBrightness:42", "setColor:#123456"]);
    expect(await group.getState()).toEqual({ on: true, brightnessPercent: 42, colorTemperatureKelvin: 4000, color: "#123456" });
  });

  test("publishes color only when every member does and treats a mixed group as off", async () => {
    const one = new MemoryLight("one", state(true, 100));
    const two = new MemoryLight("two", state(false, 50), false);
    const group = new LightGroupCapability("room", [one, two]);
    expect(group.methods).not.toContain("setColor");
    expect(await group.getState()).toMatchObject({ on: false, brightnessPercent: 75 });
    await group.toggle();
    expect((await group.getState()).on).toBe(true);
  });
});
