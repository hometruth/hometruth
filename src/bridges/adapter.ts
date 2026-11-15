import { createHash } from "node:crypto";
import type { Site } from "../site";
import type { StateHub } from "../state/hub";
import { SelectedDeviceGroup } from "../models/device-group";
import type { Television } from "../models/television";
import type { CapabilityKind } from "../models/capability";
import type { Camera } from "../models/camera";
import type { DeviceEventLogs } from "../models/device-event-log";
import { elementKey, parseElementKey } from "../tags/identity";
import { deviceNode } from "../state/protocol";
import { isCold } from "../state/persistence";
import { BridgeError, transform, type AccessoryMapping, type AccessorySnapshot, type BridgeDefinition, type BridgeMembership, type BridgeProtocol, type CharacteristicBinding, type ExportAccessory, type ReadBinding, type SharedItem, type Value } from "./model";
import { alternativeProfiles, profileFor, validateCharacteristic, validateMapping } from "./profiles";

type RecordValue = Record<string, any>;
const object = (value: unknown): RecordValue => value && typeof value === "object" ? value as RecordValue : {};
/** JSON Pointer, never executable expressions or prototype traversal. */
export function at(value: unknown, path: string): unknown {
  if (!path) return value;
  if (!path.startsWith("/")) throw new BridgeError("State paths must be JSON Pointers beginning with /");
  const parts = path.slice(1).split("/");
  if (parts.some(part => ["__proto__", "constructor", "prototype"].includes(part.replaceAll("~1", "/").replaceAll("~0", "~")))) throw new BridgeError("Invalid state path");
  for (const part of parts) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new BridgeError("Invalid state path");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as RecordValue)[key];
  }
  return value;
}
const pointer = (path: string) => "/" + path.split(".").map(s => s.replaceAll("~", "~0").replaceAll("/", "~1")).join("/");
const read = (element: string, path: string, extra: Partial<ReadBinding> = {}): CharacteristicBinding => ({ read: { element, path, ...extra } });
const idFor = (element: string, id: string) => createHash("sha256").update(JSON.stringify([element, id])).digest("hex").slice(0, 28);

