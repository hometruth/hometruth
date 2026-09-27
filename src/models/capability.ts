/**
 * A capability is one thing a device can do, described the way the schemas in
 * `src/schemas.ts` describe it: a document with observable `state` and the
 * bounded `actions` the capability supports. A device is a named set of
 * capabilities (see `device.ts`); the capability kinds here are exactly the
 * property names `homeTruthObjectSchema` allows under `capabilities`.
 */

export type CapabilityKind =
  | "cooktop"
  | "camera"
  | "treatDispenser"
  | "light"
  | "stringLight"
  | "binarySwitch"
  | "infraredBlaster"
  | "radioFrequencyBlaster"
  | "radioFrequencyReceiver"
  | "occupancySensor"
  | "sensor"
  | "contactSensor"
  | "hub"
  | "motionSensor"
  | "speaker"
  | "television"
  | "button";

export const CAPABILITY_KINDS: readonly CapabilityKind[] = [
  "cooktop",
  "camera",
  "treatDispenser",
  "light",
  "stringLight",
  "binarySwitch",
  "infraredBlaster",
  "radioFrequencyBlaster",
  "radioFrequencyReceiver",
  "motionSensor",
  "occupancySensor",
  "sensor",
  "contactSensor",
  "hub",
  "speaker",
  "television",
  "button",
];

/** Availability as the schemas spell it, for a capability's state and for the device as a whole. */
export type Availability = "online" | "offline" | "degraded" | "unknown";

export interface InvokeOptions {
  /** The caller has confirmed a control that declares `confirmation`. */
  readonly confirmed?: boolean;
}

export type CapabilityErrorCode = "unknown_control" | "invalid_value" | "confirmation_required" | "not_supported";

export class CapabilityError extends Error {
  constructor(message: string, readonly code: CapabilityErrorCode) {
    super(message);
    this.name = "CapabilityError";
  }
}

/**
 * Base class for every capability. `Doc` is the schema document type the
 * capability describes itself as (`BinarySwitch`, `Light`, `Camera`, …).
 */
export abstract class Capability<Doc> {
  abstract readonly kind: CapabilityKind;

  /**
   * Every control id `invoke()` understands, whether or not the device offers
   * it right now. A device uses this to route a bare control name (`getState`)
   * to the one capability that owns it.
   */
  abstract readonly controlIds: readonly string[];

  /**
   * The capability's public TypeScript methods (`turnOn`, `pan`, `dispense`…),
   * the names a device forwards so `gate.turnOn()` works as well as
   * `gate.switch.turnOn()`. Optional methods are listed too; a device only
   * forwards the ones the product implements.
   */
  abstract readonly methods: readonly string[];

  constructor(readonly id: string) {}

  /** A validated snapshot: current state plus the actions this capability offers. */
  abstract describe(): Promise<Doc>;

  /**
   * The one write path. `controlId` names an action from the document
   * (`turnOn`, `setBrightness`, `dispense`, …); `value` is its argument when it
   * takes one. Resolves with the action's result when it has one.
   */
  abstract invoke(controlId: string, value?: unknown, options?: InvokeOptions): Promise<unknown>;

  protected unknownControl(controlId: string): never {
    throw new CapabilityError(`${this.kind} has no control "${controlId}"`, "unknown_control");
  }
}

/** Availability of a device from its capabilities' own availability. */
/**
 * A device's status from its capabilities'. A capability that does not know
 * (a push sensor nothing has reached yet) says nothing about the device, so
 * `unknown` only counts when no capability knows anything.
 */
export function combinedAvailability(values: readonly Availability[]): Availability {
  const known = values.filter((value) => value !== "unknown");
  if (known.length === 0) return "unknown";
  if (known.every((value) => value === "online")) return "online";
  if (known.every((value) => value === "offline")) return "offline";
  return "degraded";
}

export function numberValue(controlId: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CapabilityError(`${controlId} takes a number`, "invalid_value");
  }
  return value;
}
