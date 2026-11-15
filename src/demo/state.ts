/** In-memory device simulator. It imports no device implementations or server code. */
import type { DeviceGroup } from "../schemas";
import type { RegisteredDevice } from "../site";
import type { NodeId, NodeRecord } from "../state/protocol";

export interface DemoData {
  readonly version: 1;
  readonly basePath: string;
  readonly devices: readonly RegisteredDevice[];
  readonly records: readonly NodeRecord[];
  readonly groups: readonly DeviceGroup[];
  readonly graph?: unknown;
  readonly graphScene?: unknown;
}

// Capability documents have different shapes; only this simulator's allowlisted
// state fields cross the persistence boundary. Incoming objects are never merged.
type Document = Record<string, any>;
const object = (value: unknown): Document => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Document : {};
const copy = <T>(value: T): T => structuredClone(value);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const fields = ["on", "value", "brightnessPercent", "colorTemperatureKelvin", "color", "power", "artMode", "volumePercent", "muted", "playback", "input", "app", "scene", "effect", "childLocked", "timerSeconds", "listening", "show"] as const;
type Delta = [number, number, number, unknown];
const COOKIE_NAME = "ht_demo_state";
export const COOKIE_CHUNKS = 4;
export const COOKIE_CHUNK_SIZE = 3000;
const COOKIE_MAX = COOKIE_CHUNKS * COOKIE_CHUNK_SIZE;

function fingerprint(snapshot: DemoData): string {
  let hash = 2166136261;
  const shape = JSON.stringify(snapshot.records.map(record => [record.node, record.value]));
  for (let index = 0; index < shape.length; index++) hash = Math.imul(hash ^ shape.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}

function encode(value: unknown): string {
  return btoa(Array.from(new TextEncoder().encode(JSON.stringify(value)), byte => String.fromCharCode(byte)).join(""));
}

function decode(value: string): unknown {
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value), char => char.charCodeAt(0))));
}

/** Cookie values contain compact changes, never a copy of the installation. */
export function readDemoCookie(cookie: string): string {
  const cookies = new Map(cookie.split(";").map(part => {
    const equal = part.indexOf("=");
    return [part.slice(0, equal).trim(), part.slice(equal + 1)];
  }));
  const count = Number(cookies.get(`${COOKIE_NAME}_n`));
  if (!Number.isInteger(count) || count < 1 || count > COOKIE_CHUNKS) return "";
  let value = "";
  for (let index = 0; index < count; index++) {
    const chunk = cookies.get(`${COOKIE_NAME}_${index}`);
    if (!chunk || chunk.length > COOKIE_CHUNK_SIZE) return "";
    value += chunk;
  }
  return value;
}

/** Host-only cookies expire after 30 days; a deployment cannot write another path. */
export function demoCookieWrites(value: string, basePath: string, secure: boolean): string[] {
  if (value.length > COOKIE_MAX) throw new Error("Demo state exceeds its cookie budget");
  if (!/^\/[A-Za-z0-9/_-]*$/.test(basePath)) throw new Error("Invalid demo base path");
  const suffix = `; Path=${basePath || "/"}; SameSite=Lax${secure ? "; Secure" : ""}`;
  const count = Math.ceil(value.length / COOKIE_CHUNK_SIZE);
  const result = Array.from({ length: COOKIE_CHUNKS }, (_, index) => {
    const chunk = value.slice(index * COOKIE_CHUNK_SIZE, (index + 1) * COOKIE_CHUNK_SIZE);
    return `${COOKIE_NAME}_${index}=${chunk}; Max-Age=${chunk ? 2592000 : 0}${suffix}`;
  });
  result.push(`${COOKIE_NAME}_n=${count || ""}; Max-Age=${count ? 2592000 : 0}${suffix}`);
  return result;
}

export class DemoError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** Every command updates a local snapshot and notifies the same UI state stream. */
export class DemoState {
  readonly #initial: NodeRecord[];
  readonly #records = new Map<NodeId, NodeRecord>();
  readonly #listeners = new Set<(records: readonly NodeRecord[]) => void>();
  readonly #fingerprint: string;
  #version = 1;

