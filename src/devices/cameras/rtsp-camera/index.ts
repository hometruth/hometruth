import type { FromSchema } from "json-schema-to-ts";
import { isSafeCameraUri, type CameraMediaSource } from "../../../camera-media";
import { assertCredentialFree } from "../../../config/repository-safety";
import { CapabilityError } from "../../../models/capability";
import { Camera, type CameraActions, type CameraState } from "../../../models/camera";
import { Device, lanHostSchema, type CapabilityMethods, type DeviceIdentity, type DeviceInstance, type DeviceModel, type SecretsBag, type SiteServices } from "../../../models/device";
import { rtspOptions, type RtspProbe } from "../../../protocols/rtsp/probe";
import { cameraSchema } from "../../../schemas";

export const RTSP_CAMERA_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/rtsp-camera/config",
  title: "RTSP camera config",
  type: "object",
  additionalProperties: false,
  properties: {
    host: lanHostSchema,
    port: { type: "integer", minimum: 1, maximum: 65535 },
    path: { type: "string", pattern: "^/[^\\s#]*$", maxLength: 2048 },
    timeoutMs: { type: "integer", minimum: 100, maximum: 30000 },
  },
  required: ["host", "path"],
} as const;

export type RtspCameraConfig = FromSchema<typeof RTSP_CAMERA_CONFIG_SCHEMA>;

export const RTSP_CAMERA_SECRETS_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/rtsp-camera/secrets",
  title: "RTSP camera secrets",
  type: "object",
  additionalProperties: false,
  properties: {
    rtsp: {
      type: "object",
      additionalProperties: false,
      properties: {
        username: { type: "string", minLength: 1, maxLength: 128 },
        password: { type: "string", minLength: 1, maxLength: 256 },
      },
      required: ["username", "password"],
    },
  },
} as const;

export type RtspCameraSecrets = FromSchema<typeof RTSP_CAMERA_SECRETS_SCHEMA>;

export class RtspCameraCapability extends Camera {
  override readonly controlIds: readonly string[] = [];

  constructor(private readonly device: RtspCamera) {
    super("camera");
  }

  override async state(): Promise<CameraState> {
    return this.device.streamState();
  }

  override async actions(): Promise<CameraActions> {
    return { snapshot: { mediaTypes: ["image/jpeg"] } };
  }

  override mediaSource(): CameraMediaSource {
    return this.device.mediaSource();
  }
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface RtspCamera extends CapabilityMethods<{ camera: RtspCameraCapability }> {}

/** A configured RTSP endpoint; no manufacturer, firmware or physical controls are inferred. */
export class RtspCamera extends Device<RtspCameraConfig> {
  readonly model = RTSP_CAMERA;
  readonly capabilities;
  readonly camera: RtspCameraCapability;
  private readonly streamUri: string;
  private readonly probeImpl: RtspProbe;

  constructor(instance: DeviceInstance, config: RtspCameraConfig, private readonly secrets: RtspCameraSecrets = {}, dependencies: { probe?: RtspProbe } = {}) {
    super(instance.id, instance.name, config);
    if (!/^[A-Za-z0-9.-]+$/u.test(config.host) || !isSafeCameraUri(`rtsp://${config.host}/`)) {
      throw new CapabilityError("RTSP camera host must be a private LAN address", "invalid_value");
    }
    const port = config.port ?? 554;
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\/[^\s#]*$/u.test(config.path)) {
      throw new CapabilityError("RTSP camera needs a port from 1 to 65535 and an absolute stream path without whitespace or fragments", "invalid_value");
    }
    this.streamUri = `rtsp://${config.host}:${port}${config.path}`;
    assertCredentialFree(this.streamUri, "RTSP camera stream");
    this.probeImpl = dependencies.probe ?? rtspOptions;
    this.camera = new RtspCameraCapability(this);
    this.capabilities = this.expose({ camera: this.camera });
  }

  mediaSource(): CameraMediaSource {
    return { streamUri: this.streamUri, ...this.secrets.rtsp };
  }

  private async rtspProbe() {
    return this.probeImpl({
      host: this.config.host,
      port: this.config.port ?? 554,
      path: this.config.path,
      timeoutMs: this.config.timeoutMs ?? 3000,
    });
  }

  /** OPTIONS checks reachability; decoding and authentication are checked when media is opened. */
  async streamState(): Promise<CameraState> {
    try {
      const answer = await this.rtspProbe();
      const available = (answer.statusCode >= 200 && answer.statusCode < 300)
        || (answer.statusCode === 401 && this.secrets.rtsp !== undefined);
      return { availability: available ? "online" : "degraded", streamAvailable: available, snapshotAvailable: available };
    } catch {
      return { availability: "offline", streamAvailable: false, snapshotAvailable: false };
    }
  }

  override async probe(): Promise<DeviceIdentity> {
    await this.rtspProbe();
    // RTSP reachability provides no reliable hardware identity.
    return {};
  }
}

export const RTSP_CAMERA: DeviceModel<RtspCameraConfig> = {
  id: "rtsp-camera",
  title: "RTSP camera",
  manufacturer: "Generic",
  product: "RTSP camera",
  capabilities: ["camera"],
  connectionTypes: ["direct-local"],
  configSchema: RTSP_CAMERA_CONFIG_SCHEMA,
  secretsSchema: RTSP_CAMERA_SECRETS_SCHEMA,
  objectSchemaId: cameraSchema.$id,
  create(instance: DeviceInstance, config: RtspCameraConfig, _services: SiteServices, secrets: SecretsBag): RtspCamera {
    return new RtspCamera(instance, config, secrets as RtspCameraSecrets);
  },
};
