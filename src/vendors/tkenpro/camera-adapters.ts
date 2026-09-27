import { networkInterfaces } from "node:os";
import {
  isSafeCameraUri,
  type CameraPlayback,
  type CameraPlaybackFrame,
} from "../../camera-media";
import type {
  CameraCapabilityCategory,
  CameraCapabilityDescriptor,
  CameraCapabilityKind,
  CameraDeviceView,
} from "../../ui/dashboard";
import {
  CameraService,
  CameraServiceError,
  type CameraController,
  type CameraServiceDependencies,
  type CloudCameraSession,
  type LocalCameraCredentials,
  type ManagedCamera,
  type CameraNetworkModeLike,
  type LocalRegistrationLike,
  mergeConnections,
  credentialsForHost,
} from "./camera-service";
import type { CameraDiscoverRequest, CameraSetupRequest } from "../../schemas";
import type { CameraSetupStore } from "./setup-store";
import {
  IOT_CODES,
  MeariClient,
  MeariApiError,
  MeariAuthError,
  MeariLocalTalkbackClient,
  MeariLocalPlaybackClient,
  PET3T_CONTROL_BY_ID,
  PET3T_CONTROL_CATALOG,
  decodeMeariGridRegion,
  decodeMeariPolygonRegions,
  decodeMeariSchedule,
  encodeControlValue,
  getAvailableControls,
  type ControlDefinition,
  type DestructiveConfirmation,
  type FeedPortions,
  type FeedSchedule,
  type IotValue,
  type IotValues,
  type MeariLocalCameraAuthorization,
  type MeariLocalCloudRuntime,
  type MeariDevice,
  type MeariCommonRequest,
  type MeariPeerCommandResponse,
  MeariLocalPeerClient,
} from "../../protocols/tkenpro";
import {
  OnvifClient,
  type OnvifImagingSettingsPatch,
  type OnvifProfile,
} from "../../protocols/onvif/client";
import { discoverCameras, isCompatiblePetCamera, type DiscoveredCamera } from "../../protocols/tkenpro/discovery";
import type { CameraInventoryStore, InventoryCamera } from "./inventory-store";
import type {
  CameraCloudAccount,
  CameraIdentity,
  CameraLocation,
  CameraRecoveryCredentials,
  CameraRecoveryDependencies,
} from "../../models/recovery";

/** The Pet 3T's multi-portion feed action is unreliable, so every dispense is exactly one treat. */
const ONE_TREAT_PER_COMMAND = "This dispenser delivers one treat per command; send 1 and repeat for more";

const STANDARD_IDS: Readonly<Record<string, string>> = Object.freeze({
  statusLed: "device.statusLed",
  rotateImage: "video.flip",
  motionDetection: "detection.motion",
  motionSensitivity: "detection.motionSensitivity",
  soundDetection: "detection.sound",
  soundSensitivity: "detection.soundSensitivity",
  humanTracking: "detection.tracking",
  dayNightMode: "video.nightVision",
  sleepMode: "device.privacy",
  onvif: "onvif.enabled",
  recording: "storage.recording",
  recordType: "storage.mode",
  speakerVolume: "audio.volume",
  microphone: "audio.microphone",
  petAlarm: "detection.pet",
  petDogAlarm: "detection.dog",
  petCatAlarm: "detection.cat",
  feedSchedule: "feed.schedule",
  ptzPatrol: "camera.patrol",
  ptzMove: "camera.ptz",
  ptzCalibration: "camera.calibrate",
  ptzPreset: "camera.presets",
  feed: "feed.portions",
  formatStorage: "storage.format",
  resetDevice: "device.restart",
  restoreFactory: "device.factoryReset",
});

const REVERSE_STANDARD_IDS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(STANDARD_IDS).map(([controlId, uiId]) => [uiId, controlId])),
);

function meariControlId(capabilityId: string): string {
  return REVERSE_STANDARD_IDS[capabilityId]
    ?? (capabilityId.startsWith("meari.") ? capabilityId.slice("meari.".length) : capabilityId);
}

function isNativeMeariCapability(capabilityId: string): boolean {
  return capabilityId === "device.wake" || PET3T_CONTROL_BY_ID[meariControlId(capabilityId)] !== undefined;
}

function toCategory(category: ControlDefinition["category"]): CameraCapabilityCategory {
  switch (category) {
    case "camera": return "privacy";
    case "detection": return "detection";
    case "video":
    case "lighting": return "video";
    case "audio": return "audio";
    case "ptz": return "movement";
    case "feeder": return "feeding";
    case "storage": return "storage";
    case "system":
    case "environment": return "advanced";
  }
}

function toKind(definition: ControlDefinition): CameraCapabilityKind {
  if (definition.id === "feed") return "treat";
  if (definition.id === "ptzPreset") return "presets";
  if (definition.id === "ptzMove") return "ptz";
  switch (definition.kind) {
    case "switch": return "toggle";
    case "number": return "range";
    case "color": return "color";
    case "text": return "text";
    case "select": return "select";
    case "schedule": return "schedule";
    case "region": return "region";
    case "polygon-region": return "polygon-region";
    case "action": return "action";
    case "json": return "json";
    case "status": return "status";
  }
}

