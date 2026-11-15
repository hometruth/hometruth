/**
 * Enphase IQ Gateway ("Envoy"), read-only. Solar production, home
 * consumption, net grid power, IQ Battery charge and power, and grid status
 * from the IQ System Controller, as one sensor collection read from the
 * gateway's local HTTPS API. Optional per-microinverter and per-battery
 * readings join the same collection.
 *
 * Firmware 7 and later wants an owner token on every call. The token comes
 * from the secrets file, either pasted in or fetched from Enlighten with the
 * account login and kept in memory.
 */
import type { FromSchema } from "json-schema-to-ts";
import { Device, lanHostSchema, type CapabilityMethods, type DeviceIdentity, type DeviceInstance, type DeviceModel, type SecretsBag, type SiteServices } from "../../../models/device";
import { SensorCollection, type SensorCollectionReading, type SensorCollectionState } from "../../../models/sensors";
import { sensorCollectionSchema } from "../../../models/sensor-schemas";
import { EnvoyClient, EnvoyError } from "../../../protocols/enphase/client";
import {
  ENVOY_SERIAL_PATTERN, parseBatteryPower, parseEnsembleInventory, parseInverters, parseProduction, parseSecctrl,
  type BatteryAggregate, type EnsembleInventory, type EnvoyInfo, type EnvoyProduction, type InverterReading,
} from "../../../protocols/enphase/local-api";
import { EnlightenOwnerToken, JWT_PATTERN, StaticOwnerToken, type EnphaseFetch, type OwnerTokenSource } from "../../../protocols/enphase/token";

export const ENPHASE_ENVOY_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/enphase-envoy/config",
  title: "Enphase IQ Gateway config", type: "object", additionalProperties: false,
  properties: {
    host: lanHostSchema,
    /** The gateway serial. When set, `/info` must report it before any token is sent; read from `/info` when not. */
    serialNumber: { type: "string", pattern: ENVOY_SERIAL_PATTERN },
    /** Add one reading per microinverter and per IQ Battery to the collection. */
    unitReadings: { type: "boolean" },
    /** Per-request timeout. */
    timeoutMs: { type: "integer", minimum: 500, maximum: 60000 },
  }, required: ["host"],
} as const;
export type EnphaseEnvoyConfig = FromSchema<typeof ENPHASE_ENVOY_CONFIG_SCHEMA>;

const tokenSchema = { type: "string", pattern: JWT_PATTERN, minLength: 20, maxLength: 8192 } as const;
const usernameSchema = { type: "string", minLength: 3, maxLength: 254 } as const;
const passwordSchema = { type: "string", minLength: 1, maxLength: 256 } as const;

/** Exactly one of: an owner `token`, or the Enlighten `username` and `password` to fetch one. */
export const ENPHASE_ENVOY_SECRETS_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/enphase-envoy/secrets",
  title: "Enphase IQ Gateway secrets", type: "object", additionalProperties: false,
  properties: { token: tokenSchema, username: usernameSchema, password: passwordSchema },
  oneOf: [
    {
      type: "object", properties: { token: tokenSchema }, required: ["token"],
      not: { anyOf: [{ type: "object", properties: { username: usernameSchema }, required: ["username"] }, { type: "object", properties: { password: passwordSchema }, required: ["password"] }] },
    },
    {
      type: "object", properties: { username: usernameSchema, password: passwordSchema }, required: ["username", "password"],
      not: { type: "object", properties: { token: tokenSchema }, required: ["token"] },
    },
  ],
} as const;
export type EnphaseEnvoySecrets = { readonly token: string } | { readonly username: string; readonly password: string };

