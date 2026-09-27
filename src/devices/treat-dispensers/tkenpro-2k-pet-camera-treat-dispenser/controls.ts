import { DestructiveControlError } from "../../../protocols/tkenpro/errors.ts";
import { encodeMeariPolygonRegions } from "../../../protocols/tkenpro/polygon-region-codecs.ts";
import { encodeMeariGridRegion } from "../../../protocols/tkenpro/region-codecs.ts";
import { encodeMeariSchedule, type MeariScheduleCodec } from "../../../protocols/tkenpro/schedule-codecs.ts";
import type { IotValue, IotValues, MeariDevice } from "../../../protocols/tkenpro/types.ts";

/** IoT data-point IDs used by PET3T/TKENPRO and compatible Meari cameras. */
export const IOT_CODES = Object.freeze({
  FIRMWARE_CODE: "51",
  FIRMWARE_VERSION: "52",
  CLOUD_UPLOAD_ENABLE: "53",
  DELETE_SD_FILES: "71",
  DEVICE_NAME: "72",
  ROTATE_ENABLE: "102",
  LED_ENABLE: "103",
  SD_RECORD_TYPE: "104",
  SD_RECORD_DURATION: "105",
  MOTION_DET_ENABLE: "106",
  MOTION_DET_SENSITIVITY: "107",
  HUMAN_DET_ENABLE: "108",
  SOUND_DET_ENABLE: "109",
  SOUND_DET_SENSITIVITY: "110",
  CRY_DET_ENABLE: "111",
  HUMAN_TRACK_ENABLE: "112",
  DAY_NIGHT_MODE: "113",
  SD_STATUS: "114",
  SD_CAPACITY: "115",
  SD_REMAINING_CAPACITY: "116",
  HUMAN_FRAME_ENABLE: "117",
  SLEEP_MODE: "118",
  SLEEP_TIME_LIST: "119",
  ONVIF_ENABLE: "121",
  ONVIF_PASSWORD: "122",
  ONVIF_URL: "123",
  H265_ENABLE: "124",
  ALARM_PLAN_LIST: "125",
  RECORD_SWITCH: "140",
  SMART_DET: "141",
  SMART_DET_FRAME: "142",
  SMART_DET_SENSITIVITY: "143",
  SMART_DET_DEPLOYMENT_TIME: "144",
  TIMING_RECORD: "145",
  PIR_DET_ENABLE: "150",
  PIR_DET_SENSITIVITY: "151",
  SPEAK_VOLUME: "152",
  POWER_TYPE: "153",
  BATTERY_PERCENT: "154",
  BATTERY_REMAINING: "155",
  CHARGE_STATUS: "156",
  TIME_FORMAT_SWITCH: "162",
  FLOODLIGHT_SWITCH: "167",
  FLOODLIGHT_BRIGHTNESS: "168",
  FLOODLIGHT_SCHEDULE: "169",
  FLOODLIGHT_PIR_DURATION: "171",
  ROI: "177",
  ALARM_FREQUENCY: "178",
  MUSIC_VOLUME: "179",
  FLOODLIGHT_LINK_ENABLE: "180",
  FACE_RECOGNITION_SWITCH: "181",
  SOUND_LIGHT_ENABLE: "182",
  SOUND_LIGHT_TYPE: "183",
  FLOODLIGHT_MANUAL_DURATION: "185",
  FLOODLIGHT_MULTI_SCHEDULE: "186",
  SIREN_LINK_ENABLE: "187",
  OSD_ENABLE: "190",
  LOGO_SWITCH: "191",
  ABNORMAL_NOISE_ENABLE: "195",
  TIMED_PTZ_PATROL: "196",
  RGB_LIGHT_SWITCH: "197",
  RGB_LIGHT_COLOR: "198",
  RGB_LIGHT_TIMING: "199",
  RGB_LIGHT_MODE: "200",
  ANTI_FLICKER: "202",
  AUTO_UPDATE: "203",
  HOMEKIT_ENABLE: "206",
  MICROPHONE_ENABLE: "207",
  SPEAKER_ENABLE: "208",
  FULL_COLOR_MODE: "209",
  RECORD_AUDIO_ENABLE: "211",
  VIDEO_ENCRYPTION_ENABLE: "216",
  VIDEO_ENCRYPTION_PASSWORD: "217",
  WHISTLE_TIME: "218",
  ANTI_JAMMING: "223",
  HUMAN_SENSITIVITY_LEVEL: "224",
  FRAME_RATE: "228",
  SOUND_LIGHT_ALARM_PLAN_LIST: "230",
  LIGHT_SOUND_SELECT_SONG: "231",
  POLYGON_ROI: "232",
  POLYGON_PRIVACY: "233",
  FREE_CLOUD_VIDEO_UPLOAD_ENABLE: "235",
  /** @deprecated Property 235 is the optional free/short cloud-video path, not general cloud upload. */
  CLOUD_VIDEO_UPLOAD_ENABLE: "235",
  FEED_SOUND_ENABLE: "236",
  /** @deprecated Code 236 is the feeding/dispense sound switch on PET3T. */
  PET_THROW_WARNING: "236",
  PET_FEED_PLAN_LIST: "237",
  EAT_DETECTION: "336",
  NEW_FEED_PLAN: "338",
  OUT_OF_FOOD_INFO: "343",
  NO_EAT_DETECTION: "353",
  NO_EAT_WAIT_TIME: "355",
  REMAINING_GRAIN_DETECT: "387",
  REMAINING_GRAIN_NOTIFY: "388",
  MEAL_CALL_STATE: "1049",
  INFRARED_LIGHT: "238",
  /** Codes 240-246 are overloaded by other Meari product families. */
  MONITOR_TIME_SWITCH: "240",
  TEMP_HUMIDITY_ALARM_ENABLE: "241",
  MONITOR_TIME: "241",
  TEMPERATURE_MAX: "242",
  PIR_TRIGGER_INTERVAL: "242",
  TEMPERATURE_MIN: "243",
  HUMIDITY_MAX: "244",
  KEY_VOICE_SWITCH: "244",
  HUMIDITY_MIN: "245",
  /** PET3T uses 246 for credential-bearing saved Wi-Fi/AP configuration. */
  WIFI_MULTI_AP_INFO: "246",
  RESTORE_FACTORY: "251",
  SOUND_SWITCH: "258",
  SOUND_DATE: "259",
  SOUND_SET: "262",
  PET_DOG_ALARM_ENABLE: "263",
  PET_ALARM: "263",
  PET_ALARM_ENABLE: "264",
  MUSIC_TIME: "276",
  MUSIC_CYCLICAL: "277",
  WATCH_SLOT: "278",
  ALARM_SOUND_LIGHT_SET: "280",
  POWER_ON_VOICE_ENABLE: "284",
  POWER_ON_VOLUME: "285",
  COVER_DET_ENABLE: "286",
  WARM_LIGHT_BRIGHTNESS: "289",
  LASER_SWITCH: "291",
  TEASE_MODE: "292",
  TEASE_DURATION: "293",
  TEASE_PLAN: "294",
  PET_CAT_ALARM_ENABLE: "320",
  PET_MEOW: "320",
  FOOD_DETECTION: "331",
  OUT_OF_FOOD_DURATION: "337",
  DESICCANT_INFO: "339",
  TODAY_FEED_PLAN: "344",
  RESET_DEVICE: "800",
  HARD_RESET_DEVICE: "801",
  SYNC_TIME: "802",
  OTA_UPGRADE: "803",
  FORMAT_SD_CARD: "806",
  PTZ_START: "807",
  PTZ_STOP: "808",
  REFRESH_PROPERTY: "809",
  MUSIC_PLAY_CONTROL: "821",
  PTZ_PATROL: "822",
  SIREN_SWITCH: "823",
  ALL_ALARMS_ENABLE: "825",
  PTZ2_START: "841",
  PTZ2_STOP: "842",
  PET_SOUND_SET: "843",
  PET_FEED_CALL: "844",
  PET_FEED_LEGACY: "845",
  PTZ_CALIBRATION: "847",
  PTZ_PRESET: "848",
  CAMERA_LINKAGE: "849",
  PET_FEED: "850",
  CAMERA_CONTROL: "851",
  PET_SOUND_CALL: "860",
  WATCH_BOWL: "868",
  /** Pet-feeder physical-button lock; CloudEdge exposes this only when pkl is advertised. */
  PET_KEY_LOCK: "415",
  /** One-click stuck-food repair; CloudEdge exposes this when fmr is advertised. */
  STUCK_FEED_REPAIR: "875",
  SD_FORMAT_PROGRESS: "1004",
  WIFI_STRENGTH: "1007",
  TEMPERATURE: "1008",
  HUMIDITY: "1009",
  RGB_LIGHT_STATUS: "1014",
  DEVICE_WIFI_INFO: "1032",
  PTZ_INFO: "1034",
} as const);

