/** Device groups retain individual readings; only compatible, published controls fan out. */
import { isDeepStrictEqual } from "node:util";
import { CapabilityError, combinedAvailability, type Availability, type CapabilityKind, type InvokeOptions } from "./capability";
import type { Device } from "./device";
import type { HomeTruthObject } from "../schemas";

/** A member in this state cannot currently report a reading; a capability it holds is still excused from "shared", not disqualified. */
function isUnread(availability: Availability): boolean {
  return availability === "offline" || availability === "degraded" || availability === "unknown";
}

type RecordValue = Record<string, unknown>;
type Input = "none" | "number" | "boolean" | "text" | "color" | "json";
export interface SharedAction {
  id: string;
  control: string;
  input: Input;
  bounds: RecordValue;
  confirmation: boolean;
}
export interface MemberSnapshot {
  id: string;
  name: string;
  availability: Availability;
  properties: RecordValue;
  error?: string;
  /** Present when this member keeps the group from being a switch; names what it lacks. */
  missingForSwitch?: SwitchRequirement[];
}
export interface GroupSnapshot {
  availability: Availability;
  members: MemberSnapshot[];
  properties: { id: string; status: "shared" | "mixed" | "unknown"; value?: unknown }[];
  actions: SharedAction[];
  /** False when no member has a power-capable kind at all, so the group could never be offered as a switch. */
  switchEligible: boolean;
}

/** What a group switch asks of every member: a power reading and the three power operations. */
export const SWITCH_REQUIREMENTS = ["power.on", "power.turnOn", "power.turnOff", "power.toggle"] as const;
export type SwitchRequirement = typeof SWITCH_REQUIREMENTS[number];
const SWITCH_CAPABLE_KINDS: readonly CapabilityKind[] = ["light", "stringLight", "binarySwitch"];

/** A switch needs a common power reading and all three power operations; `missingForSwitch` on each member says who falls short. */
export function isGroupSwitch(snapshot: GroupSnapshot): boolean {
  return snapshot.properties.some(property => property.id === "power.on")
    && ["power.turnOn", "power.turnOff", "power.toggle"].every(id => snapshot.actions.some(action => action.id === id && !action.confirmation && action.input === "none"));
}
interface Target { kind: CapabilityKind; control: string; bounds: RecordValue }
interface Reading extends Omit<MemberSnapshot, "missingForSwitch"> { actions: Map<string, Target>; kinds: Set<CapabilityKind> }

/** The switch requirements one member fails, judged the way shared properties and actions are formed. */
function missingForSwitch(member: Reading): SwitchRequirement[] {
  return SWITCH_REQUIREMENTS.filter(requirement => {
    if (requirement === "power.on") {
      if (Object.hasOwn(member.properties, requirement)) return false;
      return !(isUnread(member.availability) && (member.kinds.has("light") || member.kinds.has("stringLight") || member.kinds.has("binarySwitch")));
    }
    const target = member.actions.get(requirement);
    return !target || Boolean(target.bounds.confirmation) && target.bounds.confirmation !== "none" || inputFor(target.control, target.bounds) !== "none";
  });
}

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}
function at(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((parent, key) => record(parent)?.[key], value);
}
function flatten(value: RecordValue, prefix: string, output: RecordValue): void {
  for (const [key, child] of Object.entries(value)) {
    if (key === "observedAt" || key === "availability") continue;
    const path = `${prefix}.${key}`;
    if (record(child)) flatten(child as RecordValue, path, output);
    else output[path] = child;
  }
}
async function bounded<T>(work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Device did not respond in time")), 2500);
    })]);
  } finally { clearTimeout(timer); }
}