export interface EnphaseEnvoyDependencies {
  /** Fetch for the gateway; a fake in tests. Defaults to one that accepts the gateway's self-signed certificate. */
  readonly fetch?: EnphaseFetch;
  /** Fetch for Enlighten and Entrez; a fake in tests. Verifies TLS. */
  readonly cloudFetch?: EnphaseFetch;
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// Readings

interface ReadingDefinition {
  readonly id: string;
  readonly name: string;
  readonly quantity: string;
  readonly unit: string;
  /** Display order; per-unit readings follow the aggregates. */
  readonly order: number;
}

const define = (order: number, id: string, name: string, quantity: string, unit: string): ReadingDefinition => ({ id, name, quantity, unit, order });

/**
 * Sign conventions: `grid-power` is positive while importing from the grid
 * and negative while exporting; `battery-power` is positive while the
 * batteries discharge and negative while they charge. `grid-status` is 1 on
 * grid and 0 off grid (islanded), with the word in `detail`.
 */
export const READINGS = {
  solarPower: define(0, "solar-power", "Solar production", "power", "W"),
  homePower: define(1, "home-power", "Home consumption", "power", "W"),
  gridPower: define(2, "grid-power", "Net grid power", "power", "W"),
  batteryCharge: define(3, "battery-charge", "Battery charge", "stateOfCharge", "%"),
  batteryPower: define(4, "battery-power", "Battery power", "power", "W"),
  gridStatus: define(5, "grid-status", "Grid", "gridConnection", ""),
  solarToday: define(6, "solar-energy-today", "Solar energy today", "energy", "kWh"),
  solarLifetime: define(7, "solar-energy-lifetime", "Solar energy lifetime", "energy", "kWh"),
  homeToday: define(8, "home-energy-today", "Home energy today", "energy", "kWh"),
  homeLifetime: define(9, "home-energy-lifetime", "Home energy lifetime", "energy", "kWh"),
  batteryEnergy: define(10, "battery-energy-available", "Battery energy available", "energy", "kWh"),
  invertersActive: define(11, "inverters-active", "Inverters reporting", "count", ""),
} as const;

const batteryUnit = (serial: string, index: number) => define(1000 + index, `battery-${serial}`, `Battery ${serial}`, "stateOfCharge", "%");
const inverterUnit = (serial: string, index: number) => define(2000 + index, `inverter-${serial}`, `Inverter ${serial}`, "power", "W");

/** What the collection may hold; the rest is dropped with a note. */
const MAX_READINGS = 100;

type Group = "production" | "ensemble" | "inverters";

/** One reading before it becomes a document entry. */
type Draft =
  | { readonly definition: ReadingDefinition; readonly value: number; readonly source: string; readonly observedAt?: string; readonly detail?: string }
  | { readonly definition: ReadingDefinition; readonly missing: "offline" | "unknown"; readonly detail?: string };

const kwh = (wh: number) => Math.round(wh) / 1000;

export interface EnvoySnapshot {
  readonly observedAt: string;
  readonly production: EnvoyProduction | Error;
  /** Undefined when the gateway has no Ensemble (no IQ Batteries or System Controller). */
  readonly ensemble: { readonly inventory: EnsembleInventory; readonly aggregate: BatteryAggregate | Error | undefined; readonly batteryWatts: number | Error | undefined } | Error | undefined;
  /** Present only when per-unit readings are configured. */
  readonly inverters?: readonly InverterReading[] | Error;
}

function productionDrafts(production: EnvoyProduction): Draft[] {
  const { production: solar, consumption, net, invertersActive } = production;
  const drafts: Draft[] = [{ definition: READINGS.solarPower, value: solar.watts, source: solar.source === "eim" ? "productionMeter" : "inverters" }];
  if (solar.whToday !== undefined) drafts.push({ definition: READINGS.solarToday, value: kwh(solar.whToday), source: "productionMeter" });
  else if (solar.source === "eim") drafts.push({ definition: READINGS.solarToday, missing: "unknown" });
  if (solar.whLifetime !== undefined) drafts.push({ definition: READINGS.solarLifetime, value: kwh(solar.whLifetime), source: solar.source === "eim" ? "productionMeter" : "inverters" });
  else drafts.push({ definition: READINGS.solarLifetime, missing: "unknown" });
  if (consumption) {
    drafts.push({ definition: READINGS.homePower, value: consumption.watts, source: "consumptionMeter" });
    drafts.push(consumption.whToday !== undefined ? { definition: READINGS.homeToday, value: kwh(consumption.whToday), source: "consumptionMeter" } : { definition: READINGS.homeToday, missing: "unknown" });
    drafts.push(consumption.whLifetime !== undefined ? { definition: READINGS.homeLifetime, value: kwh(consumption.whLifetime), source: "consumptionMeter" } : { definition: READINGS.homeLifetime, missing: "unknown" });
  }
  if (net) drafts.push({ definition: READINGS.gridPower, value: net.watts, source: "netConsumptionMeter" });
  if (invertersActive !== undefined) drafts.push({ definition: READINGS.invertersActive, value: invertersActive, source: "production" });
  return drafts;
}

function ensembleDrafts(ensemble: Exclude<EnvoySnapshot["ensemble"], Error | undefined>, unitReadings: boolean): Draft[] {
  const { inventory, aggregate, batteryWatts } = ensemble;
  const drafts: Draft[] = [];
  const failed = (value: unknown): value is Error => value instanceof Error;
  if (inventory.batteries.length) {
    const units = inventory.batteries;
    const aggregatePercent = !failed(aggregate) ? aggregate?.percent : undefined;
    // Without secctrl, the capacity-weighted mean of the units, but only when every unit reported.
    const weighted = units.every((unit) => unit.percent !== undefined && unit.capacityWh !== undefined)
      ? units.reduce((sum, unit) => sum + unit.percent! * unit.capacityWh!, 0) / units.reduce((sum, unit) => sum + unit.capacityWh!, 0)
      : undefined;
    drafts.push(aggregatePercent !== undefined
      ? { definition: READINGS.batteryCharge, value: aggregatePercent, source: "secctrl" }
      : weighted !== undefined
        ? { definition: READINGS.batteryCharge, value: Math.round(weighted * 10) / 10, source: "inventory" }
        : { definition: READINGS.batteryCharge, missing: failed(aggregate) ? "offline" : "unknown", ...(failed(aggregate) ? { detail: aggregate.message } : {}) });
    drafts.push(typeof batteryWatts === "number"
      ? { definition: READINGS.batteryPower, value: batteryWatts, source: "ensemblePower" }
      : { definition: READINGS.batteryPower, missing: failed(batteryWatts) ? "offline" : "unknown", ...(failed(batteryWatts) ? { detail: batteryWatts.message } : {}) });
    const available = !failed(aggregate) ? aggregate?.availableWh : undefined;
    drafts.push(available !== undefined
      ? { definition: READINGS.batteryEnergy, value: kwh(available), source: "secctrl" }
      : { definition: READINGS.batteryEnergy, missing: failed(aggregate) ? "offline" : "unknown", ...(failed(aggregate) ? { detail: aggregate.message } : {}) });
    if (unitReadings) {
      units.forEach((unit, index) => drafts.push(unit.percent !== undefined
        ? { definition: batteryUnit(unit.serialNumber, index), value: unit.percent, source: "inventory", ...(unit.reportedAt ? { observedAt: unit.reportedAt } : {}) }
        : { definition: batteryUnit(unit.serialNumber, index), missing: "unknown" }));
    }
  }
  const controller = inventory.controllers[0];
  if (controller) {
    drafts.push(controller.grid
      ? { definition: READINGS.gridStatus, value: controller.grid === "on-grid" ? 1 : 0, source: "systemController", detail: controller.grid === "on-grid" ? "On grid" : "Off grid" }
      : { definition: READINGS.gridStatus, missing: "unknown" });
  }
  return drafts;
}

function inverterDrafts(inverters: readonly InverterReading[]): Draft[] {
  return inverters.map((inverter, index) => ({
    definition: inverterUnit(inverter.serialNumber, index), value: inverter.watts, source: "lastReportWatts",
    ...(inverter.reportedAt ? { observedAt: inverter.reportedAt } : {}),
  }));
}

/**
 * The rows for a group nothing has been read from yet. A gateway without
 * batteries answers the ensemble endpoints 404, so a failing ensemble read
 * means there is something there to report as offline.
 */
const FIRST_LAYOUT: Readonly<Record<Group, readonly ReadingDefinition[]>> = {
  production: [READINGS.solarPower, READINGS.solarToday, READINGS.solarLifetime],
  ensemble: [READINGS.batteryCharge],
  inverters: [],
};

class EnvoySensors extends SensorCollection {
  override readonly inventory = Object.values(READINGS).map(({ id, name }) => ({ id, name }));
  /** Which rows each group last produced, so an outage shows the same rows as offline rather than an empty list. */
  private readonly layout = new Map<Group, readonly ReadingDefinition[]>();

