/**
 * Whisker Litter-Robot 4, through Whisker's cloud (the robot has no LAN API).
 *
 * Three models share one robot:
 * - `litter-robot-4`: the robot itself, a sensor collection of what the
 *   account reports (status, waste drawer, litter level, cat weight, …);
 * - `litter-robot-4-switch`: the night light or the panel lockout, as a
 *   binary switch whose state is what Whisker last reported, not what was
 *   last asked for;
 * - `litter-robot-4-button`: start a clean cycle or press reset. Both move
 *   the globe.
 *
 * Every read goes through the site's one `WhiskerAccount`, which shares a
 * single snapshot of the whole account between all of them.
 */
import type { FromSchema } from "json-schema-to-ts";
import { BinarySwitch, BinarySwitchError, type BinarySwitchState } from "../../../models/binary-switch";
import { Button } from "../../../models/button";
import type { Availability } from "../../../models/capability";
import { Device, type CapabilityMethods, type DeviceCreationContext, type DeviceIdentity, type DeviceInstance, type DeviceModel, type SiteServices } from "../../../models/device";
import { sensorCollectionSchema } from "../../../models/sensor-schemas";
import { SensorCollection, type SensorCollectionReading, type SensorCollectionState } from "../../../models/sensors";
import { WhiskerError, type Lr4Robot } from "../../../protocols/whisker/client";
import { LR4_COMMANDS } from "../../../protocols/whisker/constants";
import { binarySwitchSchema, buttonSchema } from "../../../schemas";
import type { WhiskerRobotSource } from "../../../vendors/whisker/site-service";

const PRODUCT = "Litter-Robot 4";

/**
 * A site built without a Whisker account. Reads say `unknown` (nothing here
 * knows anything about the robot); writes say what is missing.
 */
export function dormantWhiskerSource(): WhiskerRobotSource {
  const missing = () => new WhiskerError("This site has no Whisker account configured; store one with `ht secrets set vendors.whisker.username` and `ht secrets set vendors.whisker.password`", "not_configured");
  return {
    robot: async () => { throw missing(); },
    command: async () => { throw missing(); },
    subscribe: () => () => {},
  };
}

const robotIdSchema = { type: "string", minLength: 1, maxLength: 100 } as const;

export const LITTER_ROBOT_4_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/litter-robot-4/config",
  title: "Litter-Robot 4 config",
  type: "object", additionalProperties: false,
  properties: {
    /** The robot's serial as the Whisker app shows it. */
    serial: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9-]+$" },
  },
  required: ["serial"],
} as const;
export type LitterRobot4Config = FromSchema<typeof LITTER_ROBOT_4_CONFIG_SCHEMA>;

interface Measurement {
  readonly id: string;
  readonly name: string;
  readonly quantity: string;
  readonly unit: string;
  /** A number, or a sentence for a reading that has no number. */
  readonly read: (robot: Lr4Robot) => { value?: number; detail?: string } | undefined;
}

const bit = (value: boolean | undefined) => value === undefined ? undefined : { value: value ? 1 : 0 };
const number = (value: number | undefined, detail?: string) => value === undefined ? undefined : { value, ...(detail ? { detail } : {}) };

const MEASUREMENTS: readonly Measurement[] = [
  { id: "status", name: "Status", quantity: "status", unit: "", read: robot => ({ detail: robot.status.text }) },
  { id: "waste-drawer", name: "Waste drawer", quantity: "wasteDrawerLevel", unit: "%", read: robot => number(robot.wasteDrawerPercent, robot.wasteDrawerFull ? "Full" : undefined) },
  { id: "litter-level", name: "Litter level", quantity: "litterLevel", unit: "%", read: robot => number(robot.litterLevelPercent, robot.litterLevelState) },
  { id: "cat-weight", name: "Cat weight", quantity: "mass", unit: "lb", read: robot => number(robot.catWeightPounds) },
  { id: "clean-cycle-wait", name: "Clean cycle wait", quantity: "duration", unit: "min", read: robot => number(robot.cleanCycleWaitMinutes) },
  { id: "sleeping", name: "Sleep mode", quantity: "sleeping", unit: "", read: robot => bit(robot.sleeping) },
  { id: "hopper-connected", name: "Hopper connected", quantity: "hopperConnected", unit: "", read: robot => bit(robot.hopperRemoved === undefined ? undefined : !robot.hopperRemoved) },
  { id: "night-light-lit", name: "Night light lit", quantity: "lightOn", unit: "", read: robot => bit(robot.nightLightLit) },
  { id: "power-source", name: "Power source", quantity: "powerSource", unit: "", read: robot => robot.powerType ? { detail: robot.powerType } : undefined },
];
/** Readings without which the robot is only partly reported. */
const CORE = new Set(["waste-drawer", "litter-level"]);
const ONLINE = { id: "online", name: "Online", quantity: "connectivity", unit: "" } as const;

