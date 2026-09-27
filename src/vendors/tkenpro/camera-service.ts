import type {
  CameraCapabilityDescriptor,
  CameraConnectionView,
  CameraDashboardModel,
  CameraDeviceView,
  CameraNetworkStatusView,
} from "../../ui/dashboard";
import type {
  CameraControlRequest,
  CameraDiscoverRequest,
  CameraPtzRequest,
  CameraSetupRequest,
} from "../../schemas";
import type {
  CameraMediaSource,
  CameraPlayback,
  CameraPlaybackFrame,
} from "../../camera-media";
import type { CameraSetupStore, SavedCameraConfiguration } from "./setup-store";
import type { CameraInventoryStore, InventoryCamera } from "./inventory-store";
import {
  CameraRecoveryError,
  rebootCamera as recoverCamera,
  type CameraIdentity,
  type CameraRebootOutcome,
  type CameraRecoveryDependencies,
} from "../../models/recovery";
import { encodeMeariGridRegion } from "../../protocols/tkenpro/region-codecs";
import { encodeMeariPolygonRegions } from "../../protocols/tkenpro/polygon-region-codecs";
import { assertIotCode, isDestructiveCode } from "../../devices/treat-dispensers/tkenpro-2k-pet-camera-treat-dispenser/controls";
import type { MeariCommonRequest } from "../../protocols/tkenpro/p2p-command";
import type { MeariPeerCommandResponse } from "../../protocols/tkenpro/peer-command-session";
import type { IotValue, IotValues } from "../../protocols/tkenpro/types";

export interface CameraController {
  control(capabilityId: string, value: unknown, confirmed: boolean): Promise<void>;
  ptzStart(direction: "left" | "right" | "up" | "down"): Promise<void>;
  ptzStop(): Promise<void>;
  /** Issue one recovered CloudEdge common command directly to a local camera. */
  localCommand?(request: MeariCommonRequest): Promise<MeariPeerCommandResponse>;
  /** Write one or more raw CloudEdge IoT properties over the local channel. */
  localIot?(values: IotValues): Promise<Readonly<Record<string, unknown>>>;
  close?(): Promise<void> | void;
}

export interface CameraTalkback {
  start(): Promise<void>;
  sendPcm(pcm: Int16Array): Promise<void> | void;
  stop(): Promise<void>;
  close?(): Promise<void> | void;
}

export interface ManagedCamera {
  view: CameraDeviceView;
  controller: CameraController;
  media?: CameraMediaSource;
  talkback?: CameraTalkback;
  playback?: CameraPlayback;
  /** Non-secret discovery metadata for the persisted compatible-camera inventory. */
  inventory?: InventoryCamera;
}

export interface HostCredentials {
  readonly username: string;
  readonly password: string;
}

export interface LocalCameraCredentials {
  /** Site-wide fallback (legacy); per-camera secrets in `perHost` win. */
  username?: string;
  password?: string;
  /** ONVIF/local credentials by camera address, from each device's secrets. */
  perHost?: Readonly<Record<string, HostCredentials>>;
}

/** The credentials for one camera: its own secrets first, then the site-wide fallback. */
export function credentialsForHost(credentials: LocalCameraCredentials, host: string): LocalCameraCredentials {
  const own = credentials.perHost?.[host];
  return own ? { username: own.username, password: own.password } : { ...(credentials.username ? { username: credentials.username } : {}), ...(credentials.password ? { password: credentials.password } : {}) };
}

export interface CloudCameraSession {
  discover(): Promise<ManagedCamera[]>;
  close?(): Promise<void> | void;
}

export interface CameraServiceDependencies {
  connectCloud(input: CameraSetupRequest): Promise<CloudCameraSession>;
  /** Persists ONVIF credentials entered in the settings form for the camera at `host` (its device's secrets). */
  saveHostCredentials?(host: string, credentials: HostCredentials): Promise<void>;
  discoverLocal(
    request: CameraDiscoverRequest,
    credentials: LocalCameraCredentials,
  ): Promise<ManagedCamera[]>;
  registeredLocal?(credentials: LocalCameraCredentials): ManagedCamera[];
  /** A native local control plane is active, so app-account login is unnecessary. */
  localControlAvailable?: boolean;
  /** Hosts of the cameras defined in devices.yml; always included in discovery. */
  cameraHosts?: readonly string[];
  setupStore?: CameraSetupStore;
  /** Persists the catalog of compatible cameras found on the local network. */
  inventoryStore?: CameraInventoryStore;
  /** Reports and switches the shared DNS override (local emulator vs vendor cloud). */
  networkMode?: CameraNetworkModeLike;
  /** Observes the local emulator's registrations so a reconnect can be confirmed. */
  localRegistration?: LocalRegistrationLike;
  /** Finds a camera (configured address, then the vendor cloud) and reboots it over ONVIF. */
  cameraRecovery?: CameraRecoveryDependencies;
}

export interface CameraKickOutcome {
  readonly address: string;
  readonly kicked: boolean;
  readonly detail: string;
}

export interface CameraNetworkModeLike {
  snapshot(): CameraNetworkStatusView | undefined;
  refresh(): Promise<CameraNetworkStatusView>;
  /** Switch every camera, or (when the implementation isolates per device and a camera address is given) that camera. */
  set(action: "on" | "off", host?: string): Promise<{ message: string; status: CameraNetworkStatusView }>;
  /** One camera's own state by its LAN address; absent when the implementation only knows the shared DNS record. */
  snapshotFor?(host: string): CameraNetworkStatusView | undefined;
  /** Drops the cameras' Wi-Fi so they re-resolve DNS at once; absent when the gateway cannot. */
  kick?(addresses: readonly string[]): Promise<CameraKickOutcome[]>;
}

export interface LocalRegistrationLike {
  /** LAN addresses of the cameras the local emulator is bootstrapped for. */
  readonly cameraAddresses: readonly string[];
  isRegistered(address: string): boolean;
  /**
   * Resolves with the elapsed milliseconds once the camera at `address` next
   * registers with (or, for "disconnected", drops from) the local emulator, or
   * undefined when `timeoutMs` passes first. Call it before the kick so the
   * event cannot be missed.
   */
  waitForEvent(address: string, kind: "registered" | "disconnected", timeoutMs: number): Promise<number | undefined>;
}

export interface CameraReconnectOptions {
  /** Reconnect one camera by dashboard id; every bootstrapped/configured camera when omitted. */
  readonly deviceId?: string;
  /** Switch the DNS override first, then make the cameras follow it. */
  readonly action?: "on" | "off";
  /** How long to wait for the local emulator to see the camera again. */
  readonly timeoutMs?: number;
}

export interface CameraReconnectResult {
  readonly message: string;
  readonly state: CameraDashboardModel;
  readonly results: readonly CameraKickOutcome[];
}