  constructor(id: string, private readonly read: () => Promise<EnvoySnapshot>, private readonly unitReadings: boolean) { super(id); }

  private remember(group: Group, drafts: readonly Draft[]): Draft[] {
    this.layout.set(group, drafts.map((draft) => draft.definition));
    return [...drafts];
  }

  private down(group: Group, error: Error, guess = true): Draft[] {
    return (this.layout.get(group) ?? (guess || group === "production" ? FIRST_LAYOUT[group] : [])).map((definition) => ({ definition, missing: "offline" as const, detail: error.message }));
  }

  /** Readings from one snapshot, ordered aggregates first. */
  drafts(snapshot: EnvoySnapshot): Draft[] {
    const drafts: Draft[] = [];
    drafts.push(...(snapshot.production instanceof Error ? this.down("production", snapshot.production) : this.remember("production", productionDrafts(snapshot.production))));
    drafts.push(...(snapshot.ensemble instanceof Error ? this.down("ensemble", snapshot.ensemble)
      : this.remember("ensemble", snapshot.ensemble ? ensembleDrafts(snapshot.ensemble, this.unitReadings) : [])));
    if (snapshot.inverters !== undefined) {
      drafts.push(...(snapshot.inverters instanceof Error ? this.down("inverters", snapshot.inverters) : this.remember("inverters", inverterDrafts(snapshot.inverters))));
    }
    return drafts.sort((a, b) => a.definition.order - b.definition.order);
  }

