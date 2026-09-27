/**
 * TKENPRO 2K Pet Camera Treat Dispenser (Meari "Pet 3T" firmware).
 *
 * A camera and a treat dispenser in one box. This device composes those two
 * capabilities over the TKENPRO camera service, which owns the link to the
 * camera (local emulator session, ONVIF, or the vendor cloud) and the
 * discovered control descriptors. The product-specific behaviour the camera
 * needs beyond its capabilities (reboot wherever it is, re-registration with
 * the local emulator, DNS mode) is reached through the same service.
 */
import type { FromSchema } from "json-schema-to-ts";
import { checkTcpPorts } from "../../../health/checks";
import type { HealthCheck } from "../../../health/model";
import { CapabilityError, type Availability, type InvokeOptions } from "../../../models/capability";
import { Camera, DEFAULT_MOVEMENT_LEASE, type CameraActions, type CameraState, type PanDirection, type TiltDirection } from "../../../models/camera";
import { TreatDispenser, type DispenseBounds, type TreatDispenserState } from "../../../models/treat-dispenser";
import {
  Device,
  lanHostSchema,
  type CapabilityMethods,
  type DeviceIdentity,
  type DeviceInstance,
  type DeviceLocation,
  type DeviceModel,
  type SecretsBag,
  type SiteServices,
} from "../../../models/device";
import { petTreatDispenserCameraSchema, type CameraControlRequest, type CameraPtzRequest } from "../../../schemas";
import { MEARI_ALARM_UPLOAD_HOSTNAMES } from "../../../vendors/tkenpro/alarm-upload";
import { TkenproMotionSensor, type TkenproAlarmSource } from "./motion";
import { EVENT_TYPES } from "../../../models/event-types";
import { decodeAlarmThumbnail } from "../../../protocols/tkenpro/alarm-image";
import type { CameraCapabilityDescriptor, CameraDashboardModel, CameraDeviceView, CameraEventLogView, CameraNetworkStatusView } from "../../../ui/dashboard";

/**
 * What the camera needs from the TKENPRO camera service: the discovered
 * state, the one write path, and the reboot-anywhere flow.
 */
export interface TkenproCameraLink {
  state(): CameraDashboardModel;
  /** This camera's own network/isolation view by its LAN address, when the site isolates per device. */
  networkStatusFor?(host: string): CameraNetworkStatusView | undefined;
  /** Hands the camera service this camera's own ONVIF/local credentials. */
  registerHostCredentials?(host: string, credentials: { readonly username: string; readonly password: string }): void;
  control(input: CameraControlRequest): Promise<unknown>;
  ptz(input: CameraPtzRequest): Promise<unknown>;
  rebootCamera(options: { readonly host: string }): Promise<unknown>;
}

/** The vendor services every TKENPRO camera at this site shares. */
export interface TkenproServices {
  readonly cameraService: TkenproCameraLink;
  /** The alarm-upload interceptor (motion while isolated); absent when the site runs no isolation listeners. */
  readonly alarms?: TkenproAlarmSource;
  /** The local cloud emulator, which records this camera's events; its log is the camera page's Events tab. */
  readonly emulator?: { readonly id: string; readonly title: string };
}

declare module "../../../models/device" {
  interface SiteServices {
    tkenpro?: TkenproServices;
  }
}

/** Vendor hostnames handled during isolation: local control and alarm listeners, plus a relayed vendor HTTPS API. See docs/NETWORK_ISOLATION.md for the remaining cloud dependency. */
export const TKENPRO_CLOUD_HOSTNAMES: readonly string[] = ["usce.mearicloud.com", ...MEARI_ALARM_UPLOAD_HOSTNAMES, "apis-us-west.cloudedge360.com"];

export const TKENPRO_2K_PET_CAMERA_TREAT_DISPENSER_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/tkenpro-2k-pet-camera-treat-dispenser/config",
  title: "TKENPRO 2K Pet Camera Treat Dispenser config",
  type: "object",
  additionalProperties: false,
  properties: {
    /** The camera's LAN address; give it a DHCP reservation. */
    host: lanHostSchema,
    /** The printed serial (also the cloud's device name); lets the cloud be asked where the camera went. */
    serialNumber: { type: "string", pattern: "^[0-9]{6,}$", maxLength: 32 },
  },
  required: ["host"],
} as const;

export type TkenproPet3TConfig = FromSchema<typeof TKENPRO_2K_PET_CAMERA_TREAT_DISPENSER_CONFIG_SCHEMA>;

