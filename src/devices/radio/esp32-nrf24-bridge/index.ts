import type { FromSchema } from "json-schema-to-ts";
import { Capability, type InvokeOptions } from "../../../models/capability";
import { Device, type CapabilityMethods, type DeviceIdentity, type DeviceInstance, type DeviceModel } from "../../../models/device";
import { radioFrequencyReceiverSchema, type RadioFrequencyReceiver } from "../../../schemas";
import { describeValidationErrors, validators } from "../../../validation";
import {
  Nrf24BridgeClient,
  Nrf24BridgeError,
  type Nrf24ListenRequest,
  type Nrf24ListenerState,
  type Nrf24RadioBridge,
  type Nrf24TransmitRequest,
  type Nrf24TransmitResponse,
} from "../../../protocols/nrf24-bridge/client";
import { FileNrf24CaptureJournal } from "../../../protocols/nrf24-bridge/capture-journal";

export const ESP32_NRF24_BRIDGE_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/esp32-nrf24-bridge/config",
  title: "ESP32 nRF24 radio bridge config",
  type: "object",
  additionalProperties: false,
  properties: {
    baseUrl: { type: "string", format: "uri", minLength: 1, maxLength: 500 },
    timeoutMs: { type: "integer", minimum: 100, maximum: 60000 },
  },
  required: ["baseUrl"],
} as const;

export type Esp32Nrf24BridgeConfig = FromSchema<typeof ESP32_NRF24_BRIDGE_CONFIG_SCHEMA>;

/** HomeTruth's RF-receiver capability, backed by the narrow bridge interface rather than HTTP directly. */
export class Nrf24ReceiverCapability extends Capability<RadioFrequencyReceiver> {
  readonly kind = "radioFrequencyReceiver" as const;
  readonly controlIds = [] as const;
  readonly methods = [] as const;

  constructor(id: string, private readonly bridge: Nrf24RadioBridge) { super(id); }

  getState(): Promise<Nrf24ListenerState> { return this.bridge.listener(); }
  startListening(request?: Nrf24ListenRequest): Promise<Nrf24ListenerState> { return this.bridge.startListening(request); }
  stopListening(): Promise<Nrf24ListenerState> { return this.bridge.stopListening(); }
  transmit(request: Nrf24TransmitRequest): Promise<Nrf24TransmitResponse> { return this.bridge.transmit(request); }
  captureStatus() { return this.bridge.captureStatus?.(); }
  cachedState() { return this.bridge.cachedListener?.(); }
  quietStatus() { return this.bridge.quietStatus?.(); }
  startQuietCapture(settings: import("../../../protocols/nrf24-bridge/quiet-capture").QuietCaptureSettings) {
    if (!this.bridge.startQuietCapture) throw new Nrf24BridgeError("USB capture is unavailable", "not_supported");
    return this.bridge.startQuietCapture(settings);
  }

  override async invoke(controlId: string, _value?: unknown, _options?: InvokeOptions): Promise<unknown> {
    return this.unknownControl(controlId);
  }

  override async describe(): Promise<RadioFrequencyReceiver> {
    let state: Nrf24ListenerState;
    try { state = await this.getState(); }
    catch (error) {
      const candidate: unknown = {
        id: this.id,
        state: { availability: "offline" },
        channels: [{ id: "nrf24", centerFrequencyHz: 2_440_000_000, modulations: ["gfsk"], formats: ["rpd-channel-activity"] }],
        events: { signalReceived: { includesDecodedPayload: false } },
      };
      if (!validators.radioFrequencyReceiver(candidate)) throw new Error(`Invalid RF receiver document: ${describeValidationErrors(validators.radioFrequencyReceiver.errors)}`);
      return candidate;
    }
    const centerChannel = Math.round((state.config.channelMin + state.config.channelMax) / 2);
    const candidate: unknown = {
      id: this.id,
      state: {
        availability: state.radioPresent ? "online" : "degraded",
        observedAt: new Date().toISOString(),
      },
      channels: [{
        id: "nrf24",
        centerFrequencyHz: (2400 + centerChannel) * 1_000_000,
        bandwidthHz: (state.config.channelMax - state.config.channelMin + 2) * 1_000_000,
        modulations: ["gfsk"],
        formats: ["rpd-channel-activity"],
      }],
      events: { signalReceived: { includesDecodedPayload: false } },
    };
    if (!validators.radioFrequencyReceiver(candidate)) throw new Error(`Invalid RF receiver document: ${describeValidationErrors(validators.radioFrequencyReceiver.errors)}`);
    return candidate;
  }
}

export interface Esp32Nrf24Bridge extends CapabilityMethods<{ radioFrequencyReceiver: Nrf24ReceiverCapability }> {}

/** An ESP32 plus nRF24L01+ radio module implementing the HomeTruth bridge API. */
export class Esp32Nrf24Bridge extends Device<Esp32Nrf24BridgeConfig> {
  readonly model = ESP32_NRF24_BRIDGE;
  readonly capabilities;
  readonly receiver: Nrf24ReceiverCapability;
  readonly bridge: Nrf24RadioBridge;
  private knownIdentity: DeviceIdentity | undefined;

  constructor(instance: DeviceInstance, config: Esp32Nrf24BridgeConfig, options: { bridge?: Nrf24RadioBridge } = {}) {
    super(instance.id, instance.name, config);
    this.bridge = options.bridge ?? new Nrf24BridgeClient({
      baseUrl: config.baseUrl,
      journal: new FileNrf24CaptureJournal(instance.id, config.baseUrl),
      readCacheMs: 900,
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    });
    this.receiver = new Nrf24ReceiverCapability(instance.id, this.bridge);
    this.capabilities = this.expose({ radioFrequencyReceiver: this.receiver });
  }

  protected override identity(): DeviceIdentity | undefined { return this.knownIdentity; }
  override displayHost(): string { return this.config.baseUrl; }

  override async probe(): Promise<DeviceIdentity> {
    const health = await this.bridge.health();
    if (!health.radio.present) throw new Nrf24BridgeError("Bridge is online, but the nRF24 radio was not detected", "protocol");
    this.knownIdentity = { model: health.model, firmwareVersion: health.firmwareVersion };
    return this.knownIdentity;
  }
}

export const ESP32_NRF24_BRIDGE: DeviceModel<Esp32Nrf24BridgeConfig> = {
  id: "esp32-nrf24-bridge",
  title: "ESP32 nRF24 radio bridge",
  manufacturer: "HomeTruth",
  product: "ESP32 nRF24L01+ bridge",
  capabilities: ["radioFrequencyReceiver"],
  connectionTypes: ["direct-local"],
  configSchema: ESP32_NRF24_BRIDGE_CONFIG_SCHEMA,
  objectSchemaId: radioFrequencyReceiverSchema.$id,
  create: (instance, config) => new Esp32Nrf24Bridge(instance, config),
};
