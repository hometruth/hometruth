import type { FromSchema } from "json-schema-to-ts";
import { CapabilityError } from "../../../models/capability";
import { type CapabilityMethods, type DeviceCreationContext, type DeviceIdentity, type DeviceInstance, type DeviceModel } from "../../../models/device";
import { Light, type LightState } from "../../../models/light";
import { LightDevice, StringLight, StringLightControl } from "../../../models/string-light";
import { assertGoveeHost, goveeLanTransport, GoveeLanError, parseGoveeScan, parseGoveeStatus, type GoveeLanTransport, type GoveeScan, type GoveeStatus } from "../../../protocols/govee/lan";
import { GoveeShows } from "./shows";
import { bulbColorPacket, bulbBrightnessPacket, arrangementPackets } from "../../../protocols/govee/effects";
import { lightSchema, stringLightSchema, type Light as LightDocument } from "../../../schemas";

const deviceIdSchema = { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 100 } as const;
export const GOVEE_H7021_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/govee-h7021/config", type: "object", additionalProperties: false,
  properties: {
    host: { type: "string", format: "ipv4", pattern: "^(10\\.|192\\.168\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.)" },
    deviceId: { type: "string", pattern: "^([A-Fa-f0-9]{2}:){7}[A-Fa-f0-9]{2}$" },
    /** Real bulb device IDs, in physical order starting at the controller. */
    lights: { type: "array", minItems: 1, maxItems: 30, uniqueItems: true, items: deviceIdSchema },
    timeoutMs: { type: "integer", minimum: 100, maximum: 60000 },
  }, required: ["host", "deviceId", "lights"],
} as const;
export type GoveeH7021Config = FromSchema<typeof GOVEE_H7021_CONFIG_SCHEMA>;

const hexOf = (color: GoveeStatus["color"]) => "#" + [color.r, color.g, color.b].map(channel => channel.toString(16).padStart(2, "0")).join("");

/** Official local API. Writes are serialized and checked against a fresh status reply. */
export class GoveeWholeStringLight extends Light {
  private queue: Promise<unknown> = Promise.resolve();
  private identity?: GoveeScan;
  beforeManual?: () => void;
  private readonly bulbs = new Map<number, LightState & { commandedAt: string }>();
  clearBulbState(): void { this.bulbs.clear(); }
  bulbState(index: number) { const state = this.bulbs.get(index); return state ? { ...state } : undefined; }
  private identityRead: Promise<GoveeScan> | undefined;
  constructor(id: string, readonly config: GoveeH7021Config, readonly transport: GoveeLanTransport) { super(id); assertGoveeHost(config.host); }
  override supportsColor(): boolean { return true; }
  override bounds() { return { minimumPercent: 0, maximumPercent: 100, minimumKelvin: 2700, maximumKelvin: 2700 }; }

