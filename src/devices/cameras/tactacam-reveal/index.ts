import type { FromSchema } from "json-schema-to-ts";
import { CameraMediaError, type CameraMediaSource } from "../../../camera-media";
import { Camera, type CameraActions, type CameraState } from "../../../models/camera";
import { CapabilityError } from "../../../models/capability";
import { Device, type CapabilityMethods, type DeviceInstance, type DeviceModel, type SecretsBag, type SiteServices } from "../../../models/device";
import { RevealClient, RevealError, type RevealCredentials, type RevealFetch, type RevealPhoto } from "../../../protocols/reveal/client";
import { cameraSchema } from "../../../schemas";
import { revealCredentials } from "../../../vendors/reveal/credentials";
import type { RevealPhotoArchive } from "../../../vendors/reveal/photo-archive";

export const REVEAL_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/tactacam-reveal/config",
  title: "Tactacam REVEAL cloud camera config",
  type: "object", additionalProperties: false,
  properties: {
    cameraId: { type: "string", minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
    /** Minimum interval between cloud feed reads, including failed reads. */
    pollIntervalMs: { type: "integer", minimum: 60_000, maximum: 86_400_000 },
    timeoutMs: { type: "integer", minimum: 1000, maximum: 60_000 },
    archiveMaxPages: { type: "integer", minimum: 1, maximum: 10_000, description: "Cloud pages per import batch (100 photos per page). Continues automatically until all photos are saved. Default 100." },
  },
  required: ["cameraId"],
} as const;
export type RevealConfig = FromSchema<typeof REVEAL_CONFIG_SCHEMA>;

export const REVEAL_SECRETS_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/tactacam-reveal/secrets",
  title: "Tactacam REVEAL account",
  type: "object", additionalProperties: false,
  properties: {
    email: { type: "string", minLength: 1, maxLength: 320 },
    password: { type: "string", minLength: 1, maxLength: 1024 },
  },
} as const;
export type RevealSecrets = FromSchema<typeof REVEAL_SECRETS_SCHEMA>;

export class RevealCamera extends Camera {
  override readonly controlIds = ["latestPhoto"];
  constructor(private readonly device: TactacamReveal) { super("camera"); }

  override async state(): Promise<CameraState> {
    if (!this.device.configured) return { availability: "unknown", streamAvailable: false, snapshotAvailable: false };
    try {
      const photo = await this.device.latestPhoto();
      // Availability describes access to the cloud feed, not a sleeping camera's radio.
      return { availability: "online", streamAvailable: false, snapshotAvailable: Boolean(photo) };
    } catch (error) {
      if (!(error instanceof RevealError)) throw error;
      return { availability: error.code === "authentication" || error.code === "challenge" ? "degraded" : "offline", streamAvailable: false, snapshotAvailable: false };
    }
  }

  override async actions(): Promise<CameraActions> { return { snapshot: { mediaTypes: ["image/jpeg"] } }; }
  override mediaSource(): CameraMediaSource {
    return { captureSnapshot: () => this.device.snapshot(),
      ...(this.device.archive ? { photos: this.device.archive.history(this.device.config.cameraId) } : {}),
    };
  }

  override async invoke(controlId: string): Promise<unknown> {
    if (controlId !== "latestPhoto") return this.unknownControl(controlId);
    try {
      const photo = await this.device.latestPhoto();
      if (!photo) return null;
      const { photoUrl: _privateUrl, ...metadata } = photo;
      return metadata;
    } catch (error) {
      if (error instanceof RevealError) throw new CapabilityError(error.message, "not_supported");
      throw error;
    }
  }
}

export interface TactacamReveal extends CapabilityMethods<{ camera: RevealCamera }> {}

export class TactacamReveal extends Device<RevealConfig> {
  readonly model = TACTACAM_REVEAL;
  readonly capabilities;
  readonly camera: RevealCamera;
  readonly configured: boolean;
  readonly archive: RevealPhotoArchive | undefined;
  private readonly client: RevealClient;
  private readonly now: () => number;
  private nextPollAt = 0;
  private lastPhoto: RevealPhoto | undefined;
  private lastError: RevealError | undefined;
  private polling: Promise<RevealPhoto | undefined> | undefined;
  private image: { id: string; bytes: Uint8Array } | undefined;
  private downloading: Promise<Uint8Array> | undefined;
  private nextDownloadAt = 0;
  private downloadError: CameraMediaError | undefined;

