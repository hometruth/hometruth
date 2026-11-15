/**
 * Roborock robot vacuums on the local protocol "1.0" (TCP 58867), e.g. the
 * S7 MaxV (roborock.vacuum.a27). No cloud at run time: the device's
 * `localKey` is provisioned once into the secrets file.
 *
 * HomeTruth has no robot-vacuum capability yet, so the product is composed
 * from existing ones:
 *
 * - `roborock-vacuum`: the robot itself. A `sensor` collection (state, error,
 *   cleaning, area, time, fan power; codes in `value`, readable text in
 *   `detail`) and a typed battery sensor, all from one `get_status`.
 * - `roborock-vacuum-action`: one Button per action (start, pause, stop,
 *   return to dock, locate), contained in the robot through `parent`. Every
 *   action moves the robot or makes it sound, so each is a physical action.
 *
 * Supported behaviour and setup are documented in docs/ROBOROCK.md.
 */
import type { FromSchema } from "json-schema-to-ts";
import { isSafeCameraUri } from "../../../camera-media";
import { Button } from "../../../models/button";
import { CapabilityError, type Availability } from "../../../models/capability";
import {
  Device,
  lanHostSchema,
  type CapabilityMethods,
  type DeviceCreationContext,
  type DeviceIdentity,
  type DeviceInstance,
  type DeviceLocation,
  type DeviceModel,
  type SecretsBag,
  type SiteServices,
} from "../../../models/device";
import { BatterySensor, type BatterySensorDocument } from "../../../models/sensor";
import { batterySensorSchema } from "../../../models/sensor-schemas";
import { SensorCollection, type SensorCollectionReading, type SensorCollectionState } from "../../../models/sensors";
import { RoborockError, RoborockLocalClient, type RoborockConnect } from "../../../protocols/roborock/client";
import { ROBOROCK_LOCAL_PORT } from "../../../protocols/roborock/codec";
import { buttonSchema, sensorDeviceSchema } from "../../../schemas";
import { parseStatus, type RoborockStatus } from "./status";

export { ROBOROCK_STATES, ROBOROCK_ERRORS, ROBOROCK_FAN_POWERS, parseStatus, type RoborockStatus } from "./status";

export const ROBOROCK_VACUUM_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/roborock-vacuum/config",
  title: "Roborock vacuum config",
  type: "object",
  additionalProperties: false,
  properties: {
    /** The robot's LAN address; give it a DHCP reservation. */
    host: lanHostSchema,
    /** Roborock's device id (`duid`) from the account's home data; names the robot, never sent locally. */
    duid: { type: "string", pattern: "^[A-Za-z0-9]{6,64}$" },
    port: { type: "integer", minimum: 1, maximum: 65535 },
    timeoutMs: { type: "integer", minimum: 500, maximum: 30000 },
  },
  required: ["host", "duid"],
} as const;
export type RoborockVacuumConfig = FromSchema<typeof ROBOROCK_VACUUM_CONFIG_SCHEMA>;

export const ROBOROCK_VACUUM_SECRETS_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/roborock-vacuum/secrets",
  title: "Roborock vacuum secrets",
  type: "object",
  additionalProperties: false,
  properties: {
    /** The device's local key (`localKey` in the account's home data); keys every local frame. */
    localKey: { type: "string", pattern: "^[A-Za-z0-9]{8,64}$" },
  },
  required: ["localKey"],
} as const;
export type RoborockVacuumSecrets = FromSchema<typeof ROBOROCK_VACUUM_SECRETS_SCHEMA>;

export type RoborockVacuumActionId = "start" | "pause" | "stop" | "dock" | "locate";

export interface RoborockVacuumAction {
  readonly id: RoborockVacuumActionId;
  /** The local RPC method. */
  readonly method: string;
  readonly name: string;
  readonly description: string;
  /** The robot moves or sounds; nothing about it is a read. */
  readonly physical: true;
}

/** Every action the robot offers, in display order; `parent.index` of an action button is its position here. */
export const ROBOROCK_VACUUM_ACTIONS: readonly RoborockVacuumAction[] = [
  { id: "start", method: "app_start", name: "Start cleaning", description: "Start a full clean, or resume a paused one.", physical: true },
  { id: "pause", method: "app_pause", name: "Pause", description: "Stop moving and hold the current run.", physical: true },
  { id: "stop", method: "app_stop", name: "Stop", description: "End the current run where the robot is.", physical: true },
  { id: "dock", method: "app_charge", name: "Return to dock", description: "Drive back to the dock and charge.", physical: true },
  { id: "locate", method: "find_me", name: "Locate", description: "Play the robot's locator sound.", physical: true },
];
const ACTION_IDS = ROBOROCK_VACUUM_ACTIONS.map((action) => action.id);

