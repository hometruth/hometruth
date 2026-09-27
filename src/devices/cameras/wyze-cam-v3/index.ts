/**
 * Wyze Cam v3 (WYZE_CAKP2JFUS): a fixed 1080p indoor/outdoor camera.
 *
 * Stock firmware only talks TUTK P2P with keys issued by the Wyze cloud, so
 * HomeTruth does not model it. The product is instead a *firmware-flavoured
 * RTSP camera*: the `firmware` config field says which local route is on the
 * camera (Thingino, Wyze's RTSP beta, or wz_mini_hacks) and the profiles in
 * `firmware.ts` turn that into stream, snapshot, and ONVIF addresses. The
 * camera capability is reachable when its RTSP server answers `OPTIONS`;
 * identity and reboot come from ONVIF where the firmware has it (Thingino).
 *
 * Supported routes and setup requirements are documented in docs/WYZE.md.
 */
import type { FromSchema } from "json-schema-to-ts";
import { isSafeCameraUri, type CameraMediaSource } from "../../../camera-media";
import { CapabilityError, type Availability, type InvokeOptions } from "../../../models/capability";
import { CAMERA_CONTROL_IDS, Camera, type CameraActions, type CameraState } from "../../../models/camera";
import { Device, lanHostSchema, type CapabilityMethods, type DeviceIdentity, type DeviceInstance, type DeviceLocation, type DeviceModel, type SecretsBag, type SiteServices } from "../../../models/device";
import { OnvifClient, type OnvifFetch } from "../../../protocols/onvif/client";
import { RtspProbeError, rtspOptions, type RtspProbe } from "../../../protocols/rtsp/probe";
import { ThinginoError, ThinginoWebApi, type ThinginoFetch, type ThinginoHeartbeat } from "../../../protocols/thingino";
import { cameraMotionSensorSchema } from "../../../schemas";
import { WYZE_CAM_V3_CONTROLS, readWyzeCamV3Settings, wyzeCamV3Control } from "./controls";
import {
  WYZE_CAM_V3_FIRMWARE_PROFILES,
  WYZE_CAM_V3_FIRMWARES,
  wyzeCamV3MediaSource,
  wyzeCamV3OnvifUrl,
  type WyzeCamV3Firmware,
} from "./firmware";
import { WyzeCamV3MotionSensor, wyzeCamV3MqttTopic, type WyzeCamV3MqttBroker } from "./motion";

export { WYZE_CAM_V3_FIRMWARE_PROFILES, WYZE_CAM_V3_FIRMWARES, wyzeCamV3MediaSource, type WyzeCamV3Firmware } from "./firmware";
export { WYZE_CAM_V3_CONTROLS, type WyzeCamV3Control } from "./controls";
export { wyzeCamV3MqttTopic, WYZE_CAM_V3_MOTION_PULSE_MS, type WyzeCamV3MqttBroker } from "./motion";

export const WYZE_CAM_V3_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/wyze-cam-v3/config",
  title: "Wyze Cam v3 config",
  type: "object",
  additionalProperties: false,
  properties: {
    /** The camera's LAN address; give it a DHCP reservation. */
    host: lanHostSchema,
    /** Which local firmware route is on the camera. Stock firmware has none. */
    firmware: { enum: [...WYZE_CAM_V3_FIRMWARES] },
    /** Main (1080p) or sub (360p) stream for the live view. */
    stream: { enum: ["main", "sub"] },
    /** Overrides the firmware's RTSP port (wz_mini's `RTSP_PORT`, a re-homed Thingino). */
    rtspPort: { type: "integer", minimum: 1, maximum: 65535 },
    /** RTSP over TLS where the firmware offers it (Wyze beta: port 322, self-signed). */
    secure: { type: "boolean" },
    timeoutMs: { type: "integer", minimum: 100, maximum: 30000 },
  },
  required: ["host", "firmware"],
} as const;

export type WyzeCamV3Config = FromSchema<typeof WYZE_CAM_V3_CONFIG_SCHEMA>;

