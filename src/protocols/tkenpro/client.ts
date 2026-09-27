import {
  DESTRUCTIVE_IOT_CODES,
  IOT_CODES,
  PET3T_CONTROL_BY_ID,
  assertIotCode,
  decodeRecordDurationValue,
  defineSafeExtensionControl,
  encodeControlValue,
  encodeRecordDurationSeconds,
  type ControlDefinition,
  type SafeExtensionControl,
} from "../../devices/treat-dispensers/tkenpro-2k-pet-camera-treat-dispenser/controls.ts";
import {
  aesDecrypt,
  encodeUserAccount,
  encryptPassword,
  hmacSha1Base64,
  md5Hex,
  padBase64,
} from "./crypto.ts";
import {
  DestructiveControlError,
  DeviceOfflineError,
  MeariApiError,
  MeariAuthError,
  MeariSessionError,
} from "./errors.ts";
import { resolveAppProfile } from "./profiles.ts";
import { phoneCodeForCountry } from "./regions.ts";
import { encodeMeariSchedule } from "./schedule-codecs.ts";
import type {
  DestructiveConfirmation,
  DeviceStatus,
  FeedSchedule,
  FetchLike,
  IotValue,
  IotValues,
  IotWriteOptions,
  JsonValue,
  MeariAppProfile,
  MeariClientConfig,
  MeariClientDependencies,
  MeariClock,
  MeariCredentials,
  MeariDevice,
  MeariLoginResult,
  MeariRandomSource,
  MeariSession,
  OnvifConfiguration,
  PtzDirection,
  PtzMoveOptions,
  PtzPreset,
  SleepLike,
  StorageInfo,
} from "./types.ts";

const USER_AGENT =
  "Mozilla/5.0 (Linux; U; Android 14; en-us; Pixel Build/UP1A.231105.001) " +
  "AppleWebKit/533.1 (KHTML, like Gecko) Version/5.0 Mobile Safari/533.1";
const SUCCESS = "1001";
const SESSION_BUMPED = "1023";
const CAMERA_CATEGORIES = new Set([
  "ipc",
  "snap",
  "doorbell",
  "voicebell",
  "fourthgeneration",
  "cellular",
  "light",
  "picturedoorbell",
]);
const CATEGORY_NAMES = new Set([
  ...CAMERA_CATEGORIES,
  "nvr",
  "nvr-neutral",
  "base",
  "chime",
]);

const PTZ_VECTORS: Readonly<Record<PtzDirection, readonly [number, number]>> =
  Object.freeze({
    left: [-80, 0],
    right: [80, 0],
    up: [0, 20],
    down: [0, -20],
  });

type UnknownRecord = Record<string, unknown>;

/** Convert the full Meari serial number to its 16-character IoT UUID. */
export function formatSn(serialNumber: string): string {
  if (!serialNumber) return "";
  if (serialNumber.length === 9) return `0000000${serialNumber}`;
  return serialNumber.slice(4);
}

export function normalizeIotValues(value: unknown): IotValues {
  if (!isRecord(value)) return {};
  const normalized: Record<string, IotValue> = {};
  for (const [code, raw] of Object.entries(value)) {
    const candidate = isRecord(raw) && "value" in raw ? raw.value : raw;
    if (isIotValue(candidate)) normalized[code] = candidate;
  }
  return normalized;
}

export class MeariClient {
  readonly profile: MeariAppProfile;

  #email: string;
  #password: string;
  #countryCode: string;
  #phoneCode: string;
  #language: string;
  #includeSharedHomes: boolean;
  #requestTimeoutMs: number;
  #fetch: FetchLike;
  #now: () => number;
  #random: () => number;
  #sleep: SleepLike;
  #apiServer = "";
  #session: MeariSession | null = null;
  #devices: readonly MeariDevice[] = [];

  constructor(config: MeariClientConfig);
  constructor(
    credentials: MeariCredentials,
    dependencies?: MeariClientDependencies &
      Omit<MeariClientConfig, keyof MeariCredentials | keyof MeariClientDependencies>,
  );
  constructor(
    configOrCredentials: MeariClientConfig | MeariCredentials,
    dependencies: (MeariClientDependencies & Partial<MeariClientConfig>) | undefined =
      undefined,
  ) {
    const config: MeariClientConfig = dependencies
      ? { ...configOrCredentials, ...dependencies }
      : configOrCredentials;
    if (!config.email.trim()) throw new TypeError("email is required");
    if (!config.password) throw new TypeError("password is required");

    // The Android app normalizes the single email/phone account field before
    // encrypting it for both redirect and login.
    this.#email = config.email.trim().toLowerCase();
    this.#password = config.password;
    this.#countryCode = (config.countryCode ?? "US").trim().toUpperCase();
    this.#phoneCode = (config.phoneCode ?? phoneCodeForCountry(this.#countryCode) ?? "1")
      .trim()
      .replace(/^\+/, "");
    this.#language = config.language ?? "en";
    this.#includeSharedHomes = config.includeSharedHomes ?? true;
    this.#requestTimeoutMs = config.requestTimeoutMs ?? 30_000;
    this.profile = resolveAppProfile(config.profile);
    this.#fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = normalizeClock(config.clock);
    this.#random = normalizeRandom(config.random);
    this.#sleep = config.sleep ?? defaultSleep;
  }

  get session(): MeariSession | null {
    return this.#session;
  }

  get devices(): readonly MeariDevice[] {
    return this.#devices;
  }

  /** Redirect → encrypted login → IoT initialization → device discovery. */
  async login(): Promise<MeariLoginResult> {
    await this.redirect();
    await this.authenticate();
    await this.initializeIot();
    const devices = await this.listDevices();
    return { session: this.requireSession(), devices };
  }

  async redirect(): Promise<string> {
    const timestamp = this.#now();
    const path = "/ppstrongs/redirect";
    const params: Record<string, string> = {
      t: String(timestamp),
      localTime: String(timestamp),
      nonce: this.randomDigits(8),
      sign: md5Hex(`GET|${path}|${timestamp}|apis.meari.com.cn`),
      partnerId: this.profile.partnerId,
      phoneType: "a",
      sourceApp: this.profile.sourceApp,
      appVer: this.profile.appVer,
      appVerCode: this.profile.appVerCode,
      countryCode: this.#countryCode,
      phoneCode: this.#phoneCode,
      lngType: this.#language,
      userAccount: encodeUserAccount(
        this.#email,
        path,
        timestamp,
        this.profile.partnerId,
        this.profile.ttid,
      ),
    };
    const response = await this.requestJson(
      this.profile.redirectUrl,
      path,
      "GET",
      params,
      this.caHeaders(path),
    );
    assertResult(response, "Redirect");
    const result = recordAt(response, "result");
    const apiServer = stringAt(result, "apiServer");
    if (!apiServer) throw new MeariApiError("Redirect response omitted apiServer");
    this.#apiServer = stripTrailingSlash(apiServer);
    this.#countryCode = stringAt(result, "countryCode") || this.#countryCode;
    return this.#apiServer;
  }