export type IotCodeName = keyof typeof IOT_CODES;
export type KnownIotCode = (typeof IOT_CODES)[IotCodeName];

export type ControlKind =
  | "switch"
  | "number"
  | "text"
  | "select"
  | "color"
  | "schedule"
  | "region"
  | "polygon-region"
  | "json"
  | "action"
  | "status";
export type ControlAccess = "read" | "write" | "read-write";
export type ControlSafety = "safe" | "caution" | "destructive";
export type ControlCategory =
  | "camera"
  | "detection"
  | "video"
  | "audio"
  | "ptz"
  | "feeder"
  | "lighting"
  | "storage"
  | "system"
  | "environment";
export type CapabilityFeature =
  | "always"
  | "camera"
  | "motion"
  | "person"
  | "sound"
  | "cry"
  | "ptz"
  | "feeder"
  | "pet"
  | "pir"
  | "storage"
  | "speaker"
  | "floodlight"
  | "siren"
  | "rgb"
  | "laser"
  | "temperature"
  | "humidity"
  | "onvif";

export interface ControlOption {
  readonly value: number | string;
  readonly label: string;
}

export interface ControlDefinition {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly category: ControlCategory;
  readonly kind: ControlKind;
  readonly access: ControlAccess;
  readonly safety: ControlSafety;
  readonly feature: CapabilityFeature;
  /** Command whose support can be inferred even when no current property value was returned. */
  readonly featurePromoted?: boolean;
  /** Exact device-capability flags used by CloudEdge for this command, when narrower than `feature`. */
  readonly capabilityFlags?: readonly string[];
  readonly direct?: boolean;
  readonly jsonString?: boolean;
  /** Exact Android/firmware serializer for non-interchangeable schedule shapes. */
  readonly scheduleCodec?: MeariScheduleCodec;
  /** Exact Android/firmware serializer for property 177's 16x9 grid. */
  readonly regionCodec?: "grid-16x9";
  /** Exact CloudEdge serializer for property 232's percentage-based octagons. */
  readonly polygonRegionCodec?: "property-232";
  /** Wrap a text value in a JSON object before writing it to the IoT property. */
  readonly jsonField?: string;
  /** Divide camera values by this factor for display and multiply UI writes by it. */
  readonly scale?: number;
  readonly unit?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly options?: readonly ControlOption[];
  readonly description?: string;
}

const control = (definition: ControlDefinition): Readonly<ControlDefinition> =>
  Object.freeze(definition);

const binary = (
  id: string,
  code: string,
  label: string,
  category: ControlCategory,
  feature: CapabilityFeature,
): Readonly<ControlDefinition> =>
  control({ id, code, label, category, feature, kind: "switch", access: "read-write", safety: "safe" });

const number = (
  id: string,
  code: string,
  label: string,
  category: ControlCategory,
  feature: CapabilityFeature,
  min: number,
  max: number,
): Readonly<ControlDefinition> =>
  control({ id, code, label, category, feature, kind: "number", access: "read-write", safety: "safe", min, max, step: 1 });

export const RECORD_DURATION_OPTIONS: readonly Readonly<ControlOption>[] = Object.freeze([
  { value: 7, label: "7 seconds" },
  { value: 5, label: "10 seconds" },
  { value: 3, label: "20 seconds" },
  { value: 6, label: "30 seconds" },
  { value: 4, label: "40 seconds" },
  { value: 0, label: "60 seconds" },
  { value: 1, label: "120 seconds" },
  { value: 2, label: "180 seconds" },
]);

