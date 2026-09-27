import type { StringLightDocument } from "../schemas";
import { validators, describeValidationErrors } from "../validation";
import { Capability, CapabilityError, type InvokeOptions } from "./capability";
import { Device, type CapabilityMap } from "./device";
import { Light } from "./light";
import type { LightShows } from "./light-show";

/** A bulb is a device, with its own identity, controls, and observable state. */
export abstract class LightDevice<Config = unknown> extends Device<Config> {
  abstract readonly light: Light;
  abstract override readonly capabilities: CapabilityMap & { readonly light: Light };
  turnOn(): Promise<void> { return this.light.turnOn(); }
  turnOff(): Promise<void> { return this.light.turnOff(); }
  toggle(): Promise<void> { return this.light.toggle(); }
  setBrightness(percent: number): Promise<void> { return this.light.setBrightness(percent); }
  setColor(hex: string): Promise<void> { return this.light.setColor(hex); }
  setColorTemperature(kelvin: number): Promise<void> { return this.light.setColorTemperature(kelvin); }
  getState() { return this.light.getState(); }
}

/** Physical order starts at the controller. Array indexes are zero based. */
export abstract class StringLight<Config = unknown> extends Device<Config> {
  abstract readonly lights: readonly LightDevice[];

  at(index: number): LightDevice {
    if (!Number.isInteger(index) || index < 0 || index >= this.lights.length) {
      throw new CapabilityError(`Light index must be between 0 and ${this.lights.length - 1}`, "invalid_value");
    }
    return this.lights[index]!;
  }
}

/** Whole-string methods have their own capability namespace, separate from each bulb. */
export class StringLightControl extends Capability<StringLightDocument> {
  readonly kind = "stringLight" as const;
  get controlIds(): readonly string[] { return [...this.whole.controlIds, "getLights", ...(this.shows ? ["getScenes", "applyScene", "getShows", "playShow", "stopShow", "getPresets", "applyPreset"] : [])]; }
  readonly methods = ["turnOn", "turnOff", "toggle", "setBrightness", "setColor", "setColorTemperature", "getState", "getLights", "getScenes", "applyScene", "getShows", "playShow", "stopShow", "getPresets", "applyPreset"] as const;

  constructor(id: string, readonly whole: Light, private readonly orderedLights: () => readonly LightDevice[], readonly shows?: LightShows) { super(id); }

  turnOn(): Promise<void> { return this.whole.turnOn(); }
  turnOff(): Promise<void> { return this.whole.turnOff(); }
  toggle(): Promise<void> { return this.whole.toggle(); }
  setBrightness(percent: number): Promise<void> { return this.whole.setBrightness(percent); }
  setColor(hex: string): Promise<void> { return this.whole.setColor(hex); }
  setColorTemperature(kelvin: number): Promise<void> { return this.whole.setColorTemperature(kelvin); }
  getState() { return this.whole.getState(); }
  getLights() { return this.orderedLights().map((light, index) => ({ id: light.id, name: light.name, index })); }

  getScenes() { return [...(this.shows?.getScenes() ?? [])]; }
  async applyScene(value: unknown): Promise<void> { if (!this.shows) throw new CapabilityError("Light scenes are not supported", "not_supported"); await this.shows.applyScene(value); }
  getPresets() { return [...(this.shows?.getPresets() ?? [])]; }
  async applyPreset(value: unknown): Promise<void> { if (!this.shows) throw new CapabilityError("Light presets are not supported", "not_supported"); await this.shows.applyPreset(value); }
  getShows() { return [...(this.shows?.getShows() ?? [])]; }
  async playShow(value: unknown): Promise<void> { if (!this.shows) throw new CapabilityError("Light shows are not supported", "not_supported"); await this.shows.playShow(value); }
  async stopShow(): Promise<void> { if (!this.shows) throw new CapabilityError("Light shows are not supported", "not_supported"); await this.shows.stopShow(); }

  override async invoke(controlId: string, value?: unknown, options?: InvokeOptions): Promise<unknown> {
    if (controlId === "getScenes") return this.getScenes();
    if (controlId === "applyScene") return this.applyScene(value);
    if (controlId === "getPresets") return this.getPresets();
    if (controlId === "applyPreset") return this.applyPreset(value);
    if (controlId === "getShows") return this.getShows();
    if (controlId === "playShow") return this.playShow(value);
    if (controlId === "stopShow") return this.stopShow();
    if (controlId === "getLights") return this.getLights();
    return this.whole.invoke(controlId, value, options);
  }

  override async describe(): Promise<StringLightDocument> {
    const whole = await this.whole.describe();
    const lights = this.getLights();
    const candidate = { id: this.id, state: { ...whole.state, layout: "linear" as const, lightCount: lights.length, lights, ...(this.shows ? { scenes: this.getScenes(), scene: this.shows.getSceneState(), shows: this.getShows(), show: this.shows.getShowState(), presets: this.getPresets() } : {}) }, actions: { ...whole.actions, getLights: {}, ...(this.shows ? { getScenes: {}, applyScene: {}, getShows: {}, playShow: {}, stopShow: {}, getPresets: {}, applyPreset: {} } : {}) } };
    if (!validators.stringLight(candidate)) throw new Error(`Invalid string light: ${describeValidationErrors(validators.stringLight.errors)}`);
    return candidate;
  }
}
