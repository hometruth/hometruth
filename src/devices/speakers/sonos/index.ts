/**
 * A Sonos speaker as a `Speaker` capability, backed by its local UPnP/SOAP
 * control API (`../../../protocols/sonos/soap-client.ts`) — no Sonos account
 * or cloud involved. Every speaker in the household is its own independent
 * device in config; grouping is a runtime operation (`joinGroup`/
 * `leaveGroup`), not something config needs to describe.
 */
import type { FromSchema } from "json-schema-to-ts";
import { Device, lanHostSchema, type CapabilityMethods, type DeviceIdentity, type DeviceInstance, type DeviceModel, type SecretsBag, type SiteServices } from "../../../models/device";
import { Speaker, SpeakerError, type SpeakerState } from "../../../models/speaker";
import { speakerSchema } from "../../../schemas";
import { SonosSoapClient, type SonosFetch } from "../../../protocols/sonos/soap-client";
import type { SonosMediaService } from "../../../vendors/sonos/site-service";
import { registerSayClip, type SaySynthesizer } from "./say";

declare module "../../../models/device" {
  interface SiteServices {
    /** Absent means `say()`/relative `playUri()` will throw when actually invoked; construction still succeeds. */
    sonosMedia?: SonosMediaService;
  }
}

export interface SonosSpeakerOptions {
  id: string;
  host: string;
  port?: number;
  timeoutMs?: number;
  fetch?: SonosFetch;
  /** Absolute `http://<lan-ip>:<port>` this server is reachable at from this speaker; absent when no `sonosMedia` service is configured. */
  localMediaBaseUrl?: () => string;
  /** Overrides the default macOS-`say`-based TTS for `say()`; narrow enough to fake in tests. */
  synthesizeSayClip?: SaySynthesizer;
}