const RECORD_DURATION_SECONDS_BY_WIRE = Object.freeze({
  0: 60,
  1: 120,
  2: 180,
  3: 20,
  4: 40,
  5: 10,
  6: 30,
  7: 7,
} as const);

export function encodeRecordDurationSeconds(seconds: number): number {
  const match = RECORD_DURATION_OPTIONS.find((option) => option.label === `${seconds} seconds`);
  if (!match || typeof match.value !== "number") {
    throw new RangeError("Record duration must be 7, 10, 20, 30, 40, 60, 120, or 180 seconds");
  }
  return match.value;
}

export function decodeRecordDurationValue(value: IotValue | undefined): number | null {
  const wire = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/u.test(value)
      ? Number(value)
      : Number.NaN;
  return RECORD_DURATION_SECONDS_BY_WIRE[wire as keyof typeof RECORD_DURATION_SECONDS_BY_WIRE] ?? null;
}

/**
 * PET3T control surface. Availability is computed from capability.caps and is
 * also promoted when a device actually returns the matching IoT code. This is
 * intentional: firmware capability flags are known to lag real data points.
 */
export const PET3T_CONTROL_CATALOG: readonly Readonly<ControlDefinition>[] =
  Object.freeze([
    binary("statusLed", IOT_CODES.LED_ENABLE, "Status LED", "camera", "camera"),
    binary("rotateImage", IOT_CODES.ROTATE_ENABLE, "Rotate image 180°", "video", "camera"),
    binary("motionDetection", IOT_CODES.MOTION_DET_ENABLE, "Motion detection", "detection", "motion"),
    number("motionSensitivity", IOT_CODES.MOTION_DET_SENSITIVITY, "Motion sensitivity", "detection", "motion", 1, 5),
    binary("personDetection", IOT_CODES.HUMAN_DET_ENABLE, "Person detection", "detection", "person"),
    number("personSensitivity", IOT_CODES.HUMAN_SENSITIVITY_LEVEL, "Person sensitivity", "detection", "person", 1, 3),
    binary("soundDetection", IOT_CODES.SOUND_DET_ENABLE, "Sound detection", "detection", "sound"),
    control({ id: "soundSensitivity", code: IOT_CODES.SOUND_DET_SENSITIVITY, label: "Sound sensitivity", category: "detection", feature: "sound", kind: "select", access: "read-write", safety: "safe", options: [{ value: 0, label: "Low" }, { value: 1, label: "Medium" }, { value: 2, label: "High" }] }),
    binary("cryDetection", IOT_CODES.CRY_DET_ENABLE, "Cry detection", "detection", "cry"),
    binary("humanTracking", IOT_CODES.HUMAN_TRACK_ENABLE, "Human tracking", "ptz", "ptz"),
    control({ id: "dayNightMode", code: IOT_CODES.DAY_NIGHT_MODE, label: "Day/night mode", category: "video", feature: "camera", kind: "select", access: "read-write", safety: "safe", options: [{ value: 0, label: "Day" }, { value: 1, label: "Night" }, { value: 2, label: "Auto" }] }),
    binary("humanFrame", IOT_CODES.HUMAN_FRAME_ENABLE, "Detection frame", "video", "person"),
    control({ id: "sleepMode", code: IOT_CODES.SLEEP_MODE, label: "Sleep/privacy mode", category: "camera", feature: "camera", kind: "select", access: "read-write", safety: "safe", options: [{ value: 0, label: "Active" }, { value: 1, label: "Sleep" }, { value: 2, label: "Privacy" }] }),
    control({ id: "sleepSchedule", code: IOT_CODES.SLEEP_TIME_LIST, label: "Sleep schedule", category: "camera", feature: "camera", kind: "schedule", access: "read-write", safety: "safe", jsonString: true, scheduleCodec: "weekly-intervals" }),
    control({ id: "cameraLensControl", code: IOT_CODES.CAMERA_CONTROL, label: "Lens control command", description: "Low-level focus/zoom command, such as {\"focus\":1}, {\"scale\":-1}, or {\"stop\":1}.", category: "camera", feature: "camera", kind: "json", access: "write", safety: "caution", direct: true, jsonString: true }),
    control({
      id: "onvif",
      code: IOT_CODES.ONVIF_ENABLE,
      label: "ONVIF",
      description: "Enabling ONVIF can disable cloud recording on compatible cameras.",
      category: "video",
      feature: "onvif",
      kind: "switch",
      access: "read-write",
      safety: "caution",
      featurePromoted: true,
      capabilityFlags: ["ovf"],
    }),
    binary("h265", IOT_CODES.H265_ENABLE, "H.265", "video", "camera"),
    control({ id: "alarmSchedule", code: IOT_CODES.ALARM_PLAN_LIST, label: "Alarm schedule", category: "detection", feature: "motion", kind: "schedule", access: "read-write", safety: "safe", jsonString: true, scheduleCodec: "weekly-intervals" }),
    binary("recording", IOT_CODES.RECORD_SWITCH, "SD recording", "storage", "storage"),
    control({ id: "recordType", code: IOT_CODES.SD_RECORD_TYPE, label: "SD record type", category: "storage", feature: "storage", kind: "select", access: "read-write", safety: "safe", options: [{ value: 0, label: "Continuous" }, { value: 1, label: "Event" }] }),
    control({ id: "recordDuration", code: IOT_CODES.SD_RECORD_DURATION, label: "Record duration", category: "storage", feature: "storage", kind: "select", access: "read-write", safety: "safe", options: RECORD_DURATION_OPTIONS }),
    binary("recordAudio", IOT_CODES.RECORD_AUDIO_ENABLE, "Record audio", "storage", "storage"),
    control({ id: "smartDetection", code: IOT_CODES.SMART_DET, label: "Smart detection", description: "Per-category smart-detection flags reported by this firmware.", category: "detection", feature: "motion", kind: "json", access: "read-write", safety: "safe", jsonString: true }),
    binary("smartDetectionFrame", IOT_CODES.SMART_DET_FRAME, "Smart detection frame", "detection", "motion"),
    number("smartDetectionSensitivity", IOT_CODES.SMART_DET_SENSITIVITY, "Smart detection sensitivity", "detection", "motion", 1, 5),
    control({ id: "smartDetectionSchedule", code: IOT_CODES.SMART_DET_DEPLOYMENT_TIME, label: "Smart detection schedule", category: "detection", feature: "motion", kind: "schedule", access: "read-write", safety: "safe", jsonString: true, scheduleCodec: "deployment-intervals" }),
    control({ id: "recordingSchedule", code: IOT_CODES.TIMING_RECORD, label: "Recording schedule", category: "storage", feature: "storage", kind: "schedule", access: "read-write", safety: "safe", jsonString: true, scheduleCodec: "weekly-intervals" }),
    binary("pirDetection", IOT_CODES.PIR_DET_ENABLE, "PIR detection", "detection", "pir"),
    number("pirSensitivity", IOT_CODES.PIR_DET_SENSITIVITY, "PIR sensitivity", "detection", "pir", 1, 10),
    number("speakerVolume", IOT_CODES.SPEAK_VOLUME, "Speaker volume", "audio", "speaker", 0, 100),
    binary("speaker", IOT_CODES.SPEAKER_ENABLE, "Speaker", "audio", "speaker"),
    binary("microphone", IOT_CODES.MICROPHONE_ENABLE, "Microphone", "audio", "camera"),
    binary("sound", IOT_CODES.SOUND_SWITCH, "Sound", "audio", "speaker"),
    number("soundVolume", IOT_CODES.SOUND_SET, "Sound volume", "audio", "speaker", 0, 100),
    binary("faceRecognition", IOT_CODES.FACE_RECOGNITION_SWITCH, "Face recognition", "detection", "person"),
    binary("abnormalNoise", IOT_CODES.ABNORMAL_NOISE_ENABLE, "Abnormal-noise detection", "detection", "sound"),
    control({ id: "alarmFrequency", code: IOT_CODES.ALARM_FREQUENCY, label: "Alarm frequency", category: "detection", feature: "motion", kind: "select", access: "read-write", safety: "safe", options: [{ value: 0, label: "Low" }, { value: 1, label: "Medium" }, { value: 2, label: "High" }] }),
    binary("soundLightAlarm", IOT_CODES.SOUND_LIGHT_ENABLE, "Sound/light alarm", "audio", "siren"),
    control({ id: "soundLightType", code: IOT_CODES.SOUND_LIGHT_TYPE, label: "Sound/light alarm type", category: "audio", feature: "siren", kind: "select", access: "read-write", safety: "safe", options: [{ value: 0, label: "Sound" }, { value: 1, label: "Light" }, { value: 2, label: "Both" }] }),
    control({ id: "soundLightSchedule", code: IOT_CODES.SOUND_LIGHT_ALARM_PLAN_LIST, label: "Sound/light alarm schedule", category: "audio", feature: "siren", kind: "schedule", access: "read-write", safety: "safe", jsonString: true, scheduleCodec: "weekly-intervals" }),
    control({ id: "soundLightSong", code: IOT_CODES.LIGHT_SOUND_SELECT_SONG, label: "Sound/light alarm tone", category: "audio", feature: "siren", kind: "select", access: "read-write", safety: "safe", options: [{ value: 1, label: "Tone 1" }, { value: 2, label: "Tone 2" }, { value: 3, label: "Tone 3" }] }),
    binary("osd", IOT_CODES.OSD_ENABLE, "Timestamp watermark", "video", "camera"),
    binary("logo", IOT_CODES.LOGO_SWITCH, "Brand watermark", "video", "camera"),
    control({ id: "antiFlicker", code: IOT_CODES.ANTI_FLICKER, label: "Anti-flicker", category: "video", feature: "camera", kind: "select", access: "read-write", safety: "safe", options: [{ value: 0, label: "50 Hz" }, { value: 1, label: "60 Hz" }] }),
    binary("autoUpdate", IOT_CODES.AUTO_UPDATE, "Automatic updates", "system", "camera"),
    binary("antiJamming", IOT_CODES.ANTI_JAMMING, "Anti-jamming", "system", "camera"),
    binary("powerOnVoice", IOT_CODES.POWER_ON_VOICE_ENABLE, "Startup sound", "audio", "speaker"),
    number("powerOnVolume", IOT_CODES.POWER_ON_VOLUME, "Startup volume", "audio", "speaker", 0, 100),
    binary("coverDetection", IOT_CODES.COVER_DET_ENABLE, "Lens-cover detection", "detection", "camera"),
    control({ id: "fullColorMode", code: IOT_CODES.FULL_COLOR_MODE, label: "Night color mode", category: "video", feature: "camera", kind: "select", access: "read-write", safety: "safe", options: [{ value: 0, label: "Black and white" }, { value: 1, label: "Full color" }] }),
    control({ id: "infraredLight", code: IOT_CODES.INFRARED_LIGHT, label: "Infrared light", category: "lighting", feature: "camera", kind: "select", access: "read-write", safety: "safe", options: [{ value: 0, label: "Off" }, { value: 1, label: "On" }, { value: 2, label: "Automatic" }] }),
    control({ id: "frameRate", code: IOT_CODES.FRAME_RATE, label: "Frame rate", category: "video", feature: "camera", kind: "number", access: "read-write", safety: "safe", min: 1, max: 60, step: 1 }),
    control({ id: "detectionRegion", code: IOT_CODES.ROI, label: "Detection region", description: "Choose the parts of the picture where motion should trigger an alert.", category: "detection", feature: "motion", kind: "region", access: "read-write", safety: "safe", jsonString: true, regionCodec: "grid-16x9" }),
    control({ id: "polygonDetectionRegion", code: IOT_CODES.POLYGON_ROI, label: "Polygon detection areas", description: "Drag the points to choose up to six precise detection areas.", category: "detection", feature: "motion", kind: "polygon-region", access: "read-write", safety: "safe", jsonString: true, polygonRegionCodec: "property-232" }),
    control({ id: "privacyMask", code: IOT_CODES.POLYGON_PRIVACY, label: "Privacy mask", category: "video", feature: "camera", kind: "json", access: "read-write", safety: "caution", jsonString: true }),
    binary("temperatureHumidityAlarm", IOT_CODES.TEMP_HUMIDITY_ALARM_ENABLE, "Temperature/humidity alarm", "environment", "temperature"),
    control({ id: "temperatureMaximum", code: IOT_CODES.TEMPERATURE_MAX, label: "Maximum temperature", category: "environment", feature: "temperature", kind: "number", access: "read-write", safety: "safe", min: 0, max: 40, step: 1, scale: 1000, unit: " °C" }),
    control({ id: "temperatureMinimum", code: IOT_CODES.TEMPERATURE_MIN, label: "Minimum temperature", category: "environment", feature: "temperature", kind: "number", access: "read-write", safety: "safe", min: 0, max: 40, step: 1, scale: 1000, unit: " °C" }),
    control({ id: "humidityMaximum", code: IOT_CODES.HUMIDITY_MAX, label: "Maximum humidity", category: "environment", feature: "humidity", kind: "number", access: "read-write", safety: "safe", min: 0, max: 100, step: 1, scale: 1000, unit: "% RH" }),
    control({ id: "humidityMinimum", code: IOT_CODES.HUMIDITY_MIN, label: "Minimum humidity", category: "environment", feature: "humidity", kind: "number", access: "read-write", safety: "safe", min: 0, max: 100, step: 1, scale: 1000, unit: "% RH" }),
    binary("petAlarm", IOT_CODES.PET_ALARM_ENABLE, "Pet alarm", "feeder", "pet"),
    binary("petDogAlarm", IOT_CODES.PET_DOG_ALARM_ENABLE, "Dog detection alarm", "detection", "pet"),
    binary("petCatAlarm", IOT_CODES.PET_CAT_ALARM_ENABLE, "Cat detection alarm", "detection", "pet"),
    binary("allAlarms", IOT_CODES.ALL_ALARMS_ENABLE, "All detection alarms", "detection", "motion"),
    control({ id: "dispenseSound", code: IOT_CODES.FEED_SOUND_ENABLE, label: "Play sound when dispensing", category: "feeder", feature: "feeder", kind: "switch", access: "read-write", safety: "safe", featurePromoted: true, capabilityFlags: ["pfv"] }),
    binary("cloudUpload", IOT_CODES.CLOUD_UPLOAD_ENABLE, "Cloud event recording", "storage", "camera"),
    control({ id: "freeCloudVideoUpload", code: IOT_CODES.FREE_CLOUD_VIDEO_UPLOAD_ENABLE, label: "Short cloud clips", description: "CloudEdge's separate free six-second cloud-video option. This is not the main cloud recording switch.", category: "storage", feature: "camera", kind: "switch", access: "read-write", safety: "safe" }),
    control({ id: "feedSchedule", code: IOT_CODES.PET_FEED_PLAN_LIST, label: "Feed schedule", category: "feeder", feature: "feeder", kind: "schedule", access: "read-write", safety: "safe", jsonString: true, scheduleCodec: "feed-times", featurePromoted: true, capabilityFlags: ["pfp"] }),
    control({ id: "newFeedPlan", code: IOT_CODES.NEW_FEED_PLAN, label: "New-format feed plan", category: "feeder", feature: "feeder", kind: "json", access: "read-write", safety: "safe", direct: true, jsonString: true, featurePromoted: true, capabilityFlags: ["uvd"] }),
    control({ id: "foodDetection", code: IOT_CODES.FOOD_DETECTION, label: "Food detection window", category: "feeder", feature: "feeder", kind: "json", access: "read-write", safety: "safe", jsonString: true, featurePromoted: true, capabilityFlags: ["food"] }),
    control({ id: "desiccant", code: IOT_CODES.DESICCANT_INFO, label: "Desiccant status", category: "feeder", feature: "feeder", kind: "json", access: "read-write", safety: "caution", jsonString: true }),
    binary("laser", IOT_CODES.LASER_SWITCH, "Laser toy", "feeder", "laser"),
    control({ id: "teaseMode", code: IOT_CODES.TEASE_MODE, label: "Pet tease mode", category: "feeder", feature: "laser", kind: "select", access: "read-write", safety: "safe", options: [{ value: 0, label: "Manual" }, { value: 1, label: "Automatic" }] }),
    number("teaseDuration", IOT_CODES.TEASE_DURATION, "Pet tease duration", "feeder", "laser", 1, 60),
    control({ id: "teaseSchedule", code: IOT_CODES.TEASE_PLAN, label: "Pet tease schedule", category: "feeder", feature: "laser", kind: "schedule", access: "read-write", safety: "safe", jsonString: true, scheduleCodec: "tease-times" }),
    binary("floodlight", IOT_CODES.FLOODLIGHT_SWITCH, "Floodlight", "lighting", "floodlight"),
    number("floodlightBrightness", IOT_CODES.FLOODLIGHT_BRIGHTNESS, "Floodlight brightness", "lighting", "floodlight", 1, 100),
    control({ id: "floodlightSchedule", code: IOT_CODES.FLOODLIGHT_SCHEDULE, label: "Floodlight schedule", category: "lighting", feature: "floodlight", kind: "schedule", access: "read-write", safety: "safe", jsonString: true, scheduleCodec: "daily-window" }),
    number("warmLightBrightness", IOT_CODES.WARM_LIGHT_BRIGHTNESS, "Warm-light brightness", "lighting", "floodlight", 1, 100),
    binary("floodlightLink", IOT_CODES.FLOODLIGHT_LINK_ENABLE, "Motion-linked floodlight", "lighting", "floodlight"),
    binary("sirenLink", IOT_CODES.SIREN_LINK_ENABLE, "Motion-linked siren", "audio", "siren"),
    binary("rgbLight", IOT_CODES.RGB_LIGHT_SWITCH, "RGB light", "lighting", "rgb"),
    control({ id: "rgbColor", code: IOT_CODES.RGB_LIGHT_COLOR, label: "RGB color", category: "lighting", feature: "rgb", kind: "color", access: "read-write", safety: "safe" }),
    control({ id: "rgbLightMode", code: IOT_CODES.RGB_LIGHT_MODE, label: "RGB light effect", category: "lighting", feature: "rgb", kind: "select", access: "read-write", safety: "safe", options: [{ value: 0, label: "Steady" }, { value: 1, label: "Color chase" }, { value: 2, label: "Breathing" }] }),
    control({ id: "rgbLightStatus", code: IOT_CODES.RGB_LIGHT_STATUS, label: "RGB light status", category: "lighting", feature: "rgb", kind: "status", access: "read", safety: "safe" }),
    control({ id: "rgbSchedule", code: IOT_CODES.RGB_LIGHT_TIMING, label: "RGB schedule", category: "lighting", feature: "rgb", kind: "schedule", access: "read-write", safety: "safe", jsonString: true, scheduleCodec: "daily-window" }),
    control({ id: "cameraLinkage", code: IOT_CODES.CAMERA_LINKAGE, label: "Camera linkage rules", category: "camera", feature: "camera", kind: "json", access: "read-write", safety: "caution", direct: true, jsonString: true }),
    control({ id: "ptzPatrol", code: IOT_CODES.PTZ_PATROL, label: "Start PTZ patrol", category: "ptz", feature: "ptz", kind: "action", access: "write", safety: "caution", direct: true, featurePromoted: true, capabilityFlags: ["ptz", "ptz2"] }),
    control({ id: "timedPtzPatrol", code: IOT_CODES.TIMED_PTZ_PATROL, label: "PTZ patrol schedule", category: "ptz", feature: "ptz", kind: "schedule", access: "read-write", safety: "safe", jsonString: true, scheduleCodec: "patrol-times" }),
    control({ id: "ptzMove", code: IOT_CODES.PTZ2_START, label: "PTZ move", category: "ptz", feature: "ptz", kind: "action", access: "write", safety: "caution", direct: true, jsonString: true, featurePromoted: true, capabilityFlags: ["ptz", "ptz2"] }),
    control({ id: "ptzCalibration", code: IOT_CODES.PTZ_CALIBRATION, label: "PTZ calibration", category: "ptz", feature: "ptz", kind: "action", access: "write", safety: "caution", direct: true, featurePromoted: true, capabilityFlags: ["ptc"] }),
    control({ id: "ptzPreset", code: IOT_CODES.PTZ_PRESET, label: "PTZ preset", category: "ptz", feature: "ptz", kind: "json", access: "write", safety: "caution", direct: true, jsonString: true, featurePromoted: true, capabilityFlags: ["ptz", "ptz2"] }),
    control({ id: "feed", code: IOT_CODES.PET_FEED_LEGACY, label: "Dispense a treat", description: "Releases one treat per command through the single-portion action (845); the multi-portion form (850, {\"parts\": n}) is not reliable on this hardware and is never sent, so the value is always 1.", category: "feeder", feature: "feeder", kind: "action", access: "write", safety: "caution", direct: true, min: 1, max: 1, featurePromoted: true, capabilityFlags: ["pet"] }),
    control({ id: "feedSound", code: IOT_CODES.PET_SOUND_SET, label: "Feeding sound URL", description: "Audio file fetched directly by the camera when food is dispensed.", category: "feeder", feature: "feeder", kind: "text", access: "read-write", safety: "safe", direct: true, jsonField: "url", featurePromoted: true, capabilityFlags: ["pms"] }),
    control({ id: "feedCall", code: IOT_CODES.PET_FEED_CALL, label: "Play feeding call", category: "feeder", feature: "feeder", kind: "action", access: "write", safety: "safe", direct: true, featurePromoted: true, capabilityFlags: ["pms"] }),
    control({ id: "petCallSound", code: IOT_CODES.PET_SOUND_CALL, label: "Pet-call sound URL", description: "Audio file fetched directly by the camera for the custom pet-call sound.", category: "feeder", feature: "pet", kind: "text", access: "read-write", safety: "safe", direct: true, jsonField: "url", featurePromoted: true, capabilityFlags: ["pms"] }),
    control({ id: "petKeyLock", code: IOT_CODES.PET_KEY_LOCK, label: "Pet-feeder key lock", description: "Lock the feeder's physical control key, matching CloudEdge property 415.", category: "feeder", feature: "pet", kind: "switch", access: "read-write", safety: "safe", featurePromoted: true, capabilityFlags: ["pkl"] }),
    control({ id: "stuckFeedRepair", code: IOT_CODES.STUCK_FEED_REPAIR, label: "Repair stuck food", description: "Run CloudEdge's one-click stuck-food repair routine.", category: "feeder", feature: "pet", kind: "action", access: "write", safety: "caution", direct: true, jsonString: true, featurePromoted: true, capabilityFlags: ["fmr"] }),
    control({ id: "remainingGrain", code: IOT_CODES.REMAINING_GRAIN_DETECT, label: "Remaining-grain detection", description: "Detect when the feeder's remaining grain reaches the selected threshold.", category: "feeder", feature: "feeder", kind: "json", access: "read-write", safety: "safe", direct: true, jsonString: true, featurePromoted: true, capabilityFlags: ["rgd"] }),
    control({ id: "watchBowl", code: IOT_CODES.WATCH_BOWL, label: "Look at food bowl", description: "Move the camera to its built-in food-bowl view, matching CloudEdge's Watch bowl action.", category: "feeder", feature: "feeder", kind: "action", access: "write", safety: "caution", direct: true, featurePromoted: true, capabilityFlags: ["bowl"] }),
    control({ id: "manualLightDuration", code: IOT_CODES.FLOODLIGHT_MANUAL_DURATION, label: "Manual-light timeout", category: "lighting", feature: "floodlight", kind: "select", access: "read-write", safety: "safe", options: [{ value: 0, label: "Automatic" }, { value: 10, label: "10 seconds" }, { value: 20, label: "20 seconds" }, { value: 30, label: "30 seconds" }, { value: 40, label: "40 seconds" }, { value: 50, label: "50 seconds" }, { value: 60, label: "60 seconds" }, { value: 300, label: "5 minutes" }, { value: 600, label: "10 minutes" }, { value: 900, label: "15 minutes" }, { value: 1200, label: "20 minutes" }, { value: 1500, label: "25 minutes" }, { value: 1800, label: "30 minutes" }] }),
    control({ id: "videoEncryption", code: IOT_CODES.VIDEO_ENCRYPTION_ENABLE, label: "Video encryption", description: "Whether CloudEdge video encryption is enabled. Password changes use a separate protected workflow.", category: "video", feature: "camera", kind: "switch", access: "read", safety: "safe" }),
    control({ id: "whistleTime", code: IOT_CODES.WHISTLE_TIME, label: "Camera whistle duration", description: "Firmware-reported whistle timing value.", category: "audio", feature: "speaker", kind: "status", access: "read", safety: "safe", unit: " seconds" }),
    control({ id: "ptzInfo", code: IOT_CODES.PTZ_INFO, label: "PTZ position information", category: "ptz", feature: "ptz", kind: "status", access: "read", safety: "safe" }),
    control({ id: "storageStatus", code: IOT_CODES.SD_STATUS, label: "Storage status", category: "storage", feature: "storage", kind: "status", access: "read", safety: "safe" }),
    control({ id: "storageCapacity", code: IOT_CODES.SD_CAPACITY, label: "Storage capacity", category: "storage", feature: "storage", kind: "status", access: "read", safety: "safe" }),
    control({ id: "storageRemaining", code: IOT_CODES.SD_REMAINING_CAPACITY, label: "Storage remaining", category: "storage", feature: "storage", kind: "status", access: "read", safety: "safe" }),
    control({ id: "storageFormatProgress", code: IOT_CODES.SD_FORMAT_PROGRESS, label: "Format progress", category: "storage", feature: "storage", kind: "status", access: "read", safety: "safe" }),
    control({ id: "formatStorage", code: IOT_CODES.FORMAT_SD_CARD, label: "Format storage", category: "storage", feature: "storage", kind: "action", access: "write", safety: "destructive", direct: true, jsonString: true, featurePromoted: true }),
    control({ id: "deleteStorageFiles", code: IOT_CODES.DELETE_SD_FILES, label: "Delete storage files", category: "storage", feature: "storage", kind: "action", access: "write", safety: "destructive", direct: true, jsonString: true, featurePromoted: true }),
    control({ id: "firmware", code: IOT_CODES.FIRMWARE_VERSION, label: "Firmware version", category: "system", feature: "always", kind: "status", access: "read", safety: "safe" }),
    control({ id: "wifiStrength", code: IOT_CODES.WIFI_STRENGTH, label: "Wi-Fi strength", category: "system", feature: "always", kind: "status", access: "read", safety: "safe" }),
    control({ id: "wifiInfo", code: IOT_CODES.DEVICE_WIFI_INFO, label: "Wi-Fi information", category: "system", feature: "always", kind: "status", access: "read", safety: "safe" }),
    control({ id: "battery", code: IOT_CODES.BATTERY_PERCENT, label: "Battery", category: "system", feature: "always", kind: "status", access: "read", safety: "safe" }),
    control({ id: "temperature", code: IOT_CODES.TEMPERATURE, label: "Temperature", category: "environment", feature: "temperature", kind: "status", access: "read", safety: "safe", scale: 1000, unit: " °C" }),
    control({ id: "humidity", code: IOT_CODES.HUMIDITY, label: "Humidity", category: "environment", feature: "humidity", kind: "status", access: "read", safety: "safe", unit: "% RH" }),
    control({ id: "foodOutDuration", code: IOT_CODES.OUT_OF_FOOD_DURATION, label: "Out-of-food duration", category: "feeder", feature: "feeder", kind: "status", access: "read", safety: "safe" }),
    control({ id: "eatDetection", code: IOT_CODES.EAT_DETECTION, label: "Eat-detection state", category: "feeder", feature: "feeder", kind: "status", access: "read", safety: "safe", featurePromoted: true, capabilityFlags: ["food"] }),
    control({ id: "outFoodInfo", code: IOT_CODES.OUT_OF_FOOD_INFO, label: "Out-of-food status", category: "feeder", feature: "feeder", kind: "status", access: "read", safety: "safe", featurePromoted: true, capabilityFlags: ["fprm"] }),
    control({ id: "todayFeedPlan", code: IOT_CODES.TODAY_FEED_PLAN, label: "Today's feed plan", category: "feeder", feature: "feeder", kind: "json", access: "read-write", safety: "safe", direct: true, jsonString: true, featurePromoted: true, capabilityFlags: ["uvd"] }),
    control({ id: "noEatDetection", code: IOT_CODES.NO_EAT_DETECTION, label: "No-eat detection", category: "feeder", feature: "feeder", kind: "switch", access: "read-write", safety: "safe", featurePromoted: true, capabilityFlags: ["mmn"] }),
    control({ id: "noEatWaitTime", code: IOT_CODES.NO_EAT_WAIT_TIME, label: "No-eat wait time", category: "feeder", feature: "feeder", kind: "number", access: "read-write", safety: "safe", min: 1, max: 24, step: 1, featurePromoted: true, capabilityFlags: ["mmn"] }),
    control({ id: "remainingGrainNotification", code: IOT_CODES.REMAINING_GRAIN_NOTIFY, label: "Remaining-grain notification", category: "feeder", feature: "feeder", kind: "status", access: "read", safety: "safe", featurePromoted: true, capabilityFlags: ["rgd"] }),
    control({ id: "mealCallState", code: IOT_CODES.MEAL_CALL_STATE, label: "Meal-call state", category: "feeder", feature: "pet", kind: "status", access: "read", safety: "safe" }),
    control({ id: "restoreFactory", code: IOT_CODES.RESTORE_FACTORY, label: "Restore factory settings", category: "system", feature: "camera", kind: "action", access: "write", safety: "destructive", direct: true, jsonString: true, featurePromoted: true }),
    control({ id: "resetDevice", code: IOT_CODES.RESET_DEVICE, label: "Restart device", category: "system", feature: "camera", kind: "action", access: "write", safety: "destructive", direct: true, featurePromoted: true }),
    control({ id: "hardReset", code: IOT_CODES.HARD_RESET_DEVICE, label: "Hard reset", category: "system", feature: "camera", kind: "action", access: "write", safety: "destructive", direct: true, jsonString: true, featurePromoted: true }),
  ]);

