/**
 * A device is an instance of a model: `model + config`. The model is the
 * enumerable "class" (which capabilities, which config schema, how to build
 * one); the instance is what `devices.yml` provisions from it.
 *
 * `describe()` composes the capabilities' documents into one validated
 * HomeTruth object document (`homeTruthObjectSchema`). Models that can be
 * probed, rebooted, or located get generic recovery for free (`recovery.ts`).
 */
import type { HomeTruthObject } from "../schemas";
import { HealthReporter, availabilityHealth, type HealthCheck } from "../health/model";
import type { DeviceConnectionType } from "./device-connection";
import type { Sensor, SensorDefinition, SensorDocument } from "./sensor";
import { describeValidationErrors, validators } from "../validation";
import { combinedAvailability, type Availability, type Capability, type CapabilityKind, type InvokeOptions } from "./capability";

/** What a device reports about itself when probed. */
export interface DeviceIdentity {
  readonly serialNumber?: string;
  readonly model?: string;
  readonly firmwareVersion?: string;
}

/** Where a device is on the network right now. */
export interface DeviceLocation {
  readonly host: string;
  readonly gateway?: string;
}

/** The instance-level identity every config entry carries. */
export interface DeviceInstance {
  readonly id: string;
  readonly name: string;
}

/**
 * Shared services a model may pull from when it creates an instance. This is
 * an open interface: a vendor module adds its service with declaration
 * merging (`declare module "../../models/device" { interface SiteServices … }`),
 * so the models stay vendor-free and there is no container to configure.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SiteServices {}

/**
 * What a reference between two devices means, declared by the composite making
 * it. Provisioning records these as it resolves them, which is how the system
 * graph learns that a switch is made of two buttons without anything having to
 * re-parse config by model id afterwards.
 */
export interface ReferenceIntent {
  /**
   * `uses` for something this device drives, `members` for a fan-out group.
   * Always stated from the referring device's point of view. Containment is
   * not expressible here: a device that is physically part of another declares
   * that through `parent`, which is a different mechanism and the only one that
   * reaches the object document.
   */
  readonly relation: "uses" | "members";
  /** The role this particular reference plays: "on", "off", "3". */
  readonly label?: string;
  /** The capability the reference narrows to, when it narrows to one. */
  readonly capability?: CapabilityKind;
}

/** Other configured devices available while a composed device is being built. */
export interface DeviceCreationContext {
  /**
   * Resolve a configured device by id, including one declared later in the
   * file. `intent` describes what the reference is for; passing it is how the
   * edge reaches the graph, and a composite that resolves a sibling without one
   * is invisible to it.
   */
  device(id: string, intent?: ReferenceIntent): Device;
}

/** A private LAN address or `.local` name, as every product's config names its device. */
export const lanHostSchema = { type: "string", pattern: "^[A-Za-z0-9.-]+$", minLength: 1, maxLength: 253 } as const;

/** A JSON Schema object; the model's config and secrets schemas are validated with Ajv at provisioning. */
export type ConfigSchema = { readonly $id: string; readonly type: "object"; readonly [key: string]: unknown };

/** An instance's secrets as provisioning hands them over: already validated against the model's `secretsSchema`. */
export type SecretsBag = Readonly<Record<string, unknown>>;

/** The enumerable class of a product: one record per product HomeTruth knows. */
export interface DeviceModel<Config = unknown> {
  /** Stable id used in devices.yml, e.g. "shelly-plus-1". */
  readonly id: string;
  /** Human name, e.g. "Shelly Plus 1". */
  readonly title: string;
  readonly manufacturer: string;
  /** Product name as the maker prints it. */
  readonly product: string;
  /** Controlled connection paths available for an instance of this model. */
  readonly connectionTypes: readonly DeviceConnectionType[];
  /** Which capabilities every instance has, in display order. */
  readonly capabilities: readonly CapabilityKind[];
  /** Sensors built into every instance, each with its own schema and device-local id. */
  readonly sensors?: readonly SensorDefinition[];
  /** Per-instance config, validated before `create`. */
  readonly configSchema: ConfigSchema;
  /** Per-instance secrets (from the secrets file, never the config), validated before `create`; absent when the product needs none. */
  readonly secretsSchema?: ConfigSchema;
  /** `$id` of the object schema an instance's `describe()` satisfies. */
  readonly objectSchemaId: string;
  /**
   * What every instance looks like, when the product deserves better than its
   * dominant capability's generic icon. An emoji, or `{ image }` naming a local
   * file. A device entry's own `icon` overrides it.
   */
  readonly icon?: string | { readonly image: string; readonly alt?: string };
  /**
   * Vendor hostnames an instance talks to that HomeTruth stands in for while
   * the device is isolated (`src/network/isolation.ts`): the DNS override
   * points each at this server, where a local emulator or interceptor
   * answers. Absent for a product that needs no cloud at all.
   */
  readonly cloudHostnames?: readonly string[];
  create(instance: DeviceInstance, config: Config, services: SiteServices, secrets: SecretsBag, context?: DeviceCreationContext): Device<Config>;
}