const READINGS = [
  { id: "state", name: "State", quantity: "vacuumState", unit: "" },
  { id: "error", name: "Error", quantity: "vacuumError", unit: "" },
  { id: "cleaning", name: "Cleaning", quantity: "active", unit: "" },
  { id: "cleanArea", name: "Cleaned area", quantity: "area", unit: "m²" },
  { id: "cleanTime", name: "Cleaning time", quantity: "duration", unit: "s" },
  { id: "fanPower", name: "Fan power", quantity: "fanPower", unit: "" },
] as const;

const SENSORS = [{ id: "battery", name: "Battery", schemaId: batterySensorSchema.$id }] as const;

const DEFAULT_TIMEOUT_MS = 4_000;
/** Concurrent sensor reads within this window share one `get_status`; failures are never reused. */
const STATUS_REUSE_MS = 1_000;

export interface RoborockVacuumDependencies {
  /** The TCP connector; a fake in tests. */
  readonly connect?: RoborockConnect;
  readonly now?: () => number;
  readonly randomInt?: (min: number, max: number) => number;
}

function readings(status: RoborockStatus | undefined, observedAt: string | undefined, availability: "offline" | "unknown"): SensorCollectionReading[] {
  const values: Record<(typeof READINGS)[number]["id"], { value: number; detail?: string } | undefined> = {
    state: status && { value: status.state, detail: status.stateText },
    error: status && { value: status.errorCode, detail: status.errorText },
    cleaning: status && { value: status.cleaning ? 1 : 0 },
    cleanArea: status?.cleanAreaSquareMetres === undefined ? undefined : { value: status.cleanAreaSquareMetres },
    cleanTime: status?.cleanTimeSeconds === undefined ? undefined : { value: status.cleanTimeSeconds },
    fanPower: status?.fanPower === undefined ? undefined : { value: status.fanPower, detail: status.fanPowerText! },
  };
  return READINGS.map(({ id, name, quantity, unit }) => {
    const reading = values[id];
    return reading && observedAt
      ? { id, name, quantity, unit, availability: "online" as const, value: reading.value, observedAt, ...(reading.detail ? { detail: reading.detail } : {}) }
      : { id, name, quantity, unit, availability: status ? "unknown" as const : availability };
  });
}

/** State, error, area, time, and fan power from one `get_status`. Reading never changes the robot. */
export class RoborockVacuumSensors extends SensorCollection {
  override readonly inventory = READINGS.map(({ id, name }) => ({ id, name }));

  constructor(id: string, private readonly vacuum: RoborockVacuum) {
    super(id);
  }

  async getState(): Promise<SensorCollectionState> {
    let status: RoborockStatus;
    try {
      status = await this.vacuum.status();
    } catch (error) {
      return { availability: "offline", detail: describeFailure(error), sensors: readings(undefined, undefined, "offline") };
    }
    const observedAt = new Date().toISOString();
    const sensors = readings(status, observedAt, "unknown");
    const complete = sensors.every((sensor) => sensor.availability === "online");
    return {
      availability: complete ? "online" : "degraded",
      observedAt,
      detail: status.errorCode ? `${status.stateText}: ${status.errorText}` : status.stateText,
      sensors,
    };
  }
}

export class RoborockVacuumBattery extends BatterySensor {
  constructor(private readonly vacuum: RoborockVacuum) {
    super(SENSORS[0].id, SENSORS[0].name);
  }