export class BridgeAdapter {
  constructor(readonly site: Site, readonly hub: StateHub, private readonly logs?: DeviceEventLogs) {}
  node(key: string) { return this.hub.data.topology().node(key); }
  eligible(key: string): boolean {
    const node = this.node(key);
    return Boolean(node?.side === "instance" && ["device", "capability", "sensor", "property", "control", "group", "group-switch", "speaker-group", "automation", "service", "scene", "show", "preset", "signal"].includes(node.kind));
  }
  private group(id: string) {
    const configured = this.site.deviceGroups.find(group => group.id === id);
    const members = configured ? configured.members.flatMap(id => this.site.get(id) ?? [])
      : this.site.devices.filter(device => this.site.deviceView(device).groupLabel === id);
    return new SelectedDeviceGroup(members, Boolean(configured?.criteria));
  }
  private groupSnapshot(id: string) {
    const cached = this.hub.data.group(id);
    if (cached) return cached;
    return this.group(id).snapshot(new Map(this.site.devices.flatMap(device => {
      const doc = this.hub.data.device(device.id); return doc ? [[device.id, doc] as const] : [];
    })), new Map(this.site.devices.flatMap(device => isCold(this.hub.data.record(device.id)?.observedAt) ? [[device.id, "unknown" as const] as const] : [])));
  }
  source(key: string): { value: unknown; reachable: boolean } {
    const parsed = parseElementKey(key);
    if (!parsed) throw new BridgeError("Invalid element");
    const [id, kind, field, property] = parsed.ids;
    if (["group", "group-switch", "speaker-group"].includes(parsed.kind)) {
      const snapshot = this.groupSnapshot(id!);
      return { value: Object.fromEntries(snapshot.properties.filter(p => p.status === "shared").map(p => [p.id, p.value])), reachable: snapshot.availability === "online" };
    }
    if (parsed.kind === "automation" || parsed.kind === "service") {
      const service = this.site.getService(id!);
      return { value: { enabled: service?.switch?.enabled }, reachable: Boolean(service?.switch) };
    }
    const device = this.site.get(id!);
    const record = this.hub.data.record(id!);
    const document = object(this.hub.data.device(id!));
    let value: any = document;
    if (parsed.kind === "capability") value = object(object(document.capabilities)[kind!]).state;
    if (parsed.kind === "sensor" || parsed.kind === "property" && kind === "sensor" && property) {
      const sensorId = parsed.kind === "sensor" ? kind : field;
      const sensor = (document.sensors ?? []).find((s: RecordValue) => s.id === sensorId);
      value = sensor?.state ?? object(object(document.capabilities).sensor).state?.sensors?.find((s: RecordValue) => s.id === sensorId);
      if (property) value = value?.[property];
    } else if (parsed.kind === "property") value = at(object(object(document.capabilities)[kind!]).state, pointer(field!));
    const availability = object(value).availability ?? (kind ? object(object(object(document.capabilities)[kind]).state).availability : undefined);
    return { value, reachable: Boolean(device?.enabled && record && !record.fault && !isCold(record.observedAt) && availability !== "offline" && availability !== "unknown" && availability !== "degraded") };
  }
  exists(key: string, control: boolean): boolean {
    const p = parseElementKey(key);
    if (!p) return false;
    if (!control) return Boolean(this.node(key)?.side === "instance" && this.eligible(key) && !["control", "scene", "show", "preset", "signal"].includes(p.kind));
    if (p.kind !== "control") return false;
    const [id, kind, action] = p.ids;
    if (id === "group") return this.groupSnapshot(kind!).actions.some(a => a.id === action);
    if (id === "automation") return action === "setEnabled" && Boolean(this.site.getService(kind!)?.switch);
    return Boolean(this.site.get(id!)?.capabilities[kind as CapabilityKind]?.controlIds.includes(action!));
  }
  async invoke(key: string, value: unknown): Promise<void> {
    if (!this.exists(key, true)) throw new BridgeError("The mapped control is unavailable", "unavailable");
    const [id, kind, action] = parseElementKey(key)!.ids;
    this.logs?.record(id!, "apple_bridge_control", `Apple Home requested ${kind}.${action}`, { data: { control: `${kind}.${action}`.slice(0, 100), outcome: "requested" } });
    try {
      if (id === "group") {
        const result = await this.group(kind!).invoke(action!, value);
        if (result.results.some(result => !result.ok)) throw new BridgeError("One or more group members did not respond", "unavailable");
        await Promise.all(result.results.map(result => this.hub.observer.refresh(deviceNode(result.id))));
      } else if (id === "automation") await this.site.getService(kind!)!.switch!.setEnabled(Boolean(value));
      else {
        const device = this.site.get(id!)!;
        if (!device.enabled) throw new BridgeError("This device is disabled", "unavailable");
        await device.invoke(kind as CapabilityKind, action!, value);
        await this.hub.observer.refresh(deviceNode(id!));
      }
      this.logs?.record(id!, "apple_bridge_control", `Apple Home completed ${kind}.${action}`, { data: { control: `${kind}.${action}`.slice(0, 100), outcome: "succeeded" } });
    } catch (error) {
      this.logs?.record(id!, "apple_bridge_control", `Apple Home could not complete ${kind}.${action}`, { level: "warn", data: { control: `${kind}.${action}`.slice(0, 100), outcome: "failed" } });
      throw error;
    }
  }
  private mapping(element: string, id: string, name: string, profile: string, characteristics: AccessoryMapping["characteristics"]): ExportAccessory {
    return { element, slot: id, id: idFor(element, id), name, profile, characteristics };
  }
  native(element: string): ExportAccessory[] {
    const p = parseElementKey(element), node = this.node(element);
    if (!p || !node) return [];
    const [id, selected] = p.ids;
    const mappings: ExportAccessory[] = [];
    const add = (id: string, profile: string, characteristics: AccessoryMapping["characteristics"], name = node.name) => mappings.push(this.mapping(element, id, name, profile, characteristics));
    if (["group", "group-switch", "speaker-group"].includes(p.kind)) {
      const snapshot = this.groupSnapshot(id!);
      const actions = new Set(snapshot.actions.map(a => a.id));
      const get = (property: string) => read(element, "/" + property);
      const control = (action: string) => ({ element: elementKey("control", "group", id!, action) });
      if (actions.has("power.turnOn") && actions.has("power.turnOff")) {
        const chars: AccessoryMapping["characteristics"] = { On: { ...get("power.on"), commands: { true: control("power.turnOn"), false: control("power.turnOff") } } };
        if (actions.has("light.setBrightness")) chars.Brightness = { ...get("light.brightnessPercent"), write: control("light.setBrightness") };
        add("power", chars.Brightness ? "Lightbulb" : "Switch", chars);
      }
      if (actions.has("speaker.setMute")) add("speaker", "Speaker", { Mute: { ...get("speaker.muted"), write: control("speaker.setMute") }, ...(actions.has("speaker.setVolume") ? { Volume: { ...get("speaker.volumePercent"), write: control("speaker.setVolume") } } : {}) });
      return mappings;
    }
    if (["automation", "service"].includes(p.kind) && this.site.getService(id!)?.switch) {
      add("enabled", "Switch", { On: { ...read(element, "/enabled"), write: { element: elementKey("control", "automation", id!, "setEnabled") } } }); return mappings;
    }
    const device = this.site.get(id!);
    if (!device) return [];
    const sensor = (sensorId: string, name: string, quantity: string, unit?: string) => {
      const source = elementKey("sensor", id!, sensorId);
      const measure = (extra: Partial<ReadBinding> = {}) => read(source, "/value", extra);
      if (quantity === "temperature") add(`sensor-${sensorId}`, "TemperatureSensor", { CurrentTemperature: measure(unit === "°F" ? { scale: 5 / 9, offset: -160 / 9 } : {}) }, name);
      if (["humidity", "relativeHumidity"].includes(quantity)) add(`sensor-${sensorId}`, "HumiditySensor", { CurrentRelativeHumidity: measure() }, name);
      if (quantity === "battery") add(`sensor-${sensorId}`, "Battery", { BatteryLevel: measure(), StatusLowBattery: measure({ conversion: "battery-low" }) }, name);
      if (quantity === "carbonDioxide") add(`sensor-${sensorId}`, "CarbonDioxideSensor", { CarbonDioxideLevel: measure(), CarbonDioxideDetected: measure({ conversion: "co2-high" }) }, name);
      if (quantity === "particulateMatter2.5") add(`sensor-${sensorId}`, "AirQualitySensor", { PM2_5Density: measure(), AirQuality: measure({ conversion: "pm25-quality" }) }, name);
      if (quantity === "illuminance") add(`sensor-${sensorId}`, "LightSensor", { CurrentAmbientLightLevel: measure() }, name);
    };
    if (["device", "sensor"].includes(p.kind) || p.kind === "capability" && selected === "sensor") {
      for (const s of device.sensors) if (p.kind !== "sensor" || s.id === selected) sensor(s.id, s.name, s.kind, s.unit);
      const reported = object(object(object(this.hub.data.device(id!)).capabilities).sensor).state?.sensors ?? [];
      for (const s of reported) if (p.kind !== "sensor" || s.id === selected) sensor(s.id, s.name, s.quantity, s.unit);
    }
    for (const [kind, capability] of Object.entries(device.capabilities)) {
      if (p.kind !== "device" && !(p.kind === "capability" && selected === kind)) continue;
      const source = elementKey("capability", id!, kind);
      const get = (path: string, extra: Partial<ReadBinding> = {}) => read(source, path, extra);
      const control = (action: string) => ({ element: elementKey("control", id!, kind, action) });
      const has = (action: string) => capability!.controlIds.includes(action);
      if (["light", "stringLight", "binarySwitch"].includes(kind) && has("turnOn") && has("turnOff")) {
        const chars: AccessoryMapping["characteristics"] = { On: { ...get(kind === "binarySwitch" ? "/value" : "/on", kind === "binarySwitch" ? { values: { on: true, off: false } } : {}), commands: { true: control("turnOn"), false: control("turnOff") } } };
        if (has("setBrightness")) chars.Brightness = { ...get("/brightnessPercent"), write: control("setBrightness") };
        if (has("setColorTemperature")) chars.ColorTemperature = { ...get("/colorTemperatureKelvin", { conversion: "kelvin-mired" }), write: { ...control("setColorTemperature"), conversion: "kelvin-mired" } };
        if (has("setColor")) for (const [key, conversion] of [["Hue", "hex-hue"], ["Saturation", "hex-saturation"]] as const) chars[key] = { ...get("/color", { conversion }), write: { ...control("setColor"), conversion } };
        add(kind, kind === "binarySwitch" ? "Switch" : "Lightbulb", chars);
      }
      if (kind === "contactSensor") add(kind, "ContactSensor", { ContactSensorState: get("/open", { values: { true: 1, false: 0 } }) });
      if (kind === "motionSensor") add(kind, "MotionSensor", { MotionDetected: get("/motion") });
      if (kind === "occupancySensor") {
        add(kind, "OccupancySensor", { OccupancyDetected: get("/occupied", { values: { true: 1, false: 0 } }) });
        if (object(this.source(source).value).illuminanceLux !== undefined) add("illuminance", "LightSensor", { CurrentAmbientLightLevel: get("/illuminanceLux") });
      }
      if (kind === "speaker" && has("setMute")) add(kind, "Speaker", { Mute: { ...get("/muted"), write: control("setMute") }, ...(has("setVolume") ? { Volume: { ...get("/volumePercent"), write: control("setVolume") } } : {}) });
      if (kind === "television") {
        const keys = { 0: "rewind", 1: "fastForward", 4: "up", 5: "down", 6: "left", 7: "right", 8: "select", 9: "back", 10: "exit", 11: "play", 15: "info" };
        const chars: AccessoryMapping["characteristics"] = {
          Active: { ...get("/power", { values: { on: 1, standby: 0 } }), commands: { 1: control("turnOn"), 0: control("turnOff") } },
          ActiveIdentifier: { constant: 1 },
          SleepDiscoveryMode: { constant: 1 },
          RemoteKey: { commands: Object.fromEntries(Object.entries(keys).map(([key, value]) => [key, { ...control("press"), value }])) },
        };
        const inputs = (capability as Television).inputs();
        if (inputs.length) chars.ActiveIdentifier = { ...get("/input/id", { values: Object.fromEntries(inputs.map((input, i) => [input.id, i + 1])) }), commands: Object.fromEntries(inputs.map((input, i) => [String(i + 1), { ...control("setInput"), value: input.id }])) };
        // A television with no selectable inputs exposes its one fixed display.
        add(kind, "Television", chars);
        mappings.at(-1)!.inputs = inputs.length ? inputs.map((input, i) => ({ id: i + 1, name: input.name ?? input.id })) : [{ id: 1, name: "Display" }];
      }
      if (kind === "button") add(kind, "MomentarySwitch", { On: { trigger: { element: source } } });
      if (kind === "speaker" && has("play") && has("pause")) add("playback", "SmartSpeaker", {
        CurrentMediaState: get("/playback", { values: { playing: 0, paused: 1, stopped: 2, transitioning: 4, unknown: 5 } }),
        TargetMediaState: { ...get("/playback", { values: { playing: 0, paused: 1, stopped: 2 } }), commands: { 0: control("play"), 1: control("pause"), 2: control("stop") } },
      });
      if (kind === "camera" && (capability as Camera).mediaSource?.()) {
        const mapping = this.mapping(element, kind, node.name, "Camera", {}); mapping.cameraDevice = id!; mappings.push(mapping);
      }
    }
    return mappings;
  }
  /** The automatic accessories an item offers on a protocol, before any overrides. */
  automatic(element: string, protocol: BridgeProtocol): ExportAccessory[] {
    return this.native(element).filter(mapping => profileFor(mapping.profile).protocols.includes(protocol));
  }
  /** Every accessory a membership defines, hidden ones included, with names and types applied. */
  private resolve(member: BridgeMembership, protocol: BridgeProtocol): { accessory: ExportAccessory; automaticName: string; automaticProfile: string; profiles: string[]; hidden: boolean }[] {
    if (!this.eligible(member.element)) throw new BridgeError("An assigned element no longer exists", "unavailable");
    if (member.mappings.length) return member.mappings.map(mapping => {
      validateMapping(mapping, protocol, (key, control) => this.exists(key, control));
      for (const binding of Object.values(mapping.characteristics)) if (binding.read) at({}, binding.read.path);
      const camera = mapping.camera ? parseElementKey(mapping.camera) : undefined;
      const cameraDevice = camera?.ids[0];
      if (mapping.camera && (!cameraDevice || !(this.site.get(cameraDevice)?.capabilities.camera as Camera | undefined)?.mediaSource?.())) throw new BridgeError("Choose an available camera media source");
      for (const binding of Object.values(mapping.characteristics)) if (binding.event) {
        const p = parseElementKey(binding.event.element);
        if (p?.kind !== "capability" || p.ids[1] !== "button") throw new BridgeError("Event sources must be button capabilities");
      }
      const accessory: ExportAccessory = { ...mapping, slot: mapping.id, id: idFor(member.element, mapping.id), element: member.element, ...(cameraDevice ? { cameraDevice } : {}) };
      return { accessory, automaticName: mapping.name, automaticProfile: mapping.profile, profiles: [mapping.profile], hidden: false };
    });
    const automatic = this.automatic(member.element, protocol);
    if (!automatic.length) throw new BridgeError("This element needs a custom mapping for this bridge");
    const resolved = automatic.map(accessory => {
      const override = member.accessories?.[accessory.slot];
      const profiles = alternativeProfiles(accessory, protocol);
      if (override?.profile && !profiles.includes(override.profile)) throw new BridgeError(`${accessory.name} cannot appear as ${profileFor(override.profile).name}`);
      return { accessory: { ...accessory, name: override?.name?.trim() || accessory.name, profile: override?.profile ?? accessory.profile }, automaticName: accessory.name, automaticProfile: accessory.profile, profiles, hidden: Boolean(override?.hidden) };
    });
    if (resolved.every(entry => entry.hidden)) throw new BridgeError("Every accessory from this item is hidden. Remove the item instead.");
    return resolved;
  }
  exports(bridge: BridgeDefinition): ExportAccessory[] {
    const exports = bridge.members.flatMap(member => this.resolve(member, bridge.protocol).filter(entry => !entry.hidden).map(entry => entry.accessory));
    if (exports.length > 140) throw new BridgeError("A bridge can expose up to 140 accessories. Create another bridge for the remaining items.");
    if (new Set(exports.map(a => a.id)).size !== exports.length) throw new BridgeError("Duplicate accessory identity");
    return exports;
  }
  /** What each member contributes, for the bridge page. A broken member is reported, not thrown. */
  shared(bridge: BridgeDefinition): SharedItem[] {
    return bridge.members.map(member => {
      const node = this.node(member.element), parsed = parseElementKey(member.element);
      const device = parsed && ["device", "capability", "sensor", "property"].includes(parsed.kind) ? this.site.get(parsed.ids[0]!) : undefined;
      const room = this.site.roomOf(member.element, device?.room);
      const base = { element: member.element, name: node?.name ?? member.element, ...(room ? { room } : {}), custom: member.mappings.length > 0 };
      try {
        return { ...base, missing: false, accessories: this.resolve(member, bridge.protocol).map(({ accessory, automaticName, automaticProfile, profiles, hidden }) => ({
          slot: accessory.slot, id: accessory.id, name: accessory.name, automaticName, profile: accessory.profile, automaticProfile, profiles, hidden,
        })) };
      } catch (error) {
        return { ...base, missing: true, problem: error instanceof BridgeError ? error.message : "This item cannot be resolved", accessories: [] };
      }
    });
  }
  snapshot(accessory: ExportAccessory): AccessorySnapshot {
    const values: Record<string, Value> = {};
    let reachable = true;
    const definitions = profileFor(accessory.profile).characteristics;
    for (const [key, binding] of Object.entries(accessory.characteristics)) {
      try {
        if (binding.trigger) {
          const source = this.source(binding.trigger.element);
          values[key] = false;
          if (!source.reachable || object(source.value).availability !== "online") reachable = false;
        }
        else if (binding.event) { if (!this.source(binding.event.element).reachable) reachable = false; }
        else if (binding.constant !== undefined) values[key] = binding.constant;
        else if (binding.read) {
          const source = this.source(binding.read.element);
          if (!source.reachable) throw new BridgeError("Unavailable");
          const value = transform(at(source.value, binding.read.path), binding.read);
          const definition = definitions.find(c => c.key === key);
          const quantized = typeof value === "number" && definition?.step ? Math.round(value / definition.step) * definition.step : value;
          values[key] = definition ? validateCharacteristic(quantized, definition) : quantized;
        }
      } catch { if (definitions.find(c => c.key === key)?.required) reachable = false; }
    }
    if (accessory.cameraDevice) reachable = this.source(elementKey("device", accessory.cameraDevice)).reachable;
    return { id: accessory.id, reachable, values };
  }
  private controlQueue = new Map<string, Promise<unknown>>();
  async write(accessory: ExportAccessory, key: string, value: unknown): Promise<AccessorySnapshot> {
    const binding = accessory.characteristics[key];
    const control = binding?.commands?.[String(value)] ?? binding?.write;
    const parts = control ? parseElementKey(control.element)?.ids : binding?.trigger ? parseElementKey(binding.trigger.element)?.ids : undefined;
    const target = parts ? JSON.stringify(parts.slice(0, 2)) : accessory.id;
    const pending = (this.controlQueue.get(target) ?? Promise.resolve()).catch(() => {}).then(() => this.performWrite(accessory, key, value));
    this.controlQueue.set(target, pending);
    try { return await pending; } finally { if (this.controlQueue.get(target) === pending) this.controlQueue.delete(target); }
  }
  private async performWrite(accessory: ExportAccessory, key: string, value: unknown): Promise<AccessorySnapshot> {
    const definition = profileFor(accessory.profile).characteristics.find(c => c.key === key);
    if (!definition?.writable) throw new BridgeError("This characteristic is read-only");
    validateCharacteristic(value, definition);
    const binding = accessory.characteristics[key];
    if (binding?.trigger) {
      validateMapping(accessory, "homekit", (element, control) => this.exists(element, control));
      if (value === false) return this.snapshot(accessory);
      if (!this.snapshot(accessory).reachable) throw new BridgeError("The button is unavailable", "unavailable");
      const id = parseElementKey(binding.trigger.element)!.ids[0]!;
      await this.invoke(elementKey("control", id, "button", "press"), undefined);
      return this.snapshot(accessory);
    }
    const control = binding?.commands?.[String(value)] ?? binding?.write;
    if (!control) throw new BridgeError("This value has no mapped control");
    let output: Value | undefined = control.value !== undefined ? control.value : binding?.commands?.[String(value)] ? undefined : control.conversion?.startsWith("hex-") ? null : transform(value, control);
    if (control.conversion?.startsWith("hex-")) {
      const source = binding?.read;
      if (!source) throw new BridgeError("Colour controls require an observed colour");
      const current = at(this.source(source.element).value, source.path);
      const hue = key === "Hue" ? Number(value) : Number(transform(current, { conversion: "hex-hue" }));
      const saturation = (key === "Saturation" ? Number(value) : Number(transform(current, { conversion: "hex-saturation" }))) / 100;
      const component = (offset: number) => { const k = (offset + hue / 60) % 6; return Math.round(255 * (1 - saturation * Math.max(0, Math.min(k, 4 - k, 1)))).toString(16).padStart(2, "0"); };
      output = `#${component(5)}${component(3)}${component(1)}`;
    }
    await this.invoke(control.element, output);
    const observed = this.snapshot(accessory);
    if (definition.readable && (!observed.reachable || observed.values[key] === undefined)) throw new BridgeError("The device did not return an observed state", "unavailable");
    return observed;
  }
}