  async discover(): Promise<GoveeScan> {
    if (this.identity) return this.identity;
    if (this.identityRead) return this.identityRead;
    this.identityRead = (async () => {
      const scan = parseGoveeScan(await this.transport.request(this.config.host, "scan", this.config.timeoutMs ?? 2000));
      if (scan.sku !== "H7021" || scan.device.toUpperCase() !== this.config.deviceId.toUpperCase() || scan.ip !== this.config.host) throw new GoveeLanError("The Govee controller at this address does not match the configured H7021", "protocol");
      this.identity = scan;
      return scan;
    })();
    try { return await this.identityRead; } finally { this.identityRead = undefined; }
  }
  private async status(): Promise<GoveeStatus> {
    await this.discover();
    return parseGoveeStatus(await this.transport.request(this.config.host, "devStatus", this.config.timeoutMs ?? 2000));
  }
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result;
  }
  async sendVerified(command: "turn" | "brightness" | "colorwc", data: Record<string, unknown>, matches: (state: GoveeStatus) => boolean): Promise<void> {
    await this.discover();
    await this.transport.send(this.config.host, command, data);
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 150));
      if (matches(await this.status())) return;
    }
    throw new GoveeLanError("The controller did not confirm the requested light change", "protocol");
  }
  private manual<T>(fn: () => Promise<T>, clear = false, cancelShow = true): Promise<T> {
    return this.runExclusive(async () => { if (cancelShow) this.beforeManual?.(); if (clear) this.clearBulbState(); return fn(); });
  }
  override turnOn(): Promise<void> { return this.manual(() => this.sendVerified("turn", { value: 1 }, state => state.onOff === 1), false, false); }
  override turnOff(): Promise<void> { return this.manual(() => this.sendVerified("turn", { value: 0 }, state => state.onOff === 0)); }
  override toggle(): Promise<void> { return this.manual(async () => { const value = (await this.status()).onOff === 1 ? 0 : 1; await this.sendVerified("turn", { value }, state => state.onOff === value); }); }
  override setBrightness(percent: number): Promise<void> {
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new CapabilityError("Brightness must be from 0 to 100 percent", "invalid_value");
    const value = Math.round(percent);
    return this.manual(() => this.sendVerified("brightness", { value }, state => state.brightness === value), false, false);
  }
  override setColor(hex: string): Promise<void> {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new CapabilityError("Color must be #rrggbb", "invalid_value");
    return this.manual(() => this.writeColor(hex), true);
  }
  private writeColor(hex: string): Promise<void> {
    const color = { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
    return this.sendVerified("colorwc", { color, colorTemInKelvin: 0 }, state => state.colorTemInKelvin === 0 && hexOf(state.color) === hex.toLowerCase());
  }
  override setColorTemperature(kelvin: number): Promise<void> {
    if (kelvin !== 2700) throw new CapabilityError("H7021 has fixed 2700K warm-white LEDs. It cannot adjust color temperature or warm/cool an RGB pattern. Choose 2700K explicitly to switch the whole string to white.", "invalid_value");
    return this.manual(() => this.writeTemperature(kelvin), true);
  }
  private writeTemperature(kelvin: number): Promise<void> {
    return this.sendVerified("colorwc", { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: kelvin }, state => state.colorTemInKelvin === kelvin);
  }
  async readState(): Promise<LightState> {
    const state = await this.status();
    // The LAN API echoes arbitrary requested Kelvin values, but H7021 white
    // LEDs are fixed at 2700K. A positive value only identifies white mode.
    return { on: state.onOff === 1, brightnessPercent: state.brightness, ...(state.colorTemInKelvin > 0 ? { colorTemperatureKelvin: 2700 } : { color: hexOf(state.color) }) };
  }
  override getState(): Promise<LightState> { return this.runExclusive(() => this.readState()); }
  /** Called from within the shared queue; restores solid settings, not an unknown app scene. */
  async restoreState(state: LightState): Promise<void> {
    if (state.colorTemperatureKelvin) await this.writeTemperature(state.colorTemperatureKelvin);
    else await this.writeColor(state.color ?? "#ffffff");
    await this.sendVerified("brightness", { value: state.brightnessPercent }, current => current.brightness === state.brightnessPercent);
    await this.sendVerified("turn", { value: state.on ? 1 : 0 }, current => current.onOff === (state.on ? 1 : 0));
  }
  /** Called inside the shared queue. Every bulb receives a static RGB value. */
  async writeArrangement(palette: readonly string[]): Promise<void> {
    if (!palette.length) throw new CapabilityError("A scene needs colors", "invalid_value");
    const colors = this.config.lights.map((_, index) => palette[index % palette.length]!);
    const command = arrangementPackets(colors);
    await this.readState();
    this.clearBulbState();
    await this.transport.send(this.config.host, "ptReal", { command });
    const commandedAt = new Date().toISOString();
    colors.forEach((color, index) => this.bulbs.set(index, { on: true, color, brightnessPercent: 100, commandedAt }));
  }
  async setBulb(index: number, patch: Partial<LightState>, toggle = false): Promise<void> {
    if (!Number.isInteger(index) || index < 0 || index >= this.config.lights.length) throw new CapabilityError("Invalid bulb index", "invalid_value");
    await this.manual(async () => {
      await this.readState();
      // This is a requested initial state, not inferred per-bulb telemetry.
      const previous = this.bulbs.get(index);
      if (toggle && !previous) throw new CapabilityError("Set this bulb on or off before toggling; its current state is unknown", "not_supported");
      const next = { on: true, color: "#ffffff", brightnessPercent: 100, ...previous, ...patch };
      if (toggle) next.on = !previous!.on;
      const scale = next.on ? next.brightnessPercent / 100 : 0;
      const color = "#" + [1, 3, 5].map(offset => Math.round(parseInt(next.color.slice(offset, offset + 2), 16) * scale).toString(16).padStart(2, "0")).join("");
      // Native brightness 0 leaves a visible glow on this controller. Use RGB
      // attenuation, including black for off, and reset its segment dimmer.
      try { await this.transport.send(this.config.host, "ptReal", { command: [bulbBrightnessPacket(index, 100), bulbColorPacket(index, color)] }); }
      catch (error) { this.bulbs.delete(index); throw error; }
      this.bulbs.set(index, { ...next, commandedAt: new Date().toISOString() });
    });
  }
}