export interface CameraRebootServiceOptions {
  /** The camera's dashboard id; or give its configured address as `host`. */
  readonly deviceId?: string;
  readonly host?: string;
  /** How long to wait for the camera to answer at its configured address again. */
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export interface CameraRebootServiceResult {
  readonly message: string;
  readonly state: CameraDashboardModel;
  readonly outcome: CameraRebootOutcome;
}

const REBOOT_REGISTER_GRACE_MS = 30_000;

/** Whatever a dashboard id says about which camera it is. */
export function identityFromDeviceId(deviceId: string): CameraIdentity {
  const uuid = /^meari-local-([0-9a-f]{16})$/u.exec(deviceId)?.[1];
  if (uuid) return { uuid };
  if (/^\d{6,}$/u.test(deviceId)) return { serialNumber: deviceId };
  return {};
}

const RECONNECT_REGISTER_TIMEOUT_MS = 45_000;
const RECONNECT_DEPART_TIMEOUT_MS = 20_000;

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

export class CameraServiceError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "not_configured"
      | "not_supported"
      | "confirmation_required"
      | "invalid_control"
      | "camera_error",
  ) {
    super(message);
    this.name = "CameraServiceError";
  }
}

function accountHint(account: string): string {
  const at = account.indexOf("@");
  if (at > 1) return `${account.slice(0, 2)}•••${account.slice(at)}`;
  if (account.length > 4) return `${account.slice(0, 2)}•••${account.slice(-2)}`;
  return "configured account";
}

function setupView(input: CameraSetupRequest): CameraDashboardModel["setup"] {
  return {
    configured: true,
    profile: input.profile,
    ...(input.email ? { accountHint: accountHint(input.email) } : {}),
  };
}

function localCredentials(input: CameraSetupRequest): LocalCameraCredentials {
  return {
    ...(input.onvifUsername ? { username: input.onvifUsername } : {}),
    ...(input.onvifPassword ? { password: input.onvifPassword } : {}),
  };
}

function mergeSetup(
  saved: CameraSetupRequest | undefined,
  input: CameraSetupRequest,
): CameraSetupRequest {
  const countryCode = input.countryCode ?? saved?.countryCode;
  const phoneCode = input.phoneCode ?? saved?.phoneCode;
  const email = input.email ?? saved?.email;
  const password = input.password ?? saved?.password;
  const onvifUsername = input.onvifUsername ?? saved?.onvifUsername;
  const onvifPassword = input.onvifPassword ?? saved?.onvifPassword;
  return {
    profile: input.profile,
    ...(countryCode ? { countryCode } : {}),
    ...(phoneCode ? { phoneCode } : {}),
    ...(email ? { email } : {}),
    ...(password ? { password } : {}),
    ...(onvifUsername ? { onvifUsername } : {}),
    ...(onvifPassword ? { onvifPassword } : {}),
  };
}

/** Build a placeholder device view for a camera known only from the persisted
 * inventory (not yet re-contacted this session). It shows in the web interface
 * as an offline entry with the recorded identity so the user sees every
 * compatible camera immediately; a scan replaces it with a live view. */
function inventoryDeviceView(camera: InventoryCamera): CameraDeviceView {
  return {
    id: camera.id,
    name: camera.deviceName ?? camera.model ?? "Pet camera",
    host: camera.host,
    ...(camera.model ? { model: camera.model } : {}),
    ...(camera.firmware ? { firmware: camera.firmware } : {}),
    status: "offline",
    stream: "unknown",
    snapshot: "unknown",
    connection: {
      via: "none",
      problems: [`Known from an earlier scan at ${camera.host} but not contacted since HomeTruth started. Run Discover locally, or check that the camera is powered and on Wi-Fi.`],
    },
    capabilities: [{
      id: "local.discovery",
      category: "advanced",
      label: "Local network discovery",
      description: "Saved from a previous local discovery scan. Scan again to reconnect.",
      kind: "status",
      availability: "unavailable",
      value: `Last seen at ${camera.host}`,
      readOnly: true,
    }],
  };
}

function cameraMediaHost(camera: ManagedCamera | undefined): string | undefined {
  const uri = camera?.media?.streamUri ?? camera?.media?.snapshotUri;
  if (!uri) return undefined;
  try {
    return new URL(uri).hostname;
  } catch {
    return undefined;
  }
}

/** Combine the local-emulator and cloud views of one camera into a single account. */
export function mergeConnections(
  left: CameraConnectionView | undefined,
  right: CameraConnectionView | undefined,
): CameraConnectionView {
  const local = left?.local ?? right?.local;
  const cloud = left?.cloud ?? right?.cloud;
  const via: CameraConnectionView["via"] = local?.state === "connected"
    ? "local"
    : cloud?.state === "online"
      ? "cloud"
      : "none";
  const problems = [...new Set([...(left?.problems ?? []), ...(right?.problems ?? [])])];
  if (via === "none" && problems.length === 0) {
    problems.push("The camera is not reachable through the local emulator or the vendor cloud right now");
  }
  return {
    via,
    ...(local ? { local } : {}),
    ...(cloud ? { cloud } : {}),
    problems,
  };
}

/** Account for the direct ONVIF/RTSP media path, which neither adapter's
 * connection summary covers: a camera streaming over the LAN is reachable even
 * while it has not (re)registered with the local emulator. */
function finalizeConnection(device: CameraDeviceView): CameraConnectionView {
  const connection = device.connection ?? { via: "none", problems: [] };
  const direct = device.status === "online" && device.stream === "available";
  const onvif: CameraConnectionView["onvif"] = direct
    ? { state: "connected", detail: "Live video and microphone audio come straight from the camera's RTSP stream on this network." }
    : { state: "unavailable", detail: device.status === "online" ? "The camera's ONVIF/RTSP service is not reachable, so live video is not available." : "The camera is not online." };
  const via: CameraConnectionView["via"] = connection.via !== "none" ? connection.via : direct ? "onvif" : "none";
  const problems = connection.problems.filter((problem) => !(direct && /not reachable through the local emulator or the vendor cloud/u.test(problem)));
  if (device.status === "online" && !direct && !problems.some((problem) => /ONVIF/u.test(problem))) {
    problems.push("Live video is unavailable: the camera's ONVIF/RTSP service is not reachable (check ONVIF is enabled and the ONVIF password is saved).");
  }
  return { ...connection, via, onvif, problems };
}

function cameraCommandError(error: unknown): CameraServiceError {
  if (error instanceof CameraServiceError) return error;
  if (error instanceof TypeError || error instanceof RangeError) {
    return new CameraServiceError(error.message, "invalid_control");
  }
  const resultCode = typeof error === "object" && error !== null && "resultCode" in error
    ? String((error as { resultCode?: unknown }).resultCode ?? "")
    : "";
  const suffix = /^[A-Za-z0-9_-]{1,32}$/u.test(resultCode) ? ` (TKENPRO code ${resultCode})` : "";
  const wrapped = new CameraServiceError(
    `The camera rejected the change${suffix}. Check the camera connection and credentials, then try again.`,
    "camera_error",
  );
  // Keep the underlying failure reachable for the request_error log line.
  wrapped.cause = error;
  return wrapped;
}

const LOCAL_COMMAND_CONFIRMATION_PATHS = new Set([
  "/devices/charm/unpair",
  "/devices/firmware_upgrade",
  "/devices/reboot",
  "/devices/sdrecord/delete/progress",
  "/devices/tlr/download/progress",
]);