  async authenticate(): Promise<MeariSession> {
    if (!this.#apiServer) throw new MeariApiError("Call redirect() before authenticate()");
    const path = "/meari/app/login";
    const timestamp = this.#now();
    const params: Record<string, string> = {
      phoneType: "a",
      sourceApp: this.profile.sourceApp,
      appVer: this.profile.appVer,
      appVerCode: this.profile.appVerCode,
      countryCode: this.#countryCode,
      phoneCode: this.#phoneCode,
      lngType: this.#language,
      t: String(timestamp),
      userAccount: encodeUserAccount(
        this.#email,
        path,
        timestamp,
        this.profile.partnerId,
        this.profile.ttid,
      ),
      localTime: String(timestamp),
      password: encryptPassword(this.#password),
      iotType: this.profile.iotType,
      equipmentNo: " ",
    };
    if (this.profile.encryptedLogin) params.encryStatus = "1";
    if (this.#countryCode === "CN") params.limitSwitch = "1";

    const response = await this.requestJson(
      this.#apiServer,
      path,
      "POST",
      params,
      this.caHeaders(path),
    );
    const resultCode = String(response.resultCode ?? "");
    if (resultCode !== SUCCESS) {
      if (resultCode === SESSION_BUMPED) {
        throw new MeariSessionError("The Meari session was replaced by another login", resultCode);
      }
      throw new MeariAuthError("Authentication failed", resultCode || undefined);
    }
    const result = recordAt(response, "result");
    const userToken = stringAt(result, "userToken");
    const userId = String(result.userID ?? "");
    if (!userToken || !userId) {
      throw new MeariAuthError("Authentication response omitted session credentials");
    }
    this.#countryCode = stringAt(result, "countryCode") || this.#countryCode;
    this.#phoneCode = stringAt(result, "phoneCode") || this.#phoneCode;

    const initial: MeariSession = {
      profile: this.profile.name,
      apiServer: this.#apiServer,
      userId,
      clientId: stringAt(result, "clientId").trim(),
      userToken,
      countryCode: this.#countryCode,
      phoneCode: this.#phoneCode,
      accessId: "",
      accessKey: "",
      openapiServer: "",
      platformDomain: "",
      mqttHost: "",
      mqttPort: 1883,
      mqttSignature: "",
    };
    this.#session = this.applyLoginIot(initial, result);
    this.#session = this.applyPlatformDefaults(this.#session);
    return this.#session;
  }

  async initializeIot(options: { readonly refresh?: boolean } = {}): Promise<MeariSession> {
    const session = this.requireSession();
    const response = await this.apiGet("/v2/app/config/pf/init", {
      iotType: this.profile.iotType,
      ...(options.refresh ? { refresh: "1" } : {}),
    });
    const resultCode = String(response.resultCode ?? "");
    if (resultCode === SESSION_BUMPED) {
      // Some Meari regions return 1023 here while the freshly issued token and
      // pfKey from login remain usable. Preserve those credentials.
      this.#session = this.applyPlatformDefaults(session);
      return this.#session;
    }
    if (resultCode !== SUCCESS) {
      throw new MeariApiError("IoT initialization failed", resultCode || undefined);
    }
    const result = recordAt(response, "result");
    const pfApi = recordAt(result, "pfApi");
    const openapi = recordAt(pfApi, "openapi");
    const mqtt = recordAt(pfApi, "mqtt");
    const platform = recordAt(pfApi, "platform");

    let accessId = session.accessId;
    let accessKey = session.accessKey;
    const signature = stringAt(platform, "signature");
    const expireTime = String(platform.expireTime ?? "");
    if (signature && expireTime) {
      try {
        const keyMaterial = `${session.userId}${this.profile.partnerId}${this.profile.ttid}${expireTime}`;
        const key = Buffer.from(keyMaterial, "utf8").toString("base64").replace(/=+$/u, "").slice(0, 16);
        const decrypted = aesDecrypt(signature, key);
        const encodedInfo = decrypted.split("-", 1)[0];
        if (encodedInfo) {
          const info = JSON.parse(Buffer.from(padBase64(encodedInfo), "base64").toString("utf8")) as unknown;
          if (isRecord(info)) {
            accessId = stringAt(info, "accessid") || accessId;
            accessKey = stringAt(info, "accesskey") || accessKey;
          }
        }
      } catch {
        // Recent app profiles already return pfKey in the login response. A
        // stale platform signature must not erase those working credentials.
      }
    }

    const mqttPort = positiveInteger(mqtt.port) ?? session.mqttPort;
    this.#session = this.applyPlatformDefaults({
      ...session,
      accessId,
      accessKey,
      openapiServer: stringAt(openapi, "domain") || session.openapiServer,
      platformDomain: stringAt(platform, "domain") || session.platformDomain,
      mqttHost: stringAt(mqtt, "host") || session.mqttHost,
      mqttPort,
      mqttSignature: stringAt(pfApi, "mqttSignature") || session.mqttSignature,
    });
    return this.#session;
  }

  async listDevices(options: { readonly includeSharedHomes?: boolean } = {}): Promise<readonly MeariDevice[]> {
    this.requireSession();
    const byId = new Map<string, MeariDevice>();
    let defaultFailure: MeariApiError | null = null;

    try {
      const response = await this.apiPost("/v1/app/device/info/get", { funSwitch: "1" });
      this.assertSessionResult(response, "Device listing");
      collectDevices(response, byId);
    } catch (error) {
      if (error instanceof MeariSessionError) throw error;
      defaultFailure = error instanceof MeariApiError
        ? error
        : new MeariApiError("Device listing failed", undefined, { cause: error });
    }

    const includeHomes = options.includeSharedHomes ?? this.#includeSharedHomes;
    if (includeHomes) {
      try {
        const homesResponse = await this.apiGet("/v1/app/home/list");
        this.assertSessionResult(homesResponse, "Home listing");
        const homes = arrayAt(recordAt(homesResponse, "result"), "homes");
        for (const rawHome of homes) {
          if (!isRecord(rawHome)) continue;
          const homeId = String(rawHome.homeID ?? "");
          if (!homeId) continue;
          try {
            const response = await this.apiGet("/v1/app/home/join/device/list", {
              homeID: homeId,
              funSwitch: "1",
            });
            const code = String(response.resultCode ?? "");
            if (code !== SUCCESS && code !== "1107") continue;
            collectDevices(response, byId, homeId);
          } catch (error) {
            if (error instanceof MeariSessionError) throw error;
          }
        }
      } catch (error) {
        if (error instanceof MeariSessionError) throw error;
        // Shared-home discovery is augmentation; owner-device discovery still
        // succeeds on regions that do not implement the home endpoints.
      }
    }

    if (byId.size === 0 && defaultFailure) throw defaultFailure;
    this.#devices = Object.freeze([...byId.values()]);
    return this.#devices;
  }

  getCameraDevices(): readonly MeariDevice[] {
    return this.#devices.filter((device) =>
      CAMERA_CATEGORIES.has(String(device._category ?? "").toLowerCase()),
    );
  }

  getSnapDevices(): readonly MeariDevice[] {
    return this.#devices.filter((device) => device._category === "snap");
  }

  async getAllIotValues(serialNumber: string): Promise<IotValues> {
    const response = await this.iotRequest(serialNumber, "get", undefined, true);
    return normalizeIotValues(response.iot);
  }

  async getIotValues(
    serialNumber: string,
    codes: readonly (string | number)[],
  ): Promise<IotValues> {
    if (codes.length === 0) return {};
    const normalized = codes.map((code) => {
      assertIotCode(code);
      return String(code);
    });
    const response = await this.iotRequest(serialNumber, "get", normalized, false);
    return normalizeIotValues(response.iot);
  }

  /** Compatibility alias matching the reference client's naming. */
  getDeviceIotValues(serialNumber: string, codes: readonly (string | number)[]): Promise<IotValues> {
    return this.getIotValues(serialNumber, codes);
  }

  getDeviceIotConfig(serialNumber: string): Promise<IotValues> {
    return this.getAllIotValues(serialNumber);
  }

  async setIotValue(
    serialNumber: string,
    code: string | number,
    value: IotValue,
    options: IotWriteOptions = {},
  ): Promise<UnknownRecord> {
    return this.setIotValues(serialNumber, { [String(code)]: value }, options);
  }

  /** Compatibility alias matching the reference client's naming. */
  setDeviceIotValue(
    serialNumber: string,
    code: string | number,
    value: IotValue,
    options: IotWriteOptions = {},
  ): Promise<UnknownRecord> {
    return this.setIotValue(serialNumber, code, value, options);
  }