export const TKENPRO_2K_PET_CAMERA_TREAT_DISPENSER_SECRETS_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/tkenpro-2k-pet-camera-treat-dispenser/secrets",
  title: "TKENPRO 2K Pet Camera Treat Dispenser secrets",
  type: "object",
  additionalProperties: false,
  properties: {
    /**
     * The camera's 32-hex-character picture key, which it XORs over the first
     * kilobyte of every alarm thumbnail it uploads. Without it a saved
     * thumbnail cannot be viewed; see src/protocols/tkenpro/alarm-image.ts.
     */
    pictureKey: { type: "string", pattern: "^[0-9a-f]{32}$" },
    /** The camera's ONVIF login (admin/admin from the factory); also the local peer password. */
    onvif: {
      type: "object",
      additionalProperties: false,
      properties: {
        username: { type: "string", minLength: 1, maxLength: 64 },
        password: { type: "string", minLength: 1, maxLength: 128 },
      },
      required: ["username", "password"],
    },
  },
} as const;

export type TkenproPet3TSecrets = FromSchema<typeof TKENPRO_2K_PET_CAMERA_TREAT_DISPENSER_SECRETS_SCHEMA>;

const EMPTY_DASHBOARD: CameraDashboardModel = { setup: { configured: false, profile: null }, discovery: { status: "idle" }, devices: [], selectedDeviceId: null };

function availabilityOf(view: CameraDeviceView | undefined): Availability {
  switch (view?.status) {
    case "online": return "online";
    case "offline": return "offline";
    case "connecting": return "degraded";
    case "unknown": return "unknown";
    default: return "offline";
  }
}

/** The camera half: the generic Camera over the camera service's discovered view and PTZ. */
export class TkenproCamera extends Camera {
  constructor(private readonly device: TkenproPet3T) {
    super("camera");
  }

  override async state(): Promise<CameraState> {
    const view = this.device.view();
    const privacy = this.device.descriptor("device.privacy")?.value;
    return {
      availability: availabilityOf(view),
      streamAvailable: view?.stream === "available",
      snapshotAvailable: view?.snapshot === "available",
      ...(typeof privacy === "boolean" ? { privacyEnabled: privacy } : {}),
    };
  }

  override async actions(): Promise<CameraActions> {
    const ptz = this.device.descriptor("camera.ptz")?.availability === "available";
    const privacy = this.device.descriptor("device.privacy")?.availability === "available";
    return {
      snapshot: { mediaTypes: ["image/jpeg"] },
      ...(ptz ? { pan: { lease: DEFAULT_MOVEMENT_LEASE }, tilt: { lease: DEFAULT_MOVEMENT_LEASE } } : {}),
      ...(privacy ? { setPrivacy: true } : {}),
    };
  }

  override pan(direction: PanDirection, leaseMs: number): Promise<void> {
    return this.device.ptz("start", direction, leaseMs);
  }

  override tilt(direction: TiltDirection, leaseMs: number): Promise<void> {
    return this.device.ptz("start", direction, leaseMs);
  }

  override stopMovement(): Promise<void> {
    return this.device.ptz("stop");
  }

  override setPrivacy(enabled: boolean): Promise<void> {
    return this.device.control("device.privacy", enabled, true);
  }

  /** The generic controls first; any other discovered non-feeding control (`device.statusLed`, `video.flip`, …) goes straight to the firmware. */
  override async invoke(controlId: string, value?: unknown, options: InvokeOptions = {}): Promise<unknown> {
    try {
      return await super.invoke(controlId, value, options);
    } catch (error) {
      if (!(error instanceof CapabilityError) || error.code !== "unknown_control" || controlId.startsWith("feed.")) throw error;
      await this.device.control(controlId, value, options.confirmed ?? false);
      return undefined;
    }
  }
}

/** The treat half: the generic TreatDispenser over the firmware's feeder controls. */
export class TkenproTreatDispenser extends TreatDispenser {
  constructor(private readonly device: TkenproPet3T) {
    super("treatDispenser");
  }

  override async state(): Promise<TreatDispenserState> {
    // One box: the dispenser is reachable exactly when the camera is.
    return { availability: availabilityOf(this.device.view()) };
  }

  /** One treat per command: the firmware's multi-portion action is not reliable on this hardware. */
  override async bounds(): Promise<DispenseBounds> {
    const portions = this.device.descriptor("feed.portions");
    return {
      minimumPortions: 1,
      maximumPortions: 1,
      step: 1,
      confirmation: portions?.confirmation === "confirm" ? "confirm" : "none",
    };
  }

  override dispense(portions: number): Promise<void> {
    return this.device.control("feed.portions", portions, true);
  }