export type CapabilityMap = Readonly<Partial<Record<CapabilityKind, Capability<unknown>>>>;

type UnionToIntersection<U> = (U extends unknown ? (member: U) => void : never) extends (member: infer I) => void ? I : never;
/** The names a capability publishes in `methods`, narrowed to ones it really has. */
type PublishedMethods<C> = C extends { readonly methods: readonly (infer M)[] } ? Extract<M, keyof C> : never;
/** Methods of capability `K` that no sibling capability also publishes and that `Device` does not already define. */
type UniqueMethods<Caps, K extends keyof Caps> = Exclude<PublishedMethods<Caps[K]>, PublishedMethods<Caps[Exclude<keyof Caps, K>]> | keyof Device>;
/**
 * The device-level view of a capability map: every public method of every
 * capability, by its bare name, except names two capabilities share. Merge it
 * into a device class (`export interface ShellyPlus1 extends
 * CapabilityMethods<{ binarySwitch: ShellyGen2Switch }> {}`) and set
 * `capabilities` through `this.expose(…)`, and `gate.turnOn()` is
 * `gate.switch.turnOn()`.
 */
export type CapabilityMethods<Caps> = UnionToIntersection<{ [K in keyof Caps]: Pick<Caps[K], UniqueMethods<Caps, K> & keyof Caps[K]> }[keyof Caps]> extends infer Methods
  ? Methods extends object ? Methods : Record<never, never>
  : never;

export abstract class Device<Config = unknown> extends HealthReporter {
  /** Physical containment, with a zero-based position when the parent is ordered. */
  readonly parent?: { readonly id: string; readonly index: number };
  /** Check references after every configured device has been constructed. */
  validate?(): void;
  /** Site-owned room assignment, independent of the hardware configuration. */
  room?: string;
  /** Site-owned icon override from the device entry; falls back to the model's. */
  icon?: string | { readonly image: string; readonly alt?: string };
  /**
   * Site-owned kill switch: stays provisioned (still listed, still viewable,
   * still re-enableable) but refuses controls, and anything that maintains an
   * ongoing connection or background poll must skip it while this is false.
   */
  enabled = true;
  abstract readonly model: DeviceModel<Config>;
  abstract readonly capabilities: CapabilityMap;
  readonly sensors: readonly Sensor[] = [];

  constructor(readonly id: string, readonly name: string, readonly config: Config) { super(); }

  /** Every model must answer. Probe the actual protocol, then check all capability/sensor states. */
  async checkHealth(): Promise<HealthCheck> {
    if (!this.enabled) return this.reportHealth({ status: "disabled", detail: "Disabled in HomeTruth" });
    try {
      await this.probe();
      const object = await this.describe();
      return this.reportHealth(availabilityHealth(object.status ?? "unknown"));
    } catch (error) {
      const unsupported = (error as { code?: unknown })?.code === "not_supported";
      return this.reportHealth({ status: unsupported ? "unknown" : "unhealthy", detail: unsupported ? "This device cannot confirm its physical state" : "Device health check failed" });
    }
  }

  /** Is the device there, and is it the device we think it is. Rejects when unreachable. */
  abstract probe(): Promise<DeviceIdentity>;

  /**
   * A live push: call `onChange` whenever this device learns its own state
   * changed, instead of waiting to be polled. Returns the detach.
   *
   * Present only on a product with a real push path — a Matter subscription, a
   * retained MQTT topic. Without one the state hub polls at the model's floor,
   * which for a contact sensor is fifteen seconds; with one a door reports as
   * it opens. Anything that `uses` this device is refreshed too, so a hub that
   * pushes also refreshes the sensors bridged through it.
   */
  watch?(onChange: () => void): () => void;

