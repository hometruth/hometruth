import { describe, expect, test } from "bun:test";
import { Light, LightError, type LightState } from "./light";
import { CapabilityError } from "./capability";

class PlainLight extends Light {
  private state: LightState = { on: false, brightnessPercent: 100, colorTemperatureKelvin: 4000 };
  async turnOn() { this.state = { ...this.state, on: true }; }
  async turnOff() { this.state = { ...this.state, on: false }; }
  async toggle() { this.state = { ...this.state, on: !this.state.on }; }
  async setBrightness(percent: number) { this.state = { ...this.state, brightnessPercent: percent }; }
  async setColorTemperature(kelvin: number) { this.state = { ...this.state, colorTemperatureKelvin: kelvin }; }
  async getState() { return this.state; }
}

class ColorLight extends Light {
  private state: LightState = { on: false, brightnessPercent: 100, colorTemperatureKelvin: 4000, color: "#ffffff" };
  async turnOn() { this.state = { ...this.state, on: true }; }
  async turnOff() { this.state = { ...this.state, on: false }; }
  async toggle() { this.state = { ...this.state, on: !this.state.on }; }
  async setBrightness(percent: number) { this.state = { ...this.state, brightnessPercent: percent }; }
  async setColorTemperature(kelvin: number) { this.state = { ...this.state, colorTemperatureKelvin: kelvin }; }
  async getState() { return this.state; }
  override supportsColor() { return true; }
  override async setColor(hex: string) { this.state = { ...this.state, color: hex }; }
}

describe("Light without color support", () => {
  test("controlIds and methods omit setColor", () => {
    const light = new PlainLight("plain");
    expect(light.controlIds).not.toContain("setColor");
    expect(light.methods).not.toContain("setColor");
  });

  test("describe()'s actions omit setColor", async () => {
    const light = new PlainLight("plain");
    const doc = await light.describe();
    expect(doc.actions).not.toHaveProperty("setColor");
  });

  test("describe()'s state omits color", async () => {
    const light = new PlainLight("plain");
    const doc = await light.describe();
    expect(doc.state).not.toHaveProperty("color");
  });

  test("invoking setColor is an unknown control", async () => {
    const light = new PlainLight("plain");
    await expect(light.invoke("setColor", "#ff0000")).rejects.toThrow(CapabilityError);
  });

  test("calling setColor directly throws", async () => {
    const light = new PlainLight("plain");
    await expect(light.setColor("#ff0000")).rejects.toThrow(LightError);
  });
});

describe("Light with color support", () => {
  test("controlIds and methods include setColor", () => {
    const light = new ColorLight("color");
    expect(light.controlIds).toContain("setColor");
    expect(light.methods).toContain("setColor");
  });

  test("describe()'s actions advertise setColor with hex format", async () => {
    const light = new ColorLight("color");
    const doc = await light.describe();
    expect(doc.actions).toHaveProperty("setColor");
    expect((doc.actions as { setColor?: { formats?: string[] } }).setColor?.formats).toEqual(["hex"]);
  });

  test("describe()'s state includes the current color", async () => {
    const light = new ColorLight("color");
    await light.setColor("#00ff00");
    const doc = await light.describe();
    expect(doc.state).toMatchObject({ color: "#00ff00" });
  });

  test("invoke('setColor', ...) sets the color", async () => {
    const light = new ColorLight("color");
    await light.invoke("setColor", "#123abc");
    expect((await light.getState()).color).toBe("#123abc");
  });

  test("invoke rejects a malformed hex value", async () => {
    const light = new ColorLight("color");
    await expect(light.invoke("setColor", "red")).rejects.toThrow();
    await expect(light.invoke("setColor", "#zzzzzz")).rejects.toThrow();
    await expect(light.invoke("setColor", 123)).rejects.toThrow();
  });

  test("an offline light's describe() still advertises setColor in actions", async () => {
    class OfflineColorLight extends ColorLight {
      override async getState(): Promise<LightState> { throw new Error("unreachable"); }
    }
    const light = new OfflineColorLight("offline");
    const doc = await light.describe();
    expect(doc.state.availability).toBe("offline");
    expect(doc.actions).toHaveProperty("setColor");
  });
});