export const PET3T_CONTROL_BY_ID: Readonly<Record<string, Readonly<ControlDefinition>>> =
  Object.freeze(Object.fromEntries(PET3T_CONTROL_CATALOG.map((item) => [item.id, item])));

export const PET3T_CONTROLS = PET3T_CONTROL_CATALOG;
export const MEARI_IOT_CODES = IOT_CODES;

export const DESTRUCTIVE_IOT_CODES: ReadonlySet<string> = new Set(
  PET3T_CONTROL_CATALOG.filter((item) => item.safety === "destructive").map(
    (item) => item.code,
  ),
);

export function isDestructiveCode(code: string | number): boolean {
  return DESTRUCTIVE_IOT_CODES.has(String(code));
}

export function getDeviceCapabilities(device: MeariDevice): Readonly<Record<string, unknown>> {
  const raw = device.capability;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return {};
    }
  }
  if (!isRecord(parsed)) return {};
  const caps = parsed.caps;
  return isRecord(caps) ? caps : parsed;
}

export function supportsFeature(
  device: MeariDevice,
  feature: CapabilityFeature,
): boolean {
  if (feature === "always") return true;
  const caps = getDeviceCapabilities(device);
  const has = (...names: readonly string[]): boolean =>
    names.some((name) => numericCapability(caps[name]) > 0);
  const type = numericCapability(device.devTypeID);

  switch (feature) {
    case "camera": return Boolean(device.snNum);
    case "motion": return has("md", "smd");
    case "person": return has("pdt", "ptr");
    case "sound": return has("nst", "nms");
    case "cry": return has("cct");
    case "ptz": return has("ptz", "ptz2") || Boolean(device.msc);
    case "feeder": return has("pfp", "pet");
    case "pet": return has("pet", "pfp");
    case "pir": return has("pir", "plv") || type === 4 || type === 5;
    case "storage": return has("sd") || (numericCapability(caps.ver) < 6 && type !== 6);
    case "speaker": return has("ovc") || type === 4 || type === 5;
    case "floodlight": return has("flt", "ltl");
    case "siren": return has("sir", "sla");
    case "rgb": return has("rgb");
    case "laser": return has("las");
    case "temperature": return has("tmpr");
    case "humidity": return has("hmd");
    case "onvif": return has("ovf");
  }
}