/** UPnP's `H:MM:SS.mmm` duration format, e.g. 0.55 -> "0:00:00.550". */
function upnpDuration(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Raw (unescaped) DIDL-Lite metadata XML — the caller (`SonosSoapClient`)
 * escapes this itself when embedding it into `<CurrentURIMetaData>`, so this
 * must NOT pre-escape its own angle brackets; doing so double-escapes the
 * whole document into unparseable text, which Sonos then silently ignores.
 *
 * A `<res>` element naming the resource's format and duration is required
 * for a short clip: without it Sonos has to determine playability itself,
 * and can silently fail to do so for a very short WAV (observed: a
 * sub-second clip never transitions past "transitioning" with no `<res>`
 * hint, while the same clip with a duration set plays immediately).
 */
export function didlLiteMetadata(title: string, options?: { durationSeconds?: number }): string {
  const escapedTitle = escapeXmlText(title);
  const res = options?.durationSeconds !== undefined
    ? `<res protocolInfo="http-get:*:audio/wav:*" duration="${upnpDuration(options.durationSeconds)}"></res>`
    : "";
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="1" parentID="0" restricted="1"><dc:title>${escapedTitle}</dc:title><upnp:class>object.item.audioItem</upnp:class>${res}</item></DIDL-Lite>`;
}

/** One Sonos player, controlled entirely over its own local network API. */
export class SonosSpeaker extends Speaker {
  readonly host: string;
  private readonly soap: SonosSoapClient;
  private readonly localMediaBaseUrl: (() => string) | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly fetchImpl: SonosFetch | undefined;
  private readonly synthesizeSayClip: SaySynthesizer | undefined;

  constructor(options: SonosSpeakerOptions) {
    super(options.id);
    this.host = options.host.trim();
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetch;
    this.soap = new SonosSoapClient({
      host: options.host,
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.localMediaBaseUrl = options.localMediaBaseUrl;
    this.synthesizeSayClip = options.synthesizeSayClip;
  }

  override supportsSay(): boolean {
    return true;
  }

  async play(): Promise<void> {
    await this.soap.play();
  }

  async pause(): Promise<void> {
    await this.soap.pause();
  }

  async stop(): Promise<void> {
    await this.soap.stop();
  }

  async setVolume(percent: number): Promise<void> {
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new SpeakerError("setVolume takes a number from 0 to 100", "protocol");
    }
    await this.soap.setVolume(percent);
  }

  async setMute(muted: boolean): Promise<void> {
    await this.soap.setMute(muted);
  }

  async playUri(uri: string, options?: { title?: string }): Promise<void> {
    await this.soap.setAvTransportUri(uri, options?.title ? didlLiteMetadata(options.title) : "");
    await this.soap.play();
  }

  override async say(text: string, options?: { volumePercent?: number }): Promise<void> {
    if (!this.localMediaBaseUrl) {
      throw new SpeakerError("No local media base URL is configured for say(); see sonosMedia in SiteServices", "protocol");
    }
    const clip = this.synthesizeSayClip ? await registerSayClip(text, this.synthesizeSayClip) : await registerSayClip(text);
    const url = `${this.localMediaBaseUrl()}${clip.path}`;
    if (options?.volumePercent !== undefined) await this.setVolume(options.volumePercent);
    // Declares the resource's duration explicitly (see didlLiteMetadata):
    // without it Sonos can silently fail to start a very short clip.
    await this.soap.setAvTransportUri(url, didlLiteMetadata("HomeTruth", { durationSeconds: clip.durationSeconds }));
    await this.soap.play();
  }

  async joinGroup(coordinatorHost: string): Promise<void> {
    const coordinator = new SonosSoapClient({
      host: coordinatorHost,
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });
    const uuid = await coordinator.getSpeakerUuid();
    await this.soap.setAvTransportUri(`x-rincon:${uuid}`);
    await this.soap.play();
  }

  async leaveGroup(): Promise<void> {
    await this.soap.becomeCoordinatorOfStandaloneGroup();
  }

  async getState(): Promise<SpeakerState> {
    // GetZoneGroupState/getSpeakerUuid and RenderingControl (volume/mute)
    // succeed on every member, coordinator or not — only AVTransport
    // (transport/track info) requires being the coordinator, and 500s on a
    // bonded satellite. Reading topology first lets a satellite report a
    // real, non-throwing state (volume/mute/group) instead of going
    // "offline" just because it isn't the one answering playback calls.
    const [groups, ownUuid, volumePercent, muted] = await Promise.all([
      this.soap.getZoneGroupState(),
      this.soap.getSpeakerUuid(),
      this.soap.getVolume(),
      this.soap.getMute(),
    ]);

    const ownGroup = groups.find((group) => group.members.some((member) => member.uuid === ownUuid));
    const isCoordinator = ownGroup ? ownGroup.coordinatorUuid === ownUuid : true;
    const group = ownGroup
      ? {
        coordinatorHost: ownGroup.members.find((member) => member.uuid === ownGroup.coordinatorUuid)?.host ?? this.host,
        isCoordinator,
        memberHosts: ownGroup.members.map((member) => member.host).filter((host): host is string => host !== undefined),
      }
      : { coordinatorHost: this.host, isCoordinator: true, memberHosts: [this.host] };

    if (!isCoordinator) {
      return { playback: "unknown", volumePercent, muted, group };
    }

    const [transport, position] = await Promise.all([this.soap.getTransportInfo(), this.soap.getPositionInfo()]);
    const playback = playbackStateFrom(transport.state);
    const track = position.uri
      ? { uri: position.uri, ...trackTiming(position.duration, position.relTime) }
      : undefined;

    return {
      playback,
      volumePercent,
      muted,
      ...(track ? { track } : {}),
      group,
    };
  }
}

function playbackStateFrom(transportState: string): SpeakerState["playback"] {
  switch (transportState.toUpperCase()) {
    case "PLAYING": return "playing";
    case "PAUSED_PLAYBACK": return "paused";
    case "STOPPED": return "stopped";
    case "TRANSITIONING": return "transitioning";
    default: return "unknown";
  }
}

function timeToSeconds(value: string): number | undefined {
  const parts = value.split(":").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return undefined;
  const [hours, minutes, seconds] = parts as [number, number, number];
  return hours * 3600 + minutes * 60 + seconds;
}

function trackTiming(duration: string, relTime: string): { durationSeconds?: number; positionSeconds?: number } {
  const durationSeconds = timeToSeconds(duration);
  const positionSeconds = timeToSeconds(relTime);
  return {
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(positionSeconds !== undefined ? { positionSeconds } : {}),
  };
}

export const SONOS_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/sonos/config",
  title: "Sonos speaker config",
  type: "object",
  additionalProperties: false,
  properties: {
    /** LAN address of this one physical speaker (or stereo pair/soundbar unit). */
    host: lanHostSchema,
    /** Local control port. Defaults to 1400. */
    port: { type: "integer", minimum: 1, maximum: 65535 },
    timeoutMs: { type: "integer", minimum: 100, maximum: 60000 },
    /** Groups this speaker with every other Sonos device sharing the same label on the dashboard (e.g. a stereo pair or home theater set), shown as one card. Absent means it stands alone. */
    group: { type: "string", minLength: 1, maxLength: 200 },
  },
  required: ["host"],
} as const;

export type SonosConfig = FromSchema<typeof SONOS_CONFIG_SCHEMA>;

/** `player.play()`, `player.setVolume()`… forwarded from the speaker. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SonosDevice extends CapabilityMethods<{ speaker: SonosSpeaker }> {}

/** A Sonos player: one speaker capability on the LAN, no account. */
export class SonosDevice extends Device<SonosConfig> {
  readonly model = SONOS;
  readonly capabilities;
  readonly player: SonosSpeaker;

  constructor(
    instance: DeviceInstance,
    config: SonosConfig,
    services: SiteServices = {},
    options: { fetch?: SonosFetch; synthesizeSayClip?: SaySynthesizer } = {},
  ) {
    super(instance.id, instance.name, config);
    this.player = new SonosSpeaker({
      id: instance.id,
      host: config.host,
      ...(config.port !== undefined ? { port: config.port } : {}),
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.synthesizeSayClip ? { synthesizeSayClip: options.synthesizeSayClip } : {}),
      ...(services.sonosMedia ? { localMediaBaseUrl: () => services.sonosMedia!.baseUrlFor(config.host) } : {}),
    });
    this.capabilities = this.expose({ speaker: this.player });
  }

  override async probe(): Promise<DeviceIdentity> {
    await this.player.getState();
    return { model: SONOS.product };
  }
}

export const SONOS: DeviceModel<SonosConfig> = {
  id: "sonos",
  title: "Sonos speaker",
  manufacturer: "Sonos",
  product: "Sonos speaker",
  capabilities: ["speaker"],
  connectionTypes: ["direct-local"],
  configSchema: SONOS_CONFIG_SCHEMA,
  objectSchemaId: speakerSchema.$id,
  create(instance: DeviceInstance, config: SonosConfig, services: SiteServices, _secrets: SecretsBag): SonosDevice {
    return new SonosDevice(instance, config, services);
  },
};
