import type { Television as TelevisionDocument } from "../schemas";
import { describeValidationErrors, validators } from "../validation";
import { Capability, numberValue, type InvokeOptions } from "./capability";

export type TelevisionErrorCode = "invalid_host" | "unreachable" | "protocol" | "not_paired" | "not_supported";

export class TelevisionError extends Error {
  constructor(message: string, readonly code: TelevisionErrorCode) {
    super(message);
    this.name = "TelevisionError";
  }
}

/**
 * Power as a set reports it. A television that answers nothing at all is
 * `offline` — there is no third power value for "unplugged", because that is
 * an availability question, not a power one.
 */
export type TelevisionPower = "on" | "standby";

/**
 * The generic remote vocabulary, as `televisionKeySchema` names it. Every
 * product maps these onto its own key names; no vendor key string reaches
 * this module.
 */
export const TELEVISION_KEYS = [
  "up", "down", "left", "right", "select", "back", "home", "menu", "info", "exit",
  "play", "pause", "stop", "rewind", "fastForward",
  "channelUp", "channelDown", "source",
] as const;

export type TelevisionKey = (typeof TELEVISION_KEYS)[number];

/** An input or an app: something the set can be switched to, with a name when it has one. */
export interface TelevisionSource {
  id: string;
  name?: string;
}

/** What a set reports when read. Everything but `power` is absent on a product that cannot read it. */
export interface TelevisionState {
  power: TelevisionPower;
  input?: TelevisionSource;
  app?: TelevisionSource;
  volumePercent?: number;
  muted?: boolean;
  artMode?: "on" | "off";
}

function isKey(value: unknown): value is TelevisionKey {
  return typeof value === "string" && (TELEVISION_KEYS as readonly string[]).includes(value);
}

function keyValue(controlId: string, value: unknown, keys: readonly TelevisionKey[]): TelevisionKey {
  if (!isKey(value)) {
    throw new TelevisionError(`${controlId} takes one of ${keys.join(", ")}`, "protocol");
  }
  if (!keys.includes(value)) {
    throw new TelevisionError(`This television has no ${value} key; it has ${keys.join(", ")}`, "not_supported");
  }
  return value;
}

function sourceIdValue(controlId: string, value: unknown): string {
  const id = typeof value === "string" ? value : typeof value === "object" && value !== null && "id" in value ? (value as { id: unknown }).id : undefined;
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new TelevisionError(`${controlId} takes an id string or { id }`, "protocol");
  }
  return id;
}

function onOffValue(controlId: string, value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (value === "on") return true;
  if (value === "off") return false;
  throw new TelevisionError(`${controlId} takes a boolean or "on"/"off"`, "protocol");
}

/**
 * The television capability: a networked TV set, whatever protocol reaches it.
 *
 * Every set has power, the navigation keys it declares, relative volume, and
 * mute. Absolute volume, input selection, app launching, and art mode are
 * opt-in — a product declares them by overriding the matching `supports…()`
 * and implementing the operation — so the document never advertises a control
 * the hardware cannot actually perform.
 */
export abstract class Television extends Capability<TelevisionDocument> {
  readonly kind = "television" as const;

  get controlIds(): readonly string[] {
    return [
      "turnOn", "turnOff", "press", "volumeUp", "volumeDown", "toggleMute",
      ...(this.supportsAbsoluteVolume() ? ["setVolume"] : []),
      ...(this.inputs().length > 0 ? ["setInput"] : []),
      ...(this.apps().length > 0 ? ["launchApp"] : []),
      ...(this.supportsArtMode() ? ["setArtMode"] : []),
      "getState",
    ];
  }

  get methods(): readonly string[] {
    return this.controlIds;
  }

  /** Bring the set out of standby (or off, when the product has a way to reach it). */
  abstract turnOn(): Promise<void>;

  /** Put the set into standby, or all the way off where that is what the product means by off. */
  abstract turnOff(): Promise<void>;

  /** Press one key of the generic remote vocabulary. */
  abstract press(key: TelevisionKey): Promise<void>;

  abstract volumeUp(): Promise<void>;
  abstract volumeDown(): Promise<void>;

  /** Flip mute. Sets that cannot read mute state can still toggle it, which is why this is not `setMute`. */
  abstract toggleMute(): Promise<void>;

  /** Return the current state. */
  abstract getState(): Promise<TelevisionState>;