  async setIotValues(
    serialNumber: string,
    values: IotValues,
    options: IotWriteOptions = {},
  ): Promise<UnknownRecord> {
    const normalized: Record<string, IotValue> = {};
    for (const [code, value] of Object.entries(values)) {
      assertIotCode(code);
      this.assertDestructiveConfirmation(code, options.confirmation);
      if (!isIotValue(value)) throw new TypeError(`IoT ${code} has a non-JSON value`);
      normalized[code] = value;
    }
    if (Object.keys(normalized).length === 0) throw new TypeError("At least one IoT value is required");
    const inferredDirect = Object.keys(normalized).some(isDirectActionCode);
    return this.iotRequest(serialNumber, "set", normalized, !(options.direct ?? inferredDirect));
  }

  async getIotBatch(
    serialNumbers: readonly string[],
    codes: readonly (string | number)[],
  ): Promise<Readonly<Record<string, IotValues>>> {
    if (serialNumbers.length === 0 || codes.length === 0) return {};
    const codeList = codes.map((code) => {
      assertIotCode(code);
      return String(code);
    }).join(",");
    const identifiers = Object.fromEntries(serialNumbers.map((serial) => [serial, codeList]));
    const response = await this.apiGet("/v2/app/iot/model/get/batch", {
      snIdentifier: JSON.stringify(identifiers),
    });
    this.assertSessionResult(response, "Batch IoT read");
    const result = recordAt(response, "result");
    return Object.freeze(Object.fromEntries(
      Object.entries(result).map(([serial, values]) => [serial, normalizeIotValues(values)]),
    ));
  }

  async getDeviceStatus(serialNumber: string): Promise<DeviceStatus> {
    const response = await this.openapiRequest(
      "/openapi/device/status",
      "query",
      { deviceid: formatSn(serialNumber) },
    );
    if (hasApiError(response)) return "offline";
    return typeof response.status === "string" ? response.status : "unknown";
  }

  async getFirmwareUpgradeInfo(
    serialNumber: string,
    firmwareCode: string,
    deviceType: string,
  ): Promise<UnknownRecord> {
    if (!serialNumber.trim()) throw new TypeError("serialNumber is required");
    if (!firmwareCode.trim()) throw new TypeError("firmwareCode is required");
    if (!deviceType.trim()) throw new TypeError("deviceType is required");
    const response = await this.apiGet("/v3/app/device/upgrade/version/get", {
      licenseID: serialNumber,
      tp: deviceType,
      versionID: firmwareCode,
    });
    this.assertSessionResult(response, "Firmware upgrade lookup");
    return recordAt(response, "result");
  }

  async wakeDevice(serialNumber: string): Promise<UnknownRecord> {
    const deviceId = formatSn(serialNumber);
    const sid = `${deviceId}${this.#now()}`.slice(0, 30);
    return this.openapiRequest("/openapi/device/awaken", "set", {
      deviceid: deviceId,
      sid,
    });
  }

  async ptzStart(
    serialNumber: string,
    direction: PtzDirection,
    options: Pick<PtzMoveOptions, "usePtz2" | "speed"> = {},
  ): Promise<UnknownRecord> {
    const vector = PTZ_VECTORS[direction];
    if (!vector) throw new RangeError(`Unsupported PTZ direction: ${String(direction)}`);
    const [defaultPan, defaultTilt] = vector;
    const speed = options.speed;
    if (speed !== undefined && (!Number.isInteger(speed) || speed < 1 || speed > 100)) {
      throw new RangeError("PTZ speed must be an integer from 1 to 100");
    }
    const ps = speed === undefined ? defaultPan : Math.round(Math.sign(defaultPan) * speed);
    const ts = speed === undefined ? defaultTilt : Math.round(Math.sign(defaultTilt) * speed);
    const code = (options.usePtz2 ?? true) ? IOT_CODES.PTZ2_START : IOT_CODES.PTZ_START;
    return this.setIotValue(
      serialNumber,
      code,
      JSON.stringify({ ps, ts, zs: 0 }),
      { direct: true },
    );
  }

  async ptzStop(
    serialNumber: string,
    options: Pick<PtzMoveOptions, "usePtz2"> = {},
  ): Promise<UnknownRecord> {
    const code = (options.usePtz2 ?? true) ? IOT_CODES.PTZ2_STOP : IOT_CODES.PTZ_STOP;
    return this.setIotValue(serialNumber, code, "{}", { direct: true });
  }