function lastSeenDetail(robot: Lr4Robot): string | undefined {
  return robot.lastSeen ? `Last seen ${robot.lastSeen}` : undefined;
}

export class LitterRobot4Readings extends SensorCollection {
  override readonly inventory = [...MEASUREMENTS.map(({ id, name }) => ({ id, name })), { id: ONLINE.id, name: ONLINE.name }];

  constructor(id: string, private readonly source: WhiskerRobotSource, private readonly serial: string) { super(id); }

  async getState(): Promise<SensorCollectionState> {
    let robot: Lr4Robot;
    try { robot = await this.source.robot(this.serial); }
    catch (error) {
      const unconfigured = error instanceof WhiskerError && error.code === "not_configured";
      const availability = unconfigured ? "unknown" as const : "offline" as const;
      return {
        availability,
        ...(unconfigured ? {} : { detail: (error instanceof Error ? error.message : "Whisker is unreachable").slice(0, 500) }),
        sensors: [...MEASUREMENTS, ONLINE].map(({ id, name, quantity, unit }) => ({ id, name, quantity, unit, availability })),
      };
    }
    const observedAt = new Date().toISOString();
    const seen = lastSeenDetail(robot);
    const online: SensorCollectionReading = { ...ONLINE, availability: "online", value: robot.online ? 1 : 0, observedAt, ...(seen ? { detail: seen } : {}) };
    if (!robot.online) {
      // Whisker still returns the robot's last report; an offline robot's levels are not current.
      return {
        availability: "offline", observedAt, detail: `Whisker reports the robot offline${seen ? ` (${seen.toLowerCase()})` : ""}`,
        sensors: [...MEASUREMENTS.map(({ id, name, quantity, unit }) => ({ id, name, quantity, unit, availability: "offline" as const })), online],
      };
    }
    const sensors: SensorCollectionReading[] = MEASUREMENTS.map(({ id, name, quantity, unit, read }) => {
      const reading = read(robot);
      if (!reading) return { id, name, quantity, unit, availability: "unknown" };
      return {
        id, name, quantity, unit, availability: "online", observedAt,
        ...(reading.value !== undefined ? { value: reading.value } : {}),
        ...(reading.detail ? { detail: reading.detail.slice(0, 500) } : {}),
      };
    });
    sensors.push(online);
    const complete = sensors.every(sensor => !CORE.has(sensor.id) || sensor.availability === "online");
    return {
      availability: complete ? "online" : "degraded", observedAt, sensors,
      ...(complete ? {} : { detail: "Whisker did not report the waste drawer or litter level" }),
    };
  }
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface LitterRobot4 extends CapabilityMethods<{ sensor: LitterRobot4Readings }> {}

export class LitterRobot4 extends Device<LitterRobot4Config> {
  readonly model = LITTER_ROBOT_4;
  readonly capabilities;
  readonly readings: LitterRobot4Readings;
  private firmware: string | undefined;

  constructor(instance: DeviceInstance, config: LitterRobot4Config, readonly source: WhiskerRobotSource = dormantWhiskerSource()) {
    super(instance.id, instance.name, config);
    this.readings = new LitterRobot4Readings(instance.id, source, config.serial);
    this.capabilities = this.expose({ sensor: this.readings });
  }

  /** The account is polled while watched; a change in the robot's report arrives here. */
  override watch(onChange: () => void): () => void {
    return this.source.subscribe(onChange, () => this.enabled);
  }

  override displayHost(): string { return "Via Whisker's cloud"; }

  protected override identity(): DeviceIdentity {
    return { model: PRODUCT, serialNumber: this.config.serial, ...(this.firmware ? { firmwareVersion: this.firmware } : {}) };
  }