  /** Restart the device; absent when the product has no way to. */
  reboot?(): Promise<void>;

  /** Ask wherever the product can be asked where the device is now; absent when it cannot. */
  locate?(): Promise<DeviceLocation | undefined>;

  close?(): Promise<void>;

  /** Individual sensor documents; repeat types are allowed, repeat ids are not. */
  async getSensors(): Promise<SensorDocument[]> {
    if (new Set(this.sensors.map(sensor => sensor.id)).size !== this.sensors.length) {
      throw new Error(`Duplicate sensor id on ${this.id}`);
    }
    return Promise.all(this.sensors.map(sensor => sensor.describe()));
  }

  /** What is already known about the device without asking it; folded into `describe()`. */
  protected identity(): DeviceIdentity | undefined {
    return undefined;
  }

  /**
   * The address shown for this device on the home page and its own page,
   * when it is not simply `config.host` — e.g. a device that talks through a
   * shared hub (a Hue light streamed to via its bridge) rather than having
   * its own LAN address. Absent means "use `config.host`".
   */
  displayHost?(): string;

  capability(kind: CapabilityKind): Capability<unknown> | undefined {
    return this.capabilities[kind];
  }

  /**
   * Wire the capabilities in and forward each one's public methods onto the
   * device under their bare names, so `device.turnOn()` calls
   * `device.capabilities.binarySwitch.turnOn()`. A name two capabilities both
   * publish is not forwarded (call it on the capability), nor is one the
   * device already has. Returns the map so it can be assigned in one line:
   * `this.capabilities = this.expose({ binarySwitch: this.switch })`.
   */
  protected expose<Caps extends CapabilityMap>(capabilities: Caps): Caps {
    const owners = new Map<string, Capability<unknown>[]>();
    for (const capability of Object.values(capabilities)) {
      if (!capability) continue;
      for (const name of capability.methods) {
        if (typeof (capability as unknown as Record<string, unknown>)[name] !== "function") continue;
        owners.set(name, [...(owners.get(name) ?? []), capability]);
      }
    }
    for (const [name, list] of owners) {
      if (list.length !== 1 || name in this) continue;
      const [capability] = list as [Capability<unknown>];
      const target = capability as unknown as Record<string, (...args: unknown[]) => unknown>;
      Object.defineProperty(this, name, {
        value: (...args: unknown[]) => {
          try {
            const result = target[name]!.apply(capability, args);
            return result instanceof Promise ? result.catch(error => { this.operationFailed(error); throw error; }) : result;
          } catch (error) { this.operationFailed(error); throw error; }
        },
        enumerable: false,
        configurable: true,
        writable: false,
      });
    }
    return capabilities;
  }

  /** The device's availability, from a fresh `describe()`. */
  async availability(): Promise<Availability> {
    return (await this.describe()).status ?? "unknown";
  }

  /** Route one control to a named capability. */
  async invoke(kind: CapabilityKind, controlId: string, value?: unknown, options: InvokeOptions = {}): Promise<unknown> {
    if (!this.enabled) throw new DeviceError(`${this.name} is disabled`, "device_disabled");
    const capability = this.capability(kind);
    if (!capability) throw new DeviceError(`${this.name} has no ${kind} capability`, "no_such_capability");
    try { return await capability.invoke(controlId, value, options); }
    catch (error) {
      this.operationFailed(error);
      throw error;
    }
  }

  private operationFailed(error: unknown): void {
    // Invalid user input is not a device outage.
    if (!["invalid_value", "confirmation_required", "unknown_control", "not_supported"].includes(String((error as { code?: unknown })?.code))) {
      this.reportHealth({ status: "degraded", detail: "A device operation failed" });
    }
  }

  /**
   * The device's own control namespace: every control of every capability,
   * by its bare name when only one capability offers it (`getState`,
   * `pan.left`) and qualified by the capability when several do
   * (`infraredBlaster.send`, `radioFrequencyBlaster.send`). These are the names
   * `invokeControl()` accepts; the qualified form always works.
   */
  controls(): readonly string[] {
    const owners = this.controlOwners();
    const names: string[] = [];
    for (const kind of this.model.capabilities) {
      for (const controlId of this.capabilities[kind]?.controlIds ?? []) {
        names.push((owners.get(controlId)?.length ?? 0) > 1 ? `${kind}.${controlId}` : controlId);
      }
    }
    return names;
  }