  /** The generic controls first; the firmware's other feeding controls (`feed.schedule`, `feed.sound`) pass straight through. */
  override async invoke(controlId: string, value?: unknown, options: InvokeOptions = {}): Promise<unknown> {
    try {
      return await super.invoke(controlId, value, options);
    } catch (error) {
      if (!(error instanceof CapabilityError) || error.code !== "unknown_control" || !controlId.startsWith("feed.")) throw error;
      await this.device.control(controlId, value, options.confirmed ?? false);
      return undefined;
    }
  }
}

/** `pet.pan("left", 500)`, `pet.dispense(1)`, `pet.actions()`… forwarded; `state` is on both capabilities, so it stays `pet.camera.state()` / `pet.treatDispenser.state()`. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TkenproPet3T extends CapabilityMethods<{ camera: TkenproCamera; treatDispenser: TkenproTreatDispenser; motionSensor: TkenproMotionSensor }> {}

export class TkenproPet3T extends Device<TkenproPet3TConfig> {
  readonly model = TKENPRO_2K_PET_CAMERA_TREAT_DISPENSER;
  readonly capabilities;
  readonly camera: TkenproCamera;
  readonly treatDispenser: TkenproTreatDispenser;
  readonly motionSensor: TkenproMotionSensor;
  /** This camera's picture key, when the site has one stored; never logged or served. */
  private readonly pictureKey: string | undefined;

  constructor(
    instance: DeviceInstance,
    config: TkenproPet3TConfig,
    private readonly cameraService: TkenproCameraLink | undefined,
    secrets: TkenproPet3TSecrets = {},
    alarms?: TkenproAlarmSource,
    private readonly emulator?: { readonly id: string; readonly title: string },
  ) {
    super(instance.id, instance.name, config);
    this.pictureKey = secrets.pictureKey;
    if (secrets.onvif) cameraService?.registerHostCredentials?.(config.host, secrets.onvif);
    this.camera = new TkenproCamera(this);
    this.treatDispenser = new TkenproTreatDispenser(this);
    this.motionSensor = new TkenproMotionSensor("motion", config.host, alarms, {
      sensitivityLevel: () => {
        const value = this.descriptor("motionSensitivity")?.value;
        return typeof value === "number" ? value : undefined;
      },
      setSensitivityLevel: (level) => this.control("motionSensitivity", level, false),
      cameraAvailability: () => availabilityOf(this.view()),
    });
    this.capabilities = this.expose({ camera: this.camera, treatDispenser: this.treatDispenser, motionSensor: this.motionSensor });
  }

  override async close(): Promise<void> {
    this.motionSensor.close();
  }

  /**
   * The real image behind a saved alarm thumbnail. The camera scrambles the
   * first kilobyte of everything it uploads, so a stored file is what the
   * camera sent, not a viewable picture; this undoes that with the camera's
   * own picture key. Returns the bytes unchanged when there is no key, so a
   * page shows a broken image rather than pretending it has a picture.
   */
  decodeThumbnail(stored: Uint8Array): Uint8Array {
    return (this.pictureKey ? decodeAlarmThumbnail(stored, this.pictureKey) : undefined) ?? stored;
  }

  /** The discovered camera at this address, as the camera service last saw it. Online entries win. */
  view(): CameraDeviceView | undefined {
    const candidates = this.cameraService?.state().devices.filter((view) => view.host === this.config.host) ?? [];
    return candidates.find((view) => view.status === "online")
      ?? [...candidates].sort((left, right) => right.capabilities.length - left.capabilities.length)[0];
  }

  descriptor(controlId: string): CameraCapabilityDescriptor | undefined {
    return this.view()?.capabilities.find((capability) => capability.id === controlId);
  }

  /**
   * The dashboard model for this camera's page: only this camera, under its
   * configured name. A camera not yet reached is shown offline with the
   * discovery controls still available.
   */
  pageModel(): CameraDashboardModel {
    const model = this.cameraService?.state() ?? EMPTY_DASHBOARD;
    const view = this.view();
    const shown: CameraDeviceView = view
      ? { ...view, name: this.name }
      : {
        id: this.id,
        name: this.name,
        host: this.config.host,
        status: "offline",
        stream: "unknown",
        snapshot: "unknown",
        capabilities: [{
          id: "local.discovery",
          category: "advanced",
          label: "Local network discovery",
          description: `Defined in devices.yml at ${this.config.host}. Discover locally to connect.`,
          kind: "status",
          availability: "unavailable",
          value: `Not reached at ${this.config.host}`,
          readOnly: true,
        }],
      };
    const network = this.cameraService?.networkStatusFor?.(this.config.host) ?? model.network;
    // The Events tab reads this camera's own slice of the emulator's log.
    const eventLog: CameraEventLogView | undefined = this.emulator
      ? { serviceId: this.emulator.id, serviceTitle: this.emulator.title, subject: this.id, types: EVENT_TYPES.map(({ id, label, description, level, view }) => ({ id, label, description, level, view })) }
      : undefined;
    return { ...model, ...(network ? { network } : {}), ...(eventLog ? { eventLog } : {}), devices: [shown], selectedDeviceId: shown.id };
  }

  async control(controlId: string, value: unknown, confirmed: boolean): Promise<void> {
    const { view, service } = this.link();
    await service.control({ deviceId: view.id, capabilityId: controlId, value: value as never, confirmed });
  }

  /** One leased pan/tilt step, or a stop; the service ends the lease on its own. */
  async ptz(action: "start" | "stop", direction?: PanDirection | TiltDirection, leaseMs?: number): Promise<void> {
    const { view, service } = this.link();
    await service.ptz({
      deviceId: view.id,
      action,
      commandId: `${action}-${direction ?? "stop"}-${Date.now()}`,
      ...(direction ? { direction } : {}),
      ...(leaseMs !== undefined ? { leaseMs } : {}),
    });
  }

  private link(): { view: CameraDeviceView; service: TkenproCameraLink } {
    const view = this.view();
    if (!view || !this.cameraService) throw new CapabilityError(`${this.name} has not been reached at ${this.config.host}`, "not_supported");
    return { view, service: this.cameraService };
  }

  protected override identity(): DeviceIdentity | undefined {
    const view = this.view();
    if (!view) return this.config.serialNumber ? { serialNumber: this.config.serialNumber } : undefined;
    return {
      ...(this.config.serialNumber ? { serialNumber: this.config.serialNumber } : /^\d{6,}$/u.test(view.id) ? { serialNumber: view.id } : {}),
      ...(view.model ? { model: view.model } : {}),
      ...(view.firmware ? { firmwareVersion: view.firmware } : {}),
    };
  }

  override async probe(): Promise<DeviceIdentity> {
    const view = this.view();
    if (view?.status !== "online") throw new Error(`${this.name} is not reachable at ${this.config.host}`);
    return this.identity() ?? {};
  }

  override async checkHealth(): Promise<HealthCheck> {
    if (!this.enabled) return this.reportHealth({ status: "disabled", detail: "Disabled in HomeTruth" });
    try {
      await checkTcpPorts(this.config.host, [8000, 554, 8554]);
      return this.reportHealth(this.view()?.status === "online"
        ? { status: "healthy", detail: "Camera local service responds" }
        : { status: "degraded", detail: "Camera responds; the control connection is unavailable" });
    } catch { return this.reportHealth({ status: "unhealthy", detail: "Camera local services are not responding" }); }
  }

  /** Reboot the camera wherever it is (its address, or where the vendor cloud says it went). */
  override async reboot(): Promise<void> {
    if (!this.cameraService) throw new CapabilityError(`${this.name} cannot be rebooted without the camera service`, "not_supported");
    await this.cameraService.rebootCamera({ host: this.config.host });
  }

  override async locate(): Promise<DeviceLocation | undefined> {
    const view = this.view();
    return view?.status === "online" ? { host: this.config.host } : undefined;
  }
}