/** Match CloudEdge's narrow per-control capability gates when they are known. */
export function supportsControlDefinition(
  device: MeariDevice,
  definition: Readonly<ControlDefinition>,
): boolean {
  if (definition.capabilityFlags?.length) {
    const caps = getDeviceCapabilities(device);
    return definition.capabilityFlags.some((name) => numericCapability(caps[name]) > 0);
  }
  return supportsFeature(device, definition.feature);
}

export function getAvailableControls(
  device: MeariDevice,
  values: IotValues = {},
  extensions: readonly Readonly<ControlDefinition>[] = [],
): readonly Readonly<ControlDefinition>[] {
  const observedCodes = new Set(Object.keys(values));
  return [...PET3T_CONTROL_CATALOG, ...extensions].filter(
    (definition) =>
      observedCodes.has(definition.code)
      || definition.feature === "always"
      || (definition.featurePromoted === true && supportsControlDefinition(device, definition)),
  );
}

export const getSupportedControls = getAvailableControls;

export interface SafeExtensionControl extends ControlDefinition {
  readonly safety: "safe" | "caution";
}

/**
 * Explicit extension point for firmware data points not yet in the catalog.
 * It never converts unknown codes into destructive UI actions implicitly.
 */
export function defineSafeExtensionControl(
  definition: SafeExtensionControl,
): Readonly<SafeExtensionControl> {
  assertIotCode(definition.code);
  if (isDestructiveCode(definition.code)) {
    throw new DestructiveControlError(
      definition.code,
      `IoT code ${definition.code} is destructive and cannot be a safe extension`,
    );
  }
  if (definition.access === "read" && definition.kind === "action") {
    throw new TypeError("An action extension must be writable");
  }
  return Object.freeze({ ...definition });
}