function jsonString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function primitiveValue(definition: ControlDefinition, value: IotValue | undefined): boolean | string | number | null | undefined {
  if (value === undefined) return undefined;
  if (definition.kind === "color") {
    let candidate: unknown = value;
    if (typeof candidate === "string") {
      try { candidate = JSON.parse(candidate) as unknown; } catch { return typeof value === "string" ? value : jsonString(value); }
    }
    if (
      Array.isArray(candidate)
      && candidate.length === 3
      && candidate.every((channel) => typeof channel === "number" && Number.isInteger(channel) && channel >= 0 && channel <= 255)
    ) {
      return `#${candidate.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
    }
    return jsonString(value);
  }
  if (definition.jsonField && typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        const field = (parsed as Record<string, unknown>)[definition.jsonField];
        if (typeof field === "string") return field;
      }
    } catch {
      // Preserve an unexpected firmware value for diagnostics instead of hiding it.
    }
  }
  if (definition.kind === "switch") return value === true || value === 1 || value === "1";
  if (definition.scale !== undefined) {
    const numeric = typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
    if (Number.isFinite(numeric)) return numeric / definition.scale;
  }
  if (definition.id === "dayNightMode") {
    return value === 2 || value === "2" ? "auto" : value === 1 || value === "1" ? "on" : "off";
  }
  if (definition.id === "recordType") return value === 1 || value === "1" ? "events" : "continuous";
  if (definition.kind === "select") return String(value);
  return value === null || ["string", "number", "boolean"].includes(typeof value)
    ? value as boolean | string | number | null
    : jsonString(value);
}

function optionValue(definition: ControlDefinition, value: string | number): string {
  if (definition.id === "dayNightMode") {
    return value === 2 ? "auto" : value === 1 ? "on" : "off";
  }
  if (definition.id === "recordType") return value === 1 ? "events" : "continuous";
  return String(value);
}

function capabilityId(definition: ControlDefinition): string {
  return STANDARD_IDS[definition.id] ?? `meari.${definition.id}`;
}

function descriptorForControl(
  definition: ControlDefinition,
  values: IotValues,
): CameraCapabilityDescriptor {
  const value = primitiveValue(definition, values[definition.code]);
  const decodedSchedule = definition.scheduleCodec
    ? decodeMeariSchedule(definition.scheduleCodec, values[definition.code])
    : undefined;
  const decodedRegion = definition.regionCodec === "grid-16x9"
    ? decodeMeariGridRegion(values[definition.code])
    : undefined;
  const decodedPolygonRegion = definition.polygonRegionCodec === "property-232"
    ? decodeMeariPolygonRegions(values[definition.code])
    : undefined;
  return {
    id: capabilityId(definition),
    category: definition.id === "onvif" ? "onvif" : toCategory(definition.category),
    label: definition.label,
    ...(definition.description ? { description: definition.description } : {}),
    kind: toKind(definition),
    availability: "available",
    ...(definition.kind === "schedule" || definition.kind === "region" || definition.kind === "polygon-region" || value === undefined ? {} : { value }),
    ...(decodedSchedule ? {
      schedule: {
        mode: decodedSchedule.mode,
        maxEntries: decodedSchedule.maxEntries,
        entries: decodedSchedule.entries.map((entry) => ({
          enabled: entry.enabled,
          ...(entry.time === undefined ? {} : { time: entry.time }),
          ...(entry.startTime === undefined ? {} : { startTime: entry.startTime }),
          ...(entry.endTime === undefined ? {} : { endTime: entry.endTime }),
          ...(entry.days ? { days: [...entry.days] } : {}),
          ...(entry.once === undefined ? {} : { once: entry.once }),
          ...(entry.portions === undefined ? {} : { portions: entry.portions }),
          ...(entry.sound === undefined ? {} : { sound: entry.sound }),
          ...(entry.mode === undefined ? {} : { mode: entry.mode }),
          ...(entry.auto === undefined ? {} : { auto: entry.auto }),
        })),
      },
    } : {}),
    ...(decodedRegion ? {
      region: {
        width: decodedRegion.width,
        height: decodedRegion.height,
        selectedCells: [...decodedRegion.selectedCells],
      },
    } : {}),
    ...(decodedPolygonRegion ? {
      polygonRegion: {
        maxPolygons: decodedPolygonRegion.maxPolygons,
        pointCount: decodedPolygonRegion.pointCount,
        polygons: decodedPolygonRegion.polygons.map((polygon) => ({
          type: polygon.type,
          points: polygon.points.map((point) => ({ ...point })),
          ...(polygon.vId === undefined ? {} : { vId: polygon.vId }),
          ...(polygon.aiTypes === undefined ? {} : { aiTypes: [...polygon.aiTypes] }),
        })),
      },
    } : {}),
    ...(definition.options ? {
      options: definition.options.map((option) => ({ value: optionValue(definition, option.value), label: option.label })),
    } : {}),
    ...(definition.min === undefined ? {} : { min: definition.min }),
    ...(definition.max === undefined ? {} : { max: definition.max }),
    ...(definition.step === undefined ? {} : { step: definition.step }),
    ...(definition.unit === undefined ? {} : { unit: definition.unit }),
    ...(definition.access === "read" || definition.kind === "status"
      ? { readOnly: true }
      : {}),
    confirmation: definition.safety === "safe"
      ? "none"
      : definition.safety === "caution"
        ? "confirm"
        : "type-device-name",
    ...(definition.safety === "destructive" ? { dangerous: true } : {}),
  };
}

function mergeCapabilityDescriptors(
  first: readonly CameraCapabilityDescriptor[],
  second: readonly CameraCapabilityDescriptor[],
): CameraCapabilityDescriptor[] {
  const merged = new Map(first.map((capability) => [capability.id, capability]));
  for (const capability of second) {
    const existing = merged.get(capability.id);
    if (!existing) {
      merged.set(capability.id, capability);
      continue;
    }
    const replacement: CameraCapabilityDescriptor = { ...existing, ...capability };
    // Optional flags describe the active controller, not durable facts. A
    // read-only discovery placeholder must not keep a native local control
    // disabled after the authenticated MsgSvr channel comes online.
    if (!("readOnly" in capability)) delete replacement.readOnly;
    if (!("dangerous" in capability)) delete replacement.dangerous;
    merged.set(capability.id, replacement);
  }
  return [...merged.values()];
}

function serialOf(device: MeariDevice): string | undefined {
  const value = device.snNum;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function deviceIdOf(device: MeariDevice): string {
  return serialOf(device) ?? String(device.deviceID ?? crypto.randomUUID());
}

function deviceNameOf(device: MeariDevice): string {
  const name = device.deviceName;
  return typeof name === "string" && name.trim() ? name.trim() : "TKENPRO pet camera";
}

function isJsonValue(value: unknown): value is IotValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object"
    && value !== null
    && Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function controlValue(
  definition: ControlDefinition,
  capabilityId: string,
  value: unknown,
): IotValue {
  if (capabilityId === "video.nightVision") {
    if (value === "off") return 0;
    if (value === "on") return 1;
    if (value === "auto") return 2;
  }
  if (capabilityId === "storage.mode") {
    if (value === "continuous") return 0;
    if (value === "events") return 1;
  }
  if (capabilityId === "device.privacy" && typeof value === "boolean") return value ? 2 : 0;
  if (definition.kind === "select" && typeof value === "string") {
    const option = definition.options?.find((candidate) => String(candidate.value) === value);
    if (!option) {
      throw new CameraServiceError(`${definition.label} received an unsupported option`, "invalid_control");
    }
    return option.value;
  }
  if (!isJsonValue(value)) throw new CameraServiceError("The control value must be valid JSON", "invalid_control");
  return value;
}

const WEEKDAY_BY_NAME: Readonly<Record<string, 0 | 1 | 2 | 3 | 4 | 5 | 6>> = Object.freeze({
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
});

function feedSchedule(value: unknown): FeedSchedule {
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length === 0 || entries.length > 100) {
    throw new CameraServiceError("A feeding schedule needs 1 to 100 entries", "invalid_control");
  }
  return entries.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new CameraServiceError(`Feeding schedule entry ${index + 1} must be an object`, "invalid_control");
    }
    const schedule = entry as Record<string, unknown>;
    if (typeof schedule.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(schedule.time)) {
      throw new CameraServiceError(`Feeding schedule entry ${index + 1} needs a valid HH:MM time`, "invalid_control");
    }
    if (schedule.enabled !== undefined && typeof schedule.enabled !== "boolean") {
      throw new CameraServiceError(`Feeding schedule entry ${index + 1} enabled must be true or false`, "invalid_control");
    }
    const parts = schedule.parts === undefined ? 1 : Number(schedule.parts);
    if (!Number.isInteger(parts) || parts < 1 || parts > 10) {
      throw new CameraServiceError(`Feeding schedule entry ${index + 1} needs 1 to 10 portions`, "invalid_control");
    }
    if (schedule.days !== undefined && !Array.isArray(schedule.days)) {
      throw new CameraServiceError(`Feeding schedule entry ${index + 1} days must be a list`, "invalid_control");
    }
    const rawDays = Array.isArray(schedule.days) ? schedule.days : [];
    const days = rawDays.map((day) => {
      if (typeof day === "number" && Number.isInteger(day) && day >= 0 && day <= 6) {
        return day as 0 | 1 | 2 | 3 | 4 | 5 | 6;
      }
      if (typeof day === "string" && WEEKDAY_BY_NAME[day] !== undefined) return WEEKDAY_BY_NAME[day]!;
      throw new CameraServiceError(`Feeding schedule entry ${index + 1} has an invalid day`, "invalid_control");
    });
    if (new Set(days).size !== days.length) {
      throw new CameraServiceError(`Feeding schedule entry ${index + 1} repeats a day`, "invalid_control");
    }
    return {
      ...(schedule.id === undefined ? {} : { id: String(schedule.id) }),
      time: schedule.time,
      parts: parts as FeedPortions,
      enabled: schedule.enabled !== false,
      days,
    };
  });
}

function numericPresetId(value: unknown): number {
  const id = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isInteger(id) || id < 1 || id > 255) {
    throw new CameraServiceError("Saved-view ID must be a whole number from 1 to 255", "invalid_control");
  }
  return id;
}

function destructiveConfirmation(controlId: string): DestructiveConfirmation | undefined {
  switch (controlId) {
    case "resetDevice": return "RESET_DEVICE";
    case "formatStorage": return "FORMAT_STORAGE";
    case "deleteStorageFiles": return "DELETE_STORAGE_FILES";
    case "restoreFactory": return "RESTORE_FACTORY_SETTINGS";
    case "hardReset": return "HARD_RESET_DEVICE";
    default: return undefined;
  }
}

export class MeariCameraController implements CameraController {
  private readonly presetIds: Set<number>;

  constructor(
    private readonly client: MeariClient,
    private readonly serialNumber: string,
    private readonly onvifPassword?: string,
    knownPresetIds: readonly number[] = [],
  ) {
    this.presetIds = new Set(knownPresetIds.filter((id) => Number.isInteger(id) && id >= 1 && id <= 255));
  }

  async control(capabilityId: string, value: unknown, confirmed: boolean): Promise<void> {
    if (capabilityId === "device.wake") {
      if (value !== true) {
        throw new CameraServiceError("Wake camera expects true", "invalid_control");
      }
      await this.client.wakeDevice(this.serialNumber);
      return;
    }
    const controlId = meariControlId(capabilityId);
    const definition = PET3T_CONTROL_BY_ID[controlId];
    if (!definition) throw new CameraServiceError("This firmware control is not in the PET3T catalog", "not_supported");
    if (definition.safety !== "safe" && !confirmed) {
      throw new CameraServiceError("Confirm this camera action before continuing", "confirmation_required");
    }

    if (controlId === "onvif") {
      if (value !== true && value !== false && value !== 1 && value !== 0) {
        throw new CameraServiceError("ONVIF must be enabled or disabled", "invalid_control");
      }
      const enabled = value === true || value === 1;
      if (enabled && !this.onvifPassword) {
        throw new CameraServiceError(
          "Enter an ONVIF password in camera setup before enabling ONVIF for the first time",
          "not_configured",
        );
      }
      if (this.onvifPassword) {
        await this.client.configureOnvif(this.serialNumber, {
          enabled,
          password: this.onvifPassword,
        });
      } else {
        await this.client.setOnvif(this.serialNumber, false);
      }
      return;
    }

    if (controlId === "feed") {
      if (Number(value) !== 1) throw new CameraServiceError(ONE_TREAT_PER_COMMAND, "invalid_control");
      await this.client.feed(this.serialNumber);
      return;
    }
    if (controlId === "feedSchedule") {
      await this.client.setFeedSchedule(this.serialNumber, feedSchedule(value));
      return;
    }
    if (controlId === "ptzCalibration") {
      await this.client.calibratePtz(this.serialNumber);
      return;
    }
    if (controlId === "feedCall") {
      await this.client.playFeedCall(this.serialNumber);
      return;
    }
    if (controlId === "resetDevice") {
      await this.client.resetDevice(this.serialNumber, "RESET_DEVICE");
      return;
    }
    if (controlId === "formatStorage") {
      await this.client.formatStorage(this.serialNumber, "FORMAT_STORAGE");
      return;
    }
    if (controlId === "deleteStorageFiles") {
      await this.client.deleteStorageFiles(this.serialNumber, "DELETE_STORAGE_FILES");
      return;
    }
    if (controlId === "restoreFactory") {
      await this.client.restoreFactorySettings(this.serialNumber, "RESTORE_FACTORY_SETTINGS");
      return;
    }
    if (controlId === "hardReset") {
      await this.client.hardResetDevice(this.serialNumber, "HARD_RESET_DEVICE");
      return;
    }
    if (controlId === "ptzPreset") {
      const command = value as { action?: unknown; presetId?: unknown; name?: unknown };
      if (command.action === "recall") {
        await this.client.goToPtzPreset(this.serialNumber, numericPresetId(command.presetId));
      } else if (command.action === "save") {
        const name = typeof command.name === "string" ? command.name.trim() : "";
        if (!name || name.length > 40) {
          throw new CameraServiceError("A saved view needs a name of 1 to 40 characters", "invalid_control");
        }
        const nextAvailable = (): number => {
          for (let id = 1; id <= 255; id += 1) {
            if (!this.presetIds.has(id)) return id;
          }
          throw new CameraServiceError("This camera has no free saved-view slots", "invalid_control");
        };
        const id = command.presetId === undefined ? nextAvailable() : numericPresetId(command.presetId);
        await this.client.setPtzPreset(this.serialNumber, {
          id,
          name,
        });
        this.presetIds.add(id);
      } else if (command.action === "delete") {
        const id = numericPresetId(command.presetId);
        await this.client.deletePtzPreset(this.serialNumber, id);
        this.presetIds.delete(id);
      } else {
        throw new CameraServiceError("Choose whether to save, recall, or delete a camera view", "invalid_control");
      }
      return;
    }

    const confirmation = destructiveConfirmation(controlId);
    await this.client.setControl(
      this.serialNumber,
      controlId,
      controlValue(definition, capabilityId, value),
      {
        ...(confirmation ? { confirmation } : {}),
      },
    );
  }

  async ptzStart(direction: "left" | "right" | "up" | "down"): Promise<void> {
    await this.client.ptzStart(this.serialNumber, direction);
  }

  async ptzStop(): Promise<void> {
    await this.client.ptzStop(this.serialNumber);
  }
}

/** Native PET3T controller backed by the camera's local MsgSvr session. */
export class MeariLocalCameraController implements CameraController {
  private readonly presetIds: Set<number>;
  private localCommandTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly runtime: MeariLocalCloudRuntime,
    private readonly uuid: string,
    private readonly onvifPassword?: string,
    knownPresetIds: readonly number[] = [],
    private readonly sendOverride?: (values: Readonly<Record<string, IotValue>>) => Promise<void>,
  ) {
    this.presetIds = new Set(knownPresetIds.filter((id) => Number.isInteger(id) && id >= 1 && id <= 255));
  }

  private async send(values: Readonly<Record<string, IotValue>>): Promise<Readonly<Record<string, unknown>>> {
    if (this.sendOverride) {
      await this.sendOverride(values);
      return {};
    }
    // PET3T is an IoT-mode camera: CloudEdge sends its property writes over
    // the persistent MsgSvr settings channel. The authenticated local emulator
    // terminates that channel and receives the camera's ordinary `rsp` ACK.
    return await this.runtime.emulator.setIot(this.uuid, values);
  }

  async close(): Promise<void> {}

  async control(capabilityId: string, value: unknown, confirmed: boolean): Promise<void> {
    if (capabilityId === "device.wake") {
      if (value !== true) throw new CameraServiceError("Wake camera expects true", "invalid_control");
      if (!this.runtime.emulator.connectedDeviceUuids.includes(this.uuid)) {
        throw new CameraServiceError("The camera is not connected to local control", "camera_error");
      }
      return;
    }
    const controlId = meariControlId(capabilityId);
    const definition = PET3T_CONTROL_BY_ID[controlId];
    if (!definition) throw new CameraServiceError("This firmware control is not in the PET3T catalog", "not_supported");
    if (definition.safety !== "safe" && !confirmed) {
      throw new CameraServiceError("Confirm this camera action before continuing", "confirmation_required");
    }

    if (controlId === "onvif") {
      if (value !== true && value !== false && value !== 1 && value !== 0) {
        throw new CameraServiceError("ONVIF must be enabled or disabled", "invalid_control");
      }
      const enabled = value === true || value === 1;
      if (enabled && !this.onvifPassword) {
        throw new CameraServiceError(
          "Enter an ONVIF password in camera setup before enabling ONVIF for the first time",
          "not_configured",
        );
      }
      const values: Record<string, IotValue> = { [IOT_CODES.ONVIF_ENABLE]: enabled ? 1 : 0 };
      if (this.onvifPassword) {
        if (this.onvifPassword.length > 16 || !/^[\x20-\x7e]+$/u.test(this.onvifPassword)) {
          throw new CameraServiceError("The ONVIF password must be 1–16 printable characters", "invalid_control");
        }
        values[IOT_CODES.ONVIF_PASSWORD] = Buffer.from(this.onvifPassword, "utf8").toString("base64");
      }
      await this.send(values);
      return;
    }

    if (controlId === "feed") {
      if (Number(value) !== 1) throw new CameraServiceError(ONE_TREAT_PER_COMMAND, "invalid_control");
      // Only the single-portion action; the `{parts: n}` form is unreliable on this hardware.
      await this.send({ [IOT_CODES.PET_FEED_LEGACY]: 1 });
      return;
    }
    if (controlId === "feedSchedule") {
      await this.send({ [IOT_CODES.PET_FEED_PLAN_LIST]: JSON.stringify(feedSchedule(value)) });
      return;
    }
    if (controlId === "feedCall") {
      await this.send({ [IOT_CODES.PET_FEED_CALL]: 1 });
      return;
    }
    const actionValues: Readonly<Record<string, readonly [string, IotValue]>> = {
      ptzCalibration: [IOT_CODES.PTZ_CALIBRATION, 1],
      ptzPatrol: [IOT_CODES.PTZ_PATROL, "{}"],
      stuckFeedRepair: [IOT_CODES.STUCK_FEED_REPAIR, JSON.stringify({ fix: 1 })],
      resetDevice: [IOT_CODES.RESET_DEVICE, "1"],
      formatStorage: [IOT_CODES.FORMAT_SD_CARD, "{}"],
      deleteStorageFiles: [IOT_CODES.DELETE_SD_FILES, "{}"],
      restoreFactory: [IOT_CODES.RESTORE_FACTORY, "{}"],
      hardReset: [IOT_CODES.HARD_RESET_DEVICE, "{}"],
    };
    const action = actionValues[controlId];
    if (action) {
      await this.send({ [action[0]]: action[1] });
      return;
    }
    if (controlId === "ptzPreset") {
      const command = value as { action?: unknown; presetId?: unknown; name?: unknown };
      if (command.action === "recall") {
        await this.send({
          [IOT_CODES.PTZ_PRESET]: JSON.stringify({ idx: numericPresetId(command.presetId) }),
        });
      } else {
        throw new CameraServiceError("Native property 848 only recalls a saved view; use local ONVIF to save or delete views", "not_supported");
      }
      return;
    }

    if (controlId === "soundDetection" || controlId === "soundSensitivity") {
      // CloudEdge always writes these as one atomic pair. PET3T accepts an
      // enable-only write, but rejects a standalone sensitivity update.
      const state = this.runtime.emulator.getDeviceState(this.uuid);
      const currentEnable = Number(state[IOT_CODES.SOUND_DET_ENABLE]);
      const currentSensitivity = Number(state[IOT_CODES.SOUND_DET_SENSITIVITY]);
      const encoded = Number(encodeControlValue(
        definition,
        controlValue(definition, capabilityId, value),
      ));
      await this.send({
        [IOT_CODES.SOUND_DET_ENABLE]: controlId === "soundDetection"
          ? encoded
          : currentEnable === 1 ? 1 : 0,
        [IOT_CODES.SOUND_DET_SENSITIVITY]: controlId === "soundSensitivity"
          ? encoded
          : Number.isInteger(currentSensitivity) && currentSensitivity >= 0 && currentSensitivity <= 2
            ? currentSensitivity
            : 1,
      });
      return;
    }

    const normalized = controlValue(definition, capabilityId, value);
    await this.send({ [definition.code]: encodeControlValue(definition, normalized) });
  }

  async ptzStart(direction: "left" | "right" | "up" | "down"): Promise<void> {
    const [ps, ts] = direction === "left" ? [-80, 0]
      : direction === "right" ? [80, 0]
        : direction === "up" ? [0, 20]
          : [0, -20];
    await this.send({ [IOT_CODES.PTZ2_START]: JSON.stringify({ ps, ts, zs: 0 }) });
  }

  async ptzStop(): Promise<void> {
    await this.send({ [IOT_CODES.PTZ2_STOP]: "{}" });
  }

  async localCommand(request: MeariCommonRequest): Promise<MeariPeerCommandResponse> {
    const operation = this.localCommandTail.then(async () => {
      const client = new MeariLocalPeerClient({
        runtime: this.runtime,
        uuid: this.uuid,
      });
      try {
        return await client.request(request);
      } finally {
        await client.close();
        // PET3T closes its peer session asynchronously. Give the firmware a
        // short handoff window before the next local command negotiates.
        await new Promise<void>((resolve) => setTimeout(resolve, 350));
      }
    });
    this.localCommandTail = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  async localIot(values: IotValues): Promise<Readonly<Record<string, unknown>>> {
    return await this.send(values);
  }
}

function parsePresets(value: IotValue | undefined): { id: string; label: string }[] {
  let candidate: unknown = value;
  if (typeof candidate === "string") {
    try { candidate = JSON.parse(candidate) as unknown; } catch { return []; }
  }
  if (!Array.isArray(candidate)) return [];
  return candidate.flatMap((item, index) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    const id = record.id ?? record.presetId ?? index + 1;
    return [{ id: String(id), label: String(record.name ?? record.label ?? `Saved view ${index + 1}`) }];
  });
}

function mediaFromCloudValues(
  values: IotValues,
  onvifPassword?: string,
): ManagedCamera["media"] | undefined {
  let raw: unknown = values[IOT_CODES.ONVIF_URL];
  if (typeof raw === "string" && !/^rtsps?:\/\//i.test(raw)) {
    try { raw = JSON.parse(raw) as unknown; } catch { return undefined; }
  }
  const record = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : undefined;
  const uri = typeof raw === "string"
    ? raw
    : typeof record?.url === "string"
      ? record.url
      : typeof record?.rtsp === "string"
        ? record.rtsp
        : undefined;
  if (!uri || !/^rtsps?:\/\//i.test(uri) || !isSafeCameraUri(uri)) return undefined;
  const rawPassword = onvifPassword ?? values[IOT_CODES.ONVIF_PASSWORD];
  const passwordValue = typeof rawPassword === "string" ? decodeLegacyOnvifPassword(rawPassword) : undefined;
  return {
    streamUri: uri,
    username: "admin",
    ...(passwordValue ? { password: passwordValue } : {}),
  };
}

function decodeLegacyOnvifPassword(value: string): string {
  const trimmed = value.trim();
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(trimmed)) {
    return value;
  }
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    return decoded.length > 0 && decoded.length <= 16 && /^[\x20-\x7e]+$/u.test(decoded)
      ? decoded
      : value;
  } catch {
    return value;
  }
}

class LocalPreferredCameraController implements CameraController {
  constructor(
    private readonly local: MeariLocalCameraController,
    private readonly fallback: CameraController,
  ) {}

  async control(capabilityId: string, value: unknown, confirmed: boolean): Promise<void> {
    if (capabilityId === "camera.presets") {
      // PET3T's native property 848 can recall a saved view locally. ONVIF
      // remains the fallback for creating/removing views because those
      // operations are not implemented by this firmware property.
      const action = typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>).action
        : undefined;
      if (action === "recall") {
        await this.local.control(capabilityId, value, confirmed);
      } else {
        await this.fallback.control(capabilityId, value, confirmed);
      }
      return;
    }
    if (isNativeMeariCapability(capabilityId)) {
      await this.local.control(capabilityId, value, confirmed);
    } else {
      await this.fallback.control(capabilityId, value, confirmed);
    }
  }

  async ptzStart(direction: "left" | "right" | "up" | "down"): Promise<void> {
    await this.local.ptzStart(direction);
  }

  async ptzStop(): Promise<void> {
    await this.local.ptzStop();
  }

  async localCommand(request: MeariCommonRequest): Promise<MeariPeerCommandResponse> {
    return await this.local.localCommand(request);
  }

  async localIot(values: IotValues): Promise<Readonly<Record<string, unknown>>> {
    return await this.local.localIot(values);
  }

  async close(): Promise<void> {
    await Promise.all([
      this.local.close(),
      this.fallback.close?.(),
    ]);
  }
}

class MeariLocalCameraPlayback implements CameraPlayback {
  private client: MeariLocalPlaybackClient | undefined;
  private controller: ReadableStreamDefaultController<CameraPlaybackFrame> | undefined;
  private generation = 0;

  constructor(
    private readonly runtime: MeariLocalCloudRuntime,
    private readonly uuid: string,
  ) {}

  async start(timestamp: string): Promise<ReadableStream<CameraPlaybackFrame>> {
    await this.stop();
    const generation = ++this.generation;
    let streamController: ReadableStreamDefaultController<CameraPlaybackFrame> | undefined;
    const stream = new ReadableStream<CameraPlaybackFrame>({
      start(controller) {
        streamController = controller;
      },
      cancel: async () => {
        if (this.generation === generation) await this.stop();
      },
    });
    this.controller = streamController;
    const client = new MeariLocalPlaybackClient({
      runtime: this.runtime,
      uuid: this.uuid,
      onEvent: (event) => {
        if (this.generation !== generation || this.client !== client) return;
        if (event.type === "media") {
          try {
            this.controller?.enqueue({
              kind: event.frame.kind,
              codec: event.frame.codec,
              keyFrame: event.frame.keyFrame,
              timestamp: event.frame.timestamp,
              payload: event.frame.payload,
            });
          } catch {
            // A browser may close the stream before the camera notices.
          }
        } else if (event.type === "media-error") {
          try { this.controller?.error(new Error(event.message)); } catch { /* Stream already closed. */ }
          this.controller = undefined;
          void this.stop();
        }
      },
    });
    this.client = client;
    try {
      await client.prepare();
      const response = await client.start(timestamp);
      if (response.result === -14 || response.result === -1) {
        throw new Error(`The camera has no recording at that time (playback code ${response.result})`);
      }
      return stream;
    } catch (error) {
      if (this.client === client) {
        this.client = undefined;
        this.controller = undefined;
      }
      try { streamController?.error(error); } catch { /* Stream never reached a reader. */ }
      await client.close();
      throw error;
    }
  }

  pause(): void {
    if (!this.client) throw new Error("Local SD playback is not active");
    this.client.pause();
  }

  resume(): void {
    if (!this.client) throw new Error("Local SD playback is not active");
    this.client.resume();
  }

  seek(timestamp: string): void {
    if (!this.client) throw new Error("Local SD playback is not active");
    this.client.seek(timestamp);
  }

  async stop(): Promise<void> {
    const client = this.client;
    const controller = this.controller;
    this.client = undefined;
    this.controller = undefined;
    this.generation += 1;
    try { controller?.close(); } catch { /* Reader already cancelled. */ }
    await client?.close();
  }

  async close(): Promise<void> {
    await this.stop();
  }
}

function localIotValues(runtime: MeariLocalCloudRuntime, uuid: string): IotValues {
  return Object.freeze(Object.fromEntries(
    Object.entries(runtime.emulator.getDeviceState(uuid))
      .filter((entry): entry is [string, IotValue] => isJsonValue(entry[1])),
  ));
}

function localControlDefinitions(
  values: IotValues,
  capabilityFlags?: Readonly<Record<string, number>>,
): readonly Readonly<ControlDefinition>[] {
  if (capabilityFlags) {
    return getAvailableControls({
      snNum: "local-camera",
      capability: { caps: capabilityFlags },
    }, values);
  }
  const observedCodes = new Set(Object.keys(values));
  const observedFeatures = new Set(
    PET3T_CONTROL_CATALOG
      .filter((definition) => observedCodes.has(definition.code))
      .map((definition) => definition.feature),
  );
  return PET3T_CONTROL_CATALOG.filter((definition) => (
    definition.feature === "always"
    || observedCodes.has(definition.code)
    || (definition.featurePromoted === true && observedFeatures.has(definition.feature))
  ));
}

/** Adds the authenticated native command channel to a LAN-discovered camera. */
export class MeariLocalControlAdapter {
  private readonly discoveredByHost = new Map<string, DiscoveredCamera>();

  constructor(private readonly runtime: MeariLocalCloudRuntime) {}

  /**
   * Registration tracking for the reconnect flow: after a Wi-Fi kick the
   * service waits for the camera's next real `registered` event rather than
   * trusting a session the emulator may still be holding for the old link.
   */
  registration(): LocalRegistrationLike {
    const runtime = this.runtime;
    const uuidFor = (address: string): string | undefined =>
      runtime.authorization.devices.find((device) => device.sourceAddress === address)?.uuid;
    return {
      cameraAddresses: runtime.cameraAddresses,
      isRegistered(address) {
        const uuid = uuidFor(address);
        return uuid !== undefined && runtime.emulator.connectedDeviceUuids.includes(uuid);
      },
      waitForEvent(address, kind, timeoutMs) {
        const uuid = uuidFor(address);
        if (uuid === undefined) return Promise.resolve(undefined);
        const startedAt = Date.now();
        return new Promise((resolve) => {
          let unsubscribe = (): void => undefined;
          const timer = setTimeout(() => {
            unsubscribe();
            resolve(undefined);
          }, timeoutMs);
          unsubscribe = runtime.subscribe((event) => {
            if (event.type !== kind || event.uuid !== uuid) return;
            clearTimeout(timer);
            unsubscribe();
            resolve(Date.now() - startedAt);
          });
        });
      },
    };
  }

  private discoveredCameraFor(
    authorization: MeariLocalCameraAuthorization,
  ): DiscoveredCamera | undefined {
    if (!authorization.sourceAddress) return undefined;
    const cached = this.discoveredByHost.get(authorization.sourceAddress);
    if (cached) return cached;
    const serialNumber = /^0{7}\d{9}$/u.test(authorization.uuid)
      ? authorization.uuid.slice(7)
      : undefined;
    const model = authorization.clientId?.trim() || undefined;
    return {
      id: `meari-local-${authorization.uuid}`,
      host: authorization.sourceAddress,
      sources: ["meari-lan"],
      ...(model ? { server: model, model } : {}),
      ...(serialNumber ? { serialNumber } : {}),
      deviceName: "Local pet camera",
      onvifAdvertised: Number(authorization.capabilityFlags?.ovf ?? 0) > 0,
      types: ["meari:camera"],
      scopes: [],
      locations: [],
      onvifEndpoints: [],
      openPorts: [],
    };
  }

  /** Keep authenticated local cameras present even while ONVIF is disabled. */
  attachRegisteredCameras(
    credentials: LocalCameraCredentials,
    alreadyDiscoveredHosts: ReadonlySet<string> = new Set(),
  ): ManagedCamera[] {
    return this.runtime.authorization.devices.flatMap((authorization) => {
      const camera = this.discoveredCameraFor(authorization);
      if (!camera || alreadyDiscoveredHosts.has(camera.host)) return [];
      const managed = this.attach(camera, undefined, credentials);
      return managed ? [managed] : [];
    });
  }

  private authorizationFor(camera: DiscoveredCamera): MeariLocalCameraAuthorization | undefined {
    return this.runtime.authorization.devices.find((device) => device.sourceAddress === camera.host);
  }

  attach(
    camera: DiscoveredCamera,
    existing: ManagedCamera | undefined,
    credentials: LocalCameraCredentials,
  ): ManagedCamera | undefined {
    const authorization = this.authorizationFor(camera);
    if (!authorization) return existing;
    if (camera.id !== `meari-local-${authorization.uuid}`) {
      this.discoveredByHost.set(camera.host, {
        ...camera,
        // ONVIF GetDeviceInformation often supplies the useful serial only
        // after LAN discovery. Preserve that canonical dashboard identity so
        // a temporary ONVIF outage cannot rename the same local camera.
        ...(existing?.view.id ? { serialNumber: existing.view.id } : {}),
        ...(existing?.view.name ? { deviceName: existing.view.name } : {}),
        ...(existing?.view.model ? { model: existing.view.model } : {}),
        ...(existing?.view.firmware ? { firmware: existing.view.firmware } : {}),
      });
    }

    const uuid = authorization.uuid;
    const values = localIotValues(this.runtime, uuid);
    const connected = this.runtime.emulator.connectedDeviceUuids.includes(uuid);
    const definitions = localControlDefinitions(values, authorization.capabilityFlags);
    const nativeCapabilities = definitions.map((definition) => {
      const descriptor = descriptorForControl(definition, values);
      return connected ? descriptor : { ...descriptor, availability: "unknown" as const };
    });
    const presets = parsePresets(values[IOT_CODES.PTZ_PRESET]);
    const presetCapability = nativeCapabilities.find((capability) => capability.id === "camera.presets");
    if (presetCapability) presetCapability.presets = presets;
    nativeCapabilities.push({
      id: "local.nativeControl",
      category: "advanced",
      label: "Local camera control",
      description: "The camera is authenticated directly to HomeTruth on this network; no app account or remote command server is in use.",
      kind: "status",
      availability: connected ? "available" : "unknown",
      value: connected ? "Connected locally" : "Waiting for camera",
      readOnly: true,
    });
    const talkback = authorization.peer
      ? new MeariLocalTalkbackClient({
        runtime: this.runtime,
        uuid,
        ...(process.env.HOMETRUTH_DEBUG_LOCAL_MEDIA === "1"
          ? {
            onEvent: (event) => {
              const detail = event.type === "control-sent"
                ? {
                  command: event.command,
                  controlSequence: event.controlSequence,
                  kcpSequence: event.kcpSequence,
                }
                  : event.type === "transport"
                    ? {
                      transport: event.event,
                      ...(event.sequence === undefined ? {} : { sequence: event.sequence }),
                      ...(event.payloadBytes === undefined ? {} : { payloadBytes: event.payloadBytes }),
                    }
                  : event.type === "ready"
                    ? { mode: event.mode }
                    : event.type === "voice-response"
                      ? { status: event.status, payloadBytes: event.payloadBytes }
                    : event.type === "voice-sent"
                      ? { sequence: event.sequence, samples: event.samples }
                      : event.type === "media"
                        ? {
                          codec: event.frame.codec,
                          frameFormat: event.frame.frameFormat,
                          payloadLength: event.frame.payloadLength,
                          mediaType: event.frame.mediaType,
                        }
                        : event.type === "media-error"
                          ? { message: event.message }
                          : {};
              console.log(JSON.stringify({
                event: `local_talkback_${event.type.replaceAll("-", "_")}`,
                ...detail,
              }));
            },
          }
          : {}),
      })
      : undefined;
    const playback = authorization.peer
      ? new MeariLocalCameraPlayback(this.runtime, uuid)
      : undefined;
    if (talkback) {
      nativeCapabilities.push({
        id: "audio.talk",
        category: "audio",
        label: "Talk",
        description: "Hold to speak through the camera over the authenticated local network connection.",
        kind: "momentary",
        availability: connected ? "available" : "unknown",
        confirmation: "none",
      });
    }
    if (playback) {
      nativeCapabilities.push({
        id: "storage.playback",
        category: "storage",
        label: "Local recordings",
        description: "Play the camera's SD-card timeline directly over the local network.",
        kind: "status",
        availability: connected ? "available" : "unknown",
        value: connected ? "Direct local playback ready" : "Waiting for camera",
        readOnly: true,
      });
    }

    const knownPresetIds = presets.flatMap((preset) => {
      const id = Number(preset.id);
      return Number.isInteger(id) && id >= 1 && id <= 255 ? [id] : [];
    });
    const localController = new MeariLocalCameraController(
      this.runtime,
      uuid,
      credentialsForHost(credentials, camera.host).password,
      knownPresetIds,
    );
    const fallback = existing?.controller ?? emptyController();
    const firmware = values[IOT_CODES.FIRMWARE_VERSION];
    const view: CameraDeviceView = {
      ...(existing?.view ?? {
        id: camera.serialNumber ?? camera.endpointReference?.replace(/^urn:uuid:/iu, "") ?? camera.id,
        name: camera.deviceName ?? camera.model ?? "Local pet camera",
        status: connected ? "online" : "unknown",
        stream: "unknown",
        snapshot: "unknown",
        capabilities: [],
      }),
      ...(typeof firmware === "string" && firmware ? { firmware } : {}),
      status: connected ? "online" : existing?.view.status ?? "unknown",
      capabilities: mergeCapabilityDescriptors(existing?.view.capabilities ?? [], nativeCapabilities),
      // Keep whatever the cloud adapter already learned about this camera and
      // layer the local-emulator view on top, so the panel can say "online via
      // the cloud, not yet registered locally" instead of just "not reachable".
      connection: mergeConnections(existing?.view.connection, {
        via: connected ? "local" : "none",
        local: connected
          ? { state: "connected", detail: "Registered with HomeTruth's local emulator; commands, live video, and talkback go straight to the camera." }
          : {
            state: "waiting",
            detail: "The camera has not registered with the local emulator. It only does so when usce.mearicloud.com resolves to HomeTruth (DNS override on) and its current cloud session drops: use \"reconnect now\" to kick its Wi-Fi (about 15 s), or wait for its heartbeat timeout (a few minutes).",
          },
        problems: connected
          ? []
          : ["Not registered with the local emulator yet (DNS override on, then \"reconnect now\" to kick its Wi-Fi so it re-registers in ~15 s; otherwise it takes a few minutes)"],
      }),
    };
    return {
      view,
      controller: new LocalPreferredCameraController(localController, fallback),
      ...(existing?.media ? { media: existing.media } : {}),
      ...(talkback ? { talkback } : {}),
      ...(playback ? { playback } : {}),
      // A camera the native control plane recognizes is compatible by
      // definition. Carry any inventory metadata from the ONVIF/LAN pass, or
      // synthesize it from the discovery record and the resolved view id.
      inventory: existing?.inventory ?? inventoryFromDiscoveredCamera(camera, view),
    };
  }
}

export class MeariCloudSession implements CloudCameraSession {
  constructor(
    private readonly client: MeariClient,
    private readonly onvifPassword?: string,
  ) {}

  async discover(): Promise<ManagedCamera[]> {
    const listed = this.client.devices.length ? this.client.devices : await this.client.listDevices();
    const devices = listed.filter((device) => serialOf(device));
    return await Promise.all(devices.map(async (device): Promise<ManagedCamera> => {
      const serial = serialOf(device)!;
      const [valuesResult, statusResult] = await Promise.allSettled([
        this.client.getAllIotValues(serial),
        this.client.getDeviceStatus(serial),
      ]);
      const values: IotValues = valuesResult.status === "fulfilled" ? valuesResult.value : {};
      const status = statusResult.status === "fulfilled" && statusResult.value === "online"
        ? "online"
        : statusResult.status === "fulfilled" && [ "offline", "notfound" ].includes(statusResult.value)
          ? "offline"
          : "unknown";
      const describe = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason);
      const cloudProblems: string[] = [];
      if (statusResult.status === "rejected") {
        cloudProblems.push(`Vendor cloud status check failed: ${describe(statusResult.reason)}`);
      } else if (statusResult.value === "notfound") {
        cloudProblems.push("The vendor cloud no longer lists this camera on the account");
      } else if (statusResult.value === "offline") {
        cloudProblems.push("The vendor cloud reports the camera offline (asleep, unplugged, or its cloud session is pointed at the local emulator)");
      }
      if (valuesResult.status === "rejected") {
        cloudProblems.push(`Vendor cloud settings read failed: ${describe(valuesResult.reason)}`);
      }
      const connection: CameraDeviceView["connection"] = {
        via: status === "online" ? "cloud" : "none",
        cloud: {
          state: status,
          detail: status === "online"
            ? "Reachable through the vendor cloud (CloudEdge account); commands are relayed by Meari's servers."
            : statusResult.status === "rejected"
              ? "The vendor cloud could not be asked about this camera."
              : "The vendor cloud does not currently see this camera online.",
        },
        problems: cloudProblems,
      };
      const definitions = getAvailableControls(device, values);
      const capabilities = definitions.map((definition) => descriptorForControl(definition, values));
      capabilities.push({
        id: "device.wake",
        category: "advanced",
        label: "Wake camera",
        description: "Ask a sleeping or battery-powered camera to reconnect to its cloud control channel.",
        kind: "action",
        availability: "available",
        confirmation: "none",
      });
      const ptzDefinition = definitions.find((definition) => definition.feature === "ptz");
      if (ptzDefinition && !capabilities.some((capability) => capability.id === "camera.ptz")) {
        capabilities.push({
          id: "camera.ptz",
          category: "movement",
          label: "Move camera",
          description: "Press and hold an arrow to pan or tilt.",
          kind: "ptz",
          availability: "available",
          confirmation: "none",
        });
      }
      const preset = capabilities.find((capability) => capability.id === "camera.presets");
      const presets = parsePresets(values[IOT_CODES.PTZ_PRESET]);
      if (preset) preset.presets = presets;
      const media = mediaFromCloudValues(values, this.onvifPassword);
      if (media?.streamUri) {
        capabilities.push({
          id: "audio.listen",
          category: "audio",
          label: "Listen",
          description: "Camera microphone audio is available directly from the local RTSP stream.",
          kind: "status",
          availability: "available",
          value: "Available in live viewer",
          readOnly: true,
        });
      }
      const firmware = values[IOT_CODES.FIRMWARE_VERSION];
      const view: CameraDeviceView = {
        id: deviceIdOf(device),
        name: deviceNameOf(device),
        model: String(device.devTypeID ?? "Meari PET3T"),
        ...(typeof firmware === "string" && firmware ? { firmware } : {}),
        status,
        connection,
        stream: media?.streamUri ? "available" : "unknown",
        snapshot: media?.snapshotUri || media?.streamUri ? "available" : "unknown",
        capabilities,
      };
      return {
        view,
        controller: new MeariCameraController(
          this.client,
          serial,
          this.onvifPassword,
          presets.flatMap((preset) => {
            const id = Number(preset.id);
            return Number.isInteger(id) && id >= 1 && id <= 255 ? [id] : [];
          }),
        ),
        ...(media ? { media } : {}),
      };
    }));
  }
}

function defaultPrivateCidrs(): string[] {
  const cidrs = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      const family = String(entry.family);
      if (entry.internal || family !== "IPv4") continue;
      const octets = entry.address.split(".");
      if (octets.length !== 4) continue;
      cidrs.add(`${octets[0]}.${octets[1]}.${octets[2]}.0/24`);
    }
  }
  return [...cidrs];
}

function onvifEndpoints(camera: DiscoveredCamera): string[] {
  const characteristicPort = camera.openPorts.includes(8000) ? 8000
    : camera.openPorts.includes(80) ? 80
      : camera.openPorts.includes(443) ? 443
        : undefined;
  const fallback = characteristicPort === undefined
    ? []
    : [`${characteristicPort === 443 ? "https" : "http"}://${camera.host}:${characteristicPort}/onvif/device_service`];
  return [...new Set([...camera.onvifEndpoints, ...fallback])];
}

function onvifPresetToken(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new CameraServiceError("Choose a saved view first", "invalid_control");
  }
  const token = String(value).trim();
  if (!token || token.length > 100) {
    throw new CameraServiceError("Choose a valid saved view", "invalid_control");
  }
  return token;
}

export class OnvifCameraController implements CameraController {
  constructor(
    private readonly client: OnvifClient,
    private readonly profile: OnvifProfile,
  ) {}

  async control(capabilityId: string, value: unknown): Promise<void> {
    if (capabilityId === "camera.presets") {
      const command = value as { action?: unknown; presetId?: unknown; name?: unknown };
      if (command.action === "recall") {
        await this.client.gotoPreset(this.profile.token, onvifPresetToken(command.presetId));
        return;
      }
      if (command.action === "save") {
        const name = typeof command.name === "string" ? command.name.trim() : "";
        if (!name || name.length > 40) {
          throw new CameraServiceError("A saved view needs a name of 1 to 40 characters", "invalid_control");
        }
        await this.client.setPreset(this.profile.token, name);
        return;
      }
      if (command.action === "delete") {
        await this.client.removePreset(this.profile.token, onvifPresetToken(command.presetId));
        return;
      }
      throw new CameraServiceError("Choose whether to save, recall, or delete a camera view", "invalid_control");
    }
    if (capabilityId === "onvif.gotoHome") {
      await this.client.gotoHomePosition(this.profile.token);
      return;
    }
    if (capabilityId === "onvif.setHome") {
      await this.client.setHomePosition(this.profile.token);
      return;
    }
    const imagingFields: Readonly<Record<string, keyof OnvifImagingSettingsPatch>> = {
      "onvif.brightness": "brightness",
      "onvif.contrast": "contrast",
      "onvif.saturation": "colorSaturation",
      "onvif.sharpness": "sharpness",
    };
    const field = imagingFields[capabilityId];
    if (field && typeof value === "number" && this.profile.videoSourceConfigurationToken) {
      await this.client.setImagingSettings(
        this.profile.videoSourceConfigurationToken,
        { [field]: value },
      );
      return;
    }
    throw new CameraServiceError("That local ONVIF control is not available", "not_supported");
  }

  async ptzStart(direction: "left" | "right" | "up" | "down"): Promise<void> {
    const speed = 0.45;
    const panTilt = direction === "left" ? { x: -speed, y: 0 }
      : direction === "right" ? { x: speed, y: 0 }
        : direction === "up" ? { x: 0, y: speed }
          : { x: 0, y: -speed };
    await this.client.continuousMove(this.profile.token, { panTilt }, "PT3S");
  }

  async ptzStop(): Promise<void> {
    await this.client.stop(this.profile.token);
  }
}

function emptyController(): CameraController {
  const unsupported = async () => {
    throw new CameraServiceError("ONVIF authentication is required for this control", "not_supported");
  };
  return { control: unsupported, ptzStart: unsupported, ptzStop: unsupported };
}

/** @internal Converts one standards/vendor discovery result into a safe dashboard device. */
export async function manageLocalCamera(
  camera: DiscoveredCamera,
  siteCredentials: LocalCameraCredentials,
): Promise<ManagedCamera | undefined> {
  const credentials = credentialsForHost(siteCredentials, camera.host);
  const endpoints = onvifEndpoints(camera);
  const characteristic = camera.openPorts.some((port) => port === 8000 || port === 8554 || port === 554);
  const meariLan = camera.sources.includes("meari-lan");
  if (endpoints.length === 0 && !characteristic && !camera.sources.includes("ws-discovery") && !meariLan) return undefined;

  let client: OnvifClient | undefined;
  let info: Awaited<ReturnType<OnvifClient["getDeviceInformation"]>> | undefined;
  let profile: OnvifProfile | undefined;
  let streamUri: string | undefined;
  let snapshotUri: string | undefined;
  let presets: { id: string; label: string }[] = [];
  let imagingCapabilities: CameraCapabilityDescriptor[] = [];

  for (const endpoint of endpoints) {
    const hasCredentials = Boolean(credentials.username && credentials.password);
    const candidate = new OnvifClient({
      deviceServiceUrl: endpoint,
      ...(hasCredentials ? { username: credentials.username!, password: credentials.password! } : {}),
      timeoutMs: 3_000,
    });
    try {
      info = await candidate.getDeviceInformation();
      const profiles = await candidate.getProfiles();
      profile = profiles.find((item) => item.videoEncoderConfiguration) ?? profiles.at(0);
      client = candidate;
      if (profile) {
        const [streamResult, snapshotResult, presetsResult] = await Promise.allSettled([
          candidate.getStreamUri(profile.token, { protocol: "RTSP" }),
          candidate.getSnapshotUri(profile.token),
          profile.ptzConfigurationToken ? candidate.getPresets(profile.token) : Promise.resolve([]),
        ]);
        if (streamResult.status === "fulfilled") streamUri = streamResult.value.uri;
        if (snapshotResult.status === "fulfilled") snapshotUri = snapshotResult.value.uri;
        if (presetsResult.status === "fulfilled") {
          presets = presetsResult.value.map((preset) => ({
            id: preset.token,
            label: preset.name ?? `Saved view ${preset.token}`,
          }));
        }
        // Many cameras (including this Pet 3T) only accept one RTSP client per
        // profile/channel, but expose a separate lower-resolution profile as
        // its own independent channel. Live view prefers that substream so it
        // doesn't fight another consumer of the main profile (e.g. an NVR
        // continuously recording it) for the same RTSP session.
        const resolutionArea = (item: OnvifProfile) => (item.videoEncoderConfiguration?.resolution
          ? item.videoEncoderConfiguration.resolution.width * item.videoEncoderConfiguration.resolution.height
          : undefined);
        const subProfile = profiles
          .filter((item) => item.token !== profile!.token && resolutionArea(item) !== undefined)
          .sort((left, right) => resolutionArea(left)! - resolutionArea(right)!)
          .at(0);
        if (subProfile && (resolutionArea(subProfile) ?? Infinity) < (resolutionArea(profile) ?? 0)) {
          const subStreamResult = await candidate.getStreamUri(subProfile.token, { protocol: "RTSP" }).catch(() => undefined);
          if (subStreamResult) streamUri = subStreamResult.uri;
        }
        if (profile.videoSourceConfigurationToken) {
          const settingsResult = await candidate.getImagingSettings(profile.videoSourceConfigurationToken).catch(() => undefined);
          const optionsResult = await candidate.getImagingOptions(profile.videoSourceConfigurationToken).catch(() => undefined);
          if (settingsResult && optionsResult) {
            const fields = [
              ["brightness", "Brightness", settingsResult.brightness, optionsResult.brightness],
              ["contrast", "Contrast", settingsResult.contrast, optionsResult.contrast],
              ["saturation", "Color saturation", settingsResult.colorSaturation, optionsResult.colorSaturation],
              ["sharpness", "Sharpness", settingsResult.sharpness, optionsResult.sharpness],
            ] as const;
            imagingCapabilities = fields.flatMap(([id, label, value, range]) => range
              ? [{
                id: `onvif.${id}`,
                category: "video" as const,
                label,
                kind: "range" as const,
                availability: "available" as const,
                ...(value === undefined ? {} : { value }),
                min: range.min,
                max: range.max,
                step: 1,
                confirmation: "none" as const,
              }]
              : []);
          }
        }
      }
      break;
    } catch {
      // Try the next standards-compatible endpoint.
    }
  }

  const id = info?.serialNumber
    || camera.serialNumber
    || camera.endpointReference?.replace(/^urn:uuid:/i, "")
    || camera.id;
  const hasPtz = Boolean(client && profile?.ptzConfigurationToken);
  const onvifServiceOpen = endpoints.length > 0;
  const capabilities: CameraCapabilityDescriptor[] = [
    ...(meariLan ? [{
      id: "local.discovery",
      category: "advanced" as const,
      label: "Local network discovery",
      description: "This camera answered the TKENPRO local discovery broadcast on this network.",
      kind: "status" as const,
      availability: "available" as const,
      value: `Found at ${camera.host}`,
      readOnly: true,
    }] : []),
    {
      id: "onvif.enabled",
      category: "onvif",
      label: "Local ONVIF access",
      description: client
        ? "This camera answered through the local ONVIF service."
        : onvifServiceOpen
          ? "ONVIF is enabled and reachable, but HomeTruth needs the local camera password. Enter username admin and the same camera password below; the owner account is no longer required."
        : camera.onvifAdvertised
          ? "The camera advertises ONVIF support, but its ONVIF service is not reachable yet. Sign in below with the owning TKENPRO account so HomeTruth can enable it and set a local camera password."
          : "The camera was found locally, but no ONVIF service answered yet.",
      kind: "status",
      availability: client ? "available" : "unknown",
      value: client ? "Enabled" : onvifServiceOpen ? "Enabled; password required" : camera.onvifAdvertised ? "Supported; not connected" : "Not connected",
      readOnly: true,
    },
    ...imagingCapabilities,
  ];
  if (hasPtz) {
    capabilities.push(
      {
        id: "camera.ptz",
        category: "movement",
        label: "Move camera",
        description: "Press and hold an arrow to pan or tilt through ONVIF.",
        kind: "ptz",
        availability: "available",
        confirmation: "none",
      },
      {
        id: "camera.presets",
        category: "movement",
        label: "Saved views",
        kind: "presets",
        availability: "available",
        presets,
        confirmation: "none",
      },
      {
        id: "onvif.gotoHome",
        category: "movement",
        label: "Go to home position",
        kind: "action",
        availability: "available",
        confirmation: "none",
      },
      {
        id: "onvif.setHome",
        category: "movement",
        label: "Replace home position",
        kind: "action",
        availability: "available",
        confirmation: "confirm",
      },
    );
  }
  if (streamUri) {
    capabilities.push({
      id: "audio.listen",
      category: "audio",
      label: "Listen",
      description: "Camera microphone audio is available directly from the local RTSP stream.",
      kind: "status",
      availability: "available",
      value: "Available in live viewer",
      readOnly: true,
    });
  }

  const media = streamUri || snapshotUri ? {
    ...(streamUri ? { streamUri } : {}),
    ...(snapshotUri ? { snapshotUri } : {}),
    ...(credentials.username && credentials.password
      ? { username: credentials.username, password: credentials.password }
      : {}),
  } : undefined;
  const view: CameraDeviceView = {
    id,
    name: info?.model
      ? `${info.manufacturer || "ONVIF"} ${info.model}`.trim()
      : camera.deviceName && camera.deviceName !== camera.model
        ? `${camera.model || "TKENPRO camera"} · ${camera.deviceName}`
        : camera.model || camera.deviceName || "Local pet camera",
    ...(info?.model || camera.model ? { model: info?.model ?? camera.model! } : {}),
    ...(info?.firmwareVersion || camera.firmware ? { firmware: info?.firmwareVersion ?? camera.firmware! } : {}),
    status: characteristic || client || meariLan ? "online" : "unknown",
    stream: streamUri ? "available" : "unknown",
    snapshot: snapshotUri || streamUri ? "available" : "unknown",
    capabilities,
  };
  return {
    view,
    controller: client && profile ? new OnvifCameraController(client, profile) : emptyController(),
    ...(media ? { media } : {}),
    ...(isCompatiblePetCamera(camera)
      ? { inventory: inventoryFromDiscoveredCamera(camera, view) }
      : {}),
  };
}

/** Build the non-secret inventory record persisted for a compatible camera. */
function inventoryFromDiscoveredCamera(
  camera: DiscoveredCamera,
  view: CameraDeviceView,
): InventoryCamera {
  return {
    id: view.id,
    host: camera.host,
    sources: camera.sources,
    ...(view.model ?? camera.model ? { model: (view.model ?? camera.model)! } : {}),
    ...(view.firmware ?? camera.firmware ? { firmware: (view.firmware ?? camera.firmware)! } : {}),
    ...(camera.deviceName ? { deviceName: camera.deviceName } : {}),
    ...(camera.serialNumber ? { serialNumber: camera.serialNumber } : {}),
    ...(camera.endpointReference ? { endpointReference: camera.endpointReference } : {}),
    ...(camera.onvifAdvertised ? { onvifAdvertised: true } : {}),
    onvifEndpoints: camera.onvifEndpoints,
    openPorts: camera.openPorts,
    lastSeen: new Date().toISOString(),
  };
}

export interface LocalDiscoveryOptions {
  /** Send the WS-Discovery and TKENPRO LAN broadcasts; off keeps a test server from finding real cameras. */
  readonly broadcast?: boolean;
  /** Probe hosts and CIDRs at all; off makes a test server's discovery inert, so only emulator-registered cameras appear. */
  readonly probe?: boolean;
}

async function discoverLocal(
  request: CameraDiscoverRequest,
  credentials: LocalCameraCredentials,
  localControl?: MeariLocalControlAdapter,
  options: LocalDiscoveryOptions = {},
): Promise<ManagedCamera[]> {
  const cidrs = request.cidrs === undefined ? defaultPrivateCidrs() : request.cidrs;
  const broadcast = options.broadcast ?? true;
  const report = options.probe === false ? { cameras: [] } : await discoverCameras({
    ...(request.hosts ? { hosts: request.hosts } : {}),
    ...(cidrs.length ? { cidrs } : {}),
    ...(broadcast ? {} : { wsDiscovery: false, meariLan: false }),
    // Long enough for the transport to re-probe several times so multiple
    // cameras that answer the LAN broadcast sporadically are all captured.
    multicastTimeoutMs: 2_500,
    probeTimeoutMs: 250,
    probeConcurrency: 32,
    maxProbeHosts: 256,
  });
  const managed = await Promise.all(report.cameras.map(async (camera) => {
    const cameraView = await manageLocalCamera(camera, credentials);
    return localControl?.attach(camera, cameraView, credentials) ?? cameraView;
  }));
  const discoveredHosts = new Set(report.cameras.map((camera) => camera.host));
  return [
    ...managed.filter((camera): camera is ManagedCamera => camera !== undefined),
    ...(localControl?.attachRegisteredCameras(credentials, discoveredHosts) ?? []),
  ];
}

const dependencies: CameraServiceDependencies = {
  async connectCloud(input: CameraSetupRequest): Promise<CloudCameraSession> {
    if (!input.email || !input.password) {
      throw new CameraServiceError("Enter the TKENPRO app account and password to use cloud controls", "not_configured");
    }
    const client = new MeariClient({
      profile: input.profile,
      email: input.email,
      password: input.password,
      countryCode: input.countryCode ?? "US",
      phoneCode: input.phoneCode ?? "1",
      includeSharedHomes: true,
    });
    try {
      await client.login();
    } catch (error) {
      if (error instanceof MeariAuthError) {
        const resultCode = error.resultCode && /^[A-Za-z0-9_-]{1,32}$/u.test(error.resultCode)
          ? ` (TKENPRO code ${error.resultCode})`
          : "";
        const guidance = error.resultCode === "1017"
          ? "The account or password was rejected. Email login does not require a phone number."
          : error.resultCode === "1018"
            ? "That account was not found for this app profile and account region."
            : error.resultCode === "1048"
              ? "The account belongs to a different region. Choose the region shown on TKENPRO's sign-in screen."
              : error.resultCode === "1224"
                ? "Too many incorrect attempts triggered an account-lock warning; pause before retrying."
                : error.resultCode === "1039"
                  ? "TKENPRO is rate-limiting sign-in attempts; wait at least one minute before retrying."
                  : error.resultCode === "1023"
                    ? "The session was replaced or expired; sign in again."
                    : input.email.includes("@")
                      ? "No phone number is required for email login. Check the exact email, app password, and account region."
                      : "Check the phone account, app password, and account region.";
        throw new CameraServiceError(
          `TKENPRO sign-in failed${resultCode}. ${guidance}`,
          "camera_error",
        );
      }
      if (error instanceof MeariApiError) {
        const resultCode = error.resultCode && /^[A-Za-z0-9_-]{1,32}$/u.test(error.resultCode)
          ? ` (TKENPRO code ${error.resultCode})`
          : "";
        throw new CameraServiceError(
          `TKENPRO could not complete sign-in${resultCode}. Check the internet connection and account region, then try again.`,
          "camera_error",
        );
      }
      throw error;
    }
    return new MeariCloudSession(client, input.onvifPassword);
  },
  discoverLocal,
};

const IPV4_ADDRESS = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u;
/** IoT property codes the camera reports its network settings under. */
const IOT_CODE_DEVICE_IP = "126";
const IOT_CODE_DEVICE_GATEWAY = "59";

/** True when the cloud's device record is the camera named by `identity`. */
export function cloudDeviceMatchesIdentity(device: MeariDevice, identity: CameraIdentity): boolean {
  const serial = identity.serialNumber?.trim();
  const uuid = identity.uuid?.trim().toLowerCase();
  const name = deviceNameOf(device);
  const cloudSerial = (serialOf(device) ?? "").toLowerCase();
  if (serial && name === serial) return true;
  if (uuid && cloudSerial && (cloudSerial === `ppsc${uuid}` || cloudSerial.endsWith(uuid))) return true;
  return false;
}

/**
 * Ask the vendor cloud where a camera last reported itself. The camera pushes
 * its LAN address (IoT code 126) and gateway (59) whenever it connects, so
 * this still finds a camera that failed over to its backup Wi-Fi. Reads the
 * account's device list and one camera's IoT settings; changes nothing.
 */
export async function locateCameraThroughCloud(
  identity: CameraIdentity,
  account: CameraCloudAccount,
): Promise<CameraLocation | undefined> {
  const client = new MeariClient({
    profile: account.profile === "tkenpro" ? "tkenpro" : "cloudedge",
    email: account.email,
    password: account.password,
    countryCode: account.countryCode ?? "US",
    phoneCode: account.phoneCode ?? "1",
    includeSharedHomes: true,
  });
  const { devices } = await client.login();
  const matches = devices.filter((device) => cloudDeviceMatchesIdentity(device, identity));
  const anonymous = !identity.serialNumber && !identity.uuid;
  const target = matches.length === 1 ? matches[0] : anonymous && devices.length === 1 ? devices[0] : undefined;
  const cloudSerial = target ? serialOf(target) : undefined;
  if (!cloudSerial) return undefined;
  const values = await client.getDeviceIotConfig(cloudSerial);
  const host = typeof values[IOT_CODE_DEVICE_IP] === "string" ? values[IOT_CODE_DEVICE_IP].trim() : "";
  if (!IPV4_ADDRESS.test(host)) return undefined;
  const gateway = typeof values[IOT_CODE_DEVICE_GATEWAY] === "string" ? values[IOT_CODE_DEVICE_GATEWAY].trim() : "";
  return { host, ...(IPV4_ADDRESS.test(gateway) ? { gateway } : {}) };
}

/** Real network implementation behind `rebootCamera`: ONVIF on port 8000 plus the cloud lookup. */
export function createCameraRecovery(): CameraRecoveryDependencies {
  const onvif = (host: string, credentials: CameraRecoveryCredentials) => new OnvifClient({
    deviceServiceUrl: `http://${host}:8000/onvif/device_service`,
    ...(credentials.username && credentials.password
      ? { username: credentials.username, password: credentials.password }
      : {}),
    timeoutMs: 4_000,
  });
  return {
    async probe(host, credentials) {
      const info = await onvif(host, credentials).getDeviceInformation();
      return {
        ...(info.serialNumber ? { serialNumber: info.serialNumber } : {}),
        ...(info.model ? { model: info.model } : {}),
        ...(info.firmwareVersion ? { firmwareVersion: info.firmwareVersion } : {}),
      };
    },
    async reboot(host, credentials) {
      await onvif(host, credentials).systemReboot();
    },
    locate: locateCameraThroughCloud,
  };
}

export function createDefaultCameraService(
  setupStore?: CameraSetupStore,
  localControl?: MeariLocalControlAdapter,
  inventoryStore?: CameraInventoryStore,
  cameraHosts?: readonly string[],
  networkMode?: CameraNetworkModeLike,
  discovery: LocalDiscoveryOptions = {},
  overrides: Pick<CameraServiceDependencies, "saveHostCredentials"> = {},
): CameraService {
  return new CameraService({
    ...dependencies,
    ...overrides,
    discoverLocal: (request: CameraDiscoverRequest, credentials: LocalCameraCredentials) =>
      discoverLocal(request, credentials, undefined, discovery),
    ...(networkMode ? { networkMode } : {}),
    ...(cameraHosts?.length ? { cameraHosts } : {}),
    cameraRecovery: createCameraRecovery(),
    ...(localControl ? {
      localControlAvailable: true,
      localRegistration: localControl.registration(),
      registeredLocal: (credentials: LocalCameraCredentials) => localControl.attachRegisteredCameras(credentials, new Set()),
      discoverLocal: (
        request: CameraDiscoverRequest,
        credentials: LocalCameraCredentials,
      ) => discoverLocal(request, credentials, localControl, discovery),
    } : {}),
    ...(setupStore ? { setupStore } : {}),
    ...(inventoryStore ? { inventoryStore } : {}),
  });
}