export const TKENPRO_2K_PET_CAMERA_TREAT_DISPENSER: DeviceModel<TkenproPet3TConfig> = {
  id: "tkenpro-2k-pet-camera-treat-dispenser",
  title: "TKENPRO 2K Pet Camera Treat Dispenser",
  manufacturer: "TKENPRO",
  product: "2K Pet Camera Treat Dispenser",
  capabilities: ["camera", "treatDispenser", "motionSensor"],
  connectionTypes: ["direct-local", "cloud"],
  configSchema: TKENPRO_2K_PET_CAMERA_TREAT_DISPENSER_CONFIG_SCHEMA,
  secretsSchema: TKENPRO_2K_PET_CAMERA_TREAT_DISPENSER_SECRETS_SCHEMA,
  objectSchemaId: petTreatDispenserCameraSchema.$id,
  cloudHostnames: TKENPRO_CLOUD_HOSTNAMES,
  create(instance: DeviceInstance, config: TkenproPet3TConfig, services: SiteServices, secrets: SecretsBag): TkenproPet3T {
    // Without the camera service (a CLI that only needs the config) the camera is simply unreachable.
    return new TkenproPet3T(instance, config, services.tkenpro?.cameraService, secrets as TkenproPet3TSecrets, services.tkenpro?.alarms, services.tkenpro?.emulator);
  },
};