function localCommandPath(deviceurl: string): string {
  try {
    const url = new URL(deviceurl);
    if (!/^127\.0\.0\.1$|^localhost$/u.test(url.hostname)) {
      throw new Error("Local command deviceurl must target the camera loopback path");
    }
    return url.pathname;
  } catch (error) {
    if (error instanceof CameraServiceError) throw error;
    throw new CameraServiceError("Local command deviceurl is invalid", "invalid_control");
  }
}

function isJsonValue(value: unknown): value is IotValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function localIotValues(value: unknown): IotValues {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CameraServiceError("Local IoT values must be a JSON object", "invalid_control");
  }
  const values: Record<string, IotValue> = {};
  for (const [code, item] of Object.entries(value as Record<string, unknown>)) {
    try { assertIotCode(code); } catch { throw new CameraServiceError("IoT codes must contain 1–6 decimal digits", "invalid_control"); }
    if (!isJsonValue(item)) {
      throw new CameraServiceError(`IoT ${code} has a non-JSON value`, "invalid_control");
    }
    values[code] = item;
  }
  if (Object.keys(values).length === 0) {
    throw new CameraServiceError("At least one local IoT value is required", "invalid_control");
  }
  return values;
}

function invalidControl(message: string): never {
  throw new CameraServiceError(message, "invalid_control");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateScheduleValue(value: unknown): void {
  if (!isPlainRecord(value) && !Array.isArray(value)) {
    invalidControl("A schedule must be a JSON object or list");
  }
  if (!isPlainRecord(value)) return;

  if ("enabled" in value && typeof value.enabled !== "boolean") {
    invalidControl("Schedule enabled must be true or false");
  }
  if ("time" in value && (typeof value.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value.time))) {
    invalidControl("Schedule time must use 24-hour HH:MM format");
  }
  if ("days" in value) {
    if (!Array.isArray(value.days)) invalidControl("Schedule days must be a list");
    const allowedDays = new Set(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
    if (value.days.some((day) => typeof day !== "string" || !allowedDays.has(day))) {
      invalidControl("Schedule days must use sun, mon, tue, wed, thu, fri, or sat");
    }
    if (new Set(value.days).size !== value.days.length) {
      invalidControl("Schedule days cannot contain duplicates");
    }
  }
}

function validatePresetValue(value: unknown): void {
  if (!isPlainRecord(value)) invalidControl("A saved-view command must be a JSON object");
  if (value.action !== "save" && value.action !== "recall" && value.action !== "delete") {
    invalidControl("Saved-view action must be save, recall, or delete");
  }
  if (value.action === "save") {
    if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 40) {
      invalidControl("A saved view needs a name of 1 to 40 characters");
    }
    if (value.presetId !== undefined && !["string", "number"].includes(typeof value.presetId)) {
      invalidControl("Saved-view ID must be text or a number");
    }
    return;
  }
  if ((typeof value.presetId !== "string" && typeof value.presetId !== "number") || String(value.presetId).trim() === "") {
    invalidControl("Choose a saved view first");
  }
}

function validateControlValue(
  capability: CameraCapabilityDescriptor,
  value: unknown,
): void {
  switch (capability.kind) {
    case "toggle":
    case "momentary":
      if (typeof value !== "boolean" && value !== 0 && value !== 1) {
        invalidControl(`${capability.label} must be true or false`);
      }
      return;
    case "range": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        invalidControl(`${capability.label} must be a number`);
      }
      if (capability.min !== undefined && value < capability.min) {
        invalidControl(`${capability.label} must be at least ${capability.min}`);
      }
      if (capability.max !== undefined && value > capability.max) {
        invalidControl(`${capability.label} must be at most ${capability.max}`);
      }
      if (capability.step !== undefined && capability.step > 0) {
        const base = capability.min ?? 0;
        const steps = (value - base) / capability.step;
        if (Math.abs(steps - Math.round(steps)) > 1e-9) {
          invalidControl(`${capability.label} must use increments of ${capability.step}`);
        }
      }
      return;
    }
    case "select":
      if (typeof value !== "string" && typeof value !== "number") {
        invalidControl(`${capability.label} must be one of the listed options`);
      }
      if (capability.options?.length && !capability.options.some((option) => option.value === String(value))) {
        invalidControl(`${capability.label} received an unsupported option`);
      }
      return;
    case "text":
      if (typeof value !== "string" || value.length > 2_048) {
        invalidControl(`${capability.label} must be text of at most 2,048 characters`);
      }
      return;
    case "color":
      if (typeof value !== "string" || !/^#[0-9a-f]{6}$/iu.test(value)) {
        invalidControl(`${capability.label} must be a six-digit hex color`);
      }
      return;
    case "treat": {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        invalidControl(`${capability.label} must be a whole number`);
      }
      const minimum = capability.min ?? 1;
      const maximum = capability.max ?? 10;
      if (value < minimum || value > maximum) {
        invalidControl(`${capability.label} must be from ${minimum} to ${maximum}`);
      }
      return;
    }
    case "schedule":
      validateScheduleValue(value);
      return;
    case "region":
      encodeMeariGridRegion(value);
      return;
    case "polygon-region":
      encodeMeariPolygonRegions(value);
      return;
    case "presets":
      validatePresetValue(value);
      return;
    case "ptz":
      invalidControl("Use the bounded PTZ endpoint for camera movement");
    case "status":
      invalidControl(`${capability.label} is read-only`);
    case "action":
      if (value !== true && value !== null) invalidControl(`${capability.label} expects true`);
      return;
    case "json":
      return;
  }
}

function mergeCapabilities(
  first: CameraCapabilityDescriptor[],
  second: CameraCapabilityDescriptor[],
): CameraCapabilityDescriptor[] {
  const capabilities = new Map(first.map((capability) => [capability.id, capability]));
  for (const capability of second) {
    const existing = capabilities.get(capability.id);
    if (!existing) {
      capabilities.set(capability.id, capability);
      continue;
    }
    const replacement: CameraCapabilityDescriptor = {
      ...existing,
      ...capability,
      availability: capability.availability,
    };
    if (!("readOnly" in capability)) delete replacement.readOnly;
    if (!("dangerous" in capability)) delete replacement.dangerous;
    capabilities.set(capability.id, replacement);
  }
  return [...capabilities.values()];
}

function hasNativeLocalControl(camera: ManagedCamera): boolean {
  return camera.view.capabilities.some((capability) => capability.id === "local.nativeControl");
}

function cameraIdentityKey(view: CameraDeviceView): string {
  const normalized = view.id.trim().toLowerCase();
  const prefixed = /^ppsl([0-9]+)$/u.exec(normalized)?.[1];
  // CloudEdge currently assigns opaque `ppsc…` identifiers while exposing the
  // camera's exact nine-digit hardware ID as deviceName. Keep this exact-only
  // so friendly names containing digits can never merge unrelated cameras.
  const nameSerial = /^\d{9}$/u.test(view.name.trim()) ? view.name.trim() : undefined;
  const serial = prefixed
    ?? (/^[0-9]{9}(?:[0-9]{7})?$/u.test(normalized) ? normalized : undefined)
    ?? nameSerial;
  if (!serial) return normalized;
  return `meari:${serial.length === 9 ? serial.padStart(16, "0") : serial}`;
}