function consumeCapability(device: Device, kind: string, doc: RecordValue | undefined, properties: RecordValue, actions: Map<string, Target>, availability: Availability[]): void {
  const capability = device.capabilities[kind as CapabilityKind];
  if (!capability) return;
    const state = record(doc?.state) ?? {};
    const status = state.availability;
    availability.push(status === "online" || status === "offline" || status === "degraded" ? status : "unknown");
    flatten(state, kind, properties);
    // Power is the same operation on a light, string light, or a switch. Other names retain their capability namespace.
    const isLightLike = kind === "light" || kind === "stringLight";
    const power = isLightLike ? state.on : kind === "binarySwitch" ? state.value === "on" ? true : state.value === "off" ? false : undefined : undefined;
    if (isLightLike || kind === "binarySwitch") {
      delete properties[`${kind}.${isLightLike ? "on" : "value"}`];
      properties["power.on"] = power;
      if (isLightLike) {
        properties["light.brightnessPercent"] = state.brightnessPercent;
        if (capability.controlIds.includes("setColorTemperature")) properties["light.colorTemperatureKelvin"] = state.colorTemperatureKelvin;
        if (capability.controlIds.includes("setColor")) properties["light.color"] = state.color;
      }
    }
    for (const control of capability.controlIds) {
      let bounds = record(at(doc?.actions, control));
      // Lights expose getState through invoke even though it is not in their actions document.
      if (control === "getState" && (isLightLike || kind === "binarySwitch")) bounds = {};
      if (!bounds) continue;
      const id = ["turnOn", "turnOff", "toggle"].includes(control) && (isLightLike || kind === "binarySwitch") ? `power.${control}` : `${kind}.${control}`;
      if (actions.has(id)) actions.delete(id); // Ambiguous power on a multi-capability device is not groupable.
      else actions.set(id, { kind: kind as CapabilityKind, control, bounds });
    }
}

function cachedReading(device: Device, object: HomeTruthObject | undefined): Reading {
  const actions = new Map<string, Target>();
  const properties: RecordValue = {};
  const availability: Availability[] = [];
  const kinds = new Set<CapabilityKind>();
  for (const kind of Object.keys(device.capabilities)) {
    kinds.add(kind as CapabilityKind);
    consumeCapability(device, kind, record(object?.capabilities[kind as keyof typeof object.capabilities]), properties, actions, availability);
  }
  for (const sensor of device.sensors) {
    kinds.add("sensor");
    const state = object?.sensors?.find(item => item.id === sensor.id)?.state;
    properties[`sensor.${sensor.id}.unit`] = sensor.unit;
    properties[`sensor.${sensor.id}.value`] = state?.value;
    availability.push(state?.availability ?? "unknown");
  }
  return { id: device.id, name: device.name, availability: combinedAvailability(availability), properties, actions, kinds };
}