  /** The account must list this serial and say the robot is online. */
  override async probe(): Promise<DeviceIdentity> {
    const robot = await this.source.robot(this.config.serial);
    this.firmware = robot.firmware;
    if (!robot.online) throw new WhiskerError("Whisker reports the robot offline", "unreachable");
    return this.identity();
  }
}

export const LITTER_ROBOT_4: DeviceModel<LitterRobot4Config> = {
  id: "litter-robot-4", title: "Whisker Litter-Robot 4", manufacturer: "Whisker", product: PRODUCT,
  capabilities: ["sensor"], connectionTypes: ["cloud"], configSchema: LITTER_ROBOT_4_CONFIG_SCHEMA, objectSchemaId: sensorCollectionSchema.$id,
  create(instance: DeviceInstance, config: LitterRobot4Config, services: SiteServices): LitterRobot4 {
    return new LitterRobot4(instance, config, services.whisker ?? dormantWhiskerSource());
  },
};

function robotFrom(context: DeviceCreationContext | undefined, id: string, what: string): LitterRobot4 {
  if (!context) throw new Error(`A ${what} must be provisioned as part of a site`);
  // No reference intent: containment is declared through `parent`.
  const robot = context.device(id);
  if (!(robot instanceof LitterRobot4)) throw new Error(`A ${what} must reference a litter-robot-4 entry`);
  return robot;
}

/* ---------- switches: night light, panel lockout ---------- */

const SWITCHES = {
  nightLight: {
    index: 0, title: "night light",
    read: (robot: Lr4Robot): boolean | undefined =>
      robot.nightLightMode === "ON" || robot.nightLightMode === "AUTO" ? true : robot.nightLightMode === "OFF" ? false : undefined,
    on: LR4_COMMANDS.nightLightModeOn, off: LR4_COMMANDS.nightLightModeOff,
  },
  panelLockout: {
    index: 1, title: "panel lockout",
    read: (robot: Lr4Robot): boolean | undefined => robot.keypadLockout,
    on: LR4_COMMANDS.keyPadLockOutOn, off: LR4_COMMANDS.keyPadLockOutOff,
  },
} as const;
export type LitterRobot4SwitchControl = keyof typeof SWITCHES;

export const LITTER_ROBOT_4_SWITCH_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/litter-robot-4-switch/config",
  title: "Litter-Robot 4 switch config",
  type: "object", additionalProperties: false,
  properties: {
    /** The `litter-robot-4` entry this switch belongs to. */
    robot: robotIdSchema,
    /** `nightLight` (on covers Whisker's automatic mode) or `panelLockout`. */
    control: { enum: ["nightLight", "panelLockout"] },
  },
  required: ["robot", "control"],
} as const;
export type LitterRobot4SwitchConfig = FromSchema<typeof LITTER_ROBOT_4_SWITCH_CONFIG_SCHEMA>;

function switchError(error: unknown): never {
  if (error instanceof WhiskerError) {
    throw new BinarySwitchError(error.message, error.code === "not_configured" ? "unknown_state" : error.code === "unreachable" || error.code === "not_found" ? "unreachable" : "protocol");
  }
  throw error;
}

export class LitterRobot4Switch extends BinarySwitch {
  constructor(id: string, private readonly source: WhiskerRobotSource, private readonly serial: string, readonly control: LitterRobot4SwitchControl) { super(id); }

  /** What Whisker last reported; a write is confirmed only by a later read. */
  override async getState(): Promise<BinarySwitchState> {
    let robot: Lr4Robot;
    try { robot = await this.source.robot(this.serial); } catch (error) { return switchError(error); }
    if (!robot.online) throw new BinarySwitchError("Whisker reports the robot offline", "unreachable");
    const value = SWITCHES[this.control].read(robot);
    if (value === undefined) throw new BinarySwitchError(`Whisker did not report the ${SWITCHES[this.control].title}`, "protocol");
    return value ? "on" : "off";
  }

  override async turnOn(): Promise<void> { await this.set(true); }
  override async turnOff(): Promise<void> { await this.set(false); }
  override async toggle(): Promise<void> { await this.set(await this.getState() !== "on"); }

  private async set(on: boolean): Promise<void> {
    // Reading first refuses a write to an offline robot or a mistyped serial.
    await this.getState();
    const spec = SWITCHES[this.control];
    try { await this.source.command(this.serial, on ? spec.on : spec.off); } catch (error) { switchError(error); }
  }
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface LitterRobot4SwitchDevice extends CapabilityMethods<{ binarySwitch: LitterRobot4Switch }> {}

export class LitterRobot4SwitchDevice extends Device<LitterRobot4SwitchConfig> {
  readonly model = LITTER_ROBOT_4_SWITCH;
  readonly capabilities;
  override readonly parent;
  readonly switch: LitterRobot4Switch;
  private readonly source: WhiskerRobotSource;

  constructor(instance: DeviceInstance, config: LitterRobot4SwitchConfig, robot: LitterRobot4) {
    super(instance.id, instance.name, config);
    this.source = robot.source;
    this.parent = { id: robot.id, index: SWITCHES[config.control].index };
    this.switch = new LitterRobot4Switch(instance.id, robot.source, robot.config.serial, config.control);
    this.capabilities = this.expose({ binarySwitch: this.switch });
  }

  override watch(onChange: () => void): () => void {
    return this.source.subscribe(onChange, () => this.enabled);
  }

  override displayHost(): string { return "Via Whisker's cloud"; }