export function assertIotCode(code: string | number): asserts code is string | number {
  if (!/^\d{1,6}$/.test(String(code))) {
    throw new TypeError("IoT code must contain 1-6 decimal digits");
  }
}

export function encodeControlValue(
  definition: ControlDefinition,
  value: IotValue,
): IotValue {
  if (definition.access === "read") throw new TypeError(`${definition.id} is read-only`);
  if (definition.kind === "switch" && value !== 0 && value !== 1 && typeof value !== "boolean") {
    throw new RangeError(`${definition.id} expects a boolean or 0/1`);
  }
  if (definition.kind === "number" && typeof value !== "number") {
    throw new TypeError(`${definition.id} expects a number`);
  }
  if (definition.kind === "color") {
    if (typeof value !== "string" || !/^#[0-9a-f]{6}$/iu.test(value)) {
      throw new TypeError(`${definition.id} expects a six-digit hex color`);
    }
    return JSON.stringify([
      Number.parseInt(value.slice(1, 3), 16),
      Number.parseInt(value.slice(3, 5), 16),
      Number.parseInt(value.slice(5, 7), 16),
    ]);
  }
  if (definition.kind === "text" && typeof value !== "string") {
    throw new TypeError(`${definition.id} expects text`);
  }
  if (typeof value === "number") {
    if (definition.min !== undefined && value < definition.min) throw new RangeError(`${definition.id} must be at least ${definition.min}`);
    if (definition.max !== undefined && value > definition.max) throw new RangeError(`${definition.id} must be at most ${definition.max}`);
  }
  if (definition.options && !definition.options.some((option) => option.value === value)) {
    throw new RangeError(`${definition.id} received an unsupported option`);
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (definition.scheduleCodec) return JSON.stringify(encodeMeariSchedule(definition.scheduleCodec, value));
  if (definition.regionCodec === "grid-16x9") return JSON.stringify(encodeMeariGridRegion(value));
  if (definition.polygonRegionCodec === "property-232") return JSON.stringify(encodeMeariPolygonRegions(value));
  if (definition.jsonField) {
    if (typeof value !== "string") throw new TypeError(`${definition.id} expects text`);
    return JSON.stringify({ [definition.jsonField]: value });
  }
  if (definition.jsonString && typeof value !== "string") return JSON.stringify(value);
  if (typeof value === "number" && definition.scale !== undefined) {
    if (!Number.isFinite(definition.scale) || definition.scale <= 0) {
      throw new RangeError(`${definition.id} has an invalid scale`);
    }
    return Math.round(value * definition.scale);
  }
  return value;
}

function numericCapability(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value === true) return 1;
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
