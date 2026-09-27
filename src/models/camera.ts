import type { CameraMediaSource } from "../camera-media";
import type { Camera as CameraDocument } from "../schemas";
import { describeValidationErrors, validators } from "../validation";
import { Capability, CapabilityError, type Availability, type InvokeOptions } from "./capability";

/** What a camera reports about itself right now; every field but availability is optional. */
export interface CameraState {
  readonly availability: Availability;
  readonly streamAvailable?: boolean;
  readonly snapshotAvailable?: boolean;
  readonly privacyEnabled?: boolean;
  readonly panDegrees?: number;
  readonly tiltDegrees?: number;
  readonly zoomPercent?: number;
  readonly microphoneEnabled?: boolean;
  readonly speakerEnabled?: boolean;
  readonly recording?: boolean;
}

export type PanDirection = "left" | "right";
export type TiltDirection = "up" | "down";

/** A leased movement: the camera moves until the lease ends or `stopMovement` is called. */
export interface MovementLease {
  readonly minLeaseMs: number;
  readonly maxLeaseMs: number;
}

/**
 * Which actions this camera offers and their bounds, exactly as the Camera
 * schema declares them. A product declares what its link supports right now;
 * the browser renders only what is declared.
 */
export interface CameraActions {
  readonly snapshot?: { readonly mediaTypes: readonly string[] };
  readonly pan?: { readonly lease: MovementLease; readonly home?: boolean };
  readonly tilt?: { readonly lease: MovementLease; readonly home?: boolean };
  readonly setPrivacy?: boolean;
}

export const DEFAULT_MOVEMENT_LEASE: MovementLease = { minLeaseMs: 100, maxLeaseMs: 3000 };

function leaseMs(controlId: string, value: unknown, lease: MovementLease): number {
  if (value === undefined || value === null) return lease.maxLeaseMs;
  if (typeof value !== "number" || !Number.isInteger(value) || value < lease.minLeaseMs || value > lease.maxLeaseMs) {
    throw new CapabilityError(`${controlId} takes a lease of ${lease.minLeaseMs}..${lease.maxLeaseMs} ms`, "invalid_value");
  }
  return value;
}

/**
 * The camera capability: live picture, snapshots, movement, privacy. A
 * product implements `state()` and `actions()` and whichever movement or
 * privacy methods it declares; `describe()` and `invoke()` are generic.
 */
/** The generic camera controls; a product may append its own (`override readonly controlIds = [...CAMERA_CONTROL_IDS, …]`). */
export const CAMERA_CONTROL_IDS: readonly string[] = ["pan.left", "pan.right", "pan.home", "tilt.up", "tilt.down", "tilt.home", "stopMovement", "setPrivacy"];

export abstract class Camera extends Capability<CameraDocument> {
  readonly kind = "camera" as const;
  readonly controlIds: readonly string[] = CAMERA_CONTROL_IDS;
  readonly methods = ["state", "actions", "pan", "tilt", "stopMovement", "goHome", "setPrivacy"] as const;

  abstract state(): Promise<CameraState>;

  /** The actions the camera offers right now; only declared actions are invokable. */
  abstract actions(): Promise<CameraActions>;

  /** Move until the lease (ms) ends or `stopMovement()`; only when `actions().pan` is declared. */
  pan?(direction: PanDirection, leaseMs: number): Promise<void>;
  tilt?(direction: TiltDirection, leaseMs: number): Promise<void>;
  stopMovement?(): Promise<void>;
  goHome?(): Promise<void>;
  setPrivacy?(enabled: boolean): Promise<void>;

  /**
   * Where the live stream and still picture come from, for the media bridge
   * that turns RTSP into MJPEG for the browser. Absent when the product
   * serves media some other way (the TKENPRO camera service does).
   */
  mediaSource?(): CameraMediaSource | undefined;

  override async invoke(controlId: string, value?: unknown, _options: InvokeOptions = {}): Promise<unknown> {
    const actions = await this.actions();
    switch (controlId) {
      case "pan.left":
      case "pan.right": {
        if (!actions.pan || !this.pan) return this.unsupported(controlId);
        await this.pan(controlId === "pan.left" ? "left" : "right", leaseMs(controlId, value, actions.pan.lease));
        return undefined;
      }
      case "tilt.up":
      case "tilt.down": {
        if (!actions.tilt || !this.tilt) return this.unsupported(controlId);
        await this.tilt(controlId === "tilt.up" ? "up" : "down", leaseMs(controlId, value, actions.tilt.lease));
        return undefined;
      }
      case "stopMovement":
        if (!this.stopMovement || (!actions.pan && !actions.tilt)) return this.unsupported(controlId);
        await this.stopMovement();
        return undefined;
      case "pan.home":
      case "tilt.home":
        if (!this.goHome || !(actions.pan?.home || actions.tilt?.home)) return this.unsupported(controlId);
        await this.goHome();
        return undefined;
      case "setPrivacy":
        if (!actions.setPrivacy || !this.setPrivacy) return this.unsupported(controlId);
        if (typeof value !== "boolean") throw new CapabilityError("setPrivacy takes true or false", "invalid_value");
        await this.setPrivacy(value);
        return undefined;
      default:
        return this.unknownControl(controlId);
    }
  }

  protected unsupported(controlId: string): never {
    throw new CapabilityError(`This camera does not offer ${controlId} right now`, "not_supported");
  }

  override async describe(): Promise<CameraDocument> {
    const [state, actions] = await Promise.all([this.state(), this.actions()]);
    const movement = (declared: { lease: MovementLease; home?: boolean } | undefined, first: string, second: string) =>
      declared ? { [first]: declared.lease, [second]: declared.lease, ...(declared.home ? { home: {} } : {}) } : undefined;
    const pan = movement(actions.pan, "left", "right");
    const tilt = movement(actions.tilt, "up", "down");
    const candidate: unknown = {
      id: this.id,
      state,
      actions: {
        ...(actions.snapshot ? { snapshot: { mediaTypes: [...actions.snapshot.mediaTypes] } } : {}),
        ...(pan ? { pan } : {}),
        ...(tilt ? { tilt } : {}),
        ...(pan || tilt ? { stopMovement: {} } : {}),
        ...(actions.setPrivacy ? { setPrivacy: {} } : {}),
      },
    };
    if (!validators.camera(candidate)) {
      throw new Error(`Invalid camera document: ${describeValidationErrors(validators.camera.errors)}`);
    }
    return candidate;
  }
}
