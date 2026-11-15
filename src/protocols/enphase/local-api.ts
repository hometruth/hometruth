/**
 * Response parsers for the Enphase IQ Gateway ("Envoy") local API.
 *
 * Shapes follow Enphase's "IQ Gateway local APIs" technical brief and the
 * open-source pyenphase library. Every parser takes the decoded body as
 * `unknown`, keeps only finite numbers, and throws `EnphaseProtocolError` when
 * the body is not the documented shape at all. A field the firmware leaves out
 * is simply absent from the result; nothing is guessed or zero-filled.
 */

export class EnphaseProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnphaseProtocolError";
  }
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown, max = 100): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

/** Epoch seconds as an ISO time; undefined for zero, negative or absurd values. */
export function epochSeconds(value: unknown): string | undefined {
  const seconds = finite(value);
  // 2001-09-09 … 2286: anything outside is an unset clock or a different unit.
  if (seconds === undefined || seconds < 1e9 || seconds >= 1e10) return undefined;
  return new Date(seconds * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// GET /info (XML, no authentication)

export interface EnvoyInfo {
  readonly serialNumber: string;
  readonly partNumber?: string;
  /** `software` without its leading build letter: `D8.2.4499` → `8.2.4499`. */
  readonly firmwareVersion?: string;
  /** `<web-tokens>true</web-tokens>`: the firmware wants a JWT on every authenticated call (7.x and later). */
  readonly webTokens?: boolean;
}

function xmlElement(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>\\s*([^<]{1,200}?)\\s*</${name}>`, "u").exec(xml);
  return match?.[1];
}

export const ENVOY_SERIAL_PATTERN = "^[A-Za-z0-9]{6,32}$";
const SERIAL = new RegExp(ENVOY_SERIAL_PATTERN, "u");

export function parseInfo(xml: string): EnvoyInfo {
  if (!/<envoy_info>/u.test(xml)) throw new EnphaseProtocolError("Response is not an Enphase /info document");
  const serialNumber = xmlElement(xml, "sn");
  if (!serialNumber || !SERIAL.test(serialNumber)) throw new EnphaseProtocolError("Enphase /info has no serial number");
  const partNumber = xmlElement(xml, "pn");
  const software = xmlElement(xml, "software");
  const tokens = xmlElement(xml, "web-tokens");
  return {
    serialNumber,
    ...(partNumber ? { partNumber } : {}),
    ...(software ? { firmwareVersion: software.replace(/^[A-Za-z](?=\d)/u, "") } : {}),
    ...(tokens === "true" || tokens === "false" ? { webTokens: tokens === "true" } : {}),
  };
}

// ---------------------------------------------------------------------------
// GET /production.json?details=1

export interface EnergyTotals {
  /** Instantaneous real power, watts. */
  readonly watts: number;
  readonly whToday?: number;
  readonly whLifetime?: number;
}

export interface EnvoyProduction {
  /** Solar production: the production CT when one is active, else the microinverters' sum. */
  readonly production: EnergyTotals & { readonly source: "eim" | "inverters" };
  /** Whole-home consumption; present only with an active consumption CT. */
  readonly consumption?: EnergyTotals;
  /**
   * Net consumption at the grid connection; present only with an active
   * consumption CT. Enphase's sign, kept as is: positive is power imported
   * from the grid, negative is power exported to it.
   */
  readonly net?: { readonly watts: number };
  /** Microinverters the gateway currently hears from. */
  readonly invertersActive?: number;
}

function totals(entry: UnknownRecord): EnergyTotals | undefined {
  const watts = finite(entry.wNow);
  if (watts === undefined) return undefined;
  const whToday = finite(entry.whToday);
  const whLifetime = finite(entry.whLifetime);
  return { watts, ...(whToday !== undefined ? { whToday } : {}), ...(whLifetime !== undefined ? { whLifetime } : {}) };
}

/** An `eim` (CT meter) entry that is actually installed: `activeCount` above zero. */
function activeMeter(entries: readonly UnknownRecord[], measurementType: string): UnknownRecord | undefined {
  return entries.find((entry) => entry.type === "eim" && entry.measurementType === measurementType && (finite(entry.activeCount) ?? 0) > 0);
}

export function parseProduction(body: unknown): EnvoyProduction {
  const root = record(body);
  if (!root || !Array.isArray(root.production)) throw new EnphaseProtocolError("Enphase production.json has no production list");
  const production = root.production.map(record).filter((entry): entry is UnknownRecord => Boolean(entry));
  const consumption = Array.isArray(root.consumption) ? root.consumption.map(record).filter((entry): entry is UnknownRecord => Boolean(entry)) : [];
  const inverters = production.find((entry) => entry.type === "inverters");
  const meter = activeMeter(production, "production");
  const solar = meter ? totals(meter) : undefined;
  const fromInverters = inverters ? totals(inverters) : undefined;
  const chosen = solar ? { ...solar, source: "eim" as const } : fromInverters ? { ...fromInverters, source: "inverters" as const } : undefined;
  if (!chosen) throw new EnphaseProtocolError("Enphase production.json has no production reading");
  const total = activeMeter(consumption, "total-consumption");
  const net = activeMeter(consumption, "net-consumption");
  const home = total ? totals(total) : undefined;
  const netWatts = net ? finite(net.wNow) : undefined;
  const active = inverters ? finite(inverters.activeCount) : undefined;
  return {
    production: chosen,
    ...(home ? { consumption: home } : {}),
    ...(netWatts !== undefined ? { net: { watts: netWatts } } : {}),
    ...(active !== undefined && active >= 0 ? { invertersActive: active } : {}),
  };
}

// ---------------------------------------------------------------------------
// GET /api/v1/production/inverters

export interface InverterReading {
  readonly serialNumber: string;
  readonly watts: number;
  readonly maxWatts?: number;
  /** When the microinverter last reported, from its own `lastReportDate`. */
  readonly reportedAt?: string;
}

export function parseInverters(body: unknown): InverterReading[] {
  if (!Array.isArray(body)) throw new EnphaseProtocolError("Enphase inverter list is not an array");
  const readings: InverterReading[] = [];
  for (const item of body) {
    const entry = record(item);
    const serialNumber = text(entry?.serialNumber, 32);
    const watts = finite(entry?.lastReportWatts);
    if (!entry || !serialNumber || !SERIAL.test(serialNumber) || watts === undefined) continue;
    const maxWatts = finite(entry.maxReportWatts);
    const reportedAt = epochSeconds(entry.lastReportDate);
    readings.push({ serialNumber, watts, ...(maxWatts !== undefined ? { maxWatts } : {}), ...(reportedAt ? { reportedAt } : {}) });
  }
  return readings;
}

// ---------------------------------------------------------------------------
// GET /ivp/ensemble/inventory

export interface BatteryUnit {
  readonly serialNumber: string;
  /** `percentFull`, 0–100. */
  readonly percent?: number;
  /** `encharge_capacity`, watt-hours. */
  readonly capacityWh?: number;
  readonly reportedAt?: string;
}

export interface SystemController {
  readonly serialNumber: string;
  /** `mains_oper_state`: `closed` means the grid relay is closed (on grid), `open` means islanded (off grid). */
  readonly grid?: "on-grid" | "off-grid";
  readonly reportedAt?: string;
}

export interface EnsembleInventory {
  readonly batteries: readonly BatteryUnit[];
  readonly controllers: readonly SystemController[];
}

function devicesOf(groups: readonly UnknownRecord[], type: string): UnknownRecord[] {
  return groups
    .filter((group) => group.type === type && Array.isArray(group.devices))
    .flatMap((group) => (group.devices as unknown[]).map(record).filter((device): device is UnknownRecord => Boolean(device)));
}

export function parseEnsembleInventory(body: unknown): EnsembleInventory {
  if (!Array.isArray(body)) throw new EnphaseProtocolError("Enphase ensemble inventory is not an array");
  const groups = body.map(record).filter((group): group is UnknownRecord => Boolean(group));
  const batteries: BatteryUnit[] = [];
  for (const device of devicesOf(groups, "ENCHARGE")) {
    const serialNumber = text(device.serial_num, 32);
    if (!serialNumber || !SERIAL.test(serialNumber)) continue;
    const percent = finite(device.percentFull);
    const capacityWh = finite(device.encharge_capacity);
    const reportedAt = epochSeconds(device.last_rpt_date);
    batteries.push({
      serialNumber,
      ...(percent !== undefined && percent >= 0 && percent <= 100 ? { percent } : {}),
      ...(capacityWh !== undefined && capacityWh > 0 ? { capacityWh } : {}),
      ...(reportedAt ? { reportedAt } : {}),
    });
  }
  const controllers: SystemController[] = [];
  for (const device of devicesOf(groups, "ENPOWER")) {
    const serialNumber = text(device.serial_num, 32);
    if (!serialNumber || !SERIAL.test(serialNumber)) continue;
    const state = device.mains_oper_state;
    const reportedAt = epochSeconds(device.last_rpt_date);
    controllers.push({
      serialNumber,
      ...(state === "closed" ? { grid: "on-grid" as const } : state === "open" ? { grid: "off-grid" as const } : {}),
      ...(reportedAt ? { reportedAt } : {}),
    });
  }
  return { batteries, controllers };
}

// ---------------------------------------------------------------------------
// GET /ivp/ensemble/secctrl

export interface BatteryAggregate {
  /** Aggregate IQ Battery state of charge, percent. */
  readonly percent?: number;
  /** Energy available in the IQ Batteries now, watt-hours. */
  readonly availableWh?: number;
  /** Usable capacity, watt-hours. */
  readonly capacityWh?: number;
}

export function parseSecctrl(body: unknown): BatteryAggregate {
  const root = record(body);
  if (!root) throw new EnphaseProtocolError("Enphase secctrl is not an object");
  // ENC_* covers IQ Batteries only; agg_soc also folds in legacy AC Batteries.
  const percent = finite(root.ENC_agg_soc) ?? finite(root.agg_soc);
  const availableWh = finite(root.ENC_agg_avail_energy);
  const capacityWh = finite(root.Enc_max_available_capacity) ?? finite(root.Max_energy);
  return {
    ...(percent !== undefined && percent >= 0 && percent <= 100 ? { percent } : {}),
    ...(availableWh !== undefined && availableWh >= 0 ? { availableWh } : {}),
    ...(capacityWh !== undefined && capacityWh > 0 ? { capacityWh } : {}),
  };
}

// ---------------------------------------------------------------------------
// GET /ivp/ensemble/power

/**
 * Total IQ Battery real power, watts, summed from each unit's
 * `real_power_mw`: positive is discharging (supplying the home or grid),
 * negative is charging. The firmware spells the list key `devices:`, with a
 * trailing colon; the plain spelling is accepted too.
 */
export function parseBatteryPower(body: unknown): number | undefined {
  const root = record(body);
  if (!root) throw new EnphaseProtocolError("Enphase ensemble power is not an object");
  const list = root["devices:"] ?? root.devices;
  if (!Array.isArray(list)) throw new EnphaseProtocolError("Enphase ensemble power has no device list");
  const values = list.map((item) => finite(record(item)?.real_power_mw)).filter((value): value is number => value !== undefined);
  if (!values.length) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / 1000;
}