  /** Start movement and guarantee a matching stop, including abort/error paths. */
  async movePtz(
    serialNumber: string,
    direction: PtzDirection,
    options: PtzMoveOptions = {},
  ): Promise<void> {
    const durationMs = options.durationMs ?? 300;
    if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 30_000) {
      throw new RangeError("PTZ duration must be between 0 and 30000 ms");
    }
    const movementOptions: Pick<PtzMoveOptions, "usePtz2" | "speed"> = {
      ...(options.usePtz2 === undefined ? {} : { usePtz2: options.usePtz2 }),
      ...(options.speed === undefined ? {} : { speed: options.speed }),
    };
    await this.ptzStart(serialNumber, direction, movementOptions);
    try {
      await this.#sleep(durationMs, options.signal);
    } finally {
      await this.ptzStop(serialNumber, movementOptions);
    }
  }

  /**
   * Dispense one treat. CloudEdge's feeder panel also has a portioned action
   * (`PET_FEED` with a `{"parts": n}` JSON string) but on this hardware it does
   * not reliably deliver more than one portion, so HomeTruth only ever sends
   * the single-portion command; call it again for another treat.
   */
  async feed(serialNumber: string): Promise<UnknownRecord> {
    return this.dispenseOnePortion(serialNumber);
  }

  /** Match the compact treat button in CloudEdge's live-view screen. */
  dispenseOnePortion(serialNumber: string): Promise<UnknownRecord> {
    return this.setIotValue(serialNumber, IOT_CODES.PET_FEED_LEGACY, 1, { direct: true });
  }

  feedOnePortion(serialNumber: string): Promise<UnknownRecord> {
    return this.dispenseOnePortion(serialNumber);
  }

  feedOne(serialNumber: string): Promise<UnknownRecord> {
    return this.feed(serialNumber);
  }

  setFeedSound(serialNumber: string, url: string): Promise<UnknownRecord> {
    return this.setIotValue(
      serialNumber,
      IOT_CODES.PET_SOUND_SET,
      JSON.stringify({ url }),
      { direct: true },
    );
  }

  setPetSound(serialNumber: string, url: string): Promise<UnknownRecord> {
    return this.setFeedSound(serialNumber, url);
  }

  setPetCallSound(serialNumber: string, url: string): Promise<UnknownRecord> {
    return this.setIotValue(
      serialNumber,
      IOT_CODES.PET_SOUND_CALL,
      JSON.stringify({ url }),
      { direct: true },
    );
  }

  playFeedCall(serialNumber: string): Promise<UnknownRecord> {
    return this.setIotValue(serialNumber, IOT_CODES.PET_FEED_CALL, 1, { direct: true });
  }

  feedCall(serialNumber: string): Promise<UnknownRecord> {
    return this.playFeedCall(serialNumber);
  }

  /** Match CloudEdge's PET3T “Watch bowl” shortcut (property 868 = 1). */
  watchFoodBowl(serialNumber: string): Promise<UnknownRecord> {
    return this.setIotValue(serialNumber, IOT_CODES.WATCH_BOWL, 1, { direct: true });
  }

  watchBowl(serialNumber: string): Promise<UnknownRecord> {
    return this.watchFoodBowl(serialNumber);
  }

  setFeedSchedule(serialNumber: string, schedule: FeedSchedule): Promise<UnknownRecord> {
    return this.setJsonSetting(serialNumber, IOT_CODES.PET_FEED_PLAN_LIST, encodeMeariSchedule("feed-times", schedule));
  }

  setFoodDetection(
    serialNumber: string,
    setting: { readonly enable: boolean | 0 | 1; readonly start_time: string; readonly stop_time: string },
  ): Promise<UnknownRecord> {
    return this.setJsonSetting(serialNumber, IOT_CODES.FOOD_DETECTION, setting);
  }

  setDesiccantInfo(serialNumber: string, info: JsonValue): Promise<UnknownRecord> {
    return this.setJsonSetting(serialNumber, IOT_CODES.DESICCANT_INFO, info);
  }

  setFeedWarning(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setDispenseSound(serialNumber, enabled);
  }

  setDispenseSound(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.FEED_SOUND_ENABLE, enabled);
  }

  setPetAlarm(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.PET_ALARM_ENABLE, enabled);
  }

  setPetMeow(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setPetCatAlarm(serialNumber, enabled);
  }

  setPetDogAlarm(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.PET_DOG_ALARM_ENABLE, enabled);
  }

  setPetCatAlarm(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.PET_CAT_ALARM_ENABLE, enabled);
  }

  setAllAlarms(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.ALL_ALARMS_ENABLE, enabled);
  }

  setCameraActive(serialNumber: string, active: boolean): Promise<UnknownRecord> {
    return this.setIotValue(serialNumber, IOT_CODES.SLEEP_MODE, active ? 0 : 1);
  }

  setPrivacyMode(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setIotValue(serialNumber, IOT_CODES.SLEEP_MODE, enabled ? 2 : 0);
  }

  setCameraLensControl(
    serialNumber: string,
    command: { readonly focus?: number; readonly scale?: number; readonly stop?: 1 },
  ): Promise<UnknownRecord> {
    const fields = Object.keys(command);
    if (fields.length !== 1 || !fields.every((field) => field === "focus" || field === "scale" || field === "stop")) {
      throw new TypeError("Lens control expects exactly one of focus, scale, or stop");
    }
    return this.setIotValue(serialNumber, IOT_CODES.CAMERA_CONTROL, JSON.stringify(command), { direct: true });
  }

  setStatusLed(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.LED_ENABLE, enabled);
  }

  setImageRotated(serialNumber: string, rotated: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.ROTATE_ENABLE, rotated);
  }

  setRecording(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.RECORD_SWITCH, enabled);
  }

  setMotionDetection(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.MOTION_DET_ENABLE, enabled);
  }

  setMotionSensitivity(serialNumber: string, sensitivity: number): Promise<UnknownRecord> {
    return this.setRangedNumber(serialNumber, IOT_CODES.MOTION_DET_SENSITIVITY, sensitivity, 1, 5, "Motion sensitivity");
  }

  setPersonDetection(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.HUMAN_DET_ENABLE, enabled);
  }

  setSoundDetection(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.SOUND_DET_ENABLE, enabled);
  }

  setSoundSensitivity(serialNumber: string, sensitivity: number): Promise<UnknownRecord> {
    return this.setRangedNumber(serialNumber, IOT_CODES.SOUND_DET_SENSITIVITY, sensitivity, 0, 2, "Sound sensitivity");
  }

  setCryDetection(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.CRY_DET_ENABLE, enabled);
  }

  setHumanFrame(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.HUMAN_FRAME_ENABLE, enabled);
  }

  setFaceRecognition(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.FACE_RECOGNITION_SWITCH, enabled);
  }

  setAbnormalNoiseDetection(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.ABNORMAL_NOISE_ENABLE, enabled);
  }

  setAlarmFrequency(serialNumber: string, frequency: 0 | 1 | 2): Promise<UnknownRecord> {
    return this.setIotValue(serialNumber, IOT_CODES.ALARM_FREQUENCY, frequency);
  }

  setHumanTracking(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.HUMAN_TRACK_ENABLE, enabled);
  }

  setPirDetection(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.PIR_DET_ENABLE, enabled);
  }

  setPirSensitivity(serialNumber: string, sensitivity: number): Promise<UnknownRecord> {
    return this.setRangedNumber(serialNumber, IOT_CODES.PIR_DET_SENSITIVITY, sensitivity, 1, 10, "PIR sensitivity");
  }

  setPirTriggerInterval(serialNumber: string, seconds: number): Promise<UnknownRecord> {
    void serialNumber;
    throw new RangeError(`PIR trigger interval is not a PET3T property (received ${seconds})`);
  }

  setSpeakerVolume(serialNumber: string, volume: number): Promise<UnknownRecord> {
    return this.setRangedNumber(serialNumber, IOT_CODES.SPEAK_VOLUME, volume, 0, 100, "Speaker volume");
  }

  setSpeakerEnabled(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.SPEAKER_ENABLE, enabled);
  }

  setMicrophoneEnabled(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.MICROPHONE_ENABLE, enabled);
  }

  setSoundEnabled(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.SOUND_SWITCH, enabled);
  }

  setSoundVolume(serialNumber: string, volume: number): Promise<UnknownRecord> {
    return this.setRangedNumber(serialNumber, IOT_CODES.SOUND_SET, volume, 0, 100, "Sound volume");
  }

  setDayNightMode(serialNumber: string, mode: 0 | 1 | 2): Promise<UnknownRecord> {
    return this.setIotValue(serialNumber, IOT_CODES.DAY_NIGHT_MODE, mode);
  }

  setFullColorMode(serialNumber: string, mode: 0 | 1): Promise<UnknownRecord> {
    return this.setIotValue(serialNumber, IOT_CODES.FULL_COLOR_MODE, mode);
  }

  setInfraredLight(serialNumber: string, mode: 0 | 1 | 2): Promise<UnknownRecord> {
    return this.setIotValue(serialNumber, IOT_CODES.INFRARED_LIGHT, mode);
  }

  setH265(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.H265_ENABLE, enabled);
  }

  /**
   * Configure ONVIF on legacy svc=3 cameras. The firmware expects properties
   * 121 and 122 in the same write, with the password encoded as standard Base64.
   */
  configureOnvif(
    serialNumber: string,
    configuration: OnvifConfiguration,
  ): Promise<UnknownRecord> {
    if (!configuration || typeof configuration !== "object") {
      throw new TypeError("ONVIF configuration is required");
    }
    if (typeof configuration.enabled !== "boolean") {
      throw new TypeError("ONVIF enabled must be a boolean");
    }
    const password = encodeLegacyOnvifPassword(configuration.password);
    return this.setIotValues(serialNumber, {
      [IOT_CODES.ONVIF_ENABLE]: configuration.enabled ? 1 : 0,
      [IOT_CODES.ONVIF_PASSWORD]: password,
    });
  }

  /**
   * Change only the ONVIF enable flag. This compatibility method assumes an
   * ONVIF password has already been configured; use configureOnvif for setup.
   */
  setOnvif(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.ONVIF_ENABLE, enabled);
  }

  setOsd(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.OSD_ENABLE, enabled);
  }

  setLogoWatermark(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.LOGO_SWITCH, enabled);
  }

  setAntiFlicker(serialNumber: string, hertz: 50 | 60): Promise<UnknownRecord> {
    return this.setIotValue(serialNumber, IOT_CODES.ANTI_FLICKER, hertz === 50 ? 0 : 1);
  }

  setFrameRate(serialNumber: string, framesPerSecond: number): Promise<UnknownRecord> {
    return this.setRangedNumber(serialNumber, IOT_CODES.FRAME_RATE, framesPerSecond, 1, 60, "Frame rate");
  }

  setAutomaticUpdates(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.AUTO_UPDATE, enabled);
  }

  setAntiJamming(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.ANTI_JAMMING, enabled);
  }

  setKeyVoice(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    void serialNumber;
    throw new RangeError(`Button-sound control is not a PET3T property (received ${enabled})`);
  }

  setPowerOnVoice(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.POWER_ON_VOICE_ENABLE, enabled);
  }

  setPowerOnVolume(serialNumber: string, volume: number): Promise<UnknownRecord> {
    return this.setRangedNumber(serialNumber, IOT_CODES.POWER_ON_VOLUME, volume, 0, 100, "Startup volume");
  }

  setCoverDetection(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.COVER_DET_ENABLE, enabled);
  }

  setSmartDetection(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.SMART_DET, enabled);
  }

  setSmartDetectionFrame(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.SMART_DET_FRAME, enabled);
  }

  setSmartDetectionSensitivity(serialNumber: string, sensitivity: number): Promise<UnknownRecord> {
    return this.setRangedNumber(serialNumber, IOT_CODES.SMART_DET_SENSITIVITY, sensitivity, 1, 5, "Smart-detection sensitivity");
  }

  setStorageRecordDuration(serialNumber: string, seconds: number): Promise<UnknownRecord> {
    return this.setIotValue(serialNumber, IOT_CODES.SD_RECORD_DURATION, encodeRecordDurationSeconds(seconds));
  }

  startPtzPatrol(serialNumber: string): Promise<UnknownRecord> {
    return this.setIotValue(serialNumber, IOT_CODES.PTZ_PATROL, "{}", { direct: true });
  }

  setPtzPatrol(serialNumber: string, enabled = true): Promise<UnknownRecord> {
    if (!enabled) throw new RangeError("PET3T exposes PTZ patrol as a start action, not an on/off switch");
    return this.startPtzPatrol(serialNumber);
  }

  setTimedPtzPatrol(serialNumber: string, schedule: JsonValue): Promise<UnknownRecord> {
    return this.setJsonSetting(serialNumber, IOT_CODES.TIMED_PTZ_PATROL, encodeMeariSchedule("patrol-times", schedule));
  }

  setFloodlight(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.FLOODLIGHT_SWITCH, enabled);
  }

  setFloodlightBrightness(serialNumber: string, brightness: number): Promise<UnknownRecord> {
    return this.setRangedNumber(serialNumber, IOT_CODES.FLOODLIGHT_BRIGHTNESS, brightness, 1, 100, "Floodlight brightness");
  }

  setWarmLightBrightness(serialNumber: string, brightness: number): Promise<UnknownRecord> {
    return this.setRangedNumber(serialNumber, IOT_CODES.WARM_LIGHT_BRIGHTNESS, brightness, 1, 100, "Warm-light brightness");
  }

  setFloodlightLink(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.FLOODLIGHT_LINK_ENABLE, enabled);
  }

  setSirenLink(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.SIREN_LINK_ENABLE, enabled);
  }

  setSoundLightAlarm(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.SOUND_LIGHT_ENABLE, enabled);
  }

  setSoundLightType(serialNumber: string, type: 0 | 1 | 2): Promise<UnknownRecord> {
    return this.setIotValue(serialNumber, IOT_CODES.SOUND_LIGHT_TYPE, type);
  }

  setRgbLight(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.RGB_LIGHT_SWITCH, enabled);
  }

  setRgbColor(serialNumber: string, rgb: number): Promise<UnknownRecord> {
    assertIntegerRange(rgb, 0, 0xffffff, "RGB color");
    const red = (rgb >>> 16) & 0xff;
    const green = (rgb >>> 8) & 0xff;
    const blue = rgb & 0xff;
    return this.setIotValue(serialNumber, IOT_CODES.RGB_LIGHT_COLOR, JSON.stringify([red, green, blue]));
  }

  setLaser(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.LASER_SWITCH, enabled);
  }

  setTeaseMode(serialNumber: string, mode: 0 | 1): Promise<UnknownRecord> {
    return this.setIotValue(serialNumber, IOT_CODES.TEASE_MODE, mode);
  }

  setTeaseDuration(serialNumber: string, minutes: number): Promise<UnknownRecord> {
    return this.setRangedNumber(serialNumber, IOT_CODES.TEASE_DURATION, minutes, 1, 60, "Tease duration");
  }

  setSleepSchedule(serialNumber: string, schedule: JsonValue): Promise<UnknownRecord> {
    return this.setJsonSetting(serialNumber, IOT_CODES.SLEEP_TIME_LIST, encodeMeariSchedule("weekly-intervals", schedule));
  }

  setAlarmSchedule(serialNumber: string, schedule: JsonValue): Promise<UnknownRecord> {
    return this.setJsonSetting(serialNumber, IOT_CODES.ALARM_PLAN_LIST, encodeMeariSchedule("weekly-intervals", schedule));
  }

  setRecordingSchedule(serialNumber: string, schedule: JsonValue): Promise<UnknownRecord> {
    return this.setJsonSetting(serialNumber, IOT_CODES.TIMING_RECORD, encodeMeariSchedule("weekly-intervals", schedule));
  }

  setSmartDetectionSchedule(serialNumber: string, schedule: JsonValue): Promise<UnknownRecord> {
    return this.setJsonSetting(serialNumber, IOT_CODES.SMART_DET_DEPLOYMENT_TIME, encodeMeariSchedule("deployment-intervals", schedule));
  }

  setMonitoringSchedule(serialNumber: string, schedule: JsonValue): Promise<UnknownRecord> {
    void serialNumber;
    throw new RangeError(`Monitoring schedule is not a PET3T property (received ${JSON.stringify(schedule)})`);
  }

  setMonitoringScheduleEnabled(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    void serialNumber;
    throw new RangeError(`Monitoring schedule is not a PET3T property (received ${enabled})`);
  }

  setTemperatureHumidityAlarm(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setToggle(serialNumber, IOT_CODES.TEMP_HUMIDITY_ALARM_ENABLE, enabled);
  }

  setTemperatureMaximum(serialNumber: string, celsius: number): Promise<UnknownRecord> {
    return this.setEnvironmentThreshold(serialNumber, IOT_CODES.TEMPERATURE_MAX, celsius, 40, "Maximum temperature");
  }

  setTemperatureMinimum(serialNumber: string, celsius: number): Promise<UnknownRecord> {
    return this.setEnvironmentThreshold(serialNumber, IOT_CODES.TEMPERATURE_MIN, celsius, 40, "Minimum temperature");
  }

  setHumidityMaximum(serialNumber: string, relativeHumidity: number): Promise<UnknownRecord> {
    return this.setEnvironmentThreshold(serialNumber, IOT_CODES.HUMIDITY_MAX, relativeHumidity, 100, "Maximum humidity");
  }

  setHumidityMinimum(serialNumber: string, relativeHumidity: number): Promise<UnknownRecord> {
    return this.setEnvironmentThreshold(serialNumber, IOT_CODES.HUMIDITY_MIN, relativeHumidity, 100, "Minimum humidity");
  }

  setTeaseSchedule(serialNumber: string, schedule: JsonValue): Promise<UnknownRecord> {
    return this.setJsonSetting(serialNumber, IOT_CODES.TEASE_PLAN, encodeMeariSchedule("tease-times", schedule));
  }

  setFloodlightSchedule(serialNumber: string, schedule: JsonValue): Promise<UnknownRecord> {
    return this.setJsonSetting(serialNumber, IOT_CODES.FLOODLIGHT_SCHEDULE, encodeMeariSchedule("daily-window", schedule));
  }

  setSoundLightSchedule(serialNumber: string, schedule: JsonValue): Promise<UnknownRecord> {
    return this.setJsonSetting(serialNumber, IOT_CODES.SOUND_LIGHT_ALARM_PLAN_LIST, encodeMeariSchedule("weekly-intervals", schedule));
  }

  setRgbSchedule(serialNumber: string, schedule: JsonValue): Promise<UnknownRecord> {
    return this.setJsonSetting(serialNumber, IOT_CODES.RGB_LIGHT_TIMING, encodeMeariSchedule("daily-window", schedule));
  }

  setDetectionRegion(serialNumber: string, region: JsonValue): Promise<UnknownRecord> {
    return this.setJsonSetting(serialNumber, IOT_CODES.ROI, region);
  }

  setPolygonDetectionRegion(serialNumber: string, region: JsonValue): Promise<UnknownRecord> {
    return this.setJsonSetting(serialNumber, IOT_CODES.POLYGON_ROI, region);
  }

  setPrivacyMask(serialNumber: string, mask: JsonValue): Promise<UnknownRecord> {
    return this.setJsonSetting(serialNumber, IOT_CODES.POLYGON_PRIVACY, mask);
  }

  setCameraLinkage(serialNumber: string, rules: JsonValue): Promise<UnknownRecord> {
    return this.setJsonSetting(serialNumber, IOT_CODES.CAMERA_LINKAGE, rules);
  }

  calibratePtz(serialNumber: string): Promise<UnknownRecord> {
    return this.setIotValue(serialNumber, IOT_CODES.PTZ_CALIBRATION, 1, { direct: true });
  }

  ptzCalibrate(serialNumber: string): Promise<UnknownRecord> {
    return this.calibratePtz(serialNumber);
  }

  setPtzPreset(serialNumber: string, preset: PtzPreset): Promise<UnknownRecord> {
    assertPreset(preset);
    void serialNumber;
    throw new RangeError("PET3T preset creation does not use IoT property 848; use local ONVIF preset control");
  }

  goToPtzPreset(serialNumber: string, id: number): Promise<UnknownRecord> {
    assertIntegerRange(id, 1, 255, "Preset ID");
    return this.presetCommand(serialNumber, { idx: id });
  }

  deletePtzPreset(serialNumber: string, id: number): Promise<UnknownRecord> {
    assertIntegerRange(id, 1, 255, "Preset ID");
    void serialNumber;
    throw new RangeError("PET3T preset deletion does not use IoT property 848; use local ONVIF preset control");
  }

  async getStorageInfo(serialNumber: string): Promise<StorageInfo> {
    const raw = await this.getIotValues(serialNumber, [
      IOT_CODES.SD_STATUS,
      IOT_CODES.SD_CAPACITY,
      IOT_CODES.SD_REMAINING_CAPACITY,
      IOT_CODES.RECORD_SWITCH,
      IOT_CODES.SD_RECORD_TYPE,
      IOT_CODES.SD_RECORD_DURATION,
      IOT_CODES.SD_FORMAT_PROGRESS,
    ]);
    return {
      status: nullableNumber(raw[IOT_CODES.SD_STATUS]),
      capacity: nullableString(raw[IOT_CODES.SD_CAPACITY]),
      remaining: nullableString(raw[IOT_CODES.SD_REMAINING_CAPACITY]),
      recordingEnabled: nullableBoolean(raw[IOT_CODES.RECORD_SWITCH]),
      recordType: nullableNumber(raw[IOT_CODES.SD_RECORD_TYPE]),
      recordDurationSeconds: decodeRecordDurationValue(raw[IOT_CODES.SD_RECORD_DURATION]),
      formatProgress: nullableNumber(raw[IOT_CODES.SD_FORMAT_PROGRESS]),
      raw,
    };
  }

  setStorageRecording(serialNumber: string, enabled: boolean): Promise<UnknownRecord> {
    return this.setRecording(serialNumber, enabled);
  }

  setStorageRecordType(serialNumber: string, type: 0 | 1): Promise<UnknownRecord> {
    return this.setIotValue(serialNumber, IOT_CODES.SD_RECORD_TYPE, type);
  }

  formatStorage(
    serialNumber: string,
    confirmation: "FORMAT_STORAGE",
  ): Promise<UnknownRecord> {
    return this.setIotValue(serialNumber, IOT_CODES.FORMAT_SD_CARD, "{}", {
      direct: true,
      confirmation,
    });
  }

  deleteStorageFiles(
    serialNumber: string,
    confirmation: "DELETE_STORAGE_FILES",
  ): Promise<UnknownRecord> {
    return this.setIotValue(serialNumber, IOT_CODES.DELETE_SD_FILES, "{}", {
      direct: true,
      confirmation,
    });
  }

  restoreFactorySettings(
    serialNumber: string,
    confirmation: "RESTORE_FACTORY_SETTINGS",
  ): Promise<UnknownRecord> {
    return this.setIotValue(serialNumber, IOT_CODES.RESTORE_FACTORY, "{}", {
      direct: true,
      confirmation,
    });
  }

  resetDevice(
    serialNumber: string,
    confirmation: "RESET_DEVICE",
  ): Promise<UnknownRecord> {
    return this.setIotValue(serialNumber, IOT_CODES.RESET_DEVICE, "1", {
      direct: true,
      confirmation,
    });
  }

  hardResetDevice(
    serialNumber: string,
    confirmation: "HARD_RESET_DEVICE",
  ): Promise<UnknownRecord> {
    return this.setIotValue(serialNumber, IOT_CODES.HARD_RESET_DEVICE, "{}", {
      direct: true,
      confirmation,
    });
  }

  setControl(
    serialNumber: string,
    controlId: string,
    value: IotValue,
    options: IotWriteOptions = {},
  ): Promise<UnknownRecord> {
    const definition = PET3T_CONTROL_BY_ID[controlId];
    if (!definition) throw new RangeError(`Unknown PET3T control: ${controlId}`);
    if (controlId === "feed") {
      if (value !== 1) throw new RangeError("feed dispenses exactly one treat per command; the value must be 1");
      return this.feed(serialNumber);
    }
    if (controlId === "feedCall") return this.playFeedCall(serialNumber);
    if (controlId === "ptzCalibration") return this.calibratePtz(serialNumber);
    if (controlId === "ptzPatrol") return this.startPtzPatrol(serialNumber);
    if (controlId === "stuckFeedRepair") {
      return this.setIotValue(serialNumber, definition.code, JSON.stringify({ fix: 1 }), { direct: true });
    }
    if (
      controlId === "formatStorage" ||
      controlId === "deleteStorageFiles" ||
      controlId === "restoreFactory" ||
      controlId === "hardReset"
    ) {
      return this.setIotValue(serialNumber, definition.code, "{}", {
        ...(options.confirmation === undefined ? {} : { confirmation: options.confirmation }),
        direct: true,
      });
    }
    if (controlId === "resetDevice") {
      return this.setIotValue(serialNumber, definition.code, "1", {
        ...(options.confirmation === undefined ? {} : { confirmation: options.confirmation }),
        direct: true,
      });
    }
    const encoded = encodeControlValue(definition, value);
    const direct = options.direct ?? definition.direct;
    const writeOptions: IotWriteOptions = {
      ...(options.confirmation === undefined ? {} : { confirmation: options.confirmation }),
      ...(direct === undefined ? {} : { direct }),
    };
    return this.setIotValue(serialNumber, definition.code, encoded, writeOptions);
  }

  setExtension(
    serialNumber: string,
    extension: SafeExtensionControl,
    value: IotValue,
  ): Promise<UnknownRecord> {
    const definition = defineSafeExtensionControl(extension);
    const encoded = encodeControlValue(definition, value);
    return this.setIotValue(serialNumber, definition.code, encoded, {
      direct: definition.direct ?? false,
    });
  }

  async apiGet(path: string, extra: Readonly<Record<string, string>> = {}): Promise<UnknownRecord> {
    const params = this.signParams({ ...this.baseParams(), ...extra });
    return this.requestJson(this.requireSession().apiServer, path, "GET", params, this.caHeaders(path));
  }

  async apiPost(path: string, extra: Readonly<Record<string, string>> = {}): Promise<UnknownRecord> {
    const params = this.signParams({ ...this.baseParams(), ...extra });
    return this.requestJson(this.requireSession().apiServer, path, "POST", params, this.caHeaders(path));
  }

  private async setToggle(
    serialNumber: string,
    code: string,
    enabled: boolean,
    direct = false,
  ): Promise<UnknownRecord> {
    return this.setIotValue(serialNumber, code, enabled ? 1 : 0, { direct });
  }

  private setRangedNumber(
    serialNumber: string,
    code: string,
    value: number,
    min: number,
    max: number,
    label: string,
  ): Promise<UnknownRecord> {
    assertIntegerRange(value, min, max, label);
    return this.setIotValue(serialNumber, code, value);
  }

  private setEnvironmentThreshold(
    serialNumber: string,
    code: string,
    value: number,
    max: number,
    label: string,
  ): Promise<UnknownRecord> {
    assertIntegerRange(value, 0, max, label);
    return this.setIotValue(serialNumber, code, value * 1000);
  }

  private setJsonSetting(serialNumber: string, code: string, value: unknown): Promise<UnknownRecord> {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("Setting must be JSON serializable");
    return this.setIotValue(serialNumber, code, encoded);
  }

  private presetCommand(serialNumber: string, command: UnknownRecord): Promise<UnknownRecord> {
    return this.setIotValue(serialNumber, IOT_CODES.PTZ_PRESET, JSON.stringify(command), { direct: true });
  }

  private async iotRequest(
    serialNumber: string,
    action: "get" | "set",
    iot: readonly string[] | Readonly<Record<string, IotValue>> | undefined,
    targetServer: boolean,
  ): Promise<UnknownRecord> {
    if (!serialNumber) throw new TypeError("serialNumber is required");
    const payload: UnknownRecord = { code: 100001, action, name: "iot" };
    if (iot !== undefined) payload.iot = iot;
    const params = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    const extra: Record<string, string> = {
      deviceid: formatSn(serialNumber),
      params,
    };
    if (targetServer) extra.target = "server";
    let response = await this.openapiRequest("/openapi/device/config", action, extra);
    if (
      String(response.errid ?? "") === "401"
      && String(response.reason ?? "").toLowerCase() === "timeout"
    ) {
      // CloudEdge treats this response as expired platform credentials: it
      // forces /v2/app/config/pf/init to refresh and retries the exact command.
      await this.initializeIot({ refresh: true });
      response = await this.openapiRequest("/openapi/device/config", action, extra);
    }
    if (hasApiError(response)) {
      const errid = String(response.errid ?? "");
      const reason = String(response.reason ?? "");
      if (errid === "404" && reason.toLowerCase() === "notonline") {
        throw new DeviceOfflineError("Device is offline", errid);
      }
      throw new MeariApiError(
        `Device configuration ${action} failed${reason ? `: ${reason}` : ""}`,
        errid || undefined,
      );
    }
    return response;
  }

  private async openapiRequest(
    path: string,
    action: string,
    extra: Readonly<Record<string, string>>,
  ): Promise<UnknownRecord> {
    const session = this.requireOpenapiSession();
    // CloudEdge's SdkUtils.getTimeOut() adds 60 seconds and then removes the
    // device's raw+DST UTC offset before signing. This is intentionally not a
    // normal Unix expiry; the OpenAPI service expects the shifted value.
    const expires = vendorOpenapiExpiry(this.#now());
    const signature = hmacSha1Base64(
      `GET\n\n\n${expires}\n${path}\n${action}`,
      session.accessKey,
    );
    const deviceAuth = this.deviceOpenapiParams(extra.deviceid);
    return this.requestJson(session.openapiServer, path, "GET", {
      accessid: session.accessId,
      expires,
      signature,
      action,
      ...deviceAuth,
      ...extra,
    });
  }

  /**
   * Meari's current iotType=3 device endpoints bind each request to both the
   * signed-in user and the short-lived credentials returned with that camera.
   * The Android SDK calls these fields clientid, token, and t.
   */
  private deviceOpenapiParams(deviceId: string | undefined): Record<string, string> {
    if (!deviceId) return {};

    const session = this.requireSession();
    const params: Record<string, string> = { clientid: session.userId };
    const device = this.#devices.find((candidate) => {
      const serialNumber = stringAt(candidate, "snNum");
      return serialNumber === deviceId || formatSn(serialNumber) === deviceId;
    });
    if (!device) return params;

    const token = stringAt(device, "deviceSignature");
    if (token) params.token = token;
    const deviceTime = queryScalarAt(device, "t");
    if (deviceTime !== undefined) params.t = deviceTime;
    return params;
  }

  private baseParams(): Record<string, string> {
    const session = this.requireSession();
    const timestamp = this.#now();
    return {
      phoneType: "a",
      sourceApp: this.profile.sourceApp,
      appVer: this.profile.appVer,
      appVerCode: this.profile.appVerCode,
      lngType: this.#language,
      t: String(timestamp),
      countryCode: session.countryCode,
      phoneCode: session.phoneCode,
      signatureMethod: "HMAC-SHA1",
      signatureVersion: "1.0",
      signatureNonce: String(timestamp),
      timestamp: vendorTimestamp(timestamp),
      userID: session.userId,
    };
  }

  private signParams(params: Readonly<Record<string, string>>): Record<string, string> {
    const canonical = Object.keys(params).sort().map((key) => `${key}=${params[key] ?? ""}`).join("&");
    return {
      ...params,
      signature: hmacSha1Base64(canonical, this.requireSession().userToken),
    };
  }

  private caHeaders(path: string): Record<string, string> {
    const timestamp = String(this.#now());
    const nonce = String(100_000 + Math.floor(this.randomUnit() * 900_000));
    const sessionToken = this.#session?.userToken;
    const key = sessionToken || this.profile.caKey;
    const secret = sessionToken || this.profile.caSecret;
    if (!key || !secret) throw new Error("Set MEARI_CA_KEY and MEARI_CA_SECRET in local secret storage before using the vendor cloud");
    const apiPath = `/ppstrongs/${path}`;
    const signature = hmacSha1Base64(
      `api=${apiPath}|X-Ca-Key=${key}|X-Ca-Timestamp=${timestamp}|X-Ca-Nonce=${nonce}`,
      secret,
    );
    return {
      "User-Agent": USER_AGENT,
      "X-Ca-Timestamp": timestamp,
      "X-Ca-Key": key,
      "X-Ca-Nonce": nonce,
      "X-Ca-Sign": signature,
    };
  }

  private async requestJson(
    baseUrl: string,
    path: string,
    method: "GET" | "POST",
    params: Readonly<Record<string, string>>,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<UnknownRecord> {
    const url = new URL(path, ensureTrailingSlash(baseUrl));
    const init: RequestInit = { method, headers: { ...headers } };
    if (method === "GET") {
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    } else {
      const body = new URLSearchParams(params);
      init.body = body.toString();
      init.headers = {
        ...headers,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      };
    }
    const controller = new AbortController();
    init.signal = controller.signal;
    const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(url, init);
    } catch (cause) {
      throw new MeariApiError(`Network request failed for ${path}`, undefined, { cause });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new MeariApiError(`HTTP ${response.status} from ${path}`, String(response.status));
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (cause) {
      throw new MeariApiError(`Non-JSON response from ${path}`, undefined, { cause });
    }
    if (!isRecord(parsed)) throw new MeariApiError(`Invalid response from ${path}`);
    return parsed;
  }

  private applyLoginIot(session: MeariSession, result: UnknownRecord): MeariSession {
    const iot = recordAt(result, "iot");
    const pfKey = recordAt(iot, "pfKey");
    const mqtt = recordAt(iot, "mqtt");
    return {
      ...session,
      accessId: stringAt(pfKey, "accessid"),
      accessKey: stringAt(pfKey, "accesskey"),
      openapiServer: stripTrailingSlash(stringAt(pfKey, "openapiDomain")),
      platformDomain: stringAt(pfKey, "platformDomain"),
      mqttHost: stringAt(mqtt, "host"),
      mqttPort: positiveInteger(mqtt.port) ?? session.mqttPort,
    };
  }

  private applyPlatformDefaults(session: MeariSession): MeariSession {
    const region = regionCode(session.apiServer, session.openapiServer, session.platformDomain);
    if (!region) return session;
    const suffix = `${region}ce`;
    return {
      ...session,
      openapiServer: session.openapiServer || `https://openapi-${suffix}.mearicloud.com`,
      platformDomain: session.platformDomain || `${suffix}.mearicloud.com`,
      mqttHost: session.mqttHost || `events-${suffix}.mearicloud.com`,
    };
  }

  private assertSessionResult(response: UnknownRecord, operation: string): void {
    const code = String(response.resultCode ?? "");
    if (code === SUCCESS) return;
    if (code === SESSION_BUMPED) {
      throw new MeariSessionError("The Meari session was replaced by another login", code);
    }
    throw new MeariApiError(`${operation} failed`, code || undefined);
  }

  private assertDestructiveConfirmation(
    code: string,
    confirmation: DestructiveConfirmation | undefined,
  ): void {
    if (!DESTRUCTIVE_IOT_CODES.has(code)) return;
    const expected = destructiveConfirmationFor(code);
    if (!expected || confirmation !== expected) throw new DestructiveControlError(code);
  }

  private requireSession(): MeariSession {
    if (!this.#session) throw new MeariAuthError("Not authenticated");
    return this.#session;
  }

  private requireOpenapiSession(): MeariSession {
    const session = this.requireSession();
    if (!session.openapiServer || !session.accessId || !session.accessKey) {
      throw new MeariApiError("OpenAPI credentials are unavailable");
    }
    return session;
  }

  private randomDigits(count: number): string {
    return Array.from({ length: count }, () => Math.floor(this.randomUnit() * 10)).join("");
  }

  private randomUnit(): number {
    const value = this.#random();
    if (!Number.isFinite(value)) return 0;
    return Math.min(0.9999999999999999, Math.max(0, value));
  }
}

export { MeariClient as TkenProClient };
export { MeariClient as TkenProCloudClient };
export { MeariClient as MeariCloudClient };

export function createMeariClient(config: MeariClientConfig): MeariClient {
  return new MeariClient(config);
}

function collectDevices(
  payload: unknown,
  target: Map<string, MeariDevice>,
  homeId?: string,
  category?: string,
): void {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (isRecord(item)) addDevice(item, target, homeId, category);
      collectDevices(item, target, homeId, category);
    }
    return;
  }
  if (!isRecord(payload)) return;
  for (const [key, value] of Object.entries(payload)) {
    const lower = key.toLowerCase();
    const nextCategory = CATEGORY_NAMES.has(lower) ? lower : category;
    if (Array.isArray(value) && (nextCategory !== undefined || key === "deviceList")) {
      for (const item of value) {
        if (isRecord(item)) addDevice(item, target, homeId, nextCategory);
      }
    }
    collectDevices(value, target, homeId, nextCategory);
  }
}

