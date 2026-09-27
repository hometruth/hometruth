import type { BinarySwitch as BinarySwitchDocument } from "../schemas";
import { describeValidationErrors, validators } from "../validation";
import { Capability, type InvokeOptions } from "./capability";

/** The only two states a binary switch can be in. */
export type BinarySwitchState = "on" | "off";

export type BinarySwitchErrorCode = "invalid_host" | "unreachable" | "protocol" | "unknown_state";

export class BinarySwitchError extends Error {
  constructor(message: string, readonly code: BinarySwitchErrorCode) {
    super(message);
    this.name = "BinarySwitchError";
  }
}

/**
 * The binary-switch capability. Every switch, whatever hardware or protocol
 * sits behind it, exposes exactly these four operations.
 */
export abstract class BinarySwitch extends Capability<BinarySwitchDocument> {
  readonly kind = "binarySwitch" as const;
  readonly controlIds = ["turnOn", "turnOff", "toggle", "getState"] as const;
  readonly methods = ["turnOn", "turnOff", "toggle", "getState"] as const;

  /** Make the state `on`, regardless of the current state. */
  abstract turnOn(): Promise<void>;

  /** Make the state `off`, regardless of the current state. */
  abstract turnOff(): Promise<void>;

  /** Switch to the other state from whatever it is now. */
  abstract toggle(): Promise<void>;

  /** Return the current state. */
  abstract getState(): Promise<BinarySwitchState>;

  override async invoke(controlId: string, _value?: unknown, _options?: InvokeOptions): Promise<unknown> {
    switch (controlId) {
      case "turnOn": return await this.turnOn();
      case "turnOff": return await this.turnOff();
      case "toggle": return await this.toggle();
      case "getState": return await this.getState();
      default: return this.unknownControl(controlId);
    }
  }

  /**
   * Snapshot this switch as a validated BinarySwitch document. A switch that
   * cannot be read is reported as offline, unless its state is explicitly unknown.
   */
  override async describe(): Promise<BinarySwitchDocument> {
    const actions = { turnOn: {}, turnOff: {}, toggle: {}, getState: {} } as const;
    let candidate: unknown;
    try {
      const value = await this.getState();
      candidate = {
        id: this.id,
        state: { availability: "online", value, observedAt: new Date().toISOString() },
        actions,
      };
    } catch (error) {
      const availability = error instanceof BinarySwitchError && error.code === "unknown_state" ? "unknown" : "offline";
      candidate = { id: this.id, state: { availability }, actions };
    }
    if (!validators.binarySwitch(candidate)) {
      throw new Error(`Invalid binary switch document: ${describeValidationErrors(validators.binarySwitch.errors)}`);
    }
    return candidate;
  }
}
