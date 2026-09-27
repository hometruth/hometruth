/**
 * A Samsung Frame as a `Television`, driven entirely by the set's own local
 * API: the unauthenticated REST read on port 8001 for power and identity, and
 * the two token-authenticated WebSocket channels on 8002 for keys and art mode.
 * No Samsung account, no SmartThings, no cloud, and no infrared — the blaster
 * is a separate device with its own codes.
 *
 * Two things about a Frame shape this model:
 *
 * - A power *click* does not turn the set off. It moves between watching and
 *   art mode, which is what the Frame is for. Turning it off means holding the
 *   power key, so `turnOff()` holds and `setArtMode()` is the control that
 *   toggles the thing a click would have done.
 * - Only power and identity can be read back. Volume, mute, and the current
 *   input are write-only over this API, so this model does not report them
 *   rather than reporting a value it guessed from what it last sent.
 */
import type { FromSchema } from "json-schema-to-ts";
import { isSafeCameraUri } from "../../../camera-media";
import { Device, lanHostSchema, type CapabilityMethods, type DeviceIdentity, type DeviceInstance, type DeviceModel, type SecretsBag, type SiteServices } from "../../../models/device";
import { Television, TelevisionError, type TelevisionKey, type TelevisionSource, type TelevisionState } from "../../../models/television";
import { samsungFrameSchema } from "../../../schemas";
import { SamsungError, SamsungTizenClient, type SamsungClientOptions, type SamsungFetch, type SocketFactory } from "../../../protocols/samsung/client";
import { SamsungTokenStore } from "../../../vendors/samsung/token-store";

/** The generic remote vocabulary in Tizen's own key names. */
const KEYS: Readonly<Record<TelevisionKey, string>> = {
  up: "KEY_UP",
  down: "KEY_DOWN",
  left: "KEY_LEFT",
  right: "KEY_RIGHT",
  select: "KEY_ENTER",
  back: "KEY_RETURN",
  home: "KEY_HOME",
  menu: "KEY_MENU",
  info: "KEY_INFO",
  exit: "KEY_EXIT",
  play: "KEY_PLAY",
  pause: "KEY_PAUSE",
  stop: "KEY_STOP",
  rewind: "KEY_REWIND",
  fastForward: "KEY_FF",
  channelUp: "KEY_CHUP",
  channelDown: "KEY_CHDOWN",
  source: "KEY_SOURCE",
};

const POWER_KEY = "KEY_POWER";
const VOLUME_UP_KEY = "KEY_VOLUP";
const VOLUME_DOWN_KEY = "KEY_VOLDOWN";
const MUTE_KEY = "KEY_MUTE";

/** How long the power key is held to reach a real power-off rather than art mode. */
const POWER_OFF_HOLD_MS = 3_000;

/** Long enough for someone to walk to the television and accept its prompt. */
const PAIRING_TIMEOUT_MS = 60_000;

/**
 * The HDMI inputs a Frame has. The One Connect box numbers them the way the
 * on-screen source list does, and the discrete key jumps straight to one
 * instead of walking the source carousel.
 */
const INPUTS: readonly (TelevisionSource & { key: string })[] = [
  { id: "hdmi1", name: "HDMI 1", key: "KEY_HDMI1" },
  { id: "hdmi2", name: "HDMI 2", key: "KEY_HDMI2" },
  { id: "hdmi3", name: "HDMI 3", key: "KEY_HDMI3" },
  { id: "hdmi4", name: "HDMI 4", key: "KEY_HDMI4" },
  { id: "tv", name: "TV", key: "KEY_TV" },
];

export interface SamsungFrameTelevisionOptions {
  id: string;
  host: string;
  /** The name the set shows in its pairing prompt and its device list. */
  name?: string;
  timeoutMs?: number;
  tokenStore?: SamsungTokenStore;
  socketFactory?: SocketFactory;
  fetch?: SamsungFetch;
}

