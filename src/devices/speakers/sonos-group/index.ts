/**
 * A bonded Sonos group (a stereo pair, a home theater set) as one
 * controllable `Speaker`, backed by whichever physical member is currently
 * the group's coordinator. Only the coordinator answers AVTransport/
 * RenderingControl calls; every member (including satellites) answers
 * `GetZoneGroupState`, so this resolves the live coordinator's host on
 * every call rather than assuming a fixed one — the group keeps working
 * correctly even if Sonos re-elects a different coordinator later.
 *
 * Config names any one member's host as the "entry point"; it does not
 * need to be the coordinator, and the individual members are still
 * separate `sonos` devices in their own right (see
 * `../sonos/index.ts`) — this is an additional, independent device that
 * represents the group as a whole.
 */
import type { FromSchema } from "json-schema-to-ts";
import { Device, lanHostSchema, type CapabilityMethods, type DeviceIdentity, type DeviceInstance, type DeviceModel, type SecretsBag, type SiteServices } from "../../../models/device";
import { Speaker, SpeakerError, type SpeakerState } from "../../../models/speaker";
import { speakerSchema } from "../../../schemas";
import { SonosSoapClient, type SonosFetch } from "../../../protocols/sonos/soap-client";
import { didlLiteMetadata } from "../sonos/index";
import { registerSayClip, type SaySynthesizer } from "../sonos/say";

export interface SonosGroupSpeakerOptions {
  id: string;
  /** LAN host of any one member of the group; used only to look up the live coordinator. */
  host: string;
  port?: number;
  timeoutMs?: number;
  fetch?: SonosFetch;
  localMediaBaseUrl?: () => string;
  synthesizeSayClip?: SaySynthesizer;
}

/** One Sonos bonded group, controlled by resolving and delegating to whichever member is currently the coordinator. */
export class SonosGroupSpeaker extends Speaker {
  readonly host: string;
  private readonly port: number | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly fetchImpl: SonosFetch | undefined;
  private readonly localMediaBaseUrl: (() => string) | undefined;
  private readonly synthesizeSayClip: SaySynthesizer | undefined;
  private readonly entryPoint: SonosSoapClient;

  constructor(options: SonosGroupSpeakerOptions) {
    super(options.id);
    this.host = options.host.trim();
    this.port = options.port;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetch;
    this.localMediaBaseUrl = options.localMediaBaseUrl;
    this.synthesizeSayClip = options.synthesizeSayClip;
    this.entryPoint = this.clientFor(this.host);
  }

  override supportsSay(): boolean {
    return true;
  }

  private clientFor(host: string): SonosSoapClient {
    return new SonosSoapClient({
      host,
      ...(this.port !== undefined ? { port: this.port } : {}),
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });
  }

  /** The coordinator's own soap client, resolved fresh on every call — never cached, since the coordinator can change. */
  private async resolveCoordinator(): Promise<SonosSoapClient> {
    const groups = await this.entryPoint.getZoneGroupState();
    const entryUuid = await this.entryPoint.getSpeakerUuid();
    const ownGroup = groups.find((group) => group.members.some((member) => member.uuid === entryUuid));
    if (!ownGroup) return this.entryPoint;
    const coordinatorHost = ownGroup.members.find((member) => member.uuid === ownGroup.coordinatorUuid)?.host;
    if (!coordinatorHost || coordinatorHost === this.host) return this.entryPoint;
    return this.clientFor(coordinatorHost);
  }

  async play(): Promise<void> {
    await (await this.resolveCoordinator()).play();
  }

  async pause(): Promise<void> {
    await (await this.resolveCoordinator()).pause();
  }

  async stop(): Promise<void> {
    await (await this.resolveCoordinator()).stop();
  }