  async getState(): Promise<SensorCollectionState> {
    let snapshot: EnvoySnapshot;
    try { snapshot = await this.read(); }
    catch (error) {
      const failure = error instanceof Error ? error : new Error("Enphase gateway is unreachable");
      const sensors = (["production", "ensemble", "inverters"] as const).flatMap((group) => this.down(group, failure, false)).sort((a, b) => a.definition.order - b.definition.order).map((draft) => entry(draft, ""));
      return { availability: "offline", detail: failure.message.slice(0, 500), sensors: sensors.slice(0, MAX_READINGS) };
    }
    const all = this.drafts(snapshot).map((draft) => entry(draft, snapshot.observedAt));
    const sensors = all.slice(0, MAX_READINGS);
    const online = sensors.filter((sensor) => sensor.availability === "online").length;
    const problem = [snapshot.production, snapshot.ensemble, snapshot.inverters].find((part): part is Error => part instanceof Error);
    const availability = online === sensors.length && !problem ? "online" : online === 0 && sensors.every((sensor) => sensor.availability === "offline") ? "offline" : "degraded";
    const detail = all.length > MAX_READINGS ? `Showing the first ${MAX_READINGS} of ${all.length} readings` : problem?.message;
    return { availability, observedAt: snapshot.observedAt, sensors, ...(detail ? { detail: detail.slice(0, 500) } : {}) };
  }
}

function entry(draft: Draft, observedAt: string): SensorCollectionReading {
  const { id, name, quantity, unit } = draft.definition;
  if ("missing" in draft) return { id, name, quantity, unit, availability: draft.missing, ...(draft.detail ? { detail: draft.detail.slice(0, 500) } : {}) };
  return { id, name, quantity, unit, availability: "online", value: draft.value, source: draft.source, observedAt: draft.observedAt ?? observedAt, ...(draft.detail ? { detail: draft.detail } : {}) };
}

// ---------------------------------------------------------------------------
// Device

export interface EnphaseEnvoy extends CapabilityMethods<{ sensor: EnvoySensors }> {}

export class EnphaseEnvoy extends Device<EnphaseEnvoyConfig> {
  readonly model = ENPHASE_ENVOY;
  readonly capabilities;
  readonly readings: EnvoySensors;
  readonly client: EnvoyClient;
  private info: EnvoyInfo | undefined;
  private pendingInfo: Promise<EnvoyInfo> | undefined;
  private pending: Promise<EnvoySnapshot> | undefined;
  private readonly now: () => number;

  constructor(instance: DeviceInstance, config: EnphaseEnvoyConfig, secrets: EnphaseEnvoySecrets, dependencies: EnphaseEnvoyDependencies = {}) {
    super(instance.id, instance.name, config);
    this.now = dependencies.now ?? Date.now;
    const tokens: OwnerTokenSource = "token" in secrets
      ? new StaticOwnerToken(secrets.token, this.now)
      : new EnlightenOwnerToken({
        username: secrets.username, password: secrets.password,
        serialNumber: () => this.serialNumber(), now: this.now,
        ...(dependencies.cloudFetch ? { fetch: dependencies.cloudFetch } : {}),
      });
    this.client = new EnvoyClient({
      host: config.host, tokens,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
    });
    this.readings = new EnvoySensors(instance.id, () => this.read(), config.unitReadings === true);
    this.capabilities = this.expose({ sensor: this.readings });
  }