  async getState(): Promise<BatterySensorDocument["state"]> {
    try {
      const status = await this.vacuum.status();
      return { availability: "online", value: status.batteryPercent, observedAt: new Date().toISOString(), source: "get_status" };
    } catch (error) {
      return { availability: "offline", detail: describeFailure(error) };
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface RoborockVacuum extends CapabilityMethods<{ sensor: RoborockVacuumSensors }> {}

export class RoborockVacuum extends Device<RoborockVacuumConfig> {
  readonly model = ROBOROCK_VACUUM;
  readonly capabilities;
  override readonly sensors;
  readonly measurements: RoborockVacuumSensors;
  readonly battery: RoborockVacuumBattery;
  readonly client: RoborockLocalClient;
  private readonly now: () => number;
  private pending: Promise<RoborockStatus> | undefined;
  private last: { status: RoborockStatus; at: number } | undefined;

  constructor(instance: DeviceInstance, config: RoborockVacuumConfig, secrets: RoborockVacuumSecrets, dependencies: RoborockVacuumDependencies = {}) {
    super(instance.id, instance.name, config);
    const host = config.host.trim();
    if (!/^[A-Za-z0-9.-]+$/u.test(host) || !isSafeCameraUri(`http://${host}/`)) {
      throw new CapabilityError("Roborock vacuum host must be a private LAN address", "invalid_value");
    }
    if (typeof secrets?.localKey !== "string" || !/^[A-Za-z0-9]{8,64}$/u.test(secrets.localKey)) {
      throw new CapabilityError(`Roborock vacuum needs its local key (secrets: devices.${instance.id}.localKey)`, "invalid_value");
    }
    this.now = dependencies.now ?? Date.now;
    this.client = new RoborockLocalClient({
      host,
      port: config.port ?? ROBOROCK_LOCAL_PORT,
      localKey: secrets.localKey,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      now: this.now,
      ...(dependencies.connect ? { connect: dependencies.connect } : {}),
      ...(dependencies.randomInt ? { randomInt: dependencies.randomInt } : {}),
    });
    this.measurements = new RoborockVacuumSensors(instance.id, this);
    this.battery = new RoborockVacuumBattery(this);
    this.sensors = [this.battery] as const;
    this.capabilities = this.expose({ sensor: this.measurements });
  }

  /** One `get_status`, shared by reads that arrive together. Rejects when the robot does not answer. */
  async status(): Promise<RoborockStatus> {
    if (this.last && this.now() - this.last.at < STATUS_REUSE_MS) return this.last.status;
    this.pending ??= this.client.rpc("get_status")
      .then((result) => {
        const status = parseStatus(result);
        this.last = { status, at: this.now() };
        return status;
      })
      .catch((error: unknown) => {
        this.last = undefined;
        throw error;
      })
      .finally(() => { this.pending = undefined; });
    return await this.pending;
  }

  /** Run one physical action. Resolves when the robot acknowledges it. */
  async perform(actionId: RoborockVacuumActionId): Promise<void> {
    if (!this.enabled) throw new CapabilityError(`${this.name} is disabled`, "not_supported");
    const action = ROBOROCK_VACUUM_ACTIONS.find((candidate) => candidate.id === actionId);
    if (!action) throw new CapabilityError(`Roborock vacuum has no action "${actionId}"`, "invalid_value");
    this.last = undefined;
    const result = await this.client.rpc(action.method);
    this.last = undefined;
    const acknowledged = Array.isArray(result) ? result[0] === "ok" : result === "ok";
    if (!acknowledged) throw new RoborockError(`Vacuum did not acknowledge ${action.method}`, "protocol");
  }

  /** The robot answers `get_status` with a well-formed status. */
  override async probe(): Promise<DeviceIdentity> {
    await this.status();
    return { model: ROBOROCK_VACUUM.product };
  }

  override async locate(): Promise<DeviceLocation | undefined> {
    try {
      await this.status();
      return { host: this.config.host };
    } catch {
      return undefined;
    }
  }

  override async close(): Promise<void> {
    this.client.close();
  }
}

export const ROBOROCK_VACUUM: DeviceModel<RoborockVacuumConfig> = {
  id: "roborock-vacuum",
  title: "Roborock vacuum",
  manufacturer: "Roborock",
  product: "Robot vacuum",
  icon: "🧹",
  capabilities: ["sensor"],
  sensors: SENSORS,
  connectionTypes: ["direct-local"],
  configSchema: ROBOROCK_VACUUM_CONFIG_SCHEMA,
  secretsSchema: ROBOROCK_VACUUM_SECRETS_SCHEMA,
  objectSchemaId: sensorDeviceSchema.$id,
  create(instance: DeviceInstance, config: RoborockVacuumConfig, _services: SiteServices, secrets: SecretsBag): RoborockVacuum {
    return new RoborockVacuum(instance, config, secrets as RoborockVacuumSecrets);
  },
};

export const ROBOROCK_VACUUM_ACTION_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/roborock-vacuum-action/config",
  title: "Roborock vacuum action config",
  type: "object",
  additionalProperties: false,
  properties: {
    /** Id of the `roborock-vacuum` device this button drives. */
    vacuum: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 100 },
    action: { enum: ACTION_IDS },
  },
  required: ["vacuum", "action"],
} as const;
export type RoborockVacuumActionConfig = FromSchema<typeof ROBOROCK_VACUUM_ACTION_CONFIG_SCHEMA>;

/** A press runs the action once. Physical: the robot moves or sounds. */
export class RoborockVacuumActionButton extends Button {
  readonly action: RoborockVacuumAction;

