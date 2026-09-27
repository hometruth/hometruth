import type { MotionSensor as MotionSensorDocument } from "../schemas";
import { describeValidationErrors, validators } from "../validation";
import { Capability, CapabilityError, type Availability, type InvokeOptions } from "./capability";

/** What a motion sensor reports right now. `motion` and `lastObservedAt` travel together, or not at all. */
export interface MotionSensorState {
  readonly availability: Availability;
  readonly motion?: boolean;
  /** When `motion` was last read or pushed; required whenever `motion` is present. */
  readonly observedAt?: string;
  readonly lastMotionAt?: string;
  readonly sensitivityPercent?: number;
  readonly clearAfterMs?: number;
  readonly illuminanceLux?: number;
  readonly batteryPercent?: number;
  readonly tampered?: boolean;
}

export interface PercentRange {
  readonly minimumPercent: number;
  readonly maximumPercent: number;
  readonly stepPercent?: number;
}

export interface MsRange {
  readonly minimumMs: number;
  readonly maximumMs: number;
  readonly stepMs?: number;
}

/** Which actions this sensor offers right now, exactly as the schema names them. */
export interface MotionSensorActions {
  readonly setSensitivity?: PercentRange;
  readonly setClearAfter?: MsRange;
}

function inRange(value: number, range: { readonly minimumPercent?: number; readonly maximumPercent?: number; readonly minimumMs?: number; readonly maximumMs?: number }, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

/**
 * The motion-sensor capability: a push or poll of whether something moved,
 * plus the bounded settings a product may offer. A push-only source (a
 * webhook, an MQTT message) calls `report()` and lets `state()` return the
 * last reported value; a poll-only source implements `state()` directly.
 */
/** The generic motion-sensor controls; a product with neither setting overrides this to `[]`. */
export const MOTION_SENSOR_CONTROL_IDS: readonly string[] = ["setSensitivity", "setClearAfter"];

export abstract class MotionSensor extends Capability<MotionSensorDocument> {
  readonly kind = "motionSensor" as const;
  readonly controlIds: readonly string[] = MOTION_SENSOR_CONTROL_IDS;
  readonly methods = ["state", "actions", "setSensitivity", "setClearAfter"] as const;

  abstract state(): Promise<MotionSensorState>;

  /** The actions this sensor offers right now; only declared actions are invokable. */
  abstract actions(): Promise<MotionSensorActions>;

  setSensitivity?(percent: number): Promise<void>;
  setClearAfter?(ms: number): Promise<void>;

  override async invoke(controlId: string, value?: unknown, _options: InvokeOptions = {}): Promise<unknown> {
    const actions = await this.actions();
    switch (controlId) {
      case "setSensitivity": {
        if (!actions.setSensitivity || !this.setSensitivity) return this.unsupported(controlId);
        const range = actions.setSensitivity;
        if (typeof value !== "number" || !inRange(value, range, range.minimumPercent, range.maximumPercent)) {
          throw new CapabilityError(`setSensitivity takes a number from ${range.minimumPercent} to ${range.maximumPercent}`, "invalid_value");
        }
        await this.setSensitivity(value);
        return undefined;
      }
      case "setClearAfter": {
        if (!actions.setClearAfter || !this.setClearAfter) return this.unsupported(controlId);
        const range = actions.setClearAfter;
        if (typeof value !== "number" || !Number.isInteger(value) || !inRange(value, range, range.minimumMs, range.maximumMs)) {
          throw new CapabilityError(`setClearAfter takes an integer of ${range.minimumMs}..${range.maximumMs} ms`, "invalid_value");
        }
        await this.setClearAfter(value);
        return undefined;
      }
      default:
        return this.unknownControl(controlId);
    }
  }

  protected unsupported(controlId: string): never {
    throw new CapabilityError(`This motion sensor does not offer ${controlId} right now`, "not_supported");
  }

  override async describe(): Promise<MotionSensorDocument> {
    const [state, actions] = await Promise.all([this.state(), this.actions()]);
    const candidate: unknown = {
      id: this.id,
      state,
      actions: {
        ...(actions.setSensitivity ? { setSensitivity: actions.setSensitivity } : {}),
        ...(actions.setClearAfter ? { setClearAfter: actions.setClearAfter } : {}),
      },
    };
    if (!validators.motionSensor(candidate)) {
      throw new Error(`Invalid motion sensor document: ${describeValidationErrors(validators.motionSensor.errors)}`);
    }
    return candidate;
  }
}

/**
 * The common shape of a push-driven motion sensor: hold the last observation
 * and go `offline` once it is older than `staleAfterMs`. A product feeds it
 * from whatever transport it has (MQTT, a webhook, ONVIF events) by calling
 * `report()`; nothing here knows about any of those.
 */
export class PushedMotionState {
  private observed: { readonly motion: boolean; readonly observedAt: string } | undefined;
  private lastMotionAt: string | undefined;

  constructor(private readonly staleAfterMs = 10 * 60 * 1000) {}

  /** Record a motion reading pushed in from outside; `at` defaults to now. */
  report(motion: boolean, at: Date = new Date()): void {
    const observedAt = at.toISOString();
    this.observed = { motion, observedAt };
    if (motion) this.lastMotionAt = observedAt;
  }

  /** `online` with the last reading while it is fresh; `unknown` once nothing has arrived or it has gone stale. */
  state(now: Date = new Date()): Pick<MotionSensorState, "availability" | "motion" | "observedAt" | "lastMotionAt"> {
    if (!this.observed || now.getTime() - Date.parse(this.observed.observedAt) > this.staleAfterMs) {
      return { availability: "unknown", ...(this.lastMotionAt ? { lastMotionAt: this.lastMotionAt } : {}) };
    }
    return {
      availability: "online",
      motion: this.observed.motion,
      observedAt: this.observed.observedAt,
      ...(this.lastMotionAt ? { lastMotionAt: this.lastMotionAt } : {}),
    };
  }
}