export const WYZE_CAM_V3_SECRETS_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/wyze-cam-v3/secrets",
  title: "Wyze Cam v3 secrets",
  type: "object",
  additionalProperties: false,
  properties: {
    /**
     * The RTSP login. Thingino: user `thingino` (fixed) and the password set
     * under RTSP/ONVIF Access; the same pair serves ONVIF and the snapshot.
     * Wyze beta: the account created in the RTSP settings. wz_mini:
     * `RTSP_LOGIN`/`RTSP_PASSWORD`. Absent means the firmware's factory login.
     */
    rtsp: {
      type: "object",
      additionalProperties: false,
      properties: {
        username: { type: "string", minLength: 1, maxLength: 64 },
        password: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: ["username", "password"],
    },
    /**
     * The firmware's web API key (Thingino: Settings → Web UI → "API key for
     * automation"). Unlocks the HTTP snapshot and, later, the JSON controls.
     * Without it snapshots are grabbed from the RTSP stream.
     */
    web: {
      type: "object",
      additionalProperties: false,
      properties: {
        apiKey: { type: "string", minLength: 8, maxLength: 256 },
      },
      required: ["apiKey"],
    },
  },
} as const;

export type WyzeCamV3Secrets = FromSchema<typeof WYZE_CAM_V3_SECRETS_SCHEMA>;

export interface WyzeCamV3Dependencies {
  /** The RTSP `OPTIONS` probe; a fake in tests. */
  readonly probe?: RtspProbe;
  /** The fetch ONVIF uses; a fake in tests. */
  readonly fetch?: OnvifFetch;
  /** The fetch the Thingino web API uses; a fake in tests. */
  readonly webFetch?: ThinginoFetch;
  /** The site's MQTT broker for motion; a fake in tests. Absent when the site has none. */
  readonly mqttBroker?: WyzeCamV3MqttBroker;
}

const DEFAULT_TIMEOUT_MS = 3_000;

/** Control ids beyond the generic camera: `readSettings` plus the Thingino switch catalog. */
const WYZE_CAM_V3_CONTROL_IDS: readonly string[] = [...CAMERA_CONTROL_IDS, "readSettings", ...WYZE_CAM_V3_CONTROLS.map((control) => control.id)];

/**
 * The camera capability: a live stream and a still over the firmware's
 * RTSP/HTTP surfaces, plus (Thingino with a web API key) privacy and the
 * night-vision, audio, and motion switches read back from the heartbeat.
 */
export class WyzeCamV3Camera extends Camera {
  override readonly controlIds = WYZE_CAM_V3_CONTROL_IDS;

  constructor(private readonly device: WyzeCamV3) {
    super("camera");
  }

  override async state(): Promise<CameraState> {
    const availability = await this.device.availabilityNow();
    const reachable = availability === "online";
    const heartbeat = reachable ? await this.device.heartbeat() : undefined;
    return {
      availability,
      streamAvailable: reachable,
      snapshotAvailable: reachable,
      ...(heartbeat?.privacy !== undefined ? { privacyEnabled: heartbeat.privacy } : {}),
      ...(heartbeat?.microphone !== undefined ? { microphoneEnabled: heartbeat.microphone } : {}),
      ...(heartbeat?.speaker !== undefined ? { speakerEnabled: heartbeat.speaker } : {}),
      ...(heartbeat?.recordingMain !== undefined || heartbeat?.recordingSub !== undefined
        ? { recording: Boolean(heartbeat.recordingMain || heartbeat.recordingSub) }
        : {}),
    };
  }

  override async actions(): Promise<CameraActions> {
    return {
      snapshot: { mediaTypes: ["image/jpeg"] },
      ...(this.device.webApi ? { setPrivacy: true } : {}),
    };
  }

  /** Privacy is prudynt's own switch; the picture goes dark and recording pauses. */
  override async setPrivacy(enabled: boolean): Promise<void> {
    await this.device.requireWebApi("setPrivacy").setPrivacy(enabled);
  }

  /** Stream and snapshot addresses for the media bridge; credentials stay out of the URIs. */
  override mediaSource(): CameraMediaSource {
    return this.device.mediaSource();
  }