  constructor(id: string, actionId: RoborockVacuumActionId, private readonly vacuum: RoborockVacuum) {
    super(id);
    this.action = ROBOROCK_VACUUM_ACTIONS.find((candidate) => candidate.id === actionId)!;
  }

  protected override async availability(): Promise<Availability> {
    return this.vacuum.availability();
  }

  protected override async performPress(): Promise<void> {
    await this.vacuum.perform(this.action.id);
  }
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface RoborockVacuumActionDevice extends CapabilityMethods<{ button: RoborockVacuumActionButton }> {}

export class RoborockVacuumActionDevice extends Device<RoborockVacuumActionConfig> {
  readonly model = ROBOROCK_VACUUM_ACTION;
  readonly capabilities;
  override readonly parent;
  override readonly availabilitySources: readonly Device[];
  readonly button: RoborockVacuumActionButton;
  private readonly vacuum: RoborockVacuum;

  constructor(instance: DeviceInstance, config: RoborockVacuumActionConfig, context: DeviceCreationContext) {
    super(instance.id, instance.name, config);
    // Containment through `parent` only, as for other built-in parts; no second, logical edge.
    const vacuum = context.device(config.vacuum);
    if (!(vacuum instanceof RoborockVacuum)) throw new CapabilityError("A Roborock vacuum action must reference a roborock-vacuum device", "invalid_value");
    const index = ACTION_IDS.indexOf(config.action);
    if (index < 0) throw new CapabilityError(`Roborock vacuum action must be one of ${ACTION_IDS.join(", ")}`, "invalid_value");
    this.vacuum = vacuum;
    this.parent = { id: config.vacuum, index };
    this.availabilitySources = [vacuum];
    this.button = new RoborockVacuumActionButton(instance.id, config.action, vacuum);
    this.capabilities = this.expose({ button: this.button });
  }

  /** Read-only: the robot answers `get_status`. Never presses. */
  override async probe(): Promise<DeviceIdentity> {
    await this.vacuum.status();
    return { model: `${ROBOROCK_VACUUM.product}: ${this.button.action.name}` };
  }

  override displayHost(): string {
    return `${this.button.action.name.toLowerCase()} on ${this.vacuum.name}`;
  }
}

export const ROBOROCK_VACUUM_ACTION: DeviceModel<RoborockVacuumActionConfig> = {
  id: "roborock-vacuum-action",
  title: "Roborock vacuum action",
  manufacturer: "Roborock",
  product: "Robot vacuum action",
  capabilities: ["button"],
  connectionTypes: ["composed"],
  configSchema: ROBOROCK_VACUUM_ACTION_CONFIG_SCHEMA,
  objectSchemaId: buttonSchema.$id,
  create(instance: DeviceInstance, config: RoborockVacuumActionConfig, _services: SiteServices, _secrets: SecretsBag, context?: DeviceCreationContext): RoborockVacuumActionDevice {
    if (!context) throw new CapabilityError("A Roborock vacuum action must be provisioned as part of a site", "not_supported");
    return new RoborockVacuumActionDevice(instance, config, context);
  },
};

function describeFailure(error: unknown): string {
  if (error instanceof RoborockError && error.code === "protocol" && /local key/u.test(error.message)) {
    return "The vacuum's replies do not decrypt; check its local key";
  }
  if (error instanceof RoborockError && error.code === "timeout") return "The vacuum did not answer in time";
  if (error instanceof RoborockError && error.code === "unreachable") return "The vacuum is unreachable on the LAN";
  return (error instanceof Error ? error.message : "The vacuum did not answer").slice(0, 500);
}