  constructor(readonly snapshot: DemoData, cookie = "", readonly now: () => string = () => new Date().toISOString()) {
    this.#initial = copy([...snapshot.records]);
    this.#fingerprint = fingerprint(snapshot);
    for (const record of this.#initial) this.#records.set(record.node, copy(record));
    this.#version = Math.max(1, ...snapshot.records.map(record => record.version));
    this.restore(cookie);
    this.#refreshGroups();
  }

  read(node: string): NodeRecord | undefined { return this.#records.get(node as NodeId); }
  records(): NodeRecord[] { return [...this.#records.values()]; }
  onChange(listener: (records: readonly NodeRecord[]) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  reset(): void {
    this.#records.clear();
    for (const record of this.#initial) this.#records.set(record.node, { ...copy(record), version: ++this.#version });
    this.#refreshGroups();
    this.#notify();
  }

  persist(): string {
    const deltas: Delta[] = [];
    this.#initial.forEach((initial, index) => {
      if (!initial.node.startsWith("device/")) return;
      const initialCaps = object(object(initial.value).capabilities);
      const caps = object(object(this.read(initial.node)?.value).capabilities);
      Object.keys(initialCaps).forEach((capability, capIndex) => {
        const state = object(object(caps[capability]).state);
        const baseline = object(object(initialCaps[capability]).state);
        fields.forEach((field, fieldIndex) => {
          if (!same(state[field], baseline[field])) deltas.push([index, capIndex, fieldIndex, state[field] ?? null]);
        });
      });
    });
    if (!deltas.length) return "";
    const encoded = encode([this.#fingerprint, deltas]);
    // Reject the write rather than silently losing earlier control settings.
    if (encoded.length > COOKIE_MAX) throw new DemoError("This demo's cookie is full. Reset the demo to keep playing.", 409);
    return encoded;
  }

  restore(cookie: string): void {
    if (!cookie || cookie.length > COOKIE_MAX) return;
    try {
      const parsed = decode(cookie);
      if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== this.#fingerprint || !Array.isArray(parsed[1]) || parsed[1].length > 2000) return;
      for (const delta of parsed[1]) {
        if (!Array.isArray(delta) || delta.length !== 4) continue;
        const [index, capIndex, fieldIndex, value] = delta;
        if (![index, capIndex, fieldIndex].every(value => Number.isSafeInteger(value) && value >= 0)) continue;
        const initial = this.#initial[index];
        if (!initial?.node.startsWith("device/")) continue;
        const record = this.#records.get(initial.node)!;
        const caps = object(object(record.value).capabilities);
        const capability = Object.keys(caps)[capIndex];
        const field = fields[fieldIndex];
        if (!capability || !field) continue;
        if (value === null) { delete object(caps[capability]).state[field]; continue; }
        if (!this.#validField(field, value, object(caps[capability]))) continue;
        object(caps[capability]).state[field] = copy(value);
      }
    } catch { /* A stale or malformed cookie starts a fresh playground. */ }
  }

  #validField(field: string, value: unknown, capability: Document): boolean {
    if (["on", "muted", "childLocked", "listening"].includes(field)) return typeof value === "boolean";
    if (field === "timerSeconds") return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 5940;
    if (["brightnessPercent", "volumePercent"].includes(field)) return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
    if (field === "colorTemperatureKelvin") return typeof value === "number" && Number.isFinite(value) && value >= 1000 && value <= 20000;
    if (field === "color") return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
    if (["value", "artMode"].includes(field)) return value === "on" || value === "off";
    if (field === "power") return value === "on" || value === "standby";
    if (field === "playback") return ["playing", "paused", "stopped"].includes(String(value));
    if (field === "input" || field === "app") {
      const choices = capability.actions?.[field === "input" ? "setInput" : "launchApp"]?.[field === "input" ? "inputs" : "apps"];
      return Array.isArray(choices) && choices.some(choice => same(choice, value));
    }
    if (field === "effect") return typeof value === "string" && value.length <= 100;
    if (field === "scene") return typeof object(value).sceneId === "string" && JSON.stringify(value).length <= 200 && Object.keys(object(value)).every(key => ["sceneId", "status", "name"].includes(key));
    if (field === "show") return JSON.stringify(value).length <= 200 && Object.keys(object(value)).every(key => ["showId", "presetId", "status"].includes(key));
    return false;
  }

  invoke(node: string, capability: string, control: string, value?: unknown): NodeRecord {
    const before = copy(this.records());
    try {
      if (node.startsWith("group/")) {
        const group = this.snapshot.groups.find(group => `group/${group.id}` === node);
        if (!group) throw new DemoError("This group is not in the demo.", 404);
        if (control !== "getState") {
          const on = object(object(object(this.read(node)?.value).capabilities).binarySwitch).state?.value === "on";
          for (const id of group.members) {
            const caps = object(object(this.read(`device/${id}`)?.value).capabilities);
            const kind = capability === "power" || capability === "binarySwitch" ? ["light", "stringLight", "binarySwitch"].find(kind => caps[kind]) : capability === "light" && caps.stringLight ? "stringLight" : capability;
            if (kind) this.#control(`device/${id}`, kind, control === "toggle" ? on ? "turnOff" : "turnOn" : control, value);
          }
        }
      } else {
        this.#control(node, capability, control, value);
        // A string's overall controls also update its individually browsable bulbs.
        if (capability === "stringLight" && ["turnOn", "turnOff", "setBrightness", "setColor", "setColorTemperature"].includes(control)) {
          const id = node.slice("device/".length);
          for (const child of this.snapshot.devices.filter(device => device.parent?.id === id)) {
            const caps = object(object(this.read(`device/${child.id}`)?.value).capabilities);
            if (Object.hasOwn(object(object(caps.light).actions), control)) this.#control(`device/${child.id}`, "light", control, value);
          }
        }
      }
      this.#refreshGroups();
      this.persist();
      this.#notify();
      const result = this.read(node);
      if (!result) throw new DemoError("This device is not in the demo.", 404);
      return result;
    } catch (error) {
      this.#records.clear();
      before.forEach(record => this.#records.set(record.node, record));
      throw error;
    }
  }

  #control(node: string, kind: string, control: string, value?: unknown): void {
    const record = this.read(node);
    if (!record) throw new DemoError("This device is not in the demo.", 404);
    const document = object(copy(record.value));
    const capability = object(object(document.capabilities)[kind]);
    if (!Object.keys(capability).length) throw new DemoError("This capability is not in the demo.", 404);
    if (control !== "getState" && !Object.hasOwn(object(capability.actions), control)) throw new DemoError("This control is not available in the demo.", 404);
    const state = object(capability.state);
    const bounds = object(object(capability.actions)[control]);
    const numeric = (min: number, max: number): number => {
      if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new DemoError(`Choose a value from ${min} to ${max}.`);
      return value;
    };
    const power = (on: boolean) => {
      if (kind === "television") { state.power = on ? "on" : "standby"; if (!on) state.artMode = "off"; }
      else if (kind === "binarySwitch") state.value = on ? "on" : "off";
      else state.on = on;
    };
    switch (control) {
      case "getState": break;
      case "turnOn": power(true); break;
      case "turnOff": power(false); break;
      case "toggle": power(!(state.on === true || state.value === "on" || state.power === "on")); break;
      case "setBrightness": state.brightnessPercent = numeric(bounds.minimumPercent ?? 0, bounds.maximumPercent ?? 100); state.on = state.brightnessPercent > 0; break;
      case "setColorTemperature": state.colorTemperatureKelvin = numeric(bounds.minimumKelvin ?? 1000, bounds.maximumKelvin ?? 20000); delete state.color; break;
      case "setColor": if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new DemoError("Choose a six-digit hex color."); state.color = value; delete state.colorTemperatureKelvin; break;
      case "setVolume": state.volumePercent = numeric(bounds.minimumPercent ?? 0, bounds.maximumPercent ?? 100); break;
      case "volumeUp": state.volumePercent = Math.min(100, Number(state.volumePercent ?? 20) + 5); break;
      case "volumeDown": state.volumePercent = Math.max(0, Number(state.volumePercent ?? 20) - 5); break;
      case "toggleMute": state.muted = !state.muted; break;
      case "setMute": if (typeof value !== "boolean") throw new DemoError("Choose on or off."); state.muted = value; break;
      case "setChildLock": if (typeof value !== "boolean") throw new DemoError("Choose locked or unlocked."); state.childLocked = value; break;
      case "setTimer": state.timerSeconds = numeric(0, 5940); break;
      case "startListening": state.listening = true; break;
      case "stopListening": state.listening = false; break;
      case "setArtMode": if (typeof value !== "boolean") throw new DemoError("Choose on or off."); state.artMode = value ? "on" : "off"; state.power = "on"; break;
      case "play": case "playUri": state.playback = "playing"; break;
      case "pause": state.playback = "paused"; break;
      case "stop": state.playback = "stopped"; break;
      case "setInput": case "launchApp": {
        const choices = bounds[control === "setInput" ? "inputs" : "apps"];
        const choice = Array.isArray(choices) ? choices.find(choice => choice.id === value) : undefined;
        if (!choice) throw new DemoError("Choose an available demo input.");
        state[control === "setInput" ? "input" : "app"] = copy(choice); state.power = "on"; break;
      }
      case "setEffect": if (typeof value !== "string" || value.length > 100) throw new DemoError("Choose a demo effect."); state.effect = value; break;
      case "setScene": case "applyScene": {
        const id = typeof value === "string" ? value : object(value).sceneId;
        if (typeof id !== "string" || id.length > 100) throw new DemoError("Choose a demo scene.");
        state.scene = { sceneId: id, status: "submitted" }; state.on = true; break;
      }
      case "playShow": case "applyPreset": {
        const id = typeof value === "string" ? value : object(value).id;
        if (typeof id !== "string" || id.length > 100) throw new DemoError("Choose a demo show.");
        state.show = { [control === "playShow" ? "showId" : "presetId"]: id, status: "submitted" }; state.on = true; break;
      }
      case "stopShow": state.show = { status: "idle" }; break;
      // Stateless actions acknowledge the pretend action and publish a fresh frame.
      case "press": case "say": case "leaveGroup": case "joinGroup": case "next": case "previous": case "send": case "learn": case "dispense": case "start": case "cancel": case "stopEffect": case "snapshot": case "stream": break;
      default: throw new DemoError("This action is not simulated in the demo.", 501);
    }
    const stamp = this.now();
    capability.state = { ...state, availability: "online", observedAt: stamp };
    document.status = "online";
    this.#records.set(record.node, { node: record.node, value: document, version: ++this.#version, observedAt: stamp, updatedAt: stamp });
  }

  #refreshGroups(): void {
    for (const group of this.snapshot.groups) {
      const record = this.read(`group/${group.id}`);
      if (!record?.value) continue;
      const document = object(copy(record.value));
      const members = this.groupSnapshot(group.id).members;
      const values = members.map((member: Document) => member.properties["power.on"]);
      const shared = values.length > 0 && values.every((value: unknown) => value === values[0]);
      const caps = object(document.capabilities);
      if (caps.binarySwitch) caps.binarySwitch.state = { ...caps.binarySwitch.state, value: shared ? values[0] ? "on" : "off" : "unknown", observedAt: this.now() };
      document.group = { ...document.group, mixed: !shared, members };
      this.#records.set(record.node, { ...record, value: document, version: ++this.#version, observedAt: this.now(), updatedAt: this.now() });
    }
  }

  groupSnapshot(id: string): Document {
    const group = this.snapshot.groups.find(group => group.id === id);
    if (!group) throw new DemoError("This group is not in the demo.", 404);
    const members = group.members.map(id => {
      const device = this.snapshot.devices.find(device => device.id === id);
      const record = this.read(`device/${id}`);
      const caps = object(object(record?.value).capabilities);
      const properties: Document = {};
      for (const [kind, capability] of Object.entries(caps)) {
        for (const [key, value] of Object.entries(object(object(capability).state))) {
          if (["availability", "observedAt", "detail"].includes(key)) continue;
          const power = kind === "binarySwitch" && key === "value" || ["light", "stringLight"].includes(kind) && key === "on";
          properties[power ? "power.on" : `${kind === "stringLight" ? "light" : kind}.${key}`] = power && kind === "binarySwitch" ? value === "on" : value;
        }
      }
      const page = device?.page ?? `/devices/${id}`;
      return { id, name: device?.name ?? id, page: page.startsWith(`${this.snapshot.basePath}/`) ? page : `${this.snapshot.basePath}${page}.html`, availability: "online", properties, observedAt: record?.observedAt };
    });
    const properties = Object.keys(members[0]?.properties ?? {}).filter(key => members.every(member => Object.hasOwn(member.properties, key))).map(id => {
      const values = members.map(member => member.properties[id]);
      const shared = values.every(value => same(value, values[0]));
      return { id, status: shared ? "shared" : "mixed", ...(shared ? { value: values[0] } : {}) };
    });
    const common = new Map<string, Document>();
    group.members.forEach((id, index) => {
      const available = new Map<string, Document>();
      const caps = object(object(this.read(`device/${id}`)?.value).capabilities);
      for (const [kind, capability] of Object.entries(caps)) {
        for (const [control, bounds] of Object.entries(object(object(capability).actions))) {
          const prefix = ["turnOn", "turnOff", "toggle"].includes(control) && ["binarySwitch", "light", "stringLight"].includes(kind) ? "power" : kind === "stringLight" ? "light" : kind;
          const actionId = `${prefix}.${control}`;
          const input = ["setBrightness", "setColorTemperature", "setVolume"].includes(control) ? "number" : control === "setColor" ? "color" : ["setArtMode", "setMute"].includes(control) ? "boolean" : control.startsWith("set") ? "text" : "none";
          available.set(actionId, { id: actionId, control, bounds, input, confirmation: false });
        }
      }
      if (index === 0) available.forEach((action, key) => common.set(key, action));
      else for (const key of common.keys()) if (!available.has(key)) common.delete(key);
    });
    return { id: group.id, name: group.name, members, properties, actions: [...common.values()], availability: "online", canSwitch: ["turnOn", "turnOff", "toggle"].every(control => common.has(`power.${control}`)), switchEligible: properties.some(property => property.id === "power.on") };
  }

  #notify(): void { for (const listener of this.#listeners) listener(this.records()); }
}