export class SamsungFrameTelevision extends Television {
  readonly host: string;
  private readonly tokenStore: SamsungTokenStore;
  private readonly clientOptions: Omit<SamsungClientOptions, "token" | "onToken">;
  private client: SamsungTizenClient | undefined;
  private connecting: Promise<SamsungTizenClient> | undefined;
  /** Opens no channel, so it never makes the set prompt: the REST port needs no pairing. */
  private rest: SamsungTizenClient | undefined;
  /** The last token write, so `pair()` can tell whether one actually landed. */
  private tokenWrite: Promise<void> = Promise.resolve();
  /** What the set last said about itself, so the device document can name the real model without another call. */
  private lastIdentity: DeviceIdentity | undefined;

  constructor(options: SamsungFrameTelevisionOptions) {
    super(options.id);
    const host = options.host.trim();
    if (!/^[A-Za-z0-9.-]+$/u.test(host) || !isSafeCameraUri(`http://${host}/`)) {
      throw new TelevisionError("Samsung Frame host must be a private LAN address or a .local name", "invalid_host");
    }
    this.host = host;
    this.tokenStore = options.tokenStore ?? new SamsungTokenStore();
    this.clientOptions = {
      host,
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.socketFactory ? { socketFactory: options.socketFactory } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    };
  }

  override supportsArtMode(): boolean {
    return true;
  }

  override inputs(): readonly TelevisionSource[] {
    return INPUTS.map(({ id, name }) => (name !== undefined ? { id, name } : { id }));
  }

  /**
   * A click on the power key wakes the set out of standby. Once it is already
   * on, the same click would drop it into art mode, so an already-on set is
   * left alone.
   */
  override async turnOn(): Promise<void> {
    const info = await this.read();
    if (info.power === "on") return;
    await this.key(POWER_KEY);
  }

  /** A held power key: a click would only move the set into art mode. */
  override async turnOff(): Promise<void> {
    await this.withClient(async (client) => await client.holdKey(POWER_KEY, POWER_OFF_HOLD_MS));
  }

  override async press(key: TelevisionKey): Promise<void> {
    await this.key(KEYS[key]);
  }

  override async volumeUp(): Promise<void> {
    await this.key(VOLUME_UP_KEY);
  }

  override async volumeDown(): Promise<void> {
    await this.key(VOLUME_DOWN_KEY);
  }

  override async toggleMute(): Promise<void> {
    await this.key(MUTE_KEY);
  }

  override async setInput(id: string): Promise<void> {
    const input = INPUTS.find((candidate) => candidate.id === id);
    if (!input) {
      throw new TelevisionError(`This television has no ${id} input; it has ${INPUTS.map((candidate) => candidate.id).join(", ")}`, "not_supported");
    }
    await this.key(input.key);
  }

  override async setArtMode(on: boolean): Promise<void> {
    await this.withClient(async (client) => {
      await client.artRequest("set_artmode_status", { value: on ? "on" : "off" });
    });
  }

  /**
   * Power from the REST port, art mode from the art channel.
   *
   * Art mode is only asked for when the set is on *and* already paired. A set
   * in standby has no art channel; an unpaired one would show its pairing
   * prompt, and this runs on the state observer's poll, so asking anyway would
   * put that prompt on the screen every fifteen seconds. Pairing is something
   * `pair()` does once, deliberately.
   */
  override async getState(): Promise<TelevisionState> {
    const info = await this.read();
    const power = info.power;
    if (power !== "on") return { power };
    if (!(await this.paired())) return { power };
    const artMode = await this.readArtMode();
    return { power, ...(artMode ? { artMode } : {}) };
  }

  /** Whether the set has issued a token, which is the only thing that keeps it from prompting. */
  async paired(): Promise<boolean> {
    return (await this.tokenStore.load(this.id)) !== undefined;
  }