  /** Which of the generic keys this set accepts. Defaults to all of them. */
  keys(): readonly TelevisionKey[] {
    return TELEVISION_KEYS;
  }

  /** The inputs this set can be switched to by name. Empty means `setInput` is not offered. */
  inputs(): readonly TelevisionSource[] {
    return [];
  }

  /** The apps this set can launch by id. Empty means `launchApp` is not offered. */
  apps(): readonly TelevisionSource[] {
    return [];
  }

  /** Whether this set can be told an exact volume, rather than only stepped. */
  supportsAbsoluteVolume(): boolean {
    return false;
  }

  /** Whether this set has an art/gallery idle mode. */
  supportsArtMode(): boolean {
    return false;
  }

  async setVolume(_percent: number): Promise<void> {
    throw new TelevisionError("This television has no absolute volume control", "not_supported");
  }

  async setInput(_id: string): Promise<void> {
    throw new TelevisionError("This television has no input selection", "not_supported");
  }

  async launchApp(_id: string): Promise<void> {
    throw new TelevisionError("This television cannot launch apps", "not_supported");
  }

  async setArtMode(_on: boolean): Promise<void> {
    throw new TelevisionError("This television has no art mode", "not_supported");
  }

  override async invoke(controlId: string, value?: unknown, _options?: InvokeOptions): Promise<unknown> {
    switch (controlId) {
      case "turnOn": return await this.turnOn();
      case "turnOff": return await this.turnOff();
      case "press": return await this.press(keyValue(controlId, value, this.keys()));
      case "volumeUp": return await this.volumeUp();
      case "volumeDown": return await this.volumeDown();
      case "toggleMute": return await this.toggleMute();
      case "setVolume": {
        if (!this.supportsAbsoluteVolume()) return this.unknownControl(controlId);
        const percent = numberValue(controlId, value);
        if (percent < 0 || percent > 100) throw new TelevisionError(`${controlId} takes 0 to 100`, "protocol");
        return await this.setVolume(percent);
      }
      case "setInput":
        if (this.inputs().length === 0) return this.unknownControl(controlId);
        return await this.setInput(sourceIdValue(controlId, value));
      case "launchApp":
        if (this.apps().length === 0) return this.unknownControl(controlId);
        return await this.launchApp(sourceIdValue(controlId, value));
      case "setArtMode":
        if (!this.supportsArtMode()) return this.unknownControl(controlId);
        return await this.setArtMode(onOffValue(controlId, value));
      case "getState": return await this.getState();
      default: return this.unknownControl(controlId);
    }
  }

  /**
   * Snapshot this set as a validated Television document. A set that cannot be
   * read is offline: there is no last-known power value kept on the side.
   */
  override async describe(): Promise<TelevisionDocument> {
    const inputs = this.inputs();
    const apps = this.apps();
    const actions = {
      turnOn: {},
      turnOff: {},
      press: { keys: [...this.keys()] },
      volumeUp: {},
      volumeDown: {},
      toggleMute: {},
      ...(this.supportsAbsoluteVolume() ? { setVolume: { minimumPercent: 0, maximumPercent: 100 } } : {}),
      ...(inputs.length > 0 ? { setInput: { inputs: inputs.map(input => ({ ...input })) } } : {}),
      ...(apps.length > 0 ? { launchApp: { apps: apps.map(app => ({ ...app })) } } : {}),
      ...(this.supportsArtMode() ? { setArtMode: {} } : {}),
      getState: {},
    };
    let candidate: unknown;
    try {
      const state = await this.getState();
      candidate = {
        id: this.id,
        state: {
          availability: "online",
          observedAt: new Date().toISOString(),
          power: state.power,
          ...(state.input ? { input: state.input } : {}),
          ...(state.app ? { app: state.app } : {}),
          ...(state.volumePercent !== undefined ? { volumePercent: state.volumePercent } : {}),
          ...(state.muted !== undefined ? { muted: state.muted } : {}),
          ...(state.artMode !== undefined ? { artMode: state.artMode } : {}),
        },
        actions,
      };
    } catch {
      candidate = { id: this.id, state: { availability: "offline" }, actions };
    }
    if (!validators.television(candidate)) {
      throw new Error(`Invalid television document: ${describeValidationErrors(validators.television.errors)}`);
    }
    return candidate;
  }
}