  async setVolume(percent: number): Promise<void> {
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new SpeakerError("setVolume takes a number from 0 to 100", "protocol");
    }
    await (await this.resolveCoordinator()).setVolume(percent);
  }

  async setMute(muted: boolean): Promise<void> {
    await (await this.resolveCoordinator()).setMute(muted);
  }

  async playUri(uri: string, options?: { title?: string }): Promise<void> {
    const coordinator = await this.resolveCoordinator();
    await coordinator.setAvTransportUri(uri, options?.title ? didlLiteMetadata(options.title) : "");
    await coordinator.play();
  }

  override async say(text: string, options?: { volumePercent?: number }): Promise<void> {
    if (!this.localMediaBaseUrl) {
      throw new SpeakerError("No local media base URL is configured for say(); see sonosMedia in SiteServices", "protocol");
    }
    const clip = this.synthesizeSayClip ? await registerSayClip(text, this.synthesizeSayClip) : await registerSayClip(text);
    const url = `${this.localMediaBaseUrl()}${clip.path}`;
    const coordinator = await this.resolveCoordinator();
    if (options?.volumePercent !== undefined) await coordinator.setVolume(options.volumePercent);
    await coordinator.setAvTransportUri(url, didlLiteMetadata("HomeTruth", { durationSeconds: clip.durationSeconds }));
    await coordinator.play();
  }

  async joinGroup(_coordinatorHost: string): Promise<void> {
    throw new SpeakerError("joinGroup does not apply to a Sonos group device; join/leave individual speakers instead", "protocol");
  }

  async leaveGroup(): Promise<void> {
    throw new SpeakerError("leaveGroup does not apply to a Sonos group device; join/leave individual speakers instead", "protocol");
  }

  async getState(): Promise<SpeakerState> {
    const coordinator = await this.resolveCoordinator();
    const [transport, position, volumePercent, muted, groups, coordinatorUuid] = await Promise.all([
      coordinator.getTransportInfo(),
      coordinator.getPositionInfo(),
      coordinator.getVolume(),
      coordinator.getMute(),
      coordinator.getZoneGroupState(),
      coordinator.getSpeakerUuid(),
    ]);

    const playback = playbackStateFrom(transport.state);
    const track = position.uri
      ? { uri: position.uri, ...trackTiming(position.duration, position.relTime) }
      : undefined;

    const ownGroup = groups.find((group) => group.coordinatorUuid === coordinatorUuid);
    const group = ownGroup
      ? {
        coordinatorHost: ownGroup.members.find((member) => member.uuid === ownGroup.coordinatorUuid)?.host ?? this.host,
        isCoordinator: true,
        memberHosts: ownGroup.members.map((member) => member.host).filter((host): host is string => host !== undefined),
      }
      : { coordinatorHost: this.host, isCoordinator: true, memberHosts: [this.host] };

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

export const SONOS_GROUP_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/sonos-group/config",
  title: "Sonos group config",
  type: "object",
  additionalProperties: false,
  properties: {
    /** LAN address of any one member of the group; the live coordinator is resolved from it, not assumed to be this host. */
    host: lanHostSchema,
    port: { type: "integer", minimum: 1, maximum: 65535 },
    timeoutMs: { type: "integer", minimum: 100, maximum: 60000 },
    /** Matches this group device to its members' `group` label so the group page can show one control card, and this device itself isn't shown as a member. */
    group: { type: "string", minLength: 1, maxLength: 200 },
  },
  required: ["host", "group"],
} as const;

export type SonosGroupConfig = FromSchema<typeof SONOS_GROUP_CONFIG_SCHEMA>;

/** `player.play()`, `player.say()`… forwarded from the group speaker. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SonosGroupDevice extends CapabilityMethods<{ speaker: SonosGroupSpeaker }> {}

/** A Sonos bonded group represented as one controllable device, delegating to its live coordinator. */
export class SonosGroupDevice extends Device<SonosGroupConfig> {
  readonly model = SONOS_GROUP;
  readonly capabilities;
  readonly player: SonosGroupSpeaker;

  constructor(
    instance: DeviceInstance,
    config: SonosGroupConfig,
    services: SiteServices = {},
    options: { fetch?: SonosFetch; synthesizeSayClip?: SaySynthesizer } = {},
  ) {
    super(instance.id, instance.name, config);
    this.player = new SonosGroupSpeaker({
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
    return { model: SONOS_GROUP.product };
  }
}

export const SONOS_GROUP: DeviceModel<SonosGroupConfig> = {
  id: "sonos-group",
  title: "Sonos group",
  manufacturer: "Sonos",
  product: "Sonos group",
  capabilities: ["speaker"],
  connectionTypes: ["composed"],
  configSchema: SONOS_GROUP_CONFIG_SCHEMA,
  objectSchemaId: speakerSchema.$id,
  create(instance: DeviceInstance, config: SonosGroupConfig, services: SiteServices, _secrets: SecretsBag): SonosGroupDevice {
    return new SonosGroupDevice(instance, config, services);
  },
};
