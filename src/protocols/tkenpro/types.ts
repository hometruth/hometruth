export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** Values carried by Meari's IoT property map. JSON sub-objects are usually
 * encoded as strings by the vendor protocol, but reads may return parsed JSON. */
export type IotValue = JsonValue;
export type IotValues = Readonly<Record<string, IotValue>>;

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface MeariClock {
  now(): number;
}

export interface MeariRandomSource {
  /** Return a value in the same range as Math.random(): [0, 1). */
  next(): number;
}

export type SleepLike = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export interface MeariClientDependencies {
  fetch?: FetchLike;
  clock?: MeariClock | (() => number);
  random?: MeariRandomSource | (() => number);
  sleep?: SleepLike;
}

export type AppProfileName = "tkenpro" | "cloudedge";

export interface MeariAppProfile {
  readonly name: AppProfileName;
  readonly sourceApp: string;
  readonly partnerId: string;
  readonly appVer: string;
  readonly appVerCode: string;
  readonly redirectUrl: string;
  readonly ttid: string;
  readonly encryptedLogin: boolean;
  readonly iotType: string;
  readonly caKey: string;
  readonly caSecret: string;
}

export interface MeariCredentials {
  readonly email: string;
  readonly password: string;
  readonly countryCode?: string;
  readonly phoneCode?: string;
}

export interface MeariClientConfig extends MeariCredentials, MeariClientDependencies {
  readonly profile?: AppProfileName | MeariAppProfile;
  readonly language?: string;
  readonly requestTimeoutMs?: number;
  /** Also query joined/shared homes after the normal device-list request. */
  readonly includeSharedHomes?: boolean;
}

export interface MeariSession {
  readonly profile: AppProfileName;
  readonly apiServer: string;
  readonly userId: string;
  readonly clientId: string;
  readonly userToken: string;
  readonly countryCode: string;
  readonly phoneCode: string;
  readonly accessId: string;
  readonly accessKey: string;
  readonly openapiServer: string;
  readonly platformDomain: string;
  readonly mqttHost: string;
  readonly mqttPort: number;
  readonly mqttSignature: string;
}

export interface MeariDevice extends Record<string, unknown> {
  readonly deviceID?: string | number;
  readonly deviceName?: string;
  readonly snNum?: string;
  /** Per-device OpenAPI bearer returned by the device-list response. */
  readonly deviceSignature?: string;
  /** Per-device OpenAPI timestamp/version paired with deviceSignature. */
  readonly t?: string | number;
  readonly devTypeID?: string | number;
  readonly capability?: string | Record<string, unknown>;
  readonly msc?: unknown;
  readonly _category?: string;
  readonly _homeId?: string;
  readonly _home_id?: string;
}

export interface MeariLoginResult {
  readonly session: MeariSession;
  readonly devices: readonly MeariDevice[];
}

export type DeviceStatus =
  | "online"
  | "dormancy"
  | "offline"
  | "notfound"
  | "unknown"
  | (string & {});

export type PtzDirection = "left" | "right" | "up" | "down";

export interface PtzMoveOptions {
  /** Movement duration before the mandatory stop command. Defaults to 300 ms. */
  readonly durationMs?: number;
  /** Prefer the newer 841/842 command pair. Defaults to true. */
  readonly usePtz2?: boolean;
  /** Optional absolute motor speed (1-100). Vendor defaults are used if omitted. */
  readonly speed?: number;
  readonly signal?: AbortSignal;
}

export interface IotWriteOptions {
  /** Force direct-to-device delivery (omit target=server). */
  readonly direct?: boolean;
  /** Required literal for destructive data points. */
  readonly confirmation?: DestructiveConfirmation;
}

/** Legacy svc=3 ONVIF configuration written as the paired 121/122 properties. */
export interface OnvifConfiguration {
  readonly enabled: boolean;
  readonly password: string;
}

export interface TimeRange {
  readonly start: string;
  readonly end: string;
  readonly enabled?: boolean;
}

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type FeedPortions = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export interface FeedScheduleEntry {
  readonly id?: string | number;
  readonly time: string;
  readonly parts: FeedPortions;
  readonly enabled: boolean;
  readonly days?: readonly Weekday[];
}

export type FeedSchedule = readonly FeedScheduleEntry[];

export interface PtzPreset {
  readonly id: number;
  readonly name?: string;
}

export interface StorageInfo {
  readonly status: number | null;
  readonly capacity: string | null;
  readonly remaining: string | null;
  readonly recordingEnabled: boolean | null;
  readonly recordType: number | null;
  readonly recordDurationSeconds: number | null;
  readonly formatProgress: number | null;
  readonly raw: IotValues;
}

export type DestructiveConfirmation =
  | "FORMAT_STORAGE"
  | "DELETE_STORAGE_FILES"
  | "RESTORE_FACTORY_SETTINGS"
  | "RESET_DEVICE"
  | "HARD_RESET_DEVICE";
