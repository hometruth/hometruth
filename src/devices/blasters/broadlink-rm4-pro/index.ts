import type { FromSchema } from "json-schema-to-ts";
import { isSafeCameraUri } from "../../../camera-media";
import {
  InfraredBlaster,
  IrRfBlasterError,
  RadioFrequencyBlaster,
  type LearnRequest,
  type LearnedSignal,
  type SendOptions,
  type SignalChannel,
  type SignalCode,
  type SignalTransmitter,
} from "../../../models/blaster";
import { Device, lanHostSchema, type DeviceIdentity, type DeviceInstance, type DeviceModel, type SecretsBag, type SiteServices } from "../../../models/device";
import { BroadlinkClient, BroadlinkError, MAX_PACKET_REPEATS, describeSignalPacket, withPacketRepeats } from "../../../protocols/broadlink/protocol";
import { irRfBlasterDeviceSchema } from "../../../schemas";

const LEARN_POLL_INTERVAL_MS = 1_000;
/** Assumed frame length when a packet's pulses cannot be read, so a hold still repeats sensibly. */
const FALLBACK_FRAME_MS = 100;

export interface BroadlinkBlasterOptions {
  id: string;
  /** LAN IP address or `.local` hostname of the blaster. Public hosts are rejected. */
  host: string;
  devType?: number;
  timeoutMs?: number;
  /** Overrides the constructed BroadlinkClient; tests only. */
  client?: BroadlinkClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapProtocolError(host: string, error: unknown): IrRfBlasterError {
  if (error instanceof BroadlinkError) {
    const code = error.code === "not_authenticated" ? "not_authenticated"
      : error.code === "timeout" ? "unreachable"
      : error.code;
    return new IrRfBlasterError(error.message, code);
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new IrRfBlasterError(`Broadlink device at ${host} failed: ${detail}`, "protocol");
}

/**
 * An IR/RF blaster backed by a Broadlink RM-series device (RM Mini, RM Pro,
 * RM4) using its local UDP protocol. No cloud account is involved; codes are
 * exchanged as base64-encoded Broadlink signal packets.
 */
export class BroadlinkBlaster implements SignalTransmitter {
  readonly id: string;
  readonly host: string;
  private readonly client: BroadlinkClient;
  private authenticated = false;

  constructor(options: BroadlinkBlasterOptions) {
    this.id = options.id;
    const host = options.host.trim();
    if (!/^[A-Za-z0-9.-]+$/u.test(host) || !isSafeCameraUri(`http://${host}/`)) {
      throw new IrRfBlasterError("Broadlink blaster host must be a private LAN address", "invalid_host");
    }
    this.host = host;
    this.client = options.client ?? new BroadlinkClient({
      host,
      ...(options.devType !== undefined ? { devType: options.devType } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  private async ensureAuthenticated(): Promise<void> {
    if (this.authenticated) return;
    try {
      await this.client.authenticate();
      this.authenticated = true;
    } catch (error) {
      throw mapProtocolError(this.host, error);
    }
  }

  async probe(): Promise<void> {
    // A cached authentication flag is not evidence that the blaster is still there.
    this.authenticated = false;
    await this.ensureAuthenticated();
  }

  /**
   * Both channels transmit the same Broadlink packet; the code itself carries the carrier.
   * A `durationMs` hold is honoured through the packet's own repeat byte, which keeps the
   * device transmitting back-to-back frames; holds longer than 256 frames are sent as
   * consecutive packets timed to start as the previous one finishes.
   */
  async send(_channel: SignalChannel, code: SignalCode, options: SendOptions = {}): Promise<void> {
    await this.ensureAuthenticated();
    let packet: Buffer;
    try {
      packet = Buffer.from(code, "base64");
    } catch {
      throw new IrRfBlasterError("The signal code is not valid base64", "protocol");
    }
    if (packet.length === 0) throw new IrRfBlasterError("The signal code is empty", "protocol");
    const durationMs = options.durationMs ?? 0;
    if (durationMs <= 0) {
      await this.protocol(() => this.client.sendCode(packet));
      return;
    }
    const shape = describeSignalPacket(packet);
    const frameMs = shape && shape.frameMs > 0 ? shape.frameMs : FALLBACK_FRAME_MS;
    const learnedFrames = (shape?.repeats ?? 0) + 1;
    let framesLeft = Math.max(learnedFrames, Math.ceil(durationMs / frameMs));
    while (framesLeft > 0) {
      const frames = Math.min(framesLeft, MAX_PACKET_REPEATS + 1);
      await this.protocol(() => this.client.sendCode(withPacketRepeats(packet, frames - 1)));
      framesLeft -= frames;
      if (framesLeft > 0) await sleep(frames * frameMs);
    }
  }

  async learn(request: LearnRequest): Promise<LearnedSignal> {
    await this.ensureAuthenticated();
    const timeoutMs = request.timeoutMs ?? 30_000;
    if (request.channel === "infrared") {
      await this.protocol(() => this.client.enterLearning());
      return { code: await this.awaitCapture(timeoutMs) };
    }
    const frequencyHz = request.frequencyHz ?? await this.detectCarrier(timeoutMs);
    await this.protocol(() => this.client.findRfPacket(frequencyHz));
    return { code: await this.awaitCapture(timeoutMs), frequencyHz };
  }

  private async protocol<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw mapProtocolError(this.host, error);
    }
  }

  private async poll<T>(read: () => Promise<T | undefined>, timeoutMs: number, timedOut: () => IrRfBlasterError): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(LEARN_POLL_INTERVAL_MS);
      const value = await this.protocol(read);
      if (value !== undefined) return value;
    }
    throw timedOut();
  }

  /** Sweep for the carrier of a button the user is holding down. */
  private async detectCarrier(timeoutMs: number): Promise<number> {
    await this.protocol(() => this.client.sweepFrequency());
    try {
      return await this.poll(
        () => this.client.checkFrequency(),
        timeoutMs,
        () => new IrRfBlasterError(`No RF carrier was detected within ${timeoutMs}ms; hold the remote button while detecting`, "learn_timeout"),
      );
    } catch (error) {
      await this.client.cancelSweepFrequency().catch(() => undefined);
      throw error;
    }
  }

  private async awaitCapture(timeoutMs: number): Promise<SignalCode> {
    const code = await this.poll(
      () => this.client.checkLearnedCode(),
      timeoutMs,
      () => new IrRfBlasterError(`No signal was captured within ${timeoutMs}ms`, "learn_timeout"),
    );
    return code.toString("base64");
  }
}

export const BROADLINK_RM4_PRO_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/broadlink-rm4-pro/config",
  title: "Broadlink RM4 Pro config",
  type: "object",
  additionalProperties: false,
  properties: {
    /** LAN address of the blaster. */
    host: lanHostSchema,
    /** Broadlink device type code, when discovery cannot supply it. */
    devType: { type: "integer", minimum: 0, maximum: 65535 },
    timeoutMs: { type: "integer", minimum: 100, maximum: 60000 },
  },
  required: ["host"],
} as const;

export type BroadlinkRm4ProConfig = FromSchema<typeof BROADLINK_RM4_PRO_CONFIG_SCHEMA>;

/** A Broadlink RM4 Pro: one transmitter offering an infrared and a radio-frequency channel. */
export class BroadlinkRm4Pro extends Device<BroadlinkRm4ProConfig> {
  readonly model = BROADLINK_RM4_PRO;
  readonly capabilities;
  readonly transmitter: SignalTransmitter;