function mergeCameras(cameras: ManagedCamera[]): ManagedCamera[] {
  const merged = new Map<string, ManagedCamera>();
  for (const camera of cameras) {
    const key = cameraIdentityKey(camera.view);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, camera);
      continue;
    }
    const preferred = hasNativeLocalControl(camera)
      ? camera
      : hasNativeLocalControl(existing)
        ? existing
        : camera;
    const secondary = preferred === camera ? existing : camera;
    merged.set(key, {
      view: {
        ...secondary.view,
        ...preferred.view,
        status: existing.view.status === "online" || camera.view.status === "online" ? "online" : camera.view.status,
        stream: existing.view.stream === "available" || camera.view.stream === "available" ? "available" : camera.view.stream,
        snapshot: existing.view.snapshot === "available" || camera.view.snapshot === "available" ? "available" : camera.view.snapshot,
        capabilities: mergeCapabilities(secondary.view.capabilities, preferred.view.capabilities),
        ...(existing.view.connection || camera.view.connection
          ? { connection: mergeConnections(existing.view.connection, camera.view.connection) }
          : {}),
      },
      controller: preferred.controller,
      ...(preferred.media || secondary.media ? { media: preferred.media ?? secondary.media } : {}),
      ...(preferred.talkback || secondary.talkback
        ? { talkback: preferred.talkback ?? secondary.talkback }
        : {}),
      ...(preferred.playback || secondary.playback
        ? { playback: preferred.playback ?? secondary.playback }
        : {}),
    });
  }
  return [...merged.values()];
}