export interface GoveeH7021 extends CapabilityMethods<{ stringLight: StringLightControl }> {}
export class GoveeH7021 extends StringLight<GoveeH7021Config> {
  readonly model = GOVEE_H7021;
  readonly stringLight: StringLightControl;
  readonly capabilities;
  private ordered?: readonly GoveeH7021Bulb[];
  readonly whole: GoveeWholeStringLight;
  readonly shows: GoveeShows;
  constructor(instance: DeviceInstance, config: GoveeH7021Config, private readonly context: DeviceCreationContext, transport = goveeLanTransport()) {
    super(instance.id, instance.name, config);
    this.whole = new GoveeWholeStringLight(instance.id, config, transport);
    this.shows = new GoveeShows(this.whole);
    this.whole.beforeManual = () => { if (this.shows.getShowState().status !== "idle") this.whole.clearBulbState(); this.shows.cancel(); };
    this.stringLight = new StringLightControl(instance.id, this.whole, () => this.lights, this.shows);
    this.capabilities = this.expose({ stringLight: this.stringLight });
  }
  override get lights(): readonly GoveeH7021Bulb[] {
    return this.ordered ??= Object.freeze(this.config.lights.map((id, index) => {
      const bulb = this.context.device(id);
      if (!(bulb instanceof GoveeH7021Bulb) || bulb.config.stringId !== this.id || bulb.config.index !== index) throw new Error(`${this.id}: light ${index} must reference its own H7021 bulb with matching stringId and index`);
      return bulb;
    }));
  }
  override validate(): void { void this.lights; }
  override close(): Promise<void> { return this.shows.close(); }
  override async probe(): Promise<DeviceIdentity> {
    const scan = await this.whole.discover();
    await this.whole.getState();
    return { model: scan.sku, serialNumber: scan.device, firmwareVersion: scan.wifiVersionSoft };
  }
  protected override identity(): DeviceIdentity { return { model: "H7021", serialNumber: this.config.deviceId }; }
}
export const GOVEE_H7021: DeviceModel<GoveeH7021Config> = {
  id: "govee-h7021", title: "Govee H7021 StringLight", manufacturer: "Govee", product: "H7021",
  capabilities: ["stringLight"], connectionTypes: ["direct-local"], configSchema: GOVEE_H7021_CONFIG_SCHEMA, objectSchemaId: stringLightSchema.$id,
  create(instance, config, _services, _secrets, context) {
    if (!context) throw new Error("An H7021 StringLight requires its configured bulb devices");
    return new GoveeH7021(instance, config, context);
  },
};

