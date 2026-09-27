import type { TreatDispenser as TreatDispenserDocument } from "../schemas";
import { describeValidationErrors, validators } from "../validation";
import { Capability, CapabilityError, numberValue, type Availability, type InvokeOptions } from "./capability";

/** What a dispenser reports about itself; every field but availability is optional. */
export interface TreatDispenserState {
  readonly availability: Availability;
  readonly foodLevelPercent?: number;
  readonly lowFood?: boolean;
  readonly jammed?: boolean;
  readonly lastDispensedAt?: string;
  readonly lastPortions?: number;
}

/** How much one `dispense` may release, exactly as the TreatDispenser schema declares it. */
export interface DispenseBounds {
  readonly minimumPortions: number;
  readonly maximumPortions: number;
  readonly step: number;
  readonly portionSizeGrams?: number;
  /** "confirm" makes `invoke("dispense")` refuse unless the caller confirmed. */
  readonly confirmation?: "none" | "confirm";
}

/**
 * The treat-dispenser capability: portioned dispensing, optionally a call
 * sound to bring the pet over. A product implements `state()`, `bounds()`,
 * and `dispense()`; `describe()` and `invoke()` are generic and enforce the
 * declared bounds and confirmation.
 */
export abstract class TreatDispenser extends Capability<TreatDispenserDocument> {
  readonly kind = "treatDispenser" as const;
  readonly controlIds = ["dispense", "playCall"] as const;
  readonly methods = ["state", "bounds", "dispense", "playCall"] as const;

  abstract state(): Promise<TreatDispenserState>;

  abstract bounds(): Promise<DispenseBounds>;

  /** Release `portions` treats; `portions` is already within `bounds()`. */
  abstract dispense(portions: number): Promise<void>;

  /** Play the call sound; only when the product implements it. */
  playCall?(): Promise<void>;

  override async invoke(controlId: string, value?: unknown, options: InvokeOptions = {}): Promise<unknown> {
    switch (controlId) {
      case "dispense": {
        const bounds = await this.bounds();
        const portions = value === undefined ? bounds.minimumPortions : numberValue(controlId, value);
        if (!Number.isInteger(portions) || portions < bounds.minimumPortions || portions > bounds.maximumPortions || (portions - bounds.minimumPortions) % bounds.step !== 0) {
          throw new CapabilityError(`dispense takes ${bounds.minimumPortions}..${bounds.maximumPortions} portions in steps of ${bounds.step}`, "invalid_value");
        }
        if (bounds.confirmation === "confirm" && !options.confirmed) {
          throw new CapabilityError("dispense must be confirmed for this dispenser", "confirmation_required");
        }
        await this.dispense(portions);
        return undefined;
      }
      case "playCall":
        if (!this.playCall) throw new CapabilityError("This dispenser has no call sound", "not_supported");
        await this.playCall();
        return undefined;
      default:
        return this.unknownControl(controlId);
    }
  }

  override async describe(): Promise<TreatDispenserDocument> {
    const [state, bounds] = await Promise.all([this.state(), this.bounds()]);
    const candidate: unknown = {
      id: this.id,
      state,
      actions: {
        dispense: {
          minimumPortions: bounds.minimumPortions,
          maximumPortions: bounds.maximumPortions,
          step: bounds.step,
          ...(bounds.portionSizeGrams !== undefined ? { portionSizeGrams: bounds.portionSizeGrams } : {}),
          confirmation: bounds.confirmation ?? "none",
        },
        ...(this.playCall ? { playCall: {} } : {}),
      },
    };
    if (!validators.treatDispenser(candidate)) {
      throw new Error(`Invalid treat dispenser document: ${describeValidationErrors(validators.treatDispenser.errors)}`);
    }
    return candidate;
  }
}