  /**
   * Invoke a control by a name from `controls()`: bare when unambiguous, or
   * `<capability>.<control>` to say which capability explicitly.
   */
  async invokeControl(reference: string, value?: unknown, options: InvokeOptions = {}): Promise<unknown> {
    const { kind, controlId } = this.resolveControl(reference);
    return await this.invoke(kind, controlId, value, options);
  }

  /** Which capability a control reference names; throws when none or several do. */
  resolveControl(reference: string): { kind: CapabilityKind; controlId: string } {
    const separator = reference.indexOf(".");
    const prefix = separator > 0 ? reference.slice(0, separator) : undefined;
    if (prefix && this.model.capabilities.includes(prefix as CapabilityKind)) {
      const kind = prefix as CapabilityKind;
      const controlId = reference.slice(separator + 1);
      if (!this.capabilities[kind]?.controlIds.includes(controlId)) {
        throw new DeviceError(`${this.name} has no control ${reference}; its controls are ${this.controls().join(", ")}`, "unknown_control");
      }
      return { kind, controlId };
    }
    const owners = this.controlOwners().get(reference) ?? [];
    if (owners.length === 1) return { kind: owners[0]!, controlId: reference };
    if (owners.length === 0) {
      throw new DeviceError(`${this.name} has no control ${reference}; its controls are ${this.controls().join(", ")}`, "unknown_control");
    }
    throw new DeviceError(`${reference} is ambiguous on ${this.name}; say ${owners.map((kind) => `${kind}.${reference}`).join(" or ")}`, "ambiguous_control");
  }

  private controlOwners(): Map<string, CapabilityKind[]> {
    const owners = new Map<string, CapabilityKind[]>();
    for (const kind of this.model.capabilities) {
      for (const controlId of this.capabilities[kind]?.controlIds ?? []) {
        owners.set(controlId, [...(owners.get(controlId) ?? []), kind]);
      }
    }
    return owners;
  }

  /** One validated HomeTruth object document composed from every capability's document. Not overridable. */
  async describe(): Promise<HomeTruthObject> {
    try {
      const capabilities: Record<string, unknown> = {};
      const availabilities: Availability[] = [];
      for (const kind of this.model.capabilities) {
        const capability = this.capabilities[kind];
        if (!capability) continue;
        const document = await capability.describe();
        capabilities[kind] = document;
        availabilities.push(availabilityOf(document));
      }
      const sensors = await this.getSensors();
      availabilities.push(...sensors.map(sensor => sensor.state.availability));
      const identity = this.identity();
      const observed = combinedAvailability(availabilities);
      if (!this.enabled) this.reportHealth({ status: "disabled", detail: "Disabled in HomeTruth" });
      else if (observed === "offline" || observed === "degraded") this.reportHealth(availabilityHealth(observed));
      // A cached online document must not erase a failed active health check.
      // Recovery is confirmed by checkHealth(), or an explicit device self-report.
      const candidate: unknown = {
        schemaVersion: 1,
        id: this.id,
        name: this.name,
        health: this.health,
        ...(this.parent ? { parent: this.parent } : {}),
        status: combinedAvailability(availabilities),
        manufacturer: this.model.manufacturer,
        model: identity?.model ?? this.model.product,
        ...(identity?.serialNumber ? { serialNumber: identity.serialNumber } : {}),
        ...(identity?.firmwareVersion ? { firmwareVersion: identity.firmwareVersion } : {}),
        capabilities,
        ...(sensors.length ? { sensors } : {}),
      };
      if (!validators.homeTruthObject(candidate)) {
        throw new Error(`Invalid object document for ${this.id}: ${describeValidationErrors(validators.homeTruthObject.errors)}`);
      }
      return candidate;
    } catch (error) {
      this.reportHealth({ status: "unhealthy", detail: "Could not read device status" });
      throw error;
    }
  }
}

export class DeviceError extends Error {
  constructor(message: string, readonly code: "no_such_capability" | "unknown_control" | "ambiguous_control" | "not_supported" | "device_disabled") {
    super(message);
    this.name = "DeviceError";
  }
}

function availabilityOf(document: unknown): Availability {
  const state = (document as { state?: { availability?: unknown } } | undefined)?.state;
  const value = state?.availability;
  return value === "online" || value === "offline" || value === "degraded" ? value : "unknown";
}