  constructor(instance: DeviceInstance, config: RevealConfig, secrets: RevealSecrets = {}, dependencies: { fetch?: RevealFetch; now?: () => number; archive?: RevealPhotoArchive } = {}) {
    super(instance.id, instance.name, config);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(config.cameraId)) throw new RevealError("Provide a valid REVEAL camera ID", "invalid_value");
    if (config.pollIntervalMs !== undefined && (!Number.isInteger(config.pollIntervalMs) || config.pollIntervalMs < 60_000 || config.pollIntervalMs > 86_400_000)) throw new RevealError("REVEAL pollIntervalMs must be 60000..86400000", "invalid_value");
    const credentials: RevealCredentials = { email: secrets.email ?? "", password: secrets.password ?? "" };
    this.configured = Boolean(credentials.email.trim() && credentials.password);
    this.now = dependencies.now ?? Date.now;
    this.archive = dependencies.archive;
    this.client = new RevealClient(credentials, { ...dependencies, ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}) });
    this.camera = new RevealCamera(this);
    this.capabilities = this.expose({ camera: this.camera });
  }

  async syncPhotos(signal?: AbortSignal): Promise<void> {
    if (!this.archive) return;
    await this.archive.sync(this.config.cameraId, this.client, {
      intervalMs: this.config.pollIntervalMs ?? 300_000,
      ...(this.config.archiveMaxPages ? { maxPages: this.config.archiveMaxPages } : {}),
      ...(signal ? { signal } : {}),
      latest: photo => {
        this.lastPhoto = photo;
        this.lastError = undefined;
        this.nextPollAt = this.now() + (this.config.pollIntervalMs ?? 300_000);
      },
    });
  }

  async latestPhoto(): Promise<RevealPhoto | undefined> {
    if (this.polling) return this.polling;
    if (this.now() < this.nextPollAt) {
      if (this.lastError) throw this.lastError;
      return this.lastPhoto;
    }
    this.polling = (async () => {
      try {
        this.lastPhoto = undefined;
        // Filtered feeds can have empty pages with a continuation token.
        for await (const photo of this.client.photos(this.config.cameraId)) { this.lastPhoto = photo; break; }
        this.lastError = undefined;
        return this.lastPhoto;
      } catch (error) {
        if (error instanceof RevealError) this.lastError = error;
        throw error;
      } finally {
        this.nextPollAt = this.now() + (this.config.pollIntervalMs ?? 300_000);
        this.polling = undefined;
      }
    })();
    return this.polling;
  }

  override async probe() {
    const cameras = await this.client.listCameras();
    if (!cameras.some(camera => camera.cameraId === this.config.cameraId)) throw new RevealError("The configured camera ID was not found in this REVEAL account", "unavailable");
    return { model: this.model.product };
  }

  async snapshot(): Promise<Uint8Array> {
    if (this.downloading) return this.downloading;
    if (this.downloadError && this.now() < this.nextDownloadAt) throw this.downloadError;
    this.downloading = (async () => {
      try {
        const photo = await this.latestPhoto();
        if (!photo) throw new CameraMediaError("No photos have been uploaded to this REVEAL camera feed", "unavailable");
        if (this.image?.id === photo.photoId) return this.image.bytes;
        const bytes = await this.client.downloadPhoto(photo);
        this.image = { id: photo.photoId, bytes };
        this.downloadError = undefined;
        return bytes;
      } catch (error) {
        const failure = error instanceof RevealError ? new CameraMediaError(error.message, "unavailable") : error;
        if (failure instanceof CameraMediaError) {
          this.downloadError = failure;
          this.nextDownloadAt = this.now() + (this.config.pollIntervalMs ?? 300_000);
        }
        throw failure;
      } finally { this.downloading = undefined; }
    })();
    return this.downloading;
  }
}

export const TACTACAM_REVEAL: DeviceModel<RevealConfig> = {
  id: "tactacam-reveal", title: "Tactacam REVEAL", manufacturer: "Tactacam", product: "REVEAL cellular trail camera",
  capabilities: ["camera"], connectionTypes: ["cloud"], configSchema: REVEAL_CONFIG_SCHEMA, secretsSchema: REVEAL_SECRETS_SCHEMA,
  objectSchemaId: cameraSchema.$id,
  create(instance: DeviceInstance, config: RevealConfig, services: SiteServices, secrets: SecretsBag) {
    return new TactacamReveal(instance, config, revealCredentials(secrets), { ...(services.revealPhotos ? { archive: services.revealPhotos } : {}) });
  },
};