export const GOVEE_H7021_BULB_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/govee-h7021-bulb/config", type: "object", additionalProperties: false,
  properties: { stringId: deviceIdSchema, index: { type: "integer", minimum: 0, maximum: 29 } }, required: ["stringId", "index"],
} as const;
export type GoveeH7021BulbConfig = FromSchema<typeof GOVEE_H7021_BULB_CONFIG_SCHEMA>;
const BULB_LIMITATION = "The controller does not report individual bulb state. Values shown are last commands, not confirmation that the bulb is lit. The first command initializes this bulb to white at full relative brightness unless another color or brightness is requested.";

export class GoveeBulbLight extends Light {
  constructor(id: string, private readonly whole: GoveeWholeStringLight, private readonly index: number) { super(id); }
  override supportsColor(): boolean { return true; }
  override supportsColorTemperature(): boolean { return false; }
  override turnOn(): Promise<void> { return this.whole.setBulb(this.index, { on: true }); }
  override turnOff(): Promise<void> { return this.whole.setBulb(this.index, { on: false }); }
  override toggle(): Promise<void> { return this.whole.setBulb(this.index, {}, true); }
  override setBrightness(percent: number): Promise<void> {
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new CapabilityError("Brightness must be from 0 to 100 percent", "invalid_value");
    return this.whole.setBulb(this.index, { brightnessPercent: Math.round(percent) });
  }
  override async setColorTemperature(_kelvin: number): Promise<void> { throw new CapabilityError("Per-bulb white temperature is not supported", "not_supported"); }
  override setColor(hex: string): Promise<void> {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new CapabilityError("Color must be #rrggbb", "invalid_value");
    return this.whole.setBulb(this.index, { color: hex.toLowerCase() });
  }
  override async getState(): Promise<LightState> {
    const state = this.whole.bulbState(this.index);
    if (!state) throw new CapabilityError("Individual bulb state is unknown until a command is sent", "not_supported");
    return { ...state, stateSource: "commanded" };
  }
  override async describe(): Promise<LightDocument> {
    const state = this.whole.bulbState(this.index);
    return { id: this.id, state: { availability: "unknown", detail: BULB_LIMITATION, ...(state ? { ...state, stateSource: "commanded" } : {}) }, actions: { turnOn: {}, turnOff: {}, ...(state ? { toggle: {} } : {}), setBrightness: { minimumPercent: 0, maximumPercent: 100 }, setColor: { formats: ["hex"] } } };
  }
}
export class GoveeH7021Bulb extends LightDevice<GoveeH7021BulbConfig> {
  readonly model = GOVEE_H7021_BULB;
  readonly light: GoveeBulbLight;
  readonly capabilities;
  override readonly parent;
  constructor(instance: DeviceInstance, config: GoveeH7021BulbConfig, readonly string: GoveeH7021) {
    super(instance.id, instance.name, config);
    this.parent = { id: config.stringId, index: config.index };
    this.light = new GoveeBulbLight(instance.id, string.whole, config.index);
    this.capabilities = this.expose({ light: this.light });
  }
  override validate(): void { if (this.string.config.lights[this.config.index] !== this.id) throw new Error(`${this.id}: bulb index does not match its StringLight's ordered lights array`); }
  override displayHost(): string { return this.string.config.host; }
  /** Controller reachability is not evidence that an individual bulb is working. */
  override async probe(): Promise<DeviceIdentity> { throw new CapabilityError(BULB_LIMITATION, "not_supported"); }
}
export const GOVEE_H7021_BULB: DeviceModel<GoveeH7021BulbConfig> = {
  id: "govee-h7021-bulb", title: "Govee H7021 bulb", manufacturer: "Govee", product: "H7021 bulb",
  capabilities: ["light"], connectionTypes: ["local-hub"], configSchema: GOVEE_H7021_BULB_CONFIG_SCHEMA, objectSchemaId: lightSchema.$id,
  create(instance, config, _services, _secrets, context) {
    // Containment is declared through `parent` and the string's own ordered
    // `lights`; no logical reference to record on top of it.
    const string = context?.device(config.stringId);
    if (!(string instanceof GoveeH7021)) throw new Error(`${instance.id}: stringId must reference a Govee H7021 StringLight`);
    return new GoveeH7021Bulb(instance, config, string);
  },
};