  constructor(instance: DeviceInstance, config: BroadlinkRm4ProConfig, options: { transmitter?: SignalTransmitter } = {}) {
    super(instance.id, instance.name, config);
    this.transmitter = options.transmitter ?? new BroadlinkBlaster({
      id: instance.id,
      host: config.host,
      ...(config.devType !== undefined ? { devType: config.devType } : {}),
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    });
    // Both channels publish `send` and `learn`, so nothing is forwarded by bare name;
    // callers pick the channel: `blaster.capabilities.infraredBlaster.send(…)`.
    this.capabilities = this.expose({
      infraredBlaster: new InfraredBlaster(instance.id, this.transmitter),
      radioFrequencyBlaster: new RadioFrequencyBlaster(instance.id, this.transmitter),
    });
  }

  override async probe(): Promise<DeviceIdentity> {
    await this.transmitter.probe();
    return { model: BROADLINK_RM4_PRO.product };
  }
}

export const BROADLINK_RM4_PRO: DeviceModel<BroadlinkRm4ProConfig> = {
  id: "broadlink-rm4-pro",
  title: "Broadlink RM4 Pro",
  manufacturer: "Broadlink",
  product: "RM4 Pro",
  capabilities: ["infraredBlaster", "radioFrequencyBlaster"],
  connectionTypes: ["direct-local"],
  configSchema: BROADLINK_RM4_PRO_CONFIG_SCHEMA,
  objectSchemaId: irRfBlasterDeviceSchema.$id,
  create(instance: DeviceInstance, config: BroadlinkRm4ProConfig, _services: SiteServices, _secrets: SecretsBag): BroadlinkRm4Pro {
    return new BroadlinkRm4Pro(instance, config);
  },
};