  /**
   * Ask the set to accept HomeTruth. This is the one call that deliberately
   * makes the prompt appear, and it is never reached by a poll.
   *
   * It waits far longer than a control does, because what it is waiting for is
   * a person walking to the television and pressing a button on the remote.
   * The ordinary control timeout would give up before they got there, take the
   * prompt down with the socket, and leave the set unpaired.
   *
   * Pairing also happens on its own the first time any control is sent — the
   * control fails with `not_paired` and works on the next try once the prompt
   * is accepted. This is the version to call when nobody wants to discover
   * that by pressing a button that does not work.
   */
  async pair(options: { timeoutMs?: number } = {}): Promise<void> {
    const token = await this.tokenStore.load(this.id);
    const client = new SamsungTizenClient({
      ...this.clientOptions,
      timeoutMs: options.timeoutMs ?? PAIRING_TIMEOUT_MS,
      ...(token ? { token } : {}),
      onToken: (issued) => {
        this.tokenWrite = this.tokenWrite.then(async () => {
          await this.tokenStore.save(this.id, issued);
        }).catch(() => undefined);
      },
    });
    try {
      // Opening the remote channel is the whole handshake; no key is sent.
      await client.openRemoteChannel();
    } catch (error) {
      throw asTelevisionError(error, this.host);
    } finally {
      await client.close();
    }
    await this.tokenWrite;
    if (!(await this.paired())) {
      throw new TelevisionError(`The television at ${this.host} did not issue a pairing token. Accept the prompt on the screen and try again.`, "not_paired");
    }
  }

  /** Identity from the same unauthenticated read, so probing needs no pairing. */
  async identify(): Promise<DeviceIdentity> {
    const info = await this.deviceInfo();
    if (!info.frameTvSupport) {
      throw new TelevisionError(`The television at ${this.host} is not a Frame; it does not offer art mode`, "protocol");
    }
    return this.lastIdentity ?? {};
  }

  /** What the set has already said about itself; absent until something has read it. */
  identity(): DeviceIdentity | undefined {
    return this.lastIdentity;
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
    this.connecting = undefined;
  }

  /** Forget the pairing token, so the next control asks the set for a new one. */
  async unpair(): Promise<void> {
    await this.close();
    await this.tokenStore.clear(this.id);
  }

  private async read(): Promise<{ power: "on" | "standby" }> {
    const info = await this.deviceInfo();
    if (!info.powerState) throw new TelevisionError("Television did not report a power state", "protocol");
    return { power: info.powerState };
  }

  /** Art mode, or undefined when the set will not say — never a guess. */
  private async readArtMode(): Promise<"on" | "off" | undefined> {
    try {
      const payload = await this.withClient(async (client) => await client.artRequest("get_artmode_status"));
      return payload.value === "on" || payload.value === "off" ? payload.value : undefined;
    } catch (error) {
      // A Frame that will not answer the art channel is still a working
      // television; the set's power state has already been read.
      if (error instanceof SamsungError || error instanceof TelevisionError) return undefined;
      throw error;
    }
  }

  private async deviceInfo() {
    this.rest ??= new SamsungTizenClient(this.clientOptions);
    let info;
    try {
      info = await this.rest.deviceInfo();
    } catch (error) {
      throw asTelevisionError(error, this.host);
    }
    // Every read carries the set's identity, so one is never asked for
    // separately. `modelName` is what is printed on the set (QN55LS03DAFXZA);
    // `model` is the internal platform name (24_PONTUSM_FTV) and only stands
    // in when a firmware omits the first.
    const model = info.modelName ?? info.model;
    this.lastIdentity = {
      ...(model ? { model } : {}),
      ...(info.firmwareVersion ? { firmwareVersion: info.firmwareVersion } : {}),
    };
    return info;
  }

  private async key(key: string): Promise<void> {
    await this.withClient(async (client) => await client.sendKey(key));
  }

  private async withClient<T>(run: (client: SamsungTizenClient) => Promise<T>): Promise<T> {
    const client = await this.connect();
    try {
      return await run(client);
    } catch (error) {
      // A refused or dropped channel is worth one clean reconnect: the set
      // closes an idle socket itself, and the token in hand still works.
      if (error instanceof SamsungError && (error.code === "unreachable" || error.code === "timeout")) {
        await this.close();
        const retry = await this.connect();
        try {
          return await run(retry);
        } catch (retryError) {
          throw asTelevisionError(retryError, this.host);
        }
      }
      throw asTelevisionError(error, this.host);
    }
  }

  private async connect(): Promise<SamsungTizenClient> {
    if (this.client) return this.client;
    this.connecting ??= this.build().finally(() => {
      this.connecting = undefined;
    });
    return await this.connecting;
  }