function queryScalarAt(value: UnknownRecord, key: string): string | undefined {
  const raw = value[key];
  if (typeof raw === "string") return raw.trim() ? raw : undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return undefined;
}

function addDevice(
  raw: UnknownRecord,
  target: Map<string, MeariDevice>,
  homeId?: string,
  category?: string,
): void {
  const serial = stringAt(raw, "snNum");
  const id = String(raw.deviceID ?? serial);
  if (!serial || !id) return;
  const normalized: MeariDevice = {
    ...raw,
    _category: category ?? inferCategory(raw),
  };
  if (homeId !== undefined) {
    (normalized as { _homeId?: string })._homeId = homeId;
    (normalized as { _home_id?: string })._home_id = homeId;
  }
  target.set(id, normalized);
}

function inferCategory(device: UnknownRecord): string {
  return Number(device.devTypeID ?? 0) === 5 ? "snap" : "ipc";
}

function assertResult(response: UnknownRecord, operation: string): void {
  const code = String(response.resultCode ?? "");
  if (code !== SUCCESS) throw new MeariApiError(`${operation} failed`, code || undefined);
}

function destructiveConfirmationFor(code: string): DestructiveConfirmation | undefined {
  switch (code) {
    case IOT_CODES.FORMAT_SD_CARD: return "FORMAT_STORAGE";
    case IOT_CODES.DELETE_SD_FILES: return "DELETE_STORAGE_FILES";
    case IOT_CODES.RESTORE_FACTORY: return "RESTORE_FACTORY_SETTINGS";
    case IOT_CODES.RESET_DEVICE: return "RESET_DEVICE";
    case IOT_CODES.HARD_RESET_DEVICE: return "HARD_RESET_DEVICE";
    default: return undefined;
  }
}