async function read(device: Device): Promise<Reading> {
  const actions = new Map<string, Target>();
  const properties: RecordValue = {};
  const availability: Availability[] = [];
  const errors: string[] = [];
  const kinds = new Set<CapabilityKind>();
  await Promise.all([...Object.entries(device.capabilities).map(async ([kind, capability]) => {
    if (!capability) return;
    kinds.add(kind as CapabilityKind);
    try {
      const doc = record(await bounded(() => capability.describe()));
      consumeCapability(device, kind, doc, properties, actions, availability);
    } catch (error) {
      availability.push("offline");
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }), ...device.sensors.map(async sensor => {
    kinds.add("sensor");
    const prefix = `sensor.${sensor.id}`;
    properties[`${prefix}.unit`] = sensor.unit;
    properties[`${prefix}.value`] = undefined;
    try {
      const document = await bounded(() => sensor.describe());
      availability.push(document.state.availability);
      properties[`${prefix}.value`] = document.state.value;
    } catch (error) {
      availability.push("offline");
      errors.push(error instanceof Error ? error.message : String(error));
    }
  })]);
  return { id: device.id, name: device.name, availability: combinedAvailability(availability), properties, actions, kinds, ...(errors.length ? { error: errors.join("; ") } : {}) };
}

/** Intersect limits and enum sets; mismatched semantics are not shared controls. */
function intersectBounds(values: RecordValue[]): RecordValue | undefined {
  const result: RecordValue = {};
  const keys = new Set(values.flatMap(Object.keys));
  for (const key of keys) {
    const parts = values.map(value => value[key]);
    const defined = parts.filter(value => value !== undefined);
    if (key === "confirmation") { result[key] = parts.some(value => value && value !== "none") ? "confirm" : "none"; continue; }
    if (/^(minimum|min[A-Z])/.test(key) && defined.every(value => typeof value === "number")) result[key] = Math.max(...defined as number[]);
    else if (/^(maximum|max[A-Z])/.test(key) && defined.every(value => typeof value === "number")) result[key] = Math.min(...defined as number[]);
    else if (parts.every(Array.isArray)) {
      const common = (parts[0] as unknown[]).filter(value => parts.every(part => (part as unknown[]).some(item => isDeepStrictEqual(item, value))));
      if (!common.length) return undefined;
      result[key] = common;
    } else if (parts.every(value => isDeepStrictEqual(value, parts[0]))) result[key] = parts[0];
    else return undefined;
  }
  for (const key of Object.keys(result)) {
    const maximum = key.replace(/^minimum/, "maximum").replace(/^min([A-Z])/, "max$1");
    if (key !== maximum && typeof result[maximum] === "number" && Number(result[key]) > Number(result[maximum])) return undefined;
  }
  // Different step origins can describe incompatible grids even when their ranges overlap.
  if (typeof result.step === "number") {
    for (const key of keys) if (/^minimum/.test(key) && !values.every(value => (Number(result[key]) - Number(value[key])) % Number(result.step) === 0)) return undefined;
  }
  return result;
}

function inputFor(control: string, bounds: RecordValue): Input {
  if (["setMute", "setPrivacy"].includes(control)) return "boolean";
  if (control === "setColor") return "color";
  if (["say", "playUri", "joinGroup"].includes(control)) return "text";
  if (Object.keys(bounds).some(key => /^minimum|^minLease/.test(key))) return "number";
  if (["turnOn", "turnOff", "toggle", "getState", "play", "pause", "stop", "leaveGroup", "playCall", "press", "stopMovement", "pan.home", "tilt.home"].includes(control)) return "none";
  return "json";
}

export class SelectedDeviceGroup {
  constructor(readonly members: readonly Device[], automatic = false, private readonly observe?: (device: Device) => Promise<HomeTruthObject>) {
    if ((!automatic && (members.length < 2 || members.length > 100)) || new Set(members.map(member => member.id)).size !== members.length) {
      throw new CapabilityError("Select between 2 and 100 different devices", "invalid_value");
    }
    // Overlapping composites would command the same physical member twice.
    const leaves = new Set<string>();
    const visit = (device: Device): void => {
      const ids = (device.config as { members?: unknown }).members;
      const children = device.model.id === "light-group" && Array.isArray(ids) ? ids as string[] : [device.id];
      for (const id of children) {
        if (leaves.has(id)) throw new CapabilityError("Select either a light group or its members, without overlapping groups", "invalid_value");
        leaves.add(id);
      }
    };
    members.forEach(visit);
  }

  private async inspect(): Promise<{ snapshot: GroupSnapshot; readings: Reading[] }> {
    return this.summarize(await Promise.all(this.members.map(async device => {
      if (!this.observe) return read(device);
      try { return cachedReading(device, await this.observe(device)); }
      catch (error) { return { ...cachedReading(device, undefined), availability: "offline" as const, error: String(error) }; }
    })));
  }

  /** Fold already observed documents; never performs device or storage I/O. */
  snapshot(documents: ReadonlyMap<string, HomeTruthObject>, statuses: ReadonlyMap<string, Availability> = new Map()): GroupSnapshot {
    return this.summarize(this.members.map(device => {
      const reading = cachedReading(device, documents.get(device.id));
      return { ...reading, availability: statuses.get(device.id) ?? reading.availability };
    })).snapshot;
  }

  private summarize(readings: Reading[]): { snapshot: GroupSnapshot; readings: Reading[] } {
    const first = readings[0];
    if (!first) return { snapshot: { availability: "unknown", members: [], properties: [], actions: [], switchEligible: false }, readings };
    const actions: SharedAction[] = [];
    for (const [id, target] of first.actions) {
      const targets = readings.map(member => member.actions.get(id));
      if (targets.some(target => !target)) continue;
      const bounds = intersectBounds(targets.map(target => target!.bounds));
      if (!bounds) continue;
      actions.push({ id, control: target.control, input: inputFor(target.control, bounds), bounds, confirmation: bounds.confirmation === "confirm" });
    }
    const keys = [...new Set(readings.flatMap(member => Object.keys(member.properties)))];
    const properties = keys.filter(key => readings.every(member => {
      if (Object.hasOwn(member.properties, key)) return true;
      // An unread member stays unknown for this property; a different capability is not a shared property.
      if (!isUnread(member.availability)) return false;
      return key === "power.on" ? member.kinds.has("light") || member.kinds.has("stringLight") || member.kinds.has("binarySwitch") : member.kinds.has(key.split(".")[0] as CapabilityKind);
    })).map(id => {
      const values = readings.map(member => member.properties[id]);
      const status = values.some(value => value === undefined) ? "unknown" : values.every(value => isDeepStrictEqual(value, values[0])) ? "shared" : "mixed";
      return { id, status, ...(status === "shared" ? { value: values[0] } : {}) } as GroupSnapshot["properties"][number];
    });
    const switchEligible = readings.some(reading => SWITCH_CAPABLE_KINDS.some(kind => reading.kinds.has(kind)));
    const members = readings.map(reading => {
      const { actions: _actions, kinds: _kinds, ...member } = reading;
      const missing = switchEligible ? missingForSwitch(reading) : [];
      return { ...member, ...(missing.length ? { missingForSwitch: missing } : {}) };
    });
    return { snapshot: { availability: combinedAvailability(readings.map(member => member.availability)), members, properties, actions, switchEligible }, readings };
  }

  async describe(): Promise<GroupSnapshot> { return (await this.inspect()).snapshot; }

  async invoke(id: string, value?: unknown, options: InvokeOptions = {}) {
    const { snapshot, readings } = await this.inspect();
    const action = snapshot.actions.find(action => action.id === id);
    if (!action) throw new CapabilityError("This control is not currently shared by every selected device", "not_supported");
    validateValue(action, value, options);
    // Toggle converges a mixed group to On, rather than inverting each device independently.
    const toggle = id === "power.toggle" ? readings.every(member => member.properties["power.on"] === true) ? "turnOff" : "turnOn" : undefined;
    if (toggle && !snapshot.actions.some(action => action.id === `power.${toggle}`)) throw new CapabilityError("Power is not shared by every member", "not_supported");
    const results = await Promise.all(readings.map(async (member, index) => {
      const target = member.actions.get(toggle ? `power.${toggle}` : id)!;
      try {
        const result = await this.members[index]!.invoke(target.kind, target.control, value, options);
        return { id: member.id, name: member.name, ok: true, ...(result !== undefined ? { value: result } : {}) };
      } catch (error) {
        return { id: member.id, name: member.name, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }));
    return { ok: results.every(result => result.ok), results, group: await this.describe() };
  }
}

function validateValue(action: SharedAction, value: unknown, options: InvokeOptions): void {
  const invalid = (detail: string): never => { throw new CapabilityError(detail, "invalid_value"); };
  if (action.confirmation && !options.confirmed) throw new CapabilityError("Confirm this action for every group member", "confirmation_required");
  if (action.input === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) invalid("Enter a number for this control");
    for (const [key, bound] of Object.entries(action.bounds)) {
      if (typeof bound !== "number") continue;
      if (/^(minimum|min[A-Z])/.test(key) && Number(value) < bound || /^(maximum|max[A-Z])/.test(key) && Number(value) > bound) invalid("Value is outside the range shared by every member");
    }
    const step = action.bounds.step;
    const minimum = Object.entries(action.bounds).find(([key]) => /^minimum/.test(key))?.[1] ?? 0;
    if (typeof step === "number" && (Number(value) - Number(minimum)) % step !== 0) invalid("Value does not match the shared step");
    if ((action.control === "dispense" || action.control.startsWith("pan.") || action.control.startsWith("tilt.")) && !Number.isInteger(value)) invalid("Enter a whole number");
  }
  if (action.input === "boolean" && typeof value !== "boolean") invalid("Choose On or Off");
  if (action.input === "color" && (typeof value !== "string" || !/^#[a-fA-F0-9]{6}$/.test(value))) invalid("Choose a hex color");
  if (action.input === "text" && (typeof value !== "string" || !value.trim() || typeof action.bounds.maxLength === "number" && value.length > action.bounds.maxLength)) invalid("Enter text within the shared length limit");
}
