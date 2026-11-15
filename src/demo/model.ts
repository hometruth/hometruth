/** A deliberately disconnected projection: no device constructor, host, secret, or live reading. */
import { homeTruthObjectSchema, binarySwitchSchema, sensorSchema, type DevicesConfig, type DeviceGroup } from "../schemas";
import type { RegisteredDevice } from "../site";
import { deviceKindOf } from "../site";
import { MODELS } from "../registry";
import type { DeviceModel } from "../models/device";
import type { NodeRecord } from "../state/protocol";
import type { GraphContents } from "../graph/graph";
import type { PlacedGraphScene } from "../graph/scene-layout";

export interface DemoSnapshot {
  version: 1;
  basePath: string;
  devices: RegisteredDevice[];
  records: NodeRecord[];
  groups: DeviceGroup[];
  graph?: GraphContents;
  graphScene?: PlacedGraphScene;
}

/** An illustrative snapshot, not a claim about when the installation was observed. */
export const DEMO_SNAPSHOT_TIME = "2000-01-01T00:00:00.000Z";

export function demoBasePath(path = "/demo"): string {
  if (!/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path)) throw new Error("Demo base path must contain plain path segments, for example /demo");
  return path;
}

const POWER = { turnOn: {}, turnOff: {}, toggle: {}, getState: {} };
const SENSOR_SAMPLES: Record<string, { kind: string; unit: string; value: number }> = {
  "https://hometruth.ai/schemas/temperature-sensor": { kind: "temperature", unit: "°C", value: 22 },
  "https://hometruth.ai/schemas/humidity-sensor": { kind: "humidity", unit: "%", value: 45 },
  "https://hometruth.ai/schemas/battery-sensor": { kind: "battery", unit: "%", value: 92 },
};

/** Illustrative capability values and controls, independent of device configuration and secrets. */
function capability(kind: string, id: string, at: string): Record<string, unknown> {
  const state: Record<string, unknown> = { availability: "online", observedAt: at };
  let actions: Record<string, unknown> = { getState: {} };
  const extra: Record<string, unknown> = {};
  switch (kind) {
    case "binarySwitch": Object.assign(state, { value: "off" }); actions = { ...POWER }; break;
    case "light": case "stringLight":
      Object.assign(state, { on: true, brightnessPercent: 65, colorTemperatureKelvin: 3000, color: "#ffca80" }, kind === "stringLight" ? { lightCount: 15 } : {});
      actions = { turnOn: {}, turnOff: {}, toggle: {}, setBrightness: { minimumPercent: 0, maximumPercent: 100 }, setColorTemperature: { minimumKelvin: 2000, maximumKelvin: 6500 }, setColor: { formats: ["hex"] } };
      if (kind === "stringLight") { Object.assign(state, { layout: "linear", lightCount: 1, lights: [{ id: `${id}-bulb-1`, name: "Bulb 1", index: 0 }] }); actions.getLights = {}; } break;
    case "button": actions = { press: {} }; break;
    case "speaker":
      Object.assign(state, { playback: "paused", volumePercent: 25, muted: false });
      actions = { play: {}, pause: {}, stop: {}, setVolume: { minimumPercent: 0, maximumPercent: 100 }, setMute: {}, playUri: {}, say: {}, joinGroup: {}, leaveGroup: {}, getState: {} }; break;
    case "television":
      Object.assign(state, { power: "standby", volumePercent: 25, muted: false, artMode: "off" });
      actions = { turnOn: {}, turnOff: {}, getState: {}, volumeUp: {}, volumeDown: {}, toggleMute: {}, setVolume: { minimumPercent: 0, maximumPercent: 100 }, setArtMode: {}, press: { keys: ["up", "down", "left", "right", "select", "back", "home", "menu", "play", "pause"] }, setInput: { inputs: [{ id: "hdmi1", name: "HDMI 1" }, { id: "hdmi2", name: "HDMI 2" }] } }; break;
    case "camera":
      Object.assign(state, { streamAvailable: true, snapshotAvailable: true }); actions = { snapshot: {} }; break;
    case "treatDispenser": actions = { dispense: { minimumPortions: 1, maximumPortions: 5, step: 1 } }; break;
    case "occupancySensor": Object.assign(state, { occupied: false }); actions = {}; break;
    case "motionSensor": Object.assign(state, { motion: false }); actions = {}; break;
    case "contactSensor": Object.assign(state, { open: false, batteryPercent: 92 }); actions = {}; break;
    case "sensor": Object.assign(state, { sensors: [{ id: "temperature", name: "Temperature", quantity: "temperature", value: 22, unit: "°C", availability: "online", observedAt: at }] }); actions = {}; break;
    case "hub": Object.assign(state, { accessories: [] }); actions = {}; break;
    case "cooktop": Object.assign(state, { power: "off", childLocked: false, timerSeconds: 0, zones: [] }); actions = { getState: {}, setChildLock: {}, setTimer: {} }; break;
    case "infraredBlaster": case "radioFrequencyBlaster": extra.channels = [{ id: kind === "infraredBlaster" ? "infrared" : "radioFrequency", formats: ["demo"], ...(kind === "radioFrequencyBlaster" ? { centerFrequencyHz: 433920000 } : {}) }]; actions = { send: {} }; break;
    case "radioFrequencyReceiver": extra.channels = [{ id: "radioFrequency", formats: ["demo"], centerFrequencyHz: 2400000000 }]; extra.events = { signalReceived: {} }; actions = { learn: {} }; break;
  }
  return { id, state, actions, ...extra };
}