function isDirectActionCode(code: string): boolean {
  const number = Number(code);
  return (number >= 800 && number <= 899) || code === IOT_CODES.DELETE_SD_FILES || code === IOT_CODES.RESTORE_FACTORY;
}

function encodeLegacyOnvifPassword(password: string): string {
  if (typeof password !== "string") throw new TypeError("ONVIF password must be a string");
  if (password.length === 0) throw new RangeError("ONVIF password must not be empty");
  if (password.length > 16) {
    throw new RangeError("ONVIF password must be at most 16 characters for legacy svc=3 cameras");
  }
  if (!/^[\x20-\x7e]+$/u.test(password)) {
    throw new TypeError("ONVIF password must contain printable ASCII characters only");
  }
  return Buffer.from(password, "utf8").toString("base64");
}

function normalizeClock(clock: MeariClock | (() => number) | undefined): () => number {
  if (typeof clock === "function") return clock;
  if (clock) return () => clock.now();
  return () => Date.now();
}

function normalizeRandom(
  random: MeariRandomSource | (() => number) | undefined,
): () => number {
  if (typeof random === "function") return random;
  if (random) return () => random.next();
  return () => Math.random();
}

const defaultSleep: SleepLike = async (milliseconds, signal) => {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

function vendorTimestamp(milliseconds: number): string {
  const date = new Date(milliseconds);
  const offsetMinutes = -date.getTimezoneOffset();
  const local = new Date(milliseconds + offsetMinutes * 60_000);
  const base = local.toISOString().slice(0, 23);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `${base}GMT${sign}${hours}:${minutes}`;
}

function vendorOpenapiExpiry(milliseconds: number): string {
  const expiresAt = milliseconds + 60_000;
  return String(Math.floor(expiresAt / 1_000) + new Date(expiresAt).getTimezoneOffset() * 60);
}

function regionCode(...hints: readonly string[]): string {
  for (const hint of hints) {
    let host = hint;
    try {
      host = new URL(hint.includes("://") ? hint : `https://${hint}`).hostname;
    } catch {
      // Use the original hint as a host-like string.
    }
    for (const part of host.toLowerCase().replaceAll("-", ".").split(".")) {
      if (part === "eu" || part === "us" || part === "as" || part === "cn") return part;
      if (/^(eu|us|as|cn)ce$/u.test(part)) return part.slice(0, 2);
    }
  }
  return "";
}

function hasApiError(response: UnknownRecord): boolean {
  return response.errid !== undefined && response.errid !== null && response.errid !== 0 && response.errid !== "0";
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIotValue(value: unknown): value is IotValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isIotValue);
  return isRecord(value) && Object.values(value).every(isIotValue);
}

function recordAt(record: UnknownRecord, key: string): UnknownRecord {
  const value = record[key];
  return isRecord(value) ? value : {};
}

function arrayAt(record: UnknownRecord, key: string): readonly unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function stringAt(record: UnknownRecord, key: string): string {
  const value = record[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function nullableNumber(value: IotValue | undefined): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return value === undefined || value === null || !Number.isFinite(parsed) ? null : parsed;
}

function nullableString(value: IotValue | undefined): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function nullableBoolean(value: IotValue | undefined): boolean | null {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

function assertIntegerRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer from ${min} to ${max}`);
  }
}

function assertPreset(preset: PtzPreset): void {
  assertIntegerRange(preset.id, 1, 255, "Preset ID");
  if (preset.name !== undefined && (preset.name.length === 0 || preset.name.length > 64)) {
    throw new RangeError("Preset name must contain 1-64 characters");
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