  private async build(): Promise<SamsungTizenClient> {
    const token = await this.tokenStore.load(this.id);
    const client = new SamsungTizenClient({
      ...this.clientOptions,
      ...(token ? { token } : {}),
      onToken: (issued) => {
        // Persisting is what keeps the set from prompting again; a failure to
        // write must not fail the control the person is waiting on, so the
        // write is chained rather than awaited. `pair()` awaits the chain.
        this.tokenWrite = this.tokenWrite.then(async () => {
          await this.tokenStore.save(this.id, issued);
        }).catch(() => undefined);
      },
    });
    this.client = client;
    return client;
  }
}

function asTelevisionError(error: unknown, host: string): TelevisionError {
  if (error instanceof TelevisionError) return error;
  if (error instanceof SamsungError) {
    switch (error.code) {
      case "unauthorized":
        return new TelevisionError(`The television at ${host} refused HomeTruth. Accept the prompt on its screen and try again.`, "not_paired");
      case "timeout":
        // A set that takes the socket and then says nothing is showing its
        // pairing prompt and waiting for a person: it sends no frame at all
        // until someone answers. Silence here means unanswered, not broken.
        return new TelevisionError(`The television at ${host} did not answer. If it is showing a prompt, accept it; otherwise check that it is on.`, "not_paired");
      case "unreachable":
        return new TelevisionError(error.message, "unreachable");
      default:
        return new TelevisionError(error.message, "protocol");
    }
  }
  return new TelevisionError(error instanceof Error ? error.message : String(error), "protocol");
}

export const SAMSUNG_FRAME_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/samsung-frame/config",
  title: "Samsung Frame config",
  type: "object",
  additionalProperties: false,
  properties: {
    host: lanHostSchema,
    /** The name the set shows in its pairing prompt and its connected-device list. */
    clientName: { type: "string", minLength: 1, maxLength: 60 },
    timeoutMs: { type: "integer", minimum: 1000, maximum: 30000 },
  },
  required: ["host"],
} as const;
export type SamsungFrameConfig = FromSchema<typeof SAMSUNG_FRAME_CONFIG_SCHEMA>;

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SamsungFrame extends CapabilityMethods<{ television: SamsungFrameTelevision }> {}

export class SamsungFrame extends Device<SamsungFrameConfig> {
  readonly model = SAMSUNG_FRAME;
  readonly capabilities;
  readonly television: SamsungFrameTelevision;

  constructor(instance: DeviceInstance, config: SamsungFrameConfig, options: { tokenStore?: SamsungTokenStore; socketFactory?: SocketFactory; fetch?: SamsungFetch } = {}) {
    super(instance.id, instance.name, config);
    this.television = new SamsungFrameTelevision({
      id: instance.id,
      host: config.host,
      ...(config.clientName !== undefined ? { name: config.clientName } : {}),
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      ...(options.tokenStore ? { tokenStore: options.tokenStore } : {}),
      ...(options.socketFactory ? { socketFactory: options.socketFactory } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.capabilities = this.expose({ television: this.television });
  }

  override async probe(): Promise<DeviceIdentity> {
    return await this.television.identify();
  }

  /** The model printed on the set, once anything has read it; the product name until then. */
  protected override identity(): DeviceIdentity | undefined {
    return this.television.identity();
  }

  override async close(): Promise<void> {
    await this.television.close();
  }
}

export const SAMSUNG_FRAME: DeviceModel<SamsungFrameConfig> = {
  id: "samsung-frame",
  title: "Samsung The Frame",
  manufacturer: "Samsung",
  product: "The Frame",
  connectionTypes: ["direct-local"],
  capabilities: ["television"],
  configSchema: SAMSUNG_FRAME_CONFIG_SCHEMA,
  objectSchemaId: samsungFrameSchema.$id,
  icon: "🖼️",
  create(instance: DeviceInstance, config: SamsungFrameConfig, _services: SiteServices, _secrets: SecretsBag): SamsungFrame {
    return new SamsungFrame(instance, config);
  },
};
