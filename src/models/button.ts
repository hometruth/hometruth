import type { Button as ButtonDocument } from "../schemas";
import { describeValidationErrors, validators } from "../validation";
import { Capability, CapabilityError, type Availability, type InvokeOptions } from "./capability";

export interface ButtonPressOptions {
  /** Hold the button for this long; absent or zero is one momentary press. */
  readonly durationMs?: number;
}

export type ButtonPressListener = (options: ButtonPressOptions) => void;

/**
 * A stateless action. A Button says only that it can be pressed; it never
 * claims the target appliance changed state. Optional duration is bounded by
 * the concrete button and is forwarded to actions such as Broadlink sends.
 */
export abstract class Button extends Capability<ButtonDocument> {
  readonly kind = "button" as const;
  readonly controlIds = ["press"] as const;
  readonly methods = ["press"] as const;
  private readonly listeners = new Set<ButtonPressListener>();

  /** Largest accepted hold, or undefined when this button is momentary only. */
  protected maximumDurationMs(): number | undefined {
    return undefined;
  }

  /** Health of whatever a press ultimately reaches, walked from this button's own dependencies. */
  protected async availability(): Promise<Availability> {
    return "unknown";
  }

  protected abstract performPress(options: ButtonPressOptions): Promise<void>;

  async press(options: ButtonPressOptions = {}): Promise<void> {
    const normalized = this.validateOptions(options);
    await this.performPress(normalized);
    for (const listener of this.listeners) {
      try { listener(normalized); } catch { /* Observers cannot turn a successful physical press into a failure. */ }
    }
  }

  /** Observe successful presses, including presses made outside a composed switch. */
  subscribe(listener: ButtonPressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  override async invoke(controlId: string, value?: unknown, _options?: InvokeOptions): Promise<unknown> {
    if (controlId !== "press") return this.unknownControl(controlId);
    if (value === undefined || value === null) return await this.press();
    if (typeof value === "number") return await this.press({ durationMs: value });
    if (typeof value === "object" && !Array.isArray(value)) {
      const { durationMs } = value as { durationMs?: unknown };
      if (Object.keys(value).some((key) => key !== "durationMs")) {
        throw new CapabilityError("press takes only an optional durationMs", "invalid_value");
      }
      return await this.press(durationMs === undefined ? {} : { durationMs: this.durationValue(durationMs) });
    }
    throw new CapabilityError("press takes an optional durationMs", "invalid_value");
  }

  override async describe(): Promise<ButtonDocument> {
    const maximumDurationMs = this.maximumDurationMs();
    const candidate: unknown = {
      id: this.id,
      state: { availability: await this.availability() },
      actions: { press: maximumDurationMs === undefined ? {} : { maximumDurationMs } },
    };
    if (!validators.button(candidate)) {
      throw new Error(`Invalid button document: ${describeValidationErrors(validators.button.errors)}`);
    }
    return candidate;
  }

  private validateOptions(options: ButtonPressOptions): ButtonPressOptions {
    if (options.durationMs === undefined) return {};
    return { durationMs: this.durationValue(options.durationMs) };
  }

  private durationValue(value: unknown): number {
    const maximum = this.maximumDurationMs();
    if (maximum === undefined) throw new CapabilityError("This button does not support a press duration", "not_supported");
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > maximum) {
      throw new CapabilityError(`durationMs must be a whole number from 0 to ${maximum}`, "invalid_value");
    }
    return value;
  }
}