  /** The generic controls first; then `readSettings` and the Thingino switch catalog. */
  override async invoke(controlId: string, value?: unknown, options: InvokeOptions = {}): Promise<unknown> {
    try {
      return await super.invoke(controlId, value, options);
    } catch (error) {
      if (!(error instanceof CapabilityError) || error.code !== "unknown_control") throw error;
    }
    if (controlId === "readSettings") {
      const heartbeat = await this.device.requireWebApi(controlId).heartbeat();
      return readWyzeCamV3Settings(heartbeat);
    }
    const control = wyzeCamV3Control(controlId);
    if (!control) return this.unknownControl(controlId);
    const api = this.device.requireWebApi(controlId);
    if (control.kind === "toggle" && typeof value !== "boolean") {
      throw new CapabilityError(`${controlId} takes true or false`, "invalid_value");
    }
    if (control.kind === "select" && (typeof value !== "string" || !control.values?.includes(value))) {
      throw new CapabilityError(`${controlId} takes one of ${control.values?.join(", ")}`, "invalid_value");
    }
    await control.write(api, value as boolean | string);
    return undefined;
  }
}

/** `cam.state()`, `cam.actions()`, `cam.mediaSource()` forwarded from the camera; `state` stays qualified since both capabilities publish it. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface WyzeCamV3 extends CapabilityMethods<{ camera: WyzeCamV3Camera; motionSensor: WyzeCamV3MotionSensor }> {}

export class WyzeCamV3 extends Device<WyzeCamV3Config> {
  readonly model = WYZE_CAM_V3;
  readonly capabilities;
  readonly camera: WyzeCamV3Camera;
  readonly motionSensor: WyzeCamV3MotionSensor;
  readonly firmware: WyzeCamV3Firmware;
  private readonly rtspProbeImpl: RtspProbe;
  private readonly onvif: OnvifClient | undefined;
  /** Thingino's web API, when the firmware is Thingino and `web.apiKey` is stored. */
  readonly webApi: ThinginoWebApi | undefined;
  private readonly credentials: { readonly username: string; readonly password: string } | undefined;
  private readonly webApiKey: string | undefined;
  private lastIdentity: DeviceIdentity | undefined;

  constructor(instance: DeviceInstance, config: WyzeCamV3Config, secrets: WyzeCamV3Secrets = {}, dependencies: WyzeCamV3Dependencies = {}) {
    super(instance.id, instance.name, config);
    const host = config.host.trim();
    if (!/^[A-Za-z0-9.-]+$/u.test(host) || !isSafeCameraUri(`rtsp://${host}/`)) {
      throw new CapabilityError("Wyze Cam v3 host must be a private LAN address", "invalid_value");
    }
    this.firmware = config.firmware;
    this.rtspProbeImpl = dependencies.probe ?? rtspOptions;
    this.credentials = secrets.rtsp ?? WYZE_CAM_V3_FIRMWARE_PROFILES[config.firmware].defaultRtspCredentials;
    this.webApiKey = secrets.web?.apiKey;
    this.webApi = config.firmware === "thingino" && this.webApiKey
      ? new ThinginoWebApi({ host, apiKey: this.webApiKey, timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS, ...(dependencies.webFetch ? { fetch: dependencies.webFetch } : {}) })
      : undefined;
    const onvifUrl = wyzeCamV3OnvifUrl(host, config.firmware);
    this.onvif = onvifUrl
      ? new OnvifClient(
        {
          deviceServiceUrl: onvifUrl,
          ...(this.credentials ? { username: this.credentials.username, password: this.credentials.password } : {}),
          timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        },
        dependencies.fetch ? { fetch: dependencies.fetch } : {},
      )
      : undefined;
    if (this.onvif) {
      const onvif = this.onvif;
      this.reboot = async () => { await onvif.systemReboot(); };
    }
    this.camera = new WyzeCamV3Camera(this);
    this.motionSensor = new WyzeCamV3MotionSensor("motion", dependencies.mqttBroker, wyzeCamV3MqttTopic(instance.id));
    this.capabilities = this.expose({ camera: this.camera, motionSensor: this.motionSensor });
  }

  override async close(): Promise<void> {
    this.motionSensor.close();
  }

  /** The firmware profile's stream and snapshot addresses for this camera. */
  mediaSource(): CameraMediaSource {
    return wyzeCamV3MediaSource({
      host: this.config.host,
      firmware: this.firmware,
      ...(this.config.stream ? { stream: this.config.stream } : {}),
      ...(this.config.rtspPort !== undefined ? { rtspPort: this.config.rtspPort } : {}),
      ...(this.config.secure !== undefined ? { secure: this.config.secure } : {}),
      ...(this.credentials ? { credentials: this.credentials } : {}),
      ...(this.webApiKey ? { webApiKey: this.webApiKey } : {}),
    });
  }

  requireWebApi(controlId: string): ThinginoWebApi {
    if (this.webApi) return this.webApi;
    throw new CapabilityError(
      this.firmware === "thingino"
        ? `${controlId} needs the Thingino web API key (secrets: devices.${this.id}.web.apiKey)`
        : `${controlId} is only available on Thingino firmware`,
      "not_supported",
    );
  }

  /** The switch snapshot when the web API is available; undefined when it is not or the camera does not answer. */
  async heartbeat(): Promise<ThinginoHeartbeat | undefined> {
    if (!this.webApi) return undefined;
    try {
      return await this.webApi.heartbeat();
    } catch (error) {
      if (error instanceof ThinginoError) return undefined;
      throw error;
    }
  }

  /** One RTSP `OPTIONS` round trip: online when any RTSP answer comes back, offline otherwise. */
  async availabilityNow(): Promise<Availability> {
    try {
      await this.rtspProbe();
      return "online";
    } catch (error) {
      if (error instanceof RtspProbeError) return "offline";
      throw error;
    }
  }

  private async rtspProbe() {
    const stream = new URL(this.mediaSource().streamUri ?? `rtsp://${this.config.host}/`);
    return await this.rtspProbeImpl({
      host: this.config.host,
      port: Number(stream.port) || (stream.protocol === "rtsps:" ? 322 : 554),
      path: stream.pathname,
      timeoutMs: this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  }

  protected override identity(): DeviceIdentity | undefined {
    return this.lastIdentity;
  }

  /**
   * Is the camera there and is it a Wyze Cam v3 on the configured firmware:
   * ONVIF `GetDeviceInformation` where the firmware has ONVIF, otherwise the
   * RTSP server's own `Server` header.
   */
  override async probe(): Promise<DeviceIdentity> {
    if (this.onvif) {
      const information = await this.onvif.getDeviceInformation();
      this.lastIdentity = {
        ...(information.model ? { model: information.model } : {}),
        ...(information.firmwareVersion ? { firmwareVersion: information.firmwareVersion } : {}),
        ...(information.serialNumber ? { serialNumber: information.serialNumber } : {}),
      };
      return this.lastIdentity;
    }
    const answer = await this.rtspProbe();
    this.lastIdentity = { model: answer.server ? `${WYZE_CAM_V3.product} (${answer.server})` : WYZE_CAM_V3.product };
    return this.lastIdentity;
  }

  override async locate(): Promise<DeviceLocation | undefined> {
    return (await this.availabilityNow()) === "online" ? { host: this.config.host } : undefined;
  }
}

export const WYZE_CAM_V3: DeviceModel<WyzeCamV3Config> = {
  id: "wyze-cam-v3",
  title: "Wyze Cam v3",
  manufacturer: "Wyze",
  product: "Cam v3",
  capabilities: ["camera", "motionSensor"],
  connectionTypes: ["direct-local"],
  configSchema: WYZE_CAM_V3_CONFIG_SCHEMA,
  secretsSchema: WYZE_CAM_V3_SECRETS_SCHEMA,
  objectSchemaId: cameraMotionSensorSchema.$id,
  create(instance: DeviceInstance, config: WyzeCamV3Config, services: SiteServices, secrets: SecretsBag): WyzeCamV3 {
    return new WyzeCamV3(instance, config, secrets as WyzeCamV3Secrets, services.mqttBroker ? { mqttBroker: services.mqttBroker } : {});
  },
};