  protected override identity(): DeviceIdentity | undefined {
    if (!this.info) return this.config.serialNumber ? { serialNumber: this.config.serialNumber } : undefined;
    return {
      serialNumber: this.info.serialNumber,
      ...(this.info.partNumber ? { model: `IQ Gateway ${this.info.partNumber}` } : {}),
      ...(this.info.firmwareVersion ? { firmwareVersion: this.info.firmwareVersion } : {}),
    };
  }

  /** `/info`, checked against the configured serial. Shared by concurrent callers. */
  private async loadInfo(): Promise<EnvoyInfo> {
    this.pendingInfo ??= this.client.info().then((info) => {
      if (this.config.serialNumber && info.serialNumber !== this.config.serialNumber) {
        throw new EnvoyError(`The gateway at ${this.client.host} reports serial ${info.serialNumber}, not the configured ${this.config.serialNumber}`, "protocol");
      }
      this.info = info;
      return info;
    }).finally(() => { this.pendingInfo = undefined; });
    return this.pendingInfo;
  }

  /** The serial an owner token is issued for. */
  private async serialNumber(): Promise<string> {
    return this.config.serialNumber ?? this.info?.serialNumber ?? (await this.loadInfo()).serialNumber;
  }

  async probe(): Promise<DeviceIdentity> {
    await this.loadInfo();
    return this.identity()!;
  }

  private read(): Promise<EnvoySnapshot> {
    // A page, the list summary and a health probe share one round of requests.
    this.pending ??= this.snapshot().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async part<T>(read: () => Promise<T>): Promise<T | Error> {
    try { return await read(); }
    catch (error) { return error instanceof Error ? error : new Error(String(error)); }
  }

  private async snapshot(): Promise<EnvoySnapshot> {
    // Identity first, once: it proves the host is the configured gateway before a token goes to it.
    if (!this.info) await this.loadInfo();
    const [production, ensemble, inverters] = await Promise.all([
      this.part(async () => {
        const body = await this.client.json("/production.json?details=1");
        if (body === undefined) throw new EnvoyError("Enphase gateway has no production.json", "protocol");
        return parseProduction(body);
      }),
      this.part(() => this.ensemble()),
      this.config.unitReadings ? this.part(async () => parseInverters(await this.client.json("/api/v1/production/inverters") ?? [])) : Promise.resolve(undefined),
    ]);
    // A refused token refuses every request: one outage, not a partial reading.
    if (production instanceof EnvoyError && production.code === "unauthorized") throw production;
    return { observedAt: new Date(this.now()).toISOString(), production, ensemble, ...(inverters !== undefined ? { inverters } : {}) };
  }

  private async ensemble(): Promise<EnvoySnapshot["ensemble"]> {
    const body = await this.client.json("/ivp/ensemble/inventory");
    if (body === undefined) return undefined;
    const inventory = parseEnsembleInventory(body);
    if (!inventory.batteries.length && !inventory.controllers.length) return undefined;
    if (!inventory.batteries.length) return { inventory, aggregate: undefined, batteryWatts: undefined };
    const [aggregate, batteryWatts] = await Promise.all([
      this.part(async () => { const secctrl = await this.client.json("/ivp/ensemble/secctrl"); return secctrl === undefined ? undefined : parseSecctrl(secctrl); }),
      this.part(async () => { const power = await this.client.json("/ivp/ensemble/power"); return power === undefined ? undefined : parseBatteryPower(power); }),
    ]);
    return { inventory, aggregate, batteryWatts };
  }
}

export const ENPHASE_ENVOY: DeviceModel<EnphaseEnvoyConfig> = {
  id: "enphase-envoy", title: "Enphase IQ Gateway", manufacturer: "Enphase", product: "IQ Gateway",
  capabilities: ["sensor"], connectionTypes: ["direct-local"],
  configSchema: ENPHASE_ENVOY_CONFIG_SCHEMA, secretsSchema: ENPHASE_ENVOY_SECRETS_SCHEMA, objectSchemaId: sensorCollectionSchema.$id,
  create: (instance: DeviceInstance, config: EnphaseEnvoyConfig, _services: SiteServices, secrets: SecretsBag) => new EnphaseEnvoy(instance, config, secrets as EnphaseEnvoySecrets),
};