  override async probe(): Promise<DeviceIdentity> {
    await this.switch.getState();
    return { model: `${PRODUCT} ${SWITCHES[this.config.control].title}` };
  }
}

export const LITTER_ROBOT_4_SWITCH: DeviceModel<LitterRobot4SwitchConfig> = {
  id: "litter-robot-4-switch", title: "Litter-Robot 4 switch", manufacturer: "Whisker", product: `${PRODUCT} switch`,
  capabilities: ["binarySwitch"], connectionTypes: ["cloud"], configSchema: LITTER_ROBOT_4_SWITCH_CONFIG_SCHEMA, objectSchemaId: binarySwitchSchema.$id,
  create(instance, config, _services, _secrets, context) {
    return new LitterRobot4SwitchDevice(instance, config, robotFrom(context, config.robot, "Litter-Robot 4 switch"));
  },
};

/* ---------- buttons: clean cycle, reset ---------- */

const ACTIONS = {
  cleanCycle: { index: 2, title: "clean cycle", command: LR4_COMMANDS.cleanCycle },
  reset: { index: 3, title: "reset", command: LR4_COMMANDS.shortResetPress },
} as const;
export type LitterRobot4Action = keyof typeof ACTIONS;

export const LITTER_ROBOT_4_BUTTON_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/litter-robot-4-button/config",
  title: "Litter-Robot 4 button config",
  type: "object", additionalProperties: false,
  properties: {
    /** The `litter-robot-4` entry this button belongs to. */
    robot: robotIdSchema,
    /** `cleanCycle` starts a clean cycle; `reset` is a short press of the robot's reset button. */
    action: { enum: ["cleanCycle", "reset"] },
  },
  required: ["robot", "action"],
} as const;
export type LitterRobot4ButtonConfig = FromSchema<typeof LITTER_ROBOT_4_BUTTON_CONFIG_SCHEMA>;

/**
 * A momentary press that moves the robot's globe. The Button schema has no
 * field for "physical action", so it is declared here (`physical`) and in
 * the model title; callers should treat a press like dispensing a treat.
 */
export class LitterRobot4Press extends Button {
  /** This press moves hardware: the globe rotates. */
  readonly physical = true as const;

  constructor(id: string, private readonly source: WhiskerRobotSource, readonly serial: string, readonly action: LitterRobot4Action) { super(id); }

  protected override async availability(): Promise<Availability> {
    try { return (await this.source.robot(this.serial)).online ? "online" : "offline"; }
    catch (error) { return error instanceof WhiskerError && error.code === "not_configured" ? "unknown" : "offline"; }
  }

  protected override async performPress(): Promise<void> {
    // An offline robot would run a queued cycle whenever it reconnects; refuse instead.
    const robot = await this.source.robot(this.serial);
    if (!robot.online) throw new WhiskerError("Whisker reports the robot offline; nothing was sent", "unreachable");
    await this.source.command(this.serial, ACTIONS[this.action].command);
  }
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface LitterRobot4ButtonDevice extends CapabilityMethods<{ button: LitterRobot4Press }> {}

export class LitterRobot4ButtonDevice extends Device<LitterRobot4ButtonConfig> {
  readonly model = LITTER_ROBOT_4_BUTTON;
  readonly capabilities;
  override readonly parent;
  readonly button: LitterRobot4Press;
  private readonly source: WhiskerRobotSource;

  constructor(instance: DeviceInstance, config: LitterRobot4ButtonConfig, robot: LitterRobot4) {
    super(instance.id, instance.name, config);
    this.source = robot.source;
    this.parent = { id: robot.id, index: ACTIONS[config.action].index };
    this.button = new LitterRobot4Press(instance.id, robot.source, robot.config.serial, config.action);
    this.capabilities = this.expose({ button: this.button });
  }

  override watch(onChange: () => void): () => void {
    return this.source.subscribe(onChange, () => this.enabled);
  }

  override displayHost(): string { return "Via Whisker's cloud"; }

  /** Read-only: proves the robot is listed and online, never presses. */
  override async probe(): Promise<DeviceIdentity> {
    const robot = await this.source.robot(this.button.serial);
    if (!robot.online) throw new WhiskerError("Whisker reports the robot offline", "unreachable");
    return { model: `${PRODUCT} ${ACTIONS[this.config.action].title}` };
  }
}

export const LITTER_ROBOT_4_BUTTON: DeviceModel<LitterRobot4ButtonConfig> = {
  id: "litter-robot-4-button", title: "Litter-Robot 4 button (moves the globe)", manufacturer: "Whisker", product: `${PRODUCT} button`,
  capabilities: ["button"], connectionTypes: ["cloud"], configSchema: LITTER_ROBOT_4_BUTTON_CONFIG_SCHEMA, objectSchemaId: buttonSchema.$id,
  create(instance, config, _services, _secrets, context) {
    return new LitterRobot4ButtonDevice(instance, config, robotFrom(context, config.robot, "Litter-Robot 4 button"));
  },
};