export class CameraService {
  #cloudSession: CloudCameraSession | undefined;
  #localCredentials: LocalCameraCredentials = {};
  #hostCredentials = new Map<string, HostCredentials>();
  #savedConfiguration: SavedCameraConfiguration | undefined;
  #cameras = new Map<string, ManagedCamera>();
  #ptzTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #activeTalkbackDeviceId: string | undefined;
  #talkbackStarts = new Map<string, Promise<void>>();
  #cancelledTalkbackStarts = new Set<string>();
  #activePlaybackDeviceId: string | undefined;
  #model: CameraDashboardModel = {
    setup: { configured: false, profile: null },
    discovery: { status: "idle" },
    devices: [],
    selectedDeviceId: null,
  };

  constructor(private readonly dependencies: CameraServiceDependencies) {}

  /** The camera hosts defined in devices.yml. */
  configuredCameraHosts(): readonly string[] {
    return this.dependencies.cameraHosts ?? [];
  }

  /** A device's own ONVIF/local credentials, used for that address ahead of any site-wide fallback. */
  registerHostCredentials(host: string, credentials: HostCredentials): void {
    this.#hostCredentials.set(host, credentials);
  }

  #credentials(): LocalCameraCredentials {
    return this.#hostCredentials.size === 0
      ? this.#localCredentials
      : { ...this.#localCredentials, perHost: Object.fromEntries(this.#hostCredentials) };
  }

  state(): CameraDashboardModel {
    const model = structuredClone(this.#model);
    model.devices = model.devices.map((device) => ({ ...device, connection: finalizeConnection(device) }));
    const network = this.dependencies.networkMode?.snapshot();
    return network ? { ...model, network } : model;
  }

  /** Re-check the shared DNS override and return the whole dashboard model with it. */
  async refreshNetwork(): Promise<CameraDashboardModel> {
    await this.dependencies.networkMode?.refresh();
    return this.state();
  }

  /**
   * Switch the shared DNS override. By default the cameras are then kicked off
   * Wi-Fi so they follow the record within seconds instead of after their own
   * cloud heartbeat timeout; pass `reconnect: false` to only change the record.
   */
  async setNetworkMode(
    action: "on" | "off",
    options: { reconnect?: boolean; deviceId?: string } = {},
  ): Promise<{ message: string; state: CameraDashboardModel }> {
    const networkMode = this.dependencies.networkMode;
    if (!networkMode) {
      throw new CameraServiceError("The DNS override cannot be switched from this server", "not_supported");
    }
    const message = await this.#switchDnsOverride(networkMode, action, options.deviceId);
    // An isolating implementation kicks the changed camera itself; the shared-record one needs the follow-up kick here.
    const reconnect = options.reconnect ?? (typeof networkMode.snapshotFor !== "function" && typeof networkMode.kick === "function" && this.#reconnectTargets().length > 0);
    if (!reconnect) return { message, state: this.state() };
    try {
      const followed = await this.reconnectCameras(options.deviceId ? { deviceId: options.deviceId } : {});
      return { message: `${message}. ${followed.message}`, state: followed.state };
    } catch (error) {
      // The record did change; report the failed follow-up rather than undoing it.
      const detail = error instanceof Error ? error.message : String(error);
      return { message: `${message}. The cameras were not kicked to follow it (${detail}); they reconnect on their own within a few minutes`, state: this.state() };
    }
  }

  /**
   * Make the cameras follow the DNS record right now. The Pet 3T only re-resolves
   * the cloud hostname when its connection drops, so the gateway kicks each
   * camera off Wi-Fi; on local mode the call then waits for the local emulator
   * to see the camera register again and refreshes it.
   */
  async reconnectCameras(options: CameraReconnectOptions = {}): Promise<CameraReconnectResult> {
    const networkMode = this.dependencies.networkMode;
    if (!networkMode) {
      throw new CameraServiceError("The DNS override cannot be switched from this server", "not_supported");
    }
    const kick = networkMode.kick?.bind(networkMode);
    if (!kick) {
      throw new CameraServiceError("The configured network adapter cannot kick Wi-Fi clients; reconnect the camera by power-cycling it or wait for its heartbeat timeout", "not_supported");
    }
    if (options.action) await this.#switchDnsOverride(networkMode, options.action);
    const status = networkMode.snapshot() ?? await networkMode.refresh();
    const hosts = options.deviceId ? [this.#hostOfDevice(options.deviceId)] : this.#reconnectTargets();
    if (hosts.length === 0) {
      throw new CameraServiceError("No camera addresses are known; bootstrap the local emulator or list the cameras in devices.yml", "not_configured");
    }

    const registration = this.dependencies.localRegistration;
    const wantRegistered = status.mode !== "cloud";
    const timeoutMs = options.timeoutMs ?? (wantRegistered ? RECONNECT_REGISTER_TIMEOUT_MS : RECONNECT_DEPART_TIMEOUT_MS);
    // A camera already on the wanted side is left alone. Verified on the Pet
    // 3T: a kick while it is registered locally makes the firmware fall back
    // to the vendor's own domain from its last session, so it would leave the
    // emulator for minutes instead of re-registering.
    const notes: string[] = [];
    const targets: string[] = [];
    for (const host of hosts) {
      const known = registration?.cameraAddresses.includes(host) ?? false;
      const registered = known && registration!.isRegistered(host);
      if (known && registered === wantRegistered) {
        notes.push(wantRegistered
          ? `${host} is already registered with the local emulator; not kicked`
          : `${host} is not on the local emulator, so it is already using the vendor cloud; not kicked`);
        continue;
      }
      targets.push(host);
    }
    if (targets.length === 0) return { message: notes.join(". "), state: this.state(), results: [] };

    // Subscribe before the kick: a fast camera can re-register within the
    // gateway round-trip, and a stale emulator session must not count.
    const watched = new Map<string, Promise<number | undefined>>();
    for (const host of targets) {
      if (!registration?.cameraAddresses.includes(host)) continue;
      watched.set(host, registration.waitForEvent(host, wantRegistered ? "registered" : "disconnected", timeoutMs));
    }

    let results: CameraKickOutcome[];
    try {
      results = await kick(targets);
    } catch (error) {
      const wrapped = new CameraServiceError(
        `The network adapter could not kick the camera Wi-Fi: ${error instanceof Error ? error.message : String(error)}`,
        "camera_error",
      );
      wrapped.cause = error;
      throw wrapped;
    }

    for (const result of results) {
      const wait = watched.get(result.address);
      if (!result.kicked) {
        notes.push(result.detail);
        continue;
      }
      if (!wait) {
        notes.push(wantRegistered
          ? `${result.address} was kicked; it reconnects within about 15 s`
          : `${result.address} was kicked; it re-attaches to the vendor cloud within about 15 s`);
        continue;
      }
      const elapsed = await wait;
      if (wantRegistered) {
        notes.push(elapsed === undefined
          ? `${result.address} was kicked but has not re-registered with the local emulator after ${seconds(timeoutMs)}; check that ${status.domain} resolves to ${status.overrideIp} and that the camera is in the emulator allow-list`
          : `${result.address} re-registered with the local emulator ${seconds(elapsed)} after the kick`);
      } else {
        notes.push(elapsed === undefined
          ? `${result.address} was kicked; the local emulator still holds its old session, and the camera re-attaches to the vendor cloud within about 15 s`
          : `${result.address} left the local emulator ${seconds(elapsed)} after the kick and re-attaches to the vendor cloud`);
      }
    }
    // Unwatched waits (camera not kicked) must not leak past the request.
    await Promise.allSettled([...watched.values()]);

    if (results.some((result) => result.kicked)) {
      await this.discover({ hosts: targets }).catch(() => undefined);
    }
    return { message: notes.join(". "), state: this.state(), results };
  }

  /**
   * Reboot one camera wherever it is. The configured address is tried first;
   * when it is dead the vendor cloud is asked where the camera last reported
   * itself (a camera that failed over to its backup Wi-Fi shows up on another
   * subnet), the reboot goes there, and the call waits for the camera to answer
   * at its configured address again. In local mode it also waits for the
   * camera to re-register with the local emulator, then refreshes it.
   */
  async rebootCamera(options: CameraRebootServiceOptions = {}): Promise<CameraRebootServiceResult> {
    const recovery = this.dependencies.cameraRecovery;
    if (!recovery) {
      throw new CameraServiceError("Rebooting cameras is not supported by this server", "not_supported");
    }
    if (!options.deviceId && !options.host) {
      throw new CameraServiceError("Say which camera to reboot: deviceId or host", "invalid_control");
    }
    const host = options.deviceId ? this.#hostOfDevice(options.deviceId) : options.host!;
    if (options.host && options.deviceId && options.host !== host) {
      throw new CameraServiceError(`${options.deviceId} is at ${host}, not ${options.host}`, "invalid_control");
    }
    const identity = await this.#identityOfCamera(host, options.deviceId);
    const setup = this.#savedConfiguration?.setup;
    const account = setup?.email && setup.password
      ? {
        email: setup.email,
        password: setup.password,
        ...(setup.profile ? { profile: setup.profile } : {}),
        ...(setup.countryCode ? { countryCode: setup.countryCode } : {}),
        ...(setup.phoneCode ? { phoneCode: setup.phoneCode } : {}),
      }
      : undefined;

    // Arm the registration wait before the reboot so a fast re-registration is not missed.
    const registration = this.dependencies.localRegistration;
    const network = this.dependencies.networkMode?.snapshot();
    const wantRegistered = network !== undefined && network.mode !== "cloud";
    const timeoutMs = options.timeoutMs ?? undefined;
    const registered = wantRegistered && registration?.cameraAddresses.includes(host)
      ? registration.waitForEvent(host, "registered", (timeoutMs ?? 120_000) + REBOOT_REGISTER_GRACE_MS)
      : undefined;

    let outcome: CameraRebootOutcome;
    try {
      outcome = await recoverCamera(recovery, {
        configuredHost: host,
        identity,
        credentials: credentialsForHost(this.#credentials(), host),
        ...(account ? { account } : {}),
      }, {
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
      });
    } catch (error) {
      await Promise.allSettled([registered]);
      if (error instanceof CameraRecoveryError) {
        const wrapped = new CameraServiceError(error.message, error.code === "not_configured" ? "not_configured" : "camera_error");
        wrapped.cause = error;
        throw wrapped;
      }
      throw error;
    }

    const notes = [outcome.message];
    if (registered) {
      if (outcome.backAfterMs === undefined) {
        // The camera never answered; do not hold the request for the registration grace period.
        void registered.catch(() => undefined);
      } else {
        const elapsed = await registered;
        notes.push(elapsed === undefined
          ? `it has not re-registered with the local emulator yet; refresh in a minute`
          : `it re-registered with the local emulator ${seconds(elapsed)} after the reboot`);
      }
    }
    if (outcome.backAfterMs !== undefined) {
      await this.discover({ hosts: [host] }).catch(() => undefined);
    }
    return { message: notes.join("; "), state: this.state(), outcome };
  }

  async #identityOfCamera(host: string, deviceId: string | undefined): Promise<CameraIdentity> {
    const fromId = deviceId ? identityFromDeviceId(deviceId) : {};
    if (fromId.serialNumber) return fromId;
    let inventory: readonly InventoryCamera[] = [];
    try {
      inventory = await this.dependencies.inventoryStore?.load() ?? [];
    } catch {
      // The inventory is a convenience; the reboot works without it.
    }
    const record = inventory.find((camera) => camera.host === host && camera.serialNumber);
    return {
      ...fromId,
      ...(record?.serialNumber ? { serialNumber: record.serialNumber } : {}),
    };
  }

  /** One camera's own network view (by its LAN address) when the implementation isolates per device, else the shared one. */
  networkStatusFor(host: string): CameraNetworkStatusView | undefined {
    const networkMode = this.dependencies.networkMode;
    return networkMode?.snapshotFor?.(host) ?? networkMode?.snapshot();
  }

  async #switchDnsOverride(networkMode: CameraNetworkModeLike, action: "on" | "off", deviceId?: string): Promise<string> {
    try {
      const host = deviceId ? this.#hostOfDevice(deviceId) : undefined;
      return (await networkMode.set(action, host)).message;
    } catch (error) {
      const wrapped = new CameraServiceError(
        `The DNS override could not be changed: ${error instanceof Error ? error.message : String(error)}`,
        "camera_error",
      );
      wrapped.cause = error;
      throw wrapped;
    }
  }

  /** Every camera the reconnect flow can reach: emulator-bootstrapped plus devices.yml. */
  #reconnectTargets(): string[] {
    return [...new Set([
      ...(this.dependencies.localRegistration?.cameraAddresses ?? []),
      ...this.configuredCameraHosts(),
    ])];
  }

  #hostOfDevice(deviceId: string): string {
    const device = this.#model.devices.find((candidate) => candidate.id === deviceId);
    if (!device) throw new CameraServiceError(`No camera with id ${deviceId}`, "not_found");
    if (!device.host) throw new CameraServiceError(`${device.name} has no local network address to reconnect`, "not_supported");
    return device.host;
  }

  async setup(input: CameraSetupRequest): Promise<CameraDashboardModel> {
    return await this.#activateSetup(input, true);
  }

  async restore(options: { connect?: boolean } = {}): Promise<CameraDashboardModel> {
    await this.#restoreDiscoveredInventory();
    const store = this.dependencies.setupStore;
    if (!store) return this.state();
    let saved: SavedCameraConfiguration | undefined;
    try {
      saved = await store.load();
    } catch {
      this.#model.discovery = {
        status: "error",
        message: "The saved camera environment could not be read. Check .env.local and restart HomeTruth.",
      };
      return this.state();
    }
    if (!saved) return this.state();

    this.#savedConfiguration = saved;
    if (options.connect === false) {
      this.#localCredentials = localCredentials(saved.setup);
      this.#model.setup = setupView(saved.setup);
      if (saved.selectedDeviceId && this.#cameras.has(saved.selectedDeviceId)) this.#model.selectedDeviceId = saved.selectedDeviceId;
      return this.state();
    }
    let cloudRestoreFailed = false;
    try {
      await this.#activateSetup(saved.setup, false);
    } catch {
      cloudRestoreFailed = Boolean(saved.setup.email);
      this.#localCredentials = localCredentials(saved.setup);
      this.#model.setup = setupView(saved.setup);
    }

    const request: CameraDiscoverRequest = saved.cameraHost
      ? { hosts: [...new Set([saved.cameraHost, ...this.configuredCameraHosts()])], cidrs: [] }
      : {};
    try {
      await this.discover(request);
      if (saved.cameraHost && ![...this.#cameras.values()].some((camera) => cameraMediaHost(camera))) {
        await this.discover({});
      }
      if (saved.selectedDeviceId && this.#cameras.has(saved.selectedDeviceId)) {
        await this.select(saved.selectedDeviceId);
      }
      if (!this.#cloudSession && saved.setup.email && this.#model.devices.length === 0) {
        this.#model.discovery = {
          status: "error",
          message: "Saved camera details could not reconnect. Update the saved app details and try again.",
        };
      } else if (cloudRestoreFailed && this.#model.devices.length > 0) {
        this.#model.discovery = {
          status: "ready",
          message: `Found ${this.#model.devices.length} camera${this.#model.devices.length === 1 ? "" : "s"}; local controls are ready. Saved cloud controls need updated account details.`,
        };
      }
    } catch {
      this.#model.discovery = {
        status: "error",
        message: "Saved camera details loaded, but the camera could not reconnect. Check that it is online, then scan again.",
      };
    }
    return this.state();
  }

  async #activateSetup(input: CameraSetupRequest, persist: boolean): Promise<CameraDashboardModel> {
    const merged = mergeSetup(this.#savedConfiguration?.setup, input);
    const hasAccount = Boolean(merged.email || merged.password);
    if (hasAccount && (!merged.email || !merged.password)) {
      throw new CameraServiceError("Enter both the app account and password", "invalid_control");
    }

    let stagedSession: CloudCameraSession | undefined;
    if (merged.email && merged.password && !this.dependencies.localControlAvailable) {
      stagedSession = await this.dependencies.connectCloud(merged);
    }
    const nextConfiguration: SavedCameraConfiguration = {
      ...this.#savedConfiguration,
      setup: merged,
    };
    try {
      if (persist) await this.dependencies.setupStore?.save(nextConfiguration);
    } catch (error) {
      await stagedSession?.close?.();
      throw error;
    }

    // ONVIF credentials typed into the form belong to the camera the page is for.
    if (persist && input.onvifUsername && input.onvifPassword && this.dependencies.saveHostCredentials) {
      const host = this.#model.selectedDeviceId
        ? this.#model.devices.find((device) => device.id === this.#model.selectedDeviceId)?.host
        : undefined;
      if (host) {
        const credentials = { username: input.onvifUsername, password: input.onvifPassword };
        await this.dependencies.saveHostCredentials(host, credentials);
        this.#hostCredentials.set(host, credentials);
      }
    }
    const previousSession = this.#cloudSession;
    this.#cloudSession = stagedSession;
    this.#localCredentials = localCredentials(merged);
    this.#savedConfiguration = nextConfiguration;
    this.#model.setup = setupView(merged);
    try {
      await previousSession?.close?.();
    } catch {
      // The replacement is already active and saved; stale-session cleanup is best effort.
    }
    return this.state();
  }

  async disconnect(): Promise<CameraDashboardModel> {
    await this.dependencies.setupStore?.clear();
    await this.close();
    this.#savedConfiguration = undefined;
    this.#model = {
      setup: { configured: false, profile: null },
      discovery: { status: "idle" },
      devices: [],
      selectedDeviceId: null,
    };
    return this.state();
  }

  async close(): Promise<void> {
    for (const timer of this.#ptzTimers.values()) clearTimeout(timer);
    this.#ptzTimers.clear();
    for (const camera of this.#cameras.values()) {
      await camera.talkback?.close?.();
      await camera.playback?.close?.();
      await camera.controller.close?.();
    }
    this.#activeTalkbackDeviceId = undefined;
    this.#talkbackStarts.clear();
    this.#cancelledTalkbackStarts.clear();
    this.#activePlaybackDeviceId = undefined;
    await this.#cloudSession?.close?.();
    this.#cloudSession = undefined;
    this.#localCredentials = {};
    this.#cameras.clear();
  }

  /** Attach cameras that registered with our emulator, without scanning the LAN. */
  async attachRegistered(): Promise<CameraDashboardModel> {
    const registered = this.dependencies.registeredLocal?.(this.#credentials()) ?? [];
    for (const camera of registered) this.#cameras.set(camera.view.id, camera);
    this.#model.devices = [...this.#cameras.values()].map(camera => {
      const host = cameraMediaHost(camera) ?? camera.inventory?.host;
      return host ? { ...camera.view, host } : camera.view;
    });
    this.#model.selectedDeviceId ??= registered[0]?.view.id ?? null;
    await this.#saveDiscoveredInventory(registered);
    return this.state();
  }

  async discover(request: CameraDiscoverRequest = {}): Promise<CameraDashboardModel> {
    this.#model.discovery = { status: "searching", message: "Looking on your local network…" };
    // Cameras defined in devices.yml are always probed directly, even
    // when they sit outside the subnets a broadcast scan would cover.
    const hosts = [...new Set([...(request.hosts ?? []), ...this.configuredCameraHosts()])];
    const localRequest: CameraDiscoverRequest = hosts.length > 0 ? { ...request, hosts } : request;
    try {
      const results = await Promise.allSettled([
        this.dependencies.discoverLocal(localRequest, this.#credentials()),
        ...(this.#cloudSession ? [this.#cloudSession.discover()] : []),
      ]);
      const cameras = mergeCameras(results.flatMap((result) => result.status === "fulfilled" ? result.value : []));
      this.#cameras = new Map(cameras.map((camera) => [camera.view.id, camera]));
      this.#model.devices = cameras.map((camera) => {
        const host = cameraMediaHost(camera) ?? camera.inventory?.host;
        return host ? { ...camera.view, host } : camera.view;
      });
      // Adds offline entries for compatible cameras seen before but silent now.
      await this.#saveDiscoveredInventory(cameras);
      const totalDevices = this.#model.devices.length;
      const liveCount = cameras.length;

      if (!this.#model.selectedDeviceId
        || !this.#model.devices.some((device) => device.id === this.#model.selectedDeviceId)) {
        this.#model.selectedDeviceId = cameras.at(0)?.view.id
          ?? this.#model.devices.at(0)?.id
          ?? null;
      }
      const failures = results.filter((result) => result.status === "rejected");
      this.#model.discovery = {
        status: failures.length === results.length ? "error" : "ready",
        message: totalDevices > 0
          ? `Found ${totalDevices} camera${totalDevices === 1 ? "" : "s"}`
            + (liveCount < totalDevices ? ` (${liveCount} online now)` : "")
          : failures.length > 0
            ? "Camera discovery could not complete"
            : "No camera services answered. In TKENPRO, enable ONVIF and create its ONVIF password, then scan again.",
      };
      await this.#saveCameraContext();
      return this.state();
    } catch (error) {
      this.#model.discovery = {
        status: "error",
        message: error instanceof Error ? error.message : "Camera discovery failed",
      };
      throw error;
    }
  }

  async select(deviceId: string): Promise<CameraDashboardModel> {
    this.camera(deviceId);
    if (this.#activeTalkbackDeviceId && this.#activeTalkbackDeviceId !== deviceId) {
      await this.stopTalkback(this.#activeTalkbackDeviceId);
    }
    if (this.#activePlaybackDeviceId && this.#activePlaybackDeviceId !== deviceId) {
      await this.stopPlayback(this.#activePlaybackDeviceId);
    }
    this.#model.selectedDeviceId = deviceId;
    await this.#saveCameraContext();
    return this.state();
  }

  /** Seed the device list from the persisted compatible-camera inventory so the
   * web interface shows every previously discovered camera at startup, before
   * (or without) a fresh network scan. Live discovery later replaces these
   * placeholder entries by id. */
  async #restoreDiscoveredInventory(): Promise<void> {
    const store = this.dependencies.inventoryStore;
    if (!store) return;
    let inventory: readonly InventoryCamera[];
    try {
      inventory = await store.load();
    } catch {
      return;
    }
    if (inventory.length === 0 || this.#model.devices.length > 0) return;
    this.#model.devices = inventory.map(inventoryDeviceView);
    if (!this.#model.selectedDeviceId) {
      this.#model.selectedDeviceId = this.#model.devices[0]?.id ?? null;
    }
    if (this.#model.discovery.status === "idle") {
      this.#model.discovery = {
        status: "ready",
        message: `Restored ${inventory.length} saved camera${inventory.length === 1 ? "" : "s"}. Scan to reconnect.`,
      };
    }
  }

  /** Persist every discovered compatible camera's non-secret config so the web
   * interface can list them after a restart without a fresh scan. A camera is
   * "compatible" when the adapter attached inventory metadata to it. */
  async #saveDiscoveredInventory(cameras: readonly ManagedCamera[]): Promise<void> {
    const store = this.dependencies.inventoryStore;
    if (!store) return;
    const inventory = cameras
      .map((camera) => camera.inventory)
      .filter((entry): entry is InventoryCamera => entry !== undefined);
    if (inventory.length === 0) return;
    try {
      // Merge, don't overwrite: these cameras answer the LAN broadcast
      // sporadically, so any single scan may miss one that is briefly asleep.
      // Keeping previously-seen cameras means the web interface lists all of
      // them. Then surface any known-but-not-live camera as an offline entry.
      const merged = await store.merge(inventory);
      const liveIds = new Set(this.#model.devices.map((device) => device.id));
      // Older inventory rows can carry a different id for a camera that is live
      // under its serial now; match on the LAN address too so one physical
      // camera never shows twice (once online, once as a stale offline entry).
      const liveHosts = new Set(this.#model.devices.map((device) => device.host).filter(Boolean));
      const liveSerials = new Set(this.#model.devices.map((device) => device.id));
      const offline = merged
        .filter((camera) => !liveIds.has(camera.id)
          && !liveHosts.has(camera.host)
          && !(camera.serialNumber && liveSerials.has(camera.serialNumber)))
        .map(inventoryDeviceView);
      if (offline.length > 0) this.#model.devices = [...this.#model.devices, ...offline];
    } catch {
      // Inventory persistence is a convenience cache; a write failure must not
      // fail discovery or hide the cameras that were just found.
    }
  }

  async #saveCameraContext(): Promise<void> {
    if (!this.#savedConfiguration || !this.dependencies.setupStore) return;
    const selectedDeviceId = this.#model.selectedDeviceId ?? undefined;
    // Only the account settings and the chosen camera are remembered. A
    // camera's address is per-camera state (devices.yml + inventory),
    // not a global setting, so it is never persisted here.
    const next: SavedCameraConfiguration = {
      setup: this.#savedConfiguration.setup,
      ...(selectedDeviceId ? { selectedDeviceId } : {}),
    };
    if (JSON.stringify(next) === JSON.stringify(this.#savedConfiguration)) return;
    await this.dependencies.setupStore.save(next);
    this.#savedConfiguration = next;
  }

  async control(input: CameraControlRequest): Promise<CameraDashboardModel> {
    const camera = this.camera(input.deviceId);
    const capability = camera.view.capabilities.find((candidate) => candidate.id === input.capabilityId);
    if (!capability || capability.availability !== "available") {
      throw new CameraServiceError("That control is not available on this camera", "not_supported");
    }
    if (capability.readOnly) {
      throw new CameraServiceError("That camera value is read-only", "not_supported");
    }
    if ((capability.dangerous || (capability.confirmation && capability.confirmation !== "none")) && !input.confirmed) {
      throw new CameraServiceError("Confirm this camera action before continuing", "confirmation_required");
    }
    validateControlValue(capability, input.value);

    try {
      await camera.controller.control(input.capabilityId, input.value, input.confirmed === true);
    } catch (error) {
      throw cameraCommandError(error);
    }
    if (!["action", "momentary", "ptz", "presets"].includes(capability.kind)
      && (input.value === null || ["boolean", "string", "number"].includes(typeof input.value))) {
      capability.value = input.value as boolean | string | number | null;
    }
    return this.state();
  }

  async ptz(input: CameraPtzRequest): Promise<CameraDashboardModel> {
    const camera = this.camera(input.deviceId);
    const capability = camera.view.capabilities.find((candidate) => candidate.kind === "ptz");
    if (!capability || capability.availability !== "available") {
      throw new CameraServiceError("Pan and tilt are not available on this camera", "not_supported");
    }
    const previousTimer = this.#ptzTimers.get(input.deviceId);
    if (previousTimer) clearTimeout(previousTimer);
    this.#ptzTimers.delete(input.deviceId);

    if (input.action === "stop") {
      try {
        await camera.controller.ptzStop();
      } catch (error) {
        throw cameraCommandError(error);
      }
      return this.state();
    }
    if (!input.direction) {
      throw new CameraServiceError("Choose a pan or tilt direction", "invalid_control");
    }

    try {
      await camera.controller.ptzStart(input.direction);
    } catch (error) {
      throw cameraCommandError(error);
    }
    const leaseMs = Math.min(Math.max(input.leaseMs ?? 900, 100), 3000);
    const timer = setTimeout(() => {
      this.#ptzTimers.delete(input.deviceId);
      void camera.controller.ptzStop().catch(() => undefined);
    }, leaseMs);
    this.#ptzTimers.set(input.deviceId, timer);
    return this.state();
  }

  async localCommand(
    deviceId: string,
    request: MeariCommonRequest,
    confirmed = false,
  ): Promise<MeariPeerCommandResponse> {
    const camera = this.camera(deviceId);
    if (request.action !== "GET" && request.action !== "POST") {
      throw new CameraServiceError("Local command action must be GET or POST", "invalid_control");
    }
    const path = localCommandPath(request.deviceurl);
    if (request.action === "POST" && LOCAL_COMMAND_CONFIRMATION_PATHS.has(path) && !confirmed) {
      throw new CameraServiceError("Confirm this local camera command before continuing", "confirmation_required");
    }
    if (!camera.controller.localCommand) {
      throw new CameraServiceError("This camera has no authenticated local command channel", "not_supported");
    }
    try {
      return await camera.controller.localCommand(request);
    } catch (error) {
      throw cameraCommandError(error);
    }
  }

  async localIot(
    deviceId: string,
    values: unknown,
    confirmed = false,
  ): Promise<Readonly<Record<string, unknown>>> {
    const camera = this.camera(deviceId);
    const normalized = localIotValues(values);
    const destructive = Object.keys(normalized).find((code) => isDestructiveCode(code));
    if (destructive && !confirmed) {
      throw new CameraServiceError(`Confirm local IoT code ${destructive} before continuing`, "confirmation_required");
    }
    if (!camera.controller.localIot) {
      throw new CameraServiceError("This camera has no local IoT write channel", "not_supported");
    }
    try {
      return await camera.controller.localIot(normalized);
    } catch (error) {
      throw cameraCommandError(error);
    }
  }

  async startTalkback(deviceId: string): Promise<CameraDashboardModel> {
    const camera = this.camera(deviceId);
    const capability = camera.view.capabilities.find((candidate) => candidate.id === "audio.talk");
    if (!capability || capability.availability !== "available" || !camera.talkback) {
      throw new CameraServiceError("Talkback is not available on this camera", "not_supported");
    }
    if (this.#activeTalkbackDeviceId && this.#activeTalkbackDeviceId !== deviceId) {
      await this.stopTalkback(this.#activeTalkbackDeviceId);
    }
    const existingStart = this.#talkbackStarts.get(deviceId);
    if (existingStart) {
      await existingStart;
      return this.state();
    }
    this.#cancelledTalkbackStarts.delete(deviceId);
    const start = camera.talkback.start();
    this.#talkbackStarts.set(deviceId, start);
    try {
      await start;
      if (this.#cancelledTalkbackStarts.has(deviceId)) {
        await camera.talkback.stop();
      } else {
        this.#activeTalkbackDeviceId = deviceId;
      }
    } catch (error) {
      throw cameraCommandError(error);
    } finally {
      if (this.#talkbackStarts.get(deviceId) === start) this.#talkbackStarts.delete(deviceId);
      this.#cancelledTalkbackStarts.delete(deviceId);
    }
    return this.state();
  }

  async sendTalkbackPcm(deviceId: string, pcm: Int16Array): Promise<void> {
    if (this.#activeTalkbackDeviceId !== deviceId) {
      throw new CameraServiceError("Hold Talk before sending microphone audio", "invalid_control");
    }
    const talkback = this.camera(deviceId).talkback;
    if (!talkback) throw new CameraServiceError("Talkback is not available on this camera", "not_supported");
    try {
      await talkback.sendPcm(pcm);
    } catch (error) {
      throw cameraCommandError(error);
    }
  }

  async stopTalkback(deviceId: string): Promise<CameraDashboardModel> {
    const camera = this.camera(deviceId);
    const starting = this.#talkbackStarts.get(deviceId);
    if (starting) {
      this.#cancelledTalkbackStarts.add(deviceId);
      try {
        await starting;
      } catch {
        return this.state();
      }
    }
    if (this.#activeTalkbackDeviceId !== deviceId) return this.state();
    try {
      await camera.talkback?.stop();
    } catch (error) {
      throw cameraCommandError(error);
    } finally {
      if (this.#activeTalkbackDeviceId === deviceId) this.#activeTalkbackDeviceId = undefined;
    }
    return this.state();
  }

  async startPlayback(
    deviceId: string,
    timestamp: string,
  ): Promise<ReadableStream<CameraPlaybackFrame>> {
    if (!/^\d{14}$/u.test(timestamp)) {
      throw new CameraServiceError("Playback time must use YYYYMMDDHHmmss", "invalid_control");
    }
    const camera = this.camera(deviceId);
    const capability = camera.view.capabilities.find((candidate) => candidate.id === "storage.playback");
    if (!capability || capability.availability !== "available" || !camera.playback) {
      throw new CameraServiceError("Local SD playback is not available on this camera", "not_supported");
    }
    if (this.#activePlaybackDeviceId) {
      await this.stopPlayback(this.#activePlaybackDeviceId);
    }
    try {
      const stream = await camera.playback.start(timestamp);
      this.#activePlaybackDeviceId = deviceId;
      return stream;
    } catch (error) {
      throw cameraCommandError(error);
    }
  }

  async controlPlayback(
    deviceId: string,
    action: "pause" | "resume" | "seek",
    timestamp?: string,
  ): Promise<CameraDashboardModel> {
    if (this.#activePlaybackDeviceId !== deviceId) {
      throw new CameraServiceError("Start local SD playback first", "invalid_control");
    }
    const playback = this.camera(deviceId).playback;
    if (!playback) throw new CameraServiceError("Local SD playback is not available", "not_supported");
    if (action === "seek" && (!timestamp || !/^\d{14}$/u.test(timestamp))) {
      throw new CameraServiceError("Playback time must use YYYYMMDDHHmmss", "invalid_control");
    }
    try {
      if (action === "pause") await playback.pause();
      else if (action === "resume") await playback.resume();
      else await playback.seek(timestamp as string);
    } catch (error) {
      throw cameraCommandError(error);
    }
    return this.state();
  }

  async stopPlayback(deviceId: string): Promise<CameraDashboardModel> {
    const camera = this.camera(deviceId);
    if (this.#activePlaybackDeviceId !== deviceId) return this.state();
    try {
      await camera.playback?.stop();
    } catch (error) {
      throw cameraCommandError(error);
    } finally {
      if (this.#activePlaybackDeviceId === deviceId) this.#activePlaybackDeviceId = undefined;
    }
    return this.state();
  }

  media(deviceId: string): CameraMediaSource {
    const media = this.camera(deviceId).media;
    if (!media) throw new CameraServiceError("Local video is not available for this camera", "not_supported");
    return { ...media };
  }

  private camera(deviceId: string): ManagedCamera {
    const camera = this.#cameras.get(deviceId);
    if (!camera) throw new CameraServiceError("Camera not found; run discovery again", "not_found");
    return camera;
  }
}
