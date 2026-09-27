import type { Light as LightDocument } from "../schemas";
import { describeValidationErrors, validators } from "../validation";
import { Capability, numberValue, type InvokeOptions } from "./capability";

export type LightErrorCode = "invalid_host" | "unreachable" | "protocol";

export class LightError extends Error {
  constructor(message: string, readonly code: LightErrorCode) {
    super(message);
    this.name = "LightError";
  }
}

/** The state a light reports back after being read or changed. */
export interface LightState {
  /** Some devices expose only the last command, without hardware readback. */
  stateSource?: "commanded";
  commandedAt?: string;
  on: boolean;
  brightnessPercent: number;
  colorTemperatureKelvin?: number;
  /** `#rrggbb`, present only for a light that reports `supportsColor()`. */
  color?: string;
}

function hexColorValue(controlId: string, value: unknown): string {
  if (typeof value !== "string" || !/^#[0-9A-Fa-f]{6}$/u.test(value)) {
    throw new Error(`${controlId} requires a "#rrggbb" hex color`);
  }
  return value;
}

/**
 * The light capability. Every light, whatever hardware or protocol sits
 * behind it, exposes power, brightness, and color temperature. Color is
 * optional: a light overrides `supportsColor()` and `setColor()`/`getColor()`
 * only when its hardware actually has one (e.g. Hue, not the Elgato panels).
 */
export abstract class Light extends Capability<LightDocument> {
  readonly kind = "light" as const;

  get controlIds(): readonly string[] {
    const base = ["turnOn", "turnOff", "toggle", "setBrightness", "getState", ...(this.supportsColorTemperature() ? ["setColorTemperature"] : [])];
    return this.supportsColor() ? [...base, "setColor"] : base;
  }

  get methods(): readonly string[] {
    return this.controlIds;
  }

  abstract turnOn(): Promise<void>;
  abstract turnOff(): Promise<void>;
  abstract toggle(): Promise<void>;
  abstract setBrightness(percent: number): Promise<void>;
  abstract setColorTemperature(kelvin: number): Promise<void>;

  /** Return the current state. */
  abstract getState(): Promise<LightState>;

  /** Whether this light instance has a color control. Defaults to no. */
  supportsColor(): boolean {
    return false;
  }

  supportsColorTemperature(): boolean { return true; }

  /** Set the light's color as `#rrggbb`. Only called when `supportsColor()` is true. */
  async setColor(_hex: string): Promise<void> {
    throw new LightError("This light has no color control", "protocol");
  }

  /** The bounds this light accepts; products narrow them. */
  protected bounds(): { minimumPercent: number; maximumPercent: number; minimumKelvin: number; maximumKelvin: number } {
    return { minimumPercent: 0, maximumPercent: 100, minimumKelvin: 2900, maximumKelvin: 7000 };
  }

  override async invoke(controlId: string, value?: unknown, _options?: InvokeOptions): Promise<unknown> {
    switch (controlId) {
      case "turnOn": return await this.turnOn();
      case "turnOff": return await this.turnOff();
      case "toggle": return await this.toggle();
      case "setBrightness": return await this.setBrightness(numberValue(controlId, value));
      case "setColorTemperature":
        if (!this.supportsColorTemperature()) return this.unknownControl(controlId);
        return await this.setColorTemperature(numberValue(controlId, value));
      case "setColor":
        if (!this.supportsColor()) return this.unknownControl(controlId);
        return await this.setColor(hexColorValue(controlId, value));
      case "getState": return await this.getState();
      default: return this.unknownControl(controlId);
    }
  }

  /**
   * Snapshot this light as a validated Light document. A light that cannot be
   * read is reported as offline rather than guessed at.
   */
  override async describe(): Promise<LightDocument> {
    const bounds = this.bounds();
    const actions = {
      turnOn: {},
      turnOff: {},
      toggle: {},
      setBrightness: { minimumPercent: bounds.minimumPercent, maximumPercent: bounds.maximumPercent },
      ...(this.supportsColorTemperature() ? { setColorTemperature: { minimumKelvin: bounds.minimumKelvin, maximumKelvin: bounds.maximumKelvin } } : {}),
      ...(this.supportsColor() ? { setColor: { formats: ["hex"] as const } } : {}),
    } as const;
    let candidate: unknown;
    try {
      const state = await this.getState();
      candidate = {
        id: this.id,
        state: {
          availability: "online",
          observedAt: new Date().toISOString(),
          on: state.on,
          brightnessPercent: state.brightnessPercent,
          ...(state.colorTemperatureKelvin !== undefined ? { colorTemperatureKelvin: state.colorTemperatureKelvin } : {}),
          ...(state.color ? { color: state.color } : {}),
        },
        actions,
      };
    } catch {
      candidate = { id: this.id, state: { availability: "offline" }, actions };
    }
    if (!validators.light(candidate)) {
      throw new Error(`Invalid light document: ${describeValidationErrors(validators.light.errors)}`);
    }
    return candidate;
  }
}