export function createDemoSnapshot(config: DevicesConfig, options: { basePath?: string; includeNames?: boolean; now?: string; models?: readonly DeviceModel[] } = {}): DemoSnapshot {
  const basePath = demoBasePath(options.basePath);
  const at = options.now ?? DEMO_SNAPSHOT_TIME;
  const models = new Map((options.models ?? MODELS).map(model => [model.id, model]));
  const entries = config.devices ?? [];
  const ids = new Map(entries.map((entry, index) => [entry.id, `demo-device-${index + 1}`]));
  const roomNames = [...new Set([...(config.rooms ?? []), ...entries.flatMap(entry => entry.room ? [entry.room] : []), ...(config.deviceGroups ?? []).flatMap(entry => [entry.room, entry.criteria?.room].filter((room): room is string => Boolean(room)))])];
  const labels = [...new Set(entries.flatMap(entry => typeof entry.config.group === "string" ? [entry.config.group] : []))];
  const roomOf = (room: string | undefined) => room ? options.includeNames ? room : `Room ${roomNames.indexOf(room) + 1}` : undefined;
  const counts = new Map<string, number>();
  const records: NodeRecord[] = [];
  const devices = entries.map((entry): RegisteredDevice => {
    const model = models.get(entry.model);
    if (!model) throw new Error(`Unsupported demo model: ${entry.model}`);
    const id = ids.get(entry.id)!;
    const count = (counts.get(model.id) ?? 0) + 1; counts.set(model.id, count);
    const name = options.includeNames && entry.name ? entry.name : `${model.title} ${count}`;
    const room = roomOf(entry.room);
    const parentId = typeof entry.config.stringId === "string" ? ids.get(entry.config.stringId) : undefined;
    const parent = parentId && typeof entry.config.index === "number" ? { id: parentId, index: entry.config.index } : undefined;
    const groupLabel = typeof entry.config.group === "string" ? options.includeNames ? entry.config.group : `Speaker Group ${labels.indexOf(entry.config.group) + 1}` : undefined;
    const device: RegisteredDevice = { id, name, model: model.id, modelTitle: model.title, kind: deviceKindOf(model), capabilities: [...model.capabilities], connectionTypes: [...model.connectionTypes], host: "Simulated", page: `/devices/${id}`, schemaId: model.objectSchemaId, enabled: true, ...(room ? { room } : {}), ...(parent ? { parent } : {}), ...(groupLabel ? { groupLabel } : {}), ...(model.sensors ? { sensors: [...model.sensors] } : {}) };
    const capabilities = Object.fromEntries(model.capabilities.map(kind => [kind, capability(kind, id, at)]));
    const sensors = model.sensors?.map(sensor => {
      const sample = SENSOR_SAMPLES[sensor.schemaId];
      if (!sample) throw new Error(`No demo sample is defined for sensor schema ${sensor.schemaId}`);
      return { ...sensor, kind: sample.kind, unit: sample.unit, state: { availability: "online", value: sample.value, observedAt: at } };
    });
    records.push({ node: `device/${id}`, version: 1, updatedAt: at, observedAt: at, value: { schemaVersion: 1, id, name, status: "online", health: { status: "healthy", detail: "Simulated device", checkedAt: at }, manufacturer: model.manufacturer, model: model.product, capabilities, ...(parent ? { parent } : {}), ...(sensors?.length ? { sensors } : {}) } });
    return device;
  });
  for (const device of devices.filter(device => device.capabilities.includes("stringLight"))) {
    const children = devices.filter(child => child.parent?.id === device.id).sort((a, b) => a.parent!.index - b.parent!.index);
    const object = records.find(record => record.node === `device/${device.id}`)!.value as { capabilities: { stringLight: { state: Record<string, unknown> } } };
    if (children.length) Object.assign(object.capabilities.stringLight.state, { lightCount: children.length, lights: children.map(child => ({ id: child.id, name: child.name, index: child.parent!.index })) });
  }
  const groups: DeviceGroup[] = (config.deviceGroups ?? []).map((entry, index) => {
    const criteria = entry.criteria;
    const matches = criteria ? devices.filter(device => {
      const schemas = new Set([homeTruthObjectSchema.$id, device.schemaId, ...(device.sensors ?? []).map(sensor => sensor.schemaId), ...device.capabilities.flatMap(kind => homeTruthObjectSchema.properties.capabilities.properties[kind]?.$ref ?? [])]);
      if (device.capabilities.some(kind => ["light", "stringLight"].includes(kind))) schemas.add(binarySwitchSchema.$id);
      if (device.sensors?.length || device.capabilities.some(kind => kind.toLowerCase().includes("sensor"))) schemas.add(sensorSchema.$id);
      return (!criteria.room || device.room === roomOf(criteria.room)) && (!criteria.schemaId || schemas.has(criteria.schemaId)) && !criteria.tagIds?.length;
    }) : devices.filter(device => (entry.members ?? []).some(id => ids.get(id) === device.id));
    const memberIds = new Set(matches.map(device => device.id));
    return { id: `demo-group-${index + 1}`, name: options.includeNames ? entry.name : `Group ${index + 1}`, members: matches.filter(device => !device.parent || !memberIds.has(device.parent.id)).map(device => device.id), asSwitch: entry.asSwitch ?? false, ...(roomOf(entry.room) ? { room: roomOf(entry.room)! } : {}) };
  });
  for (const group of groups) records.push({ node: `group/${group.id}`, version: 1, updatedAt: at, observedAt: at, value: { id: group.id, name: group.name, status: "online", capabilities: { binarySwitch: capability("binarySwitch", group.id, at) }, group: { mixed: false, canSwitch: true, members: group.members.map(id => ({ id, name: devices.find(device => device.id === id)?.name ?? id, missingForSwitch: [] })) } } });
  return { version: 1, basePath, devices, records, groups };
}
